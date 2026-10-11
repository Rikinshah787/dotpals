import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createActivityLog } from '../bridge/activity.js';
import { codexHooks, describeCall, watchCodex } from '../bridge/adapters/codex.js';
import { buildTurns } from '../bridge/ui/recap.js';
import { readiness, stepType, testVerdict, weakenedTests, whyStopped } from '../bridge/ui/story.js';

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

// -- what the rules need from Codex: real test results, failed patches, interrupted turns --
// Synthetic logs in the format Codex writes (exec_command's "Chunk ID / Wall time / Process
// … / Output:" header, write_stdin and wait for a command still running, turn_aborted).

const SESSION = 'codex:sess-2';
/** Write a session log, follow it until its turns end, and give back the log. */
async function followLog(t, lines) {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-codex-'));
  let stop = () => {};
  t.after(async () => {
    stop();
    await sleep(150);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const now = new Date();
  const folder = join(dir, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  await mkdir(folder, { recursive: true });
  const meta = { timestamp: lines[0].timestamp, type: 'session_meta', payload: { id: 'sess-2', cwd: '/work/proj' } };
  await writeFile(join(folder, 'rollout-y.jsonl'), `${[meta, ...lines].map((l) => JSON.stringify(l)).join('\n')}\n`);
  const log = createActivityLog();
  stop = watchCodex(log, { dir, interval: 50, emit: () => {}, state: () => {} });
  const ends = () => log.all().filter((e) => e.kind === 'done' || e.kind === 'error').length;
  const want = lines.filter((l) => ['task_complete', 'turn_aborted'].includes(l.payload.type)).length;
  for (let i = 0; i < 40 && ends() < want; i++) await sleep(50);
  stop();
  return log;
}
const start = Date.now() - 60_000;
const ts = (s) => new Date(start + s * 1000).toISOString();
const item = (s, payload) => ({ timestamp: ts(s), type: 'response_item', payload });
const event = (s, payload) => ({ timestamp: ts(s), type: 'event_msg', payload });
const prompt = (s, text) => item(s, { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const call = (s, id, name, args) => item(s, { type: 'function_call', name, arguments: JSON.stringify(args), call_id: id });
const result = (s, id, output) => item(s, { type: 'function_call_output', call_id: id, output });
const custom = (s, id, name, input) => item(s, { type: 'custom_tool_call', name, input, call_id: id });
const customResult = (s, id, output) => item(s, { type: 'custom_tool_call_output', call_id: id, output });
/** exec_command's and write_stdin's output: a header, then what the command printed. */
const chunk = (status, output) => `Chunk ID: 1a2b3c\nWall time: 10.0021 seconds\n${status}\nOriginal token count: 40\nOutput:\n${output}`;

test('Codex: a long test run’s real result counts, from the check that saw it end', async (t) => {
  const log = await followLog(t, [
    prompt(1, 'fix subtract'),
    call(2, 'c1', 'exec_command', { cmd: 'npm test', yield_time_ms: 10000 }),
    result(12, 'c1', chunk('Process running with session ID 4242', '> proj@1.0.0 test\n> node --test\n\n✔ adds (1.1ms)\n')),
    call(13, 'c2', 'write_stdin', { session_id: 4242, chars: '', yield_time_ms: 30000 }),
    result(15, 'c2', chunk('Process exited with code 1', '✖ subtracts (2.3ms)\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n3 !== -1\n\nℹ tests 2\nℹ suites 0\nℹ pass 1\nℹ fail 1\n')),
    event(16, { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'Done.' }),
  ]);
  const run = log.get(`${SESSION}:c1`);
  assert.equal(run.status, 'failed');
  assert.equal(run.ms, 13000);
  assert.match(run.body.output, /✔ adds/);
  assert.match(run.body.output, /ℹ fail 1/);
  const v = testVerdict(run);
  assert.equal(v.state, 'failed');
  assert.equal(v.source, 'output');
  // The check on it isn't a step of its own.
  assert.equal(log.get(`${SESSION}:c2`), undefined);
  assert.equal(log.all().filter((e) => e.kind === 'run' && stepType(e) === 'test').length, 1);
});

test('Codex: a command still running when the turn ends didn’t finish; Ctrl-C stops one', async (t) => {
  const log = await followLog(t, [
    prompt(1, 'run the tests'),
    call(2, 'c1', 'exec_command', { cmd: 'npm test' }),
    result(12, 'c1', chunk('Process running with session ID 77', '✔ adds (1.1ms)\n')),
    event(13, { type: 'task_complete', turn_id: 'turn-1' }),
    prompt(20, 'stop the server'),
    call(21, 'c3', 'exec_command', { cmd: 'npm run dev' }),
    result(31, 'c3', chunk('Process running with session ID 88', 'listening on :3000\n')),
    call(32, 'c4', 'write_stdin', { session_id: 88, chars: '\u0003' }),
    result(33, 'c4', chunk('Process exited with code 1', '')),
    event(34, { type: 'task_complete', turn_id: 'turn-2' }),
  ]);
  const tests = log.get(`${SESSION}:c1`);
  assert.equal(tests.status, 'stopped');
  assert.equal(testVerdict(tests).state, 'unclear');
  assert.equal(log.get(`${SESSION}:c3`).status, 'stopped');
  assert.equal(log.get(`${SESSION}:c4`), undefined);
});

test('Codex: a patch that didn’t apply is a failed edit, and an interrupted turn still ends', async (t) => {
  const bad = '*** Begin Patch\n*** Update File: src/math.js\n@@\n-return a + b\n+return a - b\n*** End Patch';
  const good = '*** Begin Patch\n*** Update File: src/math.js\n@@\n-return a + b;\n+return a - b;\n*** End Patch';
  const log = await followLog(t, [
    prompt(1, 'fix subtract'),
    custom(2, 'p1', 'apply_patch', bad),
    customResult(3, 'p1', 'apply_patch verification failed: Failed to find expected lines in /work/proj/src/math.js:\nreturn a + b'),
    custom(4, 'p2', 'apply_patch', good),
    customResult(5, 'p2', 'Exit code: 0\nWall time: 0.2 seconds\nOutput:\nSuccess. Updated the following files:\nM src/math.js\n'),
    call(6, 'c1', 'exec_command', { cmd: 'npm test' }),
    customResult(8, 'c1', 'Wall time: 1.9 seconds\naborted by user'),
    event(9, { type: 'turn_aborted', turn_id: 'turn-1', reason: 'interrupted', duration_ms: 8000 }),
  ]);
  assert.equal(log.get(`${SESSION}:p1`).status, 'failed');
  assert.equal(log.get(`${SESSION}:p2`).status, 'ok');
  // The test run it was in the middle of didn't finish: not a pass.
  assert.equal(log.get(`${SESSION}:c1`).status, 'stopped');
  assert.equal(testVerdict(log.get(`${SESSION}:c1`)).state, 'unclear');

  const [turn] = buildTurns(log.all());
  assert.ok(turn.end, 'the turn has an end');
  assert.equal(turn.end.kind, 'done');
  assert.equal(turn.end.status, 'stopped');
  assert.equal(turn.end.ms, 8000);
  assert.equal(whyStopped(turn).kind, 'cut');
  // Ended, so it's reviewed: code changed and no test run finished after it.
  assert.equal(readiness(turn).ready, false);
});

test('Codex: a test run inside a script reads as one; a failing script fails', async (t) => {
  const script = (cmd) => `const r = await tools.exec_command({"cmd":${JSON.stringify(cmd)},"workdir":"/work/proj","yield_time_ms":10000});\ntext(r.output);\n`;
  const scriptResult = (s, id, head, text) => customResult(s, id, [{ type: 'input_text', text: head }, { type: 'input_text', text }]);
  const log = await followLog(t, [
    prompt(1, 'run the tests'),
    custom(2, 'x1', 'exec', script('npm test')),
    scriptResult(5, 'x1', 'Script completed\nWall time 3.1 seconds\nOutput:\n', 'Tests:       1 failed, 3 passed, 4 total\n'),
    // Still running after its wait: `wait` on its cell brings the rest.
    custom(6, 'x2', 'exec', script('npx jest')),
    scriptResult(16, 'x2', 'Script running with cell ID 28\nWall time 10.0 seconds\nOutput:\n', ''),
    call(17, 'w1', 'wait', { cell_id: '28', yield_time_ms: 10000 }),
    result(20, 'w1', [{ type: 'input_text', text: 'Script completed\nWall time 2.0 seconds\nOutput:\n' }, { type: 'input_text', text: 'Tests:       2 failed, 2 passed, 4 total\n' }]),
    // A patch written in a script that didn't apply.
    custom(21, 'x3', 'exec', 'const patch = "*** Begin Patch\\n*** Update File: src/a.js\\n@@\\n-a\\n+b\\n*** End Patch";\nawait tools.apply_patch(patch);\n'),
    scriptResult(22, 'x3', 'Script failed\nWall time 0.1 seconds\nOutput:\n', 'Script error:\napply_patch verification failed: Failed to find expected lines in /work/proj/src/a.js:\na'),
    // The script printed only the output, with no summary: how it exited isn't known.
    custom(24, 'x4', 'exec', script('python -m pytest -q')),
    scriptResult(25, 'x4', 'Script completed\nWall time 0.2 seconds\nOutput:\n', 'python.exe: No module named pytest'),
    // …or printed the whole result, exit code and all.
    custom(26, 'x5', 'exec', script('python -m pytest -q').replace('text(r.output)', 'text(JSON.stringify(r))')),
    scriptResult(27, 'x5', 'Script completed\nWall time 0.2 seconds\nOutput:\n', '{"chunk_id":"9f8e7d","wall_time_seconds":0.13,"exit_code":1,"original_token_count":9,"output":"python.exe: No module named pytest\\n"}'),
    event(28, { type: 'task_complete', turn_id: 'turn-1' }),
  ]);
  const run = log.get(`${SESSION}:x1`);
  assert.equal(run.body.command, 'npm test');
  assert.equal(run.title, 'npm test');
  assert.match(run.body.args, /tools\.exec_command/);
  assert.equal(stepType(run), 'test');
  assert.equal(testVerdict(run).state, 'failed');
  const waited = log.get(`${SESSION}:x2`);
  assert.equal(stepType(waited), 'test');
  assert.equal(testVerdict(waited).summary, '2 failed, 2 passed');
  assert.equal(log.get(`${SESSION}:w1`), undefined);
  const patch = log.get(`${SESSION}:x3`);
  assert.equal(patch.kind, 'edit');
  assert.equal(patch.status, 'failed');
  // Not a pass: the script finishing says nothing about how pytest exited.
  assert.equal(testVerdict(log.get(`${SESSION}:x4`)).state, 'unclear');
  assert.equal(testVerdict(log.get(`${SESSION}:x4`)).reason, 'no-exit-code');
  const shown = log.get(`${SESSION}:x5`);
  assert.equal(shown.status, 'failed');
  assert.equal(testVerdict(shown).state, 'failed');
});

test('Codex: a test changed to pass between a failing and a passing run is caught', async (t) => {
  const weaken = "*** Begin Patch\n*** Update File: test/math.test.js\n@@\n test('subtracts', () => {\n-  assert.equal(subtract(1, 2), -1);\n });\n*** End Patch";
  const log = await followLog(t, [
    prompt(1, 'make the tests pass'),
    call(2, 'c1', 'exec_command', { cmd: 'npm test' }),
    result(12, 'c1', chunk('Process running with session ID 5', '✔ adds (1ms)\n')),
    call(13, 'c2', 'write_stdin', { session_id: 5, chars: '' }),
    result(14, 'c2', chunk('Process exited with code 1', '✖ subtracts (2ms)\nℹ tests 2\nℹ pass 1\nℹ fail 1\n')),
    custom(15, 'p1', 'apply_patch', weaken),
    customResult(16, 'p1', 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\nSuccess. Updated the following files:\nM test/math.test.js\n'),
    call(17, 'c3', 'exec_command', { cmd: 'npm test' }),
    result(18, 'c3', chunk('Process exited with code 0', '✔ adds (1ms)\n✔ subtracts (1ms)\nℹ tests 2\nℹ pass 2\nℹ fail 0\n')),
    event(19, { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'All tests pass.' }),
  ]);
  const [turn] = buildTurns(log.all());
  assert.equal(testVerdict(log.get(`${SESSION}:c1`)).state, 'failed');
  assert.equal(testVerdict(log.get(`${SESSION}:c3`)).state, 'passed');
  const weak = weakenedTests(turn.steps);
  assert.ok(weak, 'caught');
  assert.match(weak.text, /removed 1 assertion in math\.test\.js/);
  assert.equal(readiness(turn).ready, false);
});

test('Codex: the fix loop’s hook goes into ~/.codex/hooks.json beside yours, and comes out alone', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-codexhooks-'));
  const was = process.env.DOTPALS_CODEX_HOME;
  process.env.DOTPALS_CODEX_HOME = dir;
  t.after(async () => {
    if (was === undefined) delete process.env.DOTPALS_CODEX_HOME; else process.env.DOTPALS_CODEX_HOME = was;
    await rm(dir, { recursive: true, force: true });
  });
  const file = join(dir, 'hooks.json');
  const theirs = { description: 'mine', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'python notify.py' }] }], PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'policy.sh' }] }] } };
  await writeFile(file, JSON.stringify(theirs));
  assert.equal(codexHooks.installed(), null);

  const added = codexHooks.connect();
  codexHooks.connect(); // twice: still once
  assert.equal(added.file, file);
  assert.deepEqual(JSON.parse(await readFile(added.backup, 'utf8')), theirs);
  assert.match(added.note, /\/hooks/);
  const config = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(config.description, 'mine');
  const ours = (event) => config.hooks[event].filter((g) => g.hooks.some((h) => /loop-hook\.js" codex$/.test(h.command)));
  for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) assert.equal(ours(event).length, 1, event);
  assert.deepEqual(config.hooks.Stop[0], theirs.hooks.Stop[0]);
  assert.equal(ours('PostToolUse')[0].matcher, '^Bash$');
  assert.match(codexHooks.installed(), /loop-hook\.js" codex$/);

  codexHooks.disconnect();
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), theirs);
  assert.equal(codexHooks.installed(), null);
  // A hooks.json it can't read is left alone.
  await writeFile(file, '{ not json');
  assert.throws(() => codexHooks.connect(), /wasn’t changed/);
  assert.equal(await readFile(file, 'utf8'), '{ not json');
});
