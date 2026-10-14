// Blu's safety checks: signing in to your apps, reading what they answer, which tools Blu may use,
// your "yes" to a change, and what reaches the system's own commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bounded, createConnectors, never, readOnly } from '../bridge/connectors.js';
import { saidYesTo } from '../bridge/buddy.js';
import { createHands, ps } from '../desktop/hands.js';

const REDIRECT = 'http://127.0.0.1:5175/api/apps/callback';

/** A pretend app on this computer; `route(path, body, base)` → [status, data] or null (404). */
async function appServer(route) {
  const server = createServer(async (req, res) => {
    const body = await new Promise((ok) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => ok(b)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const out = await route(new URL(req.url, base).pathname, body, base, res);
    if (out === 'handled') return;
    if (!out) return res.writeHead(404).end();
    res.writeHead(out[0], { 'content-type': 'application/json' }).end(JSON.stringify(out[1]));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((ok) => { server.closeAllConnections(); server.close(ok); }) };
}
const tempDir = async (t) => { const dir = await mkdtemp(join(tmpdir(), 'dotpals-sec-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };

test('signing in: a sign-in address that isn’t https is never handed to your browser; the app’s own host is used instead', async (t) => {
  const app = await appServer((path, body, base) => {
    if (path === '/.well-known/oauth-protected-resource/mcp') return [200, { resource: `${base}/mcp`, authorization_servers: [`${base}/auth`] }];
    if (path === '/.well-known/oauth-authorization-server/auth') return [200, { authorization_endpoint: 'ftp://elsewhere.example/authorize', token_endpoint: 'http://elsewhere.example/token', registration_endpoint: 'http://elsewhere.example/register' }];
    if (path === '/register') return [201, { client_id: 'c1' }];
    return null;
  });
  t.after(app.close);
  const c = createConnectors({ file: join(await tempDir(t), 'apps.json'), redirect: REDIRECT });
  c.add({ name: 'Cal', url: `${app.base}/mcp` });
  const { url } = await c.signIn('cal');
  assert.equal(new URL(url).origin, app.base);
  assert.equal(new URL(url).pathname, '/authorize');
  c.close();
});

test('signing in: metadata that says it’s about another app is ignored', async (t) => {
  const asked = [];
  const app = await appServer((path, body, base) => {
    asked.push(path);
    if (path === '/.well-known/oauth-protected-resource/mcp') return [200, { resource: 'https://other-app.example/mcp', authorization_servers: ['https://other-app.example/auth'] }];
    if (path === '/.well-known/oauth-authorization-server') return [200, { authorization_endpoint: `${base}/signin`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` }];
    if (path === '/register') return [201, { client_id: 'c1' }];
    return null;
  });
  t.after(app.close);
  const c = createConnectors({ file: join(await tempDir(t), 'apps.json'), redirect: REDIRECT });
  c.add({ name: 'Cal', url: `${app.base}/mcp` });
  const auth = new URL((await c.signIn('cal')).url);
  assert.equal(`${auth.origin}${auth.pathname}`, `${app.base}/signin`);
  assert.equal(auth.searchParams.get('resource'), `${app.base}/mcp`);
  c.close();
});

test('signing in: a sign-in older than 15 minutes is refused, and each one works only once', async (t) => {
  const app = await appServer((path, body, base) => {
    if (path === '/.well-known/oauth-authorization-server') return [200, { authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` }];
    if (path === '/register') return [201, { client_id: 'c1' }];
    if (path === '/token') return [200, { access_token: 'token-1' }];
    return null;
  });
  t.after(app.close);
  const c = createConnectors({ file: join(await tempDir(t), 'apps.json'), redirect: REDIRECT });
  c.add({ name: 'Cal', url: `${app.base}/mcp` });
  const old = new URL((await c.signIn('cal')).url).searchParams.get('state');
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 16 * 60_000);
  await assert.rejects(c.finish({ state: old, code: 'x' }), /expired/);
  t.mock.restoreAll();
  const fresh = new URL((await c.signIn('cal')).url).searchParams.get('state');
  assert.equal((await c.finish({ state: fresh, code: 'x' })).status, 'connected');
  await assert.rejects(c.finish({ state: fresh, code: 'x' }), /expired/);
  c.close();
});

test('signing in: a token about to run out is renewed once, however many calls need it at the same time', async (t) => {
  let renewals = 0;
  const app = await appServer(async (path, body, base) => {
    if (path === '/.well-known/oauth-authorization-server') return [200, { authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` }];
    if (path === '/register') return [201, { client_id: 'c1' }];
    if (path === '/token') {
      const f = new URLSearchParams(body);
      if (f.get('grant_type') === 'authorization_code') return [200, { access_token: 'token-1', refresh_token: 'refresh-1', expires_in: 10 }];
      renewals++;
      await new Promise((r) => setTimeout(r, 50));
      return f.get('refresh_token') === 'refresh-1' ? [200, { access_token: 'token-2', refresh_token: 'refresh-2', expires_in: 3600 }] : [400, { error: 'invalid_grant' }];
    }
    if (path === '/mcp') {
      const m = JSON.parse(body);
      if (!m.id) return [202, {}];
      return [200, { jsonrpc: '2.0', id: m.id, result: m.method === 'initialize' ? { protocolVersion: '2025-06-18' } : m.method === 'tools/list' ? { tools: [] } : { content: [{ type: 'text', text: 'ok' }] } }];
    }
    return null;
  });
  t.after(app.close);
  const c = createConnectors({ file: join(await tempDir(t), 'apps.json'), redirect: REDIRECT });
  c.add({ name: 'Cal', url: `${app.base}/mcp` });
  const state = new URL((await c.signIn('cal')).url).searchParams.get('state');
  await c.finish({ state, code: 'x' });
  const answers = await Promise.all([c.call('cal', 'list_events', {}), c.call('cal', 'list_events', {}), c.tools('cal')]);
  assert.equal(renewals, 1);
  assert.deepEqual(answers.slice(0, 2), ['ok', 'ok']);
  c.close();
});

test('an app’s answer: events left open after the answer don’t keep Blu waiting; too much is refused', async (t) => {
  const app = await appServer((path, body, base, res) => {
    const m = JSON.parse(body || '{}');
    if (!m.id) return [202, {}];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { content: [{ type: 'text', text: 'Lunch with Sam at 1' }] } })}\n\n`);
    return 'handled'; // the stream stays open
  });
  t.after(app.close);
  const c = createConnectors({ file: join(await tempDir(t), 'apps.json'), redirect: REDIRECT, timeoutMs: 5000 });
  c.add({ name: 'Cal', url: `${app.base}/mcp` });
  const started = Date.now();
  assert.equal(await c.call('cal', 'list_events', {}), 'Lunch with Sam at 1');
  assert.ok(Date.now() - started < 3000);
  c.close();
  await assert.rejects(bounded(new Response('x'.repeat(100)), null, 50), /too much/);
  assert.equal(await bounded(new Response('fine')), 'fine');
});

test('which tools: a look that also writes isn’t a look; a reply or a forward is never sent, a draft is fine', () => {
  assert.equal(readOnly({ name: 'get_or_create_page' }), false);
  assert.equal(readOnly({ name: 'findAndReplace' }), false);
  assert.equal(readOnly({ name: 'get_post' }), true);
  assert.equal(readOnly({ name: 'list_run_logs' }), true);
  assert.equal(never({ name: 'reply' }), true);
  assert.equal(never({ name: 'forward_message' }), true);
  assert.equal(never({ name: 'chat_postMessage' }), true);
  assert.equal(never({ name: 'sharePage' }), true);
  assert.equal(never({ name: 'create_reply_draft' }), false);
  assert.equal(never({ name: 'list_reply_templates' }), false);
});

test('your yes: only your own plain yes, right after Blu asked about that change in that app', () => {
  const asked = 'Add lunch with Sam at 1 to your calendar?';
  const change = { app: 'Google Calendar', ask: 'add lunch with Sam at 1', change: true };
  assert.equal(saidYesTo('Yes, go ahead', asked, change), true);
  assert.equal(saidYesTo('Hey Blu, sure', asked, change), true);
  assert.equal(saidYesTo('yes, call it Team lunch', asked, { ...change, ask: 'add Team lunch with Sam at 1' }), true);
  // Not a plain yes, or no question just before, or a look.
  assert.equal(saidYesTo('okay, no, don’t', asked, change), false);
  assert.equal(saidYesTo('yesterday I had lunch', asked, change), false);
  assert.equal(saidYesTo('yes', 'Lunch is at 1.', change), false);
  assert.equal(saidYesTo('yes', asked, { ...change, change: false }), false);
  // A yes to some other question, or another app, or a different change: the Yes/No card asks.
  assert.equal(saidYesTo('sure', 'Want me to explain it?', change), false);
  assert.equal(saidYesTo('yes', asked, { ...change, app: 'Notion' }), false);
  assert.equal(saidYesTo('yes', asked, { ...change, ask: 'create an event every day this year with everyone in the company as guests' }), false);
});

test('hands: strings for PowerShell stay one string, curly quotes too', () => {
  assert.equal(ps('it\'s'), "'it''s'");
  assert.equal(ps('it’s'), "'it’’s'");
  assert.equal(ps('a\nb'), "'a b'");
});

test('hands: a song’s link must be whole; a page’s address goes to the browser as one piece', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const opened = [], started = [];
  const hands = createHands({ shell: { openExternal: async (u) => opened.push(u) }, screen: {}, typeOut: async () => ({ ok: true }), platform: 'linux', start: (file, args) => started.push([file, ...args]) });
  const run = async (actions) => {
    let done = false;
    const receipts = hands.run(actions, { allow: { hands: true, click: false } }).finally(() => { done = true; });
    while (!done) { await new Promise((r) => setImmediate(r)); t.mock.timers.tick(1200); }
    return receipts;
  };
  const r = await run([
    { act: 'play', url: 'spotify:track:5ChkMS8OtdzJeqyybCc9R5' },
    { act: 'play', url: 'spotify:search:a" b' },
    { act: 'play', url: 'https://www.youtube.com/watch?v=aBcDeFgHiJk extra words' },
  ]);
  assert.deepEqual(r.map((x) => x.ok), [true, false, true]);
  assert.deepEqual(opened, ['spotify:track:5ChkMS8OtdzJeqyybCc9R5', 'https://www.youtube.com/watch?v=aBcDeFgHiJk%20extra%20words']);
  await run([{ act: 'url', url: 'https://example.com/a b', browser: 'chrome' }]);
  assert.deepEqual(started, [['google-chrome', 'https://example.com/a%20b']]);
});

test('hands on a Mac: mute is only ever true or false in the script', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const hands = createHands({ platform: 'darwin', screen: {}, shell: {}, typeOut: async () => ({ ok: true }), trusted: async () => true, exec: async (file, args) => { calls.push(args.at(-1)); return '40'; } });
  await hands.run([{ act: 'volume', mute: 'yes please' }], { allow: { hands: true } });
  assert.ok(calls.includes('set volume output muted false'));
});
