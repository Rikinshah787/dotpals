import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clip, clipEnds, clipText, createActivityLog, folderName, relative, toPatch } from '../bridge/activity.js';
import { testVerdict } from '../bridge/ui/story.js';

test('clipEnds keeps the start and the end of long output, so a test summary survives', () => {
  assert.equal(clipEnds('short\r\nout\n\n'), 'short\nout');
  const long = `> npm test\n${'✔ a test that passed (1ms)\n'.repeat(400)}ℹ tests 400\nℹ pass 399\nℹ fail 1`;
  const kept = clipEnds(long, 3000);
  assert.ok(kept.length < 3100);
  assert.ok(kept.startsWith('> npm test\n'));
  assert.ok(kept.endsWith('ℹ fail 1'));
  assert.match(kept, /\n… \(\d+ characters cut\) …\n/);
  // clipText loses the summary; clipEnds keeps it, so the run reads as failed, not "exit code only".
  const entry = (output) => ({ kind: 'run', status: 'ok', body: { command: 'npm test', output } });
  assert.equal(testVerdict(entry(clipText(long, 3000))).source, 'exit');
  assert.deepEqual([testVerdict(entry(kept)).state, testVerdict(entry(kept)).summary], ['failed', '1 failed, 399 passed']);
});

test('helpers: clip, clipText, relative, folderName, toPatch', () => {
  assert.equal(clip('  a \n b  '), 'a b');
  assert.equal(clip('abcdef', 4), 'abc…');
  assert.equal(clipText('a\r\nb\n\n'), 'a\nb');
  assert.match(clipText('x'.repeat(10), 4), /^xxxx\n… \(6 more characters\)$/);
  assert.equal(relative('C:\\Proj\\src\\a.js', 'c:\\proj'), 'src/a.js');
  assert.equal(relative('/other/a.js', '/proj'), '/other/a.js');
  assert.equal(folderName('C:\\Users\\me\\dotpals\\'), 'dotpals');
  assert.equal(toPatch('old', 'new\nline'), '-old\n+new\n+line');
});

test('upsert merges fields by id', () => {
  const log = createActivityLog();
  log.upsert({ id: 'a', session: 's', at: 1, kind: 'run', title: 'npm test', status: 'running' });
  const merged = log.upsert({ id: 'a', status: 'ok', ms: 42 });
  assert.equal(merged, log.get('a'));
  assert.equal(merged.kind, 'run');
  assert.equal(merged.title, 'npm test');
  assert.equal(merged.status, 'ok');
  assert.equal(merged.ms, 42);
  assert.equal(merged.at, 1);
  assert.equal(log.all().length, 1);
});

test('undefined values in a follow-up do not erase fields', () => {
  const log = createActivityLog();
  log.upsert({ id: 'a', session: 's', at: 1, kind: 'run', title: 'npm test', status: 'running' });
  log.upsert({ id: 'a', title: undefined, status: 'ok' });
  assert.equal(log.get('a').title, 'npm test');
});

test('a final status does not regress', () => {
  const log = createActivityLog();
  log.upsert({ id: 'a', session: 's', at: 1, status: 'ok' });
  log.upsert({ id: 'a', status: 'running' });
  assert.equal(log.get('a').status, 'ok');

  log.upsert({ id: 'b', session: 's', at: 2, status: 'failed' });
  log.upsert({ id: 'b', status: 'waiting' });
  assert.equal(log.get('b').status, 'failed');

  // Non-final statuses can still move on.
  log.upsert({ id: 'c', session: 's', at: 3, status: 'running' });
  log.upsert({ id: 'c', status: 'waiting' });
  assert.equal(log.get('c').status, 'waiting');
});

test('body merges instead of replacing', () => {
  const log = createActivityLog();
  log.upsert({ id: 'a', session: 's', at: 1, status: 'running', body: { command: 'npm test' } });
  log.upsert({ id: 'a', status: 'ok', body: { output: 'all good' } });
  assert.deepEqual(log.get('a').body, { command: 'npm test', output: 'all good' });
});

test('settle marks running and waiting entries as stopped, only in that session', () => {
  const log = createActivityLog();
  log.upsert({ id: 'r', session: 's', at: 1, status: 'running' });
  log.upsert({ id: 'w', session: 's', at: 2, status: 'waiting' });
  log.upsert({ id: 'k', session: 's', at: 3, status: 'ok' });
  log.upsert({ id: 'x', session: 'other', at: 4, status: 'running' });

  const settled = log.settle('s');
  assert.deepEqual(settled.map((e) => e.id).sort(), ['r', 'w']);
  assert.equal(log.get('r').status, 'stopped');
  assert.equal(log.get('w').status, 'stopped');
  assert.equal(log.get('k').status, 'ok');
  assert.equal(log.get('x').status, 'running');
  assert.deepEqual(log.settle('missing'), []);
});

test('late inserts are kept in time order', () => {
  const log = createActivityLog();
  log.upsert({ id: 'a', session: 's', at: 100, status: 'info' });
  log.upsert({ id: 'c', session: 's', at: 300, status: 'info' });
  log.upsert({ id: 'b', session: 's', at: 200, status: 'info' }); // backfilled late
  log.upsert({ id: 'z', session: 't', at: 150, status: 'info' });

  assert.deepEqual(log.all().map((e) => e.id), ['a', 'z', 'b', 'c']);
  // The newest entry in the session is still the one with the latest time.
  assert.equal(log.findLast('s', () => true).id, 'c');
  assert.equal(log.findLast('s', (e) => e.at < 300).id, 'b');
  assert.equal(log.findLast('nope', () => true), null);
});

test('limit drops the oldest entries; forget clears a session', () => {
  const log = createActivityLog({ limit: 2 });
  log.upsert({ id: 'a', session: 's', at: 1, status: 'info' });
  log.upsert({ id: 'b', session: 's', at: 2, status: 'info' });
  log.upsert({ id: 'c', session: 's', at: 3, status: 'info' });
  assert.equal(log.get('a'), undefined);
  assert.deepEqual(log.all().map((e) => e.id), ['b', 'c']);

  log.forget('s');
  assert.equal(log.has('s'), false);
  assert.equal(log.get('b'), undefined);
  assert.deepEqual(log.all(), []);
});
