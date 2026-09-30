import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActivityLog } from '../bridge/activity.js';
import cursor, { applyCursor, EVENTS } from '../bridge/adapters/cursor.js';

// Payloads as documented at https://cursor.com/docs/hooks.
const common = { conversation_id: 'c1', generation_id: 'g1', hook_event_name: '', workspace_roots: ['/work/proj'], cursor_version: '1.7.0' };
const ev = (name, extra) => ({ ...common, hook_event_name: name, ...extra });

test('applyCursor: a prompt, a command, an edit, a reply and the stop', () => {
  const log = createActivityLog();
  const prompt = applyCursor(ev('beforeSubmitPrompt', { prompt: 'fix the bug', attachments: [] }), log);
  assert.equal(prompt.session, 'cursor:c1');
  assert.equal(prompt.label, 'proj');
  assert.equal(prompt.state.state, 'thinking');
  assert.equal(prompt.entries[0].kind, 'prompt');
  assert.equal(prompt.entries[0].title, 'fix the bug');

  const run = applyCursor(ev('afterShellExecution', { command: 'npm test', output: '3 passing', duration: 1500, sandbox: false }), log).entries[0];
  assert.equal(run.kind, 'run');
  assert.equal(run.title, 'npm test');
  assert.equal(run.status, 'ok');
  assert.equal(run.ms, 1500);
  assert.equal(run.body.output, '3 passing');
  assert.equal(run.harness, 'cursor');

  const edit = applyCursor(ev('afterFileEdit', { file_path: '/work/proj/src/a.js', edits: [{ old_string: 'a', new_string: 'b' }] }), log).entries[0];
  assert.equal(edit.kind, 'edit');
  assert.equal(edit.title, 'src/a.js');
  assert.deepEqual(edit.files, [{ path: '/work/proj/src/a.js', change: 'edit' }]);
  assert.match(edit.body.patch, /^-a$/m);
  assert.match(edit.body.patch, /^\+b$/m);

  // postToolUse repeats shell and edits, which the hooks above already reported.
  assert.equal(applyCursor(ev('postToolUse', { tool_name: 'Shell', tool_input: { command: 'npm test' }, tool_output: '{}', tool_use_id: 't1', duration: 5 }), log).entries.length, 0);
  const read = applyCursor(ev('postToolUse', { tool_name: 'Read', tool_input: { file_path: '/work/proj/README.md' }, tool_use_id: 't2', duration: 3 }), log).entries[0];
  assert.equal(read.kind, 'read');
  assert.equal(read.title, 'README.md');

  const failed = applyCursor(ev('postToolUseFailure', { tool_name: 'Shell', tool_input: { command: 'npm run lint' }, tool_use_id: 't3', error_message: 'exit 1', failure_type: 'error', duration: 9 }), log).entries[0];
  assert.equal(failed.status, 'failed');
  assert.equal(failed.kind, 'run');

  applyCursor(ev('afterAgentResponse', { text: 'Fixed it.' }), log);
  const stop = applyCursor(ev('stop', { status: 'completed', loop_count: 0 }), log);
  const done = stop.entries.find((e) => e.kind === 'done');
  assert.ok(done, 'done entry');
  assert.equal(done.summary, 'Fixed it.');
  assert.equal(stop.state.state, 'done');

  const error = applyCursor(ev('stop', { status: 'error', generation_id: 'g2' }), log);
  assert.equal(error.state.state, 'error');
});

test('Cursor connect merges into hooks.json, backs it up, and disconnect takes only ours out', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-cursor-'));
  process.env.DOTPALS_CURSOR_DIR = dir;
  t.after(async () => { delete process.env.DOTPALS_CURSOR_DIR; await rm(dir, { recursive: true, force: true }); });
  const file = join(dir, 'hooks.json');
  const mine = { version: 1, hooks: { afterFileEdit: [{ command: './hooks/format.sh' }] }, other: true };
  await writeFile(file, JSON.stringify(mine));

  assert.equal(cursor.connected(), false);
  assert.equal(cursor.detect().found, true);
  const result = cursor.connect();
  assert.equal(result.backup, `${file}.dotpals-backup`);
  assert.deepEqual(JSON.parse(await readFile(result.backup, 'utf8')), mine);

  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(after.other, true);
  assert.equal(after.version, 1);
  assert.equal(after.hooks.afterFileEdit.length, 2);
  assert.equal(after.hooks.afterFileEdit[0].command, './hooks/format.sh');
  for (const event of EVENTS) assert.match(after.hooks[event].at(-1).command, /^node ".+\/bridge\/hook\.js" cursor$/);
  // Never the hooks that approve or block.
  for (const blocking of ['preToolUse', 'beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile', 'subagentStart']) assert.equal(after.hooks[blocking], undefined);
  assert.equal(cursor.connected(), true);

  // Connecting twice doesn't add a second copy.
  cursor.connect();
  assert.equal(JSON.parse(await readFile(file, 'utf8')).hooks.afterFileEdit.length, 2);

  cursor.disconnect();
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), mine);
  assert.equal(cursor.connected(), false);
});

test('Cursor connect leaves a hooks.json it can’t read alone', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-cursor-'));
  process.env.DOTPALS_CURSOR_DIR = dir;
  t.after(async () => { delete process.env.DOTPALS_CURSOR_DIR; await rm(dir, { recursive: true, force: true }); });
  await writeFile(join(dir, 'hooks.json'), '{ "version": 1, // a comment\n }');
  assert.throws(() => cursor.connect(), /wasn’t changed/);
  assert.equal(await readFile(join(dir, 'hooks.json'), 'utf8'), '{ "version": 1, // a comment\n }');
  assert.equal(existsSync(join(dir, 'hooks.json.dotpals-backup')), false);
});
