import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, get } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alertText, createAlerts, findConflict, guardReply, pathKey } from '../bridge/guard.js';

// Keep the bridge away from the real home folder: no Codex watcher, no history file.
process.env.DOTPALS_CODEX = '0';
process.env.DOTPALS_CLAUDE_LOGS = '0';
process.env.DOTPALS_HISTORY = '0';
const home = await mkdtemp(join(tmpdir(), 'dotpals-guard-'));
process.env.DOTPALS_HOME = home;
after(() => rm(home, { recursive: true, force: true }));
const { startBridge } = await import('../bridge/server.js');

const MIN = 60_000;
const NOW = 1_800_000_000_000;
const edit = (session, path, at, extra = {}) => ({ id: `${session}:${at}`, session, harness: 'codex', label: 'api', kind: 'edit', title: path, files: [{ path, change: 'edit' }], status: 'ok', at, ...extra });

test('pathKey: one spelling per file (slashes, case, dots, relative to the folder)', () => {
  assert.equal(pathKey('C:\\Work\\Shop\\src\\Billing.ts'), 'c:/work/shop/src/billing.ts');
  assert.equal(pathKey('src/./lib/../billing.ts', 'C:\\work\\shop\\'), 'c:/work/shop/src/billing.ts');
  assert.equal(pathKey('/home/me/shop//billing.ts'), '/home/me/shop/billing.ts');
  assert.equal(pathKey(''), '');
});

test('findConflict: another active session changed the file within the window', () => {
  const entries = [edit('codex:1', 'C:\\work\\shop\\billing.ts', NOW - 2 * MIN)];
  const c = findConflict(entries, { session: 'claude:1', path: 'c:/Work/Shop/billing.ts', at: NOW });
  assert.equal(c.session, 'codex:1');
  assert.equal(c.harness, 'codex');
  assert.equal(c.at, NOW - 2 * MIN);
  // A relative path from the other agent, taken from its folder.
  const rel = [edit('codex:1', 'billing.ts', NOW - MIN)];
  assert.ok(findConflict(rel, { session: 'claude:1', path: '/w/shop/billing.ts', at: NOW, cwds: new Map([['codex:1', '/w/shop']]) }));
  assert.equal(findConflict(rel, { session: 'claude:1', path: '/w/shop/billing.ts', at: NOW }), null, 'no folder known: no match');
});

test('findConflict: own session, its helpers, reads, failures, paused edits and old changes don’t count', () => {
  const path = '/w/shop/billing.ts';
  const at = NOW;
  const none = (entries, extra = {}) => assert.equal(findConflict(entries, { session: 'claude:1', path, at, ...extra }), null);
  none([edit('claude:1', path, at - MIN)]); // itself (and its subagents, which share its session)
  none([edit('codex:2', path, at - MIN)], { parents: new Map([['codex:2', 'claude:1']]) }); // a helper it started
  none([{ ...edit('codex:1', path, at - MIN), kind: 'read', files: [{ path, change: 'read' }] }]);
  none([edit('codex:1', path, at - MIN, { status: 'failed' })]);
  none([edit('codex:1', path, at - MIN, { status: 'running', guard: { mode: 'tell' } })]);
  none([edit('codex:1', path, at - 11 * MIN)]); // outside the 10 minutes
  assert.ok(findConflict([edit('codex:1', path, at - 11 * MIN)], { session: 'claude:1', path, at, within: 15 * MIN }));
  none([edit('codex:1', '/w/shop/other.ts', at - MIN)]);
  // A change under way counts.
  assert.ok(findConflict([edit('codex:1', path, at - MIN, { status: 'running' })], { session: 'claude:1', path, at }));
});

test('findConflict: the other session must still be active', () => {
  const path = '/w/shop/billing.ts';
  const entries = [edit('codex:1', path, NOW - 2 * MIN)];
  // Put to sleep (dismissed, ended, quiet): not active, even with recent activity.
  assert.equal(findConflict(entries, { session: 'claude:1', path, at: NOW, states: new Map([['codex:1', 'sleeping']]) }), null);
  // Working now, or active within the window: active.
  assert.ok(findConflict(entries, { session: 'claude:1', path, at: NOW, states: new Map([['codex:1', 'working']]) }));
  assert.ok(findConflict(entries, { session: 'claude:1', path, at: NOW, states: new Map([['codex:1', 'done']]) }));
  // The newest change wins.
  const two = [...entries, edit('gemini:1', path, NOW - MIN, { harness: 'gemini', label: 'web' })];
  assert.equal(findConflict(two, { session: 'claude:1', path, at: NOW }).session, 'gemini:1');
});

test('guardReply: Claude Code’s PreToolUse format, for ask and tell', () => {
  const c = { path: '/w/api/billing.ts', session: 'codex:1', harness: 'codex', label: 'api', at: NOW - 2 * MIN };
  assert.deepEqual(guardReply(c, 'ask', NOW), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'Codex (api) changed billing.ts 2 minutes ago. Edit anyway?' } });
  assert.deepEqual(guardReply(c, 'tell', NOW), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Codex (api) changed billing.ts 2 minutes ago. Re-read the file first, then decide.' } });
  assert.equal(guardReply(c, 'off', NOW), null);
  assert.equal(guardReply(null, 'ask', NOW), null);
  assert.equal(alertText({ harness: 'codex' }, { ...c, harness: 'claude', label: 'shop' }, NOW), 'Codex is editing billing.ts, which Claude (shop) changed 2 min ago');
});

test('alerts: once per file and pair of sessions per 10 minutes', () => {
  const alerts = createAlerts();
  const a = { path: 'C:\\w\\billing.ts', a: 'codex:1', b: 'claude:1' };
  assert.equal(alerts.ok(a, NOW), true);
  assert.equal(alerts.ok({ ...a, path: 'c:/w/Billing.ts', a: 'claude:1', b: 'codex:1' }, NOW + MIN), false, 'same file, same pair (either way round)');
  assert.equal(alerts.ok({ ...a, path: 'c:/w/other.ts' }, NOW + MIN), true, 'another file');
  assert.equal(alerts.ok({ ...a, b: 'gemini:1' }, NOW + MIN), true, 'another pair');
  assert.equal(alerts.ok(a, NOW + 10 * MIN), true, 'after 10 minutes');
});

// -- the bridge ----------------------------------------------------------------------------

const usedPorts = new Set();
const BLOCKED = new Set([5985, 5986, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);
const freshPort = () => { let port; do port = 7300 + Math.floor(Math.random() * 1500); while (usedPorts.has(port) || BLOCKED.has(port)); usedPorts.add(port); return port; };
async function start() {
  for (let tries = 0; ; tries++) {
    const port = freshPort();
    try { return { port, server: await startBridge({ port, log: () => {} }) }; } catch (err) {
      if (!['EADDRINUSE', 'EACCES'].includes(err.code) || tries > 10) throw err;
    }
  }
}
const close = async (server) => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); };

/** Listen for `conflict` events. */
async function conflicts(port) {
  const list = [];
  const stream = await new Promise((ok) => get({ host: '127.0.0.1', port, path: '/events' }, ok));
  stream.setEncoding('utf8');
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk;
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop();
    for (const b of blocks) if (b.startsWith('event: conflict')) list.push(JSON.parse(b.split('\ndata: ')[1]));
  });
  stream.on('error', () => {});
  return { list, stop: () => stream.destroy() };
}

test('the bridge: PreToolUse for a file another agent just changed gets ask, tell or nothing', async (t) => {
  const { port, server } = await start();
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;
  const setConfig = (patch) => fetch(`${base}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dotpals': '1' }, body: JSON.stringify(patch) });
  const hook = (session, tool, file, id) => fetch(`${base}/hook?guard=1`, { method: 'POST', body: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: session, cwd: '/work/shop', tool_name: tool, tool_use_id: id, tool_input: { file_path: file } }) }).then((r) => r.json());
  const events = await conflicts(port);
  t.after(events.stop);

  // Codex (followed through its logs, here a generic event) changed billing.ts.
  await fetch(`${base}/event`, { method: 'POST', body: JSON.stringify({ session: 'codex:1', harness: 'codex', label: 'api', cwd: '/work/shop', state: 'working', activity: { id: 'e1', kind: 'edit', title: 'billing.ts', files: [{ path: 'billing.ts', change: 'edit' }], status: 'ok' } }) });

  await setConfig({ conflictGuard: 'ask' });
  const ask = await hook('claude:1', 'Edit', '/work/shop/billing.ts', 'tu1');
  assert.equal(ask.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(ask.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(ask.hookSpecificOutput.permissionDecisionReason, /^Codex \(api\) changed billing\.ts (just now|1 minute ago)\. Edit anyway\?$/);
  // Told once about that change: the next try goes ahead.
  assert.deepEqual(await hook('claude:1', 'Edit', '/work/shop/billing.ts', 'tu2'), {});
  // Other tools and other files: nothing to say.
  assert.deepEqual(await hook('claude:9', 'Bash', '/work/shop/billing.ts', 'tu3'), {});
  assert.deepEqual(await hook('claude:9', 'Write', '/work/shop/README.md', 'tu4'), {});

  await setConfig({ conflictGuard: 'tell' });
  const tell = await hook('claude:2', 'MultiEdit', '/work/shop/./src/../BILLING.ts', 'tu5');
  assert.equal(tell.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(tell.hookSpecificOutput.permissionDecisionReason, /Re-read the file first, then decide\.$/);

  await setConfig({ conflictGuard: 'off' });
  assert.deepEqual(await hook('claude:3', 'Edit', '/work/shop/billing.ts', 'tu6'), {});

  // The decisions are on the edits, for the story; 'tell' stopped its edit.
  const { entries } = await (await fetch(`${base}/api/activity`)).json();
  const asked = entries.find((e) => e.id === 'claude:1:tu1');
  assert.equal(asked.guard.mode, 'ask');
  assert.match(asked.guard.text, /^Paused: Codex \(api\) changed this file/);
  assert.equal(asked.status, 'running');
  const stopped = entries.find((e) => e.id === 'claude:2:tu5');
  assert.equal(stopped.status, 'failed');
  assert.match(stopped.error, /^dotpals stopped this edit/);

  // One alert per pair: claude:1 and claude:2 each with codex:1.
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(events.list.map((c) => [c.session, c.other.session, c.guard]), [['claude:1', 'codex:1', 'ask'], ['claude:2', 'codex:1', 'tell']]);
  assert.match(events.list[0].text, /^Claude is editing billing\.ts, which Codex \(api\) changed/);
  await setConfig({ conflictGuard: 'ask' });
});

test('the bridge: any agent changing a file another active session just changed raises one alert', async (t) => {
  const { port, server } = await start();
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;
  const events = await conflicts(port);
  t.after(events.stop);
  const change = (session, harness, label, id, path) => fetch(`${base}/event`, { method: 'POST', body: JSON.stringify({ session, harness, label, state: 'working', activity: { id, kind: 'edit', title: path, files: [{ path, change: 'edit' }], status: 'ok' } }) });
  await change('claude:a', 'claude', 'shop', '1', 'C:\\work\\shop\\billing.ts');
  await change('codex:b', 'codex', 'shop', '1', 'c:/work/shop/billing.ts');
  await change('codex:b', 'codex', 'shop', '2', 'c:/work/shop/billing.ts'); // again: no second alert
  await change('claude:a', 'claude', 'shop', '2', 'C:\\work\\shop\\billing.ts'); // the same pair the other way round: none either
  await change('codex:b', 'codex', 'shop', '3', 'c:/work/shop/other.ts'); // a file only one of them changed
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(events.list.length, 1);
  assert.equal(events.list[0].session, 'codex:b');
  assert.equal(events.list[0].text, 'Codex is editing billing.ts, which Claude (shop) changed just now');
});

const guardHook = fileURLToPath(new URL('../bridge/guard-hook.js', import.meta.url));
function runGuardHook(bridge, event) {
  return new Promise((ok) => {
    const started = Date.now();
    const child = spawn(process.execPath, [guardHook], { env: { ...process.env, DOTPALS_BRIDGE: bridge }, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('exit', (code) => ok({ code, out, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(event));
  });
}

test('guard-hook.js: fails open when the bridge is slow, and prints the bridge’s answer when it isn’t', async (t) => {
  // A "bridge" that never answers.
  const slow = createServer(() => {});
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  t.after(() => { slow.closeAllConnections?.(); slow.close(); });
  const event = { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/w', tool_name: 'Edit', tool_input: { file_path: '/w/a.ts' } };
  const r = await runGuardHook(`http://127.0.0.1:${slow.address().port}`, event);
  assert.equal(r.code, 0);
  assert.equal(r.out, '', 'nothing printed: the edit goes ahead');
  assert.ok(r.ms < 4000, `gave up in ${r.ms} ms`);

  // No bridge at all: the same.
  const none = await runGuardHook('http://127.0.0.1:9', event);
  assert.deepEqual([none.code, none.out], [0, '']);

  // A bridge with something to say: printed as is.
  const reply = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'x' } };
  const fake = createServer((req, res) => {
    assert.equal(req.url, '/hook?guard=1');
    res.end(JSON.stringify(reply));
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  t.after(() => fake.close());
  const answered = await runGuardHook(`http://127.0.0.1:${fake.address().port}`, event);
  assert.deepEqual(JSON.parse(answered.out), reply);
});
