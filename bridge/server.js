#!/usr/bin/env node
// dotpals bridge: turns agent-harness events into a live pal and an activity
// feed, in the floating desktop pal (`npm run float`) or a browser tab.
//
// Adapters (bridge/adapters/):
//   claude   Claude Code hooks → POST /hook, plus every session's transcript (history,
//            and sessions that have no hooks)
//   codex    follows ~/.codex/sessions logs (no setup on the Codex side)
//   generic  any harness can POST /event (see README → "Plug in any agent")
//
//   POST /hook, /event   ← events
//   GET  /events         → Server-Sent Events:
//                            message:  { session, harness, label, state, text }   the pal's state
//                            activity: { id, session, kind, title, … }            see activity.js
//                            config:   the settings, whenever they change
//                            reset:    history was cleared
//   GET  /               → the pal page
//   GET  /dashboard      → sessions, logs, stats and settings
//   GET  /api/activity   → { entries }
//   GET  /api/status     → what's connected, where things are stored
//   GET  /api/config, POST /api/config, POST /api/history/clear
//
//   node bridge/server.js            (PORT=5175 by default)
import { createServer } from 'node:http';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toAgentState } from '../src/agent.js';
import { clip, createActivityLog, folderName } from './activity.js';
import { applyHook, backfillTranscript, lastReply, watchClaude } from './adapters/claude.js';
import { watchCodex } from './adapters/codex.js';
import { configPath, home, loadConfig, saveConfig } from './config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = (() => { try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } })();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png' };
const KINDS = new Set(['prompt', 'read', 'edit', 'write', 'run', 'search', 'web', 'agent', 'mcp', 'skill', 'plan', 'tool', 'done', 'error', 'compact']);
const STATUSES = new Set(['running', 'waiting', 'ok', 'failed', 'stopped', 'info']);
const DAY = 86_400_000;

/**
 * Activity history on disk (~/.dotpals/history.json), so the Summary, Files and
 * dashboard survive restarts. Keeps `historyDays` (default 7), at most 5000 entries.
 */
function createHistory(activity, getConfig) {
  const file = () => join(home(), 'history.json');
  const keep = () => getConfig().historyDays * DAY;
  if (getConfig().history) {
    try {
      const { entries = [] } = JSON.parse(readFileSync(file(), 'utf8'));
      for (const e of entries) {
        if (!e?.id || !e.session || Date.now() - e.at > keep()) continue;
        // Anything still running when the bridge stopped won't finish now.
        activity.upsert(e.status === 'running' || e.status === 'waiting' ? { ...e, status: 'stopped' } : e);
      }
    } catch {}
  }

  let timer;
  let writing = Promise.resolve();
  return {
    file,
    save() {
      if (!getConfig().history) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const entries = activity.all().filter((e) => Date.now() - e.at < keep()).slice(-5000);
        writing = writing.then(async () => {
          try {
            await mkdir(home(), { recursive: true });
            await writeFile(`${file()}.tmp`, JSON.stringify({ version: 1, entries }));
            await rename(`${file()}.tmp`, file());
          } catch {}
        });
      }, 2000);
      timer.unref?.();
    },
    async clear() {
      clearTimeout(timer);
      await writing;
      await rm(file(), { force: true });
    },
  };
}

/**
 * Start the bridge. Resolves with the http server once it's listening, and
 * rejects (e.g. EADDRINUSE) if it can't.
 */
export function startBridge({ port = Number(process.env.PORT) || 5175, log: print = console.log } = {}) {
  const clients = new Set();
  const sessions = new Map(); // session id → last state update (replayed to new viewers)
  const activity = createActivityLog({ limit: 1500 });
  const backfilled = new Set();
  const hooked = new Set();    // Claude sessions that send hook events
  const lastSeen = {};        // harness → time of its last event
  let config = loadConfig();
  const history = createHistory(activity, () => config);
  const startedAt = Date.now();

  function send(event, data) {
    const line = `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(line);
  }

  function publish(entries) {
    let any = false;
    for (const entry of new Set(entries)) {
      if (!entry) continue;
      send('activity', entry);
      if (entry.harness) lastSeen[entry.harness] = Math.max(lastSeen[entry.harness] ?? 0, entry.at ?? 0);
      any = true;
    }
    if (any) history.save();
  }

  function setState(session, harness, label, next, at = Date.now()) {
    const update = { session, harness, label, ...next, at };
    if (harness) lastSeen[harness] = Math.max(lastSeen[harness] ?? 0, at);
    if (next.state === 'sleeping') sessions.delete(session);
    else sessions.set(session, update);
    send(null, update);
    return update;
  }

  // -- Claude Code (hooks) ------------------------------------------------------
  async function claudeEvent(event) {
    const session = String(event.session_id);
    const label = folderName(event.cwd);
    hooked.add(session);
    // First time we hear from a session: load its history from the transcript.
    if (event.transcript_path && !backfilled.has(session)) {
      backfilled.add(session);
      publish(await backfillTranscript(event.transcript_path, activity, { session, label }));
    }
    const changed = applyHook(event, activity, { session, label });
    publish(changed);
    if (event.hook_event_name === 'Stop' && event.transcript_path) addSummary(changed.find((e) => e.kind === 'done'), event.transcript_path);
    const next = toAgentState(event);
    return next ? setState(session, 'claude', label, next) : null;
  }

  // Attach Claude's closing message to a finished turn. The transcript can lag
  // the Stop hook a little, so try again once if it isn't there yet.
  async function addSummary(done, transcript) {
    if (!done || done.summary) return;
    const prompt = activity.findLast(done.session, (x) => x.kind === 'prompt');
    for (const wait of [0, 1500]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const summary = await lastReply(transcript, prompt?.at ? prompt.at - 1000 : 0);
      if (summary) return publish([activity.upsert({ id: done.id, summary })]);
    }
  }

  // -- Claude Code (transcripts): sessions without hooks -------------------------
  const stopClaude = process.env.DOTPALS_CLAUDE_LOGS === '0' ? () => {} : watchClaude(activity, {
    emit: publish,
    state: (session, label, next, at) => setState(session, 'claude', label, next, at),
    skip: (session) => hooked.has(session),
  });

  // -- Generic: any harness ------------------------------------------------------
  //   { session, harness?, label?, state?, text?, activity?: {...} | [...] }
  function genericEvent(event) {
    const session = String(event.session_id ?? event.session ?? 'default');
    const harness = event.harness ? clip(event.harness, 30) : undefined;
    const label = event.label ?? folderName(event.cwd);
    const items = Array.isArray(event.activity) ? event.activity : event.activity ? [event.activity] : [];
    let n = 0;
    publish(items.map((a) => {
      if (!a || typeof a !== 'object') return null;
      const id = `${session}:${a.id ?? `g${Date.now()}-${n++}`}`;
      // Follow-ups (same id) only change what they send; new rows get defaults.
      const known = activity.get(id);
      return activity.upsert({
        ...a,
        id, session,
        harness: harness ?? known?.harness,
        label: label ?? known?.label,
        at: Number(a.at) || known?.at || Date.now(),
        kind: KINDS.has(a.kind) ? a.kind : known?.kind ?? 'tool',
        status: STATUSES.has(a.status) ? a.status : known ? undefined : 'ok',
        title: a.title != null ? clip(a.title, 300) : known?.title ?? clip(a.tool ?? a.kind ?? 'Tool call', 300),
        ...(a.status === 'running' && !known ? { startedAt: Date.now() } : {}),
      });
    }));
    const next = toAgentState(event);
    return next ? setState(session, harness, label, next) : null;
  }

  const handleEvent = (event) => (typeof event.hook_event_name === 'string' && event.session_id ? claudeEvent(event) : genericEvent(event));

  // -- Codex (session logs), switchable from Settings ------------------------------
  let stopCodex = () => {};
  function applyCodex() {
    stopCodex();
    stopCodex = config.codex
      ? watchCodex(activity, { emit: publish, state: (session, label, next, at) => setState(session, 'codex', label, next, at) })
      : () => {};
  }
  applyCodex();

  // -- API --------------------------------------------------------------------------
  const json = (res, status, data) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(data));
  const readBody = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });

  async function status() {
    const codexDir = join(homedir(), '.codex', 'sessions');
    let historySize = 0;
    try { historySize = (await stat(history.file())).size; } catch {}
    return {
      version, port, startedAt,
      home: home(),
      configFile: configPath(),
      historyFile: history.file(),
      historySize,
      entries: activity.all().length,
      adapters: {
        claude: { lastEventAt: lastSeen.claude ?? null, hint: 'Install the Claude Code plugin: /plugin install dotpals@dotpals' },
        codex: { enabled: config.codex, found: existsSync(codexDir), dir: codexDir, lastEventAt: lastSeen.codex ?? null },
        generic: { endpoint: `http://127.0.0.1:${port}/event`, lastEventAt: Object.entries(lastSeen).filter(([h]) => h !== 'claude' && h !== 'codex').reduce((m, [, t]) => Math.max(m, t), 0) || null },
      },
    };
  }

  async function api(req, res, path) {
    if (req.method === 'GET' && path === '/api/activity') return json(res, 200, { entries: activity.all() });
    if (req.method === 'GET' && path === '/api/status') return json(res, 200, await status());
    if (req.method === 'GET' && path === '/api/config') return json(res, 200, config);

    // Changes need a custom header: browsers won't send it cross-site without
    // asking first (and we never say yes), so other websites can't change settings.
    if (req.method !== 'POST' || req.headers['x-dotpals'] !== '1') return json(res, 403, { error: 'forbidden' });
    if (path === '/api/config') {
      let patch = {};
      try { patch = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const before = config;
      config = saveConfig(patch);
      if (config.codex !== before.codex) applyCodex();
      if (config.history && !before.history) history.save();
      send('config', config);
      return json(res, 200, config);
    }
    if (path === '/api/history/clear') {
      activity.clear();
      backfilled.clear();
      await history.clear();
      send('reset', {});
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not found' });
  }

  // Only answer to our own name: stops "DNS rebinding" pages from reading your activity.
  const allowedHost = (host = '') => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'POST' && (url.pathname === '/hook' || url.pathname === '/event')) {
      const body = await readBody(req);
      try {
        const update = await handleEvent(JSON.parse(body || '{}'));
        if (update) print(`${new Date().toLocaleTimeString()}  ${update.label ?? update.session.slice(0, 8)}  ${update.state}${update.text ? `  "${update.text}"` : ''}`);
      } catch (err) {
        console.warn('bad event:', err.message);
      }
      // Claude Code reads the response as hook output; an empty object means "carry on".
      return res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    }

    if (!allowedHost(req.headers.host)) return res.writeHead(421).end();

    if (url.pathname.startsWith('/api/')) return api(req, res, url.pathname);

    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: config\ndata: ${JSON.stringify(config)}\n\n`);
      for (const entry of activity.all()) res.write(`event: activity\ndata: ${JSON.stringify(entry)}\n\n`);
      for (const update of sessions.values()) res.write(`data: ${JSON.stringify(update)}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    const path = url.pathname === '/' ? '/bridge/index.html'
      : url.pathname === '/dashboard' ? '/bridge/dashboard.html'
      : url.pathname;
    const file = normalize(join(root, path));
    if (!file.startsWith(root) || !/[\\/](src|bridge|desktop)[\\/]/.test(file)) return res.writeHead(404).end();
    try {
      res.writeHead(200, { 'content-type': types[extname(file)] || 'text/plain' }).end(await readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  server.on('close', () => { stopCodex(); stopClaude(); });

  return new Promise((ok, fail) => {
    server.once('error', (err) => { stopCodex(); stopClaude(); fail(err); });
    server.listen(port, '127.0.0.1', () => {
      print(`dotpals bridge → http://localhost:${port}`);
      print(`dashboard      → http://localhost:${port}/dashboard`);
      print(`hook endpoint  → http://localhost:${port}/hook`);
      ok(server);
    });
  });
}

// Run directly (`node bridge/server.js`, or the `dotpals-bridge` bin, which may be a symlink).
const invoked = process.argv[1] && (() => { try { return realpathSync(process.argv[1]); } catch { return ''; } })();
if (invoked && invoked === realpathSync(fileURLToPath(import.meta.url))) {
  startBridge().catch((err) => {
    console.error(err.code === 'EADDRINUSE' ? 'The dotpals bridge is already running.' : err.message);
    process.exit(err.code === 'EADDRINUSE' ? 0 : 1);
  });
}
