// shove — walking into a loose thing pushes it (R's queue: "body shove"). The walker's side: one body (mine, never a remote's;
// an agent's process runs its own) finds the loose things its walking capsule is against and says which to punt, and how
// hard. The punt itself is the authority's (punt {id, v, shove: true}: shoveGate in authority.js, its limits SHOVE in
// physconst.js); nothing here writes anything.
//
// Contact: the thing's ORIENTED box (its physics.shape, in the world: what the authority measures to through obbs()) within
// the body's radius + `slack` of the feet, the thing neither under the feet nor over the head (its axis-aligned box). The
// push: the body's WALKING INTENT (speed along its heading: what the keys or walk_to ask for), not its motion, which the
// collider has already stopped at the thing's face; only the part along the contact normal counts (and only when the walk
// heads into it, within 60°: brushing a corner on the way past is no push). How hard is momentum (R 10-12, "avatars need a
// presumptive mass, like presumptive reach"): a body of BODY_MASS walking at u gives a thing of mass m an elastic
// 2·BODY_MASS/(BODY_MASS + m) · u, under the flat ceiling SHOVE.maxV, and keeps (BODY_MASS − m)/(BODY_MASS + m) · u itself
// (a heavy crate stops you, a ball barely does). Lifted a little so it slides rather than grinds. Standing still sends
// nothing. Never a shove that would move a body: not a thing someone sits on or stands on (or anything carrying it), not one
// whose slide would run into someone.
//
// One punt per contact: a thing is shoved when contact begins, and again only after it has moved (`moved`) and `againMs`
// has passed, so walking on behind a crate keeps pushing it while a wall of crates that won't budge hears one punt each.
// Across every thing, at most `perSec` a second and `per10s` in ten (a third of the authority's act rate, RATE.n, so
// walking about a warehouse never rate-limits a person's own edits). A refusal that stands (rights, a lock, a hand) quiets that thing for
// `quietMs`; one that passes by itself (it was already moving, the track lagged, the rate) only for `againMs`.
import { SHOVE, BODY_MASS } from "./protocol/physconst.js";
import { worldPose, offChain } from "./protocol/simlayer.js";
import { isBoxShape, shapeVolume } from "./protocol/shapes.js";
import { r3, noNeg0 } from "./protocol/round.js";
import { DEFAULT_WHO } from "./grab.js";
import * as R from "./protocol/roles.js";

export const SHOVE_FEEL = Object.freeze({ slack: 0.06, minSpeed: 0.4, headOn: 0.5, lift: 0.15, againMs: 900, moved: 0.05, perSec: 3, per10s: 20, quietMs: 10000, keepMs: 300, vrSpeed: 0.5, vrTau: 0.15 });

const PASSING = new Set(["in-flight", "out-of-reach", "rate", "timeout", "not-here", "no-answer"]);
const locked = (c) => { const v = c?.lock; return v !== undefined && v !== null && !!v; };
const up = (st, id) => st.entities[id]?.c.parent?.to;
const G = 9.81;

/** The thing and everything riding it (its descendants), by parent links. */
export function familyOf(st, id) {
  const fam = new Set([id]); let grew = true;
  while (grew) { grew = false; for (const k in st.entities) if (!fam.has(k) && fam.has(up(st, k))) { fam.add(k); grew = true; } }
  return fam;
}

/** May this body shove it at all? The punt's own gates, read from the fold: dynamic, switched on, nothing locked over it,
 *  in nobody's hand (nor riding on what is), and physics.who at or under `rank` (null: not known, the authority decides). */
export function shoveable(st, id, { rank = null, holds = {} } = {}) {
  const e = st?.entities?.[id]; if (e?.c.physics?.kind !== "dynamic" || !isBoxShape(e.c.physics.shape) || offChain(st, id)) return false;
  for (let k = id, n = 0; k && n < 33; k = up(st, k), n++) { if (locked(st.entities[k]?.c) || holds[k]) return false; }
  if (rank !== null) { const need = e.c.physics.who ?? DEFAULT_WHO; const wc = st.entities["@world"]?.c ?? {};
    if (rank < (R.roleDef(wc, need)?.rank ?? R.RANK.owner)) return false; }
  return true;
}

const qrot = ([x, y, z, w], v) => { const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)]; };
/** Its oriented box in the world, from its physics.shape: {c, ax: [3 unit axes], h: [3 half sizes]} (authority/math.js obbs' shape). */
export function obbOf(st, id) {
  const sh = st?.entities?.[id]?.c.physics?.shape; if (!isBoxShape(sh)) return null;
  const t = worldPose(st, id); if (!t) return null;
  const off = qrot(t.q, [0, 1, 2].map((i) => (sh[0][i] + sh[1][i]) / 2 * t.scale[i]));
  return { c: t.pos.map((v, i) => v + off[i]), ax: [qrot(t.q, [1, 0, 0]), qrot(t.q, [0, 1, 0]), qrot(t.q, [0, 0, 1])], h: [0, 1, 2].map((i) => Math.abs(sh[1][i] - sh[0][i]) / 2 * Math.abs(t.scale[i])) };
}
/** The axis-aligned box around an oriented one. */
export function aabbOfObb(o) {
  const e = [0, 1, 2].map((i) => o.ax.reduce((a, axv, j) => a + Math.abs(axv[i]) * o.h[j], 0));
  return { min: o.c.map((v, i) => v - e[i]), max: o.c.map((v, i) => v + e[i]) };
}
/** Its footprint in the world: the axis-aligned box around its physics.shape, as it stands in the fold. */
export function footprint(st, id) { const o = obbOf(st, id); return o ? aabbOfObb(o) : null; }

/** How far a body's feet are from a set of oriented boxes along the ground, measured at heights up the body (a tilted box
 *  is nearest somewhere up it): {d, n: [x, z] from the feet toward it} (n null when the feet are inside). */
export function reachTo(boxes, feet, tall = SHOVE.above) {
  let best = null;
  for (const o of boxes) for (const k of [0.15, 0.5, 1, 1.5]) { if (k > tall) continue;
    const p = [feet[0], feet[1] + k, feet[2]], d0 = p.map((v, i) => v - o.c[i]);
    const q = o.c.slice(); for (let j = 0; j < 3; j++) { const t = Math.max(-o.h[j], Math.min(o.h[j], d0[0] * o.ax[j][0] + d0[1] * o.ax[j][1] + d0[2] * o.ax[j][2])); for (let i = 0; i < 3; i++) q[i] += o.ax[j][i] * t; }
    const nx = q[0] - feet[0], nz = q[2] - feet[2], d = Math.hypot(nx, nz);
    if (!best || d < best.d) best = { d, n: d > 1e-4 ? [nx / d, nz / d] : null, c: o.c };
  }
  return best;
}

/** Is a body (feet [x, y, z], radius r, height tall) against this thing ({obb, box})? {d, n: [x, z] the way a push sends
 *  it} or null. Under the feet or over the head is no contact. */
export function contactOf(feet, r, tall, thing, slack = SHOVE_FEEL.slack) {
  const { obb, box } = thing;
  if (box.max[1] <= feet[1] + SHOVE.underfoot || box.min[1] >= feet[1] + Math.min(tall, SHOVE.above)) return null;
  const m = reachTo([obb], feet, tall); if (!m || m.d > r + slack) return null;
  let n = m.n; if (!n) { const cx = obb.c[0] - feet[0], cz = obb.c[2] - feet[2], l = Math.hypot(cx, cz); if (l < 1e-6) return null; n = [cx / l, cz / l]; }
  return { d: m.d, n };
}

/** Its mass (kg): physics.mass, else density (its own, its material's, else water's) × its shape's volume at its scale. */
export function massOf(st, id) {
  const e = st?.entities?.[id]; const ph = e?.c.physics; if (!ph) return null;
  if (Number.isFinite(ph.mass) && ph.mass > 0) return ph.mass;
  const v = shapeVolume(ph.shape); if (!Number.isFinite(v)) return null;
  const mat = typeof ph.material === "string" ? st.entities["@world"]?.c?.[ph.material.startsWith("surface:") ? ph.material : `surface:${ph.material}`] : null;
  const rho = Number.isFinite(ph.density) && ph.density > 0 ? ph.density : Number.isFinite(mat?.density) && mat.density > 0 ? mat.density : 1000;
  const sc = worldPose(st, id)?.scale ?? [1, 1, 1];
  return Math.max(1e-6, rho * v * Math.abs(sc[0] * sc[1] * sc[2]));
}
/** The fastest a shove may send a thing of mass m along the ground: a run's push (SHOVE.walk) passed on elastically, under
 *  the flat ceiling. What the authority admits; what a walker sends never exceeds it. */
export const shoveCap = (m) => Math.min(SHOVE.maxV, SHOVE.walk * 2 * BODY_MASS / (BODY_MASS + (Number.isFinite(m) ? m : 0)));
/** What the walker keeps of its speed after giving a thing of mass m its push (0: a heavy thing stops you). */
export const keptOf = (m) => Math.max(0, (BODY_MASS - m) / (BODY_MASS + m));

/** The shove's velocity for a body walking at vel [x, z] against a contact's normal into a thing of mass m, or null when it
 *  isn't walking into it. */
export function shoveV(vel, n, m, F = SHOVE_FEEL) {
  const along = vel[0] * n[0] + vel[1] * n[1]; if (!(along >= F.minSpeed) || along < F.headOn * Math.hypot(vel[0], vel[1])) return null;
  const s = Math.min(shoveCap(m), Math.min(along, SHOVE.walk) * 2 * BODY_MASS / (BODY_MASS + m)), lift = Math.min(F.lift, SHOVE.lift);
  return [noNeg0(r3(n[0] * s)), noNeg0(r3(s * lift)), noNeg0(r3(n[1] * s))];
}

/** Are a body's feet on top of this box (standing on it)? */
export const feetOn = (box, p) => p[0] > box.min[0] - 0.1 && p[0] < box.max[0] + 0.1 && p[2] > box.min[2] - 0.1 && p[2] < box.max[2] + 0.1 && p[1] >= box.max[1] - 0.15 && p[1] <= box.max[1] + 0.3;
/** Would this box, sliding along v (horizontal) until friction stops it, run into a body standing at p (radius r)? */
export function sweptCovers(box, v, p, r = 0.32) {
  const vh = Math.hypot(v[0], v[2]); if (vh < 1e-6) return false;
  if (p[1] >= box.max[1] - 0.15 || p[1] + 1.9 <= box.min[1]) return false;   // on it (feetOn's business) or under it
  const L = vh * vh / (2 * SHOVE.mu * G) + r, dx = v[0] / vh, dz = v[2] / vh;
  const n = Math.ceil(L / 0.1);   // the slide plus a body's width of margin (eidosim slides a lifted thing a little further)
  for (let i = 0; i <= n; i++) { const k = L * i / n;
    if (p[0] > box.min[0] + dx * k - r && p[0] < box.max[0] + dx * k + r && p[2] > box.min[2] + dz * k - r && p[2] < box.max[2] + dz * k + r) return true; }
  return false;
}
/** Who a shove of `id` at v would move: a body seated on it (or on anything riding it: `mounted`, the seats' things), one
 *  standing on it, or one in its slide. {why: 'seat' | 'standing' | 'in-the-way'} or null. `bodies`: the other bodies' feet. */
export function occupied(st, id, v, { mounted = null, bodies = [] } = {}) {
  const fam = familyOf(st, id);
  if (mounted) for (const k of fam) if (mounted.has(k)) return { why: "seat" };
  if (!bodies.length) return null;
  const boxes = [...fam].map((k) => footprint(st, k)).filter(Boolean);
  for (const p of bodies) if (boxes.some((b) => feetOn(b, p))) return { why: "standing" };
  const box = footprint(st, id);
  if (box && v) for (const p of bodies) if (sweptCovers(box, v, p)) return { why: "in-the-way" };
  return null;
}

/** A smoothed horizontal velocity from successive positions (an exponential average over tau seconds): VR room-scale walking
 *  shoves by the body's motion only above SHOVE_FEEL.vrSpeed, so leaning over a table or tracking jitter never does. */
export function smoother(tau = SHOVE_FEEL.vrTau) {
  let last = null, v = [0, 0];
  return { step(p, t) { if (last && t > last.t) { const dt = (t - last.t) / 1000, k = 1 - Math.exp(-dt / tau);
      v = [v[0] + ((p[0] - last.p[0]) / dt - v[0]) * k, v[1] + ((p[2] - last.p[2]) / dt - v[1]) * k]; }
    last = { p: [p[0], p[1], p[2]], t }; return v; }, get: () => v, reset() { last = null; v = [0, 0]; } };
}

/** One walker's shoves. step() each frame (or tick) with where the body is and what it wants; it returns the punts to send
 *  now: [{id, v, kept}] (kept: the speed the walker keeps after giving it). refused(id) after a refusal quiets that thing. */
export function createShover(opts = {}) {
  const F = { ...SHOVE_FEEL, ...opts };
  const touched = new Map();   // id -> {at: [x, z] its footprint's centre when shoved, t}
  const quiet = new Map();     // id -> until
  let sent = [];
  return {
    feel: F,
    step({ st, ids = null, feet, vel, r, tall = 1.9, now, rank = null, holds = {}, mounted = null, bodies = [], skip = () => false }) {
      const out = []; if (!st?.entities || !feet || !vel) return out;
      if (Math.hypot(vel[0], vel[1]) < F.minSpeed) { touched.clear(); return out; }   // standing still: nothing, and every contact is new next time
      sent = sent.filter((t) => now - t < 10000);
      for (const id of ids ?? Object.keys(st.entities)) {
        const e = st.entities[id]; const ph = e?.c.physics;
        if (ph?.kind !== "dynamic" || !isBoxShape(ph.shape) || skip(id)) continue;
        // broad phase: a top-level thing's origin farther than its own size plus the body's reach is no contact
        // (riding something, its origin in the world: a pose, not the oriented box and the reach)
        const t = e.c.parent ? worldPose(st, id) : e.c.transform; if (Array.isArray(t?.pos)) { const sc = t.scale ?? [1, 1, 1];
          let ext = 0; for (let i = 0; i < 3; i++) ext = Math.max(ext, Math.max(Math.abs(ph.shape[0][i]), Math.abs(ph.shape[1][i])) * Math.abs(sc[i] ?? 1));
          if (Math.hypot(t.pos[0] - feet[0], t.pos[2] - feet[2]) > ext * 1.75 + r + F.slack) { touched.delete(id); continue; } }
        const obb = obbOf(st, id); const box = obb && aabbOfObb(obb); const c = box && contactOf(feet, r, tall, { obb, box }, F.slack);
        if (!c) { touched.delete(id); continue; }
        if ((quiet.get(id) ?? -Infinity) > now || !shoveable(st, id, { rank, holds })) continue;
        const m = massOf(st, id); const v = shoveV(vel, c.n, m, F); if (!v) continue;
        const at = [obb.c[0], obb.c[2]]; const was = touched.get(id);
        if (was && (now - was.t < F.againMs || Math.hypot(at[0] - was.at[0], at[1] - was.at[1]) < F.moved)) continue;
        if (occupied(st, id, v, { mounted, bodies })) continue;
        if (sent.length >= F.per10s || sent.filter((t) => now - t < 1000).length >= F.perSec) break;
        touched.set(id, { at, t: now }); sent.push(now);
        const along = vel[0] * c.n[0] + vel[1] * c.n[1]; out.push({ id, v, kept: along * keptOf(m), keepMs: F.keepMs });
      }
      return out;
    },
    refused(id, now, code = null) { quiet.set(id, now + (PASSING.has(code) ? F.againMs : F.quietMs)); },
    touching: () => [...touched.keys()],
  };
}
