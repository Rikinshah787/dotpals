# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-09-30

### Added

- **The story view** in the pal's Summary: each request reads as a few chapters, not hundreds of tool calls. For example "Changed 5 files +42 −7", "Tests failed twice, then passed", "Committed and pushed" and "Looked through 14 files". Click a chapter to see its steps. The same rules power the dashboard; see `bridge/ui/story.js`.
- **Warnings worth a second look**: changing `.env` or key files, recursive deletes, force-pushes, force-stopping programs, and the same command failing 3 times.
- **The agent's own plan, live**: Claude's to-do list (TodoWrite and tasks) and Codex's plan show with ticks and a progress bar. The pal's bubble shows the step ("2/4 · Detecting the system setting") or the chapter ("Changing files · 4 so far"). It only changes when that changes, so you can read it.
- **The notch**: an island at the top of the screen with each agent, what it's doing, its plan, its context window and your usage limits. Hover to open it. It glows amber when an agent needs you, flashes green when one is done, and shakes on errors. By default it appears when you hide the pal, so closing the pal doesn't mean losing track. It can also stay on always, or never appear: set that in the tray or with `dotpals notch [--auto|--off]`. The window is always exactly the island's size, so it never blocks clicks.
- **Usage limits**: Codex's 5-hour and weekly limits come straight from its logs. For Claude Code's, run `dotpals statusline`. It adds a status line that shares them (Claude Code gives them only to a status line), keeps any status line you already had, backs up your settings, and `--off` undoes it.
- **Context window alerts**: each session chip shows how full its context window is. The pal is surprised at 80%, worried at 90% ("it'll compact soon") and cheers after compaction. Percentages show only when the window size is known (Codex, or Claude with the status line), so there are no false alarms.
- **Using**: the skills, plugins, MCP tools and helper agents the session you're looking at has used.
- **Two agents, one file**: a note when another agent changed a file this session also changed within 30 minutes.
- **Approve from the pal**: answer Claude Code's permission prompts ("Allow Bash: git push?") with Allow or Deny from the pal or the notch. The request shows exactly what will run, with warnings such as "Force-pushes to git". Off by default; turn it on in Settings. It waits only while a pal, the notch or the dashboard is open, for up to 30 seconds (15 to 120 in Settings). If you don't answer, Claude asks in the terminal as usual. It uses Claude Code's documented `PermissionRequest` hook. In `hooks/hooks.json` that hook now runs in the foreground (130 s timeout) so it can answer.
- **Copy /compact**: when a session's context fills up, the pal and the notch offer a `/compact` with a note on what to keep: the goal, what's still to do, the files changed and failing tests. Paste it into the agent.
- **Avatars in the notch**: each agent shows its own live pal in a round badge, in the pal, in the notch and on the landing page.
- **Landing page** in `site/`, using the real live pals. `site/build.mjs` builds it for any static host. `vercel.json` hosts it on Vercel, and there's a GitHub Pages workflow you can run by hand.

### Changed

- **Only active sessions in small mode**: agents working, waiting or busy in the last two minutes. When none are active, the most recent one shows.
- **Quiet pals doze off** after 3 minutes and wake on the next event. After 15 minutes of silence (an hour if it's waiting for you) the bridge ends the session and its pal leaves. The bridge is now the only thing that decides this.
- Speech bubbles stay inside the window, with the arrow still pointing at the pal.
- `dotpals status` lists every agent integration.

### Added: dashboard and more agents

- **More agents**: Cursor, Gemini CLI, OpenCode and GitHub Copilot CLI. Each is a small adapter "package" in `bridge/adapters/`, listed in `bridge/adapters/index.js`.
- **Agents page** in the dashboard. It has one card per agent showing:
  - whether the agent is installed and whether it's connected
  - its last event, and an on/off switch
  - what it connects through
  - **Connect** and **Disconnect**. Connect backs up the agent's config first and merges into it; Disconnect takes out only what dotpals added
  - **Send a test event**, which runs the real hook command and makes a pal say hello

  The **Any agent** card has copy-paste snippets for curl, PowerShell, Node, Python and the shell.
- **Requests read as a story**: in Sessions, each request shows a few chapters instead of a tally, like "Changed 4 files +13 −5", "Tests failed once, then passed" or "Committed, pushed and released v0.6.0". Click a chapter to see its steps. Things worth a second look are called out, such as "Changed .env, which usually holds secrets" or "Force-stopped programs".
- **Sessions over time** on the Overview: one lane per session, colored by agent. Each request is a bar split into its chapters. Hover a bar for details, click it to open the request. A "now" line shows the current time, and there's a table view.
- **Map** page:
  - **Where agents crossed paths** lists files changed by two sessions, e.g. "dashboard.html · Claude (Dot) then Codex (Dot) · 29 min apart", with links to each request.
  - A folder tree of every file changed, with a bar for how often, colored by agent. Files two agents touched get a "2 agents" badge.
  - Each session with the helper agents it started.
- `agents` setting in `~/.dotpals/config.json`, e.g. `{ "agents": { "cursor": false } }`.
- Bridge API:
  - `GET /api/agents`
  - `POST /api/agents/<id>/connect`, `/disconnect` and `/test`
  - `GET /api/usage`
  - `POST /hook?agent=<id>`
  - a `context` event on `/events` with how full each session's context window is
- `bridge/hook.js <agent>` forwards another agent's hook events. `DOTPALS_CURSOR_DIR`, `DOTPALS_GEMINI_DIR`, `DOTPALS_OPENCODE_DIR`, `DOTPALS_COPILOT_DIR` and `DOTPALS_CODEX_DIR` point dotpals at other config folders.

### Changed

- The agent cards moved from Settings to the new Agents page.

## [0.6.0] - 2026-09-30

### Added

- **Make your own pal**: in the dashboard's Settings, pick a body (6), eyes (6), something on top (9), any color, fluffy or smooth, and a name. The floating pal switches as soon as you save. **Surprise me** rolls a random one. In code: `registerCustom(spec)` from `dotpals` or `dotpals/custom`.
- **Every Claude Code session shows up**: dotpals now also follows the transcripts in `~/.claude/projects`, so sessions that started before the plugin was installed (or without it) appear too. `DOTPALS_CLAUDE_LOGS=0` turns this off.
- In small mode, every agent gets its own pal, side by side, and the round bar names each one ("Claude", "Codex", or the project when one agent runs twice). Click a name to open that session.

### Changed

- The round bar sits just above the pal or its speech bubble, instead of at the top of the window with a gap.
- In small mode, clicks on the empty space around the pal go through to the window underneath (Windows and macOS).
- macOS: the pal lives in the menu bar instead of the Dock. Linux: turned on transparent windows.

## [0.5.0] - 2026-09-30

### Added

- **One-command setup**: `npx --allow-git=all github:rikinshah787/dotpals setup` installs the pal, adds the Claude Code plugin, picks up Codex, starts at login and opens the dashboard. New `dotpals` command with `start`, `dashboard`, `status` and `bridge`.
- **Dashboard**: an Overview (requests, files changed, commands, agent time, requests per day, by project), Sessions (every session's requests, files and full log, with search and export to Markdown or JSON) and Settings.
- **Settings**, shared by the pal and dashboard in `~/.dotpals/config.json`: character, sounds, notifications, history on or off, how long to keep it, clear history, and following Codex.
- In small mode, a round bar above the pal shows each session as an icon, with expand and close.
- A 27-second demo video in `docs/`.

### Fixed

- Dragging the pal no longer makes the window grow with display scaling.
- Prompts no longer include the editor's hidden context (such as "the user opened file X").

### Security

- The bridge only answers requests addressed to localhost (blocks DNS-rebinding pages), and settings can only be changed by requests that carry a custom header, which other websites can't send.

## [0.4.0] - 2026-09-30

The first public release.

### Added

- A floating desktop pal built with Electron. It stays on top of your other windows, has a tray icon, and you can show or hide it with `Ctrl+Alt+P`. Drag the pal to move it anywhere on screen.
- **Summary** tab: one card per request, with what you asked, what the agent said it did, and a plain tally of changed files, commands run (and failures), skills and tools used. **Show steps** lists each step as a short sentence.
- **Tools** tab: every tool call. Click any row to see its details, including diffs for edits and the output of commands.
- **Files** tab: every file read, changed, created or deleted, with diffs.
- **Today** bar: requests, files changed, commands and agent time today, with **Copy today** for a standup note.
- **Copy** on any request, which copies it as Markdown for a PR description or commit message.
- History across restarts (the last week, in `~/.dotpals/history.json`; `DOTPALS_HISTORY=0` turns it off).
- Desktop notifications when the agent finishes a long request or waits for your OK.
- Claude Code adapter that uses hooks for live updates and reads the session transcript to fill in history, so the feed is complete even if you open the pal partway through a session. Slash commands and skills show up by name.
- Codex adapter that follows Codex's session logs, with nothing to set up on the Codex side.
- A generic `POST /event` format so any agent harness can drive a pal and add to its activity feed.
- One tab per session when several agents are running at once.
- Sounds for key moments, such as when a turn finishes or the agent is waiting for you.
- Tests (`npm test`) and CI on Windows, macOS and Linux.

### Changed

- Livelier pal animations: thinking pals glance around and sway, working pals scan like they're reading, and busy pals blink more.

## 0.1.0

The first internal version: the `<dot-pal>` web component, and a Claude Code bridge that turns hook events into pal states.

[Unreleased]: https://github.com/rikinshah787/dotpals/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/rikinshah787/dotpals/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/rikinshah787/dotpals/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/rikinshah787/dotpals/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/rikinshah787/dotpals/releases/tag/v0.4.0
