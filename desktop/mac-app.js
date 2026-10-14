#!/usr/bin/env node
// macOS: dotpals.app, a copy of Electron's own app named dotpals, made by setup. macOS lists the app
// that asks for Accessibility, Screen Recording, the microphone and control of other apps; run as
// plain Electron, that's "Electron" (or the terminal that started it), not dotpals.
//
//   node desktop/mac-app.js <dest>    make it at <dest> (setup: ~/.dotpals/dotpals.app); macOS only
//
// Only the copy's Info.plist and icon change. Its helper apps keep Electron's names: Electron
// looks for "Electron Helper.app" first, so nothing else needs renaming. It's signed ad hoc on
// this Mac (no certificate): Apple silicon runs only signed code, and the copy changed.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUNDLE_ID = 'dev.dotpals.desktop';
const icon = fileURLToPath(new URL('./icon.png', import.meta.url));
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });

// What macOS shows for the app. The two reasons are the lines it shows when it asks you.
const INFO = [
  ['CFBundleName', '-string', 'dotpals'],
  ['CFBundleDisplayName', '-string', 'dotpals'],
  ['CFBundleIdentifier', '-string', BUNDLE_ID],
  ['LSUIElement', '-bool', 'YES'], // a menu-bar app: no Dock icon
  // Without it, macOS refuses the Apple events dotpals' osascript sends (error -1743), without asking.
  ['NSAppleEventsUsageDescription', '-string', 'When you ask, dotpals moves windows, presses keys, pastes what you dictate and controls music in your other apps.'],
  ['NSMicrophoneUsageDescription', '-string', 'dotpals listens only while you use Talk or Dictate.'],
];

/** The folder holding Electron.app, from the path to its executable. */
export const electronDist = (exe) => exe.split(/[\\/]Electron\.app[\\/]/)[0];

/**
 * Make `dest` (dotpals.app) from the Electron.app in `electronDist`: copy it, name it dotpals,
 * give it dotpals' icon, sign it ad hoc and check the signature. `run(cmd, args)` runs a command
 * like spawnSync does (tests pass their own). Throws when a step fails, and then removes `dest`.
 */
export function buildMacApp({ electronDist, dest, run = sh }) {
  const plist = join(dest, 'Contents', 'Info.plist');
  const step = (cmd, args) => {
    const r = run(cmd, args);
    if (r?.status !== 0) throw new Error(`${cmd} failed: ${`${r?.stderr ?? ''}`.trim() || `exit ${r?.status}`}`);
  };
  rmSync(dest, { recursive: true, force: true });
  try {
    step('ditto', [join(electronDist, 'Electron.app'), dest]); // keeps the frameworks' symlinks
    for (const [key, type, value] of INFO) step('plutil', ['-replace', key, type, value, plist]);
    // dotpals' icon over Electron's (the same file name, so Info.plist still points at it). Looks only: it may fail.
    run('sips', ['-s', 'format', 'icns', icon, '--out', join(dest, 'Contents', 'Resources', 'electron.icns')]);
    step('xattr', ['-cr', dest]); // no quarantine flag or Finder info: codesign refuses the latter
    // --deep: the helper apps and frameworks inside too. Fine here: no certificate or entitlements to differ.
    step('codesign', ['--force', '--deep', '--sign', '-', dest]);
    step('codesign', ['--verify', '--deep', '--strict', dest]);
  } catch (err) {
    rmSync(dest, { recursive: true, force: true });
    throw err;
  }
  return dest;
}

/** The Electron version an app bundle holds (its CFBundleVersion), or '' when there's none. */
export function bundleVersion(app, run = sh) {
  const r = run('plutil', ['-extract', 'CFBundleVersion', 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')]);
  return r?.status === 0 ? `${r.stdout}`.trim() : '';
}

/** macOS: the LaunchAgent that opens dotpals when you log in (Electron's login item can't pass main.js there). */
export const loginAgentFile = (home = homedir()) => join(home, 'Library', 'LaunchAgents', `${BUNDLE_ID}.plist`);
/** Whether it opens at login (the LaunchAgent is there). */
export const loginAgentOn = (home) => existsSync(loginAgentFile(home));

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Its contents: start `exe` (dotpals.app's, or Electron's) with desktop/main.js (`main`). */
export function loginAgentPlist(exe, main) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${BUNDLE_ID}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(exe)}</string>
    <string>${xml(main)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`;
}

/** Open at login on or off: writes or removes the LaunchAgent. Returns whether it's on. */
export function setLoginAgent(on, { exe, main, home } = {}) {
  const file = loginAgentFile(home);
  try {
    if (!on) rmSync(file, { force: true });
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, loginAgentPlist(exe, main));
    }
  } catch {}
  return existsSync(file);
}

const invoked = process.argv[1] && (() => { try { return realpathSync(process.argv[1]); } catch { return ''; } })();
if (invoked && invoked === realpathSync(fileURLToPath(import.meta.url))) {
  const dest = process.argv[2];
  if (process.platform !== 'darwin') console.log('dotpals.app is made on macOS only. Nothing to do here.');
  else if (!dest) { console.log('Usage: node desktop/mac-app.js <dest>, e.g. ~/.dotpals/dotpals.app'); process.exitCode = 1; }
  else {
    const { findElectron } = await import('./launch.js');
    const exe = findElectron();
    if (!exe) { console.log('Electron isn’t installed: run npm install (or node desktop/launch.js --install) first.'); process.exitCode = 1; }
    else {
      try { console.log(buildMacApp({ electronDist: electronDist(exe), dest: resolve(dest) })); } catch (err) { console.error(err.message); process.exitCode = 1; }
    }
  }
}
