import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActivityLog } from '../bridge/activity.js';
import copilot, { applyCopilot, EVENTS } from '../bridge/adapters/copilot.js';
import { buildTurns } from '../bridge/ui/recap.js';
import { readiness, testVerdict, weakenedTests } from '../bridge/ui/story.js';

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

test('applyCopilot: edits carry their patch, so a test edited to pass is caught', () => {
  const log = createActivityLog();
  const c = (name, secs, extra) => ({ ...ev(name, secs, extra), sessionId: 'cs2' });
  const tests = (secs, result) => applyCopilot(c('postToolUse', secs, { toolName: 'bash', toolArgs: { command: 'npm test', description: 'Run the tests' }, toolResult: result }), log).entries[0];
  applyCopilot(c('userPromptSubmitted', 0, { prompt: 'make the tests pass' }), log);
  // What the bash tool returns for a command that exited non-zero.
  const failing = tests(2, { resultType: 'failure', textResultForLlm: "Error: Cannot find module './math'\n<exited with exit code 1>" });
  assert.equal(testVerdict(failing).state, 'failed');
  const edit = applyCopilot(c('postToolUse', 3, {
    toolName: 'edit', toolArgs: { path: '/work/proj/test/math.test.js', old_str: "test('subtracts', () => {\n  assert.equal(subtract(1, 2), -1);\n});", new_str: "test('subtracts', () => {\n});" },
    toolResult: { resultType: 'success', textResultForLlm: 'File /work/proj/test/math.test.js updated with changes.' },
  }), log).entries[0];
  assert.match(edit.body.patch, /^- {2}assert\.equal\(subtract\(1, 2\), -1\);$/m);
  const created = applyCopilot(c('postToolUse', 4, { toolName: 'create', toolArgs: { path: '/work/proj/notes.md', file_text: 'hi' }, toolResult: { resultType: 'success', textResultForLlm: 'Created file' } }), log).entries[0];
  assert.equal(created.kind, 'write');
  assert.equal(created.body.patch, '+hi');
  const passing = tests(5, { resultType: 'success', textResultForLlm: 'all good\n<exited with exit code 0>' });
  assert.equal(testVerdict(passing).state, 'passed');
  // Still running after its wait: not a result. Nothing said how it ended, so it stopped with the turn.
  const slow = tests(6, { resultType: 'success', textResultForLlm: '✔ adds\n<command with shellId: 3 is still running after 30 seconds. Use read_bash to continue waiting.>' });
  assert.equal(slow.status, 'running');
  applyCopilot(c('agentStop', 9, { stopReason: 'end_turn' }), log);
  assert.equal(log.get(slow.id).status, 'stopped');
  assert.equal(testVerdict(log.get(slow.id)).state, 'unclear');
  const [turn] = buildTurns(log.all().filter((e) => e.session === 'copilot:cs2'));
  assert.match(weakenedTests(turn.steps).text, /removed 1 assertion in math\.test\.js/);
  assert.equal(readiness(turn).ready, false);
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
