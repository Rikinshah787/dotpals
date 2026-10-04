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
import { stepType } from './ui/story.js';

const bridge = process.env.DOTPALS_BRIDGE || `http://127.0.0.1:${Number(process.env.DOTPALS_PORT) || 5175}`;
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
    const kind = name === 'Stop' ? null : stepType({ kind: 'run', body: { command: String(event.tool_input?.command ?? '') } });
    const worth = name === 'Stop' || (name === 'PreToolUse' ? kind === 'ship' : kind === 'test');
    if (event.session_id && worth) {
      const res = await fetch(`${bridge}/hook?loop=1`, {
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
