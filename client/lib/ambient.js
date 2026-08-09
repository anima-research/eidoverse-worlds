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
import { audioContext } from './audioctx.js';

const DEFAULT_SRC = 'assets/porch_ambient.ogg';
const sources = new Map();          // entityId -> { el, node, gain, data }
let ctx = null;

// A SUSPENDED CONTEXT ONLY RESUMES INSIDE A REAL USER GESTURE. Calling
// resume() from ordinary code is not a gesture, so the old opportunistic call
// failed silently every time and the retry below re-played the ELEMENT into a
// context that was still suspended — everything correct, nothing audible, no
// error anywhere (R heard nothing from a −14.7 dBFS beacon, 2026-08-08).
// So: arm a one-shot resume on the first real gesture of any kind, and keep it
// armed until the context is actually running.
let gestureArmed = false;
function armGestureResume() {
  if (gestureArmed) return;
  gestureArmed = true;
  const kick = () => {
    if (!ctx) return;
    ctx.resume().then(() => {
      if (ctx.state === 'running') {
        for (const s of sources.values()) s.el.play().catch(() => {});
        for (const ev of ['pointerdown', 'keydown', 'touchstart']) removeEventListener(ev, kick);
        gestureArmed = false;
      }
    }).catch(() => {});
  };
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) addEventListener(ev, kick);
}

function audioCtx() {
  ctx = audioContext();
  if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); armGestureResume(); }
  return ctx;
}

/** harness/debug: why is the world silent? */
export const audioState = () => ({
  ctx: ctx?.state ?? 'none', sources: sources.size, gestureArmed,
  // The GainNode value proves nothing about whether SOUND EXISTS: it is our
  // own multiplier, and it reads 1 whether the element is playing, stalled,
  // erroring, or was never decoded. currentTime advancing is the only proof
  // that media is actually flowing (R: "why can I hear youtube then?" — the
  // routing theory died there and this is what I should have exposed).
  elements: [...sources].map(([id, s]) => ({
    id,
    src: s.el.currentSrc || s.el.src,
    paused: s.el.paused,
    currentTime: +s.el.currentTime.toFixed(2),
    duration: Number.isFinite(s.el.duration) ? +s.el.duration.toFixed(1) : String(s.el.duration),
    readyState: s.el.readyState,   // 0 = nothing, 4 = enough data
    networkState: s.el.networkState, // 3 = NO_SOURCE
    error: s.el.error ? `code ${s.el.error.code}: ${s.el.error.message}` : null,
    muted: s.el.muted, volume: s.el.volume,
    gainNode: +s.gain.gain.value.toFixed(3),
  })),
});

function attach(id, data) {
  detach(id);
  if (!data) return;
  try {
    const c = audioCtx();
    // Resolve against the DOCUMENT, not the current URL-with-query: a relative
    // 'assets/x.ogg' next to '/?world=…&tts=…' is fine, but any future path
    // segment would break it silently. new URL(...) makes it explicit.
    const src = new URL(data.src ?? DEFAULT_SRC, location.origin + '/').href;
    const el = new Audio(src);
    el.loop = data.loop !== false;
    // NO crossOrigin ON A SAME-ORIGIN ASSET. Setting it forces a CORS check,
    // and this server sends no Access-Control-Allow-Origin — so the fetch is
    // tainted and createMediaElementSource() yields SILENCE with no error.
    // Only opt in when the asset really is cross-origin (2026-08-08).
    if (new URL(src).origin !== location.origin) el.crossOrigin = 'anonymous';
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
    // DO NOT DETACH ON A MISSING ENTITY. On a joining client the comp replays
    // before its spawn has settled, so a source attached at that moment would
    // be torn down one frame later and never rebuilt — the component is in the
    // log, the entity exists a moment later, and the world is silent forever.
    // A source with no entity yet is simply inaudible until there is somewhere
    // for it to be; entity removal already detaches via the 'entity' event.
    if (!obj) { s.gain.gain.setTargetAtTime(0, audioCtx().currentTime, 0.08); continue; }
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
