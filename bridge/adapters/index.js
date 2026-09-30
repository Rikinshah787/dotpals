// The integrations ("packages"): one per agent tool, all feeding the same
// activity model (bridge/activity.js). The bridge (server.js) and the
// dashboard's Agents page are driven by this list.
//
// Each one is { id, name, via, how, docs, setup, detect(), … }:
//   via      what it connects through, in a few words
//   how      one plain sentence for the dashboard
//   setup    'plugin'  installed from inside the agent (Claude Code)
//            'auto'    nothing to install: dotpals reads the agent's logs (Codex)
//            'connect' dotpals adds a hook or plugin to the agent's config; the
//                      dashboard's Connect button runs connect(), Disconnect runs
//                      disconnect(), and connected() says which it is
//            'http'    the agent posts to /event itself
//   detect() → { found, where }   is the agent installed, and where
//   apply(event, log) → { entries, session, label, state? }
//            for events its hook sends to POST /hook?agent=<id>
//   watch(log, { emit, state }) → stop     for agents followed through their logs
//   command() the hook command as installed, and sample(token) a payload for it:
//            "Send a test event" runs the real command, so a wrong path shows up
//   probe({ url, token })   the same for a plugin that runs inside the agent
//
// Switch any of them off with { "agents": { "<id>": false } } in ~/.dotpals/config.json.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { watchCodex } from './codex.js';
import copilot from './copilot.js';
import cursor from './cursor.js';
import gemini from './gemini.js';
import opencode from './opencode.js';

const claude = {
  id: 'claude',
  name: 'Claude Code',
  via: 'Plugin hooks + transcripts',
  how: 'Hooks report live, and each session’s transcript fills in its history. Sessions without the plugin show up from their transcripts.',
  docs: 'https://docs.claude.com/en/docs/claude-code/hooks',
  setup: 'plugin',
  install: '/plugin marketplace add rikinshah787/dotpals\n/plugin install dotpals@dotpals',
  detect() {
    const where = join(homedir(), '.claude');
    return { found: existsSync(where), where };
  },
};

const codexDir = () => process.env.DOTPALS_CODEX_DIR || join(homedir(), '.codex', 'sessions');

const codex = {
  id: 'codex',
  name: 'Codex',
  via: 'Session logs',
  how: 'Nothing to install: dotpals follows the session logs in ~/.codex/sessions (CLI, IDE extension and app).',
  docs: 'https://developers.openai.com/codex',
  setup: 'auto',
  detect() {
    const where = codexDir();
    return { found: existsSync(where), where };
  },
  watch: (log, opts) => watchCodex(log, { ...opts, dir: codexDir() }),
};

const generic = {
  id: 'generic',
  name: 'Any agent',
  via: 'HTTP: POST /event',
  how: 'Your agent loop, a hook script or a wrapper posts JSON to the bridge.',
  docs: 'https://github.com/Rikinshah787/dotpals#plug-in-any-agent',
  setup: 'http',
  detect: () => ({ found: true, where: null }),
};

export const ADAPTERS = [claude, codex, cursor, gemini, opencode, copilot, generic];

export const adapter = (id) => ADAPTERS.find((a) => a.id === id) ?? null;
