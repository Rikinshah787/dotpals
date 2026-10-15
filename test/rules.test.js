import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRules, forbids, matches, parseRules, ruleChecks, ruleRelative } from '../bridge/rules.js';
import { buildTurns } from '../bridge/ui/recap.js';
import { readiness } from '../bridge/ui/story.js';

const dirs = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));
const folder = async () => { const d = await mkdtemp(join(tmpdir(), 'dotpals-rules-')); dirs.push(d); return d; };

test('parseRules: the known rules, tidied; the rest ignored; under "rules" too', () => {
  const r = parseRules({ mustNotTouch: ['./migrations/', '../etc', 'src\\legacy\\**', 3], onlyTouch: ['src'], mustPass: ['npm test', 'rm -rf /\nx', '`x`'], noNewDependencies: true, beforeEdit: 'tell', other: 1 });
  assert.deepEqual(r, { mustNotTouch: ['migrations', 'src/legacy/**'], onlyTouch: ['src'], mustPass: ['npm test'], noNewDependencies: true, beforeEdit: 'tell' });
  assert.deepEqual(parseRules({ rules: { mustNotTouch: ['db'] } }).mustNotTouch, ['db']);
  assert.equal(parseRules({}).beforeEdit, 'ask'); // asks unless it says otherwise
  assert.equal(parseRules({ beforeEdit: 'nope' }).beforeEdit, 'ask');
  assert.throws(() => parseRules([]), /object/);
  assert.throws(() => parseRules('x'), /object/);
});

test('matches: a plain path is it and what is in it; *, ** and ? globs', () => {
  assert.ok(matches('migrations', 'migrations'));
  assert.ok(matches('migrations/001.sql', 'migrations'));
  assert.ok(!matches('migrations-old/x.sql', 'migrations'));
  assert.ok(matches('src/legacy/a/b.js', 'src/legacy/**'));
  assert.ok(matches('yarn.lock', '*.lock'));
  assert.ok(!matches('sub/yarn.lock', '*.lock')); // * doesn't cross folders
  assert.ok(matches('sub/yarn.lock', '**/*.lock'));
  assert.ok(matches('yarn.lock', '**/*.lock')); // ** can be no folders at all
  assert.ok(matches('src/a/b.js', 'src/*')); // a match is a folder's too
  assert.ok(matches('v1.js', 'v?.js'));
  assert.ok(!matches('v10.js', 'v?.js'));
  assert.ok(matches('a.b', 'a.b') && !matches('axb', 'a.b')); // a dot is a dot
});

test('forbids: before an edit, which rule it breaks', () => {
  const r = parseRules({ mustNotTouch: ['migrations'], onlyTouch: ['src', 'test'] });
  assert.equal(forbids(r, 'migrations/1.sql'), 'not to touch: migrations');
  assert.equal(forbids(r, 'docs/x.md'), 'only change src or test');
  assert.equal(forbids(r, 'src/a.js'), null);
  assert.equal(forbids(r, '.dotpals.json'), null); // the rules file itself may change
  assert.equal(forbids(null, 'migrations/1.sql'), null);
  assert.equal(forbids({ ...r, error: 'bad' }, 'migrations/1.sql'), null);
});

test('findRules: the nearest .dotpals.json up to the repository root; broken ones say so; cached until changed', async () => {
  const repo = await folder();
  await mkdir(join(repo, '.git'));
  await mkdir(join(repo, 'packages', 'web', 'src'), { recursive: true });
  assert.equal(await findRules(join(repo, 'packages', 'web')), null);
  await writeFile(join(repo, '.dotpals.json'), JSON.stringify({ mustNotTouch: ['db'] }));
  const top = await findRules(join(repo, 'packages', 'web', 'src'));
  assert.equal(top.dir, repo);
  assert.deepEqual(top.mustNotTouch, ['db']);
  // A package's own rules win over the repository's.
  await writeFile(join(repo, 'packages', 'web', '.dotpals.json'), JSON.stringify({ onlyTouch: ['src'] }));
  const web = await findRules(join(repo, 'packages', 'web', 'src'));
  assert.equal(web.dir, join(repo, 'packages', 'web'));
  assert.deepEqual(web.onlyTouch, ['src']);
  // Not past the repository's root.
  const outer = await folder();
  await writeFile(join(outer, '.dotpals.json'), JSON.stringify({ mustNotTouch: ['x'] }));
  await mkdir(join(outer, 'repo', '.git'), { recursive: true });
  assert.equal(await findRules(join(outer, 'repo')), null);
  // Broken: said, not taken for "no rules".
  await writeFile(join(repo, '.dotpals.json'), '{ not json');
  await new Promise((r) => setTimeout(r, 20));
  assert.match((await findRules(repo)).error, /valid JSON/);
  await writeFile(join(repo, '.dotpals.json'), 'x'.repeat(70 * 1024));
  assert.match((await findRules(repo)).error, /bigger than/);
  assert.equal(await findRules(''), null);
});

let n = 0;
const step = (kind, at, extra = {}) => ({ id: `r${n++}`, session: 's', harness: 'codex', kind, status: 'ok', at, ...extra });
const edit = (dir, path, at) => step('edit', at, { title: path, files: [{ path: join(dir, path), change: 'edit' }], body: { patch: '-a\n+b' } });
const run = (cmd, at, ok = true, output) => step('run', at, { title: cmd, status: ok ? 'ok' : 'failed', body: { command: cmd, ...(output ? { output } : {}) } });

test('ruleChecks: what a finished request broke, from its steps and what git saw', () => {
  const dir = join(tmpdir(), 'proj');
  const rules = { file: join(dir, '.dotpals.json'), dir, ...parseRules({ mustNotTouch: ['migrations'], onlyTouch: ['src', 'migrations'], mustPass: ['npm test'], noNewDependencies: true }) };
  const [turn] = buildTurns([
    step('prompt', 1000, { title: 'Fix it', status: 'info' }),
    edit(dir, 'src/a.js', 1100), edit(dir, 'migrations/2.sql', 1200),
    run('npm i left-pad', 1300), run('npm test', 1400, true, 'Tests: 3 passed'),
    step('done', 1500, { title: 'Finished', git: { files: [{ path: 'docs/x.md', change: 'edit' }] } }),
  ]);
  const texts = ruleChecks(rules, turn).map((c) => c.text);
  assert.deepEqual(texts, [
    'Broke a project rule: changed migrations/2.sql (not to touch: migrations)',
    'Broke a project rule: changed docs/x.md, outside src or migrations', // git saw it, no tool did
    'Broke a project rule (no new dependencies): Added a package: `npm i left-pad`',
  ]);
  // Tests that ran before the last change don't count.
  const [stale] = buildTurns([step('prompt', 1000, { title: 'x', status: 'info' }), run('npm test', 1100, true, 'Tests: 3 passed'), edit(dir, 'src/a.js', 1200), step('done', 1300, { title: 'Finished' })]);
  assert.deepEqual(ruleChecks(rules, stale).map((c) => c.text), ['Broke a project rule: `npm test` didn’t run after the last change']);
  // Nothing broken: one ✓ line. Nothing changed: mustPass doesn't apply.
  const [good] = buildTurns([step('prompt', 1000, { title: 'x', status: 'info' }), edit(dir, 'src/a.js', 1100), run('npm test', 1200, true, 'Tests: 3 passed'), step('done', 1300, { title: 'Finished' })]);
  assert.deepEqual(ruleChecks(rules, good), [{ ok: true, text: 'Followed the project’s rules (.dotpals.json)' }]);
  const [ask] = buildTurns([step('prompt', 1000, { title: 'x', status: 'info' }), step('done', 1100, { title: 'Finished' })]);
  assert.deepEqual(ruleChecks(rules, ask).map((c) => c.ok), [true]);
  // A broken rules file is a problem of its own.
  assert.match(ruleChecks({ file: rules.file, dir, error: 'it isn’t valid JSON' }, good)[0].text, /couldn’t be read: it isn’t valid JSON/);
  assert.deepEqual(ruleChecks(null, good), []);
});

test('ruleChecks (from review): in a monorepo package, git’s paths are the repository’s; changing the rules is said', () => {
  const root = join(tmpdir(), 'mono');
  const dir = join(root, 'packages', 'web');
  const rules = { file: join(dir, '.dotpals.json'), dir, root, ...parseRules({ mustNotTouch: ['migrations'], onlyTouch: ['src', 'migrations'] }) };
  // Git saw packages/web/migrations/1.sql (relative to the repository), and a file in another package.
  const [turn] = buildTurns([
    step('prompt', 1000, { title: 'x', status: 'info' }),
    step('done', 1100, { title: 'Finished', git: { files: [{ path: 'packages/web/migrations/1.sql', change: 'write' }, { path: 'packages/api/x.js', change: 'edit' }, { path: 'packages/web/src/a.js', change: 'edit' }] } }),
  ]);
  assert.deepEqual(ruleChecks(rules, turn).map((c) => c.text), ['Broke a project rule: changed migrations/1.sql (not to touch: migrations)']);
  // The request changed .dotpals.json itself: said, not passed over.
  const [self] = buildTurns([step('prompt', 1000, { title: 'x', status: 'info' }), edit(dir, '.dotpals.json', 1100), step('done', 1200, { title: 'Finished' })]);
  assert.deepEqual(ruleChecks(rules, self).map((c) => [c.ok, c.text]), [[false, 'Changed the project’s rules (.dotpals.json) during the request: check it’s what you wanted']]);
});

test('findRules (from review): however deep the folder, up to the repository root; it knows the root', async () => {
  const repo = await folder();
  await mkdir(join(repo, '.git'));
  await writeFile(join(repo, '.dotpals.json'), JSON.stringify({ mustNotTouch: ['db'] }));
  const deep = join(repo, ...Array.from({ length: 24 }, (_, i) => `d${i}`));
  await mkdir(deep, { recursive: true });
  const r = await findRules(deep);
  assert.equal(r.dir, repo);
  assert.equal(r.root, repo);
  // A package's rules: the root is still the repository's.
  await mkdir(join(repo, 'pkg'));
  await writeFile(join(repo, 'pkg', '.dotpals.json'), '{}');
  const p = await findRules(join(repo, 'pkg'));
  assert.equal(p.dir, join(repo, 'pkg'));
  assert.equal(p.root, repo);
});

test('readiness (from review): a broken rule shows even when only non-code files changed', () => {
  const dir = join(tmpdir(), 'proj');
  const broke = { ok: false, text: 'Broke a project rule: changed yarn.lock (not to touch: *.lock)' };
  const [turn] = buildTurns([step('prompt', 1000, { title: 'x', status: 'info' }), edit(dir, 'yarn.lock', 1100), step('done', 1200, { title: 'Finished', rules: [broke] })]);
  assert.deepEqual(readiness(turn), { ready: false, checks: [broke], problems: [broke.text] });
  // Nothing broken and no code: still nothing to say.
  const [ok] = buildTurns([step('prompt', 1000, { title: 'x', status: 'info' }), edit(dir, 'README.md', 1100), step('done', 1200, { title: 'Finished', rules: [{ ok: true, text: 'Followed' }] })]);
  assert.equal(readiness(ok), null);
});

test('ruleRelative: an agent’s path, absolute or relative to its folder, against the rules’ folder', () => {
  const dir = join(tmpdir(), 'proj');
  const rules = { dir };
  assert.equal(ruleRelative(rules, join(dir, 'src', 'a.js'), dir), 'src/a.js');
  assert.equal(ruleRelative(rules, 'a.js', join(dir, 'src')), 'src/a.js');
  assert.equal(ruleRelative(rules, join(tmpdir(), 'elsewhere', 'a.js'), dir), null);
});

test('readiness: the rules the bridge checked are part of "Ready to merge?"', () => {
  const dir = join(tmpdir(), 'proj');
  const broke = { ok: false, text: 'Broke a project rule: changed migrations/2.sql (not to touch: migrations)' };
  const [turn] = buildTurns([step('prompt', 1000, { title: 'x', status: 'info' }), edit(dir, 'src/a.js', 1100), run('npm test', 1200, true, 'Tests: 3 passed'), step('done', 1300, { title: 'Finished', rules: [broke] })]);
  const r = readiness(turn);
  assert.equal(r.ready, false);
  assert.ok(r.problems.includes(broke.text));
  const [ok] = buildTurns([step('prompt', 1000, { title: 'x', status: 'info' }), edit(dir, 'src/a.js', 1100), run('npm test', 1200, true, 'Tests: 3 passed'), step('done', 1300, { title: 'Finished', rules: [{ ok: true, text: 'Followed the project’s rules (.dotpals.json)' }] })]);
  assert.equal(readiness(ok).ready, true);
  assert.ok(readiness(ok).checks.some((c) => c.text === 'Followed the project’s rules (.dotpals.json)'));
});
