import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_EVERY, createUpdater, updateView, updateWords } from '../bridge/remote/updater.js';

/** A fake navigator.serviceWorker + registration: what the browser does, driven by the test. */
function fakeBrowser({ failRegister = false, failUpdate = false } = {}) {
  const listeners = new Map();
  const on = (map) => (type, fn) => { map.set(type, [...(map.get(type) ?? []), fn]); };
  const fire = (map, type, ...a) => (map.get(type) ?? []).forEach((fn) => fn(...a));
  const regL = new Map();
  const swL = new Map();
  const messages = [];
  const reg = {
    waiting: null, installing: null, updates: 0, options: null,
    addEventListener: on(regL),
    async update() { reg.updates++; if (failUpdate) throw new TypeError('Failed to fetch'); },
  };
  const sw = {
    addEventListener: on(swL),
    async register(url, options) { if (failRegister) throw new Error('blocked'); reg.url = url; reg.options = options; return reg; },
  };
  /** A new version arrives: it installs, then waits (as every worker after the first does, until told to skip). */
  const newVersion = () => {
    const worker = { state: 'installing', addEventListener: on(listeners), postMessage: (m) => messages.push(m) };
    reg.installing = worker;
    fire(regL, 'updatefound');
    return {
      worker,
      installed() { worker.state = 'installed'; reg.installing = null; reg.waiting = worker; fire(listeners, 'statechange'); },
      broke() { worker.state = 'redundant'; reg.installing = null; fire(listeners, 'statechange'); },
    };
  };
  const tookOver = () => { reg.waiting = null; fire(swL, 'controllerchange'); };
  return { sw, reg, messages, newVersion, tookOver };
}
const make = (b, extra = {}) => { const reloads = []; let t = 1_000_000; const u = createUpdater({ sw: b.sw, reload: () => reloads.push(1), now: () => t, ...extra }); return { u, reloads, tick: (ms) => { t += ms; } }; };

test('it registers without letting the browser reuse its own cached copy of the worker, and checks at once', async () => {
  const b = fakeBrowser();
  const { u } = make(b);
  await u.start();
  assert.equal(b.reg.url, '/sw.js');
  assert.equal(b.reg.options.updateViaCache, 'none', 'the worker file is never taken from the HTTP cache');
  assert.equal(b.reg.options.scope, '/');
  assert.equal(b.reg.updates, 1, 'asked the computer for a newer worker straight away, not "whenever the browser feels like it"');
  assert.equal(u.state().view, 'current');
  assert.ok(u.state().checkedAt > 0);
});

test('a new version is downloaded, then WAITS: nothing reloads until the person chooses Update', async () => {
  const b = fakeBrowser();
  const { u, reloads } = make(b);
  await u.start();
  const v = b.newVersion();
  assert.equal(u.state().view, 'installing');
  v.installed();
  assert.equal(u.state().view, 'ready');
  assert.deepEqual(b.messages, [], 'nothing was told to take over');
  assert.equal(reloads.length, 0, 'and the page did not reload under anyone');
  // The worker taking over by itself (another tab applied it) must not reload THIS page either: only the person's own choice does.
  b.tookOver();
  assert.equal(reloads.length, 0);
});

test('choosing Update tells the waiting worker to take over, then reloads once', async () => {
  const b = fakeBrowser();
  const { u, reloads } = make(b);
  await u.start();
  b.newVersion().installed();
  assert.equal(u.apply(), true);
  assert.deepEqual(b.messages, [{ type: 'SKIP_WAITING' }]);
  assert.equal(u.state().view, 'applying');
  assert.equal(u.apply(), false, 'a second tap does nothing');
  assert.equal(b.messages.length, 1);
  b.tookOver();
  b.tookOver();
  assert.equal(reloads.length, 1, 'reloaded once, however many times the browser says it changed');
});

test('there is nothing to apply when no update is waiting', async () => {
  const b = fakeBrowser();
  const { u } = make(b);
  await u.start();
  assert.equal(u.apply(), false);
  assert.deepEqual(b.messages, []);
});

test('an explicit check reports failure instead of pretending it is up to date, and can be tried again', async () => {
  const b = fakeBrowser({ failUpdate: true });
  const { u } = make(b);
  await u.start();
  assert.equal(u.state().view, 'failed');
  assert.equal(u.state().checkedAt, 0, 'a failed check is not "checked"');
  b.reg.update = async () => { b.reg.updates++; };
  const s = await u.check();
  assert.equal(s.view, 'current');
  assert.ok(s.checkedAt > 0);
});

test('a version that fails to install says so, and the next check clears it', async () => {
  const b = fakeBrowser();
  const { u } = make(b);
  await u.start();
  b.newVersion().broke();
  assert.equal(u.state().view, 'failed');
  await u.check();
  assert.equal(u.state().view, 'current');
});

test('coming back to the app checks again, but not on every glance', async () => {
  const b = fakeBrowser();
  const { u, tick } = make(b);
  await u.start();
  assert.equal(b.reg.updates, 1);
  tick(60_000);
  u.resumed();
  assert.equal(b.reg.updates, 1, 'a minute later: no');
  tick(CHECK_EVERY);
  u.resumed();
  await Promise.resolve();
  assert.equal(b.reg.updates, 2, 'long enough: yes');
});

test('no service worker support, or a registration that is refused, is reported, never thrown', async () => {
  const none = createUpdater({ sw: null, reload() {} });
  await none.start();
  assert.equal(none.state().view, 'unsupported');
  const refused = fakeBrowser({ failRegister: true });
  const { u } = make(refused);
  await u.start();
  assert.equal(u.state().view, 'failed');
  assert.equal(u.apply(), false);
});

test('a check while one is running, or while applying, is ignored', async () => {
  const b = fakeBrowser();
  const { u } = make(b);
  await u.start();
  const before = b.reg.updates;
  await Promise.all([u.check(), u.check(), u.check()]);
  assert.equal(b.reg.updates, before + 1, 'three taps, one request');
  b.newVersion().installed();
  u.apply();
  await u.check();
  assert.equal(b.reg.updates, before + 1, 'not while applying');
});

test('a manual check retries registration after an initial failure', async () => {
  const b = fakeBrowser({ failRegister: true });
  const { u } = make(b);
  await u.start();
  b.sw.register = async () => b.reg;
  await u.check();
  assert.equal(u.state().view, 'current');
});

test('an unresponsive waiting worker times out and permits another attempt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const b = fakeBrowser();
  const { u } = make(b);
  await u.start();
  b.newVersion().installed();
  u.apply();
  t.mock.timers.tick(20_000);
  assert.equal(u.state().requested, false);
  assert.equal(u.state().failed, true);
  assert.equal(u.apply(), true);
});

test('listeners hear every change, can stop listening, and one that throws cannot break the others', async () => {
  const b = fakeBrowser();
  const { u } = make(b);
  const seen = [];
  u.onChange(() => { throw new Error('a bad listener'); });
  const stop = u.onChange((s) => seen.push(s.view));
  await u.start();
  b.newVersion().installed();
  assert.ok(seen.includes('ready'));
  const n = seen.length;
  stop();
  u.apply();
  assert.equal(seen.length, n);
});

test('the update pill is sized to its words, not to the half of the screen `left: 50%` leaves it', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../bridge/remote/remote.css', import.meta.url), 'utf8');
  const rule = /#rc-update \{[^}]*\}/.exec(css)?.[0] ?? '';
  // Seen in a real browser on a phone: "An / update / is / ready." on four lines.
  assert.match(rule, /width: max-content/);
  assert.match(rule, /white-space: nowrap/);
  assert.match(rule, /max-width: calc\(100vw - 24px\)/, 'but never wider than the screen');
  assert.ok(css.includes('html[data-fold="book"] #rc-update') && css.includes('html[data-fold="table"] #rc-update'), 'and kept clear of the hinge');
});

test('what to show, in order of importance', () => {
  assert.equal(updateView({ supported: false }), 'unsupported');
  assert.equal(updateView({ registered: true, waiting: true, requested: true }), 'applying');
  assert.equal(updateView({ registered: true, waiting: true }), 'ready');
  assert.equal(updateView({ registered: true, installing: true }), 'installing');
  assert.equal(updateView({ registered: true, failed: true }), 'failed');
  assert.equal(updateView({ registered: true, checking: true }), 'checking');
  assert.equal(updateView({ registered: false }), 'checking', 'not registered yet: still starting');
  assert.equal(updateView({ registered: true }), 'current');
});

test('the words say what is happening and offer only what can be done', () => {
  const now = 10_000_000;
  assert.equal(updateWords({ view: 'ready' }, now).action, 'update');
  assert.match(updateWords({ view: 'ready' }, now).note, /Finish what you’re doing first/);
  assert.equal(updateWords({ view: 'current', checkedAt: now - 120_000 }, now).action, 'check');
  assert.match(updateWords({ view: 'current', checkedAt: now - 120_000 }, now).note, /Checked 2 min ago/);
  assert.equal(updateWords({ view: 'failed', checkedAt: 0 }, now).action, 'check');
  for (const view of ['applying', 'installing', 'checking', 'unsupported']) assert.equal(updateWords({ view }, now).action, null, `${view}: nothing to press`);
});
