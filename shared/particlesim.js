// shared/particlesim.js — the particle simulation every client runs for a `particles` effect: one emitter's particles,
// stepped on the CPU. Pure (no THREE, no DOM): the renderer (client/lib/particlefx.js) reads its arrays each frame, and
// tools/particlesim-test.ts steps it in bun.
//
// Ported from Godot Engine 4.7.2-stable, scene/3d/cpu_particles_3d.cpp (CPUParticles3D::_particles_process and
// _update_internal) — tag 4.7.2-stable, commit ed1daf0bf001b61586d9930840f2f1394092c079 (see THIRD-PARTY.md). The
// module vocabulary (emission shapes, direction/spread/flatness, initial velocity, gravity, linear/radial/tangential
// acceleration, damping, angle and angular velocity, scale and its curve, colour and its ramp, hue variation, animation
// speed/offset for a flipbook, lifetime randomness, explosiveness, randomness, one-shot, preprocess, speed scale) is
// Godot's ParticleProcessMaterial's. What is ours, and why:
//   - local coordinates only: a particles component hangs off its thing and rides it (the first protocol's contract), so
//     the emission transform is the identity and every radial/tangential force is about the emitter's own origin;
//   - gravity alone is WORLD-down (Unity's convention, lead 10-17): the document's gravity is a world-space vector, and
//     the renderer turns it into the emitter's frame every frame (setGravity(localGravity(…)): the inverse of the
//     emitter's world rotation, its world scale undone), so a tipped brazier's smoke still rises. Godot's local_coords
//     turns gravity with the node; here only velocity, linear/radial/tangential and the shape stay in the emitter's
//     frame, and tangential's axis is the document's gravity as written, read in that frame;
//   - no 2D (DISABLE_Z), no emission points, no attractors, no turbulence, no orbit velocity (Godot's is 2D-only here);
//   - `sphere` is uniform by VOLUME (the cube root of the draw) and has per-axis extents (an ellipsoid). Godot lerps a
//     surface point toward the centre by a plain uniform draw, which crowds the centre; the toolkit's builder, whose
//     look the Essentials keep, was uniform by volume;
//   - `velocity` may also be a uniform ranged vector {min, max} per axis (Niagara's Add Velocity), beside Godot's cone,
//     because the Essentials' launch was a box, not a cone;
//   - a particle's own randoms come from mulberry32 seeded per particle and cycle (Godot uses PCG32 there); Godot's
//     rand_from_seed (Park–Miller) and idhash are kept as they are, where Godot uses them;
//   - hue variation applies without a curve (Godot 4.7's CPU path multiplies it by 0 unless a curve is set; its GPU path
//     doesn't), and the anim-offset curve isn't the angle curve (a slip in the same file);
//   - every angle is radians (spread, a ring's cone, angle, angular velocity: PROTOCOL §9.2), where Godot's material
//     speaks degrees; the arithmetic is Godot's with its deg_to_rad dropped;
//   - four positional modules the Essentials need and Godot has no word for, applied at output (they never feed back
//     into the integration): drift (a slow sinusoidal sway, the builder's wobble), swirl (a small circle with age),
//     converge (the horizontal offset from the axis narrows over life: a flame's taper), flicker (alpha twinkles).
//
// Copyright (c) 2014-present Godot Engine contributors (see AUTHORS.md).
// Copyright (c) 2007-2014 Juan Linietsky, Ariel Manzur.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
// Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
// WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
// COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//
// The modifications in this file are part of eidoverse-worlds and are licensed under the AGPL-3.0 with it.

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;   // Godot's material speaks degrees; an effect document speaks radians (PROTOCOL §9.2), so the sim never converts (kept for the tools' mutants)
const CMP_EPSILON = 0.00001;
export const MIN_SIZE = 0.005;   // the builder's floor on a quad's side (m): a shrinking spark never inverts

// Godot's idhash and rand_from_seed, as they are (cpu_particles_3d.cpp)
export function idhash(x) {
  x = Math.imul(((x >>> 16) ^ x) >>> 0, 0x45d9f3b) >>> 0;
  x = Math.imul(((x >>> 16) ^ x) >>> 0, 0x45d9f3b) >>> 0;
  return ((x >>> 16) ^ x) >>> 0;
}
/** Park–Miller minimal standard, as Godot's rand_from_seed: returns [value 0..1, next seed]. */
export function randFromSeed(seed) {
  let s = seed | 0; if (s === 0) s = 305420679;
  const k = Math.trunc(s / 127773);
  s = 16807 * (s - k * 127773) - 2836 * k;
  if (s < 0) s += 2147483647;
  const next = s >>> 0;
  return [(next % 65536) / 65535.0, next];
}
/** mulberry32: a particle's own stream (Godot: RandomNumberGenerator, PCG32). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const lerp = (a, b, t) => a + (b - a) * t;

/** A piecewise-linear curve [[t, v], …] (t ascending in 0..1) sampled at x; null → 1 (Godot: no curve = 1). */
export function sampleCurve(c, x) {
  if (!c || !c.length) return 1;
  if (x <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) if (x <= c[i][0]) { const [ta, va] = c[i - 1], [tb, vb] = c[i]; return tb > ta ? lerp(va, vb, (x - ta) / (tb - ta)) : vb; }
  return c[c.length - 1][1];
}
/** A gradient [[t, 0xRRGGBB, alpha], …] at x → [r, g, b, a] (linear in sRGB components, as Godot's Gradient). */
export function sampleRamp(g, x, out = [1, 1, 1, 1]) {
  if (!g || !g.length) { out[0] = out[1] = out[2] = out[3] = 1; return out; }
  const rgba = (p) => [((p[1] >> 16) & 255) / 255, ((p[1] >> 8) & 255) / 255, (p[1] & 255) / 255, p[2] ?? 1];
  let a = g[0], b = g[0], t = 0;
  if (x <= g[0][0]) { a = b = g[0]; } else if (x >= g[g.length - 1][0]) { a = b = g[g.length - 1]; }
  else for (let i = 1; i < g.length; i++) if (x <= g[i][0]) { a = g[i - 1]; b = g[i]; t = b[0] > a[0] ? (x - a[0]) / (b[0] - a[0]) : 1; break; }
  const A = rgba(a), B = rgba(b);
  for (let k = 0; k < 4; k++) out[k] = lerp(A[k], B[k], t);
  return out;
}

/** v rotated by the unit quaternion q = [x, y, z, w]. */
export function qRotate(q, v, out = [0, 0, 0]) {
  const [x, y, z, w] = q, a = v[0], b = v[1], c = v[2];
  const ix = w * a + y * c - z * b, iy = w * b + z * a - x * c, iz = w * c + x * b - y * a, iw = -x * a - y * b - z * c;
  out[0] = ix * w - iw * x - iy * z + iz * y; out[1] = iy * w - iw * y - iz * x + ix * z; out[2] = iz * w - iw * z - ix * y + iy * x;
  return out;
}
/**
 * The document's gravity (a WORLD vector, m/s², lead 10-17) in an emitter's own frame, given the emitter's world rotation
 * q [x, y, z, w] and world scale s [x, y, z] (three's matrixWorld.decompose). The emitter's frame is scaled with its thing
 * (`scale`: every length in the effect, accelerations too, × the thing's scale), so the gravity that lands in the world is
 * the document's × the thing's mean scale (∛|sx·sy·sz|), pointing exactly where the document says: v = S⁻¹ · R⁻¹ · (k·g).
 * At identity it is g as written.
 */
const _QI = [0, 0, 0, 1], _R = [0, 0, 0];   // scratch: the renderer calls this every frame per emitter
export function localGravity(g, q = [0, 0, 0, 1], s = [1, 1, 1], out = [0, 0, 0]) {
  const qi = _QI; qi[0] = -q[0]; qi[1] = -q[1]; qi[2] = -q[2]; qi[3] = q[3];   // a unit quaternion's inverse is its conjugate
  const k = Math.cbrt(Math.abs(s[0] * s[1] * s[2])) || 1;
  const r = qRotate(qi, g, _R);
  out[0] = (r[0] * k) / (s[0] || 1); out[1] = (r[1] * k) / (s[1] || 1); out[2] = (r[2] * k) / (s[2] || 1);
  return out;
}
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// Godot's hue rotation (cpu_particles_3d.cpp): xform_inv of a basis built from three fixed matrices
const M1 = [[0.299, 0.587, 0.114], [0.299, 0.587, 0.114], [0.299, 0.587, 0.114]];
const M2 = [[0.701, -0.587, -0.114], [-0.299, 0.413, -0.114], [-0.300, -0.588, 0.886]];
const M3 = [[0.168, 0.330, -0.497], [-0.328, 0.035, 0.292], [1.250, -1.050, -0.203]];
function hueRotate(rgb, ang) {
  if (!ang) return rgb;
  const c = Math.cos(ang), s = Math.sin(ang); const m = [0, 1, 2].map((j) => [0, 1, 2].map((k) => M1[j][k] + M2[j][k] * c + M3[j][k] * s));
  // Basis::xform_inv(v) = transpose(m) · v
  return [m[0][0] * rgb[0] + m[1][0] * rgb[1] + m[2][0] * rgb[2], m[0][1] * rgb[0] + m[1][1] * rgb[1] + m[2][1] * rgb[2], m[0][2] * rgb[0] + m[1][2] * rgb[1] + m[2][2] * rgb[2]];
}

/** A ramp decoded once: {t, r, g, b, a} as Float64Arrays (sampling allocates nothing). */
function decodeRamp(g) {
  if (!g || !g.length) return null;
  const n = g.length, R = { n, t: new Float64Array(n), r: new Float64Array(n), g: new Float64Array(n), b: new Float64Array(n), a: new Float64Array(n) };
  g.forEach((p, i) => { R.t[i] = p[0]; R.r[i] = ((p[1] >> 16) & 255) / 255; R.g[i] = ((p[1] >> 8) & 255) / 255; R.b[i] = (p[1] & 255) / 255; R.a[i] = p[2] ?? 1; });
  return R;
}
function rampAt(R, x, out) {
  if (!R) { out[0] = out[1] = out[2] = out[3] = 1; return; }
  let i = 0, j = 0, t = 0; const n = R.n;
  if (x <= R.t[0]) { i = j = 0; } else if (x >= R.t[n - 1]) { i = j = n - 1; }
  else { for (j = 1; j < n; j++) if (x <= R.t[j]) break; i = j - 1; t = R.t[j] > R.t[i] ? (x - R.t[i]) / (R.t[j] - R.t[i]) : 1; }
  out[0] = R.r[i] + (R.r[j] - R.r[i]) * t; out[1] = R.g[i] + (R.g[j] - R.g[i]) * t; out[2] = R.b[i] + (R.b[j] - R.b[i]) * t; out[3] = R.a[i] + (R.a[j] - R.a[i]) * t;
}

/**
 * One emitter's simulation. `em` is a RESOLVED emitter (shared/particle_effects.js resolveEmitter: every module present,
 * every default written). `seed`: this instance's seed. Returns the sim: step(dt) advances it, and these arrays hold
 * what to draw (index i < amount): alive[i], pos[3i..], size[i], angle[i] (rad), color[4i..] (rgba, rgb may exceed 1
 * for additive), frame[i] (flipbook frame, a float). setEmitting(on) stops or restarts the spawning (Godot's emitting).
 * Structure of arrays, and nothing allocated per particle per frame: a viewer may run thousands of these.
 */
export function makeSim(em, { seed = 0 } = {}) {
  const n = em.spawn.amount | 0;
  const F64 = () => new Float64Array(n);
  const active = new Uint8Array(n), drawn = new Uint8Array(n), pseed = new Uint32Array(n);
  const ox = F64(), oy = F64(), oz = F64(), vx = F64(), vy = F64(), vz = F64(), ptime = F64(), plife = F64();
  const angleRand = F64(), scaleRand = F64(), hueRand = F64(), animRand = F64(), c0 = F64(), c1 = F64(), c2 = F64(), pdrift = F64(), pphase = F64();
  const startCol = em.color.initialRamp ? new Float64Array(n * 4) : null;
  const outR = new Float32Array(n), outG = new Float32Array(n), outB = new Float32Array(n), outA = new Float32Array(n), outSz = new Float32Array(n), outTv = new Float32Array(n);
  const sim = { amount: n, alive: new Uint8Array(n), pos: new Float32Array(n * 3), size: new Float32Array(n), angle: new Float32Array(n),
    color: new Float32Array(n * 4), frame: new Float32Array(n), vel: new Float32Array(n * 3), clock: 0, emitting: true,
    active: false, time: 0, cycle: 0, started: false, finished: false };
  const S = em.spawn, V = em.velocity, F = em.forces, R = em.rotation, Z = em.size, C = em.color, SH = em.shape, FB = em.render.flipbook;
  const lifetime = S.lifetime;
  const ramp = decodeRamp(C.ramp), initRamp = decodeRamp(C.initialRamp), rgba = new Float64Array(4);
  const d0 = V.direction ?? [0, 1, 0]; const dl0 = Math.hypot(d0[0], d0[1], d0[2]); const dirN = dl0 > 0 ? [d0[0] / dl0, d0[1] / dl0, d0[2] / dl0] : [0, 0, 1];
  let bin = cross([0, 1, 0], dirN); if (bin[0] * bin[0] + bin[1] * bin[1] + bin[2] * bin[2] < 1e-8) bin = [0, 0, 1];
  bin = norm3(bin); const nrm = cross(bin, dirN);
  const gN = norm3(F.gravity);   // tangential's axis: the document's gravity, in the emitter's frame (it doesn't turn with the world)
  let gx = F.gravity[0], gy = F.gravity[1], gz = F.gravity[2];   // gravity in the emitter's frame: as written until the renderer says how the emitter stands (setGravity)
  const hueOn = C.hue[0] !== 0 || C.hue[1] !== 0;
  const base = (seed >>> 0);
  let alt = 0;
  const rs = () => { let s = alt | 0; if (s === 0) s = 305420679; const k = Math.trunc(s / 127773); s = 16807 * (s - k * 127773) - 2836 * k; if (s < 0) s += 2147483647; alt = s >>> 0; return (alt % 65536) / 65535.0; };

  function spawnOne(i) {
    active[i] = 1;
    pseed[i] = (base + 1 + i + Math.imul(sim.cycle, n)) >>> 0;
    const rng = mulberry32(idhash(pseed[i]));
    angleRand[i] = rng(); scaleRand[i] = rng(); hueRand[i] = rng(); animRand[i] = rng();
    if (startCol) { rampAt(initRamp, rng(), rgba); startCol.set(rgba, i * 4); }
    if (V.mode === 'box') { vx[i] = lerp(V.min[0], V.max[0], rng()); vy[i] = lerp(V.min[1], V.max[1], rng()); vz[i] = lerp(V.min[2], V.max[2], rng()); }
    else {
      // initiate velocity spread in 3D
      const a1 = (rng() * 2 - 1) * V.spread, a2 = (rng() * 2 - 1) * (1 - V.flatness) * V.spread;
      const sx = Math.sin(a1) * Math.cos(a2), sy = Math.sin(a2), sz = Math.cos(a1) * Math.cos(a2);
      const sp = lerp(V.speed[0], V.speed[1], rng());
      vx[i] = (bin[0] * sx + nrm[0] * sy + dirN[0] * sz) * sp; vy[i] = (bin[1] * sx + nrm[1] * sy + dirN[1] * sz) * sp; vz[i] = (bin[2] * sx + nrm[2] * sy + dirN[2] * sz) * sp;
    }
    c0[i] = lerp(R.angle[0], R.angle[1], angleRand[i]); c1[i] = 0; c2[i] = lerp(FB.offset[0], FB.offset[1], animRand[i]);
    const c3 = 1 - rng() * S.lifetimeRandom;
    ptime[i] = 0; plife[i] = lifetime * c3;
    const ex = SH.extents;
    if (SH.type === 'sphere' || SH.type === 'sphere-surface') {
      const s = 2 * rng() - 1, t = TAU * rng(), x = SH.type === 'sphere' ? Math.cbrt(rng()) : 1; const r = Math.sqrt(1 - s * s);
      ox[i] = r * Math.cos(t) * ex[0] * x; oy[i] = s * ex[1] * x; oz[i] = r * Math.sin(t) * ex[2] * x;
    } else if (SH.type === 'box') { ox[i] = (rng() * 2 - 1) * ex[0]; oy[i] = (rng() * 2 - 1) * ex[1]; oz[i] = (rng() * 2 - 1) * ex[2]; }
    else if (SH.type === 'ring') {
      const rc = Math.max(0.001, SH.radius), H = SH.height;
      const top = Math.max(rc - Math.tan(Math.PI / 2 - SH.cone) * H, 0);
      let y = rng(); const skew = Math.max(Math.min(rc, top) / Math.max(rc, top), 0.5);
      y = rc < top ? Math.pow(y, skew) : 1 - Math.pow(y, skew);
      const ang = rng() * TAU;
      let rr = Math.sqrt(rng() * (rc * rc - SH.inner * SH.inner) + SH.inner * SH.inner);
      rr = lerp(rr, rr * (top / rc), y);
      const ax = (SH.axis[0] || SH.axis[1] || SH.axis[2]) ? norm3(SH.axis) : [0, 0, 1];
      let ortho = (Math.abs(ax[0]) === 1 && ax[1] === 0 && ax[2] === 0) ? cross([0, 1, 0], ax) : cross([1, 0, 0], ax);
      ortho = norm3(ortho);
      const c = Math.cos(ang), sn = Math.sin(ang), kd = ax[0] * ortho[0] + ax[1] * ortho[1] + ax[2] * ortho[2], kx = cross(ax, ortho);   // Rodrigues: ortho about ax by ang
      ortho = norm3([0, 1, 2].map((k) => ortho[k] * c + kx[k] * sn + ax[k] * kd * (1 - c)));
      ox[i] = ortho[0] * rr + (y * H - H / 2) * ax[0]; oy[i] = ortho[1] * rr + (y * H - H / 2) * ax[1]; oz[i] = ortho[2] * rr + (y * H - H / 2) * ax[2];
    } else { ox[i] = 0; oy[i] = 0; oz[i] = 0; }
    pdrift[i] = lerp(0.5, 1.5, rng()); pphase[i] = rng();
  }

  function process(delta) {
    delta *= S.speedScale;
    const prev = sim.time; sim.time += delta;
    if (sim.time > lifetime) { sim.time = sim.time % lifetime; sim.cycle++; if (S.oneShot && sim.cycle > 0) sim.emitting = false; }
    const sysPhase = sim.time / lifetime;
    let shouldBeActive = false;
    for (let i = 0; i < n; i++) {
      if (!sim.emitting && !active[i]) continue;
      let localDelta = delta;
      let restartPhase = i / n;
      if (S.randomness > 0) {
        let s = sim.cycle >>> 0; if (restartPhase >= sysPhase) s = (s - 1) >>> 0;
        s = (Math.imul(s, n) + i) >>> 0;
        restartPhase += S.randomness * ((idhash(s) % 65536) / 65536.0) / n;
      }
      restartPhase *= 1 - S.explosiveness;
      const restartTime = restartPhase * lifetime;
      let restart = false;
      if (sim.time > prev) { if (restartTime >= prev && restartTime < sim.time) { restart = true; localDelta = sim.time - restartTime; } }   // fractional_delta (Godot's default)
      else if (localDelta > 0) {
        if (restartTime >= prev) { restart = true; localDelta = lifetime - restartTime + sim.time; }
        else if (restartTime < sim.time) { restart = true; localDelta = sim.time - restartTime; }
      }
      if (ptime[i] * (1 - S.explosiveness) > plife[i]) restart = true;
      let tv = 0;
      if (restart) {
        if (!sim.emitting) { active[i] = 0; continue; }
        spawnOne(i);
      } else if (!active[i]) continue;
      else if (ptime[i] > plife[i]) { active[i] = 0; tv = 1; }
      else {
        alt = pseed[i];
        ptime[i] += localDelta; c1[i] = ptime[i] / lifetime; tv = ptime[i] / plife[i];
        let fx = gx, fy = gy, fz = gz;
        // linear acceleration along the velocity
        const vl = Math.hypot(vx[i], vy[i], vz[i]);
        { const a = lerp(F.linear[0], F.linear[1], rs()); if (vl > 0) { fx += (vx[i] / vl) * a; fy += (vy[i] / vl) * a; fz += (vz[i] / vl) * a; } }
        // radial acceleration, from the emitter's own origin (local coordinates)
        const dl = Math.hypot(ox[i], oy[i], oz[i]);
        { const a = lerp(F.radial[0], F.radial[1], rs()); if (dl > 0) { fx += (ox[i] / dl) * a; fy += (oy[i] / dl) * a; fz += (oz[i] / dl) * a; } }
        // tangential acceleration: about gravity's axis (diff.normalized() × gravity.normalized())
        { const a = lerp(F.tangential[0], F.tangential[1], rs());
          if (dl > 0) { const nx = ox[i] / dl, ny = oy[i] / dl, nz = oz[i] / dl;
            const cx = ny * gN[2] - nz * gN[1], cy = nz * gN[0] - nx * gN[2], cz = nx * gN[1] - ny * gN[0]; const cl = Math.hypot(cx, cy, cz);
            if (cl > 0) { fx += (cx / cl) * a; fy += (cy / cl) * a; fz += (cz / cl) * a; } } }
        vx[i] += fx * localDelta; vy[i] += fy * localDelta; vz[i] += fz * localDelta;
        { const damp = lerp(F.damping[0], F.damping[1], rs());
          if (damp > 0) { const l = Math.hypot(vx[i], vy[i], vz[i]); const v = l - damp * localDelta;
            if (v < 0) { vx[i] = 0; vy[i] = 0; vz[i] = 0; } else if (l > 0) { const k = v / l; vx[i] *= k; vy[i] *= k; vz[i] *= k; } } }
        let ang = lerp(R.angle[0], R.angle[1], angleRand[i]);
        ang += c1[i] * lifetime * lerp(R.velocity[0], R.velocity[1], rs());
        c0[i] = ang;
        c2[i] = lerp(FB.offset[0], FB.offset[1], animRand[i]) + tv * lerp(FB.speed[0], FB.speed[1], rs());
      }
      // colour (ramp × base, hue rotated, × start colour), and the size
      rampAt(ramp, tv, rgba);
      let r = rgba[0] * C.rgb[0], g = rgba[1] * C.rgb[1], b = rgba[2] * C.rgb[2], a = rgba[3] * C.alpha;
      if (hueOn) { const h = hueRotate([r, g, b], TAU * lerp(C.hue[0], C.hue[1], hueRand[i])); r = h[0]; g = h[1]; b = h[2]; }
      if (startCol) { r *= startCol[i * 4]; g *= startCol[i * 4 + 1]; b *= startCol[i * 4 + 2]; a *= startCol[i * 4 + 3]; }
      let sz = Z.base * lerp(Z.random[0], Z.random[1], scaleRand[i]) * sampleCurve(Z.curve, tv);
      if (sz < CMP_EPSILON) sz = CMP_EPSILON;
      ox[i] += vx[i] * localDelta; oy[i] += vy[i] * localDelta; oz[i] += vz[i] * localDelta;
      outR[i] = r; outG[i] = g; outB[i] = b; outA[i] = a; outSz[i] = sz; outTv[i] = tv; drawn[i] = 1;
      shouldBeActive = true;
    }
    if (sim.time !== 0 && sim.active && !shouldBeActive) { sim.active = false; sim.finished = true; }
  }

  // the output pass: positional modules (ours) over the integrated position, flicker, the floor on size
  function output() {
    const T = sim.clock, D = em.drift, W = em.swirl, K = em.converge, FL = em.flicker;
    for (let i = 0; i < n; i++) {
      const on = active[i] && drawn[i];
      sim.alive[i] = on ? 1 : 0; if (!on) continue;
      let x = ox[i], y = oy[i], z = oz[i]; const tv = outTv[i];
      if (D) { const w = D.amount * pdrift[i], a2 = D.rate * T + pphase[i] * TAU; x += Math.sin(a2) * w; y += Math.cos(a2 * 0.7) * w * 0.4; z += Math.cos(a2) * w; }
      if (W) { const a = ptime[i] * W.rate; x += Math.cos(a) * W.radius; z += Math.sin(a) * W.radius; }
      if (K) { const k = 1 - tv * K.amount; x *= k; z *= k; }
      sim.pos[i * 3] = x; sim.pos[i * 3 + 1] = y; sim.pos[i * 3 + 2] = z;
      sim.vel[i * 3] = vx[i]; sim.vel[i * 3 + 1] = vy[i]; sim.vel[i * 3 + 2] = vz[i];
      let a = outA[i];
      if (FL) a *= lerp(1, 0.5 + 0.5 * Math.sin(FL.rate * T + pphase[i] * 40), FL.amount);
      sim.color[i * 4] = outR[i]; sim.color[i * 4 + 1] = outG[i]; sim.color[i * 4 + 2] = outB[i]; sim.color[i * 4 + 3] = a < 0 ? 0 : a > 1 ? 1 : a;
      sim.size[i] = outSz[i] < MIN_SIZE ? MIN_SIZE : outSz[i];
      sim.angle[i] = c0[i];
      sim.frame[i] = c2[i];
    }
  }

  /** Advance by dt seconds of the viewer's clock (clamped: a backgrounded tab resumes, it doesn't replay). */
  sim.step = (dt) => {
    dt = Math.max(0, Math.min(0.1, +dt || 0));
    if (!sim.started) {   // Godot's first update: preprocess in 1/30 s steps
      sim.started = true; sim.active = sim.emitting;
      let todo = S.preprocess; while (todo > 0) { process(Math.min(1 / 30, todo)); todo -= 1 / 30; }
    }
    if (!sim.active && !sim.emitting) { output(); return sim; }
    sim.clock += dt;
    if (dt > 0) process(dt);
    output();
    return sim;
  };
  /** Gravity in the emitter's own frame (localGravity: the document's world-down gravity turned into it), read from the
   *  next step on. Without a call the document's gravity is used as written: an emitter standing upright, at scale 1. */
  sim.setGravity = (v) => { gx = +v[0]; gy = +v[1]; gz = +v[2]; return sim; };
  /** Godot's emitting: off lets the living finish; on again starts emitting where the cycle stands. */
  sim.setEmitting = (on) => { on = !!on; if (on === sim.emitting) return; sim.emitting = on; if (on) { sim.active = true; sim.finished = false; } };
  sim.liveCount = () => { let c = 0; for (let i = 0; i < n; i++) c += sim.alive[i]; return c; };
  return sim;
}
