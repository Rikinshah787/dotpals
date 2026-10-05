import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get, request } from 'node:http';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

// Keep the bridge away from the real home folder: no Codex watcher, no history file.
process.env.DOTPALS_CODEX = '0';
process.env.DOTPALS_CLAUDE_LOGS = '0';
process.env.DOTPALS_HISTORY = '0';
const home = await mkdtemp(join(tmpdir(), 'dotpals-home-'));
process.env.DOTPALS_HOME = home;
after(() => rm(home, { recursive: true, force: true }));

const { startBridge } = await import('../bridge/server.js');

/** A port no bridge in this file has used yet: fetch keeps connections alive, and reusing an old port could hand a test a dead one ("fetch failed"). */
const usedPorts = new Set();
// fetch refuses some ports outright ("bad port": 6000 X11, 6566, 6665-6669 IRC, 6679, 6697), like browsers do;
// 5985 and 5986 (WinRM) are reserved on Windows CI machines. A port Windows reserves gives EACCES: try another.
const BLOCKED = new Set([5985, 5986, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);
const freshPort = () => { let port; do port = 5190 + Math.floor(Math.random() * 2000); while (usedPorts.has(port) || BLOCKED.has(port)); usedPorts.add(port); return port; };

async function start() {
  for (let tries = 0; ; tries++) {
    const port = freshPort();
    try {
      return { port, server: await startBridge({ port, log: () => {} }) };
    } catch (err) {
      if (!['EADDRINUSE', 'EACCES'].includes(err.code) || tries > 10) throw err;
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

/** A POST to the bridge's API, with the header it needs. */
const api = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dotpals': '1' }, body: JSON.stringify(body) })
  .then(async (res) => ({ status: res.status, text: await res.text() }));

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
    port = freshPort();
    try { server = await startBridge({ port, log: () => {}, sleepAfter: 400, sleepAfterWaiting: 5000 }); } catch (err) { if (!['EADDRINUSE', 'EACCES'].includes(err.code) || tries > 10) throw err; }
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
  // Keep "busy" busy. Each request is tracked, so none is still in flight when the bridge
  // closes (one that was got its connection reset, an unhandled error: flaky in CI).
  const inflight = new Set();
  const keepBusy = setInterval(() => {
    const p = post(port, '/event', { session: 'busy', activity: { kind: 'read', title: 'a.js' } }).catch(() => {});
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  }, 100);
  await new Promise((r) => setTimeout(r, 1100));
  clearInterval(keepBusy);
  await Promise.all(inflight);
  const slept = updates.filter((u) => u.state === 'sleeping').map((u) => u.session);
  stream.destroy();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
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

test('settings never return the TypeSafe key: not from /api/config, /api/status or /events', async (t) => {
  delete process.env.TYPESAFE_API_KEY;
  const { port, server } = await start();
  t.after(async () => {
    await api(port, '/api/config', { checker: { mode: 'off', removeKey: true } });
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });
  const key = ['apikey', '0'.repeat(16), 'f'.repeat(16)].join('_'); // fake, built at run time so secret scanners don't flag it
  const saved = await api(port, '/api/config', { checker: { mode: 'cloud', jevKey: key } });
  assert.equal(saved.status, 200);
  assert.ok(!saved.text.includes(key));
  const { laya, health, ...checker } = JSON.parse(saved.text).checker;
  assert.deepEqual(checker, { mode: 'cloud', localUrl: 'http://127.0.0.1:8000', layaManaged: false, keySet: true, keyLast4: 'ffff', keyFrom: 'settings' });
  assert.ok(!JSON.stringify(health).includes(key)); // its health (working, failing, why) never carries the key
  assert.deepEqual([laya.installed, laya.running, laya.phase], [false, false, 'idle']);
  for (const path of ['/api/config', '/api/status']) {
    const text = await (await fetch(`http://127.0.0.1:${port}${path}`)).text();
    assert.ok(!text.includes(key), path);
    assert.ok(!text.includes('jevKey'), path);
  }
  const { events } = await readEvents(port, 300);
  assert.ok(!JSON.stringify(events).includes(key));
  // Saving an empty field keeps the key; something that can't be a key is refused.
  assert.equal(JSON.parse((await api(port, '/api/config', { checker: { jevKey: '' } })).text).checker.keySet, true);
  const bad = await api(port, '/api/config', { checker: { jevKey: 'not a key at all' } });
  assert.equal(bad.status, 400);
  // Changes need the header.
  const refused = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'POST', body: JSON.stringify({ checker: { removeKey: true } }) });
  assert.equal(refused.status, 403);
  assert.equal(JSON.parse((await api(port, '/api/config', { checker: { removeKey: true } })).text).checker.keySet, false);
});

test('an unclear test run is double-checked once by the local checker (a fake Laya), and every viewer sees it', async (t) => {
  const asked = [];
  const laya = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/health') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok","loaded":["english"]}');
      asked.push({ url: req.url, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: 'laya', answers: { 'done.met': { type: 'noul', noul: 0.91 } }, usage: { input_tokens: 10, output_tokens: 0 } }));
    });
  });
  await new Promise((r) => laya.listen(0, '127.0.0.1', r));
  const { port, server } = await start();
  t.after(async () => {
    await api(port, '/api/config', { checker: { mode: 'off', localUrl: 'http://127.0.0.1:8000' } });
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await new Promise((r) => laya.close(r));
  });
  await api(port, '/api/config', { checker: { mode: 'local', localUrl: `http://127.0.0.1:${laya.address().port}` } });
  const test = JSON.parse((await api(port, '/api/checker/test', { mode: 'local' })).text);
  assert.deepEqual([test.ok, test.by, test.model], [true, 'laya', 'english']);

  const output = 'collected 3 items\nme@example.com\nTraceback (most recent call last):\n  File "conftest.py"\nImportError: no module';
  await post(port, '/event', { session: 'chk', activity: { id: 't1', kind: 'run', title: 'pytest', status: 'ok', body: { command: 'pytest', output } } });
  // Clear results are never sent.
  await post(port, '/event', { session: 'chk', activity: { id: 't2', kind: 'run', title: 'pytest', status: 'ok', body: { command: 'pytest', output: '==== 3 passed in 0.1s ====' } } });
  for (let i = 0; i < 50 && !asked.length; i++) await new Promise((r) => setTimeout(r, 20));
  const { events } = await readEvents(port, 300);
  const entry = events.filter((e) => e.event === 'activity' && e.data.id === 'chk:t1').at(-1).data;
  assert.deepEqual([entry.check.by, entry.check.state, entry.check.p], ['laya', 'passed', 0.91]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].url, '/v1/systemone');
  assert.equal(asked[0].body.questions['done.met'].type, 'noul');
  assert.match(asked[0].body.state.evidence.output_end, /ImportError: no module/);
  assert.ok(!JSON.stringify(asked[0].body).includes('me@example.com'));
});

/**
 * Laya set up by dotpals, with a pretend install and server: `spawn` starts nothing real,
 * `fetch` answers Laya's /health while the pretend server runs.
 */
function fakeLaya(dir, { installed = true } = {}) {
  const spawned = [];
  const killed = [];
  let up = null;
  const win = process.platform === 'win32';
  const script = join(dir, '.venv', win ? 'Scripts' : 'bin', `laya-serve${win ? '.exe' : ''}`);
  if (installed) {
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, '');
    writeFileSync(join(dir, 'installed.json'), '{}');
  }
  const children = new Map();
  const options = {
    dir: () => dir,
    hookExit: false,
    pollMs: 5,
    portFree: async () => true,
    alive: (pid) => children.get(pid)?.alive === true,
    spawn: (cmd, args, opts) => {
      const child = new EventEmitter();
      Object.assign(child, { pid: 7000 + spawned.length, exitCode: null, signalCode: null, alive: true, unref() {} });
      spawned.push({ cmd, args, env: opts.env });
      children.set(child.pid, child);
      up = Number(opts.env.LAYA_PORT);
      return child;
    },
    fetch: async (href) => {
      const u = new URL(href);
      if (u.hostname !== '127.0.0.1' || Number(u.port) !== up) throw new TypeError('fetch failed');
      return { ok: true, json: async () => ({ status: 'ok' }) };
    },
    kill: async (pid) => {
      killed.push(pid);
      const child = children.get(pid);
      if (!child?.alive) return;
      child.alive = false;
      child.signalCode = 'SIGTERM';
      up = null;
      setImmediate(() => child.emit('exit', null));
    },
  };
  return { options, spawned, killed, isUp: () => up };
}

async function startWith(laya) {
  for (let tries = 0; ; tries++) {
    const port = freshPort();
    try { return { port, server: await startBridge({ port, log: () => {}, laya }) }; } catch (err) { if (!['EADDRINUSE', 'EACCES'].includes(err.code) || tries > 10) throw err; }
  }
}
const until = async (check) => { for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 20)); };
const getJson = async (port, path) => (await fetch(`http://127.0.0.1:${port}${path}`)).json();
const closeBridge = async (server) => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); };

test('Laya endpoints need the x-dotpals header, like every other change', async (t) => {
  const fake = fakeLaya(await mkdtemp(join(tmpdir(), 'dotpals-laya-')), { installed: false });
  const { port, server } = await startWith(fake.options);
  t.after(() => closeBridge(server));
  for (const action of ['setup', 'start', 'stop', 'uninstall']) {
    const res = await fetch(`http://127.0.0.1:${port}/api/checker/laya/${action}`, { method: 'POST' });
    assert.equal(res.status, 403, action);
    const fromSite = await fetch(`http://127.0.0.1:${port}/api/checker/laya/${action}`, { method: 'POST', headers: { origin: 'https://evil.example' } });
    assert.equal(fromSite.status, 403, action);
  }
  assert.equal(fake.spawned.length, 0);
  // Not set up: start says so.
  assert.equal((await api(port, '/api/checker/laya/start', {})).status, 400);
  // Its status is part of the settings.
  const config = await getJson(port, '/api/config');
  assert.deepEqual([config.checker.layaManaged, config.checker.laya.installed, config.checker.laya.running, config.checker.laya.phase], [false, false, false, 'idle']);
  assert.equal((await getJson(port, '/api/checker/laya')).installed, false);
});

test('Set up Laya: answers at once, runs it on 127.0.0.1, turns on Local, and every viewer sees the progress', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-laya-'));
  const fake = fakeLaya(dir);
  const { port, server } = await startWith(fake.options);
  t.after(async () => {
    await api(port, '/api/config', { checker: { mode: 'off', layaManaged: false, localUrl: 'http://127.0.0.1:8000' } });
    await closeBridge(server);
  });
  await api(port, '/api/config', { checker: { localUrl: 'http://localhost:9321' } }); // your own port: the managed server uses it
  const watching = readEvents(port, 3000); // long enough for a slow CI runner (Windows took 1.5 s)
  await new Promise((r) => setTimeout(r, 50));
  const res = await api(port, '/api/checker/laya/setup', {});
  assert.equal(res.status, 202);
  await until(async () => (await getJson(port, '/api/config')).checker.layaManaged);
  const config = await getJson(port, '/api/config');
  assert.deepEqual([config.checker.mode, config.checker.layaManaged, config.checker.localUrl], ['local', true, 'http://127.0.0.1:9321']);
  assert.deepEqual([config.checker.laya.running, config.checker.laya.phase, config.checker.laya.port], [true, 'ready', 9321]);
  assert.equal(fake.spawned.length, 1);
  assert.equal(fake.spawned[0].env.LAYA_HOST, '127.0.0.1');
  assert.equal(fake.spawned[0].env.LAYA_PORT, '9321');
  const { events } = await watching;
  const phases = events.filter((e) => e.event === 'laya').map((e) => e.data.phase);
  assert.ok(phases.includes('starting') && phases.at(-1) === 'ready', phases.join());
  assert.ok(events.some((e) => e.event === 'config' && e.data.checker.laya?.running === true));

  // Choosing another checker stops it; Local again starts it.
  await api(port, '/api/config', { checker: { mode: 'off' } });
  await until(() => fake.killed.length === 1);
  assert.equal((await getJson(port, '/api/checker/laya')).running, false);
  await api(port, '/api/config', { checker: { mode: 'local' } });
  await until(async () => (await getJson(port, '/api/checker/laya')).running);
  assert.equal(fake.spawned.length, 2);

  // Stop, then Remove: the folder goes, and the checker is turned off.
  const stopped = JSON.parse((await api(port, '/api/checker/laya/stop', {})).text);
  assert.deepEqual([stopped.ok, stopped.laya.running], [true, false]);
  assert.equal((await api(port, '/api/checker/laya/uninstall', {})).status, 200);
  assert.ok(!existsSync(dir));
  const removed = await getJson(port, '/api/config');
  assert.deepEqual([removed.checker.mode, removed.checker.layaManaged, removed.checker.laya.installed], ['off', false, false]);
});

test('the bridge starts Laya when the checker is on Local and dotpals set it up, and stops it when it closes', async () => {
  const fake = fakeLaya(await mkdtemp(join(tmpdir(), 'dotpals-laya-')));
  const first = await start();
  await api(first.port, '/api/config', { checker: { mode: 'local', layaManaged: true, localUrl: 'http://127.0.0.1:8000' } });
  await closeBridge(first.server);

  const { port, server } = await startWith(fake.options);
  await until(() => fake.isUp() === 8000);
  assert.equal(fake.spawned.length, 1);
  await until(async () => (await getJson(port, '/api/checker/laya')).running);
  assert.equal((await getJson(port, '/api/checker/laya')).running, true);
  await closeBridge(server);
  await until(() => fake.killed.length === 1);
  assert.equal(fake.isUp(), null);
  // Leave the shared settings as the other tests expect them.
  const last = await start();
  await api(last.port, '/api/config', { checker: { mode: 'off', layaManaged: false } });
  await closeBridge(last.server);
});

test('"Install it" (the TypeSafe SDK) needs the header and runs one install at a time', async () => {
  let runs = 0;
  let port;
  let server;
  for (let tries = 0; ; tries++) {
    port = freshPort();
    try { server = await startBridge({ port, log: () => {}, installSdk: async () => { runs++; await new Promise((r) => setTimeout(r, 50)); return { ok: true }; } }); break; } catch (err) { if (!['EADDRINUSE', 'EACCES'].includes(err.code) || tries > 10) throw err; }
  }
  try {
    assert.equal((await post(port, '/api/checker/jev/install', {})).status, 403); // no header
    const [a, b] = await Promise.all([api(port, '/api/checker/jev/install', {}), api(port, '/api/checker/jev/install', {})]);
    assert.deepEqual([a.status, JSON.parse(a.text), JSON.parse(b.text)], [200, { ok: true }, { ok: true }]);
    assert.equal(runs, 1);
  } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
});

test('the checker’s health: a heartbeat when the setting changes, the reason when it fails, cleared when off', async () => {
  const { port, server } = await start();
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    await api(port, '/api/config', { checker: { mode: 'cloud', removeKey: true } }); // no key: Jev can't answer
    let health;
    await until(async () => (health = (await getJson(port, '/api/config')).checker.health).state === 'failing');
    assert.equal(health.by, 'jev');
    assert.match(health.error, /no API key/);
    assert.ok(health.failingSince <= Date.now());
    await api(port, '/api/config', { checker: { mode: 'off' } });
    await until(async () => (health = (await getJson(port, '/api/config')).checker.health).by === null);
    assert.equal(health.state, 'unknown');
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    await closeBridge(server);
  }
});

test('a live request gets what git saw changed, also by commands, on its done entry', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const repo = await mkdtemp(join(tmpdir(), 'dotpals-repo-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(repo, 'a.js'), 'a\n');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'start');
  git('checkout', '-q', '-b', 'feat/rename');
  const { port, server } = await start();
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await rm(repo, { recursive: true, force: true });
  });
  const base = { session: 'git-session', harness: 'my-agent', cwd: repo };
  await post(port, '/event', { ...base, activity: { id: 'p1', kind: 'prompt', title: 'Rename x to y', status: 'info', at: Date.now() } });
  await new Promise((r) => setTimeout(r, 400)); // the "before" snapshot
  writeFileSync(join(repo, 'a.js'), 'a, changed by sed\n');
  writeFileSync(join(repo, 'b.js'), 'b\n');
  await post(port, '/event', { ...base, activity: { id: 'd1', kind: 'done', title: 'Finished', status: 'ok', at: Date.now() } });
  let entry;
  for (let i = 0; i < 40 && !entry?.git; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const res = await fetch(`http://127.0.0.1:${port}/api/activity`);
    const body = await res.json();
    entry = (Array.isArray(body) ? body : body.entries ?? []).find((e) => e.id === 'd1' || e.id?.endsWith(':d1'));
  }
  assert.deepEqual(entry?.git?.files, [{ path: 'a.js', change: 'edit' }, { path: 'b.js', change: 'write' }]);
  assert.equal(entry.git.committed, false);
  assert.deepEqual(entry.git.others, []);
  assert.equal(entry.git.branch, 'feat/rename'); // where the request ended, for "is branch X ready?"
  assert.match(entry.git.head, /^[0-9a-f]{7}$/);
  // Where each session works, for dotpals mcp. Read-only: a GET, no header needed.
  const { sessions } = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json();
  assert.deepEqual(sessions, [{ id: 'git-session', cwd: repo, parent: null, label: basename(repo), harness: 'my-agent' }]);
});

test('generic /event: malformed files are dropped, so a trimmed session never throws (from review)', async (t) => {
  const { port, server } = await start();
  t.after(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); });
  const base = { session: 'bad-files', harness: 'my-agent' };
  await post(port, '/event', { ...base, activity: { id: 'f1', kind: 'edit', title: 'x', status: 'ok', files: { path: 'not-a-list' } } });
  await post(port, '/event', { ...base, activity: { id: 'f2', kind: 'edit', title: 'y', status: 'ok', files: [null, 7, { change: 'edit' }, { path: 'src/ok.js', change: 'bogus' }] } });
  const res = await post(port, '/event', { ...base, activity: { id: 'f3', kind: 'read', title: 'z', status: 'ok', files: [{ path: 'src/ok.js', change: 'read' }] } });
  assert.equal(res.status, 200);
  const body = await (await fetch(`http://127.0.0.1:${port}/api/activity`)).json();
  const mine = body.entries.filter((e) => e.session === 'bad-files');
  assert.equal(mine.length, 3);
  assert.equal(mine.find((e) => e.id.endsWith(':f1')).files, undefined);
  assert.deepEqual(mine.find((e) => e.id.endsWith(':f2')).files, [{ path: 'src/ok.js', change: 'edit' }]);
});

test('POST /api/app/quit asks the desktop app to quit (header required; 409 when there is no app)', async (t) => {
  let quits = 0;
  const port = freshPort();
  const server = await startBridge({ port, log: () => {}, onQuit: () => { quits++; } });
  t.after(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); });
  assert.equal((await post(port, '/api/app/quit', {})).status, 403); // no x-dotpals header
  const res = await fetch(`http://127.0.0.1:${port}/api/app/quit`, { method: 'POST', headers: { 'x-dotpals': '1' } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(quits, 1);
  const bare = await startBridge({ port: freshPort(), log: () => {} });
  t.after(async () => { bare.closeAllConnections?.(); await new Promise((r) => bare.close(r)); });
  const r2 = await fetch(`http://127.0.0.1:${bare.address().port}/api/app/quit`, { method: 'POST', headers: { 'x-dotpals': '1' } });
  assert.equal(r2.status, 409);
});

for (const [name, args] of [['node bridge/server.js', ['bridge/server.js']], ['dotpals bridge', ['bin/dotpals.js', 'bridge']]]) {
  test(`${name}, run on its own, quits when setup asks (so the pal can take over)`, async (t) => {
    const { spawn } = await import('node:child_process');
    const port = freshPort();
    const child = spawn(process.execPath, args, { cwd: join(import.meta.dirname, '..'), env: { ...process.env, DOTPALS_PORT: String(port) }, stdio: 'ignore' });
    const exited = new Promise((r) => child.once('exit', (code) => r(code)));
    t.after(() => child.kill());
    let res;
    for (let i = 0; i < 40 && !res; i++) {
      await new Promise((r) => setTimeout(r, 150));
      res = await fetch(`http://127.0.0.1:${port}/api/app/quit`, { method: 'POST', headers: { 'x-dotpals': '1' } }).catch(() => null);
    }
    assert.equal(res?.status, 200);
    assert.equal(await exited, 0);
  });
}

test('/api/status says whether the desktop pal and notch follow the events (for dotpals doctor)', async (t) => {
  const { port, server } = await start();
  t.after(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); });
  const desktop = async () => (await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()).desktop;
  const follow = (path) => new Promise((ok) => get({ host: '127.0.0.1', port, path }, ok));
  assert.deepEqual(await desktop(), { pal: false, notch: false });
  const browser = await follow('/events');
  const pal = await follow('/events?answers=1&window=pal');
  assert.deepEqual(await desktop(), { pal: true, notch: false });
  const notch = await follow('/events?answers=1&window=notch');
  assert.deepEqual(await desktop(), { pal: true, notch: true });
  pal.destroy();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(await desktop(), { pal: false, notch: true });
  notch.destroy();
  browser.destroy();
});
