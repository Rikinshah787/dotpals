// What Settings → Remote says about a push, in words. Pure functions (no page needed), so what a person is told when
// "the test didn't show" can be tested. The facts come from two sides:
//   `lp`   the COMPUTER's: what the push service answered, and the phone's acknowledgement when one came (`lp.ack`)
//   `last` the PHONE's own record of the last push its service worker received (kept on the phone, read by the page)

/** The service worker's behaviour version: bumped in sw.js (BUILD) when what it does changes, so a stale copy can be told apart. */
export const WORKER_BUILD = 9;
/** The first build that keeps a record of the pushes it receives. An older copy keeps none, so an empty record means nothing there. */
export const RECORDS_FROM = 2;

const clock = (at) => new Date(at).toLocaleTimeString();

/** One line on the last push, from the computer's side. `time` is how to write when it was sent. */
export function pushVerdict(lp, time, now = Date.now()) {
  if (!lp) return 'Nothing has been sent to this device since dotpals started.';
  const a = lp.ack;
  if (a?.shown) return `Sent ${time}. Your phone received it and the browser accepted the notification display request; an OS popup is not confirmed.`;
  if (a?.held) return `Sent ${time}. Your phone received it but held it back because the app was open and in front.`;
  if (a) return `Sent ${time}. Your phone received it but couldn’t show it${a.error ? ` (${a.error})` : ''}. Check the browser and OS notification settings.`;
  if (lp.ok === null) return `Sending ${time}. Waiting for the push service…`;
  if (!lp.ok) return `Acceptance not confirmed: the push service said ${lp.status || 'nothing'} (${time}).`;
  if (now - lp.at < 15_000) return `Sent ${time}. Waiting to hear from your phone…`;
  return `Sent ${time} and accepted by the push service, but no receipt has reached the computer. Delivery or the return connection may be delayed; check the phone-local record below.`;
}

/**
 * What the phone itself says about the last push it received (`last`: { at, sentAt, phase, shown, held, error, permission,
 * ackStatus }, or null), set against the computer's last send (`lp`). Missing records are inconclusive: old workers,
 * unavailable/evicted storage, delivery and return connectivity all matter.
 */
export function phoneRecord(last, lp, since = 0, build = WORKER_BUILD) {
  if (!last) {
    // An older copy of the app keeps no record, so "nothing recorded" says nothing about the phone: don't blame it.
    if (build < RECORDS_FROM) return 'Can’t say yet. This worker is old or its build could not be read; it may keep no push record. Use Check for updates, then Update if offered.';
    // A copy of the app that started AFTER the test was sent can't say anything about it, and says so.
    if (since && lp && since > lp.at) return `This copy of the app started keeping a record at ${clock(since)}, after the last test was sent (${clock(lp.at)}), so it can’t say about that one. Press Send a test again.`;
    const from = since ? ` since ${clock(since)}, when this copy of the app started keeping a record` : '';
    return `No push is recorded on this phone${from}. This does not prove non-delivery: storage may be unavailable or cleared, or a different worker may have handled it. Check the worker build, connectivity and browser/OS notification settings.`;
  }
  const mine = lp && last.sentAt && last.sentAt === lp.at;
  const when = `${clock(last.at)}${mine ? ' (the one you just sent)' : lp ? ' (a different push, not the latest send)' : ''}`;
  const did = last.held ? 'held it back because the app was open and in front'
    : last.shown ? 'the browser accepted the notification display request (an OS popup is not confirmed)'
      : last.phase === 'received' ? 'received it, but stopped before showing it'
        : `could not show it${last.error ? ` (${last.error})` : ''}`;
  const perm = last.permission && last.permission !== 'granted' ? ` Notifications are ${last.permission} for this app: allow them in the browser’s site settings.` : '';
  const told = last.ackStatus === 200 ? '' : last.ackStatus ? ` It could not tell the computer (${last.ackStatus}).` : last.phase === 'done' ? ' It could not reach the computer to say so.' : '';
  return `The last push this phone recorded was at ${when}: ${last.shown ? '' : 'it '}${did}.${perm}${told}`;
}

/**
 * The last few pushes, one line each, newest first: what happened to EACH, so two tests pressed close together can be told
 * apart (the page used to show only the newest, and a receipt for the one before it had nowhere to go).
 * `pushes`: [{ at, kind, test, ok, status, ack? }] from the computer. `ack.at` is when the computer heard back from the phone.
 */
export function pushList(pushes, now = Date.now(), max = 5) {
  return (pushes ?? []).slice(0, max).map((p) => {
    const what = p.test ? 'test' : p.kind;
    const head = `${clock(p.at)} ${what}`;
    if (p.ack) {
      const s = Math.max(0, Math.round((p.ack.at - p.at) / 1000));
      const how = p.ack.shown ? 'display request accepted by browser' : p.ack.held ? 'held back because the app was open' : `not shown${p.ack.error ? ` (${p.ack.error})` : ''}`;
      return `${head}: receipt reached computer ${s} s after send, ${how}. This is not delivery latency.`;
    }
    if (p.ok === null) return `${head}: waiting for push service…`;
    if (!p.ok) return `${head}: acceptance not confirmed (the push service said ${p.status || 'nothing'}).`;
    const waited = Math.round((now - p.at) / 1000);
    return waited < 90 ? `${head}: sent ${waited} s ago, waiting for the phone…` : `${head}: accepted by the push service, but the phone has not confirmed it (${waited < 3600 ? `${Math.round(waited / 60)} min` : 'over an hour'} so far).`;
  });
}

/** Which service worker the phone is really running, and whether it is the current one. */
export function workerNote(server, w) {
  if (!w?.version) return 'Worker version unavailable. Use Check for updates, then Update if offered; if registration failed, reload and check connectivity.';
  if ((w.build ?? 1) < WORKER_BUILD) return `Version ${w.version}, build ${w.build ?? 1}: an older copy of the app. Use Check for updates, then Update if offered.`;
  return w.version === server ? `Version ${w.version}, build ${w.build}, the same as your computer.` : `Version ${w.version}, but your computer has ${server}. Use Check for updates, then Update if offered.`;
}
