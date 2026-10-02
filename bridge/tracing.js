// Error and performance tracing with Sentry, for your own copy of dotpals. Off unless you
// turn it on with your own project's DSN (`dotpals sentry <dsn>`, or DOTPALS_SENTRY_DSN);
// with no DSN the SDK is never loaded and nothing is sent anywhere.
//
// When it's on, the bridge sends Sentry:
//   - a span per request: its method and route ("POST /hook", "GET /api/sessions/:id"),
//     status code and time. Never a request's body, query string or headers.
//   - spans for the bridge's own outgoing calls (Jev, Laya): their URL, status and time.
//   - errors the bridge didn't handle, with their stack trace.
// And never what your agents did: the integrations that would pick that up (console log
// lines, which carry prompts; local variables at an error, which can hold commands, test
// output or an API key; child processes; request data) are left out, and every event is
// scrubbed again before it's sent. The computer's name is replaced with "dotpals".
//
// @sentry/node isn't a dependency: `dotpals sentry <dsn>` installs it next to dotpals.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { home, sentrySettings } from './config.js';
import { APP_DIR } from './checker.js';

export const SENTRY_PACKAGE = '@sentry/node@^11';

// The default integrations dotpals keeps: what an error or a span needs, nothing that reads
// your activity (Console, LocalVariablesAsync, ChildProcess, RequestData, Http's incoming
// requests, ConversationId, Modules and the web frameworks are left out).
const KEEP = new Set(['EventFilters', 'FunctionToString', 'LinkedErrors', 'Dedupe', 'NodeSystemError', 'NodeFetch',
  'OnUncaughtException', 'OnUnhandledRejection', 'ContextLines', 'Context', 'ProcessSession']);

// Requests that aren't worth a span: the live stream stays open for hours, the pal's files are static.
const UNTRACED = /^\/(events|favicon\.ico)$|^\/(src|bridge|desktop)\/|^\/(dashboard)?$/;

let sentry = null; // the SDK, once started

/** A route without what's specific to one request: ids and long tokens become ":id". */
export function routeOf(pathname) {
  return String(pathname).split('/').map((seg) => (/^[0-9a-f-]{8,}$/i.test(seg) || /^[\w-]{24,}$/.test(seg) || /^\d+$/.test(seg) ? ':id' : seg)).join('/');
}

/** An event as it may leave this computer: no request data, no user, no breadcrumbs from logs. */
export function scrub(event) {
  if (!event) return event;
  delete event.request;
  delete event.user;
  if (event.contexts) delete event.contexts.trace?.data?.['http.query'];
  if (Array.isArray(event.breadcrumbs)) event.breadcrumbs = event.breadcrumbs.filter((b) => b.category !== 'console');
  event.server_name = 'dotpals';
  return event;
}

/**
 * Start Sentry if a DSN is set. Resolves to true when it's on, false when it's off, and
 * rejects when it's on but @sentry/node can't be loaded (`dotpals sentry <dsn>` installs it).
 * `load` and `settings` are for tests.
 */
export async function startTracing({ version = '0.0.0', settings = sentrySettings(), load = loadSentry } = {}) {
  if (!settings.dsn) return false;
  const Sentry = await load();
  Sentry.init({
    dsn: settings.dsn,
    release: `dotpals@${version}`,
    environment: process.env.DOTPALS_SENTRY_ENV || 'production',
    tracesSampleRate: settings.tracesSampleRate,
    sendDefaultPii: false,
    // Whole transactions (not streamed spans), so scrub() sees each one before it's sent.
    traceLifecycle: 'static',
    serverName: 'dotpals',
    integrations: (defaults) => defaults.filter((i) => KEEP.has(i.name)),
    beforeSend: scrub,
    beforeSendTransaction: scrub,
    beforeBreadcrumb: (b) => (b.category === 'console' ? null : b),
  });
  sentry = Sentry;
  return true;
}

/** Whether tracing is on in this process. */
export const tracing = () => !!sentry;

/** Run a request's handler inside a span ("POST /hook"), when tracing is on. */
export function traceRequest(req, res, handle) {
  const pathname = (() => { try { return new URL(req.url, 'http://localhost').pathname; } catch { return '/'; } })();
  if (!sentry || UNTRACED.test(pathname)) return handle();
  const name = `${req.method} ${routeOf(pathname)}`;
  return sentry.startSpan({ name, op: 'http.server', forceTransaction: true, attributes: { 'http.request.method': req.method } }, async (span) => {
    try {
      return await handle();
    } finally {
      span.setAttribute('http.response.status_code', res.statusCode);
      if (res.statusCode >= 500) span.setStatus({ code: 2, message: 'internal_error' });
    }
  });
}

/** Report an error the bridge caught but couldn't recover from. A no-op when tracing is off. */
export function report(err) {
  sentry?.captureException(err);
}

/** Send what's queued, before the bridge exits. */
export async function stopTracing(timeoutMs = 2000) {
  if (!sentry) return;
  const s = sentry;
  sentry = null;
  await s.close(timeoutMs).catch(() => {});
}

/** @sentry/node from wherever it is: next to this copy of dotpals, or in the installed copy. */
async function loadSentry() {
  try { return await import('@sentry/node'); } catch (err) {
    for (const dir of new Set([APP_DIR, join(home(), 'app')])) {
      try { return await import(pathToFileURL(createRequire(join(dir, 'package.json')).resolve('@sentry/node')).href); } catch {}
    }
    throw Object.assign(new Error('@sentry/node isn’t installed'), { code: 'SENTRY_MISSING', cause: err });
  }
}
