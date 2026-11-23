// dotpals remote client: service worker. Two jobs, both small.
//  1. The app shell works offline-ish: its own files (scripts, styles, icons) are cached, so the app
//     opens instantly and, with no connection, still shows the last thing it knew (the page keeps a
//     copy of the data). Data is never cached here: /events and /api always go to the network.
const VERSION = '__VERSION__';
// Bumped when what this worker DOES changes (VERSION only changes with a release): the page tells a stale copy apart by it
// (shown in the worker version response).
const BUILD = 7;
// From this build on a new worker WAITS until the page says "update now" (message SKIP_WAITING), as the pdsvc dashboard does:
// the user picks the moment, nothing reloads under them. A page older than this has no Update button, so one that finds it
// installing over such a worker takes over at once, this one time (see install).
const EXPLICIT_FROM = 5;
const NETWORK_WAIT = 3000; // how long to wait for the computer before showing the last copy instead
const SHELL = `dotpals-shell-${VERSION}-b${BUILD}`; // a new build gets a fresh cache, so no old file can outlive it
const LOG = 'dotpals-worker-meta'; // not a "dotpals-shell-" cache, so activate doesn't clear it
// Small facts this worker keeps ON the phone for the page to read (Cache Storage: a worker can write it, the page can read it).
const keep = async (key, value) => {
  try { await (await caches.open(LOG)).put(key, new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })); } catch { /* storage full or blocked: nothing depends on it */ }
};
const SHELL_FILES = [
  '/', '/manifest.webmanifest', '/bridge/remote/remote.css', '/bridge/remote/boot.js', '/bridge/remote/stream.js', '/bridge/remote/client.js',
  '/bridge/remote/updater.js', '/bridge/remote/update-ui.js', '/bridge/remote/swipe.js', '/bridge/remote/pals.js', '/bridge/remote/pals-core.js', '/bridge/remote/talk.js', '/bridge/remote/settings.js', '/bridge/remote/icons/icon-192.png', '/desktop/icon.png',
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

// The page asks which version of this worker is running (and which build of its behaviour), to say so when the phone still
// has an old copy, and for its record of the last push it received.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'version') event.ports?.[0]?.postMessage({ version: VERSION, build: BUILD });
  // Only after the person chose "Update": never reload an app they are in the middle of using.
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
