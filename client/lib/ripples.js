// ripples — rings on the water's surface, as the water shader draws them (client/lib/water.js).
//
// A small ring buffer of sources, each {x, z, born, strength}, handed to the shader as one uniform array. Every
// fragment of the sheet sums each live source's ring: a packet of capillary crests a third of a metre apart
// running out at RING_SPEED, widening as it goes, fading with age and spreading thinner with distance. A
// strong source (a splash) also wears a short-lived white crown at its front. Normals only, no moving
// vertices: the sheet's vertices are a metre apart, and a 30 cm ring would alias on them.
//
// Sources come from splashes.js (bodies moving in the water, things falling in). The clock is this page's own:
// ripples are what this viewer sees of the bodies it draws, never on the wire.

import { THREE } from './core.js';
import { uniform, uniformArray, Fn, Loop, If, Continue, int, float, vec2, vec3, length, exp, cos, sqrt, max, smoothstep } from 'three/tsl';

export const MAX_RIPPLES = 48;
export const RIPPLE = {
  LIFE: 3.5,          // s a ring lasts
  SPEED: 0.6,         // m/s its front runs out
  K: (2 * Math.PI) / 0.3,   // crests 30 cm apart
  AMP: 0.022,         // m of height at strength 1 (as slope: AMP·K ≈ 0.46 at the front)
  DECAY: 1.1,         // 1/s
};

const slots = Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, -1e6, 0));
const ripplesU = uniformArray(slots);
export const rippleTime = uniform(0);
let next = 0, t0 = performance.now(), added = 0;

/** This page's ripple clock, seconds. */
export const rippleNow = () => (performance.now() - t0) / 1000;
/** Ring the water at (x, z): strength 0..1. The oldest ring gives up its slot when all are in use. */
export function addRipple(x, z, strength) {
  const v = slots[next];
  v.set(x, z, rippleNow(), Math.max(0, Math.min(1, strength)));
  added++;
  next = (next + 1) % MAX_RIPPLES;   // (the uniform array re-reads these vectors every render)
}
/** Advance the shader's clock (once a frame). */
export function tickRipples() { rippleTime.value = rippleNow(); }
/** How many rings are live now (probes). */
export const liveRipples = () => { const t = rippleNow(); return slots.filter((v) => v.w > 0 && t - v.z < RIPPLE.LIFE).length; };
/** How many rings this page has made, ever (probes: a count that a slow frame cannot age away). */
export const ripplesMade = () => added;
/** Forget every ring (a world change). */
export function clearRipples() { for (const v of slots) v.set(0, 0, -1e6, 0); }

/** The rings at world (px, pz): vec3(−∂h/∂x, −∂h/∂z, crown foam) — add the first two to the sheet's normal x/z. */
export const rippleField = Fn(([px, pz]) => {
  const acc = vec3(0, 0, 0).toVar();
  const { LIFE, SPEED, K, AMP, DECAY } = RIPPLE;
  Loop({ start: int(0), end: int(MAX_RIPPLES), type: 'int', name: 'i' }, ({ i }) => {
    const R = ripplesU.element(i);
    const age = rippleTime.sub(R.z);
    If(age.lessThan(0).or(age.greaterThan(LIFE)).or(R.w.lessThanEqual(0)), () => { Continue(); });
    const dx = px.sub(R.x), dz = pz.sub(R.y);
    const r = max(length(vec2(dx, dz)), float(0.02));
    const off = r.sub(age.mul(SPEED));                       // behind (−) or ahead of (+) the front
    const width = age.mul(0.3).add(0.15);                    // the packet widens as it runs
    const q = off.div(width);
    const env = exp(q.mul(q).negate()).mul(exp(age.mul(-DECAY))).div(sqrt(r.mul(1.5).add(1)));
    // h = AMP·w·env·sin(K·off)  →  ∂h/∂r ≈ AMP·w·K·env·cos(K·off) (the envelope varies slowly beside the crests)
    const slope = cos(off.mul(K)).mul(env).mul(R.w).mul(AMP * K);
    acc.x.subAssign(slope.mul(dx).div(r));
    acc.y.subAssign(slope.mul(dz).div(r));
    // a splash's crown: white at the front for its first moments
    const c = off.div(0.12);
    acc.z.addAssign(exp(c.mul(c).negate()).mul(exp(age.mul(-3.5))).mul(smoothstep(0.45, 1.0, R.w)));
  });
  return acc;
});
