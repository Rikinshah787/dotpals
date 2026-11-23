import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECORDS_FROM, WORKER_BUILD, phoneRecord, pushList, pushVerdict, workerNote } from '../bridge/remote/push-words.js';

const NOW = 1_000_000;
const sent = (over = {}) => ({ at: NOW - 60_000, ok: true, status: 201, ...over });

test('the computer says what it knows: accepted, then what the phone said about it', () => {
  assert.match(pushVerdict(null, ''), /Nothing has been sent/);
  assert.match(pushVerdict(sent({ ok: false, status: 410 }), '1:00', NOW), /Acceptance not confirmed: the push service said 410/);
  assert.match(pushVerdict(sent({ ack: { shown: true } }), '1:00', NOW), /browser accepted.*OS popup is not confirmed/);
  assert.match(pushVerdict(sent({ ok: null }), '1:00', NOW), /Waiting for the push service/);
  assert.match(pushVerdict(sent({ ack: { held: true } }), '1:00', NOW), /held it back because the app was open/);
  assert.match(pushVerdict(sent({ ack: { shown: false, error: 'blocked' } }), '1:00', NOW), /couldn’t show it \(blocked\)/);
  assert.match(pushVerdict(sent({ at: NOW - 3000 }), '1:00', NOW), /Waiting to hear from your phone/);
  const never = pushVerdict(sent(), '1:00', NOW);
  assert.match(never, /accepted by the push service, but no receipt has reached the computer/);
  assert.doesNotMatch(never, /battery/i, 'the computer cannot know why: the next line (what the phone saw) is what decides');
});

test('phone-local records establish receipt, but missing records are inconclusive', () => {
  const lp = sent({ at: 5000 });
  const none = phoneRecord(null, lp);
  assert.match(none, /No push is recorded.*does not prove non-delivery/);
  // Started keeping a record at a known time: the line says since when.
  assert.match(phoneRecord(null, lp, 3000), /recorded on this phone since .*when this copy of the app started keeping a record/);
  // A copy that took over AFTER the test was sent can't speak for that test, and says so instead of blaming anything.
  const late = phoneRecord(null, sent({ at: 5000 }), 9000);
  assert.match(late, /started keeping a record at .*after the last test was sent/);
  assert.match(late, /Press Send a test again/);
  assert.doesNotMatch(late, /battery|never reached/i);
  // It got the one just sent and showed it, but could not tell the computer.
  const told = phoneRecord({ at: 6000, sentAt: 5000, phase: 'done', shown: true, held: false, error: '', permission: 'granted', ackStatus: 0 }, lp);
  assert.match(told, /the one you just sent\): the browser accepted/);
  assert.match(told, /could not reach the computer to say so/);
  // Got it, the browser refused to show it.
  const refused = phoneRecord({ at: 6000, sentAt: 5000, phase: 'done', shown: false, error: 'No permission', permission: 'denied', ackStatus: 200 }, lp);
  assert.match(refused, /could not show it \(No permission\)/);
  assert.match(refused, /Notifications are denied for this app/);
  assert.doesNotMatch(refused, /could not tell the computer/, 'the ack went through');
  // Died between arriving and showing.
  assert.match(phoneRecord({ at: 6000, sentAt: 5000, phase: 'received', permission: 'granted' }, lp), /received it, but stopped before showing it/);
  // Held because the app was open.
  assert.match(phoneRecord({ at: 6000, sentAt: 5000, phase: 'done', held: true, permission: 'granted', ackStatus: 200 }, lp), /held it back because the app was open/);
  // A push from an earlier time is not mistaken for the test just sent.
  const older = phoneRecord({ at: 1000, sentAt: 900, phase: 'done', shown: true, permission: 'granted', ackStatus: 200 }, lp);
  assert.match(older, /a different push, not the latest send/);
  // The server says it couldn't be reached (a status instead of a network error).
  assert.match(phoneRecord({ at: 6000, sentAt: 5000, phase: 'done', shown: true, permission: 'granted', ackStatus: 401 }, lp), /could not tell the computer \(401\)/);
});

test('clock differences never become delivery latency or a battery-saving diagnosis', () => {
  for (const at of [90_000, 145_000, 300_000, 18_100_000]) {
    const text = phoneRecord({ at, sentAt: 100_000, phase: 'done', shown: true, ackStatus: 200 }, sent({ at: 100_000 }));
    assert.match(text, /OS popup is not confirmed/);
    assert.doesNotMatch(text, /battery|holding pushes|reached the phone .* after/i);
  }
});

test('the recent pushes are listed one by one, so two tests pressed close together can be told apart', () => {
  const now = 1_000_000;
  const lines = pushList([
    { at: now - 20_000, kind: 'done', test: true, ok: true, status: 201 },
    { at: now - 70_000, kind: 'done', test: true, ok: true, status: 201, ack: { at: now - 25_000, shown: true } },
    { at: now - 400_000, kind: 'stuck', ok: true, status: 201 },
    { at: now - 500_000, kind: 'done', ok: false, status: 410 },
    { at: now - 600_000, kind: 'done', test: true, ok: true, status: 201, ack: { at: now - 590_000, shown: false, error: 'blocked' } },
  ], now);
  assert.equal(lines.length, 5);
  assert.match(lines[0], /test: sent 20 s ago, waiting for the phone/);
  assert.match(lines[1], /test: receipt reached computer 45 s after send, display request accepted by browser\. This is not delivery latency\./);
  assert.match(lines[2], /stuck: accepted by the push service, but the phone has not confirmed it \(7 min so far\)/);
  assert.match(lines[3], /acceptance not confirmed \(the push service said 410\)/);
  assert.match(lines[4], /not shown \(blocked\)/);
  assert.deepEqual(pushList([], now), []);
  assert.deepEqual(pushList(undefined, now), []);
  assert.equal(pushList(Array.from({ length: 9 }, (_, i) => ({ at: now - i * 1000, kind: 'done', ok: true, status: 201 })), now).length, 5, 'at most five lines');
});

test('an older copy of the app keeps no record, so an empty one is never read as "nothing arrived"', () => {
  const lp = sent({ at: 5000 });
  for (const build of [0, 1]) {
    const said = phoneRecord(null, lp, 0, build);
    assert.ok(build < RECORDS_FROM);
    assert.match(said, /^Can’t say yet/);
    assert.match(said, /may keep no push record/);
    assert.doesNotMatch(said, /battery|never reached|has not received/i, 'it must not blame the phone for what it could not have recorded');
  }
  // Once the copy does keep a record, empty does mean something.
  assert.match(phoneRecord(null, lp, 0, RECORDS_FROM), /No push is recorded/);
  assert.match(phoneRecord(null, lp), /No push is recorded/, 'the current build by default');
});

test('the phone says which copy of the app it is really running, and whether it is behind', () => {
  assert.match(workerNote('0.14.2', null), /Worker version unavailable/);
  assert.match(workerNote('0.14.2', { version: null }), /Worker version unavailable/);
  // Same release number, older behaviour: the version string alone would have said "the same as your computer".
  assert.match(workerNote('0.14.1', { version: '0.14.1', build: 1 }), /older copy of the app/);
  assert.match(workerNote('0.14.1', { version: '0.14.1' }), /older copy of the app/, 'no build at all means an old worker');
  assert.match(workerNote('0.14.1', { version: '0.14.1', build: WORKER_BUILD }), /the same as your computer/);
  assert.match(workerNote('0.14.2', { version: '0.14.1', build: WORKER_BUILD }), /your computer has 0\.14\.2/);
});

test('the worker is registered, checked and updated in ONE place (updater.js), not also by client.js', async () => {
  const { readFileSync } = await import('node:fs');
  const client = readFileSync(new URL('../bridge/remote/client.js', import.meta.url), 'utf8');
  // Seen on a phone: the app kept showing the previous version after being closed and reopened. The first fix reloaded on every
  // takeover; it is replaced by an explicit check + an Update the person chooses (updater.js). Two registrations would fight.
  assert.ok(client.includes("import './update-ui.js'"));
  assert.doesNotMatch(client, /serviceWorker\.register\(/, 'registered by updater.js only');
  assert.doesNotMatch(client, /controllerchange[^\n]*location\.reload/, 'subscription repair does not reload the page');
  assert.doesNotMatch(client, /location\.reload\(\)\s*;?\s*\}\);?\s*\n\s*navigator/);
});

test('the page and the worker agree on the build number', async () => {
  const { readFileSync } = await import('node:fs');
  const sw = readFileSync(new URL('../bridge/remote/sw.js', import.meta.url), 'utf8');
  assert.equal(Number(/const BUILD = (\d+);/.exec(sw)?.[1]), WORKER_BUILD);
  assert.ok(sw.includes('/bridge/remote/push-words.js'), 'cached with the rest of the app');
  const settings = readFileSync(new URL('../bridge/remote/settings.js', import.meta.url), 'utf8');
  assert.match(settings, /import \{ phoneRecord, pushList, pushVerdict, workerNote \} from '\.\/push-words\.js'/);
  assert.ok(settings.includes("caches.open('dotpals-push-log')"), 'reads the worker’s own record');
  // Found in a real browser: the page drew itself before the read finished and told a phone that had received the push
  // that it "has not received any push". The read must finish first.
  assert.match(settings, /me = await call\('\/api\/remote\/me'\); await readPhone\(\); draw\(\);/);
  assert.ok(sw.includes("const LOG = 'dotpals-push-log'"), 'and the worker writes the same one');
});
