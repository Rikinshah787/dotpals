import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chooseEncoding, createAssets, createWorkerAsset, negotiate } from '../bridge/remote-assets.js';

test('remote encoding negotiation respects rejected and weighted encodings', () => {
  const entry = { body: Buffer.from('identity'), br: Buffer.from('br'), gz: Buffer.from('gzip') };
  assert.deepEqual(negotiate(entry, 'br;q=0, gzip;q=0, identity'), [entry.body, null]);
  assert.deepEqual(negotiate(entry, 'br;q=0.5, gzip;q=0.8, identity;q=0.1'), [entry.gz, 'gzip']);
  assert.deepEqual(negotiate(entry, '*;q=0'), [null, null]);
  assert.equal(chooseEncoding('gzip;q=0'), 'identity');
  assert.equal(chooseEncoding('gzip, identity;q=0'), 'gzip');
});

test('concurrent asset reads share one transformation and a weak validator', async () => {
  let transformed = 0;
  const assets = createAssets({ root: fileURLToPath(new URL('../', import.meta.url)), transform: (_, body) => { transformed++; return body; } });
  const reads = await Promise.all(Array.from({ length: 10 }, () => assets.load('/')));
  assert.equal(transformed, 1);
  assert.ok(reads.every((entry) => entry === reads[0]));
  assert.match(reads[0].etag, /^W\//);
});

test('a shell file edit changes the worker bytes without a release or worker build bump', async () => {
  const script = { body: Buffer.from("const SHELL_FILES = ['/','/src/index.js']; const cache = '__SHELL_REVISION__';"), etag: 'script', type: 'text/javascript' };
  let shellTag = 'v1';
  const worker = createWorkerAsset(async (path) => path === '/sw.js' ? script : { etag: path === '/src/index.js' ? shellTag : 'dashboard' });
  const before = await worker();
  assert.equal(await worker(), before);
  shellTag = 'v2';
  const after = await worker();
  assert.notEqual(before.etag, after.etag);
  assert.notDeepEqual(before.body, after.body);
});