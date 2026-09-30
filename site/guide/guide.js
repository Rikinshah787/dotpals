// dotpals docs: copy buttons on code, a search box that filters the sidebar,
// the phone menu, anchor links on headings and the current section in the sidebar.
// Plain JS, no build step.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// The pal in the header is the real <dot-pal> (copied next to the site by the build).
import('../src/index.js').catch(() => {});

// -- copy buttons ----------------------------------------------------------------
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

for (const pre of $$('.doc pre')) {
  const box = document.createElement('div');
  box.className = 'g-pre';
  pre.replaceWith(box);
  box.append(pre);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'g-copy';
  button.textContent = 'Copy';
  button.setAttribute('aria-label', 'Copy this code');
  button.addEventListener('click', async () => {
    const ok = await copyText(pre.innerText.replace(/\n$/, ''));
    button.textContent = ok ? 'Copied ✓' : 'Press Ctrl+C';
    button.classList.toggle('ok', ok);
    setTimeout(() => { button.textContent = 'Copy'; button.classList.remove('ok'); }, 1600);
  });
  box.append(button);
}

// -- anchor links on headings ----------------------------------------------------------
for (const h of $$('.doc h2[id], .doc h3[id]')) {
  const a = document.createElement('a');
  a.className = 'g-anchor';
  a.href = `#${h.id}`;
  a.textContent = '#';
  a.setAttribute('aria-label', `Link to “${h.textContent.trim()}”`);
  h.append(a);
}

// -- search: filter the sidebar across every page and section -----------------------
const side = $('#g-side');
const q = $('#g-q');
const none = $('#g-none');
const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

function mark(a, words) {
  const text = a.dataset.text ?? (a.dataset.text = a.textContent);
  if (!words.length) { a.textContent = text; return; }
  const lower = norm(text);
  const hits = [];
  for (const w of words) {
    let i = lower.indexOf(w);
    while (i >= 0) { hits.push([i, i + w.length]); i = lower.indexOf(w, i + w.length); }
  }
  hits.sort((x, y) => x[0] - y[0]);
  a.textContent = '';
  let at = 0;
  for (const [from, to] of hits) {
    if (from < at) continue;
    a.append(text.slice(at, from));
    const m = document.createElement('mark');
    m.textContent = text.slice(from, to);
    a.append(m);
    at = to;
  }
  a.append(text.slice(at));
}

// A link matches on its text, plus hidden keywords (data-k: a page's description,
// a section's sub-headings), so "electron" or "PowerShell" finds the right place.
// Each word you type must start a word there ("port" finds "Port 5175", not "reports").
const tokens = (s) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);
function filter() {
  const words = tokens(q.value);
  const matches = (a) => { const t = tokens(`${a.dataset.text ?? a.textContent} ${a.dataset.k ?? ''}`); return words.every((w) => t.some((x) => x.startsWith(w))); };
  side.classList.toggle('searching', words.length > 0);
  let any = false;
  for (const page of $$('.g-page', side)) {
    const link = $(':scope > a', page);
    const pageHit = !words.length || matches(link);
    let secHit = false;
    for (const li of $$('.g-secs > li', page)) {
      const a = $('a', li);
      const hit = words.length > 0 && matches(a);
      li.hidden = words.length > 0 && !hit;
      secHit ||= hit;
      mark(a, hit ? words : []);
    }
    page.hidden = !(pageHit || secHit);
    mark(link, words.length && pageHit ? words : []);
    any ||= !page.hidden;
  }
  for (const group of $$('.g-group', side)) group.hidden = !$$('.g-page', group).some((p) => !p.hidden);
  none.hidden = any;
}

if (q) {
  q.addEventListener('input', filter);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { q.value = ''; filter(); q.blur(); }
    if (e.key === 'Enter') {
      const first = $$('.g-page:not([hidden])', side).flatMap((p) => [
        ...$$('.g-secs > li:not([hidden]) > a', p).filter(() => side.classList.contains('searching')),
        $(':scope > a', p),
      ])[0];
      if (first) location.href = first.href;
    }
  });
  addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) {
      e.preventDefault();
      if (matchMedia('(max-width: 900px)').matches) setMenu(true);
      q.focus();
    }
  });
}

// -- phone menu ------------------------------------------------------------------------
const menu = $('.g-menu');
function setMenu(open) {
  document.body.classList.toggle('g-nav-open', open);
  menu?.setAttribute('aria-expanded', String(open));
}
menu?.addEventListener('click', () => setMenu(!document.body.classList.contains('g-nav-open')));
side?.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });

// -- the section you're reading, highlighted in the sidebar -------------------------------
const current = $('.g-page.is-current', side ?? document);
const links = new Map($$('.g-secs a', current ?? document).map((a) => [decodeURIComponent(a.hash.slice(1)), a]));
const headings = $$('.doc h2[id]').filter((h) => links.has(h.id));
if (headings.length && 'IntersectionObserver' in window) {
  const visible = new Set();
  const update = () => {
    const top = headings.find((h) => visible.has(h)) ?? headings.filter((h) => h.getBoundingClientRect().top < 120).at(-1);
    for (const a of links.values()) a.classList.remove('is-here');
    if (top) links.get(top.id)?.classList.add('is-here');
  };
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) (e.isIntersecting ? visible.add(e.target) : visible.delete(e.target));
    update();
  }, { rootMargin: '-60px 0px -60% 0px' });
  for (const h of headings) io.observe(h);
}
