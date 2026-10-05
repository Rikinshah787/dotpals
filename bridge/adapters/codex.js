// Codex adapter: follows Codex's session logs (~/.codex/sessions/**/rollout-*.jsonl),
// so Codex CLI, the Codex IDE extension and the Codex app all show up with
// nothing to install on the Codex side. Set DOTPALS_CODEX=0 to turn it off.
//
// The fix loop (Make agents fix failing tests) needs Codex's hooks, which can answer:
// `codexHooks.connect()` adds `node ".../bridge/loop-hook.js" codex` to ~/.codex/hooks.json
// for the events below, and Codex asks you to trust it once (/hooks in Codex).
import { existsSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { clip, clipEnds, clipText, folderName, relative, toPatch } from '../activity.js';
import { backup, backupPath, isOurLoop, loopCommand, readJson, writeJson } from './setup.js';

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

/**
 * The commands a code-mode script runs: `tools.exec_command({"cmd":"npm test", …})`.
 * Only commands written out as a string; one built at run time can't be read.
 */
function scriptCommands(code = '') {
  const cmds = [];
  for (const m of String(code).matchAll(/tools\.exec_command\(\s*\{\s*(?:"cmd"|'cmd'|cmd)\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
    try { cmds.push(JSON.parse(m[1])); } catch {}
  }
  return cmds;
}

/** Codex puts context (AGENTS.md, environment…) in user messages too; those aren't prompts. */
const isPrompt = (text) => !!text?.trim() && !/^\s*(<[a-z_]+>|# AGENTS\.md|<INSTRUCTIONS>)/i.test(text);

const outputText = (output) =>
  typeof output === 'string' ? output : Array.isArray(output) ? output.map((b) => b?.text ?? '').join('\n') : output?.content ?? JSON.stringify(output ?? '');

/** Guess failure from a tool's output ("Process exited with code 1", "error: …"). */
const looksFailed = (text) => /exit(?:ed)?(?: with)? code:? ?-?[1-9]\d*|^\s*(error|fatal)\b/im.test(text) && !/exit(?:ed)?(?: with)? code:? ?0\b/i.test(text);

/**
 * How a tool call ended, from what Codex sent back: 'stopped' when you interrupted it
 * ("aborted by user", a script "terminated"), 'failed' for a patch that didn't apply
 * ("apply_patch verification failed: …"), a script that threw ("Script failed") or a
 * non-zero exit, else 'ok'.
 */
const outcome = (text) => (/^(?:Wall time:[^\n]*\n)?aborted by user\b|^Script terminated\b/.test(text) ? 'stopped'
  : /^(?:apply_patch verification failed|Script failed)\b/.test(text) || looksFailed(text) ? 'failed' : 'ok');

/**
 * A command (exec_command) or script (exec) that outlived its wait: Codex says it's still
 * running and checks on it later (write_stdin with the process's session ID, or wait with
 * the cell ID), where the rest of its output and its exit code arrive. → 'Process:73606'.
 */
const stillRunning = (text) => {
  const m = text.split(/\nOutput:/)[0].match(/^(Process|Script) running with (?:session|cell) ID (\d+)/m);
  return m ? `${m[1]}:${m[2]}` : null;
};

/**
 * Follow Codex's logs. Calls `emit(entries)` for activity,
 * `state(session, label, { state, text }, at)` for the pal, and `cwd(session, folder, parent?)`
 * when a session's project folder (and, for a helper, the session that started it) is known.
 */
export function watchCodex(log, { emit, state, context = () => {}, cwd: noteCwd = () => {}, dir = join(homedir(), '.codex', 'sessions'), interval = 1000 } = {}) {
  // path → { offset, session, label, cwd, partial, running: (still-running process or cell → entry id), follow: (call id of a check on one → { id, interrupt }) }
  const files = new Map();
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
    // Judged by the event's own time: on Windows a log Codex keeps open reports a stale mtime.
    const setState = (s, text) => (live || Date.now() - at < LIVE) && state(session, label, { state: s, ...(text ? { text } : {}) }, at);

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
        let args = {};
        if (kind.endsWith('/function_call')) { try { args = JSON.parse(p.arguments || '{}'); } catch {} }
        else args = { input: p.input };
        // Checking on a command still running from an earlier call: what it says belongs to that call.
        const key = p.name === 'write_stdin' ? `Process:${args.session_id}` : p.name === 'wait' ? `Script:${args.cell_id}` : null;
        const earlier = key && log.get(file.running.get(key));
        if (earlier) {
          file.running.delete(key);
          file.follow.set(p.call_id, { id: earlier.id, interrupt: String(args.chars ?? '').includes('\u0003') });
          setState('working', earlier.title);
          break;
        }
        if (QUIET_TOOLS.has(p.name)) break;
        let described;
        const scripted = p.name === 'exec' ? patchFromScript(p.input) : null;
        const cmds = p.name === 'exec' && !scripted ? scriptCommands(p.input) : [];
        if (scripted) described = describePatch(scripted, cwd, 'apply_patch');
        // A script that runs commands: the commands are what it did (a test run reads as one). How
        // they exited isn't in the log unless the script prints it, so its output has to tell.
        else if (cmds.length) described = { kind: 'run', title: clip(cmds.join('; '), 80), exitUnknown: true, body: { command: clipEnds(cmds.join('\n'), 4000), args: clipEnds(p.input, 4000) } };
        else if (p.name === 'exec') described = { kind: 'run', title: 'Ran a script', body: { command: clipEnds(p.input, 4000) } };
        else described = describeCall(p.name, args, cwd);
        out.push(log.upsert({ ...base, id: `${session}:${p.call_id}`, tool: p.name, ...described, status: 'running', startedAt: at }));
        setState('working', described.title);
        break;
      }
      case 'response_item/function_call_output':
      case 'response_item/custom_tool_call_output': {
        // A check on a running command reports for that command: its output adds to what it said before.
        const follow = file.follow.get(p.call_id);
        file.follow.delete(p.call_id);
        const id = follow?.id ?? `${session}:${p.call_id}`;
        const entry = log.get(id);
        if (!entry) break;
        const text = outputText(p.output);
        const output = clipEnds(follow ? `${entry.body?.output ?? ''}\n${text}` : text, 3000);
        const still = stillRunning(text);
        if (still) {
          // Not finished: it keeps running until a later check says how it ended.
          file.running.set(still, id);
          out.push(log.upsert({ id, body: { output } }));
        } else {
          // Stopped with Ctrl-C (sent as input): it didn't finish, whatever the exit code says.
          let status = follow?.interrupt ? 'stopped' : outcome(text);
          // A script printed its commands' results whole (`text(JSON.stringify(r))`): their exit codes count.
          let exitUnknown;
          const codes = entry.exitUnknown && status !== 'stopped' ? [...text.matchAll(/"exit_code":(-?\d+)/g)].map((m) => Number(m[1])) : [];
          if (codes.length && codes.length >= scriptCommands(entry.body?.args).length) {
            exitUnknown = false;
            status = codes.some((c) => c !== 0) ? 'failed' : 'ok';
          }
          out.push(log.upsert({ id, status, exitUnknown, ms: entry.startedAt ? Math.max(0, at - entry.startedAt) : undefined, body: { output } }));
        }
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
      // You stopped it (Esc): the turn ends here, unfinished.
      case 'event_msg/turn_aborted':
        out.push(...log.settle(session));
        out.push(log.upsert({ ...base, id: `${session}:s:${p.turn_id ?? at}`, kind: 'done', title: 'Stopped', status: 'stopped', ms: p.duration_ms }));
        setState('done', 'Stopped');
        break;
    }
    if (out.length) emit(out);
  }

  async function poll() {
    for (const { path, size, mtime } of await recentFiles()) {
      let file = files.get(path);
      if (!file) files.set(path, (file = { offset: 0, partial: '', running: new Map(), follow: new Map() }));
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

  // One read at a time: two at once would read the same lines twice.
  let reading = Promise.resolve();
  const readNow = () => (reading = reading.then(poll).catch(() => {}));
  (async () => {
    while (!stopped) {
      await readNow();
      await new Promise((r) => setTimeout(r, interval));
    }
  })();
  const stop = () => { stopped = true; };
  /** Read what Codex logged since the last look, now (the fix loop, before it judges). */
  stop.poll = readNow;
  return stop;
}

// -- The fix loop's hook in ~/.codex/hooks.json -----------------------------------------------
// Codex's hooks answer the way Claude Code's do: after a test run (PostToolUse) Codex can be told
// why it failed, Stop can send it back, and PreToolUse can hold back a commit. UserPromptSubmit
// starts a new request, so the loop counts again. Timeouts are in seconds.
const LOOP_EVENTS = {
  UserPromptSubmit: { timeout: 5 },
  PreToolUse: { matcher: '^Bash$', timeout: 5 },
  PostToolUse: { matcher: '^Bash$', timeout: 10 },
  Stop: { timeout: 10 },
};
const codexHome = () => process.env.DOTPALS_CODEX_HOME || join(homedir(), '.codex');
const hooksFile = () => join(codexHome(), 'hooks.json');

/** Our command in a hooks.json object, if it's there. */
function ourLoop(config) {
  for (const groups of Object.values(config.hooks ?? {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      const ours = (Array.isArray(g?.hooks) ? g.hooks : []).find((h) => isOurLoop(h?.command, HARNESS));
      if (ours) return ours.command;
    }
  }
  return null;
}

/** Remove our hooks from a hooks.json object, and groups left empty; true if anything changed. */
function stripLoop(config) {
  let changed = false;
  for (const [event, groups] of Object.entries(config.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.flatMap((g) => {
      if (!Array.isArray(g?.hooks)) return [g];
      const hooks = g.hooks.filter((h) => !isOurLoop(h?.command, HARNESS));
      if (hooks.length === g.hooks.length) return [g];
      changed = true;
      return hooks.length ? [{ ...g, hooks }] : [];
    });
    if (kept.length) config.hooks[event] = kept;
    else delete config.hooks[event];
  }
  return changed;
}

export const codexHooks = {
  file: hooksFile,
  /** The fix loop's command in ~/.codex/hooks.json, as Codex will run it, or null. */
  installed() {
    try { return ourLoop(readJson(hooksFile())); } catch { return null; }
  },
  connect() {
    const config = readJson(hooksFile(), { hooks: {} });
    if (config.hooks != null && (typeof config.hooks !== 'object' || Array.isArray(config.hooks))) throw new Error(`${hooksFile()} has an unexpected "hooks" value, so it wasn’t changed.`);
    const saved = backup(hooksFile());
    config.hooks ??= {};
    stripLoop(config); // an older install location, or adding it twice
    const command = loopCommand(HARNESS);
    for (const [event, { matcher, timeout }] of Object.entries(LOOP_EVENTS)) {
      if (!Array.isArray(config.hooks[event])) config.hooks[event] = [];
      config.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout }] });
    }
    writeJson(hooksFile(), config);
    return { file: hooksFile(), backup: saved, command, note: 'In Codex, run /hooks and trust it once, so it runs.' };
  },
  disconnect() {
    if (!existsSync(hooksFile())) return { file: hooksFile() };
    const config = readJson(hooksFile());
    if (!stripLoop(config)) return { file: hooksFile() };
    writeJson(hooksFile(), config);
    return { file: hooksFile(), backup: existsSync(backupPath(hooksFile())) ? backupPath(hooksFile()) : null };
  },
};
