// Web Push without a dependency: RFC 8291 message encryption (aes128gcm) and RFC 8292
// VAPID, on node:crypto alone. The bridge signs and encrypts here; the browser's push
// service (FCM, Mozilla, Apple) only ever sees an opaque encrypted blob.
import { createECDH, createPrivateKey, createCipheriv, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const unb64u = (s) => Buffer.from(String(s), 'base64url');

/** A new VAPID key pair: { publicKey, privateKey } as unpadded base64url (65-byte point, 32-byte scalar). */
export function generateVapid() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  return { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])), privateKey: jwk.d };
}

const RECORD = 4096;

/**
 * Encrypt `payload` (a Buffer) for one subscription: { p256dh, auth } as the browser gives
 * them (base64url). `fixed` ({ asPrivate, salt }) exists for the RFC's test vector only.
 * Returns the request body: header (salt, record size, key id) then one encrypted record.
 */
export function encrypt(payload, { p256dh, auth }, fixed = {}) {
  const ua = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (ua.length !== 65 || ua[0] !== 4 || authSecret.length !== 16) throw new Error('bad push subscription keys');
  if (payload.length > RECORD - 18) throw new Error('push payload too large');
  const ecdh = createECDH('prime256v1');
  if (fixed.asPrivate) ecdh.setPrivateKey(unb64u(fixed.asPrivate)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = fixed.salt ? unb64u(fixed.salt) : randomBytes(16);
  const secret = ecdh.computeSecret(ua);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/** The VAPID `Authorization` header for a push service's origin (a token good for 12 hours). */
export function vapidHeader(endpoint, { publicKey, privateKey }, subject, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const part = (o) => b64u(JSON.stringify(o));
  const input = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  const pub = unb64u(publicKey);
  const key = createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });
  const sig = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64u(sig)}, k=${publicKey}`;
}

/** Only browser push providers, not arbitrary DNS names which could resolve inside your network. */
export function pushEndpoint(value) {
  try {
    const u = new URL(String(value));
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
    const h = u.hostname.toLowerCase();
    // Google's own hosts (Chrome on Android also uses names like jmt17.google.com/fcm/send/...), Mozilla's, Apple's and Windows'.
    const known = ['fcm.googleapis.com', 'web.push.apple.com'].includes(h) || /^(?:[a-z0-9-]+\.)*push\.services\.mozilla\.com$/.test(h) || /^[a-z0-9-]+\.notify\.windows\.com$/.test(h)
      || (/^[a-z0-9-]+\.google\.com$/.test(h) && u.pathname.startsWith('/fcm/'));
    if (!known) return null;
    return u.href;
  } catch { return null; }
}

/**
 * Send one push. Resolves { ok, status, gone }: `gone` (404/410) means the subscription is dead
 * and should be forgotten. Never throws, and gives up after `timeout` ms.
 */
export async function sendPush(sub, text, vapid, { subject, ttl = 3600, urgency = 'normal', topic, timeout = 8000, fetcher = fetch } = {}) {
  const endpoint = pushEndpoint(sub?.endpoint);
  // A refused address is OUR policy, not the push service saying the subscription is dead: never make the caller forget it.
  if (!endpoint) return { ok: false, status: 0, gone: false };
  try {
    const headers = {
      authorization: vapidHeader(endpoint, vapid, subject),
      'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream',
      ttl: String(ttl), urgency,
    };
    if (topic) headers.topic = topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
    const res = await fetcher(endpoint, { method: 'POST', headers, body: encrypt(Buffer.from(text), sub.keys), signal: AbortSignal.timeout(timeout), redirect: 'error' });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
  } catch { return { ok: false, status: 0, gone: false }; }
}
