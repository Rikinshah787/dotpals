import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCharacter, cleanCustom, CUSTOM_OPTIONS } from '../src/custom.js';

test('cleanCustom keeps known values and fixes the rest', () => {
  assert.deepEqual(cleanCustom({ name: '  Pip  ', shape: 'heart', eyes: 'visor', top: 'crown', color: '#AABBCC', fur: false }),
    { name: 'Pip', shape: 'heart', eyes: 'visor', top: 'crown', color: '#aabbcc', fur: false });
  const fixed = cleanCustom({ shape: 'triangle', color: 'red', name: '<b>'.repeat(20) });
  assert.equal(fixed.shape, 'round');
  assert.equal(fixed.color, '#ff7a2f');
  assert.equal(fixed.name.length, 24);
  assert.equal(cleanCustom(null), null);
});

test('buildCharacter draws every combination', () => {
  for (const shape of Object.keys(CUSTOM_OPTIONS.shape)) {
    for (const eyes of Object.keys(CUSTOM_OPTIONS.eyes)) {
      for (const top of Object.keys(CUSTOM_OPTIONS.top)) {
        const def = buildCharacter({ name: 'x', shape, eyes, top, color: '#123456' });
        const parts = def.render({ id: (n) => n, body: 'url(#body)', fur: 'url(#fur)' });
        const svg = `${parts.body}${parts.accessories}${parts.face}`;
        assert.ok(!/NaN|undefined/.test(svg), `${shape}/${eyes}/${top}`);
        assert.match(parts.face, /dp-look/);
      }
    }
  }
});
