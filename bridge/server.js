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
//                            loop:     Claude was told its tests failed, or sent back to fix them (see "the fix loop"):
//                                      { id, at, session, harness, label, kind: 'told' | 'sent-back' | 'blocked-ship' | 'gave-up' | 'fixed', text }
//                            stuck:    a request going round in circles (Settings: stuckAlerts), once per request and reason:
//                                      { id, at, session, harness, label, kind: 'repeat' | 'flip' | 'quiet', text, step }
//   GET  /               → the pal page
//   GET  /dashboard      → sessions, logs, stats and settings
//   GET  /api/activity   → { entries }
//   GET  /api/sessions   → { sessions: [{ id, cwd, parent, label, harness }] } where each session with
//                          activity works (its project folder), for `dotpals mcp`; null when not known
//   GET  /api/loop       → { events } what the fix loop did (`loop` events, kept in history; ?session=<id> for one)
//   GET  /api/git?session=<id> → { branch, head, changed: [paths], more } the session's repository right now
//                          (uncommitted files included), for `dotpals mcp`; {} when it isn't one
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
//   POST /hook?loop=1    Claude Code's test runs, Stop and commits (bridge/loop-hook.js): tests failing? →
//                        a note for Claude, "block" or "deny", else {} (Settings → fixLoop)
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
//   GET  /api/talk/projects          → { projects, claude } the folders a task can go to; is Claude Code installed
//   GET  /api/talk/tasks             → { tasks } the tasks so far, newest first (also `task` events as they change)
//   POST /api/talk/plan { text, project?, pal?, shot? }   your words → { plan } with a definition of done (bridge/tasks.js),
//                        or { reply } when it was just talk (what the pal, named `pal`, says back). Planned by
//                        Blu's brain; `shot`: { path, x, y }, a screenshot under ~/.dotpals/shots as you spoke
//   POST /api/talk/buddy { text, shot?, circled?, history?, pal? }   Blu looks at your screen (bridge/buddy.js) →
//                        { say, draw, do, task, clear, keep, words, by, ms, saw }: what to say, the marks to draw
//                        (screenshot pixels), the actions to do (desktop/hands.js), work for an agent
//   GET  /api/shortcuts              → { pal, talk, dictate, circle, platform } the desktop app's shortcuts that work now
//   GET  /api/apps                   → { connected, signIn, mine, claude, presets } your apps: connected to dotpals
//                        (bridge/connectors.js), and the ones Claude Code is connected to
//   POST /api/apps/add { name, url? | command? | preset?, clientId?, clientSecret? }, /api/apps/remove { id },
//        /api/apps/signin { id } → { url } (sign in in your browser; back at GET /api/apps/callback), /api/apps/check { id }
//   POST /api/talk/apps { app, ask, change?, confirmed? }   → { say, calls } Blu's brain looks (or, said yes to, does one
//                        thing) in that app: yours with any AI that can use tools, Claude's through Claude Code
//   GET  /api/brain                  → { brains, quick, plan, screen, brain, keys, apps } the AIs here, which ones each job uses,
//                        the settings, and which API keys are saved (their last 4 characters)
//   POST /api/brain/polish { text }  → { text, by?, ms?, error? } dictation, cleaned up by Blu's brain (your text
//                        back as it was when that's off, there's no AI, or it fails)
//   POST /api/brain/test { id }      → { ok, by, ms } or { ok: false, error } is that brain working?
//   POST /api/talk/start { id, title?, task?, done?, project? }   start Claude Code on it in a new terminal
//   POST /api/talk/fix { id }        → { text } a request for the agent to fix what isn't done (to paste)
//   POST /api/talk/pr/plan { id }    → { pr } what opening a PR would do; POST /api/talk/pr/open { id } does it
//   (every POST under /api needs the `x-dotpals: 1` header)
//
//   node bridge/server.js            (PORT=5175 by default)
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toAgentState } from '../src/agent.js';
import { clip, clipEnds, createActivityLog, folderName, trimActivity } from './activity.js';
import { applyHook, backfillTranscript, describeTool, failureText, lastReply, resultText, watchClaude } from './adapters/claude.js';
import { failureReason } from './ui/testout.js';
import { changedCode, checkOf, isTestFile, onlyOldFailures, parts, ships, weakenedTests, contextEntries, crossRecap, list as nameList, flags as riskFlags, stepType, stuck as findStuck, testEvidence, testState, testVerdict } from './ui/story.js';
import { baseName, buildTurns, sentence } from './ui/recap.js';
import { findRules, forbids, ruleChecks, ruleRelative } from './rules.js';
import { ADAPTERS, adapter } from './adapters/index.js';
import { createChecker, installSdk } from './checker.js';
import { createLaya } from './laya.js';
import { brainKeys, checkerKey, configPath, home, loadConfig, saveConfig, validKey } from './config.js';
import { ask, askApps, askWithTools, brainsHere, correcting, isQuick, pickBrain, polished, polishSystem, warmUp } from './brain.js';
import { PRESETS, createConnectors, never, readOnly } from './connectors.js';
import { actionWords, agentApps, appsSystem, appTools, buddyInput, buddySystem, parseBuddyReply, resolvePlay, saidYesTo } from './buddy.js';
import { yourWords } from './ui/dictation.js';
import { FILE_TOOLS, ago, alertText, createAlerts, findConflict, guardReason, guardReply, pathKey, who } from './guard.js';
import { HANDOFF_AGENTS, findOnPath, handoffPrompt, installedAgents, isFolder, launch, launchCommand, onPath, saveNote } from './handoff.js';
import { handoffNote } from './ui/handoff.js';
import { claudeContextSize, readUsage } from './usage.js';
import { checkpoint, createGround, restoreFiles, rewindPlan, runGit, snapshot, testDiff, treeChanges } from './ground.js';
import { createChat } from './chat.js';
import { agentEnv, askPlanner, claudeTaskArgs, createTaskList, doneItem, evaluate, fixRequest, knownProjects, makePlan, newSessionId, openPr, prPlan, receiptMarkdown, run, saveTask, taskMarkdown, taskPrompt, verdictWords } from './tasks.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = (() => { try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } })();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png' };
const KINDS = new Set(['prompt', 'read', 'edit', 'write', 'run', 'search', 'web', 'agent', 'mcp', 'skill', 'plan', 'tool', 'done', 'error', 'compact']);
const STATUSES = new Set(['running', 'waiting', 'ok', 'failed', 'stopped', 'info']);
const CHANGES = new Set(['read', 'edit', 'write', 'delete']);
const DAY = 86_400_000;

/**
 * Activity history on disk (~/.dotpals/history.json), so the Summary, Files and
 * dashboard survive restarts. Keeps `historyDays` (default 7), at most 5000 entries,
 * and the fix loop's `loop` events (`loops`, an array the server keeps capped).
 */
function createHistory(activity, getConfig, meta = { get: () => ({}), set: () => {} }, loops = []) {
  const file = () => join(home(), 'history.json');
  const keep = () => getConfig().historyDays * DAY;
  if (getConfig().history) {
    try {
      const { entries = [], sessions = {}, loop = [] } = JSON.parse(readFileSync(file(), 'utf8'));
      meta.set(sessions);
      loops.push(...loop.filter((e) => e?.id && e.session && Date.now() - e.at <= keep()));
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
            const loop = loops.filter((e) => Date.now() - e.at < keep());
            await writeFile(`${file()}.tmp`, JSON.stringify({ version: 1, entries, sessions, loop }));
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
  const loopEvents = []; // the fix loop's `loop` events, newest last (the last LOOP_KEEP), kept in history: GET /api/loop
  const history = createHistory(activity, () => config, {
    get: () => Object.fromEntries(sessionMeta),
    set: (saved) => { for (const [id, m] of Object.entries(saved ?? {})) noteSession(id, m?.cwd, m?.parent); },
  }, loopEvents);
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
      snapTests(entry);
      checkConflicts(entry);
      if (entry.status === 'failed' || entry.kind === 'run' || (entry.kind === 'edit' && entry.status === 'ok')) checkStuck(entry.session);
      groundTruth(entry);
      taskNews(entry);
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
  // -- "It's stuck" (Settings: stuckAlerts, on by default) ---------------------------
  // A request that keeps failing at the same thing, or where nothing has worked for a
  // while: a `stuck` event, once per request and reason. Any agent. Checked when a step
  // comes in, and every minute (for "nothing has worked for 10 minutes").
  const stuckSent = new Map(); // session → Set of reasons already told for its current request
  function checkStuck(session, now = Date.now()) {
    if (!config.stuckAlerts || !session || asleep.has(session)) return;
    const prompt = activity.findLast(session, (e) => e.kind === 'prompt');
    const steps = [];
    for (const e of activity.each()) if (e.session === session && (!prompt || e.at >= prompt.at) && e !== prompt) steps.push(e);
    const s = findStuck(steps, { now, from: prompt?.at });
    if (!s || now - (s.step?.at ?? 0) > 15 * 60_000) return; // not history read at startup
    const told = stuckSent.get(session) ?? new Set();
    const key = `${prompt?.id ?? ''}|${s.kind === 'quiet' ? 'quiet' : s.key}`;
    if (told.has(key)) return;
    told.add(key);
    stuckSent.set(session, told);
    const e = s.step ?? {};
    send('stuck', { id: randomUUID(), at: now, session, harness: e.harness, label: e.label, kind: s.kind, text: s.text, step: e.id });
  }
  const stuckTimer = setInterval(() => { for (const session of sessions.keys()) checkStuck(session); }, 60_000);
  stuckTimer.unref?.();

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
  // Git's view of the test files at each test run that just ended, any agent (testDiff in
  // bridge/ground.js): the faked-pass check (weakenedTests) compares two runs' views, so it sees
  // how the tests changed in between however it was done (an edit tool, sed, a script). Not for
  // runs read from a transcript later: git has moved on since.
  const testDiffing = new Set();
  function snapTests(entry) {
    if (entry.kind !== 'run' || !['ok', 'failed'].includes(entry.status) || entry.body?.testDiff !== undefined || testDiffing.has(entry.id)) return;
    if (stepType(entry) !== 'test' || Date.now() - ((entry.at ?? 0) + (entry.ms ?? 0)) > 60_000) return;
    const cwd = sessionMeta.get(entry.session)?.cwd;
    if (!cwd) return;
    testDiffing.add(entry.id);
    testDiff(cwd, isTestFile).then((diff) => {
      testDiffing.delete(entry.id);
      const now = activity.get(entry.id);
      if (diff && now && now.body?.testDiff === undefined) publish([activity.upsert({ id: entry.id, body: { ...now.body, testDiff: diff } })]);
    }, () => testDiffing.delete(entry.id));
  }

  function maybeCheck(entry) {
    if (!config.checker || config.checker.mode === 'off' || entry.kind !== 'run' || entry.check || stepType(entry) !== 'test') return;
    if (Date.now() - ((entry.at ?? 0) + (entry.ms ?? 0)) > 15 * 60_000) return;
    checker.check(entry).then((check) => {
      if (check && !activity.get(entry.id)?.check) publish([activity.upsert({ id: entry.id, check })]);
      if (check?.by) noteHealth(check.by, check.error ? { ok: false, error: check.error } : { ok: true, ms: check.ms });
    }, () => {});
  }

  // -- The fix loop: make Claude Code fix failing tests (Settings: fixLoop, on by default) ------
  // bridge/loop-hook.js asks here (POST /hook?loop=1) in the foreground, for three hooks:
  //   a test run just ended (PostToolUse, PostToolUseFailure): failed → Claude is told right
  //     away, as context. Unclear → the checker is asked first, when one is on.
  //   Claude tries to finish (Stop) or to commit or push (PreToolUse): while this request's
  //     tests fail, or weren't run after its last change, it's sent back with what to do.
  //     Finishing is only held up when this request changed code: one that only runs the
  //     tests (or says not to change code) may report a failure and stop.
  // At most twice per request (the count starts again with your next prompt), then it's let go
  // and you're told. Untested work is never held up: not every project has tests. Each step
  // is a `loop` event, which the pal says and the notch shows.
  //   A test run whose result can't be read (piped, cut off) and the checker didn't settle:
  //     Claude is asked to run the tests again so the output shows it. A second one in the
  //     same request, or stopping without a clear run, goes to you ("Please take a look").
  const LOOP_MAX = 2;
  const LOOP_KEEP = 500;
  const loopBlocks = new Map(); // session → times it was sent back in this request
  const loopHelped = new Set(); // sessions told or sent back, until a test run passes ("Fixed")
  const loopUnclear = new Map(); // session → { n: unreadable test runs in this request, why: what's known about the last }
  const loopAsked = new Set(); // sessions whose request went to you
  const loopBluff = new Map(); // session → { text, sentBack }: tests made to pass by changing them, in this request
  function sendLoop(session, label, kind, text) {
    if (kind === 'fixed' || kind === 'bluff') loopHelped.delete(session);
    else if (kind !== 'retry' && kind !== 'ask-you') loopHelped.add(session);
    const event = { id: randomUUID(), at: Date.now(), session, harness: 'claude', label, kind, text };
    loopEvents.push(event);
    loopEvents.splice(0, loopEvents.length - LOOP_KEEP);
    send('loop', event);
    history.save();
  }
  function askYou(session, label) {
    if (loopAsked.has(session)) return;
    loopAsked.add(session);
    const why = loopUnclear.get(session)?.why;
    sendLoop(session, label, 'ask-you', `Couldn’t tell whether Claude’s tests passed${why ? `: ${why}` : ''}. Please take a look.`);
  }
  const loopNote = (event, text) => ({ hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: text } });
  /** A test run nobody could read: run it again so it shows; the second time, it's yours to look at. */
  function unclearRun(event, session, label, step, v, check) {
    const n = (loopUnclear.get(session)?.n ?? 0) + 1;
    const unsure = typeof check?.p === 'number' ? `${checkerName(checkOf({ check }).who)} wasn’t sure either (${Math.round(check.p * 100)}% that they passed)` : '';
    // For you, if it comes to that: what ran, why it can't be read, and what the checker thought.
    loopUnclear.set(session, { n, why: `\`${clip(step.body?.command ?? '', 80)}\`: ${v.note ?? 'its output doesn’t show the result'}${unsure ? `, and ${unsure}` : ''}` });
    if (n === 1) {
      sendLoop(session, label, 'retry', 'Couldn’t tell if the tests passed. Asked Claude to run them again.');
      return loopNote(event, `dotpals: can’t tell whether this test run passed: ${v.note ?? 'its output doesn’t show the result'}.${unsure ? ` ${unsure}.` : ''} Run the tests again without cutting their output (no | tail, head or grep), so the counts and the exit code show.`);
    }
    if (n > 2) return null;
    askYou(session, label);
    return loopNote(event, 'dotpals: still can’t tell whether the tests passed, so it asked the user to take a look. Tell them what you ran and what you saw.');
  }
  /** Every step of a session, all its requests: what was failing before it changed anything (failingBefore). */
  function sessionSteps(session) {
    const steps = [];
    for (const e of activity.each()) if (e.session === session && e.kind !== 'prompt') steps.push(e);
    return steps;
  }
  // "Jev (dotpals' cloud test checker)": the name alone means nothing to an agent, or to you.
  const checkerName = (who) => `${who} (dotpals’ ${who === 'Jev' ? 'cloud' : 'local'} test checker)`;
  /** The steps of the request a session is on (since its newest prompt). */
  function turnSteps(session) {
    const start = activity.findLast(session, (e) => e.kind === 'prompt')?.at ?? 0;
    const steps = [];
    for (const e of activity.each()) if (e.session === session && e.at >= start && e.kind !== 'prompt') steps.push(e);
    return steps;
  }
  /**
   * A request's steps for the bluff rule (weakenedTests), with the session's last test run before
   * it when that run failed: changing that test in this request is the bluff too. Only this
   * request's edits count, so one already told about isn't told again.
   */
  function bluffSteps(session) {
    const start = activity.findLast(session, (e) => e.kind === 'prompt')?.at ?? 0;
    const before = activity.findLast(session, (e) => e.at < start && e.kind === 'run' && stepType(e) === 'test' && e.status !== 'running');
    return before && testVerdict(before).state === 'failed' ? [before, ...turnSteps(session)] : turnSteps(session);
  }
  // "3 failed, 5 passed: sum adds", "checked by Jev, 80% sure", or the exit code's word.
  const failedWords = (v) => (v.source === 'exit' ? 'the command exited with an error' : testEvidence(v));
  // Why the first test failed, from the run's output: "expected 3, got -1 (test/math.test.js:5)", or ''.
  const failedWhy = (step) => { const r = failureReason(`${step?.body?.output ?? ''}\n${step?.error ?? ''}`); return r ? `${r.why}${r.where ? ` (${r.where})` : ''}` : ''; };
  /** How this session last ran its tests, without a pipe or redirect (`npm test`), if it ever did. */
  function sessionTestCommand(session) {
    const run = activity.findLast(session, (e) => e.kind === 'run' && stepType(e) === 'test');
    const part = run && parts(String(run.body?.command ?? '')).find((p) => stepType({ kind: 'run', body: { command: p } }) === 'test');
    return part ? part.replace(/\s+\d?>>?&?\s*\S+/g, '').trim() : null;
  }
  /**
   * What's wrong with this request's tests, if it's worth sending Claude back: failing, or not
   * run since the last change. When finishing, also: code changed and no tests run at all, in a
   * session that has run them before (so the project has tests, and that's how).
   */
  function testTrouble(session, stopping = false) {
    const t = testState(turnSteps(session));
    const files = () => nameList([...new Set(t.since.map(baseName))]);
    // Only the failures this session caused hold it back (failingBefore): ones it found are told, not forced.
    if (t?.state === 'failing') return onlyOldFailures(t.last, sessionSteps(session)) ? null : { failing: true, words: failedWords(t.verdict), why: failedWhy(t.last) };
    if (t?.state === 'stale') return { failing: false, words: files() };
    const command = stopping && t?.state === 'untested' && sessionTestCommand(session);
    if (command) return { failing: false, untested: true, command, words: files() };
    return null;
  }

  /** A test run just ended: judged from the hook's own event (the activity hook may not have reported it yet). */
  async function loopTestRun(event, session, label) {
    if (event.is_interrupt) return null; // you stopped it
    const tool = event.tool_name;
    const ok = event.hook_event_name === 'PostToolUse';
    // The step bridge/adapters/claude.js (applyHook) records, with the same id, so the checker asks once.
    const d = describeTool(tool, event.tool_input ?? {}, event.cwd);
    // A failed command's output comes with its error: the counts and the reason are in it.
    const output = resultText(tool, event.tool_response) ?? (!ok ? failureText(event.error) : undefined);
    const step = {
      ...d, id: `${session}:${event.tool_use_id}`, session, tool, status: ok ? 'ok' : 'failed',
      body: { ...d.body, ...(output ? { output } : {}) },
      ...(!ok && event.error ? { error: clip(typeof event.error === 'string' ? event.error : event.error.message, 300) } : {}),
    };
    if (stepType(step) !== 'test') return null;
    let v = testVerdict(step);
    let checked = null;
    let check = null;
    if (v.state === 'unclear' && config.checker?.mode && config.checker.mode !== 'off') {
      check = await checker.check(step).catch(() => null);
      if (check?.state === 'passed' || check?.state === 'failed') { v = testVerdict({ ...step, check }); checked = checkOf({ ...step, check }); }
    }
    if (v.state === 'unclear' && v.reason !== 'no-tests') return unclearRun(event, session, label, step, v, check);
    if (v.state === 'passed') {
      // Green, but because the tests were changed, not the code: the bluff. Claude is told, the pal
      // tells you. Git's view of the tests now goes with this run, as snapTests gives the others.
      const diff = await testDiff(sessionMeta.get(session)?.cwd ?? event.cwd, isTestFile).catch(() => null);
      const weak = weakenedTests([...bluffSteps(session).filter((e) => e.id !== step.id), { ...step, at: Date.now(), body: { ...step.body, ...(diff ? { testDiff: diff } : {}) } }]);
      if (weak && !loopBluff.has(session)) {
        loopBluff.set(session, { text: weak.text, sentBack: false });
        sendLoop(session, label, 'bluff', `Claude changed the tests to make them pass: ${weak.text}.`);
        return loopNote(event, `dotpals: the tests pass now, but only after you changed them: ${weak.text}. Don’t weaken a test to make it pass: put it back and fix the code, or tell the user why the test itself was wrong.`);
      }
      // The test is back as it was, and it passes: the real fix.
      if (!weak && loopBluff.has(session)) { loopBluff.delete(session); sendLoop(session, label, 'fixed', 'Fixed: the test is back and passes now ✓'); }
      else if (loopHelped.has(session)) sendLoop(session, label, 'fixed', 'Fixed: tests pass now ✓');
    }
    if (v.state !== 'failed') return null;
    // Failing before this session changed anything (failingBefore): found, not caused, so told, not
    // sent back. Claude's own change broke them: fix it. Nothing changed yet: maybe this request
    // only asked how the tests stand.
    const old = !checked && onlyOldFailures(step, [...sessionSteps(session).filter((e) => e.id !== step.id), { ...step, at: Date.now() }]);
    const mine = !old && changedCode(turnSteps(session));
    const why = failedWhy(step);
    sendLoop(session, label, 'told', `${checked ? `${checked.who} thinks the tests failed` : `Tests failed (${failedWords(v)})`}${why ? `: ${why}` : ''}.${old ? ' They were failing before Claude changed anything.' : mine ? ' Told Claude to fix them.' : ''}`);
    const what = checked ? `${checkerName(checked.who)} thinks this test run failed (${checked.sure}% sure)` : `this test run failed (${failedWords(v)})`;
    const next = old ? 'These tests were failing before this session changed anything, so they aren’t yours to fix unless the user asks: mention them to the user.'
      : mine ? 'Fix it before you finish; dotpals checks again when you stop.' : 'If fixing it is part of this request, fix it and run the tests again.';
    return loopNote(event, `dotpals: ${what}${why ? `: ${why}` : ''}. ${next}`);
  }

  /** Claude is about to stop (Stop) or to commit or push (PreToolUse): send it back while the tests fail or are out of date. */
  async function loopGate(event, session, label) {
    const stopping = event.hook_event_name === 'Stop';
    const d = stopping ? null : describeTool(event.tool_name, event.tool_input ?? {}, event.cwd);
    // Only what puts the work in front of others (a commit, a push, a PR, a publish), even from inside
    // an `if` or after a `;`; not a rebase, merge or tag, which may be how Claude fixes things, and not
    // `npm test && git commit`, which only commits when the tests pass (story.js ships).
    if (d && !ships(d.body?.command ?? '')) return null;
    // The activity hook reports the last steps alongside: give it a moment to finish them.
    for (let i = 0; stopping && i < 10 && turnSteps(session).some((e) => e.status === 'running'); i++) await new Promise((r) => setTimeout(r, 100));
    // Asked to run unreadable tests again, and stopping without a clear result: you're asked to look.
    if (stopping && loopUnclear.has(session) && testState(turnSteps(session))?.state === 'unclear') askYou(session, label);
    // Finishing: only code this request changed is Claude's to fix. Shipping is held back either way.
    if (stopping && !changedCode(turnSteps(session))) return null;
    // The tests pass only because they were changed, as they stand now (a test put back doesn't
    // count): back once, to put the test back or say why it was wrong.
    const weak = stopping && weakenedTests(bluffSteps(session));
    if (weak && !loopBluff.get(session)?.sentBack) {
      loopBluff.set(session, { text: weak.text, sentBack: true });
      sendLoop(session, label, 'sent-back', 'Claude changed the tests to make them pass. Sent it back to fix the code, or say why the test was wrong.');
      return { decision: 'block', reason: `dotpals: you made the tests pass by changing them (${weak.text}). Put the test back and fix the code, or tell the user why the test was wrong, before you finish.` };
    }
    const trouble = testTrouble(session, stopping);
    if (!trouble) return null;
    const times = loopBlocks.get(session) ?? 0;
    if (times >= LOOP_MAX) {
      if (stopping) sendLoop(session, label, 'gave-up', trouble.failing ? `Claude stopped, but the tests still fail (${trouble.words})${trouble.why ? `: ${trouble.why}` : ''}.` : `Claude stopped, but the tests weren’t run after ${trouble.untested ? 'its changes' : 'its last change'}.`);
      return null;
    }
    loopBlocks.set(session, times + 1);
    const problem = trouble.failing ? `the tests are failing (${trouble.words})${trouble.why ? `: ${trouble.why}` : ''}`
      : trouble.untested ? `you changed ${trouble.words} but didn’t run the tests` : `you changed ${trouble.words} after the last test run`;
    const fix = trouble.failing ? 'Fix them and run the tests again' : trouble.untested ? `Run \`${trouble.command}\`` : 'Run the tests again';
    if (stopping) {
      sendLoop(session, label, 'sent-back', trouble.failing ? 'Claude tried to finish with failing tests. Sent it back to fix them.'
        : trouble.untested ? `Claude changed ${trouble.words} without running the tests. Sent it back to run \`${trouble.command}\`.` : `Claude changed ${trouble.words} after the last test run. Sent it back to run them.`);
      return { decision: 'block', reason: `dotpals: ${problem}. ${fix} before you finish.` };
    }
    // The commit never runs: it failed, as far as the story goes (not "committed without testing").
    const now = Date.now();
    const id = event.tool_use_id ? `${session}:${event.tool_use_id}` : `${session}:t:${now}`;
    publish([activity.upsert({ ...(activity.get(id) ? {} : { session, label, harness: 'claude', at: now, tool: event.tool_name, ...d, startedAt: now }), id, status: 'failed', error: `dotpals stopped this: ${problem}` })]);
    sendLoop(session, label, 'blocked-ship', trouble.failing ? 'Stopped Claude from shipping: the tests are failing.' : `Stopped Claude from shipping: ${trouble.words} changed after the last test run.`);
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `dotpals: ${problem}. ${fix} before you commit or push.` } };
  }

  function fixLoop(event) {
    if (!config.fixLoop) return null;
    const session = String(event.session_id);
    const label = folderName(event.cwd);
    const name = event.hook_event_name;
    if ((name === 'PostToolUse' || name === 'PostToolUseFailure') && event.tool_use_id) return loopTestRun(event, session, label);
    if (name === 'Stop' || name === 'PreToolUse') return loopGate(event, session, label);
    return null;
  }

  // -- What git says changed (bridge/ground.js) -----------------------------------------------
  // A snapshot of the session's repository when a request starts, compared when it ends:
  // the files it really changed, also through commands. Goes on the request's `done` entry
  // as `git`: { files, more, committed, tooMany?, others, branch?, head? }, `others` being the
  // other sessions that were active in the same repository meanwhile (their changes show too),
  // `branch` and `head` (short) where the request ended (for "is branch X ready?").
  // Only live requests: there's no "before" for one read from a transcript later.
  const ground = createGround({ restorePoints: () => !!config.restorePoints });
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
        if (changes.branch) git.branch = changes.branch;
        if (changes.head) git.head = changes.head.slice(0, 7);
        if (changes.trees) git.trees = changes.trees; // restore points: the request can be rewound
        publish([activity.upsert({ id: entry.id, git })]);
      }, () => {}).finally(() => applyRules(entry.id)); // the rules see what git saw, too
    } else if (entry.kind === 'done' && !entry.git && !entry.rules) applyRules(entry.id); // no "before" from git: the steps alone
  }

  // -- Project rules (bridge/rules.js): a `.dotpals.json` every request there is held to ------
  // When a request ends, what it changed is checked against the rules of the folder its session
  // works in, and the result goes on its `done` entry as `rules` ([{ ok, text }]): readiness(),
  // the cards and the MCP tools show it. Only the bridge writes `rules` (see genericEvent).
  const rulesDone = new Set(); // done entries already checked
  async function applyRules(id) {
    const entry = activity.get(id);
    if (!entry || entry.kind !== 'done' || rulesDone.has(id)) return;
    const cwd = sessionMeta.get(entry.session)?.cwd;
    const rules = cwd ? await findRules(cwd).catch(() => null) : null;
    if (!rules) return;
    rulesDone.add(id);
    if (rulesDone.size > 2000) rulesDone.delete(rulesDone.values().next().value);
    // The request this entry ends: its session's entries since the prompt before it.
    const list = [];
    for (const e of activity.each()) if (e.session === entry.session) list.push(e);
    const turn = buildTurns(list).findLast((t) => t.end?.id === id || t.steps.some((s) => s.id === id));
    if (!turn) return;
    const checks = ruleChecks(rules, { ...turn, end: activity.get(id) });
    publish([activity.upsert({ id, rules: checks })]);
  }

  /**
   * Claude Code is about to change a file a project rule forbids (`mustNotTouch`, or outside
   * `onlyTouch`): 'ask' → Claude Code asks you, with the rule; 'tell' → the edit is refused and
   * Claude reads why. The rules' own `beforeEdit` decides ("ask" unless it says otherwise).
   * → the hook's reply, or null (no rules, nothing forbidden, `beforeEdit: "off"`).
   */
  async function guardRules(event) {
    const tool = event.tool_name;
    const path = event.tool_input?.file_path || event.tool_input?.notebook_path;
    if (!FILE_TOOLS.has(tool) || typeof path !== 'string' || !path || typeof event.cwd !== 'string') return null;
    const rules = await findRules(event.cwd).catch(() => null);
    if (!rules || rules.error || rules.beforeEdit === 'off') return null;
    const rule = forbids(rules, ruleRelative(rules, path, event.cwd));
    if (!rule) return null;
    const session = String(event.session_id);
    noteSession(session, event.cwd);
    const mode = rules.beforeEdit;
    const name = basename(rules.file);
    const reason = `The project’s rules (${name}) say ${rule}.`;
    const now = Date.now();
    const id = event.tool_use_id ? `${session}:${event.tool_use_id}` : `${session}:t:${now}`;
    publish([activity.upsert({
      ...(activity.get(id) ? {} : { session, label: folderName(event.cwd), harness: 'claude', at: now, tool, ...describeTool(tool, event.tool_input ?? {}, event.cwd), startedAt: now }),
      id, guard: { mode, text: `Paused: ${reason}`, rule },
      ...(mode === 'tell' ? { status: 'failed', error: `dotpals stopped this edit: ${reason}` } : { status: 'running' }),
    })]);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: mode === 'tell' ? 'deny' : 'ask',
        permissionDecisionReason: mode === 'tell' ? `${reason} Leave it as it is, or tell the user why it has to change.` : `${reason} Edit anyway?`,
      },
    };
  }

  // -- Talk to Blu (bridge/tasks.js): a task said or typed, done by an agent, checked here ------
  // Plans wait here until you send or drop them; a sent task is followed through its session
  // (ours: Claude Code starts with a session id we chose) and checked each time it finishes.
  const taskList = createTaskList();
  // Saved tasks keep their last verdict; a task's new steps (live, or read from its transcript) check it again.
  taskList.load().catch(() => {});
  const plans = new Map(); // plan id → plan, for 30 minutes
  const prPlans = new Map(); // task id → what opening its PR will do (shown before it's done)
  const taskTimers = new Map();
  const projectsNow = () => knownProjects(activity.all(), (s) => sessionMeta.get(s)?.cwd, { isFolder: handoffOptions.isFolder ?? isFolder, name: folderName });
  // Each awake agent in a line, so the pal can answer "what are my agents doing?".
  const agentsNow = () => [...sessions.values()].slice(-6).map((u) => {
    const last = activity.findLast(u.session, (e) => e.kind !== 'prompt');
    return { label: u.label, harness: u.harness, state: u.state, asked: activity.findLast(u.session, (e) => e.kind === 'prompt')?.title,
      latest: last && (last.kind === 'done' ? last.summary || 'finished' : `${last.kind} ${last.title ?? ''}`.trim()) };
  });
  const taskView = (t) => ({ ...t, verdict: t.verdict && { ...t.verdict, turn: undefined } });
  function taskNews(entry) {
    const task = entry.session && taskList.bySession(entry.session);
    if (!task) return;
    // When a request ends, wait a moment for git's account of it (groundTruth) before checking.
    settleTask(task, entry.kind === 'done' || entry.kind === 'error' ? 2500 : 600);
  }
  function settleTask(task, delay) {
    clearTimeout(taskTimers.get(task.id));
    taskTimers.set(task.id, setTimeout(() => {
      taskTimers.delete(task.id);
      const v = evaluate(task, [...activity.each()]);
      // Steps not loaded yet (history trimmed, a restart): keep what was known.
      if (v.state === 'starting' && task.verdict && task.verdict.state !== 'starting') return;
      const before = task.state;
      task.state = v.state;
      task.verdict = v;
      if (!['starting', 'working'].includes(v.state)) task.words = verdictWords(task, v);
      send('task', taskView(task));
      if (before !== v.state || !['starting', 'working'].includes(v.state)) taskList.save();
    }, delay));
  }
  /** Read a JSON body; only this bridge's own pages (or no page at all) may ask, as for the hand-off. */
  async function talkBody(req, res) {
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) { json(res, 403, { error: 'forbidden' }); return null; }
    try { return JSON.parse((await readBody(req)) || '{}'); } catch { json(res, 400, { error: 'bad json' }); return null; }
  }
  /** A project folder the agents worked in, by its path; never a folder only a request names. */
  const knownProject = (path) => projectsNow().find((p) => p.path.toLowerCase() === String(path ?? '').toLowerCase()) ?? null;

  // -- Blu's brain (bridge/brain.js): the AI you brought, for cleaning up dictation and Talk's plans --
  /** The AIs here, and the one a job ('quick' or 'plan') uses: { brain, here, keys }. Looked up again after 20 s, or when Settings change. */
  let brainsSeen = null; // { at, here }
  async function brainFor(job) {
    const keys = brainKeys();
    if (!brainsSeen || Date.now() - brainsSeen.at > 20_000) {
      brainsSeen = { at: Date.now(), here: await (handoffOptions.brains ?? brainsHere)({ keys: Object.fromEntries(Object.keys(keys).map((id) => [id, true])) }) };
    }
    const here = brainsSeen.here;
    return { brain: pickBrain(here, { choice: config.brain?.choice, job }), here, keys };
  }
  const askBrain = (brain, keys, system, text, timeoutMs, images = []) =>
    (handoffOptions.ask ?? ask)(brain, { system, text, images, model: config.brain?.models?.[brain?.id], key: keys[brain?.id], timeoutMs });
  /** A screenshot you pointed at as you spoke: only one dotpals took, under ~/.dotpals/shots. With its size in pixels, when given. */
  function shotOf(s) {
    const dir = join(home(), 'shots');
    const path = typeof s?.path === 'string' ? normalize(s.path) : '';
    if (!path.toLowerCase().startsWith(`${normalize(dir).toLowerCase()}${sep}`) || !/\.(png|jpe?g)$/i.test(path) || !existsSync(path)) return null;
    const px = (n) => Number.isInteger(n) && n > 0 && n <= 10_000;
    return { path, ...(Number.isFinite(s.x) && Number.isFinite(s.y) ? { x: s.x, y: s.y } : {}), ...(px(s.w) && px(s.h) ? { w: s.w, h: s.h } : {}) };
  }
  // -- Your apps (Settings → Apps): connected to dotpals itself (bridge/connectors.js), so any AI
  // Blu thinks with can use them; and, when Claude Code is here, the apps it's connected to.
  const connectors = handoffOptions.connectors ?? createConnectors({ file: join(home(), 'apps.json'), redirect: `http://127.0.0.1:${port}/api/apps/callback`, log: print });
  /** The apps Blu can use: yours in dotpals first, then Claude's (bridge/buddy.js agentApps), by name. */
  function appsNow() {
    const mine = connectors.list();
    const claude = (handoffOptions.apps ?? agentApps)();
    const taken = new Set(mine.map((a) => a.name.toLowerCase()));
    const fromClaude = { ...claude, connected: claude.connected.filter((n) => !taken.has(n.toLowerCase())) };
    return {
      connected: [...mine.filter((a) => a.status === 'connected').map((a) => a.name), ...fromClaude.connected],
      signIn: [...mine.filter((a) => a.status !== 'connected').map((a) => a.name), ...claude.signIn],
      mine, claude: fromClaude,
    };
  }
  async function appsApi(req, res, path) {
    const body = await talkBody(req, res);
    if (!body) return;
    try {
      if (path === '/api/apps/add') {
        const preset = PRESETS[body.preset];
        const app = connectors.add(preset ? { ...preset, ...body, name: preset.name, url: preset.url } : body);
        send('apps', appsNow());
        return json(res, 200, { app });
      }
      const app = connectors.get(String(body.id ?? ''));
      if (!app) return json(res, 404, { error: 'dotpals has no app by that name' });
      if (path === '/api/apps/remove') { connectors.remove(app.id); send('apps', appsNow()); return json(res, 200, { ok: true }); }
      if (path === '/api/apps/signin') return json(res, 200, await connectors.signIn(app.id));
      if (path === '/api/apps/check') {
        const tools = await connectors.tools(app.id);
        send('apps', appsNow());
        return json(res, 200, { ok: true, tools: tools.length });
      }
    } catch (err) {
      return json(res, err.signIn || err.ownClient ? 409 : 400, { error: err.message, ...(err.signIn ? { signIn: true } : {}), ...(err.ownClient ? { ownClient: true } : {}) });
    }
    return json(res, 404, { error: 'not found' });
  }
  const palOf = (p) => (typeof p === 'string' && /^[\w .'-]{1,30}$/.test(p) ? p : 'Blu');
  /** Blu's instructions for a look at your screen (bridge/buddy.js), from your settings now: the same for warming up and for the look. */
  function buddyNow(name) {
    const blu = config.blu ?? {};
    const can = { hands: blu.hands !== false, click: blu.click === true };
    const apps = appsNow();
    return { blu, can, apps, system: buddySystem({ name, mode: blu.mode, can, music: blu.music, apps }) };
  }
  async function brainApi(req, res, path) {
    const body = await talkBody(req, res);
    if (!body) return;
    // Talk is listening: start Claude Code ahead, if that's what looks at your screen (bridge/brain.js warmUp).
    if (path === '/api/brain/warm') {
      const { brain } = await brainFor('screen');
      const started = brain ? await (handoffOptions.warmUp ?? warmUp)(brain, { system: buddyNow(palOf(body.pal)).system, model: config.brain?.models?.[brain.id] || brain.model }).catch(() => false) : false;
      return json(res, 200, { warm: started });
    }
    if (path === '/api/brain/polish') {
      const text = String(body.text ?? '').trim().slice(0, 8000);
      const mode = config.brain?.polish ?? 'auto';
      if (!text || mode === 'off') return json(res, 200, { text });
      const { brain, keys } = await brainFor('quick');
      if (!brain) return json(res, 200, { text, error: 'no AI is set up (Settings → Blu’s brain)' });
      // "auto": a subscription's command line takes seconds, so only when you corrected yourself.
      if (mode === 'auto' && !isQuick(brain) && !correcting(text)) return json(res, 200, { text });
      try {
        // Under the pill's own 20 s wait, so an answer nobody would read isn't waited for.
        const r = await askBrain(brain, keys, polishSystem(config.brain?.dictionary), text, isQuick(brain) ? 12_000 : 18_000);
        const clean = polished(text, r.text, yourWords(config.brain?.dictionary ?? []).words);
        return json(res, 200, clean ? { text: clean, by: r.by, ms: r.ms } : { text, error: `${r.by}’s answer didn’t look like your words` });
      } catch (err) {
        return json(res, 200, { text, error: err.message });
      }
    }
    if (path === '/api/brain/test') {
      const { here, keys } = await brainFor('quick');
      const brain = here.find((b) => b.id === body.id);
      if (!brain) return json(res, 404, { error: 'dotpals doesn’t know that brain' });
      if (!brain.ready) return json(res, 200, { ok: false, error: brain.why });
      try {
        const r = await askBrain(brain, keys, 'Reply with the single word: ready', 'Are you there?', 45_000);
        return json(res, 200, { ok: true, by: r.by, ms: r.ms });
      } catch (err) {
        return json(res, 200, { ok: false, error: err.message });
      }
    }
    return json(res, 404, { error: 'not found' });
  }

  async function talk(req, res, path) {
    const body = await talkBody(req, res);
    if (!body) return;
    // Blu, your screen buddy (bridge/buddy.js): it looks at your screen with you, and answers with
    // what to say, what to draw on the screen and what to do on your computer (desktop/hands.js
    // does it). Work for an agent comes back as `task`, for Talk's plan.
    if (path === '/api/talk/buddy') {
      const text = String(body.text ?? '').trim().slice(0, 2000);
      if (!text) return json(res, 400, { error: 'Say what you want' });
      const name = palOf(body.pal);
      const { blu, can, apps, system } = buddyNow(name);
      const shot = blu.see === false ? null : shotOf(body.shot);
      const box = body.circled;
      const circled = shot && box && [box.x, box.y, box.w, box.h].every(Number.isFinite) ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) } : null;
      const { brain, here, keys } = await brainFor('screen');
      if (!brain) {
        const chosen = here.find((b) => b.id === config.brain?.choice);
        return json(res, 400, { error: chosen && !chosen.ready ? `${chosen.name} isn’t ready: ${chosen.why} (Settings → Blu’s brain)` : 'No AI that can see is set up: add one in Settings → Blu’s brain' });
      }
      try {
        const images = shot ? [{ type: /\.png$/i.test(shot.path) ? 'image/png' : 'image/jpeg', data: (await readFile(shot.path)).toString('base64') }] : [];
        const history = (Array.isArray(body.history) ? body.history : []).slice(-6).map((t) => ({ said: String(t?.said ?? ''), reply: String(t?.reply ?? ''), drew: String(t?.drew ?? '') }));
        const input = buddyInput(text, { shot, circled, history, agents: blu.mode === 'everyday' ? [] : agentsNow(), name, words: yourWords(config.brain?.dictionary ?? []).words });
        const r = await askBrain(brain, keys, system, input, isQuick(brain) ? 40_000 : 90_000, images);
        const reply = parseBuddyReply(r.text, { size: shot?.w ? { w: shot.w, h: shot.h } : null, can, apps });
        // "Yes" to the change Blu just asked about: done now, not asked again. Only on your own plain
        // yes, right after Blu's question about that same change (bridge/buddy.js saidYesTo): the
        // brain can't confirm a change on its own, nor swap in another.
        if (saidYesTo(text, history.at(-1)?.reply, reply.apps)) reply.apps.confirmed = true;
        // "Play some jazz": the link that plays it, found here (YouTube's first result, or your Spotify app's).
        for (const a of reply.do) if (a.act === 'play') Object.assign(a, await resolvePlay(a, { music: blu.music, spotifyKey: keys.spotify }).catch(() => ({})));
        return json(res, 200, { ...reply, words: reply.do.map(actionWords), by: r.by, ms: r.ms, saw: !!images.length });
      } catch (err) {
        return json(res, 502, { error: `${brain.name} couldn’t answer: ${err.message}` });
      }
    }
    // Blu asks Claude in one of your apps it's connected to ("what's on my calendar today?"): only
    // that app's tools, only a look unless it's a change you said yes to (bridge/buddy.js appsSystem).
    if (path === '/api/talk/apps') {
      const apps = appsNow();
      const app = apps.connected.find((n) => n === body.app);
      const question = String(body.ask ?? '').trim().slice(0, 500);
      if (!app || !question) return json(res, 400, { error: `${String(body.app ?? 'That app').slice(0, 40)} isn’t connected (Settings → Apps)` });
      const change = body.change === true;
      if (change && body.confirmed !== true) return json(res, 409, { error: 'Say yes first' });
      // Said out loud, so no Markdown and no web addresses; the first link ("open it here") becomes
      // the Talk card's Open button instead.
      const spoken = (t) => String(t ?? '').replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1').replace(/<?https?:\/\/\S+/g, '').replace(/[*_`#>]+/g, '').replace(/\s+([.,;:!?])/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 800);
      const linkOf = (t) => { const u = (/\]\((https:[^)\s]+)\)/.exec(String(t)) ?? /(https:\/\/[^\s)<>"]+)/.exec(String(t)))?.[1]; return u && u.length < 2000 ? u : undefined; };
      const own = apps.mine.find((a) => a.name === app);
      // One of yours: Blu's brain (whichever AI you brought) calls its tools; dotpals runs each
      // call, and only the ones it may use now: a look only reads; a change you said yes to
      // never sends, deletes or pays.
      if (own) {
        const { brain, here, keys } = await brainFor('apps');
        if (!brain) {
          const chosen = here.find((b) => b.id === config.brain?.choice);
          return json(res, 400, { error: chosen ? `${chosen.name} can’t use your apps: pick an API key, Ollama or Claude Code (Settings → Blu)` : 'No AI that can use your apps is set up (Settings → Blu)' });
        }
        try {
          const all = await connectors.tools(own.id);
          const usable = all.filter((t) => (change ? !never(t, own.id) : readOnly(t, own.id)));
          if (!usable.length) return json(res, 400, { error: `${app} has no tools Blu may use for ${change ? 'that' : 'a look'}` });
          const name = (t) => `${own.id.replace(/-/g, '_')}__${t.name}`.replace(/[^\w-]/g, '_').slice(0, 64);
          const byName = new Map(usable.map((t) => [name(t), t]));
          const tools = [...byName].map(([n, t]) => ({ name: n, description: String(t.description ?? '').slice(0, 1000), schema: t.inputSchema ?? { type: 'object', properties: {} } }));
          // Claude Code's --allowedTools is a list: only plain tool names go in it (no commas or spaces).
          const mcp = brain.id === 'claude' ? { config: { mcpServers: { [own.id]: await connectors.claudeEntry(own.id) } }, allowed: usable.filter((t) => /^[\w-]{1,64}$/.test(t.name)).map((t) => `mcp__${own.id}__${t.name}`) } : null;
          const r = await (handoffOptions.askWithTools ?? askWithTools)(brain, {
            system: appsSystem({ app, change }), text: question, tools, mcp, model: config.brain?.models?.[brain.id], key: keys[brain.id], timeoutMs: isQuick(brain) ? 60_000 : 120_000,
            call: async (n, args) => (byName.has(n) ? connectors.call(own.id, byName.get(n).name, args) : `Error: Blu may not use ${n} now`),
          });
          // "Notion: search", not "Notion: notion search" (Claude Code's names are mcp__<app>__<tool>).
          const label = (n) => (byName.get(n)?.name ?? String(n).split('__').pop()).replace(new RegExp(`^${own.id}[-_]`, 'i'), '').replace(/[_-]+/g, ' ');
          return json(res, 200, { say: spoken(r.text), link: linkOf(r.text), app, by: r.by, ms: r.ms, calls: r.calls.map((c) => ({ words: `${app}: ${label(c.name)}`, ok: c.ok })) });
        } catch (err) {
          return json(res, err.signIn ? 409 : 502, { error: err.signIn ? err.message : `${brain.name} couldn’t use ${app}: ${err.message}`, ...(err.signIn ? { signIn: true } : {}) });
        }
      }
      // Connected in Claude: Claude Code with only that app's tools.
      try {
        const r = await (handoffOptions.askApps ?? askApps)({ tools: appTools(apps.claude.servers?.[app] ?? app), system: appsSystem({ app, change }), ask: question, model: config.brain?.models?.claude || 'haiku' });
        return json(res, 200, { say: spoken(r.text), link: linkOf(r.text), app, by: r.by, ms: r.ms });
      } catch (err) {
        return json(res, 502, { error: `Claude couldn’t reach ${app}: ${err.message}` });
      }
    }
    if (path === '/api/talk/plan') {
      const text = String(body.text ?? '').trim().slice(0, 2000);
      if (!text) return json(res, 400, { error: 'Say or type what you want done' });
      const projects = projectsNow();
      const chosen = body.project ? knownProject(body.project) : null;
      if (body.project && !chosen) return json(res, 404, { error: 'dotpals doesn’t know that project folder' });
      try {
        const name = typeof body.pal === 'string' && /^[\w .'-]{1,30}$/.test(body.pal) ? body.pal : 'Blu';
        const shot = shotOf(body.shot);
        // Planned by Blu's brain: your Claude Code as before, or whichever AI you chose.
        const { brain, here, keys } = await brainFor('plan');
        const mine = here.find((b) => b.id === config.brain?.choice);
        if (!brain && mine && !mine.ready) return json(res, 400, { error: `${mine.name} isn’t ready: ${mine.why} (Settings → Blu’s brain)` });
        const think = brain && brain.id !== 'claude' ? (system, input) => askBrain(brain, keys, system, input, 90_000).then((r) => r.text) : null;
        const reply = await (handoffOptions.planner ?? askPlanner)(text, projects, { name, agents: agentsNow(), shot, think, model: config.brain?.models?.claude });
        if (reply.chat) return json(res, 200, { reply: reply.chat }); // just talk: what the pal says back
        // An email or a note isn't work in a project: it runs in ~/.dotpals/blu.
        const apps = { path: join(home(), 'blu'), name: 'your apps' };
        if (reply.code === false) await mkdir(apps.path, { recursive: true });
        const plan = makePlan({ text, reply, projects, project: chosen, shot, apps });
        plans.set(plan.id, plan);
        for (const [id, p] of plans) if (Date.now() - p.createdAt > 30 * 60_000) plans.delete(id);
        return json(res, 200, { plan });
      } catch (err) {
        return json(res, 502, { error: `Blu couldn’t write the plan: ${err.message}` });
      }
    }
    if (path === '/api/talk/start') {
      const plan = plans.get(body.id);
      if (!plan) return json(res, 404, { error: 'That plan has expired: ask again' });
      // What you changed on the card before sending: the title, the task and the definition of done (never the folder's path).
      if (typeof body.title === 'string' && body.title.trim()) plan.title = body.title.trim().slice(0, 80);
      if (typeof body.task === 'string' && body.task.trim()) plan.task = body.task.trim().slice(0, 4000);
      if (body.project) {
        const p = knownProject(body.project);
        if (!p) return json(res, 404, { error: 'dotpals doesn’t know that project folder' });
        plan.project = p;
      }
      if (Array.isArray(body.done)) {
        // The tests item stays the plan's own (its command comes from the project's files); the rest is tidied by doneItem.
        plan.done = body.done.slice(0, 12).flatMap((d) => [d?.kind === 'tests' ? plan.done.find((x) => x.kind === 'tests') : doneItem(d)].filter(Boolean));
      }
      const has = handoffOptions.has ?? onPath;
      if (!has('claude')) return json(res, 400, { error: 'Claude Code isn’t installed here (no `claude` on PATH)' });
      if (!(handoffOptions.isFolder ?? isFolder)(plan.project.path)) return json(res, 409, { error: 'That project folder is gone' });
      let file;
      try { file = await saveTask(taskMarkdown(plan)); } catch (err) { return json(res, 500, { error: `Couldn’t save the task: ${err.message}` }); }
      const session = newSessionId();
      const command = launchCommand({ platform: handoffOptions.platform ?? process.platform, agent: 'claude', dir: plan.project.path, args: claudeTaskArgs({ sessionId: session, title: plan.title, prompt: taskPrompt(file) }), has, find: handoffOptions.find });
      if (command.error) return json(res, 409, { error: command.error, file });
      try { await (handoffOptions.launch ?? launch)({ ...command, options: { ...command.options, env: agentEnv() } }); } catch (err) { return json(res, 500, { error: `Couldn’t open a terminal: ${err.message}`, file }); }
      plans.delete(plan.id);
      const task = { ...plan, id: plan.id.replace(/^plan-/, 'task-'), session, file, startedAt: Date.now(), state: 'starting' };
      noteSession(session, plan.project.path);
      await taskList.add(task);
      send('task', taskView(task));
      return json(res, 200, { task: taskView(task) });
    }
    const task = taskList.get(body.id);
    if (!task) return json(res, 404, { error: 'dotpals has no record of that task' });
    if (path === '/api/talk/fix') {
      const v = evaluate(task, [...activity.each()]);
      if (!v.problems?.length) return json(res, 409, { error: 'There’s nothing to fix' });
      return json(res, 200, { text: fixRequest(task, v) });
    }
    if (path === '/api/talk/pr/plan') {
      const v = evaluate(task, [...activity.each()]);
      if (v.state !== 'ready' && !body.anyway) return json(res, 409, { error: 'The task isn’t ready to merge yet' });
      const p = await (handoffOptions.prPlan ?? prPlan)(task, v).catch((err) => ({ error: err.message }));
      if (p.error) return json(res, 409, { error: p.error });
      prPlans.set(task.id, { ...p, at: Date.now() });
      return json(res, 200, { pr: p });
    }
    if (path === '/api/talk/pr/open') {
      const p = prPlans.get(task.id);
      if (!p || Date.now() - p.at > 15 * 60_000) return json(res, 409, { error: 'Look at the PR’s plan first' });
      prPlans.delete(task.id);
      const v = evaluate(task, [...activity.each()]);
      try {
        const r = await (handoffOptions.openPr ?? openPr)(task, p, receiptMarkdown(task, v));
        task.pr = { url: r.url, branch: p.branch, at: Date.now() };
        await taskList.save();
        send('task', taskView(task));
        return json(res, 200, { pr: task.pr });
      } catch (err) {
        return json(res, 502, { error: err.message });
      }
    }
    return json(res, 404, { error: 'not found' });
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
    if (event.hook_event_name === 'UserPromptSubmit') { loopBlocks.delete(session); loopUnclear.delete(session); loopAsked.delete(session); loopBluff.delete(session); } // a new request: the fix loop counts again
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
        rewound: undefined, // or that a request was rewound
        rules: undefined, // or how it stood against the project's rules
        guard: undefined, // or that it was paused before an edit

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
  // A request body, up to `max` (API calls are small JSON: 1 MB; agents' hook events carry
  // whole files and outputs: 64 MB). More is refused, never cut to nothing: the promise rejects
  // with `tooLarge`, so a caller answers 400/413 instead of acting on an empty body.
  const BODY_MAX = 1024 * 1024;
  const HOOK_MAX = 64 * 1024 * 1024;
  // Counted in bytes, and decoded once at the end (a character split across two chunks stays whole).
  const readBody = (req, max = BODY_MAX) => new Promise((ok, fail) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      const buf = typeof c === 'string' ? Buffer.from(c) : c;
      size += buf.length;
      if (size > max) { over = true; chunks.length = 0; fail(Object.assign(new Error('request too large'), { tooLarge: true })); req.resume(); return; }
      chunks.push(buf);
    });
    req.on('end', () => { if (!over) ok(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', (err) => { if (!over) fail(err); });
  });

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

  // -- Rewind a request (bridge/ground.js restore points) ------------------------------------
  const rewinding = new Set(); // repositories being rewound right now: one at a time
  // What each rewind did, kept here only (never read back from an entry, which events can
  // write to): entry id → { at, paths, backup (the tree just before it), after (just after it), undone }.
  const rewinds = new Map();
  const BUSY_STATES = new Set(['thinking', 'working', 'speaking']);
  // A folder's real path, so "C:\Users\ADES-1~1" (Windows' short name) and git's long one match.
  const realDir = (p) => { try { return normDir(realpathSync.native(p)); } catch { return normDir(p); } };
  /** Another session busy in this repository right now: its files may still be changing. */
  function busyIn(root) {
    const r = realDir(root);
    for (const [id, u] of sessions) {
      if (!BUSY_STATES.has(u.state) || asleep.has(id)) continue;
      const cwd = sessionMeta.get(id)?.cwd;
      const d = cwd ? realDir(cwd) : '';
      if (d && (d === r || d.startsWith(`${r}/`) || r.startsWith(`${d}/`))) return u;
    }
    return null;
  }
  async function rewind(res, path, body) {
    const entry = typeof body.id === 'string' ? activity.get(body.id) : null;
    const trees = entry?.git?.trees;
    if (!trees?.before || !trees?.after) return json(res, 404, { error: 'This request has no restore point. Turn on Settings → Restore points; requests from then on can be rewound.' });
    const cwd = sessionMeta.get(entry.session)?.cwd;
    const root = cwd ? (await runGit(['rev-parse', '--show-toplevel'], cwd))?.trim() : null;
    if (!root) return json(res, 409, { error: 'The project’s git repository isn’t there any more.' });
    const changed = await treeChanges(root, trees.before, trees.after);
    if (!changed) return json(res, 409, { error: 'Git couldn’t read the restore point (it may have been cleaned up).' });
    if (path === '/api/rewind/preview') {
      const now = await checkpoint(root);
      if (!now) return json(res, 409, { error: 'Git couldn’t read the project right now.' });
      const plan = await rewindPlan(root, { before: trees.before, after: trees.after, now, paths: changed });
      if (!plan) return json(res, 409, { error: 'Git couldn’t read the restore point (it may have been cleaned up).' });
      const busy = busyIn(root);
      const done = rewinds.get(entry.id);
      return json(res, 200, { ...plan, now, ...(busy ? { busy: `${busy.label ?? 'Another agent'} is still working here` } : {}), ...(done && !done.undone && done.after ? { canUndo: true } : {}) });
    }
    // Writing: one at a time per repository, the lock taken before reading how things are now,
    // and never while an agent is still working there.
    if (rewinding.has(root)) return json(res, 409, { error: 'Already rewinding in this project.' });
    const busy = busyIn(root);
    if (busy) return json(res, 409, { error: `${busy.label ?? 'An agent'} is still working in this project. Wait until it’s done.` });
    rewinding.add(root);
    try {
      const now = await checkpoint(root);
      if (!now) return json(res, 409, { error: 'Git couldn’t read the project right now.' });
      if (path === '/api/rewind/undo') {
        const done = rewinds.get(entry.id);
        if (!done || done.undone || !done.after) return json(res, 409, { error: 'There’s no rewind to undo.' });
        // Changed again since the rewind: undoing it would lose that.
        const since = await treeChanges(root, done.after, now);
        if (!since) return json(res, 409, { error: 'Git couldn’t read the restore point (it may have been cleaned up).' });
        const touched = done.paths.filter((p) => since.includes(p));
        if (touched.length) return json(res, 409, { error: `Changed again since the rewind: ${touched.slice(0, 5).join(', ')}${touched.length > 5 ? ` +${touched.length - 5}` : ''}. Undo would lose that.` });
        const out = await restoreFiles(root, done.backup, done.paths);
        if (!out) return json(res, 500, { error: 'Git couldn’t put the files back. Nothing was deleted.' });
        // Only what was really put back: anything skipped stays rewound, and Undo stays on offer for it.
        const back = new Set([...out.restored, ...out.deleted]);
        done.paths = done.paths.filter((p) => !back.has(p));
        if (!done.paths.length) done.undone = Date.now();
        else done.after = await checkpoint(root) ?? done.after;
        publish([activity.upsert({ id: entry.id, rewound: { at: done.at, paths: done.paths.length ? done.paths : [...back], ...(done.undone ? { undone: done.undone } : {}) } })]);
        return json(res, out.skipped.length ? 207 : 200, { ok: !out.skipped.length, ...out, ...(out.skipped.length ? { error: `Couldn’t put back: ${out.skipped.slice(0, 5).join(', ')}${out.skipped.length > 5 ? ` +${out.skipped.length - 5}` : ''}` } : {}) });
      }
      // Only the request's own files, and only if nothing changed since the preview you saw.
      const paths = Array.isArray(body.paths) ? [...new Set(body.paths.filter((p) => typeof p === 'string' && changed.includes(p)))] : [];
      if (!paths.length) return json(res, 400, { error: 'Pick at least one of the request’s files.' });
      if (body.now !== now) return json(res, 409, { error: 'The files changed since the preview. Look again before rewinding.', code: 'stale' });
      const out = await restoreFiles(root, trees.before, paths);
      if (!out) return json(res, 500, { error: 'Git couldn’t put the files back. Nothing was deleted.' });
      // Only the files really put back count as rewound (and are what Undo puts back).
      const done = [...out.restored, ...out.deleted];
      const skippedNote = out.skipped.length ? { error: `Couldn’t put back: ${out.skipped.slice(0, 5).join(', ')}${out.skipped.length > 5 ? ` +${out.skipped.length - 5}` : ''}` } : {};
      if (!done.length) return json(res, 409, { ok: false, ...out, ...skippedNote });
      // How things were just before (for Undo) and just after (to tell if they changed again).
      const after = await checkpoint(root);
      const at = Date.now();
      rewinds.set(entry.id, { at, paths: done, backup: now, after });
      if (rewinds.size > 200) rewinds.delete(rewinds.keys().next().value);
      publish([activity.upsert({ id: entry.id, rewound: { at, paths: done } })]);
      return json(res, out.skipped.length ? 207 : 200, { ok: !out.skipped.length, ...out, undo: !!after, ...skippedNote });
    } finally { rewinding.delete(root); }
  }

  async function api(req, res, path) {
    if (req.method === 'GET' && path === '/api/activity') return json(res, 200, { entries: activity.all() });
    if (req.method === 'GET' && path === '/api/loop') {
      const session = new URL(req.url, 'http://localhost').searchParams.get('session');
      return json(res, 200, { events: loopEvents.filter((e) => !session || e.session === session) });
    }
    if (req.method === 'GET' && path === '/api/status') return json(res, 200, await status());
    if (req.method === 'GET' && path === '/api/config') return json(res, 200, withLaya());
    if (req.method === 'GET' && path === '/api/checker/laya') return json(res, 200, laya.status());
    if (req.method === 'GET' && path === '/api/agents') return json(res, 200, { agents: agents() });
    // Where each session works, for `dotpals mcp` to tell projects apart by their real folder
    // (two "api" folders, a monorepo's packages, worktrees) instead of the folder's name.
    // The session's repository right now (bridge/ground.js snapshot): its branch, its commit and what
    // isn't committed yet, so "is it ready to merge?" can say "not committed". Read-only.
    if (req.method === 'GET' && path === '/api/git') {
      const cwd = sessionMeta.get(new URL(req.url, 'http://localhost').searchParams.get('session') ?? '')?.cwd;
      const snap = cwd ? await snapshot(cwd).catch(() => null) : null;
      if (!snap) return json(res, 200, {});
      const changed = Object.keys(snap.files ?? {});
      return json(res, 200, { branch: snap.branch ?? null, head: snap.head?.slice(0, 7) ?? null, changed: changed.slice(0, 50), more: Math.max(0, changed.length - 50), tooMany: !!snap.tooMany });
    }
    if (req.method === 'GET' && path === '/api/sessions') {
      const list = [...sessionMeta].filter(([id]) => activity.has(id)).map(([id, m]) => ({
        id, cwd: m.cwd ?? null, parent: m.parent ?? null,
        label: activity.findLast(id, (e) => e.label)?.label ?? null, harness: activity.findLast(id, (e) => e.harness)?.harness ?? null,
      }));
      return json(res, 200, { sessions: list });
    }
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
    // Talk to Blu: the project folders a task can go to, and the tasks so far.
    if (req.method === 'GET' && path === '/api/talk/projects') return json(res, 200, { projects: projectsNow(), claude: (handoffOptions.has ?? onPath)('claude') });
    if (req.method === 'GET' && path === '/api/talk/tasks') return json(res, 200, { tasks: taskList.list().map(taskView) });
    // Your apps (bridge/connectors.js) and the ones Claude Code is connected to: Settings → Apps.
    if (req.method === 'GET' && path === '/api/apps') {
      const a = appsNow();
      return json(res, 200, { ...a, claude: { ...a.claude, installed: (handoffOptions.has ?? onPath)('claude') }, presets: PRESETS });
    }
    // Back from signing in to an app in your browser (bridge/connectors.js): a page that says how it went.
    if (req.method === 'GET' && path === '/api/apps/callback') {
      let line, ok = true;
      try {
        const q = new URL(req.url, 'http://localhost').searchParams;
        const app = await connectors.finish({ state: q.get('state'), code: q.get('code'), error: q.get('error') });
        line = `${app.name} is connected to dotpals. You can close this tab and ask Blu about it.`;
        connectors.tools(app.id).catch(() => {}).finally(() => send('apps', appsNow()));
      } catch (err) { ok = false; line = err.message; }
      const safe = line.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta charset="utf-8"><title>dotpals</title><body style="font:16px system-ui;background:#0b0b0e;color:#f2f2f5;display:grid;place-items:center;height:100vh;margin:0"><p>${ok ? '✓' : '✗'} ${safe}</p></body>`);
    }
    // The desktop app's shortcuts that work right now (it writes them when it registers them).
    if (req.method === 'GET' && path === '/api/shortcuts') {
      try { return json(res, 200, JSON.parse(await readFile(join(home(), 'shortcuts.json'), 'utf8'))); } catch { return json(res, 200, {}); }
    }
    if (req.method === 'GET' && path === '/api/brain') {
      const { brain, here } = await brainFor('quick');
      const plan = pickBrain(here, { choice: config.brain?.choice, job: 'plan' });
      const screen = pickBrain(here, { choice: config.brain?.choice, job: 'screen' });
      return json(res, 200, { brains: here, quick: brain?.id ?? null, plan: plan?.id ?? null, screen: screen?.id ?? null, brain: config.brain, keys: config.brainKeys ?? {}, apps: appsNow() });
    }

    // Changes need a custom header: browsers won't send it cross-site without
    // asking first (and we never say yes), so other websites can't change settings.
    if (req.method !== 'POST' || req.headers['x-dotpals'] !== '1') return json(res, 403, { error: 'forbidden' });
    if (path === '/api/config') {
      let patch = {};
      try { patch = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      // A pasted key that can't be one (spaces, line breaks): say so rather than drop it quietly.
      const key = patch?.checker?.jevKey;
      if (typeof key === 'string' && key.trim() && !validKey(key)) return json(res, 400, { error: 'That doesn’t look like an API key (it has spaces or unusual characters). Paste it again.' });
      for (const k of Object.values(patch?.brainKeys ?? {})) if (typeof k === 'string' && k.trim() && !validKey(k)) return json(res, 400, { error: 'That doesn’t look like an API key (it has spaces or unusual characters). Paste it again.' });
      const before = config;
      config = saveConfig(patch);
      brainsSeen = null; // a new key or choice: look again
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
    // Rewind a request (Settings → Restore points): put the files it changed back as they were
    // before it. `preview` { id } → what would change, and the diff; `rewind` { id, paths, now }
    // does it, only if nothing changed since the preview, and keeps a restore point of how things
    // were, so `rewind/undo` { id } puts them back. `id`: the request's done entry.
    if (path === '/api/rewind/preview' || path === '/api/rewind' || path === '/api/rewind/undo') {
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) return json(res, 403, { error: 'forbidden' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      return rewind(res, path, body ?? {});
    }
    if (path.startsWith('/api/talk/')) return talk(req, res, path);
    if (path.startsWith('/api/brain/')) return brainApi(req, res, path);
    if (path.startsWith('/api/apps/')) return appsApi(req, res, path);
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
      loopEvents.length = 0;
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
      let body;
      try { body = await readBody(req, HOOK_MAX); } catch (err) { return res.writeHead(err.tooLarge ? 413 : 400).end(); }
      let reply = null;
      try {
        const event = JSON.parse(body || '{}');
        if (url.pathname === '/hook' && url.searchParams.get('guard') === '1') {
          // bridge/guard-hook.js: only the conflict check (bridge/hook.js reports the activity).
          // A project rule first (it's the user's own), then two agents on one file.
          if (event.hook_event_name === 'PreToolUse' && event.session_id && enabled('claude')) reply = (await guardRules(event)) ?? guardEdit(event);
        } else if (url.pathname === '/hook' && url.searchParams.get('loop') === '1') {
          // bridge/loop-hook.js: only the fix loop (bridge/hook.js reports the activity).
          if (typeof event.hook_event_name === 'string' && event.session_id && enabled('claude')) reply = await fixLoop(event);
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
  server.on('close', () => { connectors.close(); chat.stop(); stopWatchers(); clearInterval(reaper); clearInterval(stuckTimer); clearTimeout(firstBeat); clearInterval(beat); laya.stop().catch(() => {}); });

  return new Promise((ok, fail) => {
    server.once('error', (err) => { stopWatchers(); clearInterval(reaper); clearInterval(stuckTimer); fail(err); });
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
