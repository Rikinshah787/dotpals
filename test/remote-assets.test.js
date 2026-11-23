import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chooseEncoding, createAssets, negotiate } from '../bridge/remote-assets.js';

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