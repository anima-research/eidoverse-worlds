// splashes — the water answering the bodies in it: ripples (ripples.js, drawn by the water's own shader) and
// thrown water (droplets, here). Which body does what, when, is splashlogic.js; this module samples every body
// this page draws — its own and everyone else's, ragdolls included — once a frame, and realizes what it says.
//
// Droplets are one instanced mesh, a fixed pool: each flies ballistically from the splash, and dies on
// meeting the water (now and then ringing it) or the ground. A splash's power sets how many, how fast and
// how high — a hand's stroke throws a few, a body dropped from a height throws a crown and a column.
//
// Visual only, per viewer, nothing on the wire; nothing here moves a body.

import { THREE, scene } from './core.js';
import { surfaceHeightAt, waterLevel } from './water.js';
import { heightAt } from './terrain.js';
import { remotes } from './remotes.js';
import { getMe } from './mybody.js';
import { onWorldChange } from './state.js';
import { makeSplashTracker } from './splashlogic.js';
import { addRipple, liveRipples, ripplesMade } from './ripples.js';

const PARTS = ['hips', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot'];
const MAX_DROPS = 400;
const G = 9.8;

// ---- droplets ---------------------------------------------------------------------------------------------
const drops = [];   // { p: Vector3, v: Vector3, r }
let mesh = null;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _dir = new THREE.Vector3();
function ensureMesh() {
  if (mesh) return mesh;
  const geo = new THREE.SphereGeometry(1, 6, 4);
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0xe6f2f8, roughness: 0.15, metalness: 0, transparent: true, opacity: 0.85, depthWrite: false });
  mesh = new THREE.InstancedMesh(geo, mat, MAX_DROPS);
  mesh.name = 'splash-drops';
  mesh.count = 0;
  mesh.frustumCulled = false;   // the drops move every frame; their bounds would always be stale
  mesh.renderOrder = 3;          // after the water sheet: they are seen over it
  // the world's, not the sky's: an async sky build adopts what is added while it runs, and the next one disposes it
  // (sky.js claimSkyAdditions), and this mesh is added at the first splash, whenever that comes
  mesh.userData.skyExempt = true;
  scene.add(mesh);
  return mesh;
}

/** Throw water from (x, y, z): power 0..1; (vx, vz) the thrower's way, a little of which the water keeps. */
export function splash(x, y, z, power, vx = 0, vz = 0) {
  const p = Math.max(0, Math.min(1, power));
  addRipple(x, z, Math.max(0.5, p));
  const n = Math.round(6 + 70 * p * p + 10 * p);
  for (let i = 0; i < n && drops.length < MAX_DROPS; i++) {
    const a = Math.random() * Math.PI * 2, out = 0.3 + (0.6 + 2.2 * p) * Math.random();
    const up = 1.0 + (1.2 + 4.0 * p) * Math.pow(Math.random(), 0.7);
    const r0 = 0.08 + 0.25 * p * Math.random();   // the crown rises from a ring, not a point
    drops.push({
      p: new THREE.Vector3(x + Math.cos(a) * r0, y + 0.02, z + Math.sin(a) * r0),
      v: new THREE.Vector3(Math.cos(a) * out + vx * 0.25, up, Math.sin(a) * out + vz * 0.25),
      r: 0.018 + Math.random() * (0.014 + 0.032 * p),
    });
  }
  if (p > 0.45) {   // the column a body's plunge throws straight back up
    for (let i = 0; i < 6 + 14 * p && drops.length < MAX_DROPS; i++) {
      drops.push({
        p: new THREE.Vector3(x + (Math.random() - 0.5) * 0.15, y + 0.02, z + (Math.random() - 0.5) * 0.15),
        v: new THREE.Vector3((Math.random() - 0.5) * 0.6, (3 + 3.5 * p) * (0.7 + 0.3 * Math.random()), (Math.random() - 0.5) * 0.6),
        r: 0.02 + Math.random() * 0.03,
      });
    }
  }
}

function stepDrops(dt) {
  let alive = 0;
  for (let i = 0; i < drops.length; i++) {
    const d = drops[i];
    d.v.y -= G * dt;
    d.v.multiplyScalar(Math.exp(-0.3 * dt));   // a little air drag
    d.p.addScaledVector(d.v, dt);
    const surf = surfaceHeightAt(d.p.x, d.p.z);
    const floor = surf ?? heightAt(d.p.x, d.p.z);
    if (d.v.y < 0 && d.p.y <= floor) {
      if (surf != null && Math.random() < 0.18) addRipple(d.p.x, d.p.z, 0.12 + d.r * 4);
      continue;   // landed
    }
    drops[alive++] = d;
  }
  drops.length = alive;
  if (!drops.length && !mesh) return;
  const m = ensureMesh();
  for (let i = 0; i < drops.length; i++) {
    const d = drops[i];
    // stretched along their flight: a fast drop reads as a streak
    const sp = d.v.length();
    _dir.copy(d.v).divideScalar(sp || 1);
    _q.setFromUnitVectors(_up, _dir);
    _s.set(d.r, d.r * (1 + Math.min(2.5, sp * 0.35)), d.r);
    _m.compose(d.p, _q, _s);
    m.setMatrixAt(i, _m);
  }
  m.count = drops.length;
  m.instanceMatrix.needsUpdate = true;
}

// ---- bodies -----------------------------------------------------------------------------------------------
const tracker = makeSplashTracker(surfaceHeightAt, {
  ripple: (x, z, s) => addRipple(x, z, s),
  splash: (x, y, z, p, vx, vz, why) => { recent.push({ at: +performance.now().toFixed(0), part: why?.part, down: +(why?.down ?? 0).toFixed(2), power: +p.toFixed(2) }); if (recent.length > 8) recent.shift(); splash(x, y, z, p, vx, vz); },
});
const recent = [];   // the last few bodies' splashes and why (probes)
const _w = new THREE.Vector3();
const samples = new WeakMap();   // avatar -> its reusable sample
function sample(av) {
  let s = samples.get(av);
  if (!s) { s = { key: av, root: [0, 0, 0], height: 1.7, parts: {}, swimming: false }; samples.set(av, s); }
  av.root.getWorldPosition(_w); s.root[0] = _w.x; s.root[1] = _w.y; s.root[2] = _w.z;
  s.height = av.bodyHeight?.() ?? 1.7;
  s.swimming = av.postureSlot === 'swim' || av.postureSlot === 'tread';
  const h = av.vrm?.humanoid;
  for (const name of PARTS) {
    const node = h?.getRawBoneNode?.(name);
    if (!node) { delete s.parts[name]; continue; }
    node.getWorldPosition(_w);
    (s.parts[name] ??= [0, 0, 0]);
    s.parts[name][0] = _w.x; s.parts[name][1] = _w.y; s.parts[name][2] = _w.z;
  }
  return s;
}

/** Once a frame, after every body has moved (main.js registers it after 'remotes'). */
export function updateSplashes(dt) {
  // no water: no body is in it. Forget them all, so a pose from before is never read against one after it returns.
  if (waterLevel() == null) { tracker.update([], dt); if (drops.length) stepDrops(dt); return; }
  const bodies = [];
  const me = getMe();
  if (me?.root) bodies.push(sample(me));
  for (const r of remotes.values()) if (r.avatar?.root) bodies.push(sample(r.avatar));
  tracker.update(bodies, dt);
  stepDrops(dt);
}

/** Probes / the console: what is in the air and on the water. */
export const splashDebug = () => ({ drops: drops.length, ripples: liveRipples(), made: ripplesMade(), bodies: tracker.size, recent: recent.slice() });

// A world change takes the drops with it, drawn ones included (with no water, stepDrops never runs to recount the
// mesh), and the bodies' last poses: a body arriving near where it was is not a fall from there.
onWorldChange((ev) => {
  if (ev.type !== 'reset') return;
  drops.length = 0;
  if (mesh) mesh.count = 0;
  tracker.update([], 0);
});
