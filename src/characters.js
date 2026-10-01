// Character definitions.
//
// Every character is drawn in a 200×200 viewBox and sits on the bottom edge,
// "peeking" up like the pals in the reference art. Bodies extend below the
// viewBox (to y≈260+) so that when a pal jumps, more body is revealed instead
// of a flat cut-off edge.
//
// A character is an object:
//   label      – human readable name (used for aria-label)
//   color      – default body color (hex)
//   tap        – action played when the pal is clicked
//   look       – how far (in viewBox units) the `.dp-look` parts can move
//   mouth      – [x, y] where mood mouths are drawn
//   cheek      – horizontal distance of the blush from the mouth
//   eyes       – optional { at: [[x, y], [x, y]], r, ink?, glow?, own? }: where the two
//                eyes are and how big, so the pal can swap in expression eyes
//                (happy arcs, hearts…). Without it the normal eyes just squint.
//                `own` lists expressions its own eyes already do (e.g. 'wide').
//   render(p)  – returns { defs, body, accessories, face } SVG strings
//
// `render` receives:
//   p.id(name) – returns an id unique to this instance (for gradients etc.)
//   p.body     – url() of the fluffy body gradient
//   p.fur      – url() of the fur filter
//
// Class hooks used by the element:
//   .dp-blink  – scaled vertically when the pal blinks
//   .dp-look   – translated toward the pointer
//   .dp-eyes   – (optional) the parts hidden while expression eyes show;
//                without it, the .dp-blink parts are hidden

const eyeShine = (cx, cy, r = 2.6) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" opacity=".9"/>`;

export const characters = {
  blu: {
    label: 'Blu',
    color: '#1e88ff',
    tap: 'jump',
    look: 6,
    mouth: [102, 186],
    cheek: 34,
    eyes: { at: [[86, 160], [118, 160]], r: 10 },
    render: ({ id, body, fur }) => ({
      defs: `
        <radialGradient id="${id('beret')}" gradientUnits="userSpaceOnUse" cx="70" cy="50" r="110">
          <stop offset="0" stop-color="#4a4a4a"/>
          <stop offset=".6" stop-color="#1a1a1a"/>
          <stop offset="1" stop-color="#050505"/>
        </radialGradient>`,
      body: `
        <path fill="${body}" d="M16 262 C2 240 0 206 16 190 C0 170 6 138 34 134 C30 108 56 92 82 100
          C94 82 132 80 146 100 C172 96 196 118 186 146 C204 160 202 196 186 208 C196 226 192 250 186 262 Z"/>`,
      accessories: `
        <g filter="${fur}" fill="url(#${id('beret')})">
          <ellipse cx="98" cy="106" rx="84" ry="26" transform="rotate(-6 98 106)"/>
          <ellipse cx="94" cy="88" rx="70" ry="34" transform="rotate(-6 94 88)"/>
          <path d="M80 58 L85 46 L91 57 Z"/>
          <circle cx="85" cy="44" r="10.5"/>
        </g>`,
      face: `
        <g class="dp-look">
          <g class="dp-blink">
            <ellipse cx="86" cy="160" rx="7.5" ry="12" fill="#0b0b12"/>
            <ellipse cx="118" cy="160" rx="7.5" ry="12" fill="#0b0b12"/>
            ${eyeShine(84, 154, 2)}${eyeShine(116, 154, 2)}
          </g>
        </g>`,
    }),
  },

  hop: {
    label: 'Hop',
    color: '#8be22e',
    tap: 'jump',
    look: 8,
    mouth: [100, 142],
    cheek: 52,
    eyes: { at: [[64, 96], [136, 96]], r: 17, own: ['wide'] },
    render: ({ id, body }) => ({
      defs: `
        <radialGradient id="${id('eyeball')}" cx=".4" cy=".35" r=".7">
          <stop offset="0" stop-color="#fff"/>
          <stop offset=".75" stop-color="#f1f1f1"/>
          <stop offset="1" stop-color="#c9c9c9"/>
        </radialGradient>`,
      body: `
        <g fill="${body}">
          <path d="M16 262 L16 176 C16 132 52 112 100 112 C148 112 184 132 184 176 L184 262 Z"/>
          <circle cx="64" cy="100" r="36"/>
          <circle cx="136" cy="100" r="36"/>
        </g>`,
      accessories: '',
      face: [64, 136]
        .map(
          (cx) => `
        <g class="dp-blink">
          <circle cx="${cx}" cy="96" r="23" fill="url(#${id('eyeball')})"/>
          <g class="dp-look">
            <circle cx="${cx}" cy="96" r="12.5" fill="#0b0b12"/>
            ${eyeShine(cx - 4, 91, 3.4)}
          </g>
        </g>`
        )
        .join(''),
    }),
  },

  sunny: {
    label: 'Sunny',
    color: '#ffc21a',
    tap: 'wiggle',
    look: 4,
    mouth: [100, 176],
    cheek: 36,
    eyes: { at: [[74, 137], [126, 137]], r: 12 },
    render: ({ body }) => ({
      defs: '',
      body: `
        <path fill="${body}" d="M12 262 L14 180 C18 120 60 36 100 34 C140 36 182 120 186 180 L188 262 Z"/>`,
      accessories: '',
      face: `
        <g class="dp-look" fill="none" stroke="#0b0b12" stroke-linecap="round">
          <path class="dp-eyes" stroke-width="4.5" d="M63 138 Q74 148 85 138 M115 138 Q126 148 137 138"/>
          <circle cx="74" cy="136" r="23" stroke-width="6" fill="#fff" fill-opacity=".08"/>
          <circle cx="126" cy="136" r="23" stroke-width="6" fill="#fff" fill-opacity=".08"/>
          <path stroke-width="5" d="M97 132 Q100 126 103 132 M51 132 L26 127 M149 132 L174 127"/>
        </g>`,
    }),
  },

  lovi: {
    label: 'Lovi',
    color: '#ff2fc4',
    tap: 'love',
    look: 5,
    mouth: [100, 170],
    cheek: 38,
    eyes: { at: [[76, 134], [124, 134]], r: 11, ink: '#fff' },
    render: ({ id, body }) => ({
      defs: `
        <radialGradient id="${id('lens')}" cx=".35" cy=".3" r=".8">
          <stop offset="0" stop-color="#3a3a44"/>
          <stop offset=".5" stop-color="#101014"/>
          <stop offset="1" stop-color="#000"/>
        </radialGradient>`,
      body: `
        <path fill="${body}" d="M100 290 C58 254 8 204 8 132 C8 86 38 56 70 56 C86 56 96 64 100 78
          C104 64 114 56 130 56 C162 56 192 86 192 132 C192 204 142 254 100 290 Z"/>`,
      accessories: '',
      face: `
        <g class="dp-look">
          <g stroke="#0b0b12" stroke-width="4.5" stroke-linecap="round" fill="none">
            <path d="M95 130 Q100 124 105 130 M58 128 L18 122 M142 128 L182 122"/>
          </g>
          <circle cx="76" cy="134" r="20" fill="url(#${id('lens')})"/>
          <circle cx="124" cy="134" r="20" fill="url(#${id('lens')})"/>
          <g class="dp-eyes">${eyeShine(69, 127, 3)}${eyeShine(117, 127, 3)}</g>
        </g>`,
    }),
  },

  // -- AI agent pals ---------------------------------------------------------

  muse: {
    label: 'Muse',
    color: '#9d6bff',
    tap: 'spin',
    look: 6,
    mouth: [100, 178],
    cheek: 36,
    eyes: { at: [[80, 144], [120, 144]], r: 11 },
    render: ({ body }) => ({
      defs: '',
      body: `
        <path fill="${body}" d="M14 262 L14 172 C14 112 58 78 94 62 C88 46 100 30 118 34
          C106 40 106 54 120 58 C162 78 186 122 186 172 L186 262 Z"/>`,
      accessories: `
        <path class="dp-sparkle" fill="#fff3a6" d="M156 30 Q159 44 172 47 Q159 50 156 64 Q153 50 140 47 Q153 44 156 30 Z"/>
        <path fill="#fff3a6" opacity=".8" d="M40 70 Q41.5 76 48 77.5 Q41.5 79 40 85 Q38.5 79 32 77.5 Q38.5 76 40 70 Z"/>`,
      face: `
        <g class="dp-look">
          ${[80, 120]
            .map(
              (cx, i) => `
            <g class="dp-blink">
              <ellipse cx="${cx}" cy="144" rx="8.5" ry="12" fill="#0b0b12"/>
              <path d="M${cx + (i ? 7 : -7)} 138 l${i ? 6 : -6} -5" stroke="#0b0b12" stroke-width="3.5" stroke-linecap="round"/>
              ${eyeShine(cx - 2.5, 138, 2.6)}
            </g>`
            )
            .join('')}
        </g>`,
    }),
  },

  grok: {
    label: 'Grok',
    color: '#4c5566',
    tap: 'nod',
    look: 10,
    mouth: [100, 182],
    cheek: 46,
    eyes: { at: [[76.5, 127], [123.5, 127]], r: 12, ink: '#dff4ff', glow: true },
    render: ({ id, body }) => ({
      defs: `
        <filter id="${id('glow')}" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="3.5" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>`,
      body: `
        <path fill="${body}" d="M14 262 L14 104 C14 72 36 52 68 52 L132 52 C164 52 186 72 186 104 L186 262 Z"/>`,
      accessories: `
        <rect x="32" y="100" width="136" height="54" rx="27" fill="#0d1117" stroke="#252c38" stroke-width="3"/>
        <path d="M140 60 L118 94" stroke="#fff" stroke-opacity=".35" stroke-width="5" stroke-linecap="round"/>`,
      face: `
        <g class="dp-look" filter="url(#${id('glow')})" fill="#dff4ff">
          <g class="dp-blink"><rect x="68" y="113" width="17" height="28" rx="8.5"/></g>
          <g class="dp-blink"><rect x="115" y="113" width="17" height="28" rx="8.5"/></g>
        </g>`,
    }),
  },

  nova: {
    label: 'Nova',
    color: '#ff7a2f',
    tap: 'jump',
    look: 7,
    mouth: [100, 172],
    cheek: 40,
    eyes: { at: [[78, 142], [122, 142]], r: 11 },
    render: ({ id, body }) => ({
      defs: `
        <radialGradient id="${id('bulb')}" cx=".4" cy=".35" r=".7">
          <stop offset="0" stop-color="#fffbe6"/>
          <stop offset=".6" stop-color="#ffe066"/>
          <stop offset="1" stop-color="#ffb000"/>
        </radialGradient>`,
      body: `
        <path fill="${body}" d="M12 262 L12 152 C12 98 52 72 100 72 C148 72 188 98 188 152 L188 262 Z"/>`,
      accessories: `
        <path d="M100 76 C100 60 104 48 100 38" stroke="#2a2a33" stroke-width="5" stroke-linecap="round" fill="none"/>
        <circle class="dp-bulb" cx="100" cy="32" r="10" fill="url(#${id('bulb')})"/>`,
      face: `
        <g class="dp-look">
          <g class="dp-blink"><circle cx="78" cy="142" r="10.5" fill="#0b0b12"/>${eyeShine(75, 138, 3)}</g>
          <g class="dp-blink"><circle cx="122" cy="142" r="10.5" fill="#0b0b12"/>${eyeShine(119, 138, 3)}</g>
        </g>`,
    }),
  },

  byte: {
    label: 'Byte',
    color: '#16c6ae',
    tap: 'wiggle',
    look: 7,
    mouth: [100, 174],
    cheek: 42,
    eyes: { at: [[75, 137], [125, 137]], r: 11 },
    render: ({ body }) => ({
      defs: '',
      body: `
        <g fill="${body}">
          <path d="M18 262 L18 122 C18 94 40 76 70 76 L130 76 C160 76 182 94 182 122 L182 262 Z"/>
          <path d="M40 90 L34 56 L66 80 Z M160 90 L166 56 L134 80 Z"/>
        </g>`,
      accessories: '',
      face: `
        <g class="dp-look">
          <g class="dp-blink"><rect x="66" y="128" width="18" height="18" rx="3" fill="#0b0b12"/><rect x="69" y="131" width="5" height="5" fill="#fff"/></g>
          <g class="dp-blink"><rect x="116" y="128" width="18" height="18" rx="3" fill="#0b0b12"/><rect x="119" y="131" width="5" height="5" fill="#fff"/></g>
        </g>`,
    }),
  },
};

/**
 * Add (or replace) a character so it can be used as `<dot-pal character="name">`.
 * Existing elements are not re-rendered; set their `character` attribute again.
 */
export function registerCharacter(name, definition) {
  if (!name || typeof definition?.render !== 'function') {
    throw new TypeError('registerCharacter(name, { label, color, render }) requires a render function');
  }
  characters[name] = { label: name, color: '#888888', tap: 'jump', look: 5, mouth: [100, 172], cheek: 36, ...definition };
}
