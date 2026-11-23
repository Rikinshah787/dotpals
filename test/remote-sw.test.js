// The service worker's push handler, run in a sandbox with a fake worker scope: no browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { WORKER_BUILD } from '../bridge/remote/push-words.js';

const source = readFileSync(new URL('../bridge/remote/sw.js', import.meta.url), 'utf8').replace('__VERSION__', 't');

/** Load sw.js against a fake scope. `clients`: the windows the page has open, by visibility. `failShow`: showNotification throws. */
function worker(clients, { failShow = '', offline = false, previous = null, failCache = '', ackFetch } = {}) {
  const skipped = []; // skipWaiting() calls
  const added = []; // requests the install cached: { url, cache }
  const opened = []; // names of the caches it opened
  const shown = [];
  const acks = []; // what the worker told the computer: POST /api/remote/me/ack
  const stored = new Map(); // the phone's own record (Cache Storage 'dotpals-push-log'): what the page reads back
  const handlers = {};
  const self = {
    location: { origin: 'https://x' },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    registration: { showNotification: async (title, o) => { if (failShow) throw new Error(failShow); shown.push({ title, ...o }); } },
    clients: { matchAll: async () => clients.map((v) => ({ visibilityState: v, url: 'https://x/' })), claim: async () => {}, openWindow: async () => {} },
    skipWaiting: async () => { skipped.push(1); },
  };
  class Res { constructor(body) { this.body = body; } json() { return Promise.resolve(JSON.parse(this.body)); } }
  class Req { constructor(url, init = {}) { this.url = url; this.cache = init.cache; } }
  // The phone's own log (what the previous worker left): '/__worker' answers with `previous`; everything else with what was stored.
  const cache = { addAll: async () => {}, add: async (r) => { if (r.url === failCache) throw new Error('download failed'); added.push(r); }, put: async (key, res) => { stored.set(key, JSON.parse(res.body)); },
    match: async (key) => (key === '/__worker' && previous ? new Res(JSON.stringify(previous)) : stored.has(key) ? new Res(JSON.stringify(stored.get(key))) : null) };
  vm.runInNewContext(source, { self, caches: { open: async (n) => { opened.push(n); return cache; }, keys: async () => [], delete: async () => {} }, URL, Request: Req, Response: Res, Promise, String, Number, JSON, Date, setTimeout, clearTimeout,
    fetch: async (url, init) => { if (offline) throw new TypeError('Failed to fetch'); acks.push({ url, init, body: JSON.parse(init.body) }); return ackFetch ? ackFetch(init) : { status: 200 }; } });
  const push = async (note) => {
    const waits = [];
    handlers.push({ data: { json: () => note, text: () => '' }, waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  const ask = (type) => new Promise((ok) => handlers.message({ data: { type }, ports: [{ postMessage: ok }] }));
  return { shown, push, acks, ask, stored, skipped, added, opened, activate: (e) => handlers.activate(e), install: (e) => handlers.install(e), message: (e) => handlers.message(e) };
}

test('a push shows a notification when the app is closed or in the background', async () => {
  for (const clients of [[], ['hidden'], ['hidden', 'hidden']]) {
    const w = worker(clients);
    await w.push({ kind: 'done', title: 'Claude is done', body: 'x', tag: 'done-1' });
    assert.equal(w.shown.length, 1, JSON.stringify(clients));
    assert.equal(w.shown[0].title, 'Claude is done');
    assert.equal(w.shown[0].tag, 'done-1');
  }
});

test('turning quietWhenOpen off permits real notifications while visible', async () => {
  const w = worker(['visible']);
  await w.push({ kind: 'done', title: 'x', quietWhenOpen: false });
  assert.equal(w.shown.length, 1);
});

test('with the app open in front, a real notification is held back (it shows live), but a test and a permission prompt are not', async () => {
  const front = worker(['visible']);
  await front.push({ kind: 'done', title: 'Claude is done', tag: 'done-1' });
  assert.equal(front.shown.length, 0, 'already on screen');
  await front.push({ kind: 'done', title: 'dotpals', body: 'Notifications are working on this device.', tag: 'test', test: true });
  assert.equal(front.shown.length, 1, 'a test pressed in the open app must still show');
  assert.equal(front.shown[0].tag, 'test');
  await front.push({ kind: 'approval', title: 'Claude wants to run a command', tag: 'ask-1' });
  assert.equal(front.shown.length, 2, 'a permission prompt always shows');
  assert.equal(front.shown[1].requireInteraction, true);
});

test('the phone tells the computer a push ARRIVED, and whether it was shown (the push service only says it accepted it)', async () => {
  const w = worker(['hidden']);
  await w.push({ kind: 'done', title: 'x', tag: 'test', at: 1234, test: true });
  assert.equal(w.acks.length, 1);
  assert.equal(w.acks[0].url, '/api/remote/me/ack');
  assert.equal(w.acks[0].init.method, 'POST');
  assert.equal(w.acks[0].init.headers['x-dotpals'], '1');
  assert.deepEqual(w.acks[0].body, { sentAt: 1234, shown: true, held: false, error: '', tag: 'test' });
});

test('an ack says "held" when the app was open in front, and says why when the notification could not be shown', async () => {
  const front = worker(['visible']);
  await front.push({ kind: 'done', title: 'x', tag: 'done-1', at: 5 });
  assert.equal(front.shown.length, 0);
  assert.deepEqual({ shown: front.acks[0].body.shown, held: front.acks[0].body.held }, { shown: false, held: true });

  // The browser refuses (notifications blocked for the site, the app's channel switched off): that is not a silent success.
  const blocked = worker([], { failShow: 'No notification permission has been granted for this origin.' });
  await blocked.push({ kind: 'done', title: 'x', tag: 't', at: 9 });
  assert.equal(blocked.shown.length, 0);
  assert.equal(blocked.acks.length, 1, 'the push is still acknowledged: it ARRIVED');
  assert.equal(blocked.acks[0].body.shown, false);
  assert.match(blocked.acks[0].body.error, /No notification permission/);
});

test('the page can ask which version of the worker the phone is really running, and which build of its behaviour', async () => {
  const v = await worker([]).ask('version'); // (an object from the worker's own context: compare the fields)
  assert.equal(v.version, 't');
  assert.equal(v.build, WORKER_BUILD, 'the page and the worker agree which build is current');
});

test('when this copy of the worker took over is kept on the phone, so "no push yet" can be told from "no record yet"', async () => {
  const w = worker([]);
  const waits = [];
  w.activate({ waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  const started = w.stored.get('/__worker');
  assert.equal(started.build, WORKER_BUILD);
  assert.equal(started.version, 't');
  assert.ok(Math.abs(started.at - Date.now()) < 5000, 'when it started');
});

test('the phone keeps its own record of the push it got, even when it cannot reach the computer', async () => {
  const w = worker([], { offline: true });
  await w.push({ kind: 'done', title: 'x', tag: 'test', at: 777, test: true });
  const rec = w.stored.get('/__last-push');
  assert.equal(rec.sentAt, 777, 'which push it was');
  assert.equal(rec.phase, 'done');
  assert.equal(rec.shown, true, 'it was shown');
  assert.equal(rec.ackStatus, 0, 'but the computer could not be told');
  assert.equal(w.acks.length, 0);
  assert.equal(w.shown.length, 1, 'being offline never stops the notification');

  const ok = worker([]);
  await ok.push({ kind: 'done', title: 'x', tag: 'test', at: 5, test: true });
  assert.equal(ok.stored.get('/__last-push').ackStatus, 200);
});

test('an older push finishing its ack cannot overwrite the latest phone-local record', async () => {
  let release;
  const started = [];
  const w = worker([], { ackFetch: async (init) => {
    const at = JSON.parse(init.body).sentAt;
    started.push(at);
    if (at === 1) await new Promise((r) => { release = r; });
    return { status: 200 };
  } });
  const first = w.push({ at: 1, test: true });
  while (!release) await new Promise((r) => setTimeout(r, 1));
  await w.push({ at: 2, test: true });
  release();
  await first;
  assert.deepEqual(started, [1, 2]);
  assert.equal(w.stored.get('/__last-push').sentAt, 2);
});

test('the record is written the moment the push arrives, before anything that can fail', async () => {
  // showNotification throws and the ack cannot be sent: the phone still has a record that a push arrived and why it wasn't shown.
  const w = worker([], { failShow: 'Notifications are blocked', offline: true });
  await w.push({ kind: 'done', title: 'x', tag: 't', at: 9 });
  const rec = w.stored.get('/__last-push');
  assert.equal(rec.phase, 'done');
  assert.equal(rec.shown, false);
  assert.match(rec.error, /blocked/);
  // And one that is not JSON at all is still recorded (as unreadable), not lost.
  const raw = worker([]);
  await raw.push(null);
  assert.ok(raw.stored.get('/__last-push'), 'a push with no readable payload still leaves a record');
});

test('an update WAITS for the person: a worker that has the Update button is not told to take over by itself', async () => {
  // Replacing a worker new enough to have the button: wait (no skipWaiting). Replacing an older one (no button), or the first install: take over.
  for (const [previous, expected] of [[null, true], [{ build: 4 }, true], [{ build: WORKER_BUILD }, false]]) {
    const w = worker([], { previous });
    const waits = [];
    w.install({ waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    assert.equal(w.skipped.length > 0, expected, `previous ${JSON.stringify(previous)}`);
  }
});

test('Update is the only thing that makes a waiting worker take over', async () => {
  const w = worker([]);
  w.message({ data: { type: 'version' }, ports: [{ postMessage() {} }] });
  assert.equal(w.skipped.length, 0, 'asking the version is not an update');
  w.message({ data: { type: 'SKIP_WAITING' } });
  assert.equal(w.skipped.length, 1);
  w.message({ data: { type: 'anything else' } });
  assert.equal(w.skipped.length, 1);
});

test('the app files are fetched fresh from the computer when a worker installs, into a cache of its own build', async () => {
  const w = worker([]);
  const waits = [];
  w.install({ waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.ok(w.added.length > 10);
  assert.ok(w.added.every((r) => r.cache === 'reload'), 'never from the browser’s own HTTP cache');
  assert.ok(w.added.some((r) => r.url === '/bridge/remote/updater.js') && w.added.some((r) => r.url === '/bridge/remote/update-ui.js'));
  assert.match(w.opened.find((n) => n.startsWith('dotpals-shell-')), new RegExp(`-b${WORKER_BUILD}$`), 'a new build gets a fresh cache');
});

test('a failed shell download prevents activation of an incomplete update', async () => {
  const w = worker([], { failCache: '/src/index.js', previous: { build: WORKER_BUILD } });
  let install;
  w.install({ waitUntil: (p) => { install = p; } });
  await assert.rejects(install, /download failed/);
  assert.equal(w.skipped.length, 0);
});

test('the offline shell contains every transitive dashboard and remote module import', async () => {
  const w = worker([]);
  let install;
  w.install({ waitUntil: (p) => { install = p; } });
  await install;
  const paths = new Set(w.added.map((r) => r.url));
  const visited = new Set();
  const visit = (path) => {
    if (visited.has(path)) return;
    visited.add(path);
    const text = readFileSync(new URL(`..${path}`, import.meta.url), 'utf8');
    const imports = /(?:\b(?:import|export)\s+(?:[^;'"\n]+?\s+from\s+)?|\bimport\s*\()\s*['"]([^'"]+)['"]|<script[^>]+src=['"]([^'"]+)['"]/g;
    for (const m of text.matchAll(imports)) {
      const spec = m[1] || m[2];
      if (!spec.startsWith('/') && !spec.startsWith('.')) continue;
      const next = new URL(spec, `https://x${path}`).pathname;
      if (!next.endsWith('.js')) continue;
      assert.ok(paths.has(next), `${next} imported by ${path} must be precached`);
      visit(next);
    }
  };
  visit('/bridge/dashboard.html');
  visit('/bridge/remote/client.js');
});

test('a test notification stays up and replaces nothing, so a second test is not swallowed by the first', async () => {
  const w = worker(['hidden']);
  await w.push({ kind: 'done', title: 'dotpals', tag: 'test-a', at: 1, test: true });
  await w.push({ kind: 'done', title: 'dotpals', tag: 'test-b', at: 2, test: true });
  assert.equal(w.shown.length, 2);
  assert.notEqual(w.shown[0].tag, w.shown[1].tag);
  assert.equal(w.shown[1].renotify, true, 'it still alerts if one is showing');
  assert.equal(w.shown[1].requireInteraction, true, 'stays until swiped away');
  // An ordinary "done" is not sticky.
  await w.push({ kind: 'done', title: 'Claude is done', tag: 'done-1', at: 3 });
  assert.equal(w.shown[2].requireInteraction, false);
  assert.equal(w.shown[2].renotify, false);
});

test('what is shown is bounded and the click target stays on this site', async () => {
  const w = worker([]);
  await w.push({ kind: 'done', title: 'T'.repeat(300), body: 'B'.repeat(900), tag: 't', url: 'https://evil.example/x' });
  assert.equal(w.shown[0].title.length, 80);
  assert.equal(w.shown[0].body.length, 200);
  assert.equal(w.shown[0].data.url, '/', 'an absolute URL from a push is ignored');
  for (const url of ['//evil.example/x', '/\\evil.example/x']) {
    await w.push({ kind: 'done', title: 'ok', url });
    assert.equal(w.shown.at(-1).data.url, '/');
  }
  await w.push({ kind: 'done', title: 'ok', url: '/#sessions' });
  assert.equal(w.shown.at(-1).data.url, '/#sessions');
});
