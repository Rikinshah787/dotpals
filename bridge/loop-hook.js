#!/usr/bin/env node
// Claude Code hook for the fix loop (Settings → Make agents fix failing tests; see
// hooks/hooks.json): runs in the foreground when a Bash or PowerShell command ends
// (PostToolUse, PostToolUseFailure), before one starts (PreToolUse) and when Claude is
// about to stop (Stop). It asks the bridge (POST /hook?loop=1), which answers in Claude
// Code's own format: a note that the tests failed, "block" (keep going, fix them) or
// "deny" (don't commit yet). This prints that answer as is.
//
// Commands that neither run tests nor commit or push are skipped here, without asking the
// bridge. It never starts anything and always exits 0: with no bridge, a slow one or
// nothing to say, it prints nothing and Claude carries on as usual.
// (The activity itself is reported by bridge/hook.js, which runs alongside, async.)
//
// Codex runs it too, as `loop-hook.js codex` (~/.codex/hooks.json): its hooks answer the same
// way. Codex's activity comes from its logs, so it also sends UserPromptSubmit here: a new
// request, and the loop counts again.
import { ships, stepType } from './ui/story.js';

const bridge = process.env.DOTPALS_BRIDGE || `http://127.0.0.1:${Number(process.env.DOTPALS_PORT) || 5175}`;
const agent = /^[a-z][a-z0-9-]*$/.test(process.argv[2] ?? '') ? process.argv[2] : null;
// A test run's result may go to the checker first, which takes up to 5 s; at Stop the bridge
// waits up to 1 s for the last steps to be reported.
const WAIT = { PostToolUse: 6500, PostToolUseFailure: 6500, Stop: 3000 };

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (body += chunk));
process.stdin.on('end', async () => {
  try {
    const event = JSON.parse(body);
    const name = event.hook_event_name;
    const command = String(event.tool_input?.command ?? '');
    // Before: a commit, a push, a PR, a publish (story.js ships). After: a test run.
    const worth = name === 'Stop' || name === 'UserPromptSubmit' || (name === 'PreToolUse' ? ships(command) : stepType({ kind: 'run', body: { command } }) === 'test');
    if (event.session_id && worth) {
      const res = await fetch(`${bridge}/hook?loop=1${agent ? `&agent=${agent}` : ''}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(Number(process.env.DOTPALS_LOOP_WAIT) || WAIT[name] || 1500),
      });
      const reply = await res.text();
      const answer = JSON.parse(reply);
      if (answer && typeof answer === 'object' && Object.keys(answer).length) process.stdout.write(reply);
    }
  } catch (err) {
    if (process.env.DOTPALS_DEBUG) console.error(err);
  }
  process.exit(0);
});
