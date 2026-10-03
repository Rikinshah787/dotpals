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
//                            conflict: an agent is changing a file another active session just changed (see guard.js)
//   GET  /               → the pal page
//   GET  /dashboard      → sessions, logs, stats and settings
//   GET  /api/activity   → { entries }
//   GET  /api/status     → what's connected, where things are stored; desktop: { pal, notch }, whether
//                          the desktop app's windows are following the events (/events?window=pal|notch)
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
//   POST /hook?guard=1   Claude Code's PreToolUse for a file change (bridge/guard-hook.js): another
//                        session changed that file a moment ago? → "ask" or "deny", else {}
//   GET  /api/handoff/agents       → { agents: [{ id, name }] } the agents a session can be handed to
//   POST /api/handoff { session, agent }   write the hand-off note and open that agent in a new
//                        terminal, in the session's own folder; agent "copy": just the note
//   POST /api/chat { text, session?, directory? } send a prompt to OpenCode (bridge/chat.js runs
//                        its own `opencode serve`); no session: a new one in `directory`.
//                        It and /api/chat/projects answer 409 unless Settings → chat is on.
//   POST /api/chat/abort { session }   stop what that OpenCode session is doing
//   POST /api/chat/answer { id, reply } | { id, answers }  answer an OpenCode permission request
//                        (`ocask` events: once, always or reject) or question (null skips it)
//   GET  /api/chat/projects → { projects: [{ path, name }] } folders agents worked in, newest first
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
import { clip, clipEnds, createActivityLog, folderName, trimActivity } from './activity.js';
import { applyHook, backfillTranscript, describeTool, lastReply, watchClaude } from './adapters/claude.js';
import { contextEntries, crossRecap, flags as riskFlags, stepType } from './ui/story.js';
import { sentence } from './ui/recap.js';
import { ADAPTERS, adapter } from './adapters/index.js';
import { createChecker, installSdk } from './checker.js';
import { createLaya } from './laya.js';
import { checkerKey, configPath, home, loadConfig, saveConfig, validKey } from './config.js';
import { FILE_TOOLS, ago, alertText, createAlerts, findConflict, guardReason, guardReply, pathKey, who } from './guard.js';
import { HANDOFF_AGENTS, handoffPrompt, installedAgents, isFolder, launch, launchCommand, onPath, saveNote } from './handoff.js';
import { handoffNote } from './ui/handoff.js';
import { claudeContextSize, readUsage } from './usage.js';
import { createGround } from './ground.js';
import { createChat } from './chat.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = (() => { try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } })();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png' };
const KINDS = new Set(['prompt', 'read', 'edit', 'write', 'run', 'search', 'web', 'agent', 'mcp', 'skill', 'plan', 'tool', 'done', 'error', 'compact']);
const STATUSES = new Set(['running', 'waiting', 'ok', 'failed', 'stopped', 'info']);
const CHANGES = new Set(['read', 'edit', 'write', 'delete']);
const DAY = 86_400_000;

/**
 * Activity history on disk (~/.dotpals/history.json), so the Summary, Files and
 * dashboard survive restarts. Keeps `historyDays` (default 7), at most 5000 entries.
 */
function createHistory(activity, getConfig, meta = { get: () => ({}), set: () => {} }) {
  const file = () => join(home(), 'history.json');
  const keep = () => getConfig().historyDays * DAY;
  if (getConfig().history) {
    try {
      const { entries = [], sessions = {} } = JSON.parse(readFileSync(file(), 'utf8'));
      meta.set(sessions);
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
        const entries = trimActivity(activity.all().filter((e) => Date.now() - e.at < keep()), 5000, contextEntries);
        writing = writing.then(async () => {
          try {
            await mkdir(home(), { recursive: true });
            const ids = new Set(entries.map((e) => e.session));
            const sessions = Object.fromEntries(Object.entries(meta.get()).filter(([id]) => ids.has(id)));
            await writeFile(`${file()}.tmp`, JSON.stringify({ version: 1, entries, sessions }));
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

export function startBridge({ port = Number(process.env.DOTPALS_PORT || process.env.PORT) || 5175, log: print = console.log, sleepAfter = SLEEP_AFTER, sleepAfterWaiting = SLEEP_AFTER_WAITING, laya: layaOptions = {}, installSdk: installTheSdk = installSdk, handoff: handoffOptions = {}, onQuit = null, createChat: makeChat = createChat } = {}) {
  const clients = new Set();
  const windows = new Map(); // the desktop app's windows following the events: response → 'pal' | 'notch'
  const sessions = new Map(); // session id → last state update (replayed to new viewers)
  const contexts = new Map(); // session id → how full its context window is (replayed too)
  const activity = createActivityLog({ limit: 1500, retain: contextEntries });
  const backfilled = new Set();
  const hooked = new Set();    // Claude sessions that send hook events
  const lastSeen = {};        // harness → time of its last event
  let config = loadConfig();
  // Each session's project folder (where it started) and, for a helper with a session of its
  // own, the session that started it: for the hand-off's terminal and the conflict guard.
  // Only ever from the agents' own events and logs, never from an API request. Kept in history.
  const sessionMeta = new Map(); // session → { cwd?, parent? }
  function noteSession(session, cwd, parent) {
    if (!session || (!cwd && !parent)) return;
    const m = sessionMeta.get(session) ?? {};
    if (typeof cwd === 'string' && cwd && !m.cwd) m.cwd = cwd;
    if (typeof parent === 'string' && parent && parent !== session) m.parent = parent;
    sessionMeta.set(session, m);
  }
  const history = createHistory(activity, () => config, {
    get: () => Object.fromEntries(sessionMeta),
    set: (saved) => { for (const [id, m] of Object.entries(saved ?? {})) noteSession(id, m?.cwd, m?.parent); },
  });
  const startedAt = Date.now();
  // OpenCode's permission requests and questions, from sessions started in
  // the pal (bridge/chat.js), shown as cards with buttons. id → { kind, session, … }
  const ocAsks = new Map();
  const chat = makeChat({
    onEvent(event) {
      const p = event?.properties ?? {};
      if (!p.sessionID) return;
      const session = `opencode:${p.sessionID}`;
      const label = folderName(sessionMeta.get(session)?.cwd) || 'OpenCode';
      if (event.type === 'permission.asked' && p.id) {
        const item = { id: p.id, kind: 'permission', session, label, permission: p.permission, patterns: (p.patterns ?? []).slice(0, 5).map((x) => clip(String(x), 300)), canAlways: (p.always ?? []).length > 0, at: Date.now() };
        ocAsks.set(p.id, item);
        send('ocask', { ...item, status: 'pending' });
      } else if (event.type === 'question.asked' && p.id) {
        const questions = (p.questions ?? []).slice(0, 4).map((q) => ({
          question: clip(String(q.question ?? ''), 500), header: clip(String(q.header ?? ''), 40),
          options: (q.options ?? []).slice(0, 8).map((o) => ({ label: clip(String(o.label ?? ''), 60), description: clip(String(o.description ?? ''), 200) })),
          multiple: !!q.multiple, custom: q.custom !== false,
        }));
        const item = { id: p.id, kind: 'question', session, label, questions, at: Date.now() };
        ocAsks.set(p.id, item);
        send('ocask', { ...item, status: 'pending' });
      } else if (['permission.replied', 'question.replied', 'question.rejected'].includes(event.type) && p.requestID) {
        if (ocAsks.delete(p.requestID)) send('ocask', { id: p.requestID, session, status: 'answered' });
      }
    },
    // OpenCode stopped: its requests went with it, so their cards close (answering one would fail).
    onExit() {
      for (const item of ocAsks.values()) send('ocask', { id: item.id, session: item.session, status: 'answered' });
      ocAsks.clear();
    },
  });
  const CHAT_OFF = 'Chat is off. Turn it on in Dashboard → Settings → Chat with your agents.';

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
      if (Date.now() - (entry.at ?? 0) < 60_000) asleep.delete(entry.session);
      maybeCheck(entry);
      checkConflicts(entry);
      groundTruth(entry);
      any = true;
    }
    if (any) history.save();
  }

  // -- Two agents, one file (bridge/guard.js) ------------------------------------------
  // An agent changing a file another active session changed in the last few minutes
  // (Settings: conflictGuard, conflictMinutes). Every agent: a `conflict` event, which the
  // notch shows as an alert and the pal as a notification, once per file and pair of
  // sessions per 10 minutes. Claude Code, before the edit: its PreToolUse hook
  // (bridge/guard-hook.js → POST /hook?guard=1) gets "ask" or "deny" (see guardEdit).
  const asleep = new Set(); // sessions put to sleep (quiet, dismissed or ended), until heard from again
  const conflictAlerts = createAlerts();
  const told = new Map(); // file|pair|that change → when Claude was paused for it (once is enough)
  function conflictOf(session, path, cwd, at = Date.now()) {
    const states = new Map([...sessions].map(([id, u]) => [id, u.state]));
    for (const id of asleep) states.set(id, 'sleeping');
    const cwds = new Map([...sessionMeta].map(([id, m]) => [id, m.cwd]));
    const parents = new Map([...sessionMeta].map(([id, m]) => [id, m.parent]));
    // Any order will do: no copy, no sort of the whole log on the guard's 1.5 s path.
    return findConflict(activity.each(), { session, path, cwd, at, within: (config.conflictMinutes ?? 10) * 60_000, states, cwds, parents });
  }
  function raiseConflict(by, conflict, guard) {
    if (!conflictAlerts.ok({ path: conflict.path, cwd: sessionMeta.get(conflict.session)?.cwd, a: by.session, b: conflict.session })) return;
    send('conflict', {
      id: randomUUID(), at: Date.now(), path: conflict.path,
      session: by.session, harness: by.harness, label: by.label,
      other: { session: conflict.session, harness: conflict.harness, label: conflict.label, at: conflict.at },
      text: alertText(by, conflict), ...(guard ? { guard } : {}),
    });
  }
  /** Any agent's change that's happening now: alert if another active session just changed the same file. */
  function checkConflicts(entry) {
    if (config.conflictGuard === 'off' || !entry.session || entry.guard || entry.status === 'failed' || entry.status === 'stopped') return;
    if (Date.now() - (entry.at ?? 0) > 2 * 60_000) return; // not history read at startup
    // A follow-up that only changes a status (running → ok) was checked when the edit started.
    if (entry.status === 'ok' && entry.startedAt) return;
    for (const f of entry.files ?? []) {
      if (!['edit', 'write', 'delete'].includes(f.change)) continue;
      const conflict = conflictOf(entry.session, f.path, sessionMeta.get(entry.session)?.cwd, entry.at);
      if (conflict) raiseConflict(entry, conflict);
    }
  }
  /**
   * Claude Code is about to change a file (PreToolUse for Edit, Write, MultiEdit,
   * NotebookEdit). On a conflict: 'ask' → Claude Code asks you, with the reason; 'tell' →
   * the edit is denied and Claude reads why, so it re-reads the file first. Once per
   * change of the other session's: the next try goes ahead. The decision is kept on the
   * edit (`guard`), so the story can say "Paused: Codex changed this file 2 minutes ago".
   */
  function guardEdit(event) {
    const mode = config.conflictGuard;
    const tool = event.tool_name;
    const path = event.tool_input?.file_path || event.tool_input?.notebook_path;
    if ((mode !== 'ask' && mode !== 'tell') || !FILE_TOOLS.has(tool) || typeof path !== 'string' || !path) return null;
    const session = String(event.session_id);
    noteSession(session, event.cwd);
    const conflict = conflictOf(session, path, event.cwd);
    if (!conflict) return null;
    const key = `${pathKey(path, event.cwd)}|${session}|${conflict.session}|${conflict.at}`;
    if (told.has(key)) return null;
    told.set(key, Date.now());
    if (told.size > 500) told.delete(told.keys().next().value);
    const reply = guardReply(conflict, mode);
    const now = Date.now();
    const id = event.tool_use_id ? `${session}:${event.tool_use_id}` : `${session}:t:${now}`;
    const label = folderName(event.cwd);
    const guard = { mode, text: `Paused: ${who(conflict)} changed this file ${ago(conflict.at, now)}`, other: { session: conflict.session, harness: conflict.harness, label: conflict.label, at: conflict.at } };
    // 'tell' stops the edit for good (it failed, as far as the story goes); 'ask' waits for you.
    publish([activity.upsert({
      ...(activity.get(id) ? {} : { session, label, harness: 'claude', at: now, tool, ...describeTool(tool, event.tool_input ?? {}, event.cwd), startedAt: now }),
      id, guard,
      ...(mode === 'tell' ? { status: 'failed', error: `dotpals stopped this edit: ${guardReason(conflict, now)}` } : { status: 'running' }),
    })]);
    raiseConflict({ session, harness: 'claude', label }, conflict, mode);
    return reply;
  }

  // -- Double-check unclear test results (bridge/checker.js; off unless you turn it on) --
  // When a test run finishes and the rules can't tell whether it passed, ask Laya or
  // Jev once. The answer goes on the entry as `check` ({ by, state, p, ms } or
  // { by, error }), so every viewer updates. Only fresh runs: not every old run in a
  // transcript read at startup.
  const checker = createChecker({ getConfig: () => config, getKey: checkerKey });
  let sdkInstall = null; // a running "Install it" (npm install @typesafe-ai/sdk)
  function maybeCheck(entry) {
    if (!config.checker || config.checker.mode === 'off' || entry.kind !== 'run' || entry.check || stepType(entry) !== 'test') return;
    if (Date.now() - ((entry.at ?? 0) + (entry.ms ?? 0)) > 15 * 60_000) return;
    checker.check(entry).then((check) => {
      if (check && !activity.get(entry.id)?.check) publish([activity.upsert({ id: entry.id, check })]);
      if (check?.by) noteHealth(check.by, check.error ? { ok: false, error: check.error } : { ok: true, ms: check.ms });
    }, () => {});
  }

  // -- What git says changed (bridge/ground.js) -----------------------------------------------
  // A snapshot of the session's repository when a request starts, compared when it ends:
  // the files it really changed, also through commands. Goes on the request's `done` entry
  // as `git`: { files, more, committed, tooMany?, others }, `others` being the other
  // sessions that were active in the same repository meanwhile (their changes show too).
  // Only live requests: there's no "before" for one read from a transcript later.
  const ground = createGround();
  const groundPrompt = new Map(); // session → the prompt its snapshot is for
  const normDir = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  function othersIn(root, session, since) {
    const r = normDir(root);
    const seen = new Map();
    for (const e of activity.each()) {
      if (e.session === session || e.at < since || seen.has(e.session)) continue;
      const m = sessionMeta.get(e.session);
      if (m?.parent === session) continue; // its own helper
      const d = normDir(m?.cwd);
      if (d && (d === r || d.startsWith(`${r}/`) || r.startsWith(`${d}/`))) seen.set(e.session, { session: e.session, harness: e.harness, label: e.label });
    }
    return [...seen.values()];
  }
  function groundTruth(entry) {
    if (Date.now() - (entry.at ?? 0) > 60_000) return;
    const cwd = sessionMeta.get(entry.session)?.cwd;
    if (!cwd) return;
    if (entry.kind === 'prompt' && groundPrompt.get(entry.session) !== entry.id) {
      groundPrompt.set(entry.session, entry.id);
      ground.start(entry.session, cwd, entry.at);
    } else if ((entry.kind === 'done' || entry.kind === 'error') && !entry.git && ground.has(entry.session)) {
      ground.finish(entry.session, cwd).then((changes) => {
        if (!changes || activity.get(entry.id)?.git) return;
        const git = { files: changes.files.slice(0, 300), more: Math.max(0, changes.files.length - 300), committed: changes.committed, others: othersIn(changes.root, entry.session, changes.since) };
        if (changes.tooMany) git.tooMany = true;
        publish([activity.upsert({ id: entry.id, git })]);
      }, () => {});
    }
  }

  // -- Is the checker working? -------------------------------------------------------------
  // Its answers, its errors, Test connection and a heartbeat (on start, when the setting
  // changes, then every 30 minutes; for Jev that's the free model list) all update one
  // status, which rides along in the settings as checker.health:
  //   { by, state: 'working' | 'failing' | 'unknown', okAt, okMs, errorAt, error, failingSince, heartbeatAt }
  const HEARTBEAT_MS = 30 * 60_000;
  const freshHealth = (by = null) => ({ by, state: 'unknown', okAt: null, okMs: null, errorAt: null, error: null, failingSince: null, heartbeatAt: null });
  let health = freshHealth();
  function noteHealth(by, result) {
    if (health.by !== by) health = freshHealth(by);
    const now = Date.now();
    if (result.ok) Object.assign(health, { state: 'working', okAt: now, okMs: result.ms ?? null, error: null, failingSince: null });
    else Object.assign(health, { state: 'failing', errorAt: now, error: result.error ?? 'no answer', failingSince: health.failingSince ?? now });
    send('config', withLaya());
  }
  async function heartbeat() {
    const mode = config.checker?.mode;
    if (!mode || mode === 'off') { if (health.by) { health = freshHealth(); send('config', withLaya()); } return; }
    const r = await checker.test(mode).catch(() => null);
    if (!r?.by) return;
    noteHealth(r.by, r);
    health.heartbeatAt = Date.now();
  }
  const firstBeat = setTimeout(() => heartbeat(), 15_000);
  const beat = setInterval(() => heartbeat(), HEARTBEAT_MS);
  firstBeat.unref?.();
  beat.unref?.();

  // -- Laya on this computer, set up by dotpals (bridge/laya.js) ----------------------
  // Runs while the checker is on Local and dotpals set it up (checker.layaManaged), on the
  // port in checker.localUrl. Stopped when you choose something else, and when the bridge
  // closes. Its status rides along in the settings (checker.laya) and as `laya` events.
  const laya = createLaya({ getUrl: () => config.checker?.localUrl, ...layaOptions });
  laya.subscribe((s) => send('laya', s));
  const withLaya = () => ({ ...config, checker: { ...config.checker, laya: laya.status(), health } });
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
    if (next.state === 'sleeping') { sessions.delete(session); contexts.delete(session); helpers.delete(session); if (!test) asleep.add(session); }
    else { sessions.set(session, update); asleep.delete(session); }
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
    noteSession(session, event.cwd);
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
      cwd: (session, cwd) => noteSession(session, cwd),
    });
  }

  // -- Generic: any harness ------------------------------------------------------
  //   { session, harness?, label?, state?, text?, activity?: {...} | [...] }
  function genericEvent(event) {
    const session = String(event.session_id ?? event.session ?? 'default');
    const harness = event.harness ? clip(event.harness, 30) : undefined;
    const label = event.label ?? folderName(event.cwd);
    noteSession(session, typeof event.cwd === 'string' ? event.cwd : undefined);
    const items = Array.isArray(event.activity) ? event.activity : event.activity ? [event.activity] : [];
    let n = 0;
    publish(items.map((a) => {
      if (!a || typeof a !== 'object') return null;
      const id = `${session}:${a.id ?? `g${Date.now()}-${n++}`}`;
      // Follow-ups (same id) only change what they send; new rows get defaults.
      const known = activity.get(id);
      // Long output keeps its start and its end (where test summaries are).
      const body = a.body && typeof a.body === 'object' && typeof a.body.output === 'string' ? { ...a.body, output: clipEnds(a.body.output, 3000) } : a.body;
      // Only well-formed files: everything downstream reads `file.path` and `file.change`.
      const files = Array.isArray(a.files)
        ? a.files.filter((f) => f && typeof f === 'object' && typeof f.path === 'string' && f.path).map((f) => ({ path: f.path.slice(0, 1000), change: CHANGES.has(f.change) ? f.change : 'edit' }))
        : undefined;
      return activity.upsert({
        ...a,
        body,
        files,
        check: undefined, // only the bridge's own checker says this
        git: undefined, // and only the bridge says what git saw

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
    const cwd = [event.cwd, event.workspace_roots?.[0], event.directory].find((x) => typeof x === 'string' && x);
    if (session) noteSession(session, cwd);
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
        cwd: (session, cwd, parent) => noteSession(session, cwd, parent),
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
      desktop: { pal: [...windows.values()].includes('pal'), notch: [...windows.values()].includes('notch') },
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
    // Chat: project folders the agents worked in, newest first, for the
    // morning greeting's "which project?" list.
    if (req.method === 'GET' && path === '/api/chat/projects') {
      if (!config.chat) return json(res, 409, { error: CHAT_OFF });
      const seen = new Set();
      const projects = [];
      const all = activity.all();
      for (let i = all.length - 1; i >= 0 && projects.length < 8; i--) {
        const cwd = sessionMeta.get(all[i].session)?.cwd;
        if (!cwd || seen.has(cwd.toLowerCase())) continue;
        seen.add(cwd.toLowerCase());
        const name = folderName(cwd);
        // Skip drive roots ("/", "C:\"), folders that are gone and anything without a name.
        if (name && !/^([a-z]:)?[\\/]*$/i.test(cwd) && isFolder(cwd)) projects.push({ path: cwd, name });
      }
      return json(res, 200, { projects });
    }
    if (req.method === 'GET' && path === '/api/handoff/agents') return json(res, 200, { agents: installedAgents({ has: handoffOptions.has ?? onPath }) });

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
      if (before.chat && !config.chat) chat.stop(); // turned off: no OpenCode server left running
      // A different checker (or a new key): check it's answering, right away.
      if (before.checker?.mode !== config.checker?.mode || before.checker?.keyLast4 !== config.checker?.keyLast4 || before.checker?.localUrl !== config.checker?.localUrl) heartbeat();
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
      const result = await checker.test(['local', 'cloud'].includes(mode) ? mode : undefined);
      if (result.by) noteHealth(result.by, result);
      return json(res, 200, result);
    }
    // "Install it", when Test connection finds the TypeSafe SDK missing: one npm install at a time.
    if (path === '/api/checker/jev/install') {
      sdkInstall ??= installTheSdk().finally(() => { sdkInstall = null; });
      return json(res, 200, await sdkInstall);
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
    if (path === '/api/handoff') return handoff(req, res);
    // Chat (bridge/chat.js): a prompt typed in the pal goes to OpenCode.
    // { text, session? ('opencode:ses_…' to continue it), directory? (for a new one) }
    // Answer an OpenCode permission request or question from the pal.
    // { id, reply: 'once' | 'always' | 'reject' } or { id, answers: [[label…]…] | null }
    if (path === '/api/chat/answer') {
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) return json(res, 403, { error: 'forbidden' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const item = typeof body?.id === 'string' ? ocAsks.get(body.id) : null;
      if (!item) return json(res, 404, { error: 'That request has already been answered' });
      const directory = sessionMeta.get(item.session)?.cwd;
      try {
        if (item.kind === 'permission') {
          if (!['once', 'always', 'reject'].includes(body.reply)) return json(res, 400, { error: 'reply must be once, always or reject' });
          await chat.replyPermission({ id: item.id, reply: body.reply, directory });
        } else {
          const answers = body.answers === null ? null
            : Array.isArray(body.answers) && body.answers.length === item.questions.length && body.answers.every((a) => Array.isArray(a) && a.length <= 8 && a.every((s) => typeof s === 'string' && s.length <= 2000))
              ? body.answers : undefined;
          if (answers === undefined) return json(res, 400, { error: 'answers must be one list of choices per question' });
          await chat.replyQuestion({ id: item.id, answers, directory });
        }
        ocAsks.delete(item.id);
        send('ocask', { id: item.id, session: item.session, status: 'answered' });
        return json(res, 200, { ok: true });
      } catch (err) {
        return json(res, 502, { error: err.message });
      }
    }
    if (path === '/api/chat' || path === '/api/chat/abort') {
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) return json(res, 403, { error: 'forbidden' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const session = typeof body?.session === 'string' && /^opencode:ses[\w-]{1,120}$/.test(body.session) ? body.session : null;
      const sessionID = session?.slice('opencode:'.length);
      // A session's folder comes from its own events; a new one may name an existing folder.
      const directory = (session && sessionMeta.get(session)?.cwd) || (typeof body?.directory === 'string' && isFolder(body.directory) ? body.directory : homedir());
      try {
        if (path === '/api/chat/abort') {
          if (!sessionID) return json(res, 400, { error: 'session must be an OpenCode session' });
          return json(res, 200, { ok: await chat.abort({ sessionID, directory }) });
        }
        // Stopping work and answering cards always work; only starting it needs chat on.
        if (!config.chat) return json(res, 409, { error: CHAT_OFF });
        const text = typeof body?.text === 'string' ? body.text.trim() : '';
        if (!text) return json(res, 400, { error: 'Type something first' });
        if (text.length > 20_000) return json(res, 400, { error: 'That message is too long' });
        const sent = await chat.send({ text, sessionID, directory });
        // Known before its first event: the session's folder (labels, follow-ups, the projects list).
        noteSession(sent.session, directory);
        return json(res, 200, { ok: true, directory, ...sent });
      } catch (err) {
        return json(res, 502, { error: err.message });
      }
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
    // `dotpals setup` / `dotpals update`: quit the running desktop app so a newer install can start.
    if (path === '/api/app/quit') {
      if (!onQuit) return json(res, 409, { error: 'This bridge isn’t the desktop app' });
      json(res, 200, { ok: true, version });
      setTimeout(() => { try { onQuit(); } catch {} }, 150);
      return;
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

  // -- Hand-off: continue a session in another agent (bridge/handoff.js) -------------------
  // { session, agent: 'codex' | 'claude' | 'gemini' } writes the note and opens that agent in
  // a new terminal, in the folder the session itself worked in (never one from the request).
  // { agent: 'copy' } only returns the note. Failures still return the note, to copy instead.
  async function handoff(req, res) {
    // Starts a program: only this bridge's own pages (or no page at all) may ask.
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) return json(res, 403, { error: 'forbidden' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const agent = body?.agent;
    if (agent !== 'copy' && !Object.hasOwn(HANDOFF_AGENTS, agent)) return json(res, 400, { error: `agent must be one of: ${Object.keys(HANDOFF_AGENTS).join(', ')}, copy` });
    const session = typeof body?.session === 'string' ? body.session : '';
    if (!session || !activity.has(session)) return json(res, 404, { error: 'dotpals has no record of that session' });
    const cwd = sessionMeta.get(session)?.cwd;
    const note = handoffNote(activity.all(), { session, cwd });
    if (agent === 'copy') return json(res, 200, { ok: true, note });
    const has = handoffOptions.has ?? onPath;
    const name = HANDOFF_AGENTS[agent].name;
    if (!has(HANDOFF_AGENTS[agent].command)) return json(res, 400, { error: `${name} isn’t installed here (not found on PATH). Use Copy instead.`, note });
    if (!(handoffOptions.isFolder ?? isFolder)(cwd)) return json(res, 409, { error: 'dotpals doesn’t know this session’s project folder (or it’s gone). Use Copy instead.', note });
    let file;
    try { file = await saveNote(note); } catch (err) { return json(res, 500, { error: `Couldn’t save the note: ${err.message}`, note }); }
    const command = launchCommand({ platform: handoffOptions.platform ?? process.platform, agent, dir: cwd, prompt: handoffPrompt(file), has });
    if (command.error) return json(res, 409, { error: command.error, note, file });
    try { await (handoffOptions.launch ?? launch)(command); } catch (err) { return json(res, 500, { error: `Couldn’t open a terminal: ${err.message}. Use Copy instead.`, note, file }); }
    return json(res, 200, { ok: true, agent, name, dir: cwd, file, note });
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
        if (url.pathname === '/hook' && url.searchParams.get('guard') === '1') {
          // bridge/guard-hook.js: only the conflict check (bridge/hook.js reports the activity).
          if (event.hook_event_name === 'PreToolUse' && event.session_id && enabled('claude')) reply = guardEdit(event);
        } else {
          const update = await handleEvent(event, url.searchParams.get('agent'));
          if (update) print(`${new Date().toLocaleTimeString()}  ${update.label ?? update.session.slice(0, 8)}  ${update.state}${update.text ? `  "${update.text}"` : ''}`);
          if (url.pathname === '/hook' && !url.searchParams.get('agent') && event.hook_event_name === 'PermissionRequest' && event.session_id) reply = await askApproval(event, req);
        }
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
      for (const item of ocAsks.values()) res.write(`event: ocask\ndata: ${JSON.stringify({ ...item, status: 'pending' })}\n\n`);
      // Everything saved has been replayed: viewers can render once now instead of per entry.
      res.write('event: ready\ndata: {}\n\n');
      clients.add(res);
      if (url.searchParams.get('answers') === '1') answerers.add(res);
      const kind = url.searchParams.get('window');
      if (kind === 'pal' || kind === 'notch') windows.set(res, kind);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
        answerers.delete(res);
        windows.delete(res);
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
  // Keep idle connections open longer than a client does (Node's fetch drops its own after
  // 4 s), so a client never reuses one this end is just closing ("fetch failed").
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.on('close', () => { chat.stop(); stopWatchers(); clearInterval(reaper); clearTimeout(firstBeat); clearInterval(beat); laya.stop().catch(() => {}); });

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
  // Run on its own (by a hook, or setup without the desktop app), it quits when setup asks, so the pal can take over.
  startBridge({ onQuit: () => process.exit(0) }).catch((err) => {
    console.error(err.code === 'EADDRINUSE' ? 'The dotpals bridge is already running.' : err.message);
    process.exit(err.code === 'EADDRINUSE' ? 0 : 1);
  });
}
