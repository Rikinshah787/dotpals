import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep the bridge and every agent's config inside a temp folder.
process.env.DOTPALS_CODEX = '0';
process.env.DOTPALS_CLAUDE_LOGS = '0';
process.env.DOTPALS_HISTORY = '0';
const tmp = await mkdtemp(join(tmpdir(), 'dotpals-agents-'));
process.env.DOTPALS_HOME = join(tmp, 'home');
process.env.DOTPALS_CURSOR_DIR = join(tmp, 'cursor');
process.env.DOTPALS_GEMINI_DIR = join(tmp, 'gemini');
process.env.DOTPALS_OPENCODE_DIR = join(tmp, 'opencode');
process.env.DOTPALS_COPILOT_DIR = join(tmp, 'copilot');
after(() => rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

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

function call(port, method, path, body, headers = {}) {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} ok({ status: res.statusCode, json }); });
    });
    req.on('error', fail);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const ours = { 'x-dotpals': '1' };

test('agents API: list, connect, test through the real hook, switch off, disconnect', async (t) => {
  const { port, server } = await start();
  t.after(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); });

  const list = await call(port, 'GET', '/api/agents');
  assert.equal(list.status, 200);
  const ids = list.json.agents.map((a) => a.id);
  for (const id of ['claude', 'codex', 'cursor', 'gemini', 'opencode', 'copilot', 'generic']) assert.ok(ids.includes(id), id);
  const cursor = list.json.agents.find((a) => a.id === 'cursor');
  assert.equal(cursor.setup, 'connect');
  assert.equal(cursor.connected, false);
  assert.equal(cursor.enabled, true);

  // Changes need the header, like every other change.
  assert.equal((await call(port, 'POST', '/api/agents/cursor/connect', {})).status, 403);
  assert.equal((await call(port, 'POST', '/api/agents/cursor/connect', {}, { ...ours, host: 'evil.example' })).status, 421);
  assert.equal((await call(port, 'POST', '/api/agents/nope/connect', {}, ours)).status, 404);
  assert.equal((await call(port, 'POST', '/api/agents/codex/connect', {}, ours)).status, 400);

  const connected = await call(port, 'POST', '/api/agents/cursor/connect', {}, ours);
  assert.equal(connected.status, 200, JSON.stringify(connected.json));
  assert.equal(connected.json.agent.connected, true);
  const hooks = JSON.parse(await readFile(join(tmp, 'cursor', 'hooks.json'), 'utf8'));
  assert.ok(hooks.hooks.stop.length);

  // "Send a test event" runs the command from hooks.json (node bridge/hook.js cursor).
  const tested = await call(port, 'POST', '/api/agents/cursor/test', {}, ours);
  assert.deepEqual(tested.json, { ok: true, via: 'hook' });
  const gemini = await call(port, 'POST', '/api/agents/gemini/connect', {}, ours);
  assert.equal(gemini.status, 200);
  assert.deepEqual((await call(port, 'POST', '/api/agents/gemini/test', {}, ours)).json, { ok: true, via: 'hook' });
  await call(port, 'POST', '/api/agents/copilot/connect', {}, ours);
  assert.deepEqual((await call(port, 'POST', '/api/agents/copilot/test', {}, ours)).json, { ok: true, via: 'hook' });
  await call(port, 'POST', '/api/agents/opencode/connect', {}, ours);
  assert.deepEqual((await call(port, 'POST', '/api/agents/opencode/test', {}, ours)).json, { ok: true, via: 'plugin' });
  assert.deepEqual((await call(port, 'POST', '/api/agents/generic/test', {}, ours)).json, { ok: true, via: 'bridge' });

  // A test isn't activity.
  assert.equal((await call(port, 'GET', '/api/activity')).json.entries.length, 0);

  // Events from a connected agent land in the log…
  const event = { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c9', workspace_roots: ['/work/proj'], prompt: 'hello' };
  await call(port, 'POST', '/hook?agent=cursor', event);
  let entries = (await call(port, 'GET', '/api/activity')).json.entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].harness, 'cursor');
  assert.ok((await call(port, 'GET', '/api/agents')).json.agents.find((a) => a.id === 'cursor').lastEventAt);

  // …unless it's switched off.
  const off = await call(port, 'POST', '/api/config', { agents: { cursor: false } }, ours);
  assert.equal(off.json.agents.cursor, false);
  await call(port, 'POST', '/hook?agent=cursor', { ...event, conversation_id: 'c10' });
  entries = (await call(port, 'GET', '/api/activity')).json.entries;
  assert.equal(entries.length, 1);

  // Gemini's payload looks like Claude's; ?agent= keeps them apart.
  await call(port, 'POST', '/hook?agent=gemini', { session_id: 'g1', hook_event_name: 'BeforeAgent', cwd: '/work/g', prompt: 'hi', timestamp: new Date().toISOString() });
  entries = (await call(port, 'GET', '/api/activity')).json.entries;
  assert.equal(entries.at(-1).harness, 'gemini');

  for (const id of ['cursor', 'gemini', 'opencode', 'copilot']) {
    const res = await call(port, 'POST', `/api/agents/${id}/disconnect`, {}, ours);
    assert.equal(res.status, 200);
    assert.equal(res.json.agent.connected, false, id);
  }
});

test('connect refuses a config file it can’t read, and says why', async (t) => {
  const { port, server } = await start();
  t.after(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); });
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(tmp, 'gemini'), { recursive: true });
  await writeFile(join(tmp, 'gemini', 'settings.json'), '{ "theme": "x", }');
  const res = await call(port, 'POST', '/api/agents/gemini/connect', {}, ours);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /wasn’t changed/);
  assert.equal(await readFile(join(tmp, 'gemini', 'settings.json'), 'utf8'), '{ "theme": "x", }');
});

test('GET /api/usage answers with a list', async (t) => {
  const { port, server } = await start();
  t.after(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); });
  const res = await call(port, 'GET', '/api/usage');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.agents));
});

test('the plugin only opens the installed copy when it is at least as new (compareVersions)', async () => {
  const { compareVersions } = await import('../desktop/launch.js');
  assert.deepEqual([compareVersions('0.9.3', '0.9.2'), compareVersions('0.9.2', '0.9.3'), compareVersions('1.0.0', '0.9.9'), compareVersions('0.9.2', '0.9.2')], [1, -1, 1, 0]);
  assert.deepEqual([compareVersions('0.9.3-rc.1', '0.9.3'), compareVersions('0.9.3', '0.9.3-rc.1'), compareVersions('0.9.3-rc.2', '0.9.3-rc.10'), compareVersions('0.9.4-rc.1', '0.9.3')], [-1, 1, -1, 1]);
});
