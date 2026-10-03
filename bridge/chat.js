// Chat: send prompts to OpenCode from the pal.
//
// The bridge starts its own headless `opencode serve` on 127.0.0.1 the first time you send
// something, protected by a random password that only this process knows. Prompts go in
// with POST /session/:id/prompt_async; everything OpenCode does comes back through the
// dotpals OpenCode plugin (the server loads ~/.config/opencode/plugins like the TUI does),
// so the reply shows up in the pal's feed and summary like any other session.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** Where the opencode executable is: $DOTPALS_OPENCODE_BIN, the npm global install, or PATH. */
function findOpencode() {
  if (process.env.DOTPALS_OPENCODE_BIN) return process.env.DOTPALS_OPENCODE_BIN;
  const candidates = process.platform === 'win32'
    ? [join(process.env.APPDATA || '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')]
    : [join(homedir(), '.opencode', 'bin', 'opencode')];
  return candidates.find((p) => existsSync(p)) || 'opencode';
}

/**
 * `onEvent(event)`: every event OpenCode's server sends ({ type, properties }), so the bridge
 * can show permission requests and questions from sessions started here.
 */
export function createChat({ port = Number(process.env.DOTPALS_OPENCODE_PORT) || 4196, onEvent } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const password = randomBytes(24).toString('base64url');
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  let proc = null;
  let ready = null;
  let lastError = null;
  let stopListening = () => {};
  const folders = new Map(); // request id → the folder its OpenCode instance runs in

  /** Follow the server's global event stream while it runs. */
  function listen() {
    const ctl = new AbortController();
    (async () => {
      while (!ctl.signal.aborted && proc) {
        try {
          const res = await fetch(new URL('/global/event', base), { headers: { authorization: auth }, signal: ctl.signal });
          const decoder = new TextDecoder();
          let buffer = '';
          for await (const chunk of res.body) {
            buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
            let end;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
              if (!data) continue;
              try {
                const msg = JSON.parse(data);
                const event = msg.payload ?? msg;
                const id = event?.properties?.id;
                if (id && typeof msg.directory === 'string') folders.set(id, msg.directory);
                onEvent?.(event);
              } catch {}
            }
          }
        } catch {}
        if (!ctl.signal.aborted) await sleep(1000);
      }
    })();
    return () => ctl.abort();
  }

  async function call(path, { method = 'GET', body, directory, timeout = 15_000 } = {}) {
    const url = new URL(path, base);
    if (directory) url.searchParams.set('directory', directory);
    const res = await fetch(url, {
      method,
      headers: { authorization: auth, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`OpenCode answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    if (res.status === 204) return null;
    return res.json().catch(() => null);
  }

  function stop() {
    stopListening();
    stopListening = () => {};
    if (!proc) return;
    try {
      // On Windows a plain kill can leave the server's own children running.
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      else proc.kill();
    } catch {}
    proc = null;
    ready = null;
  }

  /** Start `opencode serve` once and wait until it answers. */
  function start() {
    if (ready) return ready;
    ready = (async () => {
      const exe = findOpencode();
      lastError = null;
      const child = spawn(exe, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
        cwd: homedir(),
        env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
        stdio: 'ignore',
        windowsHide: true,
        shell: exe === 'opencode', // only the bare name needs PATH lookup (opencode.cmd on Windows)
      });
      proc = child;
      child.on('error', (err) => { lastError = err; });
      child.on('exit', () => { if (proc === child) { proc = null; ready = null; } });
      for (let i = 0; i < 60; i++) {
        if (lastError) throw new Error(`Couldn’t start OpenCode (${lastError.message}). Is it installed?`);
        if (proc !== child) throw new Error(`OpenCode stopped while starting. Is port ${port} already in use?`);
        try { await call('/session', { timeout: 2000 }); stopListening = listen(); return; } catch { await sleep(500); }
      }
      throw new Error('OpenCode didn’t start within 30 seconds');
    })();
    ready.catch(() => stop());
    return ready;
  }

  /**
   * Send a prompt. `sessionID` (an OpenCode "ses_…" id) continues that session; without
   * one a new session starts in `directory`. Returns the dotpals session id.
   */
  async function send({ text, sessionID, directory }) {
    await start();
    let sid = sessionID;
    if (!sid) {
      const created = await call('/session', { method: 'POST', body: { title: text.slice(0, 60) }, directory });
      sid = created?.id;
      if (!sid) throw new Error('OpenCode didn’t create a session');
    }
    await call(`/session/${encodeURIComponent(sid)}/prompt_async`, { method: 'POST', body: { parts: [{ type: 'text', text }] }, directory });
    return { session: `opencode:${sid}`, sessionID: sid };
  }

  /** Stop what a session is doing (the Stop button). */
  async function abort({ sessionID, directory }) {
    if (!proc) return false;
    await call(`/session/${encodeURIComponent(sessionID)}/abort`, { method: 'POST', directory });
    return true;
  }

  /** Answer a permission request: 'once', 'always' or 'reject'. */
  async function replyPermission({ id, reply, directory }) {
    if (!proc) throw new Error('OpenCode isn’t running');
    await call(`/permission/${encodeURIComponent(id)}/reply`, { method: 'POST', body: { reply }, directory: folders.get(id) ?? directory });
    folders.delete(id);
  }

  /** Answer a question: `answers` is one array of chosen labels per question; null skips it. */
  async function replyQuestion({ id, answers, directory }) {
    if (!proc) throw new Error('OpenCode isn’t running');
    const dir = folders.get(id) ?? directory;
    if (answers) await call(`/question/${encodeURIComponent(id)}/reply`, { method: 'POST', body: { answers }, directory: dir });
    else await call(`/question/${encodeURIComponent(id)}/reject`, { method: 'POST', directory: dir });
    folders.delete(id);
  }

  process.once('exit', stop);
  return { send, abort, stop, replyPermission, replyQuestion, running: () => !!proc };
}
