// GitHub Copilot CLI adapter: Copilot CLI's hooks
// (https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference).
//
// Connect writes ~/.copilot/hooks/dotpals.json (or $COPILOT_HOME/hooks), a file
// of its own, so your other hooks are never touched. Each event runs
// `node ".../bridge/hook.js" copilot <event>`: Copilot's payloads don't name
// their event, so the command does. Only hooks that watch are used; preToolUse
// is left alone because it can block tools.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { clip, clipEnds, clipText, folderName, relative, toPatch } from '../activity.js';
import { hookCommand, isOurs, readJson, removeOwnFile, writeOwnFile } from './setup.js';

const ID = 'copilot';
export const EVENTS = ['sessionStart', 'userPromptSubmitted', 'postToolUse', 'postToolUseFailure', 'notification', 'errorOccurred', 'agentStop', 'sessionEnd'];

const dir = () => process.env.DOTPALS_COPILOT_DIR || process.env.COPILOT_HOME || join(homedir(), '.copilot');
const file = () => join(dir(), 'hooks', 'dotpals.json');
const MARKER = 'bridge/hook.js';

// The docs name the tools but only show `command` among their arguments, so
// anything else is read carefully and shown as-is. The CLI's own code names the
// file tools' text: edit { path, old_str, new_str }, create { path, file_text }.
const KIND = { bash: 'run', powershell: 'run', view: 'read', create: 'write', edit: 'edit', grep: 'search', rg: 'search', glob: 'search', web_fetch: 'web', web_search: 'web', task: 'agent', update_todo: 'plan' };

const parse = (v) => { if (typeof v !== 'string') return v ?? {}; try { return JSON.parse(v); } catch { return { value: v }; } };

/** What a Copilot CLI tool call did. */
export function describeTool(name = '', raw = {}, cwd) {
  const args = parse(raw);
  const kind = KIND[name] ?? 'tool';
  const path = [args.path, args.file_path, args.filePath].find((p) => typeof p === 'string');
  const body = { args: clipText(JSON.stringify(args, null, 2), 3000) };
  if (kind === 'run') return { kind, title: clip(args.description || args.command, 80), detail: args.description ? clip(args.command, 160) : undefined, body: { command: clipEnds(args.command, 4000) } };
  if (path && (kind === 'read' || kind === 'write' || kind === 'edit')) {
    // What an edit took out and put in, as for the other agents (so a weakened test shows).
    const patch = kind === 'edit' && typeof args.old_str === 'string' && typeof args.new_str === 'string' ? toPatch(args.old_str, args.new_str)
      : kind === 'write' && typeof args.file_text === 'string' ? toPatch('', args.file_text) : null;
    return { kind, title: relative(path, cwd), files: [{ path, change: kind }], body: patch ? { patch } : body };
  }
  const what = [args.pattern, args.query, args.url, args.description].find((v) => typeof v === 'string');
  return { kind, title: clip(what || name.replace(/_/g, ' '), 80), body };
}

/**
 * Fold one Copilot CLI hook event into the log.
 * Returns { entries, session, label, state? }.
 */
export function applyCopilot(e, log) {
  if (!e.sessionId) return { entries: [] };
  const session = `copilot:${e.sessionId}`;
  const label = folderName(e.cwd);
  const at = Number(e.timestamp) || Date.parse(e.timestamp) || Date.now();
  const base = { session, label, harness: ID, at };
  const out = { entries: [], session, label };
  const add = (entry) => out.entries.push(log.upsert(entry));
  const n = (applyCopilot.n = (applyCopilot.n ?? 0) + 1);

  switch (e.hook_event_name) {
    case 'sessionStart':
      out.state = { state: 'idle' };
      break;
    case 'userPromptSubmitted': {
      const title = clip(e.prompt, 300);
      if (title) add({ ...base, id: `${session}:u:${at}`, kind: 'prompt', title, status: 'info' });
      out.state = { state: 'thinking' };
      break;
    }
    case 'postToolUse':
    case 'postToolUseFailure': {
      const failed = e.hook_event_name === 'postToolUseFailure' || (e.toolResult?.resultType && e.toolResult.resultType !== 'success');
      const described = describeTool(e.toolName, e.toolArgs, e.cwd);
      const output = e.toolResult?.textResultForLlm;
      // Still running after its wait ("<command with shellId: 3 is still running after 30 seconds. …>"):
      // not a result yet. If nothing says how it ended, the turn's end marks it stopped.
      const running = described.kind === 'run' && /<command with shellId: \S+ is still running after\b/.test(output ?? '');
      add({
        ...base, id: `${session}:t:${at}-${n}`, tool: e.toolName, ...described, status: failed ? 'failed' : running ? 'running' : 'ok',
        error: failed ? clip(typeof e.error === 'string' ? e.error : e.error?.message ?? output, 300) || undefined : undefined,
        body: { ...described.body, output: clipEnds(output, 3000) || undefined },
      });
      out.state = { state: 'working', text: clip(described.title, 40) };
      break;
    }
    case 'notification':
      if (e.notification_type === 'permission_prompt') out.state = { state: 'waiting', text: clip(e.message || 'Needs your OK', 60) };
      break;
    case 'errorOccurred':
      if (e.recoverable) break;
      out.entries.push(...log.settle(session));
      add({ ...base, id: `${session}:s:${at}`, kind: 'error', title: clip(e.error?.message || 'Stopped with an error', 160), status: 'failed' });
      out.state = { state: 'error', text: clip(e.error?.message || 'Something went wrong', 60) };
      break;
    case 'agentStop': {
      out.entries.push(...log.settle(session));
      const prompt = log.findLast(session, (x) => x.kind === 'prompt');
      const end = log.findLast(session, (x) => x.kind === 'error');
      if (end && prompt && end.at >= prompt.at) break; // already ended with an error
      add({ ...base, id: `${session}:s:${at}`, kind: 'done', title: 'Finished', status: 'ok', ms: prompt ? Math.max(0, at - prompt.at) : undefined });
      out.state = { state: 'done', text: 'Done!' };
      break;
    }
    case 'sessionEnd':
      out.entries.push(...log.settle(session));
      out.state = { state: 'sleeping' };
      break;
  }
  return out;
}

function installed() {
  try {
    const hooks = readJson(file()).hooks ?? {};
    return hooks.sessionStart?.find?.((h) => isOurs(h?.command, ID))?.command ?? null;
  } catch { return null; }
}

export default {
  id: ID,
  name: 'GitHub Copilot CLI',
  via: 'Hooks (~/.copilot/hooks)',
  how: 'Connect adds a hooks file of its own to Copilot CLI. It runs after each prompt and tool call and when the agent stops.',
  docs: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference',
  setup: 'connect',
  file,
  detect: () => ({ found: existsSync(dir()), where: dir() }),
  connected: () => !!installed(),
  command: () => installed(),
  connect() {
    const hooks = Object.fromEntries(EVENTS.map((event) => [event, [{ type: 'command', command: `${hookCommand(ID)} ${event}`, timeoutSec: 5 }]]));
    writeOwnFile(file(), `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`, MARKER);
    return { file: file(), backup: existsSync(`${file()}.dotpals-backup`) ? `${file()}.dotpals-backup` : null, command: hooks.sessionStart[0].command };
  },
  disconnect() {
    removeOwnFile(file(), MARKER);
    return { file: file() };
  },
  apply: applyCopilot,
  sample: (token) => ({ sessionId: token, timestamp: Date.now(), cwd: '', source: 'new' }),
};
