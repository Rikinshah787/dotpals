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

// ---------------------------------------------------------------------------
// Faces. Characters that say where their eyes are (`eyes: { at, r }`) can swap
// their normal eyes for one of these expression eyes; the rest keep squinting
// their own eyes as before.

/** Expression eyes each mood shows (characters with eye anchors only). */
export const MOOD_EYES = { happy: 'happy', sleepy: 'closed', surprised: 'wide', waiting: 'wide' };

/** Short-lived faces for `pal.emote(name, ms)`. */
const EMOTE_FACES = {
  happy: { eyes: 'happy', mouth: 'happy', cheeks: true },
  love: { eyes: 'heart', mouth: 'happy', cheeks: true, burst: 'heart' },
  star: { eyes: 'star', mouth: 'happy', burst: 'sparkle' },
  wide: { eyes: 'wide', mouth: 'surprised' },
  closed: { eyes: 'closed', mouth: 'sleepy' },
  dizzy: { eyes: 'spiral', mouth: 'thinking' },
  oops: { eyes: 'x', mouth: 'sad' },
  hey: { eyes: 'squint', mouth: 'surprised' },
  sweat: { eyes: null, mouth: 'working', burst: 'sweat', count: 2 },
};
export const EMOTES = Object.keys(EMOTE_FACES);

// Expression eyes that still blink (the rest are already "closed" shapes).
const BLINKY = new Set(['wide', 'heart', 'star']);
const INK = '#0b0b12';
const n2 = (v) => +v.toFixed(2);
const isLightInk = (ink) => {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(ink ?? '')?.[1];
  if (!hex) return false;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5;
};

/**
 * @internal SVG markup for one expression eye, centred on (0, 0).
 * `side` is -1 for the pal's left eye (on screen) and 1 for the right one.
 */
export function eyeShape(kind, r = 10, ink = INK, side = 1) {
  const light = isLightInk(ink);
  const line = (d, w = r * 0.34) =>
    `<path d="${d}" fill="none" stroke="${ink}" stroke-width="${n2(w)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const edge = light ? '' : ` stroke="${ink}" stroke-width="${n2(r * 0.12)}" stroke-linejoin="round"`;
  switch (kind) {
    case 'happy': // an upturned arc: smiling eyes
      return line(`M${n2(-0.85 * r)} ${n2(0.32 * r)} Q0 ${n2(-0.95 * r)} ${n2(0.85 * r)} ${n2(0.32 * r)}`);
    case 'closed': // a gentle downward curve: asleep
      return line(`M${n2(-0.8 * r)} ${n2(-0.12 * r)} Q0 ${n2(0.62 * r)} ${n2(0.8 * r)} ${n2(-0.12 * r)}`, r * 0.3);
    case 'wide': // big round eyes with two glints
      return `<circle r="${n2(r)}" fill="${ink}"/>${light ? '' : `<circle cx="${n2(-0.32 * r)}" cy="${n2(-0.34 * r)}" r="${n2(0.3 * r)}" fill="#fff"/><circle cx="${n2(0.32 * r)}" cy="${n2(0.3 * r)}" r="${n2(0.13 * r)}" fill="#fff" opacity=".8"/>`}`;
    case 'squint': { // ">" and "<": a scrunched-up "hey!"
      const m = -side;
      return line(`M${n2(-0.55 * r * m)} ${n2(-0.6 * r)} L${n2(0.55 * r * m)} 0 L${n2(-0.55 * r * m)} ${n2(0.6 * r)}`, r * 0.3);
    }
    case 'x':
      return line(`M${n2(-0.55 * r)} ${n2(-0.55 * r)} L${n2(0.55 * r)} ${n2(0.55 * r)} M${n2(0.55 * r)} ${n2(-0.55 * r)} L${n2(-0.55 * r)} ${n2(0.55 * r)}`, r * 0.3);
    case 'spiral': {
      const pts = [];
      const steps = 36;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const a = side * t * 2.25 * 2 * Math.PI;
        const rr = r * (0.08 + 0.92 * t);
        pts.push(`${n2(Math.cos(a) * rr)} ${n2(Math.sin(a) * rr)}`);
      }
      return `<g class="dp-spiral${side < 0 ? ' dp-ccw' : ''}">${line(`M${pts.join(' L')}`, r * 0.2)}</g>`;
    }
    case 'heart': {
      const s = r * 1.1;
      const p = (x, y) => `${n2(x * s)} ${n2(y * s)}`;
      return `<path fill="#ff3d6e"${edge} d="M${p(0, 0.85)} C${p(-0.25, 0.65)} ${p(-1, 0.25)} ${p(-1, -0.3)} C${p(-1, -0.78)} ${p(-0.48, -1)} ${p(0, -0.55)} C${p(0.48, -1)} ${p(1, -0.78)} ${p(1, -0.3)} C${p(1, 0.25)} ${p(0.25, 0.65)} ${p(0, 0.85)} Z"/><circle cx="${n2(-0.45 * s)}" cy="${n2(-0.42 * s)}" r="${n2(0.16 * s)}" fill="#fff" opacity=".85"/>`;
    }
    case 'star': { // a four-point sparkle
      const R = r * 1.3;
      const c = R * 0.22;
      return `<path fill="#ffd23f"${edge} d="M0 ${n2(-R)} Q${n2(c)} ${n2(-c)} ${n2(R)} 0 Q${n2(c)} ${n2(c)} 0 ${n2(R)} Q${n2(-c)} ${n2(c)} ${n2(-R)} 0 Q${n2(-c)} ${n2(-c)} 0 ${n2(-R)} Z"/>`;
    }
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Particles: small SVG shapes (they look the same on every OS, unlike emoji).

const star5 = (R, r) => {
  let d = '';
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r : R;
    d += `${i ? 'L' : 'M'}${n2(Math.cos(a) * rr)} ${n2(Math.sin(a) * rr)} `;
  }
  return `${d}Z`;
};
const PARTICLES = {
  heart: { fill: '#ff4d7e', d: 'M0 8.5 C-2.5 6.5 -10 2.5 -10 -3 C-10 -7.8 -4.8 -10 0 -5.5 C4.8 -10 10 -7.8 10 -3 C10 2.5 2.5 6.5 0 8.5Z' },
  sparkle: { fill: '#fff4b8', d: 'M0 -11 Q2.2 -2.2 11 0 Q2.2 2.2 0 11 Q-2.2 2.2 -11 0 Q-2.2 -2.2 0 -11Z' },
  star: { fill: '#ffc933', d: star5(10.5, 4.6) },
  sweat: { fill: '#7cc7ff', d: 'M0 -10 C3 -5 7 -1 7 3 A7 7 0 0 1 -7 3 C-7 -1 -3 -5 0 -10Z' },
  z: { stroke: '#fff', d: 'M-5.5 -6 H5.5 L-5.5 6 H5.5' },
};
export const PARTICLE_KINDS = Object.keys(PARTICLES);
// Old actions used a text glyph; map the ones we ship to shapes.
const GLYPHS = { '♥': 'heart', '❤': 'heart', '✦': 'sparkle', '✧': 'sparkle', '★': 'star', z: 'z' };

const SVG_NS = 'http://www.w3.org/2000/svg';
/** One particle's path, centred on (0, 0) in a 24×24 box. */
function particleShape(kind) {
  const p = PARTICLES[kind];
  if (!p) return '';
  const paint = p.stroke
    ? `fill="none" stroke="${p.stroke}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"`
    : `fill="${p.fill}"`;
  return `<path ${paint} d="${p.d}"/>`;
}

/** @internal Inline SVG for one particle (a standalone icon). */
export function particleSVG(kind) {
  return PARTICLES[kind] ? `<svg viewBox="-12 -12 24 24" aria-hidden="true">${particleShape(kind)}</svg>` : '';
}

/**
 * @internal Keyframes for one particle drifting by (dx, dy) px: it fades in over
 * the first 20 % and out over the rest, and grows ~40 % over its life. Hearts
 * wobble, sparkles turn, sweat falls.
 */
export function particleFrames(kind, { x0 = 0, y0 = 0, dx = 0, dy = 0, rot = 0 } = {}) {
  const frames = [];
  // A frame right at 20 %, where the fade-in peaks.
  for (const k of [0, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 1]) {
    const ease = kind === 'sweat' ? k * k : 1 - (1 - k) ** 2;
    const x = dx * (kind === 'sweat' ? k : ease);
    const y = dy * ease;
    const opacity = k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8;
    const scale = k < 0.2 ? 0.55 + (0.45 * k) / 0.2 : 1 + (0.4 * (k - 0.2)) / 0.8;
    let r = rot;
    if (kind === 'heart') r += Math.sin(k * Math.PI * 3) * 16;
    else if (kind === 'sparkle' || kind === 'star') r += k * 140;
    else if (kind === 'z') r += Math.sin(k * Math.PI * 2) * 10;
    frames.push({
      offset: n2(k),
      opacity: n2(Math.max(0, Math.min(1, opacity))),
      transform: `translate(${n2(x0 + x)}px, ${n2(y0 + y)}px) rotate(${n2(r)}deg) scale(${n2(scale)})`,
    });
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Gaze.

/**
 * @internal Where to look for a point (dx, dy) px away from the eyes of a pal
 * `width` px wide: a direction scaled by a tanh falloff, so the eyes turn fully
 * only when the point is well away from the pal.
 */
export function gazeFor(dx, dy, width) {
  const dist = Math.hypot(dx, dy);
  if (!dist || !(width > 0)) return [0, 0];
  const s = Math.tanh(dist / (width * 1.1));
  return [(dx / dist) * s, (dy / dist) * s];
}

/** @internal Eye scale for a gaze: each eye narrows as it turns, like a ball seen from the side. */
export function foreshorten(x, y, k = 1) {
  return [n2(k * (1 - 0.18 * Math.min(1, Math.abs(x)))), n2(k * (1 - 0.12 * Math.min(1, Math.abs(y))))];
}

// ---------------------------------------------------------------------------

const styles = `
  :host {
    --dp-size: 160px;
    --dp-glow: transparent;
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

  /* A soft light behind the pal in the state's colour. Pages turn it off with
     dot-pal { --dp-glow: transparent }. */
  :host([state="working"]), :host([state="thinking"]) { --dp-glow: var(--dp-glow-work, transparent); }
  :host([state="waiting"]) { --dp-glow: #ffb020; }
  :host([state="error"]) { --dp-glow: #ff4d5e; }
  :host([state="done"][mood="happy"]) { --dp-glow: #2fd67b; }

  .dp-root, .dp-pose, .dp-actor { width: 100%; height: 100%; }
  /* Everything below the bottom edge (the ledge) is cut off, and doesn't count as
     overflow either, so rising up from below never adds scrollbars to the page.
     The box reaches far up so jumps and the bubble stay visible. */
  .dp-ledge {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 500%;
    overflow-x: visible;
    overflow-y: clip;
    pointer-events: none;
  }
  .dp-idle { position: absolute; left: 0; bottom: 0; width: 100%; height: 20%; pointer-events: auto; }
  .dp-idle, .dp-pose, .dp-actor { transform-origin: 50% 100%; }
  .dp-idle { perspective: 600px; }
  .dp-pose { transition: transform .8s cubic-bezier(.25, .8, .35, 1); }
  svg { display: block; width: 100%; height: 100%; overflow: visible; transition: filter .4s; }

  /* Stays inside the host box (so it never adds scrollbars); the halo is a shadow,
     which doesn't count as overflow. The bottom edge is clipped like the pal. */
  .dp-glow {
    position: absolute;
    left: 16%;
    right: 16%;
    top: 34%;
    bottom: 0;
    border-radius: 50% 50% 0 0 / 70% 70% 0 0;
    background: color-mix(in srgb, var(--dp-glow) 30%, transparent);
    box-shadow: 0 0 calc(var(--dp-size) * .2) calc(var(--dp-size) * .1) color-mix(in srgb, var(--dp-glow) 34%, transparent);
    transition: --dp-glow .6s ease;
    pointer-events: none;
  }
  :host([state="waiting"]) .dp-glow { animation: dp-glow-pulse 1.6s ease-in-out infinite; }
  :host([tiny]) .dp-glow { display: none; }
  @keyframes dp-glow-pulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: .6; }
  }

  .dp-look, .dp-turn {
    transition: transform .22s cubic-bezier(.3, .7, .4, 1), scale .22s cubic-bezier(.3, .7, .4, 1);
  }
  .dp-blink, .dp-eyes, .dp-fs {
    transform-box: fill-box;
    transform-origin: center;
  }
  .dp-blink, .dp-fs, .dp-ae-s {
    transition: transform .25s cubic-bezier(.3, .7, .4, 1), scale .22s cubic-bezier(.3, .7, .4, 1);
  }
  /* Expression eyes replace the normal ones while they show. */
  .dp-alt .dp-hide { opacity: 0; }
  .dp-alteyes { pointer-events: none; }
  .dp-spiral { animation: dp-rot 1.3s linear infinite; }
  .dp-spiral.dp-ccw { animation-direction: reverse; }
  @keyframes dp-rot { to { transform: rotate(360deg); } }

  /* -- idle loops ---------------------------------------------------------- */

  .dp-idle { animation: dp-breathe 3.4s ease-in-out infinite var(--dp-delay, 0s); }
  :host([idle="bounce"]) .dp-idle { animation: dp-bounce 1.3s infinite var(--dp-delay, 0s); }
  :host([idle="float"])  .dp-idle { animation: dp-float 3s ease-in-out infinite var(--dp-delay, 0s); }
  :host([idle="wobble"]) .dp-idle { animation: dp-wobble 2.6s ease-in-out infinite var(--dp-delay, 0s); }
  :host([idle="sway"])   .dp-idle { animation: dp-sway 2.2s ease-in-out infinite var(--dp-delay, 0s); }
  :host([idle="none"])   .dp-idle { animation: none; }
  /* Pals that hang on a thread swing from the top of it (tiny ones hide the thread). */
  :host(:not([mood]):not([idle]):not([tiny])) .dp-hang .dp-idle { transform-origin: 50% -300%; animation: dp-swing 3.2s ease-in-out infinite var(--dp-delay, 0s); }
  :host([tiny]) .dp-thread { display: none; }
  /* Tiny pals (notch avatars) breathe deeper so they still read as alive. */
  :host([tiny]) { --dp-breath: 2.6; }
  :host([tiny]) [filter*="-fur)"] { filter: none; }

  /* -- moods (override the idle loop) -------------------------------------- */

  :host([mood="happy"])    .dp-idle { animation: dp-bounce .9s infinite; }
  :host([mood="sad"])      .dp-idle { animation: dp-droop 4s ease-in-out infinite; }
  :host([mood="thinking"]) .dp-idle { animation: dp-ponder 3.2s ease-in-out infinite; }
  :host([mood="sleepy"])   .dp-idle { animation: dp-snore 4.5s ease-in-out infinite; }
  :host([mood="shy"])      .dp-idle { animation: dp-shy 2.8s ease-in-out infinite; }
  :host([mood="listening"]) .dp-idle { animation: dp-lean 2.6s ease-in-out infinite; }
  :host([mood="working"])  .dp-idle { animation: dp-busy .5s ease-in-out infinite; }
  :host([mood="speaking"]) .dp-idle { animation: dp-breathe 1.6s ease-in-out infinite; }
  :host([mood="waiting"])  .dp-idle { animation: dp-await 1.5s ease-in-out infinite; }
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
  /* A face from emote() wins over the mood's mouth. */
  .dp-root[data-mouth] .dp-mouth > * { opacity: 0; transform: scale(.4); animation: none; }
  .dp-root[data-mouth="happy"] .dp-m-happy,
  .dp-root[data-mouth="sad"] .dp-m-sad,
  .dp-root[data-mouth="surprised"] .dp-m-surprised,
  .dp-root[data-mouth="thinking"] .dp-m-thinking,
  .dp-root[data-mouth="sleepy"] .dp-m-sleepy,
  .dp-root[data-mouth="working"] .dp-m-working { opacity: 1; transform: scale(1); }
  .dp-root[data-cheeks] .dp-cheeks { opacity: .6; }

  /* Dizzy: a woozy sway after the spin. */
  .dp-woozy .dp-pose { animation: dp-woozy 1.1s ease-in-out infinite; }

  @keyframes dp-breathe {
    0%, 100% { transform: scale(1, 1); }
    50%      { transform: scale(calc(1 - .015 * var(--dp-breath, 1)), calc(1 + .035 * var(--dp-breath, 1))); }
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
  @keyframes dp-swing {
    0%, 100% { transform: rotate(-1.6deg); }
    50%      { transform: rotate(1.6deg); }
  }
  @keyframes dp-lean {
    0%, 100% { transform: rotate(3deg) scale(1.01); }
    50%      { transform: rotate(4deg) scale(1.02, 1.03); }
  }
  @keyframes dp-busy {
    0%, 100% { transform: translateY(0) scale(1, 1); }
    50%      { transform: translateY(-1.5%) scale(.99, 1.02); }
  }
  @keyframes dp-await {
    0%, 60%, 100% { transform: translateY(0) scale(1, 1); }
    12%      { transform: translateY(0) scale(1.04, .96); animation-timing-function: cubic-bezier(.2, .8, .3, 1); }
    30%      { transform: translateY(-5%) scale(.98, 1.03); animation-timing-function: cubic-bezier(.6, 0, .8, .4); }
    44%      { transform: translateY(0) scale(1.03, .97); }
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
  @keyframes dp-woozy {
    0%, 100% { transform: rotate(0) translateX(0); }
    25%      { transform: rotate(5deg) translateX(3%); }
    50%      { transform: rotate(0) translateX(0) translateY(-2%); }
    75%      { transform: rotate(-5deg) translateX(-3%); }
  }

  /* -- speech bubble & particles ------------------------------------------ */

  .dp-bubble {
    position: absolute;
    z-index: 2;
    left: 50%;
    bottom: 88%;
    max-width: min(max(180px, calc(var(--dp-size) * 1.4)), calc(100vw - 12px));
    width: max-content;
    padding: .5em .85em;
    border-radius: 1.1em;
    background: #fff;
    color: #16161a;
    font: 600 max(13px, calc(var(--dp-size) * .075))/1.3 ui-rounded, "SF Pro Rounded", system-ui, sans-serif;
    text-align: center;
    box-shadow: 0 6px 18px rgb(0 0 0 / .22);
    opacity: 0;
    /* --dp-shift keeps the bubble inside the window when the pal is near an edge. */
    transform: translate(calc(-50% + var(--dp-shift, 0px)), 8px) scale(.85);
    transform-origin: 50% 100%;
    transition: opacity .2s, transform .35s cubic-bezier(.3, 1.5, .5, 1);
    pointer-events: none;
  }
  .dp-bubble::after {
    content: "";
    position: absolute;
    left: clamp(1em, calc(50% - var(--dp-shift, 0px)), calc(100% - 1em));
    top: 100%;
    border: .45em solid transparent;
    border-top-color: #fff;
    transform: translateX(-50%);
  }
  .dp-bubble.dp-show { opacity: 1; transform: translate(calc(-50% + var(--dp-shift, 0px)), 0) scale(1); }
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

  /* Particles live in an SVG the size of the pal; what they draw outside it
     doesn't count as overflow, so they never add scrollbars to the page. */
  svg.dp-fx {
    position: absolute;
    inset: 0;
    z-index: 1;
    pointer-events: none;
    filter: none;
  }
  .dp-particle {
    opacity: 0;
    fill: var(--dp-c);
    font-weight: 700;
    font-family: ui-rounded, system-ui, sans-serif;
    filter: drop-shadow(0 1.5px 2px rgb(0 0 0 / .28));
  }
  .dp-particle text { fill: var(--dp-c); }

  @media (prefers-reduced-motion: reduce) {
    .dp-idle, .dp-pose, .dp-spiral, .dp-glow { animation: none !important; }
    .dp-look, .dp-blink, .dp-fs, .dp-ae-s, .dp-turn, .dp-pose { transition: none; }
    .dp-dots i { animation: none; opacity: .7; }
  }
`;

// The glow colour is a registered <color>, so it fades between states.
if (typeof CSS !== 'undefined' && typeof CSS.registerProperty === 'function') {
  try {
    CSS.registerProperty({ name: '--dp-glow', syntax: '<color>', inherits: true, initialValue: 'transparent' });
  } catch {} // already registered (e.g. two copies of the library)
}

// ---------------------------------------------------------------------------
// Shared pointer tracking: one listener for every pal on the page.

const pals = new Set();
const pointer = { x: 0, y: 0, t: 0 };
let tracking = false;
let frame = 0;

function fanOut() {
  if (frame || typeof requestAnimationFrame !== 'function') return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    for (const pal of pals) pal._followPointer();
  });
}

function trackPointer() {
  if (tracking || typeof window === 'undefined') return;
  tracking = true;
  window.addEventListener(
    'pointermove',
    (e) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.t = performance.now();
      fanOut();
    },
    { passive: true }
  );
}

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const rand = (min, max) => min + Math.random() * (max - min);

/** The additive transform that turns `to` back into `from` (null when there is nothing to blend). */
function bridgeMatrix(from, to) {
  if (typeof DOMMatrix !== 'function') return null;
  try {
    const F = from && from !== 'none' ? new DOMMatrix(from) : new DOMMatrix();
    const T = to && to !== 'none' ? new DOMMatrix(to) : new DOMMatrix();
    const d = T.inverse().multiply(F);
    const v = d.toFloat64Array();
    if (v.some((x) => !Number.isFinite(x))) return null;
    const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    if (v.every((x, i) => Math.abs(x - id[i]) < 1e-3)) return null;
    return d.toString();
  } catch {
    return null;
  }
}

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

// Keep bubbles inside the window when it (or the layout) changes size.
let resizing = false;
function fitOnResize() {
  if (resizing || typeof window === 'undefined') return;
  resizing = true;
  window.addEventListener('resize', () => { for (const pal of pals) pal._fitBubble(); }, { passive: true });
}

const TINY = 48; // px: below this the pal is an avatar (bigger eyes, no fur)
const LONG_RUN = 90_000; // ms of working before the pal starts to sweat
const QUICK_CLICKS = 1200; // ms window for three clicks → dizzy
let scriptSeq = 0;

// ---------------------------------------------------------------------------

export class DotPal extends Base {
  static observedAttributes = ['character', 'color', 'size', 'label', 'mood', 'state', 'idle', 'lean'];

  #n = ++uid;
  #uid = `dp${this.#n}`;
  #def;
  #svg;
  #root;
  #idle;
  #pose;
  #actor;
  #bubble;
  #fx; // particle layer
  #blinkEls = [];
  #lookEls = [];
  #fsEls = []; // parts that foreshorten and grow (each eye, or the whole eye group)
  #hideEls = []; // parts hidden while expression eyes show
  #aeLook = null; // expression-eye layer (follows the gaze)
  #aeS = []; // one per expression eye
  #turn = null; // cheeks + mouth, nudged with the gaze so the face turns
  #anim = null;
  #animName = '';
  #bridges = new Map(); // element → the short blend running on it
  #timer = 0;
  #zzz = 0;
  #sweat = 0;
  #runSince = 0;
  #sayTimer = 0;
  #saying = false;
  #target = null; // a viewport point to look at instead of the pointer
  // Temporary moods (from during(), watch(), flash()) restore the previous mood.
  #temp = { active: false, prev: null, token: 0 };
  #stateText;
  #stateTimer = 0;
  #shownState;
  #gaze = { x: 0, y: 0 };
  #hover = false;
  #tiny = false;
  #ro = null;
  #face = null; // { eyes, mouth, cheeks, owner } from emote()/greet()/reactions
  #eyesKind = null; // expression eyes showing now (null: the character's own eyes)
  #eyesWant = null;
  #swapTok = 0;
  #scripts = new Map(); // channel → token of the timeline running on it
  #clicks = [];
  #stillTimer = 0;
  #lastLove = 0;
  #dizzy = false;
  #bubbleTok = 0;
  #bubbleAnim = null;
  #morphing = false;
  #restoring = false;
  #greetPending = false;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${styles}</style>
      <div class="dp-root" part="root">
        <div class="dp-glow" aria-hidden="true"></div>
        <div class="dp-ledge">
          <div class="dp-idle" part="idle">
            <div class="dp-pose">
              <div class="dp-actor" part="actor">
                <svg viewBox="0 0 200 200" part="svg" aria-hidden="true"></svg>
              </div>
            </div>
          </div>
        </div>
        <svg class="dp-fx" aria-hidden="true"></svg>
        <div class="dp-bubble" part="bubble" aria-hidden="true"></div>
      </div>`;
    this.#root = shadow.querySelector('.dp-root');
    this.#idle = shadow.querySelector('.dp-idle');
    this.#pose = shadow.querySelector('.dp-pose');
    this.#actor = shadow.querySelector('.dp-actor');
    this.#svg = shadow.querySelector('svg');
    this.#bubble = shadow.querySelector('.dp-bubble');
    this.#fx = shadow.querySelector('.dp-fx');

    this.addEventListener('pointerenter', (e) => {
      if (this.static) return;
      this.#hover = true;
      this.#applyEyeScale();
      this.blink();
      if (!this.#anim && !reducedMotion()) this.play('squish');
      this.#armStill(e);
    });
    this.addEventListener('pointermove', (e) => { if (!this.static) this.#armStill(e); }, { passive: true });
    this.addEventListener('pointerleave', () => {
      clearTimeout(this.#stillTimer);
      if (!this.#hover) return;
      this.#hover = false;
      this.#applyEyeScale();
    });
    this.addEventListener('pointerdown', () => clearTimeout(this.#stillTimer));
    this.addEventListener('click', () => {
      if (!this.static) this.#poke();
    });
  }

  connectedCallback() {
    if (!this.#def) this.#render();
    if (!this.hasAttribute('role')) this.setAttribute('role', 'img');
    // Desynchronise idle loops so a row of pals doesn't move in lockstep.
    this.style.setProperty('--dp-delay', `${-rand(0, 3).toFixed(2)}s`);
    this.#applySize();
    if (typeof ResizeObserver === 'function') {
      this.#ro ??= new ResizeObserver((entries) => {
        const w = entries[entries.length - 1]?.contentRect.width;
        if (w > 0) this.#setTiny(w < TINY);
      });
      this.#ro.observe(this);
    }
    if (this.hasAttribute('state')) this.#applyState();
    else this.#applyMood();
    pals.add(this);
    trackPointer();
    fitOnResize();
    this.#scheduleBlink();
    if (this.#greetPending) {
      this.#greetPending = false;
      this.greet();
    }
  }

  disconnectedCallback() {
    pals.delete(this);
    clearTimeout(this.#stateTimer);
    clearTimeout(this.#timer);
    clearTimeout(this.#stillTimer);
    clearInterval(this.#zzz);
    clearInterval(this.#sweat);
    this.#zzz = 0;
    this.#sweat = 0;
    this.#ro?.disconnect();
    this.#scripts.clear(); // running timelines notice and wind down
    this.#hover = false;
    this.#dizzy = false;
  }

  attributeChangedCallback(name, oldValue, value) {
    if (oldValue === value || this.#restoring) return;
    if (name === 'mood' || name === 'idle') {
      // Set from outside (not through #setMood): measure the old pose, then blend into the new loop.
      if (!this.#morphing && this.isConnected && this.#def) this.#blendExternal(name, oldValue, value);
      if (name === 'mood') this.#applyMood(oldValue);
    } else if (name === 'size') this.#applySize();
    else if (name === 'color') this.#applyColor();
    else if (name === 'label') this.#applyLabel();
    else if (name === 'state') this.#applyState();
    else if (name === 'lean') this.#lean(this.#gaze.x);
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

  /** True when the pal is drawn smaller than 48 px (set automatically as the `tiny` attribute). */
  get tiny() { return this.#tiny; }

  /** Names of every registered action. */
  static get actions() { return Object.keys(actions); }

  /** Re-draw every pal using `name` (after registerCharacter() changed it). */
  static refresh(name) {
    for (const pal of pals) if (pal.character === name) pal.#render();
  }

  /** Names of every registered character. */
  static get characters() { return Object.keys(characters); }

  /** Names of every mood. */
  static get moods() { return [...MOODS]; }

  /** Names of every agent state. */
  static get states() { return Object.keys(AGENT_STATES); }

  /** Names of every emote for `pal.emote(name)`. */
  static get emotes() { return [...EMOTES]; }

  /**
   * Tell every pal where the cursor is, in viewport CSS px, even when it's
   * outside the page (e.g. from a desktop app that tracks the whole screen).
   */
  static pointAt(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    pointer.x = x;
    pointer.y = y;
    pointer.t = typeof performance !== 'undefined' ? performance.now() : Date.now();
    fanOut();
  }

  // -- public API ------------------------------------------------------------

  /**
   * Play a one-shot action ('jump', 'squish', 'wiggle', 'shake', 'nod', 'spin', 'love', 'hop',
   * 'jitter', 'hello', 'drop', 'dizzy', …). Resolves when the animation finishes or is interrupted.
   * Interrupting an action blends from wherever the pal is, so it never snaps.
   */
  play(name) {
    const action = actions[name];
    if (!action) {
      console.warn(`[dotpals] Unknown action "${name}". Try: ${Object.keys(actions).join(', ')}`);
      return Promise.resolve();
    }
    const blend = this.isConnected && (this.#anim || this.#bridges.has(this.#actor));
    const from = blend ? getComputedStyle(this.#actor).transform : null;
    this.#anim?.cancel();
    const anim = this.#actor.animate(action.keyframes, {
      duration: action.duration,
      easing: action.easing || 'ease-out',
    });
    this.#anim = anim;
    this.#animName = name;
    if (blend) this.#bridgeFrom(this.#actor, from, 180);
    if (action.particles) this.#burst(GLYPHS[action.particles] ?? action.particles);
    this.dispatchEvent(new CustomEvent('dotpal-action', { detail: { action: name }, bubbles: true, composed: true }));
    return anim.finished
      .catch(() => {})
      .finally(() => {
        if (this.#anim === anim) {
          this.#anim = null;
          this.#animName = '';
        }
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
    this.#showBubble({ text });
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
   * Show a face for `ms` milliseconds: 'happy', 'love' (heart eyes), 'star',
   * 'wide', 'closed', 'dizzy', 'oops', 'hey' or 'sweat'. Characters without
   * eye anchors keep their eyes and only change mouth and cheeks.
   */
  emote(name, ms = 1600) {
    const face = EMOTE_FACES[name];
    if (!face) {
      console.warn(`[dotpals] Unknown emote "${name}". Try: ${EMOTES.join(', ')}`);
      return Promise.resolve();
    }
    const owner = {};
    return this.#run('emote', [
      {
        from: 0,
        to: Math.max(0, ms),
        enter: () => {
          this.#setFace(face, owner);
          if (face.burst) this.#burst(face.burst, face.count ?? 5);
        },
        exit: () => this.#clearFace(owner),
      },
    ]);
  }

  /**
   * Say hello: rise up from below the ledge, squint happily, hop and blink
   * twice. Resolves when it's done.
   */
  greet() {
    if (!this.isConnected) {
      this.#greetPending = true;
      return Promise.resolve();
    }
    const calm = reducedMotion();
    const owner = {};
    return this.#run('hello', [
      { at: 0, do: () => { if (!calm) this.play(this.#def?.moves?.hello ?? 'hello'); } },
      {
        from: calm ? 0 : 430,
        to: calm ? 900 : 1020,
        enter: () => this.#setFace(EMOTE_FACES.happy, owner),
        exit: () => this.#clearFace(owner),
      },
      { at: calm ? 1150 : 1560, do: () => this.blink() },
      { at: calm ? 1420 : 1830, do: () => this.blink() },
    ], calm ? 1500 : 2000);
  }

  /** Throw a few particles: 'heart', 'sparkle', 'star', 'sweat' or 'z'. */
  burst(kind = 'sparkle', count = 6) {
    this.#burst(kind, count);
  }

  /**
   * Show progress for an async task: `thinking` while it runs, then `happy`
   * (and a jump) on success or `sad` (and a jitter) on failure. The previous
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
      if (!reducedMotion()) this.play(action);
      if (text) this.say(text);
      else if (thinkingText) this.say('');
      setTimeout(() => this.#popTemp(token), revert);
    };
    try {
      const result = await (typeof task === 'function' ? task() : task);
      end(success, 'jump', successText);
      return result;
    } catch (err) {
      end(error, 'jitter', errorText);
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
      if (this.#anim?.playState !== 'running' && !reducedMotion()) this.play('shake');
      this.flash('sad', 1600);
    };
    const onSubmit = () => {
      shyToken = null;
      this.#target = null;
      if (!reducedMotion()) this.play('jump');
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

  /** Blink once: a quick close and a slower open (skipped while the eyes are closed). */
  blink() {
    const kind = this.#eyesKind;
    if (kind ? !BLINKY.has(kind) : CLOSED_EYES.includes(this.mood)) return;
    const els = kind ? this.#aeS : this.#blinkEls;
    for (const el of els) {
      el.animate(
        [
          { transform: 'scaleY(1)', easing: 'cubic-bezier(.55, 0, .9, .45)' },
          { transform: 'scaleY(.06)', offset: 0.36, easing: 'cubic-bezier(.15, .6, .3, 1)' },
          { transform: 'scaleY(1)' },
        ],
        { duration: 200, composite: 'add' }
      );
    }
  }

  /**
   * Point the eyes in a direction. `x` and `y` range from -1 to 1;
   * `lookAt(0, 0)` looks straight ahead.
   */
  lookAt(x = 0, y = 0) {
    const range = this.#def?.look ?? 0;
    x = Number(x) || 0;
    y = Number(y) || 0;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    this.#gaze = { x, y };
    const t = `translate(${(x * range).toFixed(2)}px, ${(y * range * 0.75).toFixed(2)}px)`;
    for (const el of this.#lookEls) el.style.transform = t;
    if (this.#aeLook) this.#aeLook.style.transform = t;
    this.#applyEyeScale();
  }

  // -- internals -------------------------------------------------------------

  /** @internal Called when the window resizes. */
  _fitBubble() { if (this.#bubble.classList.contains('dp-show')) this.#fitBubble(); }

  /** @internal Called by the shared pointer tracker. */
  _followPointer() {
    if (this.look === 'none' || FIXED_GAZE[this.mood]) return;
    const r = this.getBoundingClientRect();
    if (!r.width || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return;
    const { x, y } = this.#target ?? pointer;
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + r.height * 0.68);
    if (this.#target) {
      const dist = Math.hypot(dx, dy) || 1;
      this.lookAt(dx / dist, dy / dist);
    } else {
      this.lookAt(...gazeFor(dx, dy, r.width));
      this.#lean(Math.tanh(dx / (r.width * 1.6)));
    }
  }

  /** Lean the body a little toward x (-1…1). */
  #lean(x) {
    const off = this.getAttribute('lean') === 'none' || this.#tiny || reducedMotion();
    const deg = off ? 0 : x * 3;
    this.#pose.style.transform = Math.abs(deg) < 0.05 ? '' : `rotate(${deg.toFixed(2)}deg)`;
  }

  #applyEyeScale() {
    const { x, y } = this.#gaze;
    const [sx, sy] = foreshorten(x, y, (this.#tiny ? 1.45 : 1) * (this.#hover ? 1.08 : 1));
    const scale = `${sx} ${sy}`;
    for (const el of this.#fsEls) el.style.scale = scale;
    for (const el of this.#aeS) el.style.scale = scale;
    if (this.#turn) {
      const range = this.#def?.look ?? 0;
      const m = this.#tiny ? ' scale(1.35)' : '';
      this.#turn.style.transform = `translate(${n2(x * range * 0.45)}px, ${n2(y * range * 0.3)}px)${m}`;
    }
  }

  #setTiny(on) {
    if (on === this.#tiny) return;
    this.#tiny = on;
    this.toggleAttribute('tiny', on);
    this.#applyEyeScale();
    if (on) this.#lean(0);
  }

  #applyState() {
    if (!this.isConnected) return;
    const state = this.state;
    const prev = this.#shownState;
    this.#shownState = state;
    clearTimeout(this.#stateTimer);
    const moodBefore = this.mood;
    this.mood = AGENT_STATES[state];
    // Same mood, new state (e.g. error while already sad): still acknowledge it.
    if (prev !== undefined && prev !== state && this.mood === moodBefore && !this.#refreshFace(true)) this.blink();
    const calm = reducedMotion();
    if (prev !== state && !calm) {
      const move = (name) => this.#def?.moves?.[state] ?? name;
      if (state === 'done') {
        this.#entry(move('jump'));
        this.#run('fx', [{ at: 260, do: () => this.#burst('sparkle', 7) }]);
      } else if (state === 'error') this.#entry(move('jitter'));
      else if (state === 'waiting') this.#entry(move('hop'));
    }
    if (state === 'done') {
      // Celebrate briefly, then settle back to idle.
      this.#stateTimer = setTimeout(() => {
        if (this.state === 'done') this.mood = 'neutral';
      }, 2400);
    }
    this.#trackRun(state);
    this.#applyStateText();
    this.dispatchEvent(new CustomEvent('dotpal-state', { detail: { state, text: this.#stateText }, bubbles: true, composed: true }));
  }

  /** Play a state's entry move, after the hello if one is still rising. */
  #entry(name) {
    const anim = this.#anim;
    if (anim && this.#animName === (this.#def?.moves?.hello ?? 'hello')) {
      const state = this.state;
      anim.finished.then(() => { if (this.state === state && this.isConnected) this.play(name); }, () => {});
    } else this.play(name);
  }

  /** Long runs: after a while working, the pal breaks a sweat now and then. */
  #trackRun(state) {
    const busy = state === 'working' || state === 'thinking';
    if (!busy) this.#runSince = 0;
    else if (!this.#runSince) this.#runSince = Date.now();
    clearInterval(this.#sweat);
    this.#sweat = 0;
    if (busy) {
      this.#sweat = setInterval(() => {
        if (this.isConnected && Date.now() - this.#runSince > LONG_RUN && Math.random() < 0.6) this.#burst('sweat', 1);
      }, 5000);
    }
  }

  #applyStateText() {
    const text = this.#stateText;
    const transient = ['done', 'error', 'speaking', 'idle'].includes(this.state);
    this.say(text || '', { duration: transient ? undefined : 0 });
  }

  #setMood(v) {
    this.#morph(this.#idle, () => {
      if (v == null || v === 'neutral') this.removeAttribute('mood');
      else this.setAttribute('mood', v);
    });
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
    if (gaze) {
      this.lookAt(...gaze);
      this.#lean(0);
    }
    if (ACTIVE_GAZE[mood] !== ACTIVE_GAZE[previous]) this.#scheduleBlink(); // switch to the busy rhythm now
    else if (previous && FIXED_GAZE[previous]) {
      this.lookAt(0, 0);
      this._followPointer();
    }

    if (mood === 'surprised' && previous !== 'surprised' && !reducedMotion()) this.play('jump');

    clearInterval(this.#zzz);
    this.#zzz = 0;
    if (mood === 'sleepy' && !reducedMotion()) {
      this.#snore();
      this.#zzz = setInterval(() => this.#snore(), 1700);
    }
    // Acknowledge the change: swap to the mood's eyes (a blink hides the swap), or just blink.
    if (previous !== undefined) {
      if (!this.#refreshFace(true)) this.blink();
    } else this.#refreshFace(false);
    this.#syncBubble();
    this.#applyLabel();
    this.dispatchEvent(new CustomEvent('dotpal-mood', { detail: { mood }, bubbles: true, composed: true }));
  }

  // -- faces -----------------------------------------------------------------

  #setFace(face, owner) {
    this.#face = { ...face, owner };
    this.#refreshFace(true);
  }

  #clearFace(owner) {
    if (this.#face?.owner !== owner) return;
    this.#face = null;
    this.#refreshFace(true);
  }

  /** Show the face the pal should have now. Returns true when the eyes changed. */
  #refreshFace(animate) {
    if (!this.#def) return false;
    const face = this.#face;
    if (face?.mouth) this.#root.dataset.mouth = face.mouth;
    else delete this.#root.dataset.mouth;
    this.#root.toggleAttribute('data-cheeks', !!face?.cheeks);
    let eyes = face?.eyes ?? null;
    if (!eyes) eyes = this.state === 'error' && this.mood === 'sad' ? 'x' : MOOD_EYES[this.mood] ?? null;
    return this.#setEyes(eyes, animate);
  }

  /** The parts that close when the eyes blink right now. */
  #lids() {
    if (this.#eyesKind) return this.#aeS;
    return this.#blinkEls.length ? this.#blinkEls : this.#def?.eyes ? this.#hideEls : [];
  }

  #setEyes(kind, animate) {
    // No eye anchors, or a look the character's own eyes already do well: keep them.
    if (!this.#aeS.length || this.#def.eyes?.own?.includes(kind)) kind = null;
    if (kind === this.#eyesWant) return false;
    this.#eyesWant = kind;
    const tok = ++this.#swapTok;
    const swap = () => {
      this.#eyesKind = kind;
      this.#svg.classList.toggle('dp-alt', !!kind);
      const { r = 10, ink = INK } = this.#def.eyes ?? {};
      this.#aeS.forEach((el, i) => { el.innerHTML = kind ? eyeShape(kind, r, ink, i ? 1 : -1) : ''; });
    };
    const lids = this.#lids();
    if (!animate || !this.isConnected || !lids.length || typeof lids[0].animate !== 'function') {
      swap();
      return true;
    }
    // Close the current eyes, swap while they're shut, open the new ones.
    const closing = lids.map((el) =>
      el.animate([{ transform: 'scaleY(1)' }, { transform: 'scaleY(.06)' }], {
        duration: 80, easing: 'cubic-bezier(.55, 0, .9, .45)', composite: 'add', fill: 'forwards',
      })
    );
    Promise.all(closing.map((a) => a.finished)).then(
      () => {
        if (tok !== this.#swapTok) return closing.forEach((a) => a.cancel());
        swap();
        for (const el of this.#lids()) {
          el.animate([{ transform: 'scaleY(.06)' }, { transform: 'scaleY(1)' }], {
            duration: 140, easing: 'cubic-bezier(.15, .6, .3, 1)', composite: 'add',
          });
        }
        closing.forEach((a) => a.cancel());
      },
      () => { if (tok === this.#swapTok) swap(); }
    );
    return true;
  }

  // -- reactions -------------------------------------------------------------

  /** Keep the mouse still on the pal for a moment and it falls a little in love. */
  #armStill(e) {
    clearTimeout(this.#stillTimer);
    if (e?.buttons || e?.pointerType === 'touch') return;
    this.#stillTimer = setTimeout(() => {
      if (!this.#hover || !this.isConnected || this.static || this.#dizzy) return;
      const now = Date.now();
      if (now - this.#lastLove < 20_000) return;
      this.#lastLove = now;
      this.emote('love', 1800);
      if (!reducedMotion() && !this.#anim) this.play('squish');
    }, 2000);
  }

  #poke() {
    const now = Date.now();
    this.#clicks = this.#clicks.filter((t) => now - t < QUICK_CLICKS);
    this.#clicks.push(now);
    const count = this.#clicks.length;
    this.dispatchEvent(new CustomEvent('dotpal-poke', { detail: { count }, bubbles: true, composed: true }));
    if (this.#dizzy) return;
    if (count >= 3) {
      this.#clicks = [];
      this.#getDizzy();
      return;
    }
    if (!reducedMotion()) this.play(this.#def.tap); // reduced motion: just the face
    this.emote('hey', 650);
  }

  /** Three quick pokes: spin, spiral eyes and a woozy sway, then a happy face. */
  #getDizzy() {
    const calm = reducedMotion();
    const woozy = (on) => this.#morph(this.#pose, () => this.#root.classList.toggle('dp-woozy', on));
    const dazed = {};
    const better = {};
    this.#dizzy = true;
    return this.#run('react', [
      {
        from: 0,
        to: 3000,
        enter: () => {
          this.#setFace(EMOTE_FACES.dizzy, dazed);
          if (!calm) {
            this.play('dizzy');
            woozy(true);
          }
        },
        exit: () => {
          woozy(false);
          this.#clearFace(dazed);
        },
      },
      {
        from: 3000,
        to: 4300,
        enter: () => {
          this.#dizzy = false;
          this.#setFace(EMOTE_FACES.happy, better);
          if (!calm) this.play('squish');
        },
        exit: () => this.#clearFace(better),
      },
    ]).finally(() => { this.#dizzy = false; });
  }

  // -- timelines & blending --------------------------------------------------

  /**
   * Run a little script on a channel: cues fire at `at` ms, windows call
   * `enter` at `from` and `exit` at `to`. One rAF loop, no stacked timeouts.
   * A newer script on the same channel (or leaving the page) ends this one,
   * and its open windows still get their `exit`.
   */
  #run(channel, cues, length = 0) {
    const tok = ++scriptSeq;
    this.#scripts.set(channel, tok);
    const events = [];
    for (const c of cues) {
      if ('at' in c) events.push({ t: c.at, fn: c.do });
      else {
        const win = { open: false };
        events.push({ t: c.from, fn: () => { win.open = true; c.enter?.(); } });
        events.push({ t: c.to, fn: () => { win.open = false; c.exit?.(); }, win });
      }
    }
    events.sort((a, b) => a.t - b.t);
    const end = Math.max(length, ...events.map((e) => e.t));
    const start = performance.now();
    return new Promise((resolve) => {
      const tick = () => {
        if (this.#scripts.get(channel) !== tok || !this.isConnected) {
          for (const e of events) if (e.win?.open) e.fn(); // close what's still open
          return resolve();
        }
        const t = performance.now() - start;
        while (events.length && events[0].t <= t) events.shift().fn?.();
        if (events.length || t < end) requestAnimationFrame(tick);
        else {
          if (this.#scripts.get(channel) === tok) this.#scripts.delete(channel);
          resolve();
        }
      };
      tick();
    });
  }

  /** Change something that moves `el` (a class, an attribute) and blend from where it was. */
  #morph(el, change) {
    if (!this.isConnected || typeof el.animate !== 'function') {
      change();
      return;
    }
    const from = getComputedStyle(el).transform;
    this.#morphing = true;
    try { change(); } finally { this.#morphing = false; }
    this.#bridgeFrom(el, from);
  }

  /** A mood or idle attribute set from outside: measure its old pose first. */
  #blendExternal(name, oldValue, value) {
    const set = (v) => (v == null ? this.removeAttribute(name) : this.setAttribute(name, v));
    let from;
    this.#restoring = true;
    try {
      set(oldValue);
      from = getComputedStyle(this.#idle).transform;
      set(value);
    } finally {
      this.#restoring = false;
    }
    this.#bridgeFrom(this.#idle, from);
  }

  /** Blend `el` from the transform it had (`from`) into what it has now, over `ms`. */
  #bridgeFrom(el, from, ms = 220) {
    this.#bridges.get(el)?.cancel();
    this.#bridges.delete(el);
    if (from == null) return;
    const to = getComputedStyle(el).transform;
    if (from === to) return;
    const d = bridgeMatrix(from, to);
    if (!d) return;
    const anim = el.animate([{ transform: d }, { transform: 'none' }], {
      duration: ms, easing: 'cubic-bezier(.25, .7, .35, 1)', composite: 'add',
    });
    this.#bridges.set(el, anim);
    anim.finished.then(() => { if (this.#bridges.get(el) === anim) this.#bridges.delete(el); }, () => {});
  }

  // -- bubble ----------------------------------------------------------------

  #syncBubble() {
    if (this.#saying) return;
    const content = {
      thinking: '<span class="dp-dots"><i></i><i></i><i></i></span>',
      working: '<span class="dp-bar"></span>',
      waiting: '<span class="dp-ask">?</span>',
    }[this.mood];
    if (content) this.#showBubble({ html: content });
    else {
      this.#bubbleTok++;
      this.#bubbleAnim?.cancel();
      this.#bubble.classList.remove('dp-show');
    }
  }

  /** Show `text` (or `html`) in the bubble; if it was already showing something else, pop it. */
  #showBubble({ text, html }) {
    const b = this.#bubble;
    const showing = b.classList.contains('dp-show');
    const same = text != null ? !b.childElementCount && b.textContent === text : b.innerHTML === html;
    if (same && showing) return;
    const apply = () => {
      if (text != null) b.textContent = text;
      else b.innerHTML = html;
      b.classList.add('dp-show');
      this.#fitBubble();
    };
    const tok = ++this.#bubbleTok;
    this.#bubbleAnim?.cancel();
    if (!showing || same || reducedMotion() || !this.isConnected || typeof b.animate !== 'function') return apply();
    const out = b.animate([{ scale: '1', opacity: 1 }, { scale: '.8', opacity: 0.35 }], {
      duration: 90, easing: 'cubic-bezier(.5, 0, .9, .6)', fill: 'forwards',
    });
    this.#bubbleAnim = out;
    out.finished.then(() => {
      if (tok !== this.#bubbleTok) return;
      apply();
      this.#bubbleAnim = b.animate(
        [{ scale: '.8', opacity: 0.35 }, { scale: '1.07', opacity: 1, offset: 0.5 }, { scale: '1', opacity: 1 }],
        { duration: 300, easing: 'cubic-bezier(.3, .7, .4, 1)' }
      );
      out.cancel();
    }, () => {});
  }

  /** Slide the bubble sideways so it stays inside the window (its arrow still points at the pal). */
  #fitBubble() {
    requestAnimationFrame(() => {
      if (!this.isConnected || typeof innerWidth !== 'number') return;
      const host = this.getBoundingClientRect();
      const half = this.#bubble.offsetWidth / 2;
      const center = host.left + host.width / 2;
      const margin = 6;
      let shift = 0;
      if (center - half < margin) shift = margin - (center - half);
      else if (center + half > innerWidth - margin) shift = innerWidth - margin - (center + half);
      this.#bubble.style.setProperty('--dp-shift', `${Math.round(shift)}px`);
    });
  }

  // -- drawing ---------------------------------------------------------------

  #render() {
    let def = characters[this.character];
    if (!def) {
      console.warn(`[dotpals] Unknown character "${this.character}". Try: ${Object.keys(characters).join(', ')}`);
      def = characters.blu;
    }
    this.#def = def;
    this.#root.classList.toggle('dp-hang', !!def.hang);

    const id = (name) => `${this.#uid}-${name}`;
    const seed = (this.#n * 7) % 97;
    const parts = def.render({ id, body: `url(#${id('body')})`, fur: `url(#${id('fur')})` });
    const stop = (offset, mix) =>
      `<stop offset="${offset}" style="stop-color: color-mix(in srgb, var(--dp-c) ${mix})"/>`;
    const [mx, my] = def.mouth ?? [100, 170];
    const cheek = def.cheek ?? 34;
    const ink = INK;
    const eyes = Array.isArray(def.eyes?.at) && def.eyes.at.length === 2 && def.eyes.at.every((p) => p?.length === 2 && p.every(Number.isFinite))
      ? def.eyes : null;
    const glow = eyes?.glow ? ` style="filter: drop-shadow(0 0 3px ${eyes.glow === true ? '#9fdcff' : eyes.glow})"` : '';

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
      <g class="dp-body"${def.fur === false ? '' : ` filter="url(#${id('fur')})"`}>${parts.body}</g>
      ${parts.accessories || ''}
      <g class="dp-face">${parts.face || ''}</g>
      ${eyes ? `<g class="dp-alteyes"${glow}><g class="dp-ae-look">${eyes.at
        .map(([x, y]) => `<g transform="translate(${x} ${y})"><g class="dp-ae-s"></g></g>`)
        .join('')}</g></g>` : ''}
      <g class="dp-expr" transform="translate(${mx} ${my})">
        <g class="dp-turn">
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
        </g>
      </g>`;

    // Scale mouth parts from their own centre.
    for (const el of this.#svg.querySelectorAll('.dp-mouth > *')) {
      el.style.transformBox = 'fill-box';
      el.style.transformOrigin = 'center';
    }
    this.#blinkEls = [...this.#svg.querySelectorAll('.dp-blink')];
    this.#lookEls = [...this.#svg.querySelectorAll('.dp-look')];
    // What turns and grows with the gaze: each blinking eye, or else the whole eye group.
    this.#fsEls = this.#blinkEls.length ? this.#blinkEls : this.#lookEls;
    for (const el of this.#fsEls) el.classList.add('dp-fs');
    const marked = [...this.#svg.querySelectorAll('.dp-eyes')];
    this.#hideEls = eyes ? (marked.length ? marked : this.#blinkEls) : [];
    for (const el of this.#hideEls) el.classList.add('dp-hide');
    this.#aeLook = this.#svg.querySelector('.dp-ae-look');
    this.#aeS = [...this.#svg.querySelectorAll('.dp-ae-s')];
    this.#turn = this.#svg.querySelector('.dp-turn');
    this.#eyesKind = null;
    this.#eyesWant = null;
    this.#svg.classList.remove('dp-alt');

    this.#applyColor();
    this.#applyLabel();
    const gaze = FIXED_GAZE[this.mood];
    this.lookAt(...(gaze ?? [this.#gaze.x, this.#gaze.y]));
    this.#refreshFace(false);
  }

  #applyColor() {
    if (!this.#def) return;
    // `color` attribute > --dp-color custom property > character default.
    const color = this.color || `var(--dp-color, ${this.#def.color})`;
    this.#root.style.setProperty('--dp-c', color);
    // The glow while working uses the pal's colour (on the host, so pages can still override --dp-glow).
    this.style.setProperty('--dp-glow-work', color);
  }

  #applyLabel() {
    const name = this.getAttribute('label') || this.#def?.label || 'Dot pal';
    this.setAttribute('aria-label', this.mood === 'neutral' ? name : `${name} (${this.mood})`);
  }

  #applySize() {
    const size = this.getAttribute('size');
    if (size == null) this.style.removeProperty('--dp-size');
    else this.style.setProperty('--dp-size', /^\d+(\.\d+)?$/.test(size) ? `${size}px` : size);
    // Known right away for pixel sizes; the ResizeObserver covers the rest (CSS sizes, em, %).
    const px = size != null && /^\d+(\.\d+)?(px)?$/.test(size.trim()) ? parseFloat(size) : null;
    if (px != null) this.#setTiny(px < TINY);
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
      const quietFor = this.#tiny ? 1500 : 4000;
      if (!still && ACTIVE_GAZE[this.mood]) {
        // Thinking: glance up one side, then the other. Working: scan like reading.
        this.lookAt(...ACTIVE_GAZE[this.mood]());
      } else if (!still && !this.#target && !FIXED_GAZE[this.mood] && performance.now() - pointer.t > quietFor) {
        // No recent pointer movement (or a touch device): let the eyes wander.
        // Tiny avatars (even static ones) glance around more, so they read as alive.
        Math.random() < (this.#tiny ? 0.25 : 0.35) ? this.lookAt(0, 0) : this.lookAt(rand(-1, 1), rand(-0.6, 0.8));
      }
      this.#scheduleBlink();
    }, busy ? rand(900, 2400) : this.#tiny ? rand(1600, 3600) : rand(2200, 5000));
  }

  // -- particles -------------------------------------------------------------

  #snore() {
    this.#burst('z', 1);
  }

  /** Throw `count` particles of `kind` (a built-in shape, or any text glyph). */
  #burst(kind, count = 6) {
    if (!this.isConnected || this.#tiny || reducedMotion()) return;
    const box = this.getBoundingClientRect();
    const size = box.width || 160;
    const height = box.height || size;
    const shape = PARTICLES[kind] ? kind : null;
    for (let i = 0; i < count; i++) {
      let px = size * rand(0.1, 0.16);
      let left = 50;
      let top = 30;
      let dx = rand(-0.55, 0.55) * size;
      let dy = -rand(0.35, 0.7) * size;
      let duration = rand(1000, 1500);
      let delay = i * 75 + rand(0, 40);
      if (shape === 'sweat') {
        const side = Math.random() < 0.5 ? -1 : 1;
        px = size * rand(0.08, 0.1);
        left = 50 + side * rand(22, 30);
        top = rand(34, 44);
        const eyes = this.#def?.eyes;
        if (eyes?.at?.length === 2) {
          // Just outside an eye, a little above it (viewBox units → % of the pal).
          const [ex, ey] = eyes.at[side < 0 ? 0 : 1];
          left = (ex + side * (eyes.r ?? 10) * 2.2) / 2;
          top = (ey - (eyes.r ?? 10) * 1.2) / 2;
        }
        dx = side * size * 0.08;
        dy = size * 0.2;
        duration = rand(900, 1200);
      } else if (shape === 'z') {
        px = size * rand(0.1, 0.13);
        left = 62;
        dx = size * 0.22;
        dy = -size * 0.45;
        duration = 2200;
        delay = 0;
      } else if (shape === 'sparkle') {
        px = size * rand(0.08, 0.15);
        top = 34;
        dx = rand(-0.7, 0.7) * size;
        dy = -rand(0.25, 0.65) * size;
        delay = i * 60 + rand(0, 50);
      }
      // Drawn in an SVG layer over the pal: SVG content outside its box never adds scrollbars.
      const el = document.createElementNS(SVG_NS, 'g');
      el.setAttribute('class', 'dp-particle');
      el.innerHTML = shape
        ? `<g transform="scale(${n2(px / 24)})">${particleShape(shape)}</g>`
        : `<text font-size="${n2(px)}" text-anchor="middle" dominant-baseline="central"></text>`;
      if (!shape) el.firstChild.textContent = kind;
      this.#fx.append(el);
      const x0 = (left / 100) * size;
      const y0 = (top / 100) * height;
      el.animate(particleFrames(shape ?? 'glyph', { x0, y0, dx, dy, rot: shape === 'sweat' ? 0 : rand(-20, 20) }), {
        duration, delay, easing: 'linear', fill: 'backwards',
      }).finished.catch(() => {}).finally(() => el.remove());
    }
  }
}
