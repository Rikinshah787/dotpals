import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanDictation } from '../bridge/ui/dictation.js';

test('cleanDictation drops ums and uhs, and the commas around them', () => {
  assert.equal(cleanDictation(' Um, so I think, uh, we should ship it today.'), 'So I think we should ship it today.');
  assert.equal(cleanDictation('It was, um. Fine, hmm, really.'), 'It was. Fine really.');
  assert.equal(cleanDictation('Uhm we need erm two tests.'), 'We need two tests.');
  // Words that only start like a filler stay.
  assert.equal(cleanDictation('The umbrella error is in hummus.js.'), 'The umbrella error is in hummus.js.');
});

test('cleanDictation: "new line" and "new paragraph" break the text', () => {
  assert.equal(cleanDictation('Hi Sam, new line. Thanks for the review.'), 'Hi Sam,\nThanks for the review.');
  assert.equal(cleanDictation('First part. New paragraph, second part.'), 'First part.\n\nSecond part.');
});

test('cleanDictation: "scratch that" drops the sentence before it', () => {
  assert.equal(cleanDictation("Let's meet at 3. Scratch that. Let's meet at 4."), "Let's meet at 4.");
  assert.equal(cleanDictation('Ship it. Wait for CI, scratch that, ship it now.'), 'Ship it. Ship it now.');
  assert.equal(cleanDictation('Scratch that.'), '');
});

test('cleanDictation tidies spaces and capitals, and leaves nothing for nothing', () => {
  assert.equal(cleanDictation('  hello   there .  how are you ?'), 'Hello there. How are you?');
  assert.equal(cleanDictation(''), '');
  assert.equal(cleanDictation('  Um.  '), '');
});
