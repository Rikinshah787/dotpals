import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMING as T, derive, initialState, nextWake, reduce, shownAlert } from '../bridge/ui/notch-state.js';
import { diffOf, language } from '../bridge/ui/notch-diff.js';

/** Run events through the machine: [time, event] pairs, from a starting state. */
function run(steps, s = initialState()) {
  for (const [at, ev] of steps) s = reduce(s, ev, at);
  return s;
}
const mode = (s, at) => derive(s, at).mode;
const tick = { type: 'tick' };
const inside = { type: 'pointer', inside: true };
const outside = { type: 'pointer', inside: false };

test('hidden with nothing running, a bar while agents work, hidden again when you are away', () => {
  let s = initialState();
  assert.equal(mode(s, 0), 'hidden');
  s = reduce(s, { type: 'agents', running: 2 }, 0);
  assert.equal(mode(s, 0), 'bar');
  s = reduce(s, { type: 'idle', seconds: 179 }, 1000);
  assert.equal(mode(s, 1000), 'bar');
  s = reduce(s, { type: 'idle', seconds: 180 }, 2000);
  assert.equal(mode(s, 2000), 'hidden');
  s = reduce(s, outside, 3000); // the mouse moved: you're back
  assert.equal(mode(s, 3000), 'bar');
  s = reduce(s, { type: 'agents', running: 0 }, 4000);
  assert.equal(mode(s, 4000), 'hidden');
});

test('minimized, the bar hides while agents work; alerts and the top-edge peek still show', () => {
  let s = run([[0, { type: 'agents', running: 1 }], [10, { type: 'click' }]]);
  assert.equal(mode(s, 10), 'open');
  s = reduce(s, { type: 'tuck', on: true }, 20); // minimizing also closes it
  assert.equal(mode(s, 20), 'hidden');
  s = reduce(s, outside, 30);
  s = reduce(s, inside, 40); // the top edge still peeks, and opens after a dwell
  assert.equal(mode(s, 40), 'peek');
  s = reduce(s, tick, 40 + T.peekOpen);
  assert.equal(mode(s, 40 + T.peekOpen), 'open');
  s = reduce(s, { type: 'close' }, 1000);
  s = reduce(s, { type: 'alert', id: 'a', kind: 'need', session: 'x' }, 1100);
  assert.equal(mode(s, 1100), 'open'); // someone needs you: it still shows
  s = reduce(s, { type: 'resolve', id: 'a' }, 1200);
  s = reduce(s, outside, 1300);
  assert.equal(mode(s, 1300), 'hidden');
  s = reduce(s, { type: 'tuck', on: false }, 1400);
  assert.equal(mode(s, 1400), 'bar');
});

test('hovering the hidden strip peeks at once, opens after a dwell, and hides again if you leave', () => {
  let s = run([[0, inside]]);
  assert.equal(mode(s, 0), 'peek');
  s = reduce(s, tick, T.peekOpen - 1);
  assert.equal(mode(s, T.peekOpen - 1), 'peek');
  assert.equal(nextWake(s, T.peekOpen - 1), 1);
  s = reduce(s, tick, T.peekOpen);
  assert.equal(mode(s, T.peekOpen), 'open');
  assert.equal(derive(s, T.peekOpen).by, 'peek');

  // Left during the peek: it lingers a moment, then hides.
  s = run([[0, inside], [200, outside]]);
  assert.equal(mode(s, 200), 'peek');
  assert.equal(nextWake(s, 200), T.peekLinger);
  s = reduce(s, tick, 200 + T.peekLinger);
  assert.equal(mode(s, 200 + T.peekLinger), 'hidden');
  // …and a later hover starts the dwell over.
  s = run([[1000, inside], [1000 + T.peekOpen - 50, tick]], s);
  assert.equal(mode(s, 1000 + T.peekOpen - 50), 'peek');
});

test('a peek only opens once the pointer rests: sliding along the top edge keeps it a peek', () => {
  const slide = { type: 'pointer', inside: true, restless: true };
  let s = run([[0, inside], [300, slide], [600, slide], [900, slide], [900 + T.peekOpen - 10, tick]]);
  assert.equal(mode(s, 900 + T.peekOpen - 10), 'peek');
  s = reduce(s, tick, 900 + T.peekOpen);
  assert.equal(mode(s, 900 + T.peekOpen), 'open');
  // Over the bar, moving about doesn't matter: it opens after its short hover.
  s = run([[0, { type: 'agents', running: 1 }], [0, inside], [100, slide], [T.barOpen, tick]]);
  assert.equal(mode(s, T.barOpen), 'open');
});

test('the bar opens after a short hover, or at once on a click; a brush past does nothing', () => {
  const working = run([[0, { type: 'agents', running: 1 }]]);
  let s = run([[100, inside], [100 + T.barOpen - 20, outside], [1000, tick]], working);
  assert.equal(mode(s, 1000), 'bar');
  s = run([[100, inside], [100 + T.barOpen, tick]], working);
  assert.equal(mode(s, 100 + T.barOpen), 'open');
  assert.equal(derive(s, 100 + T.barOpen).by, 'hover');
  s = run([[100, { type: 'click' }]], working);
  assert.equal(derive(s, 100).by, 'click');
});

test('open with the pointer resting on it, it closes after a quiet minute, with a countdown in the last 10 s', () => {
  let s = run([[0, { type: 'agents', running: 1 }], [0, { type: 'click' }]]);
  assert.equal(derive(s, 1000).countdown, null);
  assert.equal(nextWake(s, 1000), T.autoClose - T.countdown - 1000);
  // Moving over it starts the minute again; the pointer stays there.
  s = reduce(s, inside, 30_000);
  const end = 30_000 + T.autoClose;
  s = reduce(s, tick, end - T.countdown);
  assert.deepEqual(derive(s, end - T.countdown).countdown, { start: end - T.countdown, end });
  s = reduce(s, tick, end - 1);
  assert.equal(mode(s, end - 1), 'open');
  s = reduce(s, tick, end);
  assert.equal(mode(s, end), 'bar');
});

test('open, it closes a few seconds after the pointer leaves (it covers tabs and title bars)', () => {
  let s = run([[0, { type: 'agents', running: 1 }], [0, inside], [T.barOpen, tick]]);
  assert.equal(mode(s, T.barOpen), 'open');
  s = reduce(s, outside, 5000);
  assert.equal(mode(s, 5000), 'open');
  assert.deepEqual(derive(s, 5000).countdown, { start: 5000, end: 5000 + T.afterLeave });
  // Coming back keeps it open.
  s = reduce(s, inside, 9000);
  assert.equal(derive(s, 9000).countdown, null);
  s = reduce(s, outside, 10_000);
  s = reduce(s, tick, 10_000 + T.afterLeave - 1);
  assert.equal(mode(s, 10_000 + T.afterLeave - 1), 'open');
  s = reduce(s, tick, 10_000 + T.afterLeave);
  assert.equal(mode(s, 10_000 + T.afterLeave), 'bar');
});

test('Esc closes it, and hovering where it was doesn’t reopen it until the pointer leaves', () => {
  let s = run([[0, { type: 'agents', running: 1 }], [0, inside], [T.barOpen, tick]]);
  assert.equal(mode(s, T.barOpen), 'open');
  s = reduce(s, { type: 'close' }, 1000);
  assert.equal(mode(s, 1000), 'bar');
  s = run([[1100, inside], [5000, tick]], s);
  assert.equal(mode(s, 5000), 'bar');
  s = run([[6000, outside], [7000, inside], [7000 + T.barOpen, tick]], s);
  assert.equal(mode(s, 7000 + T.barOpen), 'open');
});

test('a needs-you alert opens it by itself, even when you are away, and stays until answered', () => {
  let s = run([[0, { type: 'agents', running: 1 }], [0, { type: 'idle', seconds: 600 }]]);
  assert.equal(mode(s, 0), 'hidden');
  s = reduce(s, { type: 'alert', id: 'ap:1', kind: 'need', session: 'a' }, 10);
  let v = derive(s, 10);
  assert.equal(v.mode, 'open');
  assert.equal(v.by, 'alert');
  assert.equal(v.alert.id, 'ap:1');
  assert.equal(v.countdown, null);
  // No auto-close while someone needs you, even after moving over it.
  s = run([[20, inside], [40, inside], [10 + 5 * T.autoClose, tick]], s);
  assert.equal(mode(s, 10 + 5 * T.autoClose), 'open');
  s = reduce(s, { type: 'resolve', id: 'ap:1' }, 10 + 5 * T.autoClose);
  assert.equal(mode(s, 10 + 5 * T.autoClose), 'bar');
  // The pointer is still there: answering doesn't bounce it open again.
  s = reduce(s, tick, 20 + 6 * T.autoClose);
  assert.equal(mode(s, 20 + 6 * T.autoClose), 'bar');
});

test('Esc sets a needs-you alert aside; opening the notch shows it again', () => {
  let s = run([[0, { type: 'agents', running: 1 }], [0, { type: 'alert', id: 'w', kind: 'need', session: 'a' }]]);
  s = reduce(s, { type: 'close' }, 100);
  assert.equal(mode(s, 100), 'bar');
  assert.equal(derive(s, 100).queued, 1);
  s = run([[200, inside], [200 + T.barOpen, tick]], s);
  const v = derive(s, 200 + T.barOpen);
  assert.equal(v.mode, 'open');
  assert.equal(v.alert.id, 'w');
});

test('done opens it for a few seconds, then it closes by itself', () => {
  let s = run([[0, { type: 'agents', running: 0 }], [0, { type: 'alert', id: 'done:a', kind: 'done', session: 'a' }]]);
  let v = derive(s, 0);
  assert.equal(v.mode, 'open');
  assert.deepEqual(v.countdown, { start: 0, end: T.doneFor });
  assert.equal(nextWake(s, 0), T.doneFor);
  s = reduce(s, tick, T.doneFor);
  assert.equal(mode(s, T.doneFor), 'hidden');
  assert.equal(s.alerts.length, 0);
  // An error stays a little longer.
  s = run([[0, { type: 'alert', id: 'err:a', kind: 'error', session: 'a' }], [T.doneFor, tick]]);
  assert.equal(mode(s, T.doneFor), 'open');
  s = reduce(s, tick, T.errorFor);
  assert.equal(mode(s, T.errorFor), 'hidden');
});

test('moving over a done alert keeps it open like one you opened', () => {
  let s = run([[0, { type: 'alert', id: 'd', kind: 'done', session: 'a' }], [1000, inside], [1500, inside]]);
  assert.equal(derive(s, 1500).by, 'hover');
  s = reduce(s, tick, T.doneFor + 100);
  assert.equal(mode(s, T.doneFor + 100), 'open');
  s = reduce(s, tick, 1500 + T.autoClose);
  assert.equal(mode(s, 1500 + T.autoClose), 'hidden');
});

test('news waits while you are away and shows when you come back', () => {
  let s = run([[0, { type: 'idle', seconds: 400 }], [0, { type: 'alert', id: 'd', kind: 'done', session: 'a' }]]);
  assert.equal(mode(s, 0), 'hidden');
  s = reduce(s, tick, 60_000);
  assert.equal(mode(s, 60_000), 'hidden');
  s = reduce(s, { type: 'idle', seconds: 0 }, 90_000);
  assert.equal(derive(s, 90_000).alert.id, 'd');
  s = reduce(s, tick, 90_000 + T.doneFor);
  assert.equal(mode(s, 90_000 + T.doneFor), 'hidden');
  // Too old to be worth showing.
  s = run([[0, { type: 'idle', seconds: 400 }], [0, { type: 'alert', id: 'd', kind: 'done' }], [T.staleNews, { type: 'idle', seconds: 0 }]]);
  assert.equal(s.alerts.length, 0);
});

test('alerts queue and show one at a time: needs-you first, then news in order', () => {
  let s = run([
    [0, { type: 'agents', running: 2 }],
    [0, { type: 'alert', id: 'done:a', kind: 'done', session: 'a' }],
    [1000, { type: 'alert', id: 'ap:1', kind: 'need', session: 'b' }],
    [1100, { type: 'alert', id: 'ap:2', kind: 'need', session: 'c' }],
    [1200, { type: 'alert', id: 'ap:1', kind: 'need', session: 'b' }], // the same one again: ignored
  ]);
  let v = derive(s, 1200);
  assert.equal(v.alert.id, 'ap:1');
  assert.equal(v.queued, 2);
  s = reduce(s, { type: 'resolve', id: 'ap:1' }, 2000);
  assert.equal(derive(s, 2000).alert.id, 'ap:2');
  s = reduce(s, { type: 'resolve', session: 'c' }, 3000);
  v = derive(s, 3000);
  assert.equal(v.alert.id, 'done:a');
  // The done that was pushed aside gets its full time again.
  s = reduce(s, tick, 3000 + T.doneFor - 1);
  assert.equal(derive(s, 3000 + T.doneFor - 1).alert.id, 'done:a');
  s = reduce(s, tick, 3000 + T.doneFor);
  assert.equal(derive(s, 3000 + T.doneFor).mode, 'bar');
  assert.equal(shownAlert(s), null);
});

test('resolving by session and kind only drops those alerts', () => {
  let s = run([
    [0, { type: 'alert', id: 'wait:a', kind: 'need', session: 'a' }],
    [0, { type: 'alert', id: 'done:a', kind: 'done', session: 'a' }],
    [0, { type: 'alert', id: 'done:b', kind: 'done', session: 'b' }],
  ]);
  s = reduce(s, { type: 'resolve', session: 'a', kind: 'done' }, 10);
  assert.deepEqual(s.alerts.map((a) => a.id), ['wait:a', 'done:b']);
  s = reduce(s, { type: 'resolve', session: 'a' }, 20);
  assert.deepEqual(s.alerts.map((a) => a.id), ['done:b']);
});

test('nextWake is Infinity when only events can change anything', () => {
  assert.equal(nextWake(initialState(), 0), Infinity);
  assert.equal(nextWake(run([[0, { type: 'agents', running: 3 }]]), 0), Infinity);
});

test('diffOf shows an edit around its first change, with the newest added line typing', () => {
  const d = diffOf('-const TVA = 0.196\n+const TVA = 0.2\n+const RATE = TVA');
  assert.deepEqual(d.lines.map((l) => l.sign + l.text), ['-const TVA = 0.196', '+const TVA = 0.2', '+const RATE = TVA']);
  assert.equal(d.add, 2);
  assert.equal(d.del, 1);
  assert.equal(d.typing, 2);
  assert.equal(d.more, 0);
  assert.equal(d.path, null);

  const long = diffOf(Array.from({ length: 30 }, (_, i) => `+line ${i}`).join('\n'), { max: 5 });
  assert.equal(long.lines.length, 5);
  assert.equal(long.more, 25);
  assert.equal(long.typing, 4);
});

test('diffOf reads Codex patches and unified diffs, taking the last file', () => {
  const codex = diffOf([
    '*** Begin Patch', '*** Update File: src/a.js', '@@', ' keep', '-old', '+new',
    '*** Add File: src/b.ts', '+export const b = 1;', '*** End Patch',
  ].join('\n'));
  assert.equal(codex.path, 'src/b.ts');
  assert.deepEqual(codex.lines.map((l) => l.sign + l.text), ['+export const b = 1;']);

  const unified = diffOf(['--- a/app.py', '+++ b/app.py', '@@ -1,3 +1,3 @@', ' import os', '-x = 1', '+x = 2', ' print(x)'].join('\n'));
  assert.equal(unified.path, 'app.py');
  assert.deepEqual(unified.lines.map((l) => l.sign + l.text), [' import os', '-x = 1', '+x = 2', ' print(x)']);
  assert.equal(unified.typing, 2);

  // MultiEdit's "@@" separators stay as a break; clipText's marker is dropped.
  const multi = diffOf('-a\n+b\n@@\n-c\n+d\n… (120 more characters)');
  assert.deepEqual(multi.lines.map((l) => l.sign), ['-', '+', '@', '-', '+']);
  assert.equal(diffOf('').lines.length, 0);
});

test('language gives a short chip for a file', () => {
  assert.deepEqual(language('src/invoice.ts'), { label: 'TS', color: '#3178c6' });
  assert.equal(language('C:\\proj\\main.py').label, 'PY');
  assert.equal(language('Dockerfile').label, 'DOCKER');
  assert.equal(language('notes.weird').label, 'WEIRD');
  assert.equal(language('Makefile'), null);
  assert.equal(language(''), null);
});
