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

// VS Code's Copilot Chat runs the same hooks file but sends Claude Code-style payloads.
test('applyCopilot: VS Code Copilot Chat events (PascalCase, snake_case fields)', () => {
  const log = createActivityLog();
  const vs = (name, secs, extra) => ({ hook_event_name: name, session_id: 'vs1', cwd: '/work/proj', timestamp: new Date(1_700_000_000_000 + secs * 1000).toISOString(), ...extra });
  const p = applyCopilot(vs('UserPromptSubmit', 0, { prompt: 'rename the class' }), log);
  assert.equal(p.session, 'copilot:vs1');
  assert.equal(p.label, 'proj');
  assert.equal(p.entries[0].kind, 'prompt');
  assert.equal(p.state.state, 'thinking');

  const run = applyCopilot(vs('PostToolUse', 1, { tool_name: 'run_in_terminal', tool_input: { command: 'dotnet test', explanation: 'Run the tests' }, tool_response: [{ value: 'Passed!' }] }), log).entries[0];
  assert.equal(run.kind, 'run');
  assert.equal(run.title, 'Run the tests');
  assert.equal(run.body.output, 'Passed!');

  const edit = applyCopilot(vs('PostToolUse', 2, { tool_name: 'replace_string_in_file', tool_input: { filePath: '/work/proj/src/a.cs', oldString: 'class A', newString: 'class B' }, tool_response: 'ok' }), log).entries[0];
  assert.equal(edit.kind, 'edit');
  assert.equal(edit.title, 'src/a.cs');
  assert.match(edit.body.patch, /^-class A$/m);

  const read = applyCopilot(vs('PostToolUse', 3, { tool_name: 'read_file', tool_input: { filePath: '/work/proj/README.md' } }), log).entries[0];
  assert.equal(read.kind, 'read');

  // multi_replace_string_in_file: every file and replacement is kept.
  const multi = applyCopilot(vs('PostToolUse', 3.5, { tool_name: 'multi_replace_string_in_file', tool_input: { explanation: 'Rename', replacements: [
    { filePath: '/work/proj/src/a.cs', oldString: 'Foo()', newString: 'Bar()' },
    { filePath: '/work/proj/test/a.test.cs', oldString: 'Assert.Equal(1, Foo());', newString: '' },
  ] }, tool_response: 'ok' }), log).entries[0];
  assert.equal(multi.kind, 'edit');
  assert.deepEqual(multi.files.map((f) => f.path), ['/work/proj/src/a.cs', '/work/proj/test/a.test.cs']);
  assert.match(multi.title, /src\/a\.cs \+1 more/);
  assert.match(multi.body.patch, /^-Assert\.Equal\(1, Foo\(\)\);$/m);

  // apply_patch: the files come from the patch, which is kept whole.
  const patch = '*** Begin Patch\n*** Update File: /work/proj/src/a.cs\n@@\n-class A\n+class C\n*** Add File: /work/proj/src/b.cs\n+class B\n*** End Patch';
  const applied = applyCopilot(vs('PostToolUse', 3.7, { tool_name: 'apply_patch', tool_input: { input: patch, explanation: 'Patch' } }), log).entries[0];
  assert.deepEqual(applied.files, [{ path: '/work/proj/src/a.cs', change: 'edit' }, { path: '/work/proj/src/b.cs', change: 'write' }]);
  assert.equal(applied.body.patch, patch);

  // A terminal command that exited non-zero is a failure, with its output kept.
  const bad = applyCopilot(vs('PostToolUse', 4, { tool_name: 'run_in_terminal', tool_input: { command: 'dotnet test' }, tool_response: 'Failed: 1\nCommand exited with code 1' }), log).entries[0];
  assert.equal(bad.status, 'failed');
  assert.match(bad.body.output, /Failed: 1/);
  const marker = applyCopilot(vs('PostToolUse', 4.5, { tool_name: 'run_in_terminal', tool_input: { command: 'npm test' }, tool_response: 'boom\n<exited with exit code 2>' }), log).entries[0];
  assert.equal(marker.status, 'failed');
  const zero = applyCopilot(vs('PostToolUse', 4.6, { tool_name: 'run_in_terminal', tool_input: { command: 'true' }, tool_response: 'done\n<exited with exit code 0>' }), log).entries[0];
  assert.equal(zero.status, 'ok');

  const stop = applyCopilot(vs('Stop', 5, {}), log);
  assert.equal(stop.entries.find((e) => e.kind === 'done').ms, 5000);
  assert.equal(stop.state.state, 'done');

  // Copilot CLI payloads are untouched.
  assert.equal(applyCopilot({ hook_event_name: 'sessionStart', sessionId: 'cli', cwd: '/w' }, log).session, 'copilot:cli');
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
