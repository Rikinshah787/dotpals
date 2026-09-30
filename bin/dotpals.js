#!/usr/bin/env node
// dotpals command line.
//
//   npx --allow-git=all github:rikinshah787/dotpals setup     one command: install, connect your agents, start
//   dotpals start                             open the floating pal
//   dotpals dashboard                         open the dashboard
//   dotpals status                            what's running and connected
//   dotpals bridge                            run only the bridge (no window)
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findElectron, installElectron } from '../desktop/launch.js';
import { home, saveConfig } from '../bridge/config.js';

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
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', shell: platform() === 'win32' });

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
    for (const part of ['package.json', 'LICENSE', 'src', 'bridge', 'desktop', 'bin', 'hooks', 'commands', '.claude-plugin']) {
      if (existsSync(join(here, part))) cpSync(join(here, part), join(appDir, part), { recursive: true });
    }
  }
  ok(`Installed to ${appDir}`);

  // 3. The desktop window's runtime (Electron), once.
  if (findElectron()) ok('Desktop runtime already installed');
  else {
    console.log(`  ${dim('…')} Downloading the desktop runtime (Electron, about 100 MB, one time)`);
    if (installElectron()) ok('Desktop runtime installed');
    else { warn('Couldn’t install Electron. You can still use the dashboard in a browser: dotpals bridge'); }
  }

  // 4. Settings file with defaults.
  saveConfig({});
  ok(`Settings in ${join(home(), 'config.json')}`);

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

  // 7. Start the pal, open at login, show the dashboard.
  const extra = ['--dashboard'];
  if (!flags.has('--no-login')) extra.push('--open-at-login');
  if (flags.has('--no-start')) skip('Not starting the pal (--no-start)');
  else if (await bridgeUp()) {
    ok('The pal is already running');
    openUrl(`${bridge}/dashboard`);
  } else if (startApp(extra)) {
    ok(`The pal is starting${flags.has('--no-login') ? '' : ', and will open when you log in'}`);
  } else {
    warn('No desktop runtime, so starting the dashboard in your browser instead');
    spawn(process.execPath, [join(appDir, 'bridge', 'server.js')], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => openUrl(`${bridge}/dashboard`), 800);
  }

  console.log(`
  ${bold('Done.')} Keyboard: ${bold('Ctrl+Alt+P')} shows or hides the pal.
  Dashboard: ${bridge}/dashboard   ${dim('(or the tray icon → Dashboard)')}
  Any other agent: POST events to ${bridge}/event ${dim('(see the README)')}
`);
}

async function status() {
  try {
    const s = await (await fetch(`${bridge}/api/status`, { signal: AbortSignal.timeout(1500) })).json();
    const ago = (t) => (t ? `${Math.round((Date.now() - t) / 60000)}m ago` : 'not yet');
    console.log(`dotpals ${s.version} running on port ${s.port}`);
    console.log(`  Claude Code  last event ${ago(s.adapters.claude.lastEventAt)}`);
    console.log(`  Codex        ${s.adapters.codex.enabled ? (s.adapters.codex.found ? `following, last event ${ago(s.adapters.codex.lastEventAt)}` : 'not found') : 'off'}`);
    console.log(`  History      ${s.historyFile} (${s.entries} entries)`);
    console.log(`  Dashboard    ${bridge}/dashboard`);
  } catch {
    console.log('dotpals isn’t running. Start it with: dotpals start');
    process.exitCode = 1;
  }
}

const [command = 'help', ...rest] = process.argv.slice(2);
const flags = new Set(rest);
switch (command) {
  case 'setup': await setup(flags); break;
  case 'start':
    if (!startApp()) { console.log('The desktop runtime isn’t installed. Run: npx --allow-git=all github:rikinshah787/dotpals setup'); process.exitCode = 1; }
    break;
  case 'dashboard':
    // The app's own window when the desktop pal is installed (a running pal just opens it);
    // otherwise a browser tab.
    if (startApp(['--dashboard'])) break;
    if (await bridgeUp()) openUrl(`${bridge}/dashboard`);
    else { console.log('dotpals isn’t running. Run: dotpals start'); process.exitCode = 1; }
    break;
  case 'status': await status(); break;
  case 'bridge': await import('../bridge/server.js').then((m) => m.startBridge()); break;
  default:
    console.log(`dotpals ${version}

  setup       install, connect Claude Code and Codex, and start the pal
              (--no-claude, --no-login, --no-start)
  start       open the floating pal
  dashboard   open the dashboard
  status      what's running and connected
  bridge      run only the bridge, no window`);
}
