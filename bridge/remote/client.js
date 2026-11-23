import './update-ui.js'; // registers the worker, checks for an update, and offers it
import './swipe.js'; // swipe left or right between tabs
import './pals.js'; // an animated pal per live agent, and the agent picker in Sessions
import './talk.js'; // the notch-style Talk and Story panel
// The remote client's glue, loaded only on a paired device (the dashboard itself is untouched):
//  - registers the service worker (installable, instant start)
//  - shows the connection when it matters (offline, reconnecting, signed out), never when fine
//  - keeps the "install" prompt for Settings → Remote
(() => {
  const api = (path, body) => fetch(path, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-dotpals': '1' }, body: JSON.stringify(body) });

  // -- the connection pill: only shown when something is wrong -------------------------------------
  const pill = document.createElement('div');
  pill.id = 'rc-status';
  pill.hidden = true;
  pill.setAttribute('role', 'status');
  pill.setAttribute('aria-live', 'polite');
  const text = document.createElement('span');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Retry';
  retry.hidden = true;
  retry.onclick = () => location.reload();
  pill.append(text, retry);
  document.body.append(pill);
  let hideTimer;
  function status(detail) {
    clearTimeout(hideTimer);
    const s = detail?.state;
    if (s === 'live' || s === 'paused' || !s) { pill.hidden = true; return; }
    pill.classList.toggle('bad', s === 'closed');
    retry.hidden = s !== 'closed';
    text.textContent = s === 'closed' ? 'Can’t reach your computer.' : navigator.onLine ? 'Reconnecting…' : 'Offline';
    // Don't flash for a blip: only show if it lasts.
    hideTimer = setTimeout(() => { pill.hidden = false; }, s === 'closed' ? 0 : 1200);
  }
  addEventListener('dotpals:stream', (e) => status(e.detail));
  addEventListener('offline', () => status({ state: 'offline' }));

  // A 401 from any API call means this device was signed out on the computer: say so, once.
  const realFetch = window.fetch.bind(window);
  let toldOut = false;
  window.fetch = async (...args) => {
    const res = await realFetch(...args);
    if (res.status === 401 && !toldOut && !String(args[0]).includes('/pair')) {
      toldOut = true;
      text.textContent = 'This device was signed out.';
      retry.hidden = false;
      retry.textContent = 'Pair again';
      retry.onclick = () => location.replace('/pair');
      pill.classList.add('bad');
      pill.hidden = false;
    }
    return res;
  };

  // -- install prompt (Chromium) --------------------------------------------------------------------
  window.dotpalsInstall = { prompt: null, done: matchMedia('(display-mode: standalone)').matches };
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); window.dotpalsInstall.prompt = e; dispatchEvent(new CustomEvent('dotpals:install')); });
  addEventListener('appinstalled', () => { window.dotpalsInstall.prompt = null; window.dotpalsInstall.done = true; dispatchEvent(new CustomEvent('dotpals:install')); });

  // Fresh pairing: land on Settings → Remote so the next step (notifications) is right there.
  if (new URLSearchParams(location.search).has('paired')) { history.replaceState(null, '', '/#settings/remote'); dispatchEvent(new HashChangeEvent('hashchange')); }
})();
