---
description: Float the dotpals pal on your screen (starts the bridge if needed)
allowed-tools: Bash(node:*), Bash(curl:*), Bash(start:*), Bash(open:*), Bash(xdg-open:*)
---

Put the live dotpals pal on the user's screen.

1. Open the floating desktop pal: `node "${CLAUDE_PLUGIN_ROOT}/desktop/launch.js"`. It runs the bridge itself, stays above other windows and shows every tool call and file Claude touches.
2. If that prints that Electron isn't installed, ask the user whether to download it (one time, about 100 MB into `~/.dotpals`). If they agree, run `node "${CLAUDE_PLUGIN_ROOT}/desktop/launch.js" --install` (it can take a minute). If they decline, fall back to the browser page:
   - Check whether the bridge is running: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5175/` (200 means running).
   - If it isn't, start it in the background: `node "${CLAUDE_PLUGIN_ROOT}/bridge/server.js"` (run in background, don't wait for it to exit).
   - Open http://localhost:5175 in the user's browser (`start` on Windows, `open` on macOS, `xdg-open` on Linux). If they passed a character name (`$ARGUMENTS`), open `http://localhost:5175/?character=$ARGUMENTS` instead.
3. Reply in one or two short sentences. For the floating pal, say it's in the bottom-right corner, can be dragged anywhere, and the ⤡ button shrinks it to just the pal. It will open by itself from now on whenever a Claude Code session starts.
