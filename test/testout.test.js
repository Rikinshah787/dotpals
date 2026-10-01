import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTestOutput } from '../bridge/ui/testout.js';

const counts = (out) => { const f = parseTestOutput(out); return [f.runner, f.passed, f.failed, f.errors, f.skipped]; };

test('parseTestOutput: JavaScript runners', () => {
  assert.deepEqual(counts('Test Suites: 1 failed, 3 passed, 4 total\nTests:       1 failed, 47 passed, 48 total\n  ● math › adds\n'), ['jest', 47, 1, 0, 0]);
  assert.deepEqual(parseTestOutput('  ● math › adds\nTests: 1 failed, 2 passed, 3 total').failing, ['math › adds']);
  assert.deepEqual(counts(' ✓ src/a.test.ts (3 tests)\n Test Files  1 passed (1)\n      Tests  3 passed | 1 skipped (4)\n'), ['vitest', 3, 0, 0, 1]);
  assert.deepEqual(counts('  12 passing (40ms)\n  2 pending\n  1 failing\n\n  1) Array\n       #indexOf():\n     Error: boom'), ['mocha', 12, 1, 0, 2]);
  assert.deepEqual(counts('✔ adds (0.5ms)\nℹ tests 104\nℹ pass 104\nℹ fail 0\nℹ skipped 0'), ['node:test', 104, 0, 0, 0]);
  assert.deepEqual(counts('not ok 3 - parses dates\n# tests 5\n# pass 4\n# fail 1'), ['node:test', 4, 1, 0, 0]);
  // A filtered summary ("npm test | Select-String pass") still counts.
  assert.deepEqual(counts('Exit code 255\nℹ pass 102\nℹ fail 0'), ['node:test', 102, 0, 0, 0]);
});

test('parseTestOutput: Python, Go, Rust, .NET, Java, PHP and Ruby', () => {
  assert.deepEqual(counts('tests/test_a.py ..F\nFAILED tests/test_a.py::test_div - ZeroDivisionError\n===== 1 failed, 2 passed in 0.31s ====='), ['pytest', 2, 1, 0, 0]);
  assert.deepEqual(parseTestOutput('FAILED tests/test_a.py::test_div - ZeroDivisionError\n===== 1 failed, 2 passed in 0.31s =====').failing, ['tests/test_a.py::test_div']);
  assert.deepEqual(counts('..s\n----------------------------------------------------------------------\nRan 3 tests in 0.002s\n\nOK (skipped=1)'), ['unittest', 2, 0, 0, 1]);
  assert.deepEqual(counts('FAIL: test_x (tests.T)\nRan 4 tests in 0.01s\n\nFAILED (failures=1)'), ['unittest', 3, 1, 0, 0]);
  assert.deepEqual(counts('--- FAIL: TestDiv (0.00s)\nFAIL\nFAIL\texample.com/m\t0.01s\nok  \texample.com/other\t0.02s'), ['go test', 1, 1, 0, 0]);
  assert.deepEqual(counts('test a ... ok\ntest b ... FAILED\ntest result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured'), ['cargo test', 3, 1, 0, 0]);
  assert.deepEqual(counts('Passed!  - Failed:     0, Passed:    12, Skipped:     1, Total:    13, Duration: 1 s'), ['dotnet test', 12, 0, 0, 1]);
  assert.deepEqual(counts('[INFO] Tests run: 9, Failures: 1, Errors: 0, Skipped: 2'), ['maven', 6, 1, 0, 2]);
  assert.deepEqual(counts('MathTest > adds() FAILED\n5 tests completed, 1 failed, 1 skipped'), ['gradle', 3, 1, 0, 1]);
  assert.deepEqual(counts('There was 1 failure:\n\n1) App\\MathTest::testAdd\nFAILURES!\nTests: 5, Assertions: 9, Failures: 1.'), ['phpunit', 4, 1, 0, 0]);
  assert.deepEqual(counts('Finished in 0.1 seconds\n10 examples, 2 failures, 1 pending\n\nrspec ./spec/a_spec.rb:4 # A works'), ['rspec', 7, 2, 0, 1]);
});

test('parseTestOutput: zero tests, only skipped, and nothing to read', () => {
  const none = parseTestOutput('============ no tests ran in 0.01s ============');
  assert.equal(none.parsed, true);
  assert.equal(none.total, 0);
  const jestNone = parseTestOutput('No tests found, exiting with code 1');
  assert.equal(jestNone.parsed, true);
  assert.equal(jestNone.passed, 0);
  const skipped = parseTestOutput('ℹ tests 3\nℹ pass 0\nℹ fail 0\nℹ skipped 3');
  assert.deepEqual([skipped.passed, skipped.skipped], [0, 3]);
  const plain = parseTestOutput('Compiling…\nDone.');
  assert.equal(plain.parsed, false);
  assert.equal(plain.runner, null);
  assert.equal(parseTestOutput('').parsed, false);
});

test('parseTestOutput: the worst case wins, and a type checker adds its errors', () => {
  // A passing summary doesn't hide a failure marker printed earlier.
  assert.equal(parseTestOutput('  ● suite › breaks\nTests:       0 failed, 5 passed, 5 total').failed, 1);
  const both = parseTestOutput('src/a.ts(3,5): error TS2322: Type mismatch.\nFound 1 error.\nℹ tests 4\nℹ pass 4\nℹ fail 0');
  assert.equal(both.passed, 4);
  assert.equal(both.errors, 1);
  assert.match(both.runner, /node:test/);
  // Colors don't get in the way.
  assert.equal(parseTestOutput('\u001b[32m===== 3 passed in 0.1s =====\u001b[0m').passed, 3);
  // A last resort for runners without their own parser (Playwright).
  assert.deepEqual(counts('  1 failed\n    [chromium] › a.spec.ts:3:1 › works\n  4 passed (3.0s)'), ['tests', 4, 1, 0, 0]);
});
