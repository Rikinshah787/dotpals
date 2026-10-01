import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { get, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep the bridge away from the real home folder: no Codex watcher, no history file.
process.env.DOTPALS_CODEX = '0';
process.env.DOTPALS_CLAUDE_LOGS = '0';
process.env.DOTPALS_HISTORY = '0';
const home = await mkdtemp(join(tmpdir(), 'dotpals-home-'));
process.env.DOTPALS_HOME = home;
after(() => rm(home, { recursive: true, force: true }));

const { startBridge } = await import('../bridge/server.js');

async function start() {
  for (let tries = 0; ; tries++) {
    const port = 5190 + Math.floor(Math.random() * 2000);
    try {
      return { port, server: await startBridge({ port, log: () => {} }) };
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || tries > 10) throw err;
    }
  }
}

function post(port, path, body) {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => ok({ status: res.statusCode, text }));
    });
    req.on('error', fail);
    req.end(JSON.stringify(body));
  });
}

/** Read the SSE stream for up to `ms`, returning the parsed events. */
function readEvents(port, ms = 500) {
  return new Promise((ok, fail) => {
    const req = get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      setTimeout(() => {
        req.destroy();
        const events = text.split('\n\n').filter(Boolean).map((chunk) => {
          const event = /^event: (.+)$/m.exec(chunk)?.[1] ?? 'message';
          const data = /^data: (.+)$/m.exec(chunk)?.[1];
          return { event, data: data ? JSON.parse(data) : null };
        }).filter((e) => e.data);
        ok({ status: res.statusCode, type: res.headers['content-type'], events });
      }, ms);
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? null : fail(err)));
  });
}

test('a web page from another site cannot post events', async () => {
  const { port, server } = await start();
  const res = await fetch(`http://127.0.0.1:${port}/event`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: JSON.stringify({ session: 'x', state: 'working' }) });
  assert.equal(res.status, 403);
  const ok = await fetch(`http://127.0.0.1:${port}/event`, { method: 'POST', body: JSON.stringify({ session: 'x', state: 'working' }) });
  assert.equal(ok.status, 200);
  server.close();
});

test('generic /event: a follow-up with the same id merges into the entry', async (t) => {
  const { port, server } = await start();
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });

  const first = await post(port, '/event', {
    session: 'test-session', harness: 'my-agent', label: 'proj', state: 'working', text: 'Running tests',
    activity: { id: 'a1', kind: 'run', title: 'npm test', status: 'running', body: { command: 'npm test' } },
  });
  assert.equal(first.status, 200);
  assert.equal(first.text, '{}');

  await post(port, '/event', { session: 'test-session', activity: [{ id: 'a1', status: 'ok', body: { output: '12 passing' } }] });

  const { status, type, events } = await readEvents(port, 500);
  assert.equal(status, 200);
  assert.match(type, /text\/event-stream/);

  const activity = events.filter((e) => e.event === 'activity').map((e) => e.data);
  assert.equal(activity.length, 1);
  const [entry] = activity;
  assert.equal(entry.id, 'test-session:a1');
  assert.equal(entry.session, 'test-session');
  assert.equal(entry.harness, 'my-agent');
  assert.equal(entry.label, 'proj');
  assert.equal(entry.kind, 'run');
  assert.equal(entry.title, 'npm test');
  assert.equal(entry.status, 'ok');
  assert.deepEqual(entry.body, { command: 'npm test', output: '12 passing' });

  const state = events.find((e) => e.event === 'message' && e.data.session === 'test-session');
  assert.ok(state, 'the pal state is replayed');
  assert.equal(state.data.state, 'working');
  assert.equal(state.data.text, 'Running tests');
});

test('serves the pal page and refuses paths outside src/ and bridge/', async (t) => {
  const { port, server } = await start();
  t.after(() => new Promise((r) => server.close(r)));

  const status = (path) => new Promise((ok, fail) => {
    get({ host: '127.0.0.1', port, path }, (res) => { res.resume(); ok(res.statusCode); }).on('error', fail);
  });
  assert.equal(await status('/'), 200);
  assert.equal(await status('/package.json'), 404);
  assert.equal(await status('/bridge/../package.json'), 404);
});

test('a session that goes quiet is put to sleep by the bridge; an active one is not', async () => {
  let server;
  let port;
  for (let tries = 0; !server; tries++) {
    port = 5190 + Math.floor(Math.random() * 2000);
    try { server = await startBridge({ port, log: () => {}, sleepAfter: 400, sleepAfterWaiting: 5000 }); } catch (err) { if (err.code !== 'EADDRINUSE' || tries > 10) throw err; }
  }
  const updates = [];
  const stream = await new Promise((ok) => get({ host: '127.0.0.1', port, path: '/events' }, ok));
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    for (const block of chunk.split('\n\n')) {
      if (block.startsWith('data:')) updates.push(JSON.parse(block.slice(5)));
    }
  });
  await post(port, '/event', { session: 'quiet', harness: 'x', state: 'done' });
  await post(port, '/event', { session: 'asking', harness: 'x', state: 'waiting' });
  await post(port, '/event', { session: 'busy', harness: 'x', state: 'working' });
  const keepBusy = setInterval(() => post(port, '/event', { session: 'busy', activity: { kind: 'read', title: 'a.js' } }), 100);
  await new Promise((r) => setTimeout(r, 1100));
  clearInterval(keepBusy);
  const slept = updates.filter((u) => u.state === 'sleeping').map((u) => u.session);
  stream.destroy();
  server.close();
  assert.deepEqual(slept, ['quiet']);
});

test('approve from the pal: off answers at once; on waits for Allow or Deny', async () => {
  const { port, server } = await start();
  const base = `http://127.0.0.1:${port}`;
  const ask = (command) => fetch(`${base}/hook`, { method: 'POST', body: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'appr', cwd: '/work/app', tool_name: 'Bash', tool_input: { command } }) }).then((r) => r.json());
  const setConfig = (patch) => fetch(`${base}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dotpals': '1' }, body: JSON.stringify(patch) });

  // Off (the default): no waiting, no decision.
  assert.deepEqual(await ask('npm install'), {});

  await setConfig({ approvals: true });
  // On, but nothing is open to answer from: still no waiting.
  assert.deepEqual(await ask('npm install'), {});

  // On, with only the dashboard open (it can't show approval cards): still no waiting.
  const dashboard = await new Promise((ok) => get({ host: '127.0.0.1', port, path: '/events' }, ok));
  assert.deepEqual(await ask('npm install'), {});
  dashboard.destroy();

  // On, with a pal or the notch open: the request shows up there, and the answer goes back to Claude.
  const approvals = [];
  const stream = await new Promise((ok) => get({ host: '127.0.0.1', port, path: '/events?answers=1' }, ok));
  stream.setEncoding('utf8');
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk;
    for (const block of buffer.split('\n\n').slice(0, -1)) {
      if (block.startsWith('event: approval')) approvals.push(JSON.parse(block.split('\ndata: ')[1]));
    }
    buffer = buffer.split('\n\n').at(-1);
  });
  const waitFor = async (test) => { for (let i = 0; i < 50 && !test(); i++) await new Promise((r) => setTimeout(r, 20)); };

  const allowed = ask('git push --force origin main');
  await waitFor(() => approvals.some((a) => a.status === 'pending'));
  const pending = approvals.find((a) => a.status === 'pending');
  assert.equal(pending.tool, 'Bash');
  assert.equal(pending.command, 'git push --force origin main');
  assert.ok(pending.risks.some((r) => /force-pushes/i.test(r)));
  // Only with the dotpals header (other websites can't send it).
  assert.equal((await fetch(`${base}/api/approvals/${pending.id}`, { method: 'POST', body: '{"decision":"allow"}' })).status, 403);
  assert.equal((await fetch(`${base}/api/approvals/${pending.id}`, { method: 'POST', headers: { 'x-dotpals': '1' }, body: '{"decision":"allow"}' })).status, 200);
  assert.deepEqual(await allowed, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });

  const denied = ask('rm -rf build');
  await waitFor(() => approvals.filter((a) => a.status === 'pending').length === 2);
  const second = approvals.filter((a) => a.status === 'pending').at(-1);
  await fetch(`${base}/api/approvals/${second.id}`, { method: 'POST', headers: { 'x-dotpals': '1' }, body: '{"decision":"deny"}' });
  assert.equal((await denied).hookSpecificOutput.decision.behavior, 'deny');
  // Answered requests can't be answered again.
  assert.equal((await fetch(`${base}/api/approvals/${second.id}`, { method: 'POST', headers: { 'x-dotpals': '1' }, body: '{"decision":"allow"}' })).status, 404);

  await setConfig({ approvals: false });
  stream.destroy();
  server.close();
});

test('dismissing a session puts its pal to sleep; new activity brings it back', async () => {
  const { port, server } = await start();
  const base = `http://127.0.0.1:${port}`;
  const states = [];
  const stream = await new Promise((ok) => get({ host: '127.0.0.1', port, path: '/events' }, ok));
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => { for (const b of chunk.split('\n\n')) if (b.startsWith('data:')) states.push(JSON.parse(b.slice(5))); });
  await post(port, '/event', { session: 'stale', harness: 'codex', state: 'thinking' });
  assert.equal((await fetch(`${base}/api/sessions/stale/dismiss`, { method: 'POST' })).status, 403); // needs the dotpals header
  const res = await fetch(`${base}/api/sessions/stale/dismiss`, { method: 'POST', headers: { 'x-dotpals': '1' } });
  assert.deepEqual(await res.json(), { ok: true, wasActive: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(states.filter((u) => u.session === 'stale').at(-1).state, 'sleeping');
  await post(port, '/event', { session: 'stale', harness: 'codex', state: 'working' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(states.filter((u) => u.session === 'stale').at(-1).state, 'working');
  stream.destroy();
  server.close();
});

test('share with your agents: the context hook tells a Claude session what the others did', async (t) => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { port, server } = await start();
  // The hook runs as a child process, which can take seconds on a busy CI machine; keep
  // idle connections open meanwhile, so the test's own fetches don't hit a closed socket.
  server.keepAliveTimeout = 60_000;
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const runHook = (event) => new Promise((ok) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bridge/context-hook.js', import.meta.url))], { env: { ...process.env, DOTPALS_BRIDGE: base } });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('exit', () => ok(out));
    child.stdin.end(JSON.stringify({ session_id: 'mine', cwd: String.raw`C:\code\shop`, ...event }));
  });
  const codexEdit = (file) => post(port, '/event', { session: 'codex-9999', harness: 'codex', label: 'shop', state: 'working', activity: { kind: 'edit', title: file, files: [{ path: `C:/code/shop/${file}`, change: 'edit' }] } });

  await codexEdit('api/login.ts');
  // Off by default: nothing is added.
  assert.equal(await runHook({ hook_event_name: 'SessionStart', source: 'startup' }), '');

  await fetch(`${base}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dotpals': '1' }, body: JSON.stringify({ shareRecap: true }) });
  const start1 = JSON.parse(await runHook({ hook_event_name: 'SessionStart', source: 'startup' }));
  assert.equal(start1.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(start1.hookSpecificOutput.additionalContext, /Codex \(session 9999, working now\): changed api\/login\.ts/);
  // Nothing new since: the next prompt gets nothing.
  assert.equal(await runHook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }), '');
  // News: another change by Codex.
  await new Promise((r) => setTimeout(r, 10));
  await codexEdit('api/routes.ts');
  const prompt = JSON.parse(await runHook({ hook_event_name: 'UserPromptSubmit', prompt: 'next' }));
  assert.match(prompt.hookSpecificOutput.additionalContext, /routes\.ts/);

  await fetch(`${base}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dotpals': '1' }, body: JSON.stringify({ shareRecap: false }) });
  server.close();
});

test('helpers: Claude subagents and any agent\'s helpers, live', async (t) => {
  const { port, server } = await start();
  t.after(() => server.close());
  const seen = [];
  const stream = await new Promise((ok) => get({ host: '127.0.0.1', port, path: '/events' }, ok));
  t.after(() => stream.destroy());
  stream.setEncoding('utf8');
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk;
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop();
    for (const b of blocks) if (b.startsWith('event: helpers')) seen.push(JSON.parse(b.split('\ndata: ')[1]));
  });
  const last = (session) => seen.filter((x) => x.session === session).at(-1)?.helpers ?? [];
  const settle = () => new Promise((r) => setTimeout(r, 150));
  const hook = (e) => post(port, '/hook', { session_id: 'lead', cwd: '/work/app', ...e });

  // Claude starts a background helper: the Agent tool call returns at once, the helper keeps going.
  await hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'tu1', tool_input: { description: 'Find the auth code', subagent_type: 'Explore', prompt: 'look' } });
  await hook({ hook_event_name: 'SubagentStart', agent_id: 'ag1', agent_type: 'Explore' });
  await hook({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'tu1', tool_input: {}, tool_response: 'launched' });
  await hook({ hook_event_name: 'PreToolUse', agent_id: 'ag1', agent_type: 'Explore', tool_name: 'Read', tool_use_id: 'tu2', tool_input: { file_path: '/work/app/src/auth.js' } });
  await settle();
  let h = last('lead');
  assert.equal(h.length, 1);
  assert.equal(h[0].name, 'Explore');
  assert.equal(h[0].task, 'Find the auth code');
  assert.equal(h[0].status, 'running'); // still running, though its tool call returned
  assert.equal(h[0].doing, 'Reading src/auth.js');
  await hook({ hook_event_name: 'SubagentStop', agent_id: 'ag1', agent_type: 'Explore' });
  await settle();
  h = last('lead');
  assert.equal(h[0].status, 'done');

  // Any agent: the generic event format.
  await post(port, '/event', { session: 'mine', harness: 'my-agent', helper: { id: 'w1', name: 'tester', task: 'Run the e2e suite', state: 'working', text: 'Running playwright' } });
  await settle();
  assert.deepEqual(last('mine').map((x) => [x.name, x.task, x.status, x.doing]), [['tester', 'Run the e2e suite', 'running', 'Running playwright']]);
  await post(port, '/event', { session: 'mine', helper: { id: 'w1', state: 'done' } });
  await settle();
  assert.equal(last('mine')[0].status, 'done');
});
