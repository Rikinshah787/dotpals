import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSessions } from '../bridge/ui/recap.js';
import { brief, briefLine, briefMarkdown } from '../bridge/ui/brief.js';

let n = 0;
const step = (session, harness, label, kind, at, extra = {}) => ({ id: `s${n++}`, session, harness, label, kind, status: 'ok', at, ...extra });
const MIN = 60_000;
const now = 100 * MIN;

/** A session's steps, built with its own session, agent and folder name. */
function session(id, harness, label) {
  const at = (kind, t, extra) => step(id, harness, label, kind, t, extra);
  return {
    prompt: (t, title = 'Do it') => at('prompt', t, { title, status: 'info' }),
    edit: (t, path = 'src/a.js', patch = '-a\n+b') => at('edit', t, { title: path, files: [{ path: `/w/${label}/${path}`, change: 'edit' }], body: { patch } }),
    test: (t, ok) => at('run', t, { tool: 'Bash', title: 'npm test', status: ok ? 'ok' : 'failed', body: { command: 'npm test', output: ok ? 'Tests: 4 passed' : 'Tests: 1 failed, 3 passed' } }),
    done: (t, summary = 'Done.', extra = {}) => at('done', t, { title: 'Finished', summary, ...extra }),
  };
}

test('brief: per project, what was done, what is unfinished, failing, and worth a check', () => {
  const shop = session('a', 'claude', 'shop');
  const api = session('b', 'codex', 'api');
  const entries = [
    // shop: one clean request, then one that left the tests failing.
    shop.prompt(10 * MIN, 'Add a cart'), shop.edit(11 * MIN), shop.test(12 * MIN, true), shop.done(13 * MIN, 'Added the cart.', { usage: { m1: [100, 20, 0, 0] } }),
    shop.prompt(20 * MIN, 'Fix the total'), shop.edit(21 * MIN, 'src/total.js'), shop.test(22 * MIN, false), shop.done(23 * MIN),
    // api: changed code, never tested, and said it added tests.
    api.prompt(30 * MIN, 'Add rate limits'), api.edit(31 * MIN, 'src/limit.js'), api.done(32 * MIN, 'Added tests for the limiter.'),
  ];
  const projects = brief(summarizeSessions(entries), { now });
  assert.deepEqual(projects.map((p) => p.name), ['api', 'shop']); // newest first
  const [a, s] = projects;
  assert.equal(s.requests, 2);
  assert.equal(s.files, 2);
  assert.deepEqual(s.agents, ['Claude Code']);
  assert.deepEqual(s.unfinished.map((u) => u.asked), ['“Fix the total”']);
  assert.match(s.unfinished[0].why, /tests are failing/);
  assert.deepEqual(s.failing.map((f) => f.text), ['Claude Code: tests failing (1 failed, 3 passed)']);
  assert.equal(s.tokens.input, 100);
  assert.deepEqual(a.failing.map((f) => f.text), ['Codex: code changed and no tests ran']);
  assert.deepEqual(a.warnings.map((w) => w.text), ['Said it added tests, but no test file changed (“Add rate limits”)']);
  assert.equal(a.tokens, null);

  assert.equal(briefLine('Since yesterday', projects), 'Since yesterday: 3 requests in 2 projects · 1 unfinished · tests failing or untested in api, shop · 1 thing to check');
  const md = briefMarkdown('Morning brief', projects);
  assert.match(md, /^## Morning brief\n\n### api\n\n1 request · 1 file changed · Codex\n\n\*\*Failing\*\*\n- Codex: code changed and no tests ran\n\n\*\*To check\*\*\n- Codex: Said it added tests/);
  assert.match(md, /### shop\n\n2 requests · 2 files changed · Claude Code · 100 tokens in · 20 out\n\n\*\*Unfinished\*\*\n- Claude Code: “Fix the total”\. .*tests are failing/);
});

test('brief: only work since `since`; a session still working is not unfinished; a clean day says so', () => {
  const shop = session('c', 'claude', 'shop');
  const entries = [
    shop.prompt(1 * MIN, 'Old work'), shop.edit(2 * MIN), shop.done(3 * MIN),
    shop.prompt(90 * MIN, 'New work'), shop.edit(91 * MIN), shop.test(92 * MIN, true), shop.done(93 * MIN),
    shop.prompt(98 * MIN, 'Still going'), shop.edit(99 * MIN),
  ];
  const [p] = brief(summarizeSessions(entries), { now, since: 60 * MIN });
  assert.equal(p.requests, 2); // the old request is out of the period
  assert.deepEqual(p.unfinished, []); // "Still going" had a step a minute ago
  assert.match(briefMarkdown('Today', [{ ...p, failing: [], warnings: [] }]), /\nNothing left open\./);
  assert.deepEqual(brief(summarizeSessions(entries), { now, since: now }), []);
  assert.equal(briefLine('Since yesterday', []), '');
  assert.equal(briefMarkdown('This week', []), '## This week\n\nNo agent work in this period.');
});

test('brief: a request cut off, and a question left for you, are unfinished', () => {
  const x = session('d', 'codex', 'web');
  const entries = [
    x.prompt(10 * MIN, 'Rename the page'), x.edit(11 * MIN), // no end, and quiet for long
  ];
  assert.match(brief(summarizeSessions(entries), { now })[0].unfinished[0].why, /^Cut off/);
  const q = session('e', 'claude', 'web2');
  const asks = [q.prompt(10 * MIN, 'Add dark mode'), q.done(11 * MIN, 'Should I also change the logo?')];
  assert.equal(brief(summarizeSessions(asks), { now })[0].unfinished[0].why, 'Finished with a question for you');
});

test('brief: two folders with the same name stay apart when their paths are known', () => {
  const a = session('f', 'claude', 'api');
  const b = session('g', 'codex', 'api');
  const sessions = summarizeSessions([a.prompt(10 * MIN), a.done(11 * MIN), b.prompt(12 * MIN), b.done(13 * MIN)])
    .map((s) => ({ ...s, cwd: s.id === 'f' ? '/one/api' : '/two/api' }));
  assert.equal(brief(sessions, { now }).length, 2);
  // An agent that doesn't say its folder joins the one project of that name…
  const c = session('h', 'cursor', 'api');
  const three = [...sessions, ...summarizeSessions([c.prompt(14 * MIN), c.done(15 * MIN)])];
  assert.equal(brief(three, { now }).length, 3); // …but with two "api" folders it can't tell which
  const one = sessions.filter((s) => s.id === 'f');
  const joined = brief([...one, ...summarizeSessions([c.prompt(14 * MIN), c.done(15 * MIN)])], { now });
  assert.equal(joined.length, 1);
  assert.deepEqual(joined[0].agents, ['Claude Code', 'Cursor']);
  assert.equal(joined[0].cwd, '/one/api');
});
