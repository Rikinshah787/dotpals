// Gemini CLI adapter: Gemini CLI's hooks (https://geminicli.com/docs/hooks/,
// on by default since v0.26.0).
//
// Connect adds `node ".../bridge/hook.js" gemini` to ~/.gemini/settings.json for
// the events below; Gemini runs it with the event as JSON on stdin, hook.js
// forwards it to POST /hook?agent=gemini and prints {} (which changes nothing).
// Gemini only runs hooks in folders you've trusted.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { clip, clipEnds, clipText, folderName, relative, toPatch } from '../activity.js';
import { backup, backupPath, hookCommand, isOurs, readJson, writeJson } from './setup.js';

const ID = 'gemini';
export const EVENTS = ['SessionStart', 'BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterAgent', 'Notification', 'PreCompress', 'SessionEnd'];

const dir = () => process.env.DOTPALS_GEMINI_DIR || join(homedir(), '.gemini');
const file = () => join(dir(), 'settings.json');

/** What a Gemini CLI tool call did (geminicli.com/docs/reference/tools). */
export function describeTool(name = '', input = {}, cwd) {
  const rel = (p) => relative(p, cwd);
  const file = input.file_path;
  switch (name) {
    case 'run_shell_command':
      return { kind: 'run', title: clip(input.description || input.command, 80), detail: input.description ? clip(input.command, 160) : rel(input.dir_path) || undefined, body: { command: clipEnds(input.command, 4000) } };
    case 'write_file':
      return { kind: 'write', title: rel(file), files: [{ path: file, change: 'write' }], body: { patch: toPatch('', input.content) } };
    case 'replace':
      return { kind: 'edit', title: rel(file), files: [{ path: file, change: 'edit' }], body: { patch: toPatch(input.old_string, input.new_string) } };
    case 'read_file':
      return { kind: 'read', title: rel(file), files: [{ path: file, change: 'read' }] };
    case 'read_many_files':
      return { kind: 'read', title: clip([].concat(input.include ?? []).join(', ') || 'Several files', 80) };
    case 'glob': case 'grep_search': case 'search_file_content':
      return { kind: 'search', title: clip(input.pattern, 80), detail: [input.include_pattern, rel(input.dir_path)].filter(Boolean).join(' in ') || undefined };
    case 'list_directory':
      return { kind: 'search', title: rel(input.dir_path) || 'the folder', detail: 'listed' };
    case 'web_fetch':
      return { kind: 'web', title: clip(input.prompt, 80) };
    case 'google_web_search':
      return { kind: 'web', title: clip(input.query, 80) };
    case 'write_todos':
      return {
        kind: 'plan', title: 'Updated the plan',
        plan: (input.todos ?? []).map((t) => ({ text: String(t.description ?? ''), status: t.status === 'completed' ? 'completed' : t.status === 'in_progress' ? 'in_progress' : 'pending' })),
        body: { args: (input.todos ?? []).map((t) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '·'} ${t.description}`).join('\n') },
      };
  }
  const args = clipText(JSON.stringify(input, null, 2), 3000);
  // MCP tools are named mcp_<server>_<tool>; server names can hold underscores too.
  if (name.startsWith('mcp_')) return { kind: 'mcp', title: name.slice(4).replace(/_/g, ' '), body: { args } };
  return { kind: 'tool', title: name.replace(/_/g, ' '), body: { args } };
}

const responseText = (r) => {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  const v = r.error ? (r.error.message ?? r.error) : typeof r.returnDisplay === 'string' ? r.returnDisplay : r.llmContent;
  return typeof v === 'string' ? v : JSON.stringify(v ?? '', null, 2);
};

/**
 * How run_shell_command ended, from what it tells the model (llmContent): cancelled ("Command
 * was cancelled by user before it could complete."), or its exit code ("Exit Code: 1", only
 * there when it isn't 0). Its error field is set only when the command couldn't run at all.
 */
function shellEnd(r) {
  const llm = typeof r?.llmContent === 'string' ? r.llmContent : '';
  if (/\bCommand was cancelled by user before it could complete\b/.test(llm)) return { status: 'stopped' };
  const code = Number([...llm.matchAll(/^Exit Code: (-?\d+)/gm)].at(-1)?.[1] ?? 0);
  return code ? { status: 'failed', line: `Exit Code: ${code}` } : null;
}

// Gemini's tool events have no call id: pair BeforeTool and AfterTool by tool and input.
const pending = new Map(); // `${session}|${tool}|${input}` → [entry id, …]
const keyOf = (session, e) => `${session}|${e.tool_name}|${JSON.stringify(e.tool_input ?? {})}`;

/**
 * Fold one Gemini CLI hook event into the log.
 * Returns { entries, session, label, state? }.
 */
export function applyGemini(e, log) {
  if (!e.session_id) return { entries: [] };
  const session = `gemini:${e.session_id}`;
  const label = folderName(e.cwd);
  const at = Date.parse(e.timestamp) || Date.now();
  const base = { session, label, harness: ID, at };
  const out = { entries: [], session, label };
  const add = (entry) => out.entries.push(log.upsert(entry));
  const n = (applyGemini.n = (applyGemini.n ?? 0) + 1);

  switch (e.hook_event_name) {
    case 'SessionStart':
      out.state = { state: 'idle' };
      break;
    case 'BeforeAgent': {
      const title = clip(e.prompt, 300);
      if (title && !log.findLast(session, (x) => x.kind === 'prompt' && x.title === title && Math.abs(at - x.at) < 5000)) {
        add({ ...base, id: `${session}:u:${at}`, kind: 'prompt', title, status: 'info' });
      }
      out.state = { state: 'thinking' };
      break;
    }
    case 'BeforeTool': {
      const id = `${session}:t:${at}-${n}`;
      const key = keyOf(session, e);
      pending.set(key, [...(pending.get(key) ?? []), id]);
      const described = describeTool(e.tool_name, e.tool_input ?? {}, e.cwd);
      add({ ...base, id, tool: e.tool_name, ...described, status: 'running', startedAt: at });
      out.state = { state: 'working', text: clip(described.title, 40) };
      break;
    }
    case 'AfterTool': {
      const key = keyOf(session, e);
      const ids = pending.get(key) ?? [];
      const id = ids.shift();
      if (ids.length) pending.set(key, ids); else pending.delete(key);
      const failed = !!e.tool_response?.error;
      const shell = e.tool_name === 'run_shell_command' ? shellEnd(e.tool_response) : null;
      const status = shell?.status === 'stopped' ? 'stopped' : failed || shell ? 'failed' : 'ok';
      const raw = responseText(e.tool_response);
      // The output shown (returnDisplay) doesn't say how it exited: add the line that does.
      const text = clipEnds(shell?.line && !raw.includes(shell.line) ? `${raw}\n${shell.line}` : raw, 3000);
      const known = id && log.get(id);
      if (known) {
        add({ id, status, ms: known.startedAt ? Math.max(0, at - known.startedAt) : undefined, error: failed ? clip(text, 300) : undefined, body: { output: text || undefined } });
      } else {
        // No BeforeTool seen (the pal started mid-call): record it finished.
        add({ ...base, id: `${session}:t:${at}-${n}`, tool: e.tool_name, ...describeTool(e.tool_name, e.tool_input ?? {}, e.cwd), status, body: { output: text || undefined } });
      }
      out.state = { state: 'thinking' };
      break;
    }
    case 'Notification': {
      // Gemini is asking you to allow a tool.
      const waiting = log.findLast(session, (x) => x.status === 'running');
      if (waiting) add({ id: waiting.id, status: 'waiting' });
      out.state = { state: 'waiting', text: clip(e.message || 'Needs your OK', 60) };
      break;
    }
    case 'PreCompress':
      add({ ...base, id: `${session}:c:${at}`, kind: 'compact', title: 'Tidied up its memory', status: 'info' });
      break;
    case 'AfterAgent': {
      out.entries.push(...log.settle(session));
      const prompt = log.findLast(session, (x) => x.kind === 'prompt');
      add({
        ...base, id: `${session}:s:${at}`, kind: 'done', title: 'Finished', status: 'ok',
        ms: prompt ? Math.max(0, at - prompt.at) : undefined, summary: e.prompt_response ? clipText(e.prompt_response, 2000) : undefined,
      });
      out.state = { state: 'done', text: 'Done!' };
      break;
    }
    case 'SessionEnd':
      out.entries.push(...log.settle(session));
      for (const key of pending.keys()) if (key.startsWith(`${session}|`)) pending.delete(key);
      out.state = { state: 'sleeping' };
      break;
  }
  return out;
}

const ours = (group) => Array.isArray(group?.hooks) && group.hooks.some((h) => isOurs(h?.command, ID));

/** Remove our hook groups from a settings object; true if anything changed. */
function strip(settings) {
  let changed = false;
  for (const [event, list] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((g) => !ours(g));
    if (kept.length !== list.length) changed = true;
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (changed && settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  return changed;
}

function installed() {
  let hooks = {};
  try { hooks = readJson(file()).hooks ?? {}; } catch { return null; }
  for (const list of Object.values(hooks)) {
    for (const g of Array.isArray(list) ? list : []) {
      const h = Array.isArray(g?.hooks) && g.hooks.find((x) => isOurs(x?.command, ID));
      if (h) return h.command;
    }
  }
  return null;
}

export default {
  id: ID,
  name: 'Gemini CLI',
  via: 'Hooks (~/.gemini/settings.json)',
  how: 'Connect adds a small command to Gemini CLI’s hooks (v0.26 or newer). It runs on each prompt, tool call and reply, in folders you’ve trusted.',
  docs: 'https://geminicli.com/docs/hooks/',
  setup: 'connect',
  file,
  detect: () => ({ found: existsSync(dir()), where: dir() }),
  connected: () => !!installed(),
  command: () => installed(),
  connect() {
    const settings = readJson(file(), {});
    if (settings.hooks != null && (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) throw new Error(`${file()} has an unexpected "hooks" value, so it wasn’t changed.`);
    const saved = backup(file());
    settings.hooks ??= {};
    strip(settings);
    settings.hooks ??= {};
    const command = hookCommand(ID);
    for (const event of EVENTS) {
      if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
      settings.hooks[event].push({ matcher: '*', hooks: [{ name: 'dotpals', type: 'command', command, timeout: 5000 }] });
    }
    writeJson(file(), settings);
    const note = settings.hooksConfig?.enabled === false ? 'Hooks are turned off in your Gemini settings (hooksConfig.enabled), so nothing will arrive until you turn them on.' : undefined;
    return { file: file(), backup: saved, command, note };
  },
  disconnect() {
    if (!existsSync(file())) return { file: file() };
    const settings = readJson(file());
    if (!strip(settings)) return { file: file() };
    writeJson(file(), settings);
    return { file: file(), backup: existsSync(backupPath(file())) ? backupPath(file()) : null };
  },
  apply: applyGemini,
  sample: (token) => ({ hook_event_name: 'SessionStart', session_id: token, cwd: '', timestamp: new Date().toISOString(), source: 'startup' }),
};
