// Talk to Blu: say (or type) what you want, and
//   1. Blu turns it into a task with a definition of done, by asking your own Claude
//      (`claude -p`, lean: no tools, no MCP servers, plugins, settings or CLAUDE.md;
//      a few seconds and well under a cent), and reads it back;
//   2. you send it, and the agent starts in a new terminal in the project, with a session
//      id of ours so its steps are this task's;
//   3. when the agent finishes, Blu checks the definition of done against what really
//      happened: the "Ready to merge?" rules (ui/story.js) plus what you asked for (folders
//      not to touch or the only ones to change, commands that must pass, new tests, no new
//      dependencies, a commit, a push);
//   4. if you want, Blu opens a PR: a branch, a commit of the files the task changed, a
//      push and `gh pr create`, after you've seen exactly what it will do.
//
// Safety, as with the hand-off (handoff.js): the task is a file under <home>/tasks and the
// agent's first prompt only names it; the project folder is always one the agents worked
// in, never a path from a request; git, gh and claude run without a shell, words as
// separate arguments; nothing is pushed until you confirm the PR's plan.
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { home } from './config.js';
import { findOnPath } from './handoff.js';
import { buildTurns } from './ui/recap.js';
import { commandEdits, commandOf, gitTruth, parts, ranAfterLastChange, readiness, simple, stepType, testLine, testVerdict, turnMarkdown, wholeSuite, whyStopped } from './ui/story.js';

/** The agents a task can go to. Claude Code takes a session id, so its steps are known to be the task's. */
export const TASK_AGENTS = { claude: { name: 'Claude', full: 'Claude Code' } };

// -- which project ----------------------------------------------------------------------

/** Project folders the agents worked in, newest first: [{ path, name }]. */
export function knownProjects(entries, cwdOf, { isFolder = () => true, limit = 12, name = defaultName } = {}) {
  const seen = new Set();
  const out = [];
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    const cwd = cwdOf(entries[i].session);
    if (!cwd || seen.has(cwd.toLowerCase())) continue;
    seen.add(cwd.toLowerCase());
    const n = name(cwd);
    // Not drive roots ("/", "C:\"), folders that are gone, or anything without a name.
    if (n && !/^([a-z]:)?[\\/]*$/i.test(cwd) && isFolder(cwd)) out.push({ path: cwd, name: n });
  }
  return out;
}
const defaultName = (p) => String(p ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';

const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
/** Edit distance, for names heard slightly wrong ("dot pals", "shopp"). */
function distance(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length];
}

/**
 * The project a name means: exact folder name, then a prefix, then a near match (a word
 * heard slightly wrong). No name, or nothing close: the newest one, marked `guessed`.
 * Returns { project, guessed } or { project: null } when there are none.
 */
export function pickProject(name, projects) {
  if (!projects.length) return { project: null, guessed: true };
  const want = squash(name);
  if (want) {
    const named = projects.map((p) => ({ p, n: squash(p.name) }));
    const hit = named.find((x) => x.n === want) ?? named.find((x) => x.n.startsWith(want) || want.startsWith(x.n))
      ?? named.filter((x) => distance(x.n, want) <= Math.max(1, Math.floor(want.length / 4))).sort((a, b) => distance(a.n, want) - distance(b.n, want))[0];
    if (hit) return { project: hit.p, guessed: false };
  }
  return { project: projects[0], guessed: true };
}

// -- how the project's tests run ------------------------------------------------------------

/**
 * The command that runs a project's tests, from the files in its folder, or null. Each is
 * one the test rules recognise (TEST in ui/story.js), so the run is read as a test run.
 */
export function detectTestCommand(dir, { exists = existsSync, read = (f) => readFileSync(f, 'utf8'), list = (d) => readdirSync(d) } = {}) {
  const at = (f) => join(dir, f);
  const has = (f) => { try { return exists(at(f)); } catch { return false; } };
  if (has('package.json')) {
    let test = '';
    try { test = JSON.parse(read(at('package.json'))).scripts?.test ?? ''; } catch {}
    // npm init's placeholder ("echo \"Error: no test specified\" && exit 1") isn't a test suite.
    if (test && !/no test specified/i.test(test)) {
      if (has('pnpm-lock.yaml')) return 'pnpm test';
      if (has('yarn.lock')) return 'yarn test';
      if (has('bun.lockb') || has('bun.lock')) return 'bun run test';
      return 'npm test';
    }
  }
  const files = (() => { try { return list(dir); } catch { return []; } })();
  if (has('pytest.ini') || has('conftest.py') || (has('pyproject.toml') && /pytest/.test(safeRead(read, at('pyproject.toml'))))
    || (has('tests') && (() => { try { return list(at('tests')).some((f) => /^test_.*\.py$/.test(f)); } catch { return false; } })())) return 'pytest';
  if (has('go.mod')) return 'go test ./...';
  if (has('Cargo.toml')) return 'cargo test';
  if (files.some((f) => /\.(sln|csproj|fsproj)$/i.test(f))) return 'dotnet test';
  if (has('pom.xml')) return 'mvn test';
  if (has('build.gradle') || has('build.gradle.kts')) return has('gradlew') ? './gradlew test' : 'gradle test';
  if (has('Gemfile') && has('spec')) return 'bundle exec rspec';
  if (has('composer.json') && (has('phpunit.xml') || has('phpunit.xml.dist'))) return 'vendor/bin/phpunit';
  if (has('Makefile') && /^test:/m.test(safeRead(read, at('Makefile')))) return 'make test';
  return null;
}
const safeRead = (read, f) => { try { return read(f); } catch { return ''; } };

// -- the definition of done, from your own Claude ----------------------------------------

export const PLAN_SYSTEM = `You are the developer's pal, a friendly little character who lives in the notch at the top of their screen (your name is given below). You hand their work to a coding agent (Claude Code) and check it when it's done.
They spoke to you and it was transcribed, so fix obvious transcription mistakes (for example "pie test" means pytest, "get hub" means GitHub, "Blue" may be your name).
If they're asking for work to be done, in a project or in their apps (an email, a note, a calendar invite, a message, a search), it's a task. Anything else (hello, how are you, a question, small talk) is chat: answer them yourself, warmly and briefly, in one or two short spoken sentences with no Markdown, and if it fits, ask what they'd like Claude to work on.
For work in their apps, the agent uses the apps it's connected to. Write the task so it never sends, posts, deletes or pays without asking them first: it drafts, and says where the draft is.
If a screenshot of their screen is listed below and they say "this", "that" or "here", tell the agent in the task to open that screenshot first (give its path).
You can see their coding agents right now (listed below, from dotpals). If they ask what their agents are doing, answer from that list in plain words: which project, what it's doing or what it finished. If none are listed, say none are running.
Reply with only a JSON object, no other text:
{"kind": "task" or "chat",
 "reply": "for chat, what you say back; for a task, an empty string",
 "title": "for a task, a short imperative title, at most 60 characters",
 "task": "for a task, the instructions for the agent: specific, in the developer's own terms, everything they asked for and nothing they didn't",
 "code": true if the task changes code in a project, false for anything else (an email, a note, a search),
 "project": "the project's name if they named one of the known projects, else an empty string",
 "mustNotTouch": ["files or folders they said not to change, as paths relative to the project"],
 "onlyTouch": ["the only files or folders they said to change, as paths relative to the project"],
 "mustPass": ["commands they said must pass, like npm run build, npm run lint or tsc; leave out the tests, they are always run"],
 "addTests": true if they asked for new tests, else false,
 "noNewDependencies": true if they said not to add dependencies or packages, else false,
 "commit": true if they asked to commit, else false,
 "push": true if they asked to push, else false,
 "doneAlso": ["any other conditions for done they asked for that the fields above don't cover, each short; not the tests"]}
For chat, leave the task fields empty (empty lists, false). Don't invent requirements. If a task is unclear, keep their words in "task".`;

const strings = { type: 'array', items: { type: 'string' } };
export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['task', 'chat'] }, reply: { type: 'string' },
    title: { type: 'string' }, task: { type: 'string' }, code: { type: 'boolean' }, project: { type: 'string' },
    mustNotTouch: strings, onlyTouch: strings, mustPass: strings,
    addTests: { type: 'boolean' }, noNewDependencies: { type: 'boolean' }, commit: { type: 'boolean' }, push: { type: 'boolean' },
    doneAlso: strings,
  },
  required: ['kind', 'reply', 'title', 'task', 'code', 'project', 'mustNotTouch', 'onlyTouch', 'mustPass', 'addTests', 'noNewDependencies', 'commit', 'push', 'doneAlso'],
};

/**
 * What the planner reads on stdin: what was said, the pal's name, the projects it can name, what
 * the agents are doing and, when they pointed at their screen, the screenshot (`shot`: { path, x, y }).
 */
export function plannerInput(text, projects, { name = 'Blu', agents = [], shot = null } = {}) {
  const agentLine = (a) => `- ${a.label || 'a project'} (${a.harness}): ${a.state}${a.asked ? `. Asked: "${clean(a.asked, 160)}"` : ''}${a.latest ? `. Latest: ${clean(a.latest, 200)}` : ''}`;
  return [`They said: ${String(text).trim()}`, '', `Your name: ${name}`, `Known projects: ${projects.map((p) => p.name).join(', ') || '(none)'}`,
    'Their agents right now:', ...(agents.length ? agents.map(agentLine) : ['(none running)']),
    ...(shot ? ['', `A screenshot of their screen as they spoke: ${shot.path}${Number.isFinite(shot.x) ? ` (their pointer was at ${Math.round(shot.x)}, ${Math.round(shot.y)})` : ''}`] : [])].join('\n');
}

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
/** A tidy path relative to the project: forward slashes, no "./", no leading or trailing slash, never "..". */
export function tidyPath(p) {
  const s = String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
  return !s || s.split('/').includes('..') ? '' : s;
}
/** A command that must pass: one line, at most 200 characters, without backticks (it's only ever matched, never run); '' otherwise. */
function tidyCommand(c) {
  const s = typeof c === 'string' ? c.trim().replace(/^`+|`+$/g, '').trim() : '';
  return s.length <= 200 && !/[\r\n`]/.test(s) ? s : '';
}

/**
 * The planner's answer (`claude -p --output-format json`): { chat } when it was just talk (what to
 * say back), else { title, task, project, mustNotTouch, onlyTouch, mustPass, addTests,
 * noNewDependencies, commit, push, doneAlso }; throws if it's neither.
 */
export function parsePlanReply(stdout) {
  let outer;
  try { outer = JSON.parse(String(stdout).trim()); } catch { throw new Error('Claude’s answer wasn’t JSON'); }
  if (outer?.is_error) throw new Error(clean(outer.result || 'Claude couldn’t answer', 200));
  let plan = outer?.structured_output;
  if (!plan) {
    const text = String(outer?.result ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    try { plan = JSON.parse(json); } catch { throw new Error('Claude didn’t answer with a plan'); }
  }
  if (plan.kind === 'chat' || (!String(plan.task ?? '').trim() && String(plan.reply ?? '').trim())) {
    const chat = clean(plan.reply, 400);
    if (chat) return { chat };
  }
  const list = (a, max) => (Array.isArray(a) ? a : []).map((x) => clean(x, max)).filter(Boolean).slice(0, 8);
  const out = {
    title: clean(plan.title, 80), task: String(plan.task ?? '').trim().slice(0, 4000), code: plan.code !== false, project: clean(plan.project, 80),
    mustNotTouch: list(plan.mustNotTouch, 200).map(tidyPath).filter(Boolean), onlyTouch: list(plan.onlyTouch, 200).map(tidyPath).filter(Boolean),
    mustPass: (Array.isArray(plan.mustPass) ? plan.mustPass : []).map(tidyCommand).filter(Boolean).slice(0, 8),
    addTests: plan.addTests === true, noNewDependencies: plan.noNewDependencies === true, commit: plan.commit === true, push: plan.push === true,
    doneAlso: list(plan.doneAlso, 200),
  };
  if (!out.task) throw new Error('Claude’s plan had no task');
  if (!out.title) out.title = clean(out.task, 60);
  return out;
}

/** The arguments for the planner: lean, and no text from the request (that goes on stdin). */
export function plannerArgs(systemFile, { schema = true, model = 'haiku' } = {}) {
  return ['-p', '--model', model || 'haiku', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands',
    '--no-session-persistence', '--system-prompt-file', systemFile, '--output-format', 'json',
    ...(schema ? ['--json-schema', JSON.stringify(PLAN_SCHEMA)] : [])];
}

/** An environment for an agent we start: not marked as running inside another Claude Code. */
export function agentEnv(env = process.env) {
  const out = { ...env };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'ELECTRON_RUN_AS_NODE']) delete out[k];
  return out;
}

/**
 * Run a program without a shell: { code, stdout, stderr }. A .cmd/.bat goes through cmd with each
 * word quoted (and refused if it can't be). `input` can come later, as a promise: the program
 * starts now and gets it then (Blu's brain starts Claude Code while you're still talking).
 */
export function run(file, args, { cwd, input, timeoutMs = 60_000, env = agentEnv(), spawn = nodeSpawn } = {}) {
  return new Promise((ok, fail) => {
    let child;
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
      const words = [file, ...args];
      if (words.some((w) => /["%\r\n]/.test(w))) return fail(new Error(`Can’t run ${defaultName(file)} safely with these arguments`));
      child = spawn('cmd.exe', ['/d', '/s', '/c', `"${words.map((w) => `"${w}"`).join(' ')}"`], { cwd, env, windowsVerbatimArguments: true, windowsHide: true });
    } else child = spawn(file, args, { cwd, env, windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); fail(new Error(`${defaultName(file)} took too long`)); }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.once('error', (err) => { clearTimeout(timer); fail(err); });
    child.once('close', (code) => { clearTimeout(timer); ok({ code, stdout, stderr }); });
    child.stdin?.on('error', () => {}); // it may have stopped before reading
    if (input && typeof input.then === 'function') input.then((s) => child.stdin?.end(s ?? undefined), () => child.stdin?.end());
    else if (input != null) child.stdin?.end(input); else child.stdin?.end();
  });
}

/**
 * Ask for the plan: your Claude Code, or `think(system, input)` → text, the AI you chose as Blu's
 * brain (bridge/brain.js), which is asked for the JSON in the instructions.
 */
export async function askPlanner(text, projects, { name, agents, shot, think, model, claude = findOnPath('claude'), runner = run } = {}) {
  if (think) return parsePlanReply(JSON.stringify({ result: await think(PLAN_SYSTEM, plannerInput(text, projects, { name, agents, shot })) }));
  if (!claude) throw new Error('Claude Code isn’t installed (no `claude` on PATH)');
  const dir = join(home(), 'tasks');
  await mkdir(dir, { recursive: true });
  const systemFile = join(dir, 'planner-system.txt');
  await writeFile(systemFile, PLAN_SYSTEM);
  // Through cmd (an npm-installed claude.cmd) a JSON argument can't be quoted safely: the system prompt asks for JSON instead.
  const viaCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(claude);
  // No extended thinking: this is a quick call (it halves the wait, 11 s → 4.5 s for "hi").
  const r = await runner(claude, plannerArgs(systemFile, { schema: !viaCmd, model }), { input: plannerInput(text, projects, { name, agents, shot }), cwd: home(), timeoutMs: 90_000, env: { ...agentEnv(), MAX_THINKING_TOKENS: '0' } });
  if (r.code !== 0 && !r.stdout.trim()) throw new Error(clean(r.stderr, 200) || `claude exited with ${r.code}`);
  return parsePlanReply(r.stdout);
}

/**
 * One item of the definition of done (but the tests), tidied and with its words, or null
 * when it isn't one. Paths are relative to the project and commands one line (tidyPath,
 * tidyCommand): what the planner said and what the card sends back go through here.
 */
export function doneItem(d) {
  const path = (p) => (typeof p === 'string' ? tidyPath(p) : '');
  switch (d?.kind) {
    case 'command': { const c = tidyCommand(d.command); return c ? { kind: 'command', command: c, text: `\`${c}\` passes, run after the last change` } : null; }
    case 'untouched': { const p = path(d.path); return p ? { kind: 'untouched', path: p, text: `Nothing in \`${p}\` changes` } : null; }
    case 'only': {
      const ps = [...new Set((Array.isArray(d.paths) ? d.paths : []).slice(0, 8).map(path).filter(Boolean))];
      return ps.length ? { kind: 'only', paths: ps, text: `Only files in ${ps.map((p) => `\`${p}\``).join(' or ')} change` } : null;
    }
    case 'tests-added': return { kind: 'tests-added', text: 'New tests are added' };
    case 'no-deps': return { kind: 'no-deps', text: 'No new dependencies are added' };
    case 'committed': return { kind: 'committed', text: 'The work is committed' };
    case 'pushed': return { kind: 'pushed', text: 'The work is pushed' };
    case 'manual': { const t = clean(d.text, 200); return t ? { kind: 'manual', text: t } : null; }
    default: return null;
  }
}

/**
 * The plan Blu reads back: the planner's answer, the project folder (one the agents worked
 * in, never from the request) and the definition of done:
 *   tests        the project's test command passes, run after the last change (checked)
 *   command      a command you named passes, run after the last change (checked)
 *   untouched    nothing under a path changes (checked)
 *   only         nothing outside these paths changes (checked)
 *   tests-added  test files changed, and more tests ran than before when that can be told (checked)
 *   no-deps      no lockfile changed and no package added (checked)
 *   committed    committed after the last change; pushed: pushed after it (checked)
 *   manual       anything else you asked for (shown, not checked)
 */
export function makePlan({ text, reply, projects, project: chosen, shot = null, apps = null, testCommand = detectTestCommand }) {
  const code = reply.code !== false; // an email or a note has no tests to pass
  // Work in your apps runs in a folder of its own (`apps`), unless you named a project.
  const picked = chosen ? { project: chosen, guessed: false } : !code && apps && !reply.project ? { project: apps, guessed: false } : pickProject(reply.project, projects);
  if (!picked.project) throw new Error('dotpals doesn’t know any project folders yet: start an agent in one first');
  const cmd = code ? testCommand(picked.project.path) : null;
  const done = [
    // Work in your apps (an email, a note) has no tests, commands or files to check: only what you asked for.
    ...(code ? [{ kind: 'tests', command: cmd, text: cmd ? `\`${cmd}\` passes, run after the last change` : 'The tests pass, run after the last change' }] : []),
    ...[
      ...(code ? [
        ...(reply.mustPass ?? []).filter((c) => c !== cmd).map((command) => ({ kind: 'command', command })),
        ...reply.mustNotTouch.map((path) => ({ kind: 'untouched', path })),
        { kind: 'only', paths: reply.onlyTouch ?? [] },
        reply.addTests && { kind: 'tests-added' }, reply.noNewDependencies && { kind: 'no-deps' },
        reply.commit && { kind: 'committed' }, reply.push && { kind: 'pushed' },
      ] : []),
      ...reply.doneAlso.map((text) => ({ kind: 'manual', text })),
    ].map(doneItem).filter(Boolean),
  ];
  return {
    id: `plan-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`, said: String(text).trim().slice(0, 2000),
    title: reply.title, task: reply.task, code, agent: 'claude', project: picked.project, guessedProject: picked.guessed,
    testCommand: cmd, done, ...(shot ? { shot: shot.path } : {}), createdAt: Date.now(),
  };
}

// The definition of done as the agent reads it, one bullet per item (anything else: its own words).
const BULLETS = {
  tests: (d) => `${d.command ? `\`${d.command}\` passes` : 'The project’s tests pass'}, run after your last change.`,
  command: (d) => `\`${d.command}\` passes, run after your last change.`,
  untouched: (d) => `Don’t change anything in \`${d.path}\`.`,
  only: (d) => `Only change files in ${d.paths.map((p) => `\`${p}\``).join(' or ')}.`,
  'tests-added': () => 'Add tests for it.',
  'no-deps': () => 'Don’t add dependencies.',
  committed: () => 'Commit when done.',
  pushed: () => 'Push when done.',
};

/** The task file the agent reads. */
export function taskMarkdown(plan) {
  const lines = [`# ${plan.title}`, '', `Task from dotpals (Blu) for the project in \`${plan.project.path}\`.`, '', plan.task.trim(), ''];
  if (plan.shot) lines.push(`A screenshot of their screen when they asked: \`${plan.shot}\` (open it if the task says "this" or "here").`, '');
  lines.push('## Definition of done', '');
  for (const d of plan.done) lines.push(`- ${BULLETS[d.kind]?.(d) ?? d.text}`);
  if (plan.code === false) lines.push('- Nothing is sent, posted, deleted or paid for without asking first: draft it.', '', 'When you’ve finished, say exactly what you did and where (for example: a draft saved in Gmail, not sent).');
  else lines.push('', `When you’ve finished, run ${plan.testCommand ? `\`${plan.testCommand}\`` : 'the tests'} once more after your final edit, then say what you changed and how the tests went.`);
  return `${lines.join('\n')}\n`;
}

/** What it did in your apps (their tools, through MCP), as receipts: [{ ok, text }]. dotpals' own tools aren't actions. */
export function appReceipts(steps) {
  return steps.filter((s) => s.kind === 'mcp' && !/^dotpals$/i.test(String(s.detail ?? '').trim())).map((s) => ({
    ok: s.status === 'ok' ? true : s.status === 'failed' ? false : null,
    text: `${s.detail ? `${s.detail}: ` : ''}${clean(s.title, 80)}${s.status === 'failed' ? ' (failed)' : ''}`,
  }));
}

/** Save the task file; returns its path. The name is ours (time and random letters), never from a request. */
export async function saveTask(markdown) {
  const dir = join(home(), 'tasks');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${randomBytes(3).toString('hex')}.md`);
  await writeFile(file, markdown, { mode: 0o600 });
  return file;
}

export const taskPrompt = (file) => `Read ${file} and do the task it describes. Follow its definition of done.`;

/** A session name a terminal can show: no quotes, percent signs, semicolons or line breaks. */
export const sessionName = (title) => `Blu: ${String(title).replace(/["%;\r\n]/g, ' ').replace(/\s+/g, ' ').trim()}`.slice(0, 60);

/** Claude Code's arguments for a task: our session id (its steps come back under it), a name, the prompt. */
export function claudeTaskArgs({ sessionId, title, prompt }) {
  return ['--session-id', sessionId, '-n', sessionName(title), prompt];
}

export const newSessionId = () => randomUUID();

// -- checking it ------------------------------------------------------------------------------

const slash = (p) => String(p ?? '').replace(/\\/g, '/');
/** A changed file's path relative to the project (forward slashes), or null when it's outside it. */
export function relativeTo(dir, file) {
  const f = slash(file);
  if (!isAbsolute(file) && !/^[a-z]:\//i.test(f)) return tidyPath(f) || null;
  const r = slash(relative(dir, file));
  return !r || r.startsWith('../') || r === '..' || isAbsolute(r) || /^[a-z]:/i.test(r) ? null : r;
}
/** Whether `file` is `path` or inside it (case-insensitive on Windows and macOS). */
export function under(file, path) {
  const ci = process.platform !== 'linux';
  const f = ci ? file.toLowerCase() : file;
  const p = ci ? path.toLowerCase() : path;
  return f === p || f.startsWith(`${p}/`);
}

/** The files a turn changed (file tools, commands that write files, and what git saw), relative to the project. */
export function changedFiles(turn, dir) {
  const out = new Set();
  for (const s of turn.steps) {
    if (s.status === 'failed') continue;
    for (const f of s.files ?? []) if (f.change !== 'read') out.add(f.path);
    for (const p of commandEdits(s)) out.add(p);
  }
  for (const f of gitTruth(turn)?.files ?? []) out.add(f.path);
  return [...new Set([...out].map((p) => relativeTo(dir, p)).filter(Boolean))].sort();
}

/** The live line for a step: a file's name rather than its whole path; the task file is "Reading the task". */
function doingWords(step, task) {
  const t = clean(step.title, 160);
  if (task.file && slash(t).toLowerCase() === slash(task.file).toLowerCase()) return 'Reading the task';
  if (/[\\/]/.test(t) && !/\s/.test(t)) return `${{ read: 'Reading', edit: 'Editing', write: 'Writing', search: 'Searching' }[step.kind] ?? 'On'} ${t.split(/[\\/]/).pop()}`;
  return clean(t, 120);
}

// A test file: in a test folder, or named like one (cart.test.js, cart.spec.ts, test_cart.py, cart_test.go, cart_spec.rb).
const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.\w+$|(^|\/)test_[^/]*\.py$|_test\.go$|_spec\.rb$/i;
// New dependencies, kept simple: a lockfile (or requirements file) changed; a command added
// a package (`npm i lodash`, `pip install requests`, `cargo add serde`; not `npm ci`, a bare
// `npm install` or `pip install -r requirements.txt`); or a manifest (package.json,
// pyproject.toml…) changed and an install ran. A manifest changed on its own doesn't count:
// without a diff, new dependencies can't be told from a new script.
const LOCKFILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements[^/]*\.txt|poetry\.lock|Pipfile\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/i;
const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|Pipfile|Cargo\.toml|go\.mod|Gemfile|composer\.json)$/i;
const ADD = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)|pip3?\s+install|uv\s+(?:add|pip\s+install)|poetry\s+add|cargo\s+add|go\s+get|gem\s+install|bundle\s+add|composer\s+require)\s+/i;
const INSTALL = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|ci)|pip3?\s+install|uv\s+(?:add|sync|pip\s+install)|poetry\s+(?:add|install)|cargo\s+add|go\s+get|gem\s+install|bundle\s+(?:add|install)|composer\s+(?:require|install))\b/i;
/** Whether a command (one of its parts) names a package to add: a word after the verb that isn't an option, a redirect, "." or a requirements file. */
const addsPackage = (p) => { const m = ADD.exec(p); return !!m && p.slice(m[0].length).split(/\s+/).some((w) => w && !/^-|[<>&]|^\.$|\.(txt|toml|cfg|in)$/i.test(w)); };

/** New tests: a test file changed and, when whole-suite runs before and after it can be counted, more tests ran. */
function testsAdded(steps, changed, dir) {
  const files = changed.filter((f) => TEST_FILE.test(f));
  if (!files.length) return { ok: false, text: 'No test files were added or changed' };
  const where = files.slice(0, 3).join(', ');
  const isTest = (p) => TEST_FILE.test(relativeTo(dir, p) ?? '');
  const edited = steps.filter((s) => s.status !== 'failed' && [...(s.files ?? []).filter((f) => f.change !== 'read').map((f) => f.path), ...commandEdits(s)].some(isTest)).map((s) => s.at);
  const runs = steps.filter((s) => s.kind === 'run' && stepType(s) === 'test' && wholeSuite(s)).map((s) => ({ at: s.at, f: testVerdict(s).facts }))
    .filter((r) => r.f?.parsed && r.f.total > 0).sort((a, b) => a.at - b.at);
  const after = runs.at(-1);
  // Counted before the first test file changed, and after the last (same runner): else the counts can't be compared.
  const before = edited.length && after?.at > Math.max(...edited) && runs.find((r) => r.at < Math.min(...edited) && r.f.runner === after.f.runner);
  if (!before) return { ok: true, text: `Changed ${where} (the number of tests couldn’t be compared)` };
  return after.f.total > before.f.total
    ? { ok: true, text: `Added tests: ${before.f.total} → ${after.f.total} (${where})` }
    : { ok: false, text: `Changed ${where}, but no more tests ran than before (${before.f.total} → ${after.f.total})` };
}

/** No new dependencies (see LOCKFILE above). */
function noNewDeps(steps, changed) {
  const ran = steps.filter((s) => s.kind === 'run' && s.status !== 'failed').flatMap((s) => parts(commandOf(s)));
  const added = ran.find(addsPackage);
  if (added) return { ok: false, text: `Added a package: \`${clean(added, 70)}\`` };
  const locks = changed.filter((f) => LOCKFILE.test(f));
  if (locks.length) return { ok: false, text: `Changed ${locks.slice(0, 3).join(', ')}` };
  const manifest = changed.find((f) => MANIFEST.test(f));
  if (manifest && ran.some((p) => INSTALL.test(p))) return { ok: false, text: `Changed ${manifest} and ran an install` };
  return { ok: true, text: 'No new dependencies' };
}

// What a command that had to run says, by how it ran (ranAfterLastChange in ui/story.js).
const RAN = {
  command: (c) => ({ passed: `\`${c}\` passed after the last change`, failed: `\`${c}\` failed`, stale: `\`${c}\` didn’t run after the last change`, 'not-run': `\`${c}\` didn’t run`, unclear: `\`${c}\` unclear` }),
  committed: () => ({ passed: 'Committed', failed: '`git commit` failed', stale: 'Changed code after the last commit', 'not-run': 'Not committed', unclear: 'Commit unclear' }),
  pushed: () => ({ passed: 'Pushed', failed: '`git push` failed', stale: 'Changed code after the last push', 'not-run': 'Not pushed', unclear: 'Push unclear' }),
};

/** The definition of done's own checks (the tests are readiness()'s): [{ ok: true | false | null, text }]. */
function doneChecks(task, turns, steps, changed) {
  const checks = [];
  for (const d of task.done) {
    if (d.kind === 'untouched') {
      const hit = changed.filter((f) => under(f, d.path));
      checks.push({ ok: !hit.length, text: hit.length ? `Changed ${hit.slice(0, 3).join(', ')} in ${d.path}` : `Nothing in ${d.path} changed` });
    } else if (d.kind === 'only') {
      const out = changed.filter((f) => !d.paths.some((p) => under(f, p)));
      checks.push({ ok: !out.length, text: out.length ? `Changed ${out.slice(0, 3).join(', ')} outside ${d.paths.join(' or ')}` : `Only files in ${d.paths.join(' or ')} changed` });
    } else if (RAN[d.kind]) {
      const r = ranAfterLastChange(steps, { command: d.command, committed: 'git commit', pushed: 'git push' }[d.kind]);
      // A commit git saw that no step shows (a script made it): committed all the same.
      if (d.kind === 'committed' && r.state === 'not-run' && turns.some((t) => gitTruth(t)?.committed)) checks.push({ ok: true, text: 'Committed (git saw a new commit)' });
      else checks.push({ ok: r.state === 'passed' ? true : r.state === 'unclear' ? null : false, text: `${RAN[d.kind](d.command)[r.state]}${r.state === 'unclear' && r.note ? `: ${r.note}` : ''}` });
    } else if (d.kind === 'tests-added') checks.push(testsAdded(steps, changed, task.project.path));
    else if (d.kind === 'no-deps') checks.push(noNewDeps(steps, changed));
    else if (d.kind === 'manual') checks.push({ ok: null, text: `Not checked by Blu: ${d.text}` });
  }
  return checks;
}

/**
 * Where a task stands, from its session's entries (any order):
 *   { state: 'starting' | 'working' | 'ready' | 'not-ready' | 'no-changes' | 'stopped',
 *     doing?, sentence?, checks?: [{ ok: true | false | null, text }], problems?, changed?, at? }
 * Every request in the session since the task started counts as one: "run the tests"
 * typed in its terminal afterwards is part of the same task.
 */
export function evaluate(task, entries) {
  const turns = buildTurns(entries.filter((e) => e.session === task.session && (e.at ?? 0) >= task.startedAt - 5000));
  if (!turns.length) return { state: 'starting' };
  const last = turns.at(-1);
  const steps = turns.flatMap((t) => t.steps);
  const merged = { ...turns[0], steps, end: last.end };
  if (!last.end) {
    const now = steps.findLast((s) => s.title);
    return { state: 'working', doing: now ? doingWords(now, task) : 'Reading the task' };
  }
  const sentence = simple(merged, { live: false }).text;
  if (last.end.kind === 'error') return { state: 'stopped', sentence, problems: [whyStopped(merged).text], at: last.end.at };
  if (task.code === false) {
    // Work in your apps: the receipts are what it really did there, from its own tool calls.
    const checks = appReceipts(steps);
    for (const d of task.done) if (d.kind === 'manual') checks.push({ ok: null, text: `Not checked by Blu: ${d.text}` });
    const problems = checks.filter((c) => c.ok === false).map((c) => c.text);
    const acted = checks.some((c) => c.ok === true);
    return { state: problems.length ? 'not-ready' : acted ? 'done' : 'no-actions', sentence, checks, problems, at: last.end.at, turn: merged };
  }
  const ready = readiness(merged);
  const changed = changedFiles(merged, task.project.path);
  // No code changed: still say how the rest went ("`npm run lint` passed", "Pushed"), but it isn't ready or not.
  if (!ready) return { state: 'no-changes', sentence, changed, checks: doneChecks(task, turns, steps, changed), at: last.end.at };
  // "Test result unclear" says why, as the session's test line does ("Tests unclear: it didn't finish").
  const tests = testLine(steps)?.text;
  const checks = ready.checks.map((c) => (c.text === 'Test result unclear' && /unclear/i.test(tests ?? '') ? { ...c, text: tests.split(' · ')[0] } : c));
  checks.push(...doneChecks(task, turns, steps, changed));
  const problems = checks.filter((c) => c.ok === false).map((c) => c.text);
  return { state: problems.length ? 'not-ready' : 'ready', sentence, checks, problems, changed, tests, at: last.end.at, turn: merged };
}

/** What Blu says about a task's result, in one or two sentences. */
export function verdictWords(task, v) {
  const who = TASK_AGENTS[task.agent]?.name ?? 'The agent';
  const lower = (s) => String(s ?? '').charAt(0).toLowerCase() + String(s ?? '').slice(1);
  if (v.state === 'ready') return `${who}'s done, and it checks out. ${v.sentence} Ready to merge. Want me to open a PR?`;
  if (v.state === 'done') return `${who}'s done. Here's what it really did: ${v.checks.filter((c) => c.ok === true).map((c) => c.text).join(', ')}.`;
  if (v.state === 'no-actions') return `${who} says it's finished, but it didn't do anything in your apps. ${v.sentence}`;
  if (v.state === 'not-ready') return `Hmm. ${who} says it's done, but it isn't ready yet: ${lower(v.problems[0])}.`;
  if (v.state === 'no-changes') return `${who} finished, but it didn't change any code. ${v.sentence}`;
  if (v.state === 'stopped') return `${who} stopped: ${lower(v.problems?.[0] ?? 'it hit an error')}.`;
  return '';
}

/** A request to send the agent to fix what's wrong (copied for you to paste into its terminal). */
export function fixRequest(task, v) {
  const lines = [`dotpals checked your work on "${task.title}" and it isn't done yet:`, ...v.problems.map((p) => `- ${p}`), ''];
  lines.push(task.code === false ? 'Fix that, and say exactly what you did and where.' : `Fix that, then run ${task.testCommand ? `\`${task.testCommand}\`` : 'the tests'} again after your last change.`);
  return lines.join('\n');
}

/** The PR's description: what you asked, the definition of done with how each went, and the evidence. */
export function receiptMarkdown(task, v) {
  const mark = (ok) => (ok === true ? '✅' : ok === false ? '❌' : '❔');
  const lines = [`> ${task.said}`, '', `${TASK_AGENTS[task.agent]?.full ?? 'An agent'} did this task through [dotpals](https://github.com/Rikinshah787/dotpals) (Talk to Blu). dotpals checked the result against the definition of done:`, ''];
  for (const c of v.checks ?? []) lines.push(`- ${mark(c.ok)} ${c.text}`);
  if (v.tests) lines.push('', `**Tests:** ${v.tests}`);
  if (v.changed?.length) lines.push('', '**Changed:**', ...v.changed.slice(0, 40).map((f) => `- \`${f}\``));
  if (v.turn) lines.push('', '<details><summary>What the agent did</summary>', '', turnMarkdown(v.turn, { live: false }), '', '</details>');
  return `${lines.join('\n')}\n`;
}

// -- the PR -------------------------------------------------------------------------------------

export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';

/**
 * What opening a PR would do, without doing it: { base, branch, newBranch, files, ahead, title }
 * or { error }. `files`: the task's changed files git still has as uncommitted (only those
 * get committed). `ahead`: commits the branch already has over the base.
 */
export async function prPlan(task, v, { git = (args) => run('git', args, { cwd: task.project.path, timeoutMs: 20_000 }), gh = findOnPath('gh') } = {}) {
  if (!gh) return { error: 'The GitHub CLI (gh) isn’t installed' };
  const out = async (args, { raw = false } = {}) => { const r = await git(args); return r.code === 0 ? (raw ? r.stdout : r.stdout.trim()) : null; };
  if ((await out(['rev-parse', '--is-inside-work-tree'])) !== 'true') return { error: 'The project isn’t a git repository' };
  const current = await out(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!current || current === 'HEAD') return { error: 'The repository isn’t on a branch' };
  if (!(await out(['remote', 'get-url', 'origin']))) return { error: 'The repository has no remote called origin' };
  const base = (await out(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))?.replace(/^origin\//, '')
    ?? ((await out(['rev-parse', '--verify', '--quiet', 'origin/main'])) ? 'main' : 'master');
  const newBranch = current === base;
  const branch = newBranch ? `blu/${slug(task.title)}-${randomBytes(2).toString('hex')}` : current;
  // Raw: each line starts with two status columns, the first often a space.
  const status = (await out(['status', '--porcelain', '--untracked-files=all'], { raw: true })) ?? '';
  const dirty = new Set(status.split('\n').filter(Boolean).map((l) => slash(l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop())));
  const files = (v.changed ?? []).filter((f) => [...dirty].some((d) => d.toLowerCase() === f.toLowerCase()));
  const ahead = Number(await out(['rev-list', '--count', `origin/${base}..HEAD`])) || 0;
  if (!files.length && !ahead) return { error: 'There’s nothing to put in a PR: no changes from this task, and no commits ahead of the base' };
  return { base, branch, newBranch, files, ahead, title: task.title };
}

/** Do it: branch, commit the task's files, push, `gh pr create`. Resolves { url } or rejects with what failed. */
export async function openPr(task, plan, body, { git = (args) => run('git', args, { cwd: task.project.path, timeoutMs: 60_000 }), gh = findOnPath('gh'), runner = run } = {}) {
  const step = async (what, r) => { const x = await r; if (x.code !== 0) throw new Error(`${what} failed: ${clean(x.stderr || x.stdout, 200)}`); return x.stdout.trim(); };
  if (plan.newBranch) await step('Creating the branch', git(['switch', '-c', plan.branch]));
  if (plan.files.length) {
    await step('Adding the files', git(['add', '--', ...plan.files]));
    await step('Committing', git(['commit', '-m', task.title, '-m', `Done by ${TASK_AGENTS[task.agent]?.full ?? 'an agent'} and checked by dotpals (Talk to Blu).`]));
  }
  await step('Pushing', git(['push', '-u', 'origin', plan.branch]));
  const dir = join(home(), 'tasks');
  await mkdir(dir, { recursive: true });
  const bodyFile = join(dir, `${task.id}-pr.md`);
  await writeFile(bodyFile, body);
  const out = await step('Opening the PR', runner(gh, ['pr', 'create', '--base', plan.base, '--head', plan.branch, '--title', task.title, '--body-file', bodyFile], { cwd: task.project.path, timeoutMs: 60_000 }));
  const url = out.split(/\s+/).find((w) => /^https:\/\/\S+\/pull\/\d+/.test(w));
  return { url: url ?? null, output: clean(out, 300) };
}

// -- the list of tasks, kept in <home>/tasks.json ----------------------------------------------

export function createTaskList({ file = () => join(home(), 'tasks.json'), keep = 30 } = {}) {
  const tasks = new Map();
  let loaded = false;
  const load = async () => {
    if (loaded) return;
    loaded = true;
    try { for (const t of JSON.parse(await readFile(file(), 'utf8'))) if (t?.id && t.session) tasks.set(t.id, t); } catch {}
  };
  const save = async () => {
    const list = [...tasks.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-keep);
    try { await mkdir(home(), { recursive: true }); await writeFile(file(), JSON.stringify(list.map(({ verdict, ...t }) => ({ ...t, verdict: verdict && { ...verdict, turn: undefined } })))); } catch {}
  };
  return {
    load, save,
    add(task) { tasks.set(task.id, task); return save(); },
    get: (id) => tasks.get(id),
    bySession: (session) => [...tasks.values()].find((t) => t.session === session),
    list: () => [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt),
  };
}
