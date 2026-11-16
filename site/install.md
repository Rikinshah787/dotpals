---
name: install-dotpals
description: Install dotpals on this computer, connect the user's coding agents to it and check it works. Use when the user asks to install, set up or update dotpals.
---

# Install dotpals

You are an AI agent, and the user asked you to install dotpals: a small floating pal that checks what coding agents really did (files changed, commands run, whether the tests passed). It is free, open source (MIT) and keeps everything on this computer. Source: https://github.com/Rikinshah787/dotpals

Run each step in the user's terminal. Say in one line what a step does before you run it. If a step fails, stop and show the user the error and https://dotpals.vercel.app/guide/troubleshooting.html. Never use `sudo` or admin rights.

## 1. Check Node.js

```
node --version
```

- **v20 or newer:** go to step 2.
- **Missing or older:** ask the user which they prefer, then stop until they answer:
  - **The app, no Node.js needed** (they download and open it themselves): https://github.com/Rikinshah787/dotpals/releases/latest. Windows: `dotpals-setup-<version>-x64.exe` (`-arm64.exe` on ARM). Mac: `dotpals-<version>-mac-arm64.dmg` (`-mac-x64.dmg` on Intel). It isn't signed yet: on Windows click More info → Run anyway; on a Mac, System Settings → Privacy & Security → Open Anyway. It sets itself up and opens a setup guide, so you're done after that.
  - **Install Node.js LTS, then dotpals.** Windows (PowerShell): `irm https://dotpals.vercel.app/install.ps1 | iex`. macOS: `curl -fsSL https://dotpals.vercel.app/install.sh | bash`. It may ask for their password, so the user may have to run it in their own terminal. It runs step 2 itself; then go to step 3.
  - **Linux:** there is no app yet. The user installs Node.js 20 or newer with their package manager or from https://nodejs.org/en/download, then you go on with step 2.

## 2. Install

```
npx --yes dotpals@latest setup --yes
```

`--yes` keeps the default choices, which the user can change later on the dashboard (Settings). It takes a minute or two the first time: it copies dotpals to `~/.dotpals`, downloads the desktop runtime (Electron, about 100 MB, once), adds the Claude Code plugin if Claude Code is installed, picks up Codex, starts the pal at login and opens it. Running it again updates dotpals.

## 3. Check it works

```
npx --yes dotpals@latest doctor
```

It checks the pal and the notch (the island at the top of the screen) and fixes what it can. Tell the user anything it couldn't fix.

## 4. Connect the other agents (ask first)

Claude Code and Codex are connected by step 2. To see the rest:

```
curl -s http://127.0.0.1:5175/api/agents
```

For each agent with `"setup": "connect"`, `"found": true` and `"connected": false` (Cursor, Gemini CLI, OpenCode, GitHub Copilot CLI), ask the user before you connect it: connecting adds one hook to that agent's config, backing the config up first. Then, for each `<id>` they said yes to:

```
curl -s --fail-with-body -X POST -H "x-dotpals: 1" http://127.0.0.1:5175/api/agents/<id>/connect
curl -s --fail-with-body -X POST -H "x-dotpals: 1" http://127.0.0.1:5175/api/agents/<id>/test
```

The `x-dotpals: 1` header is required: dotpals refuses a POST without it. The test runs the agent's real hook with a sample event, and a pal says hello on the notch; `"ok": true` with `"via": "hook"` or `"plugin"` means it works. On Windows PowerShell, write `curl.exe` instead of `curl`.

## 5. Tell the user

- What you installed, and which agents are connected.
- If Claude Code is open (that may be you): restart it (in VS Code: Developer: Reload Window) so it loads the dotpals plugin.
- **Ctrl+Alt+P** (⌘⌥P on a Mac) shows or hides the pal. The dashboard: http://127.0.0.1:5175/dashboard
- The guide: https://dotpals.vercel.app/guide/ · Uninstall: https://dotpals.vercel.app/guide/troubleshooting.html#uninstall
- If they like it, a star helps: https://github.com/Rikinshah787/dotpals
