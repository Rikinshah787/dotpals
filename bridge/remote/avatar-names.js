// Which pal and which face a notification wears, as plain functions the server, the service worker and the generator share.
// The faces are the pal's own agent states (src/element.js AGENT_STATES decides the mood each one shows).

/** The states that have an avatar: every kind of notification maps onto one of these. */
export const AVATAR_STATES = ['done', 'waiting', 'thinking', 'working', 'error'];

/** Notification kind → the pal state that fits it. */
export const STATE_FOR_KIND = {
  done: 'done',          // a request finished: happy
  waiting: 'waiting',    // an agent is waiting for you: wide-eyed
  approval: 'waiting',   // asking permission: the same look
  stuck: 'thinking',     // going in circles: pondering
  conflict: 'error',     // two agents, one file
  loop: 'error',         // gave up on failing tests
  context: 'working',    // context window nearly full: still at it
};

/** The built-in pals (src/characters.js), in order. A custom or draft pal has no avatar picture. */
export const CAST = ['blu', 'hop', 'sunny', 'lovi', 'muse', 'grok', 'nova', 'byte', 'webby'];

const PLAIN = /^[a-z]+-[a-z]+$/;
/** "character-state" for a notification of this kind, or the default pal's, e.g. "blu-done". */
export function avatarName(kind, character) {
  return `${CAST.includes(character) ? character : CAST[0]}-${STATE_FOR_KIND[kind] ?? 'done'}`;
}
/** The picture's address for a name that came from the network, or null when it isn't one of ours. */
export function avatarPath(name) {
  if (typeof name !== 'string' || !PLAIN.test(name)) return null;
  const [character, state] = name.split('-');
  return CAST.includes(character) && AVATAR_STATES.includes(state) ? `/bridge/remote/avatars/${name}.png` : null;
}
