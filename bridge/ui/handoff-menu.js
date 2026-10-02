// "Continue in ▾": hand a session to another agent, from the pal, the notch and the
// dashboard. Each agent installed here (Codex, Claude Code, Gemini CLI) opens in a NEW
// terminal, in the session's own folder, told to read the hand-off note the bridge wrote
// (see bridge/handoff.js); Copy puts the note on the clipboard, to paste anywhere. It
// can't type into an agent that's already open.
//
//   continueMenu(session, { copy?, inline? }) → an element to put in a header
//   copy:   (text) => void, the page's own clipboard (the desktop app's, say)
//   inline: the menu opens in place instead of floating (inside a scrolling box)

const CSS = `
.dp-handoff { position: relative; display: inline-flex; flex-direction: column; align-items: flex-end; -webkit-app-region: no-drag; }
.dp-handoff.inline { align-items: stretch; }
.dp-handoff .dp-ho-toggle { white-space: nowrap; }
.dp-ho-menu { position: absolute; top: calc(100% + 4px); right: 0; z-index: 60; min-width: 220px; max-width: 300px; display: grid; gap: 1px; padding: 4px; border-radius: 10px; background: var(--raise, #1c1c22); border: 1px solid var(--line, #2a2a31); box-shadow: 0 10px 28px rgb(0 0 0 / .5); text-align: left; }
.dp-handoff.inline .dp-ho-menu { position: static; margin-top: 6px; max-width: none; box-shadow: none; }
.dp-ho-menu[hidden] { display: none; }
.dp-ho-menu button { all: unset; box-sizing: border-box; display: block; padding: 6px 10px; border-radius: 7px; cursor: pointer; font-family: inherit; font-weight: 600; font-size: 12.5px; line-height: 1.3; color: var(--text, #f2f2f5); }
.dp-ho-menu button:hover, .dp-ho-menu button:focus-visible { background: rgb(255 255 255 / .08); }
.dp-ho-menu button span { display: block; font-weight: 400; font-size: 11px; color: var(--muted, #8b8b96); }
.dp-ho-menu small { display: block; padding: 4px 10px; font-size: 11px; line-height: 1.35; color: var(--muted, #8b8b96); }
.dp-ho-menu small.bad { color: var(--bad, #f2555a); }
.dp-ho-menu hr { border: 0; border-top: 1px solid var(--line, #2a2a31); margin: 3px 0; }
body.compact .dp-handoff { display: none; }
`;

function injectCss() {
  if (document.getElementById('dp-handoff-css')) return;
  const style = document.createElement('style');
  style.id = 'dp-handoff-css';
  style.textContent = CSS;
  document.head.append(style);
}

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

let installed = null; // { at, list }: GET /api/handoff/agents, kept for a minute
async function agents() {
  if (installed && Date.now() - installed.at < 60_000) return installed.list;
  const res = await fetch('/api/handoff/agents');
  const { agents: list = [] } = await res.json();
  installed = { at: Date.now(), list };
  return list;
}

async function ask(session, agent) {
  try {
    const res = await fetch('/api/handoff', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dotpals': '1' }, body: JSON.stringify({ session, agent }) });
    const body = await res.json().catch(() => ({}));
    return { ...body, ok: res.ok };
  } catch {
    return { ok: false, error: 'Couldn’t reach the dotpals bridge.' };
  }
}

// Throws when it can't copy (no clipboard, or the browser said no), so the menu never says "Copied" for nothing.
const defaultCopy = async (text) => {
  if (window.dotpalsDesktop?.copy) return window.dotpalsDesktop.copy(text);
  if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
  return navigator.clipboard.writeText(text);
};

export function continueMenu(session, { copy = defaultCopy, inline = false } = {}) {
  injectCss();
  const box = el('span', `dp-handoff${inline ? ' inline' : ''}`);
  const toggle = el('button', 'dp-ho-toggle', 'Continue in ▾');
  toggle.type = 'button';
  toggle.title = 'Hand this session to another agent: it starts in a new terminal with a note on what was asked, done and left to do';
  toggle.setAttribute('aria-haspopup', 'menu');
  toggle.setAttribute('aria-expanded', 'false');
  const menu = el('div', 'dp-ho-menu');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  box.append(toggle, menu);
  let note = null; // a note that came back with an error, to copy instead

  const flash = (text) => {
    toggle.textContent = text;
    clearTimeout(flash.t);
    flash.t = setTimeout(() => { toggle.textContent = 'Continue in ▾'; }, 2200);
  };
  const close = () => {
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    removeEventListener('pointerdown', outside, true);
  };
  const outside = (e) => { if (!box.contains(e.target)) close(); };
  const item = (label, sub, onclick) => {
    const b = el('button', '', label);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    if (sub) b.append(el('span', '', sub));
    b.onclick = (e) => { e.stopPropagation(); onclick(); };
    return b;
  };
  async function doCopy() {
    const text = note ?? (await ask(session, 'copy')).note;
    if (!text) return render('Couldn’t make the note (is the bridge running?).');
    try { await copy(text); } catch { return render('Couldn’t copy it: the clipboard isn’t available here. Try again from the dashboard.', false, true); }
    close();
    flash('Copied ✓');
  }
  async function start(a) {
    render(`Opening ${a.name}…`, true);
    const r = await ask(session, a.id);
    if (r.ok) { note = null; close(); flash(`Opened ${a.name} ✓`); return; }
    note = r.note ?? null;
    render(r.error ?? 'That didn’t work.', false, true);
  }
  async function render(status, busy = false, bad = false) {
    const list = await agents().catch(() => null);
    const items = [el('small', '', 'Start a new session that picks up from here:')];
    if (list === null) items.push(el('small', 'bad', 'Couldn’t reach the dotpals bridge.'));
    else if (!list.length) items.push(el('small', '', 'No Codex, Claude Code or Gemini CLI found on this computer.'));
    for (const a of list ?? []) items.push(item(a.name, 'in a new terminal, in this project', () => !busy && start(a)));
    items.push(el('hr'), item(note ? 'Copy the note instead' : 'Copy', 'the hand-off note, as Markdown', doCopy));
    if (status) items.push(el('small', bad ? 'bad' : '', status));
    menu.replaceChildren(...items);
  }
  toggle.onclick = async (e) => {
    e.stopPropagation();
    if (!menu.hidden) return close();
    note = null;
    menu.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    addEventListener('pointerdown', outside, true);
    menu.replaceChildren(el('small', '', 'Looking for your agents…'));
    await render();
    menu.querySelector('button')?.focus();
  };
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { e.stopPropagation(); close(); toggle.focus(); } });
  return box;
}
