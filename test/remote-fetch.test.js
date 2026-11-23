import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../bridge/remote/sw.js', import.meta.url), 'utf8');
function rig({ hit = null, fetcher = async () => new Response('network') , put = async () => {} } = {}) {
  const handlers = {};
  let requests = 0;
  const cache = { match: async () => hit?.clone(), put };
  vm.runInNewContext(source, {
    self: { location: { origin: 'https://app.test' }, addEventListener: (name, fn) => { handlers[name] = fn; } },
    caches: { open: async () => cache }, URL, Response, Request, setTimeout, clearTimeout,
    fetch: (...args) => { requests++; return fetcher(...args); },
  });
  const get = async (path) => {
    let response;
    const waits = [];
    handlers.fetch({ request: new Request(`https://app.test${path}`), respondWith: (p) => { response = p; }, waitUntil: (p) => waits.push(p) });
    return { response: await response, settled: () => Promise.all(waits) };
  };
  return { get, requests: () => requests };
}

test('an installed shell stays coherent while a new version waits', async () => {
  const r = rig({ hit: new Response('installed build'), fetcher: async () => new Response('unapplied build') });
  const { response } = await r.get('/bridge/remote/client.js');
  assert.equal(await response.text(), 'installed build');
  assert.equal(r.requests(), 0);
});

test('API and event responses never enter the shell cache handler', async () => {
  const r = rig();
  for (const path of ['/api/remote/me', '/events', '/pair']) assert.equal((await r.get(path)).response, undefined);
  assert.equal(r.requests(), 0);
});

test('missing offline modules return 503, never dashboard HTML', async () => {
  const r = rig({ fetcher: async () => { throw new Error('offline'); } });
  const { response, settled } = await r.get('/src/not-cached.js');
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'Offline');
  await settled();
});

test('transient server errors fall back to a cached non-shell asset', async () => {
  const r = rig({ hit: new Response('saved icon'), fetcher: async () => new Response('gateway unavailable', { status: 503 }) });
  const { response, settled } = await r.get('/bridge/remote/icons/icon-96.png');
  assert.equal(await response.text(), 'saved icon');
  await settled();
});

test('blocked cache writes never fail an online request', async () => {
  const r = rig({ put: async () => { throw new Error('quota'); } });
  const { response, settled } = await r.get('/bridge/remote/icons/icon-96.png');
  assert.equal(await response.text(), 'network');
  await settled();
});
