# Security

## How dotpals handles your data

- **Local only.** The bridge (`bridge/server.js`) listens only on `127.0.0.1`, so other machines on your network can't connect to it.
- **Reads local files.** To build the activity feed, it reads Claude Code session transcripts (the `transcript_path` that Claude Code passes to hooks) and Codex session logs (`~/.codex/sessions`). Set `DOTPALS_CODEX=0` if you don't want it to read Codex logs.
- **Keeps a local history.** The last week of activity is saved to `~/.dotpals/history.json` so the feed survives restarts. Set `DOTPALS_HISTORY=0` to turn this off, or `DOTPALS_HOME` to move the folder.
- **Nothing is sent anywhere.** dotpals has no telemetry, no analytics and no network calls. The data stays on your machine and only goes to the pal windows and browser tabs you open.

Keep in mind that any program running on your own machine can connect to the bridge's local port and read the activity feed.

## Supported versions

Security fixes go into the latest release.

## Reporting a vulnerability

Please **don't** open a public issue. Report it privately through GitHub's [private vulnerability reporting](https://github.com/rikinshah787/dotpals/security/advisories/new) (the **Security** tab, then **Report a vulnerability**).

Tell us what you found, how to reproduce it and what impact you think it has. We'll reply as soon as we can and keep you updated while we work on a fix.
