import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChecker, evidenceOf, QUESTIONS, shouldCheck, stateOf, THRESHOLDS } from '../bridge/checker.js';
import { redactText } from '../bridge/redact.js';

const KEY = ['apikey', '0'.repeat(16), 'f'.repeat(16)].join('_'); // fake, built at run time so secret scanners don't flag it
let n = 0;
/** A finished test run the rules can't call: exit ok, but a Traceback in the output. */
const unclear = (output = 'Traceback (most recent call last):\n  File "t.py", line 3\nValueError: bad', extra = {}) =>
  ({ id: `r${n++}`, session: 's', kind: 'run', status: 'ok', at: Date.now(), body: { command: 'pytest -q', output }, ...extra });

/** A checker with a fake transport that records what it was asked. */
function fake({ mode = 'cloud', answer = () => ({ p: 0.94, model: 'jev-test' }), ping = () => ({}), budgetMs = 1000 } = {}) {
  const calls = [];
  const transport = { ask: async (args) => { calls.push(args); return answer(args); }, ping: async (args) => { calls.push(args); return ping(args); } };
  const checker = createChecker({
    getConfig: () => ({ checker: { mode, localUrl: 'http://127.0.0.1:8000' } }),
    getKey: () => KEY,
    transports: { laya: transport, jev: transport },
    budgetMs,
  });
  return { checker, calls };
}

test('the question is claude-referee’s done.met, as a yes/no (noul) question', () => {
  assert.equal(QUESTIONS['done.met'].type, 'noul');
  assert.match(QUESTIONS['done.met'].instructions.question, /Does `evidence` show that the tests pass\?/);
  assert.match(QUESTIONS['done.met'].instructions.note, /Zero tests, only skipped tests, a missing summary/);
  assert.deepEqual(Object.keys(QUESTIONS['done.met'].criteria).sort(), ['false', 'true']);
});

test('thresholds: ≥ 0.7 passed, ≤ 0.3 failed, in between still unclear', async () => {
  assert.deepEqual(THRESHOLDS, { passed: 0.7, failed: 0.3 });
  assert.deepEqual([stateOf(0.7), stateOf(0.94), stateOf(0.3), stateOf(0.05), stateOf(0.5)], ['passed', 'passed', 'failed', 'failed', 'unclear']);
  for (const [p, state] of [[0.94, 'passed'], [0.12, 'failed'], [0.55, 'unclear']]) {
    const { checker } = fake({ answer: () => ({ p }) });
    const check = await checker.check(unclear());
    assert.equal(check.state, state);
    assert.equal(check.p, p);
    assert.equal(check.by, 'jev');
    assert.equal(typeof check.ms, 'number');
  }
});

test('only unclear runs are asked about, and only when a checker is on', async () => {
  const { checker, calls } = fake();
  assert.equal(await checker.check({ ...unclear('ℹ tests 3\nℹ pass 3\nℹ fail 0') }), null); // clear: passed
  assert.equal(await checker.check({ ...unclear('Tests: 1 failed, 2 passed, 3 total') }), null); // clear: failed
  assert.equal(await checker.check({ ...unclear('ℹ tests 0\nℹ pass 0\nℹ fail 0') }), null); // nothing ran: never a pass anyway
  assert.equal(await checker.check({ ...unclear(), status: 'running' }), null);
  assert.equal(await checker.check({ ...unclear(), check: { by: 'jev', state: 'passed', p: 0.9 } }), null); // asked already
  assert.equal(calls.length, 0);
  assert.equal(shouldCheck(unclear()), true);
  const off = fake({ mode: 'off' });
  assert.equal(await off.checker.check(unclear()), null);
  assert.equal(off.calls.length, 0);
});

test('the same evidence is asked about once (cached), and one run once at a time', async () => {
  const { checker, calls } = fake();
  const a = unclear();
  const [x, y] = await Promise.all([checker.check(a), checker.check(a)]);
  assert.deepEqual(x, y);
  const b = unclear(); // another run, same output
  assert.equal((await checker.check(b)).state, 'passed');
  assert.equal(calls.length, 1);
  await checker.check(unclear('Traceback (most recent call last):\nKeyError: other'));
  assert.equal(calls.length, 2);
});

test('it fails open: an error or no answer in time only adds a short note', async () => {
  const broken = fake({ answer: () => { throw Object.assign(new Error(`401 Unauthorized for ${KEY}`), { status: 401 }); } });
  const check = await broken.checker.check(unclear());
  assert.equal(check.by, 'jev');
  assert.equal(check.error, 'TypeSafe didn’t accept the API key');
  assert.equal(check.state, undefined);
  assert.ok(!JSON.stringify(check).includes(KEY));

  const slow = fake({ answer: () => new Promise(() => {}), budgetMs: 50 });
  assert.match((await slow.checker.check(unclear())).error, /^no answer within/);

  const nonsense = fake({ answer: () => ({ p: 'yes' }) });
  assert.match((await nonsense.checker.check(unclear())).error, /no probability/);

  const down = fake({ mode: 'local', answer: () => { throw new TypeError('fetch failed'); } });
  const local = await down.checker.check(unclear());
  assert.equal(local.by, 'laya');
  assert.match(local.error, /couldn’t reach Laya/);
});

test('what is sent is redacted, and the key only goes to the transport', async () => {
  const GH = ['ghp', 'a'.repeat(36)].join('_'); // a fake GitHub token, built at run time so scanners don't flag it
  const output = [
    'Running as dev@example.com against 10.0.4.17 (build v1.2.3.4)',
    'PASSWORD=Sup3r$ecretValue9 GITHUB_TOKEN=' + GH,
    `curl https://admin:hunter2pass@db.internal/health with key ${KEY}`,
    'Traceback (most recent call last):',
    'ValueError: bad',
  ].join('\n');
  const { checker, calls } = fake();
  const check = await checker.check(unclear(output));
  const sent = JSON.stringify(calls[0].state);
  for (const secret of ['dev@example.com', '10.0.4.17', 'Sup3r$ecretValue9', GH, 'hunter2pass', KEY]) assert.ok(!sent.includes(secret), secret);
  assert.match(sent, /\[REDACTED:email\]/);
  assert.match(sent, /v1\.2\.3\.4/); // a version number isn't an address
  assert.match(sent, /ValueError: bad/); // the evidence itself survives
  assert.equal(calls[0].key, KEY);
  assert.deepEqual(calls[0].questions, QUESTIONS);
  assert.ok(!JSON.stringify(check).includes(KEY));
});

test('evidence: parsed facts, the exit status, the end of the output and failure lines, a few KB at most', () => {
  const long = `${'collecting...\n'.repeat(500)}FAILED tests/test_a.py::test_x - AssertionError\nE   assert 1 == 2`;
  const e = evidenceOf(unclear(long, { status: 'failed' }));
  assert.equal(e.exit_status, 'failed');
  assert.deepEqual(e.parsed.failing, ['tests/test_a.py::test_x']);
  assert.ok(e.output_end.length <= 1501);
  assert.ok(e.output_end.endsWith('assert 1 == 2'));
  assert.deepEqual(e.failure_lines, ['FAILED tests/test_a.py::test_x - AssertionError']);
  assert.ok(JSON.stringify(e).length < 4000);
  assert.equal(evidenceOf(unclear()).parsed, null);
});

test('test connection: one tiny request, and errors never echo the key', async () => {
  const ok = fake({ ping: () => ({ model: 'jev-1.13.0' }) });
  const r = await ok.checker.test('cloud');
  assert.deepEqual([r.ok, r.by, r.model], [true, 'jev', 'jev-1.13.0']);
  assert.equal(ok.calls.length, 1);
  const bad = fake({ ping: () => { throw Object.assign(new Error(`bad key ${KEY}`), { name: 'AuthenticationError' }); } });
  const r2 = await bad.checker.test('cloud');
  assert.equal(r2.ok, false);
  assert.ok(!JSON.stringify(r2).includes(KEY));
  assert.deepEqual(await fake({ mode: 'off' }).checker.test(), { ok: false, error: 'The checker is off' });
});

test('redactText: credentials, assignments, URLs with passwords, emails and IPs', () => {
  const { text, replaced } = redactText('token=9fK2xQ81LmZ7pW3v mail me@x.io at 192.168.1.20, page_token=abc and -----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----');
  assert.doesNotMatch(text, /9fK2xQ81LmZ7pW3v|me@x\.io|192\.168\.1\.20|MIIE/);
  assert.match(text, /page_token=abc/); // not a secret
  assert.deepEqual(Object.keys(replaced).sort(), ['email', 'ip', 'private_key', 'secret_assignment']);
});

test('installSdk: npm install into the folder dotpals runs from, with a plain reason when it fails', async () => {
  const { installSdk } = await import('../bridge/checker.js');
  const calls = [];
  const ok = await installSdk({ dir: '/opt/dotpals', run: async (args, opts) => { calls.push([args, opts.cwd]); return { code: 0, output: 'added 1 package' }; } });
  assert.deepEqual(ok, { ok: true });
  assert.deepEqual(calls[0], [['install', '--no-save', '--no-audit', '--no-fund', '--no-package-lock', '@typesafe-ai/sdk@^0.6.0'], '/opt/dotpals']);
  const offline = await installSdk({ run: async () => ({ code: 1, output: 'npm error code ENOTFOUND' }) });
  assert.deepEqual(offline, { ok: false, error: 'npm couldn’t reach the internet' });
  assert.deepEqual(await installSdk({ run: async () => ({ code: 1, output: 'EACCES' }) }), { ok: false, error: 'npm couldn’t install it' });
});
