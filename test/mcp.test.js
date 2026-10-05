import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep the bridge away from the real home folder: no Codex watcher, no history file.
process.env.DOTPALS_CODEX = '0';
process.env.DOTPALS_CLAUDE_LOGS = '0';
process.env.DOTPALS_HISTORY = '0';
delete process.env.DOTPALS_BRIDGE;
const home = await mkdtemp(join(tmpdir(), 'dotpals-home-'));
process.env.DOTPALS_HOME = home;
after(() => rm(home, { recursive: true, force: true }));

const { startBridge } = await import('../bridge/server.js');
const bin = fileURLToPath(new URL('../bin/dotpals.js', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// fetch refuses some ports outright, and Windows reserves a few (see server.test.js).
const BLOCKED = new Set([5985, 5986, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);
const freshPort = () => { let port; do port = 7200 + Math.floor(Math.random() * 2000); while (BLOCKED.has(port)); return port; };
async function start() {
  for (let tries = 0; ; tries++) {
    const port = freshPort();
    try {
      return { port, server: await startBridge({ port, log: () => {} }) };
    } catch (err) {
      if (!['EADDRINUSE', 'EACCES'].includes(err.code) || tries > 10) throw err;
    }
  }
}
const post = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const tick = () => new Promise((r) => setTimeout(r, 15)); // so every step gets its own time

/** `dotpals mcp` in `cwd`, talking to the bridge on `port`: send requests, read replies by id. */
function mcp(port, cwd) {
  const child = spawn(process.execPath, [bin, 'mcp'], { cwd, env: { ...process.env, DOTPALS_PORT: String(port) } });
  const waiting = new Map();
  const unasked = []; // replies nobody waited for (a notification must get none)
  const junk = []; // stdout lines that aren't JSON-RPC (there must be none)
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      let msg;
      try { msg = JSON.parse(line); } catch { junk.push(line); continue; }
      if (waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); } else unasked.push(msg);
    }
  });
  let next = 1;
  const reply = (id) => new Promise((ok) => waiting.set(id, ok));
  return {
    unasked, junk,
    raw(line, id = null) { const r = reply(id); child.stdin.write(`${line}\n`); return r; },
    call(method, params) { const id = next++; const r = reply(id); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); return r; },
    notify(method, params) { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); },
    async tool(name, args = {}) { return (await this.call('tools/call', { name, arguments: args })).result; },
    close() { const done = new Promise((ok) => child.on('exit', ok)); child.stdin.end(); return done; },
  };
}

test('dotpals mcp: answers from the running bridge, with the pal\'s rules', async (t) => {
  const { port, server } = await start();
  server.keepAliveTimeout = 60_000; // the server runs as a child process, which can be slow on CI
  const folder = realpathSync(await mkdtemp(join(tmpdir(), 'dotpals-mcp-'))); // macOS: /var is /private/var, as the server sees it
  const shop = join(folder, 'shop'); // the folder the assistant runs in, and the Claude session's project
  mkdirSync(shop);

  // Codex fixing billing in another project.
  await post(port, '/event', { session: 'codex-api-1', harness: 'codex', label: 'api', state: 'working', activity: { kind: 'prompt', title: 'Fix the billing bug', status: 'info' } });
  await tick();
  await post(port, '/event', { session: 'codex-api-1', harness: 'codex', label: 'api', state: 'working', activity: { kind: 'edit', title: 'billing.ts', status: 'ok', files: [{ path: '/work/api/billing.ts', change: 'edit' }] } });
  await tick();

  // Claude Code in shop: changes login.js, the tests fail, it fixes it, they pass, it stops.
  const hook = async (e) => { await post(port, '/hook', { session_id: 'sess-shop-1', cwd: shop, ...e }); await tick(); };
  const edit = async (id, file) => {
    const tool_input = { file_path: join(shop, 'src', file), old_string: 'a', new_string: 'b' };
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: id, tool_input });
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: id, tool_input, tool_response: {} });
  };
  const npmTest = async (id, passed) => {
    const tool_input = { command: 'npm test' };
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: id, tool_input });
    if (passed) await hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: id, tool_input, tool_response: { stdout: '✔ logs in\n✔ logs out\nℹ tests 2\nℹ pass 2\nℹ fail 0', stderr: '' } });
    else await hook({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: id, tool_input, error: 'Exit code 1\n✔ logs out\n✖ logs in\nℹ tests 2\nℹ pass 1\nℹ fail 1' });
  };
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Add a login page' });
  await edit('e1', 'login.js');
  await npmTest('b1', false);
  await edit('e2', 'login.js');
  await npmTest('b2', true);
  await hook({ hook_event_name: 'Stop', last_assistant_message: 'Added the login page. All tests pass.' });

  // Then Codex starts in shop too: now the newest session there.
  await post(port, '/event', { session: 'codex-shop-1', harness: 'codex', label: 'shop', state: 'working', activity: { kind: 'prompt', title: 'Write the docs', status: 'info' } });

  const client = mcp(port, shop);
  t.after(async () => {
    await client.close(); // before removing the folder it runs in
    server.closeAllConnections();
    server.close();
    await rm(folder, { recursive: true, force: true });
  });

  const init = await client.call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.0.0' } });
  assert.equal(init.result.protocolVersion, '2025-03-26'); // the client's, when it's one we speak
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.deepEqual(init.result.serverInfo, { name: 'dotpals', version });
  assert.match(init.result.instructions, /check_my_work/);
  client.notify('notifications/initialized');
  assert.deepEqual((await client.call('ping')).result, {});
  assert.deepEqual(client.unasked, []); // the notification got no reply

  const { tools } = (await client.call('tools/list')).result;
  assert.deepEqual(tools.map((x) => x.name), ['agents_now', 'test_status', 'ready_to_merge', 'recap', 'today', 'risky_steps', 'handoff_note', 'check_my_work']);
  for (const x of tools) assert.equal(x.inputSchema.type, 'object');

  const now = (await client.tool('agents_now')).content[0].text;
  assert.match(now, /^Codex in shop: working \(session codex-shop-1\)\n {2}Asked: “Write the docs”/); // newest first
  assert.match(now, /Claude Code in shop: finished just now \(session sess-shop-1\)\n {2}Asked: “Add a login page”\n {2}Result: .*the tests passed after one retry\.\n {2}Tests passed · 2 passed · .*, after the last change/);
  assert.match(now, /Codex in api: working \(session codex-api-1\)\n {2}Asked: “Fix the billing bug”\n {2}Now: Edited billing\.ts/);

  // Default: the newest session in this folder's project (Codex's, which changed nothing yet).
  assert.match((await client.tool('test_status')).content[0].text, /^Codex in shop: working.*\nNo code changed and no tests ran in this session\.$/);
  // A session by the start of its ID.
  assert.match((await client.tool('test_status', { session: 'sess-shop' })).content[0].text, /^Claude Code in shop: finished.*\nTests passed · 2 passed · .*, after the last change$/);

  const ready = (await client.tool('ready_to_merge', { session: 'sess-shop' })).content[0].text;
  assert.match(ready, /\n✅ Ready to merge\n✓ Tests ran\n✓ Tests ran after the last change\n✓ Tests passed\n✓ No failures left behind\n✓ Nothing risky\n/);
  // Still working: the checks as they stand right now, not "ask again later".
  assert.match((await client.tool('ready_to_merge', { project: 'api' })).content[0].text, /Codex in api: working.*\nStill working, so this is how it stands right now:\n⚠ Not ready to merge\n✗ No tests ran/);

  const recap = (await client.tool('recap', { project: 'shop' })).content[0].text; // a name: by the folder's name
  assert.match(recap, /^shop: 2 requests since /);
  assert.match(recap, /Claude Code in shop: “Add a login page”\n {2}.*the tests passed after one retry\.\n {2}Files: login\.js/);
  assert.match(recap, /Codex in shop: “Write the docs”/);
  // A path: where Claude worked (its hooks say), so another "shop" isn't it. Codex sent no folder: by name.
  assert.match((await client.tool('recap', { project: '/somewhere/else/shop' })).content[0].text, /^shop: 1 request since .*\n\n.*Codex in shop: “Write the docs”\n {2}Thinking…$/);
  assert.match((await client.tool('recap', { project: 'shop', since: '0' })).content[0].text, /^Nothing from shop since /);
  const nope = (await client.tool('recap', { project: 'nope' })).content[0].text;
  assert.equal(nope, `dotpals has seen no agent working in nope. Projects it knows: shop, ${shop}, api. Pass one as \`project\`.`);
  const badSince = await client.call('tools/call', { name: 'recap', arguments: { since: 'yesterday-ish' } });
  assert.equal(badSince.error.code, -32602);

  // check_my_work: Claude Code asking checks Claude's own session, though Codex's is newer.
  assert.match((await client.tool('check_my_work')).content[0].text, /^Looks done \(Claude Code in shop, session sess-shop-1\): tests passed after the last change, nothing risky\. Tests passed · 2 passed/);
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Tidy up' });
  await edit('e3', 'util.js');
  const stale = (await client.tool('check_my_work')).content[0].text;
  assert.match(stale, /^Not done yet \(Claude Code in shop, session sess-shop-1\):\n✗ Changed `util\.js` after the last test run\nTests passed at .* · 1 file changed since\nRun the tests, then call check_my_work again\.$/);

  // Protocol errors.
  assert.equal((await client.call('tools/call', { name: 'nope' })).error.code, -32602);
  assert.equal((await client.call('resources/list')).error.code, -32601);
  const parse = await client.raw('{not json');
  assert.equal(parse.id, null);
  assert.equal(parse.error.code, -32700);
  assert.deepEqual(client.junk, []); // stdout carried only protocol messages
});

test('dotpals mcp: the evidence (why tests failed, tests changed to pass), real folders, branches and the other tools', async (t) => {
  const { port, server } = await start();
  server.keepAliveTimeout = 60_000;
  const folder = realpathSync(await mkdtemp(join(tmpdir(), 'dotpals-mcp-')));
  // Two projects called "api" in different places, and a monorepo with a package in it.
  const apiA = join(folder, 'a', 'api');
  const apiB = join(folder, 'b', 'api');
  const mono = join(folder, 'mono');
  const web = join(mono, 'packages', 'web');
  for (const dir of [apiA, apiB, web]) mkdirSync(dir, { recursive: true });
  const client = mcp(port, apiA);
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    server.close();
    await rm(folder, { recursive: true, force: true });
  });

  // Claude Code in a/api: a failing test run, then the assertion taken out, and they pass.
  const hook = async (e) => { await post(port, '/hook', { session_id: 'claude-a', cwd: apiA, ...e }); await tick(); };
  const edit = async (id, file, old_string, new_string) => {
    const tool_input = { file_path: join(apiA, file), old_string, new_string };
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: id, tool_input });
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: id, tool_input, tool_response: {} });
  };
  const npmTest = async (id, passed) => {
    const tool_input = { command: 'npm test' };
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: id, tool_input });
    if (passed) await hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: id, tool_input, tool_response: { stdout: '✔ sum adds\nℹ tests 1\nℹ pass 1\nℹ fail 0', stderr: '' } });
    else await hook({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: id, tool_input, error: `Exit code 1\n✖ sum adds\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n  -1 !== 3\n\n      at TestContext.<anonymous> (file:///C:/w/api/test/math.test.js:5:10) {\n    actual: -1,\n    expected: 3,\n  }\nℹ tests 2\nℹ pass 1\nℹ fail 1` });
  };
  await client.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code' } });
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix sum' });
  await edit('e1', 'src/math.js', 'a + b', 'a - b');
  await npmTest('b1', false);
  await hook({ hook_event_name: 'Stop', last_assistant_message: 'Done.' });

  const why = 'Why: expected 3, got -1 (test/math.test.js:5)';
  assert.match((await client.tool('test_status')).content[0].text, /^Claude Code in api: .*\nTests failed · 1 failed, 1 passed.*\nWhy: expected 3, got -1 \(test\/math\.test\.js:5\)$/);
  const failing = (await client.tool('check_my_work')).content[0].text;
  assert.match(failing, /^Not done yet \(Claude Code in api, session claude-a\):\n✗ Tests are failing\n/);
  assert.ok(failing.endsWith(`\n${why}\nFix the failing tests, then run them again and call check_my_work again.`), failing);
  const failed = (await client.tool('recap')).content[0].text;
  assert.ok(failed.includes(`“Fix sum”\n  Changed math.js, and the tests are failing.\n  ${why}\n  Files: math.js`), failed);

  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Make the tests pass' });
  await edit('e2', 'test/math.test.js', '  assert.equal(sum(1, 2), 3);\n', '');
  await npmTest('b2', true);
  await hook({ hook_event_name: 'Stop', last_assistant_message: 'All tests pass.' });
  const faked = (await client.tool('check_my_work')).content[0].text;
  assert.match(faked, /^Not done yet \(Claude Code in api, session claude-a\):\n✗ Changed the tests to make them pass: removed 1 assertion in math\.test\.js\nTests passed · 1 passed · .*, but only after the tests were changed: removed 1 assertion in math\.test\.js\nPut the test back and fix the code, or tell the user why the test was wrong, then call check_my_work again\.$/);
  const recap = (await client.tool('recap', { session: 'claude-a' })).content[0].text;
  assert.match(recap, /“Make the tests pass”\n {2}Changed math\.test\.js, and the tests passed\.\n {2}⚠ Tests passed only after they were changed: removed 1 assertion in math\.test\.js\n/);
  assert.match((await client.tool('agents_now')).content[0].text, /Result: Changed math\.test\.js, and the tests passed\.\n {2}⚠ Tests passed only after they were changed: removed 1 assertion in math\.test\.js/);

  // today: per agent, the counts, then each request.
  const today = (await client.tool('today')).content[0].text;
  assert.match(today, /^Today in api\n\nClaude Code: 2 requests · 2 files changed · 2 test runs\n {2}\S.* “Fix sum”\n {4}Changed math\.js, and the tests are failing/);
  assert.match(today, /“Make the tests pass”\n {4}Changed math\.test\.js, and the tests passed\.\n {4}⚠ Tests passed only after they were changed/);

  // The hand-off note, with paths from the session's own folder.
  const note = (await client.tool('handoff_note', { session: 'claude-a' })).content[0].text;
  assert.match(note, /^# Hand-off from Claude · api\n/);
  assert.match(note, /- `src\/math\.js` \(changed\)/);

  // Codex in b/api, also called "api": a force push. Only its own folder's tools see it.
  const codex = (activity) => post(port, '/event', { session: 'codex-b', harness: 'codex', cwd: apiB, activity });
  await codex({ id: 'p1', kind: 'prompt', title: 'Ship it', status: 'info' });
  await tick();
  await codex({ id: 'r1', kind: 'run', title: 'git push --force origin main', status: 'ok', body: { command: 'git push --force origin main' } });
  await tick();
  assert.match((await client.tool('risky_steps', { project: apiB })).content[0].text, /^api: 1 risky step since .*\n.* · Codex in api: Force-pushed to git \(`git push --force origin main`\)$/);
  assert.match((await client.tool('risky_steps')).content[0].text, /^Nothing risky from api since /); // a/api: not Codex's
  assert.match((await client.tool('test_status', { project: apiB })).content[0].text, /^Codex in api: working \(session codex-b\)/);
  assert.match((await client.tool('test_status')).content[0].text, /^Claude Code in api: finished .*\(session claude-a\)/);

  // An agent in a monorepo's package: the monorepo's path finds it, though the names differ.
  const git = (...args) => execFileSync('git', args, { cwd: mono, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(web, 'index.js'), 'a\n');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'start');
  git('checkout', '-q', '-b', 'feat/web');
  const agent = (activity) => post(port, '/event', { session: 'web-1', harness: 'my-agent', cwd: web, activity: { at: Date.now(), ...activity } });
  await agent({ id: 'p1', kind: 'prompt', title: 'Change the page', status: 'info' });
  await new Promise((r) => setTimeout(r, 400)); // git's "before"
  writeFileSync(join(web, 'index.js'), 'b\n');
  await agent({ id: 'e1', kind: 'edit', title: 'index.js', status: 'ok', files: [{ path: join(web, 'index.js'), change: 'edit' }] });
  await agent({ id: 'd1', kind: 'done', title: 'Finished', status: 'ok' });
  for (let i = 0; i < 40; i++) { // git's "after" comes a moment later
    const { entries } = await (await fetch(`http://127.0.0.1:${port}/api/activity`)).json();
    if (entries.some((e) => e.id === 'web-1:d1' && e.git)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match((await client.tool('test_status', { project: mono })).content[0].text, /^My-agent in web: finished .*\(session web-1\)\nNo tests run by the agent · 1 code file changed$/);
  const branch = (await client.tool('ready_to_merge', { branch: 'feat/web' })).content[0].text;
  assert.match(branch, /^My-agent in web: finished .*\(session web-1\)\nOn branch feat\/web at [0-9a-f]{7}\n⚠ Not ready to merge\n✗ No tests ran\n/);
  // What git has now (GET /api/git): the change isn't committed, so a merge wouldn't take it.
  assert.match(branch, /\n✗ Not committed yet: packages\/web\/index\.js\. A merge wouldn’t include it\.\n/);
  assert.equal((await client.tool('ready_to_merge', { branch: 'nope' })).content[0].text, 'dotpals hasn’t seen an agent work on branch nope. It notes the branch when an agent finishes a request in a git repository.');

  // A test that was failing before the session changed anything: found, not caused. Not "fix it".
  const hookC = async (e) => { await post(port, '/hook', { session_id: 'claude-c', cwd: apiA, ...e }); await tick(); };
  const runC = async (id) => {
    const tool_input = { command: 'npm test' };
    await hookC({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: id, tool_input });
    await hookC({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: id, tool_input, error: 'Exit code 1\n✖ sum adds two numbers (0.9ms)\nℹ tests 2\nℹ pass 1\nℹ fail 1' });
  };
  await hookC({ hook_event_name: 'UserPromptSubmit', prompt: 'How do the tests look?' });
  await runC('c1');
  await hookC({ hook_event_name: 'UserPromptSubmit', prompt: 'Add divide' });
  const input = { file_path: join(apiA, 'src/math.js'), old_string: 'x', new_string: 'y' };
  await hookC({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'ce', tool_input: input });
  await hookC({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 'ce', tool_input: input, tool_response: {} });
  await runC('c2');
  const found = (await client.tool('check_my_work', { session: 'claude-c' })).content[0].text;
  assert.match(found, /^Looks done \(Claude Code in api, session claude-c\): for your part\./);
  assert.match(found, /\nThe failing tests \(sum adds two numbers\) were failing before this session changed anything, so they aren’t yours to fix unless the user asks: tell the user about them\./);
});

test('dotpals mcp: an older bridge, without /api/sessions, still answers by the folder\'s name', async (t) => {
  const at = Date.now();
  const entries = [
    { id: 'old:p', session: 'old', harness: 'claude', label: 'shop', kind: 'prompt', title: 'Add a page', status: 'info', at },
    { id: 'old:d', session: 'old', harness: 'claude', label: 'shop', kind: 'done', title: 'Finished', status: 'ok', at: at + 1 },
  ];
  const old = createServer((req, res) => {
    res.writeHead(req.url === '/api/activity' ? 200 : 403, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/activity' ? { entries } : { error: 'forbidden' }));
  });
  await new Promise((ok) => old.listen(0, '127.0.0.1', ok));
  const folder = await mkdtemp(join(tmpdir(), 'dotpals-mcp-'));
  mkdirSync(join(folder, 'shop'));
  const client = mcp(old.address().port, join(folder, 'shop'));
  t.after(async () => {
    await client.close();
    old.closeAllConnections();
    old.close();
    await rm(folder, { recursive: true, force: true });
  });
  assert.match((await client.tool('test_status')).content[0].text, /^Claude Code in shop: finished just now \(session old\)\nNo code changed and no tests ran in this session\.$/);
});

test('dotpals mcp: with no bridge running, every tool says how to start it', async (t) => {
  const client = mcp(freshPort(), tmpdir());
  t.after(() => client.close());
  await client.call('initialize', { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'cursor' } }).then((r) => assert.equal(r.result.protocolVersion, '2025-06-18'));
  for (const name of ['agents_now', 'test_status', 'ready_to_merge', 'recap', 'today', 'risky_steps', 'handoff_note', 'check_my_work']) {
    const r = await client.tool(name);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /^dotpals isn.t running\. Start it with `npx dotpals start`/);
  }
});
