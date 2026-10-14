// Blu's hands on macOS (desktop/hands.js), with the Mac swapped out: the exact osascript and open
// commands it runs, and what it makes of their answers. The JavaScript for Automation it sends is
// also run here, against stand-ins for the ObjC bridge and the apps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHands } from '../desktop/hands.js';

const applescript = (script) => ['osascript', '-l', 'AppleScript', '-e', script];
const javascript = (script) => ['osascript', '-l', 'JavaScript', '-e', script];
const SE = 'tell application "System Events" to ';
const FRONT = `${SE}tell (first application process whose frontmost is true) to `;
const ACCESSIBILITY = 'allow dotpals under Privacy & Security → Accessibility, then ask again';

// The main screen (menu bar on top, Dock at the bottom), and a second one to its left.
const displays = [
  { bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 800 } },
  { bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, workArea: { x: -1920, y: 25, width: 1920, height: 1055 } },
];
const screen = { getDisplayMatching: (r) => displays.find((d) => r.x + r.width / 2 >= d.bounds.x && r.x + r.width / 2 < d.bounds.x + d.bounds.width) ?? displays[0] };

/** Hands on a pretend Mac. `answer(file, args)`: what a command prints (throw: it failed). `trusted`: allowed under Accessibility. */
function mac(t, { answer = () => '', trusted = true } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [], asked = [], opened = [];
  const hands = createHands({
    platform: 'darwin', screen, typeOut: async () => ({ ok: true }),
    shell: { openExternal: async (url) => { opened.push(url); } },
    exec: async (file, args) => { calls.push([file, ...args]); return answer(file, args); },
    trusted: async (ask) => { asked.push(ask); return trusted; },
  });
  // run() pauses 1.2 s after opening something, for the app to come up: not here.
  const run = async (actions, { shot = null, allow = { hands: true, click: true } } = {}) => {
    let done = false;
    const receipts = hands.run(actions, { shot, allow }).finally(() => { done = true; });
    while (!done) { await new Promise((r) => setImmediate(r)); t.mock.timers.tick(1200); }
    return receipts;
  };
  return { hands, run, calls, asked, opened };
}

/** Run JavaScript for Automation here, with stand-ins for the ObjC bridge: what it imported, made and posted. */
function jxa(script) {
  const seen = { imports: [], made: [], posted: [] };
  const nil = { nil: true };
  const $ = Object.assign(() => nil, {
    NSEvent: { otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2: (...args) => { seen.made.push(args); return { CGEvent: `event ${seen.made.length}` }; } },
    CGEventCreateMouseEvent: (...args) => { seen.made.push(args); return `event ${seen.made.length}`; },
    CGEventPost: (tap, event) => { seen.posted.push([tap, event]); },
  });
  new Function('$', 'ObjC', script)($, { import: (name) => seen.imports.push(name) });
  return { ...seen, nil };
}

/** The Mac's speakers: the volume commands read and change `state` ({ volume, muted, playing }). */
const speakers = (state) => (file, args) => {
  const s = args.at(-1);
  let m;
  if (s === 'output volume of (get volume settings)') return String(state.volume);
  if (s === 'get volume settings') return `output volume:${state.volume}, input volume:75, alert volume:100, output muted:${state.muted}`;
  if ((m = /^set volume output volume (\d+) without output muted$/.exec(s))) Object.assign(state, { volume: Number(m[1]), muted: false });
  if ((m = /^set volume output muted (true|false)$/.exec(s))) state.muted = m[1] === 'true';
  if (s.startsWith('function run()')) return state.playing ?? '';
  return '';
};

const mediaScript = (code) => `ObjC.import('AppKit'); ObjC.import('CoreGraphics'); for (const down of [true, false]) { const e = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(14, {x: 0, y: 0}, down ? 0xa00 : 0xb00, 0, 0, $(), 8, (${code} << 16) | ((down ? 0xa : 0xb) << 8), -1); $.CGEventPost(0, e.CGEvent); }`;
const NOW_PLAYING = "function run() { for (const name of ['Spotify', 'Music']) { try { const app = Application(name); if (!app.running()) continue; const state = app.playerState(); if (state !== 'stopped') return [app.currentTrack.name(), app.currentTrack.artist(), state, name].join('\\t'); } catch (e) {} } return ''; }";

test('media keys: play/pause, next and previous are pressed as the keys Apple’s keyboards send', async (t) => {
  const { run, calls } = mac(t);
  const receipts = await run(['playpause', 'next', 'previous', 'pause', 'stop'].map((key) => ({ act: 'media', key })));
  assert.deepEqual(receipts.map((r) => r.ok), [true, true, true, true, true]);
  // NX_KEYTYPE_PLAY 16, FAST 19, REWIND 20 (play, pause and stop are the one play/pause key).
  assert.deepEqual(calls, [16, 19, 20, 16, 16].map((code) => javascript(mediaScript(code))));
});

test('media keys: the key goes down and up as a system-defined event, posted to the HID event tap', () => {
  const r = jxa(mediaScript(19));
  assert.deepEqual(r.imports, ['AppKit', 'CoreGraphics']); // NSEvent is AppKit's; CGEventPost is CoreGraphics'
  // NSSystemDefined (14), flags NX_KEYDOWN or NX_KEYUP << 8, subtype 8 (aux control buttons), data1 the key << 16 | down or up << 8.
  assert.deepEqual(r.made, [
    [14, { x: 0, y: 0 }, 0xa00, 0, 0, r.nil, 8, 0x130a00, -1],
    [14, { x: 0, y: 0 }, 0xb00, 0, 0, r.nil, 8, 0x130b00, -1],
  ]);
  assert.deepEqual(r.posted, [[0, 'event 1'], [0, 'event 2']]);
});

test('volume: up, down, set and mute say what they did, never past 0 or 100, and unmute when they change it', async (t) => {
  const state = { volume: 40, muted: false };
  const { run, calls } = mac(t, { answer: speakers(state) });
  const get = applescript('output volume of (get volume settings)');

  assert.equal((await run([{ act: 'volume', by: -10 }]))[0].words, 'Volume 40% → 30%');
  assert.deepEqual(calls.splice(0), [get, applescript('set volume output volume 30 without output muted'), get]);

  state.volume = 95;
  assert.equal((await run([{ act: 'volume', by: 10 }]))[0].words, 'Volume 95% → 100%');
  assert.deepEqual(calls.splice(0)[1], applescript('set volume output volume 100 without output muted'));

  assert.equal((await run([{ act: 'volume', set: 55 }]))[0].words, 'Volume 100% → 55%');
  assert.deepEqual(calls.splice(0)[1], applescript('set volume output volume 55 without output muted'));

  assert.equal((await run([{ act: 'volume', mute: true }]))[0].words, 'Muted (55%)');
  assert.deepEqual(calls.splice(0), [get, applescript('set volume output muted true'), get]);
  assert.equal((await run([{ act: 'volume', mute: false }]))[0].words, 'Unmuted, 55%');
  assert.deepEqual(calls.splice(0)[1], applescript('set volume output muted false'));
});

test('volume: speakers the Mac can’t set (missing value) get a clear answer and nothing is changed', async (t) => {
  const { run, calls } = mac(t, { answer: speakers({ volume: 'missing value', muted: false }) });
  const [r] = await run([{ act: 'volume', by: 10 }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /can’t be changed from the Mac/);
  assert.deepEqual(calls, [applescript('output volume of (get volume settings)')]);
});

test('nowPlaying: asks Spotify, then Music, in JavaScript for Automation, and reads the answer', async (t) => {
  let out = 'Sunny Morning\tThe Examples\tplaying\tSpotify';
  const { hands, calls } = mac(t, { answer: () => { if (out instanceof Error) throw out; return out; } });
  assert.deepEqual(await hands.nowPlaying(), { title: 'Sunny Morning', artist: 'The Examples', playing: true, app: 'Spotify' });
  assert.deepEqual(calls, [javascript(NOW_PLAYING)]);
  out = 'Hey Jude\tThe Beatles\tpaused\tMusic';
  assert.deepEqual(await hands.nowPlaying(), { title: 'Hey Jude', artist: 'The Beatles', playing: false, app: 'Music' });
  out = '';
  assert.equal(await hands.nowPlaying(), null);
  out = new Error('Not authorized to send Apple events to Music. (-1743)');
  assert.equal(await hands.nowPlaying(), null);
});

test('nowPlaying: its script works with Spotify not installed or closed, and skips a stopped player', () => {
  const app = (running, state, title, artist) => ({ running: () => running, playerState: () => state, currentTrack: { name: () => title, artist: () => artist } });
  const ask = (apps) => new Function('Application', `${NOW_PLAYING}; return run();`)((name) => { if (!(name in apps)) throw new Error('Application can’t be found.'); return apps[name]; });
  assert.equal(ask({ Music: app(true, 'paused', 'Song', 'Band') }), 'Song\tBand\tpaused\tMusic');
  assert.equal(ask({ Spotify: app(false), Music: app(true, 'playing', 'Hey Jude', 'The Beatles') }), 'Hey Jude\tThe Beatles\tplaying\tMusic');
  assert.equal(ask({ Spotify: app(true, 'stopped'), Music: app(false) }), '');
  assert.equal(ask({ Spotify: app(true, 'playing', 'A', 'B'), Music: app(true, 'playing', 'C', 'D') }), 'A\tB\tplaying\tSpotify');
});

test('ducking reads `get volume settings`: a third while Blu listens, back after; not when muted, paused or unreadable', async (t) => {
  const state = { volume: 60, muted: false, playing: 'Song\tBand\tplaying\tMusic' };
  const { hands, calls } = mac(t, { answer: speakers(state) });
  await hands.duck(true);
  assert.equal(state.volume, 20);
  assert.deepEqual(calls.slice(0, 2), [javascript(NOW_PLAYING), ['osascript', '-e', 'get volume settings']]);
  await hands.duck(false);
  assert.equal(state.volume, 60);

  for (const quiet of [{ muted: true }, { playing: 'Song\tBand\tpaused\tMusic' }, { volume: 'missing value' }]) {
    Object.assign(state, { volume: 60, muted: false, playing: 'Song\tBand\tplaying\tMusic' }, quiet);
    calls.length = 0;
    await hands.duck(true);
    assert.equal(calls.some((c) => /^set volume/.test(c.at(-1))), false, JSON.stringify(quiet));
    await hands.duck(false);
  }
});

test('open: an app by its name, a browser by the name macOS knows it by; one that isn’t there says so', async (t) => {
  const { run, calls } = mac(t, { answer: (file, args) => { if (args[1] === 'Nope') throw new Error('Unable to find application named \'Nope\''); return ''; } });
  const receipts = await run([{ act: 'open', app: 'Spotify' }, { act: 'open', app: 'Chrome' }, { act: 'open', app: 'Nope' }]);
  assert.equal(receipts[0].words, 'Opened Spotify');
  assert.equal(receipts[1].words, 'Opened Google Chrome');
  assert.equal(receipts[2].error, 'no app called “Nope”');
  assert.deepEqual(calls, [['open', '-a', 'Spotify'], ['open', '-a', 'Google Chrome'], ['open', '-a', 'Nope']]);
});

test('a page in the browser you named opens with open -a; your usual browser when that one isn’t there or none was named', async (t) => {
  const { run, calls, opened } = mac(t, { answer: (file, args) => { if (args[1] === 'Vivaldi') throw new Error('Unable to find application named \'Vivaldi\''); return ''; } });
  const receipts = await run([
    { act: 'url', url: 'https://example.com/', browser: 'brave' },
    { act: 'url', url: 'https://example.com/a', browser: 'safari' },
    { act: 'url', url: 'https://example.com/b', browser: 'vivaldi' },
    { act: 'url', url: 'https://example.com/c' },
  ]);
  assert.deepEqual(receipts.map((r) => r.ok), [true, true, true, true]);
  assert.deepEqual(calls, [['open', '-a', 'Brave Browser', 'https://example.com/'], ['open', '-a', 'Safari', 'https://example.com/a'], ['open', '-a', 'Vivaldi', 'https://example.com/b']]);
  assert.deepEqual(opened, ['https://example.com/b', 'https://example.com/c']);
});

test('windows: System Events’ "x, y, w, h" is read, then the window is placed in its screen’s work area', async (t) => {
  let at = '200, 100, 800, 600';
  const { run, calls } = mac(t, { answer: (file, args) => (args.at(-1).endsWith('get (position of window 1) & (size of window 1)') ? at : '') });
  const get = 'get (position of window 1) & (size of window 1)';

  await run([{ act: 'window', how: 'left' }]);
  assert.deepEqual(calls.splice(0), [applescript(FRONT + get), applescript(`${FRONT}set position of window 1 to {0, 25}`), applescript(`${FRONT}set size of window 1 to {720, 800}`)]);

  await run([{ act: 'window', how: 'maximize' }]);
  assert.deepEqual(calls.splice(0).slice(1), [applescript(`${FRONT}set position of window 1 to {0, 25}`), applescript(`${FRONT}set size of window 1 to {1440, 800}`)]);

  // A named app's window on the screen to the left (negative x).
  at = '-1700, 125, 1000, 700';
  const spotify = `${SE}tell (first application process whose name contains "Spotify") to `;
  await run([{ act: 'window', how: 'smaller', app: 'Spotify' }]);
  assert.deepEqual(calls.splice(0), [applescript(spotify + get), applescript(`${spotify}set position of window 1 to {-1600, 195}`), applescript(`${spotify}set size of window 1 to {800, 560}`)]);
  await run([{ act: 'window', how: 'right', app: 'Spotify' }]);
  assert.deepEqual(calls.splice(0).slice(1), [applescript(`${spotify}set position of window 1 to {-960, 25}`), applescript(`${spotify}set size of window 1 to {960, 1055}`)]);
});

test('windows: minimize, restore and focus are the system’s own; an app name is quoted for AppleScript', async (t) => {
  const { run, calls } = mac(t, { answer: (file, args) => (args.at(-1).endsWith('(size of window 1)') ? '0, 25, 800, 600' : '') });
  const receipts = await run([{ act: 'window', how: 'minimize' }, { act: 'window', how: 'restore' }, { act: 'window', how: 'focus' }, { act: 'window', how: 'explode' }]);
  assert.deepEqual(receipts.map((r) => r.ok), [true, true, true, false]);
  assert.deepEqual(calls.filter((_, i) => i % 2).slice(0, 3), [
    applescript(`${FRONT}set value of attribute "AXMinimized" of window 1 to true`),
    applescript(`${FRONT}set value of attribute "AXMinimized" of window 1 to false`),
    applescript(`${FRONT}set frontmost to true`),
  ]);
  assert.match(receipts[3].error, /can’t do “explode”/);

  calls.length = 0;
  await run([{ act: 'window', how: 'focus', app: 'My "Odd" \\ App\nX' }]);
  assert.equal(calls[1].at(-1), `${SE}tell (first application process whose name contains "My \\"Odd\\" \\\\ App X") to set frontmost to true`);
});

test('click: a point on the screenshot is clicked on the screen it showed, in points, from JavaScript for Automation', async (t) => {
  const { run, calls } = mac(t);
  const main = { w: 1000, h: 625, display: { bounds: displays[0].bounds, scale: 2 } };
  const left = { w: 960, h: 540, display: { bounds: displays[1].bounds, scale: 1 } };
  assert.equal((await run([{ act: 'click', x: 500, y: 250 }], { shot: main }))[0].ok, true);
  assert.equal((await run([{ act: 'click', x: 480, y: 270 }], { shot: left }))[0].ok, true);
  const click = (x, y) => `ObjC.import('CoreGraphics'); const p = {x: ${x}, y: ${y}}; for (const t of [5, 1, 2]) $.CGEventPost(0, $.CGEventCreateMouseEvent(null, t, p, 0));`;
  assert.deepEqual(calls, [javascript(click(720, 360)), javascript(click(-960, 540))]);

  // Moved there, then the left button down and up (kCGEventMouseMoved 5, LeftMouseDown 1, LeftMouseUp 2), at the HID tap.
  const r = jxa(click(720, 360));
  assert.deepEqual(r.imports, ['CoreGraphics']);
  assert.deepEqual(r.made, [5, 1, 2].map((type) => [null, type, { x: 720, y: 360 }, 0]));
  assert.deepEqual(r.posted, [[0, 'event 1'], [0, 'event 2'], [0, 'event 3']]);

  const [none] = await run([{ act: 'click', x: 1, y: 1 }]);
  assert.match(none.error, /no screenshot/);
});

test('keys: letters are keystrokes, the rest key codes, with their modifiers; keys it doesn’t know aren’t typed out', async (t) => {
  const { run, calls, asked } = mac(t);
  const combos = ['cmd+t', 'ctrl+shift+tab', 'enter', 'f5', 'cmd+alt+esc', 'shift+1', 'f12', 'cmd+left'];
  const receipts = await run(combos.slice(0, 6).map((keys) => ({ act: 'keys', keys })));
  receipts.push(...await run(combos.slice(6).map((keys) => ({ act: 'keys', keys }))));
  assert.deepEqual(receipts.map((r) => r.ok), combos.map(() => true));
  assert.deepEqual(calls, [
    `${SE}keystroke "t" using {command down}`,
    `${SE}key code 48 using {control down, shift down}`,
    `${SE}key code 36`,
    `${SE}key code 96`,
    `${SE}key code 53 using {command down, option down}`,
    `${SE}keystroke "1" using {shift down}`,
    `${SE}key code 111`,
    `${SE}key code 123 using {command down}`,
  ].map(applescript));

  calls.length = 0;
  asked.length = 0;
  const unknown = await run([{ act: 'keys', keys: 'cmd+banana' }, { act: 'keys', keys: 'cmd' }]);
  assert.deepEqual(unknown.map((r) => r.error), ['don’t know the keys “cmd+banana”', 'don’t know the keys “cmd”']);
  assert.deepEqual(calls, []);
  assert.deepEqual(asked, []); // no Accessibility prompt for keys it wouldn't press
});

test('Apple Music: plays the first match in your library; YouTube when there isn’t one', async (t) => {
  let found = true;
  const { run, calls, opened } = mac(t, { answer: (file, args) => { if (args.at(-1).includes('"Music"') && !found) throw new Error('Can’t get item 1 of {}. (-1728)'); return ''; } });
  assert.equal((await run([{ act: 'play', applemusic: 'Sunny Morning' }]))[0].ok, true);
  assert.deepEqual(calls.splice(0), [applescript('tell application "Music" to play (item 1 of (search library playlist 1 for "Sunny Morning"))')]);
  assert.deepEqual(opened, []);

  await run([{ act: 'play', applemusic: 'Say "Hi" \\ now' }]);
  assert.equal(calls.splice(0)[0].at(-1), 'tell application "Music" to play (item 1 of (search library playlist 1 for "Say \\"Hi\\" \\\\ now"))');

  found = false;
  assert.equal((await run([{ act: 'play', applemusic: 'Sunny Morning' }]))[0].ok, true);
  assert.deepEqual(opened, ['https://www.youtube.com/results?search_query=Sunny%20Morning']);
  calls.length = 0;
  await run([{ act: 'play', applemusic: 'Sunny Morning', browser: 'chrome' }]);
  assert.deepEqual(calls[1], ['open', '-a', 'Google Chrome', 'https://www.youtube.com/results?search_query=Sunny%20Morning']);
});

test('not allowed under Accessibility: media keys, windows, clicks and keys refuse and ask; the rest still work', async (t) => {
  const { run, calls, asked } = mac(t, { trusted: false, answer: speakers({ volume: 40, muted: false }) });
  const shot = { w: 1000, h: 625, display: { bounds: displays[0].bounds, scale: 2 } };
  const refused = await run([{ act: 'media', key: 'playpause' }, { act: 'window', how: 'left' }, { act: 'click', x: 10, y: 10 }, { act: 'keys', keys: 'cmd+t' }], { shot });
  assert.deepEqual(refused.map((r) => [r.ok, r.error]), refused.map(() => [false, ACCESSIBILITY]));
  assert.deepEqual(calls, []); // nothing was sent
  assert.deepEqual(asked, [false, true, false, true, false, true, false, true]); // checked, then the system's prompt

  asked.length = 0;
  const fine = await run([{ act: 'volume', by: 10 }, { act: 'open', app: 'Spotify' }, { act: 'url', url: 'https://example.com/', browser: 'brave' }, { act: 'play', applemusic: 'Sunny Morning' }]);
  assert.deepEqual(fine.map((r) => r.ok), [true, true, true, true]);
  assert.deepEqual(asked, []);
});
