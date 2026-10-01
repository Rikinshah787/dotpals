import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plain, turnMarkdown } from '../bridge/ui/recap.js';

const reply = 'Your last screenshot shows it:\n\n```text\nYou asked · ship\n  Tests passed\n```\n\nEach box is one request.';

test('plain keeps what is inside a code block, without the fences', () => {
  assert.equal(plain(reply), 'Your last screenshot shows it:\n\nYou asked · ship\n  Tests passed\n\nEach box is one request.');
});

test('Copy keeps the agent’s reply as Markdown, code blocks included', () => {
  const md = turnMarkdown({ prompt: { title: 'where is it' }, steps: [], end: { summary: reply }, harness: 'claude', label: 'Dot' });
  assert.ok(md.includes('```text\nYou asked · ship\n  Tests passed\n```'));
  assert.ok(md.startsWith('### where is it'));
});
