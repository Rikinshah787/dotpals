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
    run('rm -rf build'),
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
