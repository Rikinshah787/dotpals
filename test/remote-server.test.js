import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { get, request } from 'node:http';
import { createServer as createNet } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOTPALS_CODEX = '0';
process.env.DOTPALS_CLAUDE_LOGS = '0';
process.env.DOTPALS_HISTORY = '0';
const home = await mkdtemp(join(tmpdir(), 'dotpals-remote-srv-'));
process.env.DOTPALS_HOME = home;
after(() => rm(home, { recursive: true, force: true }));

const { saveConfig } = await import('../bridge/config.js');
const { startBridge } = await import('../bridge/server.js');
const { hostAllowed, pairingUrl, qrRows } = await import('../bridge/remote-server.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Ports the system says are free right now. A random pick from a range other test files also use sometimes landed on
// one of theirs, and a clash on the REMOTE port isn't an error (the bridge just logs it), so the test failed instead of retrying.
const port = () => new Promise((ok) => { const s = createNet().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => ok(p)); }); });

async function boot() {
  for (let i = 0; i < 10; i++) {
    const main = await port();
    const remotePort = await port();
    if (main === remotePort) continue;
    saveConfig({ remote: { enabled: true, bind: 'local', port: remotePort } });
    try {
      const server = await startBridge({ port: main, log: () => {} });
      for (let t = 0; t < 40; t++) { try { await fetch(`http://127.0.0.1:${remotePort}/pair`); break; } catch { await wait(50); } }
      return { main, remote: remotePort, server };
    } catch (err) { if (!['EADDRINUSE', 'EACCES'].includes(err.code)) throw err; }
  }
  throw new Error('no free ports');
}
const ctx = await boot();
after(() => new Promise((r) => { ctx.server.closeAllConnections?.(); ctx.server.close(() => r()); }));

const R = (path, init = {}) => fetch(`http://127.0.0.1:${ctx.remote}${path}`, init);
const M = (path, body) => fetch(`http://127.0.0.1:${ctx.main}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-dotpals': '1' }, body: JSON.stringify(body) });
const post = (path, body, cookie) => R(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dotpals': '1', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body ?? {}) });

let cookie = '';
let deviceId = '';
async function pair(name = 'Pixel Fold') {
  const made = await (await M('/api/remote/pair', {})).json();
  const res = await post('/pair/claim', { code: made.code, name });
  const set = res.headers.get('set-cookie');
  return { res, made, cookie: set?.split(';')[0] };
}
test('the remote client answers on its own port; the bridge keeps its own', async () => {
  assert.equal((await M('/api/status')).status, 200);
  const state = await (await M('/api/remote')).json();
  assert.equal(state.running, true);
  assert.equal(state.port, ctx.remote);
  assert.equal((await R('/api/status')).status, 401);
  assert.equal((await R('/events')).status, 401);
});

test('computer-side pairing needs this computer: the remote port cannot reach /api/remote', async () => {
  assert.equal((await R('/api/remote')).status, 403);
  assert.equal((await post('/api/remote/pair', {})).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${ctx.main}/api/remote/pair`, { method: 'POST', body: '{}' })).status, 403); // no x-dotpals
});

test('pairing: a code works once and sets an HttpOnly, SameSite=Strict cookie', async () => {
  const p = await pair();
  assert.equal(p.res.status, 200);
  const set = p.res.headers.get('set-cookie');
  assert.match(set, /^dp_device=[\w-]+\.[\w-]+;/);
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  assert.match(p.made.url, /\/pair#[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.ok(p.made.qr.length > 20 && /^[01]+$/.test(p.made.qr[0]));
  cookie = p.cookie;
  const again = await post('/pair/claim', { code: p.made.code, name: 'replay' });
  assert.equal(again.status, 403);
  assert.equal((await post('/pair/claim', { code: 'AAAA-AAAA-AAAA', name: 'x' })).status, 403);
});

test('pairing refuses a request that is not from our own page', async () => {
  const made = await (await M('/api/remote/pair', {})).json();
  const noHeader = await R('/pair/claim', { method: 'POST', body: JSON.stringify({ code: made.code }) });
  assert.equal(noHeader.status, 403);
  const foreign = await R('/pair/claim', { method: 'POST', headers: { 'x-dotpals': '1', origin: 'https://evil.example' }, body: JSON.stringify({ code: made.code }) });
  assert.equal(foreign.status, 403);
  assert.equal((await post('/pair/claim', { code: made.code, name: 'ok' })).status, 200); // still unused
});

test('a paired device can read, but not run things', async () => {
  const me = await (await R('/api/remote/me', { headers: { cookie } })).json();
  deviceId = me.id;
  assert.equal(me.name, 'Pixel Fold');
  assert.equal(me.control, false);
  assert.ok(me.vapid.length > 80);
  assert.equal((await R('/api/status', { headers: { cookie } })).status, 200);
  const hand = await post('/api/handoff', { session: 'x', agent: 'copy' }, cookie);
  assert.equal(hand.status, 403);
  assert.equal((await hand.json()).error, 'control');
  assert.equal((await post('/api/app/quit', {}, cookie)).status, 403);
  assert.equal((await post('/hook', {}, cookie)).status, 403);
  assert.equal((await R('/api/remote', { headers: { cookie } })).status, 403);
  assert.equal((await R('/api/status', { method: 'POST', headers: { cookie } })).status, 403); // no x-dotpals
});

test('remote management never mutates state through GET or HEAD', async () => {
  for (const method of ['GET', 'HEAD']) {
    for (const path of ['/api/remote/pair', '/api/remote/pair/cancel', '/api/remote/revoke-all', `/api/remote/devices/${deviceId}/revoke`]) {
      assert.equal((await fetch(`http://127.0.0.1:${ctx.main}${path}`, { method })).status, 405, path);
    }
    for (const path of ['/api/remote/me/signout', '/api/remote/me/push', '/api/remote/me/test', '/api/remote/me/prefs']) {
      assert.equal((await R(path, { method, headers: { cookie } })).status, 403, path);
    }
  }
  assert.equal((await R('/api/remote/me', { headers: { cookie } })).status, 200);
});

test('device diagnostics reject scalar/array JSON and acknowledgements need authentication and CSRF headers', async () => {
  for (const body of ['null', '[]', '42', '"text"', '{']) {
    assert.equal((await R('/api/remote/me/ack', { method: 'POST', headers: { cookie, 'x-dotpals': '1' }, body })).status, 400);
  }
  assert.equal((await post('/api/remote/me/ack', { sentAt: 1 })).status, 401);
  assert.equal((await R('/api/remote/me/ack', { method: 'POST', headers: { cookie }, body: '{}' })).status, 403);
  assert.equal((await R('/api/remote/me/ack', { method: 'POST', headers: { cookie, 'x-dotpals': '1', origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.deepEqual(await (await post('/api/remote/me/ack', { sentAt: 1, shown: true }, cookie)).json(), { ok: false }, 'unmatched receipt is not invented history');
});

test('a browser-origin Talk request passes only for a controlling device from the admitted origin', async () => {
  const headers = { cookie, 'x-dotpals': '1', 'content-type': 'application/json', host: 'paired.example', origin: 'https://paired.example', 'x-forwarded-proto': 'https' };
  await M('/api/config', { remote: { publicUrl: 'https://paired.example' } });
  assert.equal((await R('/api/talk/plan', { method: 'POST', headers, body: '{}' })).status, 403);
  await M(`/api/remote/devices/${deviceId}`, { control: true });
  assert.equal((await R('/api/talk/plan', { method: 'POST', headers, body: '{}' })).status, 400, 'the request reaches validation, not the local-only Origin gate');
  assert.equal((await R('/api/talk/plan', { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${ctx.main}/api/talk/plan`, { method: 'POST', headers, body: '{}' })).status, 403, 'the local listener never trusts a claimed remote origin');
  await M(`/api/remote/devices/${deviceId}`, { control: false });
  await M('/api/config', { remote: { publicUrl: '' } });
});

test('settings: safe ones change, powerful ones need the control switch', async () => {
  const ok = await post('/api/config', { sounds: false }, cookie);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).sounds, false);
  const denied = await post('/api/config', { sounds: true, chat: true, remote: { enabled: false } }, cookie);
  assert.equal(denied.status, 403);
  assert.equal((await (await M('/api/config')).json()).sounds, false); // nothing half applied
  await M(`/api/remote/devices/${deviceId}`, { control: true });
  assert.equal((await post('/api/config', { sounds: true }, cookie)).status, 200);
  const remoteEdit = await post('/api/config', { remote: { enabled: false } }, cookie);
  assert.equal(remoteEdit.status, 403); // never from a device, even with control
  assert.equal((await (await M('/api/remote')).json()).running, true);
  await M(`/api/remote/devices/${deviceId}`, { control: false });
});

test('unlisted APIs stay local even with control, and local test traffic needs the exact origin', async () => {
  await M(`/api/remote/devices/${deviceId}`, { control: true });
  try {
    for (const path of ['/api/apps', '/api/approvals', '/api/recap']) assert.equal((await R(path, { headers: { cookie } })).status, 403, path);
    for (const path of ['/api/apps/add', '/api/talk/apps', '/api/history/clear']) assert.equal((await post(path, {}, cookie)).status, 403, path);
    assert.equal((await R('/api/remote/me/prefs', { method: 'POST', headers: { cookie, 'x-dotpals': '1', origin: `https://127.0.0.1:${ctx.remote}` }, body: '{}' })).status, 403);
    const local = await R('/api/remote/me/prefs', { method: 'POST', headers: { cookie, 'x-dotpals': '1', origin: `http://127.0.0.1:${ctx.remote}` }, body: '{}' });
    assert.equal(local.status, 200);
  } finally { await M(`/api/remote/devices/${deviceId}`, { control: false }); }
});

test('subscription recovery does not re-enable notifications after opt-out', async () => {
  assert.equal((await post('/api/remote/me/push', { subscription: null, recover: true }, cookie)).status, 409);
  assert.equal((await post('/api/remote/me/test', {}, cookie)).status, 409);
});

test('the paired activity snapshot respects the configured remote history window', async () => {
  const event = (id, at) => ({ session: 'history-window', harness: 'test', activity: { id, kind: 'prompt', title: id, status: 'info', at } });
  await M('/api/config', { remote: { historyDays: 1 } });
  try {
    await M('/event', event('remote-history-old', Date.now() - 2 * 86_400_000));
    await M('/event', event('remote-history-recent', Date.now()));
    const local = await (await M('/api/activity')).json();
    const paired = await (await R('/api/activity', { headers: { cookie } })).json();
    assert.ok(local.entries.some((e) => e.title === 'remote-history-old'));
    assert.ok(paired.entries.some((e) => e.title === 'remote-history-recent'));
    assert.ok(!paired.entries.some((e) => e.title === 'remote-history-old'));
  } finally { await M('/api/config', { remote: { historyDays: 3 } }); }
});

test('a controlling remote stream without approval cards does not intercept a terminal permission prompt', async () => {
  await M(`/api/remote/devices/${deviceId}`, { control: true });
  await M('/api/config', { approvals: true });
  const stream = await R('/events', { headers: { cookie } });
  const reader = stream.body.getReader();
  await readUntilReady(reader);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 2000);
  try {
    const res = await fetch(`http://127.0.0.1:${ctx.main}/hook`, { method: 'POST', signal: abort.signal, body: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'remote-no-cards', tool_name: 'Bash', tool_input: { command: 'npm test' } }) });
    assert.deepEqual(await res.json(), {});
  } finally {
    clearTimeout(timeout);
    await reader.cancel();
    await M('/api/config', { approvals: false });
    await M(`/api/remote/devices/${deviceId}`, { control: false });
  }
});

test('static files are served with an ETag, revalidate with 304, and the bridge source stays private', async () => {
  const first = await R('/bridge/ui/recap.js');
  assert.equal(first.status, 200);
  assert.match(first.headers.get('content-type'), /javascript/);
  const etag = first.headers.get('etag');
  assert.ok(etag);
  assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await R('/bridge/ui/recap.js', { headers: { 'if-none-match': etag } })).status, 304);
  for (const hidden of ['/bridge/server.js', '/bridge/remote.js', '/bridge/config.js', '/package.json', '/bridge/../package.json', '/..%2fpackage.json', '/desktop/main.js']) {
    assert.ok([403, 404].includes((await R(hidden)).status), hidden);
  }
});

test('the dashboard is served as an installable app with a strict, hash-based CSP', async () => {
  const res = await R('/');
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const tag of ['rel="manifest"', 'name="dotpals-face" content="device"', 'viewport-fit=cover', '/bridge/remote/boot.js', '/bridge/remote/stream.js', '/bridge/remote/remote.css', '/bridge/remote/client.js', '/bridge/remote/settings.js']) assert.ok(html.includes(tag), tag);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self' 'sha256-[\w+/=]+'/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
  assert.match(csp, /frame-ancestors 'none'/);
  const manifest = await (await R('/manifest.webmanifest')).json();
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
  for (const i of manifest.icons) assert.equal((await R(i.src)).status, 200, i.src);
  const sw = await (await R('/sw.js')).text();
  assert.ok(!sw.includes('__VERSION__'));
  assert.equal((await R('/pair')).status, 200);
  assert.equal((await R('/bridge/remote/pair.js')).status, 200);
  assert.equal((await R('/bridge/vendor/qrcode.js')).status, 403, 'QR generation is server-side');
});

async function readUntilReady(reader) {
  const dec = new TextDecoder();
  let text = '';
  while (!text.includes('event: ready')) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value); }
  return text;
}

test('the live stream: one write, resumable, and gone when the device is signed out', async () => {
  const res = await R('/events', { headers: { cookie, 'accept-encoding': 'identity' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const text = await readUntilReady(reader);
  assert.match(text, /event: config/);
  const lastId = [...text.matchAll(/^id: (\S+)$/gm)].at(-1)[1];
  await reader.cancel();
  await M('/api/config', { sounds: true }); // something changes while it's away
  const back = await R('/events', { headers: { cookie, 'accept-encoding': 'identity', 'last-event-id': lastId } });
  const r2 = back.body.getReader();
  const t2 = await readUntilReady(r2);
  assert.match(t2, /"resumed":true/);
  assert.equal((t2.match(/event: config/g) ?? []).length, 1, 'only the change, not the whole picture');
  await M(`/api/remote/devices/${deviceId}/revoke`, {});
  const { done } = await Promise.race([r2.read(), wait(1500).then(() => ({ done: false }))]);
  assert.equal(done, true);
  assert.equal((await R('/api/status', { headers: { cookie } })).status, 401);
});

test('turning the setting off stops the listener', async () => {
  await M('/api/config', { remote: { enabled: false } });
  await wait(300);
  await assert.rejects(R('/pair'));
  assert.equal((await (await M('/api/remote')).json()).running, false);
});

test('helpers: hosts, links and the QR', () => {
  const cfg = { bind: 'lan', port: 5176, publicUrl: 'https://dp.example.com' };
  assert.equal(hostAllowed('dp.example.com', cfg), true);
  assert.equal(hostAllowed('127.0.0.1:5176', cfg), true);
  assert.equal(hostAllowed('192.168.1.5:5176', cfg), true);
  assert.equal(hostAllowed('192.168.1.5', { ...cfg, bind: 'local' }), false);
  assert.equal(hostAllowed('evil.example.com', cfg), false);
  assert.equal(pairingUrl(cfg, 'AAAA-BBBB-CCCC'), 'https://dp.example.com/pair#AAAA-BBBB-CCCC');
  assert.equal(pairingUrl({ bind: 'lan', port: 5176, publicUrl: '' }, 'X', ['192.168.1.69']), 'http://192.168.1.69:5176/pair#X');
  assert.equal(pairingUrl({ bind: 'local', port: 5176, publicUrl: '' }, 'X', ['192.168.1.69']), 'http://127.0.0.1:5176/pair#X');
  // With its own certificate the link is https, so the QR code opens the right thing.
  const tls = { bind: 'lan', port: 5176, publicUrl: '', tlsCert: 'c.pem', tlsKey: 'k.pem' };
  assert.equal(pairingUrl(tls, 'X', ['192.168.1.69']), 'https://192.168.1.69:5176/pair#X');
  assert.equal(pairingUrl({ ...tls, tlsKey: '' }, 'X', ['192.168.1.69']), 'http://192.168.1.69:5176/pair#X'); // half-configured: not https
  const rows = qrRows('https://dp.example.com/pair#AAAA-BBBB-CCCC');
  assert.ok(rows.length >= 21 && rows.every((r) => r.length === rows.length));
});
