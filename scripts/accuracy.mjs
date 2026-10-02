#!/usr/bin/env node
// How often is dotpals right? Scores its claims (test results, risky steps, retries, ready
// to merge, why it stopped, what changed) against real requests a person checked by hand:
// test/accuracy/cases (add more with scripts/accuracy-capture.mjs).
//
//   npm run accuracy            the table, and every claim it gets wrong
//   npm run accuracy -- --json  the same as JSON
//   npm run accuracy -- --save  record today's score as the baseline the tests hold it to
//                               (test/accuracy.test.js: no claim that's right may turn wrong)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCases, scoreAll } from '../test/accuracy/claims.js';

const dir = fileURLToPath(new URL('../test/accuracy/cases', import.meta.url));
const score = scoreAll(loadCases(dir));
if (process.argv.includes('--save')) {
  const baseline = { total: score.total, byKind: score.byKind, wrong: score.wrong.map((w) => `${w.case} ${w.kind} ${w.id}`) };
  writeFileSync(fileURLToPath(new URL('../test/accuracy/baseline.json', import.meta.url)), `${JSON.stringify(baseline, null, 2)}\n`);
  console.log('Saved as the baseline (test/accuracy/baseline.json).\n');
}
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(score, null, 2));
} else {
  const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');
  const LABEL = { tests: 'Test results', risky: 'Risky steps', retries: 'Retries', ready: 'Ready to merge?', stopped: 'Why it stopped', changed: 'What changed' };
  const all = (k) => k.right + k.wrong + k.unsure;
  console.log(`dotpals accuracy: ${score.cases} real requests, ${all(score.total)} claims checked by hand\n`);
  console.log(`${'Claim'.padEnd(18)}${'Claims'.padStart(8)}${'Right'.padStart(8)}${'Wrong'.padStart(8)}${'Unsure'.padStart(8)}${'Accuracy'.padStart(10)}`);
  for (const [kind, k] of [...Object.entries(score.byKind), ['All', score.total]]) {
    console.log(`${(LABEL[kind] ?? kind).padEnd(18)}${String(all(k)).padStart(8)}${String(k.right).padStart(8)}${String(k.wrong).padStart(8)}${String(k.unsure).padStart(8)}${pct(k.right, all(k)).padStart(10)}`);
  }
  console.log('\nAccuracy = right / all. Unsure: a test result dotpals called unclear though a person can tell (a missing answer, not a false one).');
  if (score.wrong.length) {
    console.log(`\nWrong (${score.wrong.length}):`);
    for (const w of score.wrong) console.log(`  ${w.case}  ${w.kind} ${w.id}: said ${JSON.stringify(w.said)}, really ${JSON.stringify(w.truth)}`);
  }
}
