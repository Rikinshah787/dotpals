import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { changesBetween, checkpoint, createGround, parseStatus, restoreFiles, rewindPlan, snapshot, treeChanges } from '../bridge/ground.js';
import { gitLine, gitTruth, readiness, turnMarkdown } from '../bridge/ui/story.js';

const dirs = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

/** A fresh repository with a.js, d.js and docs/x.md committed. */
async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-ground-'));
  dirs.push(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  await mkdir(join(dir, 'docs'));
  await Promise.all([writeFile(join(dir, 'a.js'), 'a\n'), writeFile(join(dir, 'd.js'), 'd\n'), writeFile(join(dir, 'docs', 'x.md'), 'x\n')]);
  git('add', '.');
  git('commit', '-q', '-m', 'start');
  return { dir, git };
}

test('restore points: a request rewound file by file, without touching the index, and undone', async () => {
  const { dir, git } = await repo();
  // Something already staged before the request: the user's index must stay as it is.
  await writeFile(join(dir, 'd.js'), 'd staged\n');
  git('add', 'd.js');
  const index = () => git('diff', '--cached', '--name-only').toString().trim();
  const staged = index();

  const before = await checkpoint(dir);
  assert.match(before, /^[0-9a-f]{40,64}$/);
  // The request: edits a.js, creates new.js, deletes docs/x.md.
  await writeFile(join(dir, 'a.js'), 'a changed\n');
  await writeFile(join(dir, 'new.js'), 'new\n');
  await unlink(join(dir, 'docs', 'x.md'));
  const after = await checkpoint(dir);
  assert.deepEqual(await treeChanges(dir, before, after), ['a.js', 'docs/x.md', 'new.js']);
  assert.equal(index(), staged); // saving restore points left the index alone

  // You change a.js again after the request: the preview says so.
  await writeFile(join(dir, 'a.js'), 'a changed, then by you\n');
  const now = await checkpoint(dir);
  const plan = await rewindPlan(dir, { before, after, now, paths: ['a.js', 'docs/x.md', 'new.js'] });
  assert.deepEqual(plan.files, [
    { path: 'a.js', change: 'restore', since: true },
    { path: 'docs/x.md', change: 'recreate', since: false },
    { path: 'new.js', change: 'delete', since: false },
  ]);
  assert.match(plan.patch, /-a changed, then by you\n\+a\n/);

  // Rewind two of them; a.js stays as you left it.
  const out = await restoreFiles(dir, before, ['docs/x.md', 'new.js']);
  assert.deepEqual(out, { restored: ['docs/x.md'], deleted: ['new.js'], skipped: [] });
  assert.equal(await readFile(join(dir, 'docs', 'x.md'), 'utf8'), 'x\n');
  assert.equal(existsSync(join(dir, 'new.js')), false);
  assert.equal(await readFile(join(dir, 'a.js'), 'utf8'), 'a changed, then by you\n');
  assert.equal(index(), staged);

  // Undo: back to how things were just before the rewind.
  assert.deepEqual(await restoreFiles(dir, now, ['docs/x.md', 'new.js']), { restored: ['new.js'], deleted: ['docs/x.md'], skipped: [] });
  assert.equal(await readFile(join(dir, 'new.js'), 'utf8'), 'new\n');
  assert.equal(existsSync(join(dir, 'docs', 'x.md')), false);

  // Paths that leave the repository are refused.
  assert.deepEqual(await restoreFiles(dir, before, ['../outside.js', '/etc/passwd']), { restored: [], deleted: [], skipped: ['../outside.js', '/etc/passwd'] });
});

test('restore points (from review): a tree git can\'t read deletes nothing; paths are names, not patterns', async () => {
  const { dir, git } = await repo();
  await writeFile(join(dir, 'b.js'), 'b\n');
  // Not a tree, or one git cleaned up: null, and every file is still there.
  assert.equal(await restoreFiles(dir, 'not-a-hash', ['a.js', 'd.js']), null);
  assert.equal(await restoreFiles(dir, 'f'.repeat(40), ['a.js', 'd.js']), null);
  assert.equal(await rewindPlan(dir, { before: 'f'.repeat(40), after: null, now: 'f'.repeat(40), paths: ['a.js'] }), null);
  assert.equal(await readFile(join(dir, 'a.js'), 'utf8'), 'a\n');
  assert.equal(await treeChanges(dir, '--output=x', 'HEAD'), null); // only hashes reach git
  // A file named like a pattern is only itself: rewinding `[ab].js` doesn't touch a.js or b.js.
  const before = await checkpoint(dir);
  await writeFile(join(dir, '[ab].js'), 'glob\n');
  await writeFile(join(dir, 'a.js'), 'a changed\n');
  const out = await restoreFiles(dir, before, ['[ab].js']);
  assert.deepEqual(out, { restored: [], deleted: ['[ab].js'], skipped: [] });
  assert.equal(await readFile(join(dir, 'a.js'), 'utf8'), 'a changed\n');
  assert.equal(await readFile(join(dir, 'b.js'), 'utf8'), 'b\n');
  // Many files at once go through stdin, not the command line.
  const many = Array.from({ length: 600 }, (_, i) => `src/some/fairly/long/folder/name/file-${String(i).padStart(4, '0')}.js`);
  await mkdir(join(dir, 'src', 'some', 'fairly', 'long', 'folder', 'name'), { recursive: true });
  await Promise.all(many.map((p) => writeFile(join(dir, p), 'v1\n')));
  const v1 = await checkpoint(dir);
  await Promise.all(many.map((p) => writeFile(join(dir, p), 'v2\n')));
  const back = await restoreFiles(dir, v1, many);
  assert.equal(back.restored.length, 600);
  assert.equal(await readFile(join(dir, many[599]), 'utf8'), 'v1\n');
  git('status'); // the repository is fine
});

test('restore points (from review): a folder that became a link out of the repository is left alone', async (t) => {
  const { symlink } = await import('node:fs/promises');
  const { dir } = await repo();
  const outside = await mkdtemp(join(tmpdir(), 'dotpals-outside-'));
  dirs.push(outside);
  const before = await checkpoint(dir); // docs/x.md is in it
  await rm(join(dir, 'docs'), { recursive: true, force: true });
  try { await symlink(outside, join(dir, 'docs'), 'junction'); } catch { t.skip('no links on this system'); return; }
  const out = await restoreFiles(dir, before, ['docs/x.md', 'a.js']);
  assert.deepEqual(out.skipped, ['docs/x.md']);
  assert.deepEqual(out.restored, ['a.js']);
  assert.equal(existsSync(join(outside, 'x.md')), false); // nothing written through the link
  assert.ok((await lstat(join(dir, 'docs'))).isSymbolicLink()); // and the link is still a link
});

test('restore points: none for a folder that isn\'t a repository, or with new files too big to keep', async () => {
  const plain = await mkdtemp(join(tmpdir(), 'dotpals-plain-'));
  dirs.push(plain);
  assert.equal(await checkpoint(plain), null);
  const { dir } = await repo();
  assert.equal(await checkpoint(dir, { snap: { files: { 'dump.bin': { code: '??', sig: `${20 * 1024 * 1024}:1` } } } }), null);
  assert.equal(await checkpoint(dir, { snap: { tooMany: true } }), null);
});

test('createGround: restore points only when the setting is on, before and after the request', async () => {
  const { dir } = await repo();
  let on = false;
  const ground = createGround({ restorePoints: () => on });
  await ground.start('s1', dir, Date.now());
  await writeFile(join(dir, 'a.js'), 'off\n');
  assert.equal((await ground.finish('s1', dir)).trees, undefined);
  on = true;
  await ground.start('s2', dir, Date.now());
  await writeFile(join(dir, 'a.js'), 'on\n');
  const { trees } = await ground.finish('s2', dir);
  assert.match(trees.before, /^[0-9a-f]{40,64}$/);
  assert.deepEqual(await treeChanges(dir, trees.before, trees.after), ['a.js']);
});

test('parseStatus reads git status -z, renames included', () => {
  assert.deepEqual(parseStatus(' M a.js\0?? new file.js\0R  b.js\0old.js\0'), [
    { code: ' M', path: 'a.js' }, { code: '??', path: 'new file.js' }, { code: 'R ', path: 'b.js', from: 'old.js' },
  ]);
});

test('not a git repository: no snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-nogit-'));
  dirs.push(dir);
  assert.equal(await snapshot(dir, { git: async () => null }), null);
});

test('an initial commit after the snapshot reports its tracked files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-ground-'));
  dirs.push(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  const before = await snapshot(dir);
  await mkdir(join(dir, 'src'));
  await writeFile(join(dir, 'src', 'a.js'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');
  const changes = await changesBetween(before, await snapshot(dir));
  assert.deepEqual(changes.files, [{ path: 'src/a.js', change: 'write' }]);
  assert.equal(changes.committed, true);
});

test('git sees what commands changed, and leaves out what was already changed before', async () => {
  const { dir } = await repo();
  await writeFile(join(dir, 'before.js'), 'mine, from before\n'); // already there, untouched by the request
  const a = await snapshot(join(dir, 'docs')); // from a subfolder: the whole repository
  // What a request might do with sed, node -e, a generator…
  await writeFile(join(dir, 'a.js'), 'a, changed by sed\n');
  await writeFile(join(dir, 'new.js'), 'generated\n');
  await unlink(join(dir, 'd.js'));
  const b = await snapshot(dir);
  const changes = await changesBetween(a, b);
  assert.deepEqual(changes.files, [{ path: 'a.js', change: 'edit' }, { path: 'd.js', change: 'delete' }, { path: 'new.js', change: 'write' }]);
  assert.equal(changes.committed, false);
});

test('a file changed before and again during the request counts; a commit during it shows its files', async () => {
  const { dir, git } = await repo();
  await writeFile(join(dir, 'a.js'), 'a, my own edit\n');
  const a = await snapshot(dir);
  await new Promise((r) => setTimeout(r, 1100)); // a commit in the snapshot's own second doesn't count
  await writeFile(join(dir, 'a.js'), 'a, my own edit, and the agent’s longer one\n');
  await writeFile(join(dir, 'c.js'), 'c\n');
  git('add', 'c.js');
  git('commit', '-q', '-m', 'add c');
  const changes = await changesBetween(a, await snapshot(dir));
  assert.deepEqual(changes.files, [{ path: 'a.js', change: 'edit' }, { path: 'c.js', change: 'write' }]);
  assert.equal(changes.committed, true);
});

// -- the story's side ----------------------------------------------------------------------

let n = 0;
const step = (kind, extra = {}) => ({ id: `g${n++}`, session: 's', kind, status: 'ok', at: 1000 + n, ...extra });
const edit = (path) => step('edit', { title: path, files: [{ path: `C:/proj/${path}`, change: 'edit' }] });
const run = (command, output = '') => step('run', { tool: 'Bash', title: command, body: { command, output } });
const done = (git) => ({ kind: 'done', at: 9999, git });

test('the recap lists what git saw, and names files changed by commands', () => {
  const turn = {
    harness: 'claude', label: 'proj',
    steps: [edit('src/a.js'), run(`sed -i 's/x/y/' src/b.js`), run('npm test', 'Tests: 4 passed')],
    end: done({ files: [{ path: 'src/a.js', change: 'edit' }, { path: 'src/b.js', change: 'edit' }], committed: false, others: [] }),
  };
  const truth = gitTruth(turn);
  assert.deepEqual(truth.byCommand.map((f) => f.path), ['src/b.js']);
  assert.equal(gitLine(truth), 'Git: 2 files changed, 1 of them by commands');
  const md = turnMarkdown(turn);
  assert.match(md, /- Changed: `a\.js`, `b\.js`/);
  assert.match(md, /- Changed by commands, not file tools: `b\.js`/);
  assert.match(md, /Files checked against git/);
});

test('code changed only by a command still gets a ready-to-merge verdict', () => {
  const turn = { steps: [run('node scripts/generate.js')], end: done({ files: [{ path: 'src/a.js', change: 'edit' }], committed: false, others: [] }) };
  const r = readiness(turn);
  assert.ok(r);
  assert.ok(r.problems.includes('No tests ran'));
  assert.equal(readiness({ ...turn, end: { kind: 'done', at: 9999 } }), null); // without git it can't know
});

test('deletions count as code changes and unlocated Git changes are not proven tested', () => {
  const deleted = readiness({ steps: [], end: done({ files: [{ path: 'src/a.js', change: 'delete' }], committed: false, others: [] }) });
  assert.ok(deleted);
  assert.ok(deleted.problems.includes('No tests ran'));

  const passing = { ...run('npm test'), body: { command: 'npm test', output: 'Tests: 4 passed' } };
  const generated = run('node scripts/generate.js');
  const gitOnly = readiness({ steps: [passing, generated], end: done({ files: [{ path: 'src/a.js', change: 'edit', byTool: false }], committed: false, others: [] }) });
  assert.equal(gitOnly.ready, false);
  assert.ok(gitOnly.problems.some((p) => /may not be tested/.test(p)));
});

test('another agent in the same repository, and edits git doesn’t show', () => {
  const others = [{ session: 'x', harness: 'codex', label: 'proj' }];
  const shared = gitTruth({ steps: [edit('src/a.js')], end: done({ files: [{ path: 'src/a.js', change: 'edit' }, { path: 'src/z.js', change: 'edit' }], committed: false, others }) });
  assert.equal(gitLine(shared), 'Git: 2 files changed, 1 of them by commands · Codex was also working here, so some may be theirs');
  const undone = gitTruth({ steps: [edit('src/a.js')], end: done({ files: [], committed: false, others: [] }) });
  assert.equal(gitLine(undone), 'Git: no files changed, though it edited 1 file (undone, or ignored by git)');
  assert.equal(gitTruth({ steps: [], end: { kind: 'done' } }), null);
});

test('code git saw changed by a command: tested if the tests were the last thing run, unknown otherwise', () => {
  const gitDone = done({ files: [{ path: 'src/a.js', change: 'edit' }], committed: false, others: [] });
  const tests = run('npm test', 'Tests: 4 passed');
  // node scripts/generate.js, then the tests, and nothing after: the change came before the tests.
  assert.equal(readiness({ steps: [{ ...run('node scripts/generate.js'), at: 1 }, { ...tests, at: 2 }], end: gitDone }).ready, true);
  // Tests, then another command: git's change may have come after them.
  const r = readiness({ steps: [{ ...tests, at: 1 }, { ...run('node scripts/generate.js'), at: 2 }], end: gitDone });
  assert.equal(r.ready, false);
  assert.ok(r.problems.some((p) => /may not be tested/.test(p)), r.problems.join(' | '));
});

test('switching branches isn’t a change: only commits made during the request count (from a real recap)', async () => {
  const { dir, git } = await repo();
  // An older sibling branch with its own commit, made an hour before the request.
  const base = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, stdio: 'pipe' }).toString().trim(); // main or master
  git('checkout', '-q', '-b', 'sibling');
  await writeFile(join(dir, 'sibling.js'), 'older work\n');
  git('add', '.');
  const old = new Date(Date.now() - 3600_000).toISOString();
  execFileSync('git', ['commit', '-q', '-m', 'older work'], { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old } });
  git('checkout', '-q', base);
  const a = await snapshot(dir); // the request starts on the main branch
  await new Promise((r) => setTimeout(r, 1100));
  git('checkout', '-q', 'sibling'); // …switches branches…
  await writeFile(join(dir, 'new.js'), 'this request’s work\n');
  git('add', '.');
  git('commit', '-q', '-m', 'this request');
  const changes = await changesBetween(a, await snapshot(dir));
  assert.equal(changes.committed, true);
  assert.deepEqual(changes.files, [{ path: 'new.js', change: 'write' }]); // not sibling.js
});

test('a snapshot knows its branch (none when HEAD is detached), and the request gets where it ended', async () => {
  const { dir, git } = await repo();
  const before = await snapshot(dir);
  assert.match(before.branch, /^(main|master)$/);
  const ground = createGround();
  await ground.start('s1', dir);
  git('checkout', '-q', '-b', 'feat/login');
  const changes = await ground.finish('s1', dir);
  assert.equal(changes.branch, 'feat/login');
  assert.equal(changes.head, before.head);
  git('checkout', '-q', '--detach');
  assert.equal((await snapshot(dir)).branch, null);
});

test('a commit or a look-up after the tests doesn’t make git’s changes "untimed"', () => {
  const gitDone = done({ files: [{ path: 'src/a.js', change: 'edit' }], committed: true, others: [] });
  const tests = { ...run('npm test'), body: { command: 'npm test', output: 'Tests: 4 passed' } };
  const steps = [{ ...run('node scripts/generate.js'), at: 1 }, { ...tests, at: 2 }, { ...run('git add -A && git commit -m x && git push'), at: 3 }, { ...run('git status --short'), at: 4 }];
  assert.equal(readiness({ steps, end: gitDone }).ready, true);
});

test('review fixes: no slack for sibling commits, merges count, written-then-edited stays written, only harmless commands are ignored', async () => {
  const { dir, git } = await repo();
  const base = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, stdio: 'pipe' }).toString().trim();
  // A sibling commit made 20 s before the request: not this request's work.
  git('checkout', '-q', '-b', 'sib');
  await writeFile(join(dir, 'sib.js'), 'x\n');
  git('add', '.');
  const recent = new Date(Date.now() - 20_000).toISOString();
  execFileSync('git', ['commit', '-q', '-m', 'sibling'], { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: recent, GIT_COMMITTER_DATE: recent } });
  git('checkout', '-q', base);
  await new Promise((r) => setTimeout(r, 1100)); // the snapshot's second must be after the sibling commit's
  const a = await snapshot(dir);
  await new Promise((r) => setTimeout(r, 1100)); // commits in the snapshot's own second don't count
  // A merge of that branch, made during the request: its files count (diffed against the first parent).
  git('merge', '-q', '--no-ff', '-m', 'merge sibling', 'sib');
  // Written, then edited, in two commits: still "written".
  await writeFile(join(dir, 'n.js'), '1\n'); git('add', '.'); git('commit', '-q', '-m', 'add n');
  await writeFile(join(dir, 'n.js'), '2\n'); git('add', '.'); git('commit', '-q', '-m', 'edit n');
  const changes = await changesBetween(a, await snapshot(dir));
  assert.deepEqual(changes.files, [{ path: 'n.js', change: 'write' }, { path: 'sib.js', change: 'write' }]);
  // The sibling commit alone (a branch switch, no merge) still doesn't count.
  git('checkout', '-q', 'sib');
  await new Promise((r) => setTimeout(r, 1100));
  const b = await snapshot(dir);
  git('checkout', '-q', base);
  assert.deepEqual((await changesBetween(b, await snapshot(dir))).files, []);

  const gitDone = done({ files: [{ path: 'src/a.js', change: 'edit' }], committed: true, others: [] });
  const tests = { ...run('npm test'), body: { command: 'npm test', output: 'Tests: 4 passed' } };
  assert.equal(readiness({ steps: [{ ...run('node scripts/generate.js'), at: 1 }, { ...tests, at: 2 }, { ...run('git merge feature'), at: 3 }], end: gitDone }).ready, false);
  assert.equal(readiness({ steps: [{ ...run('node scripts/generate.js'), at: 1 }, { ...tests, at: 2 }, { ...run('git status && node scripts/generate.js && git commit -m x'), at: 3 }], end: gitDone }).ready, false);
  assert.equal(readiness({ steps: [{ ...run('node scripts/generate.js'), at: 1 }, { ...tests, at: 2 }, { ...run('git add -A && git commit -m x && git push'), at: 3 }], end: gitDone }).ready, true);
});
