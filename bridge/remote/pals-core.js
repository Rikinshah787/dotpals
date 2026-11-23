// The remote client's agent pals, as plain functions (no DOM), so they can be tested.
// pals.js draws them. A session is { id, harness, label, state, text, at }, kept from the live stream's
// state events ({ session, harness, label, state, text, at }), the same ones the notch follows.

export const STATES = ['idle', 'listening', 'thinking', 'working', 'speaking', 'waiting', 'done', 'error', 'sleeping'];
export const ACTIVE = ['working', 'thinking', 'speaking', 'waiting'];
const RECENT = 10 * 60_000; // a quiet session stays on the tray this long (the bridge sends "sleeping" later)

export const isActive = (s) => ACTIVE.includes(s?.state);

/** Fold one state event into the map: a newer state replaces the older, "sleeping" removes the session. */
export function apply(sessions, u, now = Date.now()) {
  if (!u || typeof u.session !== 'string' || !u.session) return sessions;
  if (u.state === 'sleeping') { sessions.delete(u.session); return sessions; }
  const prev = sessions.get(u.session);
  const state = STATES.includes(u.state) ? u.state : prev?.state ?? 'idle';
  sessions.set(u.session, {
    id: u.session,
    harness: u.harness ?? prev?.harness,
    label: u.label ?? prev?.label,
    state,
    // A new state starts without the old one's words; the same state keeps them until it says something else.
    text: typeof u.text === 'string' ? u.text : state !== prev?.state ? '' : prev?.text ?? '',
    at: Number(u.at) || now,
  });
  return sessions;
}

const DOZE = 3 * 60_000;
/** What its pal shows: a session that has been quiet for a few minutes dozes off, like on the desktop. */
export const shownState = (s, now = Date.now()) => (!isActive(s) && now - (s?.at ?? now) > DOZE ? 'sleeping' : s?.state ?? 'idle');

/** Who is on the tray, most pressing first: waiting for you, then working, then the recently quiet. */
export function ordered(sessions, now = Date.now()) {
  const rank = (s) => (s.state === 'waiting' ? 0 : isActive(s) ? 1 : 2);
  return [...sessions.values()].filter((s) => isActive(s) || now - s.at < RECENT).sort((a, b) => rank(a) - rank(b) || b.at - a.at);
}

/** One pal per agent, the same every time: a stable pick from the characters there are. */
export function characterFor(key, cast) {
  if (!cast?.length) return 'blu';
  let h = 5381;
  for (const c of String(key ?? 'agent')) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0;
  return cast[h % cast.length];
}

const WORDS = { idle: 'Ready', listening: 'Your turn', thinking: 'Thinking…', working: 'Working…', speaking: 'Replying…', waiting: 'Needs you', done: 'Done', error: 'Stopped with an error', sleeping: 'Asleep' };
/** What a pal's line says: the step it's on, or the state in words. */
export const stateLine = (s) => (s?.text || WORDS[s?.state] || '').slice(0, 80);

/** The tray's one-line summary: "2 working, 1 needs you". */
export function summary(list) {
  const waiting = list.filter((s) => s.state === 'waiting').length;
  const working = list.filter((s) => isActive(s) && s.state !== 'waiting').length;
  const parts = [];
  if (working) parts.push(`${working} working`);
  if (waiting) parts.push(waiting === 1 ? '1 needs you' : `${waiting} need you`);
  return parts.join(', ') || (list.length ? 'All quiet' : '');
}

/** Agent chips for the Sessions picker, from the filter's own options: [{ value, label, live }]. */
export function agentChips(options, sessions) {
  const live = new Map();
  for (const s of sessions.values()) if (isActive(s) && s.harness) live.set(s.harness, (live.get(s.harness) ?? 0) + 1);
  return options.map((o) => ({ value: o.value, label: o.label, live: o.value ? live.get(o.value) ?? 0 : [...live.values()].reduce((a, b) => a + b, 0) }));
}

/**
 * Can this device talk to Blu from here? Only with the control switch on (what Blu answers can start work
 * on the computer), and with an AI set up for the job: `ready` is the brain id the bridge picked, or null.
 * Chat with your agents (OpenCode) is a separate thing and not what this is.
 */
export function talkGate({ control, ready, known = true } = {}) {
  if (!control) return { ok: false, why: 'This device can look, not control. Turn on “Let this device control” for it, on the computer.' };
  if (!known) return { ok: false, why: 'Couldn’t ask the computer what AI is set up. Try again in a moment.' };
  if (!ready) return { ok: false, why: 'No AI is set up for Blu yet. Add one on the computer, in Settings → Blu’s brain.' };
  return { ok: true, why: '' };
}

/** Where Blu's answer goes: 'plan' (work for an agent: asks before anything is sent) or 'buddy' (answers itself). */
export const needs = (job) => (job === 'plan' ? 'plan' : 'screen');

/** The story of a session's newest request, as { text, status, warnings } or null. `simple` is ui/story.js's. */
export function storyOf(entries, session, { buildTurns, simple }) {
  const mine = [...entries.values()].filter((e) => e.session === session);
  if (!mine.length) return null;
  const turn = buildTurns(mine).at(-1);
  return turn ? simple(turn) : null;
}

/** Keep the newest `max` entries of each session (the dashboard keeps the lot; a phone needn't). */
export function keepEntries(map, entry, max = 120) {
  if (!entry?.id) return map;
  map.set(entry.id, entry);
  const mine = [...map.values()].filter((e) => e.session === entry.session);
  if (mine.length > max) for (const e of mine.sort((a, b) => a.at - b.at).slice(0, mine.length - max)) map.delete(e.id);
  return map;
}
