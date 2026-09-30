import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createActivityLog } from '../bridge/activity.js';
import { describeCall, watchCodex } from '../bridge/adapters/codex.js';

test('describeCall: exec_command and apply_patch', () => {
  const run = describeCall('exec_command', { cmd: ['npm', 'test'] }, '/work/proj');
  assert.equal(run.kind, 'run');
  assert.equal(run.title, 'npm test');
  assert.equal(run.body.command, 'npm test');

  const patch = describeCall('apply_patch', { input: '*** Begin Patch\n*** Add File: new.js\n+x\n*** End Patch' }, '/work/proj');
  assert.equal(patch.kind, 'write');
  assert.equal(patch.title, 'new.js');
  assert.deepEqual(patch.files, [{ path: '/work/proj/new.js', change: 'write' }]);

  // Codex names MCP tools "<server>__<tool>".
  const mcp = describeCall('docs__search_pages', { q: 'x' }, '/work/proj');
  assert.equal(mcp.kind, 'mcp');
  assert.equal(mcp.title, 'search pages');
  assert.equal(mcp.detail, 'docs');
});

test('watchCodex follows a session log', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-codex-'));
  let stop = () => {};
  t.after(async () => {
    stop();
    await sleep(150); // let an in-flight poll close its file handle (Windows)
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // Same local-date layout the watcher looks in: <dir>/YYYY/MM/DD/*.jsonl
  const now = new Date();
  const folder = join(dir, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  await mkdir(folder, { recursive: true });

  const base = Date.now() - 10_000;
  const ts = (s) => new Date(base + s * 1000).toISOString();
  const patch = '*** Begin Patch\n*** Update File: src/a.js\n@@\n-a\n+b\n*** End Patch';
  const lines = [
    { timestamp: ts(0), type: 'session_meta', payload: { id: 'sess-1', cwd: '/work/proj' } },
    { timestamp: ts(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the bug' }] } },
    { timestamp: ts(2), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test' }), call_id: 'call_1' } },
    { timestamp: ts(4), type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: [{ type: 'output_text', text: 'ok' }] } },
    { timestamp: ts(5), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: patch, call_id: 'call_2' } },
    { timestamp: ts(6), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'Fixed it.' } },
  ];
  await writeFile(join(folder, 'rollout-x.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

  const log = createActivityLog();
  const emitted = [];
  const states = [];
  stop = watchCodex(log, {
    dir,
    interval: 50,
    emit: (entries) => emitted.push(...entries),
    state: (session, label, next) => states.push({ session, label, ...next }),
  });

  // Poll for up to ~1.5s instead of sleeping a fixed time.
  for (let i = 0; i < 30 && !log.findLast('codex:sess-1', (x) => x.kind === 'done'); i++) await sleep(50);
  stop();

  const session = 'codex:sess-1';
  const entries = log.all().filter((e) => e.session === session);

  const prompt = entries.find((e) => e.kind === 'prompt');
  assert.ok(prompt, 'prompt entry');
  assert.equal(prompt.title, 'fix the bug');
  assert.equal(prompt.label, 'proj');
  assert.equal(prompt.harness, 'codex');

  const run = entries.find((e) => e.kind === 'run');
  assert.ok(run, 'run entry');
  assert.equal(run.status, 'ok');
  assert.equal(run.title, 'npm test');
  assert.equal(run.ms, 2000);
  assert.equal(run.body.output, 'ok');

  const edit = entries.find((e) => e.kind === 'edit');
  assert.ok(edit, 'edit entry');
  assert.ok(edit.files[0].path.endsWith('src/a.js'), edit.files[0].path);
  assert.equal(edit.files[0].change, 'edit');
  assert.equal(edit.title, 'src/a.js');
  assert.match(edit.body.patch, /^-a$/m);
  assert.match(edit.body.patch, /^\+b$/m);
  // It never reported back, so the end of the turn stops it.
  assert.equal(edit.status, 'stopped');

  const done = entries.find((e) => e.kind === 'done');
  assert.ok(done, 'done entry');
  assert.equal(done.status, 'ok');
  assert.equal(done.summary, 'Fixed it.');

  assert.ok(emitted.length >= 4);
  assert.ok(states.some((s) => s.state === 'done' && s.session === session));
});
