// The dotpals app (the .exe and .dmg from the releases) starts here, then runs desktop/main.js like
// `dotpals start` does. It does what `npx dotpals@latest setup` does for the npm install, with no
// Node needed on the computer:
//
//   - macOS: opened from the disk image or Downloads, moves itself to Applications (or quits): from
//     there its path would change, and hooks would point at nothing. Takes PATH from your login
//     shell (an app opened from Finder gets a short one, without claude, so Claude Code wouldn't be found).
//   - A newer dotpals installed with `npx dotpals@latest setup` since: runs that one, on this app.
//   - Every start: writes ~/.dotpals/runtime.json and ~/.dotpals/bin (bridge/runtime.js), so agents'
//     hooks and the dotpals command run on this app.
//   - First start, and after an update: runs `dotpals setup` in the background (copies dotpals to
//     ~/.dotpals/app where hooks point, connects Claude Code, finds Codex), its output in
//     ~/.dotpals/setup.log. The first start also opens the setup guide, shows the notch and opens at login,
//     and when setup is done, plays a short scene on the notch: it works, and which agents it found.
//   - Updates itself: at most once a day it looks for a newer release on GitHub, downloads this computer's
//     installer, checks it against the release's SHA256SUMS.txt and installs it when dotpals quits
//     (or now, from the notification). Not on Linux (no installer there yet).
import { app, dialog, Notification } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { home } from '../bridge/config.js';
import { writeRuntime } from '../bridge/runtime.js';
import { compareVersions } from './launch.js';

const own = app.getAppPath();
const version = app.getVersion();
const versionOf = (dir) => { try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version; } catch { return null; } };

let note; // the update notification, kept so it isn't collected before it's clicked
let ready; // a downloaded and checked installer of a newer release, until it's installed

if (!app.requestSingleInstanceLock()) {
  app.exit(0); // the running one gets our arguments (main.js handles them)
} else if (process.platform === 'darwin' && /^\/Volumes\/|\/AppTranslocation\/|\/Downloads\//.test(process.execPath)) {
  // From there its path would change (ejected, or a new quarantine copy each start), and hooks
  // and open at login would point at nothing: move to Applications (it restarts from there) or quit.
  await moveToApplications();
  app.exit(0);
} else {
  const shellPath = process.platform === 'darwin' ? loginShellPath() : Promise.resolve();
  mkdirSync(home(), { recursive: true });
  writeRuntime({ exe: process.execPath, app: own, version });

  const dir = join(home(), 'app');
  const installed = versionOf(dir);
  if (!installed || compareVersions(installed, version) < 0) {
    shellPath.then(() => setup(!installed)); // needs PATH to find Claude Code
    // The first time: the setup guide (connect and test your agents), the notch, and open at login, like setup's defaults.
    if (!installed) process.argv.push('--setup', '--first', '--notch', '--open-at-login');
  }
  app.whenReady().then(() => {
    setTimeout(checkForUpdate, 30_000);
    setInterval(checkForUpdate, 6 * 3_600_000); // it runs for days: look again (at most once a day)
  });
  // A newer dotpals installed since (npx dotpals@latest setup): run that one, on this app.
  const newer = installed && compareVersions(installed, version) > 0 && existsSync(join(dir, 'desktop', 'main.js'));
  await import(newer ? pathToFileURL(join(dir, 'desktop', 'main.js')).href : './main.js');
}

/** macOS, run from the disk image, Downloads or a quarantine copy (App Translocation): move to Applications, or quit. */
async function moveToApplications() {
  await app.whenReady();
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Move to Applications', 'Quit'],
    defaultId: 0,
    cancelId: 1,
    message: 'Move dotpals to your Applications folder?',
    detail: 'Your coding agents run dotpals from where it is, so it has to stay put. It starts again from Applications.',
  });
  if (response !== 0) return;
  try { app.moveToApplicationsFolder(); } catch (err) {
    dialog.showErrorBox('Couldn’t move dotpals', `${err.message}\n\nDrag dotpals to Applications yourself, then open it from there.`);
  }
}

/** macOS: PATH as your terminal has it (where claude and your tools are), not Finder's short one. In the background. */
function loginShellPath() {
  return new Promise((resolve) => {
    execFile(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__DOTPALS_PATH__%s__DOTPALS_PATH__" "$PATH"'], { encoding: 'utf8', timeout: 10_000 }, (_, stdout) => {
      const found = /__DOTPALS_PATH__(.*?)__DOTPALS_PATH__/.exec(stdout ?? '')?.[1];
      if (found) process.env.PATH = found;
      resolve();
    }).stdin?.end();
  });
}

/** `dotpals setup` with the defaults, on this app as Node, in the background. Its output: ~/.dotpals/setup.log. */
function setup(first) {
  const log = openSync(join(home(), 'setup.log'), 'w');
  const child = spawn(process.execPath, [join(own, 'bin', 'dotpals.js'), 'setup', '--yes', '--no-start', '--no-path'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.on('error', (err) => console.error('[dotpals] setup:', err.message));
  if (first) child.on('exit', (code) => welcome(code === 0));
  closeSync(log);
}

/** After the first install: a short scene on the notch (bridge/server.js → welcome), so you see it work. */
function welcome(ok) {
  const port = Number(process.env.DOTPALS_PORT || process.env.PORT) || 5175;
  fetch(`http://127.0.0.1:${port}/api/welcome`, { method: 'POST', headers: { 'x-dotpals': '1' }, body: JSON.stringify({ ok }) }).catch(() => {});
}

/**
 * At most once a day: is there a newer release? Downloads its installer for this computer in the background, checks it
 * against the release's SHA256SUMS.txt, and installs it when dotpals quits (or now: click the notification).
 */
async function checkForUpdate() {
  if (ready) return;
  const stamp = join(home(), 'update-check.json');
  try { if (Date.now() - JSON.parse(readFileSync(stamp, 'utf8')).at < 86_400_000) return; } catch {}
  try {
    const r = await fetch('https://api.github.com/repos/rikinshah787/dotpals/releases/latest', { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return; // offline, or GitHub's rate limit: try again next time
    const release = await r.json();
    const latest = String(release.tag_name ?? '').replace(/^v/, '');
    if (!latest || compareVersions(latest, version) <= 0) return writeFileSync(stamp, JSON.stringify({ at: Date.now() }));
    const name = process.platform === 'darwin' ? `dotpals-${latest}-mac-${process.arch}.dmg` : process.platform === 'win32' ? `dotpals-setup-${latest}-${process.arch}.exe` : null;
    const url = (n) => release.assets?.find((a) => a.name === n)?.browser_download_url;
    if (!name || !url(name) || !url('SHA256SUMS.txt')) return; // Linux, or the release is still being built: next time
    const sums = await (await fetch(url('SHA256SUMS.txt'), { signal: AbortSignal.timeout(10_000) })).text();
    const sum = sums.split('\n').map((l) => l.trim().split(/\s+\*?/)).find(([, n]) => n === name)?.[0];
    const res = await fetch(url(name), { signal: AbortSignal.timeout(30 * 60_000) });
    if (!sum || !res.ok) return;
    const file = join(home(), 'updates', name);
    mkdirSync(join(home(), 'updates'), { recursive: true });
    await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
    if (createHash('sha256').update(readFileSync(file)).digest('hex') !== sum) return rmSync(file, { force: true });
    writeFileSync(stamp, JSON.stringify({ at: Date.now() }));
    ready = file;
    app.once('will-quit', () => install(false));
    if (!Notification.isSupported()) return;
    note = new Notification({ title: `dotpals ${latest} is ready`, body: 'It installs when dotpals quits. Click to restart and update now.' });
    note.on('click', () => { install(true); app.quit(); });
    note.show();
  } catch {}
}

/** Installs the downloaded update once dotpals has quit; with relaunch, dotpals starts again after. Settings and history stay. */
function install(relaunch) {
  const file = ready;
  if (!file) return;
  ready = null;
  if (process.platform === 'win32') {
    // The setup wizard, silent: same folder as before; --force-run starts dotpals when it's done.
    spawn(file, ['/S', ...(relaunch ? ['--force-run'] : [])], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  // macOS: once this process is gone, copy dotpals.app from the disk image over this one.
  spawn('/bin/sh', ['-c', macInstall(process.pid, relaunch), 'sh', file, process.execPath.replace(/\/Contents\/MacOS\/[^/]+$/, '')], { detached: true, stdio: 'ignore' }).unref();
}

/** The script that swaps the app ($1: the disk image, $2: dotpals.app), after process `pid` exits. */
function macInstall(pid, relaunch) {
  return `while kill -0 ${pid} 2>/dev/null; do sleep 0.5; done
m=$(mktemp -d) && hdiutil attach -nobrowse -readonly -mountpoint "$m" "$1" >/dev/null && rm -rf "$2.new" && ditto "$m/dotpals.app" "$2.new" && rm -rf "$2" && mv "$2.new" "$2"
hdiutil detach "$m" -quiet; rm -f "$1"${relaunch ? '; open "$2"' : ''}`;
}
