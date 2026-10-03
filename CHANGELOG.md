# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.4] - 2026-10-03

### Changed

- **Install from npm:** `npx dotpals setup`. The package is published to npm as `dotpals`; installing straight from GitHub (`npx --allow-git=all github:rikinshah787/dotpals setup`) still works. Requires Node 20 or newer.
- **Setup asks one question.** "Default (recommended)" sets up Blu, the notch, sounds, one-line summaries and open-at-login with nothing else to answer; "Customize" keeps the full set of questions. Every choice can be changed later in Dashboard → Settings.
- **The notch is on by default.** A fresh install shows the island at the top of the screen right away, whether or not the pal is visible; setup's question now recommends "Always" (it used to recommend "only when the pal is hidden", so new installs saw no notch while the pal was up). Change it any time: tray → Notch, or `dotpals notch --auto` / `--off`.

### Fixed

- **The dashboard froze (“Not Responding”) for a while after start** on a big history: it re-rendered on every one of thousands of replayed entries. The bridge now says when the replay is over and the dashboard renders once.
- **Ghost dotpals processes** when a second copy started (a hook launching the pal while it was already running): the second copy exits at once instead of a quit that could hang.
- **The pal could sit half off the screen**, hiding its × and other buttons. It keeps itself inside the display now, and a one-time hint by the × says how to hide it (×, or Ctrl+Alt+P) and that it stays in the tray.
- **Updating didn't take effect while the pal was running.** `dotpals setup` on a machine with an older pal still open just brought the old window back, so the new version never ran. Setup now asks the running app to quit (`POST /api/app/quit`, desktop app only) and starts the new one.

### Added

- **Long sessions keep their context.** A session holds at most 1,500 steps; past that, dotpals used to drop the oldest steps, losing the original request. Now it drops look-ups first and keeps what matters: the first request and the latest four, the newest plan and its updates, the latest test run, commit and turn ending, and the steps that changed the 30 most recent files. The saved history uses the same rule. A trimmed session is still not a full record; a request from early on may keep only its prompt and a few steps.
- **Better `/compact` notes:** the original request and constraints (multi-line kept), the last three instructions with newer ones overriding older ones, full file paths, and real test evidence (passed, failed, still running, or changed since the last run).

- **How accurate is it?** 21 real requests and 145 claims, checked by hand against what happened (`test/accuracy/cases`). `npm run accuracy` prints the score and every wrong claim: 94.5% right, 4 wrong, 4 unsure, no false "risky" warnings. The tests fail if a claim that's right turns wrong. `scripts/accuracy-capture.mjs` turns your own requests into cases: one project's sessions only, prompts left out, paths, keys and emails removed.
- **Code changed through commands counts as a change.** `sed -i`, `> file`, `>> file`, `tee` and scripts that write a file they name (`writeFileSync`, `open(…, 'w')`, `write_text`) now get a "Ready to merge?" verdict and count for "tests ran after the last change", in folders without git too.
- **Git checks what really changed.** When a request starts, dotpals notes the state of the project's git repository; when it ends, it compares. The recap's Changed / Wrote / Deleted lists now come from git, so files changed by commands (`sed -i`, `node -e`, a code generator, a formatter) and commits show up too, marked "Changed by commands, not file tools". A request that changed code only through a command still gets a "Ready to merge?" verdict. When another agent was working in the same repository meanwhile, the card says some changes may be theirs; when the agent edited files but git shows nothing changed, it says so. Only file names and times are read, nothing is written, and it works for every agent. Switching branches isn’t counted as a change: only commits made during the request are.

### Fixed

Found by checking real requests by hand for the accuracy set:

- **Long commands lost their end**, so a test run at the end of a long command (`node fix.js && npm test`) wasn't seen. Every agent's commands now keep their start and their end.
- **"Deleted files with a recursive delete" for a temp folder in a variable**: `T=$(mktemp -d); …; rm -rf "$T"` and `rm -rf "$S/x"` with `S` set to a temp path are now a quiet note.
- **"Stopped trying" when the tests were fixed**: a failing single test file followed by a full test run that passes (`npm test`) now counts as fixed.
- **A question before a last sentence** ("Shall I keep going? That's the X and the Y.") now reads as "Finished with a question for you".

## [0.9.3] - 2026-10-01

### Added

- **Ready to merge?** Each finished request that changed code gets a verdict: "✅ Ready to merge" when tests ran after the last change and passed, nothing is left failing and nothing risky happened; otherwise "⚠ Not ready to merge" with the reasons ("No tests ran", "Changed b.js after the last test run", "Tests are failing", "Changed .env", "Committed without a passing test run"). In the pal, the notch, the dashboard and the copied recap.
- **Why it stopped**, in plain words: "Stopped trying: `npm test` still failed after 3 tries", "Said it was done, but the tests are failing", "Finished with a question for you", "Stopped with an error: …", "Cut off before it finished", "Waiting for you".
- **Failing test names**, next to the counts: "1 failed, 47 passed: test_locked_failure_does_not_block_requested_work" (in the chapter, the Simple sentence and the recap). Retries of the same failure are one line in the recap.
- **Two agents, one file.** When an agent is about to change a file that another agent session changed in the last 10 minutes, and that session is still at it, dotpals says so before they undo each other's work. **Claude Code can be stopped before the edit**: a new PreToolUse hook, only for Edit, Write, MultiEdit and NotebookEdit (`bridge/guard-hook.js`, in the foreground; the activity hook stays async), asks the bridge and gets Claude Code's own `permissionDecision`. **Ask me first** (the default) shows Claude Code's permission prompt with the reason, "Codex (api) changed billing.ts 2 minutes ago. Edit anyway?"; **Tell Claude** denies the edit and tells Claude "… Re-read the file first, then decide."; **Off**. It asks once per change of the other agent's, so the next try goes ahead, and it fails open: no bridge, or no answer within 1.5 s, and the edit goes ahead as usual. **Every other agent** (Codex, Cursor, Gemini CLI…) can't be stopped, since dotpals only follows what it did: the notch shows an alert ("Codex is editing billing.ts, which Claude (shop) changed 2 min ago") and the pal says it, with a desktop notification, once per file and pair of sessions per 10 minutes. Paths are compared without caring about case or slash direction, relative ones from each session's own folder; a session's own helpers don't count, nor do reads, failed edits or sessions that have gone to sleep. A paused edit shows "Paused: Codex (api) changed this file 2 minutes ago" in the pal's Tools and the dashboard's Log. Settings → Two agents, one file (`conflictGuard`: `ask`, `tell` or `off`; `conflictMinutes`, default 10), and a setup question. New: a `conflict` event, `POST /hook?guard=1`, `bridge/guard.js`.
- **Hand-off: Continue in Codex, Claude or Gemini, or Copy.** **Continue in ▾** on a session (in the pal's header, the notch's Story tab and the dashboard's session) writes a hand-off note from the session's record: the original ask and the last request, the latest request's recap with its evidence, the requests before it in a sentence each, the files changed, how the tests stand (with the failing output), what's left on the agent's plan, what's worth a second look and the agent's last message. It's saved to `~/.dotpals/handoff/<id>.md`, and the agent you pick (Codex, Claude Code or Gemini CLI, whichever are installed) opens in a **new** terminal window in the session's project folder, told to read that file and continue: Windows Terminal or a console window on Windows, Terminal on macOS, gnome-terminal, konsole or x-terminal-emulator on Linux. **Copy** puts the note on the clipboard instead. It can't type into an agent that's already open. Nothing from the session goes through a shell: the note is a file, the prompt only names it, the folder is the one the session itself reported (never one from the request) and only those three agents can be started. New: `POST /api/handoff { session, agent }`, `GET /api/handoff/agents`, `bridge/handoff.js`, `bridge/ui/handoff.js`.
- **The copied recap separates what happened, with evidence.** **✅ Ran successfully**, **❌ Failed**, **❔ Unclear** and **⚪ Not run** are listed apart, and each claim shows its command, the result it was read from ("Tests: `npm test` → 48 passed") and the step's ID, which the dashboard's search opens. A failure that was retried says "(fixed on try 2)". Quick look-ups (`ls`, `grep`, `git status`) aren't counted as failures. Suggested in a reply on X.
- **Setup asks a few choices in the terminal**: your pal, sounds, the notch, Simple or Detailed, approving from the pal, sharing between agents, double-checking test results (Off, Local Laya, or Cloud Jev with the key typed hidden), Claude's usage limits and opening at login. Enter keeps each default; `--yes` (or no terminal) asks nothing. It ends with what you chose and the next steps. The Simple/Detailed choice is a setting now (`storyView`), and the dashboard's Requests tab has the switch too.
- **Simple and Detailed views** of the story, in the pal's Summary and the notch's Story (a switch next to the tabs; remembered). **Simple**, the new default, is one plain sentence per request ("Changed billing.ts, the tests passed after one retry, and committed and pushed.", "Changed 2 files, but it didn't run the tests.") plus the warnings that matter. **Detailed** is the chapters as before, with small steps (tool plumbing, scratch files, memory) folded into "+ N small steps". Copy copies the view you're looking at. Rules, not AI: `simple()` in `bridge/ui/story.js`.
- Deleting a temporary, scratch or build folder (`$TEMP`, `dist`, `node_modules`…) is now a quiet note, not a warning. Deleting anything else recursively still warns.
- A command now counts for what it **runs**, not for what it writes into a file or an inline script: writing a test that mentions `git push` or `rm -rf` no longer reads as "pushed" or "Deleted files". `timeout 150 npm test` counts as a test run, and a request that stopped before finishing says "Stopped before finishing: …" instead of "Working on it".
- **Test results show their evidence, and "unclear" is never a pass.** Building on [claude-referee](https://github.com/ismaildasci/claude-referee) by Ismail Dasci (MIT), whose test-output parsers, redaction rules and "done" question are adapted here, with credit in the files and in `THIRD_PARTY_NOTICES`.
  - Each test run says where its result came from: "Tests passed · 48 passed", "Tests failed · 1 failed, 47 passed" (from the output's summary) or "Tests passed (exit code only)". The test chapter says it too: "npm test · 48 passed".
  - Summaries are read for jest, vitest, mocha, `node --test` and TAP, pytest and unittest, go test, cargo test, dotnet test, Maven, Gradle, Deno, Bun, PHPUnit and RSpec (`parseTestOutput()` in `bridge/ui/testout.js`). A failure marker anywhere beats a passing line.
  - **Tests unclear**: zero tests ran or all were skipped ("Tests unclear: no tests actually ran", a common false green), the exit code says passed but the output shows a Traceback or `Error:` lines, or the exit code says failed but the output looks fine. Unclear never counts as passed: the request is flagged and a commit after it isn't "tested". `testVerdict()` in `bridge/ui/story.js`; `testPassed()` still returns true, false or null.
- **Double-check unclear test results** (Settings, off by default). A checker looks at an unclear run once and decides, with a probability: 0.7 or more is passed, 0.3 or less failed ("Tests passed · checked by Jev, 94% sure"). Clear results are never sent. It gets 5 seconds and fails open ("couldn't check"); the same output is never asked about twice. **Recent checks**, under the setting, lists each one: the test run, why the rules weren't sure, what the checker said and how sure it was, how long it took, and the end of the output it looked at, with a link to the run in its session's log. Each check also shows where it happened: a badge on the test run in the session's Log and the pal's Tools tab ("Jev ✕ 78%"), why it was asked and what the checker said when you open it, and a **Test checks** tile on the dashboard's Overview (how many, what they said, how fast).
  - **Local**: [Laya](https://huggingface.co/convaiinnovations/laya) by Convai Innovations, on your computer. Nothing leaves your computer. **Set up Laya** is one click (or `dotpals laya` in a terminal): dotpals finds Python 3.10+, makes its own Python environment in `~/.dotpals/laya`, installs `laya[serve]` there, and runs `laya-serve` on `127.0.0.1` only, with live progress. The first time downloads a few GB (PyTorch and the model). After that dotpals starts Laya whenever the checker is on Local and stops it when you choose something else or quit; **Stop**, **Start** and **Remove Laya** are on the same page (`dotpals laya --remove`). Without Python it says so and links to python.org. Running your own `laya-serve` still works, under *Advanced: use my own Laya server*. New: `checker.layaManaged`, `checker.laya` (its status) in the settings, a `laya` event, and `POST /api/checker/laya/setup|start|stop|uninstall` (`bridge/laya.js`).
  - **Cloud**: TypeSafe's Jev, with your API key, through TypeSafe's official SDK (`@typesafe-ai/sdk`, a new optional dependency, loaded only in this mode). The test output is sent after removing anything that looks like a password, key, email or IP address. The key is write-only on the Settings page (it shows "Saved ••••1234"), `TYPESAFE_API_KEY` works too, and `config.json` is now written readable by you only on macOS and Linux.
  - **Test connection** sends one tiny request. `POST /api/checker/test`; the answer is on the entry as `check`.
- Poke a pal three times quickly and it gets dizzy, as before, and now says so ("Whoa, too many pokes at once!"), in the pal window and the notch.
- **A light theme for the website** (the landing page and the docs). It follows your system setting, and a sun/moon button in the header switches it, remembered for next time. Mockups of the app (the notch, the pal's window, the terminal) stay dark, like the real thing.

### Changed

- Long command output keeps its start and its end ("… (12480 characters cut) …"), instead of only its start, so a test summary printed last isn't lost (`clipEnds()` in `bridge/activity.js`, used by every adapter and for `POST /event` output).
- The website shows its visitor count on the home page ("1,284 visitors so far"), instead of counting with Vercel Web Analytics. Each browser counts once, the first time it visits, using a public counter that keeps only the number. No cookies, nothing about the visitor is sent, and the line stays hidden if the counter is down. The app still sends nothing anywhere, unless you turn on the cloud test checker above.

### Fixed

- **From the pull request's reviews** (Copilot, CodeRabbit and Sentry's Seer review bot):
  - "Ready to merge" when one test target failed and a different one passed. A test or build that failed and never passed now blocks it ("`npm run test:unit` failed and wasn't fixed").
  - A retry that failed by its counts (exit code 0) got its own ❌ line in the recap. It now folds into the first one.
  - "Changed system permissions" or "Force-stopped programs" for a `grep "sudo"` or `grep "Stop-Process"`. Quoted text no longer counts for these two.
  - Hand-off notes are saved readable by you only.
  - "Copied ✓" showed even when the clipboard refused. The menu now says it couldn't copy.
  - A pre-release install (`0.9.3-rc.1`) no longer counts as up to date with the release.
  - Hand-off on Windows starts the agent from its full path on PATH. `cmd` looks in the current folder first, so a project with its own `codex.cmd` could have run instead.
  - A request still running no longer reads "Cut off before it finished" in the dashboard, a copied recap or a hand-off note.
  - `xargs -n 1 rm -rf`, `sudo -u root rm -rf …` and `timeout -s KILL 30 …`: a wrapper option's value no longer hides the command, so the warning shows.
- **Four wrong lines in the copied recap**, found by checking a real one against what happened:
  - Tests piped into another command (`npm test | grep fail`) were "passed (exit code only)", but the exit code was grep's. They're now ❔ unclear, unless the output has counts.
  - "Changed system permissions" came from the word `sudo` inside a `node -e "…"` script. Code in another language no longer triggers the whole-line rules; `bash -c "…"` still does.
  - Scratch files outside the project were listed under Wrote. They're now counted: "Also touched 2 files outside the project".
  - A failed test run wasn't linked to the run that fixed it when the two commands differed only in their pipes, or when the failure showed in the counts but the exit code was 0. Both now show "(fixed on try 2)".
- **Is the checker working?** A status line under the checker says "Jev is working · answered 4 min ago in 227 ms" or "Jev isn't answering: TypeSafe didn't accept the API key · since 4:10 PM", from its answers, Test connection and a heartbeat (on start, when the setting changes, then every 30 minutes; for Jev that's the free model list). Recent checks starts with why it's rarely asked ("82 test runs · 79 settled by the rules · 3 unclear → 2 checked"), and the Overview's Test checks tile shows a green or red dot while a checker is on.
- **Test connection said the TypeSafe SDK wasn't installed** when the pal had been opened by the Claude Code plugin: the plugin started dotpals from its own folder, which doesn't have what setup installs. The plugin now opens the installed copy (`~/.dotpals/app`) when there is one, the checker also looks for the SDK there, and an **Install it** button next to Test connection installs it in one click when it's missing.

## [0.9.2] - 2026-09-30

### Added

- **Was it tested?** A green result from before the latest edits no longer looks like a check of the current code. Ideas from [@magpiehoard](https://x.com/magpiehoard).
  - A finished request that changed code warns **"Not tested: changed 2 code files, and the agent ran no tests"**, or **"Changed app.tsx after the tests passed: not tested since"**. It also warns when the agent committed without a passing test run after the last change.
  - The pal's Summary and the notch's Story show one line for the session: "Tests passed at 7:08 PM · 3 files changed since", "No tests run by the agent", "Tests failing", plus whether the last commit was tested.
  - A test run's result comes from its output when it says ("ℹ fail 0", "5 passed", "test result: ok"), not only the exit code. A command like `npm test && restart` that fails after the tests passed no longer reads as "Tests failing". A command counts as a test run only when it runs one (`cd app && npm test`), not when it just mentions `npm test`.
  - Docs, images and lockfiles don't count as code. Only tests the agent ran count, because dotpals can't see the ones you run yourself or in CI. `testState()` and `testLine()` in `bridge/ui/story.js`.

### Fixed

- Code blocks in an agent's reply disappeared: **Copy** dropped them (it now keeps the reply as Markdown, as the agent wrote it), and on screen they were cut out (they now show their contents).
- A Claude Code prompt with pasted text showed the paste's raw `<pasted_content id="…">` wrapper in its title. Now the title is what you typed plus "[pasted text]", or "Pasted: <its first line>" when you only pasted.

### Changed

- The website counts its visitors with Vercel Web Analytics (no cookies, nothing that identifies you), and its privacy page says so. The app itself still sends nothing anywhere.
- The README and the feature guide cover retries, "Was it tested?", search by ID and minimizing the notch.

## [0.9.1] - 2026-09-30

### Added

- **Retries**: when a step fails and the agent tries the same thing again (the same file, command or tool call), dotpals links the tries. In the pal's Tools tab and the dashboard's Log, a failed step says **fixed on try 2** or **still failing after 3 tries**, a retry says which try it was, and opening either shows every try with its result. You can click a try to jump to it. The story says it too: "1 edit failed, fixed on the next try". `retries()` in `bridge/ui/story.js`.
- **Search by ID** on the dashboard: paste a step's ID (the agent's own tool-call ID, e.g. `toolu_…`) and it opens that session's Log on that step. Each step shows its ID.
- **Minimize the notch**: a **–** button in the open notch hides the slim bar while agents work, so the top of your screen stays clear. It's remembered. When an agent needs you, the notch still opens by itself, and hovering the top edge still brings it up. Click the button again (now a small bar icon) to keep the bar on screen.

### Fixed

- In small mode, the round bar's buttons (⤢, ×, the session chips) could stop taking clicks: the window stayed see-through after Windows stopped telling the page where the mouse was. The app now decides itself, from the real cursor position. It also works on Linux now.
- The notch's pal button now switches the pal on and off: it brings the small pal back, waving, when it's hidden, and puts it away when it's on screen. Before, it did nothing while the pal was already showing. The icon shows which one it'll do (eyes open: on screen).

## [0.9.0] - 2026-09-30

### Added

- **Notch 2.0**: the notch is rebuilt around a small state machine (`bridge/ui/notch-state.js`, pure and tested) and comes in four sizes:
  - **hidden**: a thin, invisible strip at the top edge, when nothing is running or you've been away for 3 minutes,
  - **peek**: hover that strip and a small island peeks out; rest on it a moment to open it,
  - **bar**: mini pals for each agent, the current step and a usage ring; hover for about 200 ms, or click, to open,
  - **open**: 640 px wide, with a big pal on the left, one card on the right, a column of mini pals for the other agents, and **Now** and **Story** tabs.
- **Now** tab: a live diff of the file the agent is editing, with a language chip and the newest line typing in (`bridge/ui/notch-diff.js`), or a checklist of its steps; then its plan, context, helpers and your usage. An approval card with **Deny** (Ctrl+Alt+N) and **Allow** (Ctrl+Alt+Y), ⌘⌥N and ⌘⌥Y on macOS. These shortcuts are held only while the card is showing. A done card (about 5 s) and an error card (about 8 s).
- **Story** tab: today's totals with Copy today, the plan, helpers, the context window with Copy /compact, the "Using" row, the two-agents-one-file note, and the last few requests as chapters you can expand.
- **The pal's faces**: expression eyes (happy, closed, wide, ×, spinning spirals, hearts and sparkle-stars) that swap in with the mood, behind a blink. New `pal.emote(name, ms?)`, `pal.greet()`, `pal.burst(kind?, count?)`, the read-only `pal.tiny`, and static `DotPal.pointAt(x, y)` and `DotPal.emotes`.
- New actions: `hop`, `jitter`, `hello` and `dizzy`.
- `CharacterDefinition.eyes` (`at`, `r`, `ink`, `glow`, `own`) and the `.dp-eyes` class hook, so your own characters get expression eyes. Every built-in character and custom pal has them.
- Particles are drawn as SVG, so they look the same everywhere. An action's `particles` takes a shape name: `heart`, `sparkle`, `star`, `sweat` or `z` (any other text still works).
- The `lean="none"` attribute, the `--dp-glow` CSS variable (a soft light behind the pal in its state's color; set it to `transparent` to turn it off), and the `tiny` attribute, set by itself under 48 px (no fur, bigger eyes).
- The `dotpal-poke` event, `{ count }`, on every click.
- Reactions: the pal blinks when you hover it, gets heart eyes when you rest the mouse on it for 2 s, makes a "hey" face when you click, and gets dizzy after 3 quick clicks.
- **A new launch video** with sound (47 s, filmed from the real app), attached to the release, and a new README GIF.

### Changed

- **The notch opens and closes by itself, sensibly.** Alerts open it, one at a time. One that needs you shows even when you're away and stays until you answer. Opened by you, it closes 8 s after the pointer leaves (it covers tabs and title bars), or after a quiet minute with the pointer resting on it, with a shrinking line for the last seconds. Esc closes it, but only while the pointer is over it, so it never takes Esc from your editor.
- **The notch's window lets clicks through everywhere except the island**, and the peek never takes a click. The window gets the cursor position and your idle time from the app, since it never takes focus.
- The notch opens with a spring and closes cleanly, its content fades between views, and it respects `prefers-reduced-motion`. The when-to-show modes (auto, always, off) are unchanged.
- The notch dismisses a session from the open view ("× Dismiss" under the agent's pal, on hover), as well as from the × on the session's tab in the pal.
- State entry moves: `waiting` hops, then bounces (it used to wobble); `error` jitters; `done` jumps with sparkles; and after 90 s of work the pal breaks a sweat now and then.
- `during()` plays `jitter` on failure instead of `shake`.
- Moods, idle loops and actions blend into each other instead of snapping.
- With reduced motion, the pal keeps its faces and blinks but skips the big moves.

## [0.8.1] - 2026-09-30

### Fixed

- Share with your agents: the hook now works out the project name the same way the bridge does (either slash style), so notes reach sessions on macOS and Linux too.

## [0.8.0] - 2026-09-30

### Added

- **Share with your agents** (off unless you turn it on in Settings): when a Claude Code session starts, it gets a short note about the other agents that worked in the same project in the last 2 hours: what they changed, whether their tests pass, and whether they're still working. Later prompts only get a note when there's news. It uses the documented `additionalContext` from a new foreground hook, `bridge/context-hook.js` (3 s timeout, never blocks), and the new `GET /api/recap` route.
- **Dismiss a session**: a × on each session tab and each notch card puts that session to sleep everywhere (`POST /api/sessions/<id>/dismiss`). It comes back if the agent does something new.
- **Tools filters**: Key steps (the default: no file reads or searches), Changes, Commands, Problems and All, with counts.
- **Helpers (subagents), for any agent**: the notch and the pal list each session's helper agents, what each is doing now ("Explore · Reading src/auth.js") and a ✓ when done. They come from every agent's "start a helper" steps (Claude's Agent tool, Codex's `spawn_agent`), from Claude Code's `SubagentStart`/`SubagentStop` hooks and the `agent_id` on a helper's tool calls (so background helpers are tracked correctly), and from a new `helper` field in the generic event format: `{ "session": "s1", "helper": { "id": "w1", "name": "tester", "task": "Run e2e", "state": "working" | "done" | "error", "text": "Running playwright" } }`. There's a new `helpers` event on `/events`.

### Changed

- **Files** lists changed files first, with the folder dimmed, +adds −dels and "edited N×". Files it only read are folded away.
- Session tabs show only active sessions (on the stage, or busy in the last 30 minutes).
- The pal's bubble no longer shows your own message as a step, and it cuts text at a whole word instead of with "…".
- **Documentation**: a 10-page guide on the website (`site/guide/`: getting started, features, agents, CLI, configuration, HTTP API, the web component, architecture, privacy and security, troubleshooting) and `docs/ARCHITECTURE.md` for contributors.
- `dotpals setup` adds the `dotpals` command to your terminal (a global npm link to `~/.dotpals/app`; skip it with `--no-path`).
- Approve from the pal waits only while the pal or the notch is open (they can show the card), not for a dashboard tab alone.
- One port setting everywhere: `DOTPALS_PORT` (then `PORT`) for the bridge, the hooks and the recap hook. `DOTPALS_CODEX_DIR` also applies to usage limits, and `DOTPALS_HOME` also sets where Electron is downloaded.

### Security

- `POST /hook` and `POST /event` now refuse requests from other websites (a browser `Origin` that isn't this computer) and requests addressed to another host name, so a web page can't inject fake activity or fake approval cards.

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
- **Approve from the pal**: answer Claude Code's permission prompts ("Allow Bash: git push?") with Allow or Deny from the pal or the notch. The request shows exactly what will run, with warnings such as "Force-pushes to git". Off by default; turn it on in Settings. It waits only while a pal, the notch or the dashboard is open, for up to 30 seconds (15 seconds to 2 minutes in Settings). If you don't answer, Claude asks in the terminal as usual. It uses Claude Code's documented `PermissionRequest` hook. In `hooks/hooks.json` that hook now runs in the foreground (130 s timeout) so it can answer.
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

[Unreleased]: https://github.com/rikinshah787/dotpals/compare/v0.9.4...HEAD
[0.9.4]: https://github.com/rikinshah787/dotpals/compare/v0.9.3...v0.9.4
[0.9.3]: https://github.com/rikinshah787/dotpals/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/rikinshah787/dotpals/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/rikinshah787/dotpals/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/rikinshah787/dotpals/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/rikinshah787/dotpals/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/rikinshah787/dotpals/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/rikinshah787/dotpals/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/rikinshah787/dotpals/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/rikinshah787/dotpals/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/rikinshah787/dotpals/releases/tag/v0.4.0
