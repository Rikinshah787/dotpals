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
