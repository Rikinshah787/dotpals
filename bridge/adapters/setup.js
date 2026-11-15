// Helpers for integrations that need a line in another tool's config (Cursor's
// hooks.json, Gemini CLI's settings.json…) or a file in its folder (an OpenCode
// plugin). Every change backs the original up first, merges instead of
// overwriting, and can be undone; a file we can't read is never touched.
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { home } from '../config.js';
import { findOnPath } from '../handoff.js';
import { nodeWrapper } from '../runtime.js';

const own = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]+$/, '');

/**
 * Where dotpals is installed. `dotpals setup` copies it to ~/.dotpals/app, which
 * outlives npx's temporary folder, so commands written into other tools point
 * there; a copy run from a checkout points at itself.
 */
export function appRoot() {
  const app = join(home(), 'app');
  // An older install's hook.js only speaks Claude Code; use this copy until setup updates it.
  try { if (readFileSync(join(app, 'bridge', 'hook.js'), 'utf8').includes('hook.js <agent>')) return app; } catch {}
  return own;
}

const slash = (p) => p.replace(/\\/g, '/');

/**
 * The Node that hook commands run, by its full path: an agent may run its hooks without
 * Node on its PATH (an app started from the Start menu or the Dock, or an agent that
 * doesn't need Node itself). The `node` on PATH comes first: where a version manager
 * puts a link or shim there (nvm-windows, Volta, Homebrew), it stays put when Node is
 * upgraded, while the running Node's own path can be a version's folder that goes away.
 * fnm's PATH entry is a folder for one terminal, so it's followed to the real one. Then
 * this Node (not in the desktop app, where it's Electron), and last plain `node`.
 */
export function nodePath({ env = process.env, platform = process.platform, execPath = process.execPath, electron = !!process.versions.electron, exists, realpath = realpathSync } = {}) {
  const found = findOnPath('node', { env: { ...env, PATHEXT: '.exe' }, platform, exists });
  if (found && /fnm_multishells/i.test(found)) try { return realpath(found); } catch {}
  return found ?? (electron ? null : execPath);
}

/**
 * The command another tool runs for each event: `"/usr/local/bin/node" ".../bridge/hook.js" cursor`. With the
 * dotpals app installed, its dotpals-node (bridge/runtime.js), which needs no Node; otherwise Node by its full path.
 * On Windows, Cursor, Gemini CLI and Copilot CLI run it in PowerShell, which needs `&` to run a quoted path.
 */
export function hookCommand(agent, { platform = process.platform, node = nodeWrapper(platform) ?? nodePath({ platform }) } = {}) {
  const script = `"${slash(join(appRoot(), 'bridge', 'hook.js'))}" ${agent}`;
  if (!node) return `node ${script}`;
  return `${platform === 'win32' ? '& ' : ''}"${slash(node)}" ${script}`;
}

/** Is this one of our commands? Known by the script and the agent, from any install location and whatever runs it (plain `node`, its full path or a wrapper). */
export const isOurs = (command, agent) => new RegExp(`[\\\\/]bridge[\\\\/]hook\\.js"?\\s+${agent}\\b`).test(String(command ?? ''));

export const backupPath = (file) => `${file}.dotpals-backup`;

/**
 * Read a JSON config. Missing → `fallback`. Unreadable (bad JSON, comments we
 * can't keep) → throws, so the caller leaves the file alone.
 */
export function readJson(file, fallback = {}) {
  if (!existsSync(file)) return structuredClone(fallback);
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (!text.trim()) return structuredClone(fallback);
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data;
  } catch {
    throw new Error(`Couldn’t read ${file} as JSON, so it wasn’t changed. Fix or remove it and try again.`);
  }
}

/** Keep a copy of the original the first time we change a file. */
export function backup(file) {
  if (existsSync(file) && !existsSync(backupPath(file))) copyFileSync(file, backupPath(file));
  return existsSync(backupPath(file)) ? backupPath(file) : null;
}

/** Write JSON atomically (a half-written config would break the other tool). */
export function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.dotpals-tmp`, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(`${file}.dotpals-tmp`, file);
}

/** Write a file we own entirely (e.g. a plugin), backing up anything else in its place. */
export function writeOwnFile(file, text, marker) {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file) && !readFileSync(file, 'utf8').includes(marker)) backup(file);
  writeFileSync(file, text);
}

/** Remove a file we wrote, putting back whatever was there before. */
export function removeOwnFile(file, marker) {
  if (existsSync(file) && readFileSync(file, 'utf8').includes(marker)) rmSync(file);
  if (existsSync(backupPath(file)) && !existsSync(file)) renameSync(backupPath(file), file);
}
