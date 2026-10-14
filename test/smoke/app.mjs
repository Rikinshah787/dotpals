// Starts the real desktop app (Electron) and checks it works: its pages load without errors, the
// bridge answers, every Settings tab shows its cards, Blu draws on the screen and clears it, and
// the app quits when asked. CI's `app` job runs it on Windows, macOS and Linux; `npm test` skips it.
// It uses its own ~/.dotpals (DOTPALS_HOME), port and Electron profile, never yours.
//
//   npm install --no-save electron && DOTPALS_SMOKE=1 node test/smoke/app.mjs
//   Linux without a screen: xvfb-run -a …   SMOKE_OUT=<folder>: where the screenshots and app.log go
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.DOTPALS_SMOKE) await main();
else (await import('node:test')).test('the desktop app starts and works', { skip: 'needs Electron and a screen: DOTPALS_SMOKE=1 node test/smoke/app.mjs' }, () => {});

async function main() {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const out = process.env.SMOKE_OUT || mkdtempSync(join(tmpdir(), 'dotpals-smoke-out-'));
  mkdirSync(out, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), 'dotpals-smoke-'));
  const [debugPort, port] = await freePorts(2);
  const bridge = `http://127.0.0.1:${port}`;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // -- start it ----------------------------------------------------------------------------------
  const electron = createRequire(import.meta.url)('electron'); // the binary's path, once installed
  const args = [join(root, 'desktop', 'main.js'), `--remote-debugging-port=${debugPort}`, '--remote-allow-origins=*', `--user-data-dir=${join(home, 'electron')}`, '--dashboard'];
  if (process.platform === 'linux') args.push('--no-sandbox');
  const env = { ...process.env, DOTPALS_HOME: home, DOTPALS_PORT: String(port), ELECTRON_ENABLE_LOGGING: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(electron, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise((r) => app.once('close', r));
  const log = createWriteStream(join(out, 'app.log'));
  for (const s of [app.stdout, app.stderr]) s.pipe(log, { end: false });
  const gone = () => app.exitCode !== null || app.signalCode !== null;
  async function until(what, check, ms = 20000) {
    for (const end = Date.now() + ms; ; await wait(250)) {
      if (gone()) throw new Error(`the app stopped (${app.exitCode ?? app.signalCode}) while waiting for ${what}`);
      const v = await check().catch(() => null);
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    }
  }
  const getJson = async (path) => { const r = await fetch(`${bridge}${path}`); if (!r.ok) throw new Error(`${path}: ${r.status}`); return r.json(); };

  // -- the report --------------------------------------------------------------------------------
  const failed = [];
  async function step(name, fn) {
    try { const note = await fn(); console.log(`  ✓ ${name}${note ? `  (${note})` : ''}`); } catch (err) { failed.push(name); console.log(`  ✗ ${name}: ${err.message}`); }
  }
  console.log(`dotpals desktop app on ${process.platform} (Electron ${createRequire(import.meta.url)('electron/package.json').version}, bridge on ${port})`);

  // -- its pages, through the DevTools protocol: errors and console.error, from every page --------
  const errors = [];
  const pages = {};
  const IGNORE = /Electron Security Warning/;
  async function attach(name, target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error(`couldn't attach to the ${name}`)); });
    const waiting = new Map();
    let id = 0;
    const seen = (text) => { if (!IGNORE.test(text)) errors.push(`${name}: ${text}`); };
    ws.onmessage = ({ data }) => {
      const m = JSON.parse(data);
      if (m.id) { waiting.get(m.id)?.(m); waiting.delete(m.id); }
      else if (m.method === 'Runtime.exceptionThrown') seen(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
      else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') seen(m.params.args.map((a) => a.value ?? a.description).join(' '));
      else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') seen(`${m.params.entry.text} ${m.params.entry.url ?? ''}`.trim());
    };
    const send = (method, params = {}) => new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`${method} took too long`)), 20000);
      waiting.set(++id, (m) => { clearTimeout(timer); m.error ? fail(new Error(m.error.message)) : ok(m.result); });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const run = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    await send('Runtime.enable'); // also hands over what was logged before we came
    await send('Log.enable');
    await until(`the ${name} to load`, () => run('document.readyState === "complete"'));
    return (pages[name] = { send, run, close: () => ws.close() });
  }
  const targets = () => fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json());
  const PAGES = { pal: '/?float=1', notch: '/bridge/notch.html', dashboard: '/dashboard', draw: '/bridge/draw.html' };
  const find = (name) => until(`the ${name} window`, async () => (await targets()).find((t) => t.type === 'page' && t.url.startsWith(bridge + PAGES[name])), 60000);
  const shoot = async (page, file) => writeFileSync(join(out, file), Buffer.from((await page.send('Page.captureScreenshot')).data, 'base64'));

  await step('the app starts: pal, notch and dashboard', async () => {
    for (const name of ['pal', 'notch', 'dashboard']) await attach(name, await find(name));
  });
  if (failed.length) return finish(); // nothing else can work

  // -- the bridge in the app -------------------------------------------------------------------------
  await step('GET /api/status', async () => {
    const s = await until('the notch to follow the bridge', async () => { const s = await getJson('/api/status'); return s.desktop?.notch && s; });
    if (s.home !== home) throw new Error(`its home is ${s.home}, not ${home}`);
    return `version ${s.version}, pal ${s.desktop.pal ? 'on' : 'off'}`;
  });
  await step('GET /api/apps', async () => {
    const a = await getJson('/api/apps');
    if (!Array.isArray(a.mine) || !Object.keys(a.presets ?? {}).length) throw new Error(`unexpected answer: ${JSON.stringify(a).slice(0, 200)}`);
    return `${Object.keys(a.presets).length} to add`;
  });
  await step('GET /api/shortcuts', async () => {
    const s = await until('the shortcuts', async () => { const s = await getJson('/api/shortcuts'); return s.platform === process.platform && s; });
    return Object.entries(s).filter(([k]) => k !== 'platform').map(([k, v]) => `${k} ${v ?? 'none'}`).join(', ');
  });

  // -- every Settings tab shows its cards --------------------------------------------------------
  for (const tab of ['pal', 'agents', 'blu', 'apps', 'more']) {
    await step(`Settings → ${tab}`, async () => {
      const dash = pages.dashboard;
      await dash.run(`location.hash = 'settings/${tab}'`);
      const cards = await until('its cards', () => dash.run(`(() => {
        if (document.getElementById('view-settings').hidden) return null;
        const cards = [...document.querySelectorAll('.settings > .card')];
        const shown = cards.filter((c) => !c.hidden && c.getBoundingClientRect().height > 0);
        const ok = shown.length && shown.every((c) => c.dataset.tab === '${tab}' && c.querySelector('h2')?.textContent.trim() && c.children.length > 1);
        return ok ? shown.map((c) => c.querySelector('h2').textContent.trim()) : null;
      })()`), 10000);
      await shoot(dash, `settings-${tab}.png`).catch(() => {});
      return cards.join(' · ');
    });
  }

  // -- Blu draws on the screen, and clears it --------------------------------------------------------
  await step('Blu: screenshot, draw, clear', async () => {
    const notch = pages.notch;
    const shot = await notch.run('window.dotpalsDesktop.bluShot()');
    if (!shot) {
      if (process.platform === 'darwin') return 'no screenshot: Screen Recording isn’t allowed here, as expected';
      throw new Error('bluShot() gave no screenshot');
    }
    const mark = { shape: 'circle', color: 'red', x: Math.round(shot.w / 3), y: Math.round(shot.h / 3), w: 120, h: 60, label: 'smoke test' };
    await notch.run(`window.dotpalsDesktop.bluDraw(${JSON.stringify({ marks: [mark], shot: shot.path })})`);
    const draw = pages.draw ?? await attach('draw', await find('draw'));
    await until('the mark on screen', () => draw.run('document.querySelectorAll("#ink path.ink").length > 0 && !!document.querySelector(".label")'), 10000);
    await wait(1200);
    await shoot(draw, 'blu-draw.png').catch(() => {});
    await notch.run('window.dotpalsDesktop.bluClear()');
    await until('the screen to clear', () => draw.run('document.querySelectorAll("#ink path.ink, .label").length === 0'), 10000);
    return `${shot.w}×${shot.h} screenshot`;
  });
  await step('Blu: what’s playing', async () => {
    const now = await pages.notch.run('window.dotpalsDesktop.bluMedia("info")');
    return now ? `${now.title} in ${now.app}` : 'nothing playing';
  });

  await step('no errors in its pages', async () => {
    if (errors.length) throw new Error(`\n      ${[...new Set(errors)].join('\n      ')}`);
  });

  // -- quit, as `dotpals setup` and `dotpals update` do ---------------------------------------
  await step('quits when asked', async () => {
    for (const p of Object.values(pages)) p.close();
    const r = await fetch(`${bridge}/api/app/quit`, { method: 'POST', headers: { 'x-dotpals': '1' } });
    if (!r.ok) throw new Error(`/api/app/quit: ${r.status}`);
    for (const end = Date.now() + 20000; !gone(); await wait(250)) if (Date.now() > end) throw new Error('still running 20 s later');
    return `exit ${app.exitCode ?? app.signalCode}`;
  });
  return finish();

  async function finish() {
    if (!gone()) app.kill();
    await closed;
    await new Promise((r) => log.end(r));
    try { rmSync(home, { recursive: true, force: true }); } catch {}
    if (!failed.length) {
      console.log(`\nAll good. Screenshots and the app's log: ${out}`);
      process.exit(0);
    }
    const lines = readFileSync(join(out, 'app.log'), 'utf8').trim().split('\n').slice(-40);
    console.log(`\nThe end of the app's log (all of it, and screenshots, in ${out}):\n${lines.join('\n')}`);
    console.log(`\n${failed.length} failed: ${failed.join(', ')}`);
    process.exit(1);
  }
}

/** `n` ports nobody is using right now. */
async function freePorts(n) {
  const servers = await Promise.all(Array.from({ length: n }, () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => ok(s)); })));
  const ports = servers.map((s) => s.address().port);
  await Promise.all(servers.map((s) => new Promise((ok) => s.close(ok))));
  return ports;
}
