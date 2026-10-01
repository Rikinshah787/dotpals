import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { get, request } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// A bridge following a Codex log in a temp folder (and nothing else).
const tmp = await mkdtemp(join(tmpdir(), 'dotpals-context-'));
delete process.env.DOTPALS_CODEX;
process.env.DOTPALS_CODEX_DIR = join(tmp, 'sessions');
process.env.DOTPALS_CLAUDE_LOGS = '0';
process.env.DOTPALS_HISTORY = '0';
process.env.DOTPALS_HOME = join(tmp, 'home');
after(() => rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const { startBridge } = await import('../bridge/server.js');

/** A port no bridge in this file has used yet: fetch keeps connections alive, and reusing an old port could hand a test a dead one ("fetch failed"). */
const usedPorts = new Set();
const freshPort = () => { let port; do port = 5190 + Math.floor(Math.random() * 2000); while (usedPorts.has(port)); usedPorts.add(port); return port; };

function readEvents(port, ms) {
  return new Promise((ok, fail) => {
    const req = get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      setTimeout(() => {
        req.destroy();
        ok(text.split('\n\n').filter(Boolean).map((chunk) => ({
          event: /^event: (.+)$/m.exec(chunk)?.[1] ?? 'message',
          data: JSON.parse(/^data: (.+)$/m.exec(chunk)?.[1] ?? 'null'),
        })));
      }, ms);
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? null : fail(err)));
  });
}

test('context-window updates are sent, replayed to new viewers, and cleared', async (t) => {
  const now = new Date();
  const folder = join(tmp, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  await mkdir(folder, { recursive: true });
  const ts = new Date().toISOString();
  const lines = [
    { timestamp: ts, type: 'session_meta', payload: { id: 'ctx-1', cwd: '/work/proj' } },
    { timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 64000 }, model_context_window: 256000 } } },
  ];
  await writeFile(join(folder, 'rollout-ctx.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

  let port;
  let server;
  for (let tries = 0; !server; tries++) {
    port = freshPort();
    try { server = await startBridge({ port, log: () => {} }); } catch (err) { if (err.code !== 'EADDRINUSE' || tries > 10) throw err; }
  }
  t.after(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); await sleep(150); });

  // The watcher polls once a second.
  let context;
  for (let i = 0; i < 6 && !context; i++) {
    await sleep(500);
    context = (await readEvents(port, 150)).find((e) => e.event === 'context');
  }
  assert.ok(context, 'a new viewer gets the context replayed');
  assert.deepEqual(
    { session: context.data.session, harness: context.data.harness, label: context.data.label, used: context.data.used, size: context.data.size, known: context.data.known },
    { session: 'codex:ctx-1', harness: 'codex', label: 'proj', used: 64000, size: 256000, known: true },
  );

  // Clearing history forgets it.
  await new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/history/clear', method: 'POST', headers: { 'x-dotpals': '1' } }, (res) => { res.resume(); res.on('end', ok); });
    req.on('error', fail);
    req.end('{}');
  });
  assert.equal((await readEvents(port, 150)).filter((e) => e.event === 'context').length, 0);
});
