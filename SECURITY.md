# Security

## How dotpals handles your data

- **Local only.** The bridge (`bridge/server.js`) listens only on `127.0.0.1`, so other machines on your network can't connect to it.
- **Reads local files.** To build the activity feed, it reads Claude Code session transcripts (the `transcript_path` that Claude Code passes to hooks) and Codex session logs (`~/.codex/sessions`). Set `DOTPALS_CODEX=0` if you don't want it to read Codex logs.
- **Keeps a local history.** The last week of activity is saved to `~/.dotpals/history.json` so the feed survives restarts. Set `DOTPALS_HISTORY=0` to turn this off, or `DOTPALS_HOME` to move the folder.
- **Tells Claude Code about its own tests.** With *Make agents fix failing tests* (`fixLoop`, on by default), the plugin's hook (`bridge/loop-hook.js`) asks the local bridge after Claude's test runs, before a commit or push, and when Claude stops. The answer is a short note in Claude's context (how its tests went and why they failed, read from the output) or a request to keep going. Like anything in Claude Code's context, the note goes to the model Claude Code uses. Turn it off under the notch's gear or in Settings.
- **The MCP server only reads.** `dotpals mcp` talks to the assistant that started it over stdin and stdout, and reads from the bridge on `127.0.0.1`. It changes nothing. What it answers becomes part of that assistant's conversation, and goes to the model it uses.
- **Nothing is sent anywhere by default.** dotpals has no telemetry and no analytics. The data stays on your machine and only goes to the pal windows and browser tabs you open. Two things send data, and only when you use them: talking to Blu (below), and, opt-in, *Settings → Double-check unclear test results → Cloud (Jev)*, which sends the end of an unclear test run's output to TypeSafe, after removing anything that looks like a password, key, email or IP address. Your TypeSafe API key is stored in `~/.dotpals/config.json` (readable by you only on macOS and Linux) and is never sent to the pal, the notch or the dashboard.

Keep in mind that any program running on your own machine can connect to the bridge's local port and read the activity feed.

## Blu: your voice, your screen and your apps

Blu (Talk, circle and ask, and Dictate) only does something when you press its keys or click its microphone.

**What leaves your computer, and when**

- **Your voice doesn't.** Speech recognition (Whisper) and Blu's voice (Kokoro) run in the notch's page. Their models are downloaded once from Hugging Face, and the code that runs them from jsDelivr (`@huggingface/transformers`, `kokoro-js`, pinned versions).
- **What you say goes to Blu's brain**, the AI you picked in Settings: an API key's provider (Anthropic, OpenAI, Google, OpenRouter), or Claude Code or Codex on your subscription, which send it to their own service. With Ollama it stays on your computer. Along with it: the last few exchanges, your words list, the names of your connected apps, what your coding agents are doing (not in Everyday mode), and for a Talk plan, your project folders' names. With *Clean up dictation* on, what you dictate goes there too.
- **A screenshot only when you ask about the screen.** Talk's keys take a screenshot (with *Look at my screen when I ask about it* on, the default), kept in `~/.dotpals/shots` (the newest 20). It's sent to Blu's brain only when what you said matches a list of words about the screen ("this", "here", "what's", "explain", "look"…) or you circled something. A plan that's about the screen gives the task file its path, so Claude Code can open it.
- **Your apps** are called at their own addresses with your sign-in, and what their tools answer goes to Blu's brain. An app you added by its command runs on your computer, as you.
- **"Play …"** sends the song's name to YouTube's search (or Spotify's, with your Spotify key) to find the link.

**Trust boundaries**

- **Text on your screen, in an app's answer, or in your agents' sessions is untrusted**: someone else may have written it to give orders. Blu's instructions say never to follow orders in it, but the limits that hold are in code:
  - **A fixed list of actions** (`bridge/buddy.js`): play, pause and skip, the volume, opening an app, a web page (http and https only) or a song, and moving or sizing a window. Nothing that closes, deletes, sends or buys. Anything else in the AI's answer is dropped, and the list is checked again in the desktop app before anything runs (`desktop/main.js`, `desktop/hands.js`).
  - **Clicking, typing and pressing keys are off** unless you turn on *Let Blu click and type for me*.
  - **A brain that runs with its own tools** (Gemini CLI, Cursor) is never given your screen, an app or a plan; Claude Code as Blu's brain runs with its tools, MCP servers and settings off, and Codex in its read-only sandbox.
- **A change in your apps needs your yes.** A look is given only the app's read-only tools. A change is only done after you say yes (the Yes/No card, Ctrl+Alt+Y, or a plain spoken yes right after Blu asked about that same change; the AI can't confirm one, or swap in another, on its own), and even then never with tools that send, delete, pay, transfer, publish, comment, share or invite, reply or forward (other than as a draft), or that the app marks destructive. Blu's instructions also say that what an app's tools return was written by other people and isn't to be obeyed. For apps used **through Claude Code's own connectors**, dotpals can't choose which of the app's tools Claude calls: there, Claude's instructions (look only, or the one change; never send or delete) are the guard.
- **Coding work** goes to Claude Code only after you say "send it", in a project folder your agents already worked in, never a path from what you said. A pull request is opened only after you've seen what it will commit and push.

**Keys and tokens**

- API keys (and an optional Spotify client id and secret) are stored in `~/.dotpals/config.json`; app sign-ins, tokens included, in `~/.dotpals/apps.json`. Both are written readable by you only on macOS and Linux (on Windows they keep your user folder's permissions). Only the bridge reads them; pages see an API key's last 4 characters and an app's name and status. Each is sent only to its own provider or app. When Claude Code answers from one of your apps, the app's token is in its MCP config file (readable by you only, deleted after).
- App sign-in is MCP's: OAuth with PKCE, a `state` that's checked and used once (within 15 minutes), dotpals registered with the app as a public client (or the client you gave it), and the sign-in coming back to `http://127.0.0.1:<port>/api/apps/callback`. dotpals only follows sign-in addresses that are `https://` (or on this computer), and only sign-in metadata about that app's own host.

**The local endpoints**

- Blu's routes (`/api/talk/*`, `/api/brain/*`, `/api/apps/*`) are on the same `127.0.0.1` bridge. Every `POST` needs the `x-dotpals: 1` header, which websites can't send, and is refused when it carries an `Origin` other than this computer's. `GET /api/apps/callback` is the only one a browser opens directly, and it only finishes a sign-in dotpals started.
- The desktop app takes Blu's requests (screenshots, drawing, actions) only from the notch's own page, and the bridge reads a screenshot only from `~/.dotpals/shots`.
- As with the activity feed, other programs running on your computer can call these routes too, including asking for a look or a confirmed change in one of your apps. Treat software on your computer as able to do what you can.

## Supported versions

Security fixes go into the latest release.

## Reporting a vulnerability

Please **don't** open a public issue. Report it privately through GitHub's [private vulnerability reporting](https://github.com/rikinshah787/dotpals/security/advisories/new) (the **Security** tab, then **Report a vulnerability**).

Tell us what you found, how to reproduce it and what impact you think it has. We'll reply as soon as we can and keep you updated while we work on a fix.
