#!/usr/bin/env node
// dotpals command line.
//
//   npx dotpals setup                         one command: install, connect your agents, start
//   dotpals start                             open the floating pal
//   dotpals dashboard                         open the dashboard
//   dotpals status                            what's running and connected
//   dotpals notch [--off]                     the island at the top of the screen
//   dotpals statusline [--off]                share Claude Code's usage limits (for the notch)
//   dotpals bridge                            run only the bridge (no window)
//   dotpals laya [--remove]                   set up Laya, the free local test checker (or delete it)
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, findElectron, installElectron } from '../desktop/launch.js';
import { home, loadConfig, saveConfig, validKey } from '../bridge/config.js';

const here = fileURLToPath(new URL('..', import.meta.url));
const appDir = join(home(), 'app');
const port = Number(process.env.DOTPALS_PORT || process.env.PORT) || 5175;
const bridge = `http://127.0.0.1:${port}`;
const version = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version;

const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[22m` : s);
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[22m` : s);
const ok = (s) => console.log(`  ${process.stdout.isTTY ? '\x1b[32m✓\x1b[39m' : '✓'} ${s}`);
const skip = (s) => console.log(`  ${dim('–')} ${dim(s)}`);
const warn = (s) => console.log(`  ${process.stdout.isTTY ? '\x1b[33m!\x1b[39m' : '!'} ${s}`);
const has = (cmd) => spawnSync(platform() === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;
// On Windows, npm and claude are .cmd files, which need a shell: pass one quoted
// command line (Node warns about separate args with a shell).
const quote = (a) => (/^[\w@./:=\\-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '\\"')}"`);
const run = (cmd, args) => (platform() === 'win32'
  ? spawnSync([cmd, ...args].map(quote).join(' '), { encoding: 'utf8', shell: true })
  : spawnSync(cmd, args, { encoding: 'utf8' }));

/** The running bridge's version, or null. */
async function runningVersion() {
  try { return (await (await fetch(`${bridge}/api/status`, { signal: AbortSignal.timeout(1500) })).json()).version ?? null; } catch { return null; }
}
/** Ask the running desktop app to quit, and wait (up to 8 s) for its bridge to go. */
async function quitRunningApp() {
  try {
    const r = await fetch(`${bridge}/api/app/quit`, { method: 'POST', headers: { 'x-dotpals': '1' }, signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
  } catch { return false; }
  for (let i = 0; i < 32; i++) { await new Promise((r) => setTimeout(r, 250)); if (!(await bridgeUp())) return true; }
  return false;
}
async function bridgeUp() {
  try { return (await fetch(`${bridge}/api/status`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

function openUrl(url) {
  const [cmd, args] = platform() === 'win32' ? ['cmd', ['/c', 'start', '', url]] : platform() === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

/** Start the desktop pal from the installed copy (or this one). */
function startApp(extra = []) {
  const electron = findElectron();
  if (!electron) return false;
  const main = existsSync(join(appDir, 'desktop', 'main.js')) ? join(appDir, 'desktop', 'main.js') : join(here, 'desktop', 'main.js');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(electron, [main, ...extra], { detached: true, stdio: 'ignore', env }).unref();
  return true;
}

async function setup(flags) {
  console.log(`\n${bold('dotpals')} ${dim(`v${version}`)}: see what your coding agent actually did\n`);

  // 1. Node
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) { warn(`Node ${process.versions.node} is too old. dotpals needs Node 20 or newer.`); process.exit(1); }
  ok(`Node ${process.versions.node}`);

  // 2. The app, copied somewhere permanent (npx runs from a temporary folder).
  if (here.replace(/[\\/]+$/, '') !== appDir) {
    mkdirSync(home(), { recursive: true });
    rmSync(appDir, { recursive: true, force: true });
    for (const part of ['package.json', 'LICENSE', 'THIRD_PARTY_NOTICES', 'src', 'bridge', 'desktop', 'bin', 'hooks', 'commands', '.claude-plugin']) {
      if (existsSync(join(here, part))) cpSync(join(here, part), join(appDir, part), { recursive: true });
    }
  }
  ok(`Installed to ${appDir}`);

  // The one optional dependency: TypeSafe's SDK, used only to double-check unclear test
  // results in the cloud (Settings). Offline or failing, setup carries on without it.
  const args = ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'];
  const deps = platform() === 'win32'
    ? spawnSync(['npm', ...args].join(' '), { cwd: appDir, encoding: 'utf8', shell: true, timeout: 90_000 })
    : spawnSync('npm', args, { cwd: appDir, encoding: 'utf8', timeout: 90_000 });
  if (deps.status === 0 && existsSync(join(appDir, 'node_modules', '@typesafe-ai', 'sdk'))) ok('Optional TypeSafe SDK installed (for cloud test checks)');
  else skip('Optional TypeSafe SDK not installed (offline?). Only cloud test checks need it.');

  // The `dotpals` command, in any terminal: link the installed copy as a global npm package.
  if (flags.has('--no-path')) skip('Not adding the dotpals command (--no-path)');
  else if (has('dotpals')) ok('The `dotpals` command works in any terminal');
  else {
    const linked = run('npm', ['install', '--global', '--no-audit', '--no-fund', appDir]);
    if (linked.status === 0) ok('The `dotpals` command works in any terminal');
    else warn(`Couldn’t add the \`dotpals\` command (${`${linked.stderr}`.trim().split('\n').pop() || 'npm failed'}). Use: node "${join(appDir, 'bin', 'dotpals.js')}" <command>`);
  }

  // 3. The desktop window's runtime (Electron), once.
  if (findElectron()) ok('Desktop runtime already installed');
  else {
    console.log(`  ${dim('…')} Downloading the desktop runtime (Electron, about 100 MB, one time)`);
    if (installElectron()) ok('Desktop runtime installed');
    else { warn('Couldn’t install Electron. You can still use the dashboard in a browser: dotpals bridge'); }
  }

  // 4. Settings file with defaults, then your preferences (asked in a terminal; --yes or no
  // terminal keeps the defaults, which you can change any time on the dashboard).
  saveConfig({});
  ok(`Settings in ${join(home(), 'config.json')}`);
  const prefs = await preferences(flags);

  // 5. Claude Code: add the plugin (hooks + /dotpals:pals).
  if (flags.has('--no-claude')) skip('Claude Code: skipped');
  else if (!has('claude')) skip('Claude Code: not found. Later, in Claude Code run: /plugin marketplace add rikinshah787/dotpals, then /plugin install dotpals@dotpals');
  else {
    const added = run('claude', ['plugin', 'marketplace', 'add', 'rikinshah787/dotpals']);
    const out = `${added.stdout}${added.stderr}`;
    if (added.status !== 0 && !/already/i.test(out)) warn(`Claude Code: couldn’t add the marketplace (${out.trim().split('\n').pop()})`);
    const installed = run('claude', ['plugin', 'install', 'dotpals@dotpals']);
    const out2 = `${installed.stdout}${installed.stderr}`;
    if (installed.status === 0 || /already/i.test(out2)) ok('Claude Code: plugin installed (restart Claude Code to load it)');
    else warn(`Claude Code: couldn’t install the plugin (${out2.trim().split('\n').pop()})`);
  }

  // 6. Codex: nothing to install, just check it's there.
  if (existsSync(join(homedir(), '.codex'))) ok('Codex: found. Its sessions show up automatically');
  else skip('Codex: not found (it will be picked up if you install it later)');

  // Asked for above: Claude's usage limits in the notch, and Laya for local test checks.
  if (prefs.statusline) statusline(new Set());
  if (prefs.laya) await laya(new Set());

  // 7. Start the pal, open at login, show the dashboard.
  const extra = ['--dashboard', { auto: '--notch-auto', always: '--notch', off: '--no-notch' }[prefs.notch] ?? '--notch'];
  if (!flags.has('--no-login') && prefs.login !== false) extra.push('--open-at-login');
  if (flags.has('--no-start')) skip('Not starting the pal (--no-start)');
  else if (await bridgeUp()) {
    // The pal from before this install is still up: it would keep running the old code, so restart it.
    // The same version too (a fix installed from a branch keeps the number); never a newer one.
    const running = await runningVersion();
    const installed = (() => { try { return JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version; } catch { return null; } })();
    if (running && installed && compareVersions(running, installed) <= 0 && (await quitRunningApp())) {
      if (startApp(extra)) ok(`Restarted the pal on ${installed} (it was running ${running})`);
      else warn('The old pal was closed, but the desktop runtime isn’t installed: run dotpals start');
    } else {
      ok('The pal is already running');
      openUrl(`${bridge}/dashboard`);
    }
  } else if (startApp(extra)) {
    ok(`The pal is starting${flags.has('--no-login') ? '' : ', and will open when you log in'}`);
  } else {
    warn('No desktop runtime, so starting the dashboard in your browser instead');
    spawn(process.execPath, [join(appDir, 'bridge', 'server.js')], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => openUrl(`${bridge}/dashboard`), 800);
  }

  // What you chose, and what to do next.
  const c = loadConfig();
  const checker = { off: 'off', local: 'Local (Laya)', cloud: `Cloud (Jev${c.checker?.keySet ? '' : ', no key yet'})` }[c.checker?.mode] ?? 'off';
  console.log(`
  ${bold('Done.')} ${dim(`Pal: ${c.character} · notch: ${{ auto: 'when the pal is hidden', always: 'always', off: 'never' }[prefs.notch] ?? 'always'} · requests read: ${c.storyView ?? 'simple'} · test checks: ${checker}`)}

  ${bold('Next')}
    1. ${has('claude') && !flags.has('--no-claude') ? 'Restart Claude Code (in VS Code: Developer: Reload Window) so it loads the dotpals plugin.' : 'Open your coding agent.'}
    2. Ask it to do something. The pal shows what it's doing, live, and sums up each request.
    3. The notch is the island at the top of your screen; ${bold('Ctrl+Alt+P')} shows or hides the pal. Dashboard: ${bridge}/dashboard
  ${dim('Cursor, Gemini CLI, OpenCode, Copilot CLI: Dashboard → Agents → Connect.')}
  ${dim(`Any other agent: POST events to ${bridge}/event (see the README).`)}
  ${dim('Change any choice later: Dashboard → Settings. Check what\'s connected: dotpals status')}
`);
}

/**
 * Setup's questions, in the terminal: the pal, sounds, the notch, how requests read,
 * approving from the pal, sharing between agents, two agents changing one file,
 * double-checking test results (Off, Local Laya, or Cloud Jev with its key, typed
 * hidden), Claude's usage limits and opening at login. Enter keeps the default shown in brackets. Saved to the settings
 * file; the dashboard's Settings changes them later. With --yes, or without a terminal
 * (scripts, CI), nothing is asked and the defaults stay.
 */
async function preferences(flags) {
  const answers = { notch: 'always', login: true, statusline: false, laya: false };
  // DOTPALS_ASK=1 asks even without a terminal (answers piped in: tests, scripted setups).
  const terminal = process.env.DOTPALS_ASK === '1' || (process.stdin.isTTY && process.stdout.isTTY);
  if (flags.has('--yes') || flags.has('-y') || !terminal) {
    skip('Using the default settings (change them any time: Dashboard → Settings)');
    return answers;
  }
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdout.isTTY });
  let hidden = false; // typing a key: echo nothing
  const write = rl._writeToOutput?.bind(rl);
  if (write) rl._writeToOutput = (s) => { if (!hidden || /[\r\n]/.test(s)) write(hidden ? s.replace(/[^\r\n]/g, '') : s); };
  // Answers in order, even when they arrive all at once (piped in); no more input: the defaults.
  const lines = [];
  const waiting = [];
  let closed = false;
  rl.on('line', (l) => (waiting.length ? waiting.shift()(l) : lines.push(l)));
  rl.on('close', () => { closed = true; while (waiting.length) waiting.shift()(''); });
  rl.question = (prompt) => {
    process.stdout.write(prompt);
    if (lines.length) { const l = lines.shift(); if (!process.stdout.isTTY) process.stdout.write(`${hidden ? '' : l}\n`); return Promise.resolve(l); }
    if (closed) { process.stdout.write('\n'); return Promise.resolve(''); }
    return new Promise((resolve) => waiting.push(resolve));
  };
  const ask = async (q, def) => (await rl.question(`  ${q} ${dim(`[${def}]`)} `)).trim() || def;
  const pick = async (q, options, def) => {
    console.log(`  ${q}`);
    options.forEach(([, label], i) => console.log(`    ${bold(String(i + 1))}. ${label}`));
    const at = options.findIndex(([v]) => v === def) + 1;
    const n = Number(await ask('Choose', String(at)));
    return options[n - 1]?.[0] ?? def;
  };
  const yn = async (q, def) => {
    const a = (await rl.question(`  ${q} ${dim(def ? '[Y/n]' : '[y/N]')} `)).trim();
    return a ? /^y/i.test(a) : def;
  };
  try {
    // One question first. Default needs nothing else: Blu, the notch on, sounds, one-line
    // summaries, no checker, open at login. Everything is changeable later in Settings.
    console.log('');
    const pal = loadConfig().character ?? 'blu'; // a reinstall keeps the pal you chose
    const how = await pick('Set up dotpals:', [['default', `Default (recommended): ${pal[0].toUpperCase()}${pal.slice(1)}, the notch on, sounds, one-line summaries, opens at login`], ['custom', 'Customize: pick the pal, the notch, the test checker and more (about 9 questions)']], 'default');
    if (how === 'default') { skip('Using the defaults (change any of them later: Dashboard → Settings)'); return answers; }
    console.log(`\n  ${bold('A few choices')} ${dim('(Enter keeps the one in brackets; change any later: Dashboard → Settings)')}\n`);
    const patch = {};
    patch.character = await pick('Your pal:', [['blu', 'Blu (blue, with a beret)'], ['hop', 'Hop (green frog)'], ['sunny', 'Sunny (yellow)'], ['lovi', 'Lovi (pink, with sunglasses)'], ['muse', 'Muse (purple)'], ['grok', 'Grok (robot)'], ['nova', 'Nova'], ['byte', 'Byte']], loadConfig().character ?? 'blu');
    patch.sounds = await yn('Sounds (a ping when an agent needs you, a chime when it’s done)?', true);
    answers.notch = await pick('The notch at the top of the screen:', [['always', 'Always (recommended)'], ['auto', 'Only when the pal is hidden'], ['off', 'Never']], 'always');
    patch.storyView = await pick('How should each request read?', [['simple', 'Simple: one plain sentence (“Changed 2 files, the tests passed, and pushed.”)'], ['detailed', 'Detailed: every chapter (files, commands, tests)']], 'simple');
    patch.approvals = await yn('Approve Claude Code’s permission prompts from the pal?', false);
    patch.shareRecap = await yn('Tell each Claude Code session what your other agents did in the same project?', false);
    patch.conflictGuard = await pick('When an agent is about to change a file another agent changed minutes ago:', [['ask', 'Ask me first (Claude Code asks you; other agents: an alert in the notch)'], ['tell', 'Tell Claude to re-read the file first, then decide'], ['off', 'Off']], 'ask');
    const mode = await pick('Double-check test results the rules can’t call?', [['off', 'Off'], ['local', 'Local: Laya on this computer (free, private; needs Python, downloads a few GB)'], ['cloud', 'Cloud: TypeSafe Jev (fast, needs an API key; sends the test output with secrets removed)']], 'off');
    patch.checker = { mode };
    if (mode === 'cloud') {
      console.log(`  ${dim('Get a key at https://console.typesafe.ai. It’s saved in your dotpals settings only.')}`);
      hidden = true;
      const key = (await rl.question('  TypeSafe API key (hidden, Enter to skip): ')).trim();
      hidden = false;
      process.stdout.write('\n');
      // Only a key that looks like one is kept (the dashboard refuses the same ones).
      if (key && validKey(key)) patch.checker.jevKey = validKey(key);
      else if (key) warn('That doesn’t look like a TypeSafe key (8 or more characters, no spaces), so it wasn’t saved. Add it later in Dashboard → Settings.');
      else console.log(`  ${dim('No key yet: add it later in Dashboard → Settings, or set TYPESAFE_API_KEY.')}`);
    }
    if (mode === 'local') answers.laya = await yn('Set up Laya now (Python environment and model, a few GB)?', true);
    if (has('claude')) answers.statusline = await yn('Show Claude’s usage limits (5-hour and weekly) in the notch?', true);
    answers.login = await yn('Open dotpals when you log in?', true);
    saveConfig(patch);
    ok('Saved your choices');
    if (mode === 'cloud' && patch.checker.jevKey) ok(`TypeSafe key saved (••••${patch.checker.jevKey.slice(-4)})`);
  } catch (err) {
    warn(`Kept the default settings (${err.message})`);
  } finally {
    rl.close();
  }
  return answers;
}

/**
 * Claude Code only shares your plan usage (5-hour and weekly limits) with a status
 * line command, so install ours in ~/.claude/settings.json. A status line you
 * already have keeps working: ours runs it and shows its output. `--off` undoes it.
 */
function statusline(flags) {
  const settingsFile = join(homedir(), '.claude', 'settings.json');
  const savedFile = join(home(), 'statusline.json');
  let settings = {};
  try { settings = JSON.parse(readFileSync(settingsFile, 'utf8')); } catch (err) {
    if (err.code !== 'ENOENT') { warn(`Couldn’t read ${settingsFile}: ${err.message}. Nothing changed.`); process.exitCode = 1; return; }
  }
  const script = join(existsSync(join(appDir, 'bridge', 'statusline.js')) ? appDir : here, 'bridge', 'statusline.js');
  const ours = (s) => /bridge[\\/]statusline\.js/.test(s?.command ?? '');
  const write = (next) => {
    mkdirSync(join(homedir(), '.claude'), { recursive: true });
    if (existsSync(settingsFile)) cpSync(settingsFile, `${settingsFile}.dotpals-backup`);
    writeFileSync(settingsFile, `${JSON.stringify(next, null, 2)}\n`);
  };

  if (flags.has('--off')) {
    if (!ours(settings.statusLine)) { ok('dotpals isn’t your Claude Code status line. Nothing to undo'); return; }
    let previous = null;
    try { previous = JSON.parse(readFileSync(savedFile, 'utf8')).previous; } catch {}
    const next = { ...settings };
    if (previous) next.statusLine = previous; else delete next.statusLine;
    write(next);
    rmSync(savedFile, { force: true });
    ok(previous ? 'Put your previous status line back' : 'Removed the dotpals status line');
    return;
  }

  if (ours(settings.statusLine)) { ok('Already set up. Claude Code shares its usage limits with dotpals'); return; }
  mkdirSync(home(), { recursive: true });
  writeFileSync(savedFile, `${JSON.stringify({ previous: settings.statusLine ?? null }, null, 2)}\n`);
  write({ ...settings, statusLine: { type: 'command', command: `node "${script.replace(/\\/g, '/')}"` } });
  ok(`Claude Code will share its usage limits with dotpals${settings.statusLine ? ' (your status line still shows as before)' : ''}`);
  console.log(`  ${dim(`Backup: ${settingsFile}.dotpals-backup · undo: dotpals statusline --off`)}`);
}

async function status() {
  try {
    const s = await (await fetch(`${bridge}/api/status`, { signal: AbortSignal.timeout(1500) })).json();
    const ago = (t) => (t ? `${Math.round((Date.now() - t) / 60000)}m ago` : 'not yet');
    console.log(`dotpals ${s.version} running on port ${s.port}`);
    for (const a of s.agents ?? []) {
      const state = !a.enabled ? 'off'
        : a.setup === 'connect' ? (a.connected ? `connected, last event ${ago(a.lastEventAt)}` : a.found ? 'found, not connected (dashboard → Agents)' : 'not found')
        : a.found === false ? 'not found' : `last event ${ago(a.lastEventAt)}`;
      console.log(`  ${a.name.padEnd(19)}${state}`);
    }
    console.log(`  History      ${s.historyFile} (${s.entries} entries)`);
    console.log(`  Dashboard    ${bridge}/dashboard`);
  } catch {
    console.log('dotpals isn’t running. Start it with: dotpals start');
    process.exitCode = 1;
  }
}

/**
 * Laya, the free local checker for unclear test results (bridge/laya.js), set up from the
 * terminal: the same steps as Settings → Set up Laya, with progress. When the bridge is
 * running it does the work (so there's only ever one Laya), and this shows its progress.
 * Otherwise this installs it, starts it once to fetch the model and check it answers, and
 * stops it again: dotpals starts it whenever the checker is on Local.
 */
async function laya(flags) {
  const { createLaya, PYTHON_URL } = await import('../bridge/laya.js');
  const remove = flags.has('--remove');
  let phase = null;
  let line = '';
  const tty = process.stdout.isTTY;
  const clearLine = () => { if (tty && line) { process.stdout.write('\r\x1b[2K'); line = ''; } };
  const show = (s) => {
    if (s.phase !== phase && !['idle', 'ready', 'error'].includes(s.phase)) { clearLine(); console.log(`  ${dim('…')} ${s.message}`); }
    phase = s.phase;
    if (tty && s.line && s.line !== line && !['ready', 'error'].includes(s.phase)) {
      line = s.line;
      process.stdout.write(`\r\x1b[2K    ${dim(s.line.slice(0, Math.max(20, (process.stdout.columns || 80) - 6)))}`);
    }
  };
  const finish = (s) => {
    clearLine();
    if (remove) { ok('Removed Laya (its Python environment and model)'); return; }
    if (s.phase === 'ready') {
      ok(s.message);
      console.log(`  ${dim('dotpals starts it whenever Settings → Double-check unclear test results is on Local.')}`);
      return;
    }
    warn(s.message);
    if (s.error === 'no-python') console.log(`  Install Python 3.10 or newer from ${PYTHON_URL}${platform() === 'win32' ? ' (tick “Add python.exe to PATH” in the installer)' : ''}, then run ${bold('dotpals laya')} again.`);
    process.exitCode = 1;
  };
  console.log(`\n${bold(remove ? 'Removing Laya' : 'Setting up Laya')} ${dim('(free, open source, runs on this computer)')}\n`);
  if (!remove) console.log(`  ${dim('It goes in dotpals’ own folder. Needs Python 3.10+, and downloads a few GB the first time (PyTorch and the model).')}\n`);

  if (await bridgeUp()) {
    const post = (path) => fetch(`${bridge}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dotpals': '1' }, body: '{}' }).then((r) => r.json());
    if (remove) { await post('/api/checker/laya/uninstall'); finish({}); return; }
    let s = (await post('/api/checker/laya/setup')).laya;
    show(s);
    while (!['ready', 'error'].includes(s.phase)) {
      await new Promise((r) => setTimeout(r, 1000));
      try { s = (await (await fetch(`${bridge}/api/checker/laya`)).json()); } catch { warn('The bridge stopped while setting up Laya. Run dotpals laya again.'); process.exitCode = 1; return; }
      show(s);
    }
    finish(s);
    return;
  }

  const config = loadConfig();
  const manager = createLaya({ getUrl: () => config.checker.localUrl });
  if (remove) {
    await manager.uninstall();
    saveConfig({ checker: { layaManaged: false, ...(config.checker.mode === 'local' ? { mode: 'off' } : {}) } });
    finish({});
    return;
  }
  const s = await manager.setup({ onProgress: show });
  if (s.installed) saveConfig({ checker: { mode: 'local', layaManaged: true, ...(s.running ? { localUrl: `http://127.0.0.1:${s.port}` } : {}) } });
  // It was only started to check it works (and fetch the model): the bridge runs it from now on.
  if (s.running) await manager.stop();
  finish(s.running ? { ...s, message: 'Laya is set up and answers on this computer' } : s);
}

const [command = 'help', ...rest] = process.argv.slice(2);
const flags = new Set(rest);
switch (command) {
  case 'setup': await setup(flags); break;
  case 'start':
    if (!startApp()) { console.log('The desktop runtime isn’t installed. Run: npx dotpals setup'); process.exitCode = 1; }
    break;
  case 'dashboard':
    // The app's own window when the desktop pal is installed (a running pal just opens it);
    // otherwise a browser tab.
    if (startApp(['--dashboard'])) break;
    if (await bridgeUp()) openUrl(`${bridge}/dashboard`);
    else { console.log('dotpals isn’t running. Run: dotpals start'); process.exitCode = 1; }
    break;
  case 'status': await status(); break;
  case 'statusline': statusline(flags); break;
  case 'notch':
    // The island at the top of the screen: every agent, its plan and your usage limits.
    if (!startApp([flags.has('--off') ? '--no-notch' : flags.has('--auto') ? '--notch-auto' : '--notch'])) { console.log('The desktop runtime isn’t installed. Run: npx dotpals setup'); process.exitCode = 1; }
    break;
  case 'bridge': await import('../bridge/server.js').then((m) => m.startBridge()); break;
  case 'laya': await laya(flags); break;
  default:
    console.log(`dotpals ${version}

  setup       install, connect Claude Code and Codex, ask a few choices
              (your pal, the notch, test checks…) and start the pal
              (--yes: keep the defaults; --no-claude, --no-login, --no-start, --no-path)
  start       open the floating pal
  dashboard   open the dashboard
  status      what's running and connected
  notch       keep the notch at the top of the screen (--auto: only when
              the pal is hidden, the default; --off: never)
  statusline  let Claude Code share its usage limits with dotpals (--off to undo)
  laya        set up Laya, the free checker for unclear test results that runs
              on this computer (needs Python 3.10+; --remove to delete it)
  bridge      run only the bridge, no window`);
}
