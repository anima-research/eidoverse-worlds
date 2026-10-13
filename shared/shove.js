// shove — walking into a loose thing pushes it (R's queue: "body shove"). The walker's side: one body (mine, never a remote's;
// an agent's process runs its own) finds the loose things its walking capsule is against and says which to punt, and how
// hard. The punt itself is the authority's (punt {id, v, shove: true}: shoveGate in authority.js, its limits SHOVE in
// physconst.js); nothing here writes anything.
//
// Contact: the thing's footprint (its physics.shape, in the world, as an axis-aligned box: what the authority measures to)
// within the body's radius + `slack` of the feet, the thing neither under the feet nor over the head. The push: the body's
// WALKING INTENT (speed along its heading: what the keys or walk_to ask for), not its motion, which the collider has already
// stopped at the thing's face; only the part along the contact normal counts (and only when the walk heads into it, within
// 60°: brushing a corner on the way past is no push), × `gain`, capped, lifted a little so it slides rather than grinds.
// Standing still sends nothing.
//
// One punt per contact: a thing is shoved when contact begins, and again only after it has moved (`moved`) and `againMs`
// has passed, so walking on behind a crate keeps pushing it while a wall of crates that won't budge hears one punt each.
// Across every thing, at most `perSec` a second and `per10s` in ten (a third of the authority's act rate, RATE.n, so
// walking about a warehouse never rate-limits a person's own edits). A refusal that stands (rights, a lock, a hand) quiets that thing for
// `quietMs`; one that passes by itself (it was already moving, the track lagged, the rate) only for `againMs`.
import { SHOVE } from "./protocol/physconst.js";
import { worldPose, offChain } from "./protocol/simlayer.js";
import { isBoxShape } from "./protocol/shapes.js";
import { r3, noNeg0 } from "./protocol/round.js";
import { DEFAULT_WHO } from "./grab.js";
import * as R from "./protocol/roles.js";

export const SHOVE_FEEL = Object.freeze({ slack: 0.06, minSpeed: 0.4, headOn: 0.5, gain: 1.3, maxV: 4.5, lift: 0.15, againMs: 900, moved: 0.05, perSec: 3, per10s: 20, quietMs: 10000 });

const PASSING = new Set(["in-flight", "out-of-reach", "rate", "timeout", "not-here", "no-answer"]);
const locked = (c) => { const v = c?.lock; return v !== undefined && v !== null && !!v; };
const up = (st, id) => st.entities[id]?.c.parent?.to;

/** May this body shove it at all? The punt's own gates, read from the fold: dynamic, switched on, nothing locked over it,
 *  in nobody's hand (nor riding on what is), and physics.who at or under `rank` (null: not known, the authority decides). */
export function shoveable(st, id, { rank = null, holds = {} } = {}) {
  const e = st?.entities?.[id]; if (e?.c.physics?.kind !== "dynamic" || !isBoxShape(e.c.physics.shape) || offChain(st, id)) return false;
  for (let k = id, n = 0; k && n < 33; k = up(st, k), n++) { if (locked(st.entities[k]?.c) || holds[k]) return false; }
  if (rank !== null) { const need = e.c.physics.who ?? DEFAULT_WHO; const wc = st.entities["@world"]?.c ?? {};
    if (rank < (R.roleDef(wc, need)?.rank ?? R.RANK.owner)) return false; }
  return true;
}

/** Its footprint in the world: the axis-aligned box around its physics.shape, as it stands in the fold. */
export function footprint(st, id) {
  const sh = st?.entities?.[id]?.c.physics?.shape; if (!isBoxShape(sh)) return null;
  const t = worldPose(st, id); if (!t) return null;
  const [x, y, z, w] = t.q; const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const a of [sh[0][0], sh[1][0]]) for (const b of [sh[0][1], sh[1][1]]) for (const c of [sh[0][2], sh[1][2]]) {
    const v = [a * t.scale[0], b * t.scale[1], c * t.scale[2]];
    const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
    const p = [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
    for (let i = 0; i < 3; i++) { const q = p[i] + t.pos[i]; if (q < min[i]) min[i] = q; if (q > max[i]) max[i] = q; }
  }
  return { min, max };
}

/** Is a body (feet [x, y, z], radius r, height tall) against this box? {d, n: [x, z] the way a push sends it} or null. */
export function contactOf(feet, r, tall, box, slack = SHOVE_FEEL.slack) {
  if (box.max[1] <= feet[1] + SHOVE.underfoot || box.min[1] >= feet[1] + Math.min(tall, SHOVE.above)) return null;
  const cx = Math.min(box.max[0], Math.max(box.min[0], feet[0])), cz = Math.min(box.max[2], Math.max(box.min[2], feet[2]));
  let nx = cx - feet[0], nz = cz - feet[2]; const d = Math.hypot(nx, nz);
  if (d > r + slack) return null;
  if (d < 1e-4) { nx = (box.min[0] + box.max[0]) / 2 - feet[0]; nz = (box.min[2] + box.max[2]) / 2 - feet[2]; }
  const l = Math.hypot(nx, nz); if (l < 1e-6) return null;
  return { d, n: [nx / l, nz / l] };
}

/** The shove's velocity for a body walking at vel [x, z] against a contact's normal, or null when it isn't walking into it. */
export function shoveV(vel, n, F = SHOVE_FEEL) {
  const along = vel[0] * n[0] + vel[1] * n[1]; if (!(along >= F.minSpeed) || along < F.headOn * Math.hypot(vel[0], vel[1])) return null;
  const s = Math.min(F.maxV, SHOVE.maxV, along * F.gain), lift = Math.min(F.lift, SHOVE.lift);
  return [noNeg0(r3(n[0] * s)), noNeg0(r3(s * lift)), noNeg0(r3(n[1] * s))];
}

/** One walker's shoves. step() each frame (or tick) with where the body is and what it wants; it returns the punts to send
 *  now: [{id, v}]. refused(id) after a refusal quiets that thing for a while. */
export function createShover(opts = {}) {
  const F = { ...SHOVE_FEEL, ...opts };
  const touched = new Map();   // id -> {at: [x, z] its footprint's centre when shoved, t}
  const quiet = new Map();     // id -> until
  let sent = [];
  return {
    feel: F,
    step({ st, ids = null, feet, vel, r, tall = 1.9, now, rank = null, holds = {}, skip = () => false }) {
      const out = []; if (!st?.entities || !feet || !vel) return out;
      sent = sent.filter((t) => now - t < 10000);
      const walking = Math.hypot(vel[0], vel[1]) >= F.minSpeed;
      for (const id of ids ?? Object.keys(st.entities)) {
        if (st.entities[id]?.c.physics?.kind !== "dynamic" || skip(id)) continue;
        const box = footprint(st, id); const c = box && contactOf(feet, r, tall, box, F.slack);
        if (!c) { touched.delete(id); continue; }
        if (!walking || (quiet.get(id) ?? -Infinity) > now || !shoveable(st, id, { rank, holds })) continue;
        const v = shoveV(vel, c.n, F); if (!v) continue;
        const at = [(box.min[0] + box.max[0]) / 2, (box.min[2] + box.max[2]) / 2]; const was = touched.get(id);
        if (was && (now - was.t < F.againMs || Math.hypot(at[0] - was.at[0], at[1] - was.at[1]) < F.moved)) continue;
        if (sent.length >= F.per10s || sent.filter((t) => now - t < 1000).length >= F.perSec) break;
        touched.set(id, { at, t: now }); sent.push(now); out.push({ id, v });
      }
      return out;
    },
    refused(id, now, code = null) { quiet.set(id, now + (PASSING.has(code) ? F.againMs : F.quietMs)); },
    touching: () => [...touched.keys()],
  };
}
