import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The fix loop for Codex: its hooks (loop-hook.js codex → POST /hook?loop=1&agent=codex) answer
// from what its session logs say. The logs live in a temp folder, and the bridge follows them.
const tmp = await mkdtemp(join(tmpdir(), 'dotpals-codexloop-'));
delete process.env.DOTPALS_CODEX;
process.env.DOTPALS_CODEX_DIR = join(tmp, 'sessions');
process.env.DOTPALS_CODEX_HOME = join(tmp, 'codex');
process.env.DOTPALS_CLAUDE_LOGS = '0';
process.env.DOTPALS_HISTORY = '0';
process.env.DOTPALS_HOME = join(tmp, 'home');
after(() => rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const { startBridge } = await import('../bridge/server.js');

const usedPorts = new Set();
const BLOCKED = new Set([5985, 5986, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);
const freshPort = () => { let port; do port = 8900 + Math.floor(Math.random() * 1000); while (usedPorts.has(port) || BLOCKED.has(port)); usedPorts.add(port); return port; };
async function start() {
  for (let tries = 0; ; tries++) {
    const port = freshPort();
    try { return { port, server: await startBridge({ port, log: () => {} }) }; } catch (err) {
      if (!['EADDRINUSE', 'EACCES'].includes(err.code) || tries > 10) throw err;
    }
  }
}
const close = async (server) => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); };

/** Listen for `loop` events. */
async function loopEvents(port) {
  const list = [];
  const stream = await new Promise((ok) => get({ host: '127.0.0.1', port, path: '/events' }, ok));
  stream.setEncoding('utf8');
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk;
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop();
    for (const b of blocks) if (b.startsWith('event: loop')) list.push(JSON.parse(b.split('\ndata: ')[1]));
  });
  stream.on('error', () => {});
  return { list, stop: () => stream.destroy() };
}

// A session log in the format Codex writes (see codex.test.js).
const now = new Date();
const folder = join(tmp, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
const t0 = Date.now() - 30_000;
const ts = (s) => new Date(t0 + s * 1000).toISOString();
const item = (s, payload) => ({ timestamp: ts(s), type: 'response_item', payload });
const lines = (...l) => l.map((o) => `${JSON.stringify(o)}\n`).join('');
const patch = (s, id) => [
  item(s, { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: math.js\n@@\n-return a - b\n+return a + b\n*** End Patch', call_id: id }),
  item(s + 1, { type: 'custom_tool_call_output', call_id: id, output: 'Success. Updated the following files:\nM math.js' }),
];
const chunk = (code, output) => `Chunk ID: 1a2b3c\nWall time: 1.2 seconds\nProcess exited with code ${code}\nOriginal token count: 40\nOutput:\n${output}`;
const testRun = (s, id, code, output) => [
  item(s, { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test' }), call_id: id }),
  item(s + 1, { type: 'function_call_output', call_id: id, output: chunk(code, output) }),
];
const FAILED = '✖ sum adds two numbers\nℹ tests 2\nℹ pass 1\nℹ fail 1';
const PASSED = '✔ sum adds two numbers\n✔ multiply\nℹ tests 2\nℹ pass 2\nℹ fail 0';

test('Codex: told when its tests fail, held back from committing, sent back at Stop, and "Fixed" once they pass', async (t) => {
  const { port, server } = await start();
  t.after(() => close(server));
  const events = await loopEvents(port);
  t.after(events.stop);
  await mkdir(folder, { recursive: true });
  const log = join(folder, 'rollout-loop.jsonl');
  await writeFile(log, lines(
    { timestamp: ts(0), type: 'session_meta', payload: { id: 'thr1', cwd: '/w/app' } },
    item(1, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the sum' }] }),
    ...patch(2, 'p1'),
    ...testRun(4, 'c1', 1, FAILED),
  ));
  // Codex's hooks, as loop-hook.js codex sends them.
  const hook = (e) => fetch(`http://127.0.0.1:${port}/hook?loop=1&agent=codex`, { method: 'POST', body: JSON.stringify({ session_id: 'thr1', cwd: '/w/app', turn_id: 'turn-1', ...e }) }).then((r) => r.json());
  const bash = (event, id, command, response) => hook({ hook_event_name: event, tool_name: 'Bash', tool_use_id: id, tool_input: { command }, ...(response ? { tool_response: response } : {}) });

  assert.deepEqual(await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the sum' }), {});
  // No PostToolUseFailure in Codex: the exit code says it failed. The edit before it comes from the log.
  const told = await bash('PostToolUse', 'c1', 'npm test', { stdout: FAILED, exit_code: 1 });
  assert.match(told.hookSpecificOutput?.additionalContext ?? '', /^dotpals: this test run failed .*Fix it before you finish; dotpals checks again when you stop\.$/);
  assert.equal((await bash('PreToolUse', 'c2', 'git commit -am wip')).hookSpecificOutput?.permissionDecision, 'deny');
  const stop = await hook({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' });
  assert.equal(stop.decision, 'block');
  assert.match(stop.reason, /^dotpals: the tests are failing/);

  // Codex fixes the code and the tests pass.
  await appendFile(log, lines(...patch(10, 'p2'), ...testRun(12, 'c3', 0, PASSED)));
  assert.deepEqual(await bash('PostToolUse', 'c3', 'npm test', { stdout: PASSED, exit_code: 0 }), {});
  assert.deepEqual(await hook({ hook_event_name: 'Stop', stop_hook_active: true }), {});

  // The pal and the notch say it's Codex.
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(events.list.map((e) => e.kind), ['told', 'blocked-ship', 'sent-back', 'fixed']);
  assert.ok(events.list.every((e) => e.harness === 'codex' && e.session === 'codex:thr1'));
  assert.match(events.list[0].text, / Told Codex to fix them\.$/);
  assert.equal(events.list[1].text, 'Stopped Codex from shipping: the tests are failing.');
  assert.equal(events.list[2].text, 'Codex tried to finish with failing tests. Sent it back to fix them.');
  assert.equal(events.list[3].text, 'Fixed: tests pass now ✓');
});

test('Codex: a new prompt counts again, and with the fix loop off nothing is said', async (t) => {
  const { port, server } = await start();
  t.after(() => close(server));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'rollout-count.jsonl'), lines(
    { timestamp: ts(0), type: 'session_meta', payload: { id: 'thr2', cwd: '/w/api' } },
    item(1, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix it' }] }),
    ...patch(2, 'p1'),
    ...testRun(4, 'c1', 1, FAILED),
  ));
  const hook = (e) => fetch(`http://127.0.0.1:${port}/hook?loop=1&agent=codex`, { method: 'POST', body: JSON.stringify({ session_id: 'thr2', cwd: '/w/api', ...e }) }).then((r) => r.json());
  const stop = () => hook({ hook_event_name: 'Stop' });
  // Sent back twice, then let go.
  assert.equal((await stop()).decision, 'block');
  assert.equal((await stop()).decision, 'block');
  assert.deepEqual(await stop(), {});
  // Your next prompt: it counts again.
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'and now?' });
  assert.equal((await stop()).decision, 'block');

  const setConfig = (patch) => fetch(`http://127.0.0.1:${port}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dotpals': '1' }, body: JSON.stringify(patch) });
  await setConfig({ fixLoop: false });
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'once more' });
  assert.deepEqual(await stop(), {});
  await setConfig({ fixLoop: true });
});
