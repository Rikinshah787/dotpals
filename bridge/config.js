// Settings, shared by the bridge, the pal and the desktop app: ~/.dotpals/config.json.
// Edited from the dashboard's Settings and Agents pages (or by hand). Environment
// variables still win: DOTPALS_HISTORY=0, DOTPALS_CODEX=0, DOTPALS_HOME=<folder>.
//
// The file can hold a TypeSafe API key (checker.jevKey, for double-checking unclear
// test results). It never leaves this module: loadConfig() returns only whether a key
// is set and its last 4 characters, and checkerKey() hands the key to bridge/checker.js.
// The file is written readable by you only (0600) where the system supports it.
//
// It can also hold a Sentry DSN (sentry.dsn, set with `dotpals sentry <dsn>`), which turns
// on error and performance tracing for your copy (bridge/tracing.js). The pages only see
// whether it's on.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { cleanCustom } from '../src/custom.js';

export const home = () => process.env.DOTPALS_HOME || join(homedir(), '.dotpals');
const file = () => join(home(), 'config.json');

/** Where Laya's server listens by default (`laya-serve`: port 8000). */
export const LAYA_URL = 'http://127.0.0.1:8000';
const CHECKER_MODES = ['off', 'local', 'cloud'];

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
  // Two agents, one file (bridge/guard.js): when an agent is about to change a file another
  // active session changed in the last `conflictMinutes`, 'ask' (Claude Code asks you first),
  // 'tell' (Claude is told to re-read the file) or 'off'. Other agents only get an alert.
  conflictGuard: 'ask',
  conflictMinutes: 10,
  agents: {},           // per integration on/off, e.g. { cursor: false } (see bridge/adapters/index.js)
  custom: null,         // your own pal: { name, shape, eyes, top, color, fur }
  storyView: 'simple',  // how requests read by default: 'simple' (one sentence) or 'detailed' (the chapters)
  // Double-check unclear test results (bridge/checker.js): 'off', 'local' (Laya on this
  // computer) or 'cloud' (TypeSafe Jev, with an API key). Off unless you turn it on.
  // layaManaged: Laya was set up by dotpals (bridge/laya.js), which then starts and stops it.
  checker: { mode: 'off', localUrl: LAYA_URL, layaManaged: false, keySet: false, keyLast4: null, keyFrom: null },
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
  if (input.storyView === 'simple' || input.storyView === 'detailed') out.storyView = input.storyView;
  if (['ask', 'tell', 'off'].includes(input.conflictGuard)) out.conflictGuard = input.conflictGuard;
  const minutes = Number(input.conflictMinutes);
  if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 60) out.conflictMinutes = minutes;
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

/** A TypeSafe API key as pasted: printable ASCII, no spaces. Returns it trimmed, or null. */
export function validKey(key) {
  const k = String(key ?? '').trim();
  return /^[\x21-\x7e]{8,512}$/.test(k) ? k : null;
}

/** Laya's address: only this computer, so "local" never sends test output anywhere else. */
function localUrl(value) {
  try {
    const url = new URL(String(value));
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || !/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(url.hostname)) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch { return null; }
}

/**
 * The checker settings as stored: { mode?, localUrl?, layaManaged?, jevKey? }. A patch can
 * set the mode, the address, whether dotpals runs Laya, or a new key; an empty key keeps
 * the saved one, `removeKey: true` clears it.
 */
function cleanChecker(input, before = {}) {
  const out = { ...before };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  if (CHECKER_MODES.includes(input.mode)) out.mode = input.mode;
  if (input.localUrl !== undefined && localUrl(input.localUrl)) out.localUrl = localUrl(input.localUrl);
  if (typeof input.layaManaged === 'boolean') out.layaManaged = input.layaManaged;
  if (typeof input.jevKey === 'string' && validKey(input.jevKey)) out.jevKey = validKey(input.jevKey);
  if (input.removeKey === true) delete out.jevKey;
  return out;
}

/** A Sentry DSN as pasted (https://<key>@<host>/<project id>), or null. */
export function validDsn(dsn) {
  try {
    const url = new URL(String(dsn ?? '').trim());
    return /^https?:$/.test(url.protocol) && url.username && /^\/(.+\/)?\d+$/.test(url.pathname) ? url.href.replace(/\/$/, '') : null;
  } catch { return null; }
}
/** How many requests get a span: 0.01 to 1. */
const validRate = (rate) => { const n = Number(rate); return Number.isFinite(n) && n >= 0.01 && n <= 1 ? n : null; };
export const SENTRY_RATE = 0.2;

function cleanSentry(input, before = {}) {
  const out = { ...before };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  if (validDsn(input.dsn)) out.dsn = validDsn(input.dsn);
  if (validRate(input.tracesSampleRate) !== null) out.tracesSampleRate = validRate(input.tracesSampleRate);
  if (input.off === true) { delete out.dsn; delete out.tracesSampleRate; }
  return out;
}

/** Sentry's settings, for bridge/tracing.js only: { dsn, tracesSampleRate }. DOTPALS_SENTRY_DSN wins. */
export function sentrySettings() {
  const saved = cleanSentry(readSaved().sentry);
  return { dsn: validDsn(process.env.DOTPALS_SENTRY_DSN) ?? saved.dsn ?? null, tracesSampleRate: saved.tracesSampleRate ?? SENTRY_RATE };
}

const readSaved = () => { try { return JSON.parse(readFileSync(file(), 'utf8')) ?? {}; } catch { return {}; } };

/** The TypeSafe API key: the one saved from the dashboard, else TYPESAFE_API_KEY. Only for bridge/checker.js. */
export function checkerKey() {
  return cleanChecker(readSaved().checker).jevKey ?? validKey(process.env.TYPESAFE_API_KEY);
}

export function loadConfig() {
  const saved = readSaved();
  const config = { ...DEFAULTS, ...clean(saved) };
  if (process.env.DOTPALS_HISTORY === '0') config.history = false;
  if (process.env.DOTPALS_CODEX === '0') config.codex = false;
  // Every integration is on unless switched off; Codex follows its own switch.
  config.agents = { ...Object.fromEntries(AGENT_IDS.map((id) => [id, true])), ...config.agents, codex: config.codex };
  // The checker, without its key: only whether one is set, where from, and its last 4 characters.
  const checker = cleanChecker(saved.checker);
  const key = checker.jevKey ?? validKey(process.env.TYPESAFE_API_KEY);
  config.checker = {
    mode: checker.mode ?? DEFAULTS.checker.mode,
    localUrl: checker.localUrl ?? LAYA_URL,
    layaManaged: checker.layaManaged === true,
    keySet: !!key,
    keyLast4: key ? key.slice(-4) : null,
    keyFrom: checker.jevKey ? 'settings' : key ? 'env' : null,
  };
  // Tracing, without the DSN: only whether it's on.
  const sentry = sentrySettings();
  config.sentry = { on: !!sentry.dsn, tracesSampleRate: sentry.tracesSampleRate };
  return config;
}

/** Merge `patch` into the saved settings. Returns the full, effective config. */
export function saveConfig(patch) {
  const saved = readSaved();
  const before = clean(saved);
  const change = clean(patch);
  const next = { ...before, ...change };
  if (change.agents) next.agents = { ...before.agents, ...change.agents };
  const checker = cleanChecker(patch?.checker, cleanChecker(saved.checker));
  if (Object.keys(checker).length) next.checker = checker;
  // Sentry is set only by saveSentry (`dotpals sentry`), never by a page: kept as saved.
  const sentry = cleanSentry(saved.sentry);
  if (Object.keys(sentry).length) next.sentry = sentry;
  write(next);
  return loadConfig();
}

/** Turn Sentry tracing on ({ dsn, tracesSampleRate }) or off ({ off: true }). For `dotpals sentry` only. */
export function saveSentry(input) {
  const saved = readSaved();
  const next = { ...saved, sentry: cleanSentry(input, cleanSentry(saved.sentry)) };
  if (!Object.keys(next.sentry).length) delete next.sentry;
  write(next);
  return sentrySettings();
}

function write(next) {
  mkdirSync(home(), { recursive: true });
  // Readable by you only, since it may hold an API key (POSIX; Windows keeps the
  // folder's own permissions, which are per user in your home folder).
  writeFileSync(file(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  if (platform() !== 'win32') { try { chmodSync(file(), 0o600); } catch {} }
}

export const configPath = file;
