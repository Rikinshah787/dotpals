# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/rikinshah787/dotpals/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/rikinshah787/dotpals/releases/tag/v0.4.0
