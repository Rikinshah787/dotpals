import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTurns } from '../bridge/ui/recap.js';
import { agentStats, reportCard, reportMarkdown, reportRows } from '../bridge/ui/report.js';

let n = 0;
const step = (session, harness, kind, at, extra = {}) => ({ id: `s${n++}`, session, harness, kind, status: 'ok', at, ...extra });
const prompt = (s, h, at, title = 'Do it') => step(s, h, 'prompt', at, { title, status: 'info' });
const edit = (s, h, at, path = 'src/a.js', patch = '-a\n+b') => step(s, h, 'edit', at, { title: path, files: [{ path: `/p/${path}`, change: 'edit' }], body: { patch } });
const test_ = (s, h, at, ok) => step(s, h, 'run', at, { tool: 'Bash', title: 'npm test', status: ok ? 'ok' : 'failed', body: { command: 'npm test', output: ok ? 'Tests: 4 passed' : 'Tests: 1 failed, 3 passed' } });
const done = (s, h, at, summary = 'Done.', extra = {}) => step(s, h, 'done', at, { title: 'Finished', summary, ...extra });

test('agentStats: tested and passed, untested, fixed after tries, faked, false claims, tokens', () => {
  const c = 'claude';
  const entries = [
    // Changed code, failed, fixed, passed.
    prompt('a', c, 1000), edit('a', c, 1100), test_('a', c, 1200, false), edit('a', c, 1300), test_('a', c, 1400, true),
    done('a', c, 1500, 'Fixed it. All tests pass.', { usage: { m1: [100, 20, 1000, 0] } }),
    // Changed code, never tested, and said it added tests.
    prompt('a', c, 2000), edit('a', c, 2100, 'src/b.js'), done('a', c, 2200, 'Added tests for b.', { usage: { m2: [300, 40, 0, 0] } }),
    // The faked pass: a failing run, an assertion taken out, then green.
    prompt('a', c, 3000), edit('a', c, 3100), test_('a', c, 3200, false),
    edit('a', c, 3300, 'test/a.test.js', '-  assert.equal(sum(1, 2), 3);'), test_('a', c, 3400, true), done('a', c, 3500),
    // Asked, no code changed.
    prompt('a', c, 4000), done('a', c, 4100, 'It uses React.'),
  ];
  const s = agentStats(buildTurns(entries));
  assert.equal(s.requests, 4);
  assert.equal(s.changed, 3);
  assert.equal(s.passed, 1); // the faked one doesn't count as passed
  assert.equal(s.untested, 1);
  assert.equal(s.faked, 1);
  assert.equal(s.claims, 1); // "Added tests for b." with no test file changed
  assert.equal(s.fixTries, 2); // failed, then passed: 2 tries
  assert.deepEqual(s.tokens, { input: 200, output: 30, cacheRead: 500, cacheWrite: 0, replies: 2 }); // per request that logged tokens
  assert.ok(s.time > 0);
});

test('agentStats: what the tokens bought: per change that held up, on changes that didn’t, on retries', () => {
  const c = 'claude';
  const u = (input, output, read = 0, write = 0) => ({ [`m${n++}`]: [input, output, read, write] });
  const entries = [
    // Held up: 1000 new tokens, 2000 cache reads (not counted).
    prompt('a', c, 1000), edit('a', c, 1100, 'src/a.js', '-a\n+b'), { ...test_('a', c, 1200, true), usage: u(800, 200, 2000) }, done('a', c, 1300),
    // Didn't: failed, tried again (the retry's reply: 300), still failing. 500 + 300 = 800 new tokens.
    prompt('a', c, 2000), { ...edit('a', c, 2100), usage: u(400, 100) }, test_('a', c, 2200, false),
    { ...edit('a', c, 2300), usage: u(250, 50) }, test_('a', c, 2400, false), done('a', c, 2500),
  ];
  const s = agentStats(buildTurns(entries));
  assert.deepEqual(s.cost, { perPass: 1000, wasted: 800, retries: 300, total: 1800 });
  const rows = reportRows(reportCard(buildTurns(entries)));
  const cell = (key) => rows.find((r) => r.key === key).cells[0];
  assert.equal(cell('perPass').text, '1k');
  assert.deepEqual(cell('wasted'), { text: '800 (44%)', warn: true });
  assert.equal(cell('retries').text, '300 (17%)');
  // An agent that logs no tokens: nothing, not zero.
  const none = agentStats(buildTurns([prompt('x', 'cursor', 1000), edit('x', 'cursor', 1100), done('x', 'cursor', 1200)]));
  assert.equal(none.cost, null);
});

test('agentStats: an agent with nothing to say says nothing', () => {
  const s = agentStats(buildTurns([prompt('x', 'cursor', 1000), done('x', 'cursor', 1100)]));
  assert.deepEqual([s.requests, s.changed, s.fixTries, s.tokens], [1, 0, null, null]);
});

test('agentStats: a request that went in circles before it ended counts', () => {
  const h = 'codex';
  const entries = [prompt('c', h, 1000), edit('c', h, 1100), test_('c', h, 1200, false), test_('c', h, 1300, false), test_('c', h, 1400, false), done('c', h, 1500)];
  assert.equal(agentStats(buildTurns(entries)).stuck, 1);
  const fixed = [prompt('d', h, 1000), edit('d', h, 1100), test_('d', h, 1200, false), edit('d', h, 1300), test_('d', h, 1400, true), done('d', h, 1500)];
  assert.equal(agentStats(buildTurns(fixed)).stuck, 0);
});

test('reportCard and reportMarkdown: one column per agent, busiest first, warnings marked', () => {
  const entries = [
    prompt('a', 'claude', 1000), edit('a', 'claude', 1100), test_('a', 'claude', 1200, true), done('a', 'claude', 1300),
    prompt('b', 'codex', 1000), edit('b', 'codex', 1100), done('b', 'codex', 1200, 'Committed the fix.'),
    prompt('b', 'codex', 2000), done('b', 'codex', 2100),
  ];
  const card = reportCard(buildTurns(entries));
  assert.deepEqual(card.map((a) => a.name), ['Codex', 'Claude']);
  const rows = reportRows(card);
  assert.deepEqual(rows.find((r) => r.label === 'Changed code, tested and passed').cells.map((c) => c.text), ['0 of 1 (0%)', '1 of 1 (100%)']);
  const md = reportMarkdown('The last 7 days', card);
  assert.match(md, /^## The last 7 days\n\n\| \| Codex \| Claude \|\n\|---\|---:\|---:\|\n\| Requests \| 2 \| 1 \|/);
  assert.match(md, /\| Changed code, tested and passed \| ⚠ 0 of 1 \(0%\) \| 1 of 1 \(100%\) \|/);
  assert.match(md, /\| Claims that didn’t happen \| ⚠ 1 \| 0 \|/);
  assert.match(md, /\| Tokens per request \| — \| — \|/);
  assert.match(md, /_3 requests · read from what the agents did/);
  assert.equal(reportMarkdown('Today', []), '## Today\n\nNo agent work in this period.');
});
