#!/usr/bin/env node
// Turn real requests into accuracy cases (test/accuracy/cases), for `npm run accuracy`.
//
//   node scripts/accuracy-capture.mjs [--project Dot] [--since 2026-09-28] [--session <id prefix>] [--out <dir>]
//
// Reads the activity of the dotpals running on this computer, keeps the requests where
// dotpals makes a claim worth checking (a test result, a risky step, a retry, "ready to
// merge?", tests changed to pass), and writes one JSON file per request. Each claim is
// pre-filled with what dotpals says today and marked `"labeled": false`: a person checks
// each one against what really happened, fixes the wrong ones, and sets `"labeled": true`.
// Only labeled cases count.
//
// Only sessions in one project (--project: a folder name; this repository's by default),
// so work in your other projects never ends up here. Prompts aren't kept, only the end of
// the agent's last message (why it stopped reads it). The cases are meant to be committed,
// so they're cleaned first: your home folder becomes
// "~", anything shaped like a credential, email or IP address is replaced (bridge/redact.js),
// and so are UUIDs, long hex tokens and your user name. Read a case before committing it anyway.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactText } from '../bridge/redact.js';
import { buildTurns } from '../bridge/ui/recap.js';
import { stepType } from '../bridge/ui/story.js';
import { claimsOf } from '../test/accuracy/claims.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const since = opt('--since') ? new Date(opt('--since')).getTime() : 0;
const only = opt('--session');
const project = opt('--project') ?? basename(fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, ''));
const out = opt('--out') ?? fileURLToPath(new URL('../test/accuracy/cases', import.meta.url));
const port = process.env.DOTPALS_PORT || 5175;

const secrets = (() => {
  try { const k = JSON.parse(readFileSync(join(process.env.DOTPALS_HOME || join(homedir(), '.dotpals'), 'config.json'), 'utf8')).checker?.jevKey; return k ? [k] : []; } catch { return []; }
})();
const clean = (s, n) => {
  if (s === undefined || s === null) return undefined;
  // Git Bash spells the home folder /c/Users/<name>.
  const msys = homedir().replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
  let t = redactText(String(s).split(msys).join('~'), { home: homedir(), secrets }).text
    // UUIDs, and parts of one (a key's first groups, typed into a grep): they may be keys.
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}(?:-[0-9a-f]{4}){0,3}(?:-[0-9a-f]{12})?\b/gi, '00000000-0000')
    .replace(/\b[0-9a-f]{32,}\b/gi, '<hex>')
    // Your user name on its own, as `ls -l` prints it.
    .replace(/[\w.-]+/g, (w) => (w === basename(homedir()) ? '<user>' : w));
  if (n && t.length > n) t = `${t.slice(0, n / 2)}\n…\n${t.slice(-n / 2)}`;
  return t;
};

/** A step with only what the rules read, cleaned. */
function slim(e, ids) {
  const id = ids.get(e.id) ?? `e${ids.size + 1}`;
  ids.set(e.id, id);
  const s = { id, kind: e.kind, tool: e.tool, title: clean(e.title, 300), status: e.status, at: e.at };
  if (e.ms !== undefined) s.ms = e.ms;
  // Only what the rules read: a test run's output (its verdict), every command (risky
  // steps, retries), an edit's patch (tests changed to pass); nothing else's output.
  const test = e.kind === 'run' && stepType(e) === 'test';
  if (e.error) s.error = clean(e.error, test ? 1000 : 200);
  if (e.files?.length) s.files = e.files.map((f) => ({ path: clean(f.path), change: f.change }));
  if (e.kind === 'run' && (e.body?.command || e.body?.output)) s.body = { command: clean(e.body.command, 1500), ...(test ? { output: clean(e.body.output, 3000) } : {}) };
  if (e.kind === 'edit' && e.body?.patch) s.body = { patch: clean(e.body.patch, 8000) };
  if (e.summary) s.summary = clean(String(e.summary).slice(-240));
  if (e.git) s.git = JSON.parse(clean(JSON.stringify(e.git)));
  return s;
}

const body = await (await fetch(`http://127.0.0.1:${port}/api/activity`)).json();
const all = Array.isArray(body) ? body : body.entries ?? [];
// Whole sessions in the project, so no request loses a step.
const inProject = new Set(all.filter((e) => String(e.label ?? '').toLowerCase() === project.toLowerCase()).map((e) => e.session));
const entries = all.filter((e) => e.at >= since && inProject.has(e.session) && (!only || String(e.session).startsWith(only)));
const turns = buildTurns(entries).filter((t) => t.end && t.prompt);
mkdirSync(out, { recursive: true });
let written = 0;
for (const t of turns) {
  const ids = new Map();
  const turn = { harness: t.harness, prompt: { ...slim(t.prompt, ids), title: '(not kept)' }, steps: t.steps.map((e) => slim(e, ids)), end: slim(t.end, ids) };
  const claims = claimsOf(turn);
  if (!Object.keys(claims.tests).length && !claims.risky.length && !Object.keys(claims.retries).length && claims.ready === null && !claims.weakened) continue;
  const name = `${new Date(t.at).toISOString().slice(0, 10)}-${t.harness}-${String(t.session).slice(0, 4)}-${t.at % 100000}`;
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify({ name, source: 'real', labeled: false, note: '', truth: claims, turn }, null, 1)}\n`);
  written++;
}
console.log(`${written} cases written to ${out} (of ${turns.length} finished requests). Check each claim, then set "labeled": true.`);
