import { test } from 'node:test';
import assert from 'node:assert/strict';
import { navViewOf, neighbour, swipeDirection, takesTheDrag } from '../bridge/remote/swipe.js';

const W = 412;
const swipe = (o) => swipeDirection({ dx: -120, dy: 10, ms: 220, startX: 200, width: W, fingers: 1, ...o });

test('a quick, mostly horizontal swipe goes to the next tab (left) or the previous one (right)', () => {
  assert.equal(swipe({ dx: -120 }), 'next');
  assert.equal(swipe({ dx: 120 }), 'prev');
});

test('not a tab swipe: too short, too slow, mostly vertical, two fingers', () => {
  assert.equal(swipe({ dx: -40 }), null, 'too short');
  assert.equal(swipe({ ms: 900 }), null, 'too slow: that was a drag');
  assert.equal(swipe({ dx: -120, dy: 100 }), null, 'a diagonal is a scroll');
  assert.equal(swipe({ dx: -100, dy: 200 }), null, 'mostly vertical');
  assert.equal(swipe({ fingers: 2 }), null, 'a pinch');
});

test('a swipe from the screen edge is left to the system (back gesture)', () => {
  assert.equal(swipe({ startX: 6, dx: 150 }), null);
  assert.equal(swipe({ startX: W - 6, dx: -150 }), null);
  assert.equal(swipe({ startX: 40, dx: 150 }), 'prev');
});

test('neighbours follow the navigation order and stop at the ends', () => {
  const views = ['overview', 'report', 'sessions', 'map', 'agents', 'settings'];
  assert.equal(neighbour(views, 'report', 'next'), 'sessions');
  assert.equal(neighbour(views, 'report', 'prev'), 'overview');
  assert.equal(neighbour(views, 'overview', 'prev'), null, 'no wrap-around');
  assert.equal(neighbour(views, 'settings', 'next'), null);
  assert.equal(neighbour(views, 'nowhere', 'next'), null);
  assert.equal(neighbour(views, 'report', null), null);
});

test('the current tab comes from the address: a replay counts as Sessions, nothing as Overview', () => {
  assert.equal(navViewOf('#sessions/abc'), 'sessions');
  assert.equal(navViewOf('#replay/abc/def'), 'sessions');
  assert.equal(navViewOf('#settings/remote'), 'settings');
  assert.equal(navViewOf(''), 'overview');
  assert.equal(navViewOf('#'), 'overview');
});

test('wired in: client.js loads it, the service worker caches it, and the page keeps its sideways swipe for us', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(`../bridge/remote/${p}`, import.meta.url), 'utf8');
  assert.match(read('client.js'), /import '\.\/swipe\.js'/);
  assert.match(read('sw.js'), /\/bridge\/remote\/swipe\.js/);
  assert.match(read('remote.css'), /main\s*\{\s*touch-action:\s*pan-y pinch-zoom/);
});

// A tiny stand-in for the DOM: just what takesTheDrag reads.
const node = (parent, { matches = false, scrollW = 100, clientW = 100, overflowX = 'visible' } = {}) => ({ parentElement: parent, matches: () => matches, scrollWidth: scrollW, clientWidth: clientW, overflowX });
const style = (n) => ({ overflowX: n.overflowX });

test('a touch inside something that scrolls sideways, or a field, is not a tab swipe', () => {
  const body = node(null);
  const main = node(body);
  const plain = node(main);
  assert.equal(takesTheDrag(plain, body, style), false);
  const table = node(main, { scrollW: 900, clientW: 380, overflowX: 'auto' });
  assert.equal(takesTheDrag(node(table), body, style), true, 'the report card table');
  const fits = node(main, { scrollW: 380, clientW: 380, overflowX: 'auto' });
  assert.equal(takesTheDrag(node(fits), body, style), false, 'scrollable, but nothing to scroll');
  const hidden = node(main, { scrollW: 900, clientW: 380, overflowX: 'hidden' });
  assert.equal(takesTheDrag(node(hidden), body, style), false, 'clipped, not scrollable by hand');
  assert.equal(takesTheDrag(node(main, { matches: true }), body, style), true, 'an input, slider or data-noswipe');
});
