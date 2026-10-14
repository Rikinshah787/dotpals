// Settings, shared by the bridge, the pal and the desktop app: ~/.dotpals/config.json.
// Edited from the dashboard's Settings and Agents pages (or by hand). Environment
// variables still win: DOTPALS_HISTORY=0, DOTPALS_CODEX=0, DOTPALS_HOME=<folder>.
//
// The file can hold a TypeSafe API key (checker.jevKey, for double-checking unclear
// test results). It never leaves this module: loadConfig() returns only whether a key
// is set and its last 4 characters, and checkerKey() hands the key to bridge/checker.js.
// The file is written readable by you only (0600) where the system supports it.
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
  chat: false,          // talk to your agents from the pal (OpenCode for now; off unless you turn it on)
  greetOnStart: false,  // with chat on: the desktop pal starts small and asks what you're working on today
  palSize: 100,         // the pal's size in small mode, in percent (50–150)
  // Two agents, one file (bridge/guard.js): when an agent is about to change a file another
  // active session changed in the last `conflictMinutes`, 'ask' (Claude Code asks you first),
  // 'tell' (Claude is told to re-read the file) or 'off'. Other agents only get an alert.
  conflictGuard: 'ask',
  conflictMinutes: 10,
  // Make Claude Code fix failing tests (bridge/server.js, "the fix loop"): tell Claude when a
  // test run fails, and send it back once or twice if it tries to finish or commit while the
  // tests fail or weren't run after its last change. On unless you turn it off.
  fixLoop: true,
  // "It's stuck" (bridge/server.js, stuck() in bridge/ui/story.js): a ping when an agent keeps
  // failing at the same thing, or nothing has worked for 10 minutes. Any agent; on by default.
  stuckAlerts: true,
  // Restore points (bridge/ground.js): when a request starts and ends, save the working tree as
  // a git tree object (in the repository's own object store, no branch or ref), so the request
  // can be rewound from the dashboard. Off unless you turn it on.
  restorePoints: false,
  // The morning brief (bridge/ui/brief.js): the first time the pal opens each day, it says what
  // your agents did since yesterday, what's unfinished and what's failing. On by default.
  morningBrief: true,
  agents: {},           // per integration on/off, e.g. { cursor: false } (see bridge/adapters/index.js)
  custom: null,         // your own pal: { name, shape, eyes, top, color, fur }
  storyView: 'simple',  // how requests read by default: 'simple' (one sentence) or 'detailed' (the chapters)
  // Double-check unclear test results (bridge/checker.js): 'off', 'local' (Laya on this
  // computer) or 'cloud' (TypeSafe Jev, with an API key). Off unless you turn it on.
  // layaManaged: Laya was set up by dotpals (bridge/laya.js), which then starts and stops it.
  checker: { mode: 'off', localUrl: LAYA_URL, layaManaged: false, keySet: false, keyLast4: null, keyFrom: null },
  // Blu's brain (bridge/brain.js): the AI it thinks with. `choice`: 'auto' or a brain's id;
  // `models`: a model per brain, where you want another; `polish`: clean up dictation with it
  // 'always', 'auto' (always with a quick brain, with a subscription only when you correct
  // yourself) or 'off'; `dictionary`: words to spell your way (names, products).
  brain: { choice: 'auto', models: {}, polish: 'auto', dictionary: [] },
  // Its API keys, like the checker's: never handed out, only whether each is set and its last 4.
  // Also `spotify`: "client id:client secret" of your own Spotify app, so "play …" finds the exact track.
  brainKeys: {},
  // Blu, your screen buddy (bridge/buddy.js, desktop/hands.js). `see`: look at your screen when
  // you ask about it; `hands`: music, volume, windows and opening apps; `click`: clicking, typing
  // and pressing keys for you (off unless you turn it on); `music`: where "play …" plays;
  // `mode`: what Blu is for, 'developer' (your coding agents), 'everyday' (your computer) or 'both';
  // `hearing`: which Whisper listens (bridge/ui/voice.js HEARING: 'quick', 'better' or 'best');
  // `conversation`: after Blu answers, it listens for your next words.
  blu: { see: true, hands: true, click: false, music: 'youtube', mode: 'both', hearing: 'quick', conversation: true },
};

/** Blu's brains (bridge/brain.js), and the ones that take an API key. */
export const BRAIN_IDS = ['ollama', 'anthropic', 'openai', 'google', 'openrouter', 'claude', 'codex', 'gemini', 'cursor'];
export const KEY_BRAINS = ['anthropic', 'openai', 'google', 'openrouter'];
const KEY_IDS = [...KEY_BRAINS, 'spotify'];

/** Integrations that can be switched off in `agents` (ids from bridge/adapters/index.js). */
export const AGENT_IDS = ['claude', 'codex', 'cursor', 'gemini', 'opencode', 'copilot', 'generic'];

const CHARACTERS = ['blu', 'hop', 'sunny', 'lovi', 'muse', 'grok', 'nova', 'byte', 'webby', 'custom'];

/** Keep only known settings with sensible values. */
function clean(input = {}) {
  const out = {};
  for (const key of ['sounds', 'notifications', 'history', 'codex', 'approvals', 'shareRecap', 'chat', 'greetOnStart', 'fixLoop', 'stuckAlerts', 'restorePoints', 'morningBrief']) if (typeof input[key] === 'boolean') out[key] = input[key];
  const wait = Number(input.approvalWait);
  if (Number.isInteger(wait) && wait >= 10 && wait <= 120) out.approvalWait = wait;
  const size = Number(input.palSize);
  if (Number.isInteger(size) && size >= 50 && size <= 150) out.palSize = size;
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
  // Talk to Blu's and Dictate's shortcuts, as Electron writes one ("CommandOrControl+Alt+T").
  const shortcut = /^(?:(?:CommandOrControl|CmdOrCtrl|Control|Ctrl|Command|Cmd|Alt|Option|AltGr|Shift|Super|Meta)\+){1,3}(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|Space)$/i;
  // An empty one goes back to the usual shortcut.
  for (const key of ['talkShortcut', 'dictateShortcut', 'circleShortcut']) if (typeof input[key] === 'string' && (input[key] === '' || shortcut.test(input[key]))) out[key] = input[key];
  if (input.blu && typeof input.blu === 'object' && !Array.isArray(input.blu)) {
    const b = input.blu, blu = {};
    for (const key of ['see', 'hands', 'click', 'conversation']) if (typeof b[key] === 'boolean') blu[key] = b[key];
    if (['youtube', 'youtubemusic', 'spotify', 'applemusic'].includes(b.music)) blu.music = b.music;
    if (['developer', 'everyday', 'both'].includes(b.mode)) blu.mode = b.mode;
    if (['quick', 'better', 'best'].includes(b.hearing)) blu.hearing = b.hearing;
    out.blu = blu;
  }
  // Blu's brain: only the parts given (a change to one keeps the rest, see saveConfig).
  if (input.brain && typeof input.brain === 'object' && !Array.isArray(input.brain)) {
    const b = input.brain, brain = {};
    if (b.choice === 'auto' || BRAIN_IDS.includes(b.choice)) brain.choice = b.choice;
    if (['auto', 'always', 'off'].includes(b.polish)) brain.polish = b.polish;
    if (b.models && typeof b.models === 'object' && !Array.isArray(b.models)) {
      brain.models = {};
      for (const id of BRAIN_IDS) if (typeof b.models[id] === 'string' && /^[\w.:/@-]{0,100}$/.test(b.models[id].trim())) brain.models[id] = b.models[id].trim();
    }
    if (Array.isArray(b.dictionary)) brain.dictionary = [...new Set(b.dictionary.map((w) => String(w).trim().slice(0, 40)).filter(Boolean))].slice(0, 100);
    out.brain = brain;
  }
  return out;
}

/** The brains' API keys as stored, patched: a new key sets it, null or '' removes it. */
function cleanBrainKeys(input, before = {}) {
  const out = {};
  for (const id of KEY_IDS) if (validKey(before[id])) out[id] = validKey(before[id]);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const id of KEY_IDS) {
    if (input[id] === null || input[id] === '') delete out[id];
    else if (validKey(input[id])) out[id] = validKey(input[id]);
  }
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
  // Blu's brain, with each part filled in; its keys only as their last 4 characters.
  config.brain = { ...DEFAULTS.brain, ...config.brain, models: { ...config.brain?.models } };
  config.blu = { ...DEFAULTS.blu, ...config.blu };
  config.brainKeys = Object.fromEntries(Object.entries(cleanBrainKeys({}, saved.brainKeys)).map(([id, k]) => [id, k.slice(-4)]));
  return config;
}

/** Blu's brains' API keys: { anthropic: 'sk-…', … }. Only for bridge/brain.js, through the bridge. */
export function brainKeys() {
  return cleanBrainKeys({}, readSaved().brainKeys);
}

/** Merge `patch` into the saved settings. Returns the full, effective config. */
export function saveConfig(patch) {
  const saved = readSaved();
  const before = clean(saved);
  const change = clean(patch);
  const next = { ...before, ...change };
  if (change.agents) next.agents = { ...before.agents, ...change.agents };
  if (change.brain) next.brain = { ...before.brain, ...change.brain, models: { ...before.brain?.models, ...change.brain.models } };
  if (change.blu) next.blu = { ...before.blu, ...change.blu };
  const checker = cleanChecker(patch?.checker, cleanChecker(saved.checker));
  if (Object.keys(checker).length) next.checker = checker;
  const keys = cleanBrainKeys(patch?.brainKeys, saved.brainKeys);
  if (Object.keys(keys).length) next.brainKeys = keys; else delete next.brainKeys;
  mkdirSync(home(), { recursive: true });
  // Readable by you only, since it may hold an API key (POSIX; Windows keeps the
  // folder's own permissions, which are per user in your home folder).
  writeFileSync(file(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  if (platform() !== 'win32') { try { chmodSync(file(), 0o600); } catch {} }
  return loadConfig();
}

export const configPath = file;
