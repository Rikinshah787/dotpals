import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { get, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep the bridge away from the real home folder: no Codex watcher, no history file.
process.env.DOTPALS_CODEX = '0';
process.env.DOTPALS_CLAUDE_LOGS = '0';
process.env.DOTPALS_HISTORY = '0';
const home = await mkdtemp(join(tmpdir(), 'dotpals-home-'));
process.env.DOTPALS_HOME = home;
after(() => rm(home, { recursive: true, force: true }));

const { startBridge } = await import('../bridge/server.js');

async function start() {
  for (let tries = 0; ; tries++) {
    const port = 5190 + Math.floor(Math.random() * 2000);
    try {
      return { port, server: await startBridge({ port, log: () => {} }) };
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || tries > 10) throw err;
    }
  }
}

function post(port, path, body) {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => ok({ status: res.statusCode, text }));
    });
    req.on('error', fail);
    req.end(JSON.stringify(body));
  });
}

/** Read the SSE stream for up to `ms`, returning the parsed events. */
function readEvents(port, ms = 500) {
  return new Promise((ok, fail) => {
    const req = get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      setTimeout(() => {
        req.destroy();
        const events = text.split('\n\n').filter(Boolean).map((chunk) => {
          const event = /^event: (.+)$/m.exec(chunk)?.[1] ?? 'message';
          const data = /^data: (.+)$/m.exec(chunk)?.[1];
          return { event, data: data ? JSON.parse(data) : null };
        }).filter((e) => e.data);
        ok({ status: res.statusCode, type: res.headers['content-type'], events });
      }, ms);
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? null : fail(err)));
  });
}

test('generic /event: a follow-up with the same id merges into the entry', async (t) => {
  const { port, server } = await start();
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });

  const first = await post(port, '/event', {
    session: 'test-session', harness: 'my-agent', label: 'proj', state: 'working', text: 'Running tests',
    activity: { id: 'a1', kind: 'run', title: 'npm test', status: 'running', body: { command: 'npm test' } },
  });
  assert.equal(first.status, 200);
  assert.equal(first.text, '{}');

  await post(port, '/event', { session: 'test-session', activity: [{ id: 'a1', status: 'ok', body: { output: '12 passing' } }] });

  const { status, type, events } = await readEvents(port, 500);
  assert.equal(status, 200);
  assert.match(type, /text\/event-stream/);

  const activity = events.filter((e) => e.event === 'activity').map((e) => e.data);
  assert.equal(activity.length, 1);
  const [entry] = activity;
  assert.equal(entry.id, 'test-session:a1');
  assert.equal(entry.session, 'test-session');
  assert.equal(entry.harness, 'my-agent');
  assert.equal(entry.label, 'proj');
  assert.equal(entry.kind, 'run');
  assert.equal(entry.title, 'npm test');
  assert.equal(entry.status, 'ok');
  assert.deepEqual(entry.body, { command: 'npm test', output: '12 passing' });

  const state = events.find((e) => e.event === 'message' && e.data.session === 'test-session');
  assert.ok(state, 'the pal state is replayed');
  assert.equal(state.data.state, 'working');
  assert.equal(state.data.text, 'Running tests');
});

test('serves the pal page and refuses paths outside src/ and bridge/', async (t) => {
  const { port, server } = await start();
  t.after(() => new Promise((r) => server.close(r)));

  const status = (path) => new Promise((ok, fail) => {
    get({ host: '127.0.0.1', port, path }, (res) => { res.resume(); ok(res.statusCode); }).on('error', fail);
  });
  assert.equal(await status('/'), 200);
  assert.equal(await status('/package.json'), 404);
  assert.equal(await status('/bridge/../package.json'), 404);
});
