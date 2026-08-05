// ambient — an `ambient` component: a looping sound that belongs to a PLACE.
// Attach it to any entity and that thing becomes the source; walk away and it
// fades. Same shape as picture.js (a component that hangs media on a thing),
// same doctrine: the log says what the world contains, the client decides how
// to make it audible.
//
// Workbench-only for now, deliberately: this is our test fixture for the
// audio-category split (see voiceconsent.js). Without world sound playing,
// "the headphone toggle silences voices but NOT the world" is an untestable
// claim — there is nothing to not-silence. So the fixture is a real component
// rather than a hardcoded background track, which also means the thing being
// tested is the composition path we actually want.
//
// data: { src, gain?, radius?, loop? }
//   src    — a URL the client can fetch (our porch ambience by default)
//   gain   — 0..1 at the source, before distance and before the world slider
//   radius — metres to silence; inside 1/4 of it you get full gain
//
// Audio: WebAudio, not <audio>, so distance and the category slider compose
// as one gain chain instead of fighting over element.volume. House standard
// −23 LUFS applies to the material, not to us; we only attenuate.

import { bus } from './core.js';
import { entities } from './world.js';
import { myState } from './controller.js';
import { volumeFor } from './voiceconsent.js';
import { report } from './core.js';

const DEFAULT_SRC = 'assets/porch_ambient.ogg';
const sources = new Map();          // entityId -> { el, node, gain, data }
let ctx = null;

function audioCtx() {
  if (!ctx) ctx = new (window.AudioContext ?? window.webkitAudioContext)();
  // browsers start suspended until a gesture; resume opportunistically
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function attach(id, data) {
  detach(id);
  if (!data) return;
  try {
    const c = audioCtx();
    const el = new Audio(data.src ?? DEFAULT_SRC);
    el.loop = data.loop !== false;
    el.crossOrigin = 'anonymous';
    const node = c.createMediaElementSource(el);
    const gain = c.createGain();
    gain.gain.value = 0;            // rises with proximity on the first tick
    node.connect(gain).connect(c.destination);
    el.play().catch(() => {
      // autoplay policy: wait for any gesture, then start
      addEventListener('click', () => el.play().catch(() => {}), { once: true });
    });
    sources.set(id, { el, node, gain, data });
  } catch (e) { report('ambient attach', e); }
}

function detach(id) {
  const s = sources.get(id);
  if (!s) return;
  sources.delete(id);
  try { s.el.pause(); s.el.src = ''; s.gain.disconnect(); s.node.disconnect(); }
  catch (e) { report('ambient detach', e); }
}

bus.on('comp', ({ id, type, data }) => { if (type === 'ambient') attach(id, data); });
bus.on('entity', ({ id, gone }) => { if (gone) detach(id); });

/** Per-frame-ish: distance rolloff × the WORLD category slider. Voices and
 *  world are separate categories on purpose — muting people must not mute
 *  the place, which is precisely what this fixture proves. */
export function updateAmbient() {
  if (!sources.size) return;
  const wv = volumeFor('world');
  for (const [id, s] of sources) {
    const obj = entities.get(id);
    if (!obj) { detach(id); continue; }
    const radius = s.data.radius ?? 18;
    const d = obj.position.distanceTo(myState.pos);
    const near = radius * 0.25;
    const roll = d <= near ? 1 : Math.max(0, 1 - (d - near) / (radius - near));
    const target = roll * (s.data.gain ?? 0.7) * wv;
    // setTargetAtTime, never a raw assignment: stepping a gain clicks
    s.gain.gain.setTargetAtTime(target, audioCtx().currentTime, 0.08);
  }
}

/** harness/debug: what is audible and why */
export const ambientDebug = () => Object.fromEntries(
  [...sources].map(([id, s]) => [id, { src: s.data.src ?? DEFAULT_SRC, gain: +s.gain.gain.value.toFixed(3) }]));
