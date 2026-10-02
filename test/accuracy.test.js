// dotpals' claims against real requests a person checked by hand (test/accuracy/cases).
// A claim that's right must stay right: anything wrong that isn't in the baseline fails
// here. After a real improvement, `npm run accuracy -- --save` records the new baseline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCases, scoreAll, scoreCase } from './accuracy/claims.js';

const dir = fileURLToPath(new URL('./accuracy/cases', import.meta.url));
const baseline = JSON.parse(readFileSync(fileURLToPath(new URL('./accuracy/baseline.json', import.meta.url)), 'utf8'));

test('accuracy: no claim that was right has turned wrong (npm run accuracy)', () => {
  const cases = loadCases(dir);
  const score = scoreAll(cases);
  assert.ok(score.cases >= 20, 'the labeled cases are there');
  const known = new Set(baseline.wrong);
  const fresh = score.wrong.filter((w) => !known.has(`${w.case} ${w.kind} ${w.id}`));
  assert.deepEqual(fresh.map((w) => `${w.case} ${w.kind} ${w.id}: said ${JSON.stringify(w.said)}, really ${JSON.stringify(w.truth)}`), []);
  const knownUnsure = new Set(baseline.unsure);
  const freshUnsure = cases.flatMap((c) => scoreCase(c).filter((r) => r.result === 'unsure').map((r) => `${c.name} ${r.kind} ${r.id}`))
    .filter((id) => !knownUnsure.has(id));
  assert.deepEqual(freshUnsure, []);
  assert.ok(score.total.unsure <= baseline.total.unsure, `more "unsure" test results than the baseline (${score.total.unsure} > ${baseline.total.unsure})`);
});
