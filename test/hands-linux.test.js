// Blu's hands on Linux, on any computer: the system is pretend, so these check the exact commands.
// (On a real Linux desktop: test/linux.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHands, linuxKeys } from '../desktop/hands.js';

delete process.env.WAYLAND_DISPLAY; // the Wayland test sets it itself

const display = { workArea: { x: 0, y: 0, width: 1280, height: 800 }, scaleFactor: 1 };
const apps = [{ name: 'Spotify', id: 'spotify', path: '/usr/share/applications/spotify.desktop' }, { name: 'Visual Studio Code', id: 'code', path: '/usr/share/applications/code.desktop' }];

/** Hands on a pretend Linux: `answer(file, args)` → what the program prints (or throw what it says). */
function linux(answer = () => '', { screen = display, failToStart = [] } = {}) {
  const calls = [], started = [], opened = [], matched = [];
  const hands = createHands({
    platform: 'linux',
    exec: async (file, args) => { calls.push([file, ...args]); return answer(file, args); },
    start: (file, args, failed) => { started.push([file, ...args]); if (failToStart.includes(file)) failed(new Error(`spawn ${file} ENOENT`)); },
    menuApps: () => apps,
    screen: { getDisplayMatching: (r) => { matched.push(r); return screen; } },
    shell: { openExternal: async (url) => { opened.push(url); } },
    typeOut: async () => ({ ok: true }),
  });
  const run = async (...actions) => hands.run(actions, { shot: null, allow: { hands: true, click: true } });
  return { hands, run, calls, started, opened, matched };
}
const fail = (message) => { throw new Error(message); };
// A window at (300, 200) with a 20 px title bar that xdotool counts twice: it says (302, 240), and after
// being moved to where it says, (304, 280).
const windowAt = (file, args) => {
  const a = args.join(' ');
  if (a === 'getactivewindow') return '42';
  if (a === 'getwindowgeometry --shell 42') return 'WINDOW=42\nX=302\nY=240\nWIDTH=600\nHEIGHT=400\nSCREEN=0';
  if (a === 'windowmove 42 302 240 sleep 0.1 getwindowgeometry --shell 42') return 'WINDOW=42\nX=304\nY=280\nWIDTH=600\nHEIGHT=400\nSCREEN=0';
  return '';
};

test('Linux media: playerctl for each key; “install playerctl” when it isn’t there; its own words when nothing plays', async () => {
  const p = linux();
  const keys = ['playpause', 'play', 'pause', 'next', 'previous', 'stop'];
  const done = await p.run(...keys.map((key) => ({ act: 'media', key })));
  assert.deepEqual(done.map((r) => r.ok), [true, true, true, true, true, true]);
  assert.deepEqual(p.calls, [['playerctl', 'play-pause'], ['playerctl', 'play'], ['playerctl', 'pause'], ['playerctl', 'next'], ['playerctl', 'previous'], ['playerctl', 'stop']]);
  assert.equal((await linux(() => fail('spawn playerctl ENOENT')).run({ act: 'media', key: 'next' }))[0].error, 'install playerctl for this');
  assert.equal((await linux(() => fail('No players found')).run({ act: 'media', key: 'next' }))[0].error, 'No players found');
});

test('Linux volume: wpctl, kept to 100%; pactl when wpctl fails, brought back to 100% if it went past', async () => {
  const wp = linux();
  await wp.run({ act: 'volume', by: 10 }, { act: 'volume', by: -20 }, { act: 'volume', set: 30 }, { act: 'volume', mute: true }, { act: 'volume', mute: false });
  assert.deepEqual(wp.calls, [
    ['wpctl', 'set-volume', '-l', '1.0', '@DEFAULT_AUDIO_SINK@', '10%+'], ['wpctl', 'set-volume', '-l', '1.0', '@DEFAULT_AUDIO_SINK@', '20%-'],
    ['wpctl', 'set-volume', '-l', '1.0', '@DEFAULT_AUDIO_SINK@', '0.3'], ['wpctl', 'set-mute', '@DEFAULT_AUDIO_SINK@', '1'], ['wpctl', 'set-mute', '@DEFAULT_AUDIO_SINK@', '0'],
  ]);
  let level = 'Volume: front-left: 72089 / 110% / 2.48 dB,   front-right: 72089 / 110% / 2.48 dB';
  const pa = linux((file, args) => (file === 'wpctl' ? fail('Could not connect to PipeWire') : args[0] === 'get-sink-volume' ? level : ''));
  const done = await pa.run({ act: 'volume', by: 10 }, { act: 'volume', by: -20 }, { act: 'volume', set: 30 }, { act: 'volume', mute: true });
  assert.deepEqual(done.map((r) => r.ok), [true, true, true, true]);
  assert.deepEqual(pa.calls.filter(([file]) => file === 'pactl'), [
    ['pactl', 'set-sink-volume', '@DEFAULT_SINK@', '+10%'], ['pactl', 'get-sink-volume', '@DEFAULT_SINK@'], ['pactl', 'set-sink-volume', '@DEFAULT_SINK@', '100%'],
    ['pactl', 'set-sink-volume', '@DEFAULT_SINK@', '-20%'], ['pactl', 'set-sink-volume', '@DEFAULT_SINK@', '30%'], ['pactl', 'set-sink-mute', '@DEFAULT_SINK@', '1'],
  ]);
  level = 'Volume: front-left: 39321 /  60% / -13.31 dB';
  const under = linux((file, args) => (file === 'wpctl' ? fail('Could not connect to PipeWire') : args[0] === 'get-sink-volume' ? level : ''));
  await under.run({ act: 'volume', by: 10 });
  assert.deepEqual(under.calls.at(-1), ['pactl', 'get-sink-volume', '@DEFAULT_SINK@']); // not past 100: left alone
  const neither = await linux((file) => fail(`spawn ${file} ENOENT`)).run({ act: 'volume', by: 10 });
  assert.equal(neither[0].error, 'install wpctl or pactl for this');
});

test('Linux windows: the one in front or the app named, moved with xdotool from where its frame really is', async () => {
  const p = linux(windowAt);
  assert.equal((await p.run({ act: 'window', how: 'up', app: '' }))[0].ok, true);
  assert.deepEqual(p.calls, [
    ['xdotool', 'getactivewindow'],
    ['xdotool', 'getwindowgeometry', '--shell', '42'],
    ['xdotool', 'windowmove', '42', '302', '240', 'sleep', '0.1', 'getwindowgeometry', '--shell', '42'],
    ['xdotool', 'windowsize', '42', '600', '400', 'windowmove', '42', '300', '120'], // its frame was at (300, 200): up by a tenth of the screen
  ]);
  assert.deepEqual(p.matched, [{ x: 300, y: 200, width: 600, height: 400 }]);
  const named = linux((file, args) => (args[0] === 'search' ? '42\n43' : windowAt(file, args)));
  await named.run({ act: 'window', how: 'smaller', app: 'spotify' }, { act: 'window', how: 'left', app: 'spotify' }, { act: 'window', how: 'maximize', app: 'spotify' },
    { act: 'window', how: 'minimize', app: 'spotify' }, { act: 'window', how: 'focus', app: 'spotify' });
  assert.deepEqual(named.calls.filter(([, cmd]) => !['getwindowgeometry', 'windowmove'].includes(cmd)), [
    ['xdotool', 'search', '--onlyvisible', '--class', 'spotify'], ['xdotool', 'windowsize', '42', '480', '320', 'windowmove', '42', '360', '240'],
    ['xdotool', 'search', '--onlyvisible', '--class', 'spotify'], ['xdotool', 'windowsize', '42', '640', '800', 'windowmove', '42', '0', '0'],
    ['xdotool', 'search', '--onlyvisible', '--class', 'spotify'], ['xdotool', 'windowsize', '42', '1280', '800', 'windowmove', '42', '0', '0'],
    ['xdotool', 'search', '--onlyvisible', '--class', 'spotify'], ['xdotool', 'windowminimize', '42'],
    ['xdotool', 'search', '--onlyvisible', '--class', 'spotify'], ['xdotool', 'windowactivate', '42'],
  ]);
  // A 2x screen: Electron's work area is in its units, xdotool's in pixels.
  const scaled = linux(windowAt, { screen: { workArea: { x: 0, y: 0, width: 640, height: 400 }, scaleFactor: 2 } });
  await scaled.run({ act: 'window', how: 'right', app: '' });
  assert.deepEqual(scaled.calls.at(-1), ['xdotool', 'windowsize', '42', '640', '800', 'windowmove', '42', '640', '0']);
});

test('Linux windows: a minimized app is found to bring back; clear errors for no window, nothing in front, no xdotool', async () => {
  const none = (file, args) => fail(`Command failed: xdotool ${args.join(' ')}`); // xdotool search finds nothing: exit 1, not a word
  const minimized = linux((file, args) => (args[0] === 'search' ? (args[1] === '--onlyvisible' ? none(file, args) : '7\n42') : windowAt(file, args)));
  assert.equal((await minimized.run({ act: 'window', how: 'restore', app: 'spotify' }))[0].ok, true);
  assert.deepEqual(minimized.calls, [
    ['xdotool', 'search', '--onlyvisible', '--class', 'spotify'], ['xdotool', 'search', '--class', 'spotify'],
    ['xdotool', 'getwindowgeometry', '--shell', '42'], ['xdotool', 'windowactivate', '42'],
  ]);
  const gone = linux((file, args) => (args[0] === 'search' ? none(file, args) : windowAt(file, args)));
  assert.equal((await gone.run({ act: 'window', how: 'smaller', app: 'spotify' }))[0].error, 'no open window for spotify');
  assert.equal(gone.calls.length, 1); // only a minimized window comes back, not a hidden one made smaller
  assert.equal((await gone.run({ act: 'window', how: 'focus', app: 'spotify' }))[0].error, 'no open window for spotify');
  const nothingInFront = linux(() => fail('XGetWindowProperty[_NET_ACTIVE_WINDOW] failed (code=1)\nxdo_get_active_window reported an error'));
  assert.equal((await nothingInFront.run({ act: 'window', how: 'left', app: '' }))[0].error, 'can’t tell which window is in front: name the app');
  const noXdotool = linux(() => fail('spawn xdotool ENOENT'));
  const done = await noXdotool.run({ act: 'window', how: 'left', app: '' }, { act: 'window', how: 'left', app: 'spotify' }, { act: 'keys', keys: 'ctrl+t' });
  assert.deepEqual(done.map((r) => r.error), ['install xdotool for this', 'install xdotool for this', 'install xdotool for this']);
});

test('Linux on Wayland, or with no X at all: “needs an X11 session”, not what xdotool said', async () => {
  const shot = { w: 100, h: 100, display: { bounds: { x: 0, y: 0, width: 100, height: 100 }, scale: 1 } };
  const actions = [{ act: 'window', how: 'left', app: '' }, { act: 'window', how: 'left', app: 'firefox' }, { act: 'keys', keys: 'ctrl+t' }, { act: 'click', x: 1, y: 1 }];
  const noDisplay = linux(() => fail("Error: Can't open display: (null)\nFailed creating new xdo instance"));
  for (const r of await noDisplay.hands.run(actions, { shot, allow: { hands: true, click: true } })) assert.match(r.error, /^this needs an X11 session: Wayland doesn’t let/, r.act);
  process.env.WAYLAND_DISPLAY = 'wayland-0';
  try {
    // XWayland is there, but the app's window is a Wayland one: xdotool finds nothing.
    const wayland = linux((file, args) => fail(`Command failed: xdotool ${args.join(' ')}`));
    for (const r of await wayland.hands.run(actions, { shot, allow: { hands: true, click: true } })) assert.match(r.error, /^this needs an X11 session/, r.act);
  } finally {
    delete process.env.WAYLAND_DISPLAY;
  }
});

test('Linux keys: X11 names for xdotool, F-keys too; keys it doesn’t know refused before xdotool can skip them', async () => {
  assert.equal(linuxKeys(['ctrl', 'shift', 't']), 'ctrl+shift+t');
  assert.equal(linuxKeys(['meta', 'enter']), 'super+Return');
  assert.equal(linuxKeys(['alt', 'f4']), 'alt+F4');
  assert.equal(linuxKeys(['pageup', 'pagedown', 'esc', 'backspace', 'space', '7']), 'Prior+Next+Escape+BackSpace+space+7');
  assert.equal(linuxKeys(['ctrl', 'banana']), null);
  assert.equal(linuxKeys(['f13']), null);
  const p = linux();
  const done = await p.run({ act: 'keys', keys: 'ctrl+shift+t' }, { act: 'keys', keys: 'f5' }, { act: 'keys', keys: 'ctrl+banana' });
  assert.deepEqual(p.calls, [['xdotool', 'key', '--clearmodifiers', 'ctrl+shift+t'], ['xdotool', 'key', '--clearmodifiers', 'F5']]);
  assert.equal(done[2].error, 'don’t know the keys “ctrl+banana”');
});

test('Linux click: the point on the screenshot, in pixels at the screen’s scale', async () => {
  const p = linux();
  // A 2x screen to the right of a 1280-wide one (Electron's units), shown in a 640×400 screenshot.
  const shot = { w: 640, h: 400, display: { bounds: { x: 1280, y: 0, width: 640, height: 400 }, scale: 2 } };
  assert.equal((await p.hands.run([{ act: 'click', x: 320, y: 200 }], { shot, allow: { hands: true, click: true } }))[0].ok, true);
  assert.deepEqual(p.calls, [['xdotool', 'mousemove', '3200', '400', 'click', '1']]);
  assert.equal((await p.run({ act: 'click', x: 1, y: 1 }))[0].error, 'there’s no screenshot to click on');
});

test('Linux open: the menu’s app with gtk-launch, else gio launch, their output sent nowhere so the app can’t hold them up', async () => {
  const p = linux();
  assert.equal((await p.run({ act: 'open', app: 'spotify' }))[0].words, 'Opened Spotify');
  assert.deepEqual(p.calls, [['sh', '-c', '"$@" >/dev/null 2>&1', 'sh', 'gtk-launch', 'spotify']]);
  const gio = linux((file, args) => (args.includes('gtk-launch') ? fail('Command failed: sh -c') : ''));
  assert.equal((await gio.run({ act: 'open', app: 'studio code' }))[0].words, 'Opened Visual Studio Code');
  assert.deepEqual(gio.calls.at(-1), ['sh', '-c', '"$@" >/dev/null 2>&1', 'sh', 'gio', 'launch', '/usr/share/applications/code.desktop']);
  const neither = linux(() => fail('Command failed: sh -c'));
  const done = await neither.run({ act: 'open', app: 'spotify' }, { act: 'open', app: 'teams' });
  assert.deepEqual(done.map((r) => r.error), ['couldn’t open Spotify (with gtk-launch or gio)', 'no app called “teams”']);
});

test('Linux links in a named browser: started with the link; your usual browser when it can’t start or isn’t one Blu knows', async () => {
  const p = linux(undefined, { failToStart: ['brave-browser'] });
  await p.run({ act: 'url', url: 'https://example.com/a', browser: 'chrome' }, { act: 'url', url: 'https://example.com/b', browser: 'brave' }, { act: 'url', url: 'https://example.com/c', browser: 'netscape' });
  assert.deepEqual(p.started, [['google-chrome', 'https://example.com/a'], ['brave-browser', 'https://example.com/b']]);
  assert.deepEqual(p.opened, ['https://example.com/b', 'https://example.com/c']);
});

test('Linux nowPlaying: playerctl’s title, artist, status and player; null when nothing plays', async () => {
  const format = ['playerctl', 'metadata', '--format', '{{title}}\t{{artist}}\t{{status}}\t{{playerName}}'];
  const spotify = linux(() => 'Sunny Morning\tThe Examples\tPlaying\tspotify');
  assert.deepEqual(await spotify.hands.nowPlaying(), { title: 'Sunny Morning', artist: 'The Examples', playing: true, app: 'Spotify' });
  assert.deepEqual(spotify.calls, [format]);
  assert.deepEqual(await linux(() => 'Lo-fi beats\t\tPaused\tchromium.instance4242').hands.nowPlaying(), { title: 'Lo-fi beats', artist: '', playing: false, app: 'Chromium' });
  assert.equal(await linux(() => '\t\tStopped\tvlc').hands.nowPlaying(), null);
  assert.equal(await linux(() => fail('No players found')).hands.nowPlaying(), null);
});
