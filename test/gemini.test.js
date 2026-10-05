import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActivityLog } from '../bridge/activity.js';
import gemini, { applyGemini, describeTool, EVENTS } from '../bridge/adapters/gemini.js';
import { buildTurns } from '../bridge/ui/recap.js';
import { readiness, testVerdict, weakenedTests } from '../bridge/ui/story.js';

// Payloads as documented at https://geminicli.com/docs/hooks/reference/.
const base = { session_id: 's1', transcript_path: '', cwd: '/work/proj' };
const ev = (name, secs, extra) => ({ ...base, hook_event_name: name, timestamp: new Date(1_700_000_000_000 + secs * 1000).toISOString(), ...extra });

test('describeTool: Gemini CLI tools', () => {
  assert.equal(describeTool('run_shell_command', { command: 'npm test', description: 'Run the tests' }, '/work/proj').title, 'Run the tests');
  const edit = describeTool('replace', { file_path: '/work/proj/a.js', old_string: 'x', new_string: 'y' }, '/work/proj');
  assert.equal(edit.kind, 'edit');
  assert.equal(edit.title, 'a.js');
  assert.equal(describeTool('write_file', { file_path: '/work/proj/b.js', content: 'hi' }, '/work/proj').kind, 'write');
  assert.equal(describeTool('grep_search', { pattern: 'TODO' }).kind, 'search');
  assert.equal(describeTool('google_web_search', { query: 'node test runner' }).kind, 'web');
  assert.equal(describeTool('mcp_github_list_issues', {}).kind, 'mcp');
  assert.deepEqual(describeTool('write_todos', { todos: [{ description: 'a', status: 'in_progress' }] }).plan, [{ text: 'a', status: 'in_progress' }]);
});

test('applyGemini: a turn with a tool call, paired without call ids', () => {
  const log = createActivityLog();
  const prompt = applyGemini(ev('BeforeAgent', 0, { prompt: 'add a test' }), log);
  assert.equal(prompt.session, 'gemini:s1');
  assert.equal(prompt.label, 'proj');
  assert.equal(prompt.entries[0].kind, 'prompt');

  const input = { command: 'npm test' };
  const before = applyGemini(ev('BeforeTool', 1, { tool_name: 'run_shell_command', tool_input: input }), log);
  assert.equal(before.entries[0].status, 'running');
  assert.equal(before.state.state, 'working');

  applyGemini(ev('Notification', 1.5, { notification_type: 'ToolPermission', message: 'Allow npm test?', details: {} }), log);
  assert.equal(log.get(before.entries[0].id).status, 'waiting');

  const after = applyGemini(ev('AfterTool', 4, { tool_name: 'run_shell_command', tool_input: input, tool_response: { llmContent: 'ok', returnDisplay: '3 passing' } }), log).entries[0];
  assert.equal(after.id, before.entries[0].id);
  assert.equal(after.status, 'ok');
  assert.equal(after.ms, 3000);
  assert.equal(after.body.output, '3 passing');

  const failed = applyGemini(ev('BeforeTool', 5, { tool_name: 'read_file', tool_input: { file_path: '/work/proj/x' } }), log).entries[0];
  applyGemini(ev('AfterTool', 6, { tool_name: 'read_file', tool_input: { file_path: '/work/proj/x' }, tool_response: { error: { message: 'not found' } } }), log);
  assert.equal(log.get(failed.id).status, 'failed');

  const end = applyGemini(ev('AfterAgent', 8, { prompt: 'add a test', prompt_response: 'Added one.', stop_hook_active: false }), log);
  const done = end.entries.find((e) => e.kind === 'done');
  assert.equal(done.summary, 'Added one.');
  assert.equal(done.ms, 8000);
  assert.equal(end.state.state, 'done');
});

test('applyGemini: a shell command’s exit code counts; a test edited to pass is caught', () => {
  const log = createActivityLog();
  const g = (name, secs, extra) => ({ ...ev(name, secs, extra), session_id: 's2' });
  const shell = (secs, llmContent, returnDisplay) => {
    const input = { command: 'npm test' };
    const before = applyGemini(g('BeforeTool', secs, { tool_name: 'run_shell_command', tool_input: input }), log).entries[0];
    applyGemini(g('AfterTool', secs + 1, { tool_name: 'run_shell_command', tool_input: input, tool_response: { llmContent, returnDisplay } }), log);
    return log.get(before.id);
  };
  applyGemini(g('BeforeAgent', 0, { prompt: 'make the tests pass' }), log);
  // What run_shell_command tells the model: "Exit Code" only when it isn't 0.
  const crash = "Error: Cannot find module './math'";
  const failing = shell(1, `Output: ${crash}\nExit Code: 1`, crash);
  assert.equal(failing.status, 'failed');
  assert.match(failing.body.output, /Exit Code: 1$/);
  assert.equal(testVerdict(failing).state, 'failed');
  applyGemini(g('BeforeTool', 3, { tool_name: 'replace', tool_input: { file_path: '/work/proj/test/math.test.js', old_string: "test('subtracts', () => {\n  assert.equal(subtract(1, 2), -1);\n});", new_string: "test('subtracts', () => {\n});" } }), log);
  applyGemini(g('AfterTool', 4, { tool_name: 'replace', tool_input: { file_path: '/work/proj/test/math.test.js', old_string: "test('subtracts', () => {\n  assert.equal(subtract(1, 2), -1);\n});", new_string: "test('subtracts', () => {\n});" }, tool_response: { llmContent: 'Successfully modified file', returnDisplay: '' } }), log);
  const passing = shell(5, 'Output: all good', 'all good');
  assert.equal(passing.status, 'ok');
  assert.equal(testVerdict(passing).state, 'passed');
  // You cancelled it: it didn't finish.
  assert.equal(shell(7, 'Command was cancelled by user before it could complete. Below is the output before it was cancelled:\n✔ adds', '✔ adds').status, 'stopped');
  applyGemini(g('AfterAgent', 9, { prompt: 'make the tests pass', prompt_response: 'Done.' }), log);
  const [turn] = buildTurns(log.all().filter((e) => e.session === 'gemini:s2'));
  assert.match(weakenedTests(turn.steps).text, /removed 1 assertion in math\.test\.js/);
  assert.equal(readiness(turn).ready, false);
});

test('Gemini connect merges into settings.json and disconnect restores it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-gemini-'));
  process.env.DOTPALS_GEMINI_DIR = dir;
  t.after(async () => { delete process.env.DOTPALS_GEMINI_DIR; await rm(dir, { recursive: true, force: true }); });
  const file = join(dir, 'settings.json');
  const mine = { theme: 'Dracula', hooks: { BeforeTool: [{ matcher: 'write_file', hooks: [{ type: 'command', command: './check.sh' }] }] } };
  await writeFile(file, JSON.stringify(mine));

  const result = gemini.connect();
  assert.ok(result.backup);
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(after.theme, 'Dracula');
  assert.equal(after.hooks.BeforeTool.length, 2);
  for (const event of EVENTS) {
    const group = after.hooks[event].at(-1);
    assert.equal(group.matcher, '*');
    assert.equal(group.hooks[0].type, 'command');
    assert.match(group.hooks[0].command, /bridge\/hook\.js" gemini$/);
  }
  assert.equal(gemini.connected(), true);

  gemini.disconnect();
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), mine);
  assert.equal(gemini.connected(), false);

  // No settings file yet: connect creates one, disconnect leaves an empty object.
  await rm(file);
  gemini.connect();
  gemini.disconnect();
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {});
});
