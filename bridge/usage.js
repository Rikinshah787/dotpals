// Plan usage limits for the notch and dashboard: how much of each agent's
// 5-hour and weekly allowance you've used, and when it resets.
//
//   Codex        writes them to its session logs (token_count → rate_limits),
//                so they're read straight from ~/.codex/sessions.
//   Claude Code  only hands them to a status line command, so bridge/statusline.js
//                saves them to ~/.dotpals/claude-limits.json (see `dotpals statusline`).
//
// Everything is read from files on this computer; nothing is fetched.
import { readFileSync } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { home } from './config.js';

export const claudeLimitsFile = () => join(home(), 'claude-limits.json');

/** A limit window, or null: { used_percent, resets_at (ms), window_minutes }. A window that has reset reads 0%. */
function windowOf(used, resetsAt, minutes) {
  if (typeof used !== 'number') return null;
  const resets = typeof resetsAt === 'number' ? resetsAt * (resetsAt < 1e12 ? 1000 : 1) : null;
  const expired = resets != null && resets < Date.now();
  return { used_percent: expired ? 0 : Math.max(0, Math.round(used * 10) / 10), resets_at: expired ? null : resets, window_minutes: minutes };
}

async function claude() {
  let saved;
  try { saved = JSON.parse(await readFile(claudeLimitsFile(), 'utf8')); } catch { return { harness: 'claude', window: null, weekly: null, setup: 'statusline' }; }
  const r = saved.rate_limits ?? {};
  return {
    harness: 'claude',
    window: windowOf(r.five_hour?.used_percentage, r.five_hour?.resets_at, 300),
    weekly: windowOf(r.seven_day?.used_percentage, r.seven_day?.resets_at, 10080),
    context: typeof saved.context_window?.used_percentage === 'number' ? saved.context_window.used_percentage : null,
    model: saved.model?.display_name ?? null,
    updatedAt: saved.updatedAt ?? null,
  };
}

/** The newest rate_limits in Codex's logs (the last few days, newest file first). */
async function codex(dir = join(homedir(), '.codex', 'sessions')) {
  const files = [];
  for (let days = 0; days < 7; days++) {
    const d = new Date(Date.now() - days * 86_400_000);
    const folder = join(dir, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    let names = [];
    try { names = await readdir(folder); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      try { files.push({ path: join(folder, name), mtime: (await stat(join(folder, name))).mtimeMs }); } catch {}
    }
    if (files.length >= 12) break;
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const { path, mtime } of files.slice(0, 12)) {
    let fh;
    try {
      fh = await open(path, 'r');
      const { size } = await fh.stat();
      const length = Math.min(size, 1024 * 1024);
      const { buffer } = await fh.read(Buffer.alloc(length), 0, length, size - length);
      const lines = buffer.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"rate_limits"')) continue;
        let o;
        try { o = JSON.parse(lines[i]); } catch { continue; }
        const r = o.payload?.rate_limits;
        if (!r?.primary && !r?.secondary) continue;
        return {
          harness: 'codex',
          window: windowOf(r.primary?.used_percent, r.primary?.resets_at, r.primary?.window_minutes ?? 300),
          weekly: windowOf(r.secondary?.used_percent, r.secondary?.resets_at, r.secondary?.window_minutes ?? 10080),
          plan: r.plan_type ?? null,
          updatedAt: Date.parse(o.timestamp) || mtime,
        };
      }
    } catch {} finally {
      await fh?.close();
    }
  }
  return null;
}

/** A Claude session's context window size, if its status line reported it (else null). */
let sizes = { at: 0, map: {} };
export function claudeContextSize(session) {
  if (Date.now() - sizes.at > 5000) {
    let map = {};
    try { map = JSON.parse(readFileSync(claudeLimitsFile(), 'utf8')).sizes ?? {}; } catch {}
    sizes = { at: Date.now(), map };
  }
  return sizes.map[session] ?? null;
}

let cache = null;
/** "5-hour", "Day", "Week", "Month" for a window's length. */
export const windowName = (minutes) =>
  minutes === 300 ? '5-hour' : minutes === 1440 ? 'Day' : minutes === 10080 ? 'Week' : minutes >= 40000 && minutes <= 46000 ? 'Month'
  : minutes < 1440 ? `${Math.round(minutes / 60)}-hour` : `${Math.round(minutes / 1440)}-day`;

/**
 * { agents: [{ harness, limits: [{ label, used_percent, resets_at, window_minutes }], window, weekly, updatedAt, … }] },
 * cached for a few seconds. `limits` is the list to show (any number of windows per agent).
 */
export async function readUsage({ codexDir } = {}) {
  if (cache && Date.now() - cache.at < 5000) return cache.value;
  const agents = (await Promise.all([claude(), codex(codexDir)])).filter(Boolean).map((a) => ({
    ...a,
    limits: a.limits ?? [a.window, a.weekly].filter(Boolean).map((w) => ({ ...w, label: windowName(w.window_minutes) })),
  }));
  cache = { at: Date.now(), value: { agents } };
  return cache.value;
}
