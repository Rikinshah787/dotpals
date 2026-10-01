// The notch's behaviour: when it hides, peeks, shows its slim bar or opens, and
// which alert it's showing. A small, pure state machine: no timers, no DOM. The
// page feeds it events with the current time and asks what to show; `nextWake()`
// says when to ask again (a dwell finishes, a "done" runs out, it auto-closes).
//
//   hidden  nothing running, or you've been away for a while. A thin invisible
//           strip at the top edge stays, so hovering there can wake it.
//   peek    you're hovering that strip: a small island peeks out. Stay a moment
//           and it opens; move away and it hides again.
//   bar     agents are working: a slim island with their pals and the current step.
//           Hover it briefly, or click, to open. Minimized (tucked), it hides instead,
//           like when nothing's running: alerts still show, the top edge still peeks.
//   open    the big view. An alert (an agent needs you, finished or failed) opens it
//           by itself. Opened by you, it closes 8 s after the pointer leaves it, or
//           after a minute with no mouse activity while the pointer rests on it (a
//           shrinking line shows the countdown); Esc closes it at once.
//
// Alerts queue and show one at a time: needs-you first (they stay until answered),
// then "done" and "error" news, in the order they came. News waits while you're away.

export const TIMING = {
  barOpen: 200,         // hovering the bar this long opens it
  peekOpen: 600,        // hovering a peek this long opens it
  peekLinger: 350,      // a peek you moved away from hides after this
  doneFor: 5000,        // a "done" alert shows this long
  errorFor: 8000,       // an "error" alert shows this long
  autoClose: 60_000,    // open with no mouse activity over it this long → it closes
  afterLeave: 8000,     // open, and the pointer left it this long ago → it closes (it covers tabs and title bars)
  countdown: 10_000,    // the last part of that, shown as a shrinking line
  away: 180_000,        // no input on the computer this long → you're away
  staleNews: 15 * 60_000, // done/error alerts older than this aren't worth showing
};

/** The starting state: nothing running, nothing open. */
export function initialState() {
  return {
    running: 0,       // agents working or waiting for you
    away: false,      // no input on the computer for TIMING.away
    hover: false,     // the pointer is over the island (or the hidden strip)
    hoverAt: 0,       // when it got there
    armed: true,      // hovering may open it (false after a close, until the pointer leaves)
    peekUntil: 0,     // a peek you left stays until then
    tucked: false,    // minimized: no bar while agents work (alerts and peeks still show)
    open: null,       // opened by you: { by: 'hover' | 'peek' | 'click', at, activeAt, leftAt }
    alerts: [],       // [{ id, kind: 'need' | 'done' | 'error', session, at, shownAt, snoozed }]
  };
}

const isNews = (a) => a.kind === 'done' || a.kind === 'error';
const lasts = (a, T) => (a.kind === 'error' ? T.errorFor : T.doneFor);

/** When a notch you opened closes by itself: soon after the pointer leaves, else after a quiet minute. */
const closesAt = (s, T) => {
  const quiet = s.open.activeAt + T.autoClose;
  return !s.hover && s.open.leftAt != null ? Math.min(quiet, s.open.leftAt + T.afterLeave) : quiet;
};

/**
 * The alert on show. Needs-you first, then news, each in arrival order. News waits
 * while you're away; a needs-you alert you closed (Esc) only shows when you open it.
 */
export function shownAlert(s) {
  const ok = (a) => (!a.snoozed || s.open) && (!s.away || !isNews(a));
  return s.alerts.find((a) => a.kind === 'need' && ok(a)) ?? s.alerts.find((a) => isNews(a) && ok(a)) ?? null;
}

/** Hidden or bar, when nothing is open. */
const restMode = (s) => (s.running > 0 && !s.away && !s.tucked ? 'bar' : 'hidden');

/**
 * What to show right now:
 *   { mode: 'hidden' | 'peek' | 'bar' | 'open', alert, by, countdown: { start, end } | null, queued }
 * `by` says why it's open ('alert', 'hover', 'peek', 'click'); `countdown` is the
 * stretch before it closes by itself, when there is one to show; `queued` counts
 * the alerts waiting behind the one on show.
 */
export function derive(s, now, T = TIMING) {
  const alert = shownAlert(s);
  const queued = s.alerts.filter((a) => a !== alert && (!s.away || !isNews(a))).length;
  if (alert || s.open) {
    let countdown = null;
    if (alert && isNews(alert) && !s.open && alert.shownAt != null) countdown = { start: alert.shownAt, end: alert.shownAt + lasts(alert, T) };
    else if (s.open && alert?.kind !== 'need') {
      const end = closesAt(s, T);
      if (now >= end - T.countdown) countdown = { start: Math.max(end - T.countdown, s.hover ? 0 : s.open.leftAt ?? 0), end };
    }
    return { mode: 'open', alert, by: s.open ? s.open.by : 'alert', countdown, queued };
  }
  const rest = restMode(s);
  if (rest === 'hidden' && s.armed && (s.hover || now < s.peekUntil)) return { mode: 'peek', alert: null, by: null, countdown: null, queued };
  return { mode: rest, alert: null, by: null, countdown: null, queued };
}

/**
 * The next state after an event:
 *   { type: 'agents', running }        how many agents are working or waiting for you
 *   { type: 'idle', seconds }          the computer's idle time (no keyboard or mouse)
 *   { type: 'pointer', inside, restless? }   the pointer moved (or clicked, or scrolled); inside: over
 *                                      the island; restless: it moved a fair way (restarts a peek's dwell)
 *   { type: 'click' }                  a click on the island: opens it
 *   { type: 'close' }                  Esc, or a close button: closes, sets needs-you alerts aside
 *   { type: 'tuck', on }               minimize (on) or bring back the bar; minimizing also closes it
 *   { type: 'alert', id, kind, session }   an alert to show (ignored if already queued)
 *   { type: 'resolve', id }            an alert is over (answered, the agent moved on)
 *   { type: 'resolve', session, kind? }   every alert of a session (of one kind)
 *   { type: 'tick' }                   time passed (see nextWake)
 */
export function reduce(prev, ev, now, T = TIMING) {
  const wasOpen = derive(prev, now, T).mode === 'open';
  const wasPeek = derive(prev, now, T).mode === 'peek';
  const s = { ...prev, alerts: prev.alerts.slice() };
  switch (ev?.type) {
    case 'agents':
      s.running = Math.max(0, Number(ev.running) || 0);
      break;
    case 'idle':
      s.away = Number(ev.seconds) * 1000 >= T.away;
      break;
    case 'pointer':
      s.away = false; // it moved: you're here
      if (ev.inside) {
        if (!s.hover) { s.hover = true; s.hoverAt = now; }
        // A peek opens once the pointer rests on it: sliding along the top edge (to
        // reach a browser tab, say) keeps starting the dwell over.
        else if (ev.restless && !s.open && restMode(s) === 'hidden') s.hoverAt = now;
        if (s.open) s.open = { ...s.open, activeAt: now, leftAt: null };
        else {
          // Moving over news ("done", "error") makes it yours: it stays open like one
          // you opened. (A needs-you alert closes once it's answered.)
          const a = shownAlert(s);
          if (a && isNews(a) && prev.hover) {
            s.alerts = s.alerts.filter((x) => x !== a);
            s.open = { by: 'hover', at: now, activeAt: now };
          }
        }
      } else if (s.hover) {
        s.hover = false;
        s.armed = true;
        if (s.open) s.open = { ...s.open, leftAt: now };
        if (wasPeek) s.peekUntil = now + T.peekLinger;
      }
      break;
    case 'click':
      s.away = false;
      if (s.open) s.open = { ...s.open, activeAt: now };
      else s.open = { by: 'click', at: now, activeAt: now };
      break;
    case 'close':
      s.open = null;
      s.alerts = s.alerts.filter((a) => !isNews(a)).map((a) => (a.snoozed ? a : { ...a, snoozed: true }));
      s.peekUntil = 0;
      break;
    case 'tuck':
      s.tucked = !!ev.on;
      if (s.tucked) { s.open = null; s.peekUntil = 0; }
      break;
    case 'alert':
      if (ev.id != null && !s.alerts.some((a) => a.id === ev.id)) {
        s.alerts.push({ id: ev.id, kind: ['need', 'done', 'error'].includes(ev.kind) ? ev.kind : 'need', session: ev.session ?? null, at: now, shownAt: null, snoozed: false });
      }
      break;
    case 'resolve':
      s.alerts = s.alerts.filter((a) => (ev.id != null ? a.id !== ev.id : !(a.session === ev.session && (!ev.kind || a.kind === ev.kind))));
      break;
    default:
      break;
  }
  return settle(s, now, T, wasOpen);
}

/** Apply what time decides: dwells open it, news runs out, it closes by itself. */
function settle(s, now, T, wasOpen) {
  s.alerts = s.alerts.filter((a) => !isNews(a) || now - a.at < T.staleNews);
  // News on show gets its time from when it first showed; news pushed aside by a
  // needs-you alert starts over when it shows again.
  for (let guard = 0; guard < 50; guard++) {
    const a = shownAlert(s);
    s.alerts = s.alerts.map((x) => (x !== a && x.shownAt != null ? { ...x, shownAt: null } : x));
    const on = s.alerts.find((x) => x.id === a?.id);
    if (!on || !isNews(on)) break;
    if (on.shownAt == null) { s.alerts = s.alerts.map((x) => (x === on ? { ...x, shownAt: now } : x)); break; }
    if (now - on.shownAt < lasts(on, T)) break;
    s.alerts = s.alerts.filter((x) => x !== on);
  }
  const alert = shownAlert(s);
  // Opened by you: it closes 8 s after the pointer leaves, or after a quiet minute with the
  // pointer resting on it (not while someone needs you).
  if (s.open && alert?.kind !== 'need' && now >= closesAt(s, T)) s.open = null;
  // Once it closes, hovering where it was doesn't open it again until the pointer leaves.
  if (wasOpen && !s.open && !alert) { s.armed = !s.hover; s.peekUntil = 0; }
  // A hover that lasts opens it: briefly over the bar, a little longer over a peek.
  if (!s.open && !alert && s.hover && s.armed) {
    const rest = restMode(s);
    const dwell = rest === 'bar' ? T.barOpen : T.peekOpen;
    if (now - s.hoverAt >= dwell) s.open = { by: rest === 'bar' ? 'hover' : 'peek', at: now, activeAt: now };
  }
  return s;
}

/** Milliseconds until the state should be looked at again (Infinity: only events change it). */
export function nextWake(s, now, T = TIMING) {
  const at = [];
  const alert = shownAlert(s);
  if (!s.open && !alert && s.hover && s.armed) at.push(s.hoverAt + (restMode(s) === 'bar' ? T.barOpen : T.peekOpen));
  if (s.peekUntil > now) at.push(s.peekUntil);
  if (alert && isNews(alert) && alert.shownAt != null) at.push(alert.shownAt + lasts(alert, T));
  if (s.open && alert?.kind !== 'need') {
    const end = closesAt(s, T);
    at.push(end - T.countdown, end);
  }
  for (const a of s.alerts) if (isNews(a)) at.push(a.at + T.staleNews);
  const next = Math.min(...at.filter((t) => t > now));
  return Number.isFinite(next) ? Math.max(0, next - now) : Infinity;
}
