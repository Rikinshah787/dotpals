// Dictate: what you said, as text to type where your cursor is. Plain rules, instant and
// on this computer: Whisper already writes sentences with punctuation, so this drops the
// ums and uhs, and acts on a few spoken commands:
//   "new line", "new paragraph"   break the text there
//   "scratch that"                drop the sentence before it

const FILLER = String.raw`\b(?:u+h*m+|u+h+|e+r+m*|a+h+|h+m+|m+h+m+)\b`;

/** "So, um, we ship it. New line. Thanks" → "So we ship it.\nThanks" */
export function cleanDictation(text) {
  let t = ` ${String(text ?? '')} `.replace(new RegExp(`,?\\s*${FILLER}\\s*,?`, 'gi'), ' ');
  t = t.replace(/\s*\bnew paragraph\b[,.!?]?\s*/gi, '\n\n').replace(/\s*\bnew line\b[,.!?]?\s*/gi, '\n');
  // Each "scratch that" takes back the sentence (or clause) just before it.
  for (let m; (m = /[,.]?\s*\bscratch that\b[,.!?]?/i.exec(t));) {
    const before = t.slice(0, m.index).trimEnd().replace(/[.!?,]$/, '').replace(/[^.!?\n]*$/, '');
    t = `${before} ${t.slice(m.index + m[0].length).trimStart()}`;
  }
  return t
    .replace(/[ \t]+([,.!?;:])/g, '$1')
    .replace(/([.!?])[.,]+/g, '$1')
    .replace(/^[\s,.]+/, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim()
    .replace(/(^|[.!?] |\n)([a-z])/g, (_, at, c) => at + c.toUpperCase());
}
