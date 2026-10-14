// Blu's hands (desktop/hands.js) on a real Linux desktop: X with a window manager, PulseAudio,
// playerctl, xdotool, gtk-launch and gio. Runs in the container test/linux/Dockerfile starts
// (test/linux/README.md); skipped anywhere else.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHands, linuxKeys } from '../../desktop/hands.js';

const skip = process.env.DOTPALS_LINUX_HANDS ? false : 'runs on the pretend Linux desktop in test/linux/Dockerfile';

const sh = (file, ...args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 5000) {
  for (const end = Date.now() + ms; ; await wait(100)) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${check}`);
  }
}
const visible = (cls) => { try { return sh('xdotool', 'search', '--onlyvisible', '--class', cls).split('\n')[0]; } catch { return ''; } };
const geo = (id) => Object.fromEntries(sh('xdotool', 'getwindowgeometry', '--shell', id).split('\n').map((l) => l.split('=')).map(([k, v]) => [k, Number(v)]));
const minimized = (id) => /Iconic/.test(sh('xprop', '-id', id, 'WM_STATE'));
const active = () => { try { return sh('xdotool', 'getactivewindow'); } catch { return ''; } };
const sinkVolume = () => Number(/(\d+)%/.exec(sh('pactl', 'get-sink-volume', '@DEFAULT_SINK@'))[1]);
const sinkMuted = () => /yes/.test(sh('pactl', 'get-sink-mute', '@DEFAULT_SINK@'));
const mouse = () => Object.fromEntries(sh('xdotool', 'getmouselocation', '--shell').split('\n').map((l) => l.split('=')).map(([k, v]) => [k, Number(v)]));

let W, H, hands, win, frame;
const opened = [];
const children = [];
const act = async (action, shot) => (await hands.run([action], { shot, allow: { hands: true, click: true } }))[0];
const reset = async () => { sh('xdotool', 'windowsize', win, '600', '400', 'windowmove', win, '300', '200'); await wait(200); };

if (!skip) {
  before(async () => {
    [W, H] = /dimensions:\s+(\d+)x(\d+)/.exec(sh('xdpyinfo')).slice(1).map(Number);
    const screen = { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: W, height: H }, scaleFactor: 1 }) };
    hands = createHands({ shell: { openExternal: async (url) => { opened.push(url); } }, screen, typeOut: async () => ({ ok: true }), platform: 'linux' });
    children.push(spawn('xmessage', ['-geometry', '600x400+300+200', '-name', 'dotwin', 'Blu was here'], { stdio: 'ignore' }));
    win = await until(() => visible('Xmessage'));
    await reset();
    // How far xdotool's idea of a window's corner is from where its frame is (the title bar).
    const g = geo(win);
    frame = { x: g.X - 300, y: g.Y - 200 };
  });
  after(() => { for (const c of children) c.kill(); });
}

test('window: up, down, the nudges, smaller and bigger move it from where it is, by the right amount, without creeping', { skip }, async () => {
  await reset();
  const start = geo(win);
  const moves = { up: [0, -Math.round(H * 0.1)], down: [0, Math.round(H * 0.1)], 'nudge-left': [-Math.round(W * 0.1), 0], 'nudge-right': [Math.round(W * 0.1), 0] };
  for (const [how, [dx, dy]] of Object.entries(moves)) {
    const b = geo(win);
    const r = await act({ act: 'window', how, app: 'xmessage' });
    await wait(200);
    const a = geo(win);
    assert.equal(r.ok, true, `${how}: ${r.error}`);
    assert.deepEqual([a.X - b.X, a.Y - b.Y, a.WIDTH, a.HEIGHT], [dx, dy, b.WIDTH, b.HEIGHT], how);
  }
  const b = geo(win);
  assert.equal((await act({ act: 'window', how: 'smaller', app: 'xmessage' })).ok, true);
  await wait(200);
  const s = geo(win);
  assert.deepEqual([s.WIDTH, s.HEIGHT, s.X + s.WIDTH / 2, s.Y + s.HEIGHT / 2], [480, 320, b.X + 300, b.Y + 200], 'smaller, around its middle');
  assert.equal((await act({ act: 'window', how: 'bigger', app: 'xmessage' })).ok, true);
  await wait(200);
  const g = geo(win);
  assert.deepEqual([g.X, g.Y, g.WIDTH, g.HEIGHT], [start.X, start.Y, 600, 400], 'back where it started');
});

test('window: left, right, top, bottom, center and maximize put it on that part of the screen', { skip }, async () => {
  await reset();
  const half = { w: Math.round(W / 2), h: Math.round(H / 2) };
  const want = {
    left: [0, 0, half.w, H], right: [half.w, 0, W - half.w, H], top: [0, 0, W, half.h], bottom: [0, half.h, W, H - half.h],
    center: [0, (H - (H - half.h)) / 2, W, H - half.h], maximize: [0, 0, W, H],
  };
  for (const [how, [x, y, w, h]] of Object.entries(want)) {
    const r = await act({ act: 'window', how, app: '' }); // the window in front
    await wait(200);
    const a = geo(win);
    assert.equal(r.ok, true, `${how}: ${r.error}`);
    assert.deepEqual([a.X - frame.x, a.Y - frame.y, a.WIDTH, a.HEIGHT], [x, y, w, h], how);
  }
});

test('window: minimize it, then restore and focus it by its app’s name; clear errors when there’s no window', { skip }, async () => {
  await reset();
  assert.equal((await act({ act: 'window', how: 'minimize', app: 'xmessage' })).ok, true);
  await until(() => minimized(win));
  const restored = await act({ act: 'window', how: 'restore', app: 'xmessage' });
  assert.equal(restored.ok, true, restored.error);
  await until(() => !minimized(win) && active() === win);
  assert.equal((await act({ act: 'window', how: 'minimize', app: '' })).ok, true); // the one in front
  await until(() => minimized(win));
  // Nothing is in front now.
  assert.match((await act({ act: 'window', how: 'smaller', app: '' })).error, /can’t tell which window is in front: name the app/);
  const focused = await act({ act: 'window', how: 'focus', app: 'XMESSAGE' });
  assert.equal(focused.ok, true, focused.error);
  await until(() => !minimized(win) && active() === win);
  assert.equal((await act({ act: 'window', how: 'smaller', app: 'nosuchapp' })).error, 'no open window for nosuchapp');
  assert.equal((await act({ act: 'window', how: 'minimize', app: 'nosuchapp' })).error, 'no open window for nosuchapp');
});

test('keys: typed into a real xterm; F-keys work; keys xdotool doesn’t know are refused, not skipped', { skip }, async () => {
  const typed = join(tmpdir(), 'dot-typed');
  rmSync(typed, { force: true });
  children.push(spawn('xterm', ['-class', 'DotTerm', '-geometry', '60x8+40+560', '-e', 'sh', '-c', `read line; printf %s "$line" > ${typed}`], { stdio: 'ignore' }));
  await until(() => visible('DotTerm'));
  assert.equal((await act({ act: 'window', how: 'focus', app: 'dotterm' })).ok, true);
  await until(() => active() === visible('DotTerm'));
  for (const keys of ['h', 'i', 'shift+a', 'enter']) {
    const r = await act({ act: 'keys', keys });
    assert.equal(r.ok, true, `${keys}: ${r.error}`);
  }
  assert.equal(await until(() => existsSync(typed) && readFileSync(typed, 'utf8')), 'hiA');
  assert.match((await act({ act: 'keys', keys: 'ctrl+banana' })).error, /don’t know the keys “ctrl\+banana”/);
  // Every key name Blu can send is one xdotool knows (it says so, then carries on, when it isn't).
  children.push(spawn('xterm', ['-class', 'DotSink', '-geometry', '40x4+700+600', '-e', 'cat'], { stdio: 'ignore' }));
  const sink = await until(() => visible('DotSink'));
  sh('xdotool', 'windowactivate', '--sync', sink);
  for (const name of ['ctrl', 'alt', 'shift', 'meta', 'enter', 'tab', 'esc', 'space', 'backspace', 'delete', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'a', '7', 'f1', 'f5', 'f12']) {
    const r = spawnSync('xdotool', ['key', '--clearmodifiers', linuxKeys([name])], { encoding: 'utf8' });
    assert.deepEqual([r.status, r.stderr], [0, ''], name);
  }
});

test('click: lands where the screenshot shows, at the screen’s scale', { skip }, async () => {
  const full = { w: W / 2, h: H / 2, display: { bounds: { x: 0, y: 0, width: W, height: H }, scale: 1 } };
  assert.equal((await act({ act: 'click', x: W / 2 - 40, y: 25 }, full)).ok, true);
  assert.deepEqual([mouse().X, mouse().Y], [W - 80, 50]);
  // A 2x screen: Electron's units are half the pixels.
  const scaled = { w: W / 2, h: H / 2, display: { bounds: { x: 0, y: 0, width: W / 2, height: H / 2 }, scale: 2 } };
  assert.equal((await act({ act: 'click', x: W / 2 - 20, y: 30 }, scaled)).ok, true);
  assert.deepEqual([mouse().X, mouse().Y], [W - 40, 60]);
});

test('volume: up, down, set, mute and unmute change the real sink (wpctl fails without PipeWire, so pactl), never past 100%', { skip }, async () => {
  assert.notEqual(spawnSync('wpctl', ['status']).status, 0, 'wpctl is there but can’t reach PipeWire');
  sh('pactl', 'set-sink-volume', '@DEFAULT_SINK@', '50%');
  sh('pactl', 'set-sink-mute', '@DEFAULT_SINK@', '0');
  for (const [a, want] of [[{ by: 10 }, 60], [{ by: -20 }, 40], [{ set: 75 }, 75], [{ by: 30 }, 100], [{ by: 10 }, 100], [{ set: 0 }, 0]]) {
    const r = await act({ act: 'volume', ...a });
    assert.equal(r.ok, true, r.error);
    assert.equal(sinkVolume(), want, JSON.stringify(a));
  }
  assert.equal((await act({ act: 'volume', mute: true })).ok, true);
  assert.equal(sinkMuted(), true);
  assert.equal((await act({ act: 'volume', mute: false })).ok, true);
  assert.equal(sinkMuted(), false);
});

test('open: an app from the menu with gtk-launch, with gio when gtk-launch can’t see its folder, without waiting on the app', { skip }, async () => {
  const entry = (name, marker) => `[Desktop Entry]\nType=Application\nName=${name}\nExec=sh -c "touch ${marker}; exec xmessage -name dotopened ${name.replace(' ', '-')}"\n`;
  const pad = join(tmpdir(), 'dot-pad.opened'), snap = join(tmpdir(), 'dot-snap.opened');
  mkdirSync(join(homedir(), '.local/share/applications'), { recursive: true });
  writeFileSync(join(homedir(), '.local/share/applications/dot-pad.desktop'), entry('Dot Pad', pad));
  writeFileSync('/var/lib/snapd/desktop/applications/dot-snap.desktop', entry('Dot Snap', snap)); // not where gtk-launch looks
  for (const [name, marker] of [['dot pad', pad], ['Dot Snap', snap]]) {
    rmSync(marker, { force: true });
    const t = Date.now();
    const r = await act({ act: 'open', app: name });
    const ms = Date.now() - t - 1200; // run() waits 1.2 s after opening an app
    assert.equal(r.ok, true, r.error);
    assert.match(r.words, /^Opened Dot (Pad|Snap)$/);
    assert.ok(ms < 2000, `${name} took ${ms} ms`);
    await until(() => existsSync(marker));
  }
  assert.match((await act({ act: 'open', app: 'nothing like this' })).error, /no app called “nothing like this”/);
  spawnSync('pkill', ['-f', 'xmessage -name dotopened']);
});

test('media and nowPlaying with nothing playing: a clear error and null, quickly', { skip }, async () => {
  const t = Date.now();
  const r = await act({ act: 'media', key: 'playpause' });
  assert.equal(r.ok, false);
  assert.match(r.error, /No players found/);
  assert.equal(await hands.nowPlaying(), null);
  assert.ok(Date.now() - t < 2000);
});

test('media and nowPlaying with a player (a pretend MPRIS one): what’s playing, pause, play, next and previous', { skip }, async () => {
  const player = spawn('python3', [fileURLToPath(new URL('./mpris.py', import.meta.url))], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(player);
  let said = '';
  player.stdout.on('data', (d) => { said += d; });
  await until(() => said.includes('ready'));
  assert.deepEqual(await hands.nowPlaying(), { title: 'Sunny Morning', artist: 'The Examples', playing: true, app: 'Dotplayer' });
  assert.equal((await act({ act: 'media', key: 'pause' })).ok, true);
  assert.equal((await hands.nowPlaying()).playing, false);
  assert.equal((await act({ act: 'media', key: 'playpause' })).ok, true);
  assert.equal((await hands.nowPlaying()).playing, true);
  assert.equal((await act({ act: 'media', key: 'next' })).ok, true);
  assert.equal((await hands.nowPlaying()).title, 'Rainy Evening');
  assert.equal((await act({ act: 'media', key: 'previous' })).ok, true);
  assert.equal((await hands.nowPlaying()).title, 'Sunny Morning');
  assert.deepEqual(said.trim().split('\n'), ['ready', 'Pause', 'PlayPause', 'Next', 'Previous']);
  player.kill();
});

test('a link in a named browser: started with the link when it’s installed, your usual browser when it isn’t', { skip }, async () => {
  const bin = join(tmpdir(), 'dot-bin'), got = join(tmpdir(), 'dot-firefox.url');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'firefox'), `#!/bin/sh\nprintf %s "$1" > ${got}\n`);
  chmodSync(join(bin, 'firefox'), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  opened.length = 0;
  assert.equal((await act({ act: 'url', url: 'https://example.com/a', browser: 'firefox' })).ok, true);
  assert.equal(await until(() => existsSync(got) && readFileSync(got, 'utf8')), 'https://example.com/a');
  assert.equal((await act({ act: 'url', url: 'https://example.com/b', browser: 'chrome' })).ok, true); // no google-chrome here
  assert.equal((await act({ act: 'play', url: 'https://www.youtube.com/watch?v=aBcDeFgHiJk', browser: 'brave' })).ok, true);
  await until(() => opened.length === 2);
  assert.deepEqual(opened, ['https://example.com/b', 'https://www.youtube.com/watch?v=aBcDeFgHiJk']);
});

test('Wayland: windows, keys and clicks say they need X11, not what xdotool said', { skip }, async () => {
  const shot = { w: W, h: H, display: { bounds: { x: 0, y: 0, width: W, height: H }, scale: 1 } };
  const display = process.env.DISPLAY;
  process.env.WAYLAND_DISPLAY = 'wayland-0';
  try {
    delete process.env.DISPLAY; // no XWayland
    for (const a of [{ act: 'window', how: 'smaller', app: '' }, { act: 'keys', keys: 'ctrl+t' }, { act: 'click', x: 1, y: 1 }]) {
      assert.match((await act(a, shot)).error, /^this needs an X11 session/, a.act);
    }
    process.env.DISPLAY = display; // XWayland, but the app's window is a Wayland one
    assert.match((await act({ act: 'window', how: 'left', app: 'firefox' })).error, /^this needs an X11 session/);
  } finally {
    process.env.DISPLAY = display;
    delete process.env.WAYLAND_DISPLAY;
  }
});
