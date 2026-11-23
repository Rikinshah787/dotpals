// The remote client's server: a second listener, separate from the bridge's own 127.0.0.1 one
// (agents' hooks never face a network). Off unless Settings → Remote turns it on.
//   GET  /pair, /manifest.webmanifest, /sw.js, static scripts    open (no data in them)
//   POST /pair/claim { code, name }                              trade a pairing code for a device cookie
//   GET  /events, allowed /api/*                                a paired device (cookie dp_device, or Bearer)
//   POST /api/*                                                  same, plus the x-dotpals header, and remote.js permission()
// A device's cookie is HttpOnly + SameSite=Strict: the unmodified dashboard just works, and no
// script on the page can read it. API calls are handed to the bridge's own handler.
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzip as gzipCb } from 'node:zlib';
import { promisify } from 'node:util';
import { allowed, chooseEncoding, createAssets, createWorkerAsset, csp, inlineHashes, negotiate } from './remote-assets.js';
import { createHub } from './remote-hub.js';
import { createPusher } from './remote-push.js';
import { sendPush } from './webpush.js';
import { createLimiter, createRemote, permission, remotePatch } from './remote.js';
import qrcode from './vendor/qrcode.js';
import { caFingerprint, certDir, ensureCerts, localName, privateAddresses } from './remote-cert.js';

const gzipAsync = promisify(gzipCb);
const COOKIE = 'dp_device';
const YEAR_AND_A_BIT = 400 * 86400; // the longest a browser keeps a cookie
const cookieOf = (req) => /(?:^|;\s*)dp_device=([\w.-]{20,140})/.exec(req.headers.cookie ?? '')?.[1] ?? null;
const SECURITY = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin', 'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

/** This computer's network addresses (IPv4), for the pairing link in 'lan' mode. */
export const lanAddresses = () => Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')).map((i) => i.address);

/** Does this configuration make the server speak https itself? The one answer, for the link, the settings page and the listener. */
export const servesTls = (cfg) => !!(cfg?.tlsAuto || (cfg?.tlsCert && cfg?.tlsKey));

/**
 * Only the names this server is meant to answer to (stops DNS-rebinding pages): this computer, the public address,
 * and in 'lan' mode, IP addresses and this computer's own .local name (a page on the internet can't make a browser
 * send that Host to your computer unless it already controls the name, and mDNS names don't resolve off your network).
 */
export function hostAllowed(host, cfg, own = localName()) {
  const authority = String(host ?? '');
  if (!/^(?:\[[a-f\d:]+\]|[a-z\d.-]+)(?::\d{1,5})?$/i.test(authority)) return false;
  let name;
  try { name = new URL(`http://${authority}`).hostname.replace(/\.$/, ''); } catch { return false; }
  if (/^(127\.0\.0\.1|localhost|\[::1\])$/.test(name)) return true;
  try { if (cfg.publicUrl && new URL(cfg.publicUrl).hostname.toLowerCase() === name) return true; } catch {}
  if (cfg.bind !== 'lan') return false;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || (!!own && name === own);
}

/**
 * The link a device opens: the public address, else (on your network) this computer's .local name when it has its own
 * certificate for it, else its IP address, else localhost. The code rides in the #fragment: never sent to a server or logged.
 * A .local name survives a new DHCP address (the certificate names both), but not every phone can look one up, so the
 * IP is what the QR code carries unless `name` says otherwise.
 */
export function pairingUrl(cfg, code, lan = cfg.tlsAuto ? privateAddresses() : lanAddresses(), { name = false, own = localName() } = {}) {
  const scheme = servesTls(cfg) ? 'https' : 'http'; // serving a certificate (its own, or yours): the link says so
  const host = name && own ? own : lan[0];
  const base = cfg.publicUrl || (cfg.bind === 'lan' && host ? `${scheme}://${host}:${cfg.port}` : `${scheme}://127.0.0.1:${cfg.port}`);
  return `${base}/pair#${code}`;
}

/** A QR code as rows of '0'/'1' (the page draws it: no markup is built from it). */
export function qrRows(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (__, c) => (qr.isDark(r, c) ? '1' : '0')).join(''));
}

const readBuffer = (req, max = 1024 * 1024) => new Promise((ok, fail) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    if (size > max) return;
    size += c.length;
    if (size > max) { chunks.length = 0; fail(Object.assign(new Error('too large'), { status: 413 })); }
    else chunks.push(c);
  });
  req.on('end', () => ok(Buffer.concat(chunks)));
  req.on('error', fail);
  req.on('aborted', () => fail(new Error('request aborted')));
});
async function readJson(req, max = 4096) {
  const bytes = await readBuffer(req, max);
  const body = JSON.parse(bytes.toString('utf8') || '{}');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('bad json');
  return body;
}
const out = (res, status, data, extra = {}) => res.writeHead(status, { ...SECURITY, 'content-type': 'application/json', 'cache-control': 'no-store', ...extra }).end(JSON.stringify(data));
const loopback = (a = '') => /^(127\.|::1$|::ffff:127\.)/.test(a);
const REPO = 'https://github.com/rikinshah787/dotpals'; // VAPID requires a contact URL, not a credential

/** A body shaped like the original request, for handing the bridge a changed one. */
const shim = (req, text) => Object.assign(Readable.from([Buffer.from(text)]), { method: req.method, url: req.url, headers: { ...req.headers, 'content-length': String(Buffer.byteLength(text)) } });
export function createRemoteServer({ config, file, certHome, root, version, api, snapshot, turn, secrets, log = () => {}, pushSend, renewMs = 60_000, addressesNow = privateAddresses, certs = ensureCerts }) {
  const remote = createRemote({ file });
  const hub = createHub();
  const claims = createLimiter({ max: 8, windowMs: 60_000 });
  const pushTests = createLimiter({ max: 5, windowMs: 60_000 });
  let server = null;
  let runKey = '';
  let lastError = null;
  const pusher = createPusher({ remote, hub, send: pushSend ?? sendPush, vapid: () => remote.vapid(), subject: REPO, turn, secrets, log });
  const visibleEvents = new Set([null, undefined, 'message', 'activity', 'config', 'context', 'helpers', 'agents', 'laya', 'loop', 'stuck', 'conflict', 'reset']);
  const onEvent = (event, data) => {
    if (!server) return;
    if (visibleEvents.has(event)) hub.publish(event, data);
    pusher.handle(event, data);
  };

  const HEAD = [
    '<link rel="manifest" href="/manifest.webmanifest">', '<meta name="theme-color" content="#0b0b0e">',
    '<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
    '<link rel="apple-touch-icon" href="/bridge/remote/icons/icon-180.png">',
    '<meta name="dotpals-face" content="device">', // the page shows a device's settings, not the computer's (bridge/remote/settings.js)
    '<link rel="stylesheet" href="/bridge/remote/remote.css">', '<script src="/bridge/remote/boot.js"></script>', '<script src="/bridge/remote/stream.js"></script>',
  ].join('\n');
  // settings.js is part of the dashboard itself (the computer needs it too); client.js is only for devices.
  const TAIL = '<script type="module" src="/bridge/remote/client.js"></script>\n';
  const transform = (target, text) => {
    if (target.endsWith('/sw.js')) return text.replace('__VERSION__', version);
    if (!target.endsWith('.html') || target.endsWith('/pair.html')) return text;
    return text.replace(/<meta name="viewport"[^>]*>/, '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">')
      .replace('</head>', () => `${HEAD}\n</head>`).replace('</body>', () => `${TAIL}</body>`);
  };
  const assets = createAssets({ root, transform });
  const workerAsset = createWorkerAsset(assets.load);

  /** Encrypted, or this computer talking to itself. Behind your own tunnel or proxy (on this computer), its X-Forwarded-Proto counts. */
  const proxied = (req) => {
    const cfg = config();
    if (cfg.bind !== 'local' || !loopback(req.socket.remoteAddress) || req.headers['x-forwarded-proto'] !== 'https') return false;
    try { const url = new URL(cfg.publicUrl); return url.protocol === 'https:' && req.headers.host === url.host; } catch { return false; }
  };
  const encrypted = (req) => {
    if (req.socket.encrypted) return true;
    return proxied(req);
  };
  const isSecure = (req) => encrypted(req) || (loopback(req.socket.remoteAddress) && /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(req.headers.host ?? '') && !req.headers['x-forwarded-for']);
  const originOk = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      if (!req.socket.encrypted && proxied(req)) return origin === config().publicUrl;
      const protocol = req.socket.encrypted ? 'https:' : 'http:';
      return origin === new URL(`${protocol}//${req.headers.host}`).origin;
    } catch { return false; }
  };
  const bearer = (req) => { const c = encrypted(req) && cookieOf(req); return c ? `Bearer ${c}` : req.headers.authorization; };
  const cookieHeader = (value, maxAge, secure) => `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  function sendEntry(req, res, entry) {
    const headers = { ...SECURITY, 'content-type': entry.type, etag: entry.etag, 'cache-control': 'no-cache', vary: 'accept-encoding' };
    if (entry.type.startsWith('text/html')) headers['content-security-policy'] = (entry.csp ??= csp(inlineHashes(entry.body.toString('utf8'))));
    const [body, encoding] = negotiate(entry, req.headers['accept-encoding']);
    if (!body) return res.writeHead(406, headers).end();
    if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers); return res.end(); }
    if (encoding) headers['content-encoding'] = encoding;
    headers['content-length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  async function claim(req, res) {
    if (!encrypted(req)) return out(res, 426, { error: 'Pair over HTTPS: use a supported proxy, Tailscale, or your own certificate (Settings → Remote).' });
    if (req.headers['x-dotpals'] !== '1' || !originOk(req)) return out(res, 403, { error: 'forbidden' });
    let body;
    try { body = await readJson(req); } catch (err) { return out(res, err.status ?? 400, { error: err.message }); }
    const made = remote.finishPairing(body.code, body.name);
    // Never trust a client-supplied forwarding address or make valid claims share the proxy's failure budget.
    if (!made) {
      if (!claims.hit(req.socket.remoteAddress ?? '?')) return out(res, 429, { error: 'Too many tries. Wait a minute.' });
      return out(res, 403, { error: 'That code didn’t work. It may have expired: make a new one on the computer.' });
    }
    log(`remote: paired "${remote.device(made.id)?.name}"`);
    return out(res, 200, { ok: true, name: remote.device(made.id)?.name }, { 'set-cookie': cookieHeader(`${made.id}.${made.secret}`, YEAR_AND_A_BIT, true) });
  }

  /** Gzip an API answer when the device accepts it: the bridge's handlers answer with writeHead(...).end(json). */
  function compressApi(req, res) {
    for (const [key, value] of Object.entries(SECURITY)) res.setHeader(key, value);
    const coding = chooseEncoding(req.headers['accept-encoding']);
    if (coding !== 'gzip') return;
    const allowIdentity = !!chooseEncoding(req.headers['accept-encoding'], ['identity']);
    const writeHead = res.writeHead.bind(res);
    const end = res.end.bind(res);
    let held = null;
    res.writeHead = (status, headers) => { held = [status, headers]; return res; };
    res.end = (chunk) => {
      res.writeHead = writeHead;
      res.end = end;
      const [status, headers = {}] = held ?? [res.statusCode, {}];
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (buf && (buf.length > 1024 || !allowIdentity) && !headers['content-encoding']) {
        gzipAsync(buf).then((z) => { writeHead(status, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' }); end(z); }).catch(() => { if (!allowIdentity) { writeHead(406); end(); } else { writeHead(status, headers); end(buf); } });
      } else { writeHead(status, headers); end(buf); }
      return res;
    };
  }
  /** The device's own page of API: who am I, my push subscription and preferences, sign out. */
  async function meApi(req, res, path, device) {
    const id = device.id;
    if (req.method === 'GET' && path === '/api/remote/me') return out(res, 200, { ...remote.device(id), vapid: remote.vapid().publicKey, pushReady: true, lastPush: pusher.last(id), pushes: pusher.history(id), version });
    if (req.method !== 'POST') return out(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
    let body;
    try { body = await readJson(req, 8192); } catch (err) { return out(res, err.status ?? 400, { error: err.message }); }
    if (!remote.device(id)) return out(res, 401, { error: 'not paired' });
    if (path === '/api/remote/me/push') {
      if (body.recover === true && !remote.device(id).push) return out(res, 409, { error: 'Notifications are disabled.' });
      if (body.test !== true && remote.hasSubscription(id, body.subscription)) return out(res, 200, remote.device(id));
      if (body.subscription && !pushTests.hit(id)) return out(res, 429, { error: 'Wait a minute before enabling notifications again.' });
      const updated = remote.update(id, { push: body.subscription ?? null });
      if (!updated) {
        // Say which push service was refused (its name only: the rest of the address is a secret that identifies the phone).
        let host = '?'; try { host = new URL(String(body.subscription?.endpoint)).hostname.slice(0, 80); } catch {}
        log(`remote: refused a notification subscription from ${host}`);
        return out(res, 400, { error: `That notification subscription isn’t valid (provider: ${host}).` });
      }
      if (body.subscription && body.test === true) pusher.test(id).catch(() => {});
      return out(res, 200, updated);
    }
    if (path === '/api/remote/me/ack') return out(res, 200, { ok: pusher.ack(id, body) });
    if (path === '/api/remote/me/prefs') return out(res, 200, remote.update(id, { prefs: body.prefs, name: body.name }));
    if (path === '/api/remote/me/test') {
      if (!remote.device(id)?.push) return out(res, 409, { error: 'Notifications are not enabled on this device.' });
      if (!pushTests.hit(id)) return out(res, 429, { error: 'Wait a minute before sending another test.' });
      pusher.test(id).catch(() => {});
      return out(res, 200, { ok: true });
    }
    if (path === '/api/remote/me/signout') {
      try { remote.revoke(id); } catch { return out(res, 503, { error: 'Could not save device revocation. Try again.' }); }
      hub.drop(id);
      pusher.forget(id);
      return out(res, 200, { ok: true }, { 'set-cookie': cookieHeader('', 0, true), 'clear-site-data': '"cache", "storage"' });
    }
    return out(res, 404, { error: 'not found' });
  }

  /** What /events says to a new device: the same picture the pal and dashboard get, trimmed to `historyDays`. */
  const live = (req, res, device) => {
    const url = new URL(req.url, 'http://x');
    const since = req.headers['last-event-id'] || url.searchParams.get('since') || '';
    hub.join(req, res, {
      since, deviceId: device.id, compress: chooseEncoding(req.headers['accept-encoding']) === 'gzip',
      include: (event, data) => event !== 'activity' || (data?.at ?? 0) >= Date.now() - config().historyDays * 86_400_000,
      snapshot: (emit) => snapshot(emit, { days: config().historyDays }),
    });
  };

  async function handle(req, res) {
    const cfg = config();
    if (!hostAllowed(req.headers.host, cfg)) return res.writeHead(421, SECURITY).end();
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    if (req.method === 'POST' && path === '/pair/claim') return claim(req, res);
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) return res.writeHead(405, SECURITY).end();
    if (!isSecure(req)) return out(res, 426, { error: 'HTTPS is required for remote access.' });

    // The app's own files: open, cached, compressed. The page then asks for data with its cookie.
    if (req.method !== 'POST' && allowed(path)) {
      const entry = await (path === '/sw.js' ? workerAsset() : assets.load(path));
      return entry ? sendEntry(req, res, entry) : res.writeHead(404, SECURITY).end();
    }

    if (permission({ control: true }, req.method, path) === 'blocked') return out(res, 403, { error: 'not available from a paired device' });
    if (!originOk(req) || (req.method === 'POST' && req.headers['x-dotpals'] !== '1')) return out(res, 403, { error: 'forbidden' });
    let device = remote.authenticate(bearer(req));
    if (!device) return out(res, 401, { error: 'not paired' });
    const verdict = permission(device, req.method, path);
    if (verdict === 'blocked') return out(res, 403, { error: 'not available from a paired device' });
    if (verdict === 'control') return out(res, 403, { error: 'control', message: 'This device can look but not change things. Turn on “Let this device control” for it, on the computer (Settings → Remote).' });
    if (!chooseEncoding(req.headers['accept-encoding'], path.startsWith('/api/remote/') ? ['identity'] : ['gzip', 'identity'])) return res.writeHead(406, SECURITY).end();

    if (path === '/events') return live(req, res, device);
    if (path === '/api/remote/me' || path.startsWith('/api/remote/me/')) return meApi(req, res, path, device);
    if (req.method === 'POST') {
      let body;
      try { body = await readJson(req, 1024 * 1024); } catch (err) { return out(res, err.status ?? 400, { error: err.status === 413 ? 'too large' : 'bad json' }); }
      device = remote.device(device.id);
      if (!device) return out(res, 401, { error: 'not paired' });
      if (permission(device, req.method, path) !== 'ok') return out(res, 403, { error: 'control', message: 'The device no longer has control.' });
      if (path === '/api/config') {
        const { patch, denied } = remotePatch(body, device);
        if (denied.length) return out(res, 403, { error: 'control', message: `This device can’t change: ${denied.join(', ')}. Some settings are only available on the computer.` });
        body = patch;
      }
      compressApi(req, res);
      return api(shim(req, JSON.stringify(body)), res, path, { device });
    }
    compressApi(req, res);
    return api(req, res, path, { device });
  }
  // -- the listener ---------------------------------------------------------------------------
  const keyOfConfig = (c) => JSON.stringify([c.enabled, c.bind, c.port, c.tlsCert, c.tlsKey, c.tlsAuto]);
  const dir = () => certDir(certHome);
  let renewTimer = null;
  let addressesSeen = '';
  let renewAt = 0;
  let certNote = null; // what the last automatic issue did, for the settings page

  /** The certificate and key to serve: our own (kept current) or the files you named. Throws with a plain message. */
  function loadTls(cfg) {
    if (cfg.tlsAuto) {
      const made = certs({ dir: dir(), ips: addressesNow() });
      const cert = readFileSync(made.cert);
      return { cert, key: readFileSync(made.key), addresses: made.addresses.join(','), renewal: Date.parse(new X509Certificate(cert).validTo) - 30 * 86_400_000 };
    }
    if (cfg.tlsCert && cfg.tlsKey) return { cert: readFileSync(cfg.tlsCert), key: readFileSync(cfg.tlsKey) };
    return null;
  }
  function recordTls(tls) {
    addressesSeen = tls?.addresses ?? '';
    renewAt = tls?.renewal ?? 0;
    certNote = addressesSeen ? `Serving a certificate for ${addressesSeen}` : null;
  }
  /** While serving our own certificate: when this computer's addresses change, issue a new one and swap it in (no dropped connections). */
  function watchAddresses() {
    clearInterval(renewTimer);
    renewTimer = null;
    if (!config().tlsAuto || !server) return;
    renewTimer = setInterval(() => {
      try {
        const now = addressesNow().join(',');
        if (!now || (now === addressesSeen && Date.now() < renewAt) || !server?.setSecureContext) return;
        const tls = loadTls(config());
        server.setSecureContext(tls);
        recordTls(tls);
        lastError = null;
        log(`remote: certificate renewed for ${addressesSeen}`);
      } catch (err) { lastError = `Couldn’t renew the certificate: ${err.message}`; }
    }, renewMs);
    renewTimer.unref?.();
  }
  const stop = () => new Promise((ok) => {
    const s = server;
    server = null;
    runKey = '';
    clearInterval(renewTimer);
    renewTimer = null;
    hub.close();
    if (!s) return ok();
    s.close(() => ok());
    s.closeAllConnections?.();
  });
  /** Start, stop or move the listener to match the settings. Safe to call whenever they change. */
  let applying = Promise.resolve();
  function apply() {
    const next = applying.then(applyConfig);
    applying = next.catch(() => {});
    return next;
  }
  async function applyConfig() {
    const cfg = config();
    const key = keyOfConfig(cfg);
    if (key === runKey && (server || !cfg.enabled)) return;
    await stop();
    lastError = null;
    if (!cfg.enabled) { remote.cancelPairing(); pusher.stop(); runKey = key; return; }
    let make = createHttp;
    let options = {};
    try {
      const tls = loadTls(cfg);
      if (tls) { options = tls; make = createHttps; }
    } catch (err) { lastError = cfg.tlsAuto ? err.message : `Couldn’t read the certificate: ${err.code ?? err.message}`; return; }
    let s;
    try {
      s = make(options, (req, res) => { handle(req, res).catch((err) => { log(`remote: ${err.message}`); if (!res.headersSent) out(res, 500, { error: 'server error' }); else res.end(); }); });
    } catch (err) { lastError = `Couldn’t start the HTTPS listener: ${err.code ?? 'invalid certificate or key'}`; return; }
    s.keepAliveTimeout = 65_000;
    s.headersTimeout = 20_000;
    s.requestTimeout = 30_000;
    s.maxConnections = 64;
    await new Promise((ok) => {
      s.once('error', (err) => { lastError = err.code === 'EADDRINUSE' ? `Port ${cfg.port} is already in use. Pick another in Settings → Remote.` : err.message; ok(); });
      s.listen(cfg.port, cfg.bind === 'lan' ? '0.0.0.0' : '127.0.0.1', () => { server = s; runKey = key; recordTls(options); watchAddresses(); log(`remote client → ${cfg.bind === 'lan' ? 'network' : 'this computer only'}, port ${cfg.port}`); ok(); });
    });
  }

  // -- the computer's own side: /api/remote/* on the bridge's 127.0.0.1 listener ------------------
  async function controlApi(req, res, path, { json, readBody }) {
    const cfg = config();
    const view = () => ({
      enabled: !!cfg.enabled, running: !!server, error: lastError, port: cfg.port, bind: cfg.bind,
      secure: servesTls(cfg) || /^https:/.test(cfg.publicUrl ?? ''), publicUrl: cfg.publicUrl || '',
      // Where a phone on your network would look: the addresses, the name, and (with our own certificate) the CA to trust.
      lan: cfg.bind === 'lan' ? { addresses: cfg.tlsAuto ? addressesSeen.split(',').filter(Boolean) : lanAddresses(), name: localName(), auto: !!cfg.tlsAuto, caFile: cfg.tlsAuto ? join(dir(), 'ca.pem') : null, caFingerprint: cfg.tlsAuto ? caFingerprint(dir()) : null, note: certNote } : null,
      addresses: cfg.bind === 'lan' ? lanAddresses() : [], devices: remote.devices().map((d) => ({ ...d, open: hub.open(d.id), lastPush: pusher.last(d.id), pushes: pusher.history(d.id) })), waiting: remote.waiting(), pendingPairs: remote.pendingPairs(), claimed: remote.claimed(), streams: hub.size(),
    });
    if (req.method === 'GET' && path === '/api/remote') return json(res, 200, view());
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'bad json' });
    if (path === '/api/remote/pair') {
      if (!server) return json(res, 409, { error: 'The remote client is off. Turn it on first.' });
      const covered = cfg.tlsAuto ? addressesNow().filter((address) => addressesSeen.split(',').includes(address)) : lanAddresses();
      if (!(servesTls(cfg) || (cfg.bind === 'local' && /^https:\/\//.test(cfg.publicUrl ?? '')))) return json(res, 409, { error: 'Configure HTTPS before making a pairing code.' });
      if (cfg.tlsAuto && cfg.bind === 'lan' && !cfg.publicUrl && !covered.length) return json(res, 409, { error: 'Waiting for a certificate for this computer’s current network address. Try again shortly.' });
      const { token, expiresAt, id } = remote.startPairing();
      const url = pairingUrl(cfg, token, covered);
      // The same code by name, for phones whose IP changes or that can resolve .local: shown beside the QR code.
      const byName = cfg.bind === 'lan' && !cfg.publicUrl && localName() ? pairingUrl(cfg, token, lanAddresses(), { name: true }) : null;
      return json(res, 200, { id, code: token, expiresAt, url, byName, secure: /^https:/.test(url), qr: qrRows(url) });
    }
    if (path === '/api/remote/pair/cancel') { remote.cancelPairing(); return json(res, 200, { ok: true }); }
    if (path === '/api/remote/revoke-all') {
      const devices = remote.devices();
      try { remote.revokeAll(); } catch { return json(res, 503, { error: 'Could not save device revocation. Try again.' }); }
      for (const d of devices) { hub.drop(d.id); pusher.forget(d.id); }
      return json(res, 200, view());
    }
    const one = /^\/api\/remote\/devices\/([\w-]{8,32})(?:\/(revoke|test))?$/.exec(path);
    if (!one) return json(res, 404, { error: 'not found' });
    if (one[2] === 'revoke') {
      try { if (!remote.revoke(one[1])) return json(res, 404, view()); }
      catch { return json(res, 503, { error: 'Could not save device revocation. Try again.' }); }
      hub.drop(one[1]);
      pusher.forget(one[1]);
      return json(res, 200, view());
    }
    if (one[2] === 'test') { pusher.test(one[1]).catch(() => {}); return json(res, 200, { ok: true }); }
    const updated = remote.update(one[1], { name: body.name, control: body.control, prefs: body.prefs });
    return updated ? json(res, 200, view()) : json(res, 404, { error: 'no such device' });
  }

  return {
    remote, hub, apply, controlApi, onEvent, state: () => ({ running: !!server, error: lastError, note: certNote, addresses: addressesSeen }), stop: async () => { await applying; pusher.stop(); await stop(); },
  };
}
