#!/usr/bin/env node
// Claude Code hook → dotpals bridge. Forwards the hook JSON (stdin) to the
// bridge and always exits 0, so Claude is never blocked or slowed down.
//
// If the bridge isn't running when a session starts or a prompt is sent, the
// floating desktop pal is opened (it runs the bridge), or just the bridge if
// Electron isn't installed. Set DOTPALS_AUTOSTART=0 to turn that off, or
// DOTPALS_FLOAT=0 to only start the bridge.
//
//   { "type": "command", "command": "node /path/to/dotpals/bridge/hook.js", "async": true }
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchFloat } from '../desktop/launch.js';

const url = process.env.DOTPALS_URL || 'http://127.0.0.1:5175/hook';
const AUTOSTART_EVENTS = ['SessionStart', 'UserPromptSubmit'];

const send = (body) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(1000),
  });

function startBridge() {
  if (process.env.DOTPALS_FLOAT !== '0' && launchFloat()) return;
  const server = fileURLToPath(new URL('./server.js', import.meta.url));
  spawn(process.execPath, [server], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (body += chunk));
process.stdin.on('end', async () => {
  try {
    await send(body);
  } catch {
    let event = '';
    try { event = JSON.parse(body).hook_event_name; } catch {}
    if (process.env.DOTPALS_AUTOSTART !== '0' && !process.env.DOTPALS_URL && AUTOSTART_EVENTS.includes(event)) {
      startBridge();
      // Electron takes a moment to boot; keep trying for a few seconds.
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 300));
        try { await send(body); break; } catch {}
      }
    }
  }
  process.exit(0);
});
