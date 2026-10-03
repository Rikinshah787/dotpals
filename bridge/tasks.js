// Talk to Blu: say (or type) what you want, and
//   1. Blu turns it into a task with a definition of done, by asking your own Claude
//      (`claude -p`, lean: no tools, no MCP servers, plugins, settings or CLAUDE.md;
//      a few seconds and well under a cent), and reads it back;
//   2. you send it, and the agent starts in a new terminal in the project, with a session
//      id of ours so its steps are this task's;
//   3. when the agent finishes, Blu checks the definition of done against what really
//      happened: the "Ready to merge?" rules (ui/story.js) plus the folders you said not
//      to touch;
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
import { commandEdits, gitTruth, readiness, simple, testLine, turnMarkdown, whyStopped } from './ui/story.js';

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

export const PLAN_SYSTEM = `You turn a developer's request into a task for a coding agent (Claude Code) working in a software project.
The request was spoken and transcribed, so fix obvious transcription mistakes (for example "pie test" means pytest, "get hub" means GitHub).
Reply with only a JSON object, no other text:
{"title": "a short imperative title, at most 60 characters",
 "task": "the instructions for the agent: specific, in the developer's own terms, everything they asked for and nothing they didn't",
 "project": "the project's name if the developer named one of the known projects, else an empty string",
 "mustNotTouch": ["files or folders the developer said not to change, as paths relative to the project"],
 "doneAlso": ["other conditions for done that the developer asked for, each short; leave out running the tests, that is always added"]}
Don't invent requirements. If the request is unclear, keep the developer's words in "task".`;

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' }, task: { type: 'string' }, project: { type: 'string' },
    mustNotTouch: { type: 'array', items: { type: 'string' } }, doneAlso: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'task', 'project', 'mustNotTouch', 'doneAlso'],
};

/** What the planner reads on stdin: the request, and the projects it can name. */
export function plannerInput(text, projects) {
  return [`Request: ${String(text).trim()}`, '', `Known projects: ${projects.map((p) => p.name).join(', ') || '(none)'}`].join('\n');
}

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
/** A tidy path relative to the project: forward slashes, no "./", no leading or trailing slash, never "..". */
export function tidyPath(p) {
  const s = String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
  return !s || s.split('/').includes('..') ? '' : s;
}

/** The planner's answer (`claude -p --output-format json`), as { title, task, project, mustNotTouch, doneAlso }; throws if it isn't one. */
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
  const list = (a, max) => (Array.isArray(a) ? a : []).map((x) => clean(x, max)).filter(Boolean).slice(0, 8);
  const out = {
    title: clean(plan.title, 80), task: String(plan.task ?? '').trim().slice(0, 4000), project: clean(plan.project, 80),
    mustNotTouch: list(plan.mustNotTouch, 200).map(tidyPath).filter(Boolean), doneAlso: list(plan.doneAlso, 200),
  };
  if (!out.task) throw new Error('Claude’s plan had no task');
  if (!out.title) out.title = clean(out.task, 60);
  return out;
}

/** The arguments for the planner: lean, and no text from the request (that goes on stdin). */
export function plannerArgs(systemFile, { schema = true } = {}) {
  return ['-p', '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands',
    '--no-session-persistence', '--system-prompt-file', systemFile, '--output-format', 'json',
    ...(schema ? ['--json-schema', JSON.stringify(PLAN_SCHEMA)] : [])];
}

/** An environment for an agent we start: not marked as running inside another Claude Code. */
export function agentEnv(env = process.env) {
  const out = { ...env };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'ELECTRON_RUN_AS_NODE']) delete out[k];
  return out;
}

/** Run a program without a shell: { code, stdout, stderr }. A .cmd/.bat goes through cmd with each word quoted (and refused if it can't be). */
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
    if (input != null) child.stdin?.end(input); else child.stdin?.end();
  });
}

/** Ask your Claude for the plan. */
export async function askPlanner(text, projects, { claude = findOnPath('claude'), runner = run } = {}) {
  if (!claude) throw new Error('Claude Code isn’t installed (no `claude` on PATH)');
  const dir = join(home(), 'tasks');
  await mkdir(dir, { recursive: true });
  const systemFile = join(dir, 'planner-system.txt');
  await writeFile(systemFile, PLAN_SYSTEM);
  // Through cmd (an npm-installed claude.cmd) a JSON argument can't be quoted safely: the system prompt asks for JSON instead.
  const viaCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(claude);
  const r = await runner(claude, plannerArgs(systemFile, { schema: !viaCmd }), { input: plannerInput(text, projects), cwd: home(), timeoutMs: 90_000 });
  if (r.code !== 0 && !r.stdout.trim()) throw new Error(clean(r.stderr, 200) || `claude exited with ${r.code}`);
  return parsePlanReply(r.stdout);
}

/**
 * The plan Blu reads back: the planner's answer, the project folder (one the agents worked
 * in, never from the request) and the definition of done:
 *   tests      the project's test command passes, run after the last change (checked)
 *   untouched  nothing under a path changes (checked)
 *   manual     anything else you asked for (shown, not checked)
 */
export function makePlan({ text, reply, projects, project: chosen, testCommand = detectTestCommand }) {
  const picked = chosen ? { project: chosen, guessed: false } : pickProject(reply.project, projects);
  if (!picked.project) throw new Error('dotpals doesn’t know any project folders yet: start an agent in one first');
  const cmd = testCommand(picked.project.path);
  const done = [
    { kind: 'tests', command: cmd, text: cmd ? `\`${cmd}\` passes, run after the last change` : 'The tests pass, run after the last change' },
    ...reply.mustNotTouch.map((path) => ({ kind: 'untouched', path, text: `Nothing in \`${path}\` changes` })),
    ...reply.doneAlso.map((text) => ({ kind: 'manual', text })),
  ];
  return {
    id: `plan-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`, said: String(text).trim().slice(0, 2000),
    title: reply.title, task: reply.task, agent: 'claude', project: picked.project, guessedProject: picked.guessed,
    testCommand: cmd, done, createdAt: Date.now(),
  };
}

/** The task file the agent reads. */
export function taskMarkdown(plan) {
  const lines = [`# ${plan.title}`, '', `Task from dotpals (Blu) for the project in \`${plan.project.path}\`.`, '', plan.task.trim(), '', '## Definition of done', ''];
  for (const d of plan.done) {
    if (d.kind === 'tests') lines.push(`- ${d.command ? `\`${d.command}\` passes, run after your last change` : 'The project’s tests pass, run after your last change'}.`);
    else if (d.kind === 'untouched') lines.push(`- Don’t change anything in \`${d.path}\`.`);
    else lines.push(`- ${d.text}`);
  }
  lines.push('', `When you’ve finished, run ${plan.testCommand ? `\`${plan.testCommand}\`` : 'the tests'} once more after your final edit, then say what you changed and how the tests went.`);
  return `${lines.join('\n')}\n`;
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
  const ready = readiness(merged);
  const changed = changedFiles(merged, task.project.path);
  if (!ready) return { state: 'no-changes', sentence, changed, at: last.end.at };
  // "Test result unclear" says why, as the session's test line does ("Tests unclear: it didn't finish").
  const tests = testLine(steps)?.text;
  const checks = ready.checks.map((c) => (c.text === 'Test result unclear' && /unclear/i.test(tests ?? '') ? { ...c, text: tests.split(' · ')[0] } : c));
  for (const d of task.done) {
    if (d.kind === 'untouched') {
      const hit = changed.filter((f) => under(f, d.path));
      checks.push({ ok: !hit.length, text: hit.length ? `Changed ${hit.slice(0, 3).join(', ')} in ${d.path}` : `Nothing in ${d.path} changed` });
    } else if (d.kind === 'manual') checks.push({ ok: null, text: `Not checked by Blu: ${d.text}` });
  }
  const problems = checks.filter((c) => c.ok === false).map((c) => c.text);
  return { state: problems.length ? 'not-ready' : 'ready', sentence, checks, problems, changed, tests, at: last.end.at, turn: merged };
}

/** What Blu says about a task's result, in one or two sentences. */
export function verdictWords(task, v) {
  const who = TASK_AGENTS[task.agent]?.name ?? 'The agent';
  if (v.state === 'ready') return `${who} is done. ${v.sentence} Ready to merge. Want a PR?`;
  if (v.state === 'not-ready') return `${who} says it's done, but it isn't ready: ${v.problems[0]}.`;
  if (v.state === 'no-changes') return `${who} finished without changing any code. ${v.sentence}`;
  if (v.state === 'stopped') return `${who} stopped: ${v.problems?.[0] ?? 'it hit an error'}.`;
  return '';
}

/** A request to send the agent to fix what's wrong (copied for you to paste into its terminal). */
export function fixRequest(task, v) {
  const lines = [`dotpals checked your work on "${task.title}" and it isn't done yet:`, ...v.problems.map((p) => `- ${p}`), ''];
  lines.push(`Fix that, then run ${task.testCommand ? `\`${task.testCommand}\`` : 'the tests'} again after your last change.`);
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
