export type BuiltInCharacter = 'blu' | 'hop' | 'sunny' | 'lovi' | 'muse' | 'grok' | 'nova' | 'byte' | 'webby';
export type BuiltInAction =
  | 'jump' | 'squish' | 'wiggle' | 'shake' | 'nod' | 'spin' | 'love'
  | 'hop' | 'jitter' | 'hello' | 'drop' | 'dizzy';
/** Faces for `pal.emote()`. */
export type Emote = 'happy' | 'love' | 'star' | 'wide' | 'closed' | 'dizzy' | 'oops' | 'hey' | 'sweat';
/** Built-in particle shapes (inline SVG, the same on every OS). */
export type ParticleKind = 'heart' | 'sparkle' | 'star' | 'sweat' | 'z';
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
   * Where the two eyes are, so the pal can swap in expression eyes (happy arcs,
   * hearts, spirals…) for moods and emotes. Without it, the normal eyes squint.
   * The parts marked `.dp-eyes` (or else `.dp-blink`) hide while they show.
   */
  eyes?: CharacterEyes;
  /** Hangs on a thread (drawn as `.dp-thread`, hidden on tiny pals) and swings from the top of it while idle. */
  hang?: boolean;
  /** Actions to play instead of the usual ones for `greet()` (`hello`) and when entering a state. */
  moves?: Partial<Record<'hello' | 'done' | 'error' | 'waiting', BuiltInAction | (string & {})>>;
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

export interface CharacterEyes {
  /** Centres of the left and right eye, in viewBox units. */
  at: [[number, number], [number, number]];
  /** Rough eye radius, in viewBox units. */
  r: number;
  /** Colour of the expression eyes (default: near-black ink). */
  ink?: string;
  /** Glow around them: `true` for a light-blue glow, or any CSS colour. */
  glow?: boolean | string;
  /** Expressions the character's own eyes already show well (e.g. `['wide']` for big eyes): no swap for those. */
  own?: string[];
}

export interface ActionDefinition {
  keyframes: Keyframe[];
  duration?: number;
  easing?: string;
  /** Particles that burst out while the action plays: a built-in shape, or any text/emoji glyph. */
  particles?: ParticleKind | (string & {});
}

export declare class DotPal extends HTMLElement {
  character: BuiltInCharacter | (string & {});
  color: string | null;
  idle: IdleAnimation;
  mood: Mood;
  state: AgentState;
  look: 'cursor' | 'none';
  static: boolean;
  // The pal leans slightly toward the pointer; the attribute lean="none" turns that off.
  /** True while the pal is drawn smaller than 48 px (reflected as the `tiny` attribute): no fur, bigger eyes. */
  readonly tiny: boolean;
  static readonly actions: string[];
  static readonly characters: string[];
  /** Re-draw every pal using `name` (after registerCharacter() changed it). */
  static refresh(name: string): void;
  static readonly moods: Mood[];
  static readonly states: AgentState[];
  /** Names of every emote. */
  static readonly emotes: Emote[];
  /**
   * Tell every pal where the cursor is, in viewport CSS px. Use it when the cursor is
   * tracked outside the page, e.g. by a desktop app watching the whole screen.
   */
  static pointAt(x: number, y: number): void;
  play(action: BuiltInAction | (string & {})): Promise<void>;
  setState(state: AgentState, options?: { text?: string }): void;
  say(text: string, options?: { duration?: number }): void;
  flash(mood: Mood, ms?: number): void;
  during<T>(
    task: Promise<T> | (() => Promise<T>),
    options?: { success?: Mood; error?: Mood; revert?: number; successText?: string; errorText?: string; thinkingText?: string }
  ): Promise<T>;
  watch(target: Element | string): () => void;
  /** Show a face for `ms` milliseconds (default 1600). Resolves when it ends. */
  emote(name: Emote, ms?: number): Promise<void>;
  /** Rise up from below the ledge, squint happily, hop and blink twice. */
  greet(): Promise<void>;
  /** Throw a few particles (default: 6 sparkles). */
  burst(kind?: ParticleKind | (string & {}), count?: number): void;
  blink(): void;
  lookAt(x?: number, y?: number): void;
}

export declare const characters: Record<string, CharacterDefinition>;
export declare const actions: Record<string, ActionDefinition>;
export declare function registerCharacter(name: string, definition: CharacterDefinition & { fur?: boolean }): void;

/** Your own pal: a body, eyes, something on top, a color and a name. */
export interface CustomPal {
  name?: string;
  shape?: 'round' | 'square' | 'blob' | 'tall' | 'heart' | 'bean';
  eyes?: 'dots' | 'round' | 'googly' | 'pixel' | 'visor' | 'shades';
  top?: 'none' | 'ears' | 'horns' | 'antenna' | 'sprout' | 'sparkle' | 'bow' | 'crown' | 'beret';
  color?: string;
  fur?: boolean;
}
export declare const CUSTOM_OPTIONS: { shape: Record<string, string>; eyes: Record<string, string>; top: Record<string, string> };
export declare const DEFAULT_CUSTOM: Required<CustomPal>;
export declare function cleanCustom(spec: unknown): Required<CustomPal> | null;
export declare function buildCharacter(spec: CustomPal): CharacterDefinition;
/** Register your pal (as `character="custom"` unless you pass a name). */
export declare function registerCustom(spec: CustomPal, name?: string): string;
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
/** Fired on every click; `count` is how many quick clicks in a row (3 makes the pal dizzy). */
export interface DotPalPokeEvent extends CustomEvent<{ count: number }> {}

declare global {
  interface HTMLElementTagNameMap {
    'dot-pal': DotPal;
  }
  interface HTMLElementEventMap {
    'dotpal-action': DotPalActionEvent;
    'dotpal-mood': CustomEvent<{ mood: Mood }>;
    'dotpal-state': CustomEvent<{ state: AgentState; text?: string }>;
    'dotpal-poke': DotPalPokeEvent;
  }
}
