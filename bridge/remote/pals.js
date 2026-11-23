// The remote client's agent pals: one animated pal per live session in a tray at the top of every page,
// and a graphical agent picker in Sessions. Both follow the live stream's state events ('dotpals:state',
// announced by stream.js: no second connection), so they cost nothing while the app is in the background.
// The pals are the same <dot-pal> the notch uses (src/), and the picker drives the dashboard's own Agent
// filter, so the list, the search and the URL keep working as they are.
import { DotPal } from '/src/index.js';
import { harnessName } from '/bridge/ui/recap.js';
import { agentChips, apply, characterFor, ordered, shownState, stateLine, summary } from './pals-core.js';
import { CAST } from './avatar-names.js';

const MAX = 6; // pals on the tray; the rest are one tap away in Sessions
const sessions = new Map();
const $ = (id) => document.getElementById(id);
const make = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const pal = (agent, size) => {
  const p = document.createElement('dot-pal');
  p.setAttribute('character', characterFor(agent, CAST));
  p.setAttribute('size', String(size));
  p.setAttribute('aria-hidden', 'true');
  return p;
};

// -- the tray ---------------------------------------------------------------------------------------
const tray = make('section');
tray.id = 'rc-tray';
tray.setAttribute('aria-label', 'Your agents');
const head = make('div', 'rc-tray-head');
const sum = make('span', 'rc-sum');
const talkBtn = make('button', 'rc-talk-btn', 'Talk');
talkBtn.type = 'button';
talkBtn.id = 'rc-talk-btn';
talkBtn.setAttribute('aria-haspopup', 'dialog');
talkBtn.onclick = () => dispatchEvent(new CustomEvent('dotpals:talk'));
head.append(sum, talkBtn);
const row = make('div', 'rc-pals');
tray.append(head, row);
const nodes = new Map(); // session id → { button, pal, name, line }

function paint(now = Date.now()) {
  const list = ordered(sessions, now);
  const shown = list.slice(0, MAX);
  // Talk is useful even when no coding agents are running.
  tray.hidden = false;
  row.hidden = !list.length;
  sum.textContent = summary(list);
  for (const [id, n] of nodes) if (!shown.some((s) => s.id === id)) { n.button.remove(); nodes.delete(id); }
  for (const s of shown) {
    let n = nodes.get(s.id);
    if (!n) {
      const button = make('button', 'rc-pal');
      button.type = 'button';
      n = { button, pal: pal(s.harness, 44), name: make('span', 'n'), line: make('small') };
      button.append(n.pal, n.name, n.line);
      button.onclick = () => { location.hash = `#sessions/${encodeURIComponent(s.id)}`; };
      nodes.set(s.id, n);
    }
    const state = shownState(s, now);
    n.button.dataset.state = state;
    n.button.setAttribute('aria-label', `${harnessName(s.harness)} ${s.label ?? ''}: ${stateLine({ ...s, state })}. Open its session.`);
    if (n.pal.getAttribute('state') !== state) n.pal.setAttribute('state', state);
    n.name.textContent = `${harnessName(s.harness)}${s.label ? ` · ${s.label}` : ''}`;
    n.line.textContent = stateLine({ ...s, state });
  }
  // Only reorder when the order changed: moving a pal in the page would restart its animation.
  const want = shown.map((s) => nodes.get(s.id).button);
  if (want.some((b, i) => row.children[i] !== b) || row.children.length !== want.length) row.replaceChildren(...want);
  chips();
}

// -- the agent picker: the dashboard's Agent filter, as buttons with a pal each -------------------------
const chipNodes = new Map(); // agent value → { button, count }
function chips() {
  const select = $('f-agent');
  const view = $('view-sessions');
  const toolbar = view?.querySelector('.toolbar');
  if (!select || !toolbar) return;
  let box = $('rc-chips');
  if (!box) {
    box = make('div');
    box.id = 'rc-chips';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Agent');
    toolbar.before(box);
  }
  const list = agentChips([...select.options].map((o) => ({ value: o.value, label: o.textContent })), sessions);
  for (const [value, n] of chipNodes) if (!list.some((c) => c.value === value)) { n.button.remove(); chipNodes.delete(value); }
  for (const c of list) {
    let n = chipNodes.get(c.value);
    if (!n) {
      const button = make('button', 'rc-chip');
      button.type = 'button';
      n = { button, count: make('b', 'live') };
      button.append(...(c.value ? [pal(c.value, 28)] : []), make('span', 'n', c.label), n.count);
      button.onclick = () => { select.value = c.value; select.dispatchEvent(new Event('change')); chips(); };
      chipNodes.set(c.value, n);
    }
    n.button.setAttribute('aria-pressed', String(select.value === c.value));
    n.count.textContent = c.live ? String(c.live) : '';
    n.count.hidden = !c.live;
    n.button.setAttribute('aria-label', `${c.label}${c.live ? `, ${c.live} working` : ''}`);
  }
  if (list.some((c, i) => box.children[i] !== chipNodes.get(c.value).button)) box.replaceChildren(...list.map((c) => chipNodes.get(c.value).button));
}

// -- wiring -------------------------------------------------------------------------------------------
let timer = 0;
const later = () => { if (!timer) timer = setTimeout(() => { timer = 0; if (document.visibilityState === 'visible') paint(); }, 120); };
addEventListener('dotpals:state', (e) => { apply(sessions, e.detail); later(); });
addEventListener('dotpals:reset', () => { sessions.clear(); paint(); });
for (const update of window.dotpalsStream?.snapshot().states ?? []) apply(sessions, update);
addEventListener('hashchange', later);
document.addEventListener('visibilitychange', later);
setInterval(later, 20_000); // dozing off, and the recently quiet leaving, need no event
document.querySelector('main')?.prepend(tray);
const filter = $('f-agent');
if (filter) { new MutationObserver(later).observe(filter, { childList: true }); filter.addEventListener('change', later); }
window.dotpalsPals = { sessions: () => [...sessions.values()], paint };
later();
