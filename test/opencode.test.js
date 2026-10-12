import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActivityLog } from '../bridge/activity.js';
import opencode, { applyOpenCode, describeTool, PLUGIN } from '../bridge/adapters/opencode.js';
import { buildTurns } from '../bridge/ui/recap.js';
import { readiness, testVerdict, weakenedTests } from '../bridge/ui/story.js';

test('describeTool: OpenCode tools', () => {
  const edit = describeTool('edit', { filePath: '/work/proj/a.js', oldString: 'x', newString: 'y' }, '/work/proj');
  assert.equal(edit.kind, 'edit');
  assert.equal(edit.title, 'a.js');
  assert.equal(describeTool('bash', { command: 'npm test' }).kind, 'run');
  const patch = describeTool('apply_patch', { patchText: '*** Begin Patch\n*** Add File: b.js\n+x\n*** End Patch' }, '/work/proj');
  assert.equal(patch.kind, 'write');
  assert.equal(patch.title, 'b.js');
  assert.equal(describeTool('todowrite', { todos: [{ content: 'a', status: 'completed', id: '1' }] }).plan[0].status, 'completed');
});

test('applyOpenCode: what the plugin sends, turned into a turn', () => {
  const log = createActivityLog();
  const cwd = '/work/proj';
  const p = applyOpenCode({ type: 'prompt', sessionID: 'ses_1', text: 'rename foo', cwd, at: 1000 }, log);
  assert.equal(p.session, 'opencode:ses_1');
  assert.equal(p.label, 'proj');
  assert.equal(p.entries[0].kind, 'prompt');

  applyOpenCode({ type: 'tool.before', sessionID: 'ses_1', callID: 'call_1', tool: 'bash', args: { command: 'npm test' }, cwd, at: 2000 }, log);
  const run = applyOpenCode({ type: 'tool.after', sessionID: 'ses_1', callID: 'call_1', tool: 'bash', title: 'npm test', output: 'ok', cwd, at: 3500 }, log).entries[0];
  assert.equal(run.status, 'ok');
  assert.equal(run.ms, 1500);

  applyOpenCode({ type: 'tool.before', sessionID: 'ses_1', callID: 'call_2', tool: 'edit', args: { filePath: '/work/proj/a.js', oldString: 'a', newString: 'b' }, cwd, at: 4000 }, log);
  applyOpenCode({ type: 'tool.error', sessionID: 'ses_1', callID: 'call_2', tool: 'edit', error: 'oldString not found', cwd, at: 4100 }, log);
  assert.equal(log.get('opencode:ses_1:call_2').status, 'failed');

  const idle = applyOpenCode({ type: 'event', event: { type: 'session.idle', properties: { sessionID: 'ses_1' } }, reply: 'Renamed it.', cwd, at: 5000 }, log);
  const done = idle.entries.find((e) => e.kind === 'done');
  assert.equal(done.summary, 'Renamed it.');
  assert.equal(done.ms, 4000);
  assert.equal(idle.state.state, 'done');

  // Idle again with nothing new: no second "Finished".
  const again = applyOpenCode({ type: 'event', event: { type: 'session.idle', properties: { sessionID: 'ses_1' } }, cwd, at: 6000 }, log);
  assert.equal(again.entries.length, 0);
});

test('applyOpenCode: a test run counts by its exit code; a test edited to pass is caught', () => {
  const log = createActivityLog();
  const cwd = '/work/proj';
  const send = (at, e) => applyOpenCode({ sessionID: 'ses_2', cwd, at, ...e }, log);
  const bash = (at, callID, exit, output) => {
    send(at, { type: 'tool.before', callID, tool: 'bash', args: { command: 'npm test' } });
    return send(at + 500, { type: 'tool.after', callID, tool: 'bash', title: 'npm test', output, exit }).entries[0];
  };
  send(1000, { type: 'prompt', text: 'make the tests pass' });
  // No summary to read: the exit code decides.
  const failing = bash(2000, 'b1', 1, 'Error: Cannot find module \'./math\'');
  assert.equal(failing.status, 'failed');
  assert.equal(testVerdict(failing).state, 'failed');
  send(4000, { type: 'tool.before', callID: 'e1', tool: 'edit', args: { filePath: '/work/proj/test/math.test.js', oldString: "  assert.equal(subtract(1, 2), -1);\n", newString: '' } });
  send(4100, { type: 'tool.after', callID: 'e1', tool: 'edit', title: 'test/math.test.js', output: 'Edit applied successfully.' });
  const passing = bash(5000, 'b2', 0, 'all good');
  assert.equal(testVerdict(passing).state, 'passed');
  // Stopped (or timed out): no exit code.
  assert.equal(bash(6000, 'b3', null, 'User aborted the command').status, 'stopped');
  send(7000, { type: 'event', event: { type: 'session.idle', properties: { sessionID: 'ses_2' } } });
  const [turn] = buildTurns(log.all());
  assert.match(weakenedTests(turn.steps).text, /removed 1 assertion in math\.test\.js/);
  assert.equal(readiness(turn).ready, false);
  // A plugin from before the exit code was sent: as before.
  assert.equal(bash(8000, 'b4', undefined, 'ok').status, 'ok');
});

test('the plugin posts what it sees, and never throws', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-oc-plugin-'));
  const file = join(dir, 'dotpals.mjs');
  await writeFile(file, PLUGIN);
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response('{}'); };
  try {
    const mod = await import(`file:///${file.replace(/\\/g, '/')}`);
    assert.deepEqual(Object.keys(mod), ['DotpalsPlugin'], 'OpenCode loads every export as a plugin');
    const hooks = await mod.DotpalsPlugin({ directory: '/work/proj', worktree: '/work/proj' }, { url: 'http://127.0.0.1:1/hook' });
    await hooks['chat.message']({ sessionID: 's' }, { message: {}, parts: [{ type: 'text', text: 'hi' }, { type: 'text', text: 'ctx', synthetic: true }] });
    await hooks['tool.execute.before']({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: { command: 'ls' } });
    // A long test run: its summary is at the end, and the bash tool says how it exited.
    const long = `${'✔ a passing test\n'.repeat(600)}ℹ tests 601\nℹ pass 600\nℹ fail 1\n`;
    await hooks['tool.execute.after']({ tool: 'bash', sessionID: 's', callID: 'c' }, { title: 'npm test', output: long, metadata: { exit: 1, truncated: false } });
    await hooks.event({ event: { type: 'message.part.updated', properties: { sessionID: 's', part: { type: 'text', text: 'All done.' } } } });
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 's' } } });
    await hooks.event({ event: { type: 'lsp.updated', properties: {} } });
    await hooks['tool.execute.after'](null, null); // bad input is swallowed
    assert.equal(sent.length, 4);
    assert.equal(sent[0].url, 'http://127.0.0.1:1/hook?agent=opencode');
    assert.deepEqual([sent[0].body.type, sent[0].body.text, sent[0].body.cwd], ['prompt', 'hi', '/work/proj']);
    assert.deepEqual(sent[1].body.args, { command: 'ls' });
    assert.equal(sent[2].body.exit, 1);
    assert.ok(sent[2].body.output.length < long.length);
    assert.match(sent[2].body.output, /^✔ a passing test/);
    assert.match(sent[2].body.output, /ℹ fail 1\n$/);
    assert.equal(sent[3].body.reply, 'All done.');
  } finally {
    globalThis.fetch = realFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('OpenCode connect writes the plugin and disconnect puts back what was there', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-oc-'));
  process.env.DOTPALS_OPENCODE_DIR = dir;
  t.after(async () => { delete process.env.DOTPALS_OPENCODE_DIR; await rm(dir, { recursive: true, force: true }); });
  const file = join(dir, 'plugins', 'dotpals.js');
  assert.equal(opencode.connected(), false);
  opencode.connect();
  assert.equal(opencode.connected(), true);
  assert.equal(await readFile(file, 'utf8'), PLUGIN);
  opencode.disconnect();
  assert.equal(existsSync(file), false);

  // Someone else's file with the same name is backed up, then restored.
  await mkdir(join(dir, 'plugins'), { recursive: true });
  await writeFile(file, 'export const Other = async () => ({})\n');
  opencode.connect();
  assert.equal(opencode.connected(), true);
  opencode.disconnect();
  assert.equal(await readFile(file, 'utf8'), 'export const Other = async () => ({})\n');
});
