// Codex adapter: follows Codex's session logs (~/.codex/sessions/**/rollout-*.jsonl),
// so Codex CLI, the Codex IDE extension and the Codex app all show up with
// nothing to install on the Codex side. Set DOTPALS_CODEX=0 to turn it off.
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { clip, clipEnds, clipText, folderName, relative, toPatch } from '../activity.js';

const HARNESS = 'codex';
const RECENT = 12 * 60 * 60 * 1000; // follow logs touched in the last 12 hours
const LIVE = 10 * 60 * 1000;        // …but only give a pal to sessions active in the last 10 minutes
const QUIET_TOOLS = new Set(['wait', 'wait_agent', 'list_agents', 'tool_search']);

/** Files touched by an apply_patch body ("*** Update File: path" …). */
function patchFiles(patch, cwd) {
  const files = [];
  const re = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
  for (let m; (m = re.exec(patch)); ) {
    const path = m[2].trim();
    files.push({ path: /^([a-z]:[\\/]|\/)/i.test(path) || !cwd ? path : `${cwd.replace(/[\\/]+$/, '')}/${path}`, change: m[1] === 'Add' ? 'write' : m[1] === 'Delete' ? 'delete' : 'edit' });
  }
  return files;
}

function describePatch(patch, cwd, tool) {
  const seen = new Set();
  const files = patchFiles(patch, cwd).filter((f) => !seen.has(f.path.toLowerCase()) && seen.add(f.path.toLowerCase()));
  const names = files.map((f) => relative(f.path, cwd));
  return {
    kind: files.length && files.every((f) => f.change === 'write') ? 'write' : 'edit',
    tool,
    title: names.length ? clip(names.join(', '), 90) : 'Patch',
    detail: files.length > 1 ? `${files.length} files` : undefined,
    files,
    body: { patch: clipText(patch, 8000) },
  };
}

/** What a Codex tool call did, as activity fields. */
export function describeCall(name, args, cwd) {
  switch (name) {
    case 'exec_command': case 'shell': case 'local_shell': {
      const cmd = Array.isArray(args.cmd ?? args.command) ? (args.cmd ?? args.command).join(' ') : String(args.cmd ?? args.command ?? '');
      return { kind: 'run', title: clip(args.justification || cmd, 80), detail: args.justification ? clip(cmd, 160) : relative(args.workdir, cwd) || undefined, body: { command: clipEnds(cmd, 4000) } };
    }
    case 'write_stdin':
      return { kind: 'run', title: 'Sent input to a running command', body: { command: clipText(args.chars, 1000) } };
    case 'apply_patch':
      return describePatch(String(args.input ?? args.patch ?? ''), cwd, name);
    case 'view_image':
      return { kind: 'read', title: relative(args.path, cwd), files: [{ path: args.path, change: 'read' }] };
    case 'spawn_agent':
      return { kind: 'agent', title: clip(args.task_name || args.message, 80), body: { args: clipText(args.message, 3000) } };
    case 'send_message':
      return { kind: 'agent', title: clip(`Message to ${args.target}`, 80), body: { args: clipText(args.message, 3000) } };
    case 'update_plan':
      return { kind: 'plan', title: 'Updated the plan', plan: (args.plan ?? []).map((s) => ({ text: clip(s.step, 120), status: s.status })), body: { args: (args.plan ?? []).map((s) => `${s.status === 'completed' ? '✓' : s.status === 'in_progress' ? '▸' : '·'} ${s.step}`).join('\n') } };
    case 'js':
      return { kind: 'run', title: clip(args.title || 'Ran a script', 80), body: { command: clipEnds(args.code, 4000) } };
  }
  // MCP tools: "server__tool" or "mcp__server__tool".
  const mcp = name.includes('__') ? name.split('__').filter(Boolean) : null;
  if (mcp?.[0] === 'mcp' && mcp.length > 2) mcp.shift();
  return {
    kind: mcp ? 'mcp' : 'tool',
    title: (mcp ? mcp.at(-1) : name).replace(/^_+/, '').replace(/_/g, ' '),
    detail: mcp ? mcp[0].replace(/^mcp_*/, '') : undefined,
    body: { args: clipText(JSON.stringify(args, null, 2), 3000) },
  };
}

/**
 * The patch inside a script that calls apply_patch(…). It's a JS string
 * literal somewhere in the script (often in a variable), so it may arrive
 * escaped: "…\n…" or '…', or a `template` (String.raw or not).
 */
function patchFromScript(code = '') {
  if (!/apply_patch/.test(code)) return null;
  const start = code.indexOf('*** Begin Patch');
  if (start < 0) return null;
  const end = code.indexOf('*** End Patch', start);
  let patch = code.slice(start, end >= 0 ? end + '*** End Patch'.length : undefined);
  const before = code.slice(Math.max(0, start - 40), start);
  const quote = before.slice(-1);
  if (quote === '"' || quote === "'" || !patch.includes('\n')) {
    patch = patch.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c) => ({ n: '\n', t: '\t', r: '' })[c] ?? (c.length > 1 ? String.fromCharCode(parseInt(c.slice(1), 16)) : c));
  } else if (quote === '`' && !/String\.raw\s*`$/.test(before)) {
    patch = patch.replace(/\\([\\`$])/g, '$1');
  }
  return patch;
}

/** Codex puts context (AGENTS.md, environment…) in user messages too; those aren't prompts. */
const isPrompt = (text) => !!text?.trim() && !/^\s*(<[a-z_]+>|# AGENTS\.md|<INSTRUCTIONS>)/i.test(text);

const outputText = (output) =>
  typeof output === 'string' ? output : Array.isArray(output) ? output.map((b) => b?.text ?? '').join('\n') : output?.content ?? JSON.stringify(output ?? '');

/** Guess failure from a tool's output ("Process exited with code 1", "error: …"). */
const looksFailed = (text) => /exit(?:ed)?(?: with)? code:? ?-?[1-9]\d*|^\s*(error|fatal)\b/im.test(text) && !/exit(?:ed)?(?: with)? code:? ?0\b/i.test(text);

/**
 * Follow Codex's logs. Calls `emit(entries)` for activity,
 * `state(session, label, { state, text }, at)` for the pal, and `cwd(session, folder, parent?)`
 * when a session's project folder (and, for a helper, the session that started it) is known.
 */
export function watchCodex(log, { emit, state, context = () => {}, cwd: noteCwd = () => {}, dir = join(homedir(), '.codex', 'sessions'), interval = 1000 } = {}) {
  const files = new Map(); // path → { offset, session, label, cwd, partial }
  let stopped = false;

  async function recentFiles() {
    const found = [];
    const now = Date.now();
    // Logs are grouped by date (YYYY/MM/DD); look at today and yesterday.
    for (const days of [0, 1]) {
      const d = new Date(now - days * 86_400_000);
      const folder = join(dir, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
      let names = [];
      try { names = await readdir(folder); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const path = join(folder, name);
        try {
          const s = await stat(path);
          if (now - s.mtimeMs < RECENT) found.push({ path, size: s.size, mtime: s.mtimeMs });
        } catch {}
      }
    }
    return found;
  }

  function handle(file, o, live) {
    const p = o.payload ?? {};
    const at = Date.parse(o.timestamp) || Date.now();
    const kind = `${o.type}/${p.type ?? ''}`;

    if (o.type === 'session_meta') {
      file.session = `codex:${p.id ?? p.session_id}`;
      file.cwd = p.cwd;
      file.label = folderName(p.cwd);
      // A helper Codex started (spawn_agent) logs its parent; it counts as that session's.
      const parent = p.source?.subagent?.thread_spawn?.parent_thread_id;
      noteCwd(file.session, p.cwd, parent ? `codex:${parent}` : undefined);
      return;
    }
    if (o.type === 'turn_context' && p.cwd) {
      file.cwd = p.cwd;
      file.label = folderName(p.cwd);
      return;
    }
    if (!file.session) return;
    const { session, label, cwd } = file;
    const base = { session, label, harness: HARNESS, at };
    const out = [];
    const setState = (s, text) => live && state(session, label, { state: s, ...(text ? { text } : {}) }, at);

    switch (kind) {
      case 'event_msg/user_message':
      case 'response_item/message': {
        if (p.role === 'assistant') { setState('speaking'); break; }
        const text = kind === 'event_msg/user_message' ? p.message
          : p.role === 'user' ? (p.content ?? []).map((c) => c.text ?? '').join('\n') : null;
        if (!isPrompt(text)) break;
        const title = clip(text, 300);
        // Newer Codex logs the prompt twice (event + message); keep one.
        if (!log.findLast(session, (x) => x.kind === 'prompt' && x.title === title && Math.abs(at - x.at) < 60_000)) {
          out.push(log.upsert({ ...base, id: `${session}:u:${at}`, kind: 'prompt', title, status: 'info' }));
        }
        setState('thinking');
        break;
      }
      // How full the context window is (Codex logs the window size too).
      case 'event_msg/token_count': {
        const last = p.info?.last_token_usage;
        const size = p.info?.model_context_window;
        if (last?.input_tokens && size) context(session, label, { used: last.input_tokens, size, known: true, at });
        break;
      }
      case 'event_msg/task_started':
        setState('thinking');
        break;
      case 'response_item/function_call':
      case 'response_item/custom_tool_call': {
        if (QUIET_TOOLS.has(p.name)) break;
        let args = {};
        if (kind.endsWith('/function_call')) { try { args = JSON.parse(p.arguments || '{}'); } catch {} }
        else args = { input: p.input };
        let described;
        const scripted = p.name === 'exec' ? patchFromScript(p.input) : null;
        if (scripted) described = describePatch(scripted, cwd, 'apply_patch');
        else if (p.name === 'exec') described = { kind: 'run', title: 'Ran a script', body: { command: clipEnds(p.input, 4000) } };
        else described = describeCall(p.name, args, cwd);
        out.push(log.upsert({ ...base, id: `${session}:${p.call_id}`, tool: p.name, ...described, status: 'running', startedAt: at }));
        setState('working', described.title);
        break;
      }
      case 'response_item/function_call_output':
      case 'response_item/custom_tool_call_output': {
        const id = `${session}:${p.call_id}`;
        const entry = log.get(id);
        if (!entry) break;
        const text = outputText(p.output);
        const failed = looksFailed(text);
        out.push(log.upsert({ id, status: failed ? 'failed' : 'ok', ms: entry.startedAt ? Math.max(0, at - entry.startedAt) : undefined, body: { output: clipEnds(text, 3000) } }));
        setState('thinking');
        break;
      }
      case 'response_item/web_search_call':
        out.push(log.upsert({ ...base, id: `${session}:${p.id}`, tool: 'web_search', kind: 'web', title: clip(p.action?.query ?? 'Web search', 80), status: 'ok' }));
        break;
      case 'event_msg/task_complete': {
        out.push(...log.settle(session));
        const error = p.error?.message;
        out.push(log.upsert({
          ...base, id: `${session}:s:${p.turn_id ?? at}`, kind: error ? 'error' : 'done', title: error ? clip(error, 160) : 'Finished', status: error ? 'failed' : 'ok', ms: p.duration_ms,
          summary: p.last_agent_message ? clipText(p.last_agent_message, 2000) : undefined,
        }));
        setState(error ? 'error' : 'done', error ? clip(error, 60) : 'Done!');
        break;
      }
    }
    if (out.length) emit(out);
  }

  async function poll() {
    for (const { path, size, mtime } of await recentFiles()) {
      let file = files.get(path);
      if (!file) files.set(path, (file = { offset: 0, partial: '' }));
      if (size <= file.offset) continue;
      const live = Date.now() - mtime < LIVE;
      let handle_;
      try {
        handle_ = await open(path, 'r');
        const { buffer, bytesRead } = await handle_.read(Buffer.alloc(size - file.offset), 0, size - file.offset, file.offset);
        file.offset += bytesRead;
        const lines = (file.partial + buffer.subarray(0, bytesRead).toString('utf8')).split('\n');
        file.partial = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try { handle(file, JSON.parse(line), live); } catch {}
        }
      } catch {} finally {
        await handle_?.close();
      }
    }
  }

  (async () => {
    while (!stopped) {
      try { await poll(); } catch {}
      await new Promise((r) => setTimeout(r, interval));
    }
  })();
  return () => { stopped = true; };
}
