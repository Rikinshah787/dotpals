import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { createHub, keyOf } from '../bridge/remote-hub.js';

/** A response that records what it's sent; `req` closes it like a browser leaving. */
function fake() {
  const chunks = [];
  const req = new EventEmitter();
  const res = new EventEmitter();
  Object.assign(res, {
    head: null, ended: false, writableLength: 0,
    writeHead(status, headers) { res.head = { status, headers }; },
    write(c) { chunks.push(Buffer.from(c)); return true; },
    end(c) { if (c) chunks.push(Buffer.from(c)); res.ended = true; },
  });
  const text = () => Buffer.concat(chunks).toString('utf8');
  const events = () => [...text().matchAll(/(?:id: (\S+)\n)?(?:event: (\w+)\n)?data: (.*)\n\n/g)].map((m) => ({ id: m[1], event: m[2] ?? 'message', data: JSON.parse(m[3]) }));
  return { req, res, text, events, chunks };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = (emit) => { emit('config', { sounds: true }); emit('activity', { id: 'old', at: 1 }); };

test('events about the same thing are keyed so the newest wins', () => {
  assert.equal(keyOf('activity', { id: 'x' }), 'a:x');
  assert.equal(keyOf(null, { session: 's' }), 'm:s');
  assert.equal(keyOf('context', { session: 's' }), 'c:s');
  assert.equal(keyOf('config', {}), 'config');
  assert.equal(keyOf('stuck', { id: 'q' }), null);
});

test('a new device gets everything in one write, then ready', () => {
  const hub = createHub();
  const f = fake();
  hub.join(f.req, f.res, { snapshot: snap });
  assert.equal(f.res.head.status, 200);
  assert.equal(f.res.head.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(f.chunks.length, 1);
  assert.deepEqual(f.events().map((e) => e.event), ['config', 'activity', 'ready']);
  assert.equal(f.events().at(-1).data.resumed, false);
  f.req.emit('close');
  assert.equal(hub.size(), 0);
});

test('a burst of changes to one entry is sent once, in one write', async () => {
  const hub = createHub({ flushMs: 10 });
  const f = fake();
  hub.join(f.req, f.res, { snapshot: snap });
  const before = f.chunks.length;
  for (let i = 1; i <= 10; i++) hub.publish('activity', { id: 'a', step: i });
  hub.publish('activity', { id: 'b', step: 1 });
  hub.publish('stuck', { id: 's1' });
  hub.publish('stuck', { id: 's2' });
  await wait(40);
  assert.equal(f.chunks.length, before + 1);
  assert.deepEqual(f.events().slice(3).map((e) => e.data.step ?? e.data.id), [10, 1, 's1', 's2']);
  f.req.emit('close');
});

test('a device that comes back gets only what it missed', async () => {
  const hub = createHub({ flushMs: 5 });
  const a = fake();
  hub.join(a.req, a.res, { snapshot: snap });
  hub.publish('activity', { id: 'x', v: 1 });
  await wait(20);
  const lastId = a.events().at(-1).id;
  a.req.emit('close');
  hub.publish('activity', { id: 'x', v: 2 });
  hub.publish('activity', { id: 'y', v: 1 });
  hub.publish('config', { sounds: false });
  const b = fake();
  hub.join(b.req, b.res, { snapshot: () => assert.fail('no snapshot on resume'), since: lastId });
  const got = b.events();
  assert.deepEqual(got.map((e) => e.event), ['activity', 'activity', 'config', 'ready']);
  assert.equal(got.at(-1).data.resumed, true);
  assert.equal(got[0].data.v, 2);
  b.req.emit('close');
});

test('a stale or foreign position starts clean; a reset forgets the past', () => {
  const hub = createHub();
  hub.publish('activity', { id: 'x' });
  const a = fake();
  hub.join(a.req, a.res, { snapshot: snap, since: 'ffffff.3' });
  assert.deepEqual(a.events().map((e) => e.event), ['reset', 'config', 'activity', 'ready']);
  a.req.emit('close');
  const idNow = `${hub.epoch()}.${hub.seq()}`;
  hub.publish('reset', {});
  assert.equal(hub.remembered(), 0);
  const b = fake();
  hub.join(b.req, b.res, { snapshot: snap, since: idNow });
  assert.equal(b.events().at(-1).data.resumed, false);
  b.req.emit('close');
});

test('the memory is bounded: old changes fall out and force a fresh start', () => {
  const hub = createHub({ keep: 5 });
  hub.publish('activity', { id: 'first' });
  const earlyId = `${hub.epoch()}.${hub.seq()}`;
  for (let i = 0; i < 20; i++) hub.publish('activity', { id: `n${i}` });
  assert.equal(hub.remembered(), 5);
  const f = fake();
  hub.join(f.req, f.res, { snapshot: snap, since: earlyId });
  assert.equal(f.events().at(-1).data.resumed, false);
  f.req.emit('close');
});

test('a device that cannot keep up is dropped; signing out drops its streams', async () => {
  const hub = createHub({ maxBuffered: 100, flushMs: 1 });
  const slow = fake();
  hub.join(slow.req, slow.res, { snapshot: snap, deviceId: 'd1' });
  assert.equal(hub.open('d1'), true);
  slow.res.writableLength = 500;
  hub.publish('activity', { id: 'x' });
  await wait(20);
  assert.equal(slow.res.ended, true);
  assert.equal(hub.size(), 0);
  const f = fake();
  hub.join(f.req, f.res, { snapshot: snap, deviceId: 'd2' });
  hub.drop('d2');
  assert.equal(f.res.ended, true);
  assert.equal(hub.open('d2'), false);
});

test('compressed streams are valid gzip and flush each batch', async () => {
  const hub = createHub({ flushMs: 5 });
  const f = fake();
  hub.join(f.req, f.res, { snapshot: snap, compress: true });
  assert.equal(f.res.head.headers['content-encoding'], 'gzip');
  hub.publish('activity', { id: 'z', big: 'x'.repeat(2000) });
  await wait(40);
  f.req.emit('close');
  await wait(20);
  const raw = Buffer.concat(f.chunks);
  const text = gunzipSync(raw).toString();
  assert.match(text, /event: ready/);
  assert.match(text, /"id":"z"/);
  assert.ok(raw.length < text.length);
});

test('no timers run with nobody connected', async () => {
  const hub = createHub({ beatMs: 5 });
  const f = fake();
  hub.join(f.req, f.res, { snapshot: snap });
  f.req.emit('close');
  assert.equal(hub.size(), 0);
  hub.publish('activity', { id: 'x' });
  await wait(15);
  assert.equal(f.text().includes(': ping'), false);
});
