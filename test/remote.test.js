import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLimiter, createRemote, cleanPrefs, cleanSubscription, newCode, normalizeCode, permission, remotePatch } from '../bridge/remote.js';

const dir = await mkdtemp(join(tmpdir(), 'dotpals-remote-'));
after(() => rm(dir, { recursive: true, force: true }));
let clock = 1_000_000;
const make = (name = 'remote.json') => createRemote({ file: () => join(dir, name), now: () => clock });
const header = (c) => `Bearer ${c.id}.${c.secret}`;

test('a pairing token works once, and only before it expires', () => {
  const r = make('a.json');
  const { token } = r.startPairing();
  const first = r.finishPairing(token, 'Pixel Fold');
  assert.ok(first.id && first.secret);
  assert.equal(r.finishPairing(token, 'again'), null);
  const late = r.startPairing();
  clock += 5 * 60_000 + 1;
  assert.equal(r.finishPairing(late.token, 'late'), null);
  assert.equal(r.finishPairing('nonsense', 'x'), null);
  assert.equal(r.devices().length, 1);
  assert.equal(r.devices()[0].name, 'Pixel Fold');
});

test('pairing codes are typeable: 12 symbols, forgiving of case, spaces and look-alikes', () => {
  const code = newCode();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(normalizeCode(code), code.replaceAll('-', ''));
  assert.equal(normalizeCode(code.toLowerCase().replaceAll('-', ' ')), code.replaceAll('-', ''));
  assert.equal(normalizeCode('0O1I 0000 0000'), '001100000000'); // O reads as 0; I and L as 1
  assert.equal(normalizeCode('0O1IL 0000 0000'), null); // thirteen symbols
  for (const bad of ['', 'abc', 'U'.repeat(12), `${code}X`, null, 5]) assert.equal(normalizeCode(bad), null, String(bad));
  assert.equal(new Set(Array.from({ length: 200 }, newCode)).size, 200);
  const r = make('codes.json');
  const { token } = r.startPairing();
  assert.ok(r.finishPairing(token.toLowerCase().replaceAll('-', ''), 'typed'));
  assert.equal(r.waiting(), 0);
  r.startPairing();
  assert.equal(r.waiting(), 1);
  r.cancelPairing();
  assert.equal(r.waiting(), 0);
});

test('a device signs in with its secret; the file holds only a hash', async () => {
  const r = make('b.json');
  const c = r.finishPairing(r.startPairing().token, '<b>Tab</b>\n');
  assert.equal(r.authenticate(header(c)).id, c.id);
  assert.equal(r.authenticate(`Bearer ${c.id}.${'x'.repeat(43)}`), null);
  assert.equal(r.authenticate(`Bearer nope.${c.secret}`), null);
  assert.equal(r.authenticate(undefined), null);
  assert.equal(r.authenticate('Basic abc'), null);
  const text = await readFile(join(dir, 'b.json'), 'utf8');
  assert.ok(!text.includes(c.secret));
  assert.equal(JSON.parse(text).devices[0].name, 'bTab/b'); // markup characters and control characters are dropped
  assert.equal(r.revoke(c.id), true);
  assert.equal(r.authenticate(header(c)), null);
  assert.equal(r.revoke(c.id), false);
});

test('the store is private to you (POSIX) and survives a restart', async () => {
  const r = make('c.json');
  const c = r.finishPairing(r.startPairing().token, 'Phone');
  const vapid = r.vapid();
  assert.equal(r.vapid().publicKey, vapid.publicKey);
  if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'c.json'))).mode & 0o777, 0o600);
  const again = make('c.json');
  assert.equal(again.authenticate(header(c)).id, c.id);
  assert.equal(again.vapid().privateKey, vapid.privateKey);
});

test('at most 20 devices', () => {
  const r = make('d.json');
  for (let i = 0; i < 20; i++) assert.ok(r.finishPairing(r.startPairing().token, `d${i}`));
  assert.equal(r.finishPairing(r.startPairing().token, 'one too many'), null);
});

test('permissions: only listed routes are available; powerful actions require control', () => {
  const plain = { control: false };
  const trusted = { control: true };
  assert.equal(permission(plain, 'GET', '/api/activity'), 'ok');
  assert.equal(permission(plain, 'GET', '/events'), 'ok');
  assert.equal(permission(plain, 'POST', '/api/config'), 'ok');
  for (const p of ['/api/handoff', '/api/rewind/undo', '/api/talk/start', '/api/sessions/abc/dismiss']) {
    assert.equal(permission(plain, 'POST', p), 'control', p);
    assert.equal(permission(trusted, 'POST', p), 'ok', p);
  }
  for (const d of [plain, trusted]) {
    for (const p of ['/api/apps', '/api/approvals', '/api/remote/future', '/api/future']) assert.equal(permission(d, 'GET', p), 'blocked', p);
    for (const p of ['/api/apps/add', '/api/talk/apps', '/api/approvals/0123456789abcdef', '/api/chat', '/api/agents/claude/connect', '/api/history/clear', '/api/future']) assert.equal(permission(d, 'POST', p), 'blocked', p);
    for (const method of ['GET', 'HEAD', 'POST']) assert.equal(permission(d, method, '/api/recap'), 'blocked', 'hook recap must not consume shared state remotely');
    for (const [m, p] of [['POST', '/hook'], ['POST', '/event'], ['POST', '/api/app/quit'], ['POST', '/api/remote/pair'], ['GET', '/api/remote/devices'], ['GET', '/api/apps/callback'], ['GET', '/bridge/server.js'], ['PUT', '/api/config'], ['DELETE', '/api/config']]) assert.equal(permission(d, m, p), 'blocked', `${m} ${p}`);
  }
});

test('settings: a device changes the safe ones; the rest needs the control switch', () => {
  assert.deepEqual(remotePatch({ sounds: false, palSize: 90 }, { control: false }), { patch: { sounds: false, palSize: 90 }, denied: [] });
  assert.deepEqual(remotePatch({ sounds: false, chat: true, brainKeys: { openai: 'x' } }, { control: false }), { patch: { sounds: false }, denied: ['chat', 'brainKeys'] });
  assert.deepEqual(remotePatch({ chat: true }, { control: true }), { patch: { chat: true }, denied: [] });
  assert.deepEqual(remotePatch(null, { control: true }), { patch: {}, denied: [] });
  assert.deepEqual(remotePatch([1], null), { patch: {}, denied: [] });
});

test('a device manages itself under /api/remote/me, but never the computer-side /api/remote', () => {
  for (const p of ['/api/remote/me/signout', '/api/remote/me/push', '/api/remote/me/prefs']) assert.equal(permission({ control: false }, 'POST', p), 'ok', p);
  assert.equal(permission({ control: false }, 'GET', '/api/remote/me'), 'ok');
  for (const p of ['/api/remote', '/api/remote/', '/api/remote/pair', '/api/remote/devices', '/api/remote/members', '/api/remote/meta']) {
    assert.equal(permission({ control: true }, 'POST', p), 'blocked', p);
  }
  assert.equal(permission({ control: false }, 'GET', '/api/remote/devices'), 'blocked');
});

test('push preferences and subscriptions are validated', () => {
  const r = make('e.json');
  const c = r.finishPairing(r.startPairing().token, 'P');
  assert.equal(r.device(c.id).prefs.done, true);
  assert.equal(r.device(c.id).prefs.context, false);
  assert.equal(r.update(c.id, { prefs: { done: false, evil: true, context: 'yes' } }).prefs.done, false);
  assert.equal(r.device(c.id).prefs.context, false);
  assert.equal('evil' in r.device(c.id).prefs, false);
  const keys = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
  assert.equal(r.update(c.id, { push: { endpoint: 'http://10.0.0.1/x', keys } }), null);
  assert.equal(r.update(c.id, { push: { endpoint: 'https://fcm.googleapis.com/x', keys: { ...keys, auth: 'AA' } } }), null);
  assert.equal(r.update(c.id, { push: { endpoint: 'https://fcm.googleapis.com/x', keys } }).push, true);
  assert.equal(r.pushTargets().length, 1);
  const original = r.pushTargets()[0].sub;
  assert.equal(r.update(c.id, { push: { endpoint: 'https://fcm.googleapis.com/replacement', keys } }).push, true);
  assert.equal(r.forgetSubscription(c.id, original), false, 'late 410 must not remove a replacement');
  assert.equal(r.forgetSubscription(c.id, r.pushTargets()[0].sub), true);
  assert.equal(r.update(c.id, { push: null }).push, false);
  assert.equal(r.pushTargets().length, 0);
  assert.equal(r.update(c.id, { control: true }).control, true);
  assert.equal(r.update('missing', { control: true }), null);
  assert.deepEqual(cleanPrefs(null), cleanPrefs(undefined));
  assert.equal(cleanSubscription('x'), null);
});

test('the limiter allows a few tries, then waits', () => {
  let t = 0;
  const l = createLimiter({ max: 3, windowMs: 1000, now: () => t });
  assert.deepEqual([l.hit('a'), l.hit('a'), l.hit('a'), l.hit('a')], [true, true, true, false]);
  assert.equal(l.hit('b'), true);
  t = 1500;
  assert.equal(l.hit('a'), true);
});
