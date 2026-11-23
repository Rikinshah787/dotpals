import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import vm from 'node:vm';
import { AVATAR_STATES, CAST, STATE_FOR_KIND, avatarName, avatarPath } from '../bridge/remote/avatar-names.js';
import { characterFor } from '../bridge/remote/pals-core.js';
import { characters } from '../src/characters.js';
import { AGENT_STATES } from '../src/element.js';
import { allowed } from '../bridge/remote-assets.js';
import { createPusher } from '../bridge/remote-push.js';

const dir = new URL('../bridge/remote/avatars/', import.meta.url);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A pusher with one device that wants everything; `sent` collects what it would send. */
function rig() {
  const sent = [];
  const prefs = { done: true, waiting: true, approval: true, stuck: true, conflict: true, loop: true, context: true, quietWhenOpen: false };
  const pusher = createPusher({
    remote: { pushTargets: () => [{ id: 'a', sub: { endpoint: 'https://p/x' }, control: true, prefs }], update() {} },
    hub: { open: () => false }, vapid: () => ({}), turn: () => ({ ms: 60_000, prompt: 'p' }),
    send: async (sub, body) => { sent.push(JSON.parse(body)); return { ok: true, status: 201 }; },
  });
  return { pusher, sent };
}

test('every notification kind has an expression, taken from the pal\'s own agent states', () => {
  for (const kind of ['done', 'waiting', 'approval', 'stuck', 'conflict', 'loop', 'context']) assert.ok(STATE_FOR_KIND[kind], kind);
  for (const state of Object.values(STATE_FOR_KIND)) {
    assert.ok(AVATAR_STATES.includes(state), `${state} has a picture`);
    assert.ok(state in AGENT_STATES, `${state} is one of the pal's own states (src/element.js), not an invented face`);
  }
  assert.equal(AGENT_STATES[STATE_FOR_KIND.done], 'happy');
  assert.equal(AGENT_STATES[STATE_FOR_KIND.waiting], 'waiting');
  assert.equal(AGENT_STATES[STATE_FOR_KIND.loop], 'sad');
});

test('the pals that can be pictured are the built-in ones, in the order src/characters.js has them', () => {
  assert.deepEqual(CAST, Object.keys(characters).filter((c) => c !== 'draft' && c !== 'custom'));
});

test('a picture exists for every pal and every state, and is a real PNG of a sensible size', () => {
  for (const character of CAST) for (const state of AVATAR_STATES) {
    const file = new URL(`${character}-${state}.png`, dir);
    assert.ok(existsSync(file), `${character}-${state}.png`);
    const bytes = readFileSync(file);
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
    assert.equal(bytes.readUInt32BE(16), 192); assert.equal(bytes.readUInt32BE(20), 192);
    assert.ok(statSync(file).size > 1500 && statSync(file).size < 120_000, `${character}-${state} size`);
    assert.ok(allowed(`/bridge/remote/avatars/${character}-${state}.png`), 'served to a paired phone');
  }
});

test('names are only ever ours: nothing from the network reaches a path', () => {
  assert.equal(avatarName('done', 'blu'), 'blu-done');
  assert.equal(avatarName('approval', 'nova'), 'nova-waiting');
  assert.equal(avatarName('nonsense', 'custom'), 'blu-done', 'a custom pal has no picture: the default pal');
  assert.equal(avatarPath('nova-error'), '/bridge/remote/avatars/nova-error.png');
  for (const bad of ['../../x', 'blu-done/../../x', 'blu-sleeping', 'evil-done', 'blu', '', null, undefined, 5, 'blu-done.png', 'BLU-done', '//evil.example/a-b']) assert.equal(avatarPath(bad), null, String(bad));
});

test('the same agent is the same pal in the tray, in Talk and in its notification', async () => {
  for (const harness of ['claude', 'codex', 'cursor', 'gemini', 'opencode', 'goose', 'cline-cli', undefined]) {
    const { pusher, sent } = rig();
    pusher.handle('message', { state: 'done', session: `s-${harness}`, harness });
    await wait(5);
    assert.equal(sent[0].avatar, `${characterFor(harness, CAST)}-done`, String(harness));
  }
});

test('each kind of notification carries its own pal and expression', async () => {
  const { pusher, sent } = rig();
  pusher.handle('approval', { status: 'pending', id: 'abcdefgh', harness: 'claude', kind: 'run', command: 'ls' });
  pusher.handle('stuck', { session: 's1', harness: 'codex', text: 'same error' });
  pusher.handle('loop', { kind: 'gave-up', session: 's2', harness: 'cursor', text: 'x' });
  pusher.handle('conflict', { session: 's3', harness: 'gemini', text: 'x' });
  pusher.handle('context', { known: true, used: 95, size: 100, session: 's4', harness: 'opencode' });
  pusher.handle('message', { state: 'done', session: 's5', harness: 'claude' });
  await wait(30);
  const by = Object.fromEntries(sent.map((n) => [n.kind, n.avatar]));
  assert.equal(by.approval, `${characterFor('claude', CAST)}-waiting`);
  assert.equal(by.stuck, `${characterFor('codex', CAST)}-thinking`);
  assert.equal(by.loop, `${characterFor('cursor', CAST)}-error`);
  assert.equal(by.conflict, `${characterFor('gemini', CAST)}-error`);
  assert.equal(by.context, `${characterFor('opencode', CAST)}-working`);
  assert.equal(by.done, `${characterFor('claude', CAST)}-done`);
  for (const n of sent) assert.ok(avatarPath(n.avatar), n.avatar);
});

test('a test notification wears the default pal; the picture name is bounded', async () => {
  const { pusher, sent } = rig();
  await pusher.test('a');
  assert.equal(sent[0].avatar, 'blu-done');
});

test('the service worker shows the avatar, and only ever one of ours', async () => {
  const source = readFileSync(new URL('../bridge/remote/sw.js', import.meta.url), 'utf8').replace('__VERSION__', 't');
  const shown = [];
  const handlers = {};
  const self = { location: { origin: 'https://x' }, addEventListener: (t, fn) => { handlers[t] = fn; }, registration: { showNotification: async (title, o) => { shown.push(o); } }, clients: { matchAll: async () => [] } };
  class Res { constructor(b) { this.b = b; } json() { return Promise.resolve(JSON.parse(this.b)); } }
  const cache = { put: async () => {}, match: async () => null };
  vm.runInNewContext(source, { self, caches: { open: async () => cache, keys: async () => [], delete: async () => {} }, URL, Request: class {}, Response: Res, Promise, String, Number, JSON, Date, setTimeout, clearTimeout, fetch: async () => ({ status: 200 }) });
  const push = async (note) => { const waits = []; handlers.push({ data: { json: () => note, text: () => '' }, waitUntil: (p) => waits.push(p) }); await Promise.all(waits); };
  await push({ kind: 'done', title: 'x', avatar: 'nova-error' });
  await push({ kind: 'done', title: 'x', avatar: '../../etc/passwd' });
  await push({ kind: 'done', title: 'x', avatar: 'https://evil.example/a.png' });
  await push({ kind: 'done', title: 'x' });
  assert.deepEqual(shown.map((o) => o.icon), ['/bridge/remote/avatars/nova-error.png', ...Array(3).fill('/bridge/remote/icons/icon-192.png')]);
  assert.ok(shown.every((o) => o.badge === '/bridge/remote/icons/icon-96.png'), 'the small status-bar badge stays the app\'s');
});

test('the offline shell holds the names the page imports', () => {
  const sw = readFileSync(new URL('../bridge/remote/sw.js', import.meta.url), 'utf8');
  assert.ok(sw.includes("'/bridge/remote/avatar-names.js'"));
});
