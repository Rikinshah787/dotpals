# Security

## How dotpals handles your data

- **Local only.** The bridge (`bridge/server.js`) listens only on `127.0.0.1`, so other machines on your network can't connect to it.
- **Reads local files.** To build the activity feed, it reads Claude Code session transcripts (the `transcript_path` that Claude Code passes to hooks) and Codex session logs (`~/.codex/sessions`). Set `DOTPALS_CODEX=0` if you don't want it to read Codex logs.
- **Keeps a local history.** The last week of activity is saved to `~/.dotpals/history.json` so the feed survives restarts. Set `DOTPALS_HISTORY=0` to turn this off, or `DOTPALS_HOME` to move the folder.
- **Tells Claude Code about its own tests.** With *Make agents fix failing tests* (`fixLoop`, on by default), the plugin's hook (`bridge/loop-hook.js`) asks the local bridge after Claude's test runs, before a commit or push, and when Claude stops. The answer is a short note in Claude's context (how its tests went and why they failed, read from the output) or a request to keep going. Like anything in Claude Code's context, the note goes to the model Claude Code uses. Turn it off under the notch's gear or in Settings.
- **The MCP server only reads.** `dotpals mcp` talks to the assistant that started it over stdin and stdout, and reads from the bridge on `127.0.0.1`. It changes nothing. What it answers becomes part of that assistant's conversation, and goes to the model it uses.
- **Nothing is sent anywhere by default.** dotpals has no telemetry and no analytics, and makes no network calls of its own. The data stays on your machine and only goes to the pal windows and browser tabs you open. The one exception is opt-in: with *Settings → Double-check unclear test results → Cloud (Jev)*, the end of an unclear test run's output is sent to TypeSafe, after removing anything that looks like a password, key, email or IP address. Your TypeSafe API key is stored in `~/.dotpals/config.json` (readable by you only on macOS and Linux) and is never sent to the pal, the notch or the dashboard.

Keep in mind that any program running on your own machine can connect to the bridge's local port and read the activity feed.

## Supported versions

Security fixes go into the latest release.

## Reporting a vulnerability

Please **don't** open a public issue. Report it privately through GitHub's [private vulnerability reporting](https://github.com/rikinshah787/dotpals/security/advisories/new) (the **Security** tab, then **Report a vulnerability**).

Tell us what you found, how to reproduce it and what impact you think it has. We'll reply as soon as we can and keep you updated while we work on a fix.
