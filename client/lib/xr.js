// xr — the door into the headset, and everything your hands do inside it.
//
// Boot split unchanged (?xr=1 → WebGL2). This module owns: the session + rig,
// STICK LOCOMOTION (which is not locomotion at all — it fills xrIntent and the
// eidoverse controller's own wish/gravity/mantle/seat code does every bit of
// the moving; a thumbstick is a keyboard that reports fractions), the POINTER
// (right-hand ray: trigger = select, feeding the same sgSelect the hierarchy
// and viewport clicks feed), GRAB (the HIGGS chord: grip alone aims, grip+
// trigger takes — local while held, and release SPEAKS A PLACE VERB, so a VR
// grab and a typed /place are the same sentence; undo already knows how to
// unsay it), and the RADIAL MENU (right-stick PRESS opens, stick aims, release
// commits; snap turn keeps stick-X when the ring is closed; every slot is a
// verb-backed action — nothing exists only as a VR gesture. Agent parity).
//
// Knowledge ported from exultation input/xr.ts + porch-old, not the structure:
// deadzone-with-rescale, snap cooldown, tracking-loss = keep-last-pose,
// 'layers' dropped from optionalFeatures (MSAA via classic XRWebGLLayer),
// foveation 0, local-floor, and the settled law: NEVER navigate mid-session.

import { installRenderListTolerance, THREE, renderer, camera, scene, XR_BOOT } from './core.js';
import { CONFIG, report, bus, tee } from './base.js';
import { frameDebug } from './frame.js';
import { resetFingers, xrBodyDebug } from './xrbody.js';
import { stroke, fillPath } from './icons.js';
import { xrPanelsEnter, xrPanelsExit, xrPanelsPick, showXRPanel, xrPanelHas, xrPanelOpen, xrPanelsGrab, xrPanelRelease, xrPanelsShown } from './xrpanels.js';
import { domQuadsScroll } from './domquad.js';
import { myState, xrIntent, camYaw, setCamYaw, setXrProbe } from './controller.js';
import { ringEmoteEntries } from './emotebar.js';
import { entities } from './world.js';
import { flashHint, toast } from './ui.js';
import { makePointerLine } from './pointer.js';
import { markXrAbsent, registerXrGlyph, micGlyph, earGlyph, xrGlyph, micLive, earOn, flipEar } from './mictoggle.js';
import { markActive } from './presence.js';
import { dockPins } from './ui.js';
import { perf } from './perf.js';
import { renderCensusTake, renderCensusTick, renderCensusPeek, setXRCurtain } from './render.js';
import { warm, P_AMBIENT } from './warmqueue.js';

// ---- self-body in first person ---------------------------------------------
// R's first headset session (23:22): own body invisible (she stood INSIDE it,
// camera at head height), own nameplate photobombing from above her own head.
// porch-old's settled answer: hide the HEAD, keep the body (looking down and
// seeing your own torso is the embodiment), hide your own label. Generic form
// for arbitrary VRMs: three-vrm firstPerson layers — setup() splits/annotates
// meshes onto FP-only (9) and TP-only (10) layers; eye cameras see 9 not 10,
// the desktop camera sees 10 not 9. main.js binds the self-avatar getter.
let getSelf = () => null;
export const bindXRSelf = (fn) => { getSelf = fn; };
const FP_LAYER = 9, TP_LAYER = 10;
let fpVrm = null;   // which vrm the head-chop is applied to — re-applied after an avatar swap
// HEAD CHOP, Basis's way (BasisLocalAvatarDriver.ScaleHeadToZero: Mapping.head.localScale = 0;
// porch-old did the same). ONE mechanism for every avatar: the RAW head bone is scaled to ~0 while
// presenting, so everything skinned to the head and its children collapses to a point behind the
// eyes, and the rest of the body draws through the ordinary path. Replaces the three-vrm layer split
// (09-04 → 09-06): that made a second skinned mesh per body part on layer 9 at enter-VR time, and R's
// own body was invisible in the headset all morning with every layer number reading correct
// (09-06 11:31–11:53) — a mechanism that can disagree with the camera is one mechanism too many.
// three-vrm's normalized rig copies ROTATIONS raw←normalized in humanoid.update(); raw scale is ours.
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
/** Run fn with the first-person head chop lifted — a mirror's reflection pass shows the whole head
 *  (porch-old's __setHeadScale(1) inside the Reflector's onBeforeRender). Restores after. */
export function withHeadShown(fn) {
  if (!choppedHead) return fn();
  const b = choppedHead.bone, kept = b.scale.clone();
  b.scale.copy(choppedHead.scale);
  try { return fn(); } finally { b.scale.copy(kept); }
}
// how many of MY meshes the renderer actually drew this frame (all eyes) — 'invisible' becomes a number
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
// finger curl surrogate (Tier A4; porch-old :10933): trigger value → index, grip value → the other three
const fingerCurl = { left: { index: 0, grip: 0 }, right: { index: 0, grip: 0 } };
export const xrFingerCurl = () => fingerCurl;
function sampleFingerCurl() {
  for (const hand of ['left', 'right']) {
    const gp = sourceFor(hand)?.gamepad; const b = gp?.buttons;
    if (!b) continue;
    fingerCurl[hand].index = b[0]?.value ?? (b[0]?.pressed ? 1 : 0);
    fingerCurl[hand].grip = b[1]?.value ?? (b[1]?.pressed ? 1 : 0);
  }
}
rig.name = 'xr-rig';
let presenting = false;
let nativeRAF = null, nativeCAF = null;   // window.rAF/cAF saved while the in-session shim is installed
let sessionEnded = false;                  // set on the FIRST 'end' listener; the shim falls back to native once it is
let exitVeil = null;
let floorSpace = null;              // 'local-floor' | 'bounded-floor' | null (fell back to 'local')
export const xrFloorSpace = () => floorSpace;

// ---- DeviceScale (Tier A5; Basis BasisHeightDriver — the AVATAR is scaled to the player)
// Map the human's standing eye height onto the avatar's: median of the first
// 120 in-session HMD heights (> 0.5 m — a seated start or tracking garbage
// must not scale), k = avatarEyeY / median, clamped .6–1.6. Provenance says why
// you are this size; saved per avatar (Basis: Fallback/Measured/Saved).
// HOW it is applied changed 09-06 12:10 (R: 'hands 8 inches from my controllers'): porch-old and
// the first port scaled the TRACKED TARGETS toward the rig by k and left the puppet at its authored
// size — so a controller 1.3 m from the rig landed 0.15 × 1.3 ≈ 20 cm short at k = 0.85, by
// construction. Basis scales the PUPPET (BasisHeightDriver.ApplyAvatarScale: the avatar root, its
// T-pose offsets, the capsule) and never the tracking. So: vrm.scene.scale = 1/k while presenting,
// targets stay 1:1, hands sit ON the controllers. xrbody reads puppetScale(); xrScale().k stays the
// measured ratio for anyone who wants the number. Restored to 1 on session end.
const SCALE_LS = 'ew-xr-scale';
let wornName = '';   // the avatar name from 'avatar-worn' — the per-body key for a saved scale (Avatar has no .name)
const scaleState = { k: 1, source: 'fallback', samples: [], eyeY: null, locked: false, firstAt: 0 };
// a body swap while presenting: the new body must not wear the old body's ratio (eyes off the HMD height)
bus.on('avatar-worn', (name) => { wornName = name ?? ''; if (!presenting) return; scaleState.samples.length = 0; scaleState.locked = false; scaleState.firstAt = 0; scaleState.k = 1; scaleState.source = 'fallback'; loadSavedScale(); tee('[xr] body swapped while presenting — device scale re-measured'); });
export const xrScale = () => ({ ...scaleState, samples: scaleState.samples.length });
/** The multiplier the self puppet wears while presenting (Basis: avatar scaled to the player). 1 when unmeasured. */
export const puppetScale = () => (presenting && scaleState.k > 0 ? 1 / scaleState.k : 1);
// harness hook (?xrsim only): feed HMD heights without waiting on a slow headless frame rate
export const xrSimSample = (y) => { if (CONFIG.params.has('xrsim')) sampleDeviceScale(y); };
function avatarEyeY() {
  const av = getSelf(); const h = av?.vrm?.humanoid;
  if (!h) return null;
  const root = av.vrm.scene.getWorldPosition(new THREE.Vector3()).y;
  const ps = av.vrm.scene.scale.y || 1;   // AUTHORED height: undo the puppet scale the body may already be wearing (a saved k would otherwise re-measure as 1)
  const eye = h.getNormalizedBoneNode?.('leftEye') ?? h.getNormalizedBoneNode?.('rightEye');
  if (eye) return (eye.getWorldPosition(new THREE.Vector3()).y - root) / ps;
  const head = h.getNormalizedBoneNode?.('head');
  return head ? (head.getWorldPosition(new THREE.Vector3()).y - root) / ps + 0.06 : null;   // eyes ≈ 6 cm above the head joint
}
function loadSavedScale() {
  if (!wornName) return;   // no body yet (visor clicked before it landed): nothing to load, and never a '' key
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
  // lock at 120 samples, or after 3 s with at least 30 (porch's floor) — a slow
  // frame rate (SwiftShader headless: ~3 fps) must not postpone it forever
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

// ---- tuning (exultation XR_DEFAULTS, ported values) ------------------------
// ---- VR preferences (Settings › VR; R, 09-05 18:22). Persisted per browser.
// turn: 'snap' | 'smooth' · vignette: comfort tunnel on move/turn · mirror:
// what the desktop window shows while presenting — 'off' | 'first' | 'third'.
const PREF_XR = 'ew-xr-prefs';
export const xrPrefs = (() => { try { return { turn: 'smooth', vignette: false, mirror: 'off', seated: false, ...JSON.parse(localStorage.getItem(PREF_XR) || '{}') }; } catch { return { turn: 'smooth', vignette: false, mirror: 'off', seated: false }; } })();
{ const m = new URLSearchParams(location.search).get('mirror'); if (m === 'off' || m === 'first' || m === 'third') xrPrefs.mirror = m; }   // URL override for A/B (R's 'pop to origin' hunt, 09-05 21:46)
export function setXrPref(k, v) { xrPrefs[k] = v; try { localStorage.setItem(PREF_XR, JSON.stringify(xrPrefs)); } catch {} bus.emit('xr:prefs', xrPrefs); }
const DEADZONE = 0.18;
const SNAP_DEG = 30;
const SMOOTH_TURN_RAD_S = 2.2;   // ~126°/s at full deflection
const snapState = { cooling: false };
const dead = (v, dz = DEADZONE) => {
  if (!Number.isFinite(v)) return 0;   // a NaN axis (Frame controller waking, 09-05 23:13) must read as centred, not poison the walk
  const m = Math.abs(v);
  return m < dz ? 0 : Math.sign(v) * ((m - dz) / (1 - dz));
};
const pickAxis = (a, b) => (typeof a === 'number' && a !== 0 ? a : (b ?? 0));

// ---- controllers -----------------------------------------------------------
const hands = { left: null, right: null };   // {grip, ray, laser} — resolved by HANDEDNESS
// three's controller slots 0/1 are enumeration order, NOT left/right (porch-old
// index.html:5395 learned this; R, 09-05 20:00: 'hands attached to the wrong
// controller'). Each slot listens to its own 'connected' event and files itself
// under e.data.handedness; until then slot 0 = left, 1 = right as a guess.
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
  // visible hand: a small warm knuckle-box — only until a body owns the hands (R 09-06 23:38:
  // 'we don't need the test-boxes if they're bound to an avatar'); the tick hides it once one does
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.035, 0.09),
    new THREE.MeshStandardMaterial({ color: 0xe8c9a0, roughness: 0.8 }));
  grip.add(box);
  // the pointer: porch-old's fading beam (R 09-06 23:38: the cylinder was distracting)
  const laser = makePointerLine();
  laser.visible = false;
  ray.add(laser);
  rig.add(grip); rig.add(ray);
  return { grip, ray, laser, box };
}

/** Guarded rumble (porch-old _haptic): silently a no-op on pads without
 *  actuators. Staging doctrine per HIGGS: touch = light tick, take = firmer. */
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
  const hit = _rc.intersectObjects(roots, true)[0];
  let n = hit?.object;
  while (n && !n.userData.entityId) n = n.parent;
  return n ? { id: n.userData.entityId, dist: hit.distance, point: hit.point } : null;
}


// ---- panel grab: grip+trigger chord takes a QUAD to reposition it -----------
// World-object grabbing lived here too (near-grab, far-grab, the place verb + undo) and was removed
// whole (R 09-07 22:26: 'take the code out — it needs to be a proper object component, otherwise it's
// tech debt'). Panels are UI, not world entities: no verb, no undo, they just ride the hand and land
// uprighted on the rig. See git history (a2e25e2 and before) for the entity path when the component exists.
let held = null;   // {quad, hand}
function tryGrab(hand) {
  const h = hands[hand];
  const q = xrPanelsGrab(h.ray);
  if (!q) return;
  held = { quad: q, hand }; haptic(hand, 0.4, 30); h.grip.attach(q.mesh); flashHint(`holding the ${q.id} panel — release grip to place it`);
}
function releaseGrab() {
  if (!held) return;
  const p = xrPanelRelease(held.quad, rig);
  tee(`[xr] panel ${held.quad.id} placed at rig ${p.pos.join(',')} yaw ${p.yaw} pitch ${p.pitch}`);
  held = null;
}

// ---- radial menu: right-stick press opens, stick aims, release commits -----
// Every slot is verb-backed — an agent can speak each of these; the ring is
// just a hand-shaped way to say them. The dock has no body in VR: this ring
// is the dock, and 'panels' toggles the schema quads xrpanels.js carries.
/** The ring IS the dock rendered radially (R, 09-04 22:02): the same pins, in
 *  the same order, each slot opening that frame's quad. Rebuilt on every open
 *  so a pin toggled on the desk shows up here. The pinned trio glyphs lead,
 *  drawn from their own SVGs so the ring and the rail cannot drift; a frame
 *  with no VR surface yet is still a slot — dim, and honest about it — because
 *  parity means the gap is visible until the sweep fills it. sit/lie live in
 *  the emote quad now, not here. */
let ringLevel = 'root';   // 'root' | 'emotes' — the sub-wheel in view
const SPACER = { spacer: true, has: false, label: '', on: () => false, act: () => {} };
const BACK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 26 26" fill="none" stroke="#f2f7f5" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-7 7 7 7"/></svg>';
// THE WHEEL IS THE DOCK, plus what VR needs (R 09-07 22:08): 12 o'clock = the panels menu (the rail's reverse-E),
// 6 o'clock = leave VR; the dock's pins fill the right half, mic / ears / recentre the left; a dim spacer keeps the
// count even so the two fixed slots sit exactly on the vertical. 'emotes' is a sub-wheel (VRC's shape): the nine
// plus a back slot at 6 o'clock. Toggles stay open and show state; everything else closes on activation.
export function radialEntries() {   // exported with makeRadial for the headless ring screenshot
  if (ringLevel === 'emotes') {
    const e = ringEmoteEntries();                    // postures + emotes, bar order, 12 o'clock first
    const back = { svg: BACK_SVG, label: 'back', on: () => false, sub: 'root', act: () => {} };
    const half = Math.ceil(e.length / 2);
    const out = [...e.slice(0, half), back, ...e.slice(half)];
    if (out.length % 2) out.push(SPACER);
    return out;
  }
  const panels = { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 26 26"><text x="13" y="19.5" font-family="system-ui, sans-serif" font-size="19" font-weight="700" text-anchor="middle" fill="#f2f7f5">∃</text></svg>', label: 'panels', on: () => xrPanelsShown(), act: () => { bus.emit('xr:panels'); tee('[xr] panels toggled (ring)'); } };
  const leave = { svg: xrGlyph(52), label: 'leave VR', on: () => true, close: true, guard: true, act: () => leaveVR('ring') };   // guard: trigger only — a stick brush toward 6 o'clock threw R out (22:29)
  // emotes is its own strip on the desk, not a dock panel — a fixed slot, first on the right (1 o'clock)
  const right = [{ icon: 'hand-waving', label: 'emotes', sub: 'emotes', on: () => false, act: () => {} }];
  for (const e of dockPins()) {
    if (e.id === 'emotes') continue;   // the sub-wheel slot above IS emotes (R 09-07 22:57: 'you have emotes twice')
    const has = xrPanelHas(e.id);
    right.push({ icon: e.icon, label: e.id, has, on: () => xrPanelOpen(e.id), close: true,
      act: () => { if (has) showXRPanel(e.id); else tee(`[xr] ring: ${e.id} has no VR surface yet`); } });
  }
  const left = [
    { svg: RECENTRE_SVG, label: 'recentre', on: () => false, close: true, act: () => recentreXR('ring') },
    { svg: () => earGlyph(52), label: 'ears', on: earOn, act: () => flipEar() },   // svg as a FUNCTION: the slash follows the live state on every repaint (a toggle from the ring used to keep the open-time glyph)
    { svg: () => micGlyph(52), label: 'mic', on: micLive, act: () => bus.emit('xr:mic') },
  ];
  // balance: the same count each side (move dock pins over, then pad) so 'leave' lands on 6 o'clock
  while (right.length > left.length + 1) left.unshift(right.pop());
  while (right.length < left.length) right.push(SPACER);
  if (right.length > left.length) left.unshift(SPACER);
  return [panels, ...right, leave, ...left];   // clockwise from the top: right side descends 1→5, left ascends 7→11
}
const RECENTRE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 26 26" fill="none" stroke="#f2f7f5" stroke-width="1.6" stroke-linecap="round"><circle cx="13" cy="13" r="7"/><circle cx="13" cy="13" r="1.6" fill="#f2f7f5"/><path d="M13 2v4M13 20v4M2 13h4M20 13h4"/></svg>';
// THE RING as a MENU — porch-old's NESTED RADIAL v2 rules (index.html:7592–7770, headset testing
// 2026-07-12/14/15), eidoverse's tokens, the same slots as before (R 09-06 12:49–12:50):
//   · rides the RIGHT GRIP, anchored over the THUMB (0, +5 cm, +1 cm) — the digit making the choice;
//   · billboarded to the eyes every frame with HEADSET-up (wrist roll can't tilt it); de-rolled from the grip;
//   · R = 7.5 cm, 5 cm icon planes (depthTest off, renderOrder 999) — it draws over the world;
//   · focus: the slot scales 1.4× and swaps to the brand ink; a focus-label PILL under the ring names it
//     (07-15: "add words to the hover menus when an option is focused");
//   · deflect > 0.5 selects a sector, release < 0.35 commits (the stick driver below), hold-to-open (updateXR).
// Ink from the page's tokens: brand seafoam #8fe8c8, fg #ebebe9, panel rgb(5 20 20).
const RING_R = 0.075, RING_ICON = 0.05, RING_ANCHOR = { x: 0, y: 0.05, z: 0.01 };
const INK = { brand: '#8fe8c8', fg: '#ebebe9', dim: 'rgba(235,235,233,.42)', panel: 'rgb(5, 20, 20)', rule: 'rgba(143,232,200,.45)' };
let radial = null;   // {group, slots[], entries[], sel, label:{mesh,cv,tx}}
function ringIconTexture(s, focused) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const g = cv.getContext('2d'); const tex = new THREE.CanvasTexture(cv); tex.anisotropy = 4;
  // eidoverse cap: a soft panel disc so glyphs read against any world; brand ring when focused/on
  g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.fillStyle = INK.panel; g.fill();
  g.lineWidth = focused ? 6 : 3; g.strokeStyle = focused ? INK.brand : INK.rule; g.stroke();
  const on = !!s.on?.();
  const ink = s.has === false ? INK.dim : (focused || on ? INK.brand : INK.fg);
  g.save(); g.translate(64, 64); g.fillStyle = ink; g.strokeStyle = ink;
  // drawn glyphs, never fillText(emoji) (icons.js header; discovered live 08-05). Phosphor at the
  // dock's weights; the trio + recentre from their own SVGs via an Image (async — the texture updates).
  if (s.svg) {
    const img = new Image();
    img.onload = () => { g.save(); g.translate(64, 64); g.drawImage(img, -30, -30, 60, 60); g.restore(); tex.needsUpdate = true; };
    // an <svg> without xmlns renders INLINE but paints NOTHING as an <img> data-URI — mic/ears/VR came from the HUD's
    // inline glyphs and were the exact icons missing on the ring (R 09-07 23:34); the ∃/recentre/emote SVGs carried it
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
  // R 09-07 23:01: 'the little circles are z-fighting' — 5 cm discs on a 7.5 cm ring overlap past ~9 slots, and with
  // depthTest off and EQUAL renderOrder three re-sorts them by distance each frame as the billboard turns → the
  // overlaps flicker. The radius grows with the count so discs never overlap, and every slot has a STABLE order.
  const R = Math.max(RING_R, (N * RING_ICON * 1.15) / (2 * Math.PI));
  const slots = entries.map((s, i) => {
    const a = -Math.PI / 2 + i * (2 * Math.PI / N);   // porch: -π/2 first (top), then clockwise, placed at (cos a, −sin a)
    const m = new THREE.Mesh(new THREE.PlaneGeometry(RING_ICON, RING_ICON), new THREE.MeshBasicMaterial({ map: ringIconTexture(s, false), transparent: true, depthTest: false }));
    m.renderOrder = 1000 + i; m.userData.order = 1000 + i; m.position.set(Math.cos(a) * R, -Math.sin(a) * R, 0); m.userData.ring = a;
    if (s.spacer) m.visible = false;   // the balance spacer keeps the verticals true but must not read as a broken icon (ring screenshot 23:40)
    group.add(m); return m;
  });
  const label = ringLabel(); label.mesh.position.set(0, -R - 0.03, 0); group.add(label.mesh);
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
  if (nowMs - ring.actedAt < 250) return;          // one activation per gesture (two landed in a second, 22:29)
  const e = radial.entries[radial.sel];
  if (e.guard && cause !== 'trigger') { tee(`[xr] ring: ${e.label} needs the trigger (${cause} ignored)`); return; }
  ring.actedAt = nowMs;
  tee(`[xr] ring act → ${e.label} (${cause})`);
  haptic('right', 0.3, 20);
  try { e.act(); } catch (err) { tee(`[xr] ring act failed: ${err?.message ?? err}`); }
  if (!radialOpen || !radial) return;              // the act may have closed it (leave VR)
  if (e.sub) { ringLevel = e.sub; const sel = radial.sel; disposeRadial(); radial = makeRadial(radialEntries()); hands.right.grip.add(radial.group); radial.group.position.set(RING_ANCHOR.x, RING_ANCHOR.y, RING_ANCHOR.z); tickRadial(); tee(`[xr] ring → ${e.sub}`); return; }
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
/** per frame while open: top-up billboard to the eyes, de-rolled from the grip (porch-old _radialTick) */
function tickRadial() {
  if (!radial) return;
  const grip = hands.right?.grip; if (!grip) return;
  if (radial.group.parent !== grip) { grip.add(radial.group); radial.group.position.set(RING_ANCHOR.x, RING_ANCHOR.y, RING_ANCHOR.z); }
  const xc = renderer.xr.getCamera();
  _rc1.setFromMatrixPosition(xc.matrixWorld);                       // the eyes
  radial.group.getWorldPosition(_rc2);
  _rq1.setFromRotationMatrix(xc.matrixWorld);
  const headUp = _v2.set(0, 1, 0).applyQuaternion(_rq1);
  _rm.lookAt(_rc1, _rc2, headUp); _rq1.setFromRotationMatrix(_rm);   // eye=camera, target=group (porch's known-good order)
  grip.getWorldQuaternion(_rq2).invert();
  radial.group.quaternion.copy(_rq2.multiply(_rq1));
}
function aimRadial(x, y) {
  if (!radial) return;
  const mag = Math.hypot(x, y);
  let best = -1;
  if (mag > 0.5) {
    // porch: stick angle atan2(y, x) against each slot's ring angle (gamepad y is inverted, which matches the −sin placement)
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
let radialOpen = false, stickPressWas = false;
const triggerWas = { left: false, right: false };
// Buttons are NOT trusted for the first 700 ms after an input source appears: the gamepad's first
// frames report pressed=true garbage (R 09-06 11:35: 'panels toggled' fired by itself, sandwiched
// between the two connect lines; same family as the NaN axis). Edges inside the window are swallowed.
let inputsSettledAt = 0;
const buttonsTrusted = () => performance.now() > inputsSettledAt;

// ---- session ---------------------------------------------------------------
let sessionNo = 0;   // per page: tee() folds byte-identical lines (repeats 2–19 are DROPPED), so every entry line carries its number
async function enterVR() {
  try {
    // THE LADDER (R's first tee line, 09-04 23:20: Chrome 152 granted the
    // session WITHOUT the optional 'webgpu' feature and three refused it —
    // "WebGPU XR sessions require the webgpu session feature"). On a WebGPU
    // backend the feature is REQUIRED: a browser that can't grant it rejects
    // the request, and we reload onto the WebGL backend (?webgl=1), where
    // three's classic XRWebGLLayer path runs (and keeps MSAA — the porch A/B).
    // 'layers' deliberately absent on that path.
    const gpu = !!renderer.backend?.isWebGPUBackend;
    sessionNo++;
    tee(`[xr] enter #${sessionNo}: requesting session (${gpu ? 'WebGPU' : 'WebGL'}; renderer.xr.enabled=${renderer.xr.enabled}; presenting=${renderer.xr.isPresenting})`);   // 09-07 11:20: a re-entry went silent between here and 'session on' — which await hangs?
    const optionalFeatures = ['local-floor', 'bounded-floor', 'hand-tracking'];
    try {
      installRenderListTolerance();   // the tolerant render loop, only now that a session is about to exist
      session = await navigator.xr.requestSession('immersive-vr',
        gpu ? { requiredFeatures: ['webgpu'], optionalFeatures } : { optionalFeatures });
    } catch (e) {
      // R 09-07 10:46: a tab that reloaded into ?xr=1 while the previous page's session was still alive got
      // "already an active, immersive XRSession". The browser owns that session and offers no handle to it,
      // so the honest path is: say so, and retry once after a short wait for the old page to release it.
      if (e?.name === 'InvalidStateError' && /already an active/i.test(e?.message ?? '')) {
        if (!enterVR._retried) { enterVR._retried = true; tee('[xr] session busy (another page holds it) — retrying in 1500 ms'); toast('a previous VR session is still closing — retrying', 'info', 3000); setTimeout(() => { enterVR._retried = false; enterVR(); }, 1500); return; }
        toast('VR is still held by another tab — close it, then click the visor again', 'warn', 8000); tee('[xr] session busy after retry — giving up until the visor is clicked again'); return;
      }
      if (!gpu) { if (e?.name === 'NotSupportedError' || e?.name === 'NotFoundError' || /no.*(device|headset|runtime)|not supported|unavailable/i.test(e?.message ?? '')) { markXrAbsent(true); if (e && typeof e === 'object') e.userMessage = 'no headset detected — put it on (or wake it) and click the visor again'; } throw e; }   // the outer catch posts the one toast, preferring this text
      tee(`[xr] webgpu session refused (${e?.name ?? ''} ${e?.message ?? e}) — reloading on the WebGL backend`);
      toast('no WebGPU VR here — reloading on WebGL', 'info', 6000);
      const u = new URL(location.href); u.searchParams.set('webgl', '1'); u.searchParams.set('xr', '1'); u.searchParams.set('why', 'vr-webgl');
      setTimeout(() => { location.href = u; }, 1200);
      return;
    }
    try { localStorage.setItem('ew-headset-seen', '1'); } catch {}   // a REAL session, not a capability answer (phones say yes to Cardboard): next boot picks WebGL up front
    tee(`[xr] enter #${sessionNo}: session granted (${session.enabledFeatures?.length ?? '?'} features)`); markXrAbsent(false);
    renderer.xr.enabled = true;
    // Tier A6 (gap list 09-05): CHOOSE the floor reference space — before this it
    // was only requested, and three's default is 'local' (eye-level origin), so
    // the world's floor could sit anywhere relative to the real one. The type
    // must be set BEFORE setSession (three reads it as the session starts).
    const feats = session.enabledFeatures ?? [];
    const floor = feats.includes('local-floor') ? 'local-floor' : feats.includes('bounded-floor') ? 'bounded-floor' : null;
    try { renderer.xr.setReferenceSpaceType(floor ?? 'local'); } catch (e) { report('xr ref space', e); }
    floorSpace = floor;
    scaleState.samples.length = 0; scaleState.locked = false; scaleState.firstAt = 0; scaleState.k = 1; scaleState.source = 'fallback'; loadSavedScale();
    bus.emit('xr:loop');   // frame.js hands the loop to three BEFORE setSession saves+wraps it (see frame.js)
    const tReq = performance.now();
    // BEFORE setSession, so it runs BEFORE three's own 'end' listener (registered inside setSession), which restarts
    // the desktop loop through window.requestAnimationFrame: with the in-session shim still installed that restart
    // went to the dead session and no frame ever ticked again — R 09-07 22:41, after-exit frames+0 at +0.5 s AND +3 s
    sessionEnded = false;
    session.addEventListener('end', () => { sessionEnded = true; if (nativeRAF) { window.requestAnimationFrame = nativeRAF; window.cancelAnimationFrame = nativeCAF; } }, { once: true });
    await renderer.xr.setSession(session);
    tee(`[xr] enter #${sessionNo}: setSession resolved in ${(performance.now() - tReq).toFixed(0)} ms`);
    { const t = renderer.xr._xrRenderTarget; const fb = renderer._frameBufferTargets;
      tee(`[xr] enter #${sessionNo}: xrTarget ${t ? `${t.width}x${t.height} samples=${t.samples} type=${t.texture?.type} fmt=${t.texture?.format} cs=${t.texture?.colorSpace} multiview=${!!t.multiview}` : 'none'} renderer.samples=${renderer.samples}/${renderer._samples} fbts=${fb?.constructor?.name}:${fb?.size ?? '?'} layers=${renderer.xr._layers?.length ?? '?'} usesLayers=${renderer.xr._sessionUsesLayers}`); }
    entryClock = { t0: performance.now(), setSessionMs: +(performance.now() - tReq).toFixed(0), frames: [], last: 0, programs: 0, programMs: 0, pipelines: 0 };
    // ENTRY PROBE (R 09-06 13:35: 'might need a better probe'): count + time every program/pipeline the
    // backend builds while the entry clock runs — the 3 s first frame becomes 'N programs in X ms'.
    { const be = renderer.backend; if (be && !be.__entryProbe) { be.__entryProbe = true;
        for (const [k, field] of [['createProgram', 'programs'], ['createRenderPipeline', 'pipelines']]) { const orig = be[k]?.bind(be); if (!orig) continue;
          be[k] = (...a) => { const t = performance.now(); try { return orig(...a); } finally { buildTotals[field]++; if (field === 'programs') buildTotals.programMs += performance.now() - t; if (field === 'pipelines' && a[1] == null) { buildTotals.syncPipelines++; buildTotals.syncMs += performance.now() - t; } if (entryClock) { entryClock[field]++; if (field === 'programs') entryClock.programMs += performance.now() - t; } } }; } } }
    // ENTRY CURTAIN (R 09-06 13:34: 'a bespoke loading screen to cover the WebXR construct'): the first
    // presenting frames draw a cheap curtain to the eyes while the WHOLE scene compiles against the real
    // XR camera + target (compileAsync from inside an XR frame captures that context — the 13:20 pre-warm
    // into a plain RT missed the pipeline key). The world appears when the compile resolves; 6 s fallback.
    setXRCurtain(true); curtainState = { armed: true, t0: performance.now() };
    if (!floor) tee('[xr] NO floor reference space granted — using local (eye-level origin); floor height is a guess');
    const onLine = `[xr] session on ${renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL'} refspace=${floor ?? 'local'} features=${JSON.stringify(session.enabledFeatures ?? [])}`;
    console.log(onLine); tee(onLine);
    try { renderer.xr.setFoveation(0); } catch { /* not all runtimes */ }
    rig.position.set(myState.pos.x, myState.pos.y, myState.pos.z);
    recentre.x = recentre.z = recentre.y = 0; recentre.pending = true;   // fold the head's playspace pose in on the first tracked frame (C15)
    rig.rotation.y = wrapPi(myState.yaw);   // headset-forward = body-forward at entry, WRAPPED (R's recorder: root/rig 7.88 vs cam −1.6 → the pop)
    scene.add(rig);
    rig.add(camera);
    slots[0] ??= makeHand(0); slots[1] ??= makeHand(1);
    hands.left ??= slots[0]; hands.right ??= slots[1];   // guess until 'connected' files them by handedness
    presenting = true; bus.emit('xr:state', true);
    // HEADSET OFF (R 09-08 01:12: she switched the headset off after load; the session was still GRANTED — SteamVR
    // presents to nothing — and the visor lit as if she were in). The tell is that no viewer pose ever arrives
    // (the stereo camera keeps zero eyes). 2.5 s of that → say so, mark the visor absent, and leave.
    hadPose = false;
    const thisSession = sessionNo;
    setTimeout(() => {
      if (sessionNo !== thisSession || !presenting || hadPose) return;   // a later session is not this timer's to judge
      tee('[xr] no viewer pose 2.5 s after the session was granted — no headset; leaving');
      markXrAbsent(true); toast('no headset detected — put it on (or wake it) and click the visor again', 'warn', 8000);
      leaveVR('no-headset');
    }, 2500);
    // IN-SESSION CLOCK SHIM: window.requestAnimationFrame crawls at ~2 Hz during a WebXR session on R's rig
    // (09-07: 7 ticks in 3 s). Everything that yields on it stalls — three's parallel-link poll (so compileAsync
    // takes 7 s to resolve), the warm conductor (so no scene caster ever finishes its depth warm in VR: only her
    // avatar cast a shadow), r186's buildAsync fallback. Route it onto the session clock for the session's
    // duration; restored at teardown. Our own frame loop is unaffected (three's Animation holds the session).
    if (!globalThis.IWER) { const s = session;   // IWER emulates the session clock ON window.rAF — the shim would feed it to itself (bench crash 09-07 19:15); real runtimes have a native session clock
      if (!nativeRAF) { nativeRAF = window.requestAnimationFrame.bind(window); nativeCAF = window.cancelAnimationFrame.bind(window); }
      window.requestAnimationFrame = (cb) => { if (sessionEnded) return nativeRAF(cb); try { return s.requestAnimationFrame((t) => cb(t)); } catch { return nativeRAF(cb); } };
      window.cancelAnimationFrame = (id) => { try { s.cancelAnimationFrame(id); } catch {} try { nativeCAF(id); } catch {} }; }
    // SHADER ERROR TEE: a material that fails to compile/link in the eye buffers' context draws black
    // and the WebGL backend only console.error()s it — invisible from the operator's side. First 6 such lines tee.
    if (!consoleTapped) { consoleTapped = true; for (const k of ['error', 'warn']) { const orig = console[k].bind(console);
      console[k] = (...a) => { try { const m = a.map((x) => (typeof x === 'string' ? x : x?.message ?? '')).join(' '); if (presenting && shaderTees < 6 && /shader|program|link|compile|GLSL|uniform|invalid/i.test(m)) { shaderTees++; tee(`[xr] console.${k}: ${m.slice(0, 300)}`); } } catch {} orig(...a); }; } }
    // WE own the stereo camera update (render.js renderWorld → xr.updateCamera(camera)). With
    // cameraAutoUpdate on, three rebuilt cameraXR inside EVERY renderer.render() while presenting —
    // including ShadowNode's nested render with the light camera (parent null) → the eyes at the
    // playspace origin (R's Frame, 09-05 21:45–23:45: 'I pop to the origin', view-dependent).
    renderer.xr.cameraAutoUpdate = false;
    // three.webgpu also hands the shadow pass cameraXR instead of the light camera while presenting
    // (Renderer.js: camera = xr.getCamera() for any render) — shadow maps are wrong by construction
    // in XR, and cost a full scene pass per light per frame. Off while presenting.
    // R 09-07 18:30: 'leave everything alone.' shadowMap.enabled is pipeline-shape (lightrig.js:85) — flipping it
    // off here and back on at exit recompiled the whole scene at the first frame in BOTH directions: the hard
    // hangs in and out. Shadows now stay exactly as they are on the desktop. What that costs per frame in VR, and
    // whether three's XR-camera shadow pass looks wrong, is R's read (fps tee + eyes), not a claim.
    xrIntent.active = true;
    selfFirstPerson(true);
    xrPanelsEnter(rig);            // every registered frame as a physical surface
    session.addEventListener('end', () => {
      if (nativeRAF) { window.requestAnimationFrame = nativeRAF; window.cancelAnimationFrame = nativeCAF; }
      exitVeilShow(true);   // desktop feedback while the session tears down and the first desktop frames come back
      tee('[xr] session end — teardown begins');   // 09-06 23:43: a leave with no after-exit lines at all → was this handler even reached?
      try {
      presenting = false; bus.emit('xr:state', false); eyeBase = null; setXRCurtain(false); curtainState = null;
      renderer.xr.cameraAutoUpdate = true;
      xrIntent.active = false;
      if (radialOpen) closeRadial(false);   // a session the browser ended leaves the ring open and the stick owned by it
      resetFingers(getSelf()?.vrm);
      selfFirstPerson(false);
      { const v = getSelf()?.vrm; if (v) { v.scene.scale.setScalar(1); v.scene.position.set(0, 0, 0); v.scene.updateMatrixWorld(true); if (v.userData) { v.userData.ankleH = null; v.userData._gait = null; } } }   // the puppet scale AND the eye-anchor offset (xrbody writes vrm.scene.position every presenting frame; left in place it sank the feet on the desktop — R 09-08 00:38) are presenting things
      releaseGrab();      // a gripped panel goes back to the rig BEFORE the quads are disposed, or a dead mesh stays in the rig
      xrPanelsExit(rig);
      rig.remove(camera);
      scene.remove(rig);
      session = null;
      camera.position.set(3.5, 2.6, 5.5);
      // FISHEYE FIX (porch-old :925): WebXR overwrote the projection with the
      // HMD's ~110° matrices; position alone leaves the desktop view fisheyed.
      camera.fov = 60; camera.aspect = innerWidth / innerHeight; camera.zoom = 1;
      camera.updateProjectionMatrix();
      // Defensive: the canvas back to the window's size and ratio (three restores its own record; ours is the truth)
      try { renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(innerWidth, innerHeight); } catch (e) { report('xr exit resize', e); }
      // THE BLACK DESKTOP (R 09-06 12:46 → 23:43; reproduced 09-07 00:05 with an emulated headset, smoke/xr-exit-probe.mjs):
      // three's WebGL backend (0.185–0.186) keeps `_currentContext` = the last XR frame's render context after the session
      // ends (that frame's finishRender never ran). Every desktop render then ends with finishRender → _setFramebuffer
      // (deadXRContext) → drawBuffers → `WeakMap.set(undefined)` THROWS — nothing reaches the canvas while the HUD (DOM)
      // lives on. Drop the dead context; the next render starts clean. (Upstream: report against Renderer/XRManager.)
      try { const be = renderer.backend; if (be && be._currentContext && be._currentContext !== null) { const rt = be._currentContext.renderTarget; tee(`[xr] exit: dropping stale backend context (${rt?.isXRRenderTarget ? 'XR' : rt?.constructor?.name ?? 'canvas'})`); be._currentContext = null; }
        renderer.setRenderTarget(null);
      } catch (e) { report('xr exit context', e); }
      camera.quaternion.identity(); camera.scale.setScalar(1); camera.updateMatrixWorld(true);   // 00:05 trap: pos+quat were NaN after exit (follow-camera lerp from XR-era numbers)
      // AFTER-EXIT INSTRUMENT (R 09-06 12:46 + 13:20: 'black desktop after leaving VR, the world is inoperable'):
      // at +0.5 s and +3 s, tee what the desktop actually is — is the loop running, what did the last frame
      // draw, where is the camera, what size is the canvas, and a REAL pixel read of the canvas centre.
      const f0 = perf.frameNo ?? 0;
      // EXIT COST (R 09-07 18:20 'hard hangs in/out'): programs/pipelines built since teardown began (the
      // shadowMap.enabled restore is pipeline-shape — lightrig.js:85 — so a recompile lands on the first desktop
      // frame), and `held` = how late each timer fired versus its schedule — a client-side clock, so a frozen tab
      // shows as held time even when the block is in the GPU process (parallel shader link) and no longtask fires.
      const tExit = performance.now(); const c0 = { ...buildTotals };
      const probe = (tag, due) => {
        // the veil drops only when desktop frames are actually flowing (a timer-hide left R a black world with a
        // live HUD); a loop that is still dead at +3 s is re-armed and probed once more
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
    // Controller census: log each input source's claimed profiles + layout
    // once. Devices with no registry entry (Steam Frame, 2026) still speak
    // xr-standard; this line is how we learn what they actually expose.
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
    // a session that was GRANTED but whose setSession failed is alive and ours: end it, or the visor is dead
    // until reload (the browser answers every later request 'already an active immersive XRSession')
    if (session && !presenting) { try { session.end(); } catch { /* already ending */ } session = null; renderer.xr.enabled = false; }
    // the failure must OUTLIVE the glance (R, 09-04: "didn't see the error
    // for very long") — a sticky toast with the actual message, 30 s
    toast(e?.userMessage ?? `VR failed to start: ${e?.message ?? e}`, e?.userMessage ? 'warn' : 'err', e?.userMessage ? 8000 : 30000);
    tee(`[xr] ENTER FAILED: ${e?.name ?? ''} ${e?.message ?? e}`);
  }
}

/** The rig goes where the body is: the BODY's root offset by the head's playspace position (recentreXR),
 *  so the head — not the playspace origin — stands on myState.pos and turns pivot about the head. Called
 *  from xrbody BEFORE the head/arm solve (main.js runs `xrbody` inside updateMe, ahead of `xr`): read
 *  after the root moved but before the rig followed, the grips and the XR camera were one frame behind
 *  the body — at 4 m/s that is a 4–5 cm fore/aft error flipping sign every frame (R 09-06 12:53: 'hands
 *  stutter backwards and forwards while running'). Basis and porch-old both move the playspace first.
 *  Rebuilds the stereo camera from the fresh rig so the eye pose xrbody reads is this frame's. */
export function syncRigToBody() {
  if (!presenting) return;
  const c = Math.cos(rig.rotation.y), sn = Math.sin(rig.rotation.y);
  rig.position.set(myState.pos.x - (c * recentre.x + sn * recentre.z), myState.pos.y + recentre.y, myState.pos.z - (-sn * recentre.x + c * recentre.z));
  rig.updateMatrixWorld(true);
  renderer.xr.updateCamera(camera);
}
/** THE SMOOTH TURN, BEFORE THE BODY SOLVE (R 09-08 01:10: hands and hips shimmy on turns; frames even).
 *  xrbody solves the head anchor and the arms from the rig's pose, and it runs BEFORE updateXR — where the
 *  stick turn used to write the rig's yaw. So every frame the body was solved against LAST frame's yaw while
 *  the eyes rendered this frame's: the whole body one yaw-step behind the eyes, the hands (at arm's length)
 *  and the hips (a latch on the head) showing it. Same class as the running stutter (09-06 12:53; the rig
 *  followed the root a frame late) and the same cure: apply the turn first. xrbody calls this ahead of
 *  syncRigToBody; the input pass below skips the smooth turn on a frame this already handled. Snap turns
 *  stay in the input pass — a discrete step is not a per-frame lag. */
let turnEarlyFrame = -1;
let hadPose = false;   // a viewer pose has arrived this session (the eyes exist) — the headset is on someone's head
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
  // snap: the same bug at full size — a 30° step written after the body solve put the eyes 30° ahead of the
  // hands for one frame (R 09-08 01:32: 'much more off on one frame'). Same cooldown as the input pass.
  if (Math.abs(rx) > 0.6 && !snapState.cooling) {
    rig.rotation.y = wrapPi(rig.rotation.y - Math.sign(rx) * (SNAP_DEG * Math.PI) / 180);
    snapState.cooling = true;
    turnEarlyFrame = perf.frameNo ?? -1;
    turnTraceArm('snap');
  } else if (Math.abs(rx) < 0.3) snapState.cooling = false;
}
/** Per-frame while presenting. Order matters: read hands → fill intent →
 *  (controller.updateMe moves the body with THEIR loco) → rig follows body. */
// TURN BURST TRACE (R 09-07 22:28: 'avatar shimmies back and forth on turns; fine on locomotion'): the 5 s recorder
// cannot see a per-frame oscillation. Armed by a stick turn, 60 frames of rig yaw / hips yaw / root xz / head xz /
// rig xz tee as ONE line (cm, centi-radians), then it retires for 10 s. Read: does root or rig alternate sign frame to frame?
let turnTrace = null, turnTraceLast = 0;
function turnTraceArm(kind) { if (turnTrace || performance.now() - turnTraceLast < 10000) return; turnTrace = { kind, rows: [], d: 0, dt: null }; }
function turnTraceInput(d, dt) { if (turnTrace) { turnTrace.d = d; turnTrace.dt = dt; } }
function turnTraceTick() {
  if (!turnTrace) return;
  const av = getSelf(); const hips = av?.vrm?.humanoid?.getNormalizedBoneNode('hips'); const root = av?.root;
  const hy = hips ? Math.atan2(hips.getWorldDirection(_v).x, hips.getWorldDirection(_v).z) : 0;
  const rp = root ? root.getWorldPosition(_v2) : _v2.set(0, 0, 0);
  const hp = renderer.xr.getCamera().matrixWorld.elements;
  // the HANDS (R 09-08 00:43: 'it's the hands I see shimmying'): VRM right hand bone vs the right grip, world, mm —
  // sign-alternating frame to frame = an ordering bug (xrbody solves the arms BEFORE xr writes the turn); a steady
  // offset = the solver; a growing one = lag
  let hd = 'u';
  { const g = hands.right?.grip, hb = av?.vrm?.humanoid?.getNormalizedBoneNode('rightHand');
    if (g && hb) { g.getWorldPosition(_v); hb.getWorldPosition(_v2); _v2.sub(_v); hd = `${Math.round(_v2.x * 1000)}:${Math.round(_v2.y * 1000)}:${Math.round(_v2.z * 1000)}`; } }
  turnTrace.rows.push(`${Math.round(rig.rotation.y * 100)},${Math.round(camYawWorld() * 100)},${Math.round((turnTrace.d || 0) * 100)},${turnTrace.dt == null ? 'u' : Math.round(turnTrace.dt * 1000)},${Math.round(hy * 100)},${Math.round(rp.x * 100)},${Math.round(rp.z * 100)},${Math.round(hp[12] * 100)},${Math.round(hp[14] * 100)},${Math.round(rig.position.x * 100)},${Math.round(rig.position.z * 100)},${hd}`);
  if (turnTrace.rows.length >= 60) { try { const sys = (Array.isArray(frameDebug?.()) ? frameDebug() : (frameDebug?.()?.systems ?? [])).map((x) => [x.name, +(x.ms ?? 0).toFixed(2)]).sort((a, b) => b[1] - a[1]).slice(0, 6); tee(`[xr] turn-trace systems (rolling ms, top 6): ${sys.map(([n, m]) => `${n}=${m}`).join(' ')} draws=${renderer.info.render.calls}`); } catch {} tee(`[xr] turn-trace ${turnTrace.kind} (rigYaw,camYaw,stick×100,dtMs|u,hipsYaw,rootX,rootZ,headX,headZ,rigX,rigZ,handΔx:y:z mm; angles×100, m×100): ${turnTrace.rows.join(' ')}`); turnTrace = null; turnTraceLast = performance.now(); }
}
function camYawWorld() { const e = renderer.xr.getCamera().matrixWorld.elements; return Math.atan2(-e[8], -e[10]); }   // world yaw of the HMD's -Z
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));   // every yaw write wraps: an unwrapped body yaw (7.88 = 1.6 + 2π on R's recorder) met a wrapped camera yaw and 'popped' a full turn
// ---- recentre / seated (gap list C15; Basis: seated suppresses height capture) ----------
// The headset sits wherever the human is in the playspace; the rig is the body's root. Without
// this the root stands on myState.pos while the visible body (eye-anchored under the head) stands
// a step away — colliders, the wire `p`, and every turn pivot are off by the human's drift. Recentre
// measures the head's RIG-LOCAL pose once and folds it into the rig every frame: head xz lands on
// myState.pos (turns then pivot about the head), and in seated mode the rig is lifted so the head
// reads at the avatar's standing eye height — the body stands, the knees don't bend for the rest
// of the session. Runs once on entry, and on the ring / Settings › VR verb. Pure math in
// recentreSolve (smoke/recentre-probe.mjs).
// NEVER yaw the rig for a body (Basis: the tracking space is only ever turned by the stick; a head
// that faces away from the root is the torso latch's job). An earlier version rotated the rig by
// (bodyYaw − headYaw) here — the camera is a child of the rig, so entering physically turned 60°
// would have spun the world 60° on frame one. Removed 09-06 10:48 before it was ever felt.
const recentre = { x: 0, y: 0, z: 0, pending: false };
/** @returns {{x,z,y}} rig-local head xz to fold in; y lift (seated only). No yaw: the rig is stick-only. */
export function recentreSolve({ headLocal, seated, standingEyeY }) {
  const y = seated && standingEyeY > 0.5 && headLocal.y > 0.3 ? standingEyeY - headLocal.y : 0;
  return { x: headLocal.x, z: headLocal.z, y };
}
const _hl = new THREE.Vector3();
export function recentreXR(why = 'verb') {
  if (!presenting) return false;
  const cam = renderer.xr.getCamera();
  _hl.setFromMatrixPosition(cam.matrixWorld);
  rig.updateMatrixWorld(true); rig.worldToLocal(_hl);           // head in rig space == the playspace: the rig's origin is root − R·recentre (syncRigToBody), so the offset is already out
  if (![_hl.x, _hl.y, _hl.z].every(Number.isFinite)) return false;
  // A tracked head stands on a floor-referenced space at ~1–2 m and within a room of the origin. On the
  // first presenting frames the XR camera has NO pose yet — its matrix is still the desktop camera at the
  // world origin, so 'rig-local head' comes out as minus the rig's own position (R, 09-06 11:24: 'head at
  // playspace 3.43,0.00,-43.50' — 43 m folded into the rig on entry). Not a head: refuse, and if this was
  // the entry pass, try again next frame.
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
export const xrRecentre = () => ({ ...recentre });
/** The one exit. Every path (visor glyph, ring, controller hold) ends here and says so. */
let lastLeaveAt = -1e9;
export function leaveVR(why = 'verb') {
  if (!session) { tee(`[xr] leave (${why}): no session`); return false; }
  tee(`[xr] leave (${why})`);
  lastLeaveAt = performance.now();
  exitVeilShow(true);   // from the CLICK, not the 'end' event — session.end() takes a moment and that moment read as nothing happening (R 22:57)
  try { const p = session.end(); p?.catch?.((e) => tee(`[xr] leave (${why}) rejected: ${e?.message ?? e}`)); } catch (e) { tee(`[xr] leave (${why}) threw: ${e?.message ?? e}`); }
  return true;
}
// ENTRY CLOCK (R 09-06 12:08: 'a LONG time to enter VR, 5–6 s of bare WebXR construct'): from setSession
// resolving to our first presenting frame, then the first eight frame gaps — a compile stall shows as
// one huge gap; a runtime stall shows as the t0→first gap. One tee line, then it retires.
let entryClock = null;
const buildTotals = { programs: 0, programMs: 0, pipelines: 0, syncPipelines: 0, syncMs: 0 };   // sync = created with promises===null on a render frame (blocking link)   // lifetime — the exit probe reads deltas off it (entryClock is nulled 12 s after entry)
let curtainState = null;   // { armed, t0 } — the compile kicks off on the first presenting frame
let eyeBase = null;
let consoleTapped = false, shaderTees = 0;
let turnMag = 0;                    // |stick-X| while smooth-turning — the vignette reads it
export const turnMagnitude = () => turnMag;
export function updateXR(dtSec = 1 / 72) {
  if (!presenting) { turnMag = 0; return; }
  renderCensusTick();
  // EYE WATCH (R 09-06 12:22: 'spontaneously each eye becomes extremely fish-eyed; right eye visible in the
  // left'): per frame, not per 5 s — the first sample is the baseline; any eye whose vertical fov moves
  // more than 5° or whose viewport changes shape tees ONE line with both eyes' fov, viewport, and the last
  // foreign render, then re-arms when it returns to baseline.
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
    // The curtain holds until the entry compileAsync RESOLVES (cap 15 s), then drops after ≥2 presenting
    // frames. It used to drop after 2 frames flat, because the promise could not resolve in-session: three's
    // parallel-link poll reschedules on window.requestAnimationFrame, which crawls at ~2 Hz in a WebXR session on
    // R's rig (measured 09-07: 7 ticks in 3 s) — so the world's first frame found nothing linked and built 25
    // pipelines synchronously (6.9 s, measured: 'sync pipelines total 25 (6894 ms)'). Now window.rAF is routed
    // onto the session clock while presenting (see the shim after setSession), the poll runs at frame rate, the
    // promise resolves in-session, and the first world frame finds its pipelines linked.
    const t0 = performance.now(); const f0 = perf.frameNo ?? 0; const clock = entryClock;
    curtainState = { down: false, resolved: false, t0, f0, clock };
    { let ticks = 0; const tw = performance.now(); const tick = () => { ticks++; if (performance.now() - tw < 3000) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
      const tc = performance.now(); const pr = renderer.compileAsync(scene, renderer.xr.getCamera(), scene);
      pr.then(() => { tee(`[xr] entry compile resolved ${(performance.now() - tc).toFixed(0)} ms after arm (presenting=${presenting})`); if (curtainState) curtainState.resolved = true; })
        .catch((e) => { report('xr entry compile', e); if (curtainState) curtainState.resolved = true; });
      setTimeout(() => tee(`[xr] window.rAF in-session: ${ticks} ticks in 3 s; sync pipelines ${buildTotals.syncPipelines} (${buildTotals.syncMs.toFixed(0)} ms)`), 3200); }
  }
  if (curtainState && !curtainState.armed && !curtainState.down) {
    const frames = (perf.frameNo ?? 0) - curtainState.f0, ms = performance.now() - curtainState.t0;
    if ((curtainState.resolved && frames >= 2) || ms > 15000) {
      curtainState.down = true; setXRCurtain(false);
      const clock = curtainState.clock;
      tee(`[xr] curtain #${sessionNo} down (${curtainState.resolved ? 'compile resolved' : 'CAP 15 s'}) after ${ms.toFixed(0)} ms — sync pipelines so far ${buildTotals.syncPipelines} (${buildTotals.syncMs.toFixed(0)} ms), frames under it ${frames}, programs ${clock?.programs ?? '?'} in ${clock?.programMs?.toFixed(0) ?? '?'} ms, pipelines ${clock?.pipelines ?? '?'}`);
    }
  }
  if (entryClock) { const now = performance.now(); entryClock.frames.push(+(now - (entryClock.last || entryClock.t0)).toFixed(0)); entryClock.last = now;
    if (entryClock.frames.length === 8) { tee(`[xr] entry: setSession ${entryClock.setSessionMs} ms; first frame +${entryClock.frames[0]} ms; next gaps ${entryClock.frames.slice(1).join(',')} ms; programs so far ${entryClock.programs} (${entryClock.programMs.toFixed(0)} ms), pipelines ${entryClock.pipelines}; sync pipelines total ${buildTotals.syncPipelines} (${buildTotals.syncMs.toFixed(0)} ms)`); } }
  if (entryClock && (entryClock.frames.length > 120 || performance.now() - entryClock.t0 > 12000)) entryClock = null;   // the probe retires after 12 s (the line above tees ONCE, at frame 8 — it teed every frame for 12 s on 09-06 23:34)
  if (!xrPrefs.seated) { const e = renderer.xr.getCamera().matrixWorld.elements; const hy = e[13] - rig.position.y; if (Number.isFinite(hy)) sampleDeviceScale(hy); }   // Basis: seated suppresses height capture
  sampleFingerCurl();
  if (recentre.pending) { recentre.pending = false; recentreXR('entry'); }

  // head yaw becomes the movement frame: stick-forward = where you look.
  // Read the -Z column of matrixWorld DIRECTLY: getWorldDirection() calls
  // updateWorldMatrix(), which clobbers the XR-set matrix and freezes forward
  // at north (porch-old :9948, a debugged-for-days bug — not a style choice).
  const me_ = camera.matrixWorld.elements;
  _v.set(-me_[8], -me_[9], -me_[10]);
  // NaN passes `< 1e-6` (every comparison with NaN is false): a frame whose
  // XR camera matrix is momentarily NaN (tracking loss, the hand-mesh
  // compile spike) poisoned camYaw → updateMe rotated the move vector by NaN
  // → myState.pos = [NaN, 0, NaN] → camera.far NaN → three threw in render
  // (R's recorder, 09-04 23:50). Keep the last good yaw on a bad frame.
  const yaw = Math.atan2(_v.x, _v.z) + Math.PI;
  if (Number.isFinite(yaw) && _v.lengthSq() > 1e-6) {
    setCamYaw(yaw);   // orbit yaw (= facing + π) for the walk direction ONLY; the body's yaw is not driven from here
  }

  // and if a NaN slipped into the body anyway, put it back on the last good
  // spot rather than let it poison every matrix downstream
  if (Number.isFinite(myState.pos.x) && Number.isFinite(myState.pos.z)) lastGood.copy(myState.pos);
  else { tee(`[xr] myState.pos NaN — restored to ${lastGood.x.toFixed(1)},${lastGood.z.toFixed(1)} (speed ${myState.speed}, camYaw ${camYaw}, intent ${xrIntent.fwd},${xrIntent.strafe})`); myState.pos.copy(lastGood); }
  // speed is a lerp accumulator: one NaN in it is permanent (every compare with NaN is false), and re-poisons pos every frame
  if (!Number.isFinite(myState.speed)) myState.speed = 0;
  if (!Number.isFinite(camYaw)) setCamYaw(0);

  // sticks → intent (deadzone-with-rescale; snap cooldown — exultation math)
  const L = sourceFor('left')?.gamepad, R = sourceFor('right')?.gamepad;
  if (L) {
    xrIntent.fwd = dead(-pickAxis(L.axes[3], L.axes[1]));
    xrIntent.strafe = dead(pickAxis(L.axes[2], L.axes[0]));
    // jump = A or X (porch-old: 'A / X = jump'; VRChat: A). No invented bindings on the sticks (R 09-06 12:37:
    // 'we shouldn't mess with the default VR affordances') — panels live on the ring.
    xrIntent.jump = !!L.buttons[4]?.pressed || !!R?.buttons[4]?.pressed;
  } else { xrIntent.fwd = 0; xrIntent.strafe = 0; xrIntent.jump = !!R?.buttons[4]?.pressed; }
  if (R) {
    const rx = dead(pickAxis(R.axes[2], R.axes[0]));
    const ry = dead(pickAxis(R.axes[3], R.axes[1]));
    const pressed = !!R.buttons[3]?.pressed;              // thumbstick click
    // CLICK / LATCH / TRIGGER (R 09-07 21:56, replacing hold-aim-release: 'I hate the VRChat action menu').
    //   · stick CLICK opens; stick click again closes; grip cancels; 12 s without stick or trigger closes (the
    //     09-04 click-toggle stuck open — every close path here tees its cause so a stuck ring is diagnosable);
    //   · AIM latches: deflect > 0.5 picks the sector and the pick STAYS when the stick springs back — a choice is
    //     a state, not a held pose (the stick is exhausting to hold; a lit slot costs nothing);
    //   · TRIGGER activates the latched slot. Toggles (mic, ears, panels) stay open and repaint their state;
    //     one-shots (recentre, opening a panel) close on activation — Resonite's CloseMenuOnPress, per item;
    //   · FLICK: deflect and return to centre within 220 ms activates without the trigger;
    //   · compat: release the CLICK while still deflected within 700 ms of opening → commit + close (the old
    //     hold-aim-release muscle memory keeps working).
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
      // smooth turn: the rig yaws continuously with the stick (R's own mode)
      const d = dead(rx);
      if (d && turnEarlyFrame !== (perf.frameNo ?? -2)) { rig.rotation.y = wrapPi(rig.rotation.y - d * SMOOTH_TURN_RAD_S * (dtSec ?? 1 / 72)); turnTraceArm('smooth'); turnTraceInput(d, dtSec); }   // applied early this frame (applyTurnEarly) → no second step
      turnMag = Math.abs(d);
    }
    else if (Math.abs(rx) > 0.6 && !snapState.cooling && turnEarlyFrame !== (perf.frameNo ?? -2)) {
      // snap turns the RIG — the world pivots around the body. camYaw belongs
      // to the head (head-following rewrites it every frame), and the camera
      // rides the rig, so the head's world yaw inherits the snap on its own.
      // (normally applied EARLY by applyTurnEarly, ahead of the body solve; this is the no-body path)
      rig.rotation.y = wrapPi(rig.rotation.y - Math.sign(rx) * (SNAP_DEG * Math.PI) / 180);
      snapState.cooling = true;
      turnTraceArm('snap');
    } else if (Math.abs(rx) < 0.3) snapState.cooling = false;
    stickPressWas = pressed;
    if (xrIntent.fwd || xrIntent.strafe || turnMag || pressed) markActive();   // sticks are input too: a presenting person is not 'away' (presence.js listens to DOM events only)

    // pointer + grab chord on BOTH hands (Tier B7 — the left was a stick and one
    // button). Either hand can aim, select, and take a panel; one thing held at a time. The ring stays on the right.
    for (const side of ['right', 'left']) {
      const G = side === 'right' ? R : L; const hand = hands[side];
      if (!G || !hand) continue;
      const grip = !!G.buttons[1]?.pressed, trig = !!G.buttons[0]?.pressed;
      hand.laser.visible = grip || trig;
      hand.box.visible = !getSelf()?.vrm;   // a body owns the hands → no test box
      if (!buttonsTrusted()) { triggerWas[side] = trig; continue; }
      if (grip && trig && !held) tryGrab(side);   // panels only
      if (!grip && held?.hand === side) releaseGrab();
      if (trig && !triggerWas[side] && !grip && !(radialOpen && side === 'right')) {
        // panels claim the laser before the world does — a click meant for a
        // stepper must never select the mountain behind it
        const panelDist = xrPanelsPick(hand.ray, true);
        if (panelDist != null) haptic(side, 0.3, 18);   // a button, felt
        if (panelDist == null) {
          const hit = rayHitEntity(hand.ray);
          if (hit) { bus.emit('xr:select', hit.id); flashHint(`→ ${hit.id}`); }
        }
      }
      if (hand.laser.visible) {
        const panelDist = xrPanelsPick(hand.ray, false);
        if (side === 'right' && panelDist != null && !radialOpen && Math.abs(ry) > 0.3) domQuadsScroll(hand.ray, ry * 900 * (dtSec ?? 1 / 72));   // R 09-07 22:57: stick Y scrolls the panel under the laser
        const hit = panelDist == null ? rayHitEntity(hand.ray, 40) : null;
        // R 09-07 22:10: short and faint unless it points at something you can act on — porch-old's 1.8 m
        // idle beam; a panel or an entity under the ray draws it out to the hit at full strength
        const target = panelDist ?? hit?.dist ?? null;
        hand.laser.scale.z = target ?? 1.8;
        hand.laser.userData.opacity.value = target != null ? 0.85 : 0.4;
      }
      triggerWas[side] = trig;
    }
  }

  // eye cameras see the first-person split, never the third-person head.
  // r185 re-derives per-eye masks from the BASE camera every frame
  // (XRManager: cameraXR.layers.mask = camera.layers.mask | 0b110), so the
  // r184-era per-eye enable() was stomped one frame later. Drive the BASE
  // camera instead and let three propagate. Restored on session end.
  if (fpVrm !== getSelf()?.vrm) selfFirstPerson(true);   // avatar swapped mid-session → chop the new head
  hookSelfDraws(); selfDrawnLast = selfDrawn; selfDrawn = 0;

  // the body moved by THEIR controller code; the rig goes where the body is
  // porch-old's rule (index.html:11034–11072, verified 09-05): the RIG IS STICK-ONLY. Nothing reads the head
  // and writes the rig or the body root; the VRM chases the head INSIDE the root (xrbody.js).
  // the rig is the BODY's root offset by the head's playspace position (recentreXR), so the
  // head — not the playspace origin — stands on myState.pos, and turns pivot about the head
  syncRigToBody();   // (again, after a snap/smooth turn above changed rig.rotation)
  // — three's XRManager builds cameraXR from camera.parent.matrixWorld
  turnTraceTick();

  // three pushes camera.near/far into session.updateRenderState every frame
  // it changes; a non-finite value throws INSIDE render and the headset
  // freezes (R's tee, 09-04 23:50: "depthFar … non-finite"). Nothing of ours
  // writes camera.far directly, so restore sane planes and record what was
  // found — the writer is still being hunted.
  if (!Number.isFinite(camera.near) || !Number.isFinite(camera.far) || camera.far <= camera.near) {
    tee(`[xr] camera planes non-finite: near=${camera.near} far=${camera.far} — restored`);
    camera.near = 0.15; camera.far = 20000; camera.updateProjectionMatrix();
  }

  // FLIGHT RECORDER: one line every 5 s while presenting — numbers where a
  // headset gives adjectives ("janky", "no avatar"). Read it out of the
  // desktop console after the session.
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
      rigWorld: (() => { const e = rig.matrixWorld.elements; return [+e[12].toFixed(2), +e[13].toFixed(2), +e[14].toFixed(2)]; })(), rigAuto: rig.matrixAutoUpdate, rigWAuto: rig.matrixWorldAutoUpdate, sceneWAuto: scene.matrixWorldAutoUpdate,   // is the rig's WORLD matrix ever computed? (eyes at origin, 23:20)
      eyes: (() => { const xc = renderer.xr.getCamera(); return (xc.cameras ?? []).map((c) => { const e = c.matrixWorld.elements; return [+e[12].toFixed(2), +e[13].toFixed(2), +e[14].toFixed(2)]; }); })(),   // PER-EYE world positions — what actually renders
      baseCam: (() => { const e = camera.matrixWorld.elements; return [+e[12].toFixed(2), +e[13].toFixed(2), +e[14].toFixed(2)]; })(),
      pitch: +(() => { const e = renderer.xr.getCamera().matrixWorld.elements; return Math.asin(Math.max(-1, Math.min(1, -e[9]))); })().toFixed(2),   // HMD pitch (rad), + = looking up
      camWorld: (() => { const e = renderer.xr.getCamera().matrixWorld.elements; return [+e[12].toFixed(2), +e[13].toFixed(2), +e[14].toFixed(2)]; })(),   // the EYES in world space — a 'pop to origin' that the rig doesn't show
      rootPos: av ? [+av.root.position.x.toFixed(2), +av.root.position.y.toFixed(2), +av.root.position.z.toFixed(2)] : null,
      vrmOff: av?.vrm ? [+av.vrm.scene.position.x.toFixed(2), +av.vrm.scene.position.y.toFixed(2), +av.vrm.scene.position.z.toFixed(2)] : null,   // the eye anchor's offset inside the root   // the facing triple (R's 'pop to origin' hunt, 09-05)
    });
    console.log('[xr:rec]', rec); tee(`[xr:rec] ${rec}`);
  }
}
let recAt = 0;

// XR PIPELINE PRE-WARM (entry clock, R 09-06 12:33: setSession 4 ms, first frame +45 ms, then ONE 5524 ms
// frame — every material compiling for the eye buffers' render context on the first presenting draw).
// On an XR boot, once my body is in, compile the whole scene ONCE into a render target shaped like the
// eye buffers (RGBA8, depth, 4× MSAA) while the desktop is still idle-waiting on the visor. If the
// pipeline cache keys match, entry loses the 5 s frame; the entry clock is the verdict either way.
let xrWarmed = false;
function warmXRPipelines() {
  if (xrWarmed || !XR_BOOT || presenting || !getSelf()?.vrm) return;
  xrWarmed = true;
  warm('xr pipelines', async () => {
    // R's headset 09-07 19:00 settled it: three builds its WebGL-XR target at samples=0 (attributes.antialias
    // came back false for the XR context) with colorSpace=renderer.outputColorSpace. Our warm RT was samples=4,
    // cs=(default) → every pipeline key missed → all ~44 programs rebuilt at ENTRY, on the session rAF, starving
    // three's parallel-compile poller (56–73 s to finish). Match three's target so the warm actually primes the cache.
    const rt = new THREE.RenderTarget(64, 64, { samples: 0, depthBuffer: true, stencilBuffer: renderer.stencil, colorSpace: renderer.outputColorSpace });
    const prev = renderer.getRenderTarget(); const prevSamples = renderer._samples; renderer._samples = 0;   // the cache key reads renderer.currentSamples when no RT is bound; the XR session runs at 0, so warm at 0
    const t0 = performance.now();
    try { renderer.setRenderTarget(rt); await renderer.compileAsync(scene, renderer.xr.getCamera?.() ?? camera, scene); }
    catch (e) { report('xr pipeline warm', e); }
    finally { renderer.setRenderTarget(prev); renderer._samples = prevSamples; rt.dispose(); }
    tee(`[xr] pipelines pre-warmed for the eye buffers in ${(performance.now() - t0).toFixed(0)} ms — warm RT: samples=${rt.samples} fmt=${rt.texture?.format} type=${rt.texture?.type} cs=${rt.texture?.colorSpace} depth=${rt.depthBuffer} stencil=${rt.stencilBuffer} (matched to three XR target; entry should now show programs≈0)`);
  }, { p: P_AMBIENT });
}
export async function initXR() {
  if (!navigator.xr) return;
  let supported = false;
  try { supported = await navigator.xr.isSessionSupported('immersive-vr'); }
  catch (e) { report('xr support probe', e); }
  if (!supported) return;

  // the third glyph of the mic/ear trio — the same ink, the same slot
  // layout, the same pin row in the ∃ menu (R, 09-04). Exists only here,
  // where the browser answered that a headset can present.
  // PRE-WARM the hand meshes: their first draw compiled two materials on the
  // frame the controllers arrived — a 0.5 s spike (R's recorder 09-04 23:50)
  // that is exactly the kind of frame whose camera matrix comes back NaN.
  // Build the hands now (controller groups exist without a session), park
  // them under the rig, and let the conductor compile them off-screen.
  slots[0] ??= makeHand(0); slots[1] ??= makeHand(1);
  hands.left ??= slots[0]; hands.right ??= slots[1];
  warm('xr hands', async () => {
    // the avatar warm's form: object + camera + the lit scene, frustumCulled
    // off so a parked (stale-matrix) mesh isn't culled out of the compile walk
    const meshes = []; rig.traverse((o) => { if (o.isMesh) meshes.push(o); });
    for (const m of meshes) { m.frustumCulled = false; try { await renderer.compileAsync(m, camera, scene); } catch { /* fine */ } }
  }, { p: P_AMBIENT });

  if (XR_BOOT) { const iv = setInterval(() => { warmXRPipelines(); if (xrWarmed) clearInterval(iv); }, 500); }   // body arrives seconds after boot; poll until it does
  registerXrGlyph({
    // ?xr=1 alone is enough: core.js picks the backend that can present (WebGL until Chrome's
    // WebGPU-XR ships unflagged; ?webgpu=1 opts in early).
    onclick: () => {
      if (presenting) { leaveVR('visor'); return; }
      // R 09-07 22:29: a ring leave was followed by an 'enter #2' inside the same second — a live session with
      // nobody in the headset = dark desktop, working HUD. Once the session ends the page is a 2D panel again
      // and a controller trigger IS a click wherever the pointer sits. Nothing meant that; refuse for 1.5 s.
      if (performance.now() - lastLeaveAt < 1500) { tee('[xr] visor: enter ignored (left VR less than 1.5 s ago)'); return; }
      if (XR_BOOT) { enterVR(); return; }
      // Already on WebGL? Nothing to swap — enter in place, no page reload (R 09-07: kill the reload tax).
      if (!renderer.backend?.isWebGPUBackend) { tee('[xr] visor: enter in place (WebGL, no reload)'); enterVR(); return; }
      const swap = !!renderer.backend?.isWebGPUBackend;
      const why = swap ? 'vr-webgl' : 'vr';
      toast(swap ? 'restarting on WebGL 2 for VR — this browser can\'t present VR from WebGPU yet' : 'restarting in VR mode', 'info', 4000);
      tee(`[xr] visor: reload (${why})`);
      const u = new URL(location.href); u.searchParams.set('xr', '1'); u.searchParams.set('why', why);
      setTimeout(() => { location.href = u; }, 700);
    },
    live: () => presenting,
  });
  setXrProbe(() => presenting);
}

/** harness window */
export const xrDebug = () => {
  const ring = radialEntries().map((e) => ({ label: e.label, has: e.has !== false, on: !!e.on?.() }));
  const gp = new THREE.Vector3();
  hands.right?.grip.getWorldPosition(gp);
  return { ring,
    presenting, held: held?.quad?.id ?? null, radialOpen,
    radialSel: radial?.sel ?? null,
    rigYaw: +rig.rotation.y.toFixed(3),
    laserOn: hands.right?.laser.visible ?? false,
    gripWorld: [+gp.x.toFixed(2), +gp.y.toFixed(2), +gp.z.toFixed(2)],
  };
};


// Desktop veil for the way OUT (R 09-07 18:20: 'loading in/out indicator, hard hangs'): a full-window
// 'Leaving VR…' from the moment the session ends until the first after-exit probe (desktop frames flowing).
function exitVeilShow(on) {
  if (!exitVeil) {
    exitVeil = document.createElement('div'); exitVeil.textContent = 'Leaving VR…';
    exitVeil.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:var(--bg,#0b0f12);color:var(--fg,#dfe7ea);font:600 22px system-ui,sans-serif;letter-spacing:.02em;pointer-events:none;opacity:0;transition:opacity .2s';
    document.body.appendChild(exitVeil);
  }
  exitVeil.style.opacity = on ? '1' : '0';
}
