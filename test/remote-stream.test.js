import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as core from '../bridge/remote/pals-core.js';
import { CAST } from '../bridge/remote/avatar-names.js';

const source = (name) => readFileSync(new URL(`../bridge/remote/${name}.js`, import.meta.url), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

function target() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(e) { for (const fn of [...(listeners.get(e.type) ?? [])]) fn(e); return true; },
  };
}

function browser(visibility = 'visible') {
  let now = 0, next = 0;
  const timers = new Map();
  const setTimeout = (fn, delay) => { const id = ++next; timers.set(id, { fn, at: now + delay }); return id; };
  const clearTimeout = (id) => timers.delete(id);
  const tick = (ms) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].fn();
    }
    now = end;
  };
  const natives = [];
  class Native {
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = new Map(); natives.push(this); }
    addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(fn); }
    close() { this.readyState = 2; this.closed = true; }
    emit(type, data, lastEventId = '') {
      const e = { type, data: JSON.stringify(data), lastEventId };
      this[`on${type}`]?.(e);
      for (const fn of this.listeners.get(type) ?? []) fn(e);
    }
    fail() { this.readyState = 2; this.emit('error'); }
  }
  const errors = [];
  const document = { ...target(), visibilityState: visibility };
  const window = { ...target(), EventSource: Native };
  const context = vm.createContext({
    window, document, console: { error: (e) => errors.push(e) },
    addEventListener: window.addEventListener, removeEventListener: window.removeEventListener,
    dispatchEvent: window.dispatchEvent, CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    setTimeout, clearTimeout, setInterval: () => ++next,
  });
  vm.runInContext(source('stream'), context);
  return {
    window, document, context, natives, errors, tick, timers,
    connect: () => new window.EventSource('/events'),
    visible(value) { document.visibilityState = value; document.dispatchEvent({ type: 'visibilitychange' }); },
  };
}

test('early state/activity snapshots update before dispatch and reset clears both before dispatch', () => {
  const b = browser();
  b.connect();
  const es = b.natives[0];
  const update = { session: 'a', state: 'working', harness: 'codex', at: 1 };
  const entry = { id: 'e1', session: 'a', at: 1 };
  es.emit('message', update, 'state-1');
  es.emit('activity', entry, 'activity-1');
  assert.deepEqual(plain(b.window.dotpalsStream.snapshot()), { states: [update], activity: [entry] });
  const seen = [];
  b.window.addEventListener('dotpals:state', () => seen.push(plain(b.window.dotpalsStream.snapshot().states)));
  es.emit('message', { ...update, state: 'waiting', at: 2 });
  assert.equal(seen[0][0].state, 'waiting');
  b.window.addEventListener('dotpals:activity', () => seen.push(plain(b.window.dotpalsStream.snapshot().activity)));
  es.emit('activity', { ...entry, at: 2 });
  assert.equal(seen[1][0].at, 2);
  b.window.addEventListener('dotpals:reset', () => seen.push(plain(b.window.dotpalsStream.snapshot())));
  es.emit('reset', {});
  assert.deepEqual(seen[2], { states: [], activity: [] });
  assert.deepEqual(plain(b.window.dotpalsStream.snapshot()), { states: [], activity: [] });
  assert.equal(b.window.dotpalsStream.lastId(), 'activity-1');
});

test('snapshots remove sleeping sessions, ignore invalid keys, and return fresh arrays', () => {
  const b = browser(); b.connect();
  const es = b.natives[0];
  es.emit('message', { session: 'a', state: 'working' });
  es.emit('message', { session: 'b', state: 'thinking' });
  es.emit('message', { session: 'a', state: 'sleeping' });
  for (const update of [null, {}, { session: '' }, { session: 3 }]) es.emit('message', update);
  for (const entry of [null, {}]) es.emit('activity', entry);
  const snap = b.window.dotpalsStream.snapshot();
  assert.deepEqual(plain(snap), { states: [{ session: 'b', state: 'thinking' }], activity: [] });
  snap.states.length = 0;
  assert.equal(b.window.dotpalsStream.snapshot().states.length, 1);
});

test('activity snapshots deduplicate and retain the newest 120 entries per session, by time', () => {
  const b = browser(); b.connect();
  const es = b.natives[0];
  for (let i = 130; i >= 0; i--) es.emit('activity', { id: `a${i}`, session: 'a', at: i });
  es.emit('activity', { id: 'other', session: 'b', at: 0 });
  es.emit('activity', { id: 'a130', session: 'a', at: 140 });
  const entries = plain(b.window.dotpalsStream.snapshot().activity);
  assert.equal(entries.length, 121);
  assert.equal(Math.min(...entries.filter((e) => e.session === 'a').map((e) => e.at)), 11);
  assert.equal(entries.find((e) => e.id === 'a130').at, 140);
  assert.ok(entries.some((e) => e.id === 'other'));
});

test('open/error property handlers and registered listeners each fire exactly once', () => {
  const b = browser(), es = b.connect(), counts = { open: 0, error: 0, onopen: 0, onerror: 0 };
  const onOpen = function () { assert.equal(this, es); counts.open++; };
  const onError = function () { assert.equal(this, es); counts.error++; };
  es.onopen = () => counts.onopen++;
  es.onerror = () => counts.onerror++;
  es.addEventListener('open', onOpen); es.addEventListener('open', onOpen);
  es.addEventListener('error', onError); es.addEventListener('error', onError);
  b.natives[0].readyState = 1; b.natives[0].emit('open');
  b.natives[0].emit('error');
  b.natives[0].fail();
  assert.deepEqual(counts, { open: 1, error: 2, onopen: 1, onerror: 2 });
  assert.equal(b.natives[0].listeners.has('open'), false);
  assert.equal(b.natives[0].listeners.has('error'), false);
  es.removeEventListener('open', onOpen); es.removeEventListener('error', onError);
  b.tick(2000); b.natives[1].emit('open'); b.natives[1].fail();
  assert.deepEqual(counts, { open: 1, error: 2, onopen: 2, onerror: 3 });
});

test('hiding cancels queued retries, background wake cannot reconnect, and resume replays since last id', () => {
  const b = browser(); b.connect();
  b.natives[0].emit('message', { session: 'a', state: 'working' }, 'last id');
  // Reach a retry longer than the 15-second background grace.
  for (const delay of [2000, 4000, 8000]) { b.natives.at(-1).fail(); b.tick(delay); }
  b.natives.at(-1).fail();
  assert.equal(b.timers.size, 1);
  b.visible('hidden');
  assert.equal(b.timers.size, 1, 'only the grace timer remains; queued retry was cancelled');
  const count = b.natives.length;
  b.tick(120_000);
  b.window.dispatchEvent({ type: 'online' }); b.window.dispatchEvent({ type: 'pageshow' });
  assert.equal(b.natives.length, count);
  assert.equal(b.window.dotpalsStream.state(), 'paused');
  b.visible('visible');
  assert.equal(b.natives.length, count + 1);
  assert.equal(b.natives.at(-1).url, '/events?since=last%20id');
  b.tick(120_000);
  assert.equal(b.natives.length, count + 1, 'old retry cannot open another connection');
});

test('a retry racing visibilitychange still checks the current document visibility', () => {
  const b = browser(); b.connect(); b.natives[0].fail();
  b.document.visibilityState = 'hidden'; // visibility changed, notification has not run yet
  b.tick(2000);
  assert.equal(b.natives.length, 1, 'the queued callback itself must refuse a hidden connection');
  b.visible('visible');
  assert.equal(b.natives.length, 2);
});

test('a hidden page starts paused and a live connection closes only after the 15-second grace', () => {
  const b = browser('hidden'), es = b.connect();
  assert.equal(b.natives.length, 0);
  b.visible('visible');
  assert.equal(b.natives.length, 1);
  b.visible('hidden'); b.tick(14_999);
  assert.equal(b.natives[0].closed, undefined);
  b.visible('visible'); b.tick(1);
  assert.equal(b.natives[0].closed, undefined, 'returning during grace keeps the connection');
  b.visible('hidden'); b.tick(15_000);
  assert.equal(b.natives[0].closed, true);
  b.visible('visible'); assert.equal(b.natives.length, 2);
  es.close(); b.visible('hidden'); b.visible('visible'); b.tick(120_000);
  assert.equal(b.natives.length, 2, 'explicit close stays closed');
});

// Minimal DOM for exercising the actual pals/Talk wiring in the same VM as the stream.
function ui(b, replies = []) {
  class Element {
    constructor(tag) { Object.assign(this, target(), { tag, children: [], dataset: {}, attrs: {}, hidden: false, textContent: '', value: '' }); }
    append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
    prepend(n) { n.parent = this; this.children.unshift(n); }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this); }
    setAttribute(k, v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k]; }
    focus() {}
  }
  const main = new Element('main'), body = new Element('body'); body.append(main);
  const walk = (el) => [el, ...el.children.flatMap(walk)];
  Object.assign(b.document, {
    body, documentElement: new Element('html'), createElement: (tag) => new Element(tag),
    getElementById: (id) => walk(body).find((n) => n.id === id), querySelector: (s) => s === 'main' ? main : null,
  });
  const calls = [];
  Object.assign(b.context, core, { CAST,
    DotPal: { characters: ['blu'] }, harnessName: (s) => s, location: { hash: '' },
    matchMedia: () => ({ matches: false }),
    buildTurns: (list) => [{ text: list.at(-1).text }], simple: (turn) => ({ text: turn.text, warnings: [] }),
    route: (text) => text === 'code' ? 'plan' : 'buddy',
    fetch: async (path, options) => {
      calls.push({ path, options });
      const data = path === '/api/remote/me' ? { control: true } : path === '/api/brain' ? { screen: 'ai', plan: 'ai' } : replies.shift();
      return { ok: true, json: async () => data };
    },
  });
  const load = (name) => vm.runInContext(`(() => { ${source(name).replace(/^import .*;\r?$/gm, '').replace(/export function /g, 'function ')} })()`, b.context);
  return { load, calls, all: () => walk(body), find: (cls) => walk(body).find((n) => n.className === cls) };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('late pals/Talk hydrate synchronously, reset repaints both, and Talk stays reachable without sessions', async () => {
  const b = browser(); b.connect();
  const es = b.natives[0];
  es.emit('message', { session: 'a', harness: 'codex', state: 'working', at: Date.now() });
  es.emit('activity', { id: 'e1', session: 'a', at: 1, text: 'Early story' });
  const dom = ui(b); dom.load('pals'); dom.load('talk');
  assert.equal(b.window.dotpalsPals.sessions().length, 1, 'hydrated before any timer or promise');
  b.document.getElementById('rc-talk-btn').onclick();
  assert.equal(dom.find('rc-story-text').textContent, 'Early story');
  es.emit('reset', {});
  assert.equal(b.window.dotpalsPals.sessions().length, 0);
  assert.equal(dom.find('rc-story-text').textContent, 'No agents are running right now.');
  assert.equal(b.document.getElementById('rc-tray').hidden, false);
  assert.equal(dom.find('rc-pals').children.length, 0);
  es.emit('message', { session: 'a', harness: 'codex', state: 'working' });
  assert.notEqual(dom.find('rc-story-text').textContent, 'Early story', 'reset discarded old activity');
  await flush();
});

test('Talk never promises unexecuted desktop actions/connectors; coding plans still require Start', async () => {
  const b = browser();
  const replies = [
    { say: 'Done.', do: [{ act: 'open' }], words: ['Open app'] },
    { say: 'Checking calendar.', apps: { app: 'Calendar', ask: 'Today?' } },
    { say: 'I will handle it.', task: 'Click through the website' },
    { say: 'Plain answer', do: [], apps: null, task: '' },
    { plan: { id: 'plan1', title: 'Fix tests', task: 'Code', done: [] } },
    {},
  ];
  const dom = ui(b, replies); dom.load('pals'); dom.load('talk');
  b.document.getElementById('rc-talk-btn').onclick(); await flush();
  for (let i = 0; i < 4; i++) {
    dom.find('rc-ask').onsubmit({ preventDefault() {} }); // empty input is ignored
    dom.all().find((n) => n.tag === 'textarea').value = 'hello';
    dom.find('rc-ask').onsubmit({ preventDefault() {} }); await flush();
    const say = dom.find('rc-say').textContent;
    if (i < 3) { assert.match(say, /desktop actions.*connectors.*unavailable.*remote/i); assert.match(say, /desktop/i); assert.doesNotMatch(say, /Blu will|Done\.|Checking calendar/); }
    else assert.equal(say, 'Plain answer');
  }
  dom.all().find((n) => n.tag === 'textarea').value = 'code';
  dom.find('rc-ask').onsubmit({ preventDefault() {} }); await flush();
  assert.equal(dom.calls.filter((c) => c.path === '/api/talk/start').length, 0);
  await dom.all().find((n) => n.textContent === 'Start').onclick();
  const starts = dom.calls.filter((c) => c.path === '/api/talk/start');
  assert.equal(starts.length, 1);
  assert.deepEqual(JSON.parse(starts[0].options.body), { id: 'plan1' });
});
