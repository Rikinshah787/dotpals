// Your apps, connected to dotpals itself (Settings → Apps): Notion, Linear, Google Calendar, or
// any MCP server of your own. Blu's brain uses them, whatever AI you brought (bridge/brain.js
// askWithTools): not only Claude. dotpals is an MCP client here, as it's an MCP server in
// bridge/mcp.js; no SDK, the same way.
//
//   An app by its address  Streamable HTTP: JSON-RPC posted to its URL, answers as JSON or as
//                          server-sent events, with its session id. You sign in once in your
//                          browser (MCP's sign-in: OAuth 2.1 with PKCE, the app's own sign-in
//                          server found from the app, dotpals registered as a client there,
//                          or your own client id where it can't be, like Google)
//   An app by its command  started on this computer (stdio: JSON-RPC a line at a time),
//                          stopped after 10 minutes unused
//
// Saved in ~/.dotpals/apps.json, readable by you only, tokens included; the pages only ever
// see each app's name, kind and whether it's signed in.
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname } from 'node:path';

const PROTOCOL = '2025-06-18';
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Apps you can add with a click: where their MCP server is, and what to know first. */
export const PRESETS = {
  notion: { name: 'Notion', url: 'https://mcp.notion.com/mcp' },
  linear: { name: 'Linear', url: 'https://mcp.linear.app/mcp' },
  sentry: { name: 'Sentry', url: 'https://mcp.sentry.dev/mcp' },
  'google-calendar': { name: 'Google Calendar', url: 'https://calendarmcp.googleapis.com/mcp/v1', ownClient: true },
};

/** An app's name as a tool prefix and an id: "Google Calendar" → "google-calendar". */
export const slug = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);

/**
 * Read-only, by the app's own word (MCP's readOnlyHint) or, when it doesn't say, by the tool's
 * name, after the app's own prefix (`app`: "notion" for notion-get-comments).
 */
const LOOKS = 'get|list|search|find|read|fetch|query|retrieve|lookup|look_up|describe|show|view|check|count';
export function readOnly(tool, app = '') {
  const a = tool?.annotations ?? {};
  if (typeof a.readOnlyHint === 'boolean') return a.readOnlyHint;
  const n = String(tool?.name ?? '').replace(app ? new RegExp(`^${app.replace(/[^\w-]/g, '')}[-_]`, 'i') : /^$/, '');
  return new RegExp(`^(${LOOKS})([_-]|$)`, 'i').test(n) || new RegExp(`^(${LOOKS})[A-Z]`).test(n); // list_events, searchPages; not "getaway"
}
/** A command as its words: "npx -y \"my server\"" → ['npx', '-y', 'my server']. */
export const words = (command) => (String(command).match(/"[^"]*"|\S+/g) ?? []).map((w) => w.replace(/^"|"$/g, ''));
/**
 * Never, even when you said yes to a change: sending, deleting, paying (Blu drafts instead), and
 * what reaches other people (a comment, sharing, an invite). An app's own "destructive" mark too.
 */
export function never(tool, app = '') {
  const n = String(tool?.name ?? '');
  return tool?.annotations?.destructiveHint === true || /(send|delete|remove|destroy|trash|purge|pay|purchase|transfer|refund|post_message|publish)/i.test(n)
    || (/comment|reaction|(^|[_-])(share|invite)([_-]|$)/i.test(n) && !readOnly(tool, app));
}

/** Server-sent events → their JSON messages. */
export function sseMessages(text) {
  const out = [];
  for (const block of String(text).replace(/\r\n/g, '\n').split('\n\n')) {
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    try { out.push(JSON.parse(data)); } catch {}
  }
  return out;
}

/** A tool's answer as text for the brain: its text parts, and what else there was. */
export function resultText(result) {
  const parts = (result?.content ?? []).map((c) => (c?.type === 'text' ? c.text : c?.type === 'resource' ? c.resource?.text ?? `[${c.resource?.uri ?? 'resource'}]` : `[${c?.type ?? 'item'}]`));
  if (!parts.length && result?.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  return `${result?.isError ? 'Error: ' : ''}${parts.join('\n')}`.slice(0, 12_000);
}

/**
 * `file`: where the apps are saved. `redirect`: the sign-in's way back here
 * (http://127.0.0.1:<port>/api/apps/callback). For tests: `fetchFn`, `spawn`.
 */
export function createConnectors({ file, redirect, fetchFn = fetch, spawn = nodeSpawn, log = () => {}, timeoutMs = 30_000 }) {
  const load = () => { try { const a = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } };
  let apps = load();
  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(apps, null, 2)}\n`, { mode: 0o600 });
    if (platform() !== 'win32') { try { chmodSync(file, 0o600); } catch {} }
  };
  const live = new Map();    // id → { session, version, tools, toolsAt } (HTTP) or { proc, … } (stdio)
  const pending = new Map(); // sign-in state → { id, verifier, at }
  const find = (id) => apps.find((a) => a.id === id) ?? null;
  /** An app's live state (its session, its process, its tools), kept in one object per app. */
  const state = (id) => { if (!live.has(id)) live.set(id, {}); return live.get(id); };

  /** What a page may see: no tokens, no secrets. */
  const view = (a) => ({ id: a.id, name: a.name, kind: a.kind, ...(a.url ? { url: a.url } : { command: a.command }), status: a.kind === 'stdio' || a.auth?.tokens || a.open ? 'connected' : 'sign-in', ...(a.error ? { error: a.error } : {}), ...(a.tools ? { tools: a.tools } : {}), ownClient: !!a.ownClient, hasClient: !!a.auth?.clientId });

  function add({ name, url, command, clientId, clientSecret }) {
    const n = String(name ?? '').trim().slice(0, 40);
    const id = slug(n);
    if (!id) throw new Error('Give the app a name');
    if (find(id)) throw new Error(`There’s already an app called ${n}`);
    let app;
    if (url) {
      let u = null;
      try { u = new URL(String(url).trim()); } catch {}
      if (!u || !(u.protocol === 'https:' || (u.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(u.hostname)))) throw new Error('The app’s address starts with https://');
      app = { id, name: n, kind: 'http', url: u.href };
      const preset = Object.values(PRESETS).find((p) => p.url === u.href);
      if (preset?.ownClient) app.ownClient = true;
    } else if (command && !/[\r\n]/.test(command)) app = { id, name: n, kind: 'stdio', command: String(command).trim() };
    else throw new Error('Give the app’s address (https://…) or the command that starts it');
    if (clientId) app.auth = { clientId: String(clientId).trim(), ...(clientSecret ? { clientSecret: String(clientSecret).trim() } : {}) };
    apps.push(app);
    save();
    return view(app);
  }
  function remove(id) {
    const a = find(id);
    if (!a) throw new Error('dotpals has no app by that name');
    stopLive(id);
    apps = apps.filter((x) => x !== a);
    save();
  }
  function stopLive(id) {
    const l = live.get(id);
    clearTimeout(l?.idle);
    if (l?.proc) { try { l.proc.kill(); } catch {} }
    live.delete(id);
  }

  // -- talking to an app over HTTP -------------------------------------------------------------
  let rpcId = 1;
  async function httpRpc(app, method, params, { notify = false } = {}) {
    const l = state(app.id);
    const token = await accessToken(app);
    const body = notify ? { jsonrpc: '2.0', method, ...(params ? { params } : {}) } : { jsonrpc: '2.0', id: rpcId++, method, ...(params ? { params } : {}) };
    const r = await fetchFn(app.url, {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs), body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(l.session ? { 'mcp-session-id': l.session } : {}), ...(l.version ? { 'mcp-protocol-version': l.version } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    if (r.status === 401) {
      // Not signed in, or the token ran out and couldn't be renewed: sign in again.
      app.authHeader = r.headers.get('www-authenticate') ?? '';
      if (app.auth?.tokens) { delete app.auth.tokens; save(); }
      throw Object.assign(new Error(`Sign in to ${app.name} first (Settings → Apps)`), { signIn: true });
    }
    if (r.status === 404 && l.session) { live.delete(app.id); throw Object.assign(new Error('the app forgot this session'), { again: true }); }
    if (notify) return null;
    if (!r.ok) throw new Error(`${app.name} answered ${r.status}`);
    const session = r.headers.get('mcp-session-id');
    if (session) l.session = session;
    const type = r.headers.get('content-type') ?? '';
    const text = await r.text();
    const messages = type.includes('text/event-stream') ? sseMessages(text) : (() => { try { return [].concat(JSON.parse(text)); } catch { return []; } })();
    const reply = messages.find((m) => m?.id === body.id);
    if (!reply) throw new Error(`${app.name} gave no answer`);
    if (reply.error) throw new Error(`${app.name}: ${String(reply.error.message ?? 'error').slice(0, 200)}`);
    return reply.result;
  }

  // -- talking to an app started here (stdio) ---------------------------------------------------
  function stdioProc(app) {
    const l = state(app.id);
    if (l.proc && l.proc.exitCode === null && !l.proc.killed) { clearTimeout(l.idle); l.idle = setTimeout(() => stopLive(app.id), 600_000); return l; }
    // Your own command, as you'd type it: through the system's shell (npx is npx.cmd on Windows),
    // passed to cmd exactly as written, the way Node's own `shell` option does it.
    const proc = process.platform === 'win32' ? spawn('cmd.exe', ['/d', '/s', '/c', `"${app.command}"`], { windowsHide: true, windowsVerbatimArguments: true }) : spawn('/bin/sh', ['-c', app.command]);
    const entry = Object.assign(l, { proc, waiting: new Map(), buf: '', ready: false });
    proc.stdout.on('data', (d) => {
      const lines = (entry.buf + d).split('\n');
      entry.buf = lines.pop();
      for (const line of lines) {
        let m; try { m = JSON.parse(line); } catch { continue; }
        const w = entry.waiting.get(m?.id);
        if (w) { entry.waiting.delete(m.id); m.error ? w.fail(new Error(`${app.name}: ${String(m.error.message ?? 'error').slice(0, 200)}`)) : w.ok(m.result); }
      }
    });
    proc.stderr.on('data', (d) => log(`app ${app.name}: ${String(d).trim().slice(0, 200)}`));
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => { for (const w of entry.waiting.values()) w.fail(err); entry.waiting.clear(); });
    proc.on('exit', (code) => { for (const w of entry.waiting.values()) w.fail(new Error(`${app.name} stopped (${code})`)); entry.waiting.clear(); if (entry.proc === proc) Object.assign(entry, { proc: null, ready: false }); });
    entry.idle = setTimeout(() => stopLive(app.id), 600_000);
    return entry;
  }
  function stdioRpc(app, method, params, { notify = false } = {}) {
    const entry = stdioProc(app);
    if (notify) { entry.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`); return Promise.resolve(null); }
    const id = rpcId++;
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => { entry.waiting.delete(id); fail(new Error(`${app.name} took too long`)); }, timeoutMs);
      entry.waiting.set(id, { ok: (v) => { clearTimeout(timer); ok(v); }, fail: (e) => { clearTimeout(timer); fail(e); } });
      entry.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
    });
  }

  /** A JSON-RPC call to an app, after the MCP handshake (once per session). */
  async function rpc(app, method, params) {
    const send = app.kind === 'stdio' ? stdioRpc : httpRpc;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (!live.get(app.id)?.ready) {
          const init = await send(app, 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'dotpals', version: '1' } });
          Object.assign(state(app.id), { version: init?.protocolVersion ?? PROTOCOL, ready: true });
          await send(app, 'notifications/initialized', null, { notify: true });
        }
        return await send(app, method, params);
      } catch (err) {
        if (!err.again) throw err;
      }
    }
    throw new Error(`${app.name} kept forgetting the session`);
  }

  /** The app's tools ([{ name, description, inputSchema, annotations }]), looked up again after 5 minutes. */
  async function tools(id) {
    const app = find(id);
    if (!app) throw new Error('dotpals has no app by that name');
    const l = live.get(id);
    if (l?.tools && Date.now() - l.toolsAt < 300_000) return l.tools;
    try {
      const list = [];
      let cursor;
      for (let page = 0; page < 10; page++) {
        const r = await rpc(app, 'tools/list', cursor ? { cursor } : {});
        list.push(...(r?.tools ?? []));
        cursor = r?.nextCursor;
        if (!cursor) break;
      }
      Object.assign(state(id), { tools: list, toolsAt: Date.now() });
      if (app.error || app.tools !== list.length) { delete app.error; app.tools = list.length; app.open = app.open || (app.kind === 'http' && !app.auth?.tokens); save(); }
      return list;
    } catch (err) {
      if (!err.signIn) { app.error = err.message.slice(0, 200); save(); }
      throw err;
    }
  }
  /** Call one of the app's tools → its answer, as text. */
  async function call(id, name, args) {
    const app = find(id);
    if (!app) throw new Error('dotpals has no app by that name');
    return resultText(await rpc(app, 'tools/call', { name, arguments: args ?? {} }));
  }

  // -- signing in (MCP authorization: OAuth 2.1, PKCE) -------------------------------------------
  const getJson = async (url) => {
    try { const r = await fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) }); return r.ok ? await r.json() : null; } catch { return null; }
  };
  /** Where the app's sign-in is: its protected-resource metadata, then its sign-in server's. */
  async function signInServer(app) {
    const u = new URL(app.url);
    const fromHeader = /resource_metadata="([^"]+)"/.exec(app.authHeader ?? '')?.[1];
    const path = u.pathname.replace(/\/+$/, '');
    let resource = `${u.origin}${path}`, issuer = null, scopes = null;
    for (const t of [fromHeader, `${u.origin}/.well-known/oauth-protected-resource${path}`, `${u.origin}/.well-known/oauth-protected-resource`].filter(Boolean)) {
      const prm = await getJson(t);
      if (prm?.authorization_servers?.length) { issuer = prm.authorization_servers[0]; resource = prm.resource ?? resource; scopes = prm.scopes_supported ?? null; break; }
    }
    issuer ??= u.origin; // older servers: the sign-in is on the app's own host
    const iu = new URL(issuer);
    const ip = iu.pathname.replace(/\/+$/, '');
    let meta = null;
    for (const t of [`${iu.origin}/.well-known/oauth-authorization-server${ip}`, `${iu.origin}/.well-known/openid-configuration${ip}`, ...(ip ? [`${iu.origin}${ip}/.well-known/openid-configuration`] : [])]) {
      meta = await getJson(t);
      if (meta?.authorization_endpoint && meta?.token_endpoint) break;
      meta = null;
    }
    meta ??= { authorization_endpoint: `${iu.origin}/authorize`, token_endpoint: `${iu.origin}/token`, registration_endpoint: `${iu.origin}/register` };
    return { meta, resource, scopes };
  }
  /** The link to sign in to an app in your browser; it comes back to finish(). */
  async function signIn(id) {
    const app = find(id);
    if (!app || app.kind !== 'http') throw new Error('Only an app with an address signs in');
    const { meta, resource, scopes } = await signInServer(app);
    app.auth = { ...app.auth, meta: { authorization_endpoint: meta.authorization_endpoint, token_endpoint: meta.token_endpoint }, resource, ...(scopes ? { scopes } : {}) };
    // dotpals registers itself with the app's sign-in server, unless you gave your own client (Google).
    if (!app.auth.clientId || (app.auth.registered && app.auth.redirect !== redirect)) {
      if (app.ownClient || !meta.registration_endpoint) throw Object.assign(new Error(`${app.name} needs your own client id: add it again with one (Settings → Apps)`), { ownClient: true });
      const r = await fetchFn(meta.registration_endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ client_name: 'dotpals', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
      });
      const reg = await r.json().catch(() => ({}));
      if (!r.ok || !reg.client_id) throw new Error(`${app.name} didn’t let dotpals register (${String(reg.error_description ?? reg.error ?? r.status).slice(0, 120)})`);
      Object.assign(app.auth, { clientId: reg.client_id, ...(reg.client_secret ? { clientSecret: reg.client_secret } : {}), registered: true, redirect });
    }
    app.auth.redirect = redirect;
    save();
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(16));
    pending.set(state, { id, verifier, at: Date.now() });
    for (const [s, p] of pending) if (Date.now() - p.at > 15 * 60_000) pending.delete(s);
    const q = new URLSearchParams({ response_type: 'code', client_id: app.auth.clientId, redirect_uri: redirect, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state, resource });
    if (app.auth.scopes?.length) q.set('scope', app.auth.scopes.join(' '));
    if (app.ownClient) { q.set('access_type', 'offline'); q.set('prompt', 'consent'); } // Google: a refresh token too
    return { url: `${meta.authorization_endpoint}${meta.authorization_endpoint.includes('?') ? '&' : '?'}${q}` };
  }
  async function tokenRequest(app, params) {
    const body = new URLSearchParams({ ...params, client_id: app.auth.clientId, ...(app.auth.clientSecret ? { client_secret: app.auth.clientSecret } : {}), ...(app.auth.resource ? { resource: app.auth.resource } : {}) });
    const r = await fetchFn(app.auth.meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: String(body), signal: AbortSignal.timeout(15_000) });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.access_token) throw new Error(`${app.name}: ${String(t.error_description ?? t.error ?? `sign-in failed (${r.status})`).slice(0, 160)}`);
    app.auth.tokens = { access_token: t.access_token, ...(t.refresh_token || app.auth.tokens?.refresh_token ? { refresh_token: t.refresh_token ?? app.auth.tokens.refresh_token } : {}), ...(t.expires_in ? { expires_at: Date.now() + Number(t.expires_in) * 1000 } : {}) };
    delete app.error;
    save();
  }
  /** Back from the browser: the code for a token. → the app's view. */
  async function finish({ state, code, error }) {
    const p = pending.get(String(state ?? ''));
    if (!p) throw new Error('That sign-in has expired: start it again from Settings → Apps');
    pending.delete(state);
    const app = find(p.id);
    if (!app) throw new Error('That app was removed');
    if (error) throw new Error(`${app.name} said: ${String(error).slice(0, 120)}`);
    await tokenRequest(app, { grant_type: 'authorization_code', code: String(code ?? ''), redirect_uri: redirect, code_verifier: p.verifier });
    live.delete(app.id);
    return view(app);
  }
  /** A token that still works, renewed when it's about to run out; null when there's none. */
  async function accessToken(app) {
    const t = app.auth?.tokens;
    if (!t?.access_token) return null;
    if (t.expires_at && t.expires_at - Date.now() < 60_000 && t.refresh_token && app.auth.meta?.token_endpoint) {
      try { await tokenRequest(app, { grant_type: 'refresh_token', refresh_token: t.refresh_token }); } catch (err) { log(`app ${app.name}: renewing the sign-in failed: ${err.message}`); return null; }
    }
    return app.auth.tokens?.access_token ?? null;
  }

  /** For Claude Code, the app as its --mcp-config entry (with a working token). */
  async function claudeEntry(id) {
    const app = find(id);
    if (!app) throw new Error('dotpals has no app by that name');
    if (app.kind === 'stdio') { const [command, ...args] = words(app.command); return process.platform === 'win32' ? { command: 'cmd', args: ['/c', command, ...args] } : { command, args }; }
    const token = await accessToken(app);
    return { type: 'http', url: app.url, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) };
  }

  return {
    list: () => apps.map(view), get: (id) => (find(id) ? view(find(id)) : null), add, remove, tools, call, signIn, finish, claudeEntry,
    close: () => { for (const id of [...live.keys()]) stopLive(id); },
  };
}
