// dotpals as an MCP server: any assistant (Claude Code, Codex, Cursor, the Claude and
// ChatGPT apps) can ask dotpals what the agents on this computer really did, and whether
// it's really tested, and get the evidence instead of the agent's own word.
//
//   dotpals mcp        (Claude Code: claude mcp add dotpals -- npx dotpals mcp)
//
// MCP over stdio: one JSON-RPC 2.0 message per line, in on stdin, out on stdout. No SDK:
// a server with only tools needs a handful of methods. stdout carries nothing but those
// messages (anything else breaks the client), so console.log goes to stderr here.
//
// Read-only. Every call fetches the running bridge's activity (GET /api/activity) and
// where each session works (GET /api/sessions), and reads them with the rules the pal and
// the notch use (ui/story.js, ui/recap.js), so the answers match what they show. With no
// bridge running, a tool says how to start it.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { clip, folderName } from './activity.js';
import { handoffNote } from './ui/handoff.js';
import { baseName, facts, harnessName, plural, sentence, shortTime, startOfDay, summarizeSessions } from './ui/recap.js';
import { flags, list as nameList, onlyOldFailures, readiness, simple, stepType, testLine, testState, testVerdict, weakenedTests, whyStopped } from './ui/story.js';
import { failureReason } from './ui/testout.js';

const version = (() => { try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return '0.0.0'; } })();
// Like the hooks (guard-hook.js): not PORT, which the assistant's own environment may set for an app.
const bridge = process.env.DOTPALS_BRIDGE || `http://127.0.0.1:${Number(process.env.DOTPALS_PORT) || 5175}`;
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']; // the first is the one we answer with when the client's is unknown
const MIN = 60_000;
const NOT_RUNNING = 'dotpals isn’t running. Start it with `npx dotpals start` (or open the pal).';
const INSTRUCTIONS = 'dotpals watches the coding agents on this computer (Claude Code, Codex, Cursor and others) and checks what they really did: files changed, commands run, and test results read from the test output, not from what the agent said. Before you tell the user your work is done, call check_my_work. Use agents_now, recap, today, test_status, ready_to_merge and risky_steps to answer questions about what agents did, and handoff_note to pass a session\'s work to another agent.';

// -- reading the bridge's activity ---------------------------------------------------

const running = (e) => e.status === 'running' || e.status === 'waiting';
const lastAt = (t) => Math.max(t.at, t.end?.at ?? 0, ...t.steps.map((e) => e.at ?? 0));
const agentName = (h) => (h === 'claude' ? 'Claude Code' : harnessName(h));
const named = (s) => `${agentName(s.harness)} in ${s.label ?? 'an unknown folder'}`;
const asked = (t) => (t.prompt ? `“${clip(t.prompt.title, 160)}”` : '(no prompt recorded)');
const ago = (at) => { const m = Math.round((Date.now() - at) / MIN); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)} days ago`; };
const when = (at) => (at >= startOfDay() ? shortTime(at) : new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));

/**
 * Every session the bridge holds, newest first, with its requests (turns) and how the
 * newest one stands; null when the bridge doesn't answer. There's no agent state in the
 * activity, so like the dashboard: the newest request is still going when it hasn't ended
 * and something happened in the last 5 minutes, or a step (a long test run, a permission
 * prompt) is still going, within the hour. `cwd`: the folder the session works in, when
 * the bridge knows it (an older bridge has no /api/sessions: then projects match by name).
 */
async function load() {
  const get = (path) => fetch(`${bridge}${path}`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
  let entries, sessions;
  try {
    [{ entries }, { sessions }] = await Promise.all([get('/api/activity'), get('/api/sessions').catch(() => ({}))]);
  } catch { return null; }
  if (!Array.isArray(entries)) return null;
  const cwds = new Map((Array.isArray(sessions) ? sessions : []).map((m) => [m?.id, m?.cwd]));
  const now = Date.now();
  return summarizeSessions(entries).map((s) => {
    const turns = s.turns.filter((t) => t.prompt || t.steps.length);
    const turn = turns.at(-1);
    if (!turn) return null;
    const live = !turn.end && (now - s.last < 5 * MIN || (turn.steps.some(running) && now - s.last < 60 * MIN));
    const waiting = live && turn.steps.some((e) => e.status === 'waiting');
    return { ...s, cwd: typeof cwds.get(s.id) === 'string' ? cwds.get(s.id) : null, turns, turn, live, waiting, why: whyStopped(turn, { live, waiting }) };
  }).filter(Boolean);
}

/** "Claude Code in shop: finished 3 min ago (session 1f2e…)", with why it stopped when that's news. */
function header(s) {
  const state = s.live ? (s.waiting ? 'waiting for you' : 'working')
    : `${s.turn.end?.kind === 'done' ? 'finished' : 'stopped'} ${ago(s.last)}${s.why && s.why.kind !== 'done' ? `: ${s.why.text}` : ''}`;
  return `${named(s)}: ${state} (session ${s.id})`;
}

// Paths compared as text: forward slashes, no slash at the end, any case on Windows.
const norm = (p) => { const s = String(p).replace(/\\/g, '/').replace(/\/+$/, ''); return process.platform === 'win32' ? s.toLowerCase() : s; };
// The home folder or a drive's root holds every project: an agent started there isn't working on this one.
const wide = (p) => p === norm(homedir()) || /^([a-z]:)?$/i.test(p);

/**
 * How close a session's folder is to the project's: 3 the same, 2 inside it (a package of the
 * monorepo you're in), 1 around it (an agent started at the monorepo's root), 0 apart.
 */
function near(cwd, project) {
  const a = norm(cwd);
  const b = norm(project);
  if (a === b) return 3;
  if (wide(a) || wide(b)) return 0;
  return a.startsWith(`${b}/`) ? 2 : b.startsWith(`${a}/`) ? 1 : 0;
}

/**
 * The sessions `session` (an ID or its start) or else `project` picks, the closest first,
 * then the newest. A path (or none: the folder this server runs in) matches where each
 * session works, so two "api" folders, a monorepo's packages and worktrees stay apart; a
 * session whose folder the bridge doesn't know, and a bare name ("shop"), match by name.
 */
function pick(all, { project, session } = {}) {
  if (session) return all.filter((s) => String(s.id).startsWith(session));
  const name = String(folderName(project || process.cwd()) ?? '').toLowerCase();
  const sameName = (s) => String(s.label ?? '').toLowerCase() === name;
  if (project && !/[\\/]/.test(project)) return all.filter(sameName);
  const path = !project ? process.cwd() : isAbsolute(project) ? project : resolve(project);
  return all.map((s) => ({ s, n: s.cwd ? near(s.cwd, path) : sameName(s) ? 3 : 0 }))
    .filter((x) => x.n).sort((a, b) => b.n - a.n).map((x) => x.s);
}

/** When nothing matched: which projects dotpals does know (their folders, when known), so the assistant can ask again. */
function none(all, { project, session } = {}) {
  if (session) return `dotpals has no session ${session}. agents_now lists the recent ones.`;
  const known = [...new Set(all.map((s) => s.cwd ?? s.label).filter(Boolean))].slice(0, 8);
  return `dotpals has seen no agent working in ${project || process.cwd()}.${known.length ? ` Projects it knows: ${known.join(', ')}. Pass one as \`project\`.` : ''}`;
}

/** What `pick` found, for a heading: the session's agent and project, or the project's name. */
const titleOf = (list, args) => (args.session ? named(list[0]) : list[0].label ?? folderName(list[0].cwd));

/**
 * Is the code as the session left it ready? readiness() judges one finished request; here
 * the whole session counts (tests run in a later request cover an earlier change), and a
 * request still going is judged as if it stopped now (check_my_work asks in the middle).
 */
const review = (s) => readiness({ ...s.turn, steps: s.turns.flatMap((t) => t.steps), end: { ...s.turn.end, kind: 'done' } });

/** The last test run in these steps, with testState's verdict on it; null while it runs, or when none ran. */
const lastRun = (steps) => { const t = testState(steps); return t?.last && t.state !== 'running' ? t : null; };

/** Why the tests failed, when the last run did, read from its output like the fix loop does: "Why: expected 3, got -1 (test/math.test.js:5)", or ''. */
function whyFailed(steps) {
  const t = lastRun(steps);
  const r = t?.verdict.state === 'failed' && failureReason(`${t.last.body?.output ?? ''}\n${t.last.error ?? ''}`);
  return r ? `Why: ${r.why}${r.where ? ` (${r.where})` : ''}` : '';
}

/**
 * A request's result, line by line: its sentence and warnings (as the pal shows them), a pass
 * that came from changing the tests instead of the code, and why the tests failed.
 */
function result(t, live) {
  const r = simple(t, { live });
  const weak = !live && lastRun(t.steps)?.verdict.state === 'passed' && weakenedTests(t.steps);
  return [
    r.text,
    ...r.warnings.map((w) => `⚠ ${w}`),
    ...(weak ? [`⚠ Tests passed only after they were changed: ${weak.text}`] : []),
    ...(live ? [] : [whyFailed(t.steps)].filter(Boolean)),
  ];
}

/** `since`: minutes ago ("90") or a time ("2026-10-04T09:00"). */
function sinceOf(v) {
  const at = /^\s*\d+(\.\d+)?\s*$/.test(v) ? Date.now() - Number(v) * MIN : Date.parse(v);
  if (Number.isNaN(at)) throw bad('since: give minutes ("90") or a time ("2026-10-04T09:00")');
  return at;
}

// -- the tools -------------------------------------------------------------------------

const PROJECT = { type: 'string', description: 'The project: its folder\'s path (best: dotpals matches where each agent works, so same-named folders, a monorepo\'s packages and worktrees stay apart) or its name. Default: the folder this server runs in.' };
const SESSION = { type: 'string', description: 'A session ID from agents_now (or its first characters). Default: the newest session in the project.' };
const SINCE = { type: 'string', description: 'Only work since then: minutes ago ("90") or a time ("2026-10-04T09:00").' };
const ONLY_THEIRS = 'Only tests an agent ran count: dotpals can’t see the ones you run yourself, or CI.';

/** The session's repository right now (GET /api/git): { branch, head, changed, more }, or null (no git, an older bridge). */
async function gitNow(s) {
  try {
    const git = await (await fetch(`${bridge}/api/git?session=${encodeURIComponent(s.id)}`, { signal: AbortSignal.timeout(3000) })).json();
    return git?.head || git?.branch ? git : null;
  } catch { return null; }
}
// Files not committed yet, by name: "math.js, test/math.test.js +3".
const uncommitted = (git) => (git?.changed?.length ? `${git.changed.slice(0, 5).join(', ')}${git.changed.length + (git.more ?? 0) > 5 ? ` +${git.changed.length + (git.more ?? 0) - 5}` : ''}` : '');

const TOOLS = {
  agents_now: {
    description: 'What the coding agents on this computer (Claude Code, Codex, Cursor and others dotpals watches) are doing, or did in the last 2 hours, newest first: the project, whether each is working, waiting for you, finished or stopped, what it was asked, its latest step or result, and how its tests stand. dotpals reads this from what the agents actually did (their tool calls and the test output), not from what they said. Use it for "what are my agents doing?" and to find a session ID for the other tools.',
    inputSchema: { type: 'object', properties: {} },
    run(args, all) {
      const recent = all.filter((s) => Date.now() - s.last < 120 * MIN);
      if (!recent.length) return `No agent has worked in the last 2 hours.${all[0] ? ` The last one was ${named(all[0])}, ${ago(all[0].last)}.` : ''}`;
      return [...recent.slice(0, 10).map((s) => {
        const lines = [header(s), `  Asked: ${asked(s.turn)}`];
        const step = s.turn.steps.at(-1);
        if (s.live) lines.push(`  Now: ${step ? sentence(step) : 'Thinking…'}`);
        else lines.push(...result(s.turn, false).map((l, i) => `  ${i ? '' : 'Result: '}${l}`));
        const tests = testLine(s.entries);
        if (tests) lines.push(`  ${tests.text}`);
        return lines.join('\n');
      }), ...(recent.length > 10 ? [`and ${plural(recent.length - 10, 'older session')}`] : [])].join('\n\n');
    },
  },
  test_status: {
    description: 'Is the code really tested? How the tests stand in an agent session, from the test runs dotpals saw: passed or failed (read from the test output, with the counts, and why the last run failed), when, and whether code changed after the last run (stale) or was never tested. Only tests an agent ran count. Default: the newest session in this project.',
    inputSchema: { type: 'object', properties: { project: PROJECT, session: SESSION } },
    run(args, all) {
      const s = pick(all, args)[0];
      if (!s) return none(all, args);
      return [header(s), testLine(s.entries)?.text ?? 'No code changed and no tests ran in this session.', whyFailed(s.entries)].filter(Boolean).join('\n');
    },
  },
  ready_to_merge: {
    description: 'Is an agent session\'s work ready to merge? The checks a reviewer would make, each ✓ or ✗: tests ran, after the last change, and passed (and not because the tests were changed); no failure left behind; nothing risky (force pushes, .env changes, recursive deletes…); the commit was tested. Pass `branch` to ask about a git branch ("is feat/login ready?"). Default: the newest session in this project.',
    inputSchema: { type: 'object', properties: { project: PROJECT, session: SESSION, branch: { type: 'string', description: 'A git branch ("feat/login"): the newest session whose work ended on it, this project\'s first.' } } },
    async run(args, all) {
      // What git looked like when the session's last request ended (bridge/ground.js): its branch.
      const gitOf = (x) => x.turns.findLast((t) => t.end?.git)?.end.git;
      const s = args.branch ? [...pick(all, { project: args.project }), ...all].find((x) => gitOf(x)?.branch === args.branch) : pick(all, args)[0];
      if (!s) return args.branch ? `dotpals hasn’t seen an agent work on branch ${args.branch}. It notes the branch when an agent finishes a request in a git repository.` : none(all, args);
      // And now: the branch it's on, and what isn't committed (a merge wouldn't take it).
      const ended = gitOf(s);
      const now = await gitNow(s);
      const branch = now?.branch ?? ended?.branch;
      const head = now?.head ?? ended?.head;
      const top = [header(s), ...(branch ? [`On branch ${branch}${head ? ` at ${head}` : ''}`] : [])];
      const r = review(s);
      if (!r) return [...top, 'Nothing changed yet: no code changed in this session.', ...(now?.changed?.length ? [`Not committed (git): ${uncommitted(now)}`] : [])].join('\n');
      const checks = [...r.checks, ...(now?.changed?.length ? [{ ok: false, text: `Not committed yet: ${uncommitted(now)}. A merge wouldn’t include it.` }] : [])];
      const ready = checks.every((c) => c.ok);
      // Still working: the checks as they stand now, rather than "ask again later".
      return [...top, ...(s.live ? ['Still working, so this is how it stands right now:'] : []), ready ? '✅ Ready to merge' : '⚠ Not ready to merge', ...checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.text}`), ONLY_THEIRS].join('\n');
    },
  },
  recap: {
    description: 'What agents actually did, request by request: what each was asked, one plain sentence on what it did (files changed, how the tests went, what it shipped), warnings worth a look (tests that passed only after they were changed, too), why its tests failed, and the files it changed. For a project (default: this one, the last 24 hours) or one session (all of it).',
    inputSchema: { type: 'object', properties: { project: PROJECT, session: SESSION, since: SINCE } },
    run(args, all) {
      const from = args.since ? sinceOf(args.since) : args.session ? 0 : Date.now() - 24 * 60 * MIN;
      const list = pick(all, args);
      if (!list.length) return none(all, args);
      const turns = list.flatMap((s) => s.turns.filter((t) => lastAt(t) >= from).map((t) => ({ s, t }))).sort((a, b) => a.t.at - b.t.at);
      const title = titleOf(list, args);
      if (!turns.length) return `Nothing from ${title} since ${when(from)}.`;
      const shown = turns.slice(-20);
      return [`${title}: ${plural(turns.length, 'request')}${from ? ` since ${when(from)}` : ''}${shown.length < turns.length ? ` (the last ${shown.length} below)` : ''}`, ...shown.map(({ s, t }) => {
        const f = facts(t.steps);
        const files = [...f.changed, ...f.wrote, ...f.deleted].map((x) => baseName(x.path));
        return [
          `${when(t.at)} · ${named(s)}: ${asked(t)}`,
          ...result(t, s.live && t === s.turn).map((l) => `  ${l}`),
          ...(files.length ? [`  Files: ${files.slice(0, 8).join(', ')}${files.length > 8 ? ` +${files.length - 8} more` : ''}`] : []),
        ].join('\n');
      })].join('\n\n');
    },
  },
  today: {
    description: 'What the agents did today, for a standup or an end-of-day note: per agent, how many requests, files changed and test runs, then each request with what it was asked and one plain sentence on what it did, warnings worth a look (tests that passed only after they were changed, too) and why its tests failed. For a project (default: this one).',
    inputSchema: { type: 'object', properties: { project: PROJECT } },
    run(args, all) {
      const list = pick(all, args);
      if (!list.length) return none(all, args);
      const from = startOfDay();
      const agents = new Map(); // harness → its requests today, oldest first
      for (const s of list) for (const t of s.turns) if (t.at >= from) agents.set(s.harness, [...(agents.get(s.harness) ?? []), { s, t }]);
      const title = titleOf(list, args);
      if (!agents.size) return `Nothing from ${title} today.`;
      return [`Today in ${title}`, ...[...agents].map(([harness, turns]) => {
        turns.sort((a, b) => a.t.at - b.t.at);
        const steps = turns.flatMap(({ t }) => t.steps);
        const tests = steps.filter((e) => e.kind === 'run' && stepType(e) === 'test' && !running(e)).length;
        const shown = turns.slice(-20);
        return [
          `${agentName(harness)}: ${plural(turns.filter(({ t }) => t.prompt).length, 'request')} · ${plural(facts(steps).touched, 'file')} changed · ${plural(tests, 'test run')}${shown.length < turns.length ? ` (the last ${shown.length} below)` : ''}`,
          ...shown.map(({ s, t }) => [`  ${shortTime(t.at)} ${asked(t)}`, ...result(t, s.live && t === s.turn).map((l) => `    ${l}`)].join('\n')),
        ].join('\n');
      })].join('\n\n');
    },
  },
  risky_steps: {
    description: 'Risky things agents did, each with when, which agent and the command: force pushes, recursive deletes, git changes thrown away, dropped database tables, scripts piped from the internet, sudo and permission changes, force-stopped programs, changes to .env and other secret files, and the same command failing again and again. Use it for "did my agents do anything dangerous?" or before trusting their work. For a project (default: this one, the last 24 hours) or one session (all of it).',
    inputSchema: { type: 'object', properties: { project: PROJECT, session: SESSION, since: SINCE } },
    run(args, all) {
      const from = args.since ? sinceOf(args.since) : args.session ? 0 : Date.now() - 24 * 60 * MIN;
      const list = pick(all, args);
      if (!list.length) return none(all, args);
      // Per session: flags() says "failed 3 times" once per session, and each risky thing once.
      const found = list.flatMap((s) => flags(s.turns.flatMap((t) => t.steps)).filter((f) => f.level === 'warn' && f.step.at >= from).map((f) => ({ s, f })))
        .sort((a, b) => a.f.step.at - b.f.step.at);
      const title = titleOf(list, args);
      const since = from ? ` since ${when(from)}` : '';
      if (!found.length) return `Nothing risky from ${title}${since}.`;
      const command = (e) => (e.kind === 'run' ? ` (\`${clip(String(e.body?.command ?? e.title ?? '').replace(/\s+/g, ' ').trim(), 160)}\`)` : '');
      const shown = found.slice(-30);
      return [`${title}: ${plural(found.length, 'risky step')}${since}${shown.length < found.length ? ` (the last ${shown.length} below)` : ''}`,
        ...shown.map(({ s, f }) => `${when(f.step.at)} · ${named(s)}: ${f.text}${command(f.step)}`)].join('\n');
    },
  },
  handoff_note: {
    description: 'A hand-off note, so another agent (or a new session) can pick up where a session left off: the original ask and the last request, what was done with the evidence, the files it changed, how the tests stand (with the failure), what\'s left on its plan, what\'s risky and its last message. Markdown, ready to paste. Default: the newest session in this project.',
    inputSchema: { type: 'object', properties: { session: SESSION, project: PROJECT } },
    run(args, all) {
      const s = pick(all, args)[0];
      if (!s) return none(all, args);
      return handoffNote(s.entries, { session: s.id, cwd: s.cwd ?? undefined }); // paths from its folder
    },
  },
  check_my_work: {
    description: 'Call this before you tell the user your work is done. dotpals checks your own session in this project the way a reviewer would: did the tests run after your last change, did they pass (and why not), did you change the tests to make them pass, did anything fail and stay failing, did you do anything risky. It answers "Looks done" or says what to fix first. The evidence is what you actually ran, not what you remember.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { ...PROJECT, description: 'Only if dotpals can’t find your session: your project\'s folder path or name. Default: the folder this server runs in.' },
        session: { ...SESSION, description: 'Only if dotpals picks the wrong session: your session ID (or its first characters).' },
      },
    },
    async run(args, all, client) {
      const mine = pick(all, args);
      // Two agents in one project: the one asking (Claude Code, Codex…) checks its own session.
      const s = mine.find((x) => x.harness === client) ?? mine[0];
      if (!s) return none(all, args);
      const t = testState(s.entries);
      const line = testLine(s.entries)?.text;
      const of = `${named(s)}, session ${s.id}`;
      if (t?.state === 'running') return `Your tests are still running, as far as dotpals knows (${of}). Wait for them to finish, then call check_my_work again.`;
      const r = review(s);
      // Failing before this session changed anything (failingBefore): found, not caused, so not yours to fix.
      const old = t?.state === 'failing' && onlyOldFailures(t.last, s.entries);
      const oldNote = old ? `The failing tests (${nameList(testVerdict(t.last).facts?.failing ?? [])}) were failing before this session changed anything, so they aren’t yours to fix unless the user asks: tell the user about them.` : null;
      // No code changed in the session: only a failing or unclear test run is left to fix.
      let problems = r ? r.problems : t && t.state !== 'passing' && !old ? [line] : [];
      if (old) problems = problems.filter((p) => p !== 'Tests are failing' && !/failed and wasn’t fixed|still fails after/.test(p));
      const now = await gitNow(s);
      const notes = [oldNote, ...(now?.changed?.length ? [`Not committed yet (git): ${uncommitted(now)}${r ? '' : '. dotpals didn’t see this session make these changes: another session’s, or made in a way it can’t read'}.`] : [])].filter(Boolean);
      if (!problems.length) return [`Looks done (${of}): ${old ? 'for your part' : r ? 'tests passed after the last change, nothing risky' : 'no code changed that dotpals saw'}.${line ? ` ${line}.` : ''}`, ...notes].join('\n');
      // Green only because the tests were changed (readiness says so too): the fix is in the code.
      const faked = t?.state === 'passing' && weakenedTests(s.turns.flatMap((x) => x.steps));
      const next = t?.state === 'failing' ? 'Fix the failing tests, then run them again and call check_my_work again.'
        : t?.state === 'untested' || t?.state === 'stale' ? 'Run the tests, then call check_my_work again.'
          : t?.state === 'unclear' ? 'Run the tests again so their output shows how many passed and failed (no pipe), then call check_my_work again.'
            : faked ? 'Put the test back and fix the code, or tell the user why the test was wrong, then call check_my_work again.'
              : 'Fix these, or tell the user why they’re fine, then call check_my_work again.';
      return [`Not done yet (${of}):`, ...problems.map((p) => `✗ ${p}`), ...(line && r ? [line] : []), whyFailed(s.entries), ...notes, next].filter(Boolean).join('\n');
    },
  },
};

// -- JSON-RPC over stdio ---------------------------------------------------------------

const bad = (message) => Object.assign(new Error(message), { code: -32602 });
// Which agent is asking, from the client's name ("claude-code", "codex-mcp-client"…).
const harnessOf = (name) => ['claude', 'codex', 'cursor', 'gemini', 'opencode', 'copilot'].find((h) => String(name ?? '').toLowerCase().includes(h)) ?? '';

async function handle({ method, params }, client) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'dotpals', version },
        instructions: INSTRUCTIONS,
      };
    case 'ping': return {};
    case 'tools/list': return { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) };
    case 'tools/call': {
      const tool = Object.hasOwn(TOOLS, params?.name ?? '') ? TOOLS[params.name] : null;
      if (!tool) throw bad(`Unknown tool: ${params?.name}`);
      const args = {};
      for (const [k, v] of Object.entries(params.arguments ?? {})) {
        if (v == null || !tool.inputSchema.properties[k]) continue;
        if (!['string', 'number'].includes(typeof v)) throw bad(`${k} should be text`);
        args[k] = String(v).trim();
      }
      const all = await load();
      if (!all) return { content: [{ type: 'text', text: NOT_RUNNING }], isError: true };
      try {
        return { content: [{ type: 'text', text: await tool.run(args, all, client) }] };
      } catch (err) {
        if (err.code) throw err;
        return { content: [{ type: 'text', text: `dotpals couldn’t answer that: ${err.message}` }], isError: true };
      }
    }
    default: throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

/** Serve MCP on stdin and stdout until stdin closes. */
export function serve({ input = process.stdin, output = process.stdout } = {}) {
  console.log = console.error; // stdout is the protocol's
  const send = (msg) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  let client = '';
  // The client closes stdin to stop the server: answer what's in hand, then go (fetch's
  // open connection to the bridge would otherwise keep the process alive for a while).
  let pending = 0;
  let closed = false;
  const done = () => { if (closed && !pending) output.write('', () => process.exit(0)); };
  createInterface({ input, crlfDelay: Infinity }).on('close', () => { closed = true; done(); }).on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
    if (typeof msg?.method !== 'string') {
      if (msg && typeof msg === 'object' && ('result' in msg || 'error' in msg)) return; // a reply: this server asks nothing
      return send({ id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
    }
    if (msg.id === undefined) return; // a notification (initialized, cancelled…): no reply
    if (msg.method === 'initialize') client = harnessOf(msg.params?.clientInfo?.name);
    pending++;
    handle(msg, client).then((result) => send({ id: msg.id, result }), (err) => send({ id: msg.id, error: { code: err.code ?? -32603, message: err.message } }))
      .finally(() => { pending--; done(); });
  });
}
