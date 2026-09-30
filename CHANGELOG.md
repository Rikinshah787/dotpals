# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/rikinshah787/dotpals/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/rikinshah787/dotpals/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/rikinshah787/dotpals/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/rikinshah787/dotpals/releases/tag/v0.4.0
