import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnectors, never, readOnly, resultText, slug, sseMessages } from '../bridge/connectors.js';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * A pretend app on this computer: an MCP server (Streamable HTTP, answers as server-sent
 * events) behind MCP's sign-in, with its own sign-in server (metadata, registration, PKCE).
 */
async function fakeApp() {
  const seen = { registered: [], tokens: [], calls: [], sessions: new Set() };
  let code = null, challenge = null, expiresIn = 3600, issued = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await new Promise((ok) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => ok(b)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const json = (status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: `${base}/mcp`, authorization_servers: [`${base}/auth`], scopes_supported: ['read', 'write'] });
    if (url.pathname === '/.well-known/oauth-authorization-server/auth') return json(200, { issuer: `${base}/auth`, authorization_endpoint: `${base}/auth/authorize`, token_endpoint: `${base}/auth/token`, registration_endpoint: `${base}/auth/register` });
    if (url.pathname === '/auth/register') { const r = JSON.parse(body); seen.registered.push(r); return json(201, { client_id: 'dotpals-client', redirect_uris: r.redirect_uris }); }
    if (url.pathname === '/auth/token') {
      const f = new URLSearchParams(body);
      seen.tokens.push(Object.fromEntries(f));
      if (f.get('grant_type') === 'authorization_code') {
        if (f.get('code') !== code || b64url(createHash('sha256').update(f.get('code_verifier')).digest()) !== challenge) return json(400, { error: 'invalid_grant' });
      } else if (f.get('refresh_token') !== 'refresh-1') return json(400, { error: 'invalid_grant' });
      issued++;
      const lasts = expiresIn;
      expiresIn = 3600; // only the first one runs out soon
      return json(200, { access_token: `token-${issued}`, refresh_token: 'refresh-1', expires_in: lasts });
    }
    if (url.pathname === '/mcp') {
      if (!/^Bearer token-\d+$/.test(req.headers.authorization ?? '')) return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
      const m = JSON.parse(body);
      if (!m.id) { res.writeHead(202).end(); return; } // a notification
      let result;
      if (m.method === 'initialize') { result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } }; res.setHeader('mcp-session-id', 'session-1'); }
      else {
        if (req.headers['mcp-session-id'] !== 'session-1') return json(400, { error: 'no session' });
        seen.sessions.add(req.headers['mcp-protocol-version']);
        if (m.method === 'tools/list') result = { tools: [{ name: 'list_events', description: 'Events', inputSchema: { type: 'object', properties: { day: { type: 'string' } } }, annotations: { readOnlyHint: true } }, { name: 'create_event', inputSchema: { type: 'object' } }] };
        if (m.method === 'tools/call') { seen.calls.push(m.params); result = { content: [{ type: 'text', text: `Lunch with Sam at 1 (${m.params.arguments.day})` }] }; }
      }
      // As server-sent events, with a notification first, the way some apps answer.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n\n`);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, seen, close: () => new Promise((ok) => { server.closeAllConnections(); server.close(ok); }),
    /** You signing in in your browser: the sign-in server sends you back with a code. */
    approve: (authUrl) => { const u = new URL(authUrl); challenge = u.searchParams.get('code_challenge'); code = 'code-1'; return { state: u.searchParams.get('state'), code }; },
    expireSoon: () => { expiresIn = 10; },
  };
}

test('connectors: an app with an address signs in (MCP sign-in, PKCE), then its tools are listed and called', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-apps-'));
  const app = await fakeApp();
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const file = join(dir, 'apps.json');
  const c = createConnectors({ file, redirect: 'http://127.0.0.1:5175/api/apps/callback' });
  const added = c.add({ name: 'My Calendar', url: `${app.base}/mcp` });
  assert.deepEqual([added.id, added.kind, added.status], ['my-calendar', 'http', 'sign-in']);
  // Not signed in: the app says 401, and Blu is told to sign in first.
  await assert.rejects(c.tools('my-calendar'), /Sign in to My Calendar first/);
  const { url } = await c.signIn('my-calendar');
  const auth = new URL(url);
  assert.equal(`${auth.origin}${auth.pathname}`, `${app.base}/auth/authorize`);
  assert.deepEqual([auth.searchParams.get('client_id'), auth.searchParams.get('code_challenge_method'), auth.searchParams.get('resource'), auth.searchParams.get('scope'), auth.searchParams.get('redirect_uri')],
    ['dotpals-client', 'S256', `${app.base}/mcp`, 'read write', 'http://127.0.0.1:5175/api/apps/callback']);
  assert.deepEqual(app.seen.registered[0].redirect_uris, ['http://127.0.0.1:5175/api/apps/callback']);
  // Back from the browser: a stale or made-up state is refused; the real one gets the token.
  await assert.rejects(c.finish({ state: 'made-up', code: 'x' }), /expired/);
  const back = await c.finish(app.approve(url));
  assert.equal(back.status, 'connected');
  const tools = await c.tools('my-calendar');
  assert.deepEqual(tools.map((x) => x.name), ['list_events', 'create_event']);
  assert.equal(await c.call('my-calendar', 'list_events', { day: 'today' }), 'Lunch with Sam at 1 (today)');
  assert.deepEqual([...app.seen.sessions], ['2025-06-18']); // the session and its version on every call
  // The pages never see a token; the file is yours only (where the system can say so).
  assert.equal(JSON.stringify(c.list()).includes('token-'), false);
  assert.equal(c.list()[0].tools, 2);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.match(await readFile(file, 'utf8'), /"access_token": "token-1"/);
  // Read again after a restart.
  const again = createConnectors({ file, redirect: 'http://127.0.0.1:5175/api/apps/callback' });
  assert.equal(again.list()[0].status, 'connected');
  again.close(); c.close();
});

test('connectors: a token about to run out is renewed with its refresh token', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-apps-'));
  const app = await fakeApp();
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const c = createConnectors({ file: join(dir, 'apps.json'), redirect: 'http://127.0.0.1:5175/api/apps/callback' });
  c.add({ name: 'Cal', url: `${app.base}/mcp` });
  app.expireSoon(); // the first token lasts 10 s: under the minute dotpals keeps in hand
  const { url } = await c.signIn('cal');
  await c.finish(app.approve(url));
  await c.tools('cal');
  assert.deepEqual(app.seen.tokens.map((x) => x.grant_type), ['authorization_code', 'refresh_token']);
  c.close();
});

test('connectors: names, addresses and commands are checked; an app like Google needs your own client', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-apps-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const c = createConnectors({ file: join(dir, 'apps.json'), redirect: 'http://127.0.0.1:5175/api/apps/callback', fetchFn: async () => ({ ok: false, json: async () => ({}) }) });
  assert.throws(() => c.add({ name: '', url: 'https://x.dev/mcp' }), /name/);
  assert.throws(() => c.add({ name: 'plain', url: 'http://example.com/mcp' }), /https/);
  assert.throws(() => c.add({ name: 'nothing' }), /address .* or the command/);
  c.add({ name: 'Google Calendar', url: 'https://calendarmcp.googleapis.com/mcp/v1' });
  assert.throws(() => c.add({ name: 'google calendar', url: 'https://x.dev/mcp' }), /already an app/);
  assert.equal(c.get('google-calendar').ownClient, true);
  // No registration where its sign-in is (fetches fail here): your own client id is needed.
  await assert.rejects(c.signIn('google-calendar'), /needs your own client id/);
  c.remove('google-calendar');
  const own = c.add({ name: 'Google Calendar', url: 'https://calendarmcp.googleapis.com/mcp/v1', clientId: 'mine.apps.googleusercontent.com', clientSecret: 'shh' });
  assert.deepEqual([own.hasClient, JSON.stringify(c.list()).includes('shh')], [true, false]);
  const { url } = await c.signIn('google-calendar');
  const q = new URL(url).searchParams;
  assert.deepEqual([q.get('client_id'), q.get('access_type'), q.get('prompt')], ['mine.apps.googleusercontent.com', 'offline', 'consent']);
  assert.equal(slug('Google Calendar!'), 'google-calendar');
  c.close();
});

test('connectors: an app started by its command speaks MCP a line at a time', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-apps-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, 'server.mjs');
  await writeFile(script, `import { createInterface } from 'node:readline';
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (!m.id) return;
  if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {} } });
  else if (m.method === 'tools/list') out({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'search_notes', inputSchema: { type: 'object' } }] } });
  else if (m.method === 'tools/call') out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'found: ' + m.params.arguments.q }] } });
});`);
  const c = createConnectors({ file: join(dir, 'apps.json'), redirect: 'http://127.0.0.1:5175/api/apps/callback' });
  c.add({ name: 'Notes', command: `"${process.execPath}" "${script}"` });
  assert.equal(c.list()[0].status, 'connected'); // nothing to sign in to
  assert.deepEqual((await c.tools('notes')).map((x) => x.name), ['search_notes']);
  assert.equal(await c.call('notes', 'search_notes', { q: 'lunch' }), 'found: lunch');
  c.close();
});

test('which tools Blu may use: a look only reads; a change never sends, deletes or pays', () => {
  assert.equal(readOnly({ name: 'create_event', annotations: { readOnlyHint: true } }), true); // the app's own word wins
  assert.equal(readOnly({ name: 'list_events' }), true);
  assert.equal(readOnly({ name: 'searchPages' }), true);
  assert.equal(readOnly({ name: 'create_event' }), false);
  assert.equal(readOnly({ name: 'getaway' }), false);
  assert.equal(never({ name: 'send_email' }), true);
  assert.equal(never({ name: 'delete_event' }), true);
  assert.equal(never({ name: 'update_page', annotations: { destructiveHint: true } }), true);
  assert.equal(never({ name: 'create_draft' }), false);
  // What reaches other people: a comment, sharing, an invite; reading them is fine.
  assert.equal(never({ name: 'notion-create-comment' }), true);
  assert.equal(never({ name: 'share_page' }), true);
  assert.equal(never({ name: 'invite-user' }), true);
  assert.equal(never({ name: 'notion-get-comments' }, 'notion'), false);
  assert.equal(readOnly({ name: 'notion-search' }, 'notion'), true);
  assert.equal(readOnly({ name: 'notion-create-pages' }, 'notion'), false);
  assert.equal(never({ name: 'notion-list-shared-pages' }), false);
  assert.deepEqual(sseMessages('event: message\ndata: {"id":1}\n\ndata: not json\n\n'), [{ id: 1 }]);
  assert.equal(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }], isError: true }), 'Error: a\n[image]');
});
