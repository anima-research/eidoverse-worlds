// particlefx — draws one resolved particles emitter (shared/particle_effects.js) with three.js: the simulation is
// shared/particlesim.js (Godot's CPUParticles3D, ported), stepped on this viewer's clock; this file owns the GPU half.
//
// One InstancedMesh per emitter, one quad per particle. The CPU writes each living particle's centre, colour, size,
// angle and flipbook frame into instanced attributes once a frame (compacted: only the living are drawn); the node
// material billboards the quad toward the camera and does the texture, the soft dot and the blend. Node materials (TSL)
// compile for both of three's backends, WebGL 2 and WebGPU; nothing here is backend-specific, and there is no compute
// pass (WebGL 2 has none), so headsets and desktops run the same path.
//
// Billboarding is in the mesh's own frame: the camera's right and up are carried into the emitter's local space each
// frame, so a quad faces the viewer however its thing is turned, and grows with its thing's scale (the builder used the
// world basis in the local frame, which tilted every quad on a turned thing). A headset's two eyes share the head's
// basis, as they did.
//
// Cost is bounded three ways: what an effect may hold (EFFECT_LIMITS, checked at the door), the viewer's tier (the perf
// governor thins drawn particles, never the simulation's meaning), and distance (an emitter farther than FAR is neither
// stepped nor drawn: a cosmetic, per-viewer simulation needs no continuity nobody sees).
import { THREE, TSL, camera } from './core.js';
import { makeSim } from '../../shared/particlesim.js';

export const FAR = 90;   // m: past this an emitter sleeps (its quads would be sub-pixel long before)
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _qi = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();

/**
 * Build the mesh for one resolved emitter. opts: {map (a texture or null), seed, name, budget () => 0..1 (the share
 * of particles this viewer draws)}. Returns {mesh, sim, update(nowMs), setEmitting(on), dispose()}; update is what the
 * frame loop calls.
 */
export function buildEmitter(em, { map = null, seed = 0, name = 'particles', budget = () => 1 } = {}) {
  const { Fn, vec2, vec3, vec4, float, attribute, uniform, uv, texture, positionLocal, clamp, max, smoothstep, sin, cos, floor, mod } = TSL;
  const sim = makeSim(em, { seed });
  const n = sim.amount;
  const geo = new THREE.PlaneGeometry(1, 1);
  const A = (k) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(n * k), k); a.setUsage(THREE.DynamicDrawUsage); return a; };
  const aPos = A(3), aCol = A(4), aSa = A(3);   // centre; rgba; size, angle, frame
  geo.setAttribute('iPos', aPos); geo.setAttribute('iCol', aCol); geo.setAttribute('iSa', aSa);
  const additive = em.render.blend === 'add';
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, toneMapped: !additive });
  // no mrtNode: the builder set one (to keep quads out of an MRT pass's normals) only where its global THREE had mrt, which
  // this client's never did; here a merged MRT output drew nothing at all on the WebGL 2 backend (measured 10-07: no
  // mrtNode, the smoke is there; with it, an empty frame). The client renders no MRT pass for particles to smear.
  const uRight = uniform(new THREE.Vector3(1, 0, 0)), uUp = uniform(new THREE.Vector3(0, 1, 0));
  const fb = em.render.flipbook, frames = fb.h * fb.v;
  mat.positionNode = Fn(() => {
    const c = attribute('iPos'), sa = attribute('iSa');
    const sz = sa.x, ang = sa.y;
    const ca = cos(ang).toVar(), sn = sin(ang).toVar();
    const lx = positionLocal.x.mul(ca).sub(positionLocal.y.mul(sn)), ly = positionLocal.x.mul(sn).add(positionLocal.y.mul(ca));
    return c.add(uRight.mul(lx.mul(sz))).add(uUp.mul(ly.mul(sz)));
  })();
  const uvOf = () => {
    if (frames <= 1) return uv();
    const f = attribute('iSa').z;
    const k = fb.loop ? mod(floor(f.mul(frames)), float(frames)) : clamp(floor(f.mul(frames)), 0, frames - 1);
    const col = mod(k, float(fb.h)), row = floor(k.div(fb.h));
    // three's uv() runs bottom-up; a sheet's first frame is its top-left
    return vec2(uv().x.add(col).div(fb.h), uv().y.add(float(fb.v - 1).sub(row)).div(fb.v));
  };
  mat.colorNode = Fn(() => { const c = attribute('iCol').xyz; return map ? c.mul(texture(map, uvOf()).rgb) : c; })();
  mat.opacityNode = Fn(() => {
    let a = attribute('iCol').w;
    if (map) {
      a = a.mul(texture(map, uvOf()).a);
      // a thin fade at the quad's rim: sprites whose alpha doesn't reach zero at the border print the quad's square edge
      const b = uv().sub(0.5).abs(); a = a.mul(smoothstep(float(0.5), float(0.44), max(b.x, b.y)));
    } else a = a.mul(smoothstep(float(0.5), float(0.12), uv().sub(0.5).length()));   // the soft dot: a bare quad reads as a square
    // the sub-threshold tail is exactly zero (a depth-keyed fog pass would otherwise draw the faint quad as a rectangle)
    return a.sub(0.004).max(0.0);
  })();
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  mesh.frustumCulled = false; mesh.count = 0; mesh.name = name;
  mesh.userData.noSupportCheck = true; mesh.userData.noClippingCheck = true; mesh.userData.noCameraCollide = true;

  let last = null;
  const update = (nowMs = performance.now()) => {
    const dt = last == null ? 0 : (nowMs - last) / 1000; last = nowMs;
    mesh.getWorldPosition(_p);
    const cam = camera;
    if (!mesh.parent || _p.distanceTo(cam.getWorldPosition(_v)) > FAR) { mesh.visible = false; return; }
    mesh.visible = true;
    sim.step(dt);
    // the camera's basis, in the emitter's own frame (its rotation undone; its scale kept, so quads grow with the thing)
    mesh.matrixWorld.decompose(_p, _q, _s); _qi.copy(_q).invert();
    cam.updateMatrixWorld();
    uRight.value.setFromMatrixColumn(cam.matrixWorld, 0).normalize().applyQuaternion(_qi);
    uUp.value.setFromMatrixColumn(cam.matrixWorld, 1).normalize().applyQuaternion(_qi);
    const cap = Math.max(1, Math.round(n * Math.min(em.spawn.ratio, budget())));
    const P = aPos.array, C = aCol.array, S = aSa.array; let k = 0;
    // thinning takes every (n/cap)-th particle, never the first cap: a particle's index is its place in the emission
    // cycle (Godot's restart phase i/n), so the first quarter of them is one band of ages (a fire with no young flames)
    for (let i = 0; i < n; i++) {
      if (!sim.alive[i] || (cap < n && Math.floor((i + 1) * cap / n) === Math.floor(i * cap / n))) continue;
      P[k * 3] = sim.pos[i * 3]; P[k * 3 + 1] = sim.pos[i * 3 + 1]; P[k * 3 + 2] = sim.pos[i * 3 + 2];
      C[k * 4] = sim.color[i * 4]; C[k * 4 + 1] = sim.color[i * 4 + 1]; C[k * 4 + 2] = sim.color[i * 4 + 2]; C[k * 4 + 3] = sim.color[i * 4 + 3];
      S[k * 3] = sim.size[i]; S[k * 3 + 1] = sim.angle[i]; S[k * 3 + 2] = sim.frame[i];
      k++;
    }
    mesh.count = k;
    aPos.needsUpdate = true; aCol.needsUpdate = true; aSa.needsUpdate = true;
  };
  return {
    mesh, sim, update,
    setEmitting: (on) => sim.setEmitting(on),
    dispose() { mesh.parent?.remove(mesh); geo.dispose(); mat.dispose(); },   // NOT the texture: it's the cache's (emitters.js)
  };
}
