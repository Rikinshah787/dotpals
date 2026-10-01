#!/usr/bin/env node
// Opens the floating desktop pal (an always-on-top Electron window).
//
//   node desktop/launch.js             open it (also starts the bridge if needed)
//   node desktop/launch.js --install   download Electron once into ~/.dotpals, then open it
//
// Electron is looked up in this package's node_modules (after `npm install`),
// then in ~/.dotpals, so the Claude Code plugin can use it without its own install.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const shared = process.env.DOTPALS_HOME || join(homedir(), '.dotpals');

/** Path to the Electron executable, or null if it isn't installed. */
export function findElectron() {
  if (process.env.DOTPALS_ELECTRON) return process.env.DOTPALS_ELECTRON;
  for (const dir of [join(root, 'node_modules', 'electron'), join(shared, 'node_modules', 'electron')]) {
    try {
      const exe = join(dir, 'dist', readFileSync(join(dir, 'path.txt'), 'utf8').trim());
      if (existsSync(exe)) return exe;
    } catch {}
  }
  return null;
}

/**
 * The installed copy (`dotpals setup` puts it in ~/.dotpals/app), when there is one. It has
 * what setup installed next to it (the optional TypeSafe SDK), which a Claude Code plugin's
 * folder doesn't.
 */
export function installedRoot() {
  const dir = join(shared, 'app');
  return existsSync(join(dir, 'desktop', 'main.js')) ? dir : null;
}

/**
 * Start the floating pal in the background. Returns false if Electron isn't installed.
 * `app`: the dotpals folder to run (this one by default; the plugin's hook passes the
 * installed copy).
 */
export function launchFloat(electron = findElectron(), { app = root } = {}) {
  if (!electron) return false;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(electron, [join(app, 'desktop', 'main.js')], { detached: true, stdio: 'ignore', env }).unref();
  return true;
}

/** Download Electron once into ~/.dotpals. Returns true on success. */
export function installElectron() {
  mkdirSync(shared, { recursive: true });
  console.log(`Installing Electron into ${shared} (about 100 MB, one time)…`);
  const { status } = spawnSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--prefix', shared, 'electron'], { stdio: 'inherit', shell: true });
  return status === 0;
}

const invoked = process.argv[1] && (() => { try { return realpathSync(process.argv[1]); } catch { return ''; } })();
if (invoked && invoked === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv.includes('--install') && !findElectron() && !installElectron()) process.exit(1);
  if (launchFloat()) {
    console.log('dotpals is floating on your screen.');
  } else {
    console.log('Electron isn\'t installed yet. Run `node desktop/launch.js --install` (one-time, about 100 MB).');
    process.exit(1);
  }
}
