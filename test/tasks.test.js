import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeTaskArgs, detectTestCommand, evaluate, fixRequest, makePlan, parsePlanReply, pickProject, plannerArgs, receiptMarkdown, relativeTo, sessionName, taskMarkdown, tidyPath, under, verdictWords } from '../bridge/tasks.js';
import { launchCommand } from '../bridge/handoff.js';

const projects = [{ path: '/code/shop', name: 'shop' }, { path: '/code/dotpals', name: 'dotpals' }, { path: '/code/billing-api', name: 'billing-api' }];

test('pickProject: exact, prefix, a name heard slightly wrong, or the newest (guessed)', () => {
  assert.equal(pickProject('shop', projects).project.name, 'shop');
  assert.equal(pickProject('Dot Pals', projects).project.name, 'dotpals');
  assert.equal(pickProject('billing', projects).project.name, 'billing-api');
  assert.equal(pickProject('shopp', projects).project.name, 'shop');
  assert.deepEqual(pickProject('', projects), { project: projects[0], guessed: true });
  assert.deepEqual(pickProject('payroll', projects), { project: projects[0], guessed: true });
  assert.deepEqual(pickProject('shop', []), { project: null, guessed: true });
});

test('detectTestCommand: from the files in the project, and only commands the test rules recognise', () => {
  const fs = (files) => ({ exists: (f) => Object.keys(files).some((k) => f.replace(/\\/g, '/').endsWith(`/${k}`)), read: (f) => files[Object.keys(files).find((k) => f.replace(/\\/g, '/').endsWith(`/${k}`))], list: () => Object.keys(files) });
  assert.equal(detectTestCommand('/p', fs({ 'package.json': '{"scripts":{"test":"node --test"}}' })), 'npm test');
  assert.equal(detectTestCommand('/p', fs({ 'package.json': '{"scripts":{"test":"vitest"}}', 'pnpm-lock.yaml': '' })), 'pnpm test');
  assert.equal(detectTestCommand('/p', fs({ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' })), null);
  assert.equal(detectTestCommand('/p', fs({ 'pyproject.toml': '[tool.pytest.ini_options]' })), 'pytest');
  assert.equal(detectTestCommand('/p', fs({ 'go.mod': 'module x' })), 'go test ./...');
  assert.equal(detectTestCommand('/p', fs({ 'Cargo.toml': '' })), 'cargo test');
  assert.equal(detectTestCommand('/p', fs({ 'Makefile': 'build:\n\tgo build\ntest:\n\tgo test' })), 'make test');
  assert.equal(detectTestCommand('/p', fs({ 'README.md': '' })), null);
});

test('parsePlanReply: structured output, a JSON reply in text, errors', () => {
  const plan = { title: 'Fix the checkout test', task: 'Fix checkout.spec', project: 'shop', mustNotTouch: ['./cart/', '../etc'], doneAlso: ['The README mentions it'] };
  const a = parsePlanReply(JSON.stringify({ is_error: false, structured_output: plan, result: '' }));
  assert.equal(a.title, 'Fix the checkout test');
  assert.deepEqual(a.mustNotTouch, ['cart']); // tidied; ".." refused
  const b = parsePlanReply(JSON.stringify({ result: `\`\`\`json\n${JSON.stringify({ ...plan, title: '' })}\n\`\`\`` }));
  assert.equal(b.title, 'Fix checkout.spec'); // no title: from the task
  assert.throws(() => parsePlanReply(JSON.stringify({ is_error: true, result: 'Not logged in' })), /Not logged in/);
  assert.throws(() => parsePlanReply('nope'), /wasn’t JSON/);
  assert.throws(() => parsePlanReply(JSON.stringify({ structured_output: { ...plan, task: '' } })), /no task/);
});

test('plannerArgs: lean (no tools, MCP servers, settings or sessions) and no text from the request', () => {
  const args = plannerArgs('/home/.dotpals/tasks/planner-system.txt');
  for (const flag of ['-p', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--json-schema']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.ok(!plannerArgs('/f', { schema: false }).includes('--json-schema'));
});

test('tidyPath: relative, forward slashes, never ".."', () => {
  assert.equal(tidyPath('.\\src\\cart\\'), 'src/cart');
  assert.equal(tidyPath('/cart'), 'cart');
  assert.equal(tidyPath('../secret'), '');
  assert.equal(tidyPath('a/../../b'), '');
});

test('makePlan + taskMarkdown: the definition of done always has the tests, then what you asked', () => {
  const plan = makePlan({ text: 'have claude fix the checkout test in shop, don’t touch cart', reply: { title: 'Fix the checkout test', task: 'Fix checkout.spec.', project: 'shop', mustNotTouch: ['cart'], doneAlso: ['Explain the fix'] }, projects, testCommand: () => 'npm test' });
  assert.equal(plan.project.name, 'shop');
  assert.equal(plan.guessedProject, false);
  assert.deepEqual(plan.done.map((d) => d.kind), ['tests', 'untouched', 'manual']);
  const md = taskMarkdown(plan);
  assert.match(md, /`npm test` passes, run after your last change/);
  assert.match(md, /Don’t change anything in `cart`/);
  assert.match(md, /- Explain the fix/);
  assert.throws(() => makePlan({ text: 'x', reply: { title: 't', task: 't', project: '', mustNotTouch: [], doneAlso: [] }, projects: [] }), /doesn’t know any project/);
});

test('claudeTaskArgs and the terminal: our session id, a safe name, and nothing a Windows terminal can’t quote', () => {
  assert.equal(sessionName('Fix "checkout"; 100% now'), 'Blu: Fix checkout 100 now');
  const args = claudeTaskArgs({ sessionId: '11111111-2222-3333-4444-555555555555', title: 'Fix the test', prompt: 'Read C:\\tasks\\t.md and do the task it describes. Follow its definition of done.' });
  assert.deepEqual(args.slice(0, 4), ['--session-id', '11111111-2222-3333-4444-555555555555', '-n', 'Blu: Fix the test']);
  const cmd = launchCommand({ platform: 'win32', agent: 'claude', dir: 'C:\\code\\shop', args, has: () => true, find: () => 'C:\\bin\\claude.exe' });
  assert.equal(cmd.file, 'wt.exe');
  assert.match(cmd.args.at(-1), /"C:\\bin\\claude\.exe" --session-id "11111111-2222-3333-4444-555555555555" -n "Blu: Fix the test" "Read C:\\tasks\\t\.md/);
  const bad = launchCommand({ platform: 'win32', agent: 'claude', dir: 'C:\\code\\shop', args: ['-n', 'a"b', 'x'], has: () => true, find: () => 'C:\\bin\\claude.exe' });
  assert.ok(bad.error);
  // Without args, the hand-off still works as before.
  assert.equal(launchCommand({ platform: 'win32', agent: 'codex', dir: 'C:\\code', prompt: 'Read x.md', has: () => false, find: () => 'C:\\bin\\codex.cmd' }).file, 'cmd.exe');
});

test('relativeTo and under: files inside the project, folders matched whole', () => {
  assert.equal(relativeTo('/code/shop', '/code/shop/cart/total.js'), 'cart/total.js');
  assert.equal(relativeTo('/code/shop', '/code/other/x.js'), null);
  assert.equal(relativeTo('/code/shop', 'src/a.js'), 'src/a.js');
  assert.ok(under('cart/total.js', 'cart'));
  assert.ok(under('cart', 'cart'));
  assert.ok(!under('cartography/x.js', 'cart'));
});

// -- checking a task -----------------------------------------------------------------------------

let n = 0;
const S = 'task-session';
const T0 = 10_000;
const step = (kind, extra = {}) => ({ id: `e${n++}`, session: S, harness: 'claude', kind, status: 'ok', at: T0 + 100 * n, ...extra });
const prompt = () => step('prompt', { title: 'Read /h/tasks/t.md and do the task it describes.' });
const edit = (path) => step('edit', { title: path, files: [{ path: `/code/shop/${path}`, change: 'edit' }] });
const tests = (output = 'Tests: 12 passed, 12 total') => step('run', { tool: 'Bash', title: 'npm test', body: { command: 'npm test', output } });
const done = () => step('done', { summary: 'Fixed the checkout test; npm test passes.' });
const task = () => makePlan({ text: 'fix the checkout test, don’t touch cart', reply: { title: 'Fix the checkout test', task: 'Fix it', project: 'shop', mustNotTouch: ['cart'], doneAlso: ['Explain the fix'] }, projects, testCommand: () => 'npm test' });
const sent = () => ({ ...task(), id: 'task-1', session: S, startedAt: T0 });

test('evaluate: starting, then working with what it is doing', () => {
  assert.equal(evaluate(sent(), []).state, 'starting');
  const v = evaluate(sent(), [prompt(), edit('checkout.js')]);
  assert.equal(v.state, 'working');
  assert.equal(v.doing, 'checkout.js');
});

test('evaluate: ready when the tests ran after the last change and passed, and cart is untouched', () => {
  const v = evaluate(sent(), [prompt(), edit('checkout.js'), tests(), done()]);
  assert.equal(v.state, 'ready', v.problems?.join('; '));
  assert.ok(v.checks.some((c) => c.ok === true && /Nothing in cart changed/.test(c.text)));
  assert.ok(v.checks.some((c) => c.ok === null && /Explain the fix/.test(c.text)));
  assert.deepEqual(v.changed, ['checkout.js']);
  assert.match(verdictWords(sent(), v), /^Claude is done\. .*Ready to merge\. Want a PR\?$/);
  assert.match(receiptMarkdown(sent(), v), /✅ Nothing in cart changed[\s\S]*`checkout\.js`/);
});

test('evaluate: not ready when it changed code after the tests, or touched what it shouldn’t', () => {
  const stale = evaluate(sent(), [prompt(), edit('checkout.js'), tests(), edit('tax.js'), done()]);
  assert.equal(stale.state, 'not-ready');
  assert.match(stale.problems.join(' '), /tax\.js/);
  assert.match(verdictWords(sent(), stale), /^Claude says it's done, but it isn't ready: /);
  assert.match(fixRequest(sent(), stale), /run `npm test` again after your last change/);
  const touched = evaluate(sent(), [prompt(), edit('cart/total.js'), tests(), done()]);
  assert.equal(touched.state, 'not-ready');
  assert.match(touched.problems.join(' '), /Changed cart\/total\.js in cart/);
});

test('evaluate: a later request in the same session counts ("run the tests" typed afterwards)', () => {
  const first = [prompt(), edit('checkout.js'), done()];
  assert.equal(evaluate(sent(), first).state, 'not-ready');
  const second = [...first, step('prompt', { title: 'run the tests' }), tests(), done()];
  assert.equal(evaluate(sent(), second).state, 'ready');
});

test('evaluate: no code changed, other sessions and older steps don’t count', () => {
  const v = evaluate(sent(), [prompt(), step('read', { title: 'a.js', files: [{ path: '/code/shop/a.js', change: 'read' }] }), done()]);
  assert.equal(v.state, 'no-changes');
  const other = { ...edit('x.js'), session: 'someone-else' };
  const old = { ...edit('y.js'), at: T0 - 60_000 };
  assert.equal(evaluate(sent(), [other, old]).state, 'starting');
});
