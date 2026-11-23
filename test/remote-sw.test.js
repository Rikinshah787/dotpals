// The service worker's push handler, run in a sandbox with a fake worker scope: no browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const WORKER_BUILD = 7;

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
  const manifest = JSON.parse(readFileSync(new URL('../bridge/remote/manifest.webmanifest', import.meta.url), 'utf8'));
  for (const path of [...manifest.icons.map((icon) => icon.src), '/bridge/remote/icons/icon-180.png']) {
    assert.ok(w.added.some((r) => r.url === path), `${path} must be available offline`);
  }
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
