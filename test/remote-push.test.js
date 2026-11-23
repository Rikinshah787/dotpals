import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPusher, pushFor } from '../bridge/remote-push.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('what becomes a notification', () => {
  const turn = () => ({ ms: 60_000, prompt: 'fix the login bug' });
  assert.deepEqual(pushFor('message', { state: 'done', session: 's', harness: 'claude', label: 'shop' }, { turn }),
    { kind: 'done', title: 'Claude is done · shop', body: '“fix the login bug”', tag: 'done-s' });
  assert.equal(pushFor('message', { state: 'done', session: 's' }, { turn: () => ({ ms: 2000 }) }), null); // too quick to matter
  assert.equal(pushFor('message', { state: 'done', session: 's' }), null);
  assert.equal(pushFor('message', { state: 'working', session: 's' }), null);
  const waiting = pushFor(null, { state: 'waiting', session: 's', harness: 'codex', text: 'Run tests?' });
  assert.equal(waiting.kind, 'waiting');
  assert.equal(waiting.delay, 20_000);
  assert.equal(pushFor('approval', { status: 'expired', id: 'x' }), null);
  assert.equal(pushFor('approval', { status: 'pending', id: 'abcdefgh', harness: 'claude', kind: 'run', command: 'npm install' }).title, 'Claude wants to run a command');
  assert.equal(pushFor('stuck', { session: 's', text: 'same error 3 times' }).kind, 'stuck');
  assert.equal(pushFor('loop', { kind: 'told', text: 'x' }), null);
  assert.equal(pushFor('loop', { kind: 'gave-up', text: 'x' }).kind, 'loop');
  assert.equal(pushFor('context', { known: true, used: 50, size: 100 }), null);
  assert.equal(pushFor('context', { known: true, used: 95, size: 100, session: 's' }).kind, 'context');
  assert.equal(pushFor('activity', { id: 'x' }), null);
  assert.equal(pushFor('stuck', null), null);
});

test('secrets are redacted from what leaves the computer', () => {
  const item = pushFor('approval', { status: 'pending', id: 'abcdefgh', kind: 'run', command: 'curl -H "Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" https://x.io' });
  assert.ok(!item.body.includes('abcdefghijklmnopqrstuvwxyz0123456789'), item.body);
});

function rig(devices, opts = {}) {
  const sent = [];
  const updates = [];
  let clock = 1_000_000;
  const open = new Set(opts.open ?? []);
  const remote = { pushTargets: () => devices, forgetSubscription: (id, sub) => { updates.push([id, sub]); return true; } };
  const hub = { open: (id) => open.has(id) };
  const send = async (sub, body, vapid, o) => { sent.push({ sub, body: JSON.parse(body), o }); return opts.result ?? { ok: true, status: 201, gone: false }; };
  const pusher = createPusher({ remote, hub, send, vapid: () => ({}), subject: 'mailto:a@b.co', turn: () => ({ ms: 60_000, prompt: 'p' }), now: () => clock });
  return { sent, updates, pusher, tick: (ms) => { clock += ms; } };
}
const dev = (id, over = {}) => ({ id, sub: { endpoint: `https://p/${id}` }, control: true, prefs: { done: true, waiting: true, approval: true, stuck: true, conflict: true, loop: true, context: false, quietWhenOpen: true, ...over } });

test('each device gets what its own preferences allow, and not while it has the app open', async () => {
  const r = rig([dev('a'), dev('b', { done: false }), dev('c')], { open: ['c'] });
  r.pusher.handle('message', { state: 'done', session: 's', harness: 'claude' });
  await wait(10);
  assert.deepEqual(r.sent.map((s) => s.sub.endpoint), ['https://p/a']);
  assert.equal(r.sent[0].o.urgency, 'normal');
  assert.equal(r.sent[0].body.test, false, 'a real notification is not a test');
});

test('an approval only reaches a device that is allowed to answer it, and is urgent and short-lived', async () => {
  const r = rig([dev('a', {}), { ...dev('b'), control: false }]);
  r.pusher.handle('approval', { status: 'pending', id: 'abcdefgh', kind: 'run', command: 'ls' });
  await wait(10);
  assert.deepEqual(r.sent.map((s) => s.sub.endpoint), ['https://p/a']);
  assert.equal(r.sent[0].o.urgency, 'high');
  assert.equal(r.sent[0].o.ttl, 120);
});

test('the same thing is not sent twice in 10 seconds, and a device gets at most 20 a minute', async () => {
  const r = rig([dev('a')]);
  r.pusher.handle('stuck', { session: 's', text: 'x' });
  r.pusher.handle('stuck', { session: 's', text: 'x' });
  await wait(10);
  assert.equal(r.sent.length, 1);
  for (let i = 0; i < 30; i++) r.pusher.handle('stuck', { session: `s${i}`, text: 'x' });
  await wait(30);
  assert.equal(r.sent.length, 20);
});

test('waiting is sent only if still waiting after 20 s; a new state cancels it; a dead subscription is forgotten', async () => {
  const r = rig([dev('a')], { result: { ok: false, status: 410, gone: true } });
  r.pusher.handle('message', { state: 'waiting', session: 's' });
  r.pusher.handle('message', { state: 'working', session: 's' });
  r.pusher.stop();
  await wait(10);
  assert.equal(r.sent.length, 0);
  r.pusher.handle('stuck', { session: 's', text: 'x' });
  await wait(10);
  assert.deepEqual(r.updates, [['a', { endpoint: 'https://p/a' }]]);
});

test('with no device subscribed, nothing is sent and no timers are started', async () => {
  const r = rig([]);
  r.pusher.handle('message', { state: 'waiting', session: 's' });
  r.pusher.handle('message', { state: 'done', session: 's' });
  await wait(5);
  assert.equal(r.sent.length, 0);
});

test('each test has a tag of its own, which is also a valid Topic (letters, digits, - and _ only)', async () => {
  const r = rig([dev('a')]);
  await r.pusher.test('a');
  r.tick(1000);
  await r.pusher.test('a');
  const [one, two] = r.sent.map((s) => s.body.tag);
  assert.notEqual(one, two, 'the same tag would make Android replace the first one silently');
  assert.match(one, /^test-[a-z0-9]+$/);
  assert.match(r.sent[0].o.topic, /^test-[a-z0-9]+$/);
});

test('a test requests high urgency without changing ordinary notifications', async () => {
  const r = rig([dev('a')]);
  await r.pusher.test('a');
  assert.equal(r.sent[0].o.urgency, 'high');
  r.pusher.handle('message', { state: 'done', session: 's2', harness: 'claude' });
  await wait(10);
  assert.equal(r.sent.at(-1).o.urgency, 'normal', 'an ordinary "done" stays normal');
});

test('context labels are redacted at the send boundary even with quiet mode off', async () => {
  const r = rig([dev('a', { context: true, quietWhenOpen: false })], { open: ['a'] });
  r.pusher.handle('context', { session: 'x', known: true, used: 95, size: 100, label: 'token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' });
  await wait(10);
  assert.equal(r.sent.length, 1);
  assert.ok(!r.sent[0].body.body.includes('abcdefghijklmnopqrstuvwxyz0123456789'));
});

test('an in-flight send cannot authorize a later send to a device that signed out', async () => {
  const devices = [dev('a'), dev('b')];
  const calls = [];
  let release;
  const first = new Promise((resolve) => { release = resolve; });
  const pusher = createPusher({ remote: { pushTargets: () => [...devices] }, hub: { open: () => false }, vapid: () => ({}), turn: () => ({ ms: 60_000 }), send: async (sub) => { calls.push(sub.endpoint); return first; } });
  pusher.handle('message', { state: 'done', session: 'a' });
  assert.deepEqual(calls, ['https://p/a']);
  devices.pop();
  release({ ok: true });
  await wait(10);
  assert.deepEqual(calls, ['https://p/a']);
});

test('revoking a device forgets its diagnostics', async () => {
  const r = rig([dev('a')]);
  await r.pusher.test('a');
  r.pusher.forget('a');
  assert.equal(r.pusher.last('a'), null);
  assert.deepEqual(r.pusher.history('a'), []);
});

test('same-millisecond tests stay distinct and unknown receipts cannot replace known ones', async () => {
  const r = rig([dev('a')]);
  await r.pusher.test('a');
  const first = r.pusher.last('a').at;
  await r.pusher.test('a');
  const second = r.pusher.last('a').at;
  assert.notEqual(first, second);
  assert.notEqual(r.sent[0].body.tag, r.sent[1].body.tag);
  assert.equal(r.pusher.ack('a', { sentAt: second, shown: true }), true);
  assert.equal(r.pusher.ack('a', { sentAt: -1, shown: true }), false);
  assert.equal(r.pusher.ack('a', { sentAt: String(second), shown: true }), false);
  assert.ok(r.pusher.last('a').ack.shown);
  assert.equal(r.pusher.ack('a', { sentAt: first, held: true }), true);
  assert.ok(r.pusher.last('a').ack.shown, 'an older receipt cannot hide the latest receipt');
});

test('receipts can arrive before the push service responds and responses may finish out of order', async () => {
  const pending = [];
  const pusher = createPusher({
    remote: { pushTargets: () => [dev('a')], update() {} }, hub: { open: () => false }, vapid: () => ({}),
    send: (sub, body) => new Promise((resolve) => pending.push({ note: JSON.parse(body), resolve })),
  });
  const one = pusher.test('a');
  const two = pusher.test('a');
  assert.equal(pusher.ack('a', { sentAt: pending[0].note.at, shown: true }), true);
  pending[1].resolve({ ok: true, status: 201 });
  await two;
  pending[0].resolve({ ok: true, status: 201 });
  await one;
  assert.equal(pusher.last('a').at, pending[1].note.at, 'latest means sent latest, not response latest');
  assert.ok(pusher.history('a')[1].ack.shown);
});

test('a late receipt lands on ITS push, so pressing Send a test twice cannot hide whether the first one arrived', async () => {
  const r = rig([dev('a')]);
  await r.pusher.test('a');
  const first = r.pusher.last('a').at;
  r.tick(5000);
  await r.pusher.test('a');
  const second = r.pusher.last('a').at;
  assert.notEqual(first, second);
  // Only the SECOND one's receipt comes back (the first never arrived).
  r.pusher.ack('a', { sentAt: second, shown: true });
  const h = r.pusher.history('a');
  assert.equal(h.length, 2);
  assert.equal(h[0].at, second, 'newest first');
  assert.ok(h[0].ack?.shown, 'the second has its receipt');
  assert.equal(h[1].ack, undefined, 'the first has none: it did not arrive');
  // And if the first one's receipt turns up LATE, it is filed under the first, not mistaken for the latest.
  r.tick(5000);
  r.pusher.ack('a', { sentAt: first, shown: true });
  const again = r.pusher.history('a');
  assert.ok(again[1].ack?.shown, 'the late receipt reached the first push');
  assert.equal(again[0].ack.sentAt, second, 'and the second keeps its own');
  // Bounded.
  for (let i = 0; i < 15; i++) { r.tick(1000); await r.pusher.test('a'); }
  assert.equal(r.pusher.history('a').length, 10);
  assert.deepEqual(r.pusher.history('nobody'), []);
});

test('the phone’s ack is kept for the push it names, and only that one', async () => {
  const r = rig([dev('a')]);
  assert.equal(r.pusher.ack('a', null), false);
  assert.equal(r.pusher.ack('a', 'junk'), false);
  await r.pusher.test('a');
  const at = r.pusher.last('a').at;
  assert.equal(r.pusher.last('a').ack, undefined, 'sent, nothing heard yet: the page says "waiting", then "never arrived"');
  assert.equal(r.pusher.ack('a', { sentAt: at, shown: true, held: false, error: '' }), true);
  assert.deepEqual({ shown: r.pusher.last('a').ack.shown, held: r.pusher.last('a').ack.held }, { shown: true, held: false });
  // An ack for an OLDER push must not make a newer, unacknowledged one look delivered.
  r.tick(5000);
  await r.pusher.test('a');
  assert.equal(r.pusher.last('a').ack, undefined);
  // What a phone may say is bounded: nothing it sends is trusted as anything but a flag and a short note.
  r.pusher.ack('a', { sentAt: r.pusher.last('a').at, shown: 'yes', held: 1, error: 'x'.repeat(500) + '\n\n   y' });
  const a = r.pusher.last('a').ack;
  assert.equal(a.shown, false, 'only a real true counts');
  assert.equal(a.held, false);
  assert.ok(a.error.length <= 80 && !a.error.includes('\n'));
});

test('the test notification goes to one device whatever its preferences', async () => {
  const r = rig([dev('a', { done: false }), dev('b')]);
  assert.equal(r.pusher.last('a'), null, 'nothing sent yet');
  await r.pusher.test('a');
  assert.deepEqual(r.sent.map((s) => s.sub.endpoint), ['https://p/a']);
  assert.deepEqual({ ...r.pusher.last('a'), at: 0 }, { at: 0, ok: true, status: 201, gone: false, kind: 'done' }, 'the push service’s answer is kept for the settings page');
  // Marked as a test, so the service worker shows it even with the app open in front (that's where it's pressed).
  assert.equal(r.sent[0].body.test, true);
  assert.equal(r.sent[0].body.url, '/#settings/remote');
});
