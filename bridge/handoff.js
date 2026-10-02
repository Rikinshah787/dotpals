// Hand-off: continue a session's work in another agent ("Continue in Codex / Claude /
// Gemini"). The bridge writes the note (bridge/ui/handoff.js) to
// <home>/handoff/<id>.md, then opens a NEW terminal window in the session's project
// folder running the chosen agent with a short prompt that only names that file. It
// can't type into an agent that's already open; Copy (the note on the clipboard) is
// the way to hand it to one.
//
// Nothing here goes through a shell's string parsing with text from the session: the
// note is a file, the prompt is fixed words plus that file's path, and only the agents
// below can be started. Each platform's command is built by launchCommand() (pure, so
// it's tested without opening anything).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { home } from './config.js';

/** The agents a session can be handed to: the command, and how it takes a first prompt. */
export const HANDOFF_AGENTS = {
  codex: { name: 'Codex', command: 'codex', args: (prompt) => [prompt] },
  claude: { name: 'Claude Code', command: 'claude', args: (prompt) => [prompt] },
  gemini: { name: 'Gemini CLI', command: 'gemini', args: (prompt) => ['-i', prompt] },
};

/** The prompt the new agent starts with: it only names the note. */
export const handoffPrompt = (file) => `Read ${file} and continue the work it describes.`;

/** Whether `cmd` is a program on PATH (with Windows' .exe/.cmd/… endings). */
export function onPath(cmd, { env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const dirs = String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  const exts = platform === 'win32' ? ['', ...String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  return dirs.some((d) => exts.some((x) => { try { return exists(join(d.replace(/^"|"$/g, ''), cmd + x)); } catch { return false; } }));
}

let cache = null;
/** The hand-off agents installed here: [{ id, name }]. Looked up at most once a minute. */
export function installedAgents({ has = onPath, now = Date.now() } = {}) {
  if (cache && now - cache.at < 60_000 && has === onPath) return cache.list;
  const list = Object.entries(HANDOFF_AGENTS).filter(([, a]) => has(a.command)).map(([id, a]) => ({ id, name: a.name }));
  if (has === onPath) cache = { at: now, list };
  return list;
}

// -- the command that opens a terminal -----------------------------------------------

/**
 * A folder for a terminal to start in, never ending in a backslash: a quoted `"C:\dir\"`
 * breaks Windows' quoting (the `\"` reads as a literal quote). A drive's root is `C:\.`.
 */
const tidyDir = (dir) => { const d = String(dir).replace(/[\\/]+$/, ''); return /^[a-z]:$/i.test(d) ? `${d}\\.` : d || '/'; };
/** POSIX shell single quotes. */
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/** An AppleScript string. */
const as = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * How to open a new terminal in `dir` running `agent` with `prompt`, on `platform`:
 *   { file, args, options } to spawn (no shell), or { error } when it can't be done safely.
 * `has(program)` says what's installed (Windows Terminal, gnome-terminal…).
 *
 *   Windows  Windows Terminal (`wt -d <dir> cmd /k <agent> "<prompt>"`), else a console
 *            window (`cmd /c start "" /D "<dir>" cmd /k <agent> "<prompt>"`). The agent runs
 *            under cmd so npm's .cmd shims start; the command line is quoted here, word by
 *            word (windowsVerbatimArguments), and refuses `"`, `%` and line breaks, which
 *            cmd can't keep literal inside quotes.
 *   macOS    Terminal, through osascript: `cd '<dir>' && <agent> '<prompt>'`.
 *   Linux    gnome-terminal, konsole or x-terminal-emulator, with the agent and prompt as
 *            separate arguments; none found: an error (use Copy instead).
 */
export function launchCommand({ platform = process.platform, agent, dir, prompt, has = onPath }) {
  const a = Object.hasOwn(HANDOFF_AGENTS, agent) ? HANDOFF_AGENTS[agent] : null;
  if (!a) return { error: 'That agent can’t be started from dotpals.' };
  if (!dir) return { error: 'dotpals doesn’t know this session’s project folder.' };
  const words = [a.command, ...a.args(prompt)];
  if (platform === 'win32') {
    const folder = tidyDir(dir);
    if ([folder, prompt].some((s) => /["%\r\n]/.test(s))) return { error: 'The folder or note path has characters a Windows terminal can’t take safely.' };
    const q = (s) => `"${s}"`;
    const run = ['cmd', '/k', a.command, ...a.args(prompt).map((w) => (w.startsWith('-') && !/\s/.test(w) ? w : q(w)))];
    // Windows Terminal splits its command line at ";", even inside quotes.
    if (has('wt') && ![folder, prompt].some((s) => s.includes(';'))) {
      return { file: 'wt.exe', args: ['-d', q(folder), ...run], options: { windowsVerbatimArguments: true } };
    }
    return { file: 'cmd.exe', args: ['/d', '/c', 'start', '""', '/D', q(folder), ...run], options: { windowsVerbatimArguments: true } };
  }
  if (platform === 'darwin') {
    const script = `cd ${sq(dir)} && ${words.map(sq).join(' ')}`;
    return { file: 'osascript', args: ['-e', `tell application "Terminal" to do script ${as(script)}`, '-e', 'tell application "Terminal" to activate'], options: {} };
  }
  if (has('gnome-terminal')) return { file: 'gnome-terminal', args: [`--working-directory=${dir}`, '--', ...words], options: {} };
  if (has('konsole')) return { file: 'konsole', args: ['--workdir', dir, '-e', ...words], options: {} };
  if (has('x-terminal-emulator')) return { file: 'x-terminal-emulator', args: ['-e', ...words], options: { cwd: dir } };
  return { error: 'No terminal found (gnome-terminal, konsole or x-terminal-emulator). Use Copy instead.' };
}

/** Run a launchCommand() result: resolves once the terminal has started, rejects if it can't. */
export function launch({ file, args, options = {} }) {
  return new Promise((ok, fail) => {
    const child = spawn(file, args, { ...options, detached: true, stdio: 'ignore' });
    child.once('error', fail);
    child.once('spawn', () => { child.unref(); ok(); });
  });
}

/** Whether `dir` is a folder that exists. */
export const isFolder = (dir) => { try { return !!dir && statSync(dir).isDirectory(); } catch { return false; } };

/** Save a note as <home>/handoff/<id>.md; returns its path. The id is ours (time and random letters), never from a request. */
export async function saveNote(note) {
  const dir = join(home(), 'handoff');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${randomBytes(3).toString('hex')}.md`);
  await writeFile(file, note, { mode: 0o600 }); // it holds prompts, paths and test output: yours only
  return file;
}
