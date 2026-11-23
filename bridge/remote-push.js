// Which bridge events become a push notification, and who gets it. The pal page makes these
// decisions in the browser (index.html notifyState…); a phone with the app closed has no page
// running, so the bridge decides here, the same way, per device and per its own preferences.
import { redactText } from './redact.js';
import { harnessName } from './ui/recap.js';
import { CAST, avatarName } from './remote/avatar-names.js';
import { characterFor } from './remote/pals-core.js';

const clip = (s, n) => { const t = redactText(String(s ?? '')).text.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const VERB = { run: 'run a command', edit: 'edit a file', write: 'write a file', delete: 'delete a file', web: 'go online', agent: 'start a helper agent', mcp: 'use a tool', read: 'read a file', search: 'search' };
const MIN_DONE_MS = 15_000;   // a request that took less than this isn't worth a buzz
const WAITING_AFTER = 20_000; // like the pal: only when it's still waiting for you after this long
const HISTORY = 10;           // pushes remembered per device, with the phone's receipt for each

/**
 * What an event means for a notification, or null. `turn(session)` → { ms, prompt } for the
 * request that just ended. Returns { kind, title, body, tag, delay? }.
 */
export function pushFor(event, data, { turn = () => null } = {}) {
  if (!data || typeof data !== 'object') return null;
  const who = harnessName(data.harness);
  const where = data.label ? ` · ${clip(data.label, 40)}` : '';
  const session = data.session ?? data.id ?? '';
  switch (event ?? 'message') {
    case 'message': {
      if (data.state === 'done') {
        const t = turn(data.session);
        if (!t || t.ms < MIN_DONE_MS) return null;
        return { kind: 'done', title: `${who} is done${where}`, body: t.prompt ? `“${clip(t.prompt, 90)}”` : 'Finished', tag: `done-${session}` };
      }
      if (data.state === 'waiting') return { kind: 'waiting', title: `${who} needs your OK${where}`, body: clip(data.text, 120) || 'Waiting for you', tag: `wait-${session}`, delay: WAITING_AFTER };
      return null;
    }
    case 'approval': {
      if (data.status !== 'pending') return null;
      return { kind: 'approval', title: `${who} wants to ${VERB[data.kind] ?? `use ${clip(data.tool, 30)}`}${where}`, body: clip(data.command || data.title || data.tool, 140), tag: `ask-${data.id}` };
    }
    case 'ocask': {
      if (data.status !== 'pending') return null;
      return { kind: 'approval', title: `OpenCode needs you${where}`, body: clip(data.kind === 'question' ? data.questions?.[0]?.question : `Permission: ${data.permission}`, 140), tag: `ask-${data.id}` };
    }
    case 'stuck': return { kind: 'stuck', title: `${who}${where} may be stuck`, body: clip(data.text, 140), tag: `stuck-${data.session}` };
    case 'conflict': return { kind: 'conflict', title: 'Two agents, one file', body: clip(data.text, 140), tag: `conflict-${data.session ?? ''}` };
    case 'loop': return ['gave-up', 'ask-you', 'bluff'].includes(data.kind) ? { kind: 'loop', title: `Claude${where}`, body: clip(data.text, 140), tag: `loop-${data.session}` } : null;
    case 'context': {
      const pct = data.size ? (data.used / data.size) * 100 : 0;
      return data.known && pct >= 90 ? { kind: 'context', title: `${who}'s context is ${Math.round(pct)}% full`, body: `${data.label ?? ''}: it will compact soon`.trim(), tag: `ctx-${data.session}` } : null;
    }
    default: return null;
  }
}

/**
 * Sends them. Quiet while a device has the app open (its live stream is the foreground signal),
 * at most one per tag per 10 s and 20 a minute per device, dead subscriptions forgotten.
 */
export function createPusher({ remote, hub, send, vapid, subject, turn, now = Date.now, log = () => {} }) {
  const waiting = new Map(); // session → timer, for "still waiting after 20 s"
  const recent = new Map();  // `${device}|${tag}` → time
  const minute = new Map();  // device → times in the last minute
  const sent_ = new Map();   // device → its last HISTORY pushes, oldest first: { at, kind, tag, ok, status, ack? }
  let lastAt = 0;
  let generation = 0;

  async function deliver(item, only) {
    // Millisecond timestamps also correlate receipts; concurrent sends must never share one.
    const t = lastAt = Math.max(now(), lastAt + 1);
    const tag = item.test ? `test-${t.toString(36)}` : item.tag;
    const started = generation;
    for (const { id } of remote.pushTargets()) {
      if (started !== generation) return;
      if (only && id !== only) continue;
      const target = remote.pushTargets().find((d) => d.id === id);
      if (!target) continue;
      if (!only) {
        const { prefs } = target;
        if (!prefs[item.kind]) continue;
        if (item.kind === 'approval' && !target.control) continue; // it couldn't answer anyway
        if (prefs.quietWhenOpen && hub.open(target.id)) continue;
        const key = `${target.id}|${item.tag}`;
        if (t - (recent.get(key) ?? 0) < 10_000) continue;
        const times = (minute.get(target.id) ?? []).filter((x) => t - x < 60_000);
        if (times.length >= 20) continue;
        recent.set(key, t);
        times.push(t);
        minute.set(target.id, times);
        if (recent.size > 400) for (const [k, v] of recent) if (t - v > 60_000) recent.delete(k);
      }
      // High urgency requests prompt delivery; the push service and OS still decide when to deliver.
      const urgent = item.kind === 'approval' || item.kind === 'waiting' || !!item.test;
      const body = JSON.stringify({ kind: item.kind, title: clip(item.title, 80), body: clip(item.body, 200), tag, at: t, test: !!item.test, avatar: avatarName(item.kind, item.test ? CAST[0] : characterFor(item.harness, CAST)), url: item.test ? '/#settings/remote' : '/#sessions' });
      const entry = { at: t, kind: item.kind, tag: String(tag ?? '').slice(0, 40), test: !!item.test, ok: null, status: 0, gone: false };
      const past = sent_.get(target.id) ?? [];
      past.push(entry); // before awaiting: a fast receipt may beat the push service's response
      sent_.set(target.id, past.slice(-HISTORY));
      let res;
      try { res = await send(target.sub, body, vapid(), { subject, urgency: urgent ? 'high' : 'normal', ttl: item.kind === 'approval' ? 120 : 3600, topic: tag }); }
      catch { res = { ok: false, status: 0 }; }
      Object.assign(entry, { ok: !!res.ok, status: res.status ?? 0, gone: !!res.gone });
      if (!res.ok) log(`push: ${target.id} was not accepted (push service answered ${res.status || 'nothing'})`);
      if (res.gone && remote.forgetSubscription(target.id, target.sub)) log(`push: forgot a dead subscription for ${target.id}`);
    }
  }

  return {
    /** Call for every bridge event; does nothing (no timers either) while no device wants pushes. */
    handle(event, data) {
      if (event == null || event === 'message') {
        const timer = waiting.get(data?.session);
        if (timer) { clearTimeout(timer); waiting.delete(data.session); }
      }
      if (!remote.pushTargets().length) return;
      const found = pushFor(event, data, { turn });
      if (!found) return;
      const item = { ...found, harness: data.harness }; // whose avatar the notification wears
      if (!item.delay) { deliver(item).catch(() => {}); return; }
      const timer = setTimeout(() => { waiting.delete(data.session); deliver(item).catch(() => {}); }, item.delay);
      timer.unref?.();
      waiting.set(data.session, timer);
    },
    /** A test notification for one device, whatever its preferences. */
    // A tag of its own each time: on Android a notification with the SAME tag as one still in the shade replaces it silently (no
    // sound, no pop-up), so the second test would look like it never came. (Letters and digits only: it is also the Topic header.)
    test: (deviceId) => deliver({ kind: 'done', title: 'dotpals', body: 'A test notification from dotpals.', test: true }, deviceId),
    /** What the push service said last, with what the device said about that same push (`ack`, when it matches). */
    last: (deviceId) => {
      const sent = sent_.get(deviceId)?.at(-1);
      if (!sent) return null;
      const { at, kind, ok, status, gone, ack } = sent;
      return { at, kind, ok, status, gone, ...(ack ? { ack } : {}) };
    },
    /**
     * The last few pushes sent to a device, newest first, each with the phone's receipt when one came: [{ at, kind, tag, ok, status,
     * ack? }]. `last` only ever shows the newest, so pressing "Send a test" again hid whether the one before it had arrived.
     * The receipt's own `at` is when the COMPUTER heard it (a network request: it can trail the push itself).
     */
    history: (deviceId) => [...(sent_.get(deviceId) ?? [])].reverse(),
    /** The device's own word that a push arrived: { sentAt, shown, held, error, tag }. Kept only for the push it names. */
    ack(deviceId, body) {
      if (!deviceId || !body || !Number.isSafeInteger(body.sentAt)) return false;
      const entry = (sent_.get(deviceId) ?? []).find((e) => e.at === body.sentAt);
      if (!entry) return false;
      const a = {
        at: now(), sentAt: body.sentAt, shown: body.shown === true, held: body.held === true,
        error: typeof body.error === 'string' ? body.error.replace(/\s+/g, ' ').slice(0, 80) : '',
      };
      entry.ack = a;
      return true;
    },
    forget(deviceId) {
      sent_.delete(deviceId);
      minute.delete(deviceId);
      for (const key of recent.keys()) if (key.startsWith(`${deviceId}|`)) recent.delete(key);
    },
    stop() { generation++; for (const t of waiting.values()) clearTimeout(t); waiting.clear(); },
  };
}
