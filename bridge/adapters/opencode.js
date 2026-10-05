// OpenCode adapter: a small OpenCode plugin (https://opencode.ai/docs/plugins/).
//
// Connect writes plugins/dotpals.js into OpenCode's global config folder
// (~/.config/opencode, or $XDG_CONFIG_HOME/opencode); OpenCode loads every file
// there when it starts. The plugin runs inside OpenCode and posts what it sees
// to POST /hook?agent=opencode, where applyOpenCode() turns it into activity.
// The plugin stays dumb on purpose: the reading happens here, so it can improve
// without reconnecting.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clip, clipEnds, clipText, folderName, relative, toPatch } from '../activity.js';
import { describeCall } from './codex.js';
import { removeOwnFile, writeOwnFile } from './setup.js';

const ID = 'opencode';
const MARKER = 'dotpals-opencode-plugin';

const dir = () => process.env.DOTPALS_OPENCODE_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode');
const file = () => join(dir(), 'plugins', 'dotpals.js');

/**
 * The plugin. OpenCode loads every export as a plugin, so it exports exactly one
 * function. Nothing in it may throw: a throw in tool.execute.before blocks the tool.
 */
export const PLUGIN = `// ${MARKER}
// Shows what OpenCode does in dotpals (a floating pal and a dashboard).
// Added by the dotpals dashboard: Agents → OpenCode → Connect. Disconnect removes it.
// Nothing here changes what OpenCode does; it only reports to http://127.0.0.1:5175.
export const DotpalsPlugin = async ({ directory, worktree } = {}, options) => {
  const url = (options && options.url) || (globalThis.process && process.env.DOTPALS_URL) || "http://127.0.0.1:5175/hook"
  const cwd = worktree || directory || ""
  const texts = new Map() // session → the latest text it wrote
  const cut = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n) : s)
  // A command's output keeps its start and its end: test runners print their summary last.
  const ends = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n / 2) + "\\n… (" + (s.length - n) + " characters cut) …\\n" + s.slice(-n / 2) : s)
  const send = (body) => {
    try {
      fetch(url + (url.includes("?") ? "&" : "?") + "agent=opencode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, cwd, at: Date.now() }),
        signal: AbortSignal.timeout(1000),
      }).catch(() => {})
    } catch {}
  }
  const EVENTS = ["session.created", "session.idle", "session.error", "session.compacted", "permission.asked", "permission.replied"]
  return {
    "chat.message": async (input, output) => {
      try {
        const text = (output.parts || []).filter((p) => p.type === "text" && !p.synthetic && !p.ignored).map((p) => p.text).join("\\n")
        send({ type: "prompt", sessionID: input.sessionID, text: cut(text, 4000) })
      } catch {}
    },
    "tool.execute.before": async (input, output) => {
      try { send({ type: "tool.before", tool: input.tool, sessionID: input.sessionID, callID: input.callID, args: output.args }) } catch {}
    },
    "tool.execute.after": async (input, output) => {
      // metadata.exit: how a bash command exited (null when it was stopped or timed out).
      try { send({ type: "tool.after", tool: input.tool, sessionID: input.sessionID, callID: input.callID, title: output.title, output: ends(output.output, 6000), exit: (output.metadata || {}).exit }) } catch {}
    },
    event: async ({ event }) => {
      try {
        const p = event.properties || {}
        if (event.type === "message.part.updated" && p.part) {
          if (p.part.type === "text" && !p.part.synthetic && p.sessionID) texts.set(p.sessionID, p.part.text)
          if (p.part.type === "tool" && p.part.state && p.part.state.status === "error") {
            send({ type: "tool.error", sessionID: p.sessionID || p.part.sessionID, callID: p.part.callID, tool: p.part.tool, error: cut(String(p.part.state.error || ""), 2000) })
          }
          return
        }
        if (!EVENTS.includes(event.type)) return
        const reply = event.type === "session.idle" ? texts.get(p.sessionID) : undefined
        if (event.type === "session.idle") texts.delete(p.sessionID)
        send({ type: "event", event: { type: event.type, properties: { sessionID: p.sessionID, error: p.error, permission: p.permission, reply: p.reply } }, reply: cut(reply, 4000) })
      } catch {}
    },
  }
}
`;

/** What an OpenCode tool call did (opencode.ai/docs/tools, argument names from its source). */
export function describeTool(name = '', args = {}, cwd) {
  const rel = (p) => relative(p, cwd);
  const file = args.filePath;
  switch (name) {
    case 'bash':
      return { kind: 'run', title: clip(args.description || args.command, 80), detail: args.description ? clip(args.command, 160) : rel(args.workdir) || undefined, body: { command: clipEnds(args.command, 4000) } };
    case 'read':
      return { kind: 'read', title: rel(file), files: file ? [{ path: file, change: 'read' }] : undefined };
    case 'edit':
      return { kind: 'edit', title: rel(file), files: [{ path: file, change: 'edit' }], body: { patch: toPatch(args.oldString, args.newString) } };
    case 'write':
      return { kind: 'write', title: rel(file), files: [{ path: file, change: 'write' }], body: { patch: toPatch('', args.content) } };
    case 'apply_patch':
      return describeCall('apply_patch', { input: args.patchText }, cwd);
    case 'grep': case 'glob':
      return { kind: 'search', title: clip(args.pattern, 80), detail: [args.include, rel(args.path)].filter(Boolean).join(' in ') || undefined };
    case 'webfetch':
      return { kind: 'web', title: clip(args.url, 80) };
    case 'websearch':
      return { kind: 'web', title: clip(args.query, 80) };
    case 'task':
      return { kind: 'agent', title: clip(args.description || 'Subagent', 80), detail: args.subagent_type, body: { args: clipText(args.prompt, 3000) } };
    case 'skill':
      return { kind: 'skill', title: clip(args.name, 80) };
    case 'todowrite':
      return {
        kind: 'plan', title: 'Updated the plan',
        plan: (args.todos ?? []).filter((t) => t.status !== 'cancelled').map((t) => ({ text: String(t.content ?? ''), status: ['completed', 'in_progress'].includes(t.status) ? t.status : 'pending' })),
        body: { args: (args.todos ?? []).map((t) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '·'} ${t.content}`).join('\n') },
      };
  }
  return { kind: 'tool', title: name.replace(/_/g, ' '), body: { args: clipText(JSON.stringify(args, null, 2), 3000) } };
}

/**
 * Fold one message from the plugin into the log.
 * Returns { entries, session, label, state? }.
 */
export function applyOpenCode(e, log) {
  const sid = e.sessionID ?? e.event?.properties?.sessionID;
  if (!sid) return { entries: [] };
  const session = `opencode:${sid}`;
  const label = folderName(e.cwd);
  const at = Number(e.at) || Date.now();
  const base = { session, label, harness: ID, at };
  const out = { entries: [], session, label };
  const add = (entry) => out.entries.push(log.upsert(entry));

  switch (e.type) {
    case 'prompt': {
      const title = clip(e.text, 300);
      if (title) add({ ...base, id: `${session}:u:${at}`, kind: 'prompt', title, status: 'info' });
      out.state = { state: 'thinking' };
      break;
    }
    case 'tool.before': {
      const described = describeTool(e.tool, e.args ?? {}, e.cwd);
      add({ ...base, id: `${session}:${e.callID}`, tool: e.tool, ...described, status: 'running', startedAt: at });
      out.state = { state: 'working', text: clip(described.title, 40) };
      break;
    }
    case 'tool.after': {
      const id = `${session}:${e.callID}`;
      const known = log.get(id);
      // The bash tool's exit code (plugins written before it was sent have none): null is stopped or timed out.
      const status = e.exit === null ? 'stopped' : typeof e.exit === 'number' && e.exit !== 0 ? 'failed' : 'ok';
      if (known) add({ id, status, ms: known.startedAt ? Math.max(0, at - known.startedAt) : undefined, body: { output: clipEnds(e.output, 3000) || undefined } });
      else add({ ...base, id, tool: e.tool, ...describeTool(e.tool, {}, e.cwd), title: clip(e.title || e.tool, 80), status, body: { output: clipEnds(e.output, 3000) || undefined } });
      out.state = { state: 'thinking' };
      break;
    }
    case 'tool.error':
      if (e.callID) add({ ...base, id: `${session}:${e.callID}`, tool: e.tool, status: 'failed', error: clip(e.error, 300) || undefined });
      break;
    case 'event': {
      const p = e.event?.properties ?? {};
      switch (e.event?.type) {
        case 'session.created':
          out.state = { state: 'idle' };
          break;
        case 'permission.asked': {
          const waiting = log.findLast(session, (x) => x.status === 'running');
          if (waiting) add({ id: waiting.id, status: 'waiting' });
          out.state = { state: 'waiting', text: clip(p.permission ? `Allow ${p.permission}?` : 'Needs your OK', 60) };
          break;
        }
        case 'permission.replied':
          out.state = { state: 'working' };
          break;
        case 'session.compacted':
          add({ ...base, id: `${session}:c:${at}`, kind: 'compact', title: 'Tidied up its memory', status: 'info' });
          break;
        case 'session.error': {
          out.entries.push(...log.settle(session));
          const message = p.error?.data?.message ?? p.error?.message ?? p.error?.name;
          add({ ...base, id: `${session}:s:${at}`, kind: 'error', title: clip(message || 'Stopped with an error', 160), status: 'failed' });
          out.state = { state: 'error', text: clip(message || 'Something went wrong', 60) };
          break;
        }
        case 'session.idle': {
          // Idle after a turn: close it. Idle with nothing new since the last close: just rest.
          const prompt = log.findLast(session, (x) => x.kind === 'prompt');
          const end = log.findLast(session, (x) => x.kind === 'done' || x.kind === 'error');
          if (!prompt || (end && end.at >= prompt.at)) { out.state = { state: 'idle' }; break; }
          out.entries.push(...log.settle(session));
          add({ ...base, id: `${session}:s:${at}`, kind: 'done', title: 'Finished', status: 'ok', ms: Math.max(0, at - prompt.at), summary: e.reply ? clipText(e.reply, 2000) : undefined });
          out.state = { state: 'done', text: 'Done!' };
          break;
        }
      }
      break;
    }
  }
  return out;
}

const installed = () => existsSync(file()) && readFileSync(file(), 'utf8').includes(MARKER);

export default {
  id: ID,
  name: 'OpenCode',
  via: 'Plugin (~/.config/opencode/plugins)',
  how: 'Connect adds a small plugin to OpenCode’s plugins folder. It reports each prompt, tool call and finished turn. Restart OpenCode to load it.',
  docs: 'https://opencode.ai/docs/plugins/',
  setup: 'connect',
  file,
  detect: () => ({ found: existsSync(dir()), where: dir() }),
  connected: installed,
  connect() {
    writeOwnFile(file(), PLUGIN, MARKER);
    return { file: file(), backup: existsSync(`${file()}.dotpals-backup`) ? `${file()}.dotpals-backup` : null, note: 'Restart OpenCode to load the plugin.' };
  },
  disconnect() {
    removeOwnFile(file(), MARKER);
    return { file: file() };
  },
  apply: applyOpenCode,
  /** Load the installed plugin and have it report a new session, as OpenCode would. */
  async probe({ url, token }) {
    const mod = await import(`${pathToFileURL(file()).href}?t=${Date.now()}`);
    const hooks = await mod.DotpalsPlugin({ directory: '', worktree: '' }, { url });
    await hooks.event({ event: { type: 'session.created', properties: { sessionID: token } } });
  },
};
