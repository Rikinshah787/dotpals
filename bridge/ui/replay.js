// Session replay: one request as a timeline you can step through, from the prompt to what the
// agent said at the end, with the moments worth stopping at marked (the first failure, each fix,
// risky steps, the test run that counted, claims that didn't happen). Plain functions over a
// turn (recap.js buildTurns), for the dashboard's replay view.
import { baseName, plural, secs, sentence } from './recap.js';
import { claimCheck, flags, retries, stepType, testVerdict, testWords } from './story.js';

const HIDDEN = new Set(['prompt', 'done', 'error', 'compact']);

/**
 * The request as frames, oldest first:
 *   { start, end, duration, frames: [{ i, at, t, kind, type, title, status, step, test?, files, patch?, output?, marks }], marks }
 * `t`: ms since the request started. `type`: stepType ('test', 'change', 'run', 'look'…).
 * `marks` on a frame: [{ kind, text }], kind one of 'fail' (a step that failed), 'retry'
 * (a try at something that failed), 'fixed', 'risky', 'tested' (the last test run, the one
 * that counts), 'claim' (on the end frame: something the summary said that didn't happen).
 * The top-level `marks`: the frames worth jumping to, [{ i, kind, text }].
 */
export function replay(turn) {
  const steps = [...turn.steps].filter((e) => !HIDDEN.has(e.kind)).sort((a, b) => a.at - b.at);
  const start = turn.prompt?.at ?? steps[0]?.at ?? turn.at;
  const frames = [];
  const push = (f) => frames.push({ i: frames.length, t: Math.max(0, f.at - start), files: [], marks: [], ...f });

  if (turn.prompt) push({ at: turn.prompt.at, kind: 'prompt', type: 'prompt', title: String(turn.prompt.title), status: 'info', step: turn.prompt.id });

  const { chains, retryOf } = retries(steps);
  const fixedBy = new Map(); // the step that fixed a chain → the chain
  for (const c of chains.values()) if (c.outcome === 'fixed') fixedBy.set(c.attempts.at(-1).id, c);
  const risky = new Map(); // step id → its warnings
  for (const f of flags(steps)) if (f.level === 'warn' && f.step) risky.set(f.step.id, [...(risky.get(f.step.id) ?? []), f.text]);
  const tests = steps.filter((e) => e.kind === 'run' && stepType(e) === 'test');
  const lastTest = tests.at(-1);

  for (const e of steps) {
    const type = stepType(e);
    const test = e.kind === 'run' && type === 'test' ? testVerdict(e) : null;
    const frame = {
      at: e.at, kind: e.kind, type, title: sentence(e), status: e.status, step: e.id,
      files: (e.files ?? []).filter((f) => f.change !== 'read').map((f) => ({ path: f.path, name: baseName(f.path), change: f.change })),
      ...(test ? { test: { state: test.state, words: testWords(test) } } : {}),
      ...(e.body?.patch ? { patch: e.body.patch } : {}),
      ...(e.body?.output ? { output: e.body.output } : {}),
      ...(e.ms != null ? { ms: e.ms } : {}),
    };
    push(frame);
    const f = frames.at(-1);
    const failed = e.status === 'failed' || test?.state === 'failed';
    if (failed) f.marks.push({ kind: 'fail', text: test ? test.words ?? testWords(test) : `Failed: ${f.title}` });
    const first = retryOf.get(e.id);
    if (first) {
      const c = chains.get(first);
      const n = c.attempts.findIndex((x) => x.id === e.id) + 1;
      if (fixedBy.get(e.id) === c) f.marks.push({ kind: 'fixed', text: `Fixed on try ${n}` });
      else f.marks.push({ kind: 'retry', text: `Try ${n}` });
    }
    for (const text of risky.get(e.id) ?? []) f.marks.push({ kind: 'risky', text });
    if (e === lastTest && test && test.state !== 'running') f.marks.push({ kind: 'tested', text: `The last test run: ${testWords(test)}` });
  }

  const end = turn.end;
  if (end) {
    push({ at: end.at, kind: end.kind, type: 'end', title: end.kind === 'error' ? `Stopped with an error: ${String(end.error || end.title || '').split('\n')[0]}` : 'Finished', status: end.status, step: end.id, ...(end.summary ? { summary: String(end.summary) } : {}) });
    const f = frames.at(-1);
    if (end.kind === 'done') for (const c of claimCheck(turn)) f.marks.push({ kind: 'claim', text: `Said it ${c.claim}, but ${c.found}` });
  }

  const last = frames.at(-1)?.at ?? start;
  return {
    start,
    end: end?.at ?? null,
    duration: Math.max(0, last - start),
    frames,
    marks: frames.flatMap((f) => f.marks.map((m) => ({ i: f.i, ...m }))),
  };
}

/** One line under the scrubber: "34 steps in 6m 12s · 2 failures · fixed on try 2 · 1 risky step". */
export function replayLine(r) {
  const n = r.frames.filter((f) => f.type !== 'prompt' && f.type !== 'end').length;
  const count = (kind) => r.marks.filter((m) => m.kind === kind).length;
  return [
    `${plural(n, 'step')}${r.duration ? ` in ${secs(r.duration)}` : ''}`,
    count('fail') ? plural(count('fail'), 'failure') : '',
    count('fixed') ? plural(count('fixed'), 'fix', 'fixes') : '',
    count('risky') ? plural(count('risky'), 'risky step') : '',
    count('claim') ? plural(count('claim'), 'claim that didn’t happen', 'claims that didn’t happen') : '',
  ].filter(Boolean).join(' · ');
}
