import './update-ui.js'; // registers the worker, checks for an update, and offers it
import './swipe.js'; // swipe left or right between tabs
import './pals.js'; // an animated pal per live agent, and the agent picker in Sessions
import './talk.js'; // the notch-style Talk and Story panel
// The remote client's glue, loaded only on a paired device (the dashboard itself is untouched):
//  - registers the service worker (installable, instant start)
//  - shows the connection when it matters (offline, reconnecting, signed out), never when fine
//  - keeps the "install" prompt for Settings → Remote
//  - keeps this device's push subscription in step with the server
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
  let toldOut = false;
  const realFetch = window.fetch.bind(window);
  const signedOut = () => {
    if (toldOut) return;
    toldOut = true;
    clearTimeout(hideTimer);
    dispatchEvent(new Event('dotpals:signed-out'));
    location.replace('/pair');
  };
  function status(detail) {
    if (toldOut) return;
    clearTimeout(hideTimer);
    const s = detail?.state;
    if (s === 'live' || s === 'paused' || !s) { pill.hidden = true; return; }
    pill.classList.toggle('bad', s === 'closed');
    retry.hidden = s !== 'closed';
    if (s === 'closed' || detail?.status === 'refused') {
      realFetch('/api/remote/me', { cache: 'no-store' }).then((res) => { if (res.status === 401) signedOut(); }).catch(() => {});
    }
    text.textContent = s === 'closed' ? 'Can’t reach your computer.' : navigator.onLine ? 'Reconnecting…' : 'Offline';
    // Don't flash for a blip: only show if it lasts.
    hideTimer = setTimeout(() => { pill.hidden = false; }, s === 'closed' ? 0 : 1200);
  }
  addEventListener('dotpals:stream', (e) => status(e.detail));
  addEventListener('offline', () => status({ state: 'offline' }));

  // A 401 from the device's own bridge is terminal. Leave the previously displayed dashboard.
  window.fetch = async (...args) => {
    const res = await realFetch(...args);
    const url = new URL(res.url || '/', location.href);
    if (res.status === 401 && url.origin === location.origin && url.pathname.startsWith('/api/')) signedOut();
    return res;
  };
  realFetch('/api/remote/me', { cache: 'no-store' }).then((res) => { if (res.status === 401) signedOut(); }).catch(() => {});

  // -- install prompt (Chromium) --------------------------------------------------------------------
  window.dotpalsInstall = { prompt: null, done: matchMedia('(display-mode: standalone)').matches };
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); window.dotpalsInstall.prompt = e; dispatchEvent(new CustomEvent('dotpals:install')); });
  addEventListener('appinstalled', () => { window.dotpalsInstall.prompt = null; window.dotpalsInstall.done = true; dispatchEvent(new CustomEvent('dotpals:install')); });

  // -- service worker and push --------------------------------------------------------------------------
  const key = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
  const sameKey = (sub, k) => { const a = sub?.options?.applicationServerKey; return !!a && a.byteLength === k.length && new Uint8Array(a).every((v, i) => v === k[i]); };
  async function subscribe(me, test = false) {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg?.active) {
      if (test) throw new Error('Wait for the app to finish installing, then try again.');
      return;
    }
    const k = key(me.vapid);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub, k)) { await sub.unsubscribe(); sub = null; }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: k });
    const res = await api('/api/remote/me/push', { subscription: sub.toJSON(), test, recover: !test });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'The computer didn’t accept it.');
    return res.json();
  }
  window.dotpalsPush = {
    supported: () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
    permission: () => ('Notification' in window ? Notification.permission : 'unsupported'),
    /** Ask permission (must be called from a tap), subscribe, and give the subscription to the computer. */
    async enable() {
      if (!this.supported()) throw new Error('This browser can’t receive notifications here. On iPhone or iPad, add dotpals to the Home Screen first.');
      if (Notification.permission === 'denied') throw new Error('Notifications are blocked for this site in the browser’s settings.');
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications weren’t allowed.');
      const me = await (await api('/api/remote/me')).json();
      return subscribe(me, true);
    },
    async disable() {
      const res = await api('/api/remote/me/push', { subscription: null });
      if (!res.ok) throw new Error('The computer did not disable notifications. Try again.');
      const reg = await navigator.serviceWorker.getRegistration();
      await (await reg?.pushManager.getSubscription())?.unsubscribe();
    },
  };

  if (window.dotpalsPush.supported()) {
    const recover = async () => {
      if (Notification.permission !== 'granted') return;
      const res = await api('/api/remote/me');
      if (!res.ok) return;
      const me = await res.json();
      if (me.push) await subscribe(me);
    };
    // The worker is registered, checked and updated by update-ui.js (updater.js): an update waits for the person to choose it.
    navigator.serviceWorker.addEventListener('message', async (e) => {
      // The push service rotated the subscription: register the new one, quietly.
      if (e.data?.type === 'resubscribe') recover().catch(() => {});
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => recover().catch(() => {}));
    recover().catch(() => {});
  }
  // Fresh pairing: land on Settings → Remote so the next step (notifications) is right there.
  if (new URLSearchParams(location.search).has('paired')) { history.replaceState(null, '', '/#settings/remote'); dispatchEvent(new HashChangeEvent('hashchange')); }
})();
