// xr-scale — the device scale: the avatar fitted to the player's measured eye height, saved per body.
import { THREE } from '../core.js';
import { CONFIG, bus, tee, wornNameOf } from '../base.js';

// what the device scale reads of the session and the self body: xr.js binds it (bindScaleHost), never read from xr.js
let scaleHost = { presenting: () => false, self: () => null };
export function bindScaleHost(host) { scaleHost = host; }
// ---- device scale (Basis BasisHeightDriver: the avatar is scaled to the player)
// k = avatarEyeY / median of the first 120 HMD heights (> 0.5 m; fewer, at least 30, once 3 s have passed, so a slow
// frame rate locks sooner), clamped .6–1.6, saved per avatar. The puppet is
// scaled (vrm.scene.scale = 1/k), never the tracking, so hands sit on the controllers. Restored on session end.
const SCALE_LS = 'ew-xr-scale';
let wornName = '';   // the per-body key for a saved scale
export const scaleState = { k: 1, source: 'fallback', samples: [], eyeY: null, locked: false, firstAt: 0 };
// a body swap while presenting re-measures: the new body must not wear the old body's ratio
bus.on('avatar-worn', (v) => { wornName = wornNameOf(v); if (!scaleHost.presenting()) return; scaleState.samples.length = 0; scaleState.locked = false; scaleState.firstAt = 0; scaleState.k = 1; scaleState.source = 'fallback'; loadSavedScale(); tee('[xr] body swapped while presenting — device scale re-measured'); });
const xrScale = () => ({ ...scaleState, samples: scaleState.samples.length });
/** The multiplier the self puppet wears while presenting (Basis: avatar scaled to the player). 1 when unmeasured. */
export const puppetScale = () => (scaleHost.presenting() && scaleState.k > 0 ? 1 / scaleState.k : 1);
// harness hook (?xrsim only): feed HMD heights without waiting on a slow headless frame rate
export const xrSimSample = (y) => { if (CONFIG.params.has('xrsim')) sampleDeviceScale(y); };
export function avatarEyeY() {
  const av = scaleHost.self(); const h = av?.vrm?.humanoid;
  if (!h) return null;
  const root = av.vrm.scene.getWorldPosition(new THREE.Vector3()).y;
  const ps = av.vrm.scene.scale.y || 1;   // authored height: undo any puppet scale the body already wears
  const eye = h.getNormalizedBoneNode?.('leftEye') ?? h.getNormalizedBoneNode?.('rightEye');
  if (eye) return (eye.getWorldPosition(new THREE.Vector3()).y - root) / ps;
  const head = h.getNormalizedBoneNode?.('head');
  return head ? (head.getWorldPosition(new THREE.Vector3()).y - root) / ps + 0.06 : null;   // eyes ≈ 6 cm above the head joint
}
export function loadSavedScale() {
  if (!wornName) return;   // no body yet: never a '' key
  try { const all = JSON.parse(localStorage.getItem(SCALE_LS) || '{}'); const name = wornName;
    const v = all[name]; if (v && v.k > 0.5 && v.k < 1.7) { scaleState.k = v.k; scaleState.source = 'saved'; scaleState.eyeY = v.eyeY ?? null; } } catch {}
}
function saveScale() {
  if (!wornName) return;
  try { const all = JSON.parse(localStorage.getItem(SCALE_LS) || '{}'); const name = wornName;
    all[name] = { k: scaleState.k, eyeY: scaleState.eyeY, t: Date.now() }; localStorage.setItem(SCALE_LS, JSON.stringify(all)); } catch {}
}
export function sampleDeviceScale(hmdY) {
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
