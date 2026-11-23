// Swipe left or right to move to the next or previous tab, in the order of the navigation.
// The decision (is this a tab swipe, and which tab?) is a pure function so it can be tested; the
// rest listens for touches. Loaded by client.js on a paired device only.
//
// What is NOT a tab swipe, so nothing you do by hand is hijacked:
//   - a gesture that starts in something that scrolls sideways (the report card's table, a chart,
//     code), in a field, a slider or a menu, or in anything marked data-noswipe
//   - one that starts within EDGE px of the screen's side (Android and iOS use those for "back")
//   - a mostly vertical drag (you're scrolling), a short or slow one, or more than one finger
export const SWIPE = { distance: 64, ratio: 1.7, maxMs: 700, edge: 24 };

/** The view a finished touch should open: 'next' | 'prev' | null. */
export function swipeDirection({ dx, dy, ms, startX, width, fingers = 1 }, T = SWIPE) {
  if (fingers !== 1 || ms > T.maxMs) return null;
  if (startX < T.edge || startX > width - T.edge) return null;
  if (Math.abs(dx) < T.distance || Math.abs(dx) < Math.abs(dy) * T.ratio) return null;
  return dx < 0 ? 'next' : 'prev';
}

/** The neighbour of `current` in `views`, or null at either end (it doesn't wrap: that's a surprise). */
export function neighbour(views, current, direction) {
  const i = views.indexOf(current);
  if (i < 0 || !direction) return null;
  return views[i + (direction === 'next' ? 1 : -1)] ?? null;
}

/** A replay lives under Sessions in the navigation. */
export const navViewOf = (hash) => {
  const view = String(hash ?? '').replace(/^#/, '').split('/')[0] || 'overview';
  return view === 'replay' ? 'sessions' : view;
};

const INTERACTIVE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="slider"], dialog, [data-noswipe]';

/** Does something between the touch and the page scroll sideways (or take the drag itself)? */
export function takesTheDrag(node, root, style = (n) => getComputedStyle(n)) {
  for (let n = node; n && n !== root; n = n.parentElement) {
    if (n.matches?.(INTERACTIVE)) return true;
    if (n.scrollWidth > n.clientWidth + 1 && /^(auto|scroll)$/.test(style(n).overflowX)) return true;
  }
  return false;
}

export function attach(doc = globalThis.document, win = globalThis) {
  if (!doc || doc.documentElement.dataset.swipe) return () => {};
  doc.documentElement.dataset.swipe = 'on';
  let start = null;
  const reduced = () => win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const views = () => [...doc.querySelectorAll('nav a[data-view]')].filter((a) => a.offsetParent !== null || a.getClientRects().length).map((a) => a.dataset.view);

  const onStart = (e) => {
    const t = e.touches[0];
    start = e.touches.length === 1 && !takesTheDrag(e.target, doc.body) ? { x: t.clientX, y: t.clientY, at: Date.now(), width: win.innerWidth } : null;
  };
  const onEnd = (e) => {
    const s = start;
    start = null;
    if (!s || e.touches.length) return;
    const t = e.changedTouches[0];
    const direction = swipeDirection({ dx: t.clientX - s.x, dy: t.clientY - s.y, ms: Date.now() - s.at, startX: s.x, width: s.width });
    const to = neighbour(views(), navViewOf(win.location.hash), direction);
    if (!to) return;
    const main = doc.querySelector('main');
    if (main && !reduced()) {
      main.dataset.slide = direction;
      main.addEventListener('animationend', () => { delete main.dataset.slide; }, { once: true });
    }
    win.location.hash = `#${to}`;
    if (main) main.scrollTop = 0;
  };
  const onCancel = () => { start = null; };

  doc.addEventListener('touchstart', onStart, { passive: true });
  doc.addEventListener('touchend', onEnd, { passive: true });
  doc.addEventListener('touchcancel', onCancel, { passive: true });
  return () => {
    doc.removeEventListener('touchstart', onStart);
    doc.removeEventListener('touchend', onEnd);
    doc.removeEventListener('touchcancel', onCancel);
    delete doc.documentElement.dataset.swipe;
  };
}

if (typeof document !== 'undefined') attach();
