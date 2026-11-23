// Runs first, in <head>, before the page paints (a classic script: no module delay).
// Everything that has to be right on the very first frame goes here: the posture of a
// foldable and the size of the display's segments become attributes on <html>, so the CSS
// can lay out for them with no flash of the wrong layout, and nothing waits for a module.
(() => {
  const root = document.documentElement;
  const set = (name, value) => { if (value === null || value === undefined || value === false) root.removeAttribute(name); else root.setAttribute(name, value === true ? '' : String(value)); };

  // -- display: installed app (any display mode), or a browser tab -------------------------------
  const installed = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: window-controls-overlay)').matches
    || matchMedia('(display-mode: minimal-ui)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
  const display = () => {
    set('data-installed', installed());
    set('data-wco', matchMedia('(display-mode: window-controls-overlay)').matches);
  };
  display();
  for (const q of ['standalone', 'window-controls-overlay', 'minimal-ui', 'fullscreen']) matchMedia(`(display-mode: ${q})`).addEventListener?.('change', display);

  // -- foldables: posture (Device Posture API) and segments (Viewport Segments API) ---------------
  // `data-posture`: 'continuous' (flat, or not foldable) | 'folded' (half-open: book or laptop).
  // `data-segments`: how many separate screens the viewport is split into, with the fold between
  // them, and `data-spanned`: 'horizontal' (side by side, fold is vertical) | 'vertical' (stacked).
  // Both can be forced for testing: localStorage dotpals.posture = 'folded', dotpals.span = 'horizontal'.
  const forced = (k) => { try { return localStorage.getItem(`dotpals.${k}`); } catch { return null; } };
  function posture() {
    const f = forced('posture');
    const type = f === 'folded' || f === 'continuous' ? f : navigator.devicePosture?.type ?? (matchMedia('(device-posture: folded)').matches ? 'folded' : 'continuous');
    set('data-posture', type);
  }
  function segments() {
    const f = forced('span');
    let h = matchMedia('(horizontal-viewport-segments: 2)').matches;
    let v = matchMedia('(vertical-viewport-segments: 2)').matches;
    if (f === 'horizontal') { h = true; v = false; } else if (f === 'vertical') { v = true; h = false; }
    set('data-spanned', h ? 'horizontal' : v ? 'vertical' : null);
    // Where the fold is, in CSS pixels, from the real segments: the layout leaves that gap clear.
    const segs = window.viewport?.segments;
    if (segs && segs.length === 2) {
      const [a, b] = segs;
      const gap = h ? b.left - (a.left + a.width) : v ? b.top - (a.top + a.height) : 0;
      root.style.setProperty('--fold-gap', `${Math.max(0, Math.round(gap))}px`);
    } else if (h || v) root.style.setProperty('--fold-gap', '0px');
    else root.style.removeProperty('--fold-gap');
  }
  // `data-fold` is the one the CSS uses: 'book' (two screens or halves side by side, hinge vertical) or
  // 'table' (one above the other, hinge horizontal). Real segment info wins; with only a `folded`
  // posture (no segment geometry), landscape reads as a book and portrait as a tabletop. Not a fold: none.
  function fold() {
    const spanned = root.getAttribute('data-spanned');
    const folded = root.getAttribute('data-posture') === 'folded';
    const landscape = matchMedia('(orientation: landscape)').matches;
    set('data-fold', spanned === 'horizontal' ? 'book' : spanned === 'vertical' ? 'table' : folded ? (landscape ? 'book' : 'table') : null);
  }
  const refresh = () => { posture(); segments(); fold(); };
  refresh();
  navigator.devicePosture?.addEventListener?.('change', refresh);
  for (const q of ['(device-posture: folded)', '(horizontal-viewport-segments: 2)', '(vertical-viewport-segments: 2)', '(orientation: landscape)']) matchMedia(q).addEventListener?.('change', refresh);
  window.viewport?.addEventListener?.('segmentchange', refresh);
  addEventListener('resize', refresh, { passive: true });
  addEventListener('storage', (e) => { if (e.key?.startsWith('dotpals.')) refresh(); });

  // Let the rest of the app (client.js) ask without re-deriving any of it.
  window.dotpalsFold = { posture: () => root.getAttribute('data-posture') ?? 'continuous', fold: () => root.getAttribute('data-fold'), refresh };
})();
