// Dictate: what you said, as text to type where your cursor is. Plain rules, instant and
// on this computer: Whisper already writes sentences with punctuation, so this drops the
// ums and uhs, and acts on a few spoken commands:
//   "new line", "new paragraph"   break the text there
//   "scratch that"                drop the sentence before it

const FILLER = String.raw`\b(?:u+h*m+|u+h+|e+r+m*|a+h+|h+m+|m+h+m+)\b`;

/**
 * Your words (Settings → Blu's brain → Your words): "dotpals" is a word to spell your way (for
 * the AI); "dot pals → dotpals" (or "dot pals = dotpals") is a fix for words the speech
 * recognition keeps mishearing, made every time. → { words: ['dotpals', …], fixes: [['dot pals', 'dotpals'], …] }
 */
export function yourWords(dictionary = []) {
  const words = [], fixes = [];
  for (const entry of dictionary) {
    const m = String(entry).match(/^(.+?)\s*(?:->|→|=)\s*(.+)$/);
    if (m && m[1].trim() && m[2].trim()) { fixes.push([m[1].trim(), m[2].trim()]); words.push(m[2].trim()); }
    else if (String(entry).trim()) words.push(String(entry).trim());
  }
  return { words: [...new Set(words)], fixes };
}

/** The fixes in your words, whole words only, in any case: "Dot pals'" → "dotpals'". */
export function fixWords(text, dictionary = []) {
  let t = String(text ?? '');
  for (const [heard, meant] of yourWords(dictionary).fixes) {
    const escaped = heard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`(?<![\\w'])${escaped}(?![\\w])`, 'gi'), () => meant); // a "$" in yours stays a "$"
  }
  return t;
}

/**
 * Said to your pal ("Hey Blu, what's this?", "Blu, email Sam…"): the request, else null.
 * Speech recognition hears Blu as "Blue" or "Blew". "Hey Blu" always counts; the name alone
 * ("Blu, …") only before something you'd ask, since "Blue, green and red are the options"
 * is just dictation.
 */
const ASKS = /^(what|what's|whats|how|why|when|where|who|which|can|could|would|will|should|is|are|do|does|did|please|tell|show|find|open|draft|write|send|email|mail|message|reply|fix|run|check|make|create|add|remind|search|look|explain|summari[sz]e|review|help|start|stop|schedule|book|note|plan|read|go|give|let|set|turn|ask)\b/i;
export function toPal(text, name = 'Blu') {
  const names = [...new Set(['blu', 'blue', 'blew', String(name).toLowerCase()])].map((n) => n.replace(/[^a-z0-9]/g, '')).filter(Boolean).join('|');
  const t = String(text ?? '');
  const hey = t.match(new RegExp(`^(?:hey|hi|ok|okay)[\\s,]+(?:${names})\\b[,.!:]?\\s*`, 'i'));
  const bare = hey ? null : t.match(new RegExp(`^(?:${names})\\s*[,:!]\\s*`, 'i'));
  const rest = (hey || bare) ? t.slice((hey || bare)[0].length).trim() : '';
  if (!rest || (bare && !ASKS.test(rest))) return null;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

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
