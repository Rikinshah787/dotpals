// One-click Laya, for "Double-check unclear test results" → Local (Settings → Set up Laya,
// or `dotpals laya`). dotpals keeps its own copy of Laya (by Convai Innovations,
// Apache-2.0, PyPI `laya`) in <dotpals home>/laya, apart from any other Python you have:
//
//   .venv/          a virtual environment: `python -m venv`, then `pip install "laya[serve]"`
//                   (Laya, PyTorch, transformers, FastAPI, uvicorn)
//   hf/             the model, downloaded by Laya on its first start (HF_HOME points here,
//                   so Remove Laya deletes it too)
//   installed.json  written once the install finished
//   server.log      what the server prints (cut back when it passes 5 MB)
//   server.pid      the running server, so a later bridge can find it or stop it
//
// The server is the package's `laya-serve` console script (laya.serve:main), configured
// only by environment variables. It binds LAYA_HOST, which defaults to 0.0.0.0 (every
// network), so dotpals always sets LAYA_HOST=127.0.0.1, plus LAYA_PORT from the checker's
// address. It loads its checkpoints before it starts listening, so GET /health answers
// only once the model is downloaded and loaded: the first start can take many minutes.
// LAYA_MODELS=english preloads only the English checkpoint (about 850 MB); Laya fetches
// another one itself if a request ever needs it.
//
// Nothing here uses a shell: every command is a program and an array of arguments.
// Everything that touches the system (spawn, fetch, ports, disk space, killing) can be
// swapped out, so the tests run without Python or a network.
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { home as dotpalsHome, LAYA_URL } from './config.js';

/** What pip installs. */
export const PACKAGE = 'laya[serve]';
export const PYTHON_URL = 'https://www.python.org/downloads/';
/** The first start downloads the model; give it this long before giving up. */
export const START_TIMEOUT_MS = 10 * 60_000;
const LOG_MAX = 5 * 1024 * 1024;
const LOG_KEEP = 256 * 1024;
const GB = 1024 ** 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** One line of output, for a progress note: no colour codes, no runs of spaces, 160 characters at most. */
export const trimLine = (s) => String(s ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);

/** "Python 3.12.4" → { major: 3, minor: 12, text: '3.12.4' }, or null. */
export function parsePythonVersion(text) {
  const m = /Python\s+(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text ?? ''));
  return m ? { major: +m[1], minor: +m[2], text: `${m[1]}.${m[2]}${m[3] ? `.${m[3]}` : ''}` } : null;
}
const newEnough = (v) => !!v && (v.major > 3 || (v.major === 3 && v.minor >= 10));

/** The checker's address → the port to run on (http://127.0.0.1:8000 → 8000). */
export function portOf(url) {
  try {
    const u = new URL(url);
    return Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  } catch { return 8000; }
}

/**
 * Run a program (no shell) and collect what it prints. Resolves { code, out } (the last
 * 64 KB of stdout and stderr together); code is null when it couldn't start at all.
 * `onLine` gets each line as it comes (pip's progress uses \r as well as \n).
 */
export function runCommand(spawn, command, args, { env, cwd, onLine, timeoutMs, onChild } = {}) {
  return new Promise((done) => {
    let out = '';
    let partial = '';
    let child;
    try {
      child = spawn(command, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) { return done({ code: null, out: err.message }); }
    onChild?.(child);
    const timer = timeoutMs ? setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs) : null;
    const take = (chunk) => {
      const text = String(chunk);
      out = (out + text).slice(-65536);
      if (!onLine) return;
      const parts = (partial + text).split(/\r\n|\r|\n/);
      partial = parts.pop();
      for (const line of parts) if (line.trim()) onLine(line);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onLine && partial.trim()) onLine(partial);
      done({ code, out });
    };
    child.on('error', (err) => { out += `\n${err.message}`; finish(null); });
    child.on('close', (code) => finish(code));
  });
}

/**
 * Find Python 3.10 or newer: `py -3` (the Windows launcher), then `python3`, then
 * `python`. Resolves { ok: true, command, args, version } or { ok: false, reason }.
 */
export async function findPython({ run, platform = process.platform } = {}) {
  run ??= (command, args, opts) => runCommand(nodeSpawn, command, args, opts);
  const candidates = [...(platform === 'win32' ? [['py', ['-3']]] : []), ['python3', []], ['python', []]];
  let tooOld = null;
  for (const [command, args] of candidates) {
    // Windows' "python" can be a Microsoft Store shortcut that only prints where to get
    // Python: it exits non-zero and has no version, so it's skipped like a missing one.
    const r = await run(command, [...args, '--version'], { timeoutMs: 20_000 });
    if (r.code !== 0) continue;
    const v = parsePythonVersion(r.out);
    if (newEnough(v)) return { ok: true, command, args, version: v.text };
    if (v) tooOld ??= v.text;
  }
  return { ok: false, reason: `Python 3.10 or newer isn’t installed${tooOld ? ` (found Python ${tooOld})` : ''}` };
}

/** Whether nothing is listening on 127.0.0.1:port. */
export function isPortFree(port) {
  return new Promise((ok) => {
    const probe = createServer();
    probe.once('error', () => ok(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => ok(true)));
  });
}

/** Free space on the disk holding `dir` (or its nearest existing parent), in bytes; null if unknown. */
export function diskFree(dir) {
  try {
    let d = dir;
    while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
    const s = statfsSync(d);
    return s.bavail * s.bsize;
  } catch { return null; }
}

/** Stop a process and everything it started (on Windows, the console script starts python.exe). */
export async function killTree(pid, platform = process.platform) {
  if (platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  const signal = (sig) => { try { process.kill(-pid, sig); return true; } catch { try { process.kill(pid, sig); return true; } catch { return false; } } };
  if (!signal('SIGTERM')) return;
  for (let i = 0; i < 30 && processAlive(pid); i++) await sleep(100);
  if (processAlive(pid)) signal('SIGKILL');
}

export function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/** Why `python -m venv` failed, in words. */
function venvReason(out) {
  if (/ensurepip|python3-venv/i.test(out)) return 'Python’s venv module is missing. On Debian or Ubuntu: sudo apt install python3-venv, then try again.';
  return `Couldn’t make a Python environment for Laya: ${trimLine(out.trim().split('\n').pop()) || 'Python failed'}`;
}

/** Why `pip install` failed, in words. */
function pipReason(out, python) {
  if (/No matching distribution found for torch\b/i.test(out)) return `PyTorch isn’t available for Python ${python} yet. Install Python 3.12, then set up Laya again.`;
  if (/No space left on device|\[Errno 28\]|not enough space/i.test(out)) return 'The disk is full. Free a few GB, then set up Laya again.';
  if (/Could not fetch URL|connection|Temporary failure in name resolution|NewConnectionError|ProxyError|SSLError|timed out/i.test(out)) return 'Couldn’t download Laya: check your internet connection, then try again.';
  const last = out.trim().split('\n').reverse().find((l) => /error/i.test(l)) ?? out.trim().split('\n').pop();
  return `Installing Laya failed: ${trimLine(last) || 'pip failed'}`;
}

/** Why the server stopped while starting, from the end of its log. */
function startReason(tail, port) {
  if (/address already in use|error while attempting to bind|Errno 98|Errno 10048|WinError 10013/i.test(tail)) return `Something else is using port ${port}. Change the address under “Advanced”, or stop the other program.`;
  if (/No space left on device|\[Errno 28\]/i.test(tail)) return 'The disk is full, so Laya couldn’t download its model. Free a few GB and start it again.';
  if (/ConnectionError|MaxRetryError|NameResolution|LocalEntryNotFoundError|offline/i.test(tail)) return 'Laya couldn’t download its model: check your internet connection, then start it again.';
  if (/MemoryError|out of memory/i.test(tail)) return 'Laya ran out of memory while loading its model (it needs about 2 GB free).';
  return null;
}

/**
 * The Laya manager, for the bridge and the CLI:
 *   status()             { installed, running, phase, message, line, error, port, log }
 *                        phase: 'idle' | 'python' | 'venv' | 'install' | 'starting' | 'ready' | 'error'
 *   setup({ onProgress }) install if needed, then start; resolves with the final status
 *   start(), stop(), uninstall()
 *   subscribe(fn)        fn(status) on every change; returns an unsubscribe function
 * Only one setup or start runs at a time: asking again returns the one in progress.
 */
export function createLaya({
  dir = () => join(dotpalsHome(), 'laya'),
  getUrl = () => LAYA_URL,
  spawn = nodeSpawn,
  fetch = globalThis.fetch,
  platform = process.platform,
  portFree = isPortFree,
  freeBytes = diskFree,
  kill = (pid) => killTree(pid, platform),
  alive = processAlive,
  pollMs = 1000,
  startTimeoutMs = START_TIMEOUT_MS,
  hookExit = true,
  env: baseEnv = process.env,
} = {}) {
  const listeners = new Set();
  let state = { phase: 'idle', message: '', line: '', error: null };
  let task = null;      // the setup or start in progress
  let busy = null;      // python or pip, while it runs (so Remove can stop it)
  let server = null;    // { child, pid, port } the server this manager started, or adopted from server.pid
  let running = false;
  let gen = 0;          // bumped by stop(): a start that's waiting gives up
  let cancelled = false;

  const paths = () => {
    const root = dir();
    const venv = join(root, '.venv');
    const bin = platform === 'win32' ? join(venv, 'Scripts') : join(venv, 'bin');
    const exe = platform === 'win32' ? '.exe' : '';
    return {
      root, venv, python: join(bin, `python${exe}`), server: join(bin, `laya-serve${exe}`),
      hf: join(root, 'hf'), log: join(root, 'server.log'), pid: join(root, 'server.pid'), marker: join(root, 'installed.json'),
    };
  };
  const installed = () => { const p = paths(); return existsSync(p.marker) && existsSync(p.server); };
  const port = () => portOf(getUrl() || LAYA_URL);
  const idleMessage = () => (installed() ? 'Laya is installed, but not running' : 'Laya isn’t set up');

  function status() {
    return { installed: installed(), running, phase: state.phase, message: state.message || idleMessage(), line: state.line, error: state.error, port: port(), log: paths().log };
  }
  let sent = '';
  function set(patch) {
    state = { ...state, ...patch };
    const s = status();
    const text = JSON.stringify(s);
    if (text === sent) return;
    sent = text;
    for (const fn of listeners) { try { fn(s); } catch {} }
  }
  const fail = (error, message) => { running = false; set({ phase: 'error', error, message, line: '' }); return status(); };
  const run = (command, args, opts = {}) => runCommand(spawn, command, args, { ...opts, onChild: (c) => { busy = c; } }).finally(() => { busy = null; });

  /** What the server runs with: none of your own LAYA_* settings (no other host, no key), only ours. */
  function serverEnv(p, at) {
    const env = { ...baseEnv };
    for (const key of Object.keys(env)) if (/^(LAYA_|HF_HOME$|HF_HUB_OFFLINE$)/i.test(key)) delete env[key];
    return {
      ...env,
      LAYA_HOST: '127.0.0.1', // never every network (Laya's own default is 0.0.0.0)
      LAYA_PORT: String(at),
      LAYA_MODELS: 'english',
      HF_HOME: p.hf,
      HF_HUB_DISABLE_TELEMETRY: '1',
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
    };
  }

  async function healthy(at) {
    try {
      const res = await fetch(`http://127.0.0.1:${at}/health`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return false;
      return (await res.json().catch(() => null))?.status === 'ok';
    } catch { return false; }
  }

  /** The last line of the server's log (what it's doing while it starts). */
  function logTail(bytes = 4096) {
    try {
      const { log } = paths();
      const size = statSync(log).size;
      const fd = openSync(log, 'r');
      try {
        const buf = Buffer.alloc(Math.min(bytes, size));
        readSync(fd, buf, 0, buf.length, size - buf.length);
        return buf.toString('utf8');
      } finally { closeSync(fd); }
    } catch { return ''; }
  }
  const lastLine = (text = logTail()) => trimLine(text.split(/\r\n|\r|\n/).filter((l) => l.trim()).pop());

  /** Keep the log small: past 5 MB, keep only its last 256 KB. */
  function trimLog(log) {
    try {
      if (statSync(log).size <= LOG_MAX) return;
      const keep = logTail(LOG_KEEP);
      writeFileSync(log, keep.slice(keep.indexOf('\n') + 1));
    } catch {}
  }

  const readPid = () => { try { return Number(readFileSync(paths().pid, 'utf8').trim()) || null; } catch { return null; } };
  const forgetPid = () => { try { rmSync(paths().pid, { force: true }); } catch {} };

  // When dotpals quits without stopping Laya first (the desktop app closing, Ctrl+C on
  // the bridge), stop it on the way out, so it doesn't keep running in the background.
  const onExit = () => {
    if (!server?.child) return;
    if (platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else { try { process.kill(-server.pid, 'SIGTERM'); } catch {} }
  };
  const onSignal = (sig) => process.exit(sig === 'SIGINT' ? 130 : 143);
  let hooked = false;
  function hook(on) {
    if (!hookExit || hooked === on) return;
    hooked = on;
    if (on) {
      process.on('exit', onExit);
      // Only when nothing else handles these, so Node's usual "stop" still happens, with 'exit'.
      for (const sig of ['SIGINT', 'SIGTERM']) if (!process.listenerCount(sig)) process.once(sig, onSignal);
    } else {
      process.off('exit', onExit);
      for (const sig of ['SIGINT', 'SIGTERM']) process.off(sig, onSignal);
    }
  }

  function ready(message = 'Laya is running on this computer') {
    running = true;
    set({ phase: 'ready', message, line: '', error: null });
    return status();
  }

  /** Start the installed server and wait for /health. */
  async function launch() {
    const p = paths();
    const at = port();
    if (running && server && server.port === at) return status();
    if (server && server.port !== at) await stopServer(); // the address changed: move it
    const mine = ++gen;
    set({ phase: 'starting', message: 'Starting Laya…', line: '', error: null });

    // Still running from an earlier bridge (one that quit before it could stop it)?
    const old = readPid();
    if (old && alive(old) && await healthy(at)) {
      server = { pid: old, port: at, child: null };
      return ready();
    }
    forgetPid();
    // Something already answers there: someone's own Laya. Use it, but don't own it.
    if (await healthy(at)) return ready(`Laya is already running on port ${at} (not started by dotpals)`);
    if (!(await portFree(at))) return fail('port', `Something else is using port ${at}. Change the address under “Advanced”, or stop the other program.`);

    const firstTime = !existsSync(join(p.hf, 'hub'));
    set({ message: firstTime ? 'Starting Laya. The first time, it downloads its model (about 850 MB), which can take several minutes…' : 'Starting Laya (loading its model)…' });
    mkdirSync(p.root, { recursive: true });
    trimLog(p.log);
    let child;
    let exited = null;
    const fd = openSync(p.log, 'a');
    try {
      writeFileSync(fd, `\n--- dotpals started laya-serve on 127.0.0.1:${at}, ${new Date().toISOString()} ---\n`);
      // detached: no console window on Windows, and its own process group elsewhere (stopped as one).
      child = spawn(p.server, [], { cwd: p.root, env: serverEnv(p, at), stdio: ['ignore', fd, fd], windowsHide: true, detached: true });
    } catch (err) {
      return fail('start', `Couldn’t start Laya: ${trimLine(err.message)}`);
    } finally { closeSync(fd); }
    server = { child, pid: child.pid, port: at };
    child.unref?.();
    child.on('error', (err) => { exited = { error: err }; });
    child.on('exit', (code) => {
      exited ??= { code };
      if (server?.child !== child) return;
      server = null;
      forgetPid();
      hook(false);
      if (running) { running = false; set({ phase: 'error', error: 'exited', message: `Laya stopped by itself${lastLine() ? `: ${lastLine()}` : ''}`, line: '' }); }
    });
    if (child.pid) writeFileSync(p.pid, String(child.pid));
    hook(true);

    const deadline = Date.now() + startTimeoutMs;
    for (;;) {
      if (mine !== gen || cancelled) return status();
      if (exited) {
        if (server?.child === child) { server = null; forgetPid(); hook(false); }
        const tail = logTail(16384);
        return fail('start', exited.error ? `Couldn’t start Laya: ${trimLine(exited.error.message)}` : startReason(tail, at) ?? `Laya stopped while starting${lastLine(tail) ? `: ${lastLine(tail)}` : ''}. Its log: ${p.log}`);
      }
      if (await healthy(at)) return mine === gen ? ready() : status();
      if (Date.now() > deadline) {
        await stopServer();
        return fail('timeout', `Laya didn’t start within ${Math.round(startTimeoutMs / 60_000)} minutes. Its log: ${p.log}`);
      }
      set({ line: lastLine() });
      await sleep(pollMs);
    }
  }

  /** Install (when needed), then start. */
  async function install() {
    const p = paths();
    if (!installed()) {
      set({ phase: 'python', message: 'Looking for Python 3.10 or newer…', line: '', error: null });
      const py = await findPython({ run, platform });
      if (cancelled) return status();
      if (!py.ok) return fail('no-python', `${py.reason}. Install Python 3.10 or newer, then set up Laya again.`);
      const free = freeBytes(p.root);
      const need = (platform === 'linux' ? 10 : 5) * GB; // Linux's PyTorch brings its GPU libraries
      if (free != null && free < need) return fail('disk', `Not enough disk space: Laya needs about ${need / GB} GB free, and there’s ${(free / GB).toFixed(1)} GB.`);

      set({ phase: 'venv', message: `Making a private Python environment for Laya (Python ${py.version})…`, line: '' });
      rmSync(p.venv, { recursive: true, force: true }); // a half-made one from an earlier try
      mkdirSync(p.root, { recursive: true });
      const venv = await run(py.command, [...py.args, '-m', 'venv', p.venv], { cwd: p.root });
      if (cancelled) return status();
      if (venv.code !== 0 || !existsSync(p.python)) return fail('venv', venvReason(venv.out));

      set({ phase: 'install', message: 'Updating pip…', line: '' });
      const pipEnv = { ...baseEnv, PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONIOENCODING: 'utf-8' };
      await run(p.python, ['-m', 'pip', 'install', '--upgrade', '--quiet', 'pip'], { env: pipEnv, cwd: p.root }); // an old pip still works
      if (cancelled) return status();
      // pip 24.1+ can print its download progress as plain lines ("Progress 1048576 of 124000000").
      const pipVersion = /pip (\d+)\.(\d+)/.exec((await run(p.python, ['-m', 'pip', '--version'], { env: pipEnv })).out);
      const raw = pipVersion && (+pipVersion[1] > 24 || (+pipVersion[1] === 24 && +pipVersion[2] >= 1));
      set({ message: 'Installing Laya and PyTorch (a few GB, so this takes a while)…' });
      let downloading = '';
      let shown = -1;
      const onLine = (line) => {
        const progress = /^Progress (\d+) of (\d+)/.exec(line.trim());
        if (progress) {
          const pct = +progress[2] ? Math.floor((100 * +progress[1]) / +progress[2]) : -1;
          if (pct >= 0 && pct !== shown) { shown = pct; set({ line: trimLine(`${downloading} · ${pct}%`) }); }
          return;
        }
        if (/^\s*Downloading\s/.test(line)) { downloading = trimLine(line); shown = -1; }
        set({ line: trimLine(line) });
      };
      const pip = await run(p.python, ['-m', 'pip', 'install', '--progress-bar', raw ? 'raw' : 'off', PACKAGE], { env: pipEnv, cwd: p.root, onLine });
      if (cancelled) return status();
      if (pip.code !== 0 || !existsSync(p.server)) return fail('install', pipReason(pip.out, py.version));
      const version = (await run(p.python, ['-c', 'import importlib.metadata as m; print(m.version("laya"))'], { env: pipEnv })).out.trim();
      writeFileSync(p.marker, `${JSON.stringify({ laya: /^[\w.+-]{1,40}$/.test(version) ? version : null, python: py.version, at: new Date().toISOString() }, null, 2)}\n`);
      set({ line: version ? `Installed Laya ${version}` : '' });
    }
    return launch();
  }

  function once(fn, onProgress) {
    const off = onProgress ? subscribe(onProgress) : null;
    if (!task) {
      cancelled = false;
      task = fn().catch((err) => fail('internal', `Something went wrong: ${trimLine(err?.message)}`)).finally(() => { task = null; });
    }
    return task.finally(() => off?.());
  }

  /** Stop the server this manager started (or adopted). Someone else's Laya is left alone. */
  async function stopServer() {
    gen++;
    const s = server;
    server = null;
    running = false;
    hook(false);
    if (s?.pid) {
      const gone = s.child && s.child.exitCode == null && s.child.signalCode == null ? new Promise((r) => s.child.once('exit', r)) : null;
      await kill(s.pid);
      if (gone) await Promise.race([gone, new Promise((r) => setTimeout(r, 5000).unref?.())]);
    }
    forgetPid();
  }

  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  async function stop() {
    // Started earlier and left running (server.pid)? Only a pid whose port answers as Laya,
    // so a stale file can never stop some other program that got the same pid.
    if (!server) { const old = readPid(); if (old && alive(old) && await healthy(port())) server = { pid: old, port: port(), child: null }; }
    await stopServer();
    set({ phase: 'idle', message: '', line: '', error: null });
    return status();
  }

  async function uninstall() {
    cancelled = true;
    if (busy?.pid) await kill(busy.pid);
    await stop();
    await task?.catch(() => {});
    await rm(paths().root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    cancelled = false;
    set({ phase: 'idle', message: '', line: '', error: null });
    return status();
  }

  return {
    status,
    subscribe,
    paths,
    installed,
    /** Whether this manager runs (or adopted) the server, up or starting. */
    owned: () => !!server,
    setup: ({ onProgress } = {}) => once(install, onProgress),
    start: ({ onProgress } = {}) => (installed() ? once(launch, onProgress) : Promise.resolve(fail('not-installed', 'Laya isn’t set up yet: click Set up Laya'))),
    stop,
    uninstall,
  };
}
