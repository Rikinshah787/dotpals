import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep the bridge away from the real home folder: no Codex watcher, no history file.
process.env.DOTPALS_CODEX = '0';
process.env.DOTPALS_CLAUDE_LOGS = '0';
process.env.DOTPALS_HISTORY = '0';
delete process.env.DOTPALS_BRIDGE;
const home = await mkdtemp(join(tmpdir(), 'dotpals-home-'));
process.env.DOTPALS_HOME = home;
after(() => rm(home, { recursive: true, force: true }));

const { startBridge } = await import('../bridge/server.js');
const bin = fileURLToPath(new URL('../bin/dotpals.js', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// fetch refuses some ports outright, and Windows reserves a few (see server.test.js).
const BLOCKED = new Set([5985, 5986, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);
const freshPort = () => { let port; do port = 7200 + Math.floor(Math.random() * 2000); while (BLOCKED.has(port)); return port; };
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
const post = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const tick = () => new Promise((r) => setTimeout(r, 15)); // so every step gets its own time

/** `dotpals mcp` in `cwd`, talking to the bridge on `port`: send requests, read replies by id. */
function mcp(port, cwd) {
  const child = spawn(process.execPath, [bin, 'mcp'], { cwd, env: { ...process.env, DOTPALS_PORT: String(port) } });
  const waiting = new Map();
  const unasked = []; // replies nobody waited for (a notification must get none)
  const junk = []; // stdout lines that aren't JSON-RPC (there must be none)
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      let msg;
      try { msg = JSON.parse(line); } catch { junk.push(line); continue; }
      if (waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); } else unasked.push(msg);
    }
  });
  let next = 1;
  const reply = (id) => new Promise((ok) => waiting.set(id, ok));
  return {
    unasked, junk,
    raw(line, id = null) { const r = reply(id); child.stdin.write(`${line}\n`); return r; },
    call(method, params) { const id = next++; const r = reply(id); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); return r; },
    notify(method, params) { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); },
    async tool(name, args = {}) { return (await this.call('tools/call', { name, arguments: args })).result; },
    close() { const done = new Promise((ok) => child.on('exit', ok)); child.stdin.end(); return done; },
  };
}

test('dotpals mcp: answers from the running bridge, with the pal\'s rules', async (t) => {
  const { port, server } = await start();
  server.keepAliveTimeout = 60_000; // the server runs as a child process, which can be slow on CI
  const folder = await mkdtemp(join(tmpdir(), 'dotpals-mcp-'));
  const shop = join(folder, 'shop'); // the folder the assistant runs in: the same name as the Claude session's project
  mkdirSync(shop);

  // Codex fixing billing in another project.
  await post(port, '/event', { session: 'codex-api-1', harness: 'codex', label: 'api', state: 'working', activity: { kind: 'prompt', title: 'Fix the billing bug', status: 'info' } });
  await tick();
  await post(port, '/event', { session: 'codex-api-1', harness: 'codex', label: 'api', state: 'working', activity: { kind: 'edit', title: 'billing.ts', status: 'ok', files: [{ path: '/work/api/billing.ts', change: 'edit' }] } });
  await tick();

  // Claude Code in shop: changes login.js, the tests fail, it fixes it, they pass, it stops.
  const hook = async (e) => { await post(port, '/hook', { session_id: 'sess-shop-1', cwd: '/work/shop', ...e }); await tick(); };
  const edit = async (id, file) => {
    const tool_input = { file_path: `/work/shop/src/${file}`, old_string: 'a', new_string: 'b' };
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: id, tool_input });
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: id, tool_input, tool_response: {} });
  };
  const npmTest = async (id, passed) => {
    const tool_input = { command: 'npm test' };
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: id, tool_input });
    if (passed) await hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: id, tool_input, tool_response: { stdout: '✔ logs in\n✔ logs out\nℹ tests 2\nℹ pass 2\nℹ fail 0', stderr: '' } });
    else await hook({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: id, tool_input, error: 'Exit code 1\n✔ logs out\n✖ logs in\nℹ tests 2\nℹ pass 1\nℹ fail 1' });
  };
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Add a login page' });
  await edit('e1', 'login.js');
  await npmTest('b1', false);
  await edit('e2', 'login.js');
  await npmTest('b2', true);
  await hook({ hook_event_name: 'Stop', last_assistant_message: 'Added the login page. All tests pass.' });

  // Then Codex starts in shop too: now the newest session there.
  await post(port, '/event', { session: 'codex-shop-1', harness: 'codex', label: 'shop', state: 'working', activity: { kind: 'prompt', title: 'Write the docs', status: 'info' } });

  const client = mcp(port, shop);
  t.after(async () => {
    await client.close(); // before removing the folder it runs in
    server.closeAllConnections();
    server.close();
    await rm(folder, { recursive: true, force: true });
  });

  const init = await client.call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.0.0' } });
  assert.equal(init.result.protocolVersion, '2025-03-26'); // the client's, when it's one we speak
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.deepEqual(init.result.serverInfo, { name: 'dotpals', version });
  assert.match(init.result.instructions, /check_my_work/);
  client.notify('notifications/initialized');
  assert.deepEqual((await client.call('ping')).result, {});
  assert.deepEqual(client.unasked, []); // the notification got no reply

  const { tools } = (await client.call('tools/list')).result;
  assert.deepEqual(tools.map((x) => x.name), ['agents_now', 'test_status', 'ready_to_merge', 'recap', 'check_my_work']);
  for (const x of tools) assert.equal(x.inputSchema.type, 'object');

  const now = (await client.tool('agents_now')).content[0].text;
  assert.match(now, /^Codex in shop: working \(session codex-shop-1\)\n {2}Asked: “Write the docs”/); // newest first
  assert.match(now, /Claude Code in shop: finished just now \(session sess-shop-1\)\n {2}Asked: “Add a login page”\n {2}Result: .*the tests passed after one retry\.\n {2}Tests passed · 2 passed · .*, after the last change/);
  assert.match(now, /Codex in api: working \(session codex-api-1\)\n {2}Asked: “Fix the billing bug”\n {2}Now: Edited billing\.ts/);

  // Default: the newest session in this folder's project (Codex's, which changed nothing yet).
  assert.match((await client.tool('test_status')).content[0].text, /^Codex in shop: working.*\nNo code changed and no tests ran in this session\.$/);
  // A session by the start of its ID.
  assert.match((await client.tool('test_status', { session: 'sess-shop' })).content[0].text, /^Claude Code in shop: finished.*\nTests passed · 2 passed · .*, after the last change$/);

  const ready = (await client.tool('ready_to_merge', { session: 'sess-shop' })).content[0].text;
  assert.match(ready, /\n✅ Ready to merge\n✓ Tests ran\n✓ Tests ran after the last change\n✓ Tests passed\n✓ No failures left behind\n✓ Nothing risky\n/);
  assert.match((await client.tool('ready_to_merge', { project: 'api' })).content[0].text, /Codex in api: working.*\nStill working: ask again when it finishes\./);

  const recap = (await client.tool('recap', { project: '/somewhere/else/shop' })).content[0].text; // a path counts by its folder name
  assert.match(recap, /^shop: 2 requests since /);
  assert.match(recap, /Claude Code in shop: “Add a login page”\n {2}.*the tests passed after one retry\.\n {2}Files: login\.js/);
  assert.match(recap, /Codex in shop: “Write the docs”/);
  assert.match((await client.tool('recap', { project: 'shop', since: '0' })).content[0].text, /^Nothing from shop since /);
  assert.match((await client.tool('recap', { project: 'nope' })).content[0].text, /^dotpals has seen no agent working in nope\. Projects it knows: shop, api\./);
  const badSince = await client.call('tools/call', { name: 'recap', arguments: { since: 'yesterday-ish' } });
  assert.equal(badSince.error.code, -32602);

  // check_my_work: Claude Code asking checks Claude's own session, though Codex's is newer.
  assert.match((await client.tool('check_my_work')).content[0].text, /^Looks done \(Claude Code in shop, session sess-shop-1\): tests passed after the last change, nothing risky\. Tests passed · 2 passed/);
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Tidy up' });
  await edit('e3', 'util.js');
  const stale = (await client.tool('check_my_work')).content[0].text;
  assert.match(stale, /^Not done yet \(Claude Code in shop, session sess-shop-1\):\n✗ Changed `util\.js` after the last test run\nTests passed at .* · 1 file changed since\nRun the tests, then call check_my_work again\.$/);

  // Protocol errors.
  assert.equal((await client.call('tools/call', { name: 'nope' })).error.code, -32602);
  assert.equal((await client.call('resources/list')).error.code, -32601);
  const parse = await client.raw('{not json');
  assert.equal(parse.id, null);
  assert.equal(parse.error.code, -32700);
  assert.deepEqual(client.junk, []); // stdout carried only protocol messages
});

test('dotpals mcp: with no bridge running, every tool says how to start it', async (t) => {
  const client = mcp(freshPort(), tmpdir());
  t.after(() => client.close());
  await client.call('initialize', { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'cursor' } }).then((r) => assert.equal(r.result.protocolVersion, '2025-06-18'));
  for (const name of ['agents_now', 'test_status', 'ready_to_merge', 'recap', 'check_my_work']) {
    const r = await client.tool(name);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /^dotpals isn.t running\. Start it with `npx dotpals start`/);
  }
});
