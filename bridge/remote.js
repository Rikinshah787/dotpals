// Remote client: pairing, device credentials and what a paired device may do.
// Kept in ~/.dotpals/remote.json (0600), never in config.json (the pages can read that).
// A device holds a secret only it knows; the bridge keeps its SHA-256, so a leaked file
// can't be used to sign in. Pairing tokens live in memory, work once, and expire.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { platform } from 'node:os';
import { b64u, generateVapid, pushEndpoint, unb64u } from './webpush.js';

const sha = (s) => createHash('sha256').update(s).digest();
const clipText = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, n);

/** What a device can be told about (Settings on the device). `quietWhenOpen`: no push while the app is open there. */
export const PUSH_KINDS = ['done', 'waiting', 'approval', 'stuck', 'conflict', 'loop', 'context'];
export const DEFAULT_PREFS = { done: true, waiting: true, approval: true, stuck: true, conflict: true, loop: true, context: false, quietWhenOpen: true };

export function cleanPrefs(input, before = DEFAULT_PREFS) {
  const out = { ...DEFAULT_PREFS, ...before };
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const k of [...PUSH_KINDS, 'quietWhenOpen']) if (typeof input[k] === 'boolean') out[k] = input[k];
  }
  return out;
}

/** A browser's push subscription, checked: an https push service and keys of the right size. */
export function cleanSubscription(sub) {
  const endpoint = pushEndpoint(sub?.endpoint);
  if (!endpoint || endpoint.length > 1000) return null;
  try {
    if (unb64u(sub.keys?.p256dh).length !== 65 || unb64u(sub.keys?.auth).length !== 16) return null;
  } catch { return null; }
  return { endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } };
}

// -- what a paired device may ask the bridge ---------------------------------------------------
// The device can manage its own name, push and credential. Desktop admin and unrelated APIs stay local.
// Explicit lists: adding a local bridge route must not silently expose it to the network.
const READS = new Set(['/events', '/api/activity', '/api/agents', '/api/brain', '/api/config', '/api/git', '/api/loop', '/api/remote/me', '/api/sessions', '/api/status', '/api/usage']);
const SELF = new Set(['/api/remote/me/prefs', '/api/remote/me/signout', '/api/remote/me/push', '/api/remote/me/ack', '/api/remote/me/test']);
const CONTROL = new Set(['/api/brain/test', '/api/handoff', '/api/rewind/preview', '/api/rewind', '/api/rewind/undo', '/api/talk/buddy', '/api/talk/plan', '/api/talk/start']);

/** 'ok', 'control' (needs the device's control switch) or 'blocked'. */
export function permission(device, method, path) {
  if (method === 'GET') return READS.has(path) ? 'ok' : 'blocked';
  if (method !== 'POST') return 'blocked';
  if (SELF.has(path) || path === '/api/config') return 'ok';
  if (!CONTROL.has(path) && !/^\/api\/sessions\/[^/]{1,200}\/dismiss$/.test(path)) return 'blocked';
  return device?.control ? 'ok' : 'control';
}

/** Settings any paired device may change: how things look and sound, not what runs on this computer. */
export const SAFE_SETTINGS = ['sounds', 'notifications', 'character', 'custom', 'palSize', 'storyView'];
const CONTROL_SETTINGS = ['stuckAlerts', 'conflictMinutes', 'fixLoop'];

/**
 * A settings patch from a paired device: { patch, denied }. Desktop-only settings always stay local.
 * `denied` lists what was refused (the
 * whole request is then refused, never half applied).
 */
export function remotePatch(patch, device) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { patch: {}, denied: [] };
  const out = {};
  const denied = [];
  for (const [key, value] of Object.entries(patch)) {
    if (SAFE_SETTINGS.includes(key) || (device?.control && CONTROL_SETTINGS.includes(key))) out[key] = value; else denied.push(key);
  }
  return { patch: out, denied };
}

/** At most `max` tries per `windowMs` for one key (an address): small, in memory, forgets itself. */
export function createLimiter({ max = 10, windowMs = 60_000, now = Date.now } = {}) {
  const hits = new Map();
  return {
    hit(key) {
      const t = now();
      const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
      if (list.length >= max) return false;
      list.push(t);
      hits.set(key, list);
      if (hits.size > 500) {
        for (const [k, v] of hits) if (t - v.at(-1) >= windowMs) hits.delete(k);
        if (hits.size > 500) hits.delete(hits.keys().next().value);
      }
      return true;
    },
  };
}

const PAIR_TTL = 5 * 60_000;
const MAX_DEVICES = 20;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U to misread

/** A pairing code, 60 bits, shown as XXXX-XXXX-XXXX (it goes in the QR's link and can be typed). */
export function newCode() {
  const b = randomBytes(8);
  let bits = 0n;
  for (const x of b) bits = (bits << 8n) | BigInt(x);
  let out = '';
  for (let i = 0; i < 12; i++) out += ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}

/** What was typed or scanned, as the 12 symbols it stands for (any case, spaces and dashes, O/I/L as 0/1/1), else null. */
export function normalizeCode(input) {
  const s = String(input ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{12}$/.test(s) ? s : null;
}

export function createRemote({ file, now = Date.now } = {}) {
  let data = null;
  const load = () => {
    if (data) return data;
    try { data = JSON.parse(readFileSync(file(), 'utf8')) ?? {}; } catch { data = {}; }
    if (!Array.isArray(data.devices)) data.devices = [];
    return data;
  };
  const save = (next = data) => {
    const path = file();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    if (platform() !== 'win32') { try { chmodSync(path, 0o600); } catch {} }
  };
  const keepDevices = (devices) => {
    const next = { ...load(), devices };
    save(next);
    data = next;
  };
  const pending = new Map(); // sha(token) hex → { expiresAt, claimed }
  let wrote = 0;

  const view = (d) => ({
    id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen, control: !!d.control,
    push: !!d.push, prefs: cleanPrefs(d.prefs),
  });
  const find = (id) => load().devices.find((d) => d.id === id);

  return {
    vapid() {
      const d = load();
      if (!d.vapid?.publicKey || !d.vapid?.privateKey) { d.vapid = generateVapid(); save(); }
      return d.vapid;
    },
    /** A one-time pairing token, good for 5 minutes. Only its hash is kept. */
    startPairing() {
      for (const [h, item] of pending) if (item.expiresAt <= now()) pending.delete(h);
      if (pending.size >= 5) pending.delete(pending.keys().next().value);
      const token = newCode();
      const expiresAt = now() + PAIR_TTL;
      const id = sha(normalizeCode(token)).toString('hex');
      pending.set(id, { expiresAt, claimed: false });
      return { token, expiresAt, id };
    },
    /** Trade a pairing code for a device credential, once. Returns { id, secret } or null. */
    finishPairing(token, name) {
      const code = normalizeCode(token);
      if (!code) return null;
      const h = sha(code).toString('hex');
      const item = pending.get(h);
      if (!item || item.claimed || item.expiresAt <= now()) return null;
      const d = load();
      if (d.devices.length >= MAX_DEVICES) return null;
      const id = b64u(randomBytes(9));
      const secret = b64u(randomBytes(32));
      d.devices.push({ id, name: clipText(name, 40) || 'Device', hash: sha(secret).toString('hex'), createdAt: now(), lastSeen: now(), control: false, push: null, prefs: { ...DEFAULT_PREFS } });
      save();
      item.claimed = true;
      return { id, secret };
    },
    /** The device behind an `Authorization: Bearer <id>.<secret>` header, or null. */
    authenticate(header) {
      const m = /^Bearer ([\w-]{8,32})\.([\w-]{20,100})$/.exec(String(header ?? ''));
      const d = m && find(m[1]);
      if (!d) return null;
      const a = Buffer.from(d.hash, 'hex');
      const b = sha(m[2]);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
      d.lastSeen = now();
      if (now() - wrote > 10 * 60_000) { wrote = now(); save(); } // not on every request
      return d;
    },
    /** How many codes are waiting to be used (for the pairing screen). */
    waiting: () => { for (const [h, item] of pending) if (item.expiresAt <= now()) pending.delete(h); return [...pending.values()].filter((item) => !item.claimed).length; },
    pendingPairs: () => [...pending].filter(([, item]) => !item.claimed && item.expiresAt > now()).map(([id]) => id),
    claimed: () => [...pending].filter(([, item]) => item.claimed && item.expiresAt > now()).map(([id]) => id),
    cancelPairing: () => pending.clear(),
    devices: () => load().devices.map(view),
    device: (id) => { const d = find(id); return d ? view(d) : null; },
    pushTargets: () => load().devices.filter((d) => d.push).map((d) => ({ id: d.id, sub: d.push, control: !!d.control, prefs: cleanPrefs(d.prefs) })),
    hasSubscription(id, sub) {
      const current = find(id)?.push;
      return !!current?.keys && current.endpoint === sub?.endpoint && current.keys.p256dh === sub?.keys?.p256dh && current.keys.auth === sub?.keys?.auth;
    },
    forgetSubscription(id, subscription) {
      const d = find(id);
      if (!d || d.push !== subscription) return false;
      d.push = null;
      save();
      return true;
    },
    /** { name?, control?, prefs?, push? (a subscription, or null to remove it) } */
    update(id, patch = {}) {
      const d = find(id);
      if (!d) return null;
      if (typeof patch.name === 'string' && clipText(patch.name, 40)) d.name = clipText(patch.name, 40);
      if (typeof patch.control === 'boolean') d.control = patch.control;
      if (patch.prefs) d.prefs = cleanPrefs(patch.prefs, d.prefs);
      if (patch.push === null) d.push = null;
      else if (patch.push) { const s = cleanSubscription(patch.push); if (s) d.push = s; else return null; }
      save();
      return view(d);
    },
    revoke(id) {
      const before = load().devices;
      const devices = before.filter((x) => x.id !== id);
      if (devices.length === before.length) return false;
      keepDevices(devices);
      return true;
    },
    revokeAll() { keepDevices([]); },
  };
}
