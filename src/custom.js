// Build your own pal: pick a body, eyes, something on top, a color and a name.
//
//   import { buildCharacter, registerCustom } from 'dotpals/custom';
//   registerCustom({ name: 'Pip', shape: 'round', eyes: 'googly', top: 'sprout', color: '#ff7a2f', fur: true });
//   // → <dot-pal character="custom">
//
// Specs are plain JSON, so they can be saved in settings (~/.dotpals/config.json)
// and checked with `cleanCustom()` on the way in. Works in Node too (no DOM).
import { registerCharacter } from './characters.js';

const shine = (cx, cy, r = 2.6) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" opacity=".9"/>`;
const INK = '#0b0b12';

// Bodies, in the same 200×200 box as the built-in pals (they run off the bottom edge).
//   top: y of the top of the head; ears: where ears and horns attach; eyes: [y, spread];
//   mouth: [x, y]; cheek: blush distance from the mouth.
const SHAPES = {
  round: {
    label: 'Round',
    path: 'M12 262 L12 152 C12 98 52 72 100 72 C148 72 188 98 188 152 L188 262 Z',
    top: 72, ears: [[46, 98], [154, 98]], eyes: [140, 23], mouth: [100, 172], cheek: 42,
  },
  square: {
    label: 'Boxy',
    path: 'M14 262 L14 104 C14 72 36 52 68 52 L132 52 C164 52 186 72 186 104 L186 262 Z',
    top: 52, ears: [[38, 66], [162, 66]], eyes: [124, 26], mouth: [100, 164], cheek: 46,
  },
  blob: {
    label: 'Fluffy',
    path: 'M16 262 C2 240 0 206 16 190 C0 170 6 138 34 134 C30 108 56 92 82 100 C94 82 132 80 146 100 C172 96 196 118 186 146 C204 160 202 196 186 208 C196 226 192 250 186 262 Z',
    top: 86, ears: [[50, 108], [158, 106]], eyes: [158, 17], mouth: [102, 188], cheek: 34,
  },
  tall: {
    label: 'Pointy',
    path: 'M12 262 L14 180 C18 120 60 36 100 34 C140 36 182 120 186 180 L188 262 Z',
    top: 34, ears: [[70, 70], [130, 70]], eyes: [136, 25], mouth: [100, 174], cheek: 38,
  },
  heart: {
    label: 'Heart',
    path: 'M100 290 C58 254 8 204 8 132 C8 86 38 56 70 56 C86 56 96 64 100 78 C104 64 114 56 130 56 C162 56 192 86 192 132 C192 204 142 254 100 290 Z',
    top: 70, ears: [[52, 66], [148, 66]], eyes: [134, 25], mouth: [100, 170], cheek: 40,
  },
  bean: {
    label: 'Frog',
    path: 'M16 262 L16 176 C16 132 52 112 100 112 C148 112 184 132 184 176 L184 262 Z M28 100 A36 36 0 1 1 100 100 A36 36 0 1 1 28 100 Z M100 100 A36 36 0 1 1 172 100 A36 36 0 1 1 100 100 Z',
    top: 64, ears: [[40, 80], [160, 80]], eyes: [98, 36], mouth: [100, 146], cheek: 52,
  },
};

// Eyes: each returns SVG with the element's hooks (.dp-blink closes, .dp-look follows the pointer;
// .dp-eyes, when present, is what hides while expression eyes show). `alt(spread)` sizes those
// expression eyes and picks their ink.
const EYES = {
  dots: {
    label: 'Dots', look: 6, alt: () => ({ r: 10 }),
    draw: (y, d) => `<g class="dp-look">${[-d, d].map((x) => `<g class="dp-blink"><ellipse cx="${100 + x}" cy="${y}" rx="7.5" ry="11.5" fill="${INK}"/>${shine(98 + x, y - 5, 2.2)}</g>`).join('')}</g>`,
  },
  round: {
    label: 'Button', look: 7, alt: () => ({ r: 11 }),
    draw: (y, d) => `<g class="dp-look">${[-d, d].map((x) => `<g class="dp-blink"><circle cx="${100 + x}" cy="${y}" r="10.5" fill="${INK}"/>${shine(97 + x, y - 4, 3)}</g>`).join('')}</g>`,
  },
  googly: {
    label: 'Googly', look: 7, alt: (d) => ({ r: d > 30 ? 17 : 13, own: ['wide'] }),
    draw: (y, d) => [-d, d].map((x) => `<g class="dp-blink"><circle cx="${100 + x}" cy="${y}" r="${d > 30 ? 22 : 17}" fill="#fff" stroke="rgb(0 0 0 / .12)" stroke-width="2"/><g class="dp-look"><circle cx="${100 + x}" cy="${y}" r="${d > 30 ? 11.5 : 9}" fill="${INK}"/>${shine(96 + x, y - 4, 3)}</g></g>`).join(''),
  },
  pixel: {
    label: 'Pixel', look: 7, alt: () => ({ r: 11 }),
    draw: (y, d) => `<g class="dp-look">${[-d, d].map((x) => `<g class="dp-blink"><rect x="${91 + x}" y="${y - 9}" width="18" height="18" rx="3" fill="${INK}"/><rect x="${94 + x}" y="${y - 6}" width="5" height="5" fill="#fff"/></g>`).join('')}</g>`,
  },
  visor: {
    label: 'Visor', look: 10, alt: () => ({ r: 12, ink: '#dff4ff', glow: true }),
    draw: (y, d) => `<rect x="${100 - d - 34}" y="${y - 27}" width="${2 * d + 68}" height="54" rx="27" fill="#0d1117" stroke="#252c38" stroke-width="3"/>
      <g class="dp-look" fill="#dff4ff" style="filter: drop-shadow(0 0 4px #9fdcff)">${[-d, d].map((x) => `<g class="dp-blink"><rect x="${91.5 + x}" y="${y - 14}" width="17" height="28" rx="8.5"/></g>`).join('')}</g>`,
  },
  shades: {
    label: 'Shades', look: 5, alt: () => ({ r: 11, ink: '#fff' }),
    draw: (y, d) => `<g class="dp-look"><path d="M${100 - 6} ${y - 4} Q100 ${y - 10} ${100 + 6} ${y - 4}" stroke="${INK}" stroke-width="4.5" fill="none" stroke-linecap="round"/>${[-d, d].map((x) => `<circle cx="${100 + x}" cy="${y}" r="19" fill="#101014"/>`).join('')}<g class="dp-eyes">${[-d, d].map((x) => shine(93 + x, y - 7, 3)).join('')}</g></g>`,
  },
};

// Something on top of the head. `t` is the top of the head; `ears` the attach points.
const TOPS = {
  none: { label: 'Nothing', draw: () => ({}) },
  ears: {
    label: 'Cat ears',
    // Part of the body, so they get the fur and the body color.
    draw: (t, [[lx, ly], [rx, ry]]) => ({ body: `<path d="M${lx - 16} ${ly + 16} L${lx - 10} ${ly - 30} L${lx + 20} ${ly - 2} Z M${rx + 16} ${ry + 16} L${rx + 10} ${ry - 30} L${rx - 20} ${ry - 2} Z"/>` }),
  },
  horns: {
    label: 'Horns',
    draw: (t, [[lx, ly], [rx, ry]]) => ({ top: `<g fill="#f3e6c8" stroke="#c9b58c" stroke-width="2"><path d="M${lx + 2} ${ly + 6} C${lx - 12} ${ly - 6} ${lx - 14} ${ly - 22} ${lx - 6} ${ly - 34} C${lx - 2} ${ly - 20} ${lx + 8} ${ly - 10} ${lx + 16} ${ly - 2} Z"/><path d="M${rx - 2} ${ry + 6} C${rx + 12} ${ry - 6} ${rx + 14} ${ry - 22} ${rx + 6} ${ry - 34} C${rx + 2} ${ry - 20} ${rx - 8} ${ry - 10} ${rx - 16} ${ry - 2} Z"/></g>` }),
  },
  antenna: {
    label: 'Antenna',
    draw: (t) => ({ top: `<path d="M100 ${t + 4} C100 ${t - 12} 104 ${t - 24} 100 ${t - 34}" stroke="#2a2a33" stroke-width="5" stroke-linecap="round" fill="none"/><circle class="dp-bulb" cx="100" cy="${t - 40}" r="10" fill="#ffe066" stroke="#ffb000" stroke-width="2"/>` }),
  },
  sprout: {
    label: 'Sprout',
    draw: (t) => ({ top: `<path d="M100 ${t + 4} C100 ${t - 8} 100 ${t - 16} 100 ${t - 22}" stroke="#3e8e2e" stroke-width="4.5" stroke-linecap="round" fill="none"/><path fill="#6fcf4a" d="M100 ${t - 20} C88 ${t - 38} 70 ${t - 36} 66 ${t - 26} C78 ${t - 18} 92 ${t - 16} 100 ${t - 20} Z M100 ${t - 20} C112 ${t - 40} 132 ${t - 40} 136 ${t - 30} C124 ${t - 20} 110 ${t - 16} 100 ${t - 20} Z"/>` }),
  },
  sparkle: {
    label: 'Sparkle',
    draw: (t) => ({ top: `<path class="dp-sparkle" fill="#fff3a6" d="M146 ${t - 38} Q149 ${t - 24} 162 ${t - 21} Q149 ${t - 18} 146 ${t - 4} Q143 ${t - 18} 130 ${t - 21} Q143 ${t - 24} 146 ${t - 38} Z"/><path fill="#fff3a6" opacity=".8" d="M52 ${t - 12} Q53.5 ${t - 6} 60 ${t - 4.5} Q53.5 ${t - 3} 52 ${t + 3} Q50.5 ${t - 3} 44 ${t - 4.5} Q50.5 ${t - 6} 52 ${t - 12} Z"/>` }),
  },
  bow: {
    label: 'Bow',
    draw: (t, [, [rx, ry]]) => ({ top: `<g transform="translate(${rx - 18} ${ry - 4}) rotate(18)"><path fill="#ff4d8d" d="M0 0 L-24 -14 C-30 -4 -30 6 -24 14 Z M0 0 L24 -14 C30 -4 30 6 24 14 Z"/><circle r="7" fill="#e0306f"/></g>` }),
  },
  crown: {
    label: 'Crown',
    draw: (t) => ({ top: `<path fill="#ffc933" stroke="#d99a00" stroke-width="2.5" stroke-linejoin="round" d="M72 ${t + 6} L68 ${t - 26} L86 ${t - 10} L100 ${t - 34} L114 ${t - 10} L132 ${t - 26} L128 ${t + 6} Z"/><circle cx="100" cy="${t - 6}" r="4.5" fill="#ff4d7e"/>` }),
  },
  beret: {
    label: 'Beret',
    draw: (t) => ({ top: `<g fill="#1a1a1a"><ellipse cx="100" cy="${t + 8}" rx="74" ry="20" transform="rotate(-6 100 ${t + 8})"/><ellipse cx="96" cy="${t - 6}" rx="60" ry="28" transform="rotate(-6 96 ${t - 6})"/><circle cx="88" cy="${t - 34}" r="8"/></g>` }),
  },
};

export const CUSTOM_OPTIONS = {
  shape: Object.fromEntries(Object.entries(SHAPES).map(([k, v]) => [k, v.label])),
  eyes: Object.fromEntries(Object.entries(EYES).map(([k, v]) => [k, v.label])),
  top: Object.fromEntries(Object.entries(TOPS).map(([k, v]) => [k, v.label])),
};

export const DEFAULT_CUSTOM = { name: 'My pal', shape: 'round', eyes: 'googly', top: 'sprout', color: '#ff7a2f', fur: true };

/** A valid spec from anything (unknown values fall back to the defaults). */
export function cleanCustom(input) {
  if (!input || typeof input !== 'object') return null;
  const pick = (key, table) => (Object.hasOwn(table, input[key]) ? input[key] : DEFAULT_CUSTOM[key]);
  return {
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 24) : DEFAULT_CUSTOM.name,
    shape: pick('shape', SHAPES),
    eyes: pick('eyes', EYES),
    top: pick('top', TOPS),
    color: /^#[0-9a-f]{6}$/i.test(input.color) ? input.color.toLowerCase() : DEFAULT_CUSTOM.color,
    fur: input.fur !== false,
  };
}

/** A character definition (see characters.js) from a spec. */
export function buildCharacter(spec) {
  const s = cleanCustom(spec) ?? DEFAULT_CUSTOM;
  const shape = SHAPES[s.shape];
  const eyes = EYES[s.eyes];
  const [eyeY, spread] = shape.eyes;
  return {
    label: s.name,
    color: s.color,
    tap: 'jump',
    look: eyes.look,
    mouth: shape.mouth,
    cheek: shape.cheek,
    // Where expression eyes (happy arcs, hearts…) go: on top of the drawn eyes.
    eyes: { at: [[100 - spread, eyeY], [100 + spread, eyeY]], ...eyes.alt(spread) },
    fur: s.fur,
    render: ({ body }) => {
      const top = TOPS[s.top].draw(shape.top, shape.ears);
      return {
        defs: '',
        body: `<g fill="${body}"><path fill-rule="nonzero" d="${shape.path}"/>${top.body ?? ''}</g>`,
        accessories: top.top ?? '',
        face: eyes.draw(eyeY, spread),
      };
    },
  };
}

/** Register (or update) your pal as `character="custom"`. */
export function registerCustom(spec, name = 'custom') {
  registerCharacter(name, buildCharacter(spec));
  return name;
}
