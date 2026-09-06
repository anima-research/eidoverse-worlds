// governor — one quality controller, session-scoped, two-way.
//
// The old governor (main.js) was five one-way ratchets and two recovering
// levers: shed grass never grew back, a doused light stayed doused
// (MAX_CAST-- was permanent), the shadow map never re-sharpened — and the
// cloud lever both PERSISTED its degradation to localStorage across
// sessions and answered "this machine is slow right now" with a full sky
// rebuild, the single most expensive operation the client has. One bad
// three-second window (a tab restore, a burst of arrivals) could
// permanently degrade a world.
//
// The new contract (TEL0S_NOTES §12.6):
//   * every lever moves BOTH ways — what a slow minute takes, a smooth
//     minute gives back;
//   * session-scoped, never a localStorage write — machine pressure is not
//     a preference;
//   * the governor never touches the cloud tier at all. Cloud quality is
//     the resident's ⚙ choice (a preference, persisted as one); the levers
//     below are cheaper, reversible, and measured. The old cloud lever is
//     simply gone.
//
// The ladder, in shed order (recovery unwinds it back-to-front, so pixels —
// shed late — return first, and content comes back last):
//
//   casters   distant objects stop casting shadows (castShadow is in no
//             pipeline key — free toggles, §12.1)
//   slots     the light-slot cap drops (idle slots are uniform zeros)
//   emitters  per-emitter instance counts thin (auto → med → low)
//   grass     the meadow thins (instanced count — no rebuild)
//   lod       far placed objects fetch their reduced tier sooner (#156: the
//             policy's edge halves; swaps happen on the residency sweep)
//   pixels    render scale, −0.25 steps to 0.7
//   detail    LOD bias 2 (far bodies at half rate) + shadow map 1024
//
// Pacing: a shed needs 3 consecutive slow seconds and resets the counter —
// one lever per window, so a hitch cannot cascade the whole ladder. A
// restore needs 5 consecutive smooth seconds. The 26/52 fps gap between
// the two thresholds is the hysteresis that keeps shed/restore from
// chattering; the dead band between them counts toward neither ladder —
// but see the cruise lever below (§22j): a sustained cruise inside the
// band steps pixels alone down, because pixel-bound machines live there.
//
// Loading grace (§16.2.D): while the engine is LOADING — warm conductor
// items queued or running, loadwork lanes busy, promote tails pending —
// storm fps is not a performance regime and lever moves make it worse
// (each pixels notch is a render-target realloc, each detail flip a 16MB
// shadow-map realloc, §16.1g). Both directions freeze and the streak
// counters reset, so a storm never carries partial counts into calm.
// whenCalm() is the storm-edge signal the deferred extras (thumbnail
// contribution, roster prefetch) wait on: 5 consecutive smooth seconds
// with no loading work in flight — the restore ladder's own 1Hz fps read,
// not a second meter.

import { renderer, sun, BASE_PIXEL_RATIO } from './core.js';
import { CONFIG } from './base.js';
import { warmStats } from './warmqueue.js';
import { laneBusy } from './loadwork.js';
import { promoteTailPending, modelQuality } from './realize/models.js';
import { setSlotCap, getSlotCap, maxSlots, litCount,
  setCasterBudget, getCasterBudget, casterCount } from './lightrig.js';
import { setEmitterQuality, emitterQuality, emitterCount } from './emitters.js';
import { setGrassDensity, getGrassDensity, hasGrass } from './terrain.js';
import { setLodBias } from './remotes.js';
import { setSystemEvery, getSystemEvery } from './frame.js';
import { toast } from './ui.js';

// ---- the resident's render-scale dial (§22k) --------------------------------
// The §22j A/B proved pixel-bound machines exist; the cruise answers them
// automatically. This is the MANUAL override, a preference like clouds⚙ and
// grass⚙ (persisted — an explicit choice is a preference; machine pressure
// stays session-only): 'auto' lets the cruise drive, a pinned factor sets
// the base outright and turns the cruise off — the resident's word is not
// something the governor argues with. The emergency <26fps pixels lever
// still sheds below a pinned base (and restores back to it): a crisis
// outranks a preference, but only for as long as it lasts.
const RS_KEY = 'ew-render-scale';
export const RENDER_SCALES = ['auto', '1', '0.85', '0.7'];
let renderScale = RENDER_SCALES.includes(localStorage.getItem(RS_KEY))
  ? localStorage.getItem(RS_KEY) : 'auto';
const residentBase = () =>
  renderScale === 'auto' ? BASE_PIXEL_RATIO : BASE_PIXEL_RATIO * Number(renderScale);

let pixelRatio = BASE_PIXEL_RATIO;
const setPR = (v) => { pixelRatio = v; renderer.setPixelRatio(v); };

export const getRenderScale = () => renderScale;
export function setRenderScale(v) {
  if (!RENDER_SCALES.includes(v)) return renderScale;
  renderScale = v;
  localStorage.setItem(RS_KEY, v);
  // an explicit move re-anchors outright — session sheds don't survive the
  // resident taking the wheel
  setPR(residentBase());
  return renderScale;
}
if (renderScale !== 'auto') setPR(residentBase());

const EMITTER_TIERS = ['auto', 'med', 'low'];
const CASTER_STEPS = [12, 6, 2];
const GRASS_STEPS = [1, 0.6, 0.35];

// Each lever: shed() / restore() return whether they moved a notch. The
// toast rides the shed (people deserve to know why the world changed);
// restores are silent — detail quietly coming back needs no announcement.
const LEVERS = [
  {
    name: 'casters',
    // step to the largest ladder value strictly below/above the current
    // budget — robust to an off-ladder value if anything else ever calls
    // setCasterBudget (review note 6: indexOf-based stepping could RAISE it)
    shed() {
      if (casterCount() === 0) return false;   // nothing casting → no relief,
                                               // don't burn the shed window
      const next = CASTER_STEPS.find((s) => s < getCasterBudget());
      if (next === undefined) return false;
      setCasterBudget(next);
      return true;
    },
    restore() {
      const next = [...CASTER_STEPS].reverse().find((s) => s > getCasterBudget());
      if (next === undefined) return false;
      setCasterBudget(next);
      return true;
    },
  },
  {
    name: 'lights',
    shed() {
      // a cap cut only relieves GPU if something is actually casting — an
      // empty world must not eat shed windows and toast lies (review note 3)
      if (getSlotCap() === 0 || litCount() === 0) return false;
      setSlotCap(getSlotCap() - 1);
      toast('turned a light down to keep the frame rate — it still glows', 'warn', 6000);
      return true;
    },
    restore() {
      if (getSlotCap() >= maxSlots()) return false;
      setSlotCap(getSlotCap() + 1);
      return true;
    },
  },
  {
    name: 'emitters',
    shed() {
      if (!emitterCount()) return false;
      const i = EMITTER_TIERS.indexOf(emitterQuality());
      if (i < 0 || i >= EMITTER_TIERS.length - 1) return false;
      if (!setEmitterQuality(EMITTER_TIERS[i + 1])) return false;
      toast('particle effects thinned to keep the frame rate', 'warn', 8000);
      return true;
    },
    restore() {
      const i = EMITTER_TIERS.indexOf(emitterQuality());
      if (i <= 0) return false;
      return Boolean(setEmitterQuality(EMITTER_TIERS[i - 1]));
    },
  },
  {
    // the first system-stride lever (§14.2 6b): the cosmetic per-frame
    // hooks — cloud drift, grass wind, emitter billboards — at half rate.
    // 30Hz wind is a degrade nobody reports; a lost frame is.
    name: 'cosmetics',
    shed() {
      if (getSystemEvery('autos') >= 2) return false;
      setSystemEvery('autos', 2);
      return true;
    },
    restore() {
      if (getSystemEvery('autos') <= 1) return false;
      setSystemEvery('autos', 1);
      return true;
    },
  },
  {
    name: 'grass',
    // The governor tracks its OWN dial. Effective density = min(resident's
    // grass⚙ cap, this dial) — shed still steps from EFFECTIVE (a meadow
    // the cap already holds below the step must not toast a no-op), but
    // restore answers for the dial alone: restoring against effective
    // returned "true" forever under a capped resident (min() ate the
    // change), wedging the unwind so casters/lights/emitters never
    // recovered (review blocker 1 — the exact ratchet §12.6 exists to kill).
    shed() {
      const eff = getGrassDensity();
      if (!hasGrass() || eff <= GRASS_STEPS[GRASS_STEPS.length - 1]) return false;
      grassDial = eff > 0.65 ? 0.6 : 0.35;
      setGrassDensity(grassDial);
      toast('grass thinned to keep the frame rate', 'warn', 8000);
      return true;
    },
    restore() {
      if (!hasGrass() || grassDial >= 1) return false;
      grassDial = grassDial < 0.5 ? 0.6 : 1;
      setGrassDensity(grassDial);
      return true;
    },
  },
  {
    name: 'lod',
    // The tier policy's session dial (lod_policy.js shed): under load the
    // reduce-at edge halves, so placed objects at middling distance fetch the
    // reduced variant on their next sweep; restore widens it again. Nothing
    // rebuilds — the swap rides the residency sweep's own retier path.
    shed() {
      if (modelQuality.shed || modelQuality.quality !== 'auto') return false;
      modelQuality.setShed(true);
      toast('distant objects reduced to keep the frame rate', 'warn', 8000);
      return true;
    },
    restore() {
      if (!modelQuality.shed) return false;
      modelQuality.setShed(false);
      return true;
    },
  },
  {
    name: 'pixels',
    shed() {
      if (pixelRatio <= 0.7) return false;
      setPR(Math.max(0.7, pixelRatio - 0.25));
      return true;
    },
    restore() {
      if (pixelRatio >= residentBase()) return false;
      setPR(Math.min(residentBase(), pixelRatio + 0.125));
      return true;
    },
  },
  {
    name: 'detail',
    shed() {
      if (shedDetail) return false;
      shedDetail = true;
      setLodBias(2);                    // far bodies animate at half rate
      if (sun.shadow.mapSize.width > 1024) {
        // mapSize is uniform + texture realloc, not pipeline shape (§12.1)
        // — which is exactly what makes this lever two-way at last
        sun.shadow.mapSize.set(1024, 1024);
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
      return true;
    },
    restore() {
      if (!shedDetail) return false;
      shedDetail = false;
      setLodBias(1);
      if (sun.shadow.mapSize.width < 2048) {
        sun.shadow.mapSize.set(2048, 2048);
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
      return true;
    },
  },
];
let shedDetail = false;
let grassDial = 1;

// ---- the cruise lever (§22j — reopens §17d with evidence) -------------------
//
// The dead band was designed as neutral ground: neither slow enough to shed
// nor smooth enough to restore, so nothing moves. Then the grasslod A/B on
// the pixel-bound Air (§22i, drift-controlled) measured the law directly:
// at 1× render scale EVERY grass shader runs 60fps, at 2× EVERY one runs
// ~30 — the machine's whole steady state lives inside 26–52, where the
// ladder never engages, and resolution is the only lever that moves it.
//
// So ONE lever — pixels, the least visible and the first to restore — also
// answers a *sustained* mid-band cruise. Deliberately gentler than the
// emergency ladder: an 8s streak (vs 3), and a higher floor — 70% of BASE,
// never the emergency 0.7 absolute (on a 2× panel that floor is 1.4, still
// a 1.4× effective ratio; ~51% of the pixels for roughly +20fps by the A/B's
// own render-scale rows). Restore is the shared silent +0.125 above 52fps;
// its smaller step and the 5s-vs-8s streak asymmetry damp the boundary
// oscillation. ?cruise=off disables the whole thing (the §17d A/B lever).
const CRUISE = (CONFIG.params.get('cruise') ?? 'on') !== 'off';
const cruiseFloor = () => Math.max(0.7, residentBase() * 0.7);
const cruiseActive = () => CRUISE && renderScale === 'auto';   // a pinned scale is the resident's word
let midFor = 0;

let slowFor = 0;
let goodFor = 0;
const history = [];   // recent lever moves, for the debug surface

// ---- loading grace + the calm signal (§16.2.D) ------------------------------

/** The busy predicate: is the engine loading RIGHT NOW? Composed from the
 *  three places load work actually lives — the warm conductor (queued or
 *  mid-item), loadwork's cpu/gpu lanes, and the promote tail's pending
 *  boulders — each read through its own smallest honest export. */
function loadingBusy() {
  const w = warmStats();
  return w.pending > 0 || w.running || laneBusy() || promoteTailPending() > 0;
}

let grace = false;        // the last pulse was held by loading grace
let graceDipped = false;  // this grace spell already told its story in history
let calmFor = 0;          // consecutive smooth AND non-busy seconds (never
                          // consumed by restores — goodFor is, per lever)
let calmReached = false;  // sticky: arrival proved smooth once this session
const calmWaiters = [];

/** Resolves once smoothness (the restore ladder's >52fps read, fed at 1Hz)
 *  has held 5 consecutive seconds with the busy predicate false throughout.
 *  Sticky: this is a storm-edge signal for boot-deferred extras, and once
 *  the arrival has proven itself the answer stays yes. */
export function whenCalm() {
  if (calmReached) return Promise.resolve();
  return new Promise((res) => calmWaiters.push(res));
}

/** Feed once per second with the measured fps. */
export function governPerformance(fps) {
  if (loadingBusy()) {
    // freeze BOTH directions and reset every streak: a storm-dip shed and a
    // splash-smooth restore are both answers to loading, not to the machine
    if (!grace) { grace = true; graceDipped = false; }
    if (fps > 0 && fps < 26 && !graceDipped) {
      // one history line per grace spell, only when grace actually swallowed
      // a would-be slow second — the story without the 1Hz flap spam
      graceDipped = true;
      if (history.length < 60) history.push(`⏸ grace held ${Math.round(fps)}fps @${Math.round(performance.now() / 1000)}s`);
    }
    slowFor = 0;
    goodFor = 0;
    calmFor = 0;
    midFor = 0;
    return;
  }
  grace = false;
  if (fps > 0 && fps < 26) {
    goodFor = 0;
    calmFor = 0;
    midFor = 0;
    slowFor++;
    if (slowFor > 2) {
      for (const lever of LEVERS) {
        if (lever.shed()) {
          slowFor = 0;   // one lever per slow window — a hitch cannot cascade
          if (history.length < 60) history.push(`− ${lever.name} @${Math.round(performance.now() / 1000)}s`);
          break;
        }
      }
    }
  } else if (fps > 52) {
    slowFor = 0;
    midFor = 0;
    calmFor++;
    if (!calmReached && calmFor > 4) {
      calmReached = true;
      if (history.length < 60) history.push(`✓ calm @${Math.round(performance.now() / 1000)}s`);
      while (calmWaiters.length) calmWaiters.shift()();
    }
    goodFor++;
    if (goodFor > 4) {
      // unwind back-to-front: pixels return before the meadow regrows
      for (let i = LEVERS.length - 1; i >= 0; i--) {
        if (LEVERS[i].restore()) {
          goodFor = 0;
          if (history.length < 60) history.push(`+ ${LEVERS[i].name} @${Math.round(performance.now() / 1000)}s`);
          break;
        }
      }
    }
  } else {
    // the dead band: neither slow nor provably smooth — the ladder counters
    // re-earn their streaks. But a SUSTAINED cruise here is the pixel-bound
    // regime (§22j above): pixels alone may step down, gently, to its own
    // higher floor.
    slowFor = 0;
    goodFor = 0;
    calmFor = 0;
    midFor++;
    if (cruiseActive() && midFor > 7 && pixelRatio > cruiseFloor()) {
      setPR(Math.max(cruiseFloor(), pixelRatio - 0.25));
      midFor = 0;
      if (history.length < 60) history.push(`− pixels (cruise) @${Math.round(performance.now() / 1000)}s`);
    }
  }
}

export const governorDebug = () => ({
  pixelRatio, slowFor, goodFor, midFor, renderScale,
  grace, calmFor, calm: calmReached,
  casterBudget: getCasterBudget(), slotCap: getSlotCap(),
  emitters: emitterQuality(), grass: getGrassDensity(),
  detailShed: shedDetail, history: [...history],
});
