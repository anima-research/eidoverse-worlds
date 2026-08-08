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
//   src    — a CONTENT-ADDRESSED store path (store/audio/<hash>.<ext>),
//            minted by POST /upload?as=audio (sniffed, capped, hashed).
//            Never a URL: a component any builder can author must not turn
//            arbitrary endpoints into every client's audio fetch (#31/#45
//            review). Served via /library/ with immutable caching.
//   gain   — source gain, clamped to [0, 1]
//   radius — metres to silence, clamped to [1, 60]; inside 1/4 = full gain
//   loop   — loop-only for now: the blind fold reconstructs components for
//            every late join, so a one-shot would replay per arrival.
//
// The server lints all of this at AUTHOR time; this file re-checks because
// history can predate the lint — malformed persisted components are refused
// LEGIBLY (ambientDebug().refused carries the reason) and stay in the log.
//
// Audio: WebAudio, not <audio>, so distance and the category slider compose
// as one gain chain instead of fighting over element.volume. House standard
// −23 LUFS applies to the material, not to us; we only attenuate.

import { bus } from './core.js';
import { entities } from './world.js';
import { myState } from './controller.js';
import { volumeFor } from './voiceconsent.js';
import { report } from './core.js';

const sources = new Map();          // entityId -> { el, node, gain, data }
const refused = new Map();          // entityId -> reason (legible, queryable)
let ctx = null;

function audioCtx() {
  if (!ctx) ctx = new (window.AudioContext ?? window.webkitAudioContext)();
  // browsers start suspended until a gesture; resume opportunistically
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** store-path gate — returns the /library URL for a valid store src, else null */
export function ambientSrc(raw) {
  return /^store\/audio\/[0-9a-f]{16}\.(ogg|wav|mp3)$/.test(raw ?? '') ? `/library/${raw}` : null;
}

/** why a component is refusable — one truth for gate + receipts */
export function ambientLint(data) {
  if (!ambientSrc(data?.src)) return `src must be a store/audio/ path (got "${String(data?.src ?? '').slice(0, 80)}")`;
  if (data.loop === false) return 'loop-only: a one-shot would replay for every late join (#31)';
  return null;
}

function attach(id, data) {
  detach(id);
  refused.delete(id);
  if (!data) return;
  const why = ambientLint(data);
  if (why) { refused.set(id, why); report('ambient refuse', `${id}: ${why}`); return; }
  const src = ambientSrc(data.src);
  try {
    const c = audioCtx();
    const el = new Audio(src);
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
  refused.delete(id);
  const s = sources.get(id);
  if (!s) return;
  sources.delete(id);
  try { s.el.pause(); s.el.src = ''; s.gain.disconnect(); s.node.disconnect(); }
  catch (e) { report('ambient detach', e); }
}

bus.on('comp', ({ id, type, data }) => { if (type === 'ambient') attach(id, data); });
// world.js emits { kind: 'remove' } — the fixture listened for a { gone }
// field that nothing emits, so removal cleanup only happened incidentally
// on a later frame (#26 review catch)
bus.on('entity', ({ id, kind }) => { if (kind === 'remove') detach(id); });
bus.on('world-reset', () => { for (const id of [...sources.keys()]) detach(id); });

/** Per-frame-ish: distance rolloff × the WORLD category slider. Voices and
 *  world are separate categories on purpose — muting people must not mute
 *  the place, which is precisely what this fixture proves. */
export function updateAmbient() {
  if (!sources.size) return;
  const wv = volumeFor('world');
  for (const [id, s] of sources) {
    const obj = entities.get(id);
    if (!obj) { detach(id); continue; }
    const radius = Math.max(1, Math.min(60, s.data.radius ?? 18));
    const d = obj.position.distanceTo(myState.pos);
    const near = radius * 0.25;
    const roll = d <= near ? 1 : Math.max(0, 1 - (d - near) / (radius - near));
    const target = roll * Math.max(0, Math.min(1, s.data.gain ?? 0.7)) * wv;
    // setTargetAtTime, never a raw assignment: stepping a gain clicks
    s.gain.gain.setTargetAtTime(target, audioCtx().currentTime, 0.08);
  }
}

/** harness/debug: what is audible and why */
export const ambientCount = () => sources.size;

export const ambientDebug = () => ({
  playing: Object.fromEntries(
    [...sources].map(([id, s]) => [id, { src: s.data.src, gain: +s.gain.gain.value.toFixed(3) }])),
  refused: Object.fromEntries(refused),
});
