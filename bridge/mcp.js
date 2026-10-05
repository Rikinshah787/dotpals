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
// reads it with the rules the pal and the notch use (ui/story.js, ui/recap.js), so the
// answers match what they show. With no bridge running, a tool says how to start it.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { clip, folderName } from './activity.js';
import { baseName, facts, harnessName, plural, sentence, shortTime, startOfDay, summarizeSessions } from './ui/recap.js';
import { readiness, simple, testLine, testState, whyStopped } from './ui/story.js';

const version = (() => { try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return '0.0.0'; } })();
// Like the hooks (guard-hook.js): not PORT, which the assistant's own environment may set for an app.
const bridge = process.env.DOTPALS_BRIDGE || `http://127.0.0.1:${Number(process.env.DOTPALS_PORT) || 5175}`;
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']; // the first is the one we answer with when the client's is unknown
const MIN = 60_000;
const NOT_RUNNING = 'dotpals isn’t running. Start it with `npx dotpals start` (or open the pal).';
const INSTRUCTIONS = 'dotpals watches the coding agents on this computer (Claude Code, Codex, Cursor and others) and checks what they really did: files changed, commands run, and test results read from the test output, not from what the agent said. Before you tell the user your work is done, call check_my_work. Use agents_now, recap, test_status and ready_to_merge to answer questions about what agents did.';

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
 * prompt) is still going, within the hour.
 */
async function load() {
  let entries;
  try {
    ({ entries } = await (await fetch(`${bridge}/api/activity`, { signal: AbortSignal.timeout(3000) })).json());
  } catch { return null; }
  if (!Array.isArray(entries)) return null;
  const now = Date.now();
  return summarizeSessions(entries).map((s) => {
    const turns = s.turns.filter((t) => t.prompt || t.steps.length);
    const turn = turns.at(-1);
    if (!turn) return null;
    const live = !turn.end && (now - s.last < 5 * MIN || (turn.steps.some(running) && now - s.last < 60 * MIN));
    const waiting = live && turn.steps.some((e) => e.status === 'waiting');
    return { ...s, turns, turn, live, waiting, why: whyStopped(turn, { live, waiting }) };
  }).filter(Boolean);
}

/** "Claude Code in shop: finished 3 min ago (session 1f2e…)", with why it stopped when that's news. */
function header(s) {
  const state = s.live ? (s.waiting ? 'waiting for you' : 'working')
    : `${s.turn.end?.kind === 'done' ? 'finished' : 'stopped'} ${ago(s.last)}${s.why && s.why.kind !== 'done' ? `: ${s.why.text}` : ''}`;
  return `${named(s)}: ${state} (session ${s.id})`;
}

/** The sessions `session` (an ID or its start) or else `project` (a folder name or path; default: the folder this server runs in) pick, newest first. */
function pick(all, { project, session } = {}) {
  if (session) return all.filter((s) => String(s.id).startsWith(session));
  const name = String(folderName(project || process.cwd()) ?? '').toLowerCase();
  return all.filter((s) => String(s.label ?? '').toLowerCase() === name);
}

/** When nothing matched: which projects dotpals does know, so the assistant can ask again. */
function none(all, { project, session } = {}) {
  if (session) return `dotpals has no session ${session}. agents_now lists the recent ones.`;
  const known = [...new Set(all.map((s) => s.label).filter(Boolean))].slice(0, 8);
  return `dotpals has seen no agent working in ${folderName(project || process.cwd())}.${known.length ? ` Projects it knows: ${known.join(', ')}. Pass one as \`project\`.` : ''}`;
}

/**
 * Is the code as the session left it ready? readiness() judges one finished request; here
 * the whole session counts (tests run in a later request cover an earlier change), and a
 * request still going is judged as if it stopped now (check_my_work asks in the middle).
 */
const review = (s) => readiness({ ...s.turn, steps: s.turns.flatMap((t) => t.steps), end: { ...s.turn.end, kind: 'done' } });

/** `since`: minutes ago ("90") or a time ("2026-10-04T09:00"). */
function sinceOf(v) {
  const at = /^\s*\d+(\.\d+)?\s*$/.test(v) ? Date.now() - Number(v) * MIN : Date.parse(v);
  if (Number.isNaN(at)) throw bad('since: give minutes ("90") or a time ("2026-10-04T09:00")');
  return at;
}

// -- the tools -------------------------------------------------------------------------

const PROJECT = { type: 'string', description: 'The project: its folder name or path. Default: the folder this server runs in.' };
const SESSION = { type: 'string', description: 'A session ID from agents_now (or its first characters). Default: the newest session in the project.' };
const ONLY_THEIRS = 'Only tests an agent ran count: dotpals can’t see the ones you run yourself, or CI.';

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
        else { const r = simple(s.turn, { live: false }); lines.push(`  Result: ${r.text}`, ...r.warnings.map((w) => `  ⚠ ${w}`)); }
        const tests = testLine(s.entries);
        if (tests) lines.push(`  ${tests.text}`);
        return lines.join('\n');
      }), ...(recent.length > 10 ? [`and ${plural(recent.length - 10, 'older session')}`] : [])].join('\n\n');
    },
  },
  test_status: {
    description: 'Is the code really tested? How the tests stand in an agent session, from the test runs dotpals saw: passed or failed (read from the test output, with the counts), when, and whether code changed after the last run (stale) or was never tested. Only tests an agent ran count. Default: the newest session in this project.',
    inputSchema: { type: 'object', properties: { project: PROJECT, session: SESSION } },
    run(args, all) {
      const s = pick(all, args)[0];
      if (!s) return none(all, args);
      return `${header(s)}\n${testLine(s.entries)?.text ?? 'No code changed and no tests ran in this session.'}`;
    },
  },
  ready_to_merge: {
    description: 'Is an agent session\'s work ready to merge? The checks a reviewer would make, each ✓ or ✗: tests ran, after the last change, and passed; no failure left behind; nothing risky (force pushes, .env changes, recursive deletes…); the commit was tested. Default: the newest session in this project.',
    inputSchema: { type: 'object', properties: { project: PROJECT, session: SESSION } },
    run(args, all) {
      const s = pick(all, args)[0];
      if (!s) return none(all, args);
      if (s.live) return [header(s), 'Still working: ask again when it finishes.', testLine(s.entries)?.text].filter(Boolean).join('\n');
      const r = review(s);
      if (!r) return `${header(s)}\nNothing changed yet: no code changed in this session.`;
      return [header(s), r.ready ? '✅ Ready to merge' : '⚠ Not ready to merge', ...r.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.text}`), ONLY_THEIRS].join('\n');
    },
  },
  recap: {
    description: 'What agents actually did, request by request: what each was asked, one plain sentence on what it did (files changed, how the tests went, what it shipped), warnings worth a look, and the files it changed. For a project (default: this one, the last 24 hours) or one session (all of it).',
    inputSchema: { type: 'object', properties: { project: PROJECT, session: SESSION, since: { type: 'string', description: 'Only work since then: minutes ago ("90") or a time ("2026-10-04T09:00").' } } },
    run(args, all) {
      const from = args.since ? sinceOf(args.since) : args.session ? 0 : Date.now() - 24 * 60 * MIN;
      const list = pick(all, args);
      if (!list.length) return none(all, args);
      const turns = list.flatMap((s) => s.turns.filter((t) => lastAt(t) >= from).map((t) => ({ s, t }))).sort((a, b) => a.t.at - b.t.at);
      const title = args.session ? named(list[0]) : list[0].label;
      if (!turns.length) return `Nothing from ${title} since ${when(from)}.`;
      const shown = turns.slice(-20);
      return [`${title}: ${plural(turns.length, 'request')}${from ? ` since ${when(from)}` : ''}${shown.length < turns.length ? ` (the last ${shown.length} below)` : ''}`, ...shown.map(({ s, t }) => {
        const r = simple(t, { live: s.live && t === s.turn });
        const f = facts(t.steps);
        const files = [...f.changed, ...f.wrote, ...f.deleted].map((x) => baseName(x.path));
        return [
          `${when(t.at)} · ${named(s)}: ${asked(t)}`,
          `  ${r.text}`,
          ...r.warnings.map((w) => `  ⚠ ${w}`),
          ...(files.length ? [`  Files: ${files.slice(0, 8).join(', ')}${files.length > 8 ? ` +${files.length - 8} more` : ''}`] : []),
        ].join('\n');
      })].join('\n\n');
    },
  },
  check_my_work: {
    description: 'Call this before you tell the user your work is done. dotpals checks your own session in this project the way a reviewer would: did the tests run after your last change, did they pass, did anything fail and stay failing, did you do anything risky. It answers "Looks done" or says what to fix first. The evidence is what you actually ran, not what you remember.',
    inputSchema: { type: 'object', properties: { project: { ...PROJECT, description: 'Only if dotpals can’t find your session: your project\'s folder name or path. Default: the folder this server runs in.' } } },
    run(args, all, client) {
      const mine = pick(all, { project: args.project });
      // Two agents in one project: the one asking (Claude Code, Codex…) checks its own session.
      const s = mine.find((x) => x.harness === client) ?? mine[0];
      if (!s) return none(all, { project: args.project });
      const t = testState(s.entries);
      const line = testLine(s.entries)?.text;
      const of = `${named(s)}, session ${s.id}`;
      if (t?.state === 'running') return `Your tests are still running, as far as dotpals knows (${of}). Wait for them to finish, then call check_my_work again.`;
      const r = review(s);
      // No code changed in the session: only a failing or unclear test run is left to fix.
      const problems = r ? r.problems : t && t.state !== 'passing' ? [line] : [];
      if (!problems.length) return `Looks done (${of}): ${r ? 'tests passed after the last change, nothing risky' : 'no code changed'}.${line ? ` ${line}.` : ''}`;
      const next = t?.state === 'failing' ? 'Fix the failing tests, then run them again and call check_my_work again.'
        : t?.state === 'untested' || t?.state === 'stale' ? 'Run the tests, then call check_my_work again.'
          : t?.state === 'unclear' ? 'Run the tests again so their output shows how many passed and failed (no pipe), then call check_my_work again.'
            : 'Fix these, or tell the user why they’re fine, then call check_my_work again.';
      return [`Not done yet (${of}):`, ...problems.map((p) => `✗ ${p}`), ...(line && r ? [line] : []), next].join('\n');
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
        return { content: [{ type: 'text', text: tool.run(args, all, client) }] };
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
