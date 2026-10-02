// Double-check unclear test results (optional, off by default; Settings → "Double-check
// unclear test results"). When the plain rules in ui/story.js can't tell whether a test
// run passed (no summary in the output, an "ok" exit with a Traceback in it, a "failed"
// exit with clean output), the bridge asks a yes/no question about the evidence once:
//
//   local   Laya (by Convai Innovations) on this computer: `laya-serve` answers the same
//           POST /v1/systemone format as Jev, at http://127.0.0.1:8000 by default.
//           Nothing leaves your computer. Settings → Set up Laya (or `dotpals laya`) installs
//           and runs it for you (bridge/laya.js); it never installs Python itself.
//   cloud   TypeSafe's Jev, with your API key, through the official SDK
//           (@typesafe-ai/sdk, an optional dependency loaded only in this mode).
//
// The question, its thresholds and the redaction come from claude-referee by Ismail
// Dasci, MIT (see THIRD_PARTY_NOTICES):
//   https://github.com/ismaildasci/claude-referee/blob/main/npm/packs/generic/questions/done.json
//   https://github.com/ismaildasci/claude-referee/blob/main/npm/packs/generic/thresholds.json
//   https://github.com/ismaildasci/claude-referee/blob/main/src/engine/client.ts
//   https://github.com/ismaildasci/claude-referee/blob/main/src/engine/config.ts
//
// What's sent: the facts parsed from the output (ui/testout.js), the exit status, the
// command, the end of the output and the lines that look like failures, a few KB at
// most, always after redact.js. It fails open: an error or no answer within the budget
// (5 s) changes nothing except a "couldn't check" note. The API key is only ever passed
// to the SDK; it's never logged, stored on an entry or sent to a viewer.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { home } from './config.js';
import { parseTestOutput } from './ui/testout.js';
import { testVerdict } from './ui/story.js';
import { redact } from './redact.js';

/** Jev's model, as claude-referee's DEFAULT_MODEL. */
export const JEV_MODEL = 'jev-1.13.0';
/** P(the tests pass) at or above `passed` → passed; at or below `failed` → failed; between → still unclear. */
export const THRESHOLDS = { passed: 0.7, failed: 0.3 };
export const BUDGET_MS = 5000;

/** claude-referee's done.met question, asked about the tests passing. */
export const QUESTIONS = {
  'done.met': {
    type: 'noul',
    instructions: {
      question: 'Does `evidence` show that the tests pass?',
      note: '`evidence` holds facts parsed from the test command\'s output (runner, passed, failed, errors, skipped, failing test names) or null when no summary was found, its exit status, the end of the output and the lines that look like failures. A claim of success in prose is not evidence. Zero tests, only skipped tests, a missing summary or a missing exit code do not show that tests pass.',
    },
    criteria: {
      true: 'The test output directly shows that the tests pass.',
      false: 'The output does not show it, or shows that they fail.',
    },
  },
};

const FAILURE_LINE = /\bFAIL(?:ED|URE)?\b|\bfailing\b|Traceback \(most recent call last\)|\bpanicked\b|\b\w*Error:|^\s*[✕✖×]\s|^not ok\b|\bexit (?:code|status)\b/;
const TAIL = 1500;

/** What the checker is shown about a test run, already redacted. */
export function evidenceOf(e, { secrets = [] } = {}) {
  const output = `${e.body?.output ?? ''}\n${e.error ?? ''}`.trim();
  const facts = parseTestOutput(output);
  const lines = output.split('\n');
  const evidence = {
    command: String(e.body?.command ?? e.detail ?? e.title ?? '').slice(0, 300),
    exit_status: e.status === 'failed' ? 'failed' : e.status === 'ok' ? 'ok' : 'did not finish',
    parsed: facts.parsed ? { runner: facts.runner, passed: facts.passed, failed: facts.failed, errors: facts.errors, skipped: facts.skipped, failing: facts.failing } : null,
    failure_lines: lines.filter((l) => FAILURE_LINE.test(l)).slice(-12).map((l) => l.trim().slice(0, 200)),
    output_end: output.length > TAIL ? `…${output.slice(-TAIL)}` : output,
  };
  return redact(evidence, { home: homedir(), secrets }).value;
}

/** Whether a finished test run is worth asking about: unclear, and not just "no tests ran" (that never counts as a pass). */
export function shouldCheck(e) {
  if (e?.kind !== 'run' || e.check || !['ok', 'failed', 'stopped'].includes(e.status)) return false;
  const v = testVerdict(e);
  return v.state === 'unclear' && v.reason !== 'no-tests';
}

/** A probability (that the tests pass) to a state. */
export const stateOf = (p) => (p >= THRESHOLDS.passed ? 'passed' : p <= THRESHOLDS.failed ? 'failed' : 'unclear');

// -- talking to the checkers ---------------------------------------------------------

/** Laya's own server (`laya-serve`): POST /v1/systemone, Jev's format. */
async function askLaya({ url, state, questions, signal }) {
  const res = await fetch(`${url.replace(/\/+$/, '')}/v1/systemone`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state, questions }), signal,
  });
  if (!res.ok) throw Object.assign(new Error(`Laya answered ${res.status}`), { status: res.status });
  const data = await res.json();
  return { p: data?.answers?.['done.met']?.noul, model: typeof data?.model === 'string' ? data.model : undefined };
}

/** Laya's health check: GET /health. */
async function pingLaya({ url, signal }) {
  const res = await fetch(`${url.replace(/\/+$/, '')}/health`, { signal });
  if (!res.ok) throw Object.assign(new Error(`Laya answered ${res.status}`), { status: res.status });
  const data = await res.json().catch(() => ({}));
  return { model: Array.isArray(data?.loaded) && data.loaded.length ? data.loaded.join(', ') : undefined };
}

let sdk = null;
/** The folder dotpals runs from (an install in ~/.dotpals/app, or a clone): where the SDK goes. */
export const APP_DIR = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');

/**
 * Install the SDK into the folder dotpals runs from, for "Install it" next to Test
 * connection (setup normally does this; a clone or an offline setup may not have it).
 * A fixed command, no user input: npm install @typesafe-ai/sdk, without touching
 * package.json. Resolves { ok, error? }.
 */
export function installSdk(options = {}) {
  return installPackage('@typesafe-ai/sdk@^0.6.0', options).then((r) => { sdk = null; return r; }); // then try loading it again
}

/**
 * npm install one package (a fixed spec from dotpals' own code, never user input) into the
 * folder dotpals runs from, without touching package.json. Resolves { ok, error? }.
 */
export function installPackage(spec, { run = spawnNpm, dir = sdkHome(), timeoutMs = 120_000 } = {}) {
  return run(['install', '--no-save', '--no-audit', '--no-fund', '--no-package-lock', spec], { cwd: dir, timeoutMs })
    .then((r) => (r.code === 0 ? { ok: true } : { ok: false, error: /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network/i.test(r.output) ? 'npm couldn’t reach the internet' : 'npm couldn’t install it' }));
}
function spawnNpm(args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    // On Windows npm is a .cmd script, which Node only runs through a shell; the arguments are fixed above.
    const child = process.platform === 'win32'
      // Quoted where cmd would read a character itself: ^ is its escape character, so an
      // unquoted "@typesafe-ai/sdk@^0.6.0" would install exactly 0.6.0.
      ? spawn(['npm', ...args.map((a) => (/[\^&|<>%!\s]/.test(a) ? `"${a}"` : a))].join(' '), { cwd, shell: true, windowsHide: true })
      : spawn('npm', args, { cwd, windowsHide: true });
    let output = '';
    const keep = (d) => { output = (output + d).slice(-4000); };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, output }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

/** @typesafe-ai/sdk, loaded the first time cloud mode needs it. */
async function typesafe() {
  sdk ??= loadSdk().catch((err) => { sdk = null; throw Object.assign(new Error('sdk missing'), { code: 'SDK_MISSING', cause: err }); });
  return sdk;
}
/**
 * The SDK from wherever it is: next to this copy of dotpals, or in the installed copy
 * (~/.dotpals/app, where setup and "Install it" put it). A Claude Code plugin's folder,
 * or a clone, may run without it.
 */
async function loadSdk() {
  try { return await import('@typesafe-ai/sdk'); } catch (err) {
    for (const dir of sdkDirs()) {
      try { return await import(pathToFileURL(createRequire(join(dir, 'package.json')).resolve('@typesafe-ai/sdk')).href); } catch {}
    }
    throw err;
  }
}
/** Where the SDK can live: this copy, then the installed one. */
const sdkDirs = () => [...new Set([APP_DIR, join(home(), 'app')])];
/** Where "Install it" puts the SDK: the installed copy when there is one, so updates of a plugin's folder don't lose it. */
const sdkHome = () => (existsSync(join(home(), 'app', 'package.json')) ? join(home(), 'app') : APP_DIR);
const jevClient = async (key) => {
  const { TypeSafeClient } = await typesafe();
  // No logging (it could print request details), no SDK retries: one try within the budget.
  return new TypeSafeClient({ apiKey: key, logLevel: 'off', timeout: BUDGET_MS, retry: { maxRetries: 0 } });
};

/** TypeSafe Jev, through the official SDK. */
async function askJev({ key, state, questions, signal }) {
  const client = await jevClient(key);
  const { data } = await client.systemOne({ state, questions, model: JEV_MODEL }, { signal }).withResponse();
  return { p: data?.answers?.['done.met']?.noul, model: data?.model, inputTokens: data?.usage?.input_tokens };
}

/** A free request that proves the key works: the list of models. */
async function pingJev({ key, signal }) {
  const client = await jevClient(key);
  await client.models.list({ signal });
  return { model: JEV_MODEL };
}

export const TRANSPORTS = { laya: { ask: askLaya, ping: pingLaya }, jev: { ask: askJev, ping: pingJev } };

/** A short, safe reason for a failed call. Never the raw error text, which could echo a request. */
function reason(err, by, timedOut) {
  if (timedOut || err?.name === 'TimeoutError' || err?.name === 'APITimeoutError' || err?.name === 'AbortError') return `no answer within ${BUDGET_MS / 1000} s`;
  if (err?.code === 'SDK_MISSING') return 'the TypeSafe SDK isn’t installed where dotpals runs';
  if (err?.code === 'NO_KEY') return 'no API key: add one in Settings, or set TYPESAFE_API_KEY';
  const status = err?.status ?? err?.statusCode;
  if (status === 401 || status === 403 || err?.name === 'AuthenticationError' || err?.name === 'PermissionDeniedError') return by === 'jev' ? 'TypeSafe didn’t accept the API key' : 'Laya wants a key (LAYA_API_KEY): run it without one on this computer';
  if (status === 429 || err?.name === 'RateLimitError') return 'too many requests right now';
  if (status) return `${by === 'jev' ? 'TypeSafe' : 'Laya'} answered with an error (${status})`;
  if (err?.name === 'APIConnectionError' || err?.cause?.code === 'ECONNREFUSED' || err instanceof TypeError) return by === 'jev' ? 'couldn’t reach TypeSafe' : 'couldn’t reach Laya: is `laya-serve` running?';
  if (err?.message === 'bad answer') return `${by === 'jev' ? 'Jev' : 'Laya'} gave no probability`;
  return 'something went wrong';
}

/**
 * The checker, for the bridge:
 *   check(entry)  → Promise<{ by, state, p, ms, model? } | { by, error } | null>   (null: off, or not worth asking)
 *   test(mode?)   → Promise<{ ok, by, ms, model?, error? }>   one tiny request, for "Test connection"
 * `getConfig()` returns the settings (config.checker), `getKey()` the TypeSafe key.
 * Answers are cached by the evidence, so the same output is never asked about twice.
 */
export function createChecker({ getConfig, getKey, transports = TRANSPORTS, budgetMs = BUDGET_MS, cacheSize = 200 } = {}) {
  const cache = new Map(); // hash of (who, evidence) → answer
  const inFlight = new Map(); // entry id → promise

  const target = (mode) => (mode === 'local' ? 'laya' : mode === 'cloud' ? 'jev' : null);

  /** Run fn with a budget; rejects with { timedOut } when it runs out. */
  async function within(fn) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, fail) => { timer = setTimeout(() => { controller.abort(); fail(Object.assign(new Error('timeout'), { timedOut: true })); }, budgetMs); });
    try { return await Promise.race([fn(controller.signal), timeout]); } finally { clearTimeout(timer); }
  }

  function args(by, signal) {
    const config = getConfig().checker ?? {};
    if (by === 'laya') return { url: config.localUrl, signal };
    const key = getKey();
    if (!key) throw Object.assign(new Error('no key'), { code: 'NO_KEY' });
    return { key, signal };
  }

  async function ask(entry, by) {
    const key = by === 'jev' ? getKey() : null;
    const state = { evidence: evidenceOf(entry, { secrets: key ? [key] : [] }) };
    const hash = createHash('sha256').update(`${by}\n${JSON.stringify(state)}`).digest('hex');
    if (cache.has(hash)) return { ...cache.get(hash) };
    const started = Date.now();
    try {
      const reply = await within((signal) => transports[by].ask({ ...args(by, signal), state, questions: QUESTIONS }));
      const p = Number(reply?.p);
      if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error('bad answer');
      const answer = { by, state: stateOf(p), p: Math.round(p * 1000) / 1000, ms: Date.now() - started, ...(reply.model ? { model: String(reply.model).slice(0, 60) } : {}) };
      cache.set(hash, answer);
      if (cache.size > cacheSize) cache.delete(cache.keys().next().value);
      return answer;
    } catch (err) {
      return { by, error: reason(err, by, err?.timedOut), ms: Date.now() - started };
    }
  }

  return {
    check(entry) {
      const by = target(getConfig().checker?.mode);
      if (!by || !shouldCheck(entry)) return Promise.resolve(null);
      if (inFlight.has(entry.id)) return inFlight.get(entry.id);
      const p = ask(entry, by).finally(() => inFlight.delete(entry.id));
      inFlight.set(entry.id, p);
      return p;
    },
    async test(mode = getConfig().checker?.mode) {
      const by = target(mode);
      if (!by) return { ok: false, error: 'The checker is off' };
      const started = Date.now();
      try {
        const reply = await within((signal) => transports[by].ping(args(by, signal)));
        return { ok: true, by, ms: Date.now() - started, ...(reply?.model ? { model: String(reply.model).slice(0, 80) } : {}) };
      } catch (err) {
        return { ok: false, by, ms: Date.now() - started, error: reason(err, by, err?.timedOut), ...(err?.code === 'SDK_MISSING' ? { fix: 'install-sdk' } : {}) };
      }
    },
  };
}
