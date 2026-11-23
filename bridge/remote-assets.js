// What the remote client may download, and how: an allowlist (never the bridge's own source or
// settings), each file read once, compressed once, and answered with an ETag so a device that
// has it gets a 304 and no bytes. The pages' inline script and style are allowed by hash in
// the Content-Security-Policy, so nothing else can run.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { promisify } from 'node:util';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};
export const typeOf = (path) => TYPES[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream';

// Static files need no sign-in: they're dotpals's own open-source pages and scripts, with none of
// your data in them (a browser can't send a cookie-less module import with a header anyway, and the
// app shell has to load to show the sign-in). Everything with data (/events, /api) needs a device.
export const ALIASES = { '/': '/bridge/dashboard.html', '/pair': '/bridge/remote/pair.html', '/sw.js': '/bridge/remote/sw.js', '/manifest.webmanifest': '/bridge/remote/manifest.webmanifest' };
const STATIC = [
  /^\/(?:pair|sw\.js|manifest\.webmanifest)?$/, /^\/desktop\/icon\.png$/, /^\/src\/[\w.-]+\.js$/, /^\/bridge\/ui\/[\w.-]+\.js$/,
  /^\/bridge\/activity\.js$/, /^\/bridge\/remote\/[\w-]+\.(?:js|css)$/, /^\/bridge\/remote\/icons\/icon-[\w-]+\.png$/,
  /^\/bridge\/remote\/avatars\/[a-z]+-(?:done|waiting|thinking|working|error)\.png$/,
];
export const allowed = (path) => STATIC.some((r) => r.test(path));

const sha = (data, alg = 'sha256') => createHash(alg).update(data).digest('base64');

/** The 'sha256-…' sources for every inline <script> and <style> in a page. */
export function inlineHashes(html) {
  const out = { script: [], style: [] };
  for (const m of html.matchAll(/<(script|style)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    if (/\bsrc\s*=/.test(m[2]) || !m[3].trim()) continue;
    out[m[1].toLowerCase()].push(`'sha256-${sha(m[3])}'`);
  }
  return out;
}

/**
 * The CSP for a page with these inline-script hashes. Scripts are locked down: only this origin's files
 * and the page's own inline script, by hash. Styles allow `unsafe-inline`: the pal element builds its
 * own <style> inside a shadow root and the pages set style attributes, none of which can be hashed
 * ahead of time (and a style hash would make browsers ignore `unsafe-inline`). Style injection can't
 * run code, and every other source is still closed (default-src 'none', connect-src 'self').
 */
export function csp({ script = [] } = {}) {
  return [
    "default-src 'none'", `script-src 'self' ${script.join(' ')}`.trim(), "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:", "connect-src 'self'", "manifest-src 'self'",
    "worker-src 'self'", "font-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * A cache of files by path: { body, etag, type, br, gz }. `transform(path, text)` may rewrite a
 * text file once (the dashboard gets the manifest link and the client scripts); it's re-read when
 * the file's time changes. Compression is done once, in the background, and used when it's ready.
 */
export function createAssets({ root, transform = (path, text) => text } = {}) {
  const cache = new Map();
  async function load(path) {
    const target = ALIASES[path] ?? path;
    const file = normalize(join(root, target));
    if (!file.startsWith(root)) return null;
    let info;
    try { info = await stat(file); } catch { return null; }
    if (!info.isFile()) return null;
    const hit = cache.get(path);
    if (hit && hit.mtime === info.mtimeMs) return hit.pending ?? hit;
    const pending = readAndPack(file, target, info.mtimeMs);
    const slot = { mtime: info.mtimeMs, pending };
    cache.set(path, slot);
    try {
      const entry = await pending;
      if (cache.get(path) === slot) cache.set(path, entry);
      return entry;
    } catch (err) {
      if (cache.get(path) === slot) cache.delete(path);
      throw err;
    }
  }
  async function readAndPack(file, target, mtime) {
    let body = await readFile(file);
    const type = typeOf(target);
    // Only the pages and the service worker are rewritten (once, here); other files go out as they are.
    // Line endings are made LF first: a browser normalises CRLF before it hashes an inline script, so a
    // CRLF file (a Windows checkout) would never match the hash we put in the CSP.
    if (target.endsWith('.html') || target.endsWith('/sw.js')) body = Buffer.from(transform(target, body.toString('utf8').replace(/\r\n/g, '\n')));
    const entry = { body, type, mtime, etag: `W/"${sha(body, 'sha1').slice(0, 27)}"`, br: null, gz: null };
    if (type.startsWith('text/') || type.includes('json') || type.includes('javascript') || type.includes('svg')) {
      brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } }).then((b) => { entry.br = b; }).catch(() => {});
      gz(body, { level: 9 }).then((b) => { entry.gz = b; }).catch(() => {});
    }
    return entry;
  }
  return { load, size: () => cache.size };
}

/** Fingerprint exactly what the worker installs; changing any of it invalidates the worker and its shell cache. */
export function createWorkerAsset(load) {
  let current;
  return async () => {
    const entry = await load('/sw.js');
    if (!entry) return null;
    const source = entry.body.toString('utf8');
    const manifest = /\bconst SHELL_FILES = \[([\s\S]*?)\];/.exec(source);
    const paths = manifest && [...manifest[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
    if (!paths?.length || paths.some((path) => path === '/sw.js' || !allowed(path))) throw new Error('Invalid service worker shell list');
    const files = await Promise.all(paths.map(load));
    if (files.some((file) => !file)) throw new Error('Incomplete service worker shell');
    const fingerprint = sha(JSON.stringify([entry.etag, ...files.map((file) => file.etag)])).replace(/[+/=]/g, '').slice(0, 24);
    if (current?.fingerprint === fingerprint) return current;
    const body = Buffer.from(source.replace('__SHELL_REVISION__', fingerprint));
    current = { fingerprint, body, type: entry.type, etag: `W/"${fingerprint}"` };
    gz(body).then((zipped) => { if (current.fingerprint === fingerprint) current.gz = zipped; }).catch(() => {});
    return current;
  };
}

/** The best encoding this client takes that we already have: [body, 'br' | 'gzip' | null]. */
export function negotiate(entry, acceptEncoding = '') {
  const coding = chooseEncoding(acceptEncoding, [entry.br && 'br', entry.gz && 'gzip', 'identity'].filter(Boolean));
  if (coding === 'br') return [entry.br, 'br'];
  if (coding === 'gzip') return [entry.gz, 'gzip'];
  return [coding === 'identity' ? entry.body : null, null];
}

export function chooseEncoding(header = '', available = ['gzip', 'identity']) {
  const weights = new Map();
  for (const item of header.toLowerCase().split(',')) {
    const [coding, ...params] = item.trim().split(';').map((part) => part.trim());
    const q = params.find((param) => param.startsWith('q='));
    weights.set(coding, q ? (/^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(q) ? Number(q.slice(2)) : 0) : 1);
  }
  const quality = (coding) => weights.get(coding) ?? (coding === 'identity' ? (weights.get('*') === 0 ? 0 : 1) : weights.get('*') ?? 0);
  return available.filter((coding) => quality(coding) > 0).sort((a, b) => quality(b) - quality(a))[0];
}
