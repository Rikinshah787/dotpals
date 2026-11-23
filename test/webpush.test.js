import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createPublicKey, verify } from 'node:crypto';
import { b64u, encrypt, generateVapid, pushEndpoint, sendPush, unb64u, vapidHeader } from '../bridge/webpush.js';

// RFC 8291 appendix A: the same inputs must give the same bytes.
const VECTOR = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  cipher: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd' + 'irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
};

test('web push encryption matches the RFC 8291 test vector', () => {
  const body = encrypt(unb64u(VECTOR.plaintext), { p256dh: VECTOR.uaPublic, auth: VECTOR.auth }, { asPrivate: VECTOR.asPrivate, salt: VECTOR.salt });
  // Compared as bytes: the 86-byte header doesn't end on a base64 boundary, so the strings can't just be joined.
  assert.deepEqual(body, Buffer.concat([unb64u(VECTOR.header), unb64u(VECTOR.cipher)]));
  assert.equal(body.length, 86 + unb64u(VECTOR.plaintext).length + 1 + 16);
});

test('encrypt refuses bad keys and oversized payloads', () => {
  const keys = { p256dh: VECTOR.uaPublic, auth: VECTOR.auth };
  assert.throws(() => encrypt(Buffer.from('x'), { p256dh: 'AAAA', auth: VECTOR.auth }));
  assert.throws(() => encrypt(Buffer.from('x'), { p256dh: VECTOR.uaPublic, auth: 'AAAA' }));
  assert.throws(() => encrypt(Buffer.alloc(4100), keys), /too large/);
  assert.doesNotThrow(() => encrypt(Buffer.alloc(4078), keys));
});

test('VAPID: a generated key signs a token the public key verifies', () => {
  const vapid = generateVapid();
  assert.equal(unb64u(vapid.publicKey).length, 65);
  assert.equal(unb64u(vapid.privateKey).length, 32);
  const now = Date.UTC(2026, 10, 20);
  const header = vapidHeader('https://fcm.googleapis.com/fcm/send/abc', vapid, 'mailto:me@example.com', now);
  const [, t, k] = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(header);
  assert.equal(k, vapid.publicKey);
  const [h, c, s] = t.split('.');
  assert.deepEqual(JSON.parse(unb64u(h)), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(unb64u(c));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'mailto:me@example.com');
  assert.equal(claims.exp, Math.floor(now / 1000) + 43200);
  const pub = unb64u(vapid.publicKey);
  const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) } });
  assert.equal(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, unb64u(s)), true);
});

test('only real https push services are accepted as endpoints', () => {
  assert.ok(pushEndpoint('https://fcm.googleapis.com/fcm/send/abc'));
  assert.ok(pushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'));
  assert.ok(pushEndpoint('https://web.push.apple.com/x'));
  for (const real of ['https://jmt17.google.com/fcm/send/abc', 'https://fcm.googleapis.com/wp/abc', 'https://updates.push.services.mozilla.com/wpush/v2/x']) assert.ok(pushEndpoint(real), real);
  for (const bad of ['https://www.google.com/search?q=x', 'https://jmt17.google.com/other', 'https://google.com.evil.example/fcm/send/x', 'https://evil.example/fcm/send/google.com', 'https://a.b.google.com/fcm/send/x']) assert.equal(pushEndpoint(bad), null, bad);
  assert.ok(pushEndpoint('https://wns2-pn2p.notify.windows.com/w/?token=x'));
  for (const bad of ['https://attacker.example/x', 'https://fcm.googleapis.com.evil.example/x', 'https://evilnotify.windows.com/x', 'https://notify.windows.com.evil.example/x']) assert.equal(pushEndpoint(bad), null);
  for (const bad of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://192.168.1.5/x', 'https://[::1]/x', 'https://intranet/x', 'https://u:p@fcm.googleapis.com/x', 'https://push.example.com:8443/x', 'nope', '', null]) assert.equal(pushEndpoint(bad), null, String(bad));
});

test('sendPush posts the encrypted blob with VAPID, and reports a dead subscription', async () => {
  const vapid = generateVapid();
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: VECTOR.uaPublic, auth: VECTOR.auth } };
  let seen;
  const ok = await sendPush(sub, 'hello', vapid, { subject: 'mailto:a@b.co', topic: 'a b!c', fetcher: async (url, init) => { seen = { url, init }; return { status: 201 }; } });
  assert.deepEqual(ok, { ok: true, status: 201, gone: false });
  assert.equal(seen.url, sub.endpoint);
  assert.equal(seen.init.headers['content-encoding'], 'aes128gcm');
  assert.equal(seen.init.headers.topic, 'abc');
  assert.match(seen.init.headers.authorization, /^vapid t=/);
  assert.ok(Buffer.isBuffer(seen.init.body));
  assert.equal((await sendPush(sub, 'x', vapid, { subject: 's', fetcher: async () => ({ status: 410 }) })).gone, true);
  assert.equal((await sendPush(sub, 'x', vapid, { subject: 's', fetcher: async () => ({ status: 500 }) })).gone, false);
  assert.deepEqual(await sendPush(sub, 'x', vapid, { subject: 's', fetcher: async () => { throw new Error('down'); } }), { ok: false, status: 0, gone: false });
  assert.equal((await sendPush({ endpoint: 'http://10.0.0.1/x', keys: sub.keys }, 'x', vapid, { subject: 's' })).gone, false, 'our own refusal never deletes a subscription');
});
