// The desktop app runs the bridge as a process of its own (desktop/main.js), so a busy
// bridge can't freeze the pal's window: bridge/server.js has to work when run that way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('../bridge/server.js', import.meta.url));
const BLOCKED = new Set([5985, 5986, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);
const freshPort = () => { let port; do port = 8900 + Math.floor(Math.random() * 900); while (BLOCKED.has(port)); return port; };

/** Run the bridge the way the desktop app does; resolves once it answers. */
async function runBridge(t, env = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dotpals-child-'));
  const port = freshPort();
  const child = spawn(process.execPath, [server], {
    env: { ...process.env, DOTPALS_PORT: String(port), DOTPALS_HOME: home, DOTPALS_DESKTOP_CHILD: '1', DOTPALS_CODEX: '0', DOTPALS_CLAUDE_LOGS: '0', DOTPALS_HISTORY: '0', ...env },
    stdio: 'ignore',
  });
  const exited = new Promise((ok) => child.once('exit', (code) => ok(code)));
  t.after(async () => { child.kill(); await exited.catch(() => {}); await rm(home, { recursive: true, force: true }); });
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/agents`);
      if (res.ok) return { port, exited };
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('the bridge never answered');
}

test('the bridge runs as its own process, on the port it is given', async (t) => {
  const { port } = await runBridge(t);
  const { agents } = await (await fetch(`http://127.0.0.1:${port}/api/agents`)).json();
  assert.ok(Array.isArray(agents) && agents.length > 0);
});

test('run by the desktop app, what the bridge starts does not get ELECTRON_RUN_AS_NODE', async (t) => {
  // "OpenCode" here is plain Node with a preload that writes down the env it got and exits:
  // the bridge starts it for the first chat message (bridge/chat.js).
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const record = join(dir, 'env.json');
  const preload = join(dir, 'record.cjs');
  await writeFile(preload, `if (process.argv.includes('--port')) { require('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ value: process.env.ELECTRON_RUN_AS_NODE ?? null })); process.exit(0); }\n`);
  const { port } = await runBridge(t, {
    ELECTRON_RUN_AS_NODE: '1',
    DOTPALS_OPENCODE_BIN: process.execPath,
    DOTPALS_OPENCODE_PORT: String(freshPort()),
    NODE_OPTIONS: `--require "${preload.replace(/\\/g, '/')}"`, // NODE_OPTIONS eats backslashes
  });
  const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dotpals': '1' }, body: JSON.stringify(body) });
  assert.equal((await post('/api/config', { chat: true })).status, 200);
  await post('/api/chat', { text: 'hi' }); // fails (our "OpenCode" exits), after it started
  const { value } = JSON.parse(await readFile(record, 'utf8'));
  assert.equal(value, null, 'a spawned Electron app would start as plain Node');
});

test('run by the desktop app, the bridge exits with 75 when setup asks the app to quit', async (t) => {
  const { port, exited } = await runBridge(t);
  const res = await fetch(`http://127.0.0.1:${port}/api/app/quit`, { method: 'POST', headers: { 'x-dotpals': '1' } });
  assert.equal(res.status, 200);
  assert.equal(await exited, 75, 'the app sees this code and quits too');
});
