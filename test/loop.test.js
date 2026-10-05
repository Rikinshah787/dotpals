import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, get } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep the bridge away from the real home folder: no Codex watcher, no history file.
process.env.DOTPALS_CODEX = '0';
process.env.DOTPALS_CLAUDE_LOGS = '0';
process.env.DOTPALS_HISTORY = '0';
const home = await mkdtemp(join(tmpdir(), 'dotpals-loop-'));
process.env.DOTPALS_HOME = home;
after(() => rm(home, { recursive: true, force: true }));
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
const tick = () => new Promise((r) => setTimeout(r, 5)); // steps a few ms apart, so "after the tests" is clear

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

const FAILED = 'Exit code 1\n✖ sum adds two numbers\nℹ tests 2\nℹ pass 1\nℹ fail 1';
const PASSED = '✔ sum adds two numbers\n✔ multiply\nℹ tests 2\nℹ pass 2\nℹ fail 0';

/** A Claude Code session, as its hooks report it: the activity hook (/hook) and the fix loop (/hook?loop=1). */
function claude(port, session, cwd = '/w/app') {
  const base = `http://127.0.0.1:${port}`;
  const post = (path, e) => fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify({ session_id: session, cwd, ...e }) }).then((r) => r.json());
  let n = 0;
  const s = {
    observe: (e) => post('/hook', e),
    loop: (e) => post('/hook?loop=1', e),
    prompt: (text = 'fix it') => s.observe({ hook_event_name: 'UserPromptSubmit', prompt: text }),
    async edit(file, old_string = 'a', new_string = 'b') {
      const e = { tool_name: 'Edit', tool_use_id: `ed${++n}`, tool_input: { file_path: `/w/app/${file}`, old_string, new_string } };
      await s.observe({ ...e, hook_event_name: 'PreToolUse' });
      await s.observe({ ...e, hook_event_name: 'PostToolUse', tool_response: {} });
      await tick();
    },
    /** A command that ends: reported by the activity hook, and answered by the fix loop. */
    async run(command, { ok = true, output = '' } = {}) {
      const e = { tool_name: 'Bash', tool_use_id: `run${++n}`, tool_input: { command } };
      await s.observe({ ...e, hook_event_name: 'PreToolUse' });
      const end = ok ? { ...e, hook_event_name: 'PostToolUse', tool_response: { stdout: output, stderr: '' } } : { ...e, hook_event_name: 'PostToolUseFailure', error: output };
      const [reply] = await Promise.all([s.loop(end), s.observe(end)]);
      await tick();
      return reply;
    },
    stop: () => Promise.all([s.loop({ hook_event_name: 'Stop', stop_hook_active: false }), s.observe({ hook_event_name: 'Stop' })]).then(([reply]) => reply),
    ship: (command = 'git commit -m "done"') => s.loop({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: `ship${++n}`, tool_input: { command } }),
  };
  return s;
}

test('a test run that fails: Claude is told at once; one that passes, or another command: nothing', async (t) => {
  const { port, server } = await start();
  t.after(() => close(server));
  const events = await loopEvents(port);
  t.after(events.stop);
  const s = claude(port, 'told');
  await s.prompt();
  await s.edit('math.js');

  const told = await s.run('npm test', { ok: false, output: FAILED });
  assert.equal(told.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  assert.match(told.hookSpecificOutput.additionalContext, /^dotpals: this test run failed \(1 failed, 1 passed.*\)\. Fix it before you finish; dotpals checks again when you stop\.$/);
  // The error can also come as { message, stdout, stderr }: the counts are read from it all the same.
  const asObject = await s.loop({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'obj1', tool_input: { command: 'npm test' }, error: { message: 'Exit code 1', stdout: FAILED.slice('Exit code 1\n'.length) } });
  assert.match(asObject.hookSpecificOutput.additionalContext, /this test run failed \(1 failed, 1 passed/);
  // Failed tests in a run that exited 0 count too (the output's own summary decides).
  const fromOutput = await s.run('npm test', { output: 'not ok 1 - sum adds\nℹ tests 2\nℹ pass 1\nℹ fail 1' });
  assert.equal(fromOutput.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(fromOutput.hookSpecificOutput.additionalContext, /this test run failed \(1 failed, 1 passed/);

  assert.deepEqual(await s.run('ls -la'), {}, 'not a test run');
  assert.deepEqual(await s.run('git status'), {});
  // Unclear (the exit code says passed, the output shows errors), and no checker: run them again.
  const again = await s.run('npm test', { output: 'Traceback (most recent call last):\nImportError: no module' });
  assert.match(again.hookSpecificOutput.additionalContext, /^dotpals: can’t tell whether this test run passed: .+\. Run the tests again without cutting their output/);
  // It passes now: nothing for Claude, "Fixed" for you.
  assert.deepEqual(await s.run('npm test', { output: PASSED }), {});

  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(events.list.map((e) => e.kind), ['told', 'told', 'told', 'retry', 'fixed']);
  assert.equal(events.list[0].session, 'told');
  assert.equal(events.list[0].label, 'app');
  assert.match(events.list[0].text, /^Tests failed \(.+\)\. Told Claude to fix them\.$/);
  assert.equal(events.list.at(-1).text, 'Fixed: tests pass now ✓');
});

test('an unclear test run: the checker you chose decides (a fake Laya that says they failed)', async (t) => {
  const laya = createServer((req, res) => {
    req.resume();
    req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: 'laya', answers: { 'done.met': { type: 'noul', noul: 0.1 } } })));
  });
  await new Promise((r) => laya.listen(0, '127.0.0.1', r));
  const { port, server } = await start();
  const setConfig = (patch) => fetch(`http://127.0.0.1:${port}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dotpals': '1' }, body: JSON.stringify(patch) });
  t.after(async () => { await setConfig({ checker: { mode: 'off', localUrl: 'http://127.0.0.1:8000' } }); await close(server); await new Promise((r) => laya.close(r)); });
  await setConfig({ checker: { mode: 'local', localUrl: `http://127.0.0.1:${laya.address().port}` } });
  const s = claude(port, 'checked');
  await s.prompt();
  await s.edit('math.js');
  const told = await s.run('npm test', { output: 'Traceback (most recent call last):\nImportError: no module' });
  assert.equal(told.hookSpecificOutput.additionalContext, 'dotpals: Laya (dotpals’ local test checker) thinks this test run failed (90% sure): ImportError: no module. Fix it before you finish; dotpals checks again when you stop.');
});

test('Stop: sent back while the tests fail or are out of date, at most twice per request', async (t) => {
  const { port, server } = await start();
  t.after(() => close(server));
  const events = await loopEvents(port);
  t.after(events.stop);

  // Failing.
  const s = claude(port, 'stop');
  await s.prompt();
  await s.edit('math.js');
  await s.run('npm test', { ok: false, output: FAILED });
  const first = await s.stop();
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /^dotpals: the tests are failing \(.+\)\. Fix them and run the tests again before you finish\.$/);
  assert.equal((await s.stop()).decision, 'block');
  // Twice is enough: Claude may stop now, and you're told the tests still fail.
  assert.deepEqual(await s.stop(), {});
  // Your next prompt starts the count again.
  await s.prompt('try again');
  await s.edit('math.js');
  await s.run('npm test', { ok: false, output: FAILED });
  assert.equal((await s.stop()).decision, 'block');

  // Changed after the last test run.
  const stale = claude(port, 'stale');
  await stale.prompt();
  await stale.run('npm test', { output: PASSED });
  await stale.edit('src/b.js');
  const back = await stale.stop();
  assert.equal(back.decision, 'block');
  assert.equal(back.reason, 'dotpals: you changed b.js after the last test run. Run the tests again before you finish.');

  // Changed code without running the tests, in a session that has run them before: run them (how it ran them, without the pipe).
  const skipped = claude(port, 'skipped');
  await skipped.prompt('how do the tests look?');
  await skipped.run('npm test 2>&1 | tail -n 3', { output: PASSED });
  await skipped.prompt('add divide to math.js');
  await skipped.edit('math.js');
  const run = await skipped.stop();
  assert.equal(run.decision, 'block');
  assert.equal(run.reason, 'dotpals: you changed math.js but didn’t run the tests. Run `npm test` before you finish.');

  // No tests at all (not every project has them), or tests that pass: Claude stops as usual.
  const untested = claude(port, 'untested');
  await untested.prompt();
  await untested.edit('c.js');
  assert.deepEqual(await untested.stop(), {});
  const passing = claude(port, 'passing');
  await passing.prompt();
  await passing.edit('d.js');
  await passing.run('npm test', { output: PASSED });
  assert.deepEqual(await passing.stop(), {});
  // Only this request counts: the tests that failed before the last prompt don't.
  const earlier = claude(port, 'earlier');
  await earlier.prompt();
  await earlier.run('npm test', { ok: false, output: FAILED });
  await earlier.prompt('now update the readme');
  assert.deepEqual(await earlier.stop(), {});

  await new Promise((r) => setTimeout(r, 100));
  const kinds = (session) => events.list.filter((e) => e.session === session).map((e) => e.kind);
  assert.deepEqual(kinds('stop'), ['told', 'sent-back', 'sent-back', 'gave-up', 'told', 'sent-back']);
  assert.match(events.list.find((e) => e.kind === 'gave-up').text, /^Claude stopped, but the tests still fail \(1 failed, 1 passed.*\)\.$/);
  assert.deepEqual(kinds('stale'), ['sent-back']);
  assert.equal(events.list.find((e) => e.session === 'skipped' && e.kind === 'sent-back').text, 'Claude changed math.js without running the tests. Sent it back to run `npm test`.');
  assert.deepEqual(kinds('untested'), []);
  assert.deepEqual(kinds('passing'), []);
});

test('a test result nobody can read: Claude runs them again; the second time, or stopping without one, goes to you', async (t) => {
  const { port, server } = await start();
  t.after(() => close(server));
  const events = await loopEvents(port);
  t.after(events.stop);
  const PIPED = { output: "    operator: 'strictEqual',\n    diff: 'simple'\n  }" };

  const s = claude(port, 'piped');
  await s.prompt();
  const first = await s.run('npm test 2>&1 | tail -n 3', PIPED);
  assert.match(first.hookSpecificOutput.additionalContext, /^dotpals: can’t tell whether this test run passed: its output went through a pipe.+Run the tests again without cutting their output \(no \| tail, head or grep\), so the counts and the exit code show\.$/);
  const second = await s.run('npm test 2>&1 | tail -n 3', PIPED);
  assert.equal(second.hookSpecificOutput.additionalContext, 'dotpals: still can’t tell whether the tests passed, so it asked the user to take a look. Tell them what you ran and what you saw.');
  assert.deepEqual(await s.run('npm test 2>&1 | tail -n 3', PIPED), {}, 'asked once is enough');
  // Your next prompt starts again.
  await s.prompt('try again');
  assert.match((await s.run('npm test | tail -n 3', PIPED)).hookSpecificOutput.additionalContext, /Run the tests again/);

  // Asked to run them again, and stops without a clear result: you're asked, Claude isn't held up.
  const quiet = claude(port, 'quiet');
  await quiet.prompt();
  await quiet.run('npm test | tail -n 3', PIPED);
  assert.deepEqual(await quiet.stop(), {});
  // Ran them again and they're clear: nothing for you.
  const clear = claude(port, 'clear');
  await clear.prompt();
  await clear.run('npm test | tail -n 3', PIPED);
  await clear.run('npm test', { output: PASSED });
  assert.deepEqual(await clear.stop(), {});

  await new Promise((r) => setTimeout(r, 100));
  const kinds = (session) => events.list.filter((e) => e.session === session).map((e) => e.kind);
  assert.deepEqual(kinds('piped'), ['retry', 'ask-you', 'retry']);
  assert.equal(events.list.find((e) => e.kind === 'ask-you').text, 'Couldn’t tell whether Claude’s tests passed: `npm test 2>&1 | tail -n 3`: its output went through a pipe, so the exit code isn’t the tests’. Please take a look.');
  assert.deepEqual(kinds('quiet'), ['retry', 'ask-you']);
  assert.deepEqual(kinds('clear'), ['retry']);
});

test('why it failed, from the output: in what Claude is told, what the pal says, and the Stop and commit reasons', async (t) => {
  const { port, server } = await start();
  t.after(() => close(server));
  const events = await loopEvents(port);
  t.after(events.stop);
  // node --test, as Claude Code sends it when npm test exits 1: the output comes with the error.
  const NODE = '✖ sum adds two numbers (1.2ms)\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n  -1 !== 3\n\n      at TestContext.<anonymous> (file:///C:/w/app/test/math.test.js:5:10)\n      at Test.runInAsyncScope (node:internal/test_runner/test:1004:9) {\n    actual: -1,\n    expected: 3,\n    operator: \'strictEqual\'\n  }\nℹ tests 2\nℹ pass 1\nℹ fail 1';
  const s = claude(port, 'why');
  await s.prompt();
  await s.edit('math.js');
  const told = await s.run('npm test', { ok: false, output: NODE });
  assert.match(told.hookSpecificOutput.additionalContext, /^dotpals: this test run failed \(1 failed, 1 passed.*\): expected 3, got -1 \(test\/math\.test\.js:5\)\. Fix it before you finish/);
  assert.match((await s.stop()).reason, /^dotpals: the tests are failing \(.+\): expected 3, got -1 \(test\/math\.test\.js:5\)\. Fix them/);
  assert.match((await s.ship()).hookSpecificOutput.permissionDecisionReason, /: expected 3, got -1 \(test\/math\.test\.js:5\)\. Fix them and run the tests again before you commit or push\.$/);

  await new Promise((r) => setTimeout(r, 100));
  assert.match(events.list[0].text, /^Tests failed \(.+\): expected 3, got -1 \(test\/math\.test\.js:5\)\. Told Claude to fix them\.$/);
});

test('the bluff: green because Claude changed the tests, not the code: told, you hear about it, sent back once', async (t) => {
  const { port, server } = await start();
  t.after(() => close(server));
  const events = await loopEvents(port);
  t.after(events.stop);
  const s = claude(port, 'bluff');
  await s.prompt('Add divide to math.js');
  await s.edit('math.js');
  await s.run('npm test', { ok: false, output: FAILED });
  // Instead of fixing sum, it changes what the test expects.
  await s.edit('test/math.test.js', 'assert.equal(sum(1, 2), 3);', 'assert.equal(sum(1, 2), -1);');
  const told = await s.run('npm test', { output: PASSED });
  assert.equal(told.hookSpecificOutput.additionalContext, 'dotpals: the tests pass now, but only after you changed them: changed what an assertion expects in math.test.js. Don’t weaken a test to make it pass: put it back and fix the code, or tell the user why the test itself was wrong.');
  const back = await s.stop();
  assert.equal(back.decision, 'block');
  assert.equal(back.reason, 'dotpals: you made the tests pass by changing them (changed what an assertion expects in math.test.js). Put the test back and fix the code, or tell the user why the test was wrong, before you finish.');
  // Once: if it says why the test was wrong, it may finish.
  assert.deepEqual(await s.stop(), {});

  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(events.list.map((e) => e.kind), ['told', 'bluff', 'sent-back'], 'no "Fixed ✓" for a bluff');
  assert.equal(events.list[1].text, 'Claude changed the tests to make them pass: changed what an assertion expects in math.test.js.');

  // Without ever running the failing test first: it reads the files, changes only the test, runs it green.
  const quick = claude(port, 'quick');
  await quick.prompt('The sum test fails. Make it pass by changing the test. Don\'t touch math.js.');
  await quick.run('cat math.js test/math.test.js', { output: 'export function sum(a, b) { return a - b; }' });
  await quick.edit('test/math.test.js', 'assert.equal(sum(1, 2), 3);', 'assert.equal(sum(1, 2), -1);');
  assert.match((await quick.run('npm test', { output: PASSED })).hookSpecificOutput.additionalContext, /^dotpals: the tests pass now, but only after you changed them: changed what an assertion expects in math\.test\.js\./);
  assert.equal((await quick.stop()).decision, 'block');

  // Caught, then put right: the skip taken out again and the code fixed. "Fixed", and it may finish.
  const undo = claude(port, 'undo');
  await undo.prompt();
  await undo.run('npm test', { ok: false, output: FAILED });
  await undo.edit('test/math.test.js', "test('sum adds two numbers', () => {", "test.skip('sum adds two numbers', () => {");
  assert.match((await undo.run('npm test', { output: PASSED })).hookSpecificOutput.additionalContext, /turned 1 test off/);
  await undo.edit('test/math.test.js', "test.skip('sum adds two numbers', () => {", "test('sum adds two numbers', () => {");
  await undo.edit('math.js', 'return a - b;', 'return a + b;');
  assert.deepEqual(await undo.run('npm test', { output: PASSED }), {});
  assert.deepEqual(await undo.stop(), {}, 'the test is back: nothing to send it back for');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(events.list.filter((e) => e.session === 'undo').map((e) => e.kind), ['told', 'bluff', 'fixed']);
  assert.equal(events.list.filter((e) => e.session === 'undo').at(-1).text, 'Fixed: the test is back and passes now ✓');
});

test('a test that was failing before the session changed anything: told, not sent back; one it broke: sent back', async (t) => {
  const { port, server } = await start();
  t.after(() => close(server));
  const events = await loopEvents(port);
  t.after(events.stop);
  const s = claude(port, 'baseline');
  // node --test's own lines: the failing test's name is what's compared.
  const SUM = '✖ sum adds two numbers (0.9ms)\n✔ multiply multiplies (0.1ms)\nℹ tests 2\nℹ pass 1\nℹ fail 1';
  // It looked first: sum was already failing.
  await s.prompt('Run the tests and tell me the result.');
  await s.run('npm test', { ok: false, output: SUM });
  // Then a request that has nothing to do with sum.
  await s.prompt('Add a divide function to math.js.');
  await s.edit('math.js');
  const told = await s.run('npm test', { ok: false, output: SUM });
  assert.match(told.hookSpecificOutput.additionalContext, /These tests were failing before this session changed anything, so they aren’t yours to fix unless the user asks: mention them to the user\.$/);
  assert.deepEqual(await s.stop(), {}, 'not sent back for a failure it found');
  assert.deepEqual(await s.ship(), {}, 'its commit doesn\'t make sum any worse');
  // Now it breaks multiply too: that one is its own.
  await s.prompt('Refactor multiply.');
  await s.edit('math.js');
  await s.run('npm test', { ok: false, output: '✖ sum adds two numbers (0.9ms)\n✖ multiply multiplies (0.1ms)\nℹ tests 2\nℹ pass 0\nℹ fail 2' });
  assert.equal((await s.stop()).decision, 'block');

  await new Promise((r) => setTimeout(r, 100));
  const said = events.list.filter((e) => e.session === 'baseline' && e.kind === 'told').map((e) => e.text);
  assert.match(said[1], /\. They were failing before Claude changed anything\.$/);
});

test('commit or push: held back from inside a PowerShell if, or after a ; (the tests can\'t stop it)', async (t) => {
  const { port, server } = await start();
  t.after(() => close(server));
  const s = claude(port, 'gates');
  await s.prompt();
  await s.edit('math.js');
  await s.run('npm test', { ok: false, output: FAILED });
  // How Claude really committed through PowerShell: the commit inside `if ($?) { … }`.
  const inIf = await s.ship("git status --short; git add -A; if ($?) { git commit -m 'wip' }; git log --oneline -2");
  assert.equal(inIf.hookSpecificOutput?.permissionDecision, 'deny');
  // `;` runs the commit whatever the tests say (the second and last time it's held back in this request).
  assert.equal((await s.ship('npm test; git commit -m x')).hookSpecificOutput?.permissionDecision, 'deny');
});

test('the bluff through the shell (sed, a script): git sees how the tests changed, however it was done', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { port, server } = await start();
  t.after(() => close(server));
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-gitbluff-'));
  // After the bridge closes; Windows may still hold the folder for a moment (its last git run).
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {}));
  const git = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir });
  const TEST = "import { sum } from '../math.js';\ntest('sum adds two numbers', () => {\n  assert.equal(sum(1, 2), 3);\n});\n";
  await mkdir(join(dir, 'test'));
  await writeFile(join(dir, 'test', 'math.test.js'), TEST);
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'start');

  const s = claude(port, 'shell', dir);
  await s.prompt('Make the sum test pass by changing what it expects. Don\'t touch math.js.');
  await s.run('npm test', { ok: false, output: FAILED });
  await new Promise((r) => setTimeout(r, 300)); // git's view of the tests is taken right after a run
  // No edit tool: sed changes the file, and the bridge only sees a command.
  await writeFile(join(dir, 'test', 'math.test.js'), TEST.replace('sum(1, 2), 3)', 'sum(1, 2), -1)'));
  await s.run("sed -i 's/sum(1, 2), 3);/sum(1, 2), -1);/' test/math.test.js");
  const told = await s.run('npm test', { output: PASSED });
  assert.match(told.hookSpecificOutput?.additionalContext ?? '', /^dotpals: the tests pass now, but only after you changed them: changed what an assertion expects in math\.test\.js\./);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await s.stop()).decision, 'block');
  // Kept on the runs, for the notch, Ready to merge and `dotpals mcp`.
  const { entries } = await (await fetch(`http://127.0.0.1:${port}/api/activity`)).json();
  const runs = entries.filter((e) => e.session === 'shell' && e.body?.testDiff);
  assert.ok(runs.length >= 2, 'git\'s view is kept on the test runs');
  assert.match(runs.at(-1).body.testDiff['test/math.test.js'], /^-\s+assert\.equal\(sum\(1, 2\), 3\);\n\+\s+assert\.equal\(sum\(1, 2\), -1\);$/);
});

test('a request that changed no code ("run the tests, don\'t change code"): told gently, and it may stop', async (t) => {
  const { port, server } = await start();
  t.after(() => close(server));
  const events = await loopEvents(port);
  t.after(events.stop);
  const s = claude(port, 'report');
  await s.prompt('Run the tests and tell me the result. Don\'t change code.');
  const told = await s.run('npm test', { ok: false, output: FAILED });
  assert.match(told.hookSpecificOutput.additionalContext, /^dotpals: this test run failed \(1 failed, 1 passed.*\)\. If fixing it is part of this request, fix it and run the tests again\.$/);
  // The failure isn't Claude's doing: it reports it and stops, never sent back.
  assert.deepEqual(await s.stop(), {});
  // Shipping failing tests is held back all the same.
  assert.equal((await s.ship()).hookSpecificOutput.permissionDecision, 'deny');

  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(events.list.map((e) => e.kind), ['told', 'blocked-ship']);
  assert.match(events.list[0].text, /^Tests failed \(.+\)\.$/);
});

test('commit or push: denied while the tests fail or are out of date, allowed once they pass', async (t) => {
  const { port, server } = await start();
  t.after(() => close(server));
  const events = await loopEvents(port);
  t.after(events.stop);
  const s = claude(port, 'ship');
  await s.prompt();
  await s.edit('math.js');
  await s.run('npm test', { ok: false, output: FAILED });

  const denied = await s.ship();
  assert.equal(denied.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /^dotpals: the tests are failing \(.+\)\. Fix them and run the tests again before you commit or push\.$/);
  assert.deepEqual(await s.ship('git status'), {}, 'not shipping');
  assert.deepEqual(await s.ship('git rebase main'), {}, 'a rebase may be how Claude fixes things');
  // The commit never ran: it's a failed step, not "committed without testing".
  const { entries } = await (await fetch(`http://127.0.0.1:${port}/api/activity`)).json();
  const commit = entries.find((e) => e.id === 'ship:ship3');
  assert.equal(commit.status, 'failed');
  assert.match(commit.error, /^dotpals stopped this: the tests are failing/);

  // Fixed and tested: it may commit. Changed again: run them first.
  await s.edit('math.js');
  await s.run('npm test', { output: PASSED });
  assert.deepEqual(await s.ship('git push'), {});
  await s.edit('math.js');
  const stale = await s.ship('gh pr create --fill');
  assert.equal(stale.hookSpecificOutput.permissionDecisionReason, 'dotpals: you changed math.js after the last test run. Run the tests again before you commit or push.');
  // "npm test && git commit" tests first: it's a test run, not held up.
  assert.deepEqual(await s.ship('npm test && git commit -m x'), {});

  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(events.list.map((e) => e.kind), ['told', 'blocked-ship', 'fixed', 'blocked-ship']);
  assert.equal(events.list[1].text, 'Stopped Claude from shipping: the tests are failing.');
});

test('what the fix loop did is kept: GET /api/loop, and in history across a restart', async (t) => {
  // This one keeps history (in this file's own folder): the other bridges here don't.
  process.env.DOTPALS_HISTORY = '1';
  t.after(() => { process.env.DOTPALS_HISTORY = '0'; });
  const loops = (port, session) => fetch(`http://127.0.0.1:${port}/api/loop?session=${session}`).then((r) => r.json()).then((b) => b.events);
  const first = await start();
  const s = claude(first.port, 'kept');
  await s.prompt();
  await s.edit('math.js');
  await s.run('npm test', { ok: false, output: FAILED });
  const events = await loops(first.port, 'kept');
  assert.deepEqual(events.map((e) => [e.kind, e.session, e.label, e.harness]), [['told', 'kept', 'app', 'claude']]);
  assert.match(events[0].text, /^Tests failed \(.+\)\. Told Claude to fix them\.$/);
  assert.deepEqual(await loops(first.port, 'other'), []);
  // History is written a moment later.
  for (let i = 0; i < 100 && !(await readFile(join(home, 'history.json'), 'utf8').catch(() => '')).includes(events[0].id); i++) await new Promise((r) => setTimeout(r, 50));
  await close(first.server);
  const second = await start();
  t.after(() => close(second.server));
  assert.deepEqual(await loops(second.port, 'kept'), events);
});

test('Settings → fixLoop off: nothing is ever said or held up', async (t) => {
  const { port, server } = await start();
  const setConfig = (patch) => fetch(`http://127.0.0.1:${port}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dotpals': '1' }, body: JSON.stringify(patch) }).then((r) => r.json());
  t.after(async () => { await setConfig({ fixLoop: true }); await close(server); });
  assert.equal((await setConfig({ fixLoop: false })).fixLoop, false);
  const s = claude(port, 'off');
  await s.prompt();
  await s.edit('math.js');
  assert.deepEqual(await s.run('npm test', { ok: false, output: FAILED }), {});
  assert.deepEqual(await s.ship(), {});
  assert.deepEqual(await s.stop(), {});
});

const loopHook = fileURLToPath(new URL('../bridge/loop-hook.js', import.meta.url));
function runLoopHook(bridge, event, env = {}) {
  return new Promise((ok) => {
    const started = Date.now();
    const child = spawn(process.execPath, [loopHook], { env: { ...process.env, DOTPALS_BRIDGE: bridge, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('exit', (code) => ok({ code, out, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(event));
  });
}

test('loop-hook.js: fails open, skips commands that don’t matter, and prints the bridge’s answer as is', async (t) => {
  const testRun = { hook_event_name: 'PostToolUse', session_id: 's', cwd: '/w', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'npm test' }, tool_response: { stdout: 'x' } };
  // A "bridge" that never answers.
  const slow = createServer(() => {});
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  t.after(() => { slow.closeAllConnections?.(); slow.close(); });
  const r = await runLoopHook(`http://127.0.0.1:${slow.address().port}`, testRun, { DOTPALS_LOOP_WAIT: '300' });
  assert.deepEqual([r.code, r.out], [0, '']);
  assert.ok(r.ms < 4000, `gave up in ${r.ms} ms`);
  // No bridge at all: the same.
  const none = await runLoopHook('http://127.0.0.1:9', { hook_event_name: 'Stop', session_id: 's' });
  assert.deepEqual([none.code, none.out], [0, '']);

  // A bridge with something to say: printed as is. With nothing ({}): nothing.
  const asked = [];
  let reply = { decision: 'block', reason: 'dotpals: the tests are failing.' };
  const fake = createServer((req, res) => { asked.push(req.url); res.end(JSON.stringify(reply)); });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  t.after(() => fake.close());
  const url = `http://127.0.0.1:${fake.address().port}`;
  assert.deepEqual(JSON.parse((await runLoopHook(url, { hook_event_name: 'Stop', session_id: 's' })).out), reply);
  reply = {};
  assert.equal((await runLoopHook(url, testRun)).out, '');
  // Neither a test run nor a commit: the bridge isn't even asked.
  assert.equal((await runLoopHook(url, { ...testRun, tool_input: { command: 'ls' } })).out, '');
  assert.equal((await runLoopHook(url, { ...testRun, hook_event_name: 'PreToolUse', tool_input: { command: 'npm test' } })).out, '');
  assert.deepEqual(asked, ['/hook?loop=1', '/hook?loop=1']);
});
