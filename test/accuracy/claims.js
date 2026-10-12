// The claims dotpals makes about a finished request, in a form a person can check one by
// one (test/accuracy/cases/*.json holds them, with the true answer for each):
//
//   tests    { stepId: 'passed' | 'failed' | 'unclear' }  each finished test run, by the rules alone (no checker)
//   risky    [text]                                        the warnings ("Force-pushed to git")
//   retries  { stepId: 'fixed' | 'failing' }               each failed step and what became of it
//   ready    true | false | null                           "Ready to merge?" (null: not asked, no code changed)
//   stopped  'done' | 'cut' | 'error' | 'gave-up' | 'failing' | 'question'   why it stopped
//   changed  [path]                                        project files it changed (only with git's snapshot)
//   weakened text | null                                   tests made to pass by changing them ("turned 1 test off … in math.test.js")
//   why      { stepId: text | null }                       each failed test run: why it failed, in the runner's words ("expected 3, got -1")
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flags, gitTruth, readiness, retries, stepType, testVerdict, weakenedTests, whyStopped } from '../../bridge/ui/story.js';
import { failureReason } from '../../bridge/ui/testout.js';

const finished = (e) => !['running', 'waiting'].includes(e.status);

export function claimsOf(turn) {
  const tests = {};
  const why = {};
  for (const e of turn.steps) {
    if (e.kind !== 'run' || stepType(e) !== 'test' || !finished(e)) continue;
    tests[e.id] = testVerdict({ ...e, check: undefined }).state;
    // The same reading the fix loop tells Claude (bridge/server.js, failedWhy).
    if (tests[e.id] === 'failed') why[e.id] = failureReason(`${e.body?.output ?? ''}\n${e.error ?? ''}`)?.why ?? null;
  }
  const retried = {};
  // Only real retries: "fixed on try 2", "still fails after 3 tries". A step that failed once is in `tests` or not a claim.
  for (const [id, chain] of retries(turn.steps).chains) if (chain.outcome !== 'trying' && chain.attempts.length > 1) retried[id] = chain.outcome;
  const r = readiness(turn);
  const truth = gitTruth(turn);
  return {
    tests,
    risky: flags(turn.steps).filter((f) => f.level === 'warn').map((f) => f.text).sort(),
    retries: retried,
    ready: r ? r.ready : null,
    stopped: whyStopped(turn, { live: false })?.kind ?? null,
    weakened: weakenedTests(turn.steps)?.text ?? null,
    why,
    ...(truth && !truth.tooMany ? { changed: truth.files.map((f) => f.path).sort() } : {}),
  };
}

/**
 * Score what dotpals says against the labeled truth: one result per claim,
 * { kind, id, said, truth, result: 'right' | 'wrong' | 'unsure' }. "Unsure" is a test run
 * dotpals called unclear though a person can tell, or a failed run it gave no reason for
 * though its output shows one: not a false claim, a missing answer.
 * A list (risky, changed) counts each item: what dotpals said that isn't true, and what's
 * true that it didn't say.
 */
export function scoreCase(c) {
  const said = claimsOf(c.turn);
  const out = [];
  const missing = (kind, s) => (kind === 'tests' && s === 'unclear') || (kind === 'why' && s === null);
  const add = (kind, id, s, t) => out.push({ kind, id, said: s, truth: t, result: s === t ? 'right' : missing(kind, s) ? 'unsure' : 'wrong' });
  for (const kind of ['tests', 'retries']) {
    for (const id of new Set([...Object.keys(c.truth[kind] ?? {}), ...Object.keys(said[kind])])) add(kind, id, said[kind][id] ?? null, c.truth[kind]?.[id] ?? null);
  }
  // Only the failed runs a person labeled a reason for (older cases have none).
  for (const id of Object.keys(c.truth.why ?? {})) add('why', id, said.why[id] ?? null, c.truth.why[id]);
  for (const kind of ['risky', 'changed']) {
    if (!(kind in c.truth)) continue;
    const s = new Set(said[kind] ?? []);
    const t = new Set(c.truth[kind]);
    for (const x of new Set([...s, ...t])) add(kind, x, s.has(x), t.has(x));
  }
  for (const kind of ['ready', 'stopped', 'weakened']) if (kind in c.truth) add(kind, kind, said[kind], c.truth[kind]);
  return out;
}

/** Read the labeled cases in `dir`: [case]. Unlabeled ones (not checked by a person yet) don't count. */
export function loadCases(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))).filter((c) => c.labeled === true);
}

/** Score every case: { total: { right, wrong, unsure }, byKind: { kind: { right, wrong, unsure } }, wrong: [{ case, kind, id, said, truth }], unsure: [the same] }. */
export function scoreAll(cases) {
  const total = { right: 0, wrong: 0, unsure: 0 };
  const byKind = {};
  const wrong = [];
  const unsure = [];
  for (const c of cases) {
    for (const r of scoreCase(c)) {
      total[r.result]++;
      (byKind[r.kind] ??= { right: 0, wrong: 0, unsure: 0 })[r.result]++;
      if (r.result !== 'right') (r.result === 'wrong' ? wrong : unsure).push({ case: c.name, kind: r.kind, id: r.id, said: r.said, truth: r.truth });
    }
  }
  return { cases: cases.length, total, byKind, wrong, unsure };
}
