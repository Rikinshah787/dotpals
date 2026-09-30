// Claude Code adapter.
//
//   Live:     hook events POSTed by bridge/hook.js (see hooks/hooks.json).
//   History:  the session transcript (`transcript_path` in every hook event), so
//             the feed has every tool call and file since the session began,
//             even if the pal was opened halfway through.
import { open, readFile } from 'node:fs/promises';
import { clip, clipText, folderName, relative, toPatch } from '../activity.js';

const HARNESS = 'claude';

// Paths are shown relative to the folder the session started in; the working
// directory can drift (e.g. after a `cd`), but the project root doesn't.
const roots = new Map(); // session → first cwd seen
const rootOf = (session, cwd) => {
  if (cwd && !roots.has(session)) roots.set(session, cwd);
  return roots.get(session) ?? cwd;
};

/** Messages Claude Code injects into the prompt stream that aren't really prompts. */
const notAPrompt = (text) => !text || /^\s*<(task-notification|system-reminder|command-|local-command|user-prompt-submit-hook)/.test(text);

/** A prompt's text; slash commands (skills, plugin commands) read as "/name args". */
function promptText(text) {
  if (!text) return null;
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
      return { kind: 'run', title: clip(input.description || input.command, 80), detail: clip(input.command, 160), body: { command: clipText(input.command, 3000) } };
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
      return { kind: 'plan', title: 'Updated the plan', body: { args: (input.todos ?? []).map((t) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '·'} ${t.content}`).join('\n') } };
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
  if (typeof result === 'string') return clipText(result, 3000);
  if (Array.isArray(result)) return clipText(result.map((b) => b?.text ?? '').join('\n'), 3000);
  if (name === 'Bash' || name === 'PowerShell') {
    return clipText([result.stdout, result.stderr].filter(Boolean).join('\n'), 3000) || undefined;
  }
  if (name === 'Edit' || name === 'MultiEdit') return undefined;
  if (name === 'Grep' || name === 'Glob') {
    const files = result.filenames ?? [];
    return clipText(result.content || `${result.numFiles ?? files.length} files\n${files.join('\n')}`, 3000);
  }
  if (Array.isArray(result.content)) return clipText(result.content.map((b) => b?.text ?? '').join('\n'), 3000);
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
 * Rebuild a session's history from its transcript (JSONL). Entries use the same
 * ids as the hooks (`session:tool_use_id`), so nothing is shown twice.
 */
export async function backfillTranscript(path, log, { session, label }) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch { return []; }
  const changed = [];
  const starts = new Map(); // tool_use_id → { at, name }

  for (const line of text.split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const at = Date.parse(o.timestamp) || Date.now();
    const base = { session, label: label ?? folderName(o.cwd), harness: HARNESS, at };
    const content = o.message?.content;

    if (o.type === 'user' && !o.isMeta && !o.isSidechain) {
      const raw = typeof content === 'string' ? content : Array.isArray(content) ? content.find((b) => b.type === 'text')?.text : null;
      const prompt = promptText(raw);
      if (prompt && !(Array.isArray(content) && content.some((b) => b.type === 'tool_result'))) {
        const title = clip(prompt, 300);
        if (!seenPrompt(log, session, title, at)) changed.push(log.upsert({ ...base, id: `${session}:u:${o.uuid}`, kind: 'prompt', title, status: 'info' }));
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
      }
    }

    if (o.type === 'assistant' && Array.isArray(content) && !o.isSidechain) {
      for (const block of content) {
        if (block.type === 'tool_use') {
          starts.set(block.id, { at, name: block.name });
          changed.push(log.upsert({ ...base, id: `${session}:${block.id}`, tool: block.name, ...describeTool(block.name, block.input, rootOf(session, o.cwd)), status: 'running', startedAt: at }));
        }
        // The reply that ends a turn: what Claude says it did.
        if (block.type === 'text' && o.message.stop_reason === 'end_turn') {
          changed.push(log.upsert({ ...base, id: `${session}:d:${o.uuid}`, kind: 'done', title: 'Finished', status: 'ok', summary: clipText(block.text, 2000) }));
        }
      }
    }
  }
  return changed.filter(Boolean);
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
