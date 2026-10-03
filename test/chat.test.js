// Chat with OpenCode from the pal: the bridge's /api/chat endpoints and OpenCode's
// permission requests and questions (bridge/chat.js is swapped for a fake here, so no
// OpenCode server starts).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep the bridge away from the real home folder: no Codex watcher, no history file.
process.env.DOTPALS_CODEX = '0';
process.env.DOTPALS_CLAUDE_LOGS = '0';
process.env.DOTPALS_HISTORY = '0';
const home = await mkdtemp(join(tmpdir(), 'dotpals-home-'));
process.env.DOTPALS_HOME = home;
const project = await mkdtemp(join(tmpdir(), 'dotpals-project-'));
after(() => Promise.all([rm(home, { recursive: true, force: true }), rm(project, { recursive: true, force: true })]));

const { startBridge } = await import('../bridge/server.js');

const usedPorts = new Set();
const BLOCKED = new Set([5985, 5986, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);
const freshPort = () => { let port; do port = 7300 + Math.floor(Math.random() * 1500); while (usedPorts.has(port) || BLOCKED.has(port)); usedPorts.add(port); return port; };

/** A fake bridge/chat.js: records what the bridge asks of OpenCode. */
function fakeChat() {
  const calls = [];
  const fake = {
    calls,
    emit: null, // OpenCode's events, as the real one would pass them on
    exit: null, // OpenCode stopped
    create({ onEvent, onExit }) {
      fake.emit = onEvent;
      fake.exit = onExit;
      return {
        send: async (args) => { calls.push(['send', args]); return { session: `opencode:${args.sessionID ?? 'ses_new1'}`, sessionID: args.sessionID ?? 'ses_new1' }; },
        abort: async (args) => { calls.push(['abort', args]); return true; },
        replyPermission: async (args) => { calls.push(['permission', args]); },
        replyQuestion: async (args) => { calls.push(['question', args]); },
        stop: () => { calls.push(['stop']); },
      };
    },
  };
  return fake;
}

/** A bridge with a fake OpenCode, and chat turned on (Settings → Chat with your agents) unless . */
async function start(t, { chat: on = true } = {}) {
  const chat = fakeChat();
  for (let tries = 0; ; tries++) {
    const port = freshPort();
    try {
      const server = await startBridge({ port, log: () => {}, createChat: (o) => chat.create(o) });
      t.after(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); });
      await api(port, '/api/config', { chat: on });
      return { port, chat };
    } catch (err) {
      if (!['EADDRINUSE', 'EACCES'].includes(err.code) || tries > 10) throw err;
    }
  }
}

const api = (port, path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-dotpals': '1', ...headers }, body: JSON.stringify(body),
}).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));

/** Read the SSE stream for `ms` and return the `ocask` events. */
function ocAsks(port, ms = 300) {
  return new Promise((ok, fail) => {
    const req = get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      setTimeout(() => {
        req.destroy();
        ok(text.split('\n\n').filter((c) => /^event: ocask$/m.test(c)).map((c) => JSON.parse(/^data: (.+)$/m.exec(c)[1])));
      }, ms);
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? null : fail(err)));
  });
}

test('chat: needs the header, a local page and some text', async (t) => {
  const { port, chat } = await start(t);
  assert.equal((await api(port, '/api/chat', { text: 'hi' }, { 'x-dotpals': '' })).status, 403);
  assert.equal((await api(port, '/api/chat', { text: 'hi' }, { origin: 'https://evil.example' })).status, 403);
  const empty = await api(port, '/api/chat', { text: '   ' });
  assert.equal(empty.status, 400);
  assert.equal((await api(port, '/api/chat', { text: 'x'.repeat(20_001) })).status, 400);
  assert.equal(chat.calls.length, 0, 'nothing reached OpenCode');
});

test('chat: a new session starts in the folder you name, or your home folder', async (t) => {
  const { port, chat } = await start(t);
  const r = await api(port, '/api/chat', { text: 'run the tests', directory: project });
  assert.equal(r.status, 200);
  assert.equal(r.body.session, 'opencode:ses_new1');
  assert.equal(r.body.directory, project);
  assert.deepEqual(chat.calls[0], ['send', { text: 'run the tests', sessionID: undefined, directory: project }]);

  const missing = await api(port, '/api/chat', { text: 'hi', directory: join(project, 'not-there') });
  assert.equal(missing.body.directory, homedir(), 'a folder that does not exist falls back to home');
});

test('chat: follow-ups go to that session in its own folder; other ids start a new one', async (t) => {
  const { port, chat } = await start(t);
  await api(port, '/api/chat', { text: 'first', directory: project });
  const next = await api(port, '/api/chat', { text: 'and then?', session: 'opencode:ses_new1', directory: homedir() });
  assert.equal(next.status, 200);
  assert.deepEqual(chat.calls[1], ['send', { text: 'and then?', sessionID: 'ses_new1', directory: project }], 'the session’s folder wins over the request');

  await api(port, '/api/chat', { text: 'hi', session: 'claude:abc' });
  assert.equal(chat.calls[2][1].sessionID, undefined, 'not an OpenCode session: a new one');

  assert.equal((await api(port, '/api/chat/abort', { session: 'claude:abc' })).status, 400);
  assert.equal((await api(port, '/api/chat/abort', { session: 'opencode:ses_new1' })).status, 200);
  assert.deepEqual(chat.calls[3], ['abort', { sessionID: 'ses_new1', directory: project }]);
});

test('chat: an OpenCode permission request shows as a card, and answering it once is enough', async (t) => {
  const { port, chat } = await start(t);
  await api(port, '/api/chat', { text: 'read win.ini', directory: project });
  chat.emit({ type: 'permission.asked', properties: { id: 'per_1', sessionID: 'ses_new1', permission: 'external_directory', patterns: ['C:\\Windows\\*'], always: ['C:\\Windows\\*'], metadata: {} } });

  const [card] = await ocAsks(port);
  assert.equal(card.id, 'per_1');
  assert.equal(card.kind, 'permission');
  assert.equal(card.status, 'pending');
  assert.equal(card.permission, 'external_directory');
  assert.deepEqual(card.patterns, ['C:\\Windows\\*']);
  assert.equal(card.canAlways, true);
  assert.equal(card.label, project.split(/[\\/]/).pop(), 'labelled with the session’s folder');

  assert.equal((await api(port, '/api/chat/answer', { id: 'per_1', reply: 'sure' })).status, 400);
  assert.equal((await api(port, '/api/chat/answer', { id: 'per_1', reply: 'once' })).status, 200);
  assert.deepEqual(chat.calls.at(-1), ['permission', { id: 'per_1', reply: 'once', directory: project }]);
  assert.equal((await api(port, '/api/chat/answer', { id: 'per_1', reply: 'once' })).status, 404, 'already answered');
  assert.deepEqual(await ocAsks(port), [], 'the card is gone');
});

test('chat: questions take one list of choices per question, or null to skip', async (t) => {
  const { port, chat } = await start(t);
  chat.emit({ type: 'question.asked', properties: { id: 'que_1', sessionID: 'ses_q', questions: [
    { question: 'Which database?', header: 'Database', options: [{ label: 'Postgres', description: '' }, { label: 'SQLite', description: '' }] },
    { question: 'Add tests?', header: 'Tests', options: [{ label: 'Yes', description: '' }], multiple: true },
  ] } });
  const [card] = await ocAsks(port);
  assert.equal(card.kind, 'question');
  assert.equal(card.questions.length, 2);
  assert.deepEqual(card.questions[0].options.map((o) => o.label), ['Postgres', 'SQLite']);
  assert.equal(card.questions[1].multiple, true);

  assert.equal((await api(port, '/api/chat/answer', { id: 'que_1', answers: [['Postgres']] })).status, 400, 'one answer short');
  assert.equal((await api(port, '/api/chat/answer', { id: 'que_1', answers: [['Postgres'], [42]] })).status, 400, 'answers are text');
  assert.equal((await api(port, '/api/chat/answer', { id: 'que_1', answers: [['Postgres'], ['Yes', 'and lint']] })).status, 200);
  assert.deepEqual(chat.calls.at(-1)[1].answers, [['Postgres'], ['Yes', 'and lint']]);

  chat.emit({ type: 'question.asked', properties: { id: 'que_2', sessionID: 'ses_q', questions: [{ question: 'Sure?', header: 'Sure', options: [] }] } });
  assert.equal((await api(port, '/api/chat/answer', { id: 'que_2', answers: null })).status, 200);
  assert.equal(chat.calls.at(-1)[1].answers, null, 'skipped');
});

test('chat: a request answered in OpenCode itself (the TUI) takes the card away', async (t) => {
  const { port, chat } = await start(t);
  chat.emit({ type: 'permission.asked', properties: { id: 'per_2', sessionID: 'ses_x', permission: 'bash', patterns: ['rm -rf dist'], always: [], metadata: {} } });
  assert.equal((await ocAsks(port)).length, 1);
  chat.emit({ type: 'permission.replied', properties: { sessionID: 'ses_x', requestID: 'per_2', reply: 'reject' } });
  assert.deepEqual(await ocAsks(port), []);
});

test('chat: the projects list has the folders agents worked in, newest first, without drive roots', async (t) => {
  const { port } = await start(t);
  const event = (session, cwd) => fetch(`http://127.0.0.1:${port}/event`, { method: 'POST', body: JSON.stringify({ session, cwd, activity: { id: 'a', kind: 'run', title: 'npm test' } }) });
  await event('root-session', '/');
  await event('gone-session', join(project, 'deleted'));
  await event('project-session', project);
  const res = await fetch(`http://127.0.0.1:${port}/api/chat/projects`);
  const { projects } = await res.json();
  assert.deepEqual(projects, [{ path: project, name: project.split(/[\\/]/).pop() }]);
});

test('chat is off until you turn it on: no prompts and no projects list, but Stop still works', async (t) => {
  const { port, chat } = await start(t, { chat: false });
  const r = await api(port, '/api/chat', { text: 'hi', directory: project });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Settings/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/chat/projects`)).status, 409);
  assert.equal((await api(port, '/api/chat/abort', { session: 'opencode:ses_new1' })).status, 200, 'stopping work is always allowed');
  assert.ok(!chat.calls.some(([call]) => call === 'send'), 'no prompt reached OpenCode');
});

test('chat: when OpenCode stops, its cards close (answering one is a 404, not a 502)', async (t) => {
  const { port, chat } = await start(t);
  chat.emit({ type: 'permission.asked', properties: { id: 'per_3', sessionID: 'ses_y', permission: 'bash', patterns: ['npm test'], always: [], metadata: {} } });
  const watching = ocAsks(port, 400);
  await new Promise((r) => setTimeout(r, 100));
  chat.exit();
  assert.deepEqual((await watching).map((e) => [e.id, e.status]), [['per_3', 'pending'], ['per_3', 'answered']], 'a viewer sees it close');
  assert.deepEqual(await ocAsks(port), [], 'and a new viewer never sees it');
  assert.equal((await api(port, '/api/chat/answer', { id: 'per_3', reply: 'once' })).status, 404);
  assert.equal(chat.calls.length, 0, 'nothing sent to a server that is gone');
});

test('chat: turning it off stops the OpenCode server', async (t) => {
  const { port, chat } = await start(t);
  assert.equal((await api(port, '/api/config', { chat: false })).status, 200);
  assert.deepEqual(chat.calls, [['stop']]);
});
