// dotpals landing page. Vanilla JS, no build step. The pals are the real
// <dot-pal> web component from ../src (copied next to this file on Pages).
import { DotPal, registerCustom, CUSTOM_OPTIONS, agentHandler } from './src/index.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Run `enter` when `el` scrolls into view and `leave` when it scrolls out. */
function onView(el, enter, leave = () => {}, margin = '0px') {
  if (!el) return;
  new IntersectionObserver((entries) => {
    for (const e of entries) (e.isIntersecting ? enter : leave)();
  }, { rootMargin: margin }).observe(el);
}

// ---------------------------------------------------------------------------
// Copy the install command

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

for (const box of $$('.install')) {
  const btn = $('.copy-btn', box);
  btn.addEventListener('click', async () => {
    const ok = await copyText(box.dataset.copy);
    btn.textContent = ok ? 'Copied ✓' : 'Press Ctrl+C';
    btn.classList.toggle('ok', ok);
    if (ok) cheer();
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('ok'); }, 2200);
  });
}

// The crew at the bottom celebrates when you copy the command.
function cheer() {
  $$('.crew dot-pal').forEach((pal, i) => setTimeout(() => pal.setState('done'), i * 70));
}

// ---------------------------------------------------------------------------
// The notch: an island showing every agent, its plan and usage limits.

const USAGE = [
  { name: 'Claude 5-hour', v: 42, reset: 'resets in 2h 12m' },
  { name: 'Claude week', v: 18, reset: 'resets Sat 1:56 PM' },
  { name: 'Codex 5-hour', v: 91, reset: 'resets in 40 min' },
  { name: 'Codex week', v: 30, reset: 'resets Mon 1:56 PM' },
];
const STATUS = { working: 'working', waiting: 'needs you', done: 'done', idle: 'idle' };

class Notch {
  constructor(el, agents) {
    this.el = el;
    this.agents = agents;
    this.avatars = { bar: new Map(), list: new Map() }; // kept across renders so the pals keep moving
    this.flash = null;
    this.pill = $('.notch-pill', el);
    this.text = $('.notch-text', el);
    this.dots = $('.notch-dots', el);
    this.list = $('.notch-agents', el);
    $('.notch-usage', el).innerHTML = '<h4>Usage limits</h4>' + USAGE.map((u) => `
      <div class="u-row${u.v >= 80 ? ' hot' : ''}"><span>${u.name}</span><span class="bar"><i style="--v:${u.v}%"></i></span><b>${u.v}%</b><small>${u.reset}</small></div>`).join('');
    const top = Math.max(...USAGE.filter((u) => u.name.includes('5-hour')).map((u) => u.v));
    el.style.setProperty('--v', top);

    this.pill.addEventListener('click', () => this.toggle());
    el.addEventListener('pointerenter', () => this.pill.setAttribute('aria-expanded', 'true'));
    el.addEventListener('pointerleave', () => this.pill.setAttribute('aria-expanded', String(el.classList.contains('open'))));
    document.addEventListener('click', (e) => { if (!el.contains(e.target)) this.toggle(false); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { this.toggle(false); this.pill.focus(); } });
    this.render();
  }

  toggle(open = !this.el.classList.contains('open')) {
    this.el.classList.toggle('open', open);
    this.pill.setAttribute('aria-expanded', String(open));
  }

  set(id, patch) {
    const a = this.agents.find((x) => x.id === id);
    const wasDone = a.s === 'done';
    Object.assign(a, patch);
    if (a.s === 'done' && !wasDone) {
      this.flash = a;
      clearTimeout(this.flashTimer);
      this.flashTimer = setTimeout(() => { this.flash = null; this.render(); }, 2600);
    }
    this.render();
  }

  /** An agent's avatar: its own pal peeking up inside a round badge. */
  avatar(where, a) {
    let box = this.avatars[where].get(a.id);
    if (!box) {
      box = document.createElement('span');
      const pal = document.createElement('dot-pal');
      pal.setAttribute('size', where === 'bar' ? '24' : '30');
      pal.setAttribute('static', '');
      pal.setAttribute('character', a.char ?? 'blu');
      box.append(pal);
      this.avatars[where].set(a.id, box);
    }
    box.className = `av${where === 'list' ? ' av-lg' : ''}`;
    box.dataset.s = a.s;
    box.style.setProperty('--c', a.color);
    const pal = box.firstChild;
    if (pal.dataset.s !== a.s && pal.setState) { pal.dataset.s = a.s; pal.setState(a.s === 'working' ? 'working' : a.s === 'waiting' ? 'waiting' : a.s === 'done' ? 'done' : 'idle'); }
    return box;
  }

  render() {
    const { agents } = this;
    const waiting = agents.filter((a) => a.s === 'waiting');
    const working = agents.filter((a) => a.s === 'working');
    let tone = 'work';
    let text = 'All quiet · nothing running';
    if (waiting.length) {
      tone = 'wait';
      text = `${waiting[0].name} needs you · ${waiting[0].line.replace(/^Needs your OK: /, '')}`;
    } else if (this.flash) {
      tone = 'done';
      text = `${this.flash.name} is done · ${this.flash.line.replace(/^Done · /, '')}`;
    } else if (working.length) {
      text = `${working[0].name} · ${working[0].line}`;
    }
    if (this.el.dataset.tone !== tone) {
      this.el.dataset.tone = '';
      void this.el.offsetWidth; // restart the flash animation
      this.el.dataset.tone = tone;
    }
    this.text.innerHTML = text;
    this.dots.replaceChildren(...agents.map((a) => this.avatar('bar', a)));
    this.list.innerHTML = agents.map((a) => `
      <li class="na" data-s="${a.s}">
        <div class="na-top"><span class="av-slot" data-id="${a.id}"></span><b>${esc(a.name)}</b><span>· ${esc(a.project)}</span><span class="na-s">${STATUS[a.s]}</span></div>
        <div class="na-line">${esc(a.line)}</div>
        ${a.plan && a.s === 'working' ? `<div class="na-plan"><span>Plan ${a.plan[0]}/${a.plan[1]}</span><span class="bar"><i style="--p:${(a.plan[0] / a.plan[1]) * 100}%"></i></span></div>` : ''}
      </li>`).join('');
    for (const slot of $$('.av-slot', this.list)) slot.replaceWith(this.avatar('list', agents.find((a) => a.id === slot.dataset.id)));
  }
}

// ---------------------------------------------------------------------------
// Hero: three pals work through a request while the notch follows along.

const heroPals = Object.fromEntries($$('.hero .lp').map((fig) => [fig.dataset.agent, $('dot-pal', fig)]));
const heroNotch = new Notch($('#heroNotch'), [
  { id: 'A', char: 'blu', name: 'Claude', project: 'acme-web', color: 'var(--claude)', s: 'working', line: '2/4 · Detecting the system setting', plan: [1, 4] },
  { id: 'B', char: 'grok', name: 'Codex', project: 'api-server', color: 'var(--codex)', s: 'working', line: 'Reading routes.ts' },
  { id: 'C', char: 'muse', name: 'my-agent', project: 'docs', color: 'var(--mine)', s: 'idle', line: 'Idle' },
]);

const idleAll = { A: { st: 'idle', s: 'idle', line: 'Waiting for your next request' }, B: { st: 'idle', s: 'idle', line: 'Waiting for your next request' }, C: { st: 'idle', s: 'idle', line: 'Idle' } };
const HERO = [
  [0, { A: { st: 'thinking', s: 'working', line: '1/4 · Reading the settings page', plan: [0, 4] }, B: { st: 'working', say: 'Reading routes.ts', s: 'working', line: 'Reading routes.ts' }, C: { st: 'sleeping', s: 'idle', line: 'Idle' } }],
  [2200, { A: { st: 'working', say: 'Editing app.js', s: 'working', line: '2/4 · Detecting the system setting', plan: [1, 4] } }],
  [4700, { B: { st: 'waiting', say: 'Allow Bash?', s: 'waiting', line: 'Needs your OK: Run npm install?' } }],
  [8000, { B: { st: 'working', say: 'npm install', s: 'working', line: 'Running npm install' }, C: { st: 'thinking', s: 'working', line: 'Thinking' } }],
  [9800, { A: { st: 'done', say: 'Changed 3 files', s: 'done', line: 'Done · Changed 3 files, tests pass' } }],
  [11200, { C: { st: 'working', say: 'Fixing typos', s: 'working', line: 'Fixing typos across 4 pages' } }],
  [13600, { C: { st: 'done', say: 'Fixed 12 typos', s: 'done', line: 'Done · Fixed 12 typos across 4 pages' } }],
  [15200, { B: { st: 'done', say: 'All green!', s: 'done', line: 'Done · Installed 2 packages' } }],
  [18400, idleAll],
];
const HERO_LOOP = 19600;

function applyHero(step) {
  for (const [id, v] of Object.entries(step)) {
    heroPals[id]?.setState(v.st, { text: v.say });
    heroNotch.set(id, { s: v.s, line: v.line, ...(v.plan ? { plan: v.plan } : {}) });
  }
}

if (reduced) {
  // A calm, still snapshot of the same story.
  applyHero({ A: HERO[1][1].A, B: HERO[2][1].B, C: { st: 'idle', s: 'done', line: 'Done · Fixed 12 typos across 4 pages' } });
} else {
  let timers = [];
  let running = false;
  const run = () => {
    timers.forEach(clearTimeout);
    timers = HERO.map(([t, step]) => setTimeout(() => applyHero(step), t));
    timers.push(setTimeout(run, HERO_LOOP));
  };
  const start = () => { if (!running && !document.hidden) { running = true; run(); } };
  const stop = () => { running = false; timers.forEach(clearTimeout); timers = []; };
  let heroVisible = false;
  onView($('.hero'), () => { heroVisible = true; start(); }, () => { heroVisible = false; stop(); });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : heroVisible && start()));
}

// ---------------------------------------------------------------------------
// The notch section: a bigger notch you can poke at.

const demo = new Notch($('#demoNotch'), [
  { id: 'x', char: 'grok', name: 'Codex', project: 'api-server', color: 'var(--codex)', s: 'working', line: 'Reading routes.ts' },
  { id: 'c', char: 'blu', name: 'Claude', project: 'acme-web', color: 'var(--claude)', s: 'working', line: '2/4 · Detecting the system setting', plan: [1, 4] },
  { id: 'd', char: 'hop', name: 'Claude', project: 'docs', color: 'var(--claude)', s: 'done', line: 'Done · Fixed 12 typos across 4 pages' },
]);
const DEMO = {
  wait: { s: 'waiting', line: 'Needs your OK: Run npm install?' },
  done: { s: 'done', line: 'Done · Installed 2 packages, tests pass' },
  work: { s: 'working', line: 'Running npm install' },
};
const demoButtons = $$('[data-demo]');
function setDemo(key) {
  demo.set('x', DEMO[key]);
  demoButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.demo === key)));
}
demoButtons.forEach((b) => b.addEventListener('click', () => setDemo(b.dataset.demo)));

// The first time it scrolls into view, play the whole loop once: needs you, then done.
let demoPlayed = false;
onView($('.screen'), () => {
  if (demoPlayed || reduced) return;
  demoPlayed = true;
  setTimeout(() => setDemo('wait'), 900);
  setTimeout(() => setDemo('done'), 4600);
  setTimeout(() => setDemo('work'), 8200);
}, undefined, '0px 0px -30% 0px');

// ---------------------------------------------------------------------------
// The story view: 400 tool calls scroll by, then fold into five chapters.

const story = $('.story');
if (!reduced) {
  story.classList.add('story-live');
  const log = $('.sc-log');
  const body = $('.sc-body');
  const track = $('.story-track');
  const n = $('.sc-n');
  const unit = $('.sc-unit');
  const scPal = $('.sc-pal dot-pal');

  // A believable log for "Add a dark mode toggle", with the risky bits in it.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const dirs = ['src/settings', 'src/theme', 'src/components', 'src/hooks', 'test', 'src/lib', 'docs', 'src/app'];
  const names = ['Settings.tsx', 'useTheme.ts', 'Toggle.tsx', 'index.ts', 'Layout.tsx', 'storage.ts', 'colors.ts', 'Settings.test.tsx', 'App.tsx', 'README.md', 'tokens.css', 'Header.tsx', 'prefs.ts', 'app.js'];
  const finds = ['useTheme', 'prefers-color-scheme', 'localStorage', 'ThemeContext', 'dark', '<Section title="Display">'];
  const special = {
    60: ['EDIT', 'src/settings/Settings.tsx', 'ok', true],
    96: ['EDIT', 'src/theme/useTheme.ts', 'ok'],
    120: ['RUN', 'npm install', 'ok'],
    150: ['EDIT', '.env', 'ok', true],
    171: ['WRITE', 'src/theme/dark.css', 'ok'],
    205: ['RUN', 'npm test', 'bad'],
    232: ['EDIT', 'src/theme/useTheme.ts', 'ok'],
    250: ['RUN', 'npm test', 'bad'],
    268: ['EDIT', 'src/settings/Settings.test.tsx', 'ok'],
    290: ['RUN', 'npm test', 'ok'],
    318: ['RUN', 'npm run e2e', 'bad', true],
    331: ['RUN', 'npm run e2e', 'bad', true],
    347: ['RUN', 'npm run e2e', 'bad', true],
    362: ['EDIT', 'src/app/App.tsx', 'ok'],
    391: ['RUN', 'git commit -m "Add dark mode toggle"', 'ok'],
    396: ['RUN', 'git push --force origin main', 'ok', true],
  };
  const kc = { READ: '#8fa6ff', FIND: '#c792ff', EDIT: 'var(--amber)', WRITE: '#ff9a6b', RUN: 'var(--green)' };
  const rows = [];
  for (let i = 1; i <= 400; i++) {
    let [k, t, st, hot] = special[i] ?? (rnd() < 0.2 ? ['FIND', pick(finds), 'ok'] : ['READ', `${pick(dirs)}/${pick(names)}`, 'ok']);
    const ms = k === 'RUN' ? `${(rnd() * 8 + 0.4).toFixed(1)}s` : `${Math.round(rnd() * 180 + 20)}ms`;
    rows.push(`<li${hot ? ' class="hot"' : ''}><span class="k" style="--kc:${kc[k]}">${k}</span><span>${esc(t)}</span><span class="ms">${ms} <b class="${st}">${st === 'ok' ? '✓' : '✕'}</b></span></li>`);
  }
  log.innerHTML = rows.join('');

  let frame = 0;
  let phase = -1;
  let logH = 0;
  const measure = () => { logH = log.scrollHeight; };
  measure();
  addEventListener('resize', () => { measure(); update(); }, { passive: true });

  function update() {
    frame = 0;
    const r = track.getBoundingClientRect();
    const span = r.height - innerHeight;
    if (r.bottom < -200 || r.top > innerHeight + 200) return;
    const p = Math.min(1, Math.max(0, -r.top / (span || 1)));
    const q = Math.min(1, Math.max(0, (p - 0.04) / 0.5));
    log.style.transform = `translateY(${-(q * Math.max(0, logH - body.clientHeight))}px)`;
    const next = p >= 0.74 ? 2 : p >= 0.58 ? 1 : 0;
    if (next === 0) n.textContent = String(Math.round(q * 400));
    if (next !== phase) {
      story.classList.toggle('compressed', next >= 1);
      story.classList.toggle('flagged', next >= 2);
      if (next >= 1) { n.textContent = '5'; unit.textContent = 'lines from 400 calls'; }
      else { unit.textContent = 'tool calls'; }
      // On short screens the flags may sit below the fold of the card: bring them in.
      const scroller = $('.sc-story');
      if (next === 2) setTimeout(() => scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' }), 250);
      else if (next === 1 && phase === 2) scroller.scrollTo({ top: 0, behavior: 'smooth' });
      if (next === 1 && phase === 0) scPal.setState('done');
      else if (next === 0) scPal.setState('working');
      phase = next;
    }
  }
  addEventListener('scroll', () => { if (!frame) frame = requestAnimationFrame(update); }, { passive: true });
  update();
}

// ---------------------------------------------------------------------------
// Agents: one pal each. Claude and Codex keep busy; you drive the third.

const palClaude = $('#palClaude');
const palCodex = $('#palCodex');
const palMine = $('#palMine');
const LOOP = [
  [['working', 'Editing app.js'], ['thinking']],
  [['working', 'Running tests'], ['working', 'Reading routes.ts']],
  [['thinking'], ['waiting', 'Allow Bash?']],
  [['done', 'Changed 3 files'], ['working', 'npm install']],
  [['working', 'Editing useTheme.ts'], ['done', 'All green!']],
];
if (reduced) {
  palClaude.setState('working', { text: 'Editing app.js' });
  palCodex.setState('waiting', { text: 'Allow Bash?' });
} else {
  let i = 0;
  let timer = 0;
  const tick = () => {
    const [c, x] = LOOP[i++ % LOOP.length];
    palClaude.setState(c[0], { text: c[1] });
    palCodex.setState(x[0], { text: x[1] });
  };
  onView($('.agents-stage'), () => { if (!timer) { tick(); timer = setInterval(tick, 2800); } }, () => { clearInterval(timer); timer = 0; });
}

const send = agentHandler(palMine);
const tryJson = $('#tryJson');
const tryOut = $('#tryOut');
function fire() {
  let ev;
  try { ev = JSON.parse(tryJson.value); } catch {
    tryOut.textContent = 'That isn’t valid JSON yet.';
    tryOut.classList.add('err');
    return;
  }
  const next = send(ev);
  tryOut.classList.toggle('err', !next?.state);
  tryOut.textContent = next?.state
    ? `→ my-agent is ${next.state}${next.text ? ` · “${next.text}”` : ''}`
    : 'The pal didn’t recognise that event. Try { "state": "thinking" }.';
}
$('#tryForm').addEventListener('submit', (e) => { e.preventDefault(); fire(); });
$$('[data-ev]').forEach((b) => b.addEventListener('click', () => { tryJson.value = b.dataset.ev; fire(); }));
palMine.say('Send me an event!', { duration: 0 });

// ---------------------------------------------------------------------------
// Make your own pal: the real registerCustom() from src/custom.js.

const mixPal = $('#mixPal');
const form = $('#mixForm');
const spec = { name: 'Pip', shape: 'round', eyes: 'googly', top: 'sprout', color: '#16c6ae', fur: true };
const SWATCHES = ['#1e88ff', '#8be22e', '#ffc21a', '#ff2fc4', '#9d6bff', '#ff7a2f', '#16c6ae', '#ef4444', '#4c5566', '#f2efe9'];
const NAMES = ['Pip', 'Mochi', 'Bean', 'Nori', 'Ziggy', 'Pixel', 'Bo', 'Luna', 'Sprocket', 'Tofu', 'Momo', 'Kiwi'];

for (const box of $$('.opts[data-key]', form)) {
  const key = box.dataset.key;
  box.setAttribute('role', 'radiogroup');
  box.innerHTML = Object.entries(CUSTOM_OPTIONS[key]).map(([value, label]) =>
    `<label><input type="radio" name="${key}" value="${value}"${spec[key] === value ? ' checked' : ''}><span>${esc(label)}</span></label>`).join('');
}
const colorBox = $('.colors', form);
colorBox.insertAdjacentHTML('afterbegin', SWATCHES.map((c) =>
  `<button type="button" class="swatch" style="--s:${c}" data-color="${c}" aria-label="Color ${c}" aria-pressed="false"></button>`).join(''));
const colorIn = $('#mixColor');
const nameIn = $('#mixNameIn');
const furIn = $('#mixFur');

function showCode() {
  const s = (v) => `<span class="s">'${esc(v)}'</span>`;
  $('#mixCode').innerHTML =
    `<span class="k">import</span> { registerCustom } <span class="k">from</span> <span class="s">'dotpals'</span>;\n\n` +
    `<span class="f">registerCustom</span>({ name: ${s(spec.name)}, shape: ${s(spec.shape)}, eyes: ${s(spec.eyes)}, top: ${s(spec.top)}, color: ${s(spec.color)}${spec.fur ? '' : ', fur: <span class="k">false</span>'} });\n` +
    `<span class="c">// then</span> &lt;dot-pal character=<span class="s">"custom"</span>&gt;`;
}

function applyMix() {
  registerCustom(spec, 'site-mix');
  if (mixPal.character !== 'site-mix') mixPal.character = 'site-mix';
  else DotPal.refresh('site-mix');
  mixPal.setAttribute('label', spec.name);
  $('#mixName').textContent = spec.name;
  $('.mix-stage').style.setProperty('--mix', spec.color);
  colorIn.value = spec.color;
  $$('.swatch', form).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === spec.color)));
  showCode();
}

form.addEventListener('change', (e) => {
  const t = e.target;
  if (t.type === 'radio') spec[t.name] = t.value;
  else if (t === furIn) spec.fur = t.checked;
  else if (t === colorIn) spec.color = t.value;
  applyMix();
});
colorIn.addEventListener('input', () => { spec.color = colorIn.value; applyMix(); });
nameIn.addEventListener('input', () => { spec.name = nameIn.value.trim().slice(0, 24) || 'My pal'; applyMix(); });
colorBox.addEventListener('click', (e) => {
  const b = e.target.closest('.swatch');
  if (!b) return;
  spec.color = b.dataset.color;
  applyMix();
});
form.addEventListener('submit', (e) => e.preventDefault());

const hsl = (h, s, l) => {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
};
const any = (o) => { const k = Object.keys(o); return k[Math.floor(Math.random() * k.length)]; };

$('#surprise').addEventListener('click', () => {
  Object.assign(spec, {
    shape: any(CUSTOM_OPTIONS.shape),
    eyes: any(CUSTOM_OPTIONS.eyes),
    top: any(CUSTOM_OPTIONS.top),
    color: Math.random() < 0.35 ? SWATCHES[Math.floor(Math.random() * SWATCHES.length)] : hsl(Math.random() * 360, 0.65 + Math.random() * 0.3, 0.52 + Math.random() * 0.12),
    fur: Math.random() < 0.8,
    name: NAMES[Math.floor(Math.random() * NAMES.length)],
  });
  for (const key of ['shape', 'eyes', 'top']) {
    const r = form.querySelector(`input[name="${key}"][value="${spec[key]}"]`);
    if (r) r.checked = true;
  }
  furIn.checked = spec.fur;
  nameIn.value = spec.name;
  applyMix();
  mixPal.play('jump');
});

const STATE_TEXT = { working: 'Editing app.js', waiting: 'Allow Bash?', done: 'Looks good!' };
const stateButtons = $$('[data-state]');
let stateTimer = 0;
stateButtons.forEach((b) => b.addEventListener('click', () => {
  const st = b.dataset.state;
  clearTimeout(stateTimer);
  mixPal.setState(st, { text: STATE_TEXT[st] });
  stateButtons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  if (st === 'done') stateTimer = setTimeout(() => { mixPal.setState('idle'); b.setAttribute('aria-pressed', 'false'); }, 2600);
}));
applyMix();

// ---------------------------------------------------------------------------
// Dashboard tabs

const tabs = $$('[role="tab"]');
function selectTab(tab, focus) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
  }
  if (focus) tab.focus();
}
tabs.forEach((t, i) => {
  t.addEventListener('click', () => selectTab(t));
  t.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (d) { e.preventDefault(); selectTab(tabs[(i + d + tabs.length) % tabs.length], true); }
  });
});

// ---------------------------------------------------------------------------
// The crew nods off when nobody's looking, and wakes when you scroll down.

const crew = $$('.crew dot-pal');
crew.forEach((p, i) => { if (i % 3 === 1) p.setState('sleeping'); });
onView($('.crew'), () => crew.forEach((p, i) => i % 3 === 1 && setTimeout(() => p.setState('idle'), 1200 + i * 150)));

// ---------------------------------------------------------------------------
// Visitors so far, under the install line. A public counter (abacus.jasoncameron.dev)
// keeps the number: each browser adds one, the first time it visits (remembered
// in localStorage), and only reads it after that, so it counts people, not page
// loads. No cookies; nothing about you is sent. Not counted when you open the
// page from your own computer. If the counter is down, the line just stays hidden.
// It asks through the site itself first (/count/…, a rewrite in vercel.json), since
// blockers often stop requests to counter services; then the counter directly.

const COUNTERS = ['./count', 'https://abacus.jasoncameron.dev'];
const KEY = 'dotpals-site/visitors';
async function counter(op) {
  for (const base of COUNTERS) {
    try {
      const res = await fetch(`${base}/${op}/${KEY}`, { cache: 'no-store' });
      if (!res.ok || !/json/.test(res.headers.get('content-type') ?? '')) continue;
      const { value } = await res.json();
      if (Number.isFinite(value)) return value;
    } catch {}
  }
  return null;
}
(async () => {
  const box = $('#visitors');
  if (!box) return;
  const local = location.protocol === 'file:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  let seen = false;
  try { seen = localStorage.getItem('dotpals.counted') === '1'; } catch {}
  const add = !seen && !local;
  try {
    const value = await counter(add ? 'hit' : 'get');
    if (value == null || value < 1) return;
    if (add) { try { localStorage.setItem('dotpals.counted', '1'); } catch {} }
    $('#visitors-n').textContent = value.toLocaleString('en-US');
    $('#visitors-label').textContent = value === 1 ? 'visitor so far' : 'visitors so far';
    box.hidden = false;
  } catch {}
})();
