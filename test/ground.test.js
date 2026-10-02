import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changesBetween, parseStatus, snapshot } from '../bridge/ground.js';
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
  assert.ok(gitOnly.problems.some((p) => /timing relative to the tests is unknown/.test(p)));
});

test('another agent in the same repository, and edits git doesn’t show', () => {
  const others = [{ session: 'x', harness: 'codex', label: 'proj' }];
  const shared = gitTruth({ steps: [edit('src/a.js')], end: done({ files: [{ path: 'src/a.js', change: 'edit' }, { path: 'src/z.js', change: 'edit' }], committed: false, others }) });
  assert.equal(gitLine(shared), 'Git: 2 files changed, 1 of them by commands · Codex was also working here, so some may be theirs');
  const undone = gitTruth({ steps: [edit('src/a.js')], end: done({ files: [], committed: false, others: [] }) });
  assert.equal(gitLine(undone), 'Git: no files changed, though it edited 1 file (undone, or ignored by git)');
  assert.equal(gitTruth({ steps: [], end: { kind: 'done' } }), null);
});
