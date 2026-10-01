import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createLaya, findPython, PACKAGE, parsePythonVersion, portOf } from '../bridge/laya.js';

// No Python, no pip, no network: every program and request below is a fake.
const root = mkdtempSync(join(tmpdir(), 'dotpals-laya-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const GB = 1024 ** 3;
const touch = (file) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, ''); };

/** A child process that prints `out` and exits with `code` (or stays up when code is undefined). */
function fakeChild(pid) {
  const child = new EventEmitter();
  Object.assign(child, { pid, exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter(), unref() {} });
  child.finish = (code, out = '') => setImmediate(() => {
    if (out) child.stdout.emit('data', Buffer.from(out));
    child.exitCode = code;
    child.emit('exit', code);
    child.emit('close', code);
  });
  child.kill = () => { child.signalCode = 'SIGTERM'; child.finish(null); };
  return child;
}

/**
 * A pretend computer. `pythons` maps a command to what `--version` prints (missing: not
 * installed). `pip` and `server` decide how pip and laya-serve behave. Records every call.
 */
function fakeSystem({
  pythons = { py: 'Python 3.12.4' },
  platform = 'win32',
  venv = () => ({ code: 0 }),
  pip = () => ({ code: 0, out: 'Collecting laya[serve]\nDownloading torch-2.14.1-cp312-cp312-win_amd64.whl (124.0 MB)\nProgress 0 of 1000\nProgress 500 of 1000\nProgress 1000 of 1000\nSuccessfully installed laya-0.3.22 torch-2.14.1\n' }),
  server = () => ({}),              // { dies: 'log text' } to exit while starting
  healthyAfter = 2,                 // health checks before it answers
  url = 'http://127.0.0.1:8000',
  portFree = true,
  free = 100 * GB,
  env = { PATH: '/usr/bin', LAYA_HOST: '0.0.0.0', LAYA_API_KEY: 'k', LAYA_PORT: '1' },
  startTimeoutMs = 3000,
} = {}) {
  const dir = join(root, `home${n++}`, 'laya');
  const calls = [];
  const killed = [];
  const children = new Map();
  let up = null; // port the fake server answers on
  let serverChild = null;
  let checks = 0;
  const health = [];
  let laya;

  const spawn = (cmd, args, opts) => {
    const child = fakeChild(9000 + calls.length);
    calls.push({ cmd, args, opts });
    children.set(child.pid, child);
    const p = laya.paths();
    const base = cmd.split(/[\\/]/).pop();
    if (args.at(-1) === '--version' && args.length <= 2 && !cmd.includes('.venv')) {
      if (!(base in pythons)) { setImmediate(() => { const err = Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }); child.emit('error', err); }); return child; }
      const v = pythons[base];
      child.finish(v.code ?? 0, v.out ?? v);
    } else if (args.includes('venv')) {
      const r = venv();
      if (r.code === 0) touch(p.python);
      child.finish(r.code, r.out);
    } else if (args.join(' ') === '-m pip --version') {
      child.finish(0, 'pip 25.2 from x (python 3.12)\n');
    } else if (args.includes(PACKAGE)) {
      const r = pip();
      if (r.code === 0) touch(p.server);
      child.finish(r.code, r.out);
    } else if (args[0] === '-c') {
      child.finish(0, '0.3.22\n');
    } else if (args.includes('pip')) {
      child.finish(0);
    } else if (cmd === p.server) {
      const r = server();
      writeSync(opts.stdio[1], r.dies ?? 'INFO: loading checkpoints\nmodel.safetensors:  40%|####      | 340M/843M\r');
      if (r.dies) child.finish(1);
      else { up = Number(opts.env.LAYA_PORT); checks = 0; serverChild = child; }
      child.on('exit', () => { up = null; });
    }
    return child;
  };
  const fetch = async (href) => {
    const u = new URL(href);
    health.push(href);
    if (u.pathname !== '/health' || Number(u.port) !== up || ++checks < healthyAfter) throw new TypeError('fetch failed');
    return { ok: true, json: async () => ({ status: 'ok', loaded: ['english'] }) };
  };
  const kill = async (pid) => { killed.push(pid); children.get(pid)?.kill(); };
  const alive = (pid) => children.get(pid)?.exitCode === null;
  laya = createLaya({
    dir: () => dir, getUrl: () => url, spawn, fetch, platform, kill, alive,
    portFree: async () => portFree, freeBytes: () => free,
    pollMs: 5, startTimeoutMs, hookExit: false, env,
  });
  const phases = [];
  laya.subscribe((s) => { if (phases.at(-1) !== s.phase) phases.push(s.phase); });
  return { laya, calls, killed, health, phases, dir, isUp: () => up, crash: () => serverChild.finish(1), children };
}

test('findPython: reads the version, needs 3.10 or newer, and tries py -3, python3, python in turn', async () => {
  assert.deepEqual(parsePythonVersion('Python 3.12.4\n'), { major: 3, minor: 12, text: '3.12.4' });
  assert.deepEqual(parsePythonVersion('Python 3.10'), { major: 3, minor: 10, text: '3.10' });
  assert.equal(parsePythonVersion('Python was not found; run without arguments to install from the Microsoft Store'), null);

  const asked = [];
  const run = (answers) => async (cmd, args) => { asked.push([cmd, ...args].join(' ')); return answers[cmd] ?? { code: null, out: 'ENOENT' }; };
  assert.deepEqual(await findPython({ platform: 'win32', run: run({ py: { code: 0, out: 'Python 3.13.1' } }) }), { ok: true, command: 'py', args: ['-3'], version: '3.13.1' });
  assert.deepEqual(asked, ['py -3 --version']);

  // No launcher, python3 too old, python new enough.
  const r = await findPython({ platform: 'win32', run: run({ python3: { code: 0, out: 'Python 3.8.10' }, python: { code: 0, out: 'Python 3.11.2' } }) });
  assert.deepEqual([r.ok, r.command, r.args, r.version], [true, 'python', [], '3.11.2']);

  // Windows' Store shortcut: exits 9009 and prints no version.
  const none = await findPython({ platform: 'win32', run: run({ python: { code: 9009, out: 'Python was not found; run without arguments to install from the Microsoft Store' } }) });
  assert.deepEqual(none, { ok: false, reason: 'Python 3.10 or newer isn’t installed' });
  const old = await findPython({ platform: 'linux', run: run({ python3: { code: 0, out: 'Python 3.9.18' } }) });
  assert.deepEqual(old, { ok: false, reason: 'Python 3.10 or newer isn’t installed (found Python 3.9.18)' });

  // Not on Windows: no `py`.
  asked.length = 0;
  await findPython({ platform: 'darwin', run: run({}) });
  assert.deepEqual(asked, ['python3 --version', 'python --version']);
});

test('portOf: the port in the checker’s address', () => {
  assert.equal(portOf('http://127.0.0.1:8000'), 8000);
  assert.equal(portOf('http://localhost:9123'), 9123);
  assert.equal(portOf('http://127.0.0.1'), 80);
  assert.equal(portOf('not a url'), 8000);
});

test('setup: venv → pip → start → /health, with progress, and no shell anywhere', async () => {
  const sys = fakeSystem();
  const seen = [];
  const s = await sys.laya.setup({ onProgress: (x) => seen.push(x) });
  assert.deepEqual([s.phase, s.installed, s.running, s.error], ['ready', true, true, null]);
  assert.equal(s.message, 'Laya is running on this computer');
  assert.deepEqual(sys.phases, ['python', 'venv', 'install', 'starting', 'ready']);

  const p = sys.laya.paths();
  const steps = sys.calls.map((c) => [c.cmd, ...c.args].join(' '));
  assert.deepEqual(steps, [
    'py -3 --version',
    `py -3 -m venv ${p.venv}`,
    `${p.python} -m pip install --upgrade --quiet pip`,
    `${p.python} -m pip --version`,
    `${p.python} -m pip install --progress-bar raw laya[serve]`,
    `${p.python} -c import importlib.metadata as m; print(m.version("laya"))`,
    p.server,
  ]);
  for (const c of sys.calls) {
    assert.ok(!c.opts?.shell, `${c.cmd} without a shell`);
    assert.equal(c.opts?.windowsHide, true);
  }
  // pip's latest line, and its download progress as a percentage.
  assert.ok(seen.some((x) => x.phase === 'install' && /Downloading torch-2\.14\.1.*· 50%/.test(x.line)), 'download progress');
  assert.ok(seen.some((x) => x.phase === 'install' && /^Successfully installed laya-0\.3\.22/.test(x.line)));
  // While it starts: the latest line of its log (the model download).
  assert.ok(seen.some((x) => x.phase === 'starting' && /model\.safetensors: 40%/.test(x.line)));
  assert.ok(seen.some((x) => x.phase === 'starting' && /first time, it downloads its model/.test(x.message)));
  assert.ok(existsSync(p.marker) && existsSync(p.pid));
  await sys.laya.stop();
});

test('the server only ever listens on 127.0.0.1, on the port from the checker’s address', async () => {
  const sys = fakeSystem({ url: 'http://localhost:9123' });
  await sys.laya.setup();
  const server = sys.calls.at(-1);
  const p = sys.laya.paths();
  assert.equal(server.cmd, p.server);
  assert.deepEqual(server.args, []);
  assert.equal(server.opts.env.LAYA_HOST, '127.0.0.1'); // even though the environment said 0.0.0.0
  assert.equal(server.opts.env.LAYA_PORT, '9123');
  assert.equal(server.opts.env.LAYA_API_KEY, undefined); // your own Laya settings don't leak in
  assert.equal(server.opts.env.HF_HOME, p.hf);            // the model lives in dotpals' folder
  assert.equal(server.opts.env.LAYA_MODELS, 'english');
  assert.equal(server.opts.env.PATH, '/usr/bin');
  assert.equal(server.opts.detached, true);
  assert.equal(server.opts.windowsHide, true);
  assert.ok(sys.health.length && sys.health.every((h) => h === 'http://127.0.0.1:9123/health'));
  assert.equal(sys.laya.status().port, 9123);
  await sys.laya.stop();
});

test('setup is idempotent: installed means start only; running means nothing to do; one at a time', async () => {
  const sys = fakeSystem();
  const [a, b] = await Promise.all([sys.laya.setup(), sys.laya.setup()]);
  assert.equal(a, b);
  assert.equal(sys.calls.filter((c) => c.args.includes('--version') && c.cmd === 'py').length, 1);
  const count = sys.calls.length;
  assert.equal((await sys.laya.setup()).phase, 'ready');
  assert.equal(sys.calls.length, count, 'already running: nothing spawned');

  await sys.laya.stop();
  assert.deepEqual([sys.laya.status().running, sys.laya.status().installed], [false, true]);
  assert.equal(sys.killed.length, 1);
  assert.ok(!existsSync(sys.laya.paths().pid));
  const again = await sys.laya.setup();
  assert.equal(again.phase, 'ready');
  assert.deepEqual(sys.calls.slice(count).map((c) => c.cmd), [sys.laya.paths().server], 'no python or pip the second time');
  await sys.laya.stop();
});

test('failures say what to do: no Python, no venv module, pip errors, not enough disk', async () => {
  const none = fakeSystem({ pythons: {} });
  const s = await none.laya.setup();
  assert.deepEqual([s.phase, s.error, s.installed, s.running], ['error', 'no-python', false, false]);
  assert.match(s.message, /^Python 3\.10 or newer isn’t installed\. Install Python 3\.10 or newer, then set up Laya again\.$/);
  assert.ok(none.calls.every((c) => c.args.at(-1) === '--version'), 'nothing else ran');

  const venv = await fakeSystem({ venv: () => ({ code: 1, out: 'The virtual environment was not created successfully because ensurepip is not available.' }) }).laya.setup();
  assert.deepEqual([venv.error, /apt install python3-venv/.test(venv.message)], ['venv', true]);

  const torch = await fakeSystem({ pip: () => ({ code: 1, out: 'ERROR: Could not find a version that satisfies the requirement torch>=2.0.0 (from versions: none)\nERROR: No matching distribution found for torch>=2.0.0\n' }) }).laya.setup();
  assert.deepEqual([torch.error, torch.installed], ['install', false]);
  assert.match(torch.message, /PyTorch isn’t available for Python 3\.12\.4/);

  const offline = await fakeSystem({ pip: () => ({ code: 1, out: "WARNING: Retrying (Retry(total=4)) after connection broken by 'NewConnectionError'\nERROR: Could not find a version that satisfies the requirement laya\n" }) }).laya.setup();
  assert.match(offline.message, /check your internet connection/);

  const disk = fakeSystem({ free: 2 * GB });
  const d = await disk.laya.setup();
  assert.equal(d.error, 'disk');
  assert.match(d.message, /needs about 5 GB free, and there’s 2\.0 GB/);
  assert.ok(!disk.calls.some((c) => c.args.includes('venv')));

  // A failed install is tried again from the start next time.
  let fail = true;
  const retry = fakeSystem({ pip: () => (fail ? { code: 1, out: 'ERROR: boom' } : { code: 0 }) });
  assert.equal((await retry.laya.setup()).error, 'install');
  fail = false;
  const ok = await retry.laya.setup();
  assert.equal(ok.phase, 'ready');
  await retry.laya.stop();
});

test('starting: a busy port, a server that dies, and one that never answers', async () => {
  const busy = fakeSystem({ portFree: false });
  const b = await busy.laya.setup();
  assert.deepEqual([b.error, b.installed], ['port', true]);
  assert.match(b.message, /Something else is using port 8000/);
  assert.ok(!busy.calls.some((c) => c.cmd === busy.laya.paths().server), 'not started');

  const dies = fakeSystem({ server: () => ({ dies: 'INFO: loading\nERROR: [Errno 10048] error while attempting to bind on address (\'127.0.0.1\', 8000)\n' }) });
  const d = await dies.laya.setup();
  assert.deepEqual([d.error, d.running], ['start', false]);
  assert.match(d.message, /Something else is using port 8000/);

  const crash = await fakeSystem({ server: () => ({ dies: 'Traceback (most recent call last):\nRuntimeError: weird\n' }) }).laya.setup();
  assert.match(crash.message, /^Laya stopped while starting: RuntimeError: weird\. Its log: /);

  const slow = fakeSystem({ healthyAfter: Infinity, startTimeoutMs: 60 });
  const t = await slow.laya.setup();
  assert.deepEqual([t.error, t.running], ['timeout', false]);
  assert.equal(slow.killed.length, 1, 'the slow server is stopped');

  // Not set up yet: start says so.
  const fresh = fakeSystem();
  assert.equal((await fresh.laya.start()).error, 'not-installed');
});

test('stop, uninstall, a server that stops by itself, and an old pid file that isn’t Laya', async () => {
  const sys = fakeSystem();
  await sys.laya.setup();
  assert.equal(sys.laya.owned(), true);
  assert.equal(sys.isUp(), 8000);

  // It stops by itself: the status says so.
  const stopped = new Promise((r) => sys.laya.subscribe((s) => s.phase === 'error' && r(s)));
  sys.crash();
  const s = await stopped;
  assert.deepEqual([s.error, s.running, s.installed], ['exited', false, true]);
  assert.match(s.message, /^Laya stopped by itself/);
  assert.equal(sys.laya.owned(), false);

  // A server.pid left behind whose process is alive but isn't Laya: never killed.
  const p = sys.laya.paths();
  writeFileSync(p.pid, '9000'); // pid of the `py --version` fake, long gone
  sys.children.get(9000).exitCode = null; // pretend some other program has that pid now
  await sys.laya.stop();
  assert.deepEqual(sys.killed, []);
  assert.ok(!existsSync(p.pid));

  // Remove: stops it and deletes the whole folder.
  await sys.laya.start();
  assert.equal(sys.laya.status().running, true);
  const gone = await sys.laya.uninstall();
  assert.deepEqual([gone.installed, gone.running, gone.phase], [false, false, 'idle']);
  assert.equal(sys.killed.length, 1);
  assert.ok(!existsSync(sys.dir));
});

test('a server left running by an earlier bridge is found again (and can be stopped)', async () => {
  const sys = fakeSystem();
  await sys.laya.setup();
  // A new manager, same folder, same fake computer: as if the bridge restarted.
  const again = createLaya({
    dir: () => sys.dir, getUrl: () => 'http://127.0.0.1:8000', spawn: () => assert.fail('nothing to spawn'),
    fetch: async () => ({ ok: true, json: async () => ({ status: 'ok' }) }),
    alive: () => true, kill: async (x) => sys.killed.push(x), portFree: async () => false, hookExit: false, pollMs: 5,
  });
  const s = await again.start();
  assert.deepEqual([s.phase, s.running, again.owned()], ['ready', true, true]);
  await again.stop();
  assert.equal(sys.killed.length, 1);
  assert.equal(typeof sys.killed[0], 'number');
});
