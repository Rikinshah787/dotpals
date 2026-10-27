// Project rules: a `.dotpals.json` in a project, with rules every request there is held to,
// whichever agent makes it. Talk to Blu's "definition of done" (bridge/tasks.js), written once
// for the project instead of per task:
//
//   {
//     "mustNotTouch": ["migrations", "src/legacy/**", "*.lock"],
//     "onlyTouch": ["src", "test"],
//     "mustPass": ["npm test", "npm run lint"],
//     "noNewDependencies": true,
//     "beforeEdit": "ask"
//   }
//
// (or the same under "rules"). Paths are relative to the file's folder: a plain path is that
// file or folder and everything in it; `*` is any name, `**` any number of folders, `?` one
// character. When a request ends, its changes (tools, commands and what git saw) are checked
// against the rules, and what it broke goes on its `done` entry as `rules`, so "Ready to merge?",
// the cards and the MCP tools say so. Claude Code is also stopped before an edit a rule
// forbids (`beforeEdit`: "ask" asks you, "tell" refuses and tells Claude why, "off").
//
// The file is found from the session's folder up to its repository's root (the nearest one
// wins, so a monorepo's package can have its own). Read only: dotpals never writes it.
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { noNewDeps, relativeTo, tidyPath, under } from './tasks.js';
import { commandEdits, gitTruth, ranAfterLastChange } from './ui/story.js';

export const RULES_FILE = '.dotpals.json';
const MAX = 64 * 1024;   // a rules file bigger than this isn't one
const LIST = 50;         // paths or commands per rule
const MODES = ['ask', 'tell', 'off'];

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
/** A command that must pass: one line, at most 200 characters, no backticks (only ever matched, never run). */
const tidyCommand = (c) => { const s = typeof c === 'string' ? c.trim() : ''; return s.length <= 200 && !/[\r\n`]/.test(s) ? s : ''; };

/**
 * The rules in a parsed `.dotpals.json`: { mustNotTouch, onlyTouch, mustPass, noNewDependencies,
 * beforeEdit }. Anything else is ignored; a value of the wrong kind is dropped. Throws when it
 * isn't an object at all.
 */
export function parseRules(json) {
  const top = json && typeof json === 'object' && !Array.isArray(json) ? json : null;
  const r = top?.rules && typeof top.rules === 'object' && !Array.isArray(top.rules) ? top.rules : top;
  if (!r) throw new Error('it should be an object of rules');
  const list = (a, tidy) => [...new Set((Array.isArray(a) ? a : []).filter((x) => typeof x === 'string').map(tidy).filter(Boolean))].slice(0, LIST);
  return {
    mustNotTouch: list(r.mustNotTouch, tidyPath),
    onlyTouch: list(r.onlyTouch, tidyPath),
    mustPass: list(r.mustPass, tidyCommand),
    noNewDependencies: r.noNewDependencies === true,
    beforeEdit: MODES.includes(r.beforeEdit) ? r.beforeEdit : 'ask',
  };
}

const CI = process.platform !== 'linux';
const globs = new Map(); // pattern → RegExp
/**
 * Whether `file` (relative to the rules' folder, forward slashes) matches a rule's path: a
 * plain path is that file or folder and everything in it; `*` any name, `**` any folders, `?`
 * one character (a match is a folder's too: `src/*` covers `src/a/b.js`).
 */
export function matches(file, pattern) {
  if (!/[*?]/.test(pattern)) return under(file, pattern);
  let re = globs.get(pattern);
  if (!re) {
    const body = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\/|\*\*|\*|\?/g, (m) => (m === '**/' ? '(?:.*/)?' : m === '**' ? '.*' : m === '*' ? '[^/]*' : '[^/]'));
    re = new RegExp(`^${body}(?:/.*)?$`, CI ? 'i' : '');
    globs.set(pattern, re);
    if (globs.size > 500) globs.delete(globs.keys().next().value);
  }
  return re.test(file);
}

/** The rule a change to `file` breaks before it's made, in words ("not to touch: migrations"), or null. */
export function forbids(rules, file) {
  if (!rules || rules.error || !file) return null;
  const not = rules.mustNotTouch.find((p) => matches(file, p));
  if (not) return `not to touch: ${not}`;
  if (rules.onlyTouch.length && !rules.onlyTouch.some((p) => matches(file, p)) && file !== RULES_FILE) return `only change ${rules.onlyTouch.join(' or ')}`;
  return null;
}

const cache = new Map(); // file → { mtimeMs, size, rules }

/**
 * The rules for a session working in `cwd`: the nearest `.dotpals.json` from there up to the
 * repository's root (a folder with `.git`), as { file, dir, ...parseRules } or { file, dir,
 * error } when it can't be read (too big, not JSON): a broken rules file is said, never taken
 * for "no rules". null when there's none. Cached until the file changes.
 */
export async function findRules(cwd, { statFile = stat, read = readFile } = {}) {
  if (!cwd || typeof cwd !== 'string') return null;
  const isRoot = async (d) => !!(await statFile(join(d, '.git')).catch(() => null)); // .git is a folder, or a file in a worktree
  // Up to the repository's root however deep the folder is, and no further.
  for (let dir = resolve(cwd); ;) {
    const file = join(dir, RULES_FILE);
    const s = await statFile(file).catch(() => null);
    if (s?.isFile()) {
      // The repository's root too: what git saw changed is relative to it.
      let root = dir;
      for (let d = dir; ;) {
        if (await isRoot(d)) { root = d; break; }
        const up = dirname(d);
        if (up === d) break;
        d = up;
      }
      return load(file, s, read, root);
    }
    if (await isRoot(dir)) return null; // the repository's root: no rules
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

async function load(file, s, read, root) {
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === s.mtimeMs && hit.size === s.size && hit.rules.root === root) return hit.rules;
  const at = { file, dir: dirname(file), root };
  let rules;
  if (s.size > MAX) rules = { ...at, error: `it’s bigger than ${MAX / 1024} KB` };
  else {
    try { rules = { ...at, ...parseRules(JSON.parse(await read(file, 'utf8'))) }; } catch (err) { rules = { ...at, error: err instanceof SyntaxError ? 'it isn’t valid JSON' : clean(err?.message, 120) || 'it couldn’t be read' }; }
  }
  cache.set(file, { mtimeMs: s.mtimeMs, size: s.size, rules });
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return rules;
}

const some = (files) => `${files.slice(0, 3).join(', ')}${files.length > 3 ? ` +${files.length - 3}` : ''}`;
const RAN = { failed: 'failed', stale: 'didn’t run after the last change', 'not-run': 'didn’t run', unclear: 'had an unclear result' };

/**
 * A finished request held to the rules: [{ ok: true | false, text }], what it broke first and,
 * when it broke nothing, one ✓ line. Its changes are the files any tool, command or (git says)
 * anything else changed, relative to the rules' folder; `mustPass` only counts when it changed
 * something. [] without rules.
 */
export function ruleChecks(rules, turn) {
  if (!rules) return [];
  const name = basename(rules.file ?? RULES_FILE);
  if (rules.error) return [{ ok: false, text: `The project’s rules (${name}) couldn’t be read: ${rules.error}` }];
  const all = changedIn(rules, turn);
  const changed = all.filter((f) => f !== RULES_FILE);
  const out = [];
  // The request changed the rules themselves: it's held to the ones it started with (see the
  // bridge), and the change is for you to look at, not for the request to decide.
  if (all.length !== changed.length) out.push({ ok: false, text: `Changed the project’s rules (${name}) during the request: check it’s what you wanted` });
  for (const p of rules.mustNotTouch) {
    const hit = changed.filter((f) => matches(f, p));
    if (hit.length) out.push({ ok: false, text: `Broke a project rule: changed ${some(hit)} (not to touch: ${p})` });
  }
  if (rules.onlyTouch.length) {
    const off = changed.filter((f) => !rules.onlyTouch.some((p) => matches(f, p)));
    if (off.length) out.push({ ok: false, text: `Broke a project rule: changed ${some(off)}, outside ${rules.onlyTouch.join(' or ')}` });
  }
  if (changed.length) {
    for (const c of rules.mustPass) {
      const r = ranAfterLastChange(turn.steps, c);
      if (r.state !== 'passed') out.push({ ok: false, text: `Broke a project rule: \`${c}\` ${RAN[r.state] ?? r.state}${r.note ? ` (${r.note})` : ''}` });
    }
  }
  if (rules.noNewDependencies) {
    const d = noNewDeps(turn.steps, changed);
    if (!d.ok) out.push({ ok: false, text: `Broke a project rule (no new dependencies): ${d.text}` });
  }
  return out.length ? out : [{ ok: true, text: `Followed the project’s rules (${name})` }];
}

/**
 * The files a request changed (file tools, commands that write files, and what git saw),
 * relative to the rules' folder; files outside it (another package of a monorepo) left out.
 * Git's paths are relative to the repository's root, so they're put under it first.
 */
function changedIn(rules, turn) {
  const out = new Set();
  const rel = (p) => relativeTo(rules.dir, p);
  for (const s of turn.steps) {
    if (s.status === 'failed') continue;
    for (const f of s.files ?? []) if (f.change !== 'read') out.add(rel(f.path));
    for (const p of commandEdits(s)) out.add(rel(p));
  }
  for (const f of gitTruth(turn)?.files ?? []) out.add(rel(join(rules.root ?? rules.dir, f.path)));
  out.delete(null);
  return [...out].sort();
}

/** For a path the agent gives (absolute, or relative to its folder): the path relative to the rules' folder, or null when it's outside it. */
export function ruleRelative(rules, path, cwd) {
  if (!rules || !path) return null;
  const abs = /^([a-z]:[\\/]|[\\/])/i.test(path) ? path : join(cwd ?? rules.dir, path);
  return relativeTo(rules.dir, abs);
}
