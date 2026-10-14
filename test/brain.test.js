import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAINS, ask, brainsHere, correcting, isQuick, pickBrain, polished, polishSystem, sees, streamResult, warmUp, askWithTools, usesTools, geminiSchema } from '../bridge/brain.js';

const brain = (id) => BRAINS.find((b) => b.id === id);
/** A fetch that answers with `body` and remembers what it was asked. */
function fakeFetch(body, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null }); return { ok, status, json: async () => body }; };
  fn.calls = calls;
  return fn;
}

test('brainsHere: installed command lines, saved keys and Ollama’s models', async () => {
  const fetchFn = async (url) => ({ ok: true, json: async () => ({ models: [{ name: 'llama3.2:3b' }] }) });
  const here = await brainsHere({ keys: { openai: true }, find: (bin) => (bin === 'claude' ? 'C:\\bin\\claude.cmd' : null), fetchFn });
  const by = Object.fromEntries(here.map((b) => [b.id, b]));
  assert.equal(by.claude.ready, true);
  assert.equal(by.codex.ready, false);
  assert.equal(by.openai.ready, true);
  assert.equal(by.anthropic.ready, false);
  assert.deepEqual([by.ollama.ready, by.ollama.model], [true, 'llama3.2:3b']);
  const off = await brainsHere({ find: () => null, fetchFn: async () => { throw new Error('ECONNREFUSED'); } });
  assert.deepEqual([off.find((b) => b.id === 'ollama').ready, off.find((b) => b.id === 'ollama').why], [false, 'not running']);
});

test('pickBrain: your choice if it’s ready; else the quickest for a quick job, Claude Code for a plan', () => {
  const here = BRAINS.map((b) => ({ ...b, ready: ['claude', 'openai'].includes(b.id) }));
  assert.equal(pickBrain(here, { job: 'quick' }).id, 'openai');
  assert.equal(pickBrain(here, { job: 'plan' }).id, 'claude');
  assert.equal(pickBrain(here, { choice: 'claude', job: 'quick' }).id, 'claude');
  assert.equal(pickBrain(here, { choice: 'anthropic' }), null); // chosen but no key
  assert.equal(pickBrain(BRAINS.map((b) => ({ ...b, ready: false }))), null);
  assert.equal(isQuick(brain('ollama')), true);
  assert.equal(isQuick(brain('claude')), false);
  // Cursor and Gemini CLI run with their tools: your dictation only, never a plan (it has other agents' text).
  const cursor = BRAINS.map((b) => ({ ...b, ready: ['cursor', 'claude'].includes(b.id) }));
  assert.equal(pickBrain(cursor, { choice: 'cursor', job: 'quick' }).id, 'cursor');
  assert.equal(pickBrain(cursor, { choice: 'cursor', job: 'plan' }).id, 'claude');
  assert.equal(pickBrain(BRAINS.map((b) => ({ ...b, ready: b.id === 'gemini' })), { job: 'plan' }), null);
});

test('ask: Anthropic’s Messages API, its text blocks only, low effort on current models', async () => {
  const fetchFn = fakeFetch({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Hi, I’m ready.' }], stop_reason: 'end_turn' });
  const r = await ask(brain('anthropic'), { system: 'clean', text: 'hi im ready', key: 'sk-ant-test', fetchFn });
  assert.equal(r.text, 'Hi, I’m ready.');
  assert.equal(r.by, 'Anthropic');
  const call = fetchFn.calls[0];
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.init.headers['x-api-key'], 'sk-ant-test');
  assert.equal(call.init.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual([call.body.model, call.body.system, call.body.messages, call.body.output_config], ['claude-opus-5-5', 'clean', [{ role: 'user', content: 'hi im ready' }], { effort: 'low' }]);
  await assert.rejects(ask(brain('anthropic'), { system: 's', text: 't', key: 'k', fetchFn: fakeFetch({ content: [], stop_reason: 'refusal' }) }), /declined/);
  await assert.rejects(ask(brain('anthropic'), { system: 's', text: 't', key: 'bad', fetchFn: fakeFetch({ error: { message: 'invalid x-api-key' } }, { ok: false, status: 401 }) }), /Anthropic: invalid x-api-key/);
});

test('ask: OpenAI, OpenRouter, Gemini and Ollama, each in its own shape; <think> comes off', async () => {
  const openai = fakeFetch({ choices: [{ message: { content: 'Done.' } }] });
  assert.equal((await ask(brain('openai'), { system: 's', text: 't', key: 'sk-1', fetchFn: openai })).text, 'Done.');
  assert.equal(openai.calls[0].init.headers.authorization, 'Bearer sk-1');
  assert.deepEqual(openai.calls[0].body.messages.map((m) => m.role), ['system', 'user']);
  const router = fakeFetch({ choices: [{ message: { content: 'ok' } }] });
  await ask(brain('openrouter'), { system: 's', text: 't', key: 'k', fetchFn: router });
  assert.equal(router.calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  const google = fakeFetch({ candidates: [{ content: { parts: [{ text: 'Hi ' }, { text: 'there.' }] } }] });
  assert.equal((await ask(brain('google'), { system: 's', text: 't', key: 'g', fetchFn: google })).text, 'Hi there.');
  assert.match(google.calls[0].url, /models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(google.calls[0].init.headers['x-goog-api-key'], 'g');
  const ollama = fakeFetch({ message: { content: '<think>hmm</think>\nHello.' } });
  assert.equal((await ask(brain('ollama'), { system: 's', text: 't', model: 'qwen3:4b', fetchFn: ollama })).text, 'Hello.');
  assert.deepEqual([ollama.calls[0].url, ollama.calls[0].body.model, ollama.calls[0].body.stream], ['http://127.0.0.1:11434/api/chat', 'qwen3:4b', false]);
});

test('ask: Claude Code runs lean, the instructions in a file and what was said on stdin', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-brain-'));
  process.env.DOTPALS_HOME = dir;
  t.after(async () => { delete process.env.DOTPALS_HOME; await rm(dir, { recursive: true, force: true }); });
  const seen = [];
  const runner = async (file, args, opts) => { seen.push({ file, args, opts }); return { code: 0, stdout: 'Clean text.\n', stderr: '' }; };
  const r = await ask(brain('claude'), { system: 'clean it', text: 'um clean it', runner, find: () => '/usr/bin/claude' });
  assert.equal(r.text, 'Clean text.');
  const { args, opts } = seen[0];
  assert.deepEqual(args.slice(0, 3), ['-p', '--model', 'haiku']);
  assert.ok(args.includes('--strict-mcp-config') && args.includes('--system-prompt-file'));
  assert.ok(!args.some((a) => a.includes('um clean it')), 'what was said never goes on the command line');
  assert.equal(opts.input, 'um clean it');
  assert.equal(opts.env.MAX_THINKING_TOKENS, '0');
  // The brain as detected (what the bridge passes) still knows its program.
  const detected = pickBrain(await brainsHere({ find: (bin) => (bin === 'claude' ? '/usr/bin/claude' : null), fetchFn: async () => ({ ok: false }) }), { job: 'plan' });
  assert.equal((await ask(detected, { system: 's', text: 't', runner, find: (bin) => (bin === 'claude' ? '/usr/bin/claude' : null) })).text, 'Clean text.');
  await assert.rejects(ask(brain('codex'), { system: 's', text: 't', runner, find: () => null }), /isn’t installed/);
  const failing = async () => ({ code: 1, stdout: '', stderr: 'Not logged in' });
  await assert.rejects(ask(brain('gemini'), { system: 's', text: 't', runner: failing, find: () => '/bin/gemini' }), /Gemini CLI: Not logged in/);
});

test('screen: the brains that can see, keys first; never one running with its tools', () => {
  const here = BRAINS.map((b) => ({ ...b, ready: ['claude', 'cursor', 'gemini'].includes(b.id) }));
  assert.equal(pickBrain(here, { job: 'screen' }).id, 'claude');
  assert.equal(pickBrain(here, { choice: 'cursor', job: 'screen' }).id, 'claude'); // Cursor runs with its tools: not for what's on your screen
  assert.equal(pickBrain(BRAINS.map((b) => ({ ...b, ready: ['claude', 'google'].includes(b.id) })), { job: 'screen' }).id, 'google');
  assert.equal(pickBrain(BRAINS.map((b) => ({ ...b, ready: b.id === 'gemini' })), { job: 'screen' }), null);
  assert.equal(sees(brain('anthropic')), true);
  assert.equal(sees(brain('cursor')), false);
});

test('ask with a picture: each provider in its own shape', async () => {
  const images = [{ type: 'image/jpeg', data: 'QUJD' }];
  const anthropic = fakeFetch({ content: [{ type: 'text', text: '{}' }] });
  await ask(brain('anthropic'), { system: 's', text: 'what is this', images, key: 'k', fetchFn: anthropic });
  assert.deepEqual(anthropic.calls[0].body.messages[0].content, [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } }, { type: 'text', text: 'what is this' }]);
  const openai = fakeFetch({ choices: [{ message: { content: '{}' } }] });
  await ask(brain('openai'), { system: 's', text: 't', images, key: 'k', fetchFn: openai });
  assert.deepEqual(openai.calls[0].body.messages[1].content[1], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } });
  const google = fakeFetch({ candidates: [{ content: { parts: [{ text: '{}' }] } }] });
  await ask(brain('google'), { system: 's', text: 't', images, key: 'k', fetchFn: google });
  assert.deepEqual(google.calls[0].body.contents[0].parts[0], { inline_data: { mime_type: 'image/jpeg', data: 'QUJD' } });
  const ollama = fakeFetch({ message: { content: '{}' } });
  await ask(brain('ollama'), { system: 's', text: 't', images, model: 'gemma3', fetchFn: ollama });
  assert.deepEqual(ollama.calls[0].body.messages[1].images, ['QUJD']);
  await assert.rejects(ask(brain('cursor'), { system: 's', text: 't', images }), /can’t look at your screen/);
});

test('ask with a picture: Claude Code takes it in stream-json, still with no tools; its result line is the answer', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-brain-'));
  process.env.DOTPALS_HOME = dir;
  t.after(async () => { delete process.env.DOTPALS_HOME; await rm(dir, { recursive: true, force: true }); });
  const seen = [];
  const out = [JSON.stringify({ type: 'system', subtype: 'init' }), JSON.stringify({ type: 'assistant', message: {} }), JSON.stringify({ type: 'result', result: '{"say":"A bar chart."}', is_error: false })].join('\n');
  const runner = async (file, args, opts) => { seen.push({ args, opts }); return { code: 0, stdout: out, stderr: '' }; };
  const r = await ask(brain('claude'), { system: 's', text: 'what song', images: [{ type: 'image/jpeg', data: 'QUJD' }], runner, find: () => '/usr/bin/claude' });
  assert.equal(r.text, '{"say":"A bar chart."}');
  const { args, opts } = seen[0];
  assert.deepEqual(args.slice(args.indexOf('--input-format'), args.indexOf('--input-format') + 2), ['--input-format', 'stream-json']);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  const message = JSON.parse(opts.input);
  assert.deepEqual(message.message.content.map((c) => c.type), ['image', 'text']);
  assert.equal(streamResult('not json\n{"type":"result","result":"x"}').result, 'x');
  assert.equal(streamResult(''), null);
  const failing = async () => ({ code: 1, stdout: JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in' }), stderr: '' });
  await assert.rejects(ask(brain('claude'), { system: 's', text: 't', images: [{ type: 'image/jpeg', data: 'QUJD' }], runner: failing, find: () => '/usr/bin/claude' }), /Claude Code: Not logged in/);
});

test('warmUp: Claude Code started while you talk gets the question when it comes; other instructions start their own; unused, it gets nothing and stops', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-brain-'));
  process.env.DOTPALS_HOME = dir;
  t.after(async () => { delete process.env.DOTPALS_HOME; await rm(dir, { recursive: true, force: true }); });
  const started = [];
  const runner = (file, args, opts) => {
    const run = { args, input: null };
    started.push(run);
    return Promise.resolve(opts.input).then((input) => { run.input = input; return { code: 0, stdout: input ? JSON.stringify({ type: 'result', result: 'warm answer' }) : '', stderr: '' }; });
  };
  const find = () => '/usr/bin/claude';
  assert.equal(await warmUp(brain('claude'), { system: 'look', runner, find }), true);
  assert.equal(await warmUp(brain('claude'), { system: 'look', runner, find }), true); // already one
  assert.equal(started.length, 1);
  assert.ok(started[0].args.includes('stream-json'));
  const r = await ask(brain('claude'), { system: 'look', text: 'play jazz', runner, find });
  assert.equal(r.text, 'warm answer');
  assert.equal(started.length, 1); // no second start
  assert.equal(JSON.parse(started[0].input).message.content[0].text, 'play jazz');
  assert.equal(await warmUp(brain('openai'), { system: 'look' }), false); // only a command line starts slowly
  await warmUp(brain('claude'), { system: 'look', runner, find, waitMs: 20 });
  await new Promise((r2) => setTimeout(r2, 60));
  assert.equal(started[1].input, ''); // nothing came: it's told there's nothing to do
});

test('askWithTools: each API in its own shape calls your app’s tool, gets the answer back, then answers; receipts for each call', async () => {
  const tools = [{ name: 'cal__list_events', description: 'Events', schema: { type: 'object', properties: { day: { type: ['string', 'null'], description: 'Which day' } }, required: ['day'], additionalProperties: false } }];
  const called = [];
  const call = async (name, args) => { called.push([name, args]); return 'Lunch with Sam at 1'; };
  /** A fetch that answers with each of `bodies` in turn. */
  const turns = (...bodies) => { const f = fakeFetch(null); let i = 0; const fn = async (url, init) => { f.calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => bodies[i++] }; }; fn.calls = f.calls; return fn; };

  const anthropic = turns({ content: [{ type: 'tool_use', id: 'tu1', name: 'cal__list_events', input: { day: 'today' } }], stop_reason: 'tool_use' }, { content: [{ type: 'text', text: 'You have lunch with Sam at 1.' }], stop_reason: 'end_turn' });
  const a = await askWithTools(brain('anthropic'), { system: 's', text: 'what’s on today?', tools, call, key: 'k', fetchFn: anthropic });
  assert.deepEqual([a.text, a.calls], ['You have lunch with Sam at 1.', [{ name: 'cal__list_events', ok: true }]]);
  assert.deepEqual(anthropic.calls[0].body.tools[0].name, 'cal__list_events');
  assert.deepEqual(anthropic.calls[1].body.messages.at(-1).content, [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Lunch with Sam at 1' }]);

  const openai = turns({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'cal__list_events', arguments: '{"day":"today"}' } }] } }] }, { choices: [{ message: { content: 'Lunch at 1.' } }] });
  assert.equal((await askWithTools(brain('openai'), { system: 's', text: 't', tools, call, key: 'k', fetchFn: openai })).text, 'Lunch at 1.');
  assert.deepEqual(openai.calls[1].body.messages.at(-1), { role: 'tool', tool_call_id: 'c1', content: 'Lunch with Sam at 1' });

  const google = turns({ candidates: [{ content: { parts: [{ functionCall: { name: 'cal__list_events', args: { day: 'today' } }, thoughtSignature: 'sig' }] } }] }, { candidates: [{ content: { parts: [{ text: 'Lunch at 1.' }] } }] });
  assert.equal((await askWithTools(brain('google'), { system: 's', text: 't', tools, call, key: 'k', fetchFn: google })).text, 'Lunch at 1.');
  assert.deepEqual(google.calls[0].body.tools[0].functionDeclarations[0].parameters, { type: 'object', properties: { day: { type: 'string', nullable: true, description: 'Which day' } }, required: ['day'] }); // Gemini's kind of schema
  assert.equal(google.calls[1].body.contents[1].parts[0].thoughtSignature, 'sig'); // its turn goes back as it came
  assert.deepEqual(google.calls[1].body.contents[2].parts[0].functionResponse, { name: 'cal__list_events', response: { result: 'Lunch with Sam at 1' } });

  const ollama = turns({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'cal__list_events', arguments: { day: 'today' } } }] } }, { message: { content: 'Lunch at 1.' } });
  assert.equal((await askWithTools(brain('ollama'), { system: 's', text: 't', tools, call, model: 'qwen3', fetchFn: ollama })).text, 'Lunch at 1.');
  assert.deepEqual(ollama.calls[1].body.messages.at(-1), { role: 'tool', tool_name: 'cal__list_events', content: 'Lunch with Sam at 1' });
  assert.equal(called.length, 4);
  // A tool that fails is a ✗ receipt, and the brain hears why; brains that can't use tools say so.
  const failing = turns({ content: [{ type: 'tool_use', id: 'x', name: 'cal__list_events', input: {} }], stop_reason: 'tool_use' }, { content: [{ type: 'text', text: 'It didn’t work.' }] });
  const f = await askWithTools(brain('anthropic'), { system: 's', text: 't', tools, call: async () => { throw new Error('offline'); }, key: 'k', fetchFn: failing });
  assert.deepEqual(f.calls, [{ name: 'cal__list_events', ok: false }]);
  assert.equal(failing.calls[1].body.messages.at(-1).content[0].content, 'Error: offline');
  await assert.rejects(askWithTools(brain('codex'), { system: 's', text: 't', tools, call }), /can’t use your apps/);
  assert.deepEqual([usesTools(brain('claude')), usesTools(brain('gemini')), usesTools(brain('ollama'))], [true, false, true]);
  assert.deepEqual(geminiSchema({ anyOf: [{ type: 'null' }, { type: 'integer' }] }), { type: 'integer' });
});

test('askWithTools, Claude Code: your app as its MCP config, only the tools it may use, the calls read back from its output', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-brain-'));
  process.env.DOTPALS_HOME = dir;
  t.after(async () => { delete process.env.DOTPALS_HOME; await rm(dir, { recursive: true, force: true }); });
  let seen;
  const out = [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__cal__list_events' }] } }), JSON.stringify({ type: 'result', result: 'Lunch at 1.', is_error: false })].join('\n');
  const runner = async (file, args, opts) => { const { readFileSync } = await import('node:fs'); seen = { args, config: JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')), input: opts.input }; return { code: 0, stdout: out, stderr: '' }; };
  const r = await askWithTools(brain('claude'), { system: 's', text: 'what’s on today?', mcp: { config: { mcpServers: { cal: { type: 'http', url: 'https://x.dev/mcp', headers: { Authorization: 'Bearer t' } } } }, allowed: ['mcp__cal__list_events'] }, runner, find: () => '/usr/bin/claude' });
  assert.deepEqual([r.text, r.calls], ['Lunch at 1.', [{ name: 'mcp__cal__list_events', ok: true }]]);
  assert.equal(seen.args[seen.args.indexOf('--allowedTools') + 1], 'mcp__cal__list_events');
  assert.ok(seen.args.includes('--strict-mcp-config'));
  assert.equal(seen.args[seen.args.indexOf('--tools') + 1], '');
  assert.equal(seen.config.mcpServers.cal.url, 'https://x.dev/mcp');
  assert.equal(seen.input, 'what’s on today?');
});

test('polish: the dictionary goes in the instructions; a reply that answered instead of cleaning is dropped', () => {
  assert.match(polishSystem(['dotpals', 'Blu']), /Their own words \(names, products\): dotpals, Blu\. Speech recognition often writes these as other, similar-sounding words/);
  assert.equal(polishSystem([]).includes('Their own words'), false);
  assert.equal(polished('we ship it with blu today', '“We ship it with Blu today.”'), 'We ship it with Blu today.');
  assert.equal(polished('hi', 'Sure! Here is a long friendly answer to your greeting, with some extra ideas you might like to try today.'), null);
  assert.equal(polished('hi', '   '), null);
  // An answer, not your words cleaned up.
  assert.equal(polished('can you send me the report by Friday?', 'Sure, I will.'), null);
  assert.equal(polished('The meeting is on Monday. It is. No, sorry, the meeting is on Tuesday.', 'The meeting is on Tuesday.'), 'The meeting is on Tuesday.');
  assert.equal(polished('we ship it with blue', 'We ship it with Blu.', ['Blu']), 'We ship it with Blu.'); // your words count as yours
  assert.equal(correcting('The meeting is on Monday. It is. No, sorry, the meeting is on Tuesday.'), true);
  assert.equal(correcting('Ship it today, I mean it.'), true);
  assert.equal(correcting('The tests pass now.'), false);
});
