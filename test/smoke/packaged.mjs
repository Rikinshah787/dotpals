// Starts the packaged dotpals app (what electron-builder makes: dotpals.exe, dotpals.app) and
// checks what it adds over `dotpals start`: it runs with no Node, writes ~/.dotpals/runtime.json
// and ~/.dotpals/bin, runs setup on its first start, and agents' hooks and the dotpals command
// work through its scripts. CI runs it on the app it builds; `npm test` skips it. It uses its
// own home folder, port and Electron profile, never yours.
//
//   npm run dist -- --dir && DOTPALS_APP_EXE=dist/mac-arm64/dotpals.app/Contents/MacOS/dotpals node test/smoke/packaged.mjs
//   (Windows: DOTPALS_APP_EXE=dist\win-unpacked\dotpals.exe)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.env.DOTPALS_APP_EXE) await main(resolve(process.env.DOTPALS_APP_EXE));
else (await import('node:test')).test('the packaged app starts and works', { skip: 'needs a built app: DOTPALS_APP_EXE=<its executable> node test/smoke/packaged.mjs' }, () => {});

async function main(exe) {
  const win = process.platform === 'win32';
  const home = mkdtempSync(join(tmpdir(), 'dotpals-packaged-'));
  const dot = join(home, '.dotpals');
  const port = await new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const bridge = `http://127.0.0.1:${port}`;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Its own home (where ~/.dotpals and its hooks go) and a PATH without Node: the app must not need it.
  const env = { ...process.env, HOME: home, USERPROFILE: home, DOTPALS_PORT: String(port), PATH: win ? `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}` : '/usr/bin:/bin' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DOTPALS_HOME;

  const app = spawn(exe, [`--user-data-dir=${join(home, 'electron')}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  for (const s of [app.stdout, app.stderr]) s.on('data', (d) => { out += d; });
  const closed = new Promise((r) => app.once('close', r));
  const until = async (what, check, ms = 60_000) => {
    for (const end = Date.now() + ms; ; await wait(500)) {
      if (app.exitCode !== null) throw new Error(`the app stopped (${app.exitCode}) while waiting for ${what}`);
      const v = await check().catch(() => null);
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    }
  };
  const status = async () => (await fetch(`${bridge}/api/status`, { signal: AbortSignal.timeout(2000) })).json();
  // A .cmd needs a shell on Windows.
  const run = (file, args, input) => (win
    ? spawnSync([file, ...args].map((a) => `"${a}"`).join(' '), { shell: true, env, input, encoding: 'utf8' })
    : spawnSync(file, args, { env, input, encoding: 'utf8' }));

  const failed = [];
  const step = async (name, fn) => {
    try { const note = await fn(); console.log(`  ✓ ${name}${note ? `  (${note})` : ''}`); } catch (err) { failed.push(name); console.log(`  ✗ ${name}: ${err.message}`); }
  };
  console.log(`packaged dotpals: ${exe}`);

  await step('starts, and its bridge answers', async () => `version ${(await until('the bridge', status)).version}`);
  await step('writes runtime.json and its scripts', () => {
    const r = JSON.parse(readFileSync(join(dot, 'runtime.json'), 'utf8'));
    if (resolve(r.exe) !== exe) throw new Error(`runtime.json names ${r.exe}`);
    for (const f of win ? ['dotpals-node.cmd', 'dotpals.cmd'] : ['dotpals-node', 'dotpals']) if (!existsSync(join(dot, 'bin', f))) throw new Error(`no bin/${f}`);
  });
  await step('runs setup on its first start', async () => {
    const log = await until('setup to finish', async () => { const t = readFileSync(join(dot, 'setup.log'), 'utf8'); return /Done\./.test(t) && t; }, 120_000);
    if (!existsSync(join(dot, 'app', 'bridge', 'hook.js'))) throw new Error(`no ~/.dotpals/app:\n${log}`);
  });
  await step('plays the welcome on the notch', () => until('the welcome scene', () => new Promise((ok, fail) => {
    // The scene goes to the notch over /events; it ends asleep after 12 s, so it's still there.
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 3000);
    fetch(`${bridge}/events`, { signal: ctrl.signal }).then(async (r) => {
      let text = '';
      for await (const c of r.body) { text += Buffer.from(c); const m = /"session":"dotpals:welcome"[^\n]*"state":"(working|done)"[^\n]*"text":"([^"]*)"/.exec(text); if (m) { ctrl.abort(); return ok(m[2]); } }
      ok(null); // the stream ended without it: try again
    }).catch(() => ok(null));
  }), 15_000));
  await step('the dotpals command works without Node', () => {
    const r = run(join(dot, 'bin', win ? 'dotpals.cmd' : 'dotpals'), ['status']);
    if (r.status !== 0 || !r.stdout.includes(`running on port ${port}`)) throw new Error(`exit ${r.status}: ${r.stdout}${r.stderr}`);
  });
  await step('a hook reaches the pal through dotpals-node', async () => {
    const before = (await status()).entries;
    const event = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'packaged-smoke', cwd: home, prompt: 'packaged smoke test' });
    const r = run(join(dot, 'bin', win ? 'dotpals-node.cmd' : 'dotpals-node'), [join(dot, 'app', 'bridge', 'hook.js')], event);
    if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`);
    return `${await until('the event', async () => { const n = (await status()).entries; return n > before && n; }, 15_000)} entries`;
  });
  await step('quits when asked', async () => {
    await fetch(`${bridge}/api/app/quit`, { method: 'POST', headers: { 'x-dotpals': '1' } });
    await Promise.race([closed, wait(15_000).then(() => { throw new Error('still running'); })]);
  });

  if (app.exitCode === null) app.kill();
  if (failed.length) console.log(`\n--- app output ---\n${out.slice(-4000)}`);
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  console.log(failed.length ? `\n${failed.length} failed: ${failed.join(', ')}` : '\nAll good.');
  process.exit(failed.length ? 1 : 0);
}
