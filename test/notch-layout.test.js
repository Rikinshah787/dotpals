import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notchBounds, notchSafeTop, overNotchIsland } from '../desktop/notch-layout.js';

test('the notch is centered at the top of the display, not the work area', () => {
  const display = {
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 25, width: 1440, height: 800 },
  };
  assert.deepEqual(notchBounds(display, { w: 220, h: 40 }), { x: 610, y: 0, width: 220, height: 40 });
  assert.equal(notchSafeTop(display, 'darwin'), 25);
  assert.equal(notchSafeTop(display, 'win32'), 0);
  assert.equal(notchSafeTop({ ...display, workArea: { ...display.workArea, y: -4 } }, 'darwin'), 0);
});

test('the island hit area follows its safe-area offset', () => {
  const bounds = { x: -800, y: 12, width: 1600, height: 100 };
  const island = { w: 160, h: 34, y: 37 };
  assert.equal(overNotchIsland(bounds, island, { x: 0, y: 48 }), true);
  assert.equal(overNotchIsland(bounds, island, { x: 0, y: 11 }), false);
  assert.equal(overNotchIsland(bounds, island, { x: 0, y: 90 }), false);
  assert.equal(overNotchIsland(bounds, null, { x: 0, y: 50 }), false);
});
