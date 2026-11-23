// The remote client's Talk panel: a notch-style island that drops from the top, with the Story of the
// session you're looking at (the same plain sentence the notch gives a request) and Blu to talk to.
// Blu is what the notch's Talk uses (/api/talk/buddy and /api/talk/plan). It needs this device's control
// switch (what Blu answers can start work on the computer) and an AI set up for the job, and says so when
// not. Starting work from here asks first: a plan card with Start, as on the computer.
import { buildTurns, harnessName } from '/bridge/ui/recap.js';
import { simple } from '/bridge/ui/story.js';
import { route } from '/bridge/ui/buddy.js';
import { DotPal } from '/src/index.js';
import { CAST } from './avatar-names.js';
import { characterFor, keepEntries, needs, ordered, shownState, stateLine, storyOf, talkGate } from './pals-core.js';

const entries = new Map();
let island = null;
let picked = null;
let busy = false;

const api = (path, body) => fetch(path, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-dotpals': '1' }, body: JSON.stringify(body) });
const make = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const smallPal = (character, size, state) => {
  const p = document.createElement('dot-pal');
  p.setAttribute('character', character);
  p.setAttribute('size', String(size));
  if (state) p.setAttribute('state', state);
  p.setAttribute('aria-hidden', 'true');
  return p;
};
const sessions = () => window.dotpalsPals?.sessions() ?? [];

addEventListener('dotpals:activity', (e) => keepEntries(entries, e.detail));
addEventListener('dotpals:reset', () => { entries.clear(); paintStory(); });
for (const entry of window.dotpalsStream?.snapshot().activity ?? []) keepEntries(entries, entry);

/** { ok, why } for a kind of ask: this device's control switch, and the AI the computer picked for it. */
async function gate(job) {
  try {
    const [me, brain] = await Promise.all([api('/api/remote/me').then((r) => r.json()), api('/api/brain').then((r) => r.json())]);
    return talkGate({ control: me.control, ready: brain[needs(job)] });
  } catch { return talkGate({ control: true, known: false }); }
}

function build() {
  const el = make('section');
  el.id = 'rc-talk';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Talk to Blu');
  el.tabIndex = -1;
  el.hidden = true;
  const top = make('div', 'rc-talk-top');
  const blu = smallPal('blu', 40);
  const close = make('button', 'rc-x', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.onclick = hide;
  top.append(blu, make('strong', '', 'Blu'), close);

  const story = make('div', 'rc-story');
  story.setAttribute('aria-live', 'polite');
  const who = make('div', 'rc-who');
  who.setAttribute('role', 'group');
  who.setAttribute('aria-label', 'Session');
  const text = make('p', 'rc-story-text');
  const warn = make('ul', 'rc-warn');
  story.append(who, text, warn);

  const form = make('form', 'rc-ask');
  const input = make('textarea');
  input.rows = 2;
  input.maxLength = 2000;
  input.placeholder = 'Ask Blu, or tell an agent what to do…';
  input.setAttribute('aria-label', 'What to say to Blu');
  const send = make('button', 'rc-send', 'Send');
  send.type = 'submit';
  form.append(input, send);
  const note = make('p', 'rc-note');
  note.setAttribute('role', 'status');
  const answer = make('div', 'rc-answer');
  answer.setAttribute('aria-live', 'polite');

  el.append(top, story, form, note, answer);
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  form.onsubmit = (e) => { e.preventDefault(); ask(input.value.trim()); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); } });
  document.body.append(el);
  return { el, blu, who, text, warn, input, send, note, answer };
}

function paintStory() {
  if (!island || island.el.hidden) return;
  const list = ordered(new Map(sessions().map((s) => [s.id, s])));
  if (!list.some((s) => s.id === picked)) picked = list[0]?.id ?? null;
  island.who.replaceChildren(...list.slice(0, 6).map((s) => {
    const b = make('button', 'rc-chip');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(s.id === picked));
    b.append(smallPal(characterFor(s.harness, CAST), 24, shownState(s)), make('span', 'n', `${harnessName(s.harness)}${s.label ? ` · ${s.label}` : ''}`));
    b.onclick = () => { picked = s.id; paintStory(); };
    return b;
  }));
  const s = list.find((x) => x.id === picked);
  const story = s ? storyOf(entries, s.id, { buildTurns, simple }) : null;
  // Waiting for you is what matters most: say what it's asking, not the request's summary ("Thinking…").
  island.text.textContent = s?.state === 'waiting' ? stateLine(s) : story?.text ?? (s ? stateLine(s) : 'No agents are running right now.');
  island.warn.replaceChildren(...(story?.warnings ?? []).map((w) => make('li', '', w)));
}

async function ask(text) {
  if (!text || busy) return;
  busy = true;
  island.send.disabled = true;
  island.answer.replaceChildren();
  const job = route(text);
  const g = await gate(job);
  island.note.textContent = g.why;
  if (!g.ok) { busy = false; island.send.disabled = false; return; }
  island.note.textContent = job === 'plan' ? 'Writing the plan…' : 'Blu is thinking…';
  island.blu.setAttribute('state', 'thinking');
  try {
    const res = await api(job === 'plan' ? '/api/talk/plan' : '/api/talk/buddy', { text, pal: 'Blu' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `The computer said ${res.status}`);
    island.note.textContent = '';
    if (data.plan) card(data.plan);
    else {
      const unavailable = data.do?.length || data.apps || data.task || data.words?.length;
      island.answer.append(make('p', 'rc-say', unavailable
        ? 'Desktop actions and connectors are unavailable from remote. Use Talk on the desktop to do this.'
        : data.say || data.reply || 'Okay.'));
    }
    island.blu.setAttribute('state', 'speaking');
    island.input.value = '';
  } catch (err) {
    island.note.textContent = err.message;
    island.blu.setAttribute('state', 'error');
  } finally {
    busy = false;
    island.send.disabled = false;
    setTimeout(() => island?.blu.setAttribute('state', 'idle'), 2500);
  }
}

/** A plan from Blu: what it will ask an agent to do, in which project, and when it counts as done. Nothing starts until Start. */
function card(plan) {
  const box = make('div', 'rc-plan');
  const done = make('ul');
  done.append(...(plan.done ?? []).map((d) => make('li', '', d.text || d.kind)));
  box.append(make('strong', '', plan.title || 'Plan'), make('p', '', plan.task || ''), make('small', '', `In ${plan.project?.name ?? 'a project'}${plan.guessedProject ? ' (a guess: check it)' : ''}`), done);
  const start = make('button', 'rc-send', 'Start');
  start.type = 'button';
  const cancel = make('button', '', 'Not now');
  cancel.type = 'button';
  cancel.onclick = () => box.remove();
  start.onclick = async () => {
    start.disabled = true;
    try {
      const res = await api('/api/talk/start', { id: plan.id });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `The computer said ${res.status}`);
      box.replaceChildren(make('p', '', 'Started. It will show up in your agents.'));
    } catch (err) { start.disabled = false; island.note.textContent = err.message; }
  };
  box.append(start, cancel);
  island.answer.append(box);
}

export function show() {
  island ??= build();
  island.el.hidden = false;
  document.documentElement.dataset.talk = 'open';
  paintStory();
  // A keyboard that opens by itself would cover the story: on a touch screen, focus the panel and let them tap the box.
  if (matchMedia('(pointer: coarse)').matches) island.el.focus({ preventScroll: true }); else island.input.focus({ preventScroll: true });
  gate('buddy').then((g) => { if (island && !island.el.hidden && !busy) island.note.textContent = g.why; });
}
export function hide() {
  if (!island) return;
  island.el.hidden = true;
  delete document.documentElement.dataset.talk;
  document.getElementById('rc-talk-btn')?.focus();
}
addEventListener('dotpals:talk', () => (island && !island.el.hidden ? hide() : show()));
addEventListener('dotpals:state', paintStory);
addEventListener('dotpals:activity', paintStory);
