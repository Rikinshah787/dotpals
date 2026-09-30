// Settings, shared by the bridge, the pal and the desktop app: ~/.dotpals/config.json.
// Edited from the dashboard's Settings page (or by hand). Environment variables
// still win: DOTPALS_HISTORY=0, DOTPALS_CODEX=0, DOTPALS_HOME=<folder>.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const home = () => process.env.DOTPALS_HOME || join(homedir(), '.dotpals');
const file = () => join(home(), 'config.json');

export const DEFAULTS = {
  character: 'blu',     // the first pal
  sounds: true,
  notifications: true,
  history: true,        // keep activity in ~/.dotpals/history.json
  historyDays: 7,
  codex: true,          // follow Codex's session logs
};

const CHARACTERS = ['blu', 'hop', 'sunny', 'lovi', 'muse', 'grok', 'nova', 'byte'];

/** Keep only known settings with sensible values. */
function clean(input = {}) {
  const out = {};
  for (const key of ['sounds', 'notifications', 'history', 'codex']) if (typeof input[key] === 'boolean') out[key] = input[key];
  if (CHARACTERS.includes(input.character)) out.character = input.character;
  const days = Number(input.historyDays);
  if (Number.isInteger(days) && days >= 1 && days <= 90) out.historyDays = days;
  return out;
}

export function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(readFileSync(file(), 'utf8')); } catch {}
  const config = { ...DEFAULTS, ...clean(saved) };
  if (process.env.DOTPALS_HISTORY === '0') config.history = false;
  if (process.env.DOTPALS_CODEX === '0') config.codex = false;
  return config;
}

/** Merge `patch` into the saved settings. Returns the full, effective config. */
export function saveConfig(patch) {
  let saved = {};
  try { saved = JSON.parse(readFileSync(file(), 'utf8')); } catch {}
  const next = { ...clean(saved), ...clean(patch) };
  mkdirSync(home(), { recursive: true });
  writeFileSync(file(), `${JSON.stringify(next, null, 2)}\n`);
  return loadConfig();
}

export const configPath = file;
