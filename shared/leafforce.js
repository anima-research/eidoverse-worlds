// leafforce — the aerodynamic forces that make a ragdoll fall like a leaf (mcpl/physics.ts applies them to Bullet bodies).
//
// shared/flight.js leafAt() is the kinematic twin: a closed-form curve for tests and capture. This is the dynamic half:
// given rigid bodies, the force and torque each should feel this step so the assembly tumbles. Nothing here moves anything.
//
// The physics: a falling plate flutters because (1) drag scales with the velocity component along its NORMAL, so it
// seeks edge-on and overshoots, and (2) the centre of pressure sits forward of centre, so that force is a torque, turning
// the overshoot into a periodic tumble. The period falls out of mass, area and speed; `periodAssist` nudges it toward
// the authored 3.4 s.
//
// Pure: no engine types, no globals.

/** @typedef {{x:number,y:number,z:number}} V3 */
/** @typedef {{ rho:number, cdNormal:number, cdEdge:number, copOffset:number,
 *              swirl:number, damp:number, periodAssist:number, period:number,
 *              vMax:number }} LeafForceCfg */
/** @typedef {{ mass:number, halfExtents:number[], vel:V3, normal:V3, right:V3 }} PlateBody */

export const DEFAULT_LEAF_FORCE = {
  rho: 1.225,                 // kg/m^3, air at sea level (halving it is the cheapest way to fall faster)

  // Per-body plate model: a body is a box, and its largest face is the plate.
  cdNormal: 1.28,             // flat plate, broadside
  cdEdge: 0.06,               // edge-on
  copOffset: 0.42,            // centre of pressure, as a fraction of the half-width forward of centre: THE flutter term

  // Flutter shaping: how much of the oscillation survives a 60 Hz solver on a jointed doll (tuned against the assembly).
  swirl: 2.4,                 // torque gain, N.m per (m/s)^2 of normal flow
  damp: 0.06,                 // angular damping; lower is more flutter

  // A weak sinusoidal couple about world-up that herds the emergent period toward the authored one: 0 purely physical, 1 firmly herded.
  periodAssist: 0.6,
  period: 3.4,                // s, the target when periodAssist > 0

  vMax: 45,                   // m/s, clamps the runaway case only; terminal speed is a consequence, not a setting
};

/**
 * Aerodynamic force and torque for ONE rigid body this step.
 *
 * @param {LeafForceCfg} cfg   from DEFAULT_LEAF_FORCE (spread and override)
 * @param {PlateBody} body
 *   `normal` is the body's largest-face normal in WORLD space; `right` is any
 *   perpendicular in the plate, used to place the centre of pressure.
 * @param {number} t        seconds since the fall began (for periodAssist)
 * @returns {{force:V3, torque:V3, angularDamping:number}}
 *   apply with applyCentralForce / applyTorque / setDamping
 */
export function leafForceFor(cfg, body, t) {
  const he = body.halfExtents;
  // the plate: the two largest half-extents span it, the smallest is thickness
  const dims = [he[0], he[1], he[2]];
  const thinAxis = dims.indexOf(Math.min(...dims));
  const a = dims[(thinAxis + 1) % 3], b = dims[(thinAxis + 2) % 3];
  const area = 4 * a * b;                       // full face, both half-extents
  const halfWidth = Math.max(a, b);

  const v = body.vel;
  const speed = Math.hypot(v.x, v.y, v.z);
  if (speed < 1e-4 || area < 1e-6) return zero();

  const n = norm(body.normal);
  // the airflow along the plate normal is what a plate feels; the tangential part slides past
  const vn = v.x * n.x + v.y * n.y + v.z * n.z;
  const absVn = Math.abs(vn);
  // blend the two drag coefficients by how broadside the flow is
  const broadside = absVn / speed;
  const cd = cfg.cdEdge + (cfg.cdNormal - cfg.cdEdge) * broadside;

  // F = 1/2 rho v^2 Cd A, opposing the motion
  const q = 0.5 * cfg.rho * speed * Math.min(speed, cfg.vMax) * cd * area;
  const force = { x: -v.x / speed * q, y: -v.y / speed * q, z: -v.z / speed * q };

  // the flutter torque: the normal force acts at the centre of pressure, forward of centre; r x F with r along the plate
  const r = norm(body.right);
  const nf = 0.5 * cfg.rho * vn * absVn * cfg.cdNormal * area;   // signed
  const lever = cfg.copOffset * halfWidth;
  const rv = { x: r.x * lever, y: r.y * lever, z: r.z * lever };
  const fv = { x: -n.x * nf, y: -n.y * nf, z: -n.z * nf };
  let torque = cross(rv, fv);
  torque = scale(torque, cfg.swirl);

  // period assist: a weak couple about world-up at the authored period, so the flutter phase-locks near it
  if (cfg.periodAssist > 0) {
    const w = (2 * Math.PI) / Math.max(0.05, cfg.period);
    const bias = Math.sin(w * t) * cfg.periodAssist * body.mass * absVn * 0.5;
    torque.y += bias;
  }

  // angular damping is the caller's to apply (Bullet has a setter)
  return { force, torque, angularDamping: cfg.damp };
}

/**
 * The whole assembly at once.
 * @param {LeafForceCfg} cfg
 * @param {PlateBody[]} bodies
 * @param {number} t
 */
export function leafForces(cfg, bodies, t) {
  return bodies.map(b => leafForceFor(cfg, b, t));
}

/**
 * Terminal speed a single plate would reach: mg = 1/2 rho v^2 Cd A  =>  v = sqrt(2mg / (rho Cd A)).
 * @param {LeafForceCfg} cfg
 * @param {{mass:number, halfExtents:number[]}} body
 * @param {number} [g]
 */
export function terminalOf(cfg, { mass, halfExtents }, g = 9.81) {
  const dims = halfExtents.slice().sort((x, y) => x - y);
  const area = 4 * dims[1] * dims[2];
  if (area < 1e-9) return Infinity;
  return Math.sqrt((2 * mass * g) / (cfg.rho * cfg.cdNormal * area));
}

const zero = () => ({ force: { x: 0, y: 0, z: 0 }, torque: { x: 0, y: 0, z: 0 }, angularDamping: 0 });
const norm = (v) => { const m = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / m, y: v.y / m, z: v.z / m }; };
const scale = (v, k) => ({ x: v.x * k, y: v.y * k, z: v.z * k });
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
