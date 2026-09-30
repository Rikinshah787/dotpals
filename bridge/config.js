// Settings, shared by the bridge, the pal and the desktop app: ~/.dotpals/config.json.
// Edited from the dashboard's Settings and Agents pages (or by hand). Environment
// variables still win: DOTPALS_HISTORY=0, DOTPALS_CODEX=0, DOTPALS_HOME=<folder>.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cleanCustom } from '../src/custom.js';

export const home = () => process.env.DOTPALS_HOME || join(homedir(), '.dotpals');
const file = () => join(home(), 'config.json');

export const DEFAULTS = {
  character: 'blu',     // the first pal
  sounds: true,
  notifications: true,
  history: true,        // keep activity in ~/.dotpals/history.json
  historyDays: 7,
  codex: true,          // follow Codex's session logs
  approvals: false,     // answer Claude Code's permission prompts from the pal (off unless you turn it on)
  approvalWait: 30,     // seconds to wait for an answer there before Claude asks in the terminal
  shareRecap: false,    // tell each Claude Code session what your other agents did in the same project
  agents: {},           // per integration on/off, e.g. { cursor: false } (see bridge/adapters/index.js)
  custom: null,         // your own pal: { name, shape, eyes, top, color, fur }
};

/** Integrations that can be switched off in `agents` (ids from bridge/adapters/index.js). */
export const AGENT_IDS = ['claude', 'codex', 'cursor', 'gemini', 'opencode', 'copilot', 'generic'];

const CHARACTERS = ['blu', 'hop', 'sunny', 'lovi', 'muse', 'grok', 'nova', 'byte', 'custom'];

/** Keep only known settings with sensible values. */
function clean(input = {}) {
  const out = {};
  for (const key of ['sounds', 'notifications', 'history', 'codex', 'approvals', 'shareRecap']) if (typeof input[key] === 'boolean') out[key] = input[key];
  const wait = Number(input.approvalWait);
  if (Number.isInteger(wait) && wait >= 10 && wait <= 120) out.approvalWait = wait;
  if (CHARACTERS.includes(input.character)) out.character = input.character;
  // { cursor: false, … }: only known ids, only true/false. "codex" is the older `codex` switch.
  if (input.agents && typeof input.agents === 'object' && !Array.isArray(input.agents)) {
    const agents = {};
    for (const id of AGENT_IDS) if (typeof input.agents[id] === 'boolean') agents[id] = input.agents[id];
    if ('codex' in agents) { out.codex ??= agents.codex; delete agents.codex; }
    out.agents = agents;
  }
  // Your own pal, built on the dashboard (see src/custom.js).
  if (input.custom) out.custom = cleanCustom(input.custom);
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
  // Every integration is on unless switched off; Codex follows its own switch.
  config.agents = { ...Object.fromEntries(AGENT_IDS.map((id) => [id, true])), ...config.agents, codex: config.codex };
  return config;
}

/** Merge `patch` into the saved settings. Returns the full, effective config. */
export function saveConfig(patch) {
  let saved = {};
  try { saved = JSON.parse(readFileSync(file(), 'utf8')); } catch {}
  const before = clean(saved);
  const change = clean(patch);
  const next = { ...before, ...change };
  if (change.agents) next.agents = { ...before.agents, ...change.agents };
  mkdirSync(home(), { recursive: true });
  writeFileSync(file(), `${JSON.stringify(next, null, 2)}\n`);
  return loadConfig();
}

export const configPath = file;
