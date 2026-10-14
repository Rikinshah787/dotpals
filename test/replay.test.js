import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTurns } from '../bridge/ui/recap.js';
import { replay, replayLine } from '../bridge/ui/replay.js';

let n = 0;
const step = (kind, at, extra = {}) => ({ id: `s${n++}`, session: 'r', harness: 'claude', kind, status: 'ok', at, ...extra });
const prompt = (at, title = 'Fix the total') => step('prompt', at, { title, status: 'info' });
const edit = (at, path = 'src/total.js', patch = '-a\n+b') => step('edit', at, { title: path, files: [{ path: `/p/${path}`, change: 'edit' }], body: { patch } });
const npmTest = (at, ok) => step('run', at, { tool: 'Bash', title: 'npm test', status: ok ? 'ok' : 'failed', body: { command: 'npm test', output: ok ? 'Tests: 4 passed' : 'Tests: 1 failed, 3 passed' } });
const done = (at, summary = 'Fixed it.') => step('done', at, { title: 'Finished', summary });

test('replay: the request as frames, from the prompt to the end, with the moments that matter marked', () => {
  const [turn] = buildTurns([
    prompt(1000), edit(2000), npmTest(3000, false), edit(4000), npmTest(5000, true),
    step('run', 6000, { tool: 'Bash', title: 'git push --force', body: { command: 'git push --force origin main' } }),
    done(7000, 'Fixed the total and committed it.'),
  ]);
  const r = replay(turn);
  assert.equal(r.start, 1000);
  assert.equal(r.duration, 6000);
  assert.deepEqual(r.frames.map((f) => f.type), ['prompt', 'change', 'test', 'change', 'test', 'ship', 'end']);
  assert.deepEqual(r.frames.map((f) => f.t), [0, 1000, 2000, 3000, 4000, 5000, 6000]);
  assert.equal(r.frames[1].patch, '-a\n+b');
  assert.deepEqual(r.frames[1].files, [{ path: '/p/src/total.js', name: 'total.js', change: 'edit' }]);
  assert.equal(r.frames[2].test.state, 'failed');
  assert.equal(r.frames[2].output, 'Tests: 1 failed, 3 passed');
  assert.equal(r.frames[6].summary, 'Fixed the total and committed it.');
  // The marks: the failure, the fix, the run that counts, the force push, the claim.
  assert.deepEqual(r.marks.map((m) => [m.i, m.kind]), [[2, 'fail'], [4, 'fixed'], [4, 'tested'], [5, 'risky'], [6, 'claim']]);
  assert.equal(r.marks.find((m) => m.kind === 'fixed').text, 'Fixed on try 2');
  assert.match(r.marks.find((m) => m.kind === 'claim').text, /^Said it committed, but no commit ran$/);
  assert.equal(replayLine(r), '5 steps in 6.0s · 1 failure · 1 fix · 1 risky step · 1 claim that didn’t happen');
});

test('replay: a request still going has no end frame; one without a prompt starts at its first step', () => {
  const [live] = buildTurns([prompt(1000), edit(2000)]);
  const r = replay(live);
  assert.equal(r.end, null);
  assert.deepEqual(r.frames.map((f) => f.type), ['prompt', 'change']);
  assert.equal(replayLine(r), '1 step in 1.0s');
  const [bare] = buildTurns([edit(5000), done(6000)]);
  const b = replay(bare);
  assert.equal(b.start, 5000);
  assert.deepEqual(b.frames.map((f) => f.type), ['change', 'end']);
});

test('replay: a retry that never got fixed is marked as a try, not a fix', () => {
  const [turn] = buildTurns([prompt(1000), npmTest(2000, false), npmTest(3000, false), done(4000)]);
  const r = replay(turn);
  assert.deepEqual(r.marks.map((m) => m.kind), ['fail', 'fail', 'retry', 'tested']);
  assert.equal(r.marks.find((m) => m.kind === 'retry').text, 'Try 2');
});
