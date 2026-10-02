import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chapters, flags, headline, planOf, stepType } from '../bridge/ui/story.js';

let n = 0;
const step = (kind, extra = {}) => ({ id: `s${n++}`, session: 's', kind, status: 'ok', at: 1000 + n, ...extra });
const run = (command, status = 'ok') => step('run', { tool: 'Bash', title: command, body: { command }, status });
const read = (path) => step('read', { title: path, files: [{ path: `/p/${path}`, change: 'read' }] });
const edit = (path, patch = '-a\n+b') => step('edit', { title: path, files: [{ path: `/p/${path}`, change: 'edit' }], body: { patch } });

test('stepType tells tests, builds, installs, shipping and quick looks apart', () => {
  assert.equal(stepType(run('npm test')), 'test');
  assert.equal(stepType(run('cd app && pytest -q')), 'test');
  assert.equal(stepType(run('npx tsc --noEmit')), 'build');
  assert.equal(stepType(run('pip install requests')), 'install');
  assert.equal(stepType(run('git commit -m "x" && git push')), 'ship');
  assert.equal(stepType(run('git status')), 'explore');
  assert.equal(stepType(run('ls -la src')), 'explore');
  assert.equal(stepType(run('node scripts/migrate.js')), 'run');
});

test('hundreds of steps become a few chapters, most important first', () => {
  const steps = [];
  for (let i = 0; i < 40; i++) steps.push(read(`src/f${i}.js`));
  steps.push(edit('src/a.js', '-1\n+2\n+3'), edit('src/b.js'), read('src/c.js'), edit('src/a.js'));
  steps.push(run('npm test', 'failed'), edit('src/a.js'), run('npm test', 'failed'), run('npm test'));
  steps.push(run('git commit -m "Fix the thing" && git push'));
  const chs = chapters(steps);
  assert.deepEqual(chs.map((c) => c.type), ['change', 'test', 'ship', 'explore']);
  assert.equal(chs[0].title, 'Changed 2 files');
  assert.deepEqual(chs[0].lines, { add: 5, del: 4 });
  assert.equal(chs[1].title, 'Tests failed twice, then passed');
  assert.equal(chs[1].status, 'ok');
  assert.equal(chs[2].title, 'Committed and pushed');
  assert.match(chs[2].detail, /Fix the thing/);
  assert.equal(chs[3].title, 'Looked through 41 files');
});

test('running chapters read in the present tense', () => {
  const chs = chapters([edit('a.js'), { ...edit('b.js'), status: 'running' }]);
  assert.equal(chs[0].title, 'Changing 2 files');
  assert.equal(chs[0].status, 'running');
});

test('flags: secrets, risky commands and a stuck loop', () => {
  const f = flags([
    step('edit', { title: '.env', files: [{ path: '/p/.env', change: 'edit' }] }),
    run('rm -rf src'),
    run('git push --force origin main'),
    run('npm run e2e', 'failed'), run('npm run e2e', 'failed'), run('npm run e2e', 'failed'),
  ]);
  const text = f.map((x) => x.text).join('\n');
  assert.match(text, /Changed \.env/);
  assert.match(text, /recursive delete/);
  assert.match(text, /Force-pushed/);
  assert.match(text, /failed 3 times/);
  assert.ok(f.every((x) => x.level === 'warn'));
});

test('planOf: TodoWrite lists and TaskCreate/TaskUpdate', () => {
  const todo = planOf([step('plan', { plan: [{ text: 'a', status: 'completed' }, { text: 'b', active: 'Doing b', status: 'in_progress' }, { text: 'c', status: 'pending' }] })]);
  assert.equal(todo.done, 1);
  assert.equal(todo.total, 3);
  assert.equal(headline([], todo), '2/3 · Doing b');

  const tasks = planOf([
    step('plan', { task: { op: 'create', text: 'Write tests' } }),
    step('plan', { task: { op: 'create', text: 'Ship it' } }),
    step('plan', { task: { op: 'update', id: '1', status: 'completed' } }),
    step('plan', { task: { op: 'update', id: '2', status: 'in_progress' } }),
  ]);
  assert.deepEqual(tasks.items.map((i) => i.status), ['completed', 'in_progress']);
  assert.equal(tasks.current.text, 'Ship it');
});

test('readUsage finds Codex limits in its logs', async (t) => {
  const { readUsage } = await import('../bridge/usage.js');
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-usage-'));
  process.env.DOTPALS_HOME = join(dir, 'home');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const d = new Date();
  const folder = join(dir, 'codex', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  await mkdir(folder, { recursive: true });
  const resets = Math.floor(Date.now() / 1000) + 3600;
  const line = { timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 64, window_minutes: 300, resets_at: resets }, secondary: { used_percent: 12, window_minutes: 10080, resets_at: resets + 86400 }, plan_type: 'plus' } } };
  await writeFile(join(folder, 'rollout-x.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: {} })}\n${JSON.stringify(line)}\n`);
  const { agents } = await readUsage({ codexDir: join(dir, 'codex') });
  const codex = agents.find((a) => a.harness === 'codex');
  assert.equal(codex.window.used_percent, 64);
  assert.equal(codex.window.resets_at, resets * 1000);
  assert.equal(codex.weekly.used_percent, 12);
  const claude = agents.find((a) => a.harness === 'claude');
  assert.equal(claude.setup, 'statusline'); // no status line yet
});

test('toolkit: skills, plugins, MCP tools and helpers a session used', async () => {
  const { toolkit } = await import('../bridge/ui/story.js');
  const kit = toolkit([
    step('skill', { title: 'frontend-design' }),
    step('skill', { title: 'bio-research:literature' }),
    step('mcp', { title: 'search', detail: 'Vercel' }),
    step('mcp', { title: 'deploy', detail: 'Vercel' }),
    step('mcp', { title: 'query', detail: 'plugin bio-research chembl' }),
    step('agent', { title: 'Write the tests' }),
  ]);
  assert.deepEqual(kit.skills.map((s) => [s.name, s.plugin]), [['frontend-design', undefined], ['literature', 'bio-research']]);
  assert.deepEqual(kit.tools.map((t) => [t.name, t.uses]), [['Vercel', 2], ['chembl', 1]]);
  assert.deepEqual(kit.plugins, ['bio-research']);
  assert.equal(kit.helpers, 1);
});

test('overlaps: a file changed by two sessions', async () => {
  const { overlaps } = await import('../bridge/ui/story.js');
  const now = Date.now();
  const change = (session, harness, path, at) => ({ id: `${session}${at}`, session, harness, label: 'app', kind: 'edit', status: 'ok', at, files: [{ path, change: 'edit' }] });
  const found = overlaps([
    change('a', 'claude', String.raw`C:\app\src\x.js`, now - 60_000), // same file, other slashes
    change('b', 'codex', 'C:/app/src/x.js', now - 30_000),
    change('a', 'claude', 'C:/app/src/y.js', now - 20_000),
    { ...change('b', 'codex', 'C:/app/src/y.js', now - 10_000), status: 'failed' },
    change('c', 'codex', 'C:/app/src/old.js', now - 5 * 3600_000),
    change('a', 'claude', 'C:/app/src/old.js', now - 1000),
  ]);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].sessions.map((s) => s.session), ['a', 'b']);
});

test('overlaps: the same file hours apart is not a clash', async () => {
  const { overlaps } = await import('../bridge/ui/story.js');
  const now = Date.now();
  const change = (session, at) => ({ id: `${session}${at}`, session, harness: 'claude', label: 'app', kind: 'edit', status: 'ok', at, files: [{ path: '/app/README.md', change: 'edit' }] });
  assert.equal(overlaps([change('a', now - 100 * 60_000), change('b', now - 5 * 60_000)]).length, 0);
  assert.equal(overlaps([change('a', now - 20 * 60_000), change('b', now - 5 * 60_000)]).length, 1);
});

test('compactNote: a /compact with what to keep', async () => {
  const { compactNote } = await import('../bridge/ui/story.js');
  const note = compactNote([
    step('prompt', { title: 'Add dark mode' }),
    step('plan', { plan: [{ text: 'Read theme', status: 'completed' }, { text: 'Add Auto option', status: 'pending' }] }),
    edit('src/useTheme.ts'),
    run('npm test', 'failed'),
  ]);
  assert.equal(note, '/compact Keep the current goal: "Add dark mode". Still to do: Add Auto option. Files changed so far: useTheme.ts. The tests are failing right now (npm test).');
  assert.equal(compactNote([]), '/compact Keep the current goal and the files changed so far.');
});

test('headline: prompts are not steps, and it shortens to whole words', async () => {
  const { headline } = await import('../bridge/ui/story.js');
  assert.equal(headline([step('prompt', { title: 'also on the notch would be good right' })]), null);
  const long = headline([], { done: 1, total: 3, current: { text: 'Detect the system colour scheme and apply it everywhere', status: 'in_progress' }, items: [] });
  assert.ok(!long.includes('…'));
  assert.equal(long, '2/3 · Detect the system colour scheme');
});

test('crossRecap: what the other agents in this project did', async () => {
  const { crossRecap } = await import('../bridge/ui/story.js');
  const now = Date.now();
  const at = (min) => now - min * 60_000;
  const e = (session, harness, extra) => ({ id: `${session}${Math.random()}`, session, harness, label: 'shop', status: 'ok', ...extra });
  const entries = [
    e('mine-1111', 'claude', { kind: 'edit', at: at(3), files: [{ path: 'C:/code/shop/src/cart.js', change: 'edit' }] }),
    e('codex-2222', 'codex', { kind: 'prompt', at: at(20), title: 'Add rate limiting to the login route' }),
    e('codex-2222', 'codex', { kind: 'edit', at: at(18), files: [{ path: 'C:/code/shop/api/login.ts', change: 'edit' }] }),
    e('codex-2222', 'codex', { kind: 'run', at: at(15), status: 'failed', body: { command: 'npm test' } }),
    e('looker-3333', 'claude', { kind: 'read', at: at(10), files: [{ path: 'C:/code/shop/README.md', change: 'read' }] }),
    e('other-4444', 'claude', { kind: 'edit', at: at(5), label: 'blog', files: [{ path: 'C:/code/blog/a.md', change: 'edit' }] }),
  ];
  const r = crossRecap(entries, { session: 'mine-1111', label: 'shop', states: new Map([['codex-2222', 'working']]) });
  assert.match(r.text, /Codex \(session 2222, working now\): changed api\/login\.ts; its last test run failed \(npm test\); it was asked: "Add rate limiting to the login route"\./);
  assert.doesNotMatch(r.text, /3333|4444|mine|cart\.js/); // only looked around / another project / itself
  assert.equal(crossRecap(entries, { session: 'mine-1111', label: 'nothing-here' }), null);
});

test('retries: a failed step is linked to the next try at the same thing', async () => {
  const { retries, chapters } = await import('../bridge/ui/story.js');
  const a = edit('src/app.js'); a.status = 'failed';
  const b = read('src/app.js');
  const c = edit('src/app.js');                       // the retry: worked
  const d = run('npm run e2e', 'failed');
  const e = run('npm run e2e', 'failed');              // retried, still failing
  const f = edit('src/other.js');
  const { chains, retryOf } = retries([a, b, c, d, e, f]);
  assert.equal(chains.get(a.id).outcome, 'fixed');
  assert.deepEqual(chains.get(a.id).attempts.map((x) => x.id), [a.id, c.id]);
  assert.equal(retryOf.get(c.id), a.id);
  assert.equal(chains.get(d.id).outcome, 'failing');
  assert.equal(retryOf.get(e.id), d.id);
  assert.equal(retryOf.has(f.id), false);
  const chs = chapters([a, b, c, f]);
  assert.match(chs[0].detail, /1 edit failed, fixed on the next try/);
  const runs = chapters([run('node build.js', 'failed'), run('node build.js', 'failed'), run('node build.js')]);
  assert.match(runs[0].detail, /1 command failed, fixed on try 3/);
});

test('retries: a command that keeps failing says so plainly', async () => {
  const { chapters } = await import('../bridge/ui/story.js');
  const chs = chapters([run('npm run e2e', 'failed'), run('npm run e2e', 'failed'), run('npm run e2e', 'failed')]);
  assert.match(chs[0].detail, /still failing after 3 tries/);
  assert.doesNotMatch(chs[0].detail, /1 failed · 1 still failing/);
});

test('testState: untested, tested, then changed after the tests passed', async () => {
  const { testState, testLine } = await import('../bridge/ui/story.js');
  assert.equal(testState([read('src/a.js')]), null); // only looked: nothing to test
  assert.equal(testState([edit('README.md'), edit('CHANGELOG.md')]), null); // docs don't need tests
  const untested = testState([edit('src/a.js'), edit('src/b.js')]);
  assert.equal(untested.state, 'untested');
  assert.equal(untested.since.length, 2);
  assert.equal(testState([edit('src/a.js'), run('npm test')]).state, 'passing');
  assert.equal(testState([edit('src/a.js'), run('npm test', 'failed')]).state, 'failing');
  const stale = testState([edit('src/a.js'), run('npm test'), edit('src/b.js'), edit('docs/x.md')]);
  assert.equal(stale.state, 'stale');
  assert.deepEqual(stale.since, ['/p/src/b.js']);
  assert.match(testLine([edit('src/a.js'), run('npm test'), edit('src/b.js')], () => '7:08 PM').text, /^Tests passed at 7:08 PM · 1 file changed since$/);
});

test('testState: was the last commit tested after its last change?', async () => {
  const { testState } = await import('../bridge/ui/story.js');
  assert.equal(testState([edit('src/a.js'), run('npm test'), run('git commit -m x')]).commit.tested, true);
  assert.equal(testState([edit('src/a.js'), run('npm test'), edit('src/a.js'), run('git commit -m x')]).commit.tested, false);
  assert.equal(testState([edit('src/a.js'), run('npm test && git commit -m x')]).commit.tested, true);
  assert.equal(testState([edit('src/a.js'), run('git commit -m x')]).commit.tested, false);
});

test('story: a finished request that changed code without testing says so, loudly', async () => {
  const { story } = await import('../bridge/ui/story.js');
  const turn = (steps, end = { kind: 'done' }) => ({ steps, end });
  assert.match(story(turn([edit('src/a.js')])).flags[0].text, /^Not tested: changed 1 code file \(a\.js\), and the agent ran no tests$/);
  assert.equal(story(turn([edit('src/a.js')])).flags[0].level, 'warn');
  assert.match(story(turn([edit('src/a.js'), run('npm test'), edit('src/b.js')])).flags[0].text, /^Changed b\.js after the tests passed: not tested since$/);
  assert.equal(story(turn([edit('src/a.js'), run('npm test')])).flags.length, 0);
  assert.equal(story(turn([edit('src/a.js')], null)).flags.length, 0); // still working: it may test yet
});

test('a test run’s result comes from its output: a later part of the command failing isn’t a test failure', async () => {
  const { testPassed, testState } = await import('../bridge/ui/story.js');
  const ran = (command, output, status = 'ok') => ({ ...run(command, status), body: { command, output } });
  // npm test passed, then restarting the app returned 255 (seen for real).
  const change = edit('src/a.js');
  const restart = ran('npm test 2>&1 | Select-String pass; Stop-Process -Id 1; dotpals start', 'Exit code 255\nℹ pass 102\nℹ fail 0', 'failed');
  assert.equal(testPassed(restart), true);
  assert.equal(testState([change, restart]).state, 'passing');
  assert.equal(testPassed(ran('npx jest', 'Tests:       1 failed, 5 passed, 6 total')), false);
  assert.equal(testPassed(ran('pytest -q', '===== 12 passed in 0.31s =====')), true);
  assert.equal(testPassed(ran('cargo test', 'test result: FAILED. 3 passed; 1 failed', 'failed')), false);
  assert.equal(testPassed(ran('go test ./...', 'ok  \texample.com/pkg\t0.01s')), true);
  assert.equal(testPassed(ran('npm test', 'something broke', 'failed')), false); // no counts: the exit status decides
});

test('a command only counts as a test run when it runs a test command, not when it mentions one', async () => {
  assert.equal(stepType(run('cd app && CI=1 npm test -- --watch=false')), 'test');
  assert.equal(stepType(run('./node_modules/.bin/jest --ci')), 'test');
  assert.equal(stepType(run('& npm test 2>&1 | Select-String fail')), 'test');
  assert.notEqual(stepType(run("node -e \"await a({ body: { command: 'npm test' } })\"")), 'test');
  assert.notEqual(stepType(run('echo "run npm test before pushing" > NOTES.txt')), 'test');
  assert.notEqual(stepType(run('grep -rn "npm test" docs')), 'test');
});

test('testVerdict: the summary decides, and says where the verdict came from', async () => {
  const { testVerdict, testWords } = await import('../bridge/ui/story.js');
  const ran = (output, status = 'ok', extra = {}) => ({ ...run('npm test', status), body: { command: 'npm test', output }, ...extra });
  const v = (output, status, extra) => { const x = testVerdict(ran(output, status, extra)); return [x.state, x.source]; };
  assert.deepEqual(v('ℹ tests 48\nℹ pass 48\nℹ fail 0'), ['passed', 'output']);
  assert.equal(testWords(testVerdict(ran('ℹ tests 48\nℹ pass 48\nℹ fail 0'))), 'Tests passed · 48 passed');
  assert.equal(testWords(testVerdict(ran('Tests: 1 failed, 47 passed, 48 total', 'failed'))), 'Tests failed · 1 failed, 47 passed');
  // The summary wins over the exit status, both ways.
  assert.deepEqual(v('===== 3 passed in 0.1s =====', 'failed'), ['passed', 'output']);
  assert.deepEqual(v('test result: FAILED. 3 passed; 1 failed; 0 ignored;', 'ok'), ['failed', 'output']);
  // No summary: the exit status, and it says so.
  assert.deepEqual(v('Compiling…\ndone'), ['passed', 'exit']);
  assert.equal(testWords(testVerdict(ran('done'))), 'Tests passed (exit code only)');
  assert.deepEqual(v('something broke', 'failed'), ['failed', 'exit']);
  assert.equal(testVerdict(run('npm test', 'running')).state, 'running');
});

test('testVerdict: zero tests, only skipped, or output that disagrees with the exit code is unclear', async () => {
  const { testVerdict, testWords, testPassed, testState, testLine, chapters, story } = await import('../bridge/ui/story.js');
  const ran = (output, status = 'ok', extra = {}) => ({ ...run('npm test', status), body: { command: 'npm test', output }, ...extra });
  for (const output of ['ℹ tests 0\nℹ pass 0\nℹ fail 0', '======= 4 skipped in 0.02s =======', 'No tests found, exiting with code 0']) {
    const x = testVerdict(ran(output));
    assert.equal(x.state, 'unclear', output);
    assert.equal(x.note, 'no tests actually ran');
  }
  assert.equal(testWords(testVerdict(ran('ℹ tests 0\nℹ pass 0\nℹ fail 0'))), 'Tests unclear: no tests actually ran');
  // An "ok" exit with a crash in the output, and a "failed" exit with clean output.
  assert.equal(testVerdict(ran('Traceback (most recent call last):\n  File "x.py"\nValueError: bad')).state, 'unclear');
  assert.equal(testVerdict(ran('PASS src/a.test.js\n✓ adds', 'failed')).state, 'unclear');
  assert.equal(testVerdict(ran('', 'stopped')).state, 'unclear');
  // Unclear is never a pass.
  const change = edit('src/a.js');
  const unclear = ran('ℹ tests 0\nℹ pass 0\nℹ fail 0');
  assert.equal(testPassed(unclear), null);
  const t = testState([change, unclear, run('git commit -m x')]);
  assert.equal(t.state, 'unclear');
  assert.equal(t.commit.tested, false);
  const line = testLine([change, unclear], () => '7:08 PM');
  assert.equal(line.level, 'warn');
  assert.equal(line.text, 'Tests unclear: no tests actually ran · 7:08 PM');
  const [ch] = chapters([unclear]);
  assert.equal(ch.title, 'Tests unclear');
  assert.equal(ch.status, 'unclear');
  assert.equal(ch.detail, 'npm test · no tests actually ran');
  assert.match(story({ steps: [change, unclear], end: { kind: 'done' } }).flags[0].text, /^Tests unclear: no tests actually ran$/);
});

test('testVerdict: a checker settles an unclear run, and only an unclear one', async () => {
  const { testVerdict, testWords, testLine, chapters } = await import('../bridge/ui/story.js');
  const ran = (output, status, check) => ({ ...run('npm test', status), body: { command: 'npm test', output }, check });
  const crash = 'Traceback (most recent call last):\nValueError: bad';
  const passed = testVerdict(ran(crash, 'ok', { by: 'jev', state: 'passed', p: 0.94, ms: 300 }));
  assert.deepEqual([passed.state, passed.source], ['passed', 'checker']);
  assert.equal(testWords(passed), 'Tests passed · checked by Jev, 94% sure');
  const failed = testVerdict(ran(crash, 'ok', { by: 'laya', state: 'failed', p: 0.1, ms: 40 }));
  assert.equal(testWords(failed), 'Tests failed · checked by Laya, 90% sure');
  const unsure = testVerdict(ran(crash, 'ok', { by: 'laya', state: 'unclear', p: 0.55, ms: 40 }));
  assert.equal(unsure.state, 'unclear');
  assert.match(testWords(unsure), /Laya wasn’t sure \(55% that they passed\)$/);
  const error = testVerdict(ran(crash, 'ok', { by: 'jev', error: 'no answer within 5 s' }));
  assert.equal(testWords(error), 'Tests unclear: the exit code says passed, but the output shows errors · couldn’t check with Jev');
  // A clear result ignores a checker.
  assert.equal(testVerdict(ran('ℹ pass 3\nℹ fail 1', 'failed', { by: 'jev', state: 'passed', p: 0.99 })).state, 'failed');
  const change = edit('src/a.js');
  const checked = ran(crash, 'ok', { by: 'jev', state: 'passed', p: 0.94 });
  assert.match(testLine([change, checked], () => '7:08 PM').text, /^Tests passed · checked by Jev, 94% sure · 7:08 PM, after the last change$/);
  assert.equal(chapters([checked])[0].detail, 'npm test · checked by Jev, 94% sure');
});

test('checkOf describes a checker’s answer: who, what, how sure, why the rules weren’t sure', async () => {
  const { checkOf } = await import('../bridge/ui/story.js');
  const e = { ...run('npm test'), body: { command: 'npm test', output: 'Error: Cannot find module ./config' } };
  assert.equal(checkOf(e), null);
  const c = checkOf({ ...e, check: { by: 'jev', state: 'failed', p: 0.22, ms: 167, model: 'jev-1.13.0' } });
  assert.deepEqual(c, { who: 'Jev', state: 'failed', sure: 78, ms: 167, model: 'jev-1.13.0', error: null, why: 'The exit code says passed, but the output shows errors' });
  assert.equal(checkOf({ ...e, check: { by: 'laya', error: 'couldn’t reach Laya' } }).state, 'error');
});

test('simple: one plain sentence for a request, with the warnings that matter', async () => {
  const { simple } = await import('../bridge/ui/story.js');
  const done = { kind: 'done' };
  assert.equal(simple({ steps: [edit('src/billing.ts'), run('npm test', 'failed'), run('npm test'), run('git commit -m "Fix VAT" && git push')], end: done }).text,
    'Changed billing.ts, the tests passed after one retry, and committed and pushed.');
  assert.equal(simple({ steps: [edit('src/a.js'), edit('src/b.js')], end: done }).text, 'Changed 2 files, but it didn’t run the tests.');
  assert.equal(simple({ steps: [read('src/a.js'), read('src/b.js')], end: done }).text, 'Looked through 2 files.');
  assert.equal(simple({ steps: [], end: done }).text, 'Answered without changing anything.');
  const failing = simple({ steps: [edit('src/a.js'), run('npm test', 'failed')], end: done });
  assert.equal(failing.status, 'failed');
  assert.match(failing.text, /the tests are failing\.$/);
  assert.match(simple({ steps: [edit('src/a.js')], end: null }).text, /^Working on it: /);
  // Only warnings, and not the one the sentence already says.
  const risky = simple({ steps: [edit('.env'), edit('src/a.js')], end: done });
  assert.deepEqual(risky.warnings, ['Changed .env, which usually holds secrets']);
});

test('deleting a temp or build folder is a quiet note, deleting code is a warning', () => {
  const quiet = flags([run('rm -rf "$TEMP/claude/scratchpad/laya"')]);
  assert.deepEqual(quiet.map((f) => [f.level, f.text]), [['info', 'Deleted a temporary or build folder']]);
  assert.equal(flags([run('rm -rf dist node_modules')])[0].level, 'info');
  assert.equal(flags([run('rm -rf src')])[0].level, 'warn');
  assert.equal(flags([run('rm -rf $TEMP/x && rm -rf src')])[0].level, 'warn'); // one real delete is enough
});

test('a command counts for what it runs, not for what it writes into a file (seen for real)', async () => {
  const { parts, simple } = await import('../bridge/ui/story.js');
  // Writing a test file that mentions git push and rm -rf: not a push, not a delete.
  const writing = "cd /c/Dot; cat >> test/story.test.js <<'EOF'\n  run('git commit -m \"Fix VAT\" && git push')\n  flags([run('rm -rf src')])\nEOF\nnpm test";
  assert.notEqual(stepType(run(writing)), 'ship');
  assert.equal(flags([run(writing)]).length, 0);
  assert.doesNotMatch(simple({ steps: [edit('src/a.js'), run(writing)], end: { kind: 'done' } }).text, /pushed/);
  // An inline script that mentions them doesn't count either; a real push does.
  assert.notEqual(stepType(run(`node -e "console.log('git push --force')"`)), 'ship');
  assert.equal(stepType(run('git add -A && git commit -m "x" && git push')), 'ship');
  // `timeout 150 npm test` is a test run.
  assert.equal(stepType(run('timeout 150 npm test > out.txt 2>&1')), 'test');
  assert.deepEqual(parts('FOO=1 timeout 30 npx jest --ci | tail -5'), ['jest --ci', 'tail -5']);
  // Stop-Process inside a PowerShell pipeline is still a force-stop.
  assert.equal(flags([run("Get-Process electron | ForEach-Object { Stop-Process -Id $_.Id -Force }")])[0]?.text, 'Force-stopped programs');
});

test('simple: a request that stopped before finishing says so, not "working on it"', async () => {
  const { simple } = await import('../bridge/ui/story.js');
  const s = simple({ steps: [edit('src/a.js'), edit('src/b.js'), run('npm test', 'failed')], end: null }, { live: false });
  assert.equal(s.status, 'stopped');
  assert.equal(s.text, 'Stopped before finishing: changed 2 files, and the tests are failing.');
  assert.match(simple({ steps: [edit('src/a.js')], end: null }, { live: true }).text, /^Working on it: /);
});

test('the copied recap keeps ran, failed, unclear and not run apart, each with its evidence', async () => {
  const { turnMarkdown } = await import('../bridge/ui/story.js');
  const withOut = (command, status, output) => ({ ...run(command, status), body: { command, output } });
  const md = turnMarkdown({
    prompt: { title: 'Fix the VAT rounding' }, harness: 'claude', label: 'shop',
    steps: [edit('src/billing.ts'), withOut('npm test', 'failed', 'Tests: 1 failed, 47 passed'), edit('src/billing.ts'), withOut('npm test', 'ok', 'Tests: 48 passed'),
      withOut('grep -rn TODO src', 'failed', ''), run('git commit -m x && git push'), edit('src/app.tsx')],
    end: { kind: 'done' },
  });
  assert.match(md, /\*\*✅ Ran successfully\*\*\n- Tests: `npm test` → 48 passed · step `s\d+`/);
  assert.match(md, /- Shipped: `git commit -m x && git push`/);
  assert.match(md, /\*\*❌ Failed\*\*\n- Tests: `npm test` → 1 failed, 47 passed · step `s\d+` \(fixed on try 2\)/);
  assert.match(md, /\*\*⚪ Not run\*\*\n- Tests after the last change to `app\.tsx`/);
  assert.doesNotMatch(md, /grep/); // a look-up that found nothing isn't a failure
  // An unclear run gets its own group, with why it's unclear.
  const unclear = turnMarkdown({ steps: [edit('src/a.js'), withOut('npm test', 'ok', 'Error: Cannot find module ./config')], end: { kind: 'done' }, harness: 'claude' });
  assert.match(unclear, /\*\*❔ Unclear\*\*\n- Tests: `npm test` → the exit code says passed, but the output shows errors/);
});

test('failing test names show next to the counts, shortened to the test’s own name', async () => {
  const { testEvidence, testVerdict, simple } = await import('../bridge/ui/story.js');
  const out = 'FAILED tests/test_locks.py::test_locked_failure_does_not_block_requested_work - AssertionError\n=== 1 failed, 47 passed in 0.42s ===';
  const failing = { ...run('pytest -q', 'failed'), body: { command: 'pytest -q', output: out } };
  assert.equal(testEvidence(testVerdict(failing)), '1 failed, 47 passed: test_locked_failure_does_not_block_requested_work');
  assert.match(simple({ steps: [edit('src/locks.py'), failing], end: { kind: 'done' } }).text, /the tests are failing \(test_locked_failure_does_not_block_requested_work\)\.$/);
});

test('whyStopped: why a request ended, in plain words', async () => {
  const { whyStopped } = await import('../bridge/ui/story.js');
  const failing = (n) => Array.from({ length: n }, () => ({ ...run('npm test', 'failed'), body: { command: 'npm test', output: 'Tests: 1 failed, 3 passed' } }));
  assert.equal(whyStopped({ steps: [edit('src/a.js')], end: null }, { live: true }), null);
  assert.equal(whyStopped({ steps: [], end: null }, { live: true, waiting: true }).kind, 'waiting');
  assert.equal(whyStopped({ steps: [edit('src/a.js')], end: null }, { live: false }).kind, 'cut');
  assert.match(whyStopped({ steps: [], end: { kind: 'error', title: 'API error: overloaded' } }).text, /^Stopped with an error: API error: overloaded$/);
  assert.equal(whyStopped({ steps: failing(3), end: { kind: 'done' } }).text, 'Stopped trying: `npm test` still failed after 3 tries');
  assert.equal(whyStopped({ steps: failing(1), end: { kind: 'done' } }).kind, 'failing');
  assert.equal(whyStopped({ steps: [], end: { kind: 'done', summary: 'Should I also update the docs?' } }).kind, 'question');
  assert.equal(whyStopped({ steps: [edit('src/a.js')], end: { kind: 'done', summary: 'Done.' } }).kind, 'done');
});

test('readiness: ready to merge only when tests ran after the last change, passed, and nothing is risky', async () => {
  const { readiness } = await import('../bridge/ui/story.js');
  const ok = (cmd = 'npm test') => ({ ...run(cmd), body: { command: cmd, output: 'Tests: 48 passed' } });
  const done = { kind: 'done' };
  assert.equal(readiness({ steps: [read('src/a.js')], end: done }), null); // nothing changed
  assert.equal(readiness({ steps: [edit('src/a.js')], end: null }), null); // still working
  assert.equal(readiness({ steps: [edit('src/a.js'), ok(), run('git commit -m x')], end: done }).ready, true);
  const untested = readiness({ steps: [edit('src/a.js')], end: done });
  assert.deepEqual([untested.ready, untested.problems], [false, ['No tests ran']]);
  const stale = readiness({ steps: [edit('src/a.js'), ok(), edit('src/b.js')], end: done });
  assert.match(stale.problems.join(' | '), /Changed `b\.js` after the last test run/);
  const risky = readiness({ steps: [edit('src/a.js'), edit('.env'), ok()], end: done });
  assert.match(risky.problems.join(' | '), /\.env/);
  const commit = readiness({ steps: [edit('src/a.js'), ok(), edit('src/a.js'), run('git commit -m x')], end: done });
  assert.ok(commit.problems.includes('Committed without a passing test run after the last change'));
});

test('risky commands are still caught inside shells, behind sudo/xargs/-exec, and in mixed deletes (from code review)', () => {
  const warns = (c) => flags([run(c)]).filter((f) => f.level === 'warn').map((f) => f.text);
  for (const c of ['bash -c "rm -rf ~/project"', 'powershell -Command "Remove-Item -Recurse -Force C:/repo"', 'sudo rm -rf /var/lib/app',
    "find . -name '*.js' -exec rm -rf {} \;", 'ls | xargs rm -rf', 'cmd /c rmdir /s /q src', 'rm -rf dist src', 'rm -rf node_modules ~/work/app']) {
    assert.ok(warns(c).includes('Deleted files with a recursive delete'), c);
  }
  assert.ok(warns("sh -c 'git push --force'").includes('Force-pushed to git'));
  assert.ok(warns('sudo git push --force').includes('Force-pushed to git'));
  // Only deletes where every target is throwaway are quiet; mentions in files or other languages don't count.
  assert.deepEqual(flags([run('rm -rf dist node_modules')]).map((f) => f.level), ['info']);
  assert.deepEqual(flags([run("cat >> t.js <<'EOF'\nrm -rf src\nEOF")]), []);
  assert.deepEqual(flags([run('node -e "require(\'fs\').rmSync(\'x\')" && echo "git push --force"')]), []);
});

test('a recap of a real turn: piped tests, code in node -e, scratch files and retries (from a user check)', async () => {
  const { turnMarkdown, testVerdict } = await import('../bridge/ui/story.js');
  const withOut = (command, status, output) => ({ ...run(command, status), body: { command, output } });
  // Piped into grep or tail, the exit code is the last command's, not the tests'.
  assert.equal(testVerdict(withOut('node --test test/guard.test.js 2>&1 | grep -E "fail|ok"', 'ok', 'ok 1 - x')).reason, 'piped');
  assert.equal(testVerdict(withOut('npm test || echo failed', 'ok', '')).state, 'passed');
  assert.equal(testVerdict(withOut('npm test 2>&1 | tail -3', 'ok', '# pass 12\n# fail 0')).state, 'passed'); // counts still win
  // "sudo" or "chmod" inside a node -e script is a string, not a command; inside bash -c it is one.
  assert.deepEqual(flags([run('node -e "console.log(\'sudo chmod 777 x\')"')]), []);
  assert.ok(flags([run('bash -c "sudo chmod 777 x"')]).some((f) => f.level === 'warn'));
  // A scratch file outside the project is counted, not listed.
  const scratch = step('write', { title: 'C:/Users/me/AppData/Local/Temp/root-check.mjs', files: [{ path: 'C:/Users/me/AppData/Local/Temp/root-check.mjs', change: 'write' }] });
  const md = turnMarkdown({
    harness: 'claude', end: { kind: 'done' },
    steps: [edit('src/guard.js'), scratch, withOut('node --test test/guard.test.js 2>&1 | grep -E "fail"', 'failed', 'not ok 3 - pathKey'),
      edit('src/guard.js'), withOut('node --test test/guard.test.js 2>&1 | tail -5', 'ok', '# pass 9\n# fail 0')],
  });
  assert.doesNotMatch(md, /root-check/);
  assert.match(md, /Also touched 1 file outside the project/);
  // The same test file run again with a different pipe is a retry.
  assert.match(md, /\(fixed on try 2\)/);
});

test('a test run that exits 0 but reports failures still starts a retry chain', async () => {
  const { retries } = await import('../bridge/ui/story.js');
  const withOut = (command, status, output) => ({ ...run(command, status), body: { command, output } });
  const first = withOut('npm test; echo done', 'ok', 'Tests: 1 failed, 8 passed');
  const piped = withOut('npm test | grep fail', 'ok', '');
  const fixed = withOut('npm test', 'ok', 'Tests: 9 passed');
  const { chains } = retries([first, piped, fixed]);
  assert.deepEqual(chains.get(first.id).attempts.map((e) => e.id), [first.id, fixed.id]); // the piped run can't tell, so it's skipped
  assert.equal(chains.get(first.id).outcome, 'fixed');
});

test('commandEdits: the code files a command writes, never temp files, docs or reads', async () => {
  const { commandEdits, readiness } = await import('../bridge/ui/story.js');
  const edits = (c) => commandEdits(run(c));
  assert.deepEqual(edits("sed -i 's/a/b/' src/a.js"), ['src/a.js']);
  assert.deepEqual(edits("cat >> test/x.test.js <<'EOF'\ntest(1)\nEOF"), ['test/x.test.js']);
  assert.deepEqual(edits(`node -e "const p = 'src/config.js'; fs.writeFileSync(p, s)"`), ['src/config.js']);
  assert.deepEqual(edits("python - <<'EOF'\np='test/h.test.js'\nopen(p,'w').write(s)\nEOF"), ['test/h.test.js']);
  assert.deepEqual(edits(`npm test > "$TEMP/t.out" 2>&1`), []);
  assert.deepEqual(edits(`node -e "const s = fs.readFileSync('src/a.js'); fs.writeFileSync('/tmp/x.js', s)"`), []);
  assert.deepEqual(edits('echo hi > README.md'), []);
  assert.deepEqual(edits('sed -n 5p src/a.js'), []);
  // Code edited with sed, then tests: "Ready to merge?" is asked, and knows the tests came after.
  const r = readiness({ steps: [run("sed -i 's/a/b/' src/a.js"), { ...run('npm test'), body: { command: 'npm test', output: 'Tests: 4 passed' } }], end: { kind: 'done' } });
  assert.equal(r.ready, true);
  const stale = readiness({ steps: [{ ...run('npm test'), body: { command: 'npm test', output: 'Tests: 4 passed' } }, run("sed -i 's/a/b/' src/a.js")], end: { kind: 'done' } });
  assert.ok(stale.problems.some((p) => /after the last test run/.test(p)));
});

test('review fixes: a test target left failing blocks merging; a retry that failed by its counts gets one line', async () => {
  const { readiness, turnMarkdown } = await import('../bridge/ui/story.js');
  const out = (command, output, status = 'ok') => ({ ...run(command, status), body: { command, output } });
  // `npm run test:unit` fails and a different target passes: not ready.
  const r = readiness({ steps: [edit('src/a.js'), out('npm run test:unit', 'Tests: 1 failed, 4 passed', 'failed'), out('npm run test:lint', 'Tests: 3 passed')], end: { kind: 'done' } });
  assert.equal(r.ready, false);
  assert.ok(r.problems.includes('`npm run test:unit` failed and wasn’t fixed'), r.problems.join(' | '));
  // Two runs that fail by their output (exit 0): one ❌ line, not two.
  const md = turnMarkdown({ steps: [edit('src/a.js'), out('npm test; echo done', 'Tests: 1 failed, 4 passed'), out('npm test; echo done', 'Tests: 1 failed, 4 passed')], end: { kind: 'done' }, harness: 'claude' });
  assert.equal((md.match(/^- Tests: /gm) ?? []).length, 1, md);
});

test('review fixes: sudo or Stop-Process inside a quoted search pattern isn’t risky', () => {
  assert.deepEqual(flags([run('grep -rn "sudo" src')]), []);
  assert.deepEqual(flags([run('grep -n "Stop-Process" scripts/a.ps1')]), []);
  assert.ok(flags([run('sudo apt install jq')]).some((f) => f.text === 'Changed system permissions'));
});

test('review fixes: a request still running isn’t "cut off"; wrapper options with values don’t hide the command', async () => {
  const { turnMarkdown, recapMarkdown, parts } = await import('../bridge/ui/story.js');
  const running = { session: 's', at: 2000, steps: [edit('src/a.js')], end: null, harness: 'claude' };
  assert.doesNotMatch(turnMarkdown(running), /Why it stopped/); // not known: no stop reason
  assert.doesNotMatch(turnMarkdown(running, { live: true }), /Why it stopped/);
  assert.match(turnMarkdown(running, { live: false }), /Why it stopped: Cut off/);
  // In a recap, an end-less request that isn't its session's newest was cut off; the newest may be running.
  const older = { ...running, at: 1000, prompt: { title: 'first' } };
  const md = recapMarkdown('Today', [older, { ...running, prompt: { title: 'second' } }]);
  assert.equal((md.match(/Why it stopped: Cut off/g) ?? []).length, 1);
  assert.deepEqual(parts('ls | xargs -n 1 rm -rf'), ['ls', 'rm -rf']);
  assert.deepEqual(parts('sudo -u root rm -rf /var/app'), ['rm -rf /var/app']);
  assert.deepEqual(parts('timeout -s KILL 30 npm test'), ['npm test']);
  assert.ok(flags([run('printf x | xargs -n 1 rm -rf')]).some((f) => f.text === 'Deleted files with a recursive delete'));
});
