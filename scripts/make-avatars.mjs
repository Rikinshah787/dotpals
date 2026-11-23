// Renders the notification avatars: bridge/remote/avatars/<character>-<state>.png, one per pal and notification state.
// They are drawn by the real <dot-pal> (src/element.js) in the same state the pal would show, so the expression comes from
// the existing state/mood logic, not a second set of faces. Needs Microsoft Edge or Chrome:
//   node scripts/make-avatars.mjs [path-to-browser]
// Output is committed: the server and phones only ever serve the PNGs.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AVATAR_STATES } from '../bridge/remote/avatar-names.js';
import { characters } from '../src/characters.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'bridge/remote/avatars');
const SIZE = 192;
const browser = process.argv[2] ?? [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
if (!browser) throw new Error('Give the path of Edge or Chrome as the first argument');

const page = `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; background: transparent; }
  #card { width: ${SIZE}px; height: ${SIZE}px; border-radius: 40px; overflow: hidden; position: relative; background: radial-gradient(circle at 50% 38%, #34344a, #17171f 78%); }
  /* A 46 px pal is drawn as an avatar (bigger eyes, no fur), like the ones in the notch; scaled up it stays sharp. */
  dot-pal::part(bubble) { display: none; } /* a state's words are not part of an icon */
  dot-pal { position: absolute; left: 50%; bottom: 0; transform: translateX(-50%) scale(${(SIZE * 0.92 / 46).toFixed(3)}); transform-origin: 50% 100%; }
</style><div id="card"></div>
<script type="module">
  import { DotPal } from '/src/index.js';
  window.show = async (character, state) => {
    const card = document.getElementById('card');
    card.replaceChildren();
    const pal = document.createElement('dot-pal');
    pal.setAttribute('size', '46'); pal.setAttribute('static', ''); pal.setAttribute('look', 'none'); pal.setAttribute('idle', 'none'); pal.setAttribute('character', character);
    card.append(pal);
    await new Promise((r) => setTimeout(r, 60)); // a timer, not requestAnimationFrame: a headless window that counts as hidden never fires that
    pal.setState(state);
    await new Promise((r) => setTimeout(r, 650)); // the entry move and the face have settled; "done" is still celebrating
    return true;
  };
  window.ready = DotPal.states.length;
</script>`;

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  const file = normalize(join(root, path));
  if (!file.startsWith(root) || !/^\/(src)\//.test(path) || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(file));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;
const cdp = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'dotpals-avatars-'));
const proc = spawn(browser, ['--headless=new', `--remote-debugging-port=${cdp}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const done = () => { try { proc.kill(); } catch {} server.close(); setTimeout(() => rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }), 800).unref(); };
try {
  let tab;
  for (let i = 0; i < 60 && !tab; i++) { await new Promise((r) => setTimeout(r, 200)); try { tab = (await (await fetch(`http://127.0.0.1:${cdp}/json/list`)).json()).find((t) => t.type === 'page'); } catch {} }
  if (!tab) throw new Error('The browser did not start');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((ok) => (ws.onopen = ok));
  let id = 0; const wait = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
  const send = (method, params = {}) => new Promise((ok) => { const n = ++id; wait.set(n, ok); ws.send(JSON.stringify({ id: n, method, params })); });
  const run = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'page error'); return r.result?.result?.value; };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: SIZE, height: SIZE, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  for (let i = 0; i < 50 && !(await run('window.ready')); i++) await new Promise((r) => setTimeout(r, 200));
  mkdirSync(out, { recursive: true });
  const only = (process.env.AVATAR_ONLY ?? '').split(',').filter(Boolean); // optional: only these characters (default: all)
  const wanted = (c) => !only.length || only.includes(c);
  const limit = (promise, what) => { let timer; return Promise.race([promise, new Promise((_, no) => { timer = setTimeout(() => no(new Error(`Timed out: ${what}`)), 15_000); })]).finally(() => clearTimeout(timer)); };
  for (const character of Object.keys(characters)) {
    if (!wanted(character)) continue;
    for (const state of AVATAR_STATES) {
      const what = `${character} ${state}`;
      const draw = async () => {
        await limit(run(`window.show(${JSON.stringify(character)}, ${JSON.stringify(state)})`), what);
        return limit(send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: SIZE, height: SIZE, scale: 1 }, fromSurface: true }), what);
      };
      const shot = await draw().catch(() => draw()); // once more if the browser was slow
      writeFileSync(join(out, `${character}-${state}.png`), Buffer.from(shot.result.data, 'base64'));
      console.log(`  ${what}`);
    }
  }
  console.log(`Wrote ${Object.keys(characters).length * AVATAR_STATES.length} avatars to ${out}`);
  ws.close();
} finally { done(); }
setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
