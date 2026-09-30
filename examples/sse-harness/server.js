// Minimal "harness" that streams agent states over Server-Sent Events.
// Replace the fake `runAgent` with your real agent loop and emit
// `{ state, text? }` (or raw Anthropic / OpenAI / Agent SDK events).
//
//   npm run example:agent   →  http://localhost:5174
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const port = Number(process.env.PORT) || 5174;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function runAgent(send) {
  send({ state: 'listening' });
  await wait(1200);
  send({ state: 'thinking' });
  await wait(2000);
  send({ state: 'working', text: 'Searching the web…' });
  await wait(2200);
  send({ state: 'working', text: 'Reading 3 files…' });
  await wait(1800);
  send({ state: 'waiting', text: 'Allow file edit?' });
  await wait(2500);
  send({ state: 'working', text: 'Editing index.js' });
  await wait(1800);
  send({ state: 'speaking' });
  await wait(2600);
  send(Math.random() < 0.8 ? { state: 'done', text: 'All done!' } : { state: 'error', text: 'Tests failed' });
  await wait(3000);
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    let open = true;
    req.on('close', () => (open = false));
    while (open) await runAgent((d) => open && send(d));
    return;
  }
  const file = url.pathname === '/' ? 'examples/sse-harness/index.html' : url.pathname.slice(1);
  if (!/^(src|examples)\//.test(file) || file.includes('..')) return res.writeHead(404).end();
  try {
    const body = await readFile(root + file);
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, () => console.log(`agent harness example → http://localhost:${port}`));
