// Checking for an update of the app, and applying it only when the person says so. The same shape as the pdsvc dashboard's
// PWA (web/pwa.js + web/service-worker.js there):
//   - register with updateViaCache: 'none', so the browser never takes the worker file from its own HTTP cache
//   - ask for an update explicitly (on start, when the app comes back to the front, and on a button), not only when the browser feels like it
//   - a new worker WAITS; the page shows "Update", and only that click sends SKIP_WAITING
//   - the page reloads once, and only after that click: never under someone who is in the middle of something
// No DOM in here: update-ui.js draws it, and the tests drive this with a fake service worker.

export const CHECK_EVERY = 10 * 60_000; // coming back to the app checks again if it has been this long

/** What to show: 'unsupported' | 'applying' | 'ready' | 'installing' | 'failed' | 'checking' | 'current'. */
export function updateView({ supported = true, registered = false, waiting = false, installing = false, requested = false, failed = false, checking = false } = {}) {
  if (!supported) return 'unsupported';
  if (requested) return 'applying';
  if (waiting) return 'ready';
  if (installing) return 'installing';
  if (failed) return 'failed';
  if (checking || !registered) return 'checking';
  return 'current';
}

const ago = (at, now) => { const s = Math.round((now - at) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };

/** The words for it: { title, note, action: 'check' | 'update' | null }. */
export function updateWords(state, now = Date.now()) {
  const checked = state.checkedAt ? ` Checked ${ago(state.checkedAt, now)}.` : '';
  switch (state.view) {
    case 'unsupported': return { title: 'Updates', note: 'This browser can’t keep dotpals up to date by itself. Reload the page to get the newest.', action: null };
    case 'applying': return { title: 'Updating…', note: 'Reloading with the new version.', action: null };
    case 'ready': return { title: 'An update is ready', note: 'Finish what you’re doing first: the app reloads when you choose Update.', action: 'update' };
    case 'installing': return { title: 'Downloading an update…', note: 'It will be ready in a moment.', action: null };
    case 'failed': return { title: 'Update check or activation failed', note: `Check connectivity, then try again.${checked}`, action: 'check' };
    case 'checking': return { title: 'Checking for an update…', note: '', action: null };
    default: return { title: 'Up to date', note: `You have the newest version.${checked}`, action: 'check' };
  }
}

/**
 * The updater. `sw`: navigator.serviceWorker (or a fake); `reload`: how to reload the page.
 * state() → { view, registered, waiting, installing, requested, failed, checking, checkedAt }; onChange(fn) → stop.
 */
export function createUpdater({ sw = globalThis.navigator?.serviceWorker, reload = () => globalThis.location.reload(), now = Date.now } = {}) {
  const s = { registered: false, waiting: false, installing: false, requested: false, failed: false, checking: false, checkedAt: 0 };
  const listeners = new Set();
  let reg = null;
  let reloading = false;
  let applyTimer;
  let workerUrl = '/sw.js';
  const snapshot = () => ({ ...s, view: updateView({ supported: !!sw, ...s }) });
  const emit = () => { const now_ = snapshot(); for (const fn of listeners) { try { fn(now_); } catch { /* a listener's problem is not the updater's */ } } };
  const sync = () => { s.waiting = !!reg?.waiting; s.installing = !!reg?.installing; emit(); };

  function watch(worker) {
    worker.addEventListener('statechange', () => {
      if (worker.state === 'redundant' && !reg?.waiting) s.failed = true; // it did not install and nothing took its place
      sync();
    });
  }

  sw?.addEventListener('controllerchange', () => {
    sync();
    if (!s.requested || reloading) return;
    clearTimeout(applyTimer); reloading = true; reload();
  });

  async function register() {
    reg = await sw.register(workerUrl, { scope: '/', updateViaCache: 'none' });
    s.registered = true;
    reg.addEventListener('updatefound', () => { if (reg.installing) watch(reg.installing); sync(); });
    if (reg.installing) watch(reg.installing);
    sync();
  }

  async function start(url = '/sw.js') {
    workerUrl = url;
    return check();
  }

  /** Ask the computer now whether there is a newer worker. Resolves when it has answered (or failed). */
  async function check() {
    if (!sw || s.checking || s.requested) return snapshot();
    s.checking = true; s.failed = false; emit();
    try { if (!reg) await register(); await reg.update(); s.checkedAt = now(); } catch { s.failed = true; }
    s.checking = false; sync();
    return snapshot();
  }

  /** The person chose Update: tell the waiting worker to take over (the page reloads when it has). False when there's nothing to apply. */
  function apply() {
    if (!reg?.waiting || s.requested) return false;
    s.requested = true; emit();
    applyTimer = setTimeout(() => { s.requested = false; s.failed = true; sync(); }, 15_000);
    applyTimer.unref?.();
    try { reg.waiting.postMessage({ type: 'SKIP_WAITING' }); } catch { clearTimeout(applyTimer); s.requested = false; s.failed = true; emit(); return false; }
    return true;
  }

  /** Called when the app comes back to the front: check again, but not on every glance. */
  const resumed = () => { if (!s.checking && now() - s.checkedAt > CHECK_EVERY) check(); };

  return { start, check, apply, resumed, state: snapshot, onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
}
