import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanDictation, fixWords, toPal, yourWords } from '../bridge/ui/dictation.js';

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

test('toPal: "Blu, …" and "Hey Blue …" are for your pal; a sentence about blue is dictation', () => {
  assert.equal(toPal('Blu, email Sam that the cart is fixed.'), 'Email Sam that the cart is fixed.');
  assert.equal(toPal('Blue: what is this error?'), 'What is this error?');
  assert.equal(toPal('Hey Blue, fix the failing test.'), 'Fix the failing test.');
  assert.equal(toPal('Okay blu draft a note'), 'Draft a note');
  assert.equal(toPal('Webby, check my PR.', 'Webby'), 'Check my PR.');
  assert.equal(toPal('Blue is my favourite colour.'), null);
  assert.equal(toPal('Blu,'), null);
  assert.equal(toPal('The blue button is broken.'), null);
  // The name alone only before something you'd ask; "Hey Blu" always.
  assert.equal(toPal('Blue, green and red are the options.'), null);
  assert.equal(toPal('Blue: the primary colour.'), null);
  assert.equal(toPal('Hey Blue, the build is green now.'), 'The build is green now.');
});

test('your words: a "$" in the word you want stays a "$"', () => {
  assert.equal(fixWords('I paid ten dollars.', ['dollars → $&']), 'I paid ten $&.');
});

test('your words: plain words for the AI, fixes ("dot pals → dotpals") made every time, whole words only', () => {
  const dictionary = ['dotpals', 'Blu', 'dot pals → dotpals', 'blew=Blu', 'blue -> Blu'];
  assert.deepEqual(yourWords(dictionary), { words: ['dotpals', 'Blu'], fixes: [['dot pals', 'dotpals'], ['blew', 'Blu'], ['blue', 'Blu']] });
  assert.equal(fixWords('We ship dot pals today. Dot pals’ notch beats blew.', dictionary), 'We ship dotpals today. dotpals’ notch beats Blu.');
  assert.equal(fixWords('Blue, open the bluetooth settings.', dictionary), 'Blu, open the bluetooth settings.');
  assert.equal(fixWords('Nothing to fix.', []), 'Nothing to fix.');
});
