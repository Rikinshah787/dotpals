// The story of a request: hundreds of tool calls turned into a few chapters a
// person can read ("Looked through 18 files", "Changed 6 files", "Tests failed
// twice, then passed", "Committed and pushed"), the agent's live plan, and the
// things worth a second look (secrets touched, risky commands, a stuck loop).
//
// Plain rules, no AI: instant, free and the same every time. Shared by the pal
// (bridge/index.html) and the dashboard (bridge/dashboard.html); runs in Node too.
import { baseName, facts, harnessName, plural, secs, turnTime } from './recap.js';
import { parseTestOutput } from './testout.js';

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

/**
 * Whether a command runs tests: a test command at the start of one of its parts
 * ("cd app && pytest", "CI=1 npm test | tail"), not just mentioned somewhere in it
 * (a script being written, an echo, a search for "npm test").
 */
function runsTests(cmd) {
  return parts(cmd).some((s) => s.search(TEST) === 0);
}

/**
 * The commands a command line actually runs, each from its start. Text written into a
 * file (a heredoc's body) and code in another language (`node -e "…"`, `python -c "…"`)
 * are left out, so writing a test that mentions `git push` or `rm -rf` doesn't count as
 * doing it. A script handed to a shell (`bash -c "…"`, `powershell -Command "…"`,
 * `cmd /c …`) is a command too, and is read as one. Split at && || ; | -exec and new
 * lines; wrappers and prefixes like `sudo`, `xargs`, `timeout 150`, `FOO=1`, `npx` and
 * `./node_modules/.bin/` are looked through.
 */
export function parts(cmd) {
  return scriptText(cmd).split(/\n|&&|\|\||[;|]/).map((part) => {
    let s = part.trim();
    for (let i = 0; i < 6; i++) {
      s = s
        .replace(/^&\s*/, '') // PowerShell's call operator
        .replace(/^(\w+=\S*\s+)+/, '') // FOO=1 npm test
        // Wrappers, with their options, including the ones that take a value (`xargs -n 1 rm -rf`, `sudo -u root …`).
        .replace(/^(?:sudo|doas)(?:\s+(?:-[ugCphUrtD]\s+\S+|-\S+))*\s+/i, '')
        .replace(/^xargs(?:\s+(?:-[nIPLdsaE]\s+\S+|-\S+))*\s+/i, '')
        .replace(/^env(?:\s+(?:-[uCS]\s+\S+|-\S+))*\s+/i, '')
        .replace(/^(?:nohup|exec|command)(?:\s+-\S+)*\s+/i, '')
        .replace(/^(?:timeout(?:\s+(?:-[sk]\s+\S+|-\S+))*\s+\d+[smhd]?|time|nice(?:\s+-n\s+\S+|\s+-\S+)*|npx|bunx|pnpm\s+exec|uv\s+run|poetry\s+run)\s+/i, '')
        .replace(/^["']?[^\s"']*[\\/](?=[\w.-]+["']?(\s|$))/, ''); // ./node_modules/.bin/jest
    }
    return s;
  }).filter(Boolean);
}

/**
 * A command line as the shell would run it: heredoc bodies (text written into a file) and
 * code in another language (node -e "…", python -c "…") left out, a shell's own script
 * (bash -c "…", cmd /c …) kept as commands.
 */
export function scriptText(cmd) {
  const unquote = (q) => q.slice(1, -1).replace(/\\(["\\])/g, '$1');
  return String(cmd)
    .replace(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '') // heredoc bodies
    // A shell's script is commands: bash -c "rm -rf x" → rm -rf x
    .replace(/\b(?:bash|sh|zsh|dash|fish|pwsh|powershell)(?:\.exe)?\b[^"'\n;&|]*?\s-(?:c|Command)\s+("(?:[^"\\]|\\.)*"|'[^']*')/gi, (_, q) => `;${unquote(q)};`)
    .replace(/\bcmd(?:\.exe)?\s+\/[ck]\s+/gi, ';')
    // Code in another language isn't a shell command: node -e "…", python -c "…"
    .replace(/\b(?:node|deno|bun|python3?|py|ruby|perl|php)(?:\.exe)?\b[^"'\n;&|]*?\s-(?:e|c|p|r|-eval)\s+("(?:[^"\\]|\\.)*"|'[^']*')/gi, (m, q) => m.slice(0, m.length - q.length) + '""')
    .replace(/\s-exec(?:dir)?\s+/g, ';'); // find … -exec rm -rf {} \;
}
/** Whether a command runs something matching `re` (from the start of one of its parts). */
const runs = (cmd, re) => parts(cmd).some((s) => s.search(re) === 0);

// A path that's fine to delete: temp and scratch space, build output, installed packages.
const THROWAWAY_PATH = /(\$TEMP|%TEMP%|\$env:TEMP|(^|[\\/])te?mp([\\/]|$)|AppData[\\/]Local[\\/]Temp|(^|[\\/])scratchpad([\\/]|$)|(^|[\\/])(node_modules|dist|build|out|coverage|\.next|\.cache|__pycache__|\.pytest_cache|target)([\\/]|$))/i;
/** Whether a delete command (rm, rmdir, del, Remove-Item) only deletes throwaway paths: every target must be one. */
function deletesOnlyThrowaway(part, vars = {}) {
  const tokens = part.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const targets = tokens.slice(1).filter((t) => !/^-/.test(t) && !/^\/[a-z]$/i.test(t))
    .map((t) => t.replace(/^["']|["']$/g, '').replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, name) => vars[name] ?? m));
  return targets.length > 0 && targets.every((t) => THROWAWAY_PATH.test(t));
}

/**
 * Shell variables a command sets, for the paths a delete names: T=$(mktemp -d) is a temp
 * folder ("$TEMP/mktemp"), S="$TEMP/x" is what it says. Only from the same command.
 */
function shellVars(cmd) {
  const vars = {};
  for (const m of String(cmd).matchAll(/(?:^|[\s;&|(])(?:export\s+|local\s+)?([A-Za-z_]\w*)=("[^"]*"|'[^']*'|\$\([^)]*\)|[^\s;&|]+)/g)) {
    const value = m[2].replace(/^["']|["']$/g, '');
    vars[m[1]] = /^\$\(\s*mktemp\b/.test(value) ? '$TEMP/mktemp' : value;
  }
  return vars;
}

// Output that looks like something broke, or like everything went fine, when there's
// no summary to count from.
const BROKE = /\bFAIL(?:ED|URE)?\b|\bfailing\b|^Traceback \(most recent call last\)|\bpanicked\b|\b\w*Error:|^\s*[✕✖×]\s|^not ok\b/m;
const FINE = /^\s*(?:PASS|ok)\s|\ball (?:\d+ )?tests? passed\b|^OK\b|^\s*[✓✔]\s/m;
const CHECKERS = { laya: 'Laya', jev: 'Jev' };

// The views ask on every render, so remember the last few hundred outputs read.
const parsedOutputs = new Map();
function factsOf(out) {
  let facts = parsedOutputs.get(out);
  if (!facts) {
    facts = parseTestOutput(out);
    parsedOutputs.set(out, facts);
    if (parsedOutputs.size > 300) parsedOutputs.delete(parsedOutputs.keys().next().value);
  }
  return facts;
}

/** "1 failed, 47 passed, 2 skipped" from parsed counts. */
function countWords(f) {
  return [f.failed && `${f.failed} failed`, f.errors && plural(f.errors, 'error'), f.passed && `${f.passed} passed`, f.skipped && `${f.skipped} skipped`].filter(Boolean).join(', ') || '0 tests';
}

/**
 * How a test run ended, and how we know:
 *   { state: 'passed' | 'failed' | 'unclear' | 'running', source: 'output' | 'exit' | 'checker',
 *     summary?, note?, reason?, facts, check? }
 * The output's own summary decides when there is one ("ℹ fail 0", "5 passed", "test
 * result: ok", see testout.js): a command can fail after the tests passed ("npm test &&
 * restart"), and the tests are what count here. Zero tests, or only skipped ones, is
 * unclear: a run where nothing ran isn't a pass. With no summary the exit status
 * decides, unless the output disagrees with it (an "ok" exit with a Traceback in the
 * output). An unclear run can be settled by the optional checker (bridge/checker.js),
 * whose answer is stored on the entry as `check`.
 */
/**
 * Whether a test command's output goes through a pipe (`npm test | grep fail`): the shell
 * then reports the last command's exit code (grep's), not the tests'. `2>&1 | tee` too.
 */
function piped(cmd) {
  for (const statement of scriptText(cmd).split(/\n|&&|\|\||;/)) {
    const pipeline = statement.split(/(?<!\|)\|(?!\|)/);
    if (pipeline.length > 1 && parts(pipeline.slice(0, -1).join(';')).some((p) => TEST.test(p))) return true;
  }
  return false;
}

export function testVerdict(e) {
  if (running(e)) return { state: 'running', source: 'exit' };
  const out = `${e.body?.output ?? ''}\n${e.error ?? ''}`;
  const facts = factsOf(out);
  let v;
  if (facts.parsed && facts.failed + facts.errors > 0) v = { state: 'failed', source: 'output', summary: countWords(facts) };
  else if (facts.parsed && facts.passed > 0) v = { state: 'passed', source: 'output', summary: countWords(facts) };
  else if (facts.parsed) v = { state: 'unclear', source: 'output', summary: countWords(facts), reason: 'no-tests', note: 'no tests actually ran' };
  else if (e.status === 'stopped') v = { state: 'unclear', source: 'exit', reason: 'stopped', note: 'it didn’t finish' };
  else if (piped(commandOf(e))) v = { state: 'unclear', source: 'exit', reason: 'piped', note: 'its output went through a pipe, so the exit code isn’t the tests’' };
  else if (e.status === 'failed') {
    v = FINE.test(out) && !BROKE.test(out)
      ? { state: 'unclear', source: 'exit', reason: 'clean-but-failed', note: 'the exit code says failed, but the output looks fine' }
      : { state: 'failed', source: 'exit' };
  } else {
    v = BROKE.test(out)
      ? { state: 'unclear', source: 'exit', reason: 'errors-but-ok', note: 'the exit code says passed, but the output shows errors' }
      : { state: 'passed', source: 'exit' };
  }
  v.facts = facts;
  if (v.state !== 'unclear' || !e.check) return v;
  v.check = e.check;
  if (e.check.state === 'passed' || e.check.state === 'failed') return { ...v, state: e.check.state, source: 'checker' };
  return v;
}

/** The evidence behind a verdict, in a few words: "48 passed", "exit code only", "checked by Jev, 94% sure". */
export function testEvidence(v) {
  if (!v || v.state === 'running') return '';
  const c = v.check;
  const by = c ? CHECKERS[c.by] ?? c.by : '';
  if (v.source === 'checker') return typeof c.p === 'number' ? `checked by ${by}, ${Math.round((v.state === 'passed' ? c.p : 1 - c.p) * 100)}% sure` : `checked by ${by}`;
  if (v.state === 'unclear') {
    const extra = !c ? '' : c.error ? ` · couldn’t check with ${by}` : typeof c.p === 'number' ? ` · ${by} wasn’t sure (${Math.round(c.p * 100)}% that they passed)` : '';
    return `${v.note}${extra}`;
  }
  return v.source === 'output' ? `${v.summary}${v.state === 'failed' ? failingNames(v) : ''}` : 'exit code only';
}

/**
 * Which tests failed, when the output names them: ": test_locked_failure +1 more". The
 * test's own name, not its path ("tests/test_x.py::test_name" → "test_name").
 */
function failingNames(v) {
  const names = (v?.facts?.failing ?? []).map((n) => String(n).split('::').pop().split(' › ').pop().trim()).filter(Boolean);
  if (!names.length) return '';
  const shown = names.slice(0, 2).map((n) => (n.length > 60 ? `${n.slice(0, 59)}…` : n));
  return `: ${shown.join(', ')}${names.length > 2 ? ` +${names.length - 2} more` : ''}`;
}

/** "Tests passed · 48 passed", "Tests passed (exit code only)", "Tests unclear: no tests actually ran". */
export function testWords(v) {
  if (!v || v.state === 'running') return 'Running the tests…';
  const evidence = testEvidence(v);
  if (v.state === 'unclear') return `Tests unclear: ${evidence}`;
  return v.source === 'exit' ? `Tests ${v.state} (${evidence})` : `Tests ${v.state} · ${evidence}`;
}

/**
 * A checker's answer on a step, for showing it: { who: 'Jev', state: 'passed' | 'failed'
 * | 'unsure' | 'error', sure (0–100, how sure of that answer), ms, model, error, why (why
 * the rules weren't sure) }, or null when no checker looked at it.
 */
export function checkOf(e) {
  const c = e?.check;
  if (!c) return null;
  const state = c.error ? 'error' : c.state === 'passed' || c.state === 'failed' ? c.state : 'unsure';
  const p = typeof c.p === 'number' ? c.p : null;
  const sure = p == null ? null : Math.round((state === 'failed' ? 1 - p : state === 'passed' ? p : Math.max(p, 1 - p)) * 100);
  const note = testVerdict({ ...e, check: undefined }).note;
  return { who: CHECKERS[c.by] ?? c.by, state, sure, ms: Number.isFinite(c.ms) ? c.ms : null, model: c.model ?? null, error: c.error ?? null, why: note ? note[0].toUpperCase() + note.slice(1) : null };
}

/** Whether a test run passed: true, false, or null while it runs or when it's unclear. */
export function testPassed(e) {
  const { state } = testVerdict(e);
  return state === 'passed' ? true : state === 'failed' ? false : null;
}

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
      if (runsTests(cmd)) return 'test';
      if (runs(cmd, SHIP)) return 'ship';
      if (runs(cmd, INSTALL)) return 'install';
      if (runs(cmd, BUILD)) return 'build';
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
export const list = (names, max = 3) => (names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} +${names.length - max}`);
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

/**
 * "failed twice, then passed" from a list of test runs, plus the evidence for the
 * last one ("48 passed", "exit code only"). An unclear run is never counted as a pass.
 */
function outcome(runs, { tests = true } = {}) {
  const done = runs.filter((e) => !running(e));
  if (!done.length) return { text: 'running', status: 'running' };
  // Builds and checks have no tests to count: there, what isn't clearly failed passed.
  const verdicts = done.map((e) => {
    const v = testVerdict(e);
    return tests || v.state !== 'unclear' ? v : { state: e.status === 'failed' ? 'failed' : 'passed', source: 'exit' };
  });
  const last = verdicts.at(-1);
  const evidence = tests ? testEvidence(last) : '';
  const failed = verdicts.filter((v) => v.state === 'failed').length;
  if (last.state === 'failed') return { text: failed === done.length && failed > 1 ? `failed ${times(failed)}` : 'failed', status: 'failed', evidence };
  if (last.state === 'unclear') return { text: failed ? `failed ${times(failed)}, then unclear` : 'unclear', status: 'unclear', evidence };
  if (failed) return { text: `failed ${times(failed)}, then passed`, status: 'ok', evidence };
  return { text: done.length > 1 ? `passed (${done.length} runs)` : 'passed', status: 'ok', evidence };
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
      // Where the verdict came from: "npm test · 48 passed", "pytest · exit code only".
      ch.detail = [matched(cmds, TEST), live ? '' : o.evidence].filter(Boolean).join(' · ');
      break;
    }
    case 'build': {
      const o = outcome(cmds, { tests: false });
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
      // Only what the commands ran, one per line, not what they wrote into files.
      const all = cmds.flatMap((c) => parts(commandOf(c))).join('\n');
      const did = [];
      const msg = /^git\s+commit\b[^\n]*?-m\s+(["'])([\s\S]*?)\1/m.exec(all)?.[2];
      if (/^git\s+commit\b/m.test(all)) did.push(live ? 'committing' : 'committed');
      if (/^git\s+push\b/m.test(all)) did.push(live ? 'pushing' : 'pushed');
      if (/^git\s+tag\b/m.test(all)) did.push('tagged');
      const release = /^gh\s+release\s+create\s+(\S+)/m.exec(all)?.[1];
      if (release) did.push(`released ${release}`);
      if (/^gh\s+pr\s+create/m.test(all)) did.push('opened a pull request');
      if (/^(?:gh\s+pr\s+merge|git\s+merge)/m.test(all)) did.push('merged');
      if (/^npm\s+publish/m.test(all)) did.push('published to npm');
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
    const ran = parts(cmd);
    const script = scriptText(cmd);
    // Without quoted text: a "sudo" or "Stop-Process" in a grep pattern or a message isn't one being run.
    const unquoted = script.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
    for (const [re, did, will, level = 'warn'] of RISKY) {
      // A command it ran (not text it wrote into a file); a pipe into a shell and SQL
      // (often inside `psql -c "…"`) and force-stops (inside a PowerShell pipeline) are looked
      // for across the whole line, minus text written into a file and code in another
      // language (a "sudo" inside node -e "…" is a string, not a command).
      const anywhere = re === RISKY[3][0] || re === RISKY[4][0] || re === RISKY[5][0] || re === RISKY[6][0];
      const where = re === RISKY[5][0] || re === RISKY[6][0] ? unquoted : script;
      if (anywhere ? !re.test(where) : !ran.some((p) => p.search(re) === 0)) continue;
      // Clearing out a temp, scratch or build folder is housekeeping, not a risk: a quiet note.
      if (re === RISKY[0][0] && ran.filter((p) => p.search(re) === 0).every((p) => deletesOnlyThrowaway(p, shellVars(cmd)))) { add('info', before ? 'Deletes a temporary or build folder' : 'Deleted a temporary or build folder', e); continue; }
      const text = before ? will : did;
      add(level, text[0].toUpperCase() + text.slice(1), e);
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
  if (e.kind === 'run' && stepType(e) === 'test') {
    // `node --test x.js 2>&1 | grep fail` then `node --test x.js 2>&1 | tail` is one test, run twice.
    const test = parts(commandOf(e)).find((p) => TEST.test(p));
    if (test) return `test:${test.replace(/\s+\d?>>?&?\s*\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 200)}`;
  }
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
// A test run fails by its results, not only its exit code (`npm test; echo done` exits 0).
const testedAs = (e) => (e.kind === 'run' && stepType(e) === 'test' && !running(e) ? testVerdict(e).state : null);
const failedStep = (e) => e.status === 'failed' || testedAs(e) === 'failed';
/** Whether a test run runs every test: no file, folder or name filter after the runner (`npm test`, `pytest -q`). */
const wholeSuite = (e) => parts(commandOf(e)).filter((p) => TEST.test(p)).some((p) => {
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?test:/.test(p)) return false; // `npm run test:unit` is one part of it
  const words = p.replace(/\s+\d?>>?&?\s*\S+/g, '').split(/\s+/).slice(1);
  return !words.some((w) => /[\\/]|\.(?:[cm]?[jt]sx?|py|go|rs|rb|php|java|cs)$/i.test(w) || /^(-k|-t|--grep|--test-name-pattern|--testNamePattern|--filter|-run)(=|$)/.test(w));
});

export function retries(steps) {
  const list = [...steps].filter((e) => !['prompt', 'done', 'error', 'plan', 'compact'].includes(e.kind)).sort((a, b) => a.at - b.at);
  const chains = new Map();
  const retryOf = new Map();
  for (let i = 0; i < list.length; i++) {
    const first = list[i];
    if (!failedStep(first) || retryOf.has(first.id)) continue;
    const key = target(first);
    if (!key) continue;
    const attempts = [first];
    for (let j = i + 1; j < list.length && j <= i + 25; j++) {
      const e = list[j];
      if (e.at - attempts.at(-1).at > 15 * 60_000) break;
      if (e.session !== first.session || target(e) !== key) continue;
      // A test run that can't tell (piped, stopped) neither fixes nor fails: look further.
      if (testedAs(e) === 'unclear') continue;
      attempts.push(e);
      retryOf.set(e.id, first.id);
      if (!failedStep(e)) break; // fixed (or still running): the chain ends here
    }
    // Failing tests are also fixed by a later run of the whole suite that passes
    // (`node --test test/a.test.js` fails, then `npm test` passes).
    if (testedAs(first) && failedStep(attempts.at(-1))) {
      const at = list.indexOf(attempts.at(-1));
      const suite = list.slice(at + 1, at + 61).find((e) => e.session === first.session && e.at - attempts.at(-1).at <= 15 * 60_000 && testedAs(e) === 'passed' && wholeSuite(e));
      if (suite) { attempts.push(suite); retryOf.set(suite.id, first.id); }
    }
    const last = attempts.at(-1);
    const outcome = last === first ? 'failing' : failedStep(last) ? 'failing' : running(last) ? 'trying' : 'fixed';
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

// -- was the code as it is now tested? ------------------------------------------------

// Files whose changes don't need tests: docs, images, lockfiles.
const NOT_CODE = /\.(md|mdx|markdown|txt|rst|adoc|png|jpe?g|gif|webp|svg|ico|mp4|lock)$|(^|[\\/])(LICENSE|CHANGELOG|README)[^\\/]*$|(^|[\\/])(package-lock\.json|pnpm-lock\.yaml)$/i;
const COMMIT = /\bgit\s+commit\b/i;

/**
 * Whether the code as it stands was tested, from steps (any order). Only tests the
 * agent ran count: dotpals can't see the ones you run yourself or CI.
 *   { state, last, since, commit } or null when no code changed and nothing was tested
 *   state:  'untested' (code changed, no test run) | 'running' | 'stale' (code changed
 *           after the last test run) | 'passing' | 'failing' | 'unclear' (see testVerdict)
 *   last:   the last test run;  verdict: testVerdict(last);  since: the code files changed after it
 *   commit: the last commit: { at, tested } (tested: a passing run after the last change before it)
 */
export function testState(steps) {
  const list = [...steps].sort((a, b) => a.at - b.at);
  const tests = list.filter((e) => e.kind === 'run' && stepType(e) === 'test');
  const edits = [];
  for (const e of list) {
    for (const path of commandEdits(e)) edits.push({ at: e.at, path });
    if (stepType(e) !== 'change' || outside(e) || e.status === 'failed') continue;
    for (const f of e.files ?? []) if (f.change !== 'read' && !NOT_CODE.test(String(f.path))) edits.push({ at: e.at, path: f.path });
  }
  const last = tests.at(-1) ?? null;
  if (!edits.length && !last) return null;
  const seen = new Map();
  for (const x of edits) if (!last || x.at > last.at) seen.set(String(x.path).toLowerCase(), x.path);
  const since = [...seen.values()];
  const verdict = last ? testVerdict(last) : null;
  const state = !last ? 'untested' : running(last) ? 'running' : since.length ? 'stale'
    : verdict.state === 'failed' ? 'failing' : verdict.state === 'unclear' ? 'unclear' : 'passing';
  const c = list.findLast((e) => e.kind === 'run' && runs(commandOf(e), COMMIT) && e.status !== 'failed' && !running(e));
  let commit = null;
  if (c) {
    // "npm test && git commit" tests and commits in one go.
    const before = stepType(c) === 'test' ? c : tests.filter((t) => t.at < c.at && !running(t)).at(-1);
    commit = { at: c.at, tested: !!before && testPassed(before) === true && !edits.some((x) => x.at > before.at && x.at < c.at) };
  }
  return { state, last, verdict, since, commit };
}

// A source file's name: what a command that writes files is taken to change.
const CODE_FILE = /^[^\s"'`$<>|;&]+\.(?:[cm]?[jt]sx?|py|go|rs|rb|php|java|kt|swift|cs|c|cc|cpp|h|hpp|css|scss|html?|vue|svelte|sh|ps1|ya?ml|toml|json|sql)$/i;

/**
 * The code files a command wrote, as far as its text shows: `sed -i … file`, `> file`,
 * `>> file`, `tee file`, and scripts (node -e, python heredocs) that call writeFileSync /
 * open(…, 'w') / write_text on a path they name. Never temp, scratch or build paths. When
 * git saw the request (gitTruth), that's the better answer; this is for when it didn't.
 */
export function commandEdits(e) {
  if (e.kind !== 'run' || e.status === 'failed' || running(e)) return [];
  const cmd = commandOf(e);
  const found = new Set();
  const vars = shellVars(cmd);
  const words = (p) => (p.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, '').replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, n) => vars[n] ?? m));
  for (const p of parts(cmd)) {
    if (/^(sed|perl)\b/.test(p) && /\s-\w*i/.test(p)) words(p).slice(1).forEach((w) => found.add(w));
    if (/^tee\b/.test(p)) words(p).slice(1).forEach((w) => found.add(w));
    for (const m of p.matchAll(/(?:^|[^0-9&>])>>?\s*("[^"]*"|'[^']*'|[^\s;&|]+)/g)) found.add(words(m[1])[0] ?? '');
  }
  // Scripts: a write call's path, given as text or through a variable set in the script.
  const text = String(cmd);
  const named = (x) => (/^['"`]/.test(x) ? x.slice(1, -1) : text.match(new RegExp(`\\b${x.replace(/[^\w$]/g, '')}\\s*=\\s*(?:Path\\()?['"\`]([^'"\`]+)['"\`]`))?.[1]);
  for (const m of text.matchAll(/\b(?:writeFileSync|writeFile|appendFileSync)\(\s*('[^']*'|"[^"]*"|`[^`]*`|[\w$]+)/g)) found.add(named(m[1]) ?? '');
  for (const m of text.matchAll(/\bopen\(\s*('[^']*'|"[^"]*"|\w+)\s*,\s*['"][wa]/g)) found.add(named(m[1]) ?? '');
  for (const m of text.matchAll(/(?:Path\(\s*('[^']*'|"[^"]*")\s*\)|\b(\w+))\.write_text\(/g)) found.add(named(m[1] ?? m[2]) ?? '');
  return [...found].filter((f) => CODE_FILE.test(f) && !NOT_CODE.test(f) && !THROWAWAY_PATH.test(f));
}

/** "passed", "failed" or "were unclear", for a sentence about the last run. */
const lastWord = (v) => (v.state === 'passed' ? 'passed' : v.state === 'failed' ? 'failed' : 'were unclear');

/** For a finished request: a flag when it changed code it didn't test, or changed it after testing. */
function testFlag(steps) {
  const t = testState(steps);
  if (!t) return null;
  // The last change, whether it came from a file tool or a command that wrote code.
  const step = steps.findLast((e) => stepType(e) === 'change' || commandEdits(e).length) ?? t.last ?? steps.at(-1);
  const names = list(t.since.map(baseName));
  if (t.state === 'untested') return { level: 'warn', text: `Not tested: changed ${plural(t.since.length, 'code file')} (${names}), and the agent ran no tests`, step };
  if (t.state === 'stale') return { level: 'warn', text: `Changed ${names} after the tests ${t.verdict.state === 'failed' ? 'last failed' : lastWord(t.verdict)}: not tested since`, step };
  if (t.state === 'unclear') return { level: 'warn', text: testWords(t.verdict), step: t.last };
  if (t.commit && !t.commit.tested) return { level: 'warn', text: 'Committed without a passing test run after the last change', step };
  return null;
}

/**
 * One line on the code's test status for a whole session, for the pal and the notch:
 * { level: 'ok' | 'warn' | 'bad' | 'info', text } or null. `time` formats a timestamp.
 */
export function testLine(steps, time = (at) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) {
  const t = testState(steps);
  if (!t) return null;
  const commit = t.commit ? ` · last commit ${t.commit.tested ? 'tested' : 'not tested'}` : '';
  // The verdict says where it came from: "Tests passed · 48 passed", "Tests passed (exit
  // code only)", "Tests unclear: no tests actually ran", "… · checked by Jev, 94% sure".
  switch (t.state) {
    case 'untested': return { level: 'warn', text: `No tests run by the agent · ${plural(t.since.length, 'code file')} changed${commit}` };
    case 'running': return { level: 'info', text: 'Running the tests…' };
    case 'stale': return { level: 'warn', text: `Tests ${lastWord(t.verdict)} at ${time(t.last.at)} · ${plural(t.since.length, 'file')} changed since${commit}` };
    case 'failing': return { level: 'bad', text: `${testWords(t.verdict)} · ${time(t.last.at)}${commit}` };
    case 'unclear': return { level: 'warn', text: `${testWords(t.verdict)} · ${time(t.last.at)}${commit}` };
    default: {
      // Green because the tests were changed (weakenedTests): not a pass to trust.
      const weak = weakenedTests(steps);
      if (weak) return { level: 'warn', text: `${testWords(t.verdict)} · ${time(t.last.at)}, but only after the tests were changed: ${weak.text}${commit}` };
      return { level: 'ok', text: `${testWords(t.verdict)} · ${time(t.last.at)}, after the last change${commit}` };
    }
  }
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
 * Claude Code keeps its plan as tasks, one entry per TaskCreate/TaskUpdate, and planOf()
 * numbers tasks by their position, so dropping an early task entry corrupts the plan. Before
 * a session is trimmed, its task history is folded: the plan as replayed so far is written
 * onto the newest task entry as a `plan` array (the form TodoWrite, Codex and Gemini use).
 * planOf() starts over from an array, so the older task entries are then free to go.
 * Changes the entries in place; only called when a session is over its limit.
 */
export function foldTasks(list) {
  const last = list.findLastIndex((entry) => Array.isArray(entry.plan));
  const tasks = list.slice(last + 1).filter((entry) => entry.task);
  if (tasks.length < 2) return;
  const plan = planOf(list);
  if (plan) tasks.at(-1).plan = plan.items;
}

export function contextEntries(entries) {
  const sessions = new Map();
  for (const entry of entries) {
    if (!sessions.has(entry.session)) sessions.set(entry.session, []);
    sessions.get(entry.session).push(entry);
  }
  const kept = new Set();
  for (const list of sessions.values()) {
    foldTasks(list);
    const prompts = list.filter((entry) => entry.kind === 'prompt');
    for (const entry of [prompts[0], ...prompts.slice(-4)]) if (entry) kept.add(entry);
    const plan = list.findLastIndex((entry) => Array.isArray(entry.plan));
    for (const entry of list.slice(Math.max(0, plan))) if (entry.plan || entry.task) kept.add(entry);
    // The latest test run, the latest commit that went through, the test run before that
    // commit (what testState() reads "the commit was tested" from), and the latest ending.
    const isTest = (entry) => entry.kind === 'run' && stepType(entry) === 'test' && !running(entry);
    const commit = list.findLast((entry) => entry.kind === 'run' && runs(commandOf(entry), COMMIT) && entry.status !== 'failed' && !running(entry));
    for (const entry of [
      list.findLast(isTest),
      commit,
      commit && list.findLast((entry) => isTest(entry) && entry.at < commit.at),
      list.findLast((entry) => entry.kind === 'done' || entry.kind === 'error'),
    ]) if (entry) kept.add(entry);
    const paths = new Set();
    for (let index = list.length - 1; index >= 0 && paths.size < 30; index--) {
      const entry = list[index];
      if (entry.status === 'failed') continue;
      const changed = [...(entry.files ?? []).filter((file) => file.change !== 'read').map((file) => file.path), ...commandEdits(entry)];
      for (const path of changed) {
        const key = String(path).replace(/\\/g, '/').toLowerCase();
        if (paths.has(key) || paths.size >= 30) continue;
        paths.add(key);
        kept.add(entry);
      }
    }
  }
  return [...kept];
}

/**
 * A `/compact` command with a note on what to keep, written from the session's own
 * record: the goal, what's still on the plan, the files changed and whether the
 * tests are failing. Claude Code and Codex both take `/compact <instructions>`; a
 * good note keeps the summary from dropping what matters. Paste it into the agent.
 */
export function compactNote(entries) {
  const list = [...entries].sort((a, b) => a.at - b.at);
  const clipped = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
  const prompts = list.filter((entry) => entry.kind === 'prompt');
  const original = prompts[0]?.title;
  const goal = prompts.at(-1)?.title;
  const plan = planOf(list);
  const todo = plan?.items.filter((p) => p.status !== 'completed').slice(0, 4).map((p) => clipped(p.text, 60)) ?? [];
  // The files changed, newest first: by file tools, and by commands (`sed -i`, scripts) too.
  const files = [];
  for (const e of list.slice().reverse()) {
    if (e.status === 'failed') continue;
    const changed = [...(e.files ?? []).filter((f) => ['edit', 'write', 'delete'].includes(f.change)).map((f) => f.path), ...commandEdits(e)];
    for (const path of changed) {
      const name = String(path).replace(/\\/g, '/');
      if (!files.includes(name)) files.push(name);
      if (files.length >= 8) break;
    }
    if (files.length >= 8) break;
  }
  const tested = testState(list);
  const tests = !tested ? null : tested.state === 'untested' ? 'no tests run by the agent after changing code'
    : tested.state === 'running' ? 'tests are still running; no final result yet'
    : tested.state === 'stale' ? `tests ${lastWord(tested.verdict)}, but ${tested.since.slice(0, 4).map((path) => clipped(path, 120)).join(', ')}${tested.since.length > 4 ? ` and ${tested.since.length - 4} more files` : ''} changed since; not tested since`
    : `${testWords(tested.verdict)} (${clipped(commandOf(tested.last), 120)})`;
  const parts = [
    original && original !== goal && `Keep the original request and constraints: "${clipped(original, 800)}"`,
    prompts.length > 2 && `recent instructions (newer ones override older ones): ${prompts.slice(-4, -1).filter((entry) => entry !== prompts[0]).map((entry) => `"${clipped(entry.title, 400)}"`).join('; ')}`,
    goal && `Keep the current goal and constraints: "${clipped(goal, 800)}"`,
    todo.length && `still to do: ${todo.join('; ')}`,
    files.length && `recent changed paths: ${files.map((path) => clipped(path, 160)).join(', ')}`,
    tests && `test evidence: ${tests}`,
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
    if (test) {
      const passed = testPassed(test);
      parts.push(passed === false ? `its last test run failed (${words(commandOf(test), 40)})` : passed ? 'its tests passed' : `its last test run was unclear (${testVerdict(test).note ?? 'not finished'})`);
    }
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

/** Chapters that rarely matter (tool plumbing, scratch files, memory): folded into "+N small steps". */
export const minorChapter = (c) => c.type === 'scratch' || c.type === 'memory' || (c.type === 'tool' && c.status !== 'failed');

/**
 * The simple view of a request: one plain sentence, and the warnings worth a look.
 *   { text: 'Changed billing.ts, the tests passed after one retry, and pushed it.',
 *     status: 'ok' | 'failed' | 'running' | 'unclear', warnings: ['…'] }
 * Rules, not AI: it picks what changed, how the tests went and what was shipped, and
 * only falls back to the looking around when nothing else happened.
 */
export function simple(turn, { live = !turn.end } = {}) {
  // Not finished and not working any more (you sent something new, or it was interrupted).
  const stopped = !turn.end && !live;
  const chs = chapters(turn.steps);
  const by = (type) => chs.find((c) => c.type === type);
  const parts = [];
  let status = turn.end?.kind === 'error' ? 'failed' : live ? 'running' : stopped ? 'stopped' : 'ok';

  const change = by('change');
  if (change) {
    const files = change.files ?? [];
    parts.push(files.length === 1 ? change.title[0].toLowerCase() + change.title.slice(1) : `${live ? 'changing' : 'changed'} ${plural(files.length, 'file')}${live ? ' so far' : ''}`);
  }
  const tests = turn.steps.filter((e) => e.kind === 'run' && stepType(e) === 'test' && !running(e));
  if (tests.length) {
    const last = testVerdict(tests.at(-1));
    const fails = tests.slice(0, -1).filter((e) => testVerdict(e).state === 'failed').length;
    if (last.state === 'passed') parts.push(fails ? `the tests passed after ${fails === 1 ? 'one retry' : `${fails} retries`}` : 'the tests passed');
    else if (last.state === 'failed') {
      const first = failingNames({ facts: { failing: last.facts?.failing?.slice(0, 1) ?? [] } }).slice(2);
      parts.push(`the tests are failing${first ? ` (${first})` : ''}`);
      if (status === 'ok') status = 'failed';
    }
    else { parts.push('the test result is unclear'); if (status === 'ok') status = 'unclear'; }
  } else if (change && !live && testState(turn.steps)?.state === 'untested') parts.push('but it didn’t run the tests');
  const build = by('build');
  if (build?.status === 'failed') { parts.push('the build is failing'); if (status === 'ok') status = 'failed'; }
  if (by('install')) parts.push(live ? 'installing packages' : 'installed packages');
  const ship = by('ship');
  if (ship) parts.push(ship.title[0].toLowerCase() + ship.title.slice(1));
  // Nothing changed: say what it did instead.
  if (!parts.length) {
    const other = ['ask', 'agent', 'web', 'explore', 'run', 'skill', 'mcp'].map(by).filter(Boolean).slice(0, 2);
    for (const c of other) parts.push(c.title[0].toLowerCase() + c.title.slice(1));
  }

  let text;
  if (!parts.length) text = live ? 'Thinking…' : turn.end?.kind === 'error' ? 'Stopped with an error.' : stopped ? 'Stopped before it did anything.' : 'Answered without changing anything.';
  else {
    const joined = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')}${parts.at(-1).startsWith('but ') ? ', ' : ', and '}${parts.at(-1)}`;
    text = `${live ? 'Working on it: ' : turn.end?.kind === 'error' ? 'Stopped with an error after it ' : stopped ? 'Stopped before finishing: ' : ''}${joined}.`;
    text = text[0].toUpperCase() + text.slice(1);
  }
  // Warnings: the risky things, minus what the sentence already says.
  const warnings = live ? [] : story(turn).flags.filter((f) => f.level === 'warn' && !(/^Not tested:/.test(f.text) && parts.includes('but it didn’t run the tests'))).slice(0, 2).map((f) => f.text);
  return { text, status, warnings };
}

// -- the recap you copy (a PR description, a commit message, a standup) ------------------

/** A step's ID as the dashboard's search finds it: the agent's own tool-call ID, shortened. */
const stepId = (e) => String(e.id ?? '').split(':').pop().slice(0, 18);
const code = (text) => `\`${String(text).split('\n')[0].trim().slice(0, 70).replace(/`/g, "'")}\``;
const firstError = (e) => String(e.error || '').split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 90) || 'failed';
const fileList = (paths) => paths.map((p) => code(baseName(p))).join(', ');

/**
 * A request as Markdown, for a PR description, a commit message or a standup. What ran
 * is kept apart from what failed, what's unclear and what didn't run at all, and every
 * claim carries its evidence: the command, the result it's read from (the test output's
 * summary, or the exit code), and the step's ID, which the dashboard's search opens.
 * Quick look-ups (ls, grep, git status) aren't listed: a grep that finds nothing isn't
 * a failure.
 */
export function turnMarkdown(t, { live } = {}) {
  const f = facts(t.steps);
  const lines = [];
  if (t.prompt) lines.push(`### ${t.prompt.title.split('\n')[0]}`, '');
  if (t.end?.summary) lines.push(String(t.end.summary).trim(), ''); // already Markdown: kept as the agent wrote it

  const ok = [];
  const failed = [];
  const unclear = [];
  const notRun = [];
  const { chains, retryOf } = retries(t.steps);
  // A failed retry is part of the first failure's line ("still failing after 3 tries"), not a line of its own.
  const repeat = (e) => failedStep(e) && retryOf.has(e.id);
  const tries = (e) => {
    const c = chains.get(e.id);
    if (!c || c.attempts.length < 2) return '';
    return c.outcome === 'fixed' ? ` (fixed on try ${c.attempts.length})` : c.outcome === 'failing' ? ` (still failing after ${c.attempts.length} tries)` : ' (trying again)';
  };
  const ref = (e) => (stepId(e) ? ` · step ${code(stepId(e))}` : '');
  let other = 0;
  for (const e of t.steps) {
    if (running(e)) continue;
    if (['edit', 'write', 'delete'].includes(e.kind) && e.status === 'failed') {
      if (repeat(e)) continue;
      failed.push(`- Edit to ${code(baseName(e.files?.[0]?.path ?? e.title ?? 'a file'))} didn’t apply${ref(e)}${tries(e)}`);
      continue;
    }
    if (e.kind !== 'run') continue;
    const type = stepType(e);
    if (type === 'explore') continue;
    if (type === 'test') {
      const v = testVerdict(e);
      const line = `- Tests: ${code(commandOf(e))} → ${testEvidence(v)}${ref(e)}`;
      if (v.state === 'passed') ok.push(line);
      else if (v.state === 'failed') { if (!repeat(e)) failed.push(line + tries(e)); }
      else unclear.push(line);
      continue;
    }
    const label = { build: 'Build and checks', ship: 'Shipped', install: 'Installed' }[type];
    if (e.status === 'failed') { if (!repeat(e)) failed.push(`- ${label ?? 'Command'}: ${code(commandOf(e))} → ${firstError(e)}${ref(e)}${tries(e)}`); }
    else if (label) ok.push(`- ${label}: ${code(commandOf(e))}${ref(e)}`);
    else other++;
  }
  if (other) ok.push(`- ${plural(other, 'other command')}`);
  const tested = testState(t.steps);
  if (tested?.state === 'untested') notRun.push(`- Tests: none ran after changing ${fileList(tested.since)}`);
  if (tested?.state === 'stale') notRun.push(`- Tests after the last change to ${fileList(tested.since)}`);
  if (tested?.commit && !tested.commit.tested) notRun.push('- A passing test run between the last change and the commit');

  for (const [title, list] of [['✅ Ran successfully', ok], ['❌ Failed', failed], ['❔ Unclear', unclear], ['⚪ Not run', notRun]]) {
    if (list.length) lines.push(`**${title}**`, ...list, '');
  }
  // The reviewer's two questions: ready to merge? and why did it stop?
  const r = readiness(t);
  if (r) lines.push(r.ready ? '**Ready to merge?** Yes: tests ran after the last change and passed, nothing risky.' : `**Ready to merge?** Not yet: ${r.problems.join('; ')}.`, '');
  // Why it stopped: only when that's known. A request with no end may still be running, unless
  // the caller says it isn't (live: false); a running one has no stop reason yet.
  const why = t.end || live === false ? whyStopped(t, { live: !!live }) : null;
  if (why) lines.push(`_Why it stopped: ${why.text}._`, '');
  const outsidePaths = new Set(t.steps.filter(outside).flatMap((e) => e.files.map((x) => String(x.path).toLowerCase())));
  const elsewhere = (x) => outsidePaths.has(String(x.path).toLowerCase());
  // What changed: git's word when the bridge saw the repository before and after (it also
  // sees what commands changed); otherwise what the file tools said.
  const truth = gitTruth(t);
  const lists = truth && !truth.tooMany
    ? [['Changed', truth.files.filter((x) => x.change === 'edit')], ['Wrote', truth.files.filter((x) => x.change === 'write')], ['Deleted', truth.files.filter((x) => x.change === 'delete')]]
    : [['Changed', f.changed], ['Wrote', f.wrote], ['Deleted', f.deleted]];
  for (const [label, list] of lists) {
    const mine = list.filter((x) => !elsewhere(x));
    if (mine.length) lines.push(`- ${label}: ${fileList(mine.map((x) => x.path))}${truth && !truth.tooMany && truth.more && label === 'Changed' ? ` and ${truth.more} more` : ''}`);
  }
  if (truth && !truth.tooMany && truth.byCommand.length) lines.push(`- Changed by commands, not file tools: ${fileList(truth.byCommand.map((x) => x.path))}`);
  if (truth) {
    const note = gitLine({ ...truth, byCommand: [] }).replace(/^Git: [^·]*(· )?/, '');
    if (truth.tooMany) lines.push('- Git: too many changed files to compare');
    else if (!truth.files.length) lines.push(`- ${gitLine(truth)}`);
    if (note) lines.push(`- ⚠ ${note[0].toUpperCase()}${note.slice(1)}`);
    lines.push('- _Files checked against git_');
  }
  const scratch = [...f.changed, ...f.wrote, ...f.deleted].filter(elsewhere).length;
  if (scratch) lines.push(`- Also touched ${plural(scratch, 'file')} outside the project (scratch or temp)`);
  if (f.skills.size) lines.push(`- Skills: ${[...f.skills].join(', ')}`);
  if (f.mcp.size) lines.push(`- Tools: ${[...f.mcp].join(', ')}`);
  const took = turnTime(t);
  lines.push('', `_${harnessName(t.harness)} · ${t.label ?? ''}${took > 0 ? ` · ${secs(took)}` : ''}_`);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Several requests as one Markdown document ("Copy today", a session's export). */
export function recapMarkdown(title, turns) {
  // A request with no end that isn't its session's newest was cut off (a new message came in).
  // The newest may still be running: no stop reason for it unless it ended.
  const newest = new Map();
  for (const t of turns) if (!newest.has(t.session) || t.at > newest.get(t.session).at) newest.set(t.session, t);
  const shown = turns.filter((t) => t.prompt || t.steps.length);
  return [`## ${title}`, ...shown.map((t) => turnMarkdown(t, newest.get(t.session) === t ? {} : { live: false }))].join('\n\n');
}

// -- reviewing a request: why it stopped, and is it ready to merge? ------------------------

/** What a step was trying to do, in a few words: a command, or the file an edit was for. */
const whatOf = (e) => (e.kind === 'run' ? code(commandOf(e)) : code(baseName(e.files?.[0]?.path ?? e.title ?? 'a file')));
const lastTestVerdict = (steps) => {
  const runs = steps.filter((e) => e.kind === 'run' && stepType(e) === 'test' && !running(e));
  return runs.length ? testVerdict(runs.at(-1)) : null;
};
/** Failures the agent tried again and never fixed. */
const leftFailing = (steps) => [...retries(steps).chains.values()].filter((c) => c.outcome === 'failing' && c.attempts.length > 1);
/** Whether a request changed code (not docs, images or lockfiles, not scratch files outside the project). */
// Command parts that can't change a project's code: looking, testing, and git's bookkeeping (not merge, rebase, cherry-pick, checkout or pull, which can).
const HARMLESS = /^(?:git\s+(?:status|log|diff|show|branch|fetch|ls-remote|rev-parse|remote|tag|add|commit|push|stash\s+list)\b|gh\s|ls\b|dir\b|cat\b|type\b|grep\b|rg\b|find\b|echo\b|printf\b|head\b|tail\b|wc\b|pwd\b|which\b|where\b|sleep\b|true\b|exit\b|cd\b|npm\s+(?:test|run\s+test)\b|node\s+--test\b|pytest\b|jest\b|vitest\b|go\s+test\b|cargo\s+test\b)/i;
export const changedCode = (steps) => steps.some((e) => (stepType(e) === 'change' && !outside(e) && e.status !== 'failed'
  && (e.files ?? []).some((f) => f.change !== 'read' && !NOT_CODE.test(String(f.path)))) || commandEdits(e).length > 0);

/**
 * Why a request ended, in plain words: { kind, text }, or null while the agent is still
 * working on it. Agents don't say why they stopped, so this reads it from what happened:
 * an error, a failure it kept retrying, failing tests, a question at the end, or a clean
 * finish. `waiting`: the agent is waiting for you right now.
 */
export function whyStopped(turn, { live = !turn.end, waiting = false } = {}) {
  if (live) return waiting ? { kind: 'waiting', text: 'Waiting for you' } : null;
  if (!turn.end) return { kind: 'cut', text: 'Cut off before it finished (interrupted, or a new message came in)' };
  if (turn.end.kind === 'error') {
    const why = String(turn.end.error || turn.end.title || '').split('\n')[0].trim().slice(0, 90);
    return { kind: 'error', text: `Stopped with an error${why ? `: ${why}` : ''}` };
  }
  const gaveUp = leftFailing(turn.steps).at(-1);
  if (gaveUp) return { kind: 'gave-up', text: `Stopped trying: ${whatOf(gaveUp.attempts[0])} still failed after ${gaveUp.attempts.length} tries` };
  if (lastTestVerdict(turn.steps)?.state === 'failed') return { kind: 'failing', text: 'Said it was done, but the tests are failing' };
  const said = String(turn.end.summary ?? '').trim().split('\n').filter(Boolean).at(-1) ?? '';
  // A question in its last two sentences ("Shall I keep going? That's the X and the Y.").
  const sentences = said.split(/(?<=[.!?]\**)\s+/).filter(Boolean).slice(-2);
  if (sentences.some((s) => /\?\s*\**\s*$/.test(s))) return { kind: 'question', text: 'Finished with a question for you' };
  return { kind: 'done', text: 'Finished: the agent said it was done' };
}

/**
 * What git says a finished request changed (the bridge compares the repository before and
 * after it: bridge/ground.js), next to what its tool calls said:
 *   { files: [{ path, change, byTool }], byCommand: [files no file tool touched],
 *     undone: [project files a tool changed that git shows unchanged], committed, others, more, tooMany }
 * or null when there's no snapshot (not a git repository, or read from a transcript later).
 * Git's paths are relative to the repository; a tool's may be absolute, so a tool's path
 * counts as the same file when it ends with git's.
 */
export function gitTruth(turn) {
  const g = turn.end?.git;
  if (!g || !Array.isArray(g.files)) return null;
  const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();
  const toolPaths = [...new Set(turn.steps.filter((e) => e.status !== 'failed' && !outside(e)).flatMap((e) => (e.files ?? []).filter((f) => f.change !== 'read').map((f) => norm(f.path))))];
  const same = (tool, git) => tool === git || tool.endsWith(`/${git}`);
  const files = g.files.map((f) => ({ ...f, byTool: toolPaths.some((t) => same(t, norm(f.path))) }));
  const undone = g.tooMany ? [] : toolPaths.filter((t) => !files.some((f) => same(t, norm(f.path))));
  return { files, byCommand: files.filter((f) => !f.byTool), undone, committed: !!g.committed, others: g.others ?? [], more: g.more ?? 0, tooMany: !!g.tooMany };
}

/** One line for a card: "Git: 5 files changed, 2 of them by commands · Codex was also working here", or ''. */
export function gitLine(truth) {
  if (!truth) return '';
  if (truth.tooMany) return 'Git: too many changed files to compare';
  const n = truth.files.length + truth.more;
  const parts = [n ? `Git: ${plural(n, 'file')} changed${truth.byCommand.length ? `, ${truth.byCommand.length === n ? (n === 1 ? 'by a command' : 'all by commands') : `${truth.byCommand.length} of them by commands`}` : ''}` : 'Git: no files changed'];
  if (!n && truth.undone.length) parts[0] += `, though it edited ${plural(truth.undone.length, 'file')} (undone, or ignored by git)`;
  if (truth.others.length) parts.push(`${truth.others.map((o) => harnessName(o.harness)).join(', ')} ${truth.others.length === 1 ? 'was' : 'were'} also working here, so some may be theirs`);
  return parts.join(' · ');
}

// A test file: in a test folder, or named like one (cart.test.js, cart.spec.ts, test_cart.py, cart_test.go, cart_spec.rb).
const TEST_FILE = /(^|[\\/])(tests?|__tests__|spec)[\\/]|\.(test|spec)\.\w+$|(^|[\\/])test_[^\\/]*\.py$|_test\.go$|_spec\.rb$/i;
// A line that checks something, in the usual test libraries.
const ASSERTION = /\b(?:assert\w*|expect)\s*[.(]|^assert\s|\bt\.(?:equal|deepEqual|is|ok|true|false|same)\s*\(|\bself\.assert\w+\s*\(|\.should\b|\bXCTAssert\w*\s*\(|\brequire\.\w+\s*\(/;
// Turning tests off: skip, todo or only (the others stop running), xit, pytest's and unittest's skips, go's t.Skip, rust's #[ignore].
const SKIPS = /\b(?:it|test|describe|context)\.(?:skip|todo|only)\b|\bx(?:it|test|describe)\s*\(|@pytest\.mark\.(?:skip|xfail)|@unittest\.skip|\bt\.Skip(?:Now|f)?\(|#\[ignore\]|\bskip:\s*true\b/;
const COMMENT = /^(?:\/\/|#(?!\[)|\/\*|\*|--)/;

/** What an edit took out and put in, without the lines it kept (its patch has the old text as -, the new as +). */
function lineChanges(patch) {
  const gone = [];
  const added = [];
  for (const raw of String(patch ?? '').split('\n')) {
    const line = raw.slice(1).trim().replace(/\s+/g, ' ');
    if (line && raw[0] === '-') gone.push(line);
    else if (line && raw[0] === '+') added.push(line);
  }
  for (let i = gone.length - 1; i >= 0; i--) {
    const j = added.indexOf(gone[i]);
    if (j >= 0) { added.splice(j, 1); gone.splice(i, 1); }
  }
  return { gone, added };
}

/**
 * Tests made to pass by changing them: before the passing test run, an edit to a test file
 * took out assertions (or commented them out), turned tests off (skip, only, todo) or changed
 * what an assertion expects. Fixing the code is the job; weakening the test is the bluff.
 * The edits that count: those after the last failing run; or, when no failing run was seen,
 * all of them, but only if no other code changed (then green can only have come from the
 * tests). An assertion the agent itself added earlier doesn't count (writing a new test
 * takes tries). { files, text: "removed 2 assertions in math.test.js" } or null. Whole-file
 * writes can't be compared (their old text isn't known), so only edits count.
 */
export function weakenedTests(steps) {
  const sorted = [...steps].sort((a, b) => a.at - b.at);
  const tests = sorted.filter((e) => e.kind === 'run' && stepType(e) === 'test' && !running(e));
  const passed = tests.findLast((e) => testVerdict(e).state === 'passed');
  if (!passed) return null;
  const failed = tests.findLast((e) => e.at < passed.at && testVerdict(e).state === 'failed');
  const isTest = (path) => TEST_FILE.test(String(path));
  const otherCode = changedCode(sorted.filter((e) => e.at < passed.at).map((e) => ({ ...e, files: (e.files ?? []).filter((f) => !isTest(f.path)) })));
  if (!failed && otherCode) return null;
  const from = failed?.at ?? -Infinity;
  const ownLines = new Set(); // lines the agent added in these steps: its own, to change as it likes
  // The shape of an assertion without its values: the same check with a different expected value.
  const shape = (l) => l.replace(/(['"`])(?:\\.|(?!\1).)*\1|-?\b\d[\d_.]*\b|\b(?:true|false|null|undefined|None|True|False|nil)\b/g, '#');
  let removed = 0, skipped = 0, changed = 0;
  const files = new Set();
  for (const e of sorted) {
    if (e.at >= passed.at || e.kind !== 'edit' || e.status === 'failed') continue;
    const file = (e.files ?? []).find((f) => isTest(f.path));
    if (!file) continue;
    const { gone, added } = lineChanges(e.body?.patch);
    const own = gone.filter((l) => ownLines.has(l));
    for (const l of added) ownLines.add(l);
    if (e.at <= from) continue;
    const lost = gone.filter((l) => !own.includes(l) && !COMMENT.test(l) && ASSERTION.test(l));
    const kept = added.filter((l) => !COMMENT.test(l) && ASSERTION.test(l));
    const before = removed + skipped + changed;
    changed += lost.filter((l) => kept.some((k) => shape(k) === shape(l))).length;
    removed += Math.max(0, lost.length - kept.length);
    skipped += added.filter((l) => !COMMENT.test(l) && SKIPS.test(l)).length;
    if (removed + skipped + changed > before) files.add(baseName(file.path));
  }
  const what = [
    removed && `removed ${plural(removed, 'assertion')}`,
    skipped && `turned ${plural(skipped, 'test')} off (skip, only or todo)`,
    changed && `changed what ${changed === 1 ? 'an assertion expects' : `${changed} assertions expect`}`,
  ].filter(Boolean);
  return what.length ? { files: [...files], text: `${what.join(', ')} in ${list([...files])}` } : null;
}

/**
 * Is a finished request that changed code ready to merge? The checks a reviewer would make:
 *   { ready, checks: [{ ok, text }], problems: [text] }, or null (still working, or no code changed).
 * Only tests the agent ran count: dotpals can't see the ones you run yourself, or CI.
 */
export function readiness(turn) {
  // Code changed: through a file tool, or (git says) through a command.
  const truth = gitTruth(turn);
  const byGit = truth?.files.some((f) => !NOT_CODE.test(f.path));
  if (!turn.end || turn.end.kind !== 'done' || !(changedCode(turn.steps) || byGit)) return null;
  const tested = testState(turn.steps);
  const last = lastTestVerdict(turn.steps);
  const ran = !!last && tested?.state !== 'untested';
  const norm = (path) => String(path).replace(/\\/g, '/').toLowerCase();
  const same = (a, b) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
  const commandPaths = turn.steps.flatMap(commandEdits).map(norm);
  // Code git saw changed that no file tool or readable command accounts for: it can't be
  // placed before or after the tests, unless no command ran after the last test run (then
  // it can only have happened before it).
  // Only a command that could have changed code counts: every part of it must be one that
  // can't (a commit, a push, a look-up, a test run). `git merge`, `git rebase` and
  // `node scripts/generate.js && git commit` can, and do.
  const after = tested?.last ? turn.steps.some((e) => e.kind === 'run' && e.at > tested.last.at && !parts(commandOf(e)).every((p) => HARMLESS.test(p))) : true;
  const gitUntimed = after && truth?.files.some((f) => !NOT_CODE.test(f.path) && !f.byTool
    && !commandPaths.some((path) => same(path, norm(f.path))));
  const checks = [
    { ok: ran, text: ran ? 'Tests ran' : 'No tests ran' },
  ];
  if (ran) {
    checks.push({ ok: tested?.state !== 'stale' && !gitUntimed, text: gitUntimed ? 'Code changed by a command after the tests may not be tested (git saw it, the steps don’t show when)' : tested?.state === 'stale' ? `Changed ${fileList(tested.since)} after the last test run` : 'Tests ran after the last change' });
    checks.push({ ok: last.state === 'passed', text: last.state === 'passed' ? 'Tests passed' : last.state === 'failed' ? 'Tests are failing' : 'Test result unclear' });
    // Green because the tests were weakened, not because the code was fixed.
    const weak = last.state === 'passed' && weakenedTests(turn.steps);
    if (weak) checks.push({ ok: false, text: `Changed the tests to make them pass: ${weak.text}` });
  }
  // Left failing: anything tried again and again, and a test or build that failed once and
  // never passed (a failing `npm run test:unit` isn't fixed by a passing `npm run lint`).
  const stuck = [...retries(turn.steps).chains.values()].filter((c) => c.outcome === 'failing'
    && (c.attempts.length > 1 || ['test', 'build'].includes(stepType(c.attempts[0]))));
  const worst = stuck.at(-1);
  checks.push({ ok: !stuck.length, text: !worst ? 'No failures left behind' : worst.attempts.length > 1 ? `${whatOf(worst.attempts[0])} still fails after ${worst.attempts.length} tries` : `${whatOf(worst.attempts[0])} failed and wasn’t fixed` });
  const risky = flags(turn.steps).filter((f) => f.level === 'warn');
  checks.push({ ok: !risky.length, text: risky.length ? risky[0].text : 'Nothing risky' });
  if (tested?.commit) checks.push({ ok: tested.commit.tested, text: tested.commit.tested ? 'The commit was tested' : 'Committed without a passing test run after the last change' });
  const problems = checks.filter((c) => !c.ok).map((c) => c.text);
  return { ready: !problems.length, checks, problems };
}

/** "✅ Ready to merge" or "⚠ Not ready to merge: Tests are failing · Changed .env…", for a card. */
export function readinessLine(r) {
  if (!r) return '';
  return r.ready ? '✅ Ready to merge: tests ran after the last change and passed, nothing risky' : `⚠ Not ready to merge: ${r.problems.join(' · ')}`;
}

/** A turn's story: chapters, flags for the whole turn, and the plan. */
export function story(turn, sessionSteps = turn.steps) {
  const chs = chapters(turn.steps);
  // Once it's finished: did it test what it changed? (While it works, it may still.)
  const tested = turn.end ? testFlag(turn.steps) : null;
  return {
    chapters: chs,
    flags: [...(tested ? [tested] : []), ...chs.flatMap((c) => c.flags)].filter((f, i, all) => all.findIndex((g) => g.text === f.text) === i),
    plan: planOf(sessionSteps),
  };
}
