#!/usr/bin/env node
// Claude Code hook (PreToolUse, only for Edit, Write, MultiEdit and NotebookEdit; see
// hooks/hooks.json): before Claude changes a file, ask the bridge whether another agent
// changed it in the last few minutes (Settings → Two agents, one file). If so, the
// bridge answers in Claude Code's PreToolUse format ("ask" you first, or "deny" with a
// note so Claude re-reads the file), and this prints it.
//
// It never starts anything, gives up after ~1.5 s and always exits 0: with no bridge,
// a slow one or nothing to say, it prints nothing and the edit goes ahead as usual.
// (The activity itself is reported by bridge/hook.js, which runs alongside, async.)
const bridge = process.env.DOTPALS_BRIDGE || `http://127.0.0.1:${Number(process.env.DOTPALS_PORT) || 5175}`;
const WAIT = Number(process.env.DOTPALS_GUARD_WAIT) || 1500;

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (body += chunk));
process.stdin.on('end', async () => {
  try {
    const event = JSON.parse(body);
    if (event.hook_event_name === 'PreToolUse' && event.session_id) {
      const res = await fetch(`${bridge}/hook?guard=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(WAIT),
      });
      const reply = await res.text();
      if (reply.includes('"hookSpecificOutput"')) process.stdout.write(reply);
    }
  } catch (err) {
    if (process.env.DOTPALS_DEBUG) console.error(err);
  }
  process.exit(0);
});
