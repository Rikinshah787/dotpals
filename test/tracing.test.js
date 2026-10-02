import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'dotpals-tracing-'));
process.env.DOTPALS_HOME = home;
delete process.env.DOTPALS_SENTRY_DSN;
after(() => rm(home, { recursive: true, force: true }));

const { loadConfig, saveConfig, saveSentry, sentrySettings, validDsn } = await import('../bridge/config.js');
const { routeOf, scrub, startTracing, stopTracing, traceRequest } = await import('../bridge/tracing.js');

const DSN = 'https://abc123@o42.ingest.us.sentry.io/4507';

/** A stand-in for @sentry/node that records what dotpals asks of it. */
function fakeSentry() {
  const spans = [];
  return {
    spans,
    init(options) { this.options = options; },
    startSpan(opts, fn) {
      const span = { ...opts, attributes: { ...opts.attributes }, setAttribute(k, v) { this.attributes[k] = v; }, setStatus(s) { this.status = s; } };
      spans.push(span);
      return fn(span);
    },
    captureException() {},
    close: async () => true,
  };
}

test('Sentry is off with no DSN: the SDK is never loaded', async () => {
  let loaded = false;
  assert.equal(await startTracing({ settings: { dsn: null }, load: async () => { loaded = true; } }), false);
  assert.equal(loaded, false);
  let ran = false;
  await traceRequest({ method: 'GET', url: '/api/config' }, { statusCode: 200 }, async () => { ran = true; });
  assert.equal(ran, true);
});

test('a DSN is only set from the command line, kept through the dashboard’s saves, and never shown to a page', async () => {
  assert.equal(validDsn(DSN), DSN);
  assert.equal(validDsn('https://sentry.io/4507'), null); // no key
  assert.equal(validDsn('not a url'), null);
  assert.equal(validDsn('http://abc123@sentry.example.com/4507'), null); // not over plain http
  assert.equal(validDsn('http://abc123@127.0.0.1:9000/7'), 'http://abc123@127.0.0.1:9000/7'); // except to this computer
  assert.equal(loadConfig().sentry.on, false);
  saveConfig({ sentry: { dsn: DSN }, fromCli: true }); // a page can't turn it on
  assert.equal(sentrySettings().dsn, null);
  saveSentry({ dsn: DSN, tracesSampleRate: 0.5 });
  saveConfig({ sounds: false }); // a Settings save keeps it
  assert.deepEqual(sentrySettings(), { dsn: DSN, tracesSampleRate: 0.5 });
  assert.deepEqual(loadConfig().sentry, { on: true, tracesSampleRate: 0.5 });
  assert.doesNotMatch(JSON.stringify(loadConfig()), /abc123/);
  saveSentry({ off: true });
  assert.equal(sentrySettings().dsn, null);
  assert.doesNotMatch(await readFile(join(home, 'config.json'), 'utf8'), /sentry/);
});

test('when on, Sentry starts without the integrations that would read your activity', async () => {
  const sentry = fakeSentry();
  assert.equal(await startTracing({ version: '1.2.3', settings: { dsn: DSN, tracesSampleRate: 0.2 }, load: async () => sentry }), true);
  const o = sentry.options;
  assert.equal(o.dsn, DSN);
  assert.equal(o.release, 'dotpals@1.2.3');
  assert.equal(o.tracesSampleRate, 0.2);
  assert.equal(o.sendDefaultPii, false);
  assert.equal(o.traceLifecycle, 'static'); // streamed spans would skip scrub()
  const names = ['Console', 'LocalVariablesAsync', 'ChildProcess', 'RequestData', 'Http', 'NodeFetch', 'OnUncaughtException', 'ContextLines'];
  assert.deepEqual(o.integrations(names.map((name) => ({ name }))).map((i) => i.name), ['NodeFetch', 'OnUncaughtException', 'ContextLines']);
  assert.equal(o.beforeBreadcrumb({ category: 'console', message: 'Fix the VAT rounding' }), null);
  await stopTracing();
});

test('each request is a span named by its route; the live stream and the pal’s files aren’t traced', async () => {
  const sentry = fakeSentry();
  await startTracing({ settings: { dsn: DSN, tracesSampleRate: 1 }, load: async () => sentry });
  await traceRequest({ method: 'POST', url: '/hook?guard=1' }, { statusCode: 200 }, async () => {});
  await traceRequest({ method: 'GET', url: '/api/sessions/shop/dismiss' }, { statusCode: 500 }, async () => {});
  await traceRequest({ method: 'GET', url: '/events' }, { statusCode: 200 }, async () => {});
  await traceRequest({ method: 'GET', url: '/bridge/ui/story.js' }, { statusCode: 200 }, async () => {});
  assert.deepEqual(sentry.spans.map((s) => s.name), ['POST /hook', 'GET /api/sessions/:id/dismiss']);
  assert.equal(sentry.spans[0].attributes['http.response.status_code'], 200);
  assert.equal(sentry.spans[1].status.code, 2);
  await stopTracing();
  assert.equal(routeOf('/api/handoff/agents'), '/api/handoff/agents');
  assert.equal(routeOf('/api/sessions/alice@example.com/x'), '/api/:other'); // nothing from the path but its kind
  assert.equal(routeOf('/someone/secret'), '/:other');
});

test('an event leaves without request data, user or log lines, and without the computer’s name', () => {
  const event = scrub({ request: { data: '{"prompt":"secret"}' }, user: { ip_address: '1.2.3.4' }, server_name: 'RIKIN-PC',
    breadcrumbs: [{ category: 'console', message: 'Fix the VAT rounding' }, { category: 'fetch', data: { url: 'https://api.typesafe.ai' } }] });
  assert.equal(event.request, undefined);
  assert.equal(event.user, undefined);
  assert.equal(event.server_name, 'dotpals');
  assert.deepEqual(event.breadcrumbs.map((b) => b.category), ['fetch']);
});
