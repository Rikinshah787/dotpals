import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HANDOFF_AGENTS, handoffPrompt, installedAgents, launchCommand, onPath } from '../bridge/handoff.js';
import { handoffNote } from '../bridge/ui/handoff.js';

process.env.DOTPALS_CODEX = '0';
process.env.DOTPALS_CLAUDE_LOGS = '0';
process.env.DOTPALS_HISTORY = '0';
const home = await mkdtemp(join(tmpdir(), 'dotpals-handoff-'));
process.env.DOTPALS_HOME = home;
after(() => rm(home, { recursive: true, force: true }));
const { startBridge } = await import('../bridge/server.js');

const T = 1_800_000_000_000;
const S = 'claude:abc12345';
const base = { session: S, harness: 'claude', label: 'shop' };
/** A scripted session: two requests, edits, a failing test run, a plan and the agent's last word. */
const session = [
  { ...base, id: 'p1', at: T, kind: 'prompt', title: 'Add a discount code field to checkout', status: 'info' },
  { ...base, id: 'r1', at: T + 1000, kind: 'read', title: 'src/checkout.ts', files: [{ path: '/w/shop/src/checkout.ts', change: 'read' }], status: 'ok' },
  { ...base, id: 'e1', at: T + 2000, kind: 'edit', title: 'src/checkout.ts', files: [{ path: '/w/shop/src/checkout.ts', change: 'edit' }], status: 'ok', body: { patch: '-a\n+b' } },
  { ...base, id: 'd1', at: T + 3000, kind: 'done', title: 'Finished', status: 'ok', summary: 'Added the field.' },
  { ...base, id: 'p2', at: T + 10_000, kind: 'prompt', title: 'Now validate the code against the API', status: 'info' },
  { ...base, id: 'pl', at: T + 11_000, kind: 'plan', tool: 'TodoWrite', title: 'Updated the plan', status: 'ok', plan: [{ text: 'Call the API', status: 'completed' }, { text: 'Show an error for bad codes', status: 'in_progress' }, { text: 'Add tests', status: 'pending' }] },
  { ...base, id: 'w1', at: T + 12_000, kind: 'write', title: 'src/discount.ts', files: [{ path: '/w/shop/src/discount.ts', change: 'write' }], status: 'ok', body: { patch: '+x' } },
  { ...base, id: 't1', at: T + 13_000, kind: 'run', tool: 'Bash', title: 'npm test', status: 'failed', body: { command: 'npm test', output: '✖ rejects an expired code\n  AssertionError: expected 400, got 200\nℹ tests 12\nℹ pass 11\nℹ fail 1' } },
  { ...base, id: 'x1', at: T + 14_000, kind: 'run', tool: 'Bash', title: 'Delete the env file', status: 'ok', body: { command: 'rm -rf .cache-x && cat .env' }, files: [{ path: '/w/shop/.env', change: 'edit' }] },
  { ...base, id: 'd2', at: T + 15_000, kind: 'done', title: 'Finished', status: 'ok', summary: 'Validation is in, but one test still fails.' },
  { session: 'other', harness: 'codex', label: 'api', id: 'o1', at: T, kind: 'prompt', title: 'Something else', status: 'info' },
];

test('handoffNote: the ask, what was done, files, failing tests with evidence, the plan, flags and the last message', () => {
  const note = handoffNote(session, { session: S, cwd: '/w/shop', now: T + 20_000, time: () => '7:00 PM' });
  assert.match(note, /^# Hand-off from Claude · shop\n/);
  assert.match(note, /You're continuing work another agent started\. Read this, check the current state .*then continue: “Now validate the code against the API”\./);
  assert.match(note, /## The original ask\n\n> Add a discount code field to checkout/);
  assert.match(note, /## The last request\n\n> Now validate the code against the API/);
  assert.match(note, /## What was done\n\n### Now validate the code against the API/); // the latest request's recap
  assert.match(note, /Tests: `npm test` → 1 failed, 11 passed/); // with its evidence
  assert.match(note, /Before that:\n- “Add a discount code field to checkout”: Changed checkout\.ts/);
  assert.match(note, /## Files changed in this session\n\n- `src\/checkout\.ts` \(changed\)/);
  assert.match(note, /- `src\/discount\.ts` \(written\)/);
  assert.match(note, /## Tests\n\nTests failed · 1 failed, 11 passed · 7:00 PM/);
  assert.match(note, /AssertionError: expected 400, got 200/); // the failure itself
  assert.match(note, /## Still on its plan \(1 of 3 done\)\n\n- \[ \] Show an error for bad codes \(it was on this one\)\n- \[ \] Add tests/);
  assert.match(note, /## Worth a second look\n\n(- .*\n)*- Changed \.env, which usually holds secrets/);
  assert.ok(!note.includes('Not tested: changed 1 code file (checkout.ts)'), 'an earlier request’s test flag is out of date');
  assert.match(note, /## Claude's last message\n\n> Validation is in, but one test still fails\./);
  assert.ok(!note.includes('Something else'), 'only this session');
  assert.equal(handoffNote(session, { session: 'nope' }), null);
});

test('launchCommand: Windows Terminal, a console window, macOS Terminal, Linux terminals (built, not run)', () => {
  const prompt = handoffPrompt('C:\\Users\\Me Too\\.dotpals\\handoff\\n1.md');
  assert.equal(prompt, 'Read C:\\Users\\Me Too\\.dotpals\\handoff\\n1.md and continue the work it describes.');
  const wt = launchCommand({ platform: 'win32', agent: 'codex', dir: 'C:\\work\\my shop\\', prompt, has: (c) => c === 'wt' });
  assert.deepEqual(wt, { file: 'wt.exe', args: ['-d', '"C:\\work\\my shop"', 'cmd', '/k', 'codex', `"${prompt}"`], options: { windowsVerbatimArguments: true } });
  const cmd = launchCommand({ platform: 'win32', agent: 'gemini', dir: 'C:\\R&D', prompt, has: () => false });
  assert.deepEqual(cmd, { file: 'cmd.exe', args: ['/d', '/c', 'start', '""', '/D', '"C:\\R&D"', 'cmd', '/k', 'gemini', '-i', `"${prompt}"`], options: { windowsVerbatimArguments: true } });
  // Windows Terminal splits at ";": a console window instead. cmd can't keep % or " literal: refused.
  assert.equal(launchCommand({ platform: 'win32', agent: 'claude', dir: 'C:\\a;b', prompt, has: () => true }).file, 'cmd.exe');
  assert.ok(launchCommand({ platform: 'win32', agent: 'claude', dir: 'C:\\100%', prompt, has: () => true }).error);
  assert.ok(launchCommand({ platform: 'win32', agent: 'claude', dir: 'C:\\x', prompt: 'say "hi"', has: () => true }).error);

  const mac = launchCommand({ platform: 'darwin', agent: 'claude', dir: "/Users/me/Bob's app", prompt: 'Read /Users/me/.dotpals/handoff/n1.md and continue the work it describes.' });
  assert.equal(mac.file, 'osascript');
  assert.equal(mac.args[1], `tell application "Terminal" to do script "cd '/Users/me/Bob'\\\\''s app' && 'claude' 'Read /Users/me/.dotpals/handoff/n1.md and continue the work it describes.'"`);
  assert.equal(mac.args[3], 'tell application "Terminal" to activate');

  const p = 'Read /home/me/.dotpals/handoff/n1.md and continue the work it describes.';
  assert.deepEqual(launchCommand({ platform: 'linux', agent: 'codex', dir: '/w/shop', prompt: p, has: (c) => c === 'gnome-terminal' }),
    { file: 'gnome-terminal', args: ['--working-directory=/w/shop', '--', 'codex', p], options: {} });
  assert.deepEqual(launchCommand({ platform: 'linux', agent: 'gemini', dir: '/w/shop', prompt: p, has: (c) => c === 'konsole' }),
    { file: 'konsole', args: ['--workdir', '/w/shop', '-e', 'gemini', '-i', p], options: {} });
  assert.deepEqual(launchCommand({ platform: 'linux', agent: 'claude', dir: '/w/shop', prompt: p, has: (c) => c === 'x-terminal-emulator' }),
    { file: 'x-terminal-emulator', args: ['-e', 'claude', p], options: { cwd: '/w/shop' } });
  assert.ok(launchCommand({ platform: 'linux', agent: 'claude', dir: '/w/shop', prompt: p, has: () => false }).error);
  // Only the allow-listed agents.
  assert.ok(launchCommand({ platform: 'linux', agent: 'bash', dir: '/w', prompt: p, has: () => true }).error);
  assert.ok(launchCommand({ platform: 'linux', agent: 'toString', dir: '/w', prompt: p, has: () => true }).error);
});

test('onPath and installedAgents: what’s installed', () => {
  const files = new Set([join('C:\\bin', 'codex.cmd'), join('/usr/bin', 'gemini')].map((f) => f.toLowerCase()));
  const exists = (f) => files.has(f.toLowerCase()); // Windows doesn't mind the case
  assert.equal(onPath('codex', { env: { PATH: 'C:\\x;C:\\bin', PATHEXT: '.EXE;.CMD' }, platform: 'win32', exists }), true);
  assert.equal(onPath('claude', { env: { PATH: 'C:\\x;C:\\bin', PATHEXT: '.EXE;.CMD' }, platform: 'win32', exists }), false);
  assert.deepEqual(installedAgents({ has: (c) => c !== 'claude' }).map((a) => a.id), ['codex', 'gemini']);
  assert.deepEqual(Object.keys(HANDOFF_AGENTS), ['codex', 'claude', 'gemini']);
});

// -- POST /api/handoff ------------------------------------------------------------------

const usedPorts = new Set();
const BLOCKED = new Set([5985, 5986, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
const freshPort = () => { let port; do port = 8900 + Math.floor(Math.random() * 1500); while (usedPorts.has(port) || BLOCKED.has(port)); usedPorts.add(port); return port; };

test('POST /api/handoff: header, origin, unknown session, allow-listed agents, and the folder comes from the session', async (t) => {
  const launched = [];
  let server;
  let port;
  for (let tries = 0; !server; tries++) {
    port = freshPort();
    try {
      server = await startBridge({ port, log: () => {}, handoff: { platform: 'linux', has: (c) => c === 'gnome-terminal' || c === 'codex', isFolder: (d) => d === '/w/shop', launch: async (cmd) => { launched.push(cmd); } } });
    } catch (err) { if (!['EADDRINUSE', 'EACCES'].includes(err.code) || tries > 10) throw err; }
  }
  t.after(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); });
  const url = `http://127.0.0.1:${port}`;
  const call = (body, headers = { 'x-dotpals': '1' }) => fetch(`${url}/api/handoff`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

  // A Claude Code session in /w/shop (its folder comes from its own events).
  await fetch(`${url}/hook`, { method: 'POST', body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'abc', cwd: '/w/shop', prompt: 'Fix the checkout' }) });

  assert.equal((await call({ session: 'abc', agent: 'codex' }, {})).status, 403, 'no dotpals header');
  assert.equal((await call({ session: 'abc', agent: 'codex' }, { 'x-dotpals': '1', origin: 'https://evil.example' })).status, 403, 'another website');
  assert.equal((await call({ session: 'nope', agent: 'codex' })).status, 404);
  assert.equal((await call({ session: 'abc', agent: 'bash' })).status, 400);
  assert.equal((await call({ session: 'abc', agent: '__proto__' })).status, 400);
  const missing = await call({ session: 'abc', agent: 'gemini' });
  assert.equal(missing.status, 400, 'not installed');
  assert.match(missing.body.note, /Fix the checkout/, 'the note comes back, to copy instead');

  const copy = await call({ session: 'abc', agent: 'copy' });
  assert.equal(copy.status, 200);
  assert.match(copy.body.note, /^# Hand-off from Claude · shop/);
  assert.equal(launched.length, 0);

  // A folder in the request is ignored: the session's own is used.
  const ok = await call({ session: 'abc', agent: 'codex', cwd: '/etc', dir: '/etc' }, { 'x-dotpals': '1', origin: url });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.dir, '/w/shop');
  assert.equal(launched.length, 1);
  assert.equal(launched[0].file, 'gnome-terminal');
  assert.deepEqual(launched[0].args, ['--working-directory=/w/shop', '--', 'codex', `Read ${ok.body.file} and continue the work it describes.`]);
  assert.ok(ok.body.file.startsWith(join(home, 'handoff')));
  assert.ok(existsSync(ok.body.file));
  assert.match(readFileSync(ok.body.file, 'utf8'), /continue: “Fix the checkout”/);

  // A session whose folder isn't known: no terminal, the note to copy.
  await fetch(`${url}/event`, { method: 'POST', body: JSON.stringify({ session: 'nofolder', harness: 'x', activity: { kind: 'prompt', title: 'hi' } }) });
  const unknown = await call({ session: 'nofolder', agent: 'codex' });
  assert.equal(unknown.status, 409);
  assert.ok(unknown.body.note);
  assert.equal(launched.length, 1);
});
