import { DotPal } from './element.js';

export { DotPal, MOODS, AGENT_STATES } from './element.js';
export { characters, registerCharacter } from './characters.js';
export { actions, registerAction } from './actions.js';
export { connectAgent, agentHandler, toAgentState } from './agent.js';

/**
 * Register the custom element. Called automatically with the default
 * `dot-pal` tag when this module is imported in a browser.
 */
export function define(tag = 'dot-pal') {
  if (typeof customElements === 'undefined' || customElements.get(tag)) return;
  customElements.define(tag, tag === 'dot-pal' ? DotPal : class extends DotPal {});
}

define();
