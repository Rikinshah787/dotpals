import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAINS, ask, brainsHere, correcting, isQuick, pickBrain, polished, polishSystem } from '../bridge/brain.js';

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
  const fetchFn = fakeFetch({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Hi, I’m Rikin.' }], stop_reason: 'end_turn' });
  const r = await ask(brain('anthropic'), { system: 'clean', text: 'hi im rikin', key: 'sk-ant-test', fetchFn });
  assert.equal(r.text, 'Hi, I’m Rikin.');
  assert.equal(r.by, 'Anthropic');
  const call = fetchFn.calls[0];
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.init.headers['x-api-key'], 'sk-ant-test');
  assert.equal(call.init.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual([call.body.model, call.body.system, call.body.messages, call.body.output_config], ['claude-opus-5-5', 'clean', [{ role: 'user', content: 'hi im rikin' }], { effort: 'low' }]);
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

test('polish: the dictionary goes in the instructions; a reply that answered instead of cleaning is dropped', () => {
  assert.match(polishSystem(['Rikin', 'Blu', 'coucou']), /Their own words \(names, products\): Rikin, Blu, coucou\. Speech recognition often writes these as other, similar-sounding words/);
  assert.equal(polishSystem([]).includes('Their own words'), false);
  assert.equal(polished('my name is rikin', '“My name is Rikin.”'), 'My name is Rikin.');
  assert.equal(polished('hi', 'Sure! Here is a long friendly answer to your greeting, with some extra ideas you might like to try today.'), null);
  assert.equal(polished('hi', '   '), null);
  // An answer, not your words cleaned up.
  assert.equal(polished('can you send me the report by Friday?', 'Sure, I will.'), null);
  assert.equal(polished('Hi, my name is Regan. I am. No, sorry, my name is Rikin.', 'Hi, my name is Rikin.'), 'Hi, my name is Rikin.');
  assert.equal(polished('we ship it with blue', 'We ship it with Blu.', ['Blu']), 'We ship it with Blu.'); // your words count as yours
  assert.equal(correcting('Hi, my name is Regan. I am. No, sorry, my name is Rikin.'), true);
  assert.equal(correcting('Ship it today, I mean it.'), true);
  assert.equal(correcting('The tests pass now.'), false);
});
