// The update notice and the page's handle on the updater (updater.js). Loaded by client.js on a paired device.
//   - a small pill, only when an update is READY: "An update is ready · Update". Nothing else is ever shown unasked.
//   - window.dotpalsUpdate for Settings → Remote → App ("Check for updates").
import { createUpdater, updateWords } from './updater.js';

if (typeof document !== 'undefined' && !window.dotpalsUpdate) {
  const updater = createUpdater();
  window.dotpalsUpdate = { check: () => updater.check(), apply: () => updater.apply(), state: () => updater.state(), onChange: (fn) => updater.onChange(fn), words: (s) => updateWords(s ?? updater.state()) };

  const pill = document.createElement('div');
  pill.id = 'rc-update';
  pill.hidden = true;
  pill.setAttribute('role', 'status');
  pill.setAttribute('aria-live', 'polite');
  const text = document.createElement('span');
  const go = document.createElement('button');
  go.type = 'button';
  const later = document.createElement('button');
  later.type = 'button';
  later.textContent = 'Later';
  later.className = 'rc-later';
  pill.append(text, go, later);
  document.body.append(pill);

  let dismissed = false; // "Later" hides it for this visit; the Settings row still offers it
  go.onclick = () => updater.apply();
  later.onclick = () => { dismissed = true; pill.hidden = true; };
  updater.onChange((s) => {
    const w = updateWords(s);
    const show = (s.view === 'ready' && !dismissed) || s.view === 'applying';
    pill.hidden = !show;
    text.textContent = s.view === 'applying' ? 'Updating…' : 'An update is ready.';
    go.hidden = s.view !== 'ready';
    later.hidden = s.view !== 'ready';
    go.textContent = w.action === 'update' ? 'Update' : '';
  });

  updater.start();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') updater.resumed(); });
  addEventListener('online', () => updater.resumed());
}
