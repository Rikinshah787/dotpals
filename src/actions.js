// One-shot actions, played with the Web Animations API on the `.dp-actor`
// wrapper. They compose with the looping idle animation on the parent.
//
// `particles` is one of the built-in particle shapes ('heart', 'sparkle',
// 'star', 'sweat', 'z'), or any other text/emoji glyph.

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
    particles: 'heart',
    keyframes: [
      { transform: 'scale(1)' },
      { transform: 'scale(1.1)', offset: 0.2 },
      { transform: 'scale(.97)', offset: 0.45 },
      { transform: 'scale(1.05)', offset: 0.65 },
      { transform: 'scale(1)' },
    ],
  },
  // A quick rise that lands a little low and springs back ("hey, over here").
  hop: {
    duration: 560,
    easing: 'linear',
    keyframes: [
      { transform: squashStretch(0, 1, 1), easing: 'cubic-bezier(.3,.6,.5,1)' },
      { transform: squashStretch(0, 1.08, 0.92), offset: 0.14, easing: 'cubic-bezier(.2,.8,.3,1)' },
      { transform: squashStretch(-13, 0.95, 1.06), offset: 0.42, easing: 'cubic-bezier(.6,0,.9,.5)' },
      { transform: squashStretch(2.5, 1.09, 0.9), offset: 0.66, easing: 'cubic-bezier(.3,.7,.4,1)' },
      { transform: squashStretch(-1.5, 0.98, 1.02), offset: 0.84, easing: 'ease-in-out' },
      { transform: squashStretch(0, 1, 1) },
    ],
  },
  // A fast side-to-side shudder that dies down: reads as "something went wrong".
  jitter: {
    duration: 520,
    easing: 'linear',
    keyframes: [
      { transform: 'translateX(0)' },
      { transform: 'translateX(-6%)', offset: 0.08 },
      { transform: 'translateX(6%)', offset: 0.2 },
      { transform: 'translateX(-5%)', offset: 0.32 },
      { transform: 'translateX(4%)', offset: 0.44 },
      { transform: 'translateX(-2.5%)', offset: 0.58 },
      { transform: 'translateX(1.5%)', offset: 0.72 },
      { transform: 'translateX(-.6%)', offset: 0.86 },
      { transform: 'translateX(0)' },
    ],
  },
  // Pop up from below the ledge, settle with a squash, then one little hop.
  hello: {
    duration: 1500,
    easing: 'linear',
    keyframes: [
      { transform: 'translateY(80%) scale(.9, 1.08)', easing: 'cubic-bezier(.15,.75,.3,1)' },
      { transform: 'translateY(-6%) scale(.96, 1.05)', offset: 0.3, easing: 'cubic-bezier(.5,0,.6,1)' },
      { transform: 'translateY(0) scale(1.09, .9)', offset: 0.42, easing: 'cubic-bezier(.3,.7,.4,1)' },
      { transform: 'translateY(0) scale(1, 1)', offset: 0.54 },
      { transform: 'translateY(0) scale(1.06, .94)', offset: 0.62, easing: 'cubic-bezier(.2,.8,.3,1)' },
      { transform: 'translateY(-11%) scale(.96, 1.05)', offset: 0.75, easing: 'cubic-bezier(.6,0,.8,.4)' },
      { transform: 'translateY(0) scale(1.07, .93)', offset: 0.87, easing: 'ease-out' },
      { transform: 'translateY(0) scale(1, 1)' },
    ],
  },
  // Zip up the thread, then drop and bounce on it like a bungee (for pals that hang).
  drop: {
    duration: 1300,
    easing: 'linear',
    keyframes: [
      { transform: squashStretch(0, 1, 1), easing: 'cubic-bezier(.2,.8,.3,1)' },
      { transform: squashStretch(-70, 0.94, 1.08), offset: 0.16 },
      { transform: squashStretch(-70, 1, 1), offset: 0.3, easing: 'cubic-bezier(.55,0,.9,.5)' },
      { transform: squashStretch(4, 1.06, 0.92), offset: 0.55, easing: 'cubic-bezier(.2,.7,.4,1)' },
      { transform: squashStretch(-12, 0.97, 1.04), offset: 0.7, easing: 'cubic-bezier(.5,0,.6,1)' },
      { transform: squashStretch(2, 1.02, 0.98), offset: 0.84, easing: 'ease-in-out' },
      { transform: squashStretch(0, 1, 1) },
    ],
  },
  // Two fast turns that run out of steam.
  dizzy: {
    duration: 1150,
    easing: 'linear',
    keyframes: [
      { transform: 'rotateY(0) scale(1, 1)', easing: 'cubic-bezier(.4,0,.6,1)' },
      { transform: 'rotateY(380deg) scale(.95, 1.05)', offset: 0.45, easing: 'cubic-bezier(.2,.6,.3,1)' },
      { transform: 'rotateY(720deg) scale(1.06, .95)', offset: 0.85, easing: 'ease-in-out' },
      { transform: 'rotateY(720deg) scale(1, 1)' },
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
