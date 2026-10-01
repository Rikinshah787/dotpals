// Plug a pal into any AI agent harness.
//
// A pal understands one tiny protocol: `{ state, text? }`, where `state` is
// idle · listening · thinking · working · speaking · waiting · done · error · sleeping.
//
// `toAgentState()` translates common streaming formats into that protocol,
// so most harnesses work without any mapping code:
//   - Anthropic Messages API stream events
//   - Claude Agent SDK messages
//   - OpenAI Responses API stream events
//   - generic `{ type: 'tool_call' | 'permission_request' | … }` events
// Anything it doesn't recognise is ignored (returns null).

const STATES = ['idle', 'listening', 'thinking', 'working', 'speaking', 'waiting', 'done', 'error', 'sleeping'];
const pick = (state, text) =>
  STATES.includes(state) ? { state, ...(typeof text === 'string' && text ? { text } : {}) } : null;

/**
 * Convert a harness event into `{ state, text? }`, or `null` to ignore it.
 * @param {any} e
 */
export function toAgentState(e) {
  if (e == null) return null;
  if (typeof e === 'string') {
    try { e = JSON.parse(e); } catch { return pick(e); }
  }
  if (typeof e.state === 'string') return pick(e.state, e.text);

  // -- Claude Code hooks (POSTed by `type: "http"` hooks) --------------------
  if (typeof e.hook_event_name === 'string') return fromClaudeCodeHook(e);

  const type = e.type ?? e.event ?? '';

  // -- Anthropic Messages API streaming --------------------------------------
  switch (type) {
    case 'message_start': return pick('thinking');
    case 'content_block_start': {
      const block = e.content_block ?? {};
      if (block.type === 'thinking' || block.type === 'redacted_thinking') return pick('thinking');
      if (block.type === 'tool_use' || block.type === 'server_tool_use') return pick('working', block.name);
      if (block.type === 'text') return pick('speaking');
      return null;
    }
    case 'message_delta':
      return e.delta?.stop_reason === 'tool_use' ? pick('working') : null;
    case 'message_stop': return pick('done');
  }

  // -- Claude Agent SDK messages ---------------------------------------------
  if (type === 'system' && e.subtype === 'init') return pick('thinking');
  if (type === 'assistant' && Array.isArray(e.message?.content)) {
    const blocks = e.message.content;
    const tool = blocks.findLast?.((b) => b.type === 'tool_use');
    if (tool) return pick('working', tool.name);
    if (blocks.some((b) => b.type === 'text')) return pick('speaking');
    if (blocks.some((b) => b.type === 'thinking')) return pick('thinking');
    return null;
  }
  if (type === 'user' && e.message?.content?.some?.((b) => b.type === 'tool_result')) return pick('thinking');
  if (type === 'result') return pick(e.subtype === 'success' && !e.is_error ? 'done' : 'error');

  // -- OpenAI Responses API streaming ----------------------------------------
  if (type === 'response.created' || type === 'response.in_progress') return pick('thinking');
  if (type.startsWith('response.reasoning')) return pick('thinking');
  if (type === 'response.output_item.added') {
    const item = e.item ?? {};
    if (item.type === 'function_call' || item.type?.endsWith('_call')) return pick('working', item.name);
    if (item.type === 'message') return pick('speaking');
    return null;
  }
  if (type.startsWith('response.output_text')) return pick('speaking');
  if (type === 'response.completed') return pick('done');
  if (type === 'response.failed' || type === 'response.incomplete') return pick('error');

  // -- Generic harness events ------------------------------------------------
  const generic = {
    start: 'thinking', thinking: 'thinking', reasoning: 'thinking',
    tool_call: 'working', tool_use: 'working', tool_start: 'working', working: 'working',
    tool_result: 'thinking', tool_end: 'thinking',
    // 'token': one streamed word of a model's reply, not a credential.
    text: 'speaking', text_delta: 'speaking', ['token']: 'speaking', speaking: 'speaking',
    permission_request: 'waiting', approval_required: 'waiting', input_required: 'waiting', waiting: 'waiting',
    user_typing: 'listening', listening: 'listening',
    end: 'done', done: 'done', complete: 'done', completed: 'done', finish: 'done',
    error: 'error', failed: 'error',
    idle: 'idle', sleep: 'sleeping', sleeping: 'sleeping',
  }[type];
  if (!generic) return null;
  return pick(generic, e.text ?? (typeof e.message === 'string' ? e.message : undefined) ?? e.name ?? e.tool);
}

const basename = (p) => String(p ?? '').split(/[\\/]/).pop();
const clip = (s, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Short, human description of a Claude Code tool call. */
function describeTool(name = '', input = {}) {
  if (name === 'Bash' || name === 'PowerShell') return clip(input.description || `$ ${input.command ?? ''}`);
  if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(name) && (input.file_path || input.notebook_path)) {
    return `${name === 'Read' ? 'Reading' : 'Editing'} ${basename(input.file_path || input.notebook_path)}`;
  }
  if (name === 'Grep' || name === 'Glob') return clip(`Searching ${input.pattern ?? ''}`);
  if (name === 'WebSearch' || name === 'WebFetch') return 'Browsing the web';
  if (name === 'Agent' || name === 'Task') return clip(input.description || 'Delegating…');
  if (name.startsWith('mcp__')) return clip(name.split('__').pop().replace(/_/g, ' '));
  return name;
}

function fromClaudeCodeHook(e) {
  switch (e.hook_event_name) {
    case 'SessionStart': return pick('idle');
    case 'UserPromptSubmit': return pick('thinking');
    case 'PreToolUse': return pick('working', describeTool(e.tool_name, e.tool_input));
    case 'PostToolUse': case 'PostToolBatch': case 'SubagentStop': return pick('thinking');
    case 'PostToolUseFailure': return pick('thinking', `${e.tool_name ?? 'Tool'} failed`);
    case 'PermissionRequest': return pick('waiting', `Allow ${e.tool_name ?? 'this'}?`);
    case 'Notification':
      return e.notification_type === 'idle_prompt' ? pick('listening', 'Your turn') : pick('waiting', e.message);
    case 'SubagentStart': return pick('working', 'Starting a subagent');
    case 'PreCompact': return pick('working', 'Compacting memory…');
    case 'Stop': return pick('done', 'Done!');
    case 'StopFailure': return pick('error', e.error?.message ?? 'Something went wrong');
    case 'SessionEnd': return pick('sleeping');
    default: return null;
  }
}

/**
 * Drive a pal from an agent. `source` can be:
 *   - an EventSource or WebSocket sending JSON events
 *   - any EventTarget (listens for `event` — default 'message' — and reads `e.data ?? e.detail`)
 *   - an async iterable of events (e.g. an SDK stream)
 *
 * Returns a function that disconnects. Options:
 *   map(event)  – custom translator; return `{ state, text? }` or null (default: toAgentState)
 *   event       – event name to listen for on EventTargets (default 'message')
 *
 *   connectAgent(pal, new EventSource('/agent/events'));
 *   connectAgent(pal, client.messages.stream({ … }));
 */
export function connectAgent(pal, source, { map = toAgentState, event = 'message' } = {}) {
  const apply = (raw) => {
    const next = map(raw);
    if (next?.state) pal.setState(next.state, { text: next.text });
  };

  if (source && typeof source[Symbol.asyncIterator] === 'function') {
    let stopped = false;
    (async () => {
      try {
        for await (const e of source) {
          if (stopped) break;
          apply(e);
        }
      } catch (err) {
        if (!stopped) pal.setState('error', { text: err?.message });
      }
    })();
    return () => { stopped = true; };
  }

  if (source && typeof source.addEventListener === 'function') {
    const onEvent = (e) => apply(e.data ?? e.detail ?? e);
    const onError = () => pal.setState('error');
    source.addEventListener(event, onEvent);
    source.addEventListener('error', onError);
    return () => {
      source.removeEventListener(event, onEvent);
      source.removeEventListener('error', onError);
    };
  }

  throw new TypeError('[dotpals] connectAgent() needs an EventTarget, EventSource, WebSocket or async iterable');
}

/**
 * Returns a function you can call with each harness event yourself —
 * handy inside existing callbacks: `onEvent: agentHandler(pal)`.
 */
export function agentHandler(pal, { map = toAgentState } = {}) {
  return (raw) => {
    const next = map(raw);
    if (next?.state) pal.setState(next.state, { text: next.text });
    return next;
  };
}
