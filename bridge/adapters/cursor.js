// Cursor adapter: Cursor's agent hooks (https://cursor.com/docs/hooks).
//
// Connect adds `node ".../bridge/hook.js" cursor` to ~/.cursor/hooks.json for the
// hooks below; Cursor runs it with the event as JSON on stdin, and hook.js
// forwards it to POST /hook?agent=cursor. Cursor reloads hooks.json on save.
//
// Only hooks that watch are used, never the ones that approve or block
// (preToolUse, beforeShellExecution, beforeReadFile…), so dotpals can't change
// what the agent is allowed to do. That's why tool calls show up once they've
// finished rather than while they run.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { clip, clipEnds, clipText, folderName, relative, toPatch } from '../activity.js';
import { backup, backupPath, hookCommand, isOurs, readJson, writeJson } from './setup.js';

const ID = 'cursor';
export const EVENTS = [
  'sessionStart', 'sessionEnd', 'beforeSubmitPrompt', 'afterShellExecution', 'afterFileEdit',
  'afterMCPExecution', 'postToolUse', 'postToolUseFailure', 'subagentStop', 'afterAgentResponse', 'preCompact', 'stop',
];

const dir = () => process.env.DOTPALS_CURSOR_DIR || join(homedir(), '.cursor');
const file = () => join(dir(), 'hooks.json');

// Tools the specific hooks above already report (postToolUse fires for them too).
const COVERED = /^(Shell|Write|Edit|MCP:.*)$/;
const KIND = { Read: 'read', Grep: 'search', Glob: 'search', Delete: 'edit', Task: 'agent', WebSearch: 'web', WebFetch: 'web' };

const replies = new Map(); // session → the agent's last reply, until the turn ends

const text = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v, null, 2));
const parse = (v) => { if (typeof v !== 'string') return v ?? {}; try { return JSON.parse(v); } catch { return {}; } };

/**
 * Fold one Cursor hook event into the log.
 * Returns { entries, session, label, state? }.
 */
export function applyCursor(e, log) {
  const convo = e.conversation_id ?? e.session_id;
  if (!convo) return { entries: [] };
  const session = `cursor:${convo}`;
  const root = Array.isArray(e.workspace_roots) ? e.workspace_roots[0] : undefined;
  const cwd = e.cwd ?? root;
  const label = folderName(root ?? cwd);
  const now = Date.now();
  const n = (applyCursor.n = (applyCursor.n ?? 0) + 1);
  const base = { session, label, harness: ID };
  // Cursor reports tools when they finish; date them from when they started, but
  // never before the prompt, or they'd look like part of the previous request.
  const asked = log.findLast(session, (x) => x.kind === 'prompt')?.at ?? 0;
  const started = (ms) => Math.max(Number(ms) > 0 ? now - Number(ms) : now, Math.min(asked + 1, now));
  const out = { entries: [], session, label };
  const add = (entry) => out.entries.push(log.upsert(entry));

  switch (e.hook_event_name) {
    case 'sessionStart':
      out.state = { state: 'idle' };
      break;
    case 'beforeSubmitPrompt': {
      const title = clip(e.prompt, 300);
      if (title) add({ ...base, id: `${session}:u:${e.generation_id ?? now}`, at: now, kind: 'prompt', title, status: 'info' });
      out.state = { state: 'thinking' };
      break;
    }
    case 'afterShellExecution': {
      const cmd = String(e.command ?? '');
      add({
        ...base, id: `${session}:sh:${now}-${n}`, at: started(e.duration), tool: 'Shell', kind: 'run', title: clip(cmd, 80),
        detail: e.cwd && e.cwd !== root ? relative(e.cwd, root) : undefined, status: 'ok', ms: Number(e.duration) || undefined,
        body: { command: clipEnds(cmd, 4000), output: clipEnds(e.output, 3000) || undefined },
      });
      out.state = { state: 'working', text: clip(cmd, 40) };
      break;
    }
    case 'afterFileEdit': {
      const path = e.file_path;
      const edits = Array.isArray(e.edits) ? e.edits : [];
      const created = edits.length === 1 && !edits[0].old_string;
      add({
        ...base, id: `${session}:ed:${now}-${n}`, at: now, tool: 'Edit', kind: created ? 'write' : 'edit', title: relative(path, root),
        files: [{ path, change: created ? 'write' : 'edit' }], status: 'ok',
        body: { patch: clipText(edits.map((x) => toPatch(x.old_string, x.new_string, 2000)).join('\n@@\n'), 6000) },
      });
      out.state = { state: 'working', text: `Editing ${relative(path, root).split(/[\\/]/).pop()}` };
      break;
    }
    case 'afterMCPExecution': {
      const server = e.mcp_server_name ?? '';
      add({
        ...base, id: `${session}:mcp:${now}-${n}`, at: started(e.duration), tool: `MCP:${e.tool_name}`, kind: 'mcp',
        title: String(e.tool_name ?? 'tool').replace(/_/g, ' '), detail: server || undefined, status: 'ok', ms: Number(e.duration) || undefined,
        body: { args: clipText(text(parse(e.tool_input)), 3000), output: clipEnds(text(e.result_json), 3000) || undefined },
      });
      out.state = { state: 'working', text: clip(e.tool_name, 40) };
      break;
    }
    case 'postToolUse':
    case 'postToolUseFailure': {
      const tool = String(e.tool_name ?? '');
      const failed = e.hook_event_name === 'postToolUseFailure';
      if (!tool || (!failed && COVERED.test(tool))) break;
      const input = parse(e.tool_input);
      const target = input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.command ?? input.description;
      const kind = tool === 'Shell' ? 'run' : tool.startsWith('MCP:') ? 'mcp' : KIND[tool] ?? 'tool';
      add({
        ...base, id: `${session}:${e.tool_use_id ?? `t:${now}-${n}`}`, at: started(e.duration), tool, kind,
        title: clip(typeof target === 'string' ? relative(target, root) : tool, 80), status: failed ? 'failed' : 'ok',
        ms: Number(e.duration) || undefined, error: failed ? clip(e.error_message ?? e.failure_type, 300) : undefined,
        ...(kind === 'read' && typeof target === 'string' ? { files: [{ path: target, change: 'read' }] } : {}),
        body: { args: clipText(text(input), 3000), output: failed ? undefined : clipEnds(text(e.tool_output), 3000) || undefined },
      });
      break;
    }
    case 'subagentStop':
      add({
        ...base, id: `${session}:sub:${now}-${n}`, at: started(e.duration_ms), tool: 'Task', kind: 'agent',
        title: clip(e.description || e.task || e.subagent_type || 'Subagent', 80), detail: e.subagent_type,
        status: e.status === 'completed' ? 'ok' : e.status === 'error' ? 'failed' : 'stopped', ms: Number(e.duration_ms) || undefined,
        body: { output: clipText(e.summary, 3000) || undefined },
      });
      break;
    case 'afterAgentResponse': {
      // Usually before `stop`; if the turn already ended, add it to that.
      const summary = clipText(e.text, 2000);
      const prompt = log.findLast(session, (x) => x.kind === 'prompt');
      const done = log.findLast(session, (x) => x.kind === 'done' || x.kind === 'error');
      if (summary && done && (!prompt || done.at >= prompt.at)) add({ id: done.id, summary });
      else if (summary) replies.set(session, summary);
      out.state = { state: 'speaking' };
      break;
    }
    case 'preCompact':
      add({ ...base, id: `${session}:c:${now}`, at: now, kind: 'compact', title: 'Tidied up its memory', status: 'info' });
      break;
    case 'stop': {
      out.entries.push(...log.settle(session));
      const prompt = log.findLast(session, (x) => x.kind === 'prompt');
      const ok = e.status !== 'error';
      add({
        ...base, id: `${session}:s:${e.generation_id ?? now}`, at: now, kind: ok ? 'done' : 'error',
        title: e.status === 'aborted' ? 'Stopped' : ok ? 'Finished' : 'Stopped with an error', status: ok ? 'ok' : 'failed',
        ms: prompt ? Math.max(0, now - prompt.at) : undefined, summary: replies.get(session),
      });
      replies.delete(session);
      out.state = ok ? { state: 'done', text: e.status === 'aborted' ? 'Stopped' : 'Done!' } : { state: 'error', text: 'Something went wrong' };
      break;
    }
    case 'sessionEnd':
      out.entries.push(...log.settle(session));
      out.state = { state: 'sleeping' };
      break;
  }
  return out;
}

/** Our command in hooks.json, if it's there. */
function installed() {
  let hooks = {};
  try { hooks = readJson(file()).hooks ?? {}; } catch { return null; }
  for (const list of Object.values(hooks)) {
    const ours = Array.isArray(list) && list.find((h) => isOurs(h?.command, ID));
    if (ours) return ours.command;
  }
  return null;
}

/** Remove our commands from a hooks.json object; true if anything changed. */
function strip(config) {
  let changed = false;
  for (const [event, list] of Object.entries(config.hooks ?? {})) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((h) => !isOurs(h?.command, ID));
    if (kept.length !== list.length) changed = true;
    if (kept.length) config.hooks[event] = kept;
    else delete config.hooks[event];
  }
  return changed;
}

export default {
  id: ID,
  name: 'Cursor',
  via: 'Hooks (~/.cursor/hooks.json)',
  how: 'Connect adds a small command to Cursor’s hooks. Cursor runs it after each prompt, command, edit and reply, and when the agent stops.',
  docs: 'https://cursor.com/docs/hooks',
  setup: 'connect',
  file,
  detect: () => ({ found: existsSync(dir()), where: dir() }),
  connected: () => !!installed(),
  /** The command in hooks.json, as Cursor will run it. */
  command: () => installed(),
  connect() {
    const config = readJson(file(), { version: 1, hooks: {} });
    if (config.hooks != null && (typeof config.hooks !== 'object' || Array.isArray(config.hooks))) throw new Error(`${file()} has an unexpected "hooks" value, so it wasn’t changed.`);
    const saved = backup(file());
    config.version ??= 1;
    config.hooks ??= {};
    strip(config); // an older install location, or connecting twice
    const command = hookCommand(ID);
    for (const event of EVENTS) {
      if (!Array.isArray(config.hooks[event])) config.hooks[event] = [];
      config.hooks[event].push({ command, timeout: 5 });
    }
    writeJson(file(), config);
    return { file: file(), backup: saved, command };
  },
  disconnect() {
    if (!existsSync(file())) return { file: file() };
    const config = readJson(file());
    if (!strip(config)) return { file: file() };
    writeJson(file(), config);
    return { file: file(), backup: existsSync(backupPath(file())) ? backupPath(file()) : null };
  },
  apply: applyCursor,
  sample: (session) => ({ hook_event_name: 'sessionStart', conversation_id: session, session_id: session, workspace_roots: [], composer_mode: 'agent' }),
};
