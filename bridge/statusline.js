#!/usr/bin/env node
// A Claude Code status line that also tells dotpals your plan usage.
//
// Claude Code gives a status line command its 5-hour and weekly usage limits (and
// nothing else does), so this saves them to ~/.dotpals/claude-limits.json for the
// notch and dashboard, then prints a short line of its own. If you already had a
// status line, it runs that one and prints its output instead, so nothing changes
// on your screen. Set up with `dotpals statusline`; undo with `dotpals statusline --off`.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { home } from './config.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks).toString('utf8');
let input = {};
try { input = JSON.parse(raw); } catch {}

// 1. Save what the notch needs (only fields we use; nothing from your conversation).
if (input.rate_limits || input.context_window) {
  try {
    mkdirSync(home(), { recursive: true });
    const file = join(home(), 'claude-limits.json');
    // Each session's context window size (transcripts don't record it), newest 30.
    let sizes = {};
    try { sizes = JSON.parse(readFileSync(file, 'utf8')).sizes ?? {}; } catch {}
    if (input.session_id && input.context_window?.context_window_size) {
      delete sizes[input.session_id];
      sizes[input.session_id] = input.context_window.context_window_size;
      sizes = Object.fromEntries(Object.entries(sizes).slice(-30));
    }
    const keep = {
      sizes,
      rate_limits: input.rate_limits ?? null,
      context_window: input.context_window ? { used_percentage: input.context_window.used_percentage ?? null, context_window_size: input.context_window.context_window_size ?? null } : null,
      model: input.model ? { display_name: input.model.display_name } : null,
      session_id: input.session_id,
      updatedAt: Date.now(),
    };
    writeFileSync(`${file}.tmp`, JSON.stringify(keep));
    renameSync(`${file}.tmp`, file);
  } catch {}
}

// 2. Print a status line: yours, if you had one, or ours.
let previous = null;
try { previous = JSON.parse(readFileSync(join(home(), 'statusline.json'), 'utf8')).previous; } catch {}
if (previous?.command) {
  const run = spawnSync(previous.command, { input: raw, encoding: 'utf8', shell: true, timeout: 4000 });
  process.stdout.write(run.stdout ?? '');
} else {
  const pct = (w) => (typeof w?.used_percentage === 'number' ? `${Math.round(w.used_percentage)}%` : null);
  const parts = [
    input.model?.display_name,
    pct(input.rate_limits?.five_hour) && `5h ${pct(input.rate_limits.five_hour)}`,
    pct(input.rate_limits?.seven_day) && `week ${pct(input.rate_limits.seven_day)}`,
    typeof input.context_window?.used_percentage === 'number' && `context ${Math.round(input.context_window.used_percentage)}%`,
  ].filter(Boolean);
  process.stdout.write(`● ${parts.join(' · ') || 'dotpals'}`);
}
