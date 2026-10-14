import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appName, createHands, keyNames, linuxKeys, pickApp, shotToScreen, windowRect, windowsKeys } from '../desktop/hands.js';

const work = { x: 0, y: 0, w: 1920, h: 1040 };

test('windowRect: smaller and bigger around the middle, halves of the screen, nudges; always on screen', () => {
  const cur = { x: 400, y: 200, w: 1000, h: 600 };
  assert.deepEqual(windowRect('smaller', cur, work), { x: 500, y: 260, w: 800, h: 480 });
  assert.deepEqual(windowRect('bigger', cur, work), { x: 275, y: 125, w: 1250, h: 750 });
  assert.deepEqual(windowRect('left', cur, work), { x: 0, y: 0, w: 960, h: 1040 });
  assert.deepEqual(windowRect('right', cur, work), { x: 960, y: 0, w: 960, h: 1040 });
  assert.deepEqual(windowRect('bottom', cur, work), { x: 0, y: 520, w: 1920, h: 520 });
  assert.deepEqual(windowRect('center', { x: 0, y: 0, w: 1000, h: 600 }, work), { x: 460, y: 220, w: 1000, h: 600 });
  assert.deepEqual(windowRect('up', cur, work), { x: 400, y: 96, w: 1000, h: 600 });
  assert.deepEqual(windowRect('up', { ...cur, y: 20 }, work), { x: 400, y: 0, w: 1000, h: 600 }); // not off the top
  assert.deepEqual(windowRect('bigger', { x: 0, y: 0, w: 1900, h: 1000 }, work), { x: 0, y: 0, w: 1920, h: 1040 }); // never bigger than the screen
  assert.deepEqual(windowRect('smaller', { x: 10, y: 10, w: 300, h: 200 }, work), { x: 0, y: 0, w: 320, h: 240 }); // never tiny
  assert.deepEqual(windowRect('maximize', cur, work), { cmd: 'maximize' });
  assert.equal(windowRect('explode', cur, work), null);
  // A second screen to the left of the first.
  assert.deepEqual(windowRect('left', cur, { x: -1920, y: 0, w: 1920, h: 1080 }), { x: -1920, y: 0, w: 960, h: 1080 });
});

test('pickApp: the exact name, then one starting with it, then all its words', () => {
  const apps = [{ name: 'Spotify', id: 'a' }, { name: 'Spotify Web Helper', id: 'b' }, { name: 'Visual Studio Code', id: 'c' }, { name: 'Microsoft Teams', id: 'd' }];
  assert.equal(pickApp('spotify', apps).id, 'a');
  assert.equal(pickApp('Spot', apps).id, 'a');
  assert.equal(pickApp('studio code', apps).id, 'c');
  assert.equal(pickApp('teams app', apps), null);
  assert.equal(pickApp('the Spotify app', apps).id, 'a');
  assert.equal(pickApp('', apps), null);
});

test('keys: names to Windows key codes and X11 names', () => {
  assert.deepEqual(keyNames('Control + Shift + T'), ['ctrl', 'shift', 't']);
  assert.deepEqual(keyNames('cmd+return'), ['meta', 'enter']);
  assert.deepEqual(windowsKeys(['ctrl', 't']), [0x11, 0x54]);
  assert.deepEqual(windowsKeys(['alt', 'f4']), [0x12, 0x73]);
  assert.equal(windowsKeys(['ctrl', 'banana']), null);
  assert.equal(linuxKeys(['meta', 'enter']), 'super+Return');
});

test('appName: what’s playing, named the way you’d say it', () => {
  assert.equal(appName('Spotify.exe'), 'Spotify');
  assert.equal(appName('SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify'), 'Spotify');
  assert.equal(appName('Chrome'), 'Chrome');
  assert.equal(appName('chromium.instance4242'), 'Chromium');
  assert.equal(appName(''), '');
});

test('shotToScreen: a point on the screenshot lands on the screen it showed', () => {
  const shot = { w: 1356, h: 848, display: { bounds: { x: 1920, y: 0, width: 2560, height: 1600 }, scale: 1.5 } };
  assert.deepEqual(shotToScreen({ x: 678, y: 424 }, shot), { x: 1920 + 1280, y: 800 });
});

test('run: a receipt for each action; off switches and unknown actions refuse, the rest still run', async () => {
  const opened = [];
  const hands = createHands({ shell: { openExternal: async (u) => opened.push(u) }, screen: {}, typeOut: async (t) => ({ ok: t === 'hi' }), platform: 'linux-test' });
  const receipts = await hands.run([
    { act: 'url', url: 'https://example.com', words: 'Open example.com' },
    { act: 'play', url: 'https://www.youtube.com/watch?v=aBcDeFgHiJk', words: 'Play “Sunny Morning”' },
    { act: 'play', url: 'https://evil.example/x' },
    { act: 'click', x: 1, y: 1 },
    { act: 'teleport' },
  ], { allow: { hands: true, click: false } });
  assert.deepEqual(receipts.map((r) => r.ok), [true, true, false, false, false]);
  assert.match(receipts[3].error, /clicking and typing are off/);
  assert.deepEqual(opened, ['https://example.com/', 'https://www.youtube.com/watch?v=aBcDeFgHiJk']); // as one whole address
  const off = await hands.run([{ act: 'url', url: 'https://example.com' }], { allow: { hands: false } });
  assert.match(off[0].error, /hands are off/);
  const typed = await hands.run([{ act: 'type', text: 'hi' }], { allow: { hands: true, click: true } });
  assert.equal(typed[0].ok, true);
});
