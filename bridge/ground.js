// Git as the ground truth for what a request changed. The agents' tool calls say which
// files they edited, but not what a command changed (`sed -i`, `node -e "fs.writeFileSync…"`,
// a code generator, a formatter). So when a request starts the bridge notes the state of
// the session's git repository, and when it ends, notes it again: the difference is what
// changed, however it was changed, including commits.
//
// A snapshot is HEAD (and the branch it's on) plus every file `git status` lists (changed, new, deleted; not
// ignored ones), each with its size and modification time. A file that was already
// changed when the request started counts only if it changed again. Nothing is read
// but the file list and file times; nothing is written.
//
// It can't tell who changed a file: another agent working in the same repository at the
// same time shows up too, so the bridge notes which other sessions were active there.
import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

const LIMIT = 5000; // more changed files than this: too many to compare (a build into a tracked folder)

/**
 * Run git in `cwd`: resolves stdout, or null when it fails (not a repository, no git, too slow).
 * `env`: extra variables. `input`: written to its stdin (for --stdin lists, never the command line).
 */
export function runGit(args, cwd, { timeoutMs = 10_000, env, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8', ...(env ? { env: { ...process.env, ...env } } : {}) }, (err, out) => resolve(err ? null : out));
    if (input != null) { child.stdin?.on('error', () => {}); child.stdin?.end(input); }
  });
}

// -- Restore points (Settings: restorePoints) ---------------------------------------------
// The whole working tree as git sees it (tracked and new files, not ignored ones), saved as a
// git tree object when a request starts and when it ends, so a request can be rewound: its
// files put back as they were before it. Built in a private index (a copy of yours, so only
// changed files are read again): your index, your branches and your files are never touched,
// and nothing points at the trees, so git's own clean-up removes them in a couple of weeks.

// Files go in and come back as they are: with core.autocrlf on (Windows' default) git would
// save "a\n" and put back "a\r\n". The repository's own .gitattributes still apply both ways.
// And no program a repository's own config names (core.fsmonitor, hooks) runs for it: the
// folder comes from an agent's event, not from you.
const EXACT = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath='];
// Paths are file names, never patterns: a file called `*.js` or `:(top)x` is only itself.
const LITERAL = ['--literal-pathspecs'];
const HASH = /^[0-9a-f]{40,64}$/;
const BIG_FILE = 10 * 1024 * 1024;   // a new file this big (a build, a dump): no restore point
const BIG_TOTAL = 100 * 1024 * 1024; // new files this big in all: no restore point

/** Run `fn(env)` with a private index for the repository at `root` (a copy of its own, when it has one). */
async function withIndex(root, git, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-index-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    const own = (await git(['rev-parse', '--git-path', 'index'], root))?.trim();
    if (own) await copyFile(isAbsolute(own) ? own : join(root, own), env.GIT_INDEX_FILE).catch(() => {});
    return await fn(env);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Save the working tree of the repository at `root` as a tree object: its hash, or null (no
 * git, too slow). `snap` (a snapshot()): skipped when it has too many changed files, or new
 * files too big to keep (see BIG_FILE): those aren't worth copying into the repository.
 */
export async function checkpoint(root, { git = runGit, snap } = {}) {
  if (!root || snap?.tooMany) return null;
  if (snap?.files) {
    let total = 0;
    for (const { code, sig } of Object.values(snap.files)) {
      if (code !== '??') continue;
      const size = Number(String(sig).split(':')[0]) || 0;
      if (size > BIG_FILE || (total += size) > BIG_TOTAL) return null;
    }
  }
  return withIndex(root, git, async (env) => {
    if ((await git([...EXACT, 'add', '-A', '--', '.'], root, { env, timeoutMs: 30_000 })) === null) return null;
    const tree = (await git(['write-tree'], root, { env }))?.trim();
    return HASH.test(tree ?? '') ? tree : null;
  });
}

/** The files that differ between two saved trees: what a request changed, however (tools, commands, commits). */
export async function treeChanges(root, a, b, { git = runGit } = {}) {
  if (!HASH.test(a ?? '') || !HASH.test(b ?? '')) return null;
  const out = await git(['-c', 'core.quotepath=off', 'diff', '--name-only', '-z', '--no-renames', a, b], root, { timeoutMs: 20_000 });
  return out === null ? null : out.split('\0').filter(Boolean).sort();
}

/**
 * Every file in a saved tree, or null when it isn't one (not a hash, cleaned up by git, git
 * failed). Read whole and filtered here: a list of paths on the command line can be too long
 * (Windows), and a failure must never read as "the tree has none of them".
 */
async function treeFiles(root, tree, git) {
  if (!HASH.test(tree ?? '')) return null;
  if ((await git(['cat-file', '-e', `${tree}^{tree}`], root)) === null) return null;
  const out = await git(['-c', 'core.quotepath=off', 'ls-tree', '-r', '--name-only', '-z', tree], root, { timeoutMs: 30_000 });
  return out === null ? null : new Set(out.split('\0').filter(Boolean));
}

/** A path from git (relative to the repository, forward slashes) that stays inside `root`, as a full path; else null. */
function inside(root, path) {
  if (!path || isAbsolute(path) || String(path).split(/[\\/]/).includes('..')) return null;
  const full = resolve(root, path);
  return full.startsWith(resolve(root) + sep) ? full : null;
}

/**
 * Whether the folder `full` would be written in is really inside the repository, with links
 * followed: the nearest folder of it that exists (a deleted folder comes back under its
 * parent) must resolve inside `root`. A folder that's a link to somewhere else isn't.
 */
async function folderInside(root, full) {
  try {
    const top = await realpath(root);
    let dir = dirname(full);
    for (;;) {
      try {
        const real = await realpath(dir);
        return real === top || real.startsWith(top + sep);
      } catch {
        const up = dirname(dir);
        if (up === dir) return false;
        dir = up;
      }
    }
  } catch { return false; }
}

/**
 * Delete a file the request created, only if it really is inside the repository (folderInside),
 * and it's a file or a link, not a folder. → true when it was deleted, or was already gone.
 */
async function removeInside(root, path) {
  const full = inside(root, path);
  if (!full || !(await folderInside(root, full))) return false;
  try {
    const s = await lstat(full);
    if (s.isDirectory()) return false;
    await rm(full, { force: true });
    return true;
  } catch (err) { return err?.code === 'ENOENT'; }
}

/**
 * What rewinding `paths` from `after` (the request's end) back to `before` (its start) would do,
 * as the working tree is `now`: { patch, files: [{ path, change: 'restore' | 'delete' | 'recreate', since }] },
 * or null when git can't read one of the trees. `since`: the file changed again after the
 * request ended (you, or another agent): putting it back would lose that too. `patch`: the
 * diff from now to before, for a preview ('' when there are too many files to list).
 */
export async function rewindPlan(root, { before, after, now, paths }, { git = runGit, max = 60_000 } = {}) {
  if (!paths.length) return { files: [], patch: '' };
  const [inBefore, inNow, sinceOut] = await Promise.all([
    treeFiles(root, before, git),
    treeFiles(root, now, git),
    after ? git(['-c', 'core.quotepath=off', 'diff', '--name-only', '-z', '--no-renames', after, now], root, { timeoutMs: 20_000 }) : '',
  ]);
  if (!inBefore || !inNow || sinceOut === null) return null;
  const since = new Set(sinceOut.split('\0').filter(Boolean));
  // The diff names the files on the command line: only when they fit on one.
  const fits = paths.reduce((n, p) => n + p.length + 1, 0) < 20_000;
  const diff = fits ? await git([...LITERAL, '-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '--no-renames', now, before, '--', ...paths], root, { timeoutMs: 20_000 }) : '';
  const files = paths.map((path) => ({ path, change: !inBefore.has(path) ? 'delete' : inNow.has(path) ? 'restore' : 'recreate', since: since.has(path) }));
  const patch = String(diff ?? '');
  return { files, patch: patch.length > max ? `${patch.slice(0, max)}\n… (${patch.length - max} more characters)` : patch };
}

/**
 * Put `paths` back as they are in `tree`: written from it (through a private index, so yours
 * isn't touched, the paths given on stdin), or deleted when the tree doesn't have them (the
 * request created them). → { restored: [paths], deleted: [paths] }, or null when git couldn't
 * read the tree or write the files: then nothing is deleted. Paths outside the repository,
 * and files behind a link that leads out of it, are left alone.
 */
export async function restoreFiles(root, tree, paths, { git = runGit, remove = removeInside } = {}) {
  const asked = [...new Set(paths)];
  const safe = asked.filter((p) => inside(root, p));
  const skipped = asked.filter((p) => !safe.includes(p));
  if (!safe.length) return { restored: [], deleted: [], skipped };
  const present = await treeFiles(root, tree, git);
  if (!present) return null;
  // Written only where the folder is really inside the repository: a folder that's become a
  // link to somewhere else is left as it is (git would replace the link with a folder).
  const write = [];
  for (const p of safe.filter((x) => present.has(x))) (await folderInside(root, inside(root, p)) ? write : skipped).push(p);
  const gone = safe.filter((p) => !present.has(p));
  if (write.length) {
    const ok = await withIndex(root, git, async (env) => {
      if ((await git([...EXACT, 'read-tree', tree], root, { env })) === null) return false;
      return (await git([...EXACT, 'checkout-index', '-f', '-z', '--stdin'], root, { env, timeoutMs: 30_000, input: write.join('\0') })) !== null;
    });
    if (!ok) return null;
  }
  const deleted = [];
  for (const p of gone) (await remove(root, p) ? deleted : skipped).push(p);
  return { restored: write, deleted, skipped };
}

/**
 * How the test files differ from the last commit, as git sees them: { 'test/math.test.js':
 * '-  assert.equal(sum(1, 2), 3);\n+  assert.equal(sum(1, 2), -1);' } (the removed and added
 * lines of `git diff -U0`), {} when they don't, null when git can't say (not a repository, no
 * commit yet). Taken at each test run, so the faked-pass check sees how the tests changed
 * between two runs however they were changed: an edit tool, `sed -i`, a heredoc, a script.
 * Only tracked files: a new test file can't weaken a test that was there. `isTest` picks them.
 */
export async function testDiff(cwd, isTest, { git = runGit, max = 8000 } = {}) {
  if (!cwd) return null;
  const globs = ['**/*test*', '**/*spec*', '**/test/**', '**/tests/**', '**/__tests__/**', '**/spec/**'].map((g) => `:(top,glob)${g}`);
  const out = await git(['-c', 'core.quotepath=off', 'diff', '-U0', '--no-color', '--no-ext-diff', 'HEAD', '--', ...globs], cwd);
  if (out === null) return null;
  const files = {};
  let file = null;
  let size = 0;
  for (const line of out.split('\n')) {
    const head = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (head) { file = isTest(head[1]) ? head[1] : null; continue; }
    if (!file || /^(?:---|\+\+\+) /.test(line) || (line[0] !== '-' && line[0] !== '+')) continue;
    if ((size += line.length + 1) > max) break; // enough to judge; a huge rewrite isn't a quiet weakening
    files[file] = files[file] ? `${files[file]}\n${line}` : line;
  }
  return files;
}

/**
 * `git status --porcelain=v1 -z` → [{ path, code }]: code is the two status letters
 * ("??" new, " M" changed, " D" deleted, "R " renamed: the new name, with `from`).
 */
export function parseStatus(out) {
  const parts = String(out ?? '').split('\0');
  const list = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const code = p.slice(0, 2);
    const item = { code, path: p.slice(3) };
    if (code[0] === 'R' || code[0] === 'C') item.from = parts[++i]; // the old name follows a rename
    list.push(item);
  }
  return list;
}

/**
 * The state of the repository `cwd` is in: { root, head, branch, files: { path: { code, sig } } },
 * { root, head, branch, tooMany: true }, or null when it isn't a git repository. Paths are
 * relative to the repository's root, with forward slashes. `branch` is null when HEAD is
 * detached (a commit or a tag checked out).
 */
export async function snapshot(cwd, { git = runGit, statFile = stat, at = Date.now() } = {}) {
  if (!cwd) return null;
  const root = (await git(['rev-parse', '--show-toplevel'], cwd))?.trim();
  if (!root) return null;
  const [head, branch] = (await Promise.all([
    git(['rev-parse', '--verify', '-q', 'HEAD'], root),
    git(['symbolic-ref', '--short', '-q', 'HEAD'], root), // works before the first commit too; fails when detached
  ])).map((out) => out?.trim() || null);
  const out = await git(['-c', 'core.quotepath=off', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], root);
  if (out === null) return null;
  const list = parseStatus(out);
  if (list.length > LIMIT) return { root, head, branch, at, tooMany: true };
  const files = {};
  await Promise.all(list.map(async ({ code, path }) => {
    let sig = 'gone';
    try { const s = await statFile(join(root, path)); sig = `${s.size}:${Math.round(s.mtimeMs)}`; } catch {}
    files[path] = { code, sig };
  }));
  return { root, head, branch, at, files };
}

const kindOf = (code) => (code === '??' || code.includes('A') ? 'write' : code.includes('D') ? 'delete' : 'edit');

/**
 * What changed between two snapshots of the same repository:
 *   { files: [{ path, change: 'write' | 'edit' | 'delete' }], committed, tooMany? }
 * `committed`: HEAD moved (a commit, or a checkout). Committed files come from the
 * commits made during the request (reachable from the new HEAD, not the old one, and no
 * older than the first snapshot): switching to a sibling branch moves HEAD too, and that
 * branch's older commits aren't this request's work. A repository with no prior HEAD
 * gets the new tree.
 */
export async function changesBetween(a, b, { git = runGit } = {}) {
  if (!a || !b || a.root !== b.root) return null;
  if (a.tooMany || b.tooMany) return { files: [], committed: a.head !== b.head, tooMany: true };
  const out = new Map();
  const before = a.files;
  const after = b.files;
  for (const [path, now] of Object.entries(after)) {
    const was = before[path];
    if (was && was.sig === now.sig && was.code === now.code) continue; // already changed, and not since
    out.set(path, now.sig === 'gone' ? 'delete' : was ? (was.sig === 'gone' ? 'write' : 'edit') : kindOf(now.code));
  }
  // Changed when it started, unchanged now: undone (or committed, see below).
  for (const path of Object.keys(before)) if (!after[path]) out.set(path, 'edit');
  const committed = !!(b.head && a.head !== b.head);
  if (committed && a.head) {
    // The commits this request made: committed after the first snapshot (no slack: a sibling
    // branch's commit from a minute ago isn't this request's), oldest first, each diffed
    // against its first parent so a merge's changes count too.
    // Git's commit time is whole seconds: a commit from the snapshot's own second is treated as
    // before it (a sibling branch's commit from that second isn't the request's; a request can't
    // commit within its first second).
    const since = Math.floor((a.at ?? Date.now()) / 1000);
    const log = await git(['log', '--reverse', '--format=%H %ct %P', `${a.head}..${b.head}`], b.root);
    const mine = String(log ?? '').split('\n').map((l) => l.trim().split(' ')).filter(([h, ct]) => h && Number(ct) > since);
    for (const [hash, , parent] of mine) {
      const diff = parent
        ? await git(['-c', 'core.quotepath=off', 'diff', '--name-status', '-z', '--no-renames', parent, hash], b.root)
        : await git(['-c', 'core.quotepath=off', 'ls-tree', '-r', '--name-only', '-z', hash], b.root);
      const parts = String(diff ?? '').split('\0').filter(Boolean);
      if (!parent) { for (const path of parts) if (!out.has(path)) out.set(path, 'write'); continue; }
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const change = parts[i][0] === 'A' ? 'write' : parts[i][0] === 'D' ? 'delete' : 'edit';
        const path = parts[i + 1];
        // Net state across the request's commits: written then edited is still "written"; deleted wins.
        if (change === 'delete' || !out.has(path) || out.get(path) !== 'write') out.set(path, change);
      }
    }
  } else if (committed) {
    const tree = await git(['-c', 'core.quotepath=off', 'ls-tree', '-r', '--name-only', '-z', b.head], b.root);
    for (const path of String(tree ?? '').split('\0').filter(Boolean)) if (!out.has(path)) out.set(path, 'write');
  }
  const files = [...out].map(([path, change]) => ({ path, change })).sort((x, y) => x.path.localeCompare(y.path));
  return { files, committed };
}

/**
 * For the bridge: snapshots per session, taken when a request starts and compared when it
 * ends. start(session, cwd) and finish(session, cwd) → Promise<changes | null>, with the
 * branch and HEAD the request ended on.
 */
export function createGround({ git = runGit, statFile = stat, restorePoints = () => false } = {}) {
  const starts = new Map(); // session → Promise<snapshot, with `tree` when a restore point was saved>
  return {
    start(session, cwd, at) {
      const p = snapshot(cwd, { git, statFile, at }).then(async (snap) => {
        if (snap && restorePoints()) snap.tree = await checkpoint(snap.root, { git, snap }).catch(() => null);
        return snap;
      }).catch(() => null);
      starts.set(session, p);
      if (starts.size > 200) starts.delete(starts.keys().next().value);
      return p;
    },
    async finish(session, cwd) {
      const before = await starts.get(session);
      if (!before) return null;
      const after = await snapshot(cwd, { git, statFile }).catch(() => null);
      const changes = await changesBetween(before, after, { git });
      if (!changes) return null;
      // Restore points: the tree before and after, when both could be saved.
      const tree = before.tree && after ? await checkpoint(after.root, { git, snap: after }).catch(() => null) : null;
      return { ...changes, root: before.root, since: before.at, branch: after.branch, head: after.head, ...(tree ? { trees: { before: before.tree, after: tree } } : {}) };
    },
    has: (session) => starts.has(session),
  };
}
