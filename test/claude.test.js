import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActivityLog } from '../bridge/activity.js';
import { applyHook, backfillTranscript, describeTool, lastReply } from '../bridge/adapters/claude.js';

const CWD = 'C:\\work\\proj';
let n = 0;
// The adapter remembers each session's first cwd, so every test gets its own session.
const newSession = () => `claude-test-${process.pid}-${n++}`;

const patchLinesOk = (patch) => patch.split('\n').every((l) => l.startsWith('-') || l.startsWith('+'));

test('describeTool: Read', () => {
  const d = describeTool('Read', { file_path: 'C:\\work\\proj\\src\\a.js' }, CWD);
  assert.equal(d.kind, 'read');
  assert.equal(d.title, 'src/a.js');
  assert.deepEqual(d.files, [{ path: 'C:\\work\\proj\\src\\a.js', change: 'read' }]);
});

test('describeTool: Edit gives a -/+ patch', () => {
  const d = describeTool('Edit', { file_path: '/work/proj/src/a.js', old_string: 'a\nb', new_string: 'c' }, '/work/proj');
  assert.equal(d.kind, 'edit');
  assert.equal(d.title, 'src/a.js');
  assert.equal(d.files[0].change, 'edit');
  assert.equal(d.body.patch, '-a\n-b\n+c');
  assert.ok(patchLinesOk(d.body.patch));
});

test('describeTool: Write gives an all-+ patch', () => {
  const d = describeTool('Write', { file_path: '/work/proj/README.md', content: 'hi\nthere' }, '/work/proj');
  assert.equal(d.kind, 'write');
  assert.equal(d.title, 'README.md');
  assert.equal(d.files[0].change, 'write');
  assert.equal(d.body.patch, '+hi\n+there');
  assert.ok(patchLinesOk(d.body.patch));
});

test('describeTool: Bash', () => {
  const d = describeTool('Bash', { command: 'npm test -- --watch=false', description: 'Run the tests' }, CWD);
  assert.equal(d.kind, 'run');
  assert.equal(d.title, 'Run the tests');
  assert.equal(d.detail, 'npm test -- --watch=false');
  assert.equal(d.body.command, 'npm test -- --watch=false');

  const bare = describeTool('Bash', { command: 'ls' }, CWD);
  assert.equal(bare.title, 'ls');
});

test('describeTool: Grep', () => {
  const d = describeTool('Grep', { pattern: 'TODO', glob: '*.js', path: 'C:\\work\\proj\\src' }, CWD);
  assert.equal(d.kind, 'search');
  assert.equal(d.title, 'TODO');
  assert.equal(d.detail, '*.js in src');
});

test('describeTool: MCP tools', () => {
  const d = describeTool('mcp__server__do_thing', { q: 1 }, CWD);
  assert.equal(d.kind, 'mcp');
  assert.equal(d.title, 'do thing');
  assert.equal(d.detail, 'server');
  assert.match(d.body.args, /"q": 1/);
});

test('describeTool: unknown tools', () => {
  const d = describeTool('Mystery', { a: 1 }, CWD);
  assert.equal(d.kind, 'tool');
  assert.equal(d.title, 'Mystery');
});

test('applyHook: PreToolUse then PostToolUse is one ok entry with ms', () => {
  const log = createActivityLog();
  const session = newSession();
  const ctx = { session, label: 'proj' };
  const common = { session_id: session, cwd: CWD, tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'npm test' } };

  const [started] = applyHook({ ...common, hook_event_name: 'PreToolUse' }, log, ctx);
  assert.equal(started.status, 'running');
  applyHook({ ...common, hook_event_name: 'PostToolUse', tool_response: { stdout: 'passed', stderr: '' } }, log, ctx);

  const entries = log.all();
  assert.equal(entries.length, 1);
  const [e] = entries;
  assert.equal(e.id, `${session}:toolu_1`);
  assert.equal(e.kind, 'run');
  assert.equal(e.harness, 'claude');
  assert.equal(e.status, 'ok');
  assert.equal(typeof e.ms, 'number');
  assert.ok(e.ms >= 0);
  assert.equal(e.body.command, 'npm test');
  assert.equal(e.body.output, 'passed');
});

test('applyHook: PostToolUse arriving before PreToolUse still ends ok', () => {
  const log = createActivityLog();
  const session = newSession();
  const ctx = { session, label: 'proj' };
  const common = { session_id: session, cwd: CWD, tool_name: 'Read', tool_use_id: 'toolu_2', tool_input: { file_path: 'C:\\work\\proj\\a.js' } };

  applyHook({ ...common, hook_event_name: 'PostToolUse', tool_response: {} }, log, ctx);
  applyHook({ ...common, hook_event_name: 'PreToolUse' }, log, ctx);

  const entries = log.all();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'ok');
  assert.equal(entries[0].kind, 'read');
  assert.equal(entries[0].title, 'a.js');
});

test('applyHook: PostToolUseFailure marks the entry failed', () => {
  const log = createActivityLog();
  const session = newSession();
  const ctx = { session, label: 'proj' };
  const common = { session_id: session, cwd: CWD, tool_name: 'Bash', tool_use_id: 'toolu_f', tool_input: { command: 'false' } };
  applyHook({ ...common, hook_event_name: 'PreToolUse' }, log, ctx);
  applyHook({ ...common, hook_event_name: 'PostToolUseFailure', error: 'exit 1' }, log, ctx);
  const e = log.get(`${session}:toolu_f`);
  assert.equal(e.status, 'failed');
  assert.equal(e.error, 'exit 1');
});

test('applyHook: Stop settles running entries and adds a done entry', () => {
  const log = createActivityLog();
  const session = newSession();
  const ctx = { session, label: 'proj' };
  applyHook({ session_id: session, cwd: CWD, hook_event_name: 'UserPromptSubmit', prompt: 'fix the bug' }, log, ctx);
  applyHook({ session_id: session, cwd: CWD, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_3', tool_input: { command: 'sleep 100' } }, log, ctx);

  const changed = applyHook({ session_id: session, cwd: CWD, hook_event_name: 'Stop', last_assistant_message: 'All done.' }, log, ctx);

  assert.equal(log.get(`${session}:toolu_3`).status, 'stopped');
  const done = log.findLast(session, (x) => x.kind === 'done');
  assert.ok(done);
  assert.equal(done.status, 'ok');
  assert.equal(done.summary, 'All done.');
  assert.ok(changed.some((e) => e.id === `${session}:toolu_3`));
  assert.ok(log.findLast(session, (x) => x.kind === 'prompt' && x.title === 'fix the bug'));
});

test('applyHook: injected messages are not prompts', () => {
  const log = createActivityLog();
  const session = newSession();
  applyHook({ session_id: session, hook_event_name: 'UserPromptSubmit', prompt: '<system-reminder>x</system-reminder>' }, log, { session });
  assert.deepEqual(log.all(), []);
});

test('backfillTranscript rebuilds prompt, tool call and closing message', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-claude-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const session = newSession();
  const cwd = '/work/proj';
  const ts = (s) => `2026-09-30T10:00:0${s}.000Z`;
  const lines = [
    { type: 'user', uuid: 'u1', timestamp: ts(0), cwd, message: { role: 'user', content: 'fix the bug' } },
    { type: 'assistant', uuid: 'a1', timestamp: ts(1), cwd, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', uuid: 'u2', timestamp: ts(3), cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'passed' }] }, toolUseResult: { stdout: 'passed', stderr: '' } },
    { type: 'assistant', uuid: 'a2', timestamp: ts(4), cwd, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fixed the bug.' }] } },
  ];
  const path = join(dir, 'transcript.jsonl');
  await writeFile(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

  const log = createActivityLog();
  const changed = await backfillTranscript(path, log, { session });
  assert.ok(changed.length >= 3);

  const entries = log.all();
  assert.deepEqual(entries.map((e) => e.kind), ['prompt', 'run', 'done']);
  const [prompt, run, done] = entries;
  assert.equal(prompt.title, 'fix the bug');
  assert.equal(prompt.label, 'proj');
  assert.equal(run.id, `${session}:toolu_9`);
  assert.equal(run.status, 'ok');
  assert.equal(run.ms, 2000);
  assert.equal(run.body.output, 'passed');
  assert.equal(done.status, 'ok');
  assert.equal(done.summary, 'Fixed the bug.');

  // Replaying the same transcript doesn't duplicate anything.
  await backfillTranscript(path, log, { session });
  assert.equal(log.all().length, 3);

  assert.equal(await lastReply(path), 'Fixed the bug.');
  assert.equal(await lastReply(path, Date.parse(ts(5))), null);
});

test('backfillTranscript on a missing file returns nothing', async () => {
  const log = createActivityLog();
  assert.deepEqual(await backfillTranscript(join(tmpdir(), 'dotpals-does-not-exist.jsonl'), log, { session: newSession() }), []);
});
