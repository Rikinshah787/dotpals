// The story of a request: hundreds of tool calls turned into a few chapters a
// person can read ("Looked through 18 files", "Changed 6 files", "Tests failed
// twice, then passed", "Committed and pushed"), the agent's live plan, and the
// things worth a second look (secrets touched, risky commands, a stuck loop).
//
// Plain rules, no AI: instant, free and the same every time. Shared by the pal
// (bridge/index.html) and the dashboard (bridge/dashboard.html); runs in Node too.
import { baseName, plural } from './recap.js';

// -- what a command is for ---------------------------------------------------------

const TEST = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bnode\s+--test\b|\b(jest|vitest|mocha|ava|pytest|tox|nox|rspec|phpunit|playwright\s+test|cypress\s+run)\b|\bgo\s+test\b|\bcargo\s+test\b|\bdotnet\s+test\b|\bgradle\w*\s+test\b|\bmvn\w*\s+test\b|\bpython\s+-m\s+(pytest|unittest)\b|\bdeno\s+test\b|\bmake\s+test\b/i;
const BUILD = /\b(npm|pnpm|yarn|bun)\s+run\s+(build|lint|typecheck|check|compile)\b|\btsc\b|\beslint\b|\bprettier\s+--check\b|\bruff\b|\bmypy\b|\bcargo\s+(build|check|clippy)\b|\bgo\s+(build|vet)\b|(?:^|[;&|]\s*)make(?=\s|$)(?!\s+test)|\bdotnet\s+build\b|\bnode\s+--check\b|\bvite\s+build\b|\bnext\s+build\b|\bwebpack\b/i;
const INSTALL = /\b(npm|pnpm|yarn|bun)\s+(install|i|add|ci)\b|\bpip3?\s+install\b|\buv\s+(add|pip\s+install|sync)\b|\bpoetry\s+add\b|\bcargo\s+add\b|\bgo\s+get\b|\bgem\s+install\b|\bbrew\s+install\b|\bapt(-get)?\s+install\b|\bwinget\s+install\b|\bchoco\s+install\b/i;
const SHIP = /\bgit\s+(commit|push|tag|merge|rebase|cherry-pick)\b|\bgh\s+(pr\s+(create|merge)|release\s+create|repo\s+create)\b|\bnpm\s+publish\b|\bvercel\b.*--prod|\bdocker\s+push\b/i;
// Commands that only look at things (they belong with reading files).
const LOOK = /^\s*(cd\s+\S+\s*(&&|;)\s*)?(ls|dir|cat|type|head|tail|less|more|wc|stat|file|tree|pwd|which|where|find|fd|grep|rg|ag|sed\s+-n|awk|jq|echo|printf|du|df|env|printenv|date|uname|whoami|ps|tasklist|netstat|lsof|curl\s+-s|git\s+(status|log|diff|show|branch|remote|ls-files|blame|rev-parse|config\s+--get)|gh\s+(run|pr|issue|repo)\s+(list|view|watch|status)|Get-(ChildItem|Content|Item|Process|CimInstance|Command|Location)|Select-String|Test-Path|node\s+-e|node\s+-p|python\s+-c)\b/i;
// [pattern, what it did, what it will do (for approving it beforehand), level]
const RISKY = [
  [/\brm\s+-(r|rf|fr)\b|\bRemove-Item\b[^\n]*-Recurse|\brmdir\s+\/s\b|\bdel\s+\/[sq]/i, 'deleted files with a recursive delete', 'deletes files recursively'],
  [/\bgit\s+push\b[^\n]*(--force\b|\s-f\b|--force-with-lease)/i, 'force-pushed to git', 'force-pushes to git (can overwrite others’ work)'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|restore\s+\.)/i, 'threw away changes in git', 'throws away changes in git'],
  [/\b(drop\s+(table|database)|truncate\s+table)\b/i, 'dropped database tables', 'drops database tables'],
  [/\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]*\|\s*(sh|bash|zsh|iex|Invoke-Expression)\b/i, 'ran a script straight from the internet', 'runs a script straight from the internet'],
  [/\bchmod\s+(-R\s+)?777\b|\bsudo\b/i, 'changed system permissions', 'changes system permissions'],
  [/\b(taskkill|Stop-Process|kill\s+-9|pkill|killall)\b/i, 'force-stopped programs', 'force-stops programs'],
  [/\bnpm\s+publish\b/i, 'published a package', 'publishes a package', 'info'],
];
const SECRET = /(^|[\\/])(\.env(\.[\w-]+)?|\.npmrc|\.pypirc|id_(rsa|ed25519)|credentials?(\.json)?|secrets?\.[\w]+|[\w-]*\.(pem|key|p12|pfx))$/i;

const commandOf = (e) => String(e.body?.command ?? e.detail ?? e.title ?? '');

/** What kind of chapter a step belongs to. */
export function stepType(e) {
  switch (e.kind) {
    // Not steps: what you asked, and how the turn ended.
    case 'prompt': case 'done': case 'error': return 'quiet';
    case 'read': case 'search': return 'explore';
    case 'edit': case 'write': case 'delete': return 'change';
    case 'web': return 'web';
    case 'agent': return 'agent';
    case 'skill': return 'skill';
    case 'mcp': return 'mcp';
    case 'plan': return 'plan';
    case 'compact': return 'memory';
    case 'run': {
      const cmd = commandOf(e);
      if (TEST.test(cmd)) return 'test';
      if (SHIP.test(cmd)) return 'ship';
      if (INSTALL.test(cmd)) return 'install';
      if (BUILD.test(cmd)) return 'build';
      if (LOOK.test(cmd) && !/[>]|\|\s*(sh|bash|iex)/.test(cmd)) return 'explore';
      return 'run';
    }
  }
  if (/^AskUserQuestion$|^request_user_input$/i.test(e.tool ?? '')) return 'ask';
  if (/^(TaskCreate|TaskUpdate|TaskList|TaskGet|TodoWrite|update_plan)$/.test(e.tool ?? '')) return 'plan';
  if (/^(ToolSearch|SendMessage|SubagentHandback|ListAgents)$/.test(e.tool ?? '')) return 'quiet';
  return 'tool';
}

// A file path the adapter couldn't make relative to the project: scratch files, temp folders.
const outside = (e) => (e.files ?? []).length > 0 && /^([A-Za-z]:[\\/]|\/|~)/.test(String(e.title ?? ''));

/**
 * Group a request's steps (oldest first) into chapters, one per kind of work, in the
 * order the work started: { type, steps, at, end, status, title, detail, lines, files, flags }.
 * Hundreds of tool calls become a handful of lines; each chapter keeps its steps.
 */
export function chapters(steps) {
  const groups = new Map();
  for (const e of steps) {
    let type = stepType(e);
    if (type === 'plan' || type === 'quiet') continue;
    if (type === 'change' && outside(e)) type = 'scratch';
    if (!groups.has(type)) groups.set(type, { type, steps: [] });
    groups.get(type).steps.push(e);
  }
  // What it did first (changes, tests, shipping), then how it got there.
  return [...groups.values()].map(describe).sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
}

// -- describing a chapter ---------------------------------------------------------

const running = (e) => e.status === 'running' || e.status === 'waiting';
const patchLines = (steps) => {
  let add = 0;
  let del = 0;
  for (const e of steps) {
    if (e.status === 'failed') continue;
    for (const line of String(e.body?.patch ?? '').split('\n')) {
      if (line.startsWith('+')) add++;
      else if (line.startsWith('-')) del++;
    }
  }
  return { add, del };
};
const uniqueFiles = (steps, changes) => {
  const seen = new Map();
  for (const e of steps) {
    if (e.status === 'failed') continue;
    for (const f of e.files ?? []) {
      if (changes && !changes.includes(f.change)) continue;
      const key = String(f.path).toLowerCase();
      seen.set(key, { ...f, times: (seen.get(key)?.times ?? 0) + 1 });
    }
  }
  return [...seen.values()];
};
const folders = (files) => {
  const count = new Map();
  for (const f of files) {
    const parts = String(f.path).replace(/\\/g, '/').split('/');
    const dir = parts.length > 1 ? parts.at(-2) : '';
    if (dir) count.set(dir, (count.get(dir) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d]) => `${d}/`);
};
const list = (names, max = 3) => (names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} +${names.length - max}`);
const quote = (s, n = 48) => { s = String(s).split('\n')[0].trim(); return `“${s.length > n ? `${s.slice(0, n - 1)}…` : s}”`; };
const ORDER = ['ask', 'change', 'test', 'build', 'install', 'ship', 'agent', 'skill', 'mcp', 'web', 'explore', 'run', 'tool', 'scratch', 'memory'];

/** The program a command runs: "npm", "git", "python" (not paths, quotes or variables). */
const firstWord = (cmd) => {
  const words = String(cmd).trim().replace(/^(cd\s+("[^"]*"|\S+)\s*(&&|;)\s*)+/, '').split(/\s+/);
  const word = words.find((w) => !/^\w+=/.test(w)) ?? '';
  const name = word.replace(/^["'&(]+|["');]+$/g, '').split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, '');
  return /^[A-Za-z][\w.-]*$/.test(name) ? name : '';
};
const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n}×`);

/** "failed twice, then passed" from a list of test runs. */
function outcome(runs) {
  const done = runs.filter((e) => !running(e));
  if (!done.length) return { text: 'running', status: 'running' };
  const last = done.at(-1);
  const failed = done.filter((e) => e.status === 'failed').length;
  if (last.status === 'failed') return { text: failed === done.length && failed > 1 ? `failed ${times(failed)}` : 'failed', status: 'failed' };
  if (failed) return { text: `failed ${times(failed)}, then passed`, status: 'ok' };
  return { text: done.length > 1 ? `passed (${done.length} runs)` : 'passed', status: 'ok' };
}

function describe({ type, steps }) {
  const ch = { type, steps, at: steps[0].at, end: Math.max(...steps.map((e) => e.at + (e.ms ?? 0))), flags: [] };
  const live = steps.some(running);
  ch.status = live ? 'running' : steps.every((e) => e.status === 'failed') ? 'failed' : 'ok';
  const failed = steps.filter((e) => e.status === 'failed').length;
  const cmds = steps.filter((e) => e.kind === 'run');

  switch (type) {
    case 'explore': {
      const files = uniqueFiles(steps, ['read']);
      const searches = steps.filter((e) => e.kind === 'search').length;
      const looks = cmds.length;
      ch.title = files.length ? `${live ? 'Looking through' : 'Looked through'} ${plural(files.length, 'file')}` : searches ? `${live ? 'Searching' : 'Searched'} the code` : `${live ? 'Taking a quick look' : 'Took a quick look'} around`;
      ch.detail = [folders(files).length ? `in ${folders(files).join(', ')}` : '', searches ? plural(searches, 'search', 'searches') : '', looks ? plural(looks, 'quick command') : ''].filter(Boolean).join(' · ');
      ch.files = files;
      break;
    }
    case 'change': {
      const files = uniqueFiles(steps, ['edit', 'write', 'delete']);
      const created = files.filter((f) => f.change === 'write');
      const deleted = files.filter((f) => f.change === 'delete');
      ch.lines = patchLines(steps);
      const verb = live ? 'Changing' : 'Changed';
      ch.title = files.length === 1 ? `${live ? (created.length ? 'Writing' : 'Editing') : created.length ? 'Created' : deleted.length ? 'Deleted' : 'Changed'} ${baseName(files[0].path)}`
        : `${verb} ${plural(files.length, 'file')}${created.length && created.length < files.length ? ` (${created.length} new)` : created.length ? ' (all new)' : ''}`;
      ch.detail = files.length === 1 ? (files[0].times > 1 ? `${files[0].times} edits` : '') : list(files.map((f) => baseName(f.path)));
      ch.files = files;
      if (failed) ch.detail = [ch.detail, failureNote(steps, 'edit') || `${plural(failed, 'edit')} didn’t apply`].filter(Boolean).join(' · ');
      break;
    }
    case 'test': {
      const o = outcome(cmds);
      ch.status = o.status;
      ch.title = live ? 'Running the tests' : `Tests ${o.text}`;
      ch.detail = matched(cmds, TEST);
      break;
    }
    case 'build': {
      const o = outcome(cmds);
      ch.status = o.status;
      ch.title = live ? 'Checking the build' : `Build and checks ${o.text}`;
      ch.detail = matched(cmds, BUILD);
      break;
    }
    case 'scratch': {
      const files = uniqueFiles(steps, ['edit', 'write', 'delete']);
      ch.title = `${live ? 'Using' : 'Used'} ${plural(files.length, 'scratch file')} outside the project`;
      ch.detail = list(files.map((f) => baseName(f.path)));
      ch.files = files;
      ch.quiet = true;
      break;
    }
    case 'install': {
      ch.title = `${live ? 'Installing' : 'Installed'} packages`;
      // The package names after "npm install", "pip install"…
      const names = cmds.flatMap((e) => {
        const cmd = commandOf(e);
        const m = INSTALL.exec(cmd);
        return m ? cmd.slice(m.index + m[0].length).split(/[|&;>\n]/)[0].split(/\s+/).filter((w) => /^@?[A-Za-z][\w@./:=<>~^-]*$/.test(w)) : [];
      });
      ch.detail = names.length ? list([...new Set(names)], 4) : matched(cmds, INSTALL);
      if (failed) ch.status = 'failed';
      break;
    }
    case 'ship': {
      const all = cmds.map(commandOf).join('\n');
      const did = [];
      const msg = /git\s+commit\b[^\n]*?-m\s+(["'])([\s\S]*?)\1/.exec(all)?.[2];
      if (/git\s+commit\b/.test(all)) did.push(live ? 'committing' : 'committed');
      if (/git\s+push\b/.test(all)) did.push(live ? 'pushing' : 'pushed');
      if (/git\s+tag\b/.test(all)) did.push('tagged');
      const release = /gh\s+release\s+create\s+(\S+)/.exec(all)?.[1];
      if (release) did.push(`released ${release}`);
      if (/gh\s+pr\s+create/.test(all)) did.push('opened a pull request');
      if (/gh\s+pr\s+merge|git\s+merge/.test(all)) did.push('merged');
      if (/npm\s+publish/.test(all)) did.push('published to npm');
      const text = did.length ? did.join(', ').replace(/, ([^,]*)$/, ' and $1') : 'shipped';
      ch.title = text[0].toUpperCase() + text.slice(1);
      ch.detail = msg ? quote(msg, 60) : '';
      if (failed) { ch.status = cmds.at(-1)?.status === 'failed' ? 'failed' : 'ok'; ch.detail = [ch.detail, `${failed} failed`].filter(Boolean).join(' · '); }
      break;
    }
    case 'run': {
      const names = [...new Set(cmds.map((e) => firstWord(commandOf(e))).filter(Boolean))];
      ch.title = cmds.length === 1 ? `${live ? 'Running' : 'Ran'} ${quote(cmds[0].title || commandOf(cmds[0]))}` : `${live ? 'Running' : 'Ran'} ${plural(cmds.length, 'command')}`;
      ch.detail = [cmds.length > 1 ? list(names, 4) : '', failed ? failureNote(cmds, 'command') || `${failed} failed` : ''].filter(Boolean).join(' · ');
      if (failed && cmds.at(-1)?.status === 'failed') ch.status = 'failed';
      else if (!live) ch.status = 'ok';
      break;
    }
    case 'web': {
      ch.title = `${live ? 'Researching' : 'Researched'} online`;
      ch.detail = list(steps.map((e) => quote(e.title, 36)), 2);
      break;
    }
    case 'agent': {
      ch.title = steps.length === 1 ? `Asked a helper agent to ${lower(steps[0].title)}` : `Asked ${plural(steps.length, 'helper agent')} for help`;
      ch.detail = steps.length > 1 ? list(steps.map((e) => e.title), 2) : '';
      break;
    }
    case 'skill': {
      ch.title = `Used the ${list([...new Set(steps.map((e) => e.title))], 2)} skill${steps.length > 1 ? 's' : ''}`;
      break;
    }
    case 'mcp': {
      const servers = [...new Set(steps.map((e) => e.detail || e.title))];
      ch.title = `Used ${list(servers, 2)}`;
      ch.detail = list([...new Set(steps.map((e) => e.title))], 3);
      break;
    }
    case 'ask': {
      ch.title = live ? 'Asking you a question' : 'Asked you a question';
      ch.detail = question(steps[0]);
      ch.status = live ? 'waiting' : 'ok';
      break;
    }
    case 'memory': {
      ch.title = 'Tidied up its memory of the conversation';
      break;
    }
    default: {
      const names = [...new Set(steps.map((e) => e.title || e.tool))];
      ch.title = `Used ${list(names, 2)}`;
    }
  }
  ch.flags = flags(steps);
  return ch;
}

const lower = (s) => { s = String(s ?? '').trim(); return s ? s[0].toLowerCase() + s.slice(1) : 'help'; };
/** The part of the commands that made them tests (or builds): "npm test", "tsc". */
function matched(cmds, re) {
  const found = [...new Set(cmds.map((e) => re.exec(commandOf(e))?.[0]).filter(Boolean))];
  return found.length ? list(found, 2) : firstCommand(cmds);
}
function firstCommand(cmds) {
  const c = cmds.find((e) => e.status === 'failed') ?? cmds[0];
  const text = commandOf(c).split('\n')[0];
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}
function question(e) {
  try {
    const q = JSON.parse(e.body?.args ?? '{}');
    return q.questions?.[0]?.question ?? q.question ?? '';
  } catch { return ''; }
}

// -- worth a second look -----------------------------------------------------------

/**
 * Flags on a set of steps: { level: 'warn' | 'info', text, step }.
 *   warn: secrets touched, risky commands, the same command failing again and again
 *   info: packages installed, things published
 * `before: true` words them for something about to happen ("Force-pushes to git"),
 * for approving a step before it runs.
 */
export function flags(steps, { before = false } = {}) {
  const out = [];
  const seen = new Set();
  const add = (level, text, step) => { if (!seen.has(text)) { seen.add(text); out.push({ level, text, step }); } };
  const fails = new Map();
  for (const e of steps) {
    for (const f of e.files ?? []) {
      if (SECRET.test(String(f.path)) && f.change !== 'read') add('warn', `${before ? 'Changes' : 'Changed'} ${baseName(f.path)}, which usually holds secrets`, e);
      else if (SECRET.test(String(f.path))) add('info', `${before ? 'Reads' : 'Read'} ${baseName(f.path)}, which usually holds secrets`, e);
    }
    if (e.kind !== 'run') continue;
    const cmd = commandOf(e);
    for (const [re, did, will, level = 'warn'] of RISKY) {
      const text = before ? will : did;
      if (re.test(cmd)) add(level, text[0].toUpperCase() + text.slice(1), e);
    }
    if (e.status === 'failed') {
      const key = cmd.trim().slice(0, 200);
      fails.set(key, (fails.get(key) ?? 0) + 1);
      if (fails.get(key) === 3) add('warn', `The same command failed 3 times: ${quote(e.title || cmd, 40)}`, e);
    }
  }
  return out;
}

// -- retries: a failed step and the agent's next tries at the same thing ---------------

/** What a step was trying to do, to spot the next try at it: the same file, the same command or the same tool call. */
function target(e) {
  // Changing a file and reading it are different things: a read isn't a retry of an edit.
  const changed = (e.files ?? []).find((f) => f.change !== 'read')?.path;
  const file = changed ?? e.files?.[0]?.path;
  if (file) return `${changed ? 'change' : 'read'}:${String(file).replace(/\\/g, '/').toLowerCase()}`;
  if (e.kind === 'run') return `cmd:${commandOf(e).trim().replace(/\s+/g, ' ').slice(0, 200)}`;
  return e.tool ? `tool:${e.tool}:${e.title ?? ''}` : null;
}

/**
 * Link each failed step to the agent's later tries at the same thing (the same file,
 * the same command, the same tool call), within the next 25 steps and 15 minutes:
 *   Map(failed step id → { attempts: [failed, …tries], outcome: 'fixed' | 'failing' | 'trying' })
 * plus `retryOf`: Map(step id → the failed step it retried). It's a good guess, not a
 * certainty: agents don't say "this is a retry", so a later step at the same target counts.
 */
export function retries(steps) {
  const list = [...steps].filter((e) => !['prompt', 'done', 'error', 'plan', 'compact'].includes(e.kind)).sort((a, b) => a.at - b.at);
  const chains = new Map();
  const retryOf = new Map();
  for (let i = 0; i < list.length; i++) {
    const first = list[i];
    if (first.status !== 'failed' || retryOf.has(first.id)) continue;
    const key = target(first);
    if (!key) continue;
    const attempts = [first];
    for (let j = i + 1; j < list.length && j <= i + 25; j++) {
      const e = list[j];
      if (e.at - attempts.at(-1).at > 15 * 60_000) break;
      if (e.session !== first.session || target(e) !== key) continue;
      attempts.push(e);
      retryOf.set(e.id, first.id);
      if (e.status !== 'failed') break; // fixed (or still running): the chain ends here
    }
    const last = attempts.at(-1);
    const outcome = last === first ? 'failing' : last.status === 'failed' ? 'failing' : running(last) ? 'trying' : 'fixed';
    chains.set(first.id, { attempts, outcome });
  }
  return { chains, retryOf };
}

/** "1 edit failed, fixed on the next try" / "2 failed, both fixed" / "1 still failing", for a chapter. */
function failureNote(steps, noun) {
  const { chains } = retries(steps);
  const firsts = [...chains.values()];
  if (!firsts.length) return '';
  const total = firsts.length;
  const fixed = firsts.filter((c) => c.outcome === 'fixed');
  const failing = firsts.filter((c) => c.outcome === 'failing').length;
  if (fixed.length === total) {
    if (total === 1) return `1 ${noun} failed, fixed on ${fixed[0].attempts.length === 2 ? 'the next try' : `try ${fixed[0].attempts.length}`}`;
    return `${total} failed, ${total === 2 ? 'both' : 'all'} fixed`;
  }
  if (total === 1 && failing === 1) {
    const tries = firsts[0].attempts.length;
    return tries > 1 ? `still failing after ${tries} tries` : `1 ${noun} failed`;
  }
  return [`${total} failed${fixed.length ? `, ${fixed.length} fixed` : ''}`, failing ? `${failing} still failing` : ''].filter(Boolean).join(' · ');
}

// -- the agent's own plan ----------------------------------------------------------

/**
 * The newest plan in a session's steps (oldest first), from Claude's TodoWrite or
 * TaskCreate/TaskUpdate, or Codex's update_plan:
 *   { items: [{ text, active, status: 'pending' | 'in_progress' | 'completed' }], done, total, current }
 */
export function planOf(steps) {
  let items = null;
  for (const e of steps) {
    if (Array.isArray(e.plan)) items = e.plan.map((p) => ({ ...p }));
    else if (e.task?.op === 'create') (items ??= []).push({ id: String(items.length + 1), text: e.task.text, active: e.task.active, status: 'pending' });
    else if (e.task?.op === 'update' && items) {
      const item = items.find((p) => p.id === String(e.task.id));
      if (item) {
        if (e.task.status === 'deleted') items.splice(items.indexOf(item), 1);
        else Object.assign(item, e.task.status ? { status: e.task.status } : {}, e.task.text ? { text: e.task.text } : {});
      }
    }
  }
  if (!items?.length) return null;
  const done = items.filter((p) => p.status === 'completed').length;
  const current = items.find((p) => p.status === 'in_progress') ?? null;
  return { items, done, total: items.length, current };
}

// -- one line for right now ---------------------------------------------------------

/**
 * What the agent is doing, in a few words, for the pal's speech bubble. It
 * changes when the chapter changes, not on every tool call, so you can read it.
 */
export function headline(steps, plan) {
  if (plan?.current) {
    const text = plan.current.active || plan.current.text;
    return `${plan.done + 1}/${plan.total} · ${words(text, 40)}`;
  }
  const chs = chapters(steps);
  const newest = steps.filter((e) => !['plan', 'quiet'].includes(stepType(e))).at(-1);
  const ch = chs.find((c) => c.steps.includes(newest)) ?? chs.at(-1);
  if (!ch) return null;
  const count = ch.type === 'change' ? ch.files?.length : 0;
  const short = {
    explore: 'Looking around',
    change: count > 1 ? `Changing files · ${count} so far` : ch.title,
    test: 'Running the tests',
    build: 'Checking the build',
    install: 'Installing packages',
    ship: 'Shipping it',
    web: 'Researching online',
    agent: 'Working with a helper',
    ask: 'Has a question for you',
  }[ch.type];
  const text = ch.status === 'running' || !short ? (short ?? ch.title) : short;
  return words(text, 48);
}

// -- what a session has been using ----------------------------------------------------

/**
 * The skills, plugins, MCP tools and helper agents a session used, most used first:
 *   { skills: [{ name, plugin?, uses }], tools: [{ name, plugin?, uses }], plugins: [name], helpers: n }
 * Plugin skills are named "plugin:skill"; plugin MCP servers "plugin_<plugin>_<server>".
 */
export function toolkit(entries) {
  const skills = new Map();
  const tools = new Map();
  const plugins = new Set();
  let helpers = 0;
  const bump = (map, name, plugin) => {
    const item = map.get(name) ?? { name, plugin, uses: 0 };
    item.uses++;
    map.set(name, item);
    if (plugin) plugins.add(plugin);
  };
  for (const e of entries) {
    if (e.kind === 'skill' && e.title) {
      const [plugin, name] = e.title.includes(':') ? e.title.split(':', 2) : [undefined, e.title];
      bump(skills, name, plugin);
    } else if (e.kind === 'mcp') {
      const server = String(e.detail || e.title || '').trim();
      const m = /^plugin[ _]([\w-]+?)[ _]([\w-]+)$/.exec(server);
      bump(tools, m ? m[2] : server, m ? m[1] : undefined);
    } else if (e.kind === 'agent') helpers++;
  }
  const byUse = (map) => [...map.values()].sort((a, b) => b.uses - a.uses);
  return { skills: byUse(skills), tools: byUse(tools), plugins: [...plugins], helpers };
}

// -- where agents cross paths -----------------------------------------------------------

/**
 * Files that two or more sessions changed at around the same time (their edits
 * within `within` of each other, default 30 minutes), since `since` (default: the
 * last 2 hours). That's how parallel agents overwrite each other's work; the same
 * file edited by one session and then another hours later is just normal work.
 *   [{ path, sessions: [{ session, harness, label, at }] }], most recent first.
 */
export function overlaps(entries, since = Date.now() - 2 * 3600_000, { within = 30 * 60_000 } = {}) {
  const files = new Map(); // lower-cased path → { path, sessions: Map(session → { …, first, at }) }
  for (const e of entries) {
    if (e.at < since || e.status === 'failed') continue;
    for (const f of e.files ?? []) {
      if (!['edit', 'write', 'delete'].includes(f.change)) continue;
      const key = String(f.path).replace(/\\/g, '/').toLowerCase();
      const item = files.get(key) ?? { path: f.path, sessions: new Map() };
      const prev = item.sessions.get(e.session);
      item.sessions.set(e.session, { session: e.session, harness: e.harness, label: e.label, first: Math.min(prev?.first ?? Infinity, e.at), at: Math.max(prev?.at ?? 0, e.at) });
      files.set(key, item);
    }
  }
  const out = [];
  for (const f of files.values()) {
    const list = [...f.sessions.values()].sort((a, b) => a.first - b.first);
    // Sessions whose edits to this file came within `within` of another session's.
    const close = list.filter((a) => list.some((b) => b !== a && a.first <= b.at + within && b.first <= a.at + within));
    if (close.length > 1) out.push({ path: f.path, sessions: close.map(({ first, ...s }) => s).sort((a, b) => a.at - b.at) });
  }
  return out.sort((a, b) => b.sessions.at(-1).at - a.sessions.at(-1).at);
}

// -- compacting ------------------------------------------------------------------------

/**
 * A `/compact` command with a note on what to keep, written from the session's own
 * record: the goal, what's still on the plan, the files changed and whether the
 * tests are failing. Claude Code and Codex both take `/compact <instructions>`; a
 * good note keeps the summary from dropping what matters. Paste it into the agent.
 */
export function compactNote(entries) {
  const list = [...entries].sort((a, b) => a.at - b.at);
  const clipped = (s, n) => { s = String(s ?? '').split('\n')[0].trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
  const goal = list.findLast((e) => e.kind === 'prompt')?.title;
  const plan = planOf(list);
  const todo = plan?.items.filter((p) => p.status !== 'completed').slice(0, 4).map((p) => clipped(p.text, 60)) ?? [];
  const files = [];
  for (const e of list.slice().reverse()) {
    if (e.status === 'failed') continue;
    for (const f of e.files ?? []) {
      if (!['edit', 'write', 'delete'].includes(f.change)) continue;
      const name = baseName(f.path);
      if (!files.includes(name)) files.push(name);
    }
    if (files.length >= 8) break;
  }
  const lastTest = list.findLast((e) => e.kind === 'run' && stepType(e) === 'test' && e.status !== 'running');
  const parts = [
    goal && `Keep the current goal: "${clipped(goal, 140)}"`,
    todo.length && `still to do: ${todo.join('; ')}`,
    files.length && `files changed so far: ${files.join(', ')}`,
    lastTest?.status === 'failed' && `the tests are failing right now (${clipped(commandOf(lastTest), 40)})`,
  ].filter(Boolean);
  const sentences = parts.map((x) => x[0].toUpperCase() + x.slice(1));
  return `/compact ${sentences.length ? `${sentences.join('. ')}.` : 'Keep the current goal and the files changed so far.'}`;
}

// -- telling one agent what the others did -------------------------------------------

/**
 * A short note for an agent session about what *other* sessions did in the same
 * project recently: what they changed, whether their tests pass, whether they're
 * still at it. So two agents don't work blind on the same code. Returns
 * { text, newest } or null when there's nothing worth saying.
 *
 *   entries   every activity entry (any order)
 *   session   the session the note is for; label: its project (folder name)
 *   since     only work after this time (default: the last 2 hours)
 *   states    session → its current state ('working', 'done'…), if known
 */
export function crossRecap(entries, { session, label, since = Date.now() - 2 * 3600_000, states = new Map(), max = 4 } = {}) {
  if (!label) return null;
  const others = new Map(); // session → its entries
  for (const e of entries) {
    if (e.session === session || e.label !== label || e.at < since) continue;
    if (!others.has(e.session)) others.set(e.session, []);
    others.get(e.session).push(e);
  }
  const agoText = (at) => { const m = Math.round((Date.now() - at) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)}h ago`; };
  const lines = [];
  let newest = 0;
  for (const [id, list] of [...others].sort((a, b) => Math.max(...b[1].map((e) => e.at)) - Math.max(...a[1].map((e) => e.at)))) {
    list.sort((a, b) => a.at - b.at);
    const last = list.at(-1).at;
    const files = [];
    for (const e of list.slice().reverse()) {
      if (e.status === 'failed') continue;
      for (const f of e.files ?? []) if (['edit', 'write', 'delete'].includes(f.change) && !files.includes(f.path)) files.push(f.path);
    }
    const test = list.findLast((e) => e.kind === 'run' && stepType(e) === 'test' && e.status !== 'running');
    const asked = list.findLast((e) => e.kind === 'prompt')?.title;
    if (!files.length && !test) continue; // only looked around: not worth mentioning
    newest = Math.max(newest, last);
    const agent = { claude: 'Claude', codex: 'Codex' }[list[0].harness] ?? list[0].harness ?? 'Another agent';
    const state = states.get(id);
    const status = ['working', 'thinking', 'speaking', 'waiting'].includes(state) ? 'working now' : `last active ${agoText(last)}`;
    const parts = [];
    if (files.length) parts.push(`changed ${files.slice(0, 5).map((p) => relativeish(p, label)).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}`);
    if (test) parts.push(test.status === 'failed' ? `its last test run failed (${words(commandOf(test), 40)})` : 'its tests passed');
    if (asked) parts.push(`it was asked: "${words(asked, 80)}"`);
    lines.push(`- ${agent} (session ${String(id).slice(-4)}, ${status}): ${parts.join('; ')}.`);
    if (lines.length >= max) break;
  }
  if (!lines.length) return null;
  return {
    newest,
    text: [`dotpals: other coding agents worked in this project (${label}) recently:`, ...lines,
      'Check these files for their changes before editing them, and avoid undoing their work.'].join('\n'),
  };
}

/** A path from the project folder on ("src/app.js"), or just the file name. */
function relativeish(path, label) {
  const p = String(path).replace(/\\/g, '/');
  const i = p.toLowerCase().lastIndexOf(`/${String(label).toLowerCase()}/`);
  return i >= 0 ? p.slice(i + label.length + 2) : baseName(p);
}

/** Shorten to whole words (no "…"): the pal's bubble should read as a phrase. */
function words(text, n) {
  text = String(text).split('\n')[0].trim();
  if (text.length <= n) return text;
  let cut = text.slice(0, n + 1).replace(/\s+\S*$/, '').replace(/[\s,;:·–-]+$/, '');
  // Don't end on a word that needs another after it ("…scheme and").
  while (/\s(and|or|but|the|a|an|to|of|for|with|in|on|at|by|from|into|that)$/i.test(cut)) cut = cut.replace(/\s\S+$/, '');
  return cut.length >= n / 2 ? cut : text.slice(0, n).trim();
}

/** A turn's story: chapters, flags for the whole turn, and the plan. */
export function story(turn, sessionSteps = turn.steps) {
  const chs = chapters(turn.steps);
  return {
    chapters: chs,
    flags: chs.flatMap((c) => c.flags).filter((f, i, all) => all.findIndex((g) => g.text === f.text) === i),
    plan: planOf(sessionSteps),
  };
}
