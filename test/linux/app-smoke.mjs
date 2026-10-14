// The whole desktop app (desktop/main.js) on a pretend Linux desktop: the real Electron under X
// (Xvfb) with a window manager, with and without a compositor, and under Wayland (Weston), driven
// over the DevTools protocol. Runs in the container test/linux/Dockerfile starts
// (test/linux/README.md); skipped anywhere else.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const skip = process.env.DOTPALS_LINUX_APP ? false : 'runs on the pretend Linux desktop in test/linux/Dockerfile';

const PORT = 5199, DEVTOOLS = 9333;
const repo = fileURLToPath(new URL('../..', import.meta.url));
const bridge = `http://127.0.0.1:${PORT}`;
const sh = (file, ...args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 10_000) {
  for (const end = Date.now() + ms; ; await wait(150)) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${check}`);
  }
}
const windows = (name, display = process.env.DISPLAY) => { try { return execFileSync('xdotool', ['search', '--onlyvisible', '--name', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, DISPLAY: display } }).trim().split('\n').filter(Boolean); } catch { return []; } };
const first = (name, display) => windows(name, display)[0] ?? '';
const geo = (id, display = process.env.DISPLAY) => Object.fromEntries(execFileSync('xdotool', ['getwindowgeometry', '--shell', id], { encoding: 'utf8', env: { ...process.env, DISPLAY: display } }).trim().split('\n').map((l) => l.split('=')).map(([k, v]) => [k, Number(v)]));
const sinkVolume = () => Number(/(\d+)%/.exec(sh('pactl', 'get-sink-volume', '@DEFAULT_SINK@'))[1]);

/** The colour at x, y as you'd see it, compositor and all: Xvfb's own copy of the screen (run.sh starts it with -fbdir). */
function pixel(x, y) {
  const b = readFileSync('/tmp/fb/Xvfb_screen0'); // an XWD file
  const u = (i) => b.readUInt32BE(i * 4);
  const at = u(0) + u(19) * 12 + y * u(12) + x * (u(11) / 8);
  const px = u(7) ? b.readUInt32BE(at) : b.readUInt32LE(at);
  return [(px >> 16) & 255, (px >> 8) & 255, px & 255];
}

// -- the app ---------------------------------------------------------------------------------
const appLog = '/tmp/dotpals-app.log'; // what Electron says; run.sh shows it when a check fails
const targets = () => fetch(`http://127.0.0.1:${DEVTOOLS}/json/list`).then((r) => r.json()).catch(() => null);
let app = null; // { proc, home, log() }
/** Start dotpals as `electron desktop/main.js` would, with its own ~/.dotpals and settings; resolves once the notch and the pal are up. */
async function start(env = {}, args = []) {
  await stop();
  const home = mkdtempSync(join(tmpdir(), 'dotpals-'));
  let log = '';
  const keep = (d) => { log += d; appendFileSync(appLog, d); };
  keep(`\n-- electron ${args.join(' ')} desktop/main.js ${JSON.stringify(env)}\n`);
  const proc = spawn(process.env.DOTPALS_ELECTRON, ['--no-sandbox', ...args, join(repo, 'desktop', 'main.js'), `--remote-debugging-port=${DEVTOOLS}`], {
    env: { ...process.env, DOTPALS_HOME: home, DOTPALS_PORT: String(PORT), XDG_CONFIG_HOME: join(home, 'config'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', keep);
  proc.stderr.on('data', keep);
  proc.on('exit', (code, signal) => keep(`-- electron exited (${code ?? signal})\n`));
  app = { proc, home, log: () => log };
  await until(async () => { const t = (await targets()) ?? []; return t.some((x) => x.url.includes('/bridge/notch.html')) && t.some((x) => x.url.includes('?float=1')); }, 30_000);
  return app;
}
async function stop() {
  if (!app) return;
  const { proc } = app;
  app = null;
  if (proc.exitCode === null) {
    proc.kill();
    await Promise.race([new Promise((ok) => proc.once('exit', ok)), wait(5000).then(() => proc.kill('SIGKILL'))]);
  }
  await until(async () => !(await targets()), 10_000).catch(() => {});
}
const dictateLog = () => { try { return readFileSync(join(app.home, 'config', 'dotpals', 'dictate.log'), 'utf8'); } catch { return ''; } };

/** A page of the app over the DevTools protocol: run(expression) → its value; what it threw and logged (since it loaded). */
async function page(part) {
  const t = await until(async () => ((await targets()) ?? []).find((x) => x.type === 'page' && x.url.includes(part)));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error(`can’t reach ${part}`)); });
  let id = 0;
  const waiting = new Map(), errors = [], logs = [];
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    else if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  };
  ws.onclose = () => { for (const done of waiting.values()) done({ error: { message: 'the page went away' } }); waiting.clear(); };
  const send = (method, params = {}) => new Promise((ok) => { const n = ++id; waiting.set(n, ok); ws.send(JSON.stringify({ id: n, method, params })); });
  await send('Runtime.enable'); // this also hands over what the page threw and logged before we came
  async function run(expression) {
    const { result, error } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const thrown = error?.message ?? result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text;
    if (thrown) throw new Error(`${part}: ${thrown}`);
    return result.result.value;
  }
  // The target has the page's address from the start; its document (and the preload's dotpalsDesktop) a moment later.
  await until(() => run(`location.href.includes(${JSON.stringify(part)}) && document.readyState === 'complete'`).catch(() => false));
  return { run, errors, logs, close: () => ws.close() };
}
const setConfig = (patch) => fetch(`${bridge}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dotpals': '1' }, body: JSON.stringify(patch) });

// -- the desktop around it -------------------------------------------------------------------
let W, H, notch, compositor = null;
const children = [];
const clicks = join(tmpdir(), 'dot-clicks');
const compose = (on) => {
  if (on && !compositor) children.push(compositor = spawn('xcompmgr', [], { stdio: 'ignore' }));
  if (!on && compositor) { compositor.kill(); compositor = null; }
};
/** Whether a click at x, y reaches the red terminal under everything (it reports clicks: xterm's mouse mode). */
async function reachesUnder(x, y) {
  const n = existsSync(clicks) ? statSync(clicks).size : 0;
  sh('xdotool', 'mousemove', String(x), String(y));
  await wait(300); // the app checks the pointer ~30 times a second for what lets clicks through
  sh('xdotool', 'click', '1');
  await wait(500);
  return (existsSync(clicks) ? statSync(clicks).size : 0) > n;
}

if (!skip) {
  before(async () => {
    [W, H] = /dimensions:\s+(\d+)x(\d+)/.exec(sh('xdpyinfo')).slice(1).map(Number);
    children.push(spawn('xterm', ['-class', 'DotUnder', '-bg', '#ff0000', '-geometry', '+0+0', '-e', 'sh', '-c', `printf '\\033[?1000h'; stty raw -echo; cat > ${clicks}`], { stdio: 'ignore' }));
    const under = await until(() => { try { return sh('xdotool', 'search', '--onlyvisible', '--class', 'DotUnder').split('\n')[0]; } catch { return ''; } });
    sh('xdotool', 'windowsize', under, String(W), String(H), 'windowmove', under, '0', '0');
    compose(true);
    await wait(500);
    await start();
    notch = await page('/bridge/notch.html');
  });
  after(async () => {
    await stop();
    for (const c of children) c.kill();
  });
}

/** The dashboard, opened with the notch's button; shut(it) closes it (it would cover the screen). */
async function openDashboard() {
  await notch.run('window.dotpalsDesktop.openDashboard()');
  const p = await page('/dashboard');
  await until(async () => (await p.run('document.readyState')) === 'complete');
  await until(() => first('^dotpals dashboard$'));
  return p;
}
async function shut(dashboard) {
  await dashboard.run('setTimeout(() => window.close(), 50)');
  await until(() => !first('^dotpals dashboard$'));
  dashboard.close();
}

test('the notch, the pal and the dashboard load, with nothing thrown', { skip }, async () => {
  const pal = await page('?float=1');
  const dashboard = await openDashboard();
  await wait(1500); // anything thrown just after loading
  for (const [name, p] of [['notch', notch], ['pal', pal], ['dashboard', dashboard]]) {
    assert.ok(await p.run('document.body.children.length > 0'), `${name} is empty`);
    assert.deepEqual(p.errors, [], `${name} threw`);
  }
  assert.ok(await pal.run('!!window.dotpalsDesktop'), 'the pal has the desktop bridge (preload)');
  pal.close();
  await shut(dashboard);
});

test('global shortcuts: all registered (GET /api/shortcuts), and pressing one works', { skip }, async () => {
  const keys = await (await fetch(`${bridge}/api/shortcuts`)).json();
  assert.equal(keys.platform, 'linux');
  for (const k of ['pal', 'talk', 'dictate', 'circle']) assert.equal(typeof keys[k], 'string', `${k} has no shortcut`);
  const pal = await page('?float=1');
  const shown = () => pal.run('document.visibilityState');
  assert.equal(await shown(), 'visible');
  sh('xdotool', 'key', 'ctrl+alt+p');
  await until(async () => (await shown()) === 'hidden');
  sh('xdotool', 'key', 'ctrl+alt+p');
  await until(async () => (await shown()) === 'visible');
  pal.close();
});

test('a screenshot from the notch (bluShot), of the whole screen; none when Blu may not look', { skip }, async () => {
  const shot = await notch.run('window.dotpalsDesktop.bluShot()');
  assert.deepEqual([shot.w, shot.h], [W, H]);
  assert.deepEqual([...readFileSync(shot.path).subarray(0, 3)], [0xff, 0xd8, 0xff], 'a JPEG');
  assert.ok(shot.path.startsWith(app.home));
  await setConfig({ blu: { see: false } });
  assert.equal(await notch.run('window.dotpalsDesktop.bluShot()'), null);
  await setConfig({ blu: { see: true } });
});

test('Blu draws over the whole screen (see-through, clicks go through) and bluClear takes it away', { skip }, async () => {
  const at = [200, 600]; // on the red terminal, away from the mark, the notch and the pal
  assert.deepEqual(pixel(...at), [255, 0, 0]);
  const shot = await notch.run('window.dotpalsDesktop.bluShot()');
  await notch.run(`window.dotpalsDesktop.bluDraw(${JSON.stringify({ shot: shot.path, marks: [{ shape: 'circle', x: 560, y: 340, w: 160, h: 120, color: 'green', label: 'this one' }] })})`);
  const id = await until(() => first('^dotpals draw$'));
  const g = geo(id);
  assert.ok(g.X <= 0 && g.Y <= 0 && g.WIDTH >= W - 1 && g.HEIGHT >= H - 1, `over the screen: ${JSON.stringify(g)}`); // Chromium on X makes it 1 px short
  const draw = await page('/bridge/draw.html');
  await until(async () => (await draw.run("document.querySelectorAll('#ink path').length")) > 0);
  await wait(1200); // drawn in, and its label
  assert.equal(await draw.run("document.querySelectorAll('.label.on').length"), 1);
  assert.deepEqual(pixel(...at), [255, 0, 0], 'see-through, with a compositor');
  assert.equal(await reachesUnder(...at), true, 'a click goes through to the window under it');
  await notch.run('window.dotpalsDesktop.bluClear()');
  await until(() => !windows('^dotpals draw$').length);
  assert.deepEqual(draw.errors, []);
  draw.close();
});

test('circle mode (Ctrl+Alt+C): the layer takes the pointer, a loop drawn on it goes to Talk with the screenshot', { skip }, async () => {
  const shots = () => readdirSync(join(app.home, 'shots')).length;
  const before = shots();
  sh('xdotool', 'mousemove', '400', '300');
  sh('xdotool', 'key', 'ctrl+alt+c');
  await until(() => windows('^dotpals draw$').length);
  const draw = await page('/bridge/draw.html');
  await until(async () => draw.run("document.body.classList.contains('circling')"));
  assert.equal(await reachesUnder(400, 300), false, 'while you circle, clicks are the layer’s');
  sh('xdotool', 'mousemove', '350', '250', 'mousedown', '1');
  for (const [x, y] of [[420, 240], [470, 280], [480, 340], [440, 380], [380, 390], [330, 350], [320, 290], [350, 250]]) { sh('xdotool', 'mousemove', String(x), String(y)); await wait(40); }
  sh('xdotool', 'mouseup', '1');
  await until(async () => !(await draw.run("document.body.classList.contains('circling')")));
  await until(async () => (await notch.run("document.getElementById('island').dataset.mode")) === 'open');
  assert.equal(shots(), before + 2, 'the screenshot, and the one with your circle on it');
  assert.equal(await reachesUnder(200, 600), true, 'and clicks go through again');
  await notch.run('window.dotpalsDesktop.bluClear()');
  await until(() => !windows('^dotpals draw$').length);
  draw.close();
});

test('the notch: clicks go through it, except on its island', { skip }, async () => {
  sh('xdotool', 'mousemove', '640', '600');
  sh('xdotool', 'key', 'ctrl+shift+space'); // Talk opens it
  await until(async () => (await notch.run("document.getElementById('island').dataset.mode")) === 'open');
  await wait(800); // grown to fit
  const g = geo(first('^dotpals notch$'));
  const r = await notch.run("(({ x, y, width, height }) => ({ x, y, width, height }))(document.getElementById('island').getBoundingClientRect())");
  assert.ok(g.WIDTH > r.width && g.HEIGHT > r.height, `room around the island: ${JSON.stringify({ g, r })}`);
  assert.equal(await reachesUnder(g.X + 4, g.Y + g.HEIGHT - 4), true, 'beside and below the island');
  assert.equal(await reachesUnder(g.X + Math.round(r.x + r.width / 2), g.Y + Math.round(r.y + 8)), false, 'on the island');
});

test('Blu’s hands: the volume through PulseAudio (no PipeWire here), with a receipt', { skip }, async () => {
  sh('pactl', 'set-sink-volume', '@DEFAULT_SINK@', '50%');
  const [r, ...more] = await notch.run("window.dotpalsDesktop.bluDo({ actions: [{ act: 'volume', set: 30, words: 'Quieter' }] })");
  assert.deepEqual([r.act, r.ok, r.words, more.length], ['volume', true, 'Quieter', 0], r.error);
  assert.equal(sinkVolume(), 30);
  assert.equal((await notch.run("window.dotpalsDesktop.bluMedia('louder')")).ok, true);
  assert.equal(sinkVolume(), 40);
});

test('the music card (bluMedia): null with nothing playing; what’s playing, and its buttons, with a pretend MPRIS player', { skip }, async () => {
  assert.equal(await notch.run("window.dotpalsDesktop.bluMedia('info')"), null);
  const player = spawn('python3', [fileURLToPath(new URL('./mpris.py', import.meta.url))], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(player);
  let said = '';
  player.stdout.on('data', (d) => { said += d; });
  await until(() => said.includes('ready'));
  assert.deepEqual(await notch.run("window.dotpalsDesktop.bluMedia('info')"), { title: 'Sunny Morning', artist: 'The Examples', playing: true, app: 'Dotplayer' });
  assert.equal((await notch.run("window.dotpalsDesktop.bluMedia('pause')")).ok, true);
  assert.equal((await notch.run("window.dotpalsDesktop.bluMedia('info')")).playing, false);
  assert.match(said, /^Pause$/m);
  player.kill();
});

test('voice: no graphics card here, so Whisper runs on the processor (wasm); the system voice fails rather than hangs', { skip }, async (t) => {
  const p = await openDashboard(); // a page that hasn't loaded a model yet
  const gpu = await p.run('(async () => ({ api: !!navigator.gpu, adapter: !!(await navigator.gpu?.requestAdapter()) }))()');
  t.diagnostic(`WebGPU: navigator.gpu ${gpu.api ? 'is there' : 'isn’t there'}, ${gpu.adapter ? 'with' : 'without'} an adapter`);
  // The system's voice speaks until Kokoro is ready; there's no speech-dispatcher here.
  const spoke = await p.run("new Promise((ok) => { const u = new SpeechSynthesisUtterance('hello'); u.onend = () => ok('spoke'); u.onerror = (e) => ok(e.error); setTimeout(() => ok('nothing'), 5000); speechSynthesis.speak(u); })");
  t.diagnostic(`the system voice: ${spoke}`);
  assert.notEqual(spoke, 'nothing');
  const online = await fetch('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0', { method: 'HEAD', signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
  if (!online) { await shut(p); return t.skip('no network: the speech model comes from a CDN'); }
  const started = Date.now();
  await p.run("import('/bridge/ui/voice.js').then(({ createVoice }) => createVoice({ hearing: () => 'quick', speaks: false }).warm())");
  const said = p.logs.filter((l) => l.startsWith('[voice]'));
  t.diagnostic(`${said.join(' · ') || 'nothing logged'} (${Math.round((Date.now() - started) / 1000)} s)`);
  await shut(p);
  const loaded = said.some((l) => /speech model \(quick\) on the processor/.test(l));
  if (!loaded && said.some((l) => /Failed to fetch/.test(l))) return t.skip('the speech model couldn’t be downloaded (network)');
  assert.ok(loaded, 'Whisper loaded on the processor');
});

test('without a compositor: see-through windows come out black, so Blu doesn’t draw (no black screen); one started later is used', { skip }, async (t) => {
  compose(false);
  await wait(500);
  await start();
  notch = await page('/bridge/notch.html');
  const n = geo(await until(() => first('^dotpals notch$')));
  t.diagnostic(`the notch's hidden strip shows as rgb(${pixel(n.X + 2, n.Y + 2)}) over red: what's see-through is black without a compositor`);
  const drawBox = "window.dotpalsDesktop.bluShot().then((s) => window.dotpalsDesktop.bluDraw({ shot: s.path, marks: [{ shape: 'box', x: 500, y: 300, w: 200, h: 100 }] }))";
  await notch.run(drawBox);
  await wait(2500);
  assert.deepEqual(windows('^dotpals draw$'), [], 'no drawing layer');
  assert.deepEqual(pixel(200, 600), [255, 0, 0], 'the screen as it was');
  assert.match(dictateLog(), /no compositor is running/);
  compose(true);
  await wait(1000);
  await notch.run(drawBox);
  await until(() => windows('^dotpals draw$').length);
  await wait(800);
  assert.deepEqual(pixel(200, 600), [255, 0, 0], 'see-through now');
  await notch.run('window.dotpalsDesktop.bluClear()');
  await until(() => !windows('^dotpals draw$').length);
});

test('Wayland (Weston, inside X): natively, and on XWayland (--ozone-platform=x11)', { skip }, async (t) => {
  const socket = 'wayland-dot';
  let said = '';
  const weston = spawn('weston', ['--backend=x11-backend.so', '--width=1200', '--height=760', `--socket=${socket}`, '--xwayland', '--idle-time=0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(weston);
  weston.stdout.on('data', (d) => { said += d; });
  weston.stderr.on('data', (d) => { said += d; });
  const display = await until(() => /xserver listening on display (:\d+)/.exec(said)?.[1], 15_000);
  const env = { WAYLAND_DISPLAY: socket, XDG_SESSION_TYPE: 'wayland', DISPLAY: display };
  try {
    // Natively: what Electron picks on a Wayland session.
    await start(env);
    const n = await page('/bridge/notch.html');
    const pal = await page('?float=1');
    await wait(1500);
    assert.deepEqual([n.errors, pal.errors], [[], []]);
    assert.deepEqual(windows('^dotpals', display), [], 'Wayland windows, not X ones');
    assert.equal(await n.run('window.dotpalsDesktop.bluShot()'), null, 'no screenshot without a ScreenCast portal');
    assert.match(app.log(), /org\.freedesktop\.portal\.Desktop/, 'it asked the portal');
    const keys = await (await fetch(`${bridge}/api/shortcuts`)).json();
    sh('xdotool', 'key', 'ctrl+alt+p');
    await wait(1500);
    t.diagnostic(`native Wayland: the shortcuts say they're registered (Talk: ${keys.talk}); Ctrl+Alt+P left the pal ${await pal.run('document.visibilityState')}`);
    // On XWayland: X windows, so the notch can sit at the top, in the middle.
    await start(env, ['--ozone-platform=x11']);
    const g = geo(await until(() => first('^dotpals notch$', display)), display);
    assert.deepEqual([g.X, g.Y], [(1200 - g.WIDTH) / 2, 0], 'the notch at the top, in the middle');
    const x = await page('/bridge/notch.html');
    assert.equal(await x.run('window.dotpalsDesktop.bluShot()'), null, 'screenshots still go through the portal');
  } finally {
    await stop();
    weston.kill();
  }
});
