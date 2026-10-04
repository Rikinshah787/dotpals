import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DotPal, EMOTES, MOOD_EYES, PARTICLE_KINDS,
  eyeShape, particleSVG, particleFrames, gazeFor, foreshorten,
} from '../src/element.js';
import { characters } from '../src/characters.js';
import { actions } from '../src/actions.js';
import { buildCharacter, CUSTOM_OPTIONS } from '../src/custom.js';

const EYE_KINDS = ['happy', 'closed', 'wide', 'squint', 'x', 'spiral', 'heart', 'star'];
const clean = (svg, what) => assert.ok(svg && !/NaN|undefined|Infinity/.test(svg), `${what}: ${svg}`);

test('expression eyes draw for every kind, side, size and ink', () => {
  for (const kind of EYE_KINDS) {
    for (const side of [-1, 1]) {
      for (const [r, ink] of [[10, '#0b0b12'], [17, '#0b0b12'], [12, '#dff4ff'], [11, '#fff']]) {
        clean(eyeShape(kind, r, ink, side), `${kind}/${side}/${r}/${ink}`);
      }
    }
  }
  assert.equal(eyeShape('nope', 10), '');
  // Squint points inward on both sides: ">" on the left, "<" on the right.
  assert.notEqual(eyeShape('squint', 10, '#000', -1), eyeShape('squint', 10, '#000', 1));
});

test('every face a mood or emote asks for can be drawn', () => {
  for (const kind of Object.values(MOOD_EYES)) assert.ok(EYE_KINDS.includes(kind), kind);
  assert.deepEqual([...DotPal.emotes], EMOTES);
  for (const name of ['happy', 'love', 'star', 'wide', 'closed', 'dizzy', 'oops', 'hey', 'sweat']) assert.ok(EMOTES.includes(name), name);
});

test('particles are inline SVG that fade in, grow ~40% and fade out', () => {
  assert.deepEqual(PARTICLE_KINDS, ['heart', 'sparkle', 'star', 'sweat', 'z']);
  for (const kind of PARTICLE_KINDS) {
    const svg = particleSVG(kind);
    clean(svg, kind);
    assert.match(svg, /^<svg viewBox="-12 -12 24 24"/);
    const frames = particleFrames(kind, { dx: 30, dy: -60, rot: 5 });
    assert.equal(frames[0].offset, 0);
    assert.equal(frames.at(-1).offset, 1);
    assert.equal(frames[0].opacity, 0);
    assert.equal(frames.at(-1).opacity, 0);
    assert.equal(Math.max(...frames.map((f) => f.opacity)), 1);
    assert.equal(frames.find((f) => f.opacity === 1).offset, 0.2); // fully in after the first 20%
    assert.match(frames.at(-1).transform, /scale\(1\.4\)$/);
    for (let i = 1; i < frames.length; i++) assert.ok(frames[i].offset > frames[i - 1].offset);
    for (const f of frames) clean(f.transform, kind);
  }
  assert.equal(particleSVG('♥'), ''); // glyphs are drawn as text, not here
  // Hearts wobble; sweat falls.
  const heart = particleFrames('heart', {}).map((f) => /rotate\((-?[\d.]+)deg\)/.exec(f.transform)[1]);
  assert.ok(new Set(heart).size > 3);
  const sweat = particleFrames('sweat', { dy: 40 });
  assert.match(sweat.at(-1).transform, /^translate\(0px, 40px\)/);
  // Positions are absolute px inside the pal's particle layer.
  assert.match(particleFrames('star', { x0: 50, y0: 20 })[0].transform, /^translate\(50px, 20px\)/);
});

test('gaze: tanh falloff, never past 1, and eyes foreshorten as they turn', () => {
  assert.deepEqual(gazeFor(0, 0, 100), [0, 0]);
  assert.deepEqual(gazeFor(10, 10, 0), [0, 0]);
  let last = 0;
  for (const d of [5, 20, 60, 150, 400, 5000]) {
    const [x, y] = gazeFor(d, 0, 100);
    assert.equal(y, 0);
    assert.ok(x > last && x <= 1, `${d} → ${x}`);
    last = x;
  }
  assert.ok(gazeFor(100000, 0, 100)[0] > 0.999);
  const [dx, dy] = gazeFor(-300, 400, 120);
  assert.ok(dx < 0 && dy > 0 && Math.hypot(dx, dy) <= 1);
  assert.deepEqual(foreshorten(0, 0), [1, 1]);
  assert.deepEqual(foreshorten(1, 0), [0.82, 1]);
  assert.deepEqual(foreshorten(-1, -1), [0.82, 0.88]);
  assert.deepEqual(foreshorten(0, 0, 1.45), [1.45, 1.45]);
  assert.deepEqual(foreshorten(5, 0), [0.82, 1]); // clamped
});

test('every built-in character says where its eyes are', () => {
  for (const [name, def] of Object.entries(characters)) {
    const { at, r } = def.eyes ?? {};
    assert.equal(at?.length, 2, name);
    for (const [x, y] of at) assert.ok(x > 0 && x < 200 && y > 0 && y < 200, name);
    assert.ok(at[0][0] < at[1][0], `${name}: left eye first`);
    assert.ok(r > 4 && r < 30, name);
  }
});

test('custom pals get eye anchors from their shape', () => {
  for (const shape of Object.keys(CUSTOM_OPTIONS.shape)) {
    for (const eyes of Object.keys(CUSTOM_OPTIONS.eyes)) {
      const def = buildCharacter({ shape, eyes, top: 'none' });
      const text = JSON.stringify(def.eyes);
      assert.ok(!/null|NaN/.test(text), `${shape}/${eyes}: ${text}`);
      assert.equal(def.eyes.at.length, 2);
      assert.equal(def.eyes.at[0][1], def.eyes.at[1][1]);
      assert.equal(def.eyes.at[0][0] + def.eyes.at[1][0], 200); // symmetric about the middle
    }
  }
});

test('new actions exist and settle back where they started', () => {
  for (const name of ['hop', 'jitter', 'hello', 'dizzy']) {
    const a = actions[name];
    assert.ok(a && a.keyframes.length > 2 && a.duration > 0, name);
    const offsets = a.keyframes.map((k) => k.offset).filter((o) => o != null);
    for (let i = 1; i < offsets.length; i++) assert.ok(offsets[i] > offsets[i - 1], name);
  }
  assert.match(actions.hop.keyframes.at(-1).transform, /translateY\(0%\) scale\(1, 1\)/);
  assert.equal(actions.jitter.keyframes.at(-1).transform, 'translateX(0)');
  assert.match(actions.hello.keyframes[0].transform, /translateY\(80%\)/); // starts below the ledge
  assert.match(actions.hello.keyframes.at(-1).transform, /translateY\(0\) scale\(1, 1\)/);
  assert.equal(actions.love.particles, 'heart');
});

test('DotPal.pointAt ignores junk and is safe without a DOM', () => {
  assert.doesNotThrow(() => DotPal.pointAt(NaN, 3));
  assert.doesNotThrow(() => DotPal.pointAt(10, 20));
});
