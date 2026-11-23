import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentChips, apply, characterFor, keepEntries, needs, ordered, shownState, stateLine, storyOf, summary, talkGate } from '../bridge/remote/pals-core.js';

const NOW = 1_000_000_000;
const ev = (session, state, o = {}) => ({ session, harness: 'claude', label: 'app', state, at: NOW, ...o });

test('a state event adds or updates a session; "sleeping" removes it', () => {
  const m = new Map();
  apply(m, ev('a', 'working', { text: 'Editing x.js' }));
  assert.equal(m.get('a').state, 'working');
  assert.equal(m.get('a').text, 'Editing x.js');
  apply(m, ev('a', 'thinking', { at: NOW + 1 }));
  assert.equal(m.get('a').text, '', 'a new state starts without the old one’s words');
  apply(m, { session: 'a', state: 'thinking', at: NOW + 2 });
  assert.equal(m.get('a').label, 'app', 'what an event leaves out is kept');
  apply(m, ev('a', 'sleeping'));
  assert.equal(m.size, 0);
});

test('junk events change nothing', () => {
  const m = new Map();
  apply(m, null); apply(m, {}); apply(m, { session: 5, state: 'working' }); apply(m, { session: '', state: 'working' });
  assert.equal(m.size, 0);
  apply(m, ev('a', 'nonsense'));
  assert.equal(m.get('a').state, 'idle', 'an unknown state is not shown as one');
});

test('the tray puts who needs you first, then who is working, then the recently quiet; the long quiet leave', () => {
  const m = new Map();
  apply(m, ev('quiet', 'idle', { at: NOW - 60_000 }));
  apply(m, ev('work', 'working', { at: NOW - 5_000 }));
  apply(m, ev('wait', 'waiting', { at: NOW - 90_000 }));
  apply(m, ev('old', 'done', { at: NOW - 30 * 60_000 }));
  assert.deepEqual(ordered(m, NOW).map((s) => s.id), ['wait', 'work', 'quiet']);
});

test('a quiet session dozes off after three minutes; a working one never does', () => {
  assert.equal(shownState({ state: 'idle', at: NOW - 4 * 60_000 }, NOW), 'sleeping');
  assert.equal(shownState({ state: 'idle', at: NOW - 60_000 }, NOW), 'idle');
  assert.equal(shownState({ state: 'working', at: NOW - 20 * 60_000 }, NOW), 'working');
  assert.equal(shownState({ state: 'waiting', at: NOW - 20 * 60_000 }, NOW), 'waiting');
});

test('each agent gets the same pal every time, from the characters there are', () => {
  const cast = ['blu', 'spider', 'fox', 'owl'];
  assert.equal(characterFor('claude', cast), characterFor('claude', cast));
  assert.ok(cast.includes(characterFor('codex', cast)));
  assert.equal(characterFor('x', []), 'blu');
  assert.ok(new Set(['claude', 'codex', 'goose', 'cline-cli', 'cursor'].map((k) => characterFor(k, cast))).size > 1, 'not all the same pal');
});

test('the line under a pal: its step, or the state in words, kept short', () => {
  assert.equal(stateLine({ state: 'working', text: 'Editing a.js' }), 'Editing a.js');
  assert.equal(stateLine({ state: 'waiting' }), 'Needs you');
  assert.equal(stateLine({ state: 'working', text: 'x'.repeat(200) }).length, 80);
  assert.equal(stateLine(null), '');
});

test('the summary counts who is working and who needs you', () => {
  const s = (state) => ({ state });
  assert.equal(summary([s('working'), s('thinking'), s('waiting')]), '2 working, 1 needs you');
  assert.equal(summary([s('waiting'), s('waiting')]), '2 need you');
  assert.equal(summary([s('idle')]), 'All quiet');
  assert.equal(summary([]), '');
});

test('the picker shows how many of each agent are working, and all of them under "All agents"', () => {
  const m = new Map();
  apply(m, ev('a', 'working')); apply(m, ev('b', 'working')); apply(m, ev('c', 'working', { harness: 'goose' })); apply(m, ev('d', 'idle', { harness: 'codex' }));
  const chips = agentChips([{ value: '', label: 'All agents' }, { value: 'claude', label: 'Claude' }, { value: 'goose', label: 'Goose' }, { value: 'codex', label: 'Codex' }], m);
  assert.deepEqual(chips.map((c) => c.live), [3, 2, 1, 0]);
});

test('Talk needs the control switch and an AI set up, and says which is missing', () => {
  assert.equal(talkGate({ control: false, ready: 'claude' }).ok, false);
  assert.match(talkGate({ control: false, ready: 'claude' }).why, /look, not control/);
  assert.match(talkGate({ control: true, ready: null }).why, /Blu’s brain/);
  assert.match(talkGate({ control: true, known: false }).why, /Couldn’t ask/);
  assert.deepEqual(talkGate({ control: true, ready: 'claude' }), { ok: true, why: '' });
});

test('Blu plans work for an agent, and answers the rest itself', () => {
  assert.equal(needs('plan'), 'plan');
  assert.equal(needs('buddy'), 'screen');
});

test('the story is the plain sentence for the session’s newest request, from its own steps only', () => {
  const entries = new Map();
  keepEntries(entries, { id: '1', session: 'a', at: 1, kind: 'prompt' });
  keepEntries(entries, { id: '2', session: 'b', at: 2, kind: 'prompt' });
  const seen = [];
  const deps = { buildTurns: (list) => { seen.push(list.map((e) => e.id)); return [{ n: 1 }, { n: 2 }]; }, simple: (t) => ({ text: `turn ${t.n}`, status: 'ok', warnings: [] }) };
  assert.equal(storyOf(entries, 'a', deps).text, 'turn 2');
  assert.deepEqual(seen, [['1']], 'another session’s steps are not in it');
  assert.equal(storyOf(entries, 'nobody', deps), null);
});

test('a phone keeps only the newest steps of a session', () => {
  const m = new Map();
  for (let i = 0; i < 10; i++) keepEntries(m, { id: `e${i}`, session: 'a', at: i }, 4);
  keepEntries(m, { id: 'other', session: 'b', at: 0 }, 4);
  assert.deepEqual([...m.keys()].sort(), ['e6', 'e7', 'e8', 'e9', 'other']);
  keepEntries(m, null);
  keepEntries(m, {});
  assert.equal(m.size, 5);
});

test('the dashboard tells a look-only phone what to do instead of "Couldn’t ask. Is the bridge running?"', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../bridge/dashboard.html', import.meta.url), 'utf8');
  // api() keeps the bridge's own words for a refusal (error: 'control', message: what to do) and the status.
  assert.match(html, /data\.error === 'control' && data\.message \? data\.message/);
  assert.match(html, /Object\.assign\(new Error\(message\), \{ status: res\.status \}\)/);
  // The brain test and settings saves show that message when the bridge answered; "is it running" only when it didn't.
  assert.match(html, /err\.status \? `✗ \$\{err\.message\}` : 'Couldn’t ask\. Is the bridge running\?'/);
  assert.match(html, /err\.status \? err\.message : 'Couldn’t save\. Is the bridge running\?'/);
});

test('wired in: client.js loads the pals and Talk, the service worker caches them, and they have a place to go', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(`../bridge/remote/${p}`, import.meta.url), 'utf8');
  for (const f of ['pals.js', 'talk.js']) assert.ok(read('client.js').includes(`import './${f}'`), f);
  for (const f of ['pals.js', 'pals-core.js', 'talk.js']) assert.ok(read('sw.js').includes(`/bridge/remote/${f}`), f);
  const css = read('remote.css');
  for (const sel of ['#rc-tray', '.rc-pal', '#rc-chips', '.rc-chip', '#rc-talk', 'html[data-fold="book"] #rc-talk', 'html[data-fold="table"] #rc-talk']) assert.ok(css.includes(sel), sel);
  assert.ok(read('stream.js').includes('dotpals:state'));
  // The unfolded layouts: in a book the picker and the search stay on the first screen (above the list they filter), and the
  // Report card's row labels wrap so the agents get the room; on a tabletop the tray is one row, not a quarter of the half you read.
  assert.ok(css.includes('html[data-fold="book"] #rc-chips, html[data-fold="book"] .view > .toolbar { grid-column: 1;'));
  assert.ok(css.includes('html[data-fold="table"] .rc-pals { flex-wrap: nowrap;'));
  assert.match(css, /html\[data-fold="book"\] \.rc th\[scope="row"\][^{]*\{[^}]*white-space: normal/);
  assert.match(css, /@media \(max-width: 720px\) \{ \.rc th\[scope="row"\]/);
});
