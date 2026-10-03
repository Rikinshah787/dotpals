// Claude Code adapter.
//
//   Live:     hook events POSTed by bridge/hook.js (see hooks/hooks.json).
//   History:  the session transcript (`transcript_path` in every hook event), so
//             the feed has every tool call and file since the session began,
//             even if the pal was opened halfway through.
//   No hooks: watchClaude() follows every session's transcript, so sessions that
//             started before the plugin was installed show up too.
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { clip, clipEnds, clipText, folderName, relative, toPatch } from '../activity.js';

const HARNESS = 'claude';

// Paths are shown relative to the folder the session started in; the working
// directory can drift (e.g. after a `cd`), but the project root doesn't.
const roots = new Map(); // session → first cwd seen
const rootOf = (session, cwd) => {
  if (cwd && !roots.has(session)) roots.set(session, cwd);
  return roots.get(session) ?? cwd;
};

/** Messages Claude Code injects into the prompt stream that aren't really prompts. */
const notAPrompt = (text) => !text || /^\s*<(task-notification|agent-message|teammate-message|system-reminder|command-|local-command|user-prompt-submit-hook)/.test(text);

/** A prompt's text; slash commands (skills, plugin commands) read as "/name args". */
function promptText(text) {
  if (!text) return null;
  // IDE context the editor adds to the prompt ("the user opened file X"), not what the user typed.
  text = text.replace(/<(ide_[a-z_]+|system-reminder)>[\s\S]*?<\/\1>/g, '').trim();
  if (!text) return null;
  // Text the user pasted (Claude Code wraps it in <pasted_content id="…">): what they typed
  // leads, the paste is a "[pasted text]" placeholder after it. Only a paste: its first line.
  const PASTE = /<pasted_content\b[^>]*>([\s\S]*?)(?:<\/pasted_content\b[^>]*>|$)/g;
  if (/<pasted_content\b/.test(text)) {
    // Inside a paste, Claude Code escapes tags of its own (`<\pasted_content …>`), e.g. a
    // copied recap that had a paste in it. They and Markdown markers aren't worth a title.
    const tidy = (s) => s.replace(/<\\?\/?pasted_content\b[^>]*>/g, ' ').replace(/(^|\s)#{1,6}(?=\s)/g, '$1').replace(/^\s*(?:[-*•]|\d+\.)\s+/, '').replace(/\s+/g, ' ').trim();
    const typed = tidy(text.replace(PASTE, '\n'));
    const first = [...text.matchAll(PASTE)].map((m) => m[1]).join('\n').split('\n').map(tidy).find(Boolean);
    text = typed ? `${typed} [pasted text]` : `Pasted: ${first ?? 'some text'}`;
  }
  const cmd = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    return `${cmd[1].startsWith('/') ? '' : '/'}${cmd[1]}${args ? ` ${args}` : ''}`;
  }
  return notAPrompt(text) ? null : text;
}

/** Skip a prompt we already have (the live hook and the transcript both report it). */
const seenPrompt = (log, session, title, at) =>
  log.findLast(session, (x) => x.kind === 'prompt' && x.title === title && Math.abs(at - x.at) < 120_000);

/** What a Claude Code tool call did, as activity fields. */
export function describeTool(name = '', input = {}, cwd) {
  const file = input.file_path || input.notebook_path;
  const rel = (p) => relative(p, cwd);
  switch (name) {
    case 'Read':
      return { kind: 'read', title: rel(file), files: [{ path: file, change: 'read' }] };
    case 'Edit':
      return { kind: 'edit', title: rel(file), files: [{ path: file, change: 'edit' }], body: { patch: toPatch(input.old_string, input.new_string) } };
    case 'MultiEdit':
      return {
        kind: 'edit', title: rel(file), files: [{ path: file, change: 'edit' }],
        body: { patch: clipText((input.edits ?? []).map((e) => toPatch(e.old_string, e.new_string, 2000)).join('\n@@\n'), 6000) },
      };
    case 'NotebookEdit':
      return { kind: 'edit', title: rel(file), files: [{ path: file, change: 'edit' }], body: { patch: toPatch('', input.new_source) } };
    case 'Write':
      return { kind: 'write', title: rel(file), files: [{ path: file, change: 'write' }], body: { patch: toPatch('', input.content) } };
    case 'Bash': case 'PowerShell':
      return { kind: 'run', title: clip(input.description || input.command, 80), detail: clip(input.command, 160), body: { command: clipEnds(input.command, 4000) } };
    case 'Grep':
      return { kind: 'search', title: clip(input.pattern, 80), detail: [input.glob || input.type, rel(input.path)].filter(Boolean).join(' in ') };
    case 'Glob':
      return { kind: 'search', title: clip(input.pattern, 80), detail: rel(input.path) };
    case 'WebSearch':
      return { kind: 'web', title: clip(input.query, 80) };
    case 'WebFetch':
      return { kind: 'web', title: clip(input.url, 80), detail: clip(input.prompt, 160) };
    case 'Agent': case 'Task':
      return { kind: 'agent', title: clip(input.description || 'Subagent', 80), detail: input.subagent_type, body: { args: clipText(input.prompt, 3000) } };
    case 'Skill':
      return { kind: 'skill', title: clip(input.skill, 80), detail: clip(input.args, 160) };
    case 'TodoWrite':
      return {
        kind: 'plan', title: 'Updated the plan',
        plan: (input.todos ?? []).map((t) => ({ text: clip(t.content, 120), active: clip(t.activeForm, 120) || undefined, status: t.status })),
        body: { args: (input.todos ?? []).map((t) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '·'} ${t.content}`).join('\n') },
      };
    // Newer Claude Code keeps its plan as tasks, one at a time.
    case 'TaskCreate':
      return { kind: 'plan', title: clip(`Planned: ${input.subject ?? ''}`, 80), task: { op: 'create', text: clip(input.subject, 120), active: clip(input.activeForm, 120) || undefined } };
    case 'TaskUpdate':
      return { kind: 'plan', title: clip(`${input.status === 'completed' ? 'Finished' : input.status === 'in_progress' ? 'Started' : 'Updated'} task ${input.taskId ?? ''}`, 80), task: { op: 'update', id: String(input.taskId ?? ''), status: input.status, text: input.subject ? clip(input.subject, 120) : undefined } };
  }
  const args = clipText(JSON.stringify(input, null, 2), 3000);
  if (name.startsWith('mcp__')) {
    const [, server = '', tool = name] = name.split('__');
    return { kind: 'mcp', title: tool.replace(/_/g, ' '), detail: server.replace(/^claude_ai_/, '').replace(/_/g, ' '), body: { args } };
  }
  return { kind: 'tool', title: name, body: { args } };
}

/** A tool's result as text for the details panel (file contents aren't kept). */
function resultText(name, result) {
  if (result == null || name === 'Read' || name === 'Write') return undefined;
  if (typeof result === 'string') return clipEnds(result, 3000);
  // Command output keeps its start and its end, where test runners print their summary.
  if (Array.isArray(result)) return clipEnds(result.map((b) => b?.text ?? '').join('\n'), 3000);
  if (name === 'Bash' || name === 'PowerShell') {
    return clipEnds([result.stdout, result.stderr].filter(Boolean).join('\n'), 3000) || undefined;
  }
  if (name === 'Edit' || name === 'MultiEdit') return undefined;
  if (name === 'Grep' || name === 'Glob') {
    const files = result.filenames ?? [];
    return clipText(result.content || `${result.numFiles ?? files.length} files\n${files.join('\n')}`, 3000);
  }
  if (Array.isArray(result.content)) return clipEnds(result.content.map((b) => b?.text ?? '').join('\n'), 3000);
  return clipText(JSON.stringify(result, null, 2), 3000);
}

/**
 * Fold one Claude Code hook event into the log. Returns the changed entries.
 */
export function applyHook(e, log, { session, label }) {
  const at = Date.now();
  const base = { session, label, harness: HARNESS, at };
  const tool = e.tool_name;
  const id = e.tool_use_id ? `${session}:${e.tool_use_id}` : null;
  const changed = [];
  const add = (entry) => entry && changed.push(entry);

  switch (e.hook_event_name) {
    case 'UserPromptSubmit': {
      const text = promptText(e.prompt);
      if (!text) break;
      const title = clip(text, 300);
      // The transcript backfill may already have it.
      if (!seenPrompt(log, session, title, at)) add(log.upsert({ ...base, id: `${session}:p:${at}`, kind: 'prompt', title, status: 'info' }));
      break;
    }
    case 'PreToolUse':
      add(log.upsert({ ...base, id: id ?? `${session}:t:${at}`, tool, ...describeTool(tool, e.tool_input, rootOf(session, e.cwd)), status: 'running', startedAt: at }));
      break;
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const ok = e.hook_event_name === 'PostToolUse';
      const entry = (id && log.get(id)) || log.findLast(session, (x) => x.tool === tool && x.status === 'running');
      const output = resultText(tool, e.tool_response);
      add(log.upsert({
        ...base,
        id: entry?.id ?? id ?? `${session}:t:${at}`,
        tool,
        ...(entry ? {} : describeTool(tool, e.tool_input, rootOf(session, e.cwd))),
        status: ok ? 'ok' : 'failed',
        ...(entry?.startedAt ? { ms: at - entry.startedAt } : {}),
        ...(output ? { body: { output } } : {}),
        ...(!ok && e.error ? { error: clip(typeof e.error === 'string' ? e.error : e.error.message, 300) } : {}),
      }));
      break;
    }
    case 'PermissionRequest': {
      const entry = log.findLast(session, (x) => x.tool === tool && x.status === 'running');
      if (entry) add(log.upsert({ id: entry.id, status: 'waiting' }));
      break;
    }
    case 'PreCompact':
      add(log.upsert({ ...base, id: `${session}:c:${at}`, kind: 'compact', title: 'Compacting the conversation', status: 'info' }));
      break;
    case 'Stop': {
      const summary = typeof e.last_assistant_message === 'string' ? clipText(e.last_assistant_message, 2000) : undefined;
      add(log.upsert({ ...base, id: `${session}:s:${at}`, kind: 'done', title: 'Finished', status: 'ok', summary }));
      break;
    }
    case 'StopFailure':
      add(log.upsert({ ...base, id: `${session}:s:${at}`, kind: 'error', title: clip(e.error?.message ?? 'Something went wrong', 160), status: 'failed' }));
      break;
  }
  if (['Stop', 'StopFailure', 'SessionEnd'].includes(e.hook_event_name)) changed.unshift(...log.settle(session));
  return changed;
}

/**
 * Read transcript lines (JSONL) into the log. Entries use the same ids as the
 * hooks (`session:tool_use_id`), so nothing is shown twice. `reader.state` is
 * what the pal would show after the last line (for sessions without hooks).
 */
export function transcriptReader(log, { session, label }) {
  const starts = new Map(); // tool_use_id → { at, name }
  const reader = { state: null, at: 0, label };
  reader.line = (line) => {
    const changed = [];
    let o;
    try { o = JSON.parse(line); } catch { return changed; }
    if (o.isSidechain) return changed;
    const at = Date.parse(o.timestamp) || Date.now();
    if (o.cwd) { reader.label = label ?? folderName(o.cwd); reader.cwd ??= o.cwd; }
    const base = { session, label: reader.label, harness: HARNESS, at };
    const content = o.message?.content;
    const set = (state, text) => { reader.state = { state, ...(text ? { text } : {}) }; reader.at = at; };

    if (o.type === 'user' && !o.isMeta) {
      const raw = typeof content === 'string' ? content : Array.isArray(content) ? content.find((b) => b.type === 'text')?.text : null;
      const prompt = promptText(raw);
      if (prompt && !(Array.isArray(content) && content.some((b) => b.type === 'tool_result'))) {
        const title = clip(prompt, 300);
        if (!seenPrompt(log, session, title, at)) changed.push(log.upsert({ ...base, id: `${session}:u:${o.uuid}`, kind: 'prompt', title, status: 'info' }));
        set('thinking');
      }
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type !== 'tool_result') continue;
        const start = starts.get(block.tool_use_id);
        if (!start && !log.get(`${session}:${block.tool_use_id}`)) continue;
        const output = resultText(start?.name, o.toolUseResult ?? block.content);
        changed.push(log.upsert({
          id: `${session}:${block.tool_use_id}`,
          status: block.is_error ? 'failed' : 'ok',
          ...(start ? { ms: Math.max(0, at - start.at) } : {}),
          ...(output ? { body: { output } } : {}),
          ...(block.is_error ? { error: clip(typeof block.content === 'string' ? block.content : block.content?.[0]?.text, 300) } : {}),
        }));
        set('thinking');
      }
    }

    if (o.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use') {
          starts.set(block.id, { at, name: block.name });
          const described = describeTool(block.name, block.input, rootOf(session, o.cwd));
          changed.push(log.upsert({ ...base, id: `${session}:${block.id}`, tool: block.name, ...described, status: 'running', startedAt: at }));
          set('working', clip(described.title, 60));
        }
        // The reply that ends a turn: what Claude says it did.
        if (block.type === 'text' && o.message.stop_reason === 'end_turn') {
          changed.push(log.upsert({ ...base, id: `${session}:d:${o.uuid}`, kind: 'done', title: 'Finished', status: 'ok', summary: clipText(block.text, 2000) }));
          set('done', 'Done!');
        }
      }
    }
    return changed.filter(Boolean);
  };
  return reader;
}

/** Rebuild a session's history from its whole transcript. */
export async function backfillTranscript(path, log, ctx) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch { return []; }
  const reader = transcriptReader(log, ctx);
  return text.split('\n').flatMap((line) => (line ? reader.line(line) : []));
}

const RECENT = 3 * 60 * 60_000; // pick up sessions active in the last 3 hours
const LIVE = 30_000;             // written to in the last 30s: show it on the pal

/**
 * Follow every Claude Code session on this computer through its transcript
 * (~/.claude/projects/<project>/<session>.jsonl). Hooks give the richest live
 * view, but sessions that started before the plugin was installed (or with it
 * turned off) have none; this way they show up too.
 *
 * `skip(session)` is true for sessions the hooks already cover; `cwd(session, folder)`
 * hears the folder each session started in.
 */
/**
 * How full the context window is after an assistant reply: { used, size, known, at }.
 * Transcripts record tokens but not the window size. `size` is known when Claude
 * Code told the status line (`sizeOf`), or when usage is past 200k (so it must be
 * a 1M window). Otherwise it's a 200k guess, `known: false`.
 */
export function contextOf(o, sizeOf = () => null) {
  const u = o?.type === 'assistant' && !o.isSidechain ? o.message?.usage : null;
  if (!u) return null;
  const used = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  if (!used) return null;
  const told = sizeOf(o.sessionId);
  const size = told ?? (used > 200_000 ? 1_000_000 : 200_000);
  return { used, size, known: !!told || used > 200_000, at: Date.parse(o.timestamp) || Date.now() };
}

export function watchClaude(log, { emit, state, context = () => {}, cwd = () => {}, sizeOf, skip = () => false, dir = join(homedir(), '.claude', 'projects'), interval = 1500 } = {}) {
  const files = new Map(); // path → { offset, partial, reader, context }
  let stopped = false;

  async function recentFiles() {
    const found = [];
    const now = Date.now();
    let projects = [];
    try { projects = await readdir(dir, { withFileTypes: true }); } catch { return found; }
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      let names = [];
      try { names = await readdir(join(dir, p.name)); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const path = join(dir, p.name, name);
        try {
          const s = await stat(path);
          if (now - s.mtimeMs < RECENT || files.has(path)) found.push({ path, size: s.size, mtime: s.mtimeMs });
        } catch {}
      }
    }
    return found;
  }

  async function poll() {
    const now = Date.now();
    for (const { path, size, mtime } of await recentFiles()) {
      const session = basename(path, '.jsonl');
      let file = files.get(path);
      if (!file) files.set(path, (file = { offset: 0, partial: '', reader: transcriptReader(log, { session }) }));
      const live = now - mtime < LIVE;
      if (size > file.offset) {
        let fh;
        try {
          fh = await open(path, 'r');
          const { buffer, bytesRead } = await fh.read(Buffer.alloc(size - file.offset), 0, size - file.offset, file.offset);
          file.offset += bytesRead;
          const lines = (file.partial + buffer.subarray(0, bytesRead).toString('utf8')).split('\n');
          file.partial = lines.pop();
          // Context window (for every session, hooks or not): the newest reply's usage.
          for (let i = lines.length - 1; i >= 0; i--) {
            if (!lines[i].includes('"usage"')) continue;
            let o;
            try { o = JSON.parse(lines[i]); } catch { continue; }
            const ctx = contextOf(o, sizeOf);
            if (!ctx) continue;
            if (o.cwd) file.reader.label ??= folderName(o.cwd);
            if (ctx.used !== file.context?.used) context(session, file.reader.label ?? folderName(o.cwd), (file.context = ctx));
            break;
          }
          if (skip(session)) continue; // the hooks have it
          if (file.reader.cwd) cwd(session, file.reader.cwd);
          const out = lines.flatMap((line) => (line.trim() ? file.reader.line(line) : []));
          if (out.length) emit(out);
          // Also by the event's own time: on Windows a transcript that's still open reports a stale mtime.
          if ((live || Date.now() - (file.reader.at ?? 0) < LIVE) && file.reader.state) state(session, file.reader.label, file.reader.state, file.reader.at);
        } catch {} finally {
          await fh?.close();
        }
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

/**
 * Claude's closing message for the turn that just ended, from the end of the
 * transcript. Only messages after `since` count, so an unflushed transcript
 * doesn't hand back the previous turn's reply.
 */
export async function lastReply(path, since = 0) {
  let fh;
  try {
    fh = await open(path, 'r');
    const { size } = await fh.stat();
    const length = Math.min(size, 512 * 1024);
    const { buffer } = await fh.read(Buffer.alloc(length), 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let o;
      try { o = JSON.parse(lines[i]); } catch { continue; }
      if (o.type !== 'assistant' || o.isSidechain) continue;
      if ((Date.parse(o.timestamp) || 0) < since) return null;
      const text = (o.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (text) return clipText(text, 2000);
    }
  } catch {} finally {
    await fh?.close();
  }
  return null;
}
