// xr — the door into the headset, and everything your hands do inside it.
//
// Owns the session and rig, and the hands: stick locomotion only fills xrIntent (the controller does the moving),
// the right-hand ray feeds sgSelect, grip alone grabs a panel by its background or title (never by a control),
// and every radial-menu slot is verb-backed (agent parity). Never navigate mid-session.

import { confirmCenter } from '../edit/confirmcenter.js';
import { outOfMyView } from '../edit/myview.js';
import { installRenderListTolerance, THREE, renderer, camera, scene, XR_BOOT, PREF_HEADSET_SEEN, xrPixelRatio } from '../core.js';
import { decideEntryFailure } from './xr_entry_policy.js';
import { withXREyes } from './xrpass.js';
import { installDualWarm } from './xrwarm.js';
import { makeEntryEffects, handleEntryFailure } from './xr_entry_effects.js';
import { installEntryClock } from './xr_frame_clock.js';
import { CONFIG, report, bus, tee, wornNameOf } from '../base.js';
import { frameDebug } from '../frameloop.js';
import { resetFingers, xrBodyDebug } from './xrbody.js';
import { stroke, fillPath } from '../icons.js';
import { xrPanelsEnter, xrPanelsExit, xrPanelsPick, xrPanelsAt, xrPanelsPress, xrPanelsDrag, xrPanelsReleasePress, showXRPanel, xrPanelHas, xrPanelOpen, xrPanelsGrab, xrPanelRelease, xrPanelsShown, xrPanelsHideToggle, xrPanelsHidden } from './xrpanels.js';
import { TEXT_SEL, domQuadsScroll, domQuadResizeBegin, domQuadResizeMove, domQuadResizeEnd, domQuadsRevealOnly, domQuadMesh } from './domquad.js';
import { myState, xrIntent, camYaw, setCamYaw, setXrProbe } from '../controller.js';
import { ringActionEntries } from '../actionbar.js';
import { entities, bagOf, socketsOn } from '../world.js';
import { xrHand as grabHand, bindPresenting as bindGrabPresenting } from '../thingphysics.js';   // the grabbable component's VR hands
import { flashHint, toast } from '../ui.js';
import { vrMicPreflight } from './vrmic.js';
import { makePointerLine, makeSurfaceDot, placeSurfaceDot, hideSurfaceDot, setSurfaceDotKind } from './pointer.js';
import { markXrAbsent, registerXrGlyph, micGlyph, earGlyph, xrGlyph, micLive, earOn, flipEar } from '../audio/mictoggle.js';
import { setPttHeld } from '../audio/micstate.js';
import { pttMode } from '../audio/voiceconsent.js';
import './xrmicicon.js';   // the mic icon in view while presenting
import { markActive } from '../presence.js';
import { platePick, aimPlate, platePress } from '../platecard.js';   // a laser resting on a nameplate opens its card
import { makeDwell } from '../dwell.js';
import { showXRTip, hideXRTip, dropXRTip, tipTextFor } from './xrtip.js';
import { POINTER_VIS_DEFAULT, pointerVisible, dotVisible, looksAtWorld, interactable, smoothPose, stickStep, angleTo, rayMatrixTo } from './xrpointer.js';   // the laser's policy
import { dockPins } from '../ui.js';
import { xrScales, toRigLocal } from '../../../shared/bodyscale.js';   // the chosen size composes with the device fit (rig = u, body = u/k)
import { perf } from '../perf.js';
import { renderCensusTake, renderCensusTick, renderCensusPeek, setXRCurtain, drawStats } from '../render.js';
import { warm, P_AMBIENT } from '../warmqueue.js';

// ---- self-body in first person: hide your own head and label, keep the body ---------------
let getSelf = () => null;
export const bindXRSelf = (fn) => { getSelf = fn; };
const FP_LAYER = 9, TP_LAYER = 10;
let fpVrm = null;   // which vrm the head-chop is applied to — re-applied after an avatar swap
// head chop (Basis ScaleHeadToZero): the raw head bone scales to ~0 while presenting; three-vrm only copies rotations raw←normalized
const HEAD_CHOP = 0.0001;
let choppedHead = null;   // { bone, scale: Vector3 }
function selfFirstPerson(on) {
  const av = getSelf();
  if (!av?.vrm) return;
  av.hideLabel = !!on;   // the nameplate sits on the root above the chopped head; avatar.js reads this per frame
  const raw = av.vrm.humanoid?.getRawBoneNode?.('head');
  if (on && raw && (fpVrm !== av.vrm || choppedHead?.bone !== raw)) {
    if (choppedHead) choppedHead.bone.scale.copy(choppedHead.scale);   // a swap: restore the old body's head first
    choppedHead = { bone: raw, scale: raw.scale.clone() };
    raw.scale.setScalar(HEAD_CHOP);
    fpVrm = av.vrm;
    tee(`[xr] head chop on (${raw.name}, Basis ScaleHeadToZero)`);
  }
  if (!on && choppedHead) { choppedHead.bone.scale.copy(choppedHead.scale); choppedHead = null; fpVrm = null; tee('[xr] head chop off'); }
}
/** Run fn with the head chop lifted, for a mirror's reflection pass. Restores after. */
export function withHeadShown(fn) {
  if (!choppedHead) return fn();
  const b = choppedHead.bone, kept = b.scale.clone();
  b.scale.copy(choppedHead.scale);
  try { return fn(); } finally { b.scale.copy(kept); }
}
// how many of my meshes the renderer drew this frame (all eyes), for the flight recorder
let selfDrawn = 0, selfDrawnLast = 0, drawHookVrm = null;
function hookSelfDraws() {
  const av = getSelf(); const vrm = av?.vrm; if (!vrm || drawHookVrm === vrm) return;
  vrm.scene.traverse((o) => { if (o.isMesh) { const prev = o.onAfterRender; o.onAfterRender = function (...a) { selfDrawn++; prev?.apply(this, a); }; } });
  drawHookVrm = vrm;
}

const lastGood = new THREE.Vector3();
const rig = new THREE.Group();
export const xrRig = () => rig;   // xrbody.js scales tracked targets about it
export const xrHands = () => hands;   // { left, right }: { grip, ray, … } — xrbody.js reads grip world poses for arm IK
// finger curl surrogate: trigger value → index, grip value → the other three
const fingerCurl = { left: { index: 0, grip: 0 }, right: { index: 0, grip: 0 } };
export const xrFingerCurl = () => fingerCurl;
// curls go through a 1€ filter (Casiez, Roussel & Vogel, CHI 2012): the cutoff rises with the finger's speed, so
// rest is smooth and a squeeze doesn't lag. test/client/finger-curl-test.mjs.
const CURL_MIN_CUTOFF = 2.0;   // Hz: lower = quieter at rest
const CURL_BETA = 3.0;         // how hard the cutoff opens with speed: higher = less lag, more noise
const CURL_D_CUTOFF = 1.0;     // Hz, for the speed estimate itself
const CURL_PROBE = CONFIG.params.has('curlprobe');
const curlProbe = { left: { index: { last: null, peak: 0, sum: 0, n: 0 }, grip: { last: null, peak: 0, sum: 0, n: 0 } },
                    right: { index: { last: null, peak: 0, sum: 0, n: 0 }, grip: { last: null, peak: 0, sum: 0, n: 0 } } };
function curlProbeTake() { const out = {};
  for (const h of ['left', 'right']) for (const k of ['index', 'grip']) { const p = curlProbe[h][k];
    if (p.n) out[`${h[0]}${k[0]}`] = [+p.peak.toFixed(4), +(p.sum / p.n).toFixed(4), p.n];
    p.peak = 0; p.sum = 0; p.n = 0; }
  return out; }
let curlLast = 0;
const curlState = { left: { index: null, grip: null }, right: { index: null, grip: null } };
const oneEuroAlpha = (cutoffHz, dt) => { const te = 1 / (2 * Math.PI * cutoffHz); return 1 / (1 + te / dt); };
function sampleFingerCurl() {
  const now = performance.now();
  const dt = curlLast ? Math.min(0.1, (now - curlLast) / 1000) : 0;   // clamp: a stall must not teleport the pose
  curlLast = now;
  for (const hand of ['left', 'right']) {
    const gp = sourceFor(hand)?.gamepad; const b = gp?.buttons;
    if (!b) continue;
    for (const [key, i] of [['index', 0], ['grip', 1]]) {
      const raw = b[i]?.value ?? (b[i]?.pressed ? 1 : 0);
      if (CURL_PROBE) { const p = curlProbe[hand][key];   // RAW jitter, so tuning is measured not felt
        if (p.last !== null) { const d = Math.abs(raw - p.last); if (d > 0 && d < 0.12) { p.peak = Math.max(p.peak, d); p.sum += d; p.n++; } }
        p.last = raw; }
      let st = curlState[hand][key];
      if (!st || dt <= 0) { curlState[hand][key] = st || { x: raw, dx: 0 }; fingerCurl[hand][key] = st ? st.x : raw; continue; }
      const dRaw = (raw - st.x) / dt;                                  // speed, from the FILTERED previous value
      st.dx += oneEuroAlpha(CURL_D_CUTOFF, dt) * (dRaw - st.dx);       // smooth the speed estimate too
      st.x += oneEuroAlpha(CURL_MIN_CUTOFF + CURL_BETA * Math.abs(st.dx), dt) * (raw - st.x);
      fingerCurl[hand][key] = st.x;
    }
  }

}
rig.name = 'xr-rig';
let presenting = false;
// ?vrprobe=1: one tee line per 5 s while presenting. cpu near 1000/fps = CPU-bound; low fps, small cpu = GPU/compositor
const VRPROBE = CONFIG.params.has('vrprobe');
let vrprobeTimer = null, vrprobeLast = null, vrprobeT0 = 0;
function vrprobeLine() {
  try {
    const sys = frameDebug().filter((x) => x.enabled).map((x) => [x.name, x.ms / (x.every || 1)]);
    const cpu = sys.reduce((a, [, m]) => a + m, 0);
    const top = sys.sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, m]) => `${n}:${m.toFixed(2)}`).join(' ');
    const r = drawStats().render ?? {}; const mem = renderer.info.memory ?? {};
    const heap = performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(0) : 'n/a';
    const cam = renderer.xr.getCamera(); const eyes = (cam.cameras ?? []).map((c) => `x${c.viewport?.x ?? '?'}:${c.viewport?.z ?? '?'}x${c.viewport?.w ?? '?'}`).join('|');   // read BETWEEN frames (under the emulator: 'x0:1280x720|x?:0x720') — split vision would show a real eye with a wrong x or width
    tee(`[vrprobe] t+${((performance.now() - vrprobeT0) / 1000).toFixed(0)}s fps ${perf.fps} worst ${(perf.worst ?? 0).toFixed(1)}ms doubled ${perf.doubled} spikes ${perf.spikes} ` +
        `cpu ${cpu.toFixed(2)}ms of ${(1000 / Math.max(1, perf.fps)).toFixed(1)} | ${top} | draws ${r.drawCalls ?? '?'} passes ${r.passes ?? '?'} tris ${r.triangles ?? '?'} ` +
        `| geo ${mem.geometries ?? '?'} tex ${mem.textures ?? '?'} heap ${heap}MB eyes ${eyes}`);
    const now = { geo: mem.geometries ?? 0, tex: mem.textures ?? 0 };
    if (vrprobeLast && (Math.abs(now.geo - vrprobeLast.geo) >= 5 || Math.abs(now.tex - vrprobeLast.tex) >= 3))
      tee(`[vrprobe] assets geo ${vrprobeLast.geo}→${now.geo} tex ${vrprobeLast.tex}→${now.tex}`);
    vrprobeLast = now;
  } catch (e) { tee(`[vrprobe] failed: ${e?.message ?? e}`); }
}
// the desktop half: a heartbeat every 10 s, and a frame counter stuck for 3 s tees a STALL line
if (VRPROBE) {
  let f0 = -1, still = 0, hb = 0, stalled = false;
  setInterval(() => {
    const f = perf.frameNo ?? -1;
    if (f === f0) { still++; if (still === 3 && !stalled) { stalled = true;
      tee(`[vrprobe] desktop loop STALLED at frame ${f}: vis=${document.visibilityState} focus=${document.hasFocus()} presenting=${renderer.xr.isPresenting} ` +
          `xrSession=${!!renderer.xr.getSession?.()} rafNative=${/native code/.test(String(window.requestAnimationFrame))} heap=${performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(0) + 'MB' : 'n/a'}`); } }
    else { if (stalled) tee(`[vrprobe] desktop loop RESUMED at frame ${f} after ${still} s`); still = 0; stalled = false; }
    f0 = f;
    if (++hb % 10 === 0 && !presenting) tee(`[vrprobe] desktop hb frame ${f} fps ${perf.fps} worst ${(perf.worst ?? 0).toFixed(0)}ms spikes ${perf.spikes}`);
  }, 1000);
}
function vrprobe(on) {
  if (!VRPROBE) return;
  clearInterval(vrprobeTimer); vrprobeTimer = null;
  if (on) { vrprobeT0 = performance.now(); vrprobeLast = null; vrprobeTimer = setInterval(vrprobeLine, 5000); tee('[vrprobe] armed (5 s)'); }
  else { vrprobeLine(); tee('[vrprobe] disarmed (session ended)'); }
}
let nativeRAF = null, nativeCAF = null;   // window.rAF/cAF saved while the in-session shim is installed
let sessionEnded = false;
let frameClock = null;   // the owned clock takeover for the live session
let exitVeil = null;
let floorSpace = null;              // 'local-floor' | 'bounded-floor' | null (fell back to 'local')

// ---- device scale (Basis BasisHeightDriver: the avatar is scaled to the player)
// k = avatarEyeY / median of the first 120 HMD heights (> 0.5 m), clamped .6–1.6, saved per avatar. The puppet is
// scaled (vrm.scene.scale = 1/k), never the tracking, so hands sit on the controllers. Restored on session end.
const SCALE_LS = 'ew-xr-scale';
let wornName = '';   // the per-body key for a saved scale
const scaleState = { k: 1, source: 'fallback', samples: [], eyeY: null, locked: false, firstAt: 0 };
// a body swap while presenting re-measures: the new body must not wear the old body's ratio
bus.on('avatar-worn', (v) => { wornName = wornNameOf(v); if (!presenting) return; scaleState.samples.length = 0; scaleState.locked = false; scaleState.firstAt = 0; scaleState.k = 1; scaleState.source = 'fallback'; loadSavedScale(); tee('[xr] body swapped while presenting — device scale re-measured'); });
const xrScale = () => ({ ...scaleState, samples: scaleState.samples.length });
/** The multiplier the self puppet wears while presenting (Basis: avatar scaled to the player). 1 when unmeasured. */
export const puppetScale = () => (presenting && scaleState.k > 0 ? 1 / scaleState.k : 1);
// harness hook (?xrsim only): feed HMD heights without waiting on a slow headless frame rate
export const xrSimSample = (y) => { if (CONFIG.params.has('xrsim')) sampleDeviceScale(y); };
function avatarEyeY() {
  const av = getSelf(); const h = av?.vrm?.humanoid;
  if (!h) return null;
  const root = av.vrm.scene.getWorldPosition(new THREE.Vector3()).y;
  const ps = av.vrm.scene.scale.y || 1;   // authored height: undo any puppet scale the body already wears
  const eye = h.getNormalizedBoneNode?.('leftEye') ?? h.getNormalizedBoneNode?.('rightEye');
  if (eye) return (eye.getWorldPosition(new THREE.Vector3()).y - root) / ps;
  const head = h.getNormalizedBoneNode?.('head');
  return head ? (head.getWorldPosition(new THREE.Vector3()).y - root) / ps + 0.06 : null;   // eyes ≈ 6 cm above the head joint
}
function loadSavedScale() {
  if (!wornName) return;   // no body yet: never a '' key
  try { const all = JSON.parse(localStorage.getItem(SCALE_LS) || '{}'); const name = wornName;
    const v = all[name]; if (v && v.k > 0.5 && v.k < 1.7) { scaleState.k = v.k; scaleState.source = 'saved'; scaleState.eyeY = v.eyeY ?? null; } } catch {}
}
function saveScale() {
  if (!wornName) return;
  try { const all = JSON.parse(localStorage.getItem(SCALE_LS) || '{}'); const name = wornName;
    all[name] = { k: scaleState.k, eyeY: scaleState.eyeY, t: Date.now() }; localStorage.setItem(SCALE_LS, JSON.stringify(all)); } catch {}
}
function sampleDeviceScale(hmdY) {
  if (scaleState.locked) return;
  if (hmdY > 0.5) { if (!scaleState.samples.length) scaleState.firstAt = performance.now(); scaleState.samples.push(hmdY); }
  // lock at 120 samples, or after 3 s with at least 30: a slow frame rate must not postpone it forever
  const n = scaleState.samples.length;
  if (n < 120 && !(n >= 30 && performance.now() - scaleState.firstAt >= 3000)) return;
  const s = [...scaleState.samples].sort((a, b) => a - b); const med = s[s.length >> 1];
  const eye = avatarEyeY();
  scaleState.locked = true;
  if (!eye || med < 0.5) { tee(`[xr] scale not measured (eye=${eye?.toFixed?.(2)} med=${med.toFixed(2)}) — keeping ${scaleState.source} ${scaleState.k.toFixed(2)}`); return; }
  scaleState.k = Math.min(1.6, Math.max(0.6, eye / med)); scaleState.source = 'measured'; scaleState.eyeY = eye;
  saveScale();
  tee(`[xr] scale=${scaleState.k.toFixed(3)} (measured: avatar eye ${eye.toFixed(2)} m / your eye ${med.toFixed(2)} m, ${s.length} samples)`);
  bus.emit('xr:scale', xrScale());
}
let session = null;
export const isPresenting = () => presenting;

// ---- VR preferences (Settings › VR, vrpanel.js), persisted per browser
const PREF_XR = 'ew-xr-prefs';
const XR_PREF_DEFAULTS = { turn: 'smooth', vignette: false, mirror: 'first', seated: false, res: 'auto', pointerVisibility: POINTER_VIS_DEFAULT, dotVisibility: POINTER_VIS_DEFAULT };
export const xrPrefs = (() => { try { return { ...XR_PREF_DEFAULTS, ...JSON.parse(localStorage.getItem(PREF_XR) || '{}') }; } catch { return { ...XR_PREF_DEFAULTS }; } })();
{ const m = CONFIG.params.get('mirror'); if (m === 'off' || m === 'first' || m === 'third') xrPrefs.mirror = m; }   // URL override for A/B
// eye resolution as WebXR framebufferScaleFactor ('auto' = 1.0), read once at session start; ?xrres=0.2..1 overrides
export const XR_RES_SCALES = { auto: 1, 85: 0.85, 70: 0.7, 50: 0.5 };
function xrResScale() {
  const q = +CONFIG.params.get('xrres');
  if (q >= 0.2 && q <= 1) return q;
  return XR_RES_SCALES[xrPrefs.res] ?? 1;
}
export function setXrPref(k, v) { xrPrefs[k] = v; try { localStorage.setItem(PREF_XR, JSON.stringify(xrPrefs)); } catch {} bus.emit('xr:prefs', xrPrefs); }
const DEADZONE = 0.18;
const SNAP_DEG = 30;
const SMOOTH_TURN_RAD_S = 2.2;   // ~126°/s at full deflection
const snapState = { cooling: false };
const dead = (v, dz = DEADZONE) => {
  if (!Number.isFinite(v)) return 0;   // a NaN axis (a controller waking) must read as centred, not poison the walk
  const m = Math.abs(v);
  return m < dz ? 0 : Math.sign(v) * ((m - dz) / (1 - dz));
};
const pickAxis = (a, b) => (typeof a === 'number' && a !== 0 ? a : (b ?? 0));

// ---- controllers -----------------------------------------------------------
const hands = { left: null, right: null };   // {grip, ray, laser, …} by handedness
// three's controller slots 0/1 are enumeration order, not left/right: each files itself on 'connected'; until then a guess
const slots = [null, null];
function fileHand(slotIdx, handedness) {
  const h = slots[slotIdx]; if (!h) return;
  if (handedness !== 'left' && handedness !== 'right') return;
  for (const k of ['left', 'right']) if (hands[k] === h && k !== handedness) hands[k] = null;
  hands[handedness] = h;
  tee(`[xr] slot ${slotIdx} is the ${handedness} hand`);
}
const _v = new THREE.Vector3(); const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion(); const _m = new THREE.Matrix4();

function makeHand(i) {
  const grip = renderer.xr.getControllerGrip(i);
  const ray = renderer.xr.getController(i);
  grip.addEventListener('connected', (e) => { tee(`[xr] slot ${i} grip connected handedness=${e.data?.handedness} profiles=${JSON.stringify(e.data?.profiles ?? [])}`); fileHand(i, e.data?.handedness); });
  ray.addEventListener('connected', (e) => fileHand(i, e.data?.handedness));
  // visible hand: a knuckle-box only until a body owns the hands; the tick hides it then
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.035, 0.09),
    new THREE.MeshStandardMaterial({ color: 0xe8c9a0, roughness: 0.8 }));
  grip.add(box);
  // the beam lives in world space along the smoothed pick ray (placeLaser): under the rig its length would scale with the body size
  const laser = makePointerLine();
  laser.visible = false;
  const aim = new THREE.Object3D(); aim.name = 'xr-aim';   // the target ray low-passed in rig space (xrpointer.js)
  // the surface dot (pointer.js), parked under the rig so the hands' warm compiles it; first placement moves it to the scene
  const dot = makeSurfaceDot();
  rig.add(grip); rig.add(ray); rig.add(aim); rig.add(dot);
  return { grip, ray, aim, smooth: { init: false }, laser, dot, box };
}
const _dotP = new THREE.Vector3(), _dotN = new THREE.Vector3(), _dotO = new THREE.Vector3(), _dotD = new THREE.Vector3(), _eyeP = new THREE.Vector3();
/** What a press would do on this target — the dot's icon (pointer.js DOT_KINDS). */
const RESIZE_KIND = { 'resize-e': 'resize-ew', 'resize-w': 'resize-ew', 'resize-s': 'resize-ns', 'resize-nw': 'resize-nwse', 'resize-se': 'resize-nwse', 'resize-ne': 'resize-nesw', 'resize-sw': 'resize-nesw' };
export function targetKind({ panel = null, plateDist = null, hit = null } = {}) {
  if (panel) {
    if (panel.control) return typeof panel.control !== 'string' && panel.control.matches?.(TEXT_SEL) ? 'type' : 'click';
    if (RESIZE_KIND[panel.zone]) return RESIZE_KIND[panel.zone];
    return panel.zone === 'move' || !panel.scroll ? 'move' : 'scroll';
  }
  if (plateDist != null) return 'dot';   // a nameplate: resting there is the action
  return hit?.interactable ? 'click' : 'dot';
}
/** The dot on the hand's target (a panel hit, a plate at `plateDist` along the ray, an entity hit), or hidden. Plates
 *  are camera-facing sprites: the dot faces the eye there. */
function placeDot(hand, ray, eye, { panel = null, plateDist = null, hit = null } = {}) {
  const dot = hand.dot;
  if (!panel && plateDist == null && !hit) { hideSurfaceDot(dot); return; }
  setSurfaceDotKind(dot, targetKind({ panel, plateDist, hit }));
  if (dot.parent !== scene) scene.add(dot);
  _eyeP.setFromMatrixPosition(eye.matrixWorld);
  if (panel) placeSurfaceDot(dot, panel.point, panel.normal, _eyeP);
  else if (plateDist != null) {
    _dotO.setFromMatrixPosition(ray.matrixWorld); _dotD.set(0, 0, -1).transformDirection(ray.matrixWorld);
    _dotP.copy(_dotO).addScaledVector(_dotD, plateDist);
    placeSurfaceDot(dot, _dotP, _dotN.subVectors(_eyeP, _dotP), _eyeP);
  } else placeSurfaceDot(dot, hit.point, hit.normal ?? _dotN.set(0, 0, 0), _eyeP);
}
const _lp = new THREE.Vector3(), _ls = new THREE.Vector3();
/** The beam along a pick ray (a world matrix, −Z forward), `len` metres long. */
function placeLaser(laser, m, len) {
  if (laser.parent !== scene) scene.add(laser);
  m.decompose(_lp, laser.quaternion, _ls); laser.position.copy(_lp);
  laser.scale.set(1, 1, len);
}
/** This frame's aim for a hand: the raw target ray, low-passed (xrpointer.smoothPose). Returns the aim object. */
function steerAim(hand, dtSec) {
  smoothPose(hand.aim, hand.ray, dtSec, hand.smooth);
  hand.aim.updateMatrixWorld(true);
  return hand.aim;
}

/** A no-op on pads without actuators. Touch = light tick, take = firmer. */
export function haptic(hand, val = 0.4, ms = 24) {
  try {
    if (!session) return;
    for (const src of session.inputSources)
      if (src.handedness === hand) src.gamepad?.hapticActuators?.[0]?.pulse(val, ms);
  } catch { /* never let feedback break the frame */ }
}

function sourceFor(hand) {
  if (!session) return null;
  for (const src of session.inputSources) if (src.handedness === hand) return src;
  return null;
}

// ---- pointer: right-hand ray → entity, trigger selects ---------------------
const _rc = new THREE.Raycaster();
function rayHitEntity(handRay, far = 24) {
  _m.identity().extractRotation(handRay.matrixWorld);
  _rc.ray.origin.setFromMatrixPosition(handRay.matrixWorld);
  _rc.ray.direction.set(0, 0, -1).applyMatrix4(_m);
  _rc.far = far;
  const roots = [...entities.values()].filter(Boolean);
  const hit = _rc.intersectObjects(roots, true).find((h) => !outOfMyView(h.object));   // what isn't drawn for me isn't pointed at
  let n = hit?.object;
  while (n && !n.userData.entityId) n = n.parent;
  const normal = hit?.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;   // for the surface dot
  return n ? { id: n.userData.entityId, dist: hit.distance, point: hit.point, normal, interactable: interactable(bagOf(n.userData.entityId), socketsOn(n.userData.entityId).length) } : null;
}


// ---- stickiness (xrpointer.js) -----------------------------------------------------------------------------------
// per hand, the held target as a point local to its thing; no bending during a press or while this hand holds a panel
const sticky = { left: null, right: null };   // {kind: 'panel'|'plate', key, obj, local: Vector3}
const pickState = { left: { bent: false, kind: null }, right: { bent: false, kind: null } };   // probe window
const dwells = { left: makeDwell(), right: makeDwell() };
const entSeen = { left: null, right: null };   // probe window: the entity under each laser, {id, interactable}
const bentRay = { left: { matrixWorld: new THREE.Matrix4() }, right: { matrixWorld: new THREE.Matrix4() } };
const _sp = new THREE.Vector3(), _so = new THREE.Vector3(), _sd = new THREE.Vector3();
const stickAlive = (h) => !!h.obj?.parent && h.obj.visible && (h.obj.material?.opacity ?? 1) >= 0.1 && !h.obj.userData?.occluded
  && (typeof h.key === 'string' || h.key?.isConnected !== false);
/** What a ray is on: the panel (claims first; {dist, point, normal, mesh, control}) or a plate ({id, dist, obj}) that
 *  nothing in the world stands in front of — the beam stops at the first thing. */
function rayTargets(ray, eye) {
  const panel = xrPanelsAt(ray);
  const seen = panel == null ? platePick(ray, eye) : null;
  return { panel, plate: seen && !rayHitEntity(ray, seen.dist) ? seen : null };
}
function stickTo(side, aim, eye, hold) {
  const raw = rayTargets(aim, eye);
  const o = _so.setFromMatrixPosition(aim.matrixWorld), dir = _sd.set(0, 0, -1).transformDirection(aim.matrixWorld);
  let now = null;
  if (raw.panel?.control) now = { kind: 'panel', key: raw.panel.control, obj: raw.panel.mesh, point: raw.panel.point };
  else if (raw.plate?.obj) now = { kind: 'plate', key: `plate:${raw.plate.id}`, obj: raw.plate.obj, point: o.clone().addScaledVector(dir, raw.plate.dist) };
  const keep = (t) => t && { kind: t.kind, key: t.key, obj: t.obj, local: t.obj.worldToLocal(t.point.clone()) };
  const ps = pickState[side];
  if (!hold) { sticky[side] = keep(now); ps.bent = false; ps.kind = now?.kind ?? null; return { ray: aim, ...raw }; }
  const held = sticky[side];
  const angle = held && stickAlive(held) ? angleTo(o, dir, held.obj.localToWorld(_sp.copy(held.local))) : NaN;
  const step = stickStep(held, now, angle);
  sticky[side] = step.held === now ? keep(now) : step.held;
  ps.bent = step.bend; ps.kind = sticky[side]?.kind ?? null;
  if (!step.bend) return { ray: aim, ...raw };
  const ray = bentRay[side]; rayMatrixTo(ray.matrixWorld, o, _sp);   // _sp: the held point, world
  return { ray, ...rayTargets(ray, eye) };
}

// ---- panel grab: grip takes a quad to reposition it (over a control it does nothing). Panels are UI: no verb, no undo.
let held = null;   // {quad, hand}
let resizing = null;   // a grip on a panel's corner or edge: {hand, drag} (domquad.js does the geometry)
function tryGrab(hand, ray) {
  const h = hands[hand];
  const at = xrPanelsAt(ray);
  if (at?.control) { tee(`[xr] grip on a control of the ${at.id} panel: not grabbed (grab it by its background or title)`); return; }
  if (at?.zone?.startsWith('resize-')) {   // a corner or an edge: the grip resizes
    const drag = domQuadResizeBegin(at);
    if (drag) { resizing = { hand, drag }; haptic(hand, 0.4, 30); }
    return;
  }
  const q = xrPanelsGrab(ray);   // refuses a control too, for any other caller
  if (!q) return;
  held = { quad: q, hand }; haptic(hand, 0.4, 30); h.grip.attach(q.mesh); flashHint(`holding the ${q.id} panel — trigger + stick to push or pull it, release grip to place it`);
}
// push / pull: holding hand + trigger, stick forward/back moves the panel along the laser, clamped
const PUSH_RATE = 1.6;              // 1/s at full deflection: ≈5× farther per second
const PUSH_MIN_M = 0.25, PUSH_MAX_M = 3.0;
const _pp = new THREE.Vector3(), _po = new THREE.Vector3(), _pd = new THREE.Vector3();
function pushPull(hand, aim, stickY, dt) {
  const d = dead(stickY); if (!d || !held) return;
  const mesh = held.quad.mesh;
  _po.setFromMatrixPosition(aim.matrixWorld); _pd.set(0, 0, -1).transformDirection(aim.matrixWorld);
  mesh.getWorldPosition(_pp);
  const along = _pp.sub(_po).dot(_pd);                                     // the panel's distance out along the laser
  const want = THREE.MathUtils.clamp(along * Math.exp(PUSH_RATE * d * dt), PUSH_MIN_M, PUSH_MAX_M);
  if (Math.abs(want - along) < 1e-5) return;
  mesh.getWorldPosition(_pp).addScaledVector(_pd, want - along);           // slide along the laser only
  mesh.parent.updateMatrixWorld(true); mesh.position.copy(mesh.parent.worldToLocal(_pp));
}
function endResize() {
  if (!resizing) return;
  const r = domQuadResizeEnd(resizing.drag, rig);
  if (r) tee(`[xr] panel ${resizing.drag.q.id} resized to ${Math.round(r.w)}×${Math.round(r.h)} px`);
  resizing = null;
}
function releaseGrab() {
  if (!held) return;
  const p = xrPanelRelease(held.quad, rig);
  tee(`[xr] panel ${held.quad.id} placed at rig ${p.pos.join(',')} yaw ${p.yaw} pitch ${p.pitch}`);
  held = null;
}

// ---- radial menu: right-stick click opens, stick aims, trigger / flick / quick release commits -----
/** The ring is the dock, radially: same pins and order, rebuilt per open. A frame with no VR surface is a dim slot. */
let ringLevel = 'root';   // 'root' | 'actions' — the sub-wheel in view
const SPACER = { spacer: true, has: false, label: '', on: () => false, act: () => {} };
const BACK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 26 26" fill="none" stroke="#f2f7f5" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-7 7 7 7"/></svg>';
// The wheel: 12 o'clock = panels menu, 6 = leave VR, pins on the right, mic/headphones/recentre left, a spacer
// keeps the count even. 'actions' is a sub-wheel with back at 6. Toggles stay open; the rest close on activation.
export function radialEntries() {   // exported with makeRadial for the headless ring screenshot
  if (ringLevel === 'actions') {
    const e = ringActionEntries();                    // postures + gestures, bar order, 12 o'clock first
    const back = { svg: BACK_SVG, label: 'back', on: () => false, sub: 'root', act: () => {} };
    const half = Math.ceil(e.length / 2);
    const out = [...e.slice(0, half), back, ...e.slice(half)];
    if (out.length % 2) out.push(SPACER);
    return out;
  }
  const panels = { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 26 26"><text x="13" y="19.5" font-family="system-ui, sans-serif" font-size="19" font-weight="700" text-anchor="middle" fill="#f2f7f5">∃</text></svg>', label: 'panels', on: () => xrPanelsShown(), act: ringPanelsAct };
  const leave = { svg: xrGlyph(52), label: 'leave VR', on: () => true, close: true, guard: true, act: () => leaveVR('ring') };   // guard: trigger only, so a stick brush toward 6 o'clock can't throw you out
  // gestures is its own strip on the desk, not a dock panel — a fixed slot, first on the right (1 o'clock)
  const right = [{ icon: 'hand-waving', label: 'actions', sub: 'actions', on: () => false, act: () => {} }];
  for (const e of dockPins()) {
    if (e.id === 'actions') continue;   // the sub-wheel slot above IS gestures
    const has = xrPanelHas(e.id);
    right.push({ icon: e.icon, label: e.id, has, on: () => xrPanelOpen(e.id), close: true,
      act: () => { if (has) showXRPanel(e.id); else tee(`[xr] ring: ${e.id} has no VR surface yet`); } });
  }
  const left = [
    { svg: RECENTRE_SVG, label: 'recentre', on: () => false, close: true, act: () => recentreXR('ring') },
    { svg: () => earGlyph(52), label: 'headphones', on: earOn, act: () => flipEar() },   // svg as a FUNCTION: the slash follows the live state on every repaint
    { svg: () => micGlyph(52), label: 'mic', on: micLive, act: () => bus.emit('xr:mic') },
  ];
  // balance: the same count each side (move dock pins over, then pad) so 'leave' lands on 6 o'clock
  while (right.length > left.length + 1) left.unshift(right.pop());
  while (right.length < left.length) right.push(SPACER);
  if (right.length > left.length) left.unshift(SPACER);
  return [panels, ...right, leave, ...left];   // clockwise from the top: right side descends 1→5, left ascends 7→11
}
const RECENTRE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 26 26" fill="none" stroke="#f2f7f5" stroke-width="1.6" stroke-linecap="round"><circle cx="13" cy="13" r="7"/><circle cx="13" cy="13" r="1.6" fill="#f2f7f5"/><path d="M13 2v4M13 20v4M2 13h4M20 13h4"/></svg>';
// The ring rides the right grip over the thumb, billboarded to the eyes; icons drawn over the world, focus scales
// 1.4× with a label pill. Ink from the page's tokens.
const RING_R = 0.075, RING_ICON = 0.05, RING_ANCHOR = { x: 0, y: 0.05, z: 0.01 };
const INK = { brand: '#8fe8c8', fg: '#ebebe9', dim: 'rgba(235,235,233,.42)', panel: 'rgb(5, 20, 20)', rule: 'rgba(143,232,200,.45)' };
let radial = null;   // {group, slots[], entries[], sel, label:{mesh,cv,tx}}
function ringIconTexture(s, focused) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const g = cv.getContext('2d'); const tex = new THREE.CanvasTexture(cv); tex.anisotropy = 4;
  // a panel disc so glyphs read against any world; brand ring when focused/on
  g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.fillStyle = INK.panel; g.fill();
  g.lineWidth = focused ? 6 : 3; g.strokeStyle = focused ? INK.brand : INK.rule; g.stroke();
  const on = !!s.on?.();
  const ink = s.has === false ? INK.dim : (focused || on ? INK.brand : INK.fg);
  g.save(); g.translate(64, 64); g.fillStyle = ink; g.strokeStyle = ink;
  // drawn glyphs, never fillText(emoji) (icons.js); SVGs load via an Image, so the texture updates async
  if (s.svg) {
    const img = new Image();
    img.onload = () => { g.save(); g.translate(64, 64); g.drawImage(img, -30, -30, 60, 60); g.restore(); tex.needsUpdate = true; };
    // an <svg> without xmlns paints nothing as an <img> data-URI
    let svg = (typeof s.svg === 'function' ? s.svg() : s.svg).replace(/stroke="#f2f7f5"/g, `stroke="${ink}"`).replace(/fill="#f2f7f5"/g, `fill="${ink}"`);
    if (!/xmlns=/.test(svg)) svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  } else if (!fillPath(g, s.icon, 60, (focused || on) ? 'fill' : 'line')) stroke(g, s.icon, 60);
  g.restore();
  return tex;
}
function ringLabel() {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64;
  const tx = new THREE.CanvasTexture(cv); tx.anisotropy = 4;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.11, 0.0275), new THREE.MeshBasicMaterial({ map: tx, transparent: true, depthTest: false }));
  mesh.renderOrder = 1000; mesh.visible = false;
  return { mesh, cv, tx };
}
function setRingLabel(text) {
  const l = radial?.label; if (!l) return;
  const g = l.cv.getContext('2d'); g.clearRect(0, 0, 256, 64);
  if (text) {
    g.fillStyle = INK.panel; g.beginPath(); g.roundRect(28, 10, 200, 44, 14); g.fill();
    g.strokeStyle = INK.rule; g.lineWidth = 2; g.stroke();
    g.font = '600 28px ui-monospace, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = INK.fg; g.fillText(text, 128, 33);
  }
  l.mesh.visible = !!text; l.tx.needsUpdate = true;
}
export function makeRadial(entries) {   // exported for the headless ring screenshot (smoke) — the ring is plain meshes
  const group = new THREE.Group();
  const N = Math.max(1, entries.length);
  // the radius grows with the count so discs never overlap, and every slot has a stable renderOrder (equal orders flicker)
  const R = Math.max(RING_R, (N * RING_ICON * 1.15) / (2 * Math.PI));
  const slots = entries.map((s, i) => {
    const a = -Math.PI / 2 + i * (2 * Math.PI / N);   // -π/2 first (top), then clockwise, placed at (cos a, −sin a)
    const m = new THREE.Mesh(new THREE.PlaneGeometry(RING_ICON, RING_ICON), new THREE.MeshBasicMaterial({ map: ringIconTexture(s, false), transparent: true, depthTest: false }));
    m.renderOrder = 1000 + i; m.userData.order = 1000 + i; m.position.set(Math.cos(a) * R, -Math.sin(a) * R, 0); m.userData.ring = a;
    if (s.spacer) m.visible = false;   // the balance spacer keeps the verticals true but must not read as a broken icon
    group.add(m); return m;
  });
  // the focus label sits in the ring's empty centre and draws AFTER every slot, never under an icon
  const label = ringLabel(); label.mesh.position.set(0, 0, 0.001); label.mesh.renderOrder = 1001 + N; group.add(label.mesh);
  return { group, slots, entries, sel: -1, label };
}
function disposeRadial() {
  if (!radial) return;
  for (const m of radial.slots) { m.material.map?.dispose(); m.material.dispose(); m.geometry.dispose(); }
  radial.label.mesh.material.map?.dispose(); radial.label.mesh.material.dispose();
  radial.group.parent?.remove(radial.group); radial = null;
}
function openRadial() {
  ringLevel = 'root';
  disposeRadial();                       // rebuilt every open: the rail is the source of truth and it changes
  radial = makeRadial(radialEntries());
  if (!hands.right?.grip) return;   // a right-stick click before the grip is filed
  hands.right.grip.add(radial.group);
  radial.group.position.set(RING_ANCHOR.x, RING_ANCHOR.y, RING_ANCHOR.z);
  radial.group.quaternion.identity();
  tickRadial();
}
const ring = { openedAt: 0, lastInput: 0, leftCentreAt: 0, peak: 0, actedAt: 0, trigWas: false };
function closeRing(cause) { const sel = radial?.sel ?? -1; const label = sel >= 0 ? radial?.entries?.[sel]?.label : null; closeRadial(false); tee(`[xr] ring close (${cause})${label ? ` latched=${label}` : ''}`); }
function activateRing(cause) {
  if (!radial || radial.sel < 0) return;
  const nowMs = performance.now();
  if (nowMs - ring.actedAt < 250) return;          // one activation per gesture
  const e = radial.entries[radial.sel];
  if (e.guard && cause !== 'trigger') { tee(`[xr] ring: ${e.label} needs the trigger (${cause} ignored)`); return; }
  ring.actedAt = nowMs;
  tee(`[xr] ring act → ${e.label} (${cause})`);
  haptic('right', 0.3, 20);
  try { e.act(); } catch (err) { tee(`[xr] ring act failed: ${err?.message ?? err}`); }
  if (!radialOpen || !radial) return;              // the act may have closed it (leave VR)
  if (e.sub && hands.right?.grip) { ringLevel = e.sub; const sel = radial.sel; disposeRadial(); radial = makeRadial(radialEntries()); hands.right.grip.add(radial.group); radial.group.position.set(RING_ANCHOR.x, RING_ANCHOR.y, RING_ANCHOR.z); tickRadial(); tee(`[xr] ring → ${e.sub}`); return; }
  if (e.close) { closeRing('act'); return; }
  repaintRing();                                    // a toggle: show its new state, stay open
}
function repaintRing() {
  if (!radial) return;
  radial.slots.forEach((m, i) => { m.material.map?.dispose(); m.material.map = ringIconTexture(radial.entries[i], i === radial.sel); m.material.needsUpdate = true; });
}
function closeRadial(commit) {
  ringLevel = 'root';
  if (!radial) { radialOpen = false; return; }
  const act = commit && radial.sel >= 0 ? radial.entries[radial.sel]?.act : null;
  disposeRadial(); radialOpen = false;
  if (act) act();
}
const _rc1 = new THREE.Vector3(), _rc2 = new THREE.Vector3(), _rq1 = new THREE.Quaternion(), _rq2 = new THREE.Quaternion(), _rm = new THREE.Matrix4();
/** per frame while open: top-up billboard to the eyes, de-rolled from the grip */
function tickRadial() {
  if (!radial) return;
  const grip = hands.right?.grip; if (!grip) return;
  if (radial.group.parent !== grip) { grip.add(radial.group); radial.group.position.set(RING_ANCHOR.x, RING_ANCHOR.y, RING_ANCHOR.z); }
  const xc = renderer.xr.getCamera();
  _rc1.setFromMatrixPosition(xc.matrixWorld);                       // the eyes
  radial.group.getWorldPosition(_rc2);
  _rq1.setFromRotationMatrix(xc.matrixWorld);
  const headUp = _v2.set(0, 1, 0).applyQuaternion(_rq1);
  _rm.lookAt(_rc1, _rc2, headUp); _rq1.setFromRotationMatrix(_rm);   // eye=camera, target=group: the known-good order
  grip.getWorldQuaternion(_rq2).invert();
  radial.group.quaternion.copy(_rq2.multiply(_rq1));
}
function aimRadial(x, y) {
  if (!radial) return;
  const mag = Math.hypot(x, y);
  let best = -1;
  if (mag > 0.5) {
    // stick angle atan2(y, x) against each slot's ring angle (gamepad y is inverted, matching the −sin placement)
    const a = Math.atan2(y, x); let bd = 9;
    radial.slots.forEach((m, i) => { if (radial.entries[i].spacer) return; const d = Math.abs(Math.atan2(Math.sin(a - m.userData.ring), Math.cos(a - m.userData.ring))); if (d < bd) { bd = d; best = i; } });
  } else if (mag >= 0.35) best = radial.sel;   // hysteresis band: keep the selection, don't commit yet
  if (best !== radial.sel) {
    radial.slots.forEach((m, i) => { const foc = i === best; m.scale.setScalar(foc ? 1.4 : 1); m.renderOrder = foc ? 1000 + radial.slots.length + 1 : m.userData.order; m.material.map?.dispose(); m.material.map = ringIconTexture(radial.entries[i], foc); m.material.needsUpdate = true; });
    radial.sel = best;
    setRingLabel(best >= 0 ? radial.entries[best].label : null);
    if (best >= 0) haptic('right', 0.15, 10);
  }
}
let radialOpen = false, stickPressWas = false, menuBtnWas = false, muteBtnWas = false, pttFromX = false;
const triggerWas = { left: false, right: false }, gripWas = { left: false, right: false };
const panelPress = { left: null, right: null };   // a trigger press on a panel, pending drag-or-click
// buttons are not trusted for 700 ms after an input source appears (first frames report pressed=true garbage)
let inputsSettledAt = 0;
const buttonsTrusted = () => performance.now() > inputsSettledAt;

// ---- session ---------------------------------------------------------------
let sessionNo = 0;   // per page; every entry tee line carries it (tee() folds byte-identical lines)
const ringPanelsAct = () => { bus.emit('xr:panels'); tee('[xr] panels toggled (ring)'); };
globalThis.__xrRingPanels = ringPanelsAct;   // harness: the ring's 'panels' slot
let entering = false;   // requestSession → setSession is ~1–3 s; enter and leave are refused while in flight
// the busy-session retry belongs to the intent that scheduled it (xr_entry_effects.js); a later click or a leave cancels it
const entryEffects = makeEntryEffects({
  setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t),
  tee: (m) => tee(m), toast: (m, kind, ms) => toast(m, kind, ms),
  enter: (o) => enterVR(o), markAbsent: (v) => markXrAbsent(v),
});
let entryNo = 0;           // per entry intent, not per request: a retry inherits its parent's
const cancelBusyRetry = (why) => entryEffects.cancel(why);
async function enterVR({ retryOf = null } = {}) {
  if (entering) { tee(`[xr] enter refused: a session request is already in flight`); return; }
  if (session && presenting) { tee(`[xr] enter refused: already presenting`); return; }
  // a fresh click is a new intent with a fresh retry budget; a retry carries its parent's number
  const myEntry = retryOf ?? ++entryNo;
  if (retryOf === null) cancelBusyRetry('a new entry intent');
  entering = true;
  xrVeilShow(true, 'entering VR');   // from the click: requestSession + setSession is 1–3 s of nothing otherwise
  toast('entering VR…', 'info', 6000);
  try {
    // let the veil paint first: two frames (capped, as rAF stops in a hidden tab)
    await Promise.race([new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), new Promise((r) => setTimeout(r, 250))]);
    // on a WebGPU backend the 'webgpu' session feature is required; a browser that can't grant it reloads onto WebGL (?webgl=1)
    const gpu = !!renderer.backend?.isWebGPUBackend;
    sessionNo++;
    tee(`[xr] enter #${sessionNo}: requesting session (${gpu ? 'WebGPU' : 'WebGL'}; renderer.xr.enabled=${renderer.xr.enabled}; presenting=${renderer.xr.isPresenting})`);
    const optionalFeatures = ['local-floor', 'bounded-floor', 'hand-tracking'];
    try {
      installRenderListTolerance();   // only now that a session is about to exist
      session = await navigator.xr.requestSession('immersive-vr',
        gpu ? { requiredFeatures: ['webgpu'], optionalFeatures } : { optionalFeatures });
    } catch (e) {
      // handleEntryFailure (xr_entry_effects.js) is the tested seam: nothing here may bypass it
      const next = handleEntryFailure({ effects: entryEffects, decide: decideEntryFailure,
                                        error: e, intent: myEntry, retryOf, gpu });
      if (next === 'handled') return;
      if (next === 'throw') throw e;   // the outer catch posts the one toast
      // 'reload': the effect already teed and toasted; only the navigation lives here
      const u = new URL(location.href); u.searchParams.set('webgl', '1'); u.searchParams.set('xr', '1'); u.searchParams.set('why', 'vr-webgl');
      setTimeout(() => { location.href = u; }, 1200);
      return;
    }
    try { localStorage.setItem(PREF_HEADSET_SEEN, String(Date.now())); } catch {}   // a real session, not a capability answer; the time, so it expires
    tee(`[xr] enter #${sessionNo}: session granted (${session.enabledFeatures?.length ?? '?'} features)`); markXrAbsent(false);
    renderer.xr.enabled = true;
    // the floor reference space (three defaults to 'local', eye-level); before setSession
    const feats = session.enabledFeatures ?? [];
    const floor = feats.includes('local-floor') ? 'local-floor' : feats.includes('bounded-floor') ? 'bounded-floor' : null;
    try { renderer.xr.setReferenceSpaceType(floor ?? 'local'); } catch (e) { report('xr ref space', e); }
    try { renderer.xr.setFramebufferScaleFactor(xrResScale()); } catch (e) { report('xr res scale', e); }   // also before setSession
    floorSpace = floor;
    scaleState.samples.length = 0; scaleState.locked = false; scaleState.firstAt = 0; scaleState.k = 1; scaleState.source = 'fallback'; loadSavedScale();
    bus.emit('xr:loop');   // frameloop.js hands the loop to three before setSession wraps it
    const tReq = performance.now();
    // the window.rAF shim (xr_frame_clock.js): installed before setSession so its restore runs ahead of three's 'end';
    // `saved` is the page's first capture, re-passed every entry (test/client/xr-session-lifecycle-test.mjs)
    sessionEnded = false;
    frameClock = installEntryClock({
      win: window, session, saved: nativeRAF ? { raf: nativeRAF, caf: nativeCAF } : null,
      onEnd: () => { sessionEnded = true; },
    });
    nativeRAF = frameClock.native.raf; nativeCAF = frameClock.native.caf;
    await renderer.xr.setSession(session);
    tee(`[xr] enter #${sessionNo}: setSession resolved in ${(performance.now() - tReq).toFixed(0)} ms`);
    { const t = renderer.xr._xrRenderTarget; const fb = renderer._frameBufferTargets;
      tee(`[xr] enter #${sessionNo}: xrTarget ${t ? `${t.width}x${t.height} samples=${t.samples} type=${t.texture?.type} fmt=${t.texture?.format} cs=${t.texture?.colorSpace} multiview=${!!t.multiview}` : 'none'} renderer.samples=${renderer.samples}/${renderer._samples} fbts=${fb?.constructor?.name}:${fb?.size ?? '?'} layers=${renderer.xr._layers?.length ?? '?'} usesLayers=${renderer.xr._sessionUsesLayers}`); }
    { const gl = renderer.backend?.gl; let mv = 'n/a';
      try { const ex = gl?.getSupportedExtensions?.() ?? []; mv = ['OVR_multiview2', 'OCULUS_multiview'].filter((e) => ex.includes(e)).join('+') || 'none'; } catch { /* context lost */ }
      tee(`[xr] enter #${sessionNo}: projLayer=${!!renderer.xr._glProjLayer} baseLayer=${!!renderer.xr._glBaseLayer} foveation=${renderer.xr.getFoveation?.() ?? '?'} scale=${renderer.xr.getFramebufferScaleFactor?.() ?? '?'} target=${renderer.xr._xrRenderTarget?.width ?? '?'}x${renderer.xr._xrRenderTarget?.height ?? '?'} multiviewExt=${mv} outputPass=${renderer.needsFrameBufferTarget}`); }
    entryClock = { t0: performance.now(), setSessionMs: +(performance.now() - tReq).toFixed(0), frames: [], last: 0, programs: 0, programMs: 0, pipelines: 0 };
    // entry probe: count + time every program/pipeline built while the entry clock runs
    { const be = renderer.backend; if (be && !be.__entryProbe) { be.__entryProbe = true;
        for (const [k, field] of [['createProgram', 'programs'], ['createRenderPipeline', 'pipelines']]) { const orig = be[k]?.bind(be); if (!orig) continue;
          be[k] = (...a) => { const t = performance.now(); try { return orig(...a); } finally { buildTotals[field]++; if (field === 'programs') buildTotals.programMs += performance.now() - t; if (field === 'pipelines' && a[1] == null) { buildTotals.syncPipelines++; const ms = performance.now() - t; buildTotals.syncMs += ms; if (ms > 30) { const ro = a[0]; const nm = ro?.material?.name || ro?.material?.type || '?', ob = ro?.object?.name || ro?.object?.type || '?'; tee(`[xr] sync pipeline ${ms.toFixed(0)} ms: ${nm} on ${ob}${ro?.context?.material?.isShadowMaterial || ro?.material?.isDepthMaterial ? ' [shadow/depth]' : ''}`); } } if (entryClock) { entryClock[field]++; if (field === 'programs') entryClock.programMs += performance.now() - t; } } }; } } }
    // a cheap curtain while the scene compiles against the real XR camera + target (15 s cap; dropped in updateXR)
    setXRCurtain(true); curtainState = { armed: true, t0: performance.now() };
    if (!floor) tee('[xr] NO floor reference space granted — using local (eye-level origin); floor height is a guess');
    const onLine = `[xr] session on ${renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL'} refspace=${floor ?? 'local'} features=${JSON.stringify(session.enabledFeatures ?? [])} xrctx=${JSON.stringify(globalThis.__xrCtx ?? 'default')}`;
    console.log(onLine); tee(onLine);
    // fixed foveation (Basis's split): 1 standalone, 0 on PC where the periphery blur shows; ?fov=0..1 overrides
    { const standalone = /OculusBrowser|Quest|Pico|Wolvic|Android/i.test(navigator.userAgent) && !/Windows|Macintosh|Linux x86/i.test(navigator.userAgent);
      const fov = CONFIG.params.has('fov') ? THREE.MathUtils.clamp(+CONFIG.params.get('fov') || 0, 0, 1) : (standalone ? 1 : 0);
      try { renderer.xr.setFoveation(fov); tee(`[xr] foveation ${fov} (${standalone ? 'standalone' : 'pc'}${CONFIG.params.has('fov') ? ', ?fov' : ''})`); } catch { /* not all runtimes */ } }
    rig.position.set(myState.pos.x, myState.pos.y, myState.pos.z);
    recentre.x = recentre.z = recentre.y = 0; recentre.pending = true;   // fold the head's playspace pose in on the first tracked frame
    rig.rotation.y = wrapPi(myState.yaw);   // headset-forward = body-forward at entry
    scene.add(rig);
    rig.add(camera);
    slots[0] ??= makeHand(0); slots[1] ??= makeHand(1);
    hands.left ??= slots[0]; hands.right ??= slots[1];   // guess until 'connected' files them by handedness
    presenting = true; bus.emit('xr:state', true); xrVeilShow(false); vrprobe(true);
    try { localStorage.setItem(PREF_HEADSET_SEEN, String(Date.now())); } catch { /* private mode */ }   // the next boot picks WebGL up front
    // a switched-off headset still grants a session: no viewer pose for 2.5 s → say so, mark absent, leave
    hadPose = false;
    const thisSession = sessionNo;
    setTimeout(() => {
      if (sessionNo !== thisSession || !presenting || hadPose) return;   // a later session is not this timer's to judge
      tee('[xr] no viewer pose 2.5 s after the session was granted — no headset; leaving');
      markXrAbsent(true); toast('no headset detected — put it on (or wake it) and click the visor again', 'warn', 8000);
      leaveVR('no-headset');
    }, 2500);
    // a material failing in the eye context draws black and only console.error()s: tee the first 6
    if (!consoleTapped) { consoleTapped = true; for (const k of ['error', 'warn']) { const orig = console[k].bind(console);
      console[k] = (...a) => { try { const m = a.map((x) => (typeof x === 'string' ? x : x?.message ?? '')).join(' '); if (presenting && shaderTees < 6 && /shader|program|link|compile|GLSL|uniform|invalid/i.test(m)) { shaderTees++; tee(`[xr] console.${k}: ${m.slice(0, 300)}`); } } catch {} orig(...a); }; } }
    renderer.xr.cameraAutoUpdate = false;   // render.js owns the stereo camera update
    xrIntent.active = true;
    selfFirstPerson(true);
    { const t = performance.now(); xrPanelsEnter(rig); tee(`[xr] panels enter ${(performance.now() - t).toFixed(1)} ms`); }
    session.addEventListener('end', () => {
      // no clock restore here: xr_frame_clock.js owns it, generation-checked
      exitVeilShow(true);
      tee('[xr] session end — teardown begins');
      try {
      presenting = false; vrprobe(false); bus.emit('xr:state', false); eyeBase = null; setXRCurtain(false); curtainState = null;
      renderer.xr.cameraAutoUpdate = true;
      xrIntent.active = false;
      if (radialOpen) closeRadial(false);
      resetFingers(getSelf()?.vrm);
      selfFirstPerson(false);
      { const av = getSelf(), v = av?.vrm; if (v) { if (av.setPuppetScale) av.setPuppetScale(1); else v.scene.scale.setScalar(1); v.scene.position.set(0, 0, 0); v.scene.updateMatrixWorld(true); if (v.userData) { v.userData.ankleH = null; v.userData._gait = null; } } }   // the puppet scale and the eye-anchor offset, or the feet sink on the desktop
      releaseGrab();      // before the quads are disposed, or a dead mesh stays in the rig
      endResize();        // commits as it stands
      sticky.left = sticky.right = null; dwells.left.reset(); dwells.right.reset(); dropXRTip();
      for (const h of [hands.left, hands.right]) if (h) { h.laser.visible = false; h.laser.removeFromParent(); hideSurfaceDot(h.dot); rig.add(h.dot); h.smooth.init = false; }
      { const t = performance.now(); xrPanelsExit(rig); tee(`[xr] panels exit ${(performance.now() - t).toFixed(1)} ms`); }
      rig.remove(camera);
      scene.remove(rig);
      rig.scale.setScalar(1);
      session = null;
      camera.position.set(3.5, 2.6, 5.5);
      // WebXR overwrote the projection with the HMD's matrices
      camera.fov = 60; camera.aspect = innerWidth / innerHeight; camera.zoom = 1;
      camera.updateProjectionMatrix();
      // the canvas back to the window's size; a pixel ratio the guard deferred (xrpixelratio.js) lands now
      try { renderer.setPixelRatio(xrPixelRatio?.takeDeferred() ?? Math.min(devicePixelRatio, 2)); renderer.setSize(innerWidth, innerHeight); bus.emit('xr:exit-resized'); } catch (e) { report('xr exit resize', e); }
      // three's WebGL backend keeps the last XR frame's `_currentContext` after the session ends, and every desktop
      // finishRender then throws: drop it
      try { const be = renderer.backend; if (be && be._currentContext && be._currentContext !== null) { const rt = be._currentContext.renderTarget; tee(`[xr] exit: dropping stale backend context (${rt?.isXRRenderTarget ? 'XR' : rt?.constructor?.name ?? 'canvas'})`); be._currentContext = null; }
        renderer.setRenderTarget(null);
      } catch (e) { report('xr exit context', e); }
      camera.quaternion.identity(); camera.scale.setScalar(1); camera.updateMatrixWorld(true);   // pos+quat went NaN after exit without this
      // after-exit probe at +0.5 s and +3 s: the loop, camera, canvas size, a real centre pixel, programs/pipelines built
      // since teardown began, and `held` = how late each timer fired
      const f0 = perf.frameNo ?? 0;
      const tExit = performance.now(); const c0 = { ...buildTotals };
      const probe = (tag, due) => {
        // the veil drops only when desktop frames flow, never on a timer; a loop still dead at +3 s is re-armed once
        const flowing = ((perf.frameNo ?? 0) - f0) > 0;
        if (flowing) exitVeilShow(false);
        else if (tag === '+3s') { tee('[xr] after-exit: loop DEAD (frames+0 at +3 s) — re-arming'); bus.emit('xr:rearm'); setTimeout(() => probe('+6s', 6000), 3000); }
        else if (tag === '+6s') { exitVeilShow(false); tee(`[xr] after-exit: ${((perf.frameNo ?? 0) - f0) > 0 ? 'loop recovered' : 'loop STILL dead — reload'}`); }
        try {
          const cost = ` programs+${buildTotals.programs - c0.programs} (${(buildTotals.programMs - c0.programMs).toFixed(0)} ms) pipelines+${buildTotals.pipelines - c0.pipelines}`;
          const held = ` held ${Math.max(0, performance.now() - tExit - due).toFixed(0)}ms`;
          const cv = renderer.domElement; const ctx = document.createElement('canvas').getContext('2d'); ctx.canvas.width = 8; ctx.canvas.height = 8;
          let mean = null; try { ctx.drawImage(cv, cv.width * 0.4, cv.height * 0.4, cv.width * 0.2, cv.height * 0.2, 0, 0, 8, 8); const d = ctx.getImageData(0, 0, 8, 8).data; let a = 0; for (let i = 0; i < d.length; i += 4) a += d[i] + d[i + 1] + d[i + 2]; mean = +(a / (d.length / 4) / 3).toFixed(1); } catch (e) { mean = `err:${e?.name}`; }
          const e = camera.matrixWorld.elements;
          tee(`[xr] after-exit ${tag}:${cost}${held} frames+${(perf.frameNo ?? 0) - f0} draws ${renderer.info.render.calls} canvas ${cv.width}x${cv.height} css ${cv.clientWidth}x${cv.clientHeight} pr ${renderer.getPixelRatio()} cam ${[e[12], e[13], e[14]].map((v) => v.toFixed(1)).join(',')} parent ${camera.parent?.name ?? camera.parent?.type ?? 'none'} fov ${camera.fov} near/far ${camera.near}/${camera.far} rt ${renderer.getRenderTarget() ? 'SET' : 'canvas'} xr.enabled ${renderer.xr.enabled} presenting ${renderer.xr.isPresenting} hidden ${document.hidden} centrePx ${mean}`);
        } catch (e) { tee(`[xr] after-exit ${tag} probe threw: ${e?.message ?? e}`); }
      };
      setTimeout(() => probe('+0.5s', 500), 500); setTimeout(() => probe('+3s', 3000), 3000);
      } catch (e) { tee(`[xr] session end teardown THREW: ${e?.message ?? e} @ ${e?.stack?.split('\n')[1]?.trim() ?? '?'}`); report('xr end', e); }
    });
    // controller census: each input source's profiles + layout, once (unregistered devices still speak xr-standard)
    session.addEventListener('inputsourceschange', (ev) => {
      if (ev.added?.length) inputsSettledAt = performance.now() + 700;
      for (const src of ev.added ?? []) {
        const g = src.gamepad;
        const inLine = `[xr] input: ${src.handedness} profiles=${JSON.stringify(src.profiles)} ${g ? `axes=${g.axes.length} buttons=${g.buttons.length} haptics=${g.hapticActuators?.length ?? 0}` : 'no-gamepad'}`;
        console.log(inLine); tee(inLine);
      }
    });
  } catch (e) {
    report('enter VR', e);
    // a granted session whose setSession failed is alive and ours: end it, or every later request is 'already active'
    if (session && !presenting) { try { session.end(); } catch { /* already ending */ } session = null; renderer.xr.enabled = false; }
    // a sticky toast with the actual message (8 s when the policy supplied a userMessage)
    toast(e?.userMessage ?? `VR failed to start: ${e?.message ?? e}`, e?.userMessage ? 'warn' : 'err', e?.userMessage ? 8000 : 30000);
    tee(`[xr] ENTER FAILED: ${e?.name ?? ''} ${e?.message ?? e}`);
  } finally { entering = false; if (!presenting) xrVeilShow(false); }
}

/** The rig goes where the body is (offset by the head's playspace position, recentreXR). Called from xrbody before
 *  the head/arm solve, or grips and camera lag the body a frame. */
export function syncRigToBody() {
  if (!presenting) return;
  // the chosen size scales the tracking space (bodyscale.js xrScales: rig = u, body = u/k); recentre is measured
  // rig-local, so it goes back out × u here
  const u = xrScales(getSelf()?.userScale ?? 1, scaleState.k).rig;
  if (rig.scale.x !== u) rig.scale.setScalar(u);
  const c = Math.cos(rig.rotation.y), sn = Math.sin(rig.rotation.y);
  rig.position.set(myState.pos.x - u * (c * recentre.x + sn * recentre.z), myState.pos.y + u * recentre.y, myState.pos.z - u * (-sn * recentre.x + c * recentre.z));
  rig.updateMatrixWorld(true);
  renderer.xr.updateCamera(camera);
}
/** Apply the turn before the body solve, or the body is solved against last frame's yaw while the eyes render this
 *  one's. xrbody calls this ahead of syncRigToBody. */
let turnEarlyFrame = -1;
let hadPose = false;   // a viewer pose has arrived this session: the headset is on someone's head
export function applyTurnEarly(dtSec) {
  if (!presenting || radialOpen || !buttonsTrusted()) return;
  const R = sourceFor('right')?.gamepad; if (!R) return;
  const rx = pickAxis(R.axes[2], R.axes[0]);
  if (xrPrefs.turn === 'smooth') {
    const d = dead(rx);
    if (!d) return;
    rig.rotation.y = wrapPi(rig.rotation.y - d * SMOOTH_TURN_RAD_S * (dtSec ?? 1 / 72));
    turnEarlyFrame = perf.frameNo ?? -1;
    turnTraceArm('smooth'); turnTraceInput(d, dtSec);
    return;
  }
  // snap
  if (Math.abs(rx) > 0.6 && !snapState.cooling) {
    rig.rotation.y = wrapPi(rig.rotation.y - Math.sign(rx) * (SNAP_DEG * Math.PI) / 180);
    snapState.cooling = true;
    turnEarlyFrame = perf.frameNo ?? -1;
    turnTraceArm('snap');
  } else if (Math.abs(rx) < 0.3) snapState.cooling = false;
}
// turn trace: armed by a stick turn, 60 frames of rig/hips yaw and root/head/rig xz tee as one line, then it retires for 10 s
let turnTrace = null, turnTraceLast = 0;
function turnTraceArm(kind) { if (turnTrace || performance.now() - turnTraceLast < 10000) return; turnTrace = { kind, rows: [], d: 0, dt: null }; }
function turnTraceInput(d, dt) { if (turnTrace) { turnTrace.d = d; turnTrace.dt = dt; } }
function turnTraceTick() {
  if (!turnTrace) return;
  const av = getSelf(); const hips = av?.vrm?.humanoid?.getNormalizedBoneNode('hips'); const root = av?.root;
  const hy = hips ? Math.atan2(hips.getWorldDirection(_v).x, hips.getWorldDirection(_v).z) : 0;
  const rp = root ? root.getWorldPosition(_v2) : _v2.set(0, 0, 0);
  const hp = renderer.xr.getCamera().matrixWorld.elements;
  // right hand bone vs grip, world, mm
  let hd = 'u';
  { const g = hands.right?.grip, hb = av?.vrm?.humanoid?.getNormalizedBoneNode('rightHand');
    if (g && hb) { g.getWorldPosition(_v); hb.getWorldPosition(_v2); _v2.sub(_v); hd = `${Math.round(_v2.x * 1000)}:${Math.round(_v2.y * 1000)}:${Math.round(_v2.z * 1000)}`; } }
  turnTrace.rows.push(`${Math.round(rig.rotation.y * 100)},${Math.round(camYawWorld() * 100)},${Math.round((turnTrace.d || 0) * 100)},${turnTrace.dt == null ? 'u' : Math.round(turnTrace.dt * 1000)},${Math.round(hy * 100)},${Math.round(rp.x * 100)},${Math.round(rp.z * 100)},${Math.round(hp[12] * 100)},${Math.round(hp[14] * 100)},${Math.round(rig.position.x * 100)},${Math.round(rig.position.z * 100)},${hd}`);
  if (turnTrace.rows.length >= 60) { try { const sys = (Array.isArray(frameDebug?.()) ? frameDebug() : (frameDebug?.()?.systems ?? [])).map((x) => [x.name, +(x.ms ?? 0).toFixed(2)]).sort((a, b) => b[1] - a[1]).slice(0, 6); tee(`[xr] turn-trace systems (rolling ms, top 6): ${sys.map(([n, m]) => `${n}=${m}`).join(' ')} draws=${renderer.info.render.calls}`); } catch {} tee(`[xr] turn-trace ${turnTrace.kind} (rigYaw,camYaw,stick×100,dtMs|u,hipsYaw,rootX,rootZ,headX,headZ,rigX,rigZ,handΔx:y:z mm; angles×100, m×100): ${turnTrace.rows.join(' ')}`); turnTrace = null; turnTraceLast = performance.now(); }
}
function camYawWorld() { const e = renderer.xr.getCamera().matrixWorld.elements; return Math.atan2(-e[8], -e[10]); }   // world yaw of the HMD's -Z
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));   // every yaw write wraps, or a body yaw against a camera yaw pops a full turn
// ---- recentre / seated ----------
// Measure the head's rig-local pose once and fold it into the rig every frame, so head xz lands on myState.pos;
// seated lifts the rig to standing eye height. Never yaw the rig for a body: the camera is its child, so that spins
// the world (only the stick turns the tracking space).
const recentre = { x: 0, y: 0, z: 0, pending: false };
/** @returns {{x,z,y}} rig-local head xz to fold in; y lift (seated only). No yaw: the rig is stick-only. */
function recentreSolve({ headLocal, seated, standingEyeY }) {
  const y = seated && standingEyeY > 0.5 && headLocal.y > 0.3 ? standingEyeY - headLocal.y : 0;
  return { x: headLocal.x, z: headLocal.z, y };
}
const _hl = new THREE.Vector3();
export function recentreXR(why = 'verb') {
  if (!presenting) return false;
  const cam = renderer.xr.getCamera();
  _hl.setFromMatrixPosition(cam.matrixWorld);
  rig.updateMatrixWorld(true); rig.worldToLocal(_hl);           // head in rig space == the playspace
  if (![_hl.x, _hl.y, _hl.z].every(Number.isFinite)) return false;
  // a tracked head is ~0.3–3 m up and within 10 m of the origin; the first presenting frames have no pose: refuse,
  // and on the entry pass retry next frame
  if (_hl.y < 0.3 || _hl.y > 3 || Math.hypot(_hl.x, _hl.z) > 10) {
    if (why === 'entry') recentre.pending = true;
    else tee(`[xr] recentre (${why}) refused: head at playspace ${_hl.x.toFixed(2)},${_hl.y.toFixed(2)},${_hl.z.toFixed(2)} is not a tracked pose`);
    return false;
  }
  const eye = avatarEyeY();
  const r = recentreSolve({ headLocal: _hl, seated: !!xrPrefs.seated, standingEyeY: eye ? eye * puppetScale() : 0 });
  recentre.x = r.x; recentre.z = r.z; recentre.y = r.y;
  tee(`[xr] recentre (${why}): head at playspace ${r.x.toFixed(2)},${_hl.y.toFixed(2)},${r.z.toFixed(2)} folded in${r.y ? `; seated lift ${r.y.toFixed(2)} m` : ''}`);
  bus.emit('xr:recentre', { ...r, why });
  return true;
}
/** The one exit. Every path (visor glyph, ring, controller hold) ends here and says so. */
let lastLeaveAt = -1e9;
export function leaveVR(why = 'verb') {
  if (entering) { tee(`[xr] leave (${why}) refused: enter still in flight`); return false; }
  // before the `!session` return: a pending busy-retry has no session yet, and a leave must still cancel it
  if (entryEffects.hasPending) { cancelBusyRetry(`leave (${why})`); return true; }
  if (!session) { tee(`[xr] leave (${why}): no session`); return false; }
  tee(`[xr] leave (${why})`);
  lastLeaveAt = performance.now();
  toast('leaving VR…', 'info', 6000);
  exitVeilShow(true);   // from the click, not 'end': session.end() takes a moment
  try { const p = session.end(); p?.catch?.((e) => tee(`[xr] leave (${why}) rejected: ${e?.message ?? e}`)); } catch (e) { tee(`[xr] leave (${why}) threw: ${e?.message ?? e}`); }
  return true;
}
// entry clock: setSession → first presenting frame, then seven more frame gaps; one tee line, then it retires
let entryClock = null;
const buildTotals = { programs: 0, programMs: 0, pipelines: 0, syncPipelines: 0, syncMs: 0 };   // lifetime totals the exit probe reads deltas off; sync = a blocking link on a render frame
let skyArriving = false;   // sky.js 'sky-busy': a tier swap is compiling or baking
bus.on('sky-busy', (b) => { skyArriving = !!b; });
let curtainState = null;   // { armed, t0 } — the compile kicks off on the first presenting frame
let eyeBase = null;
let consoleTapped = false, shaderTees = 0;
let turnMag = 0;                    // |stick-X| while smooth-turning — the vignette reads it
export const turnMagnitude = () => turnMag;
/** Per frame while presenting: read hands → fill intent (controller.updateMe moves the body) → rig follows body. */
export function updateXR(dtSec = 1 / 72) {
  if (!presenting) { turnMag = 0; if (pttFromX) { setPttHeld(false); pttFromX = false; } muteBtnWas = false; return; }
  renderCensusTick();
  // eye watch: an eye whose vertical fov moves > 5° or whose viewport changes shape tees one line, re-armed on return
  { const cams = renderer.xr.getCamera().cameras ?? [];
    if (cams.length && !hadPose) { hadPose = true; markXrAbsent(false); }
    if (cams.length === 2) {
      const fov = cams.map((c) => 2 * Math.atan(1 / c.projectionMatrix.elements[5]) * 180 / Math.PI);
      const vp = cams.map((c) => c.viewport ? `${c.viewport.x | 0},${c.viewport.y | 0},${c.viewport.z | 0},${c.viewport.w | 0}` : '-').join(' | ');
      if (!eyeBase && fov.every(Number.isFinite)) eyeBase = { fov, vp, off: false };
      else if (eyeBase) {
        const off = fov.some((f, i) => Math.abs(f - eyeBase.fov[i]) > 5) || vp !== eyeBase.vp;
        if (off && !eyeBase.off) { tee(`[xr] EYES OFF: fov ${fov.map((f) => f.toFixed(1)).join('/')} (was ${eyeBase.fov.map((f) => f.toFixed(1)).join('/')}) vp ${vp} (was ${eyeBase.vp}) foreign ${JSON.stringify(renderCensusPeek())} camPlanes ${camera.near}/${camera.far}`); eyeBase.off = true; }
        else if (!off && eyeBase.off) { tee('[xr] eyes back to baseline'); eyeBase.off = false; }
      }
    } }
  if (curtainState?.armed) { curtainState.armed = false;
    // the curtain holds until the entry compileAsync resolves (cap 15 s), then drops after ≥2 presenting frames
    const t0 = performance.now(); const f0 = perf.frameNo ?? 0; const clock = entryClock;
    curtainState = { down: false, resolved: false, t0, f0, clock };
    { let ticks = 0; const tw = performance.now(); const tick = () => { ticks++; if (performance.now() - tw < 3000) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
      const tc = performance.now(), mine = sessionNo; const pr = compileEverything(renderer.xr.getCamera());   // tagged: session N must not drop session N+1's curtain
      pr.then(() => { tee(`[xr] entry compile resolved ${(performance.now() - tc).toFixed(0)} ms after arm (presenting=${presenting})`); if (curtainState && sessionNo === mine) curtainState.resolved = true; })
        .catch((e) => { report('xr entry compile', e); if (curtainState && sessionNo === mine) curtainState.resolved = true; });
      setTimeout(() => tee(`[xr] window.rAF in-session: ${ticks} ticks in 3 s; sync pipelines ${buildTotals.syncPipelines} (${buildTotals.syncMs.toFixed(0)} ms)`), 3200); }
  }
  if (curtainState && !curtainState.armed && !curtainState.down) {
    const frames = (perf.frameNo ?? 0) - curtainState.f0, ms = performance.now() - curtainState.t0;
    // the curtain is on screen: the sky's entry swap waits for this before its heavy work
    if (frames >= 3 && !curtainState.shown) { curtainState.shown = true; bus.emit('xr:curtain-shown'); }
    // the curtain covers the whole transition, the sky's arrival included; still capped at 15 s
    if ((curtainState.resolved && frames >= 2 && curtainState.shown && !skyArriving) || ms > 15000) {
      curtainState.down = true; setXRCurtain(false);
      const clock = curtainState.clock;
      tee(`[xr] curtain #${sessionNo} down (${curtainState.resolved ? 'compile resolved' : 'CAP 15 s'}) after ${ms.toFixed(0)} ms — sync pipelines so far ${buildTotals.syncPipelines} (${buildTotals.syncMs.toFixed(0)} ms), frames under it ${frames}, programs ${clock?.programs ?? '?'} in ${clock?.programMs?.toFixed(0) ?? '?'} ms, pipelines ${clock?.pipelines ?? '?'}`);
    }
  }
  if (entryClock) { const now = performance.now(); entryClock.frames.push(+(now - (entryClock.last || entryClock.t0)).toFixed(0)); entryClock.last = now;
    if (entryClock.frames.length === 8) { tee(`[xr] entry: setSession ${entryClock.setSessionMs} ms; first frame +${entryClock.frames[0]} ms; next gaps ${entryClock.frames.slice(1).join(',')} ms; programs so far ${entryClock.programs} (${entryClock.programMs.toFixed(0)} ms), pipelines ${entryClock.pipelines}; sync pipelines total ${buildTotals.syncPipelines} (${buildTotals.syncMs.toFixed(0)} ms)`); } }
  if (entryClock && (entryClock.frames.length > 120 || performance.now() - entryClock.t0 > 12000)) entryClock = null;
  if (!xrPrefs.seated) { const e = renderer.xr.getCamera().matrixWorld.elements; const hy = toRigLocal(e[13] - rig.position.y, rig.scale.y); if (Number.isFinite(hy)) sampleDeviceScale(hy); }   // rig-local: k is your real height; seated suppresses capture
  sampleFingerCurl();
  if (recentre.pending) { recentre.pending = false; recentreXR('entry'); }

  // head yaw becomes the movement frame. Read the -Z column of matrixWorld directly: getWorldDirection() calls
  // updateWorldMatrix(), which clobbers the XR-set matrix.
  const me_ = camera.matrixWorld.elements;
  _v.set(-me_[8], -me_[9], -me_[10]);
  // a momentarily NaN XR matrix (tracking loss) must not poison the move vector: keep the last good yaw
  const yaw = Math.atan2(_v.x, _v.z) + Math.PI;
  if (Number.isFinite(yaw) && _v.lengthSq() > 1e-6) {
    setCamYaw(yaw);   // orbit yaw for the walk direction only; the body's yaw is not driven from here
  }

  // a NaN in the body goes back to the last good spot before it poisons every matrix downstream
  if (Number.isFinite(myState.pos.x) && Number.isFinite(myState.pos.z)) lastGood.copy(myState.pos);
  else { tee(`[xr] myState.pos NaN — restored to ${lastGood.x.toFixed(1)},${lastGood.z.toFixed(1)} (speed ${myState.speed}, camYaw ${camYaw}, intent ${xrIntent.fwd},${xrIntent.strafe})`); myState.pos.copy(lastGood); }
  // speed is a lerp accumulator: one NaN in it is permanent
  if (!Number.isFinite(myState.speed)) myState.speed = 0;
  if (!Number.isFinite(camYaw)) setCamYaw(0);

  // the head's pitch (+ looking down) — swimming goes where the headset looks
  { const e = renderer.xr.getCamera().matrixWorld.elements; const pd = Math.asin(Math.max(-1, Math.min(1, e[9])));
    xrIntent.pitchDown = Number.isFinite(pd) ? pd : 0; }
  // sticks → intent
  const L = sourceFor('left')?.gamepad, R = sourceFor('right')?.gamepad;
  if (L) {
    xrIntent.fwd = dead(-pickAxis(L.axes[3], L.axes[1]));
    xrIntent.strafe = dead(pickAxis(L.axes[2], L.axes[0]));
    // jump = the right A, as VRChat; the left A/X is the mic (below)
    xrIntent.jump = !!R?.buttons[4]?.pressed;
    if (held?.hand === 'left' && L.buttons[0]?.pressed) xrIntent.fwd = 0;   // trigger + stick on the holding hand reels the panel, not a step
  } else { xrIntent.fwd = 0; xrIntent.strafe = 0; xrIntent.jump = !!R?.buttons[4]?.pressed; }
  // left A/X = the mic, as the desktop V: a press flips it in voice activation, hold-to-talk in push-to-talk
  { const x = buttonsTrusted() && !!L?.buttons[4]?.pressed;
    if (x && !muteBtnWas) {
      if (pttMode()) { if (micLive()) { setPttHeld(true); pttFromX = true; } }
      else { bus.emit('xr:mic'); haptic('left', 0.3, 20); tee('[xr] mic toggled (left A/X)'); }
    } else if (!x && muteBtnWas && pttFromX) { setPttHeld(false); pttFromX = false; }
    muteBtnWas = x; }
  // B or Y = the quick hide (VRChat's quick-menu button, either hand): every open panel away, the next press brings them back
  { const by = !!L?.buttons[5]?.pressed || !!R?.buttons[5]?.pressed;
    if (by && !menuBtnWas && buttonsTrusted()) {
      if (held) releaseGrab(); if (resizing) endResize();   // a carried or resizing panel is put down first
      const hid = xrPanelsHideToggle(); haptic('left', 0.3, 20); haptic('right', 0.3, 20); tee(`[xr] panels ${hid ? 'hidden' : 'shown'} (B/Y)`);
    }
    menuBtnWas = by; }
  if (R) {
    const rx = dead(pickAxis(R.axes[2], R.axes[0]));
    const ry = dead(pickAxis(R.axes[3], R.axes[1]));
    const pressed = !!R.buttons[3]?.pressed;              // thumbstick click
    // CLICK / LATCH / TRIGGER: stick click opens and closes; grip cancels; 12 s idle closes (each close tees its
    // cause). Aim latches (deflect > 0.5) and stays when the stick springs back; trigger activates; a flick (back
    // within 220 ms) activates too; releasing the click while deflected within 700 ms commits (hold-aim-release).
    const ringOpenAtStart = radialOpen;   // a grip that closes the ring this frame is spent: it must not also grab
    const gripNow = !!R.buttons[1]?.pressed;
    const trigNow = !!R.buttons[0]?.pressed;
    const magNow = Math.hypot(rx, ry);
    const nowMs = performance.now();
    if (pressed && !stickPressWas && buttonsTrusted()) {
      if (!radialOpen) { radialOpen = true; ring.openedAt = ring.lastInput = nowMs; ring.leftCentreAt = 0; openRadial(); haptic('right', 0.35, 30); tee('[xr] ring open (click)'); }
      else closeRing('click');
    } else if (radialOpen) {
      if (gripNow) closeRing('grip');
      else {
        if (magNow > 0.35 || trigNow) ring.lastInput = nowMs;
        if (magNow > 0.35) { if (!ring.leftCentreAt) { ring.leftCentreAt = nowMs; ring.peak = 0; } ring.peak = Math.max(ring.peak, magNow); aimRadial(rx, ry); }   // below the band aimRadial is NOT called: the latch holds
        else if (ring.leftCentreAt) {
          // a FLICK is a full, quick excursion: peak ≥ 0.85, out for 60–220 ms. A brush of the stick is not a choice.
          const out = nowMs - ring.leftCentreAt;
          const flick = ring.peak >= 0.85 && out >= 60 && out < 220 && (radial?.sel ?? -1) >= 0;
          ring.leftCentreAt = 0;
          if (flick) activateRing('flick');
        }
        if (!pressed && stickPressWas && magNow > 0.5 && nowMs - ring.openedAt < 700 && (radial?.sel ?? -1) >= 0) { activateRing('release'); if (radialOpen) closeRing('release'); }
        else if (trigNow && !ring.trigWas) activateRing('trigger');
        if (radialOpen) { tickRadial(); if (nowMs - ring.lastInput > 12000) closeRing('idle'); }
      }
    }
    ring.trigWas = trigNow;
    turnMag = 0;
    if (radialOpen) { /* the ring owns the stick */ }
    else if (xrPrefs.turn === 'smooth') {
      // smooth turn: the rig yaws continuously with the stick
      const d = dead(rx);
      if (d && turnEarlyFrame !== (perf.frameNo ?? -2)) { rig.rotation.y = wrapPi(rig.rotation.y - d * SMOOTH_TURN_RAD_S * (dtSec ?? 1 / 72)); turnTraceArm('smooth'); turnTraceInput(d, dtSec); }   // applied early this frame (applyTurnEarly) → no second step
      turnMag = Math.abs(d);
    }
    else if (Math.abs(rx) > 0.6 && !snapState.cooling && turnEarlyFrame !== (perf.frameNo ?? -2)) {
      // snap turns the RIG; the head's world yaw inherits it via the camera (normally applied early by
      // applyTurnEarly; this is the no-body path)
      rig.rotation.y = wrapPi(rig.rotation.y - Math.sign(rx) * (SNAP_DEG * Math.PI) / 180);
      snapState.cooling = true;
      turnTraceArm('snap');
    } else if (Math.abs(rx) < 0.3) snapState.cooling = false;
    stickPressWas = pressed;
    if (xrIntent.fwd || xrIntent.strafe || turnMag || pressed) markActive();   // sticks are input too: a presenting person is not 'away' (presence.js listens to DOM events only)

    // pointer + grab chord on BOTH hands, one thing held at a time; the ring stays on the right
    const eye = renderer.xr.getCamera();
    for (const side of ['right', 'left']) {
      const G = side === 'right' ? R : L; const hand = hands[side];
      if (!G || !hand) { panelPress[side] = null; sticky[side] = null; dwells[side].reset(); if (hand) { hand.laser.visible = false; hideSurfaceDot(hand.dot); } continue; }   // a controller dropped mid-press: forget it
      const grip = !!G.buttons[1]?.pressed, trig = !!G.buttons[0]?.pressed;
      // the ray every pick below uses, and the beam is drawn along: the controller's, low-passed (xrpointer.js), then
      // bent onto the target it holds while the hand drifts a little off it (stickTo)
      const aim = steerAim(hand, dtSec ?? 1 / 72);
      // panels claim the laser first; a plate counts only if nothing nearer is on it, decided before the trust gate
      const { ray, panel: panelAt, plate } = stickTo(side, aim, eye, !panelPress[side] && held?.hand !== side && resizing?.hand !== side);
      const panelNow = panelAt?.dist ?? null;
      // the whole world is cast, not just the interactable part: the beam stops at the first thing (a wall hides a chair)
      const ent = panelAt == null && plate == null ? rayHitEntity(ray, 40) : null;
      entSeen[side] = ent && { id: ent.id, interactable: ent.interactable };
      // the dwell's key: what the laser holds (a panel control, a plate) — else, on a panel, its zone (domquad.js)
      const dw = dwells[side].step(sticky[side]?.key ?? (panelAt ? `panel:${panelAt.id}:${panelAt.zone ?? 'body'}` : null));
      aimPlate(side, plate?.id, dw.since);
      // pointer visibility only hides the BEAM: the click, plate hover and stick scroll run either way
      hand.laser.visible = pointerVisible(xrPrefs.pointerVisibility, { target: panelNow != null || plate != null || !!ent?.interactable, grip, trig });
      hand.box.visible = !getSelf()?.vrm;   // a body owns the hands → no test box
      if (!buttonsTrusted()) { triggerWas[side] = trig; gripWas[side] = grip; if (hand.laser.visible) placeLaser(hand.laser, ray.matrixWorld, panelNow ?? plate?.dist ?? (ent?.interactable ? ent.dist : 1.8));
        if (dotVisible(xrPrefs.dotVisibility, { target: panelNow != null || plate != null || !!ent?.interactable, surface: !!ent })) placeDot(hand, ray, eye, { panel: panelAt, plateDist: panelAt ? null : plate?.dist ?? null, hit: ent }); else hideSurfaceDot(hand.dot);
        continue; }
      // GRIP: at a panel, takes the PANEL (tryGrab); elsewhere a grabbable THING (thingphysics.js xrHand)
      // a hand holding a thing is busy — no beam, no dot, no panel chord; its trigger uses the thing
      { const gh = grabHand(side, { pos: hand.grip.getWorldPosition(_v), grip, mayTake: panelNow == null && !held && !resizing, trig, pick: () => rayHitEntity(ray, 10), scale: getSelf()?.userScale ?? 1, haptic: (v, ms) => haptic(side, v, ms) });
        if (gh.holding || gh.took) { hand.laser.visible = false; hideSurfaceDot(hand.dot); triggerWas[side] = trig; gripWas[side] = grip; continue; } }
      if (grip && !gripWas[side] && !held && !resizing && !(side === 'right' && ringOpenAtStart)) tryGrab(side, ray);   // grip alone; panels only (a thing was taken above)
      if (!grip && held?.hand === side) releaseGrab();
      if (resizing?.hand === side) { if (grip) domQuadResizeMove(resizing.drag, aim); else endResize(); }   // the raw aim: a resize must not bend onto a control
      if (held?.hand === side && trig) pushPull(side, aim, -pickAxis(G.axes[3], G.axes[1]), dtSec ?? 1 / 72);   // trigger + stick: the reel
      const holding = held?.hand === side || resizing?.hand === side;
      if (trig && !triggerWas[side] && !holding && !(radialOpen && side === 'right')) {
        // panels claim the laser first: a click meant for a stepper must never select the mountain behind it
        const pr = xrPanelsPress(ray);
        const panelDist = pr?.dist ?? null;
        if (pr?.press) panelPress[side] = pr.press;
        if (panelDist != null) haptic(side, 0.3, 18);   // a button, felt
        const cardDist = panelDist == null ? platePress(ray) : null;   // a nameplate's open card (its buttons): before the world
        if (cardDist != null) haptic(side, 0.3, 18);
        if (panelDist == null && cardDist == null && !panelAt?.handle) {   // (the handle bar is a panel's, not the world's)
          const hit = rayHitEntity(ray);
          if (hit) { bus.emit('xr:select', hit.id); flashHint(`→ ${hit.id}`); }
        }
      }
      if (panelPress[side]) {
        // a press on a panel: held, it drags the panel's scroll; released, it clicks unless it dragged; a grab cancels it
        if (trig && !holding) xrPanelsDrag(ray, panelPress[side]);
        else { xrPanelsReleasePress(panelPress[side], holding); panelPress[side] = null; }
      }
      {
        const panelHit = xrPanelsAt(ray), panelDist = panelHit?.dist ?? null;   // again: a click above may have hidden or moved it
        if (side === 'right' && panelDist != null && !radialOpen && !holding && Math.abs(ry) > 0.3) domQuadsScroll(ray, ry * 900 * (dtSec ?? 1 / 72));   // stick Y scrolls the panel under the laser (beam hidden too)
        const plateDist = panelDist == null && plate ? plate.dist : null;
        const seen = panelDist == null && plateDist == null ? ent : null;   // (a click above may have shown a panel in front of it)
        const hit = seen && (seen.interactable || looksAtWorld(xrPrefs.pointerVisibility, { grip, trig })) ? seen : null;
        // short and faint at idle; something you can act on draws it out to the hit at full strength
        const target = panelDist ?? plateDist ?? hit?.dist ?? null;
        if (hand.laser.visible) placeLaser(hand.laser, ray.matrixWorld, target ?? 1.8);
        hand.laser.userData.opacity.value = target != null ? 0.85 : 0.4;
        // the dot follows ITS OWN setting (Settings › VR › surface dot visibility), not the beam's — and never marks the
        // panel this hand is holding: that panel is not a target, it is in your hand
        const dPanel = holding ? null : panelHit;
        if (dotVisible(xrPrefs.dotVisibility, { target: !!dPanel || plateDist != null || !!seen?.interactable, surface: !!seen })) placeDot(hand, ray, eye, { panel: dPanel, plateDist, hit: dPanel || plateDist != null ? null : seen });
        else hideSurfaceDot(hand.dot);
      }
      triggerWas[side] = trig; gripWas[side] = grip;
    }
    // THE TOOLTIP: a laser DWELLED on a control shows its desktop tooltip (xrtip.js), right hand first; never on a held panel
    let tipShown = false;
    for (const side of ['right', 'left']) {
      const st = sticky[side], key = dwells[side].ripeKey();
      if (tipShown || !key || st?.kind !== 'panel' || st.key !== key || typeof key === 'string' || held?.quad?.mesh === st.obj) continue;
      const root = st.obj.material?.map?.dom, text = root ? tipTextFor(key, root) : '';
      if (text) { showXRTip(st.obj, root, key, text); tipShown = true; }
    }
    if (!tipShown) hideXRTip();
    // THE HANDLES: move strip and resize corners/edges show only once dwelled on (domquad.js); a resize keeps its own
    const reveal = [];
    for (const side of ['right', 'left']) {
      const k = dwells[side].ripeKey(), m = typeof k === 'string' && k.match(/^panel:(.+):(move|resize-[a-z]+)$/);
      if (m) { const mesh = domQuadMesh(m[1]); if (mesh) reveal.push({ mesh, zone: m[2] }); }
    }
    if (resizing) reveal.push({ mesh: resizing.drag.q.mesh, zone: `resize-${resizing.drag.z}` });
    if (held?.quad?.mesh) reveal.push({ mesh: held.quad.mesh, zone: 'move' });   // the bar of a carried panel, at full
    domQuadsRevealOnly(reveal);
  }

  if (fpVrm !== getSelf()?.vrm) selfFirstPerson(true);   // avatar swapped mid-session → chop the new head
  hookSelfDraws(); selfDrawnLast = selfDrawn; selfDrawn = 0;

  // the rig is stick-only: nothing reads the head and writes the rig or the body root (xrbody.js chases the head)
  syncRigToBody();   // (again, after a snap/smooth turn above changed rig.rotation)
  // — three's XRManager builds cameraXR from camera.parent.matrixWorld
  turnTraceTick();

  // a non-finite camera.near/far throws inside render and freezes the headset: restore sane planes, record what was found
  if (!Number.isFinite(camera.near) || !Number.isFinite(camera.far) || camera.far <= camera.near) {
    tee(`[xr] camera planes non-finite: near=${camera.near} far=${camera.far} — restored`);
    camera.near = 0.15; camera.far = 20000; camera.updateProjectionMatrix();
  }

  // FLIGHT RECORDER: one line every 5 s while presenting — numbers where a headset gives adjectives
  const now = performance.now();
  if (now - recAt > 5000) {
    recAt = now;
    const av = getSelf();
    const rec = JSON.stringify({
      backend: renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl',
      fps: perf.fps, ms: +perf.ms.toFixed(1), worst: +perf.worst.toFixed(0), spikes: perf.spikes,
      body: av ? (av.vrm?.scene?.visible ? 'visible' : 'HIDDEN') : 'NONE',
      fp: !!fpVrm, headChop: !!choppedHead, selfDrawn: selfDrawnLast, camMask: camera.layers.mask,
      eyeMasks: (renderer.xr.getCamera().cameras ?? []).map((c) => c.layers.mask),   // what each eye may SEE
      eyeFov: (renderer.xr.getCamera().cameras ?? []).map((c) => +(2 * Math.atan(1 / c.projectionMatrix.elements[5]) * 180 / Math.PI).toFixed(1)),   // vertical fov per eye from the projection — a fisheye is a number here
      eyeVp: (renderer.xr.getCamera().cameras ?? []).map((c) => c.viewport ? [c.viewport.x, c.viewport.y, c.viewport.z, c.viewport.w].map((v) => +v.toFixed(0)) : null),
      renders: renderCensusTake(),   // max renderer.render() calls in one frame since the last line + the last foreign camera
      // 'pitch black' as numbers: my body's materials and the lights that should be lighting them
      mats: (() => { const out = {}; av?.vrm?.scene?.traverse((o) => { if (!o.isMesh || !o.visible) return; for (const m of [].concat(o.material ?? [])) { const k = `${m.constructor?.name ?? m.type}${m.isOutline ? ':outline' : ''}`; const e = out[k] ||= { n: 0, tex: 0, opaque: 0, needsUpdate: 0 }; e.n++; if (m.map) e.tex++; if (!m.transparent || m.opacity >= 0.99) e.opaque++; if (m.needsUpdate) e.needsUpdate++; } }); return out; })(),   // arrays flattened (multi-material bodies): 12:34's 'undefined / tex 0' was this counter, not the body
      lights: (() => { const l = []; scene.traverse((o) => { if (o.isLight) l.push(`${o.type.replace('Light', '')}:${+o.intensity.toFixed(2)}${o.visible ? '' : ':hidden'}`); }); return l.slice(0, 8); })(),
      env: !!scene.environment,
      fpSplit: (() => { const n = { fp: 0, tp: 0, both: 0, base: 0 }; av?.vrm?.scene?.traverse((o) => { if (!o.isMesh && !o.isSkinnedMesh) return; const f = o.layers.isEnabled(FP_LAYER), t = o.layers.isEnabled(TP_LAYER); n[f && t ? 'both' : f ? 'fp' : t ? 'tp' : 'base']++; }); return n; })(),   // a body whose meshes are ALL tp is invisible in FP by spec
      controllers: { L: !!sourceFor('left'), R: !!sourceFor('right'), trusted: buttonsTrusted(), bits: ['left', 'right'].map((h) => (sourceFor(h)?.gamepad?.buttons ?? []).map((b) => +!!b.pressed).join('')) },   // raw pressed bits per hand: a stuck-true button is visible here
      rig: [+rig.position.x.toFixed(1), +rig.position.y.toFixed(1), +rig.position.z.toFixed(1)],
      hands: { L: !!sourceFor('left'), R: !!sourceFor('right') }, held: held?.quad?.id ?? null,
      me: [+myState.pos.x.toFixed(1), +myState.pos.y.toFixed(1), +myState.pos.z.toFixed(1)], clip: myState.clip, seat: myState.seat?.id ?? null, ring: radialOpen,
      yaw: { cam: +camYawWorld().toFixed(2), rig: +rig.rotation.y.toFixed(2), root: +(av?.root?.rotation.y ?? 0).toFixed(2) },
      headLocal: [+camera.position.x.toFixed(2), +camera.position.y.toFixed(2), +camera.position.z.toFixed(2)],   // the HMD in rig space: a pop is a number here
      hips: { yaw: +(xrBodyDebug().hipsYaw ?? 0).toFixed(2), follow: +(xrBodyDebug().follow ?? 0).toFixed(2) },   // Basis latch state on the hips bone
      mirror: xrPrefs.mirror,   // is the desktop mirror pass running this session?
      vignette: xrPrefs.vignette,
      rigWorld: (() => { const e = rig.matrixWorld.elements; return [+e[12].toFixed(2), +e[13].toFixed(2), +e[14].toFixed(2)]; })(), rigAuto: rig.matrixAutoUpdate, rigWAuto: rig.matrixWorldAutoUpdate, sceneWAuto: scene.matrixWorldAutoUpdate,   // is the rig's WORLD matrix ever computed?
      eyes: (() => { const xc = renderer.xr.getCamera(); return (xc.cameras ?? []).map((c) => { const e = c.matrixWorld.elements; return [+e[12].toFixed(2), +e[13].toFixed(2), +e[14].toFixed(2)]; }); })(),   // PER-EYE world positions — what actually renders
      baseCam: (() => { const e = camera.matrixWorld.elements; return [+e[12].toFixed(2), +e[13].toFixed(2), +e[14].toFixed(2)]; })(),
      pitch: +(() => { const e = renderer.xr.getCamera().matrixWorld.elements; return Math.asin(Math.max(-1, Math.min(1, -e[9]))); })().toFixed(2),   // HMD pitch (rad), + = looking up
      camWorld: (() => { const e = renderer.xr.getCamera().matrixWorld.elements; return [+e[12].toFixed(2), +e[13].toFixed(2), +e[14].toFixed(2)]; })(),   // the EYES in world space — a 'pop to origin' that the rig doesn't show
      rootPos: av ? [+av.root.position.x.toFixed(2), +av.root.position.y.toFixed(2), +av.root.position.z.toFixed(2)] : null,
      vrmOff: av?.vrm ? [+av.vrm.scene.position.x.toFixed(2), +av.vrm.scene.position.y.toFixed(2), +av.vrm.scene.position.z.toFixed(2)] : null,   // the eye anchor's offset inside the root
    });
    console.log('[xr:rec]', rec); tee(`[xr:rec] ${rec}`);
    if (CURL_PROBE) { const cp = curlProbeTake(); if (Object.keys(cp).length) tee(`[xr:curl] raw jitter peak/mean/n per finger: ${JSON.stringify(cp)}`); }
  }
}
let recAt = 0;

// Compile the whole scene for the eyes, not the frustum: three's walk culls by camera, so a prop behind you would
// compile at its first in-session draw (hundreds of ms each, after the curtain).
async function compileEverything(cam) {
  const culled = []; scene.traverse((o) => { if (o.isMesh && o.frustumCulled) { culled.push(o); o.frustumCulled = false; } });
  try { await renderer.compileAsync(scene, cam, scene); }
  finally { for (const o of culled) o.frustumCulled = true; }
}
let xrWarmed = false, headsetHere = false;
function warmXRPipelines() {
  if (xrWarmed || !(XR_BOOT || headsetHere) || presenting || !getSelf()?.vrm) return;   // any boot with a headset present warms, not only ?xr=1
  xrWarmed = true;
  warm('xr pipelines', async () => {
    // one compile through three's own eyes (xrpass.js withXREyes), no target bound: it lands in the render context the headset uses
    const t0 = performance.now();
    try { await withXREyes(renderer, (eyes) => compileEverything(eyes)); }
    catch (e) { report('xr pipeline warm', e); }
    tee(`[xr] pipelines pre-warmed for the eyes in ${(performance.now() - t0).toFixed(0)} ms (entry should now show programs≈0)`);
  }, { p: P_AMBIENT });
}
export async function initXR() {
  bindGrabPresenting(() => presenting);   // a tracked body holds with its own hands: no desktop hold pose on the arms (at init: never at module load, where an import cycle could find thingphysics unevaluated)
  if (!navigator.xr) return;
  let supported = false;
  try { supported = await navigator.xr.isSessionSupported('immersive-vr'); }
  catch (e) { report('xr support probe', e); }
  if (!supported) return;
  // never write the headset-seen pref here: isSessionSupported is true with any XR runtime, headset or not
  headsetHere = true;
  // from here every content warm also builds the other mode's variant (xrwarm.js)
  if (renderer.backend?.isWebGLBackend) globalThis.__xrDualWarm = installDualWarm({ THREE, renderer, camera, presenting: () => presenting });

  // pre-warm the hand meshes, parked under the rig, so their first draw isn't a ~0.5 s compile spike
  slots[0] ??= makeHand(0); slots[1] ??= makeHand(1);
  hands.left ??= slots[0]; hands.right ??= slots[1];
  warm('xr hands', async () => {
    // frustumCulled off so a parked mesh isn't culled out of the compile walk; the dot and a textured icon are shown for the compile only
    const dots = [hands.left?.dot, hands.right?.dot].filter(Boolean);
    for (const d of dots) { d.visible = true; setSurfaceDotKind(d, 'click'); d.userData.parts.rim.visible = d.userData.parts.core.visible = true; }
    const meshes = []; rig.traverse((o) => { if (o.isMesh) meshes.push(o); });
    try { for (const m of meshes) { m.frustumCulled = false; try { await renderer.compileAsync(m, camera, scene); } catch { /* fine */ } } }
    finally { for (const d of dots) { setSurfaceDotKind(d, 'dot'); if (d.parent === rig) d.visible = false; } }
  }, { p: P_AMBIENT });

  { let tries = 0; const iv = setInterval(() => { warmXRPipelines(); if (xrWarmed || ++tries > 240) clearInterval(iv); }, 500); }   // poll until the body is in; give up after 2 min (a viewer page has no body)
  // the third glyph of the mic/ear trio; exists only where a headset can present
  registerXrGlyph({
    // core.js picks the backend that can present (WebGL until Chrome's WebGPU-XR ships unflagged)
    onclick: () => {
      if (presenting) { leaveVR('visor'); return; }
      // just after a leave, a controller trigger IS a click wherever the pointer sits: refuse re-entry for 1.5 s
      if (performance.now() - lastLeaveAt < 1500) { tee('[xr] visor: enter ignored (left VR less than 1.5 s ago)'); return; }
      // ASK FOR THE MIC ON THE FLAT PAGE FIRST, where the browser can show it; a fresh click then enters (vrmic.js)
      void vrMicPreflight(visorEnter);
    },
    live: () => presenting,
  });
  // the visor's entry proper — straight from the press, or from the fresh click on the mic step
  function visorEnter() {
    if (XR_BOOT) { enterVR(); return; }
    // already on WebGL: enter in place, no page reload
    if (!renderer.backend?.isWebGPUBackend) { tee('[xr] visor: enter in place (WebGL, no reload)'); enterVR(); return; }
    // on WebGPU, entering VR means RELOADING onto WebGL 2: ask first, in the middle of the screen
    tee('[xr] visor: WebGPU backend — asking before the reload onto WebGL');
    confirmCenter({
      title: 'Restart the page for VR?',
      body: "This browser can't show VR from its WebGPU renderer yet, so entering VR reloads the page on WebGL 2. Unsaved typing in panels is lost.",
      ok: 'Restart in VR', cancel: 'Not now',
    }).then((yes) => {
      if (!yes) { tee('[xr] visor: reload declined'); return; }
      toast('restarting on WebGL 2 for VR', 'info', 4000);
      tee('[xr] visor: reload (vr-webgl)');
      const u = new URL(location.href); u.searchParams.set('xr', '1'); u.searchParams.set('why', 'vr-webgl');
      setTimeout(() => { location.href = u; }, 300);
    });
  }
  setXrProbe(() => presenting);
}

/** harness window: the pointer, per hand — the beam as drawn, what the laser holds, whether the ray is bent onto it */
export const xrPointerDebug = () => Object.fromEntries(['left', 'right'].map((side) => {
  const h = hands[side], st = sticky[side];
  return [side, h && { laser: { visible: h.laser.visible, len: +h.laser.scale.z.toFixed(4), opacity: +h.laser.userData.opacity.value.toFixed(2), inScene: h.laser.parent === scene },
    held: st && { kind: st.kind, key: typeof st.key === 'string' ? st.key : `${st.key?.tagName?.toLowerCase()}${st.key?.id ? '#' + st.key.id : ''}` },
    ent: entSeen[side], dot: { visible: h.dot.visible, inScene: h.dot.parent === scene, kind: h.dot.userData.kind, pos: h.dot.position.toArray().map((v) => +v.toFixed(4)), diam: +h.dot.scale.x.toFixed(5),
      normal: [0, 0, 1].map((_, i) => +new THREE.Vector3(0, 0, 1).applyQuaternion(h.dot.quaternion).getComponent(i).toFixed(4)) },
    heldEl: st?.kind === 'panel' && typeof st.key !== 'string' ? st.key : null,
    bent: pickState[side].bent, pointerVisibility: xrPrefs.pointerVisibility, dotVisibility: xrPrefs.dotVisibility,
    dwell: { key: typeof dwells[side].key === 'string' || dwells[side].key == null ? dwells[side].key : 'el', since: dwells[side].since, ripe: dwells[side].ripe() } }];
}));

/** harness window */
export const xrDebug = () => {
  const ring = radialEntries().map((e) => ({ label: e.label, has: e.has !== false, on: !!e.on?.() }));
  const gp = new THREE.Vector3();
  hands.right?.grip.getWorldPosition(gp);
  return { ring,
    presenting, held: held?.quad?.id ?? null, radialOpen, panelsHidden: xrPanelsHidden(), resizing: resizing ? { hand: resizing.hand, id: resizing.drag.q.id, zone: resizing.drag.z, w: Math.round(resizing.drag.w), h: Math.round(resizing.drag.h) } : null,
    radialSel: radial?.sel ?? null,
    rigYaw: +rig.rotation.y.toFixed(3),
    laserOn: hands.right?.laser.visible ?? false,
    gripWorld: [+gp.x.toFixed(2), +gp.y.toFixed(2), +gp.z.toFixed(2)],
  };
};


// The veil, both ways: the splash's mark and a phase line, from the visor click until the session's first frame, and
// from the leave click until desktop frames flow again.
function xrVeilShow(on, phase = 'leaving VR') {
  if (!exitVeil) {
    exitVeil = document.createElement('div'); exitVeil.className = 'xr-veil'; exitVeil.setAttribute('aria-live', 'polite');
    const logo = document.querySelector('#splash .sp-logo-wrap');
    if (logo) { const c = logo.cloneNode(true); c.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id')); exitVeil.appendChild(c); }   // the mark at rest; its travel clip's id stays the splash's alone
    for (const [cls, txt] of [['sp-mark', 'eidoverse'], ['sp-mark-sub', 'worlds'], ['sp-phase xr-veil-phase', phase]]) {
      const d = document.createElement('div'); d.className = cls; d.textContent = txt; exitVeil.appendChild(d); }
    document.body.appendChild(exitVeil);
  }
  const ph = exitVeil.querySelector('.xr-veil-phase'); if (ph && ph.textContent !== phase) ph.textContent = phase;
  exitVeil.classList.toggle('on', !!on);
}
function exitVeilShow(on) { if (!on && entering) return; xrVeilShow(on, 'leaving VR'); }   // an after-exit probe never hides the veil of an enter #2 already in flight

// a press still pending when a session ends must not click a hidden panel on the next entry
bus.on('xr:state', (on) => { if (!on) { panelPress.left = null; panelPress.right = null; } });
