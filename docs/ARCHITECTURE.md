# dotpals architecture

This document is for contributors. It explains how dotpals is put together: where agent activity comes from, how it becomes one feed, and how the pal, the notch and the dashboard show it. For using dotpals, see the [documentation site](https://rikinshah787.github.io/dotpals/guide/) (source in `site/guide/`).

- [The big picture](#the-big-picture)
- [Components](#components)
- [The activity entry model](#the-activity-entry-model)
- [Adapters](#adapters)
- [How sessions live and sleep](#how-sessions-live-and-sleep)
- [The story engine](#the-story-engine)
- [Usage limits and context windows](#usage-limits-and-context-windows)
- [Helpers](#helpers)
- [Share with your agents](#share-with-your-agents)
- [Approve from the pal](#approve-from-the-pal)
- [The desktop app](#the-desktop-app)
- [Persistence](#persistence)
- [Security model](#security-model)
- [Testing](#testing)
- [Adding an adapter](#adding-an-adapter)

## The big picture

```
 SOURCES                                   HOW THEY REACH THE BRIDGE
 ───────────────────────────────────────   ─────────────────────────────────────────────
 Claude Code  (plugin hooks)               node bridge/hook.js        → POST /hook
 Claude Code  (every session's transcript) ~/.claude/projects/**.jsonl  (polled by watchClaude)
 Codex        (CLI, IDE extension, app)    ~/.codex/sessions/**.jsonl   (polled by watchCodex)
 Cursor, Gemini CLI, Copilot CLI (hooks)   node bridge/hook.js <id>   → POST /hook?agent=<id>
 OpenCode     (plugin inside OpenCode)     fetch(...)                 → POST /hook?agent=opencode
 Any agent                                 your own code              → POST /event
                                   │
                                   ▼
 ┌──────────────── bridge: bridge/server.js on 127.0.0.1:5175 ────────────────┐
 │  adapters (bridge/adapters/*)  →  activity log (bridge/activity.js)        │
 │  session states · context windows · pending approvals · settings          │
 │  history.json (debounced)          plan usage (bridge/usage.js, on demand) │
 └───────────────────────────── GET /events (SSE) ─────────────────────────────┘
                                   │
         ┌─────────────────┬───────┴─────────┬──────────────────────┐
         ▼                 ▼                 ▼                      ▼
   floating pal         the notch        the dashboard        any browser tab
 bridge/index.html   bridge/notch.html  bridge/dashboard.html   (/ and /dashboard)
         └──── each view runs the story engine: bridge/ui/story.js + recap.js ────┘
```

1. **Agents report what they do.** Each source is turned into the same *activity entries* by an adapter.
2. **The bridge keeps one feed.** It merges entries by id, tracks each session's live state, and streams everything to viewers over Server-Sent Events. It keeps a local history in `~/.dotpals`.
3. **Viewers render it.** The pal, the notch and the dashboard are plain HTML pages. They group entries into requests and chapters in the browser, with the same rules (the story engine).

Everything runs on your computer. Nothing is fetched from, or sent to, the internet.

## Components

| Part | Files | What it does |
| --- | --- | --- |
| Bridge | `bridge/server.js` | HTTP server on `127.0.0.1`. Ingests events, owns the activity log, session states, contexts and approvals, serves the pages and the API, streams `/events`. `startBridge({ port, log, sleepAfter, sleepAfterWaiting })` returns the listening server. |
| Activity model | `bridge/activity.js` | The entry shape, `createActivityLog()` (merge by id, per-session ordering, `settle`, `forget`), and text helpers (`clip`, `clipText`, `relative`, `folderName`, `toPatch`). |
| Settings | `bridge/config.js` | `~/.dotpals/config.json`: defaults, validation (`clean`), `loadConfig()`, `saveConfig(patch)`. Environment variables win. |
| Adapters | `bridge/adapters/*.js` | One module per agent. The registry is `bridge/adapters/index.js`; shared config-editing helpers are in `setup.js`. |
| Hook forwarder | `bridge/hook.js` | The command agents run for each hook event. Forwards stdin JSON to the bridge, always exits 0, and can start the pal. |
| Context hook | `bridge/context-hook.js` | Claude Code only: on `SessionStart` and `UserPromptSubmit`, fetches `GET /api/recap` and prints it as `additionalContext` (Share with your agents). |
| Claude Code plugin | `hooks/hooks.json`, `commands/pals.md`, `.claude-plugin/` | Registers `hook.js` (and `context-hook.js`) for Claude Code's hook events, and the `/dotpals:pals` command. |
| Usage | `bridge/usage.js`, `bridge/statusline.js` | Plan limits (5-hour and weekly) and Claude context-window sizes, read from local files. |
| Story engine | `bridge/ui/story.js`, `bridge/ui/recap.js` | Pure functions shared by every view (and Node): requests, chapters, flags, plan, headline, toolkit, overlaps, compact note, Markdown recaps. |
| Views | `bridge/index.html`, `bridge/notch.html`, `bridge/dashboard.html` | The pal (Summary, Tools, Files), the notch, and the dashboard (Overview, Sessions, Map, Agents, Settings). |
| Desktop app | `desktop/main.js`, `desktop/preload.cjs`, `desktop/launch.js` | Electron: the pal, notch and dashboard windows, tray, shortcut, click-through and drag. Runs the bridge in-process. |
| CLI | `bin/dotpals.js` | `setup`, `start`, `dashboard`, `status`, `notch`, `statusline`, `bridge`. |
| Web component | `src/*.js`, `src/index.d.ts` | `<dot-pal>`, the characters, custom pals, actions and agent-event helpers. Used by every view and published on its own. |

## The activity entry model

Every adapter produces the same entries (see the header of `bridge/activity.js`):

```js
{
  id,        // unique and stable: `${session}:${tool_use_id}` etc. Sources can report one call in pieces.
  session,   // the agent session; prefixed per agent ("codex:…", "cursor:…"), Claude's is its session id
  harness,   // "claude", "codex", "cursor", "gemini", "opencode", "copilot", or a generic harness name
  label,     // usually the project folder name
  at,        // ms since epoch
  kind,      // prompt · read · edit · write · run · search · web · agent · mcp · skill · plan · tool · done · error · compact
  tool?,     // the agent's own tool name, e.g. "Bash" or "exec_command"
  title,     // one line: a file, a command's description, a search pattern…
  detail?,   // a second line
  files?,    // [{ path, change: 'read' | 'edit' | 'write' | 'delete' }]
  body?,     // { command?, patch?, output?, args? }  plain text, clipped
  status,    // running · waiting · ok · failed · stopped · info
  startedAt?, ms?, error?,
  summary?,  // on done entries: the agent's closing message for that turn
  plan?,     // on plan entries: [{ text, active?, status: 'pending' | 'in_progress' | 'completed' }]
  task?,     // on Claude TaskCreate/TaskUpdate entries: { op: 'create' | 'update', id?, text?, active?, status? }
}
```

Merging rules (`createActivityLog().upsert`):

- A patch with a known `id` merges into the existing entry. `undefined` values don't erase fields, `body` is merged key by key, and `at` keeps its first value.
- A final status (`ok`, `failed`) never regresses. This matters because hooks run as separate processes, so a tool's result can arrive before its start.
- Each session's entries are kept in time order, even when history is backfilled late.
- `settle(session)` marks the session's `running` and `waiting` entries as `stopped` when a turn ends.
- The bridge keeps at most 1500 entries per session in memory (`createActivityLog({ limit: 1500 })`).

Viewers group entries into **requests** (`buildTurns` in `recap.js`): a `prompt`, the steps after it, and the `done` or `error` entry that ended it.

## Adapters

Every integration is listed in `bridge/adapters/index.js` as `{ id, name, via, how, docs, setup, detect(), … }`. `setup` says how it connects:

| `setup` | Meaning | Agents |
| --- | --- | --- |
| `plugin` | Installed from inside the agent | Claude Code |
| `auto` | Nothing to install: dotpals reads the agent's logs | Codex |
| `connect` | dotpals adds a hook or plugin to the agent's config (the dashboard's **Connect**) | Cursor, Gemini CLI, OpenCode, GitHub Copilot CLI |
| `http` | The agent posts to `/event` itself | Any agent (`generic`) |

### Claude Code (`claude.js`)

- **Live:** `hooks/hooks.json` runs `node "${CLAUDE_PLUGIN_ROOT}/bridge/hook.js"` for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Notification`, `SubagentStart`, `SubagentStop`, `PreCompact`, `Stop`, `StopFailure` and `SessionEnd`. All are `async` except `PermissionRequest` (see [Approve from the pal](#approve-from-the-pal)). `SessionStart` and `UserPromptSubmit` also run `bridge/context-hook.js` in the foreground with a 3 s timeout (see [Share with your agents](#share-with-your-agents)).
- The bridge treats any `/hook` or `/event` body with a string `hook_event_name` and a `session_id` (and no `?agent=`) as Claude Code. `applyHook()` folds it into the log; `toAgentState()` (in `src/agent.js`) gives the pal's state.
- **History:** the first hook from a session backfills its whole transcript (`transcript_path`), with the same entry ids as the hooks, so nothing shows twice. On `Stop`, the closing message is read from the end of the transcript (retrying once after 1.5 s, because the transcript can lag the hook).
- **No hooks:** `watchClaude()` polls `~/.claude/projects/<project>/<session>.jsonl` every 1.5 s. It picks up transcripts written in the last 3 hours and gives a session a live pal if its file changed in the last 30 s. Sessions that send hooks are skipped (the hooks have them), but their context-window usage is still read here. `DOTPALS_CLAUDE_LOGS=0` turns this off.
- `describeTool()` maps Claude's tools to kinds: `Read`, `Edit`/`MultiEdit`/`NotebookEdit` (with a `-`/`+` patch), `Write`, `Bash`/`PowerShell`, `Grep`/`Glob`, `WebSearch`/`WebFetch`, `Agent`/`Task`, `Skill`, `TodoWrite`, `TaskCreate`/`TaskUpdate`, and `mcp__server__tool`. Anything else is `tool`.
- Injected messages (`<system-reminder>`, `<task-notification>`, IDE context…) aren't prompts. Slash commands read as `/name args`.

### Codex (`codex.js`)

- `watchCodex()` polls today's and yesterday's folders under `~/.codex/sessions/YYYY/MM/DD/` every second, following `.jsonl` logs touched in the last 12 hours. Only sessions active in the last 10 minutes get a live pal.
- Handles `session_meta`, `turn_context`, user messages, `token_count` (context window), `task_started`, function and custom tool calls and their outputs, `web_search_call` and `task_complete` (with the agent's last message as the summary).
- `describeCall()` covers `exec_command`/`shell`/`local_shell`, `write_stdin`, `apply_patch` (files parsed from `*** Update File:` lines), `view_image`, `spawn_agent`, `send_message`, `update_plan`, `js` and MCP tools. Patches inside `exec` scripts are recognised too. Failure is guessed from the output ("exited with code 1", "error: …").
- The folder can be moved with `DOTPALS_CODEX_DIR`; `DOTPALS_CODEX=0` or `{ "codex": false }` turns it off.

### Cursor (`cursor.js`)

- **Connect** adds `node ".../bridge/hook.js" cursor` (timeout 5) to `~/.cursor/hooks.json` for `sessionStart`, `sessionEnd`, `beforeSubmitPrompt`, `afterShellExecution`, `afterFileEdit`, `afterMCPExecution`, `postToolUse`, `postToolUseFailure`, `subagentStop`, `afterAgentResponse`, `preCompact` and `stop`.
- Only hooks that observe are used, never the ones that can approve or block (`preToolUse`, `beforeShellExecution`, `beforeReadFile`…). So tool calls appear once they've finished, dated back by their duration but never before the prompt.
- `hook.js` prints `{"continue":true}` for `beforeSubmitPrompt` and `{}` for the rest, so Cursor carries on as if there were no hook.

### Gemini CLI (`gemini.js`)

- **Connect** adds a hook group `{ matcher: "*", hooks: [{ name: "dotpals", type: "command", command, timeout: 5000 }] }` to `~/.gemini/settings.json` for `SessionStart`, `BeforeAgent`, `BeforeTool`, `AfterTool`, `AfterAgent`, `Notification`, `PreCompress` and `SessionEnd`. Gemini CLI 0.26 or newer runs hooks, and only in trusted folders. If `hooksConfig.enabled` is `false`, Connect says so.
- Gemini's tool events carry no call id, so `BeforeTool` and `AfterTool` are paired by session, tool name and input.

### OpenCode (`opencode.js`)

- **Connect** writes a small plugin (`PLUGIN`, marked `dotpals-opencode-plugin`) to `~/.config/opencode/plugins/dotpals.js` (or `$XDG_CONFIG_HOME/opencode`). OpenCode loads it at start.
- The plugin posts raw facts to `POST /hook?agent=opencode` (`chat.message`, `tool.execute.before`/`after`, tool errors, and `session.created`, `session.idle`, `session.error`, `session.compacted`, `permission.asked`, `permission.replied`). It never throws, because a throw in `tool.execute.before` would block the tool. All the interpretation happens in `applyOpenCode()`, so it can improve without reconnecting.
- "Send a test event" loads the installed plugin with `probe()` and has it report a new session.

### GitHub Copilot CLI (`copilot.js`)

- **Connect** writes its own file, `~/.copilot/hooks/dotpals.json` (or `$COPILOT_HOME/hooks`), so your other hooks are never touched. Events: `sessionStart`, `userPromptSubmitted`, `postToolUse`, `postToolUseFailure`, `notification`, `errorOccurred`, `agentStop`, `sessionEnd`.
- Copilot's payloads don't name their event, so each command passes it: `node ".../bridge/hook.js" copilot <event>`. `preToolUse` is left alone because it can block tools.

### Any agent (`generic`)

`POST /event` with `{ session, harness?, label?, cwd?, state?, text?, activity?, helper? }`. `genericEvent()` in `server.js` namespaces activity ids by session, fills defaults for new rows (`kind: "tool"`, `status: "ok"`, a title), and merges follow-ups with the same id. `state`/`text`, or any event `toAgentState()` understands, drives the pal. See the [API reference](https://rikinshah787.github.io/dotpals/guide/api.html).

### The hook forwarder (`hook.js`)

```
node bridge/hook.js                 Claude Code
node bridge/hook.js <agent>         another agent's hooks → POST /hook?agent=<agent>
node bridge/hook.js <agent> <event> for payloads that don't name their event (Copilot CLI)
```

- Posts to `DOTPALS_URL` (default `http://127.0.0.1:5175/hook`) with a short timeout (1 s for Claude, 0.7 s for other agents, 125 s for a Claude `PermissionRequest`) and always exits 0.
- If the bridge isn't running when a Claude Code session starts or a prompt is sent, it launches the desktop pal (`desktop/launch.js`), or just the bridge if Electron isn't installed, then retries for a few seconds. `DOTPALS_AUTOSTART=0` turns that off, `DOTPALS_FLOAT=0` starts only the bridge, and setting `DOTPALS_URL` also disables it.
- Commands written into other agents' configs point at `~/.dotpals/app/bridge/hook.js` (`appRoot()` in `setup.js`), which outlives npx's temporary folder.

### Switching integrations off

`{ "agents": { "<id>": false } }` in `config.json` (or the switch on the Agents page). For hook-based agents the bridge still parses events (into a throwaway log, so "Send a test event" keeps working) but drops them. For log-following agents the watcher is stopped. `codex` and `agents.codex` are the same switch.

## How sessions live and sleep

The bridge alone decides when a session is over. Viewers never end a session on a timer of their own.

- The bridge remembers each session's last state update and the time of its newest event (`lastHeard`).
- A reaper runs every 30 s. A session that has been quiet for **15 minutes** (`SLEEP_AFTER`), or **60 minutes** if its state is `waiting` (`SLEEP_AFTER_WAITING`, in case you stepped away), is set to `sleeping`.
- An agent can also end a session itself (for example Claude Code's `SessionEnd`, or `sessionEnd` from Cursor, Gemini CLI and Copilot CLI map to `sleeping`).
- You can dismiss a session with the × on its tab in the pal or its card in the notch. That calls `POST /api/sessions/<id>/dismiss`, which sets it to `sleeping` for every viewer. History isn't touched, and the next event from the agent brings it back.
- `sleeping` removes the session's state, context and helpers from the bridge. Viewers let its pal play the sleeping animation, then remove it 6 s later. Any later event brings it back.
- Separately, the pal page lets a quiet pal **doze** (the sleeping animation) after 3 minutes without events. The next event wakes it. This is only cosmetic.
- Small mode shows only *active* sessions: working, thinking, speaking or waiting, or with an event in the last 2 minutes. If none are active, it shows the most recent one. The full view's session tabs list sessions with a pal on the stage or an event in the last 30 minutes (at most six, plus the one you picked). The notch shows sessions that are working or waiting, plus those that finished in the last 90 s.

`startBridge()` takes `sleepAfter` and `sleepAfterWaiting` so tests can shorten them.

## The story engine

`bridge/ui/story.js` turns a request's steps into something a person can read in five seconds. It's plain rules, no AI: instant, free and the same every time. It runs in the pal, the notch, the dashboard and Node.

- **`stepType(entry)`** classifies each step: `explore` (reads, searches and look-only commands like `ls`, `git status`, `cat`), `change`, `test`, `build`, `install`, `ship` (git commit/push/tag/merge, `gh pr create`, `npm publish`…), `run`, `web`, `agent`, `skill`, `mcp`, `plan`, `memory` (compaction), `ask` (`AskUserQuestion`), `quiet` (prompts, turn ends and bookkeeping tools, which aren't steps) and `tool`.
- **`chapters(steps)`** groups a request's steps by type, in a fixed order that puts outcomes first: ask, change, test, build, install, ship, agent, skill, mcp, web, explore, run, tool, scratch, memory. Plan and quiet steps are skipped. Changes to files outside the project become a quiet `scratch` chapter. Each chapter has a title and detail ("Changed 5 files" · "app.js, style.css, dark.css +2", "Tests failed twice, then passed", "Committed and pushed"), `+added −deleted` line counts, a status and its steps. Running chapters read in the present tense.
- **`flags(steps, { before })`** marks things worth a second look:
  - `warn`: changing a file that usually holds secrets (`.env*`, `.npmrc`, `.pypirc`, SSH keys, `credentials`, `secrets.*`, `*.pem`/`*.key`/`*.p12`/`*.pfx`), recursive deletes, force-pushes, throwing away git changes, dropping database tables, piping a download into a shell, `sudo`/`chmod 777`, force-stopping programs, and the same command failing 3 times.
  - `info`: reading a secrets file, publishing a package.
  - `before: true` words them for something about to happen ("Force-pushes to git"), which the approval card uses.
- **`planOf(steps)`** rebuilds the agent's newest plan from Claude's `TodoWrite` or `TaskCreate`/`TaskUpdate`, Codex's `update_plan`, Gemini's `write_todos` or OpenCode's `todowrite`: `{ items, done, total, current }`.
- **`headline(steps, plan)`** is the pal's speech bubble while it works: the plan step ("2/4 · Detecting the system setting") or the current chapter ("Changing files · 4 so far"), shortened to whole words. It only changes when that changes, so you can read it.
- **`toolkit(entries)`** lists the skills, plugins, MCP tools and helper agents a session used (the "Using" row). Plugin skills are named `plugin:skill`; plugin MCP servers `plugin_<plugin>_<server>`.
- **`overlaps(entries, since, { within })`** finds files that two or more sessions changed at around the same time: edits within 30 minutes of each other, in the last 2 hours by default. The pal shows a note; the dashboard's Map lists them.
- **`compactNote(entries)`** writes a `/compact <instructions>` from the session's own record: the goal, what's still on the plan, the files changed so far and whether the tests are failing. Claude Code and Codex both accept `/compact` with instructions. Neither lets another program compact a running session, so the views copy the command for you to paste.
- **`story(turn, sessionSteps)`** bundles chapters, de-duplicated flags and the plan.

`bridge/ui/recap.js` has the rest: `buildTurns`, `facts` (tallies), `sentence` (one step as a short sentence), `turnMarkdown`/`recapMarkdown` (Copy and Export), `summarizeSessions`, agent names and colors.

## Usage limits and context windows

**Plan usage** (`bridge/usage.js`, `GET /api/usage`, and the notch through IPC) is read from local files and cached for 5 s:

- **Codex** writes its limits to its own logs (`token_count` → `rate_limits`), so dotpals reads the newest ones from `~/.codex/sessions` (the last 7 days, the 12 newest files).
- **Claude Code** gives its 5-hour and weekly limits only to a *status line command*; nothing else receives them. `dotpals statusline` installs `bridge/statusline.js` as your status line in `~/.claude/settings.json`. On each refresh it saves the limits to `~/.dotpals/claude-limits.json` and prints a short line, or runs and prints the status line you already had (saved in `~/.dotpals/statusline.json`). `--off` puts things back. Until it's set up, usage reports `setup: "statusline"` for Claude and the notch shows a hint.

A limit window that has already reset reads 0%.

**Context windows** are sent as `context` events: `{ session, harness, label, used, size, known, at }`.

- **Codex** logs both the tokens used and the window size, so `known` is always true.
- **Claude Code** transcripts record tokens but not the window size. The size is `known` when the status line reported it for that session (`sizes` in `claude-limits.json`, newest 30 sessions), or when usage passes 200k tokens (so it must be a 1M window). Otherwise it's a 200k guess with `known: false`, and the views show a token count ("143k") instead of a percentage, so there are no false alarms.

The pal reacts only to known percentages: surprised at 80%, worried at 90% ("it'll compact soon", plus a notification if the pal is hidden), and cheers ("Fresh context") when a session that was at least half full drops by more than 25 points.

## Helpers

The bridge keeps, per session, a list of the helper agents (subagents) it started, and sends it as a `helpers` event: `{ session, harness, helpers: [{ id, name, task, status: 'running' | 'done' | 'failed', doing, startedAt, endedAt }] }`. The whole list is sent on every change and replayed to new viewers. Three sources feed it (`server.js`):

- **`helperFromEntry`**: any adapter's `kind: 'agent'` entries (Claude's Agent/Task tool, Codex's `spawn_agent`, OpenCode's `task`…). The helper finishes when its entry does.
- **`helperFromHook`**: Claude Code's `SubagentStart` and `SubagentStop`, and the `agent_id` on a helper's own `PreToolUse` calls. A helper seen this way is paired with the oldest running Agent call of the same type; from then on its lifecycle hooks, not the tool call, decide when it's done (a background helper's tool call returns long before the helper finishes), and `doing` is its current step as a sentence.
- **`helperFromEvent`**: the `helper` field of generic events, `{ id, name?, task?, state: 'working' | 'done' | 'error', text? }`.

Finished helpers stay listed for 60 s. The list is dropped when the session sleeps. The pal shows it on the running request; the notch under each agent's card.

## Share with your agents

Off unless `shareRecap` is on. It tells each Claude Code session what other agents did in the same project, so parallel agents don't undo each other's work.

- `hooks/hooks.json` runs `bridge/context-hook.js` (in the foreground, 3 s timeout) on `SessionStart` and `UserPromptSubmit`. It calls `GET /api/recap?session=<id>&label=<folder>&mode=start|prompt` on `DOTPALS_BRIDGE` (default `http://127.0.0.1:5175`) with a 1.5 s timeout and, if it gets `{ text }`, prints `{ hookSpecificOutput: { hookEventName, additionalContext: text } }`. It never starts anything and always exits 0.
- `/api/recap` returns `{}` while the setting is off. Otherwise it builds the note with `crossRecap(entries, { session, label, states })` from `story.js`: up to 4 other sessions with the same label active in the last 2 hours that changed files or ran tests, each with the files changed (up to 5), its last test result, what it was asked, and whether it's working now.
- `mode=start` returns the whole note. `mode=prompt` returns it only if there's news since the last note that session got (`recapTold`).

## Approve from the pal

Claude Code's `PermissionRequest` hook can answer a permission prompt. dotpals uses it to show **Allow** and **Deny** on the pal and the notch.

```
Claude Code ── PermissionRequest (sync hook, timeout 130 s) ──▶ hook.js ── POST /hook ──▶ bridge
                                                                                         │
      approvals off, nobody connected, or not a tool? ──▶ reply {} at once ◀────────────┤
                                                                                         ▼
                                          SSE "approval" { status: "pending", … } ──▶ pal / notch
                                          POST /api/approvals/<id> { decision } ◀── Allow / Deny
                                                                                         │
 Claude reads { hookSpecificOutput: { decision: { behavior: "allow" | "deny" } } } ◀──────┘
      or {} after approvalWait seconds, or when Claude closes the request
```

- **Off by default** (`approvals: false`). While Claude Code waits for a hook it doesn't show its own prompt, so the terminal looks idle. That's surprising if you didn't ask for it, so it's opt-in, and the wait is short.
- The bridge holds a request only when approvals are on **and** at least one viewer is connected to `/events`, and only for requests with a `tool_name`.
- It waits `approvalWait` seconds (default 30; 10 to 120 allowed; the dashboard offers 15 s, 30 s, 1 min and 2 min). On timeout, or if Claude closes the request, it replies `{}` and Claude asks in the terminal as usual. `hooks/hooks.json` gives the hook 130 s and `hook.js` waits up to 125 s, so the bridge always answers first.
- The request is described with the same `describeTool()` as the feed, the command or a clipped patch, and risk flags worded for approval (`flags(…, { before: true })`). A risky request gets an amber Allow button.
- Answers need the `x-dotpals: 1` header. A request can be answered once; afterwards the API returns 404. Deny tells Claude "The user said no from dotpals."
- Every change is broadcast (`approval` with `allow`, `deny` or `expired`), so all open views clear the card. New viewers receive pending requests when they connect, and `GET /api/approvals` lists them.

## The desktop app

`desktop/main.js` (Electron). A single-instance app: launching it again brings the running one back and applies its flags (`--dashboard`, `--open-at-login`, `--notch`, `--notch-auto`, `--no-notch`).

- **The bridge runs in-process** (`startBridge`). If the port is already taken, the app uses the bridge that's there. If that bridge later goes away, the app starts its own ("takes over").
- **Events reach the windows through the main process.** The main process reads `/events` and forwards each event over IPC (`bridge:event`); `preload.cjs` exposes a small `window.dotpalsDesktop` API. Pages are sandboxed with context isolation.
- **The pal window**: frameless, transparent, always on top (at the `floating` level, on every workspace, above full-screen apps), no taskbar entry. Full view is 380×600 (height remembered), small mode ("Just the pal") is 260×290 and resizes around the bottom-right corner. It loads `http://127.0.0.1:<port>/?float=1` (falling back to the file). Closing hides it; **Ctrl+Alt+P** (⌘⌥P) toggles it.
- **Drag**: the page handles the pointer on the pal (under 5 px is a click) and asks the main process to follow the real cursor with `setBounds`, always passing the exact intended size, because Windows display scaling makes a window creep bigger on every move. The empty space in the full view is a normal drag region.
- **Click-through**: in small mode the page tells the main process whether the cursor is over something solid (the pal's drawn shapes, its bubble, the round bar, an approval card). Over empty space the window ignores the mouse with `forward: true`, so clicks reach your editor while the page still gets mouse moves. Linux can't forward moves, so there the window stays solid. The main process also polls the cursor every 100 ms to tell the page when the mouse is over the window, because drag regions swallow mouse events on Windows.
- **The notch**: a separate frameless, non-focusable window centred at the top of the primary display (at the `screen-saver` level; a `panel` on macOS). The page reports the island's size and the window is resized to fit (it grows at once and shrinks after the closing animation), so it never blocks clicks around it. Mode `auto` (shown whenever the pal is hidden, the default), `always` or `off`, set from the tray or `dotpals notch`. It loads `/bridge/notch.html` and fetches usage over IPC every 20 s.
- **The dashboard**: a normal 1180×820 window on `/dashboard`. Links to other sites, `vscode:` and `cursor:` open outside the app.
- **Tray**: Show / hide, Just the pal, Notch at the top of the screen (When the pal is hidden, Always, Never), Dashboard, Notifications, Open when I log in, Quit dotpals.
- **Notifications** are decided by the page (`notify()` in `index.html`) and shown by the main process if `notifications` is on.
- On macOS the app lives in the menu bar, not the Dock. On Linux it enables transparent visuals.

`desktop/launch.js` finds Electron (`DOTPALS_ELECTRON`, then this package's `node_modules`, then `~/.dotpals/node_modules`), installs it into `~/.dotpals` with `--install`, and starts the app with `ELECTRON_RUN_AS_NODE` removed from the environment.

## Persistence

Everything lives in `~/.dotpals` (or `DOTPALS_HOME`):

| Path | Written by | Contents |
| --- | --- | --- |
| `config.json` | `bridge/config.js` (Settings, Agents page, tray, `dotpals setup`) | Only known keys with valid values. See [Configuration](https://rikinshah787.github.io/dotpals/guide/configuration.html). |
| `history.json` | the bridge | `{ version: 1, entries }`: the last `historyDays` days, at most 5000 entries. Written 2 s after the last change via a `.tmp` file and a rename. On load, entries that were still running become `stopped`. Not written when `history` is off. |
| `claude-limits.json` | `bridge/statusline.js` | Claude's `rate_limits`, the latest context window, the model name, and window sizes for the newest 30 sessions. Nothing from the conversation. |
| `statusline.json` | `dotpals statusline` | `{ previous }`: the status line you had before, so it keeps showing and `--off` can restore it. |
| `app/` | `dotpals setup` | A permanent copy of dotpals (npx runs from a temporary folder). Hook commands point here. |
| `node_modules/` | `desktop/launch.js --install`, `dotpals setup` | The Electron runtime (about 100 MB). |

Also:

- The desktop app keeps window position, height, small mode and notch mode in `window.json` in Electron's user-data folder for the app (for example `%APPDATA%\dotpals` on Windows).
- The browser pal keeps the sound toggle and first character in `localStorage`.
- Connecting an agent, or `dotpals statusline`, keeps the original file as `<file>.dotpals-backup` next to it.

## Security model

- **Local only.** The bridge listens on `127.0.0.1`, never on other interfaces.
- **Host check.** Every request except `POST /hook` and `POST /event` must be addressed to `127.0.0.1`, `localhost` or `[::1]` (any port); anything else gets `421`. This stops DNS-rebinding pages from reading your activity.
- **Changes need `x-dotpals: 1`.** Every `POST /api/*` (settings, clearing history, Connect/Disconnect/test, dismissing a session, answering approvals) requires this header, or it gets `403`. Browsers only send a custom header cross-origin after a CORS preflight, and the bridge never approves one (it sends no CORS headers at all), so other websites can't change anything. For the same reason they can't read `GET` responses.
- **Event ingestion is open to local processes.** `POST /hook` and `POST /event` accept any JSON, so any program on your machine can add to the feed. They can't read it back, change settings or answer approvals.
- **Static files** are served only from `src/`, `bridge/` and `desktop/` inside the package, after path normalisation.
- **The desktop app** uses sandboxed, context-isolated pages with a narrow preload API, and opens only `http(s)`, `vscode:`, `cursor:` (and, from the pal, `file:`) links outside the app.
- **Never in the agent's way.** `hook.js` always exits 0 with short timeouts. The Cursor and Copilot CLI integrations use only hooks that observe. The OpenCode plugin never throws. Approvals are off unless you turn them on, and always fall back to the terminal.
- **Careful with other tools' files.** Connect backs up the original, merges instead of overwriting, writes atomically, and refuses to touch a file it can't parse. Disconnect removes only what dotpals added.

See also `SECURITY.md`.

## Testing

```bash
npm test          # node --test: every test/*.test.js, no dependencies needed
```

- Tests start real bridges on random ports (5190 and up) with `startBridge({ port, log: () => {} })`, and keep away from your real files with `DOTPALS_HOME` (a temp folder), `DOTPALS_CODEX=0`, `DOTPALS_CLAUDE_LOGS=0`, `DOTPALS_HISTORY=0` and the `DOTPALS_*_DIR` variables.
- Adapter tests feed sample events into `apply…()` functions and check the entries; connect tests check that config files are merged, backed up and restored.
- `test/server.test.js` covers generic events, static paths, sleeping sessions and approvals; `test/story.test.js` covers the story engine and Codex usage.
- CI (`.github/workflows/ci.yml`) checks the syntax of every file and runs the tests on Node 20 and 22 on Linux, Windows and macOS. Electron isn't installed in CI.

For the UI, run `npm run float` (the desktop pal) or `npm run bridge` and open `http://127.0.0.1:5175/` and `/dashboard`. `npm run dev` serves the web component playground on port 5173.

## Adding an adapter

1. **Create `bridge/adapters/<id>.js`** exporting a default object. Use `cursor.js` as a template for a hook-based agent, `copilot.js` for one that gets a hooks file of its own, `opencode.js` for a plugin, or `codex.js` for an agent that writes a session log.

   ```js
   export default {
     id: 'myagent',                 // lowercase: [a-z][a-z0-9-]*
     name: 'My Agent',
     via: 'Hooks (~/.myagent/hooks.json)',
     how: 'One plain sentence for the Agents page.',
     docs: 'https://…',
     setup: 'connect',              // 'plugin' | 'auto' | 'connect' | 'http'
     file: () => …,                 // the config file Connect edits
     detect: () => ({ found, where }),
     connected: () => boolean,
     connect() { … return { file, backup, command, note? }; },
     disconnect() { … return { file, backup? }; },
     command: () => '…',            // the command as installed
     sample: (token) => ({ … }),    // a payload for "Send a test event" (use token as the session id)
     apply(event, log) {            // events from POST /hook?agent=myagent
       return { entries, session, label, state };
     },
   };
   ```

   A log-following agent provides `watch(log, { emit, state, context }) → stop` instead of `apply`; a plugin can provide `probe({ url, token })` instead of `command`/`sample`.

2. **Use the helpers in `setup.js`**: `hookCommand(id)`, `isOurs(command, id)`, `readJson` (throws on a file it can't parse, so it's left alone), `backup`, `writeJson` (atomic), `writeOwnFile`/`removeOwnFile`.
3. **Produce standard entries.** Prefix session ids with your id (`myagent:<id>`) and entry ids with the session. Use `clip`, `clipText`, `relative`, `folderName` and `toPatch`. Report plans as `kind: 'plan'` with a `plan` array so the plan and headline work. Call `log.settle(session)` when a turn ends.
4. **Register it**: add it to `ADAPTERS` in `bridge/adapters/index.js`, its id to `AGENT_IDS` in `bridge/config.js` (so it can be switched off), and a display name to `NAMES` in `bridge/ui/recap.js`. If the agent expects something on stdout from a hook, add it to `REPLY` in `bridge/hook.js`.
5. **Let tests move its folder** with a `DOTPALS_<ID>_DIR` variable, and add `test/<id>.test.js` covering `apply` and connect/disconnect.
6. **Document it** in the README and on the Agents page of the docs (`site/guide/agents.html`).
