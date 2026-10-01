// Two agents, one file: spot an agent about to change (or just changing) a file that
// another agent session changed a few minutes ago, while that session is still at it.
// That's how parallel agents overwrite each other's work.
//
// Plain rules, no I/O: the bridge (server.js) feeds it the activity log. Claude Code can
// be paused before the edit (its PreToolUse hook, bridge/guard-hook.js); every other
// agent only gets an alert, after the fact, since dotpals just follows what it did.

/** Claude Code tools that change a file (the PreToolUse hook waits only for these). */
export const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const CHANGES = new Set(['edit', 'write', 'delete']);
const ACTIVE = new Set(['working', 'thinking', 'speaking', 'waiting']);

/**
 * One spelling per file: forward slashes, `.` and `..` worked out, lower case (Windows
 * and macOS don't care about case, and two agents rarely use two spellings on purpose).
 * A relative path is taken from `cwd`, the session's project folder, when it's known.
 */
export function pathKey(path, cwd) {
  let p = String(path ?? '').trim().replace(/\\/g, '/');
  if (!p) return '';
  const absolute = /^([a-z]:)?\//i.test(p) || p.startsWith('~');
  if (!absolute && cwd) p = `${String(cwd).replace(/\\/g, '/').replace(/\/+$/, '')}/${p}`;
  const parts = [];
  for (const part of p.split('/')) {
    if (part === '.' || (part === '' && parts.length)) continue;
    if (part === '..' && parts.length > 1) parts.pop();
    else parts.push(part);
  }
  return parts.join('/').toLowerCase();
}

/** The session a helper agent belongs to (helpers can have sessions of their own, like Codex's). */
function rootOf(session, parents) {
  let s = session;
  for (let i = 0; i < 8 && parents?.get(s); i++) s = parents.get(s);
  return s;
}

/**
 * Did another session change `path` within `within` ms before `at`, and is it still
 * active? Returns the newest such change, { path, session, harness, label, at }, or null.
 *
 *   entries   the activity log (any order)
 *   session   the session about to change the file; its own helpers don't count
 *   path      the file (absolute, or relative to `cwd`)
 *   states    session → its pal state; 'sleeping' (put away, or ended) is never active
 *   cwds      session → its project folder, for the relative paths other agents report
 *   parents   helper session → the session that started it
 *
 * A change counts when it worked or is under way (not failed, not one dotpals paused).
 * The other session is active when it's working, thinking or waiting for you, or did
 * anything within `within`. Reads don't count.
 */
export function findConflict(entries, { session, path, cwd, at = Date.now(), within = 10 * 60_000, states = new Map(), cwds = new Map(), parents = new Map() } = {}) {
  const key = pathKey(path, cwd);
  if (!key || !session) return null;
  const mine = rootOf(String(session), parents);
  const lastAt = new Map(); // session → its newest activity
  let found = null;
  for (const e of entries) {
    if (!e?.session) continue;
    lastAt.set(e.session, Math.max(lastAt.get(e.session) ?? 0, e.at ?? 0));
    if (e.session === session || rootOf(e.session, parents) === mine) continue;
    if (!(e.at >= at - within && e.at <= at + 1000)) continue;
    const counts = e.status === 'ok' || ((e.status === 'running' || e.status === 'waiting') && !e.guard);
    if (!counts) continue;
    for (const f of e.files ?? []) {
      if (!CHANGES.has(f.change) || pathKey(f.path, cwds.get(e.session)) !== key) continue;
      if (!found || e.at > found.at) found = { path: f.path, session: e.session, harness: e.harness, label: e.label, at: e.at };
    }
  }
  if (!found) return null;
  const state = states.get(found.session);
  if (state === 'sleeping') return null;
  const active = ACTIVE.has(state) || (lastAt.get(found.session) ?? 0) >= at - within;
  return active ? found : null;
}

const AGENTS = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini', opencode: 'OpenCode', copilot: 'Copilot' };
const agentName = (h) => AGENTS[h] ?? (h ? h[0].toUpperCase() + h.slice(1) : 'Another agent');
const fileName = (p) => String(p).split(/[\\/]/).pop();
/** "Codex (api)" */
export const who = (s) => `${agentName(s?.harness)}${s?.label ? ` (${s.label})` : ''}`;
/** "2 minutes ago", "just now" */
export function ago(at, now = Date.now(), short = false) {
  const m = Math.round((now - at) / 60_000);
  if (m < 1) return 'just now';
  return `${m} ${short ? 'min' : m === 1 ? 'minute' : 'minutes'} ago`;
}

/** What Claude Code shows (or Claude reads) before the edit: "Codex (api) changed billing.ts 2 minutes ago." */
export function guardReason(conflict, now = Date.now()) {
  return `${who(conflict)} changed ${fileName(conflict.path)} ${ago(conflict.at, now)}.`;
}

/**
 * Claude Code's PreToolUse answer for a conflict (code.claude.com/docs/en/hooks →
 * PreToolUse decision control): 'ask' shows you its prompt with the reason; 'tell'
 * denies the edit and gives Claude the reason, so it re-reads the file and decides.
 */
export function guardReply(conflict, mode, now = Date.now()) {
  if (!conflict || (mode !== 'ask' && mode !== 'tell')) return null;
  const reason = guardReason(conflict, now);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: mode === 'ask' ? 'ask' : 'deny',
      permissionDecisionReason: mode === 'ask' ? `${reason} Edit anyway?` : `${reason} Re-read the file first, then decide.`,
    },
  };
}

/** The alert: "Codex is editing billing.ts, which Claude (shop) changed 2 min ago". */
export function alertText(by, conflict, now = Date.now()) {
  return `${agentName(by?.harness)} is editing ${fileName(conflict.path)}, which ${who(conflict)} changed ${ago(conflict.at, now, true)}`;
}

/**
 * Alert once per file and pair of sessions per `every` (10 minutes): two agents taking
 * turns on a file shouldn't ring every time. `ok(...)` says whether to alert now.
 */
export function createAlerts({ every = 10 * 60_000 } = {}) {
  const last = new Map(); // file|session|session → when
  return {
    ok({ path, cwd, a, b }, now = Date.now()) {
      const key = `${pathKey(path, cwd)}|${[String(a), String(b)].sort().join('|')}`;
      if (now - (last.get(key) ?? -Infinity) < every) return false;
      last.set(key, now);
      if (last.size > 500) for (const [k, t] of last) if (now - t >= every) last.delete(k);
      return true;
    },
  };
}
