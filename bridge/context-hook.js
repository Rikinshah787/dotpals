#!/usr/bin/env node
// Claude Code hook (SessionStart, UserPromptSubmit): tell this session what your
// other coding agents did in the same project, so they don't work blind on the
// same files. Off unless you turn on Settings → Share with your agents.
//
// It asks the bridge (GET /api/recap) and, if there's something to say, prints it
// as `additionalContext`, which Claude reads as context; you don't see it in the
// chat. On session start it gets the whole note; on later prompts only news since
// the last note. It never starts anything, gives up after ~1.5 s, and always exits
// 0, so Claude carries on either way.
import { basename } from 'node:path';

const bridge = process.env.DOTPALS_BRIDGE || `http://127.0.0.1:${Number(process.env.DOTPALS_PORT) || 5175}`;

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (body += chunk));
process.stdin.on('end', async () => {
  try {
    const event = JSON.parse(body);
    const name = event.hook_event_name;
    if ((name === 'SessionStart' || name === 'UserPromptSubmit') && event.session_id && event.cwd) {
      const q = new URLSearchParams({
        session: String(event.session_id),
        label: basename(String(event.cwd).replace(/[\\/]+$/, '')),
        mode: name === 'SessionStart' ? 'start' : 'prompt',
      });
      const res = await fetch(`${bridge}/api/recap?${q}`, { signal: AbortSignal.timeout(1500) });
      const { text } = await res.json();
      if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: name, additionalContext: text } }));
    }
  } catch (err) {
    if (process.env.DOTPALS_DEBUG) console.error(err);
  }
  process.exit(0);
});
