export type BuiltInCharacter = 'blu' | 'hop' | 'sunny' | 'lovi' | 'muse' | 'grok' | 'nova' | 'byte';
export type BuiltInAction = 'jump' | 'squish' | 'wiggle' | 'shake' | 'nod' | 'spin' | 'love';
export type Mood =
  | 'neutral' | 'happy' | 'sad' | 'surprised' | 'thinking' | 'sleepy' | 'shy'
  | 'listening' | 'working' | 'speaking' | 'waiting';
export type AgentState =
  | 'idle' | 'listening' | 'thinking' | 'working' | 'speaking' | 'waiting' | 'done' | 'error' | 'sleeping';
export interface AgentUpdate { state: AgentState; text?: string }
export type IdleAnimation = 'breathe' | 'bounce' | 'float' | 'wobble' | 'sway' | 'none';

export interface CharacterRenderParams {
  /** Returns an id unique to this element instance, e.g. for gradients. */
  id(name: string): string;
  /** `url(#…)` of the fluffy body gradient (follows the `color` attribute). */
  body: string;
  /** `url(#…)` of the fur filter. */
  fur: string;
}

export interface CharacterDefinition {
  label?: string;
  /** Default body color (any CSS color). */
  color?: string;
  /** Action played on click. */
  tap?: BuiltInAction | (string & {});
  /** How far `.dp-look` parts move toward the pointer, in viewBox units. */
  look?: number;
  /** [x, y] where mood mouths are drawn. */
  mouth?: [number, number];
  /** Horizontal distance of the blush from the mouth. */
  cheek?: number;
  /**
   * Returns SVG markup for a 200×200 viewBox. `body` is wrapped in the fur
   * filter. Use `.dp-blink` and `.dp-look` classes to opt into blinking and
   * pointer following.
   */
  render(params: CharacterRenderParams): {
    defs?: string;
    body: string;
    accessories?: string;
    face?: string;
  };
}

export interface ActionDefinition {
  keyframes: Keyframe[];
  duration?: number;
  easing?: string;
  /** Text/emoji glyph that bursts out of the pal while the action plays. */
  particles?: string;
}

export declare class DotPal extends HTMLElement {
  character: BuiltInCharacter | (string & {});
  color: string | null;
  idle: IdleAnimation;
  mood: Mood;
  state: AgentState;
  look: 'cursor' | 'none';
  static: boolean;
  static readonly actions: string[];
  static readonly characters: string[];
  static readonly moods: Mood[];
  static readonly states: AgentState[];
  play(action: BuiltInAction | (string & {})): Promise<void>;
  setState(state: AgentState, options?: { text?: string }): void;
  say(text: string, options?: { duration?: number }): void;
  flash(mood: Mood, ms?: number): void;
  during<T>(
    task: Promise<T> | (() => Promise<T>),
    options?: { success?: Mood; error?: Mood; revert?: number; successText?: string; errorText?: string; thinkingText?: string }
  ): Promise<T>;
  watch(target: Element | string): () => void;
  blink(): void;
  lookAt(x?: number, y?: number): void;
}

export declare const characters: Record<string, CharacterDefinition>;
export declare const actions: Record<string, ActionDefinition>;
export declare function registerCharacter(name: string, definition: CharacterDefinition): void;
export declare function registerAction(name: string, definition: ActionDefinition): void;
export declare function define(tag?: string): void;
export declare const MOODS: Mood[];
export declare const AGENT_STATES: Record<AgentState, Mood>;
export declare function toAgentState(event: unknown): AgentUpdate | null;
export declare function connectAgent(
  pal: DotPal,
  source: EventTarget | AsyncIterable<unknown>,
  options?: { map?: (event: unknown) => AgentUpdate | null; event?: string }
): () => void;
export declare function agentHandler(
  pal: DotPal,
  options?: { map?: (event: unknown) => AgentUpdate | null }
): (event: unknown) => AgentUpdate | null;

export interface DotPalActionEvent extends CustomEvent<{ action: string }> {}

declare global {
  interface HTMLElementTagNameMap {
    'dot-pal': DotPal;
  }
  interface HTMLElementEventMap {
    'dotpal-action': DotPalActionEvent;
    'dotpal-mood': CustomEvent<{ mood: Mood }>;
    'dotpal-state': CustomEvent<{ state: AgentState; text?: string }>;
  }
}
