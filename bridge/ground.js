// Git as the ground truth for what a request changed. The agents' tool calls say which
// files they edited, but not what a command changed (`sed -i`, `node -e "fs.writeFileSync…"`,
// a code generator, a formatter). So when a request starts the bridge notes the state of
// the session's git repository, and when it ends, notes it again: the difference is what
// changed, however it was changed, including commits.
//
// A snapshot is HEAD plus every file `git status` lists (changed, new, deleted; not
// ignored ones), each with its size and modification time. A file that was already
// changed when the request started counts only if it changed again. Nothing is read
// but the file list and file times; nothing is written.
//
// It can't tell who changed a file: another agent working in the same repository at the
// same time shows up too, so the bridge notes which other sessions were active there.
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

const LIMIT = 5000; // more changed files than this: too many to compare (a build into a tracked folder)

/** Run git in `cwd`: resolves stdout, or null when it fails (not a repository, no git, too slow). */
export function runGit(args, cwd, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, out) => resolve(err ? null : out));
  });
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
 * The state of the repository `cwd` is in: { root, head, files: { path: { code, sig } } },
 * { root, tooMany: true }, or null when it isn't a git repository. Paths are relative to
 * the repository's root, with forward slashes.
 */
export async function snapshot(cwd, { git = runGit, statFile = stat, at = Date.now() } = {}) {
  if (!cwd) return null;
  const root = (await git(['rev-parse', '--show-toplevel'], cwd))?.trim();
  if (!root) return null;
  const head = (await git(['rev-parse', '--verify', '-q', 'HEAD'], root))?.trim() || null;
  const out = await git(['-c', 'core.quotepath=off', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], root);
  if (out === null) return null;
  const list = parseStatus(out);
  if (list.length > LIMIT) return { root, head, at, tooMany: true };
  const files = {};
  await Promise.all(list.map(async ({ code, path }) => {
    let sig = 'gone';
    try { const s = await statFile(join(root, path)); sig = `${s.size}:${Math.round(s.mtimeMs)}`; } catch {}
    files[path] = { code, sig };
  }));
  return { root, head, at, files };
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
    // The commits this request made: new since the first snapshot (with a minute's slack for clocks).
    const since = Math.floor((a.at ?? Date.now()) / 1000) - 60;
    const log = await git(['log', '--format=%H %ct', `${a.head}..${b.head}`], b.root);
    const mine = String(log ?? '').split('\n').map((l) => l.trim().split(' ')).filter(([h, ct]) => h && Number(ct) >= since).map(([h]) => h);
    for (const hash of mine) {
      const diff = await git(['-c', 'core.quotepath=off', 'diff-tree', '--no-commit-id', '-r', '--name-status', '-z', '--no-renames', hash], b.root);
      const parts = String(diff ?? '').split('\0').filter(Boolean);
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const change = parts[i][0] === 'A' ? 'write' : parts[i][0] === 'D' ? 'delete' : 'edit';
        if (!out.has(parts[i + 1])) out.set(parts[i + 1], change);
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
 * ends. start(session, cwd) and finish(session, cwd) → Promise<changes | null>.
 */
export function createGround({ git = runGit, statFile = stat } = {}) {
  const starts = new Map(); // session → Promise<snapshot>
  return {
    start(session, cwd, at) {
      const p = snapshot(cwd, { git, statFile, at }).catch(() => null);
      starts.set(session, p);
      if (starts.size > 200) starts.delete(starts.keys().next().value);
      return p;
    },
    async finish(session, cwd) {
      const before = await starts.get(session);
      if (!before) return null;
      const after = await snapshot(cwd, { git, statFile }).catch(() => null);
      const changes = await changesBetween(before, after, { git });
      return changes && { ...changes, root: before.root, since: before.at };
    },
    has: (session) => starts.has(session),
  };
}
