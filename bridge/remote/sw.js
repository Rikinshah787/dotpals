// dotpals remote client: service worker. Two jobs, both small.
//  1. The app shell works offline-ish: its own files (scripts, styles, icons) are cached, so the app
//     opens instantly and, with no connection, still shows the last thing it knew (the page keeps a
//     copy of the data). Data is never cached here: /events and /api always go to the network.
//  2. Web Push: show the notification the bridge sent (already summarised and redacted on the
//     computer), and open the app when it's tapped.
const VERSION = '__VERSION__';
// Bumped when what this worker DOES changes (VERSION only changes with a release): the page tells a stale copy apart by it
// (push-words.js WORKER_BUILD must match).
const BUILD = 9;
// From this build on a new worker WAITS until the page says "update now" (message SKIP_WAITING), as the pdsvc dashboard does:
// the user picks the moment, nothing reloads under them. A page older than this has no Update button, so one that finds it
// installing over such a worker takes over at once, this one time (see install).
const EXPLICIT_FROM = 5;
const NETWORK_WAIT = 3000; // how long to wait for the computer before showing the last copy instead
const SHELL = `dotpals-shell-${VERSION}-b${BUILD}`; // a new build gets a fresh cache, so no old file can outlive it
const LOG = 'dotpals-push-log'; // not a "dotpals-shell-" cache, so activate doesn't clear it
// Small facts this worker keeps ON the phone for the page to read (Cache Storage: a worker can write it, the page can read it).
const keep = async (key, value) => {
  try { await (await caches.open(LOG)).put(key, new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })); } catch { /* storage full or blocked: nothing depends on it */ }
};
const SHELL_FILES = [
  '/', '/manifest.webmanifest', '/bridge/remote/remote.css', '/bridge/remote/boot.js', '/bridge/remote/stream.js', '/bridge/remote/client.js',
  '/bridge/remote/push-words.js', '/bridge/remote/avatar-names.js', '/bridge/remote/updater.js', '/bridge/remote/update-ui.js', '/bridge/remote/swipe.js', '/bridge/remote/pals.js', '/bridge/remote/pals-core.js', '/bridge/remote/talk.js', '/bridge/remote/settings.js', '/bridge/remote/icons/icon-192.png', '/desktop/icon.png',
  '/src/index.js', '/src/actions.js', '/src/agent.js', '/src/characters.js', '/src/custom.js', '/src/element.js',
  '/bridge/ui/buddy.js', '/bridge/ui/handoff-menu.js', '/bridge/ui/recap.js', '/bridge/ui/replay.js', '/bridge/ui/report.js', '/bridge/ui/story.js', '/bridge/ui/testout.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // An update must have its complete shell before replacing the active worker and deleting its cache.
    const cache = await caches.open(SHELL);
    await Promise.all(SHELL_FILES.map((f) => cache.add(new Request(f, { cache: 'reload' }))));
    // Replacing a worker that predates the Update button (or the first install, where it changes nothing): take over now,
    // because that page can never ask. Replacing one that has it: wait for the page to say so.
    const prev = await caches.open(LOG).then((c) => c.match('/__worker')).then((r) => (r ? r.json() : null)).catch(() => null);
    if (!prev || (prev.build ?? 0) < EXPLICIT_FROM) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('dotpals-shell-') && key !== SHELL) await caches.delete(key);
    await self.clients.claim();
    // When this copy started: the page can then say "no push since", and not blame the phone for ones that came before it.
    await keep('/__worker', { build: BUILD, version: VERSION, at: Date.now() });
  })());
});

const isShell = (url) => url.origin === self.location.origin && (url.pathname === '/' || /^\/(?:src|bridge|desktop)\//.test(url.pathname) || url.pathname === '/manifest.webmanifest');
// The pal that is responsible for a notification, wearing the face that fits it (bridge/remote/avatars, made by scripts/make-avatars.mjs).
// Anything that isn't one of those names gets the app's own icon.
const avatarOf = (name) => (/^(?:blu|hop|sunny|lovi|muse|grok|nova|byte|webby)-(?:done|waiting|thinking|working|error)$/.test(name) ? `/bridge/remote/avatars/${name}.png` : '/bridge/remote/icons/icon-192.png');
const localUrl = (value) => {
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin ? `${url.pathname}${url.search}${url.hash}` : '/';
  } catch { return '/'; }
};

// Keep each installed shell coherent until the person applies its replacement. Known files are immutable within a build;
// updateViaCache:'none' and explicit registration.update() fetch the new worker independently of this cache.
// Unknown assets may use the network; data, the live stream and sign-in never pass through here.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!isShell(url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(req, { ignoreSearch: url.pathname === '/' });
    if (hit && SHELL_FILES.includes(url.pathname)) return hit;
    const fresh = fetch(req).then(async (res) => { if (res.ok) { try { await cache.put(req, res.clone()); } catch { /* full/blocked storage must not break an online request */ } } return res; });
    event.waitUntil(fresh.catch(() => {})); // keep the cache write alive after the cached response wins the timeout
    if (!hit) { try { return await fresh; } catch { return new Response('Offline', { status: 503 }); } }
    let timer;
    const slow = new Promise((ok) => { timer = setTimeout(() => ok(null), NETWORK_WAIT); });
    try { const res = await Promise.race([fresh, slow]); return !res || res.status >= 500 ? hit : res; } catch { return hit; } finally { clearTimeout(timer); }
  })());
});

// -- push ---------------------------------------------------------------------------------------
// The phone's own record of the last push it received, kept ON the phone (Cache Storage: a service worker can write to it
// and the page can read it). The computer's word that "the push service accepted it" can't say whether it ever got here;
// this can, even when the phone has no way to reach the computer.
let latestPush = 0;
let recording = Promise.resolve();
const remember = (record, sequence) => {
  const copy = { ...record };
  recording = recording.then(() => sequence === latestPush ? keep('/__last-push', copy) : undefined);
  return recording;
};

self.addEventListener('push', (event) => {
  // The very first thing, before anything can fail: a push arrived at all.
  const got = Date.now();
  const sequence = ++latestPush;
  let note = { title: 'dotpals', body: '', tag: 'dotpals', url: '/' };
  let parsed = true;
  try { note = { ...note, ...event.data.json() }; } catch { parsed = false; try { note.body = event.data.text(); } catch {} }
  const record = { at: got, sentAt: Number(note.at) || 0, phase: 'received', shown: false, held: false, error: parsed ? '' : 'unreadable', permission: self.Notification?.permission ?? '', ackStatus: 0, tag: String(note.tag ?? '').slice(0, 40) };
  event.waitUntil((async () => {
    await remember(record, sequence);
    // Quiet mode is decided before sending. A delivered userVisibleOnly push must request a notification.
    const held = false;
    let shown = true;
    let error = '';
    try {
      await self.registration.showNotification(String(note.title).slice(0, 80), {
          body: String(note.body ?? '').slice(0, 200), tag: String(note.tag ?? 'dotpals'), renotify: note.kind === 'approval' || !!note.test,
          icon: avatarOf(note.avatar), badge: '/bridge/remote/icons/icon-96.png', timestamp: Number(note.at) || Date.now(),
          // A hint to keep important notifications available; the OS decides presentation.
          requireInteraction: note.kind === 'approval' || note.kind === 'waiting' || !!note.test, data: { url: typeof note.url === 'string' && note.url.startsWith('/') ? localUrl(note.url) : '/' },
      });
    } catch (err) { shown = false; error = String(err?.message ?? err).slice(0, 80); }
    // Report worker receipt and browser display outcome, separately from provider acceptance and OS presentation.
    Object.assign(record, { phase: 'done', shown, held, error: error || record.error });
    await remember(record, sequence);
    try {
      const res = await fetch('/api/remote/me/ack', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-dotpals': '1' },
        body: JSON.stringify({ sentAt: Number(note.at) || 0, shown, held, error, tag: String(note.tag ?? '').slice(0, 40) }) });
      record.ackStatus = res?.status ?? 0;
    } catch { /* offline: the notification is already up; the computer just won't hear that it arrived */ }
    await remember(record, sequence);
  })());
});

// The page asks which version of this worker is running (and which build of its behaviour), to say so when the phone still
// has an old copy, and for its record of the last push it received.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'version') event.ports?.[0]?.postMessage({ version: VERSION, build: BUILD });
  // Only after the person chose "Update": never reload an app they are in the middle of using.
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(localUrl(event.notification.data?.url ?? '/'), self.location.origin).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const mine = open.find((c) => new URL(c.url).origin === self.location.origin);
    if (mine) { await mine.focus(); if ('navigate' in mine && target !== mine.url) await mine.navigate(target).catch(() => {}); return; }
    await self.clients.openWindow(target);
  })());
});

// The push service rotated our subscription: tell the page (when it next opens) to register again.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(self.clients.matchAll({ includeUncontrolled: true }).then((all) => all.forEach((c) => c.postMessage({ type: 'resubscribe' }))));
});
