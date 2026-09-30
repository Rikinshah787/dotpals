import { characters } from './characters.js';
import { actions } from './actions.js';

const Base = typeof HTMLElement === 'undefined' ? class {} : HTMLElement;
const IDLES = ['breathe', 'bounce', 'float', 'wobble', 'sway', 'none'];
export const MOODS = [
  'neutral', 'happy', 'sad', 'surprised', 'thinking', 'sleepy', 'shy',
  'listening', 'working', 'speaking', 'waiting',
];

// Moods where the eyes are closed or fixed, so they don't blink or follow the pointer.
const CLOSED_EYES = ['sleepy', 'shy'];
const FIXED_GAZE = {
  thinking: [0.7, -0.9],
  working: [0.2, 0.9],
  sad: [0, 0.9],
  sleepy: [0, 0.4],
  shy: [-0.9, 0.5],
};

// Moods where the fixed gaze moves around a little: where to look next.
let ponderSide = 1;
const ACTIVE_GAZE = {
  thinking: () => [(ponderSide = -ponderSide) * rand(0.45, 0.85), rand(-1, -0.55)],
  working: () => [rand(-0.75, 0.75), rand(0.6, 1)],
};

// Agent lifecycle states and the mood each one shows.
export const AGENT_STATES = {
  idle: 'neutral',
  listening: 'listening',
  thinking: 'thinking',
  working: 'working',
  speaking: 'speaking',
  waiting: 'waiting',
  done: 'happy',
  error: 'sad',
  sleeping: 'sleepy',
};

const styles = `
  :host {
    --dp-size: 160px;
    display: inline-block;
    position: relative;
    width: var(--dp-size);
    height: var(--dp-size);
    vertical-align: bottom;
    /* Clip only the bottom edge, so pals "peek" over a ledge and can jump. */
    clip-path: inset(-100vh -100vw 0 -100vw);
    -webkit-tap-highlight-color: transparent;
    user-select: none;
  }
  :host([hidden]) { display: none; }
  :host(:not([static])) { cursor: pointer; }

  .dp-root, .dp-idle, .dp-actor { width: 100%; height: 100%; }
  .dp-idle, .dp-actor { transform-origin: 50% 100%; }
  .dp-idle { perspective: 600px; }
  svg { display: block; width: 100%; height: 100%; overflow: visible; transition: filter .4s; }

  .dp-look {
    transition: transform .22s cubic-bezier(.3, .7, .4, 1);
  }
  .dp-blink {
    transform-box: fill-box;
    transform-origin: center;
    transition: transform .25s cubic-bezier(.3, .7, .4, 1);
  }

  /* -- idle loops ---------------------------------------------------------- */

  .dp-idle { animation: dp-breathe 3.4s ease-in-out infinite var(--dp-delay, 0s); }
  :host([idle="bounce"]) .dp-idle { animation: dp-bounce 1.3s infinite var(--dp-delay, 0s); }
  :host([idle="float"])  .dp-idle { animation: dp-float 3s ease-in-out infinite var(--dp-delay, 0s); }
  :host([idle="wobble"]) .dp-idle { animation: dp-wobble 2.6s ease-in-out infinite var(--dp-delay, 0s); }
  :host([idle="sway"])   .dp-idle { animation: dp-sway 2.2s ease-in-out infinite var(--dp-delay, 0s); }
  :host([idle="none"])   .dp-idle { animation: none; }

  /* -- moods (override the idle loop) -------------------------------------- */

  :host([mood="happy"])    .dp-idle { animation: dp-bounce .9s infinite; }
  :host([mood="sad"])      .dp-idle { animation: dp-droop 4s ease-in-out infinite; }
  :host([mood="thinking"]) .dp-idle { animation: dp-ponder 3.2s ease-in-out infinite; }
  :host([mood="sleepy"])   .dp-idle { animation: dp-snore 4.5s ease-in-out infinite; }
  :host([mood="shy"])      .dp-idle { animation: dp-shy 2.8s ease-in-out infinite; }
  :host([mood="listening"]) .dp-idle { animation: dp-lean 2.6s ease-in-out infinite; }
  :host([mood="working"])  .dp-idle { animation: dp-busy .5s ease-in-out infinite; }
  :host([mood="speaking"]) .dp-idle { animation: dp-breathe 1.6s ease-in-out infinite; }
  :host([mood="waiting"])  .dp-idle { animation: dp-wobble 2.2s ease-in-out infinite; }
  :host([mood="sad"]) svg  { filter: saturate(.65) brightness(.88); }

  :host([mood="happy"])     .dp-blink { transform: scaleY(.5); }
  :host([mood="sad"])       .dp-blink { transform: scaleY(.8); }
  :host([mood="surprised"]) .dp-blink { transform: scale(1.2); }
  :host([mood="listening"]) .dp-blink { transform: scale(1.1); }
  :host([mood="working"])   .dp-blink { transform: scaleY(.7); }
  :host([mood="sleepy"])    .dp-blink,
  :host([mood="shy"])       .dp-blink { transform: scaleY(.08); }

  .dp-mouth > *, .dp-cheeks { opacity: 0; transition: opacity .2s; }
  .dp-mouth > * { transform: scale(.4); transition: opacity .2s, transform .3s cubic-bezier(.3, 1.6, .5, 1); }
  :host([mood="happy"])     .dp-m-happy,
  :host([mood="sad"])       .dp-m-sad,
  :host([mood="surprised"]) .dp-m-surprised,
  :host([mood="thinking"])  .dp-m-thinking,
  :host([mood="sleepy"])    .dp-m-sleepy,
  :host([mood="shy"])       .dp-m-shy,
  :host([mood="working"])   .dp-m-working,
  :host([mood="speaking"])  .dp-m-speaking { opacity: 1; transform: scale(1); }
  :host([mood="speaking"])  .dp-m-speaking { animation: dp-talk .32s ease-in-out infinite alternate; }
  :host([mood="happy"]) .dp-cheeks,
  :host([mood="shy"])   .dp-cheeks { opacity: .55; }

  @keyframes dp-breathe {
    0%, 100% { transform: scale(1, 1); }
    50%      { transform: scale(.985, 1.035); }
  }
  @keyframes dp-bounce {
    0%, 100% { transform: translateY(0) scale(1.05, .95); animation-timing-function: cubic-bezier(.2, .7, .4, 1); }
    12%      { transform: translateY(0) scale(1, 1); animation-timing-function: cubic-bezier(.2, .7, .4, 1); }
    50%      { transform: translateY(-9%) scale(.97, 1.03); animation-timing-function: cubic-bezier(.6, 0, .8, .3); }
    88%      { transform: translateY(0) scale(1, 1); }
  }
  @keyframes dp-float {
    0%, 100% { transform: translateY(0); }
    50%      { transform: translateY(-6%); }
  }
  @keyframes dp-wobble {
    0%, 100% { transform: rotate(-3deg); }
    50%      { transform: rotate(3deg); }
  }
  @keyframes dp-sway {
    0%, 100% { transform: skewX(-4deg); }
    50%      { transform: skewX(4deg); }
  }
  @keyframes dp-lean {
    0%, 100% { transform: rotate(3deg) scale(1.01); }
    50%      { transform: rotate(4deg) scale(1.02, 1.03); }
  }
  @keyframes dp-busy {
    0%, 100% { transform: translateY(0) scale(1, 1); }
    50%      { transform: translateY(-1.5%) scale(.99, 1.02); }
  }
  @keyframes dp-talk {
    from { transform: scale(1, .35); }
    to   { transform: scale(1, 1.1); }
  }
  @keyframes dp-droop {
    0%, 100% { transform: scale(1.03, .93); }
    50%      { transform: scale(1.04, .91); }
  }
  @keyframes dp-ponder {
    0%, 100% { transform: rotate(-4deg) translateY(0); }
    25%      { transform: rotate(-1deg) translateY(-4%); }
    50%      { transform: rotate(3deg) translateY(-1%); }
    75%      { transform: rotate(0deg) translateY(-5%); }
  }
  @keyframes dp-snore {
    0%, 100% { transform: scale(1.02, .96); }
    50%      { transform: scale(.98, 1.05); }
  }
  @keyframes dp-shy {
    0%, 100% { transform: rotate(-5deg) scale(.96); }
    50%      { transform: rotate(-3deg) scale(.95, .97); }
  }

  /* -- speech bubble & particles ------------------------------------------ */

  .dp-bubble {
    position: absolute;
    left: 50%;
    bottom: 88%;
    max-width: max(180px, calc(var(--dp-size) * 1.4));
    width: max-content;
    padding: .5em .85em;
    border-radius: 1.1em;
    background: #fff;
    color: #16161a;
    font: 600 max(13px, calc(var(--dp-size) * .075))/1.3 ui-rounded, "SF Pro Rounded", system-ui, sans-serif;
    text-align: center;
    box-shadow: 0 6px 18px rgb(0 0 0 / .22);
    opacity: 0;
    transform: translate(-50%, 8px) scale(.85);
    transform-origin: 50% 100%;
    transition: opacity .2s, transform .35s cubic-bezier(.3, 1.5, .5, 1);
    pointer-events: none;
  }
  .dp-bubble::after {
    content: "";
    position: absolute;
    left: 50%;
    top: 100%;
    border: .45em solid transparent;
    border-top-color: #fff;
    transform: translateX(-50%);
  }
  .dp-bubble.dp-show { opacity: 1; transform: translate(-50%, 0) scale(1); }
  .dp-dots { display: inline-flex; gap: .25em; padding: .25em 0; }
  .dp-dots i {
    width: .45em;
    height: .45em;
    border-radius: 50%;
    background: currentColor;
    animation: dp-dot 1s ease-in-out infinite;
  }
  .dp-dots i:nth-child(2) { animation-delay: .15s; }
  .dp-dots i:nth-child(3) { animation-delay: .3s; }
  .dp-bar {
    display: block;
    width: 3.2em;
    height: .45em;
    margin: .3em 0;
    border-radius: 1em;
    background: linear-gradient(90deg, transparent 0 30%, currentColor 30% 60%, transparent 60%) 0 0 / 200% 100%, #e3e3ea;
    animation: dp-bar 1s linear infinite;
  }
  @keyframes dp-bar { to { background-position: -200% 0, 0 0; } }
  .dp-ask { display: block; min-width: .9em; font-size: 1.25em; line-height: 1; }
  @keyframes dp-dot {
    0%, 60%, 100% { transform: translateY(0); opacity: .35; }
    30%           { transform: translateY(-.3em); opacity: 1; }
  }

  .dp-particle {
    position: absolute;
    left: 50%;
    top: 20%;
    color: var(--dp-c);
    font-weight: 700;
    line-height: 1;
    pointer-events: none;
    filter: drop-shadow(0 2px 3px rgb(0 0 0 / .25));
  }
  .dp-particle.dp-z { color: #fff; font-family: ui-rounded, system-ui, sans-serif; }

  @media (prefers-reduced-motion: reduce) {
    .dp-idle { animation: none !important; }
    .dp-look, .dp-blink { transition: none; }
    .dp-dots i { animation: none; opacity: .7; }
  }
`;

// ---------------------------------------------------------------------------
// Shared pointer tracking: one listener for every pal on the page.

const pals = new Set();
const pointer = { x: 0, y: 0, t: 0 };
let tracking = false;
let frame = 0;

function trackPointer() {
  if (tracking || typeof window === 'undefined') return;
  tracking = true;
  window.addEventListener(
    'pointermove',
    (e) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.t = performance.now();
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          for (const pal of pals) pal._followPointer();
        });
      }
    },
    { passive: true }
  );
}

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const rand = (min, max) => min + Math.random() * (max - min);

let measureCtx;
/** Viewport position of the text caret in an input/textarea (approximate). */
function caretPoint(field) {
  const r = field.getBoundingClientRect();
  const cs = getComputedStyle(field);
  if (field.tagName === 'TEXTAREA') return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = cs.font;
  const text = field.value.slice(0, field.selectionStart ?? field.value.length);
  const padL = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
  const x = Math.min(r.left + padL + measureCtx.measureText(text).width - field.scrollLeft, r.right - 8);
  return { x, y: r.top + r.height / 2 };
}

let uid = 0;

// ---------------------------------------------------------------------------

export class DotPal extends Base {
  static observedAttributes = ['character', 'color', 'size', 'label', 'mood', 'state'];

  #n = ++uid;
  #uid = `dp${this.#n}`;
  #def;
  #svg;
  #root;
  #actor;
  #bubble;
  #blinkEls = [];
  #lookEls = [];
  #anim = null;
  #timer = 0;
  #zzz = 0;
  #sayTimer = 0;
  #saying = false;
  #target = null; // a viewport point to look at instead of the pointer
  // Temporary moods (from during(), watch(), flash()) restore the previous mood.
  #temp = { active: false, prev: null, token: 0 };
  #stateText;
  #stateTimer = 0;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${styles}</style>
      <div class="dp-root" part="root">
        <div class="dp-idle" part="idle">
          <div class="dp-actor" part="actor">
            <svg viewBox="0 0 200 200" part="svg" aria-hidden="true"></svg>
          </div>
        </div>
        <div class="dp-bubble" part="bubble" aria-hidden="true"></div>
      </div>`;
    this.#root = shadow.querySelector('.dp-root');
    this.#actor = shadow.querySelector('.dp-actor');
    this.#svg = shadow.querySelector('svg');
    this.#bubble = shadow.querySelector('.dp-bubble');

    this.addEventListener('pointerenter', () => {
      if (!this.static && !this.#anim) this.play('squish');
    });
    this.addEventListener('click', () => {
      if (!this.static) this.play(this.#def.tap);
    });
  }

  connectedCallback() {
    if (!this.#def) this.#render();
    if (!this.hasAttribute('role')) this.setAttribute('role', 'img');
    // Desynchronise idle loops so a row of pals doesn't move in lockstep.
    this.style.setProperty('--dp-delay', `${-rand(0, 3).toFixed(2)}s`);
    this.#applySize();
    if (this.hasAttribute('state')) this.#applyState();
    else this.#applyMood();
    pals.add(this);
    trackPointer();
    this.#scheduleBlink();
  }

  disconnectedCallback() {
    pals.delete(this);
    clearTimeout(this.#stateTimer);
    clearTimeout(this.#timer);
    clearInterval(this.#zzz);
    this.#zzz = 0;
  }

  attributeChangedCallback(name, oldValue, value) {
    if (oldValue === value) return;
    if (name === 'size') this.#applySize();
    else if (name === 'color') this.#applyColor();
    else if (name === 'label') this.#applyLabel();
    else if (name === 'mood') this.#applyMood(oldValue);
    else if (name === 'state') this.#applyState();
    else if (this.#def) this.#render();
  }

  // -- properties ------------------------------------------------------------

  get character() { return this.getAttribute('character') || 'blu'; }
  set character(v) { this.setAttribute('character', v); }

  get color() { return this.getAttribute('color'); }
  set color(v) { v == null ? this.removeAttribute('color') : this.setAttribute('color', v); }

  get idle() {
    const v = this.getAttribute('idle');
    return IDLES.includes(v) ? v : 'breathe';
  }
  set idle(v) { this.setAttribute('idle', v); }

  get mood() {
    const v = this.getAttribute('mood');
    return MOODS.includes(v) ? v : 'neutral';
  }
  set mood(v) {
    // An explicit mood cancels any temporary one.
    this.#temp.active = false;
    this.#temp.token++;
    this.#setMood(v);
  }

  /** Agent state: idle · listening · thinking · working · speaking · waiting · done · error · sleeping */
  get state() {
    const v = this.getAttribute('state');
    return v in AGENT_STATES ? v : 'idle';
  }
  set state(v) { this.setState(v); }

  get look() { return this.getAttribute('look') === 'none' ? 'none' : 'cursor'; }
  set look(v) { this.setAttribute('look', v); }

  get static() { return this.hasAttribute('static'); }
  set static(v) { this.toggleAttribute('static', !!v); }

  /** Names of every registered action. */
  static get actions() { return Object.keys(actions); }

  /** Names of every registered character. */
  static get characters() { return Object.keys(characters); }

  /** Names of every mood. */
  static get moods() { return [...MOODS]; }

  /** Names of every agent state. */
  static get states() { return Object.keys(AGENT_STATES); }

  // -- public API ------------------------------------------------------------

  /**
   * Play a one-shot action ('jump', 'squish', 'wiggle', 'shake', 'nod', 'spin', 'love', …).
   * Resolves when the animation finishes or is interrupted.
   */
  play(name) {
    const action = actions[name];
    if (!action) {
      console.warn(`[dotpals] Unknown action "${name}". Try: ${Object.keys(actions).join(', ')}`);
      return Promise.resolve();
    }
    this.#anim?.cancel();
    const anim = this.#actor.animate(action.keyframes, {
      duration: action.duration,
      easing: action.easing || 'ease-out',
    });
    this.#anim = anim;
    if (action.particles) this.#burst(action.particles);
    this.dispatchEvent(new CustomEvent('dotpal-action', { detail: { action: name }, bubbles: true, composed: true }));
    return anim.finished
      .catch(() => {})
      .finally(() => {
        if (this.#anim === anim) this.#anim = null;
      });
  }

  /**
   * Show what an AI agent is doing. `text` (optional) appears in a bubble,
   * e.g. the tool being run or the question being asked.
   *
   *   pal.setState('working', { text: 'Reading files…' });
   */
  setState(state, { text } = {}) {
    if (!(state in AGENT_STATES)) {
      console.warn(`[dotpals] Unknown state "${state}". Try: ${Object.keys(AGENT_STATES).join(', ')}`);
      return;
    }
    const changed = state !== this.getAttribute('state');
    this.#stateText = text;
    if (changed) this.setAttribute('state', state); // → #applyState()
    else this.#applyStateText();
  }

  /**
   * Show a speech bubble. It hides after `duration` ms (default: based on
   * length); pass `duration: 0` to keep it until `say('')` is called.
   */
  say(text, { duration } = {}) {
    clearTimeout(this.#sayTimer);
    this.#saying = !!text;
    if (!text) return this.#syncBubble();
    this.#bubble.textContent = text;
    this.#bubble.classList.add('dp-show');
    const ms = duration ?? Math.min(6000, 1800 + text.length * 60);
    if (ms > 0) {
      this.#sayTimer = setTimeout(() => {
        this.#saying = false;
        this.#syncBubble();
      }, ms);
    }
  }

  /**
   * Switch to a mood for `ms` milliseconds, then return to the previous mood.
   */
  flash(mood, ms = 2000) {
    const token = this.#pushTemp(mood);
    setTimeout(() => this.#popTemp(token), ms);
  }

  /**
   * Show progress for an async task: `thinking` while it runs, then `happy`
   * (and a jump) on success or `sad` (and a shake) on failure. The previous
   * mood comes back after `revert` ms. Returns the task's result.
   *
   *   await pal.during(fetch('/api/save'), { successText: 'Saved!' });
   */
  async during(task, { success = 'happy', error = 'sad', revert = 2200, successText, errorText, thinkingText } = {}) {
    const token = this.#pushTemp('thinking');
    if (thinkingText) this.say(thinkingText, { duration: 0 });
    const end = (mood, action, text) => {
      if (token !== this.#temp.token) return; // superseded by a newer mood
      this.#setMood(mood);
      this.play(action);
      if (text) this.say(text);
      else if (thinkingText) this.say('');
      setTimeout(() => this.#popTemp(token), revert);
    };
    try {
      const result = await (typeof task === 'function' ? task() : task);
      end(success, 'jump', successText);
      return result;
    } catch (err) {
      end(error, 'shake', errorText);
      throw err;
    }
  }

  /**
   * Turn the pal into a form companion. It watches the text you type, covers
   * its eyes on password fields, gets sad on invalid input and cheers on a
   * valid submit. `target` is a form, any container, or a selector.
   * Returns a function that stops watching.
   */
  watch(target) {
    const root = typeof target === 'string' ? document.querySelector(target) : target;
    if (!root) throw new TypeError('[dotpals] watch() target not found');
    const isField = (el) => el?.matches?.('input:not([type=checkbox],[type=radio],[type=range]), textarea');
    let shyToken = null;

    const aim = (el) => {
      if (!isField(el) || el !== document.activeElement) return;
      if (el.type === 'password') {
        this.#target = null;
        if (shyToken === null) shyToken = this.#pushTemp('shy');
        return;
      }
      if (shyToken !== null) {
        this.#popTemp(shyToken);
        shyToken = null;
      }
      this.#target = caretPoint(el);
      this._followPointer();
    };
    const onEvent = (e) => aim(e.target);
    const onFocusOut = () =>
      setTimeout(() => {
        if (root.contains(document.activeElement)) return aim(document.activeElement);
        this.#target = null;
        if (shyToken !== null) this.#popTemp(shyToken);
        shyToken = null;
      });
    const onInvalid = () => {
      if (this.#anim?.playState !== 'running') this.play('shake');
      this.flash('sad', 1600);
    };
    const onSubmit = () => {
      shyToken = null;
      this.#target = null;
      this.play('jump');
      this.flash('happy', 2200);
    };

    const events = { focusin: onEvent, input: onEvent, keyup: onEvent, click: onEvent, select: onEvent, focusout: onFocusOut, submit: onSubmit };
    for (const [type, fn] of Object.entries(events)) root.addEventListener(type, fn);
    root.addEventListener('invalid', onInvalid, true); // `invalid` doesn't bubble
    if (root.contains(document.activeElement)) aim(document.activeElement);

    return () => {
      for (const [type, fn] of Object.entries(events)) root.removeEventListener(type, fn);
      root.removeEventListener('invalid', onInvalid, true);
      this.#target = null;
      if (shyToken !== null) this.#popTemp(shyToken);
    };
  }

  /** Blink once (skipped while the eyes are closed). */
  blink() {
    if (CLOSED_EYES.includes(this.mood)) return;
    for (const el of this.#blinkEls) {
      const base = getComputedStyle(el).transform;
      const open = base === 'none' ? 'scaleY(1)' : base;
      el.animate([{ transform: open }, { transform: 'scaleY(.08)', offset: 0.45 }, { transform: open }], {
        duration: 170,
        easing: 'ease-in-out',
      });
    }
  }

  /**
   * Point the eyes in a direction. `x` and `y` range from -1 to 1;
   * `lookAt(0, 0)` looks straight ahead.
   */
  lookAt(x = 0, y = 0) {
    const range = this.#def?.look ?? 0;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    const t = `translate(${(x * range).toFixed(2)}px, ${(y * range * 0.75).toFixed(2)}px)`;
    for (const el of this.#lookEls) el.style.transform = t;
  }

  // -- internals -------------------------------------------------------------

  /** @internal Called by the shared pointer tracker. */
  _followPointer() {
    if (this.look === 'none' || FIXED_GAZE[this.mood]) return;
    const r = this.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return;
    const { x, y } = this.#target ?? pointer;
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + r.height * 0.68);
    const dist = Math.hypot(dx, dy) || 1;
    const strength = this.#target ? 1 : Math.min(1, dist / (r.width * 1.5));
    this.lookAt((dx / dist) * strength, (dy / dist) * strength);
  }

  #applyState() {
    if (!this.isConnected) return;
    const state = this.state;
    clearTimeout(this.#stateTimer);
    this.mood = AGENT_STATES[state];
    if (state === 'done') {
      this.play('jump');
      // Celebrate briefly, then settle back to idle.
      this.#stateTimer = setTimeout(() => {
        if (this.state === 'done') this.mood = 'neutral';
      }, 2400);
    } else if (state === 'error') {
      this.play('shake');
    }
    this.#applyStateText();
    this.dispatchEvent(new CustomEvent('dotpal-state', { detail: { state, text: this.#stateText }, bubbles: true, composed: true }));
  }

  #applyStateText() {
    const text = this.#stateText;
    const transient = ['done', 'error', 'speaking', 'idle'].includes(this.state);
    this.say(text || '', { duration: transient ? undefined : 0 });
  }

  #setMood(v) {
    if (v == null || v === 'neutral') this.removeAttribute('mood');
    else this.setAttribute('mood', v);
  }

  #pushTemp(mood) {
    if (!this.#temp.active) {
      this.#temp.active = true;
      this.#temp.prev = this.getAttribute('mood');
    }
    this.#setMood(mood);
    return ++this.#temp.token;
  }

  #popTemp(token) {
    if (token !== this.#temp.token || !this.#temp.active) return;
    this.#temp.active = false;
    this.#setMood(this.#temp.prev);
  }

  #applyMood(previous) {
    if (!this.isConnected) return;
    const mood = this.mood;

    const gaze = FIXED_GAZE[mood];
    if (gaze) this.lookAt(...gaze);
    if (ACTIVE_GAZE[mood] !== ACTIVE_GAZE[previous]) this.#scheduleBlink(); // switch to the busy rhythm now
    else if (previous && FIXED_GAZE[previous]) {
      this.lookAt(0, 0);
      this._followPointer();
    }

    if (mood === 'surprised' && previous !== 'surprised') this.play('jump');

    clearInterval(this.#zzz);
    this.#zzz = 0;
    if (mood === 'sleepy' && !reducedMotion()) {
      this.#snore();
      this.#zzz = setInterval(() => this.#snore(), 1700);
    }
    this.#syncBubble();
    this.#applyLabel();
    this.dispatchEvent(new CustomEvent('dotpal-mood', { detail: { mood }, bubbles: true, composed: true }));
  }

  #syncBubble() {
    if (this.#saying) return;
    const content = {
      thinking: '<span class="dp-dots"><i></i><i></i><i></i></span>',
      working: '<span class="dp-bar"></span>',
      waiting: '<span class="dp-ask">?</span>',
    }[this.mood];
    if (content) {
      this.#bubble.innerHTML = content;
      this.#bubble.classList.add('dp-show');
    } else {
      this.#bubble.classList.remove('dp-show');
    }
  }

  #render() {
    let def = characters[this.character];
    if (!def) {
      console.warn(`[dotpals] Unknown character "${this.character}". Try: ${Object.keys(characters).join(', ')}`);
      def = characters.blu;
    }
    this.#def = def;

    const id = (name) => `${this.#uid}-${name}`;
    const seed = (this.#n * 7) % 97;
    const parts = def.render({ id, body: `url(#${id('body')})`, fur: `url(#${id('fur')})` });
    const stop = (offset, mix) =>
      `<stop offset="${offset}" style="stop-color: color-mix(in srgb, var(--dp-c) ${mix})"/>`;
    const [mx, my] = def.mouth ?? [100, 170];
    const cheek = def.cheek ?? 34;
    const ink = '#0b0b12';

    this.#svg.innerHTML = `
      <defs>
        <radialGradient id="${id('body')}" gradientUnits="userSpaceOnUse" cx="78" cy="70" fx="62" fy="54" r="215">
          ${stop(0, '62%, #fff')}
          ${stop(0.42, '100%, #fff')}
          ${stop(0.8, '82%, #000')}
          ${stop(1, '58%, #000')}
        </radialGradient>
        <filter id="${id('fur')}" x="-15%" y="-15%" width="130%" height="130%" color-interpolation-filters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="2" seed="${seed}" result="noise"/>
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="6" xChannelSelector="R" yChannelSelector="G" result="shape"/>
          <!-- plush fibres -->
          <feTurbulence type="fractalNoise" baseFrequency="1.7 1.4" numOctaves="2" seed="${seed + 1}" result="fine"/>
          <feDiffuseLighting in="fine" surfaceScale="1.6" lighting-color="#fff" result="bump">
            <feDistantLight azimuth="235" elevation="62"/>
          </feDiffuseLighting>
          <feComposite in="bump" in2="shape" operator="in" result="bumpIn"/>
          <feBlend in="shape" in2="bumpIn" mode="multiply" result="furry"/>
          <!-- soft darkening toward the silhouette for volume -->
          <feGaussianBlur in="shape" stdDeviation="12" result="soft"/>
          <feComposite in="shape" in2="soft" operator="arithmetic" k2="1" k3="-1" result="rim"/>
          <feFlood flood-color="#000" flood-opacity=".55"/>
          <feComposite in2="rim" operator="in" result="rimShade"/>
          <feComposite in="rimShade" in2="furry" operator="atop" result="shaded"/>
          <feComponentTransfer in="shaded">
            <feFuncR type="linear" slope="1.12"/>
            <feFuncG type="linear" slope="1.12"/>
            <feFuncB type="linear" slope="1.12"/>
          </feComponentTransfer>
        </filter>
        <filter id="${id('blush')}" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3"/>
        </filter>
        ${parts.defs || ''}
      </defs>
      <g class="dp-body" filter="url(#${id('fur')})">${parts.body}</g>
      ${parts.accessories || ''}
      <g class="dp-face">${parts.face || ''}</g>
      <g class="dp-expr" transform="translate(${mx} ${my})">
        <g class="dp-cheeks" fill="#ff4d7e" filter="url(#${id('blush')})">
          <ellipse cx="${-cheek}" cy="-8" rx="11" ry="6"/>
          <ellipse cx="${cheek}" cy="-8" rx="11" ry="6"/>
        </g>
        <g class="dp-mouth" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
          <path class="dp-m-happy" fill="${ink}" d="M-12 -4 Q0 -2 12 -4 Q10 12 0 12 Q-10 12 -12 -4 Z"/>
          <path class="dp-m-sad" d="M-9 5 Q0 -4 9 5"/>
          <ellipse class="dp-m-surprised" fill="${ink}" stroke="none" rx="6.5" ry="8.5"/>
          <path class="dp-m-thinking" d="M-9 2 Q-4.5 -3 0 2 T9 2"/>
          <ellipse class="dp-m-sleepy" fill="${ink}" stroke="none" rx="4" ry="4.5"/>
          <path class="dp-m-shy" d="M-6 1 Q0 6 6 1"/>
          <path class="dp-m-working" d="M-7 2 L7 2"/>
          <ellipse class="dp-m-speaking" fill="${ink}" stroke="none" rx="8" ry="7"/>
        </g>
      </g>`;

    // Scale mouth parts from their own centre.
    for (const el of this.#svg.querySelectorAll('.dp-mouth > *')) {
      el.style.transformBox = 'fill-box';
      el.style.transformOrigin = 'center';
    }
    this.#blinkEls = [...this.#svg.querySelectorAll('.dp-blink')];
    this.#lookEls = [...this.#svg.querySelectorAll('.dp-look')];
    this.#applyColor();
    this.#applyLabel();
    const gaze = FIXED_GAZE[this.mood];
    if (gaze) this.lookAt(...gaze);
  }

  #applyColor() {
    if (!this.#def) return;
    // `color` attribute > --dp-color custom property > character default.
    this.#root.style.setProperty('--dp-c', this.color || `var(--dp-color, ${this.#def.color})`);
  }

  #applyLabel() {
    const name = this.getAttribute('label') || this.#def?.label || 'Dot pal';
    this.setAttribute('aria-label', this.mood === 'neutral' ? name : `${name} (${this.mood})`);
  }

  #applySize() {
    const size = this.getAttribute('size');
    if (size == null) this.style.removeProperty('--dp-size');
    else this.style.setProperty('--dp-size', /^\d+(\.\d+)?$/.test(size) ? `${size}px` : size);
  }

  #scheduleBlink() {
    clearTimeout(this.#timer);
    // Busy pals blink and glance around more often, so they feel alive.
    const busy = ACTIVE_GAZE[this.mood];
    this.#timer = setTimeout(() => {
      if (!this.isConnected) return;
      this.blink();
      if (Math.random() < (busy ? 0.3 : 0.2)) setTimeout(() => this.blink(), 240);
      const still = this.look === 'none' || reducedMotion();
      if (!still && ACTIVE_GAZE[this.mood]) {
        // Thinking: glance up one side, then the other. Working: scan like reading.
        this.lookAt(...ACTIVE_GAZE[this.mood]());
      } else if (!still && !this.#target && !FIXED_GAZE[this.mood] && performance.now() - pointer.t > 4000) {
        // No recent pointer movement (or a touch device): let the eyes wander.
        Math.random() < 0.35 ? this.lookAt(0, 0) : this.lookAt(rand(-1, 1), rand(-0.6, 0.8));
      }
      this.#scheduleBlink();
    }, busy ? rand(900, 2400) : rand(2200, 5000));
  }

  #snore() {
    const size = this.getBoundingClientRect().width || 160;
    const z = document.createElement('span');
    z.className = 'dp-particle dp-z';
    z.textContent = 'z';
    z.style.fontSize = `${(size * rand(0.1, 0.14)).toFixed(1)}px`;
    z.style.left = '62%';
    z.style.top = '30%';
    this.#root.append(z);
    z.animate(
      [
        { transform: 'translate(0, 0) scale(.4)', opacity: 0 },
        { transform: `translate(${size * 0.08}px, ${-size * 0.15}px) scale(1)`, opacity: 1, offset: 0.3 },
        { transform: `translate(${size * 0.22}px, ${-size * 0.45}px) scale(1.2) rotate(15deg)`, opacity: 0 },
      ],
      { duration: 2200, easing: 'ease-out' }
    ).finished.catch(() => {}).finally(() => z.remove());
  }

  #burst(glyph) {
    const size = this.getBoundingClientRect().width || 160;
    for (let i = 0; i < 6; i++) {
      const p = document.createElement('span');
      p.className = 'dp-particle';
      p.textContent = glyph;
      p.style.fontSize = `${(size * rand(0.1, 0.17)).toFixed(1)}px`;
      this.#root.append(p);
      const x = rand(-0.55, 0.55) * size;
      const y = -rand(0.35, 0.7) * size;
      p.animate(
        [
          { transform: 'translate(-50%, 0) scale(.3)', opacity: 0 },
          { transform: `translate(calc(-50% + ${x * 0.4}px), ${y * 0.3}px) scale(1.1)`, opacity: 1, offset: 0.25 },
          { transform: `translate(calc(-50% + ${x}px), ${y}px) scale(.8) rotate(${rand(-25, 25)}deg)`, opacity: 0 },
        ],
        { duration: rand(900, 1400), delay: i * 60, easing: 'cubic-bezier(.2,.6,.3,1)', fill: 'backwards' }
      ).finished.catch(() => {}).finally(() => p.remove());
    }
  }
}
