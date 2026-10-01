// The notch's live diff card: an edit's patch as a few lines of code, removed
// lines and added lines, around the newest change. Pure functions (runs in Node).
//
// Patches come in three shapes (see the adapters):
//   "-old\n+new"                       Claude, Cursor, Gemini, OpenCode (toPatch in activity.js;
//                                      MultiEdit joins its edits with "@@")
//   "*** Begin Patch / *** Update File: path / @@ / -old / +new / context"   Codex apply_patch
//   "--- a/x / +++ b/x / @@ -1,3 +1,4 @@ / …"                               a unified diff

/**
 * A patch as display lines, for one file:
 *   { path, lines: [{ sign: '+' | '-' | ' ' | '@', text }], add, del, more, typing }
 * `path` is the file named in the patch (Codex and unified diffs name theirs; with
 * several files, the last one). `lines` is a window of at most `max` lines starting
 * just before the first change; `more` counts the lines left out; `typing` is the
 * index of the newest added line in the window (or -1).
 */
export function diffOf(patch, { max = 9 } = {}) {
  const text = String(patch ?? '').replace(/\r\n/g, '\n');
  const unified = /^@@ -\d+/m.test(text);
  const files = [{ path: null, lines: [] }];
  for (const raw of text.split('\n')) {
    let m;
    if (/^\*\*\* (Begin|End) Patch\b|^\*\*\* End of File\b|^\\ No newline/.test(raw)) continue;
    if ((m = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(raw))) { files.push({ path: m[1].trim(), lines: [] }); continue; }
    if (/^\*\*\* Move to: /.test(raw)) continue;
    if (unified && (m = /^\+\+\+ (?:b\/)?(.+)$/.exec(raw))) { files.at(-1).path = m[1].trim(); continue; }
    if (unified && /^--- /.test(raw)) { if (files.at(-1).lines.length) files.push({ path: null, lines: [] }); continue; }
    if (/^… \(\d+ more characters\)$/.test(raw)) continue; // clipText's marker
    const lines = files.at(-1).lines;
    if (raw.startsWith('@@')) { if (lines.length && lines.at(-1).sign !== '@') lines.push({ sign: '@', text: '' }); continue; }
    const sign = raw[0] === '+' || raw[0] === '-' ? raw[0] : ' ';
    lines.push({ sign, text: sign === ' ' && raw[0] !== ' ' ? raw : raw.slice(1) });
  }
  const file = files.filter((f) => f.lines.some((l) => l.sign === '+' || l.sign === '-')).at(-1) ?? files.at(-1);
  const all = file.lines;
  while (all.length && (all.at(-1).sign === '@' || (all.at(-1).sign === ' ' && !all.at(-1).text.trim()))) all.pop();
  while (all.length && all[0].sign === '@') all.shift();
  const add = all.filter((l) => l.sign === '+').length;
  const del = all.filter((l) => l.sign === '-').length;
  const first = all.findIndex((l) => l.sign === '+' || l.sign === '-');
  const start = first > 0 ? first - 1 : 0;
  const lines = all.slice(start, start + Math.max(1, max));
  let typing = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].sign === '+' && lines[i].text.trim()) { typing = i; break; }
  return { path: file.path, lines, add, del, more: Math.max(0, all.length - start - lines.length), typing };
}

// File extensions → a short chip and its color (the languages' usual colors).
const LANGS = {
  ts: ['TS', '#3178c6'], tsx: ['TSX', '#3178c6'], mts: ['TS', '#3178c6'], cts: ['TS', '#3178c6'],
  js: ['JS', '#e8d44d'], mjs: ['JS', '#e8d44d'], cjs: ['JS', '#e8d44d'], jsx: ['JSX', '#e8d44d'],
  py: ['PY', '#4b8bbe'], rb: ['RB', '#cc342d'], go: ['GO', '#00add8'], rs: ['RS', '#dea584'],
  java: ['JAVA', '#b07219'], kt: ['KT', '#a97bff'], swift: ['SWIFT', '#f05138'], cs: ['C#', '#8a5bd6'],
  c: ['C', '#8f9bb3'], h: ['H', '#8f9bb3'], cpp: ['C++', '#f34b7d'], hpp: ['C++', '#f34b7d'], cc: ['C++', '#f34b7d'],
  php: ['PHP', '#7a86b8'], lua: ['LUA', '#6b6bd6'], dart: ['DART', '#00b4ab'], scala: ['SCALA', '#dc322f'],
  html: ['HTML', '#e34c26'], htm: ['HTML', '#e34c26'], css: ['CSS', '#663399'], scss: ['SCSS', '#c6538c'], less: ['LESS', '#1d365d'],
  vue: ['VUE', '#41b883'], svelte: ['SVELTE', '#ff3e00'], astro: ['ASTRO', '#ff5d01'],
  json: ['JSON', '#9a9aa6'], yml: ['YAML', '#cb171e'], yaml: ['YAML', '#cb171e'], toml: ['TOML', '#9c4221'], xml: ['XML', '#0060ac'],
  md: ['MD', '#9a9aa6'], mdx: ['MDX', '#9a9aa6'], txt: ['TXT', '#62626d'],
  sh: ['SH', '#89e051'], bash: ['SH', '#89e051'], zsh: ['SH', '#89e051'], ps1: ['PS', '#3b7bd4'], bat: ['BAT', '#c1f12e'],
  sql: ['SQL', '#e38c00'], graphql: ['GQL', '#e10098'], dockerfile: ['DOCKER', '#2496ed'],
};

/** A short chip for a file's language: { label: 'TS', color: '#3178c6' }, or null. */
export function language(path) {
  const name = String(path ?? '').split(/[\\/]/).pop().toLowerCase();
  if (!name) return null;
  if (name === 'dockerfile') return { label: 'DOCKER', color: LANGS.dockerfile[1] };
  const ext = name.includes('.') ? name.split('.').pop() : '';
  const known = LANGS[ext];
  if (known) return { label: known[0], color: known[1] };
  return /^[a-z0-9]{1,5}$/.test(ext) ? { label: ext.toUpperCase(), color: '#62626d' } : null;
}
