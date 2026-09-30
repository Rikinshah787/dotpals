// One-shot actions, played with the Web Animations API on the `.dp-actor`
// wrapper. They compose with the looping idle animation on the parent.

const squashStretch = (y, sx, sy) => `translateY(${y}%) scale(${sx}, ${sy})`;

export const actions = {
  jump: {
    duration: 700,
    keyframes: [
      { transform: squashStretch(0, 1, 1) },
      { transform: squashStretch(0, 1.1, 0.88), offset: 0.15, easing: 'cubic-bezier(.2,.8,.3,1)' },
      { transform: squashStretch(-22, 0.93, 1.1), offset: 0.45, easing: 'cubic-bezier(.6,0,.8,.4)' },
      { transform: squashStretch(0, 1.12, 0.86), offset: 0.75 },
      { transform: squashStretch(0, 0.97, 1.03), offset: 0.88 },
      { transform: squashStretch(0, 1, 1) },
    ],
  },
  squish: {
    duration: 500,
    keyframes: [
      { transform: 'scale(1, 1)' },
      { transform: 'scale(1.12, .86)', offset: 0.3 },
      { transform: 'scale(.95, 1.05)', offset: 0.6 },
      { transform: 'scale(1.02, .98)', offset: 0.8 },
      { transform: 'scale(1, 1)' },
    ],
  },
  wiggle: {
    duration: 700,
    keyframes: [
      { transform: 'skewX(0)' },
      { transform: 'skewX(-9deg)', offset: 0.15 },
      { transform: 'skewX(8deg)', offset: 0.35 },
      { transform: 'skewX(-5deg)', offset: 0.55 },
      { transform: 'skewX(3deg)', offset: 0.75 },
      { transform: 'skewX(0)' },
    ],
  },
  shake: {
    duration: 550,
    keyframes: [
      { transform: 'rotate(0)' },
      { transform: 'rotate(-8deg)', offset: 0.2 },
      { transform: 'rotate(7deg)', offset: 0.4 },
      { transform: 'rotate(-5deg)', offset: 0.6 },
      { transform: 'rotate(3deg)', offset: 0.8 },
      { transform: 'rotate(0)' },
    ],
  },
  nod: {
    duration: 600,
    keyframes: [
      { transform: 'scale(1, 1)' },
      { transform: 'scale(1.04, .92)', offset: 0.25 },
      { transform: 'scale(1, 1)', offset: 0.5 },
      { transform: 'scale(1.04, .92)', offset: 0.75 },
      { transform: 'scale(1, 1)' },
    ],
  },
  spin: {
    duration: 800,
    easing: 'cubic-bezier(.5,0,.3,1)',
    keyframes: [{ transform: 'rotateY(0)' }, { transform: 'rotateY(360deg)' }],
  },
  love: {
    duration: 600,
    particles: '♥',
    keyframes: [
      { transform: 'scale(1)' },
      { transform: 'scale(1.1)', offset: 0.2 },
      { transform: 'scale(.97)', offset: 0.45 },
      { transform: 'scale(1.05)', offset: 0.65 },
      { transform: 'scale(1)' },
    ],
  },
};

/** Add (or replace) an action usable with `pal.play(name)`. */
export function registerAction(name, { keyframes, duration = 600, easing = 'ease-out', particles } = {}) {
  if (!name || !Array.isArray(keyframes)) {
    throw new TypeError('registerAction(name, { keyframes }) requires a keyframes array');
  }
  actions[name] = { keyframes, duration, easing, particles };
}
