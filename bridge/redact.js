// Cleans test output before the checker sees it (bridge/checker.js): anything shaped
// like a credential (private keys, cloud and API tokens, "password=…" assignments,
// passwords in URLs) is removed, and email addresses, IP addresses and your home
// folder are replaced. Patterns can't catch everything, such as a name in free text,
// so the checker only ever gets the end of the output and lines that look like failures.
//
// Adapted from claude-referee by Ismail Dasci, MIT:
//   https://github.com/ismaildasci/claude-referee/blob/main/src/engine/redact.ts
// Ported to plain JavaScript. claude-referee refuses to send anything when it finds a
// credential; dotpals replaces it with [REDACTED:<kind>] instead, so the rest of the
// output can still be checked.

const STOP = [
  ['private_key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g],
  ['aws_access_key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g],
  ['slack_token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai_key', /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g],
  ['typesafe_key', /\bapikey_[0-9a-f]{16,}_[0-9a-f]{16,}/gi],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
];
// "scheme://user:password@host": keep the user and host, drop the password.
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(@)/gi;

const ASSIGNMENT = /([A-Za-z_][A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["'`]?)([^\s"'`,;)}\]]+)/g;
const SECRET_NAME = /key|token|secret|passw(?:or)?d|pwd/i;
const NOT_SECRET_NAME = /page|cursor|next|continuation|label|placeholder|hint|length|type|name|algorithm/i;
const ID_NAME = /(?:[_.-](?:id|ID)|Id|ID)$/;
const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const TYPE_NAME = /^[A-Z]?[a-z]+(?:[A-Z][a-z0-9]*)*$/;
const SECRET_CHARS = /^[A-Za-z0-9+/=_\-.~!@#$%^&*]+$/;
const MEMBER_CHAIN = /^[A-Za-z_$]+(?:\.[A-Za-z_$]+)+$/;
const PLACEHOLDER = /^(?:x{3,}|\*{3,}|\.{3}|changeme|your[_-].*|example.*|dummy.*|fake.*|test.*|placeholder.*|redacted.*|\$.*|process\.env.*|env\..*)$/i;

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

/** Whether `name = value` looks like a secret being set (not an id, a type name or a placeholder). */
export function looksSecret(name, value) {
  if (!SECRET_NAME.test(name) || NOT_SECRET_NAME.test(name) || ID_NAME.test(name)) return false;
  if (value.length < 12 || !SECRET_CHARS.test(value)) return false;
  if (IDENTIFIER.test(value) || TYPE_NAME.test(value) || MEMBER_CHAIN.test(value) || PLACEHOLDER.test(value)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(value)).length;
  return classes >= 3 || (classes >= 2 && value.length >= 20 && /[0-9]/.test(value));
}

// "1.2.3.4" right after "v" or "version", or followed by ".5": a version number, not an address.
function isVersion(text, start, end) {
  return /(?:\bv|version|ver|@|=|[\d.])\s*$/i.test(text.slice(Math.max(0, start - 10), start)) || /^(?:\.\d|[-+][0-9A-Za-z])/.test(text.slice(end, end + 2));
}

/**
 * Clean one piece of text: { text, replaced: { kind: count } }.
 * `secrets` adds exact strings to remove too (e.g. the API key in use, just in case).
 */
export function redactText(input, { home, secrets = [] } = {}) {
  const replaced = {};
  const bump = (kind) => { replaced[kind] = (replaced[kind] ?? 0) + 1; return `[REDACTED:${kind}]`; };
  let out = String(input ?? '');
  for (const s of secrets) if (s && s.length >= 8 && out.includes(s)) out = out.split(s).join(bump('secret'));
  for (const [kind, re] of STOP) out = out.replace(re, () => bump(kind));
  out = out.replace(URL_CREDENTIALS, (_, start, _pw, at) => `${start}${bump('url_credentials')}${at}`);
  out = out.replace(ASSIGNMENT, (whole, name, sep, value) => (looksSecret(name, value) ? `${name}${sep}${bump('secret_assignment')}` : whole));
  if (home && home.length > 1) {
    for (const h of new Set([home, home.replace(/\\/g, '/')])) if (out.includes(h)) { out = out.split(h).join('~'); replaced.home = (replaced.home ?? 0) + 1; }
  }
  out = out.replace(EMAIL, () => bump('email'));
  out = out.replace(IPV4, (match, offset, whole) => (isVersion(whole, offset, offset + match.length) ? match : bump('ip')));
  return { text: out, replaced };
}

/** Clean every string in a value (objects, arrays): { value, replaced }. */
export function redact(value, options = {}) {
  const replaced = {};
  const walk = (node) => {
    if (typeof node === 'string') {
      const r = redactText(node, options);
      for (const [k, n] of Object.entries(r.replaced)) replaced[k] = (replaced[k] ?? 0) + n;
      return r.text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    return node;
  };
  return { value: walk(value), replaced };
}
