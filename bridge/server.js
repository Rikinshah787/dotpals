#!/usr/bin/env node
// dotpals bridge: turns agent-harness events into a live pal and an activity
// feed, in the floating desktop pal (`npm run float`) or a browser tab.
//
// Adapters (bridge/adapters/, listed in adapters/index.js):
//   claude   Claude Code hooks → POST /hook, plus every session's transcript (history,
//            and sessions that have no hooks)
//   codex    follows ~/.codex/sessions logs (no setup on the Codex side)
//   cursor, gemini, opencode
//            their hooks or plugin → POST /hook?agent=<id>, set up from the dashboard
//   generic  any harness can POST /event (see README → "Plug in any agent")
//
//   POST /hook, /event   ← events (/hook?agent=<id> for another agent's hooks)
//   GET  /events         → Server-Sent Events:
//                            message:  { session, harness, label, state, text }   the pal's state
//                            activity: { id, session, kind, title, … }            see activity.js
//                            context:  { session, harness, label, used, size, known, at }  how full its context window is
//                            config:   the settings, whenever they change
//                            agents:   the integrations, after Connect or Disconnect
//                            reset:    history was cleared
//                            context:  how full a session's context window is
//                            approval: a permission request to answer (or that it's settled)
//                            helpers:  a session's helper agents (subagents)
//                            laya:     Laya on this computer: { installed, running, phase, message, line, error }
//   GET  /               → the pal page
//   GET  /dashboard      → sessions, logs, stats and settings
//   GET  /api/activity   → { entries }
//   GET  /api/status     → what's connected, where things are stored
//   GET  /api/config, POST /api/config, POST /api/history/clear
//   GET  /api/agents     → { agents: [...] } every integration: detected, connected, on/off, last event
//   POST /api/agents/<id>/connect      add dotpals to that agent's config (backs it up first)
//   POST /api/agents/<id>/disconnect   take it out again
//   POST /api/agents/<id>/test         run its hook with a sample event and show a pal
//   GET  /api/usage      → { agents: [...] } plan usage, from usage.js
//   GET  /api/approvals  → requests waiting for an answer; POST /api/approvals/<id> { decision }
//   GET  /api/recap      → a note for one agent about the others (?session=&label=&mode=start|prompt)
//   POST /api/sessions/<id>/dismiss → put a session to sleep (it wakes on new activity)
//   POST /api/checker/test { mode? } → one tiny request to the test-result checker: { ok, by, ms, error? }
//   GET  /api/checker/laya             → Laya's status (also in /api/config, as checker.laya)
//   POST /api/checker/laya/setup       install Laya (once) and start it; answers at once, progress as `laya` events
//   POST /api/checker/laya/start|stop|uninstall
//   (every POST under /api needs the `x-dotpals: 1` header)
//
//   node bridge/server.js            (PORT=5175 by default)
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toAgentState } from '../src/agent.js';
import { clip, clipEnds, createActivityLog, folderName } from './activity.js';
import { applyHook, backfillTranscript, describeTool, lastReply, watchClaude } from './adapters/claude.js';
import { crossRecap, flags as riskFlags, stepType } from './ui/story.js';
import { sentence } from './ui/recap.js';
import { ADAPTERS, adapter } from './adapters/index.js';
import { createChecker } from './checker.js';
import { createLaya } from './laya.js';
import { checkerKey, configPath, home, loadConfig, saveConfig, validKey } from './config.js';
import { claudeContextSize, readUsage } from './usage.js';

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
// A session with no news for this long is over: its pal goes to sleep and leaves.
// Waiting for your OK gets longer, in case you stepped away.
const SLEEP_AFTER = 15 * 60_000;
const SLEEP_AFTER_WAITING = 60 * 60_000;

export function startBridge({ port = Number(process.env.DOTPALS_PORT || process.env.PORT) || 5175, log: print = console.log, sleepAfter = SLEEP_AFTER, sleepAfterWaiting = SLEEP_AFTER_WAITING, laya: layaOptions = {} } = {}) {
  const clients = new Set();
  const sessions = new Map(); // session id → last state update (replayed to new viewers)
  const contexts = new Map(); // session id → how full its context window is (replayed too)
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

  // -- session lifecycle ------------------------------------------------------------
  // The bridge alone decides when a session is over (adapters and viewers don't):
  // quiet for `sleepAfter` → "sleeping", and viewers let its pal go. Any event wakes it.
  const lastHeard = new Map(); // session → time of its newest event
  const heard = (session, at = Date.now()) => { if (session) lastHeard.set(session, Math.max(lastHeard.get(session) ?? 0, at ?? 0)); };
  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [session, update] of sessions) {
      const quiet = now - Math.max(lastHeard.get(session) ?? 0, update.at ?? 0);
      if (quiet > (update.state === 'waiting' ? sleepAfterWaiting : sleepAfter)) {
        setState(session, update.harness, update.label, { state: 'sleeping' }, now);
        lastHeard.delete(session);
      }
    }
  }, Math.min(30_000, Math.max(50, sleepAfter / 4)));
  reaper.unref?.();

  // -- helpers (subagents), for any agent ---------------------------------------------
  // One list per session of the helper agents it started, what each is doing and
  // whether it's done. Fed by every adapter's "agent" steps (Claude's Agent tool,
  // Codex's spawn_agent…), by Claude's SubagentStart/SubagentStop hooks and the
  // agent_id on a helper's own tool calls, and by `helper` in generic events.
  const helpers = new Map(); // session → Map(id → { id, name, task, status, doing, startedAt, endedAt })
  const HELPER_DONE_FOR = 60_000; // finished helpers stay listed this long
  function helperList(session) {
    const list = helpers.get(session);
    if (!list) return [];
    const now = Date.now();
    for (const [id, h] of list) if (h.status !== 'running' && now - (h.endedAt ?? now) > HELPER_DONE_FOR) list.delete(id);
    return [...list.values()].sort((a, b) => a.startedAt - b.startedAt).map(({ agentId, ...h }) => h);
  }
  function sendHelpers(session, harness) {
    send('helpers', { session, harness, helpers: helperList(session) });
  }
  function helperFromEntry(e) {
    if (e.kind !== 'agent' || !e.session || !e.id) return;
    const list = helpers.get(e.session) ?? new Map();
    helpers.set(e.session, list);
    const h = list.get(e.id) ?? { id: e.id, name: e.detail || 'helper', task: e.title, startedAt: e.startedAt ?? e.at ?? Date.now(), status: 'running' };
    h.task = e.title || h.task;
    // Once Claude's lifecycle hooks know this helper, they decide when it's done
    // (a background helper's tool call returns long before the helper finishes).
    if (!h.agentId) {
      if (e.status === 'failed' || e.status === 'stopped') { h.status = 'failed'; h.endedAt = Date.now(); }
      else if (e.status === 'ok') { h.status = 'done'; h.endedAt = Date.now(); }
    }
    list.set(e.id, h);
    sendHelpers(e.session, e.harness);
  }
  /** Claude Code: SubagentStart/SubagentStop, and tool calls made by a helper (they carry agent_id). */
  function helperFromHook(event, session) {
    const agentId = event.agent_id;
    if (!agentId) return;
    const list = helpers.get(session) ?? new Map();
    helpers.set(session, list);
    let h = [...list.values()].find((x) => x.agentId === agentId);
    if (!h) {
      // Pair it with the Agent tool call that started it: the oldest running one of this type.
      h = [...list.values()].find((x) => !x.agentId && x.status === 'running' && (!event.agent_type || x.name === event.agent_type))
        ?? [...list.values()].find((x) => !x.agentId && x.status === 'running');
      if (!h) {
        h = { id: `${session}:sub:${agentId}`, name: event.agent_type || 'helper', startedAt: Date.now(), status: 'running' };
        list.set(h.id, h);
      }
      h.agentId = agentId;
    }
    if (event.hook_event_name === 'SubagentStop') {
      h.status = 'done';
      h.endedAt = Date.now();
      h.doing = undefined;
    } else if (event.hook_event_name === 'PreToolUse' && event.tool_name) {
      const d = describeTool(event.tool_name, event.tool_input ?? {}, event.cwd);
      h.doing = sentence({ ...d, tool: event.tool_name, status: 'running' });
      h.status = 'running';
    }
    sendHelpers(session, 'claude');
  }
  /** Generic events: { session, helper: { id, name?, task?, state: 'working' | 'done' | 'error', text? } } */
  function helperFromEvent(session, harness, helper) {
    if (!helper || typeof helper !== 'object' || helper.id == null) return;
    const id = `${session}:helper:${clip(String(helper.id), 80)}`;
    const list = helpers.get(session) ?? new Map();
    helpers.set(session, list);
    const h = list.get(id) ?? { id, name: 'helper', startedAt: Date.now(), status: 'running' };
    if (helper.name) h.name = clip(String(helper.name), 40);
    if (helper.task) h.task = clip(String(helper.task), 120);
    if (helper.text) h.doing = clip(String(helper.text), 120);
    if (helper.state === 'done' || helper.state === 'error') { h.status = helper.state === 'done' ? 'done' : 'failed'; h.endedAt = Date.now(); h.doing = undefined; }
    else h.status = 'running';
    list.set(id, h);
    sendHelpers(session, harness);
  }

  function publish(entries) {
    let any = false;
    for (const entry of new Set(entries)) {
      if (!entry) continue;
      send('activity', entry);
      heard(entry.session, entry.at);
      if (entry.kind === 'agent') helperFromEntry(entry);
      if (entry.harness) lastSeen[entry.harness] = Math.max(lastSeen[entry.harness] ?? 0, entry.at ?? 0);
      maybeCheck(entry);
      any = true;
    }
    if (any) history.save();
  }

  // -- Double-check unclear test results (bridge/checker.js; off unless you turn it on) --
  // When a test run finishes and the rules can't tell whether it passed, ask Laya or
  // Jev once. The answer goes on the entry as `check` ({ by, state, p, ms } or
  // { by, error }), so every viewer updates. Only fresh runs: not every old run in a
  // transcript read at startup.
  const checker = createChecker({ getConfig: () => config, getKey: checkerKey });
  function maybeCheck(entry) {
    if (!config.checker || config.checker.mode === 'off' || entry.kind !== 'run' || entry.check || stepType(entry) !== 'test') return;
    if (Date.now() - ((entry.at ?? 0) + (entry.ms ?? 0)) > 15 * 60_000) return;
    checker.check(entry).then((check) => {
      if (check && !activity.get(entry.id)?.check) publish([activity.upsert({ id: entry.id, check })]);
    }, () => {});
  }

  // -- Laya on this computer, set up by dotpals (bridge/laya.js) ----------------------
  // Runs while the checker is on Local and dotpals set it up (checker.layaManaged), on the
  // port in checker.localUrl. Stopped when you choose something else, and when the bridge
  // closes. Its status rides along in the settings (checker.laya) and as `laya` events.
  const laya = createLaya({ getUrl: () => config.checker?.localUrl, ...layaOptions });
  laya.subscribe((s) => send('laya', s));
  const withLaya = () => ({ ...config, checker: { ...config.checker, laya: laya.status() } });
  function applyLaya(before) {
    const b = before?.checker ?? {};
    const c = config.checker ?? {};
    if (before && b.mode === c.mode && b.layaManaged === c.layaManaged && b.localUrl === c.localUrl) return;
    if (c.mode === 'local' && c.layaManaged && laya.installed()) laya.start().catch(() => {});
    else if (laya.owned() || laya.status().running) laya.stop().catch(() => {}); // only ever stops a Laya dotpals started
  }

  function setState(session, harness, label, next, at = Date.now(), test = false) {
    const update = { session, harness, label, ...next, at };
    if (harness && !test) lastSeen[harness] = Math.max(lastSeen[harness] ?? 0, at);
    if (!test && next.state !== 'sleeping') heard(session, at);
    if (next.state === 'sleeping') { sessions.delete(session); contexts.delete(session); helpers.delete(session); }
    else sessions.set(session, update);
    send(null, update);
    return update;
  }

  function setContext(session, harness, label, ctx) {
    const update = { session, harness, label, ...ctx };
    contexts.set(session, update);
    send('context', update);
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
    helperFromHook(event, session);
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

  // -- Approve from the pal (Claude Code's PermissionRequest hook) ----------------
  // Off unless you turn it on in Settings. When it's on and a pal, the notch or the
  // dashboard is open, the bridge holds Claude's permission request for up to
  // `approvalWait` seconds so you can answer Allow or Deny there. Claude doesn't show
  // its own prompt while a hook runs, so if you don't answer (or nothing is open to
  // answer from) the bridge steps aside and Claude asks you in the terminal as usual.
  const approvals = new Map(); // id → { …what's asked, resolve }
  const answerers = new Set(); // viewers that show approval cards (see /events?answers=1)
  const recapTold = new Map(); // session → newest news it has been told about (see /api/recap)
  const approvalView = ({ resolve, timer, ...item }) => item;
  async function askApproval(event, req) {
    // Only when something that can answer is open (the pal or the notch, which connect with
    // ?answers=1): an open dashboard alone would leave Claude waiting with nothing to click.
    if (!config.approvals || !answerers.size || typeof event.tool_name !== 'string') return null;
    const id = randomUUID();
    const session = String(event.session_id);
    const d = describeTool(event.tool_name, event.tool_input ?? {}, event.cwd);
    const wait = config.approvalWait * 1000;
    const item = {
      id, session, harness: 'claude', label: folderName(event.cwd),
      tool: event.tool_name, kind: d.kind, title: d.title, detail: d.detail,
      command: d.body?.command, patch: d.body?.patch ? clip(d.body.patch, 1200) : undefined,
      helper: event.agent_type || undefined,
      risks: riskFlags([{ ...d, status: 'ok' }], { before: true }).map((f) => f.text),
      at: Date.now(), expiresAt: Date.now() + wait,
    };
    approvals.set(id, item);
    send('approval', { ...approvalView(item), status: 'pending' });
    const decision = await new Promise((resolve) => {
      item.resolve = resolve;
      item.timer = setTimeout(() => resolve(null), wait);
      req.on('close', () => resolve(null)); // Claude gave up waiting (or the session ended)
    });
    clearTimeout(item.timer);
    approvals.delete(id);
    send('approval', { id, session, status: decision ?? 'expired' });
    if (!decision) return null;
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', reason: 'The user said no from dotpals.' },
      },
    };
  }

  // -- Claude Code (transcripts): sessions without hooks -------------------------
  let stopClaude = () => {};
  function applyClaude() {
    stopClaude();
    stopClaude = process.env.DOTPALS_CLAUDE_LOGS === '0' || !enabled('claude') ? () => {} : watchClaude(activity, {
      emit: publish,
      state: (session, label, next, at) => setState(session, 'claude', label, next, at),
      context: (session, label, ctx) => setContext(session, 'claude', label, ctx),
      sizeOf: claudeContextSize,
      skip: (session) => hooked.has(session),
    });
  }

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
      // Long output keeps its start and its end (where test summaries are).
      const body = a.body && typeof a.body === 'object' && typeof a.body.output === 'string' ? { ...a.body, output: clipEnds(a.body.output, 3000) } : a.body;
      return activity.upsert({
        ...a,
        body,
        check: undefined, // only the bridge's own checker says this

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
    helperFromEvent(session, harness, event.helper);
    const next = toAgentState(event);
    return next ? setState(session, harness, label, next) : null;
  }

  // -- Other agents' hooks and plugins: POST /hook?agent=<id> -----------------------
  const tests = new Map(); // test session → resolve, for "Send a test event"
  function agentEvent(id, event) {
    const a = adapter(id);
    if (!a?.apply) return null;
    // Switched off: drop it (but still answer a test from the dashboard).
    const { entries = [], session, label, state } = a.apply(event, enabled(id) ? activity : createActivityLog());
    // A test from the dashboard: it arrived, which is all we wanted to know.
    if (session && tests.has(session)) { tests.get(session)(true); activity.forget(session); return null; }
    if (!enabled(id)) return null;
    publish(entries);
    if (session) lastSeen[id] = Math.max(lastSeen[id] ?? 0, Date.now());
    return state && session ? setState(session, id, label, state) : null;
  }

  function handleEvent(event, agent) {
    if (agent) return agentEvent(agent, event);
    if (typeof event.hook_event_name === 'string' && event.session_id) return enabled('claude') ? claudeEvent(event) : null;
    return enabled('generic') ? genericEvent(event) : null;
  }

  // -- Agents followed through their logs (Codex), switchable from the Agents page --
  const enabled = (id) => config.agents?.[id] !== false;
  const watchers = new Map(); // id → stop
  function applyWatchers() {
    for (const a of ADAPTERS) {
      if (!a.watch) continue;
      const on = enabled(a.id);
      if (on === watchers.has(a.id)) continue;
      if (!on) { watchers.get(a.id)(); watchers.delete(a.id); continue; }
      watchers.set(a.id, a.watch(activity, {
        emit: publish,
        state: (session, label, next, at) => setState(session, a.id, label, next, at),
        context: (session, label, ctx) => setContext(session, a.id, label, ctx),
      }));
    }
  }
  const stopWatchers = () => { for (const stop of watchers.values()) stop(); watchers.clear(); stopClaude(); };
  applyWatchers();
  applyClaude();

  // -- API --------------------------------------------------------------------------
  const json = (res, status, data) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(data));
  const readBody = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });

  /** Every integration, for the dashboard's Agents page. */
  function agents() {
    const generic = Object.entries(lastSeen).filter(([h]) => !adapter(h) || h === 'generic').reduce((m, [, t]) => Math.max(m, t), 0) || null;
    return ADAPTERS.map((a) => {
      let found = false;
      let where = null;
      try { ({ found, where } = a.detect()); } catch {}
      let connected = null;
      if (a.setup === 'connect') { try { connected = !!a.connected(); } catch { connected = false; } }
      return {
        id: a.id, name: a.name, via: a.via, how: a.how, docs: a.docs, setup: a.setup,
        install: a.install, file: a.file?.() ?? null,
        enabled: enabled(a.id), found, where, connected,
        lastEventAt: a.id === 'generic' ? generic : lastSeen[a.id] ?? null,
        ...(a.id === 'generic' ? { endpoint: `http://127.0.0.1:${port}/event` } : {}),
      };
    });
  }

  /**
   * "Send a test event": run the agent's real hook command with a sample event
   * (so a wrong path or a missing `node` shows up), then play a short scene on a pal.
   */
  async function testAgent(a) {
    const session = `${a.id}:dotpals-test`;
    let via = 'bridge';
    if (a.setup === 'connect' && a.connected?.() && (a.probe || a.sample)) {
      const token = `dotpals-test-${Date.now().toString(36)}`;
      const arrived = new Promise((ok) => { tests.set(`${a.id}:${token}`, ok); setTimeout(() => ok(false), 6000).unref?.(); });
      const url = `http://127.0.0.1:${port}/hook`;
      let err = '';
      if (a.probe) {
        via = 'plugin';
        try { await a.probe({ url, token }); } catch (e) { err = e.message; tests.get(`${a.id}:${token}`)?.(false); }
      } else {
        via = 'hook';
        const child = spawn(a.command?.() ?? '', {
          shell: true, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'],
          env: { ...process.env, DOTPALS_URL: url },
        });
        child.stderr.on('data', (c) => (err += c));
        child.on('error', (e) => (err += e.message));
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(a.sample(token)));
      }
      const ok = await arrived;
      tests.delete(`${a.id}:${token}`);
      if (ok === false) return { ok: false, via, error: `The ${via} ran but nothing reached the bridge.${err.trim() ? ` ${clip(err, 300)}` : ''}` };
    }
    const harness = a.id === 'generic' ? 'my-agent' : a.id;
    const scene = (next) => setState(session, harness, 'connection test', next, Date.now(), true);
    scene({ state: 'working', text: 'Hello from the dashboard' });
    setTimeout(() => scene({ state: 'done', text: 'It works!' }), 1800).unref?.();
    setTimeout(() => scene({ state: 'sleeping' }), 5000).unref?.();
    return { ok: true, via };
  }

  async function usage() {
    try { return await readUsage(); } catch { return { agents: [] }; }
  }

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
      agents: agents(),
    };
  }

  async function api(req, res, path) {
    if (req.method === 'GET' && path === '/api/activity') return json(res, 200, { entries: activity.all() });
    if (req.method === 'GET' && path === '/api/status') return json(res, 200, await status());
    if (req.method === 'GET' && path === '/api/config') return json(res, 200, withLaya());
    if (req.method === 'GET' && path === '/api/checker/laya') return json(res, 200, laya.status());
    if (req.method === 'GET' && path === '/api/agents') return json(res, 200, { agents: agents() });
    // What other agents did in this project, for a Claude Code hook to hand to a session
    // (Settings → Share with your agents). `mode=start`: the whole note. `mode=prompt`:
    // only when there's news since the last note this session got.
    if (req.method === 'GET' && path === '/api/recap') {
      if (!config.shareRecap) return json(res, 200, {});
      const q = new URL(req.url, 'http://localhost').searchParams;
      const session = q.get('session') ?? '';
      const label = q.get('label') || undefined;
      const states = new Map([...sessions].map(([id, u]) => [id, u.state]));
      const recap = crossRecap(activity.all(), { session, label, states });
      if (!recap) return json(res, 200, {});
      const told = recapTold.get(session) ?? 0;
      if (q.get('mode') === 'prompt' && recap.newest <= told) return json(res, 200, {});
      recapTold.set(session, recap.newest);
      return json(res, 200, { text: recap.text });
    }
    if (req.method === 'GET' && path === '/api/approvals') return json(res, 200, { approvals: [...approvals.values()].map(approvalView) });
    if (req.method === 'GET' && path === '/api/usage') return json(res, 200, await usage());

    // Changes need a custom header: browsers won't send it cross-site without
    // asking first (and we never say yes), so other websites can't change settings.
    if (req.method !== 'POST' || req.headers['x-dotpals'] !== '1') return json(res, 403, { error: 'forbidden' });
    if (path === '/api/config') {
      let patch = {};
      try { patch = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      // A pasted key that can't be one (spaces, line breaks): say so rather than drop it quietly.
      const key = patch?.checker?.jevKey;
      if (typeof key === 'string' && key.trim() && !validKey(key)) return json(res, 400, { error: 'That doesn’t look like an API key (it has spaces or unusual characters). Paste it again.' });
      const before = config;
      config = saveConfig(patch);
      applyWatchers();
      if (enabled('claude') !== (before.agents?.claude !== false)) applyClaude();
      if (config.history && !before.history) history.save();
      applyLaya(before);
      send('config', withLaya());
      return json(res, 200, withLaya());
    }
    const action = /^\/api\/agents\/([a-z][a-z0-9-]*)\/(connect|disconnect|test)$/.exec(path);
    if (action) {
      const a = adapter(action[1]);
      if (!a) return json(res, 404, { error: 'no such agent' });
      if (action[2] === 'test') return json(res, 200, await testAgent(a));
      if (a.setup !== 'connect') return json(res, 400, { error: `${a.name} doesn’t need connecting` });
      try {
        const result = a[action[2]]();
        send('agents', agents());
        return json(res, 200, { ok: true, ...result, agent: agents().find((x) => x.id === a.id) });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    // Dismiss a session (the × on its tab): its pal goes to sleep everywhere. It comes
    // back by itself if the agent does something new. History isn't touched.
    const dismiss = /^\/api\/sessions\/([^/]{1,200})\/dismiss$/.exec(path);
    if (dismiss) {
      const session = decodeURIComponent(dismiss[1]);
      const update = sessions.get(session);
      if (update) setState(session, update.harness, update.label, { state: 'sleeping' });
      lastHeard.delete(session);
      return json(res, 200, { ok: true, wasActive: !!update });
    }
    // "Test connection" on Settings: one tiny request (Laya's /health, or Jev's model list).
    if (path === '/api/checker/test') {
      let mode;
      try { mode = JSON.parse((await readBody(req)) || '{}').mode; } catch {}
      return json(res, 200, await checker.test(['local', 'cloud'].includes(mode) ? mode : undefined));
    }
    // Laya on this computer: Set up (install once, then start), Start, Stop, Remove.
    const layaAction = /^\/api\/checker\/laya\/(setup|start|stop|uninstall)$/.exec(path);
    if (layaAction) {
      const act = layaAction[1];
      if (act === 'setup') {
        laya.setup().then((s) => {
          if (!s.installed) return;
          // From now on dotpals runs it, whenever the checker is on Local, at the address it runs on.
          config = saveConfig({ checker: { mode: 'local', layaManaged: true, ...(s.running ? { localUrl: `http://127.0.0.1:${s.port}` } : {}) } });
          send('config', withLaya());
        }, () => {});
        return json(res, 202, { ok: true, laya: laya.status() });
      }
      if (act === 'start') {
        if (!laya.installed()) return json(res, 400, { error: 'Laya isn’t set up yet', laya: laya.status() });
        laya.start().catch(() => {});
        return json(res, 202, { ok: true, laya: laya.status() });
      }
      if (act === 'stop') return json(res, 200, { ok: true, laya: await laya.stop() });
      // Remove: stop it, delete <home>/laya (the environment and the model), and turn the
      // checker off if it was using it.
      const removed = await laya.uninstall();
      config = saveConfig({ checker: { layaManaged: false, ...(config.checker?.mode === 'local' ? { mode: 'off' } : {}) } });
      send('config', withLaya());
      return json(res, 200, { ok: true, laya: removed });
    }
    const answer = /^\/api\/approvals\/([\w-]{8,64})$/.exec(path);
    if (answer) {
      const item = approvals.get(answer[1]);
      if (!item) return json(res, 404, { error: 'That request has already been answered or has timed out' });
      let decision;
      try { decision = JSON.parse(await readBody(req)).decision; } catch {}
      if (decision !== 'allow' && decision !== 'deny') return json(res, 400, { error: 'decision must be "allow" or "deny"' });
      item.resolve(decision);
      return json(res, 200, { ok: true, decision });
    }
    if (path === '/api/history/clear') {
      activity.clear();
      backfilled.clear();
      contexts.clear();
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
      // Agents' hooks and scripts don't send an Origin; a web page does. Only this
      // computer's own pages may post, so another site can't fake activity or approvals.
      const origin = req.headers.origin;
      if (!allowedHost(req.headers.host) || (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin))) return res.writeHead(403).end();
      const body = await readBody(req);
      let reply = null;
      try {
        const event = JSON.parse(body || '{}');
        const update = await handleEvent(event, url.searchParams.get('agent'));
        if (update) print(`${new Date().toLocaleTimeString()}  ${update.label ?? update.session.slice(0, 8)}  ${update.state}${update.text ? `  "${update.text}"` : ''}`);
        if (url.pathname === '/hook' && !url.searchParams.get('agent') && event.hook_event_name === 'PermissionRequest' && event.session_id) reply = await askApproval(event, req);
      } catch (err) {
        console.warn('bad event:', err.message);
      }
      // Claude Code reads the response as hook output; an empty object means "carry on".
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply ?? {}));
    }

    if (!allowedHost(req.headers.host)) return res.writeHead(421).end();

    if (url.pathname.startsWith('/api/')) return api(req, res, url.pathname);

    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: config\ndata: ${JSON.stringify(withLaya())}\n\n`);
      for (const entry of activity.all()) res.write(`event: activity\ndata: ${JSON.stringify(entry)}\n\n`);
      for (const update of sessions.values()) res.write(`data: ${JSON.stringify(update)}\n\n`);
      for (const ctx of contexts.values()) res.write(`event: context\ndata: ${JSON.stringify(ctx)}\n\n`);
      for (const session of helpers.keys()) { const list = helperList(session); if (list.length) res.write(`event: helpers\ndata: ${JSON.stringify({ session, harness: sessions.get(session)?.harness, helpers: list })}\n\n`); }
      for (const item of approvals.values()) res.write(`event: approval\ndata: ${JSON.stringify({ ...approvalView(item), status: 'pending' })}\n\n`);
      clients.add(res);
      if (url.searchParams.get('answers') === '1') answerers.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
        answerers.delete(res);
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
  server.on('close', () => { stopWatchers(); clearInterval(reaper); laya.stop().catch(() => {}); });

  return new Promise((ok, fail) => {
    server.once('error', (err) => { stopWatchers(); clearInterval(reaper); fail(err); });
    server.listen(port, '127.0.0.1', () => {
      print(`dotpals bridge → http://localhost:${port}`);
      print(`dashboard      → http://localhost:${port}/dashboard`);
      print(`hook endpoint  → http://localhost:${port}/hook`);
      // Only now: a bridge that couldn't listen (one is already running) mustn't start a second Laya.
      applyLaya(null);
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
