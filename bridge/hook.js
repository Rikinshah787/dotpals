#!/usr/bin/env node
// Agent hook → dotpals bridge. Forwards the hook JSON (stdin) to the bridge and
// always exits 0, so the agent is never blocked or slowed down.
//
//   node bridge/hook.js            Claude Code (hooks/hooks.json)
//   node bridge/hook.js <agent>    another agent's hooks, e.g. "cursor" or "gemini";
//                                  the bridge reads it with bridge/adapters/<agent>.js
//   node bridge/hook.js <agent> <event>
//                                  for agents whose payload doesn't name its event (Copilot CLI)
//
// If the bridge isn't running when a Claude Code session starts or a prompt is
// sent, the floating desktop pal is opened (it runs the bridge), or just the
// bridge if Electron isn't installed. Set DOTPALS_AUTOSTART=0 to turn that off,
// or DOTPALS_FLOAT=0 to only start the bridge. Other agents wait for the hook
// to finish, so for them it only forwards (and gives up fast).
//
//   { "type": "command", "command": "node /path/to/dotpals/bridge/hook.js", "async": true }
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const agent = /^[a-z][a-z0-9-]{0,30}$/.test(process.argv[2] ?? '') ? process.argv[2] : null;
const base = process.env.DOTPALS_URL || `http://127.0.0.1:${Number(process.env.DOTPALS_PORT) || 5175}/hook`;
const url = agent ? `${base}${base.includes('?') ? '&' : '?'}agent=${agent}` : base;
const eventArg = /^[A-Za-z]{1,40}$/.test(process.argv[3] ?? '') ? process.argv[3] : null;
const AUTOSTART_EVENTS = ['SessionStart', 'UserPromptSubmit'];

// What each agent expects on stdout, so it carries on as if there were no hook.
// Cursor: beforeSubmitPrompt takes { continue }, the rest {} (cursor.com/docs/hooks).
// Gemini CLI: JSON or nothing; {} changes nothing (geminicli.com/docs/hooks).
const REPLY = {
  cursor: (event) => (event === 'beforeSubmitPrompt' ? '{"continue":true}' : '{}'),
};

// A Claude Code permission request can be answered from the pal (Settings → Approve
// from the pal), so wait for the bridge's reply; the bridge itself gives up after
// `approvalWait` seconds (at most 120) and hooks/hooks.json allows 130.
let asking = false;
const send = (body) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(asking ? 125_000 : agent ? 700 : 1000),
  });

async function startBridge() {
  const { installedRoot, launchFloat } = await import('../desktop/launch.js');
  // The installed copy when there is one (it has setup's extras, like the TypeSafe SDK),
  // else the plugin's own files.
  const app = installedRoot();
  if (process.env.DOTPALS_FLOAT !== '0' && launchFloat(undefined, app ? { app } : {})) return;
  const server = app ? join(app, 'bridge', 'server.js') : fileURLToPath(new URL('./server.js', import.meta.url));
  spawn(process.execPath, [server], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (body += chunk));
process.stdin.on('end', async () => {
  if (eventArg) {
    // VS Code's Copilot Chat sends no cwd but runs the hook in the workspace folder.
    try { body = JSON.stringify({ hook_event_name: eventArg, cwd: process.cwd(), ...JSON.parse(body) }); } catch {}
  }
  try { asking = !agent && JSON.parse(body).hook_event_name === 'PermissionRequest'; } catch {}
  try {
    const res = await send(body);
    // The answer from the pal ("allow" or "deny"), in Claude Code's hook format.
    if (asking) {
      const reply = await res.text();
      if (reply.includes('"hookSpecificOutput"')) process.stdout.write(reply);
    }
  } catch {
    let event = '';
    try { event = JSON.parse(body).hook_event_name; } catch {}
    if (!agent && process.env.DOTPALS_AUTOSTART !== '0' && !process.env.DOTPALS_URL && AUTOSTART_EVENTS.includes(event)) {
      await startBridge();
      // Electron takes a moment to boot; keep trying for a few seconds.
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 300));
        try { await send(body); break; } catch {}
      }
    }
  }
  if (agent && REPLY[agent]) {
    let event = '';
    try { event = JSON.parse(body).hook_event_name; } catch {}
    process.stdout.write(REPLY[agent](event));
  }
  process.exit(0);
});
