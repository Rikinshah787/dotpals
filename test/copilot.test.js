import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActivityLog } from '../bridge/activity.js';
import copilot, { applyCopilot, EVENTS } from '../bridge/adapters/copilot.js';

// Payloads as documented in the Copilot CLI hooks reference (camelCase format).
const base = { sessionId: 'cs1', cwd: '/work/proj' };
const ev = (name, secs, extra) => ({ ...base, hook_event_name: name, timestamp: 1_700_000_000_000 + secs * 1000, ...extra });

test('applyCopilot: prompt, tools (toolArgs as a string or an object) and the stop', () => {
  const log = createActivityLog();
  const p = applyCopilot(ev('userPromptSubmitted', 0, { prompt: 'fix the build' }), log);
  assert.equal(p.session, 'copilot:cs1');
  assert.equal(p.label, 'proj');
  assert.equal(p.entries[0].title, 'fix the build');

  const run = applyCopilot(ev('postToolUse', 2, { toolName: 'bash', toolArgs: '{"command":"git status"}', toolResult: { resultType: 'success', textResultForLlm: 'clean' } }), log).entries[0];
  assert.equal(run.kind, 'run');
  assert.equal(run.title, 'git status');
  assert.equal(run.status, 'ok');
  assert.equal(run.body.output, 'clean');

  const obj = applyCopilot(ev('postToolUse', 3, { toolName: 'bash', toolArgs: { command: 'npm test' }, toolResult: { resultType: 'failure', textResultForLlm: '1 failing' } }), log).entries[0];
  assert.equal(obj.title, 'npm test');
  assert.equal(obj.status, 'failed');

  const failed = applyCopilot(ev('postToolUseFailure', 4, { toolName: 'edit', toolArgs: {}, error: 'no match' }), log).entries[0];
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'no match');

  const waiting = applyCopilot(ev('notification', 5, { message: 'Allow rm?', title: 'Permission', notification_type: 'permission_prompt' }), log);
  assert.equal(waiting.state.state, 'waiting');

  const stop = applyCopilot(ev('agentStop', 9, { transcriptPath: '/tmp/t.jsonl', stopReason: 'end_turn' }), log);
  const done = stop.entries.find((e) => e.kind === 'done');
  assert.equal(done.ms, 9000);
  assert.equal(stop.state.state, 'done');
});

test('Copilot connect writes its own hooks file; disconnect removes it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-copilot-'));
  process.env.DOTPALS_COPILOT_DIR = dir;
  t.after(async () => { delete process.env.DOTPALS_COPILOT_DIR; await rm(dir, { recursive: true, force: true }); });
  const file = join(dir, 'hooks', 'dotpals.json');
  copilot.connect();
  const config = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(config.version, 1);
  for (const event of EVENTS) assert.match(config.hooks[event][0].command, new RegExp(`bridge/hook\\.js" copilot ${event}$`));
  // preToolUse fails closed, so it's never used.
  assert.equal(config.hooks.preToolUse, undefined);
  assert.equal(copilot.connected(), true);
  copilot.disconnect();
  assert.equal(existsSync(file), false);
  assert.equal(copilot.connected(), false);
});
