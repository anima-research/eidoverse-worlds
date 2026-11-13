// effective — where a thing ACTUALLY is, composed at read time (#82).
//
// The fold keeps a mounted entity's pre-mount `pos` (log-truth; dismount stamps a fresh absolute), so perception
// must not report it. This walks the mount chain as the browser's scene graph does (parent pose, the parent's motion
// at `nowMs` via shared/motioneval.js, mount offset/yaw, socket frame, recursively) and returns a finite world
// transform or a refusal naming the first link it won't vouch for — never a partially composed number.
//
// Pure: state comes in through a caller-supplied view, time as an argument. agent.ts wraps it; tests drive it bare.

import { evalWholeMotion, qMul, qApply, qAxisAngle, yawOfQuat } from "../shared/motioneval.js";
import { seatGateCore, applySeatCorrection } from "../shared/seatcore.js";

export type EffectiveView = {
  /** The folded entity, or undefined when `id` is not a thing (a body, or unknown). */
  entity(id: string): { pos: number[]; yaw?: number; scale?: number; scale3?: number[]; q?: number[]; comp?: Record<string, any> } | undefined;
  /** The live mount record for `id` (thing OR body), or undefined when unmounted. A body's seat is a socket entity
   *  ({to: <socket id>}); a thing's mount is its fold parent (offset/q local to it). */
  mount(id: string): { to: string; offset?: number[]; yaw?: number; q?: number[] } | undefined;
  /** The SERVER-JUDGED seat verdict for this body's avatar (as /avatars serves it). Absent reads as "no profile":
   *  this module never defaults or rederives a contact. */
  seatVerdict?(id: string): { pose?: string; status: string; contactY?: number; refusal?: string; which?: string } | undefined;
  /** A seated BODY's chosen size (presence `pose.scale`, clamped; absent = 1) —
   *  the browser's occupantScalar input (occupants.js: root scale × avatar.bodyScale()).
   *  Absent method reads as 1. */
  occupantScale?(id: string): number;
};

export type Effective =
  | { ok: true; pos: [number, number, number]; yaw: number;
      quat: [number, number, number, number]; scale: number;
      /** the per-axis scale a stretched link carries (a uniform one: three of `scale`) */
      scale3: [number, number, number];
      /** the motion type of the nearest moving link, or null when the chain stands still */
      moving: string | null;
      /** seated BODIES only: whether the profile correction is applied, or why not */
      seat?: { state: "profiled" | "approximate"; reason?: string };
      /** a turned mount on an unequally stretched parent (here or up the chain): the true shape is a shear, so `scale3` is
       *  its diagonal (approximate); pos and quat are exact */
      sheared?: true;
      /** the exact 3×3 linear part (rows) of a mounted link's frame, shear included: what a descendant's offset goes through */
      lin?: number[][] }
  | { ok: false; why: string; link: string };

const fin3 = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const fin4 = (v: unknown): v is [number, number, number, number] =>
  Array.isArray(v) && v.length === 4 && v.every(Number.isFinite);
/** A record's per-axis scale (scale3), else three of its one-number scale. */
const scale3Of = (e: { scale?: number; scale3?: number[] }, s: number): [number, number, number] =>
  fin3(e.scale3) ? [e.scale3[0], e.scale3[1], e.scale3[2]] : [s, s, s];

/** R(q)·diag(s) as rows: the linear part of a frame turned by q and stretched by s along its own axes. */
const linQS = (q: number[], s: number[]): number[][] => { const c = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((v) => qApply(q, v));
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => c[j][i] * s[j])); };
const mulM = (A: number[][], B: number[][]) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
const applyM = (M: number[][], v: number[]): [number, number, number] => [0, 1, 2].map((i) => M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2]) as [number, number, number];

/** Default local offset when the mount gives none: the parent's origin — for a body on a socket, the socket itself
 *  (the browser: world.js mountTransform reads the socket's own frame; realize/models.js execMount [0,0,0]). */
const DEFAULT_OFFSET: [number, number, number] = [0, 0, 0];
/** Marks a refusal on a part-riding socket, so partHint can tell the agent that retrying won't help. */
export const PART_UNAVAILABLE = "part geometry unavailable here";
export const partHint = (why: string) => (why.includes(PART_UNAVAILABLE)
  ? "; asking again won't change that (this door can't place a model's parts), but a point near it will: face {x, z} or move {to: [x, z]} at coordinates beside it"
  : "");
const socketOf = (e: { comp?: Record<string, any> } | undefined) => {
  const s = e?.socket; return s && typeof s === "object" && !Array.isArray(s) ? s : undefined; };

export function effectiveWorldTransform(
  id: string, view: EffectiveView, nowMs: number, maxDepth = 8,
): Effective {
  return resolve(id, view, nowMs, maxDepth, new Set());
}

function resolve(id: string, view: EffectiveView, nowMs: number, depth: number, seen: Set<string>): Effective {
  if (seen.has(id)) return { ok: false, why: `mount cycle (${[...seen, id].join(" → ")})`, link: id };
  if (depth <= 0) return { ok: false, why: "mount chain deeper than supported", link: id };
  seen.add(id);

  const e = view.entity(id);
  const m = view.mount(id);

  // A socket on a model part needs part geometry this side doesn't have: refuse, and everything on it inherits that.
  const ownSock = socketOf(e);
  if (ownSock && typeof ownSock.part === "string")
    return { ok: false, why: `socket "${ownSock.name}" rides part "${ownSock.part}" of ${m?.to ?? "its host"} — ${PART_UNAVAILABLE}`, link: m?.to ?? id };

  // ---- mounted: the parent's frame is the truth, recursively -----------------
  // A mounted entity's own root motion is inert, as in the renderer (client/lib/motion.js): the mount chain wins.
  if (m) {
    if (!m.to || m.to === id) return { ok: false, why: "malformed mount (no parent)", link: id };
    const parent = resolve(m.to, view, nowMs, depth - 1, seen);
    if (!parent.ok) return parent;                     // the FIRST unsupported link names itself


    // the mount's own local pose (local to what it rides: the browser's execMount), else the parent's origin
    const isBody = !e;
    const rawOff = m.offset ?? DEFAULT_OFFSET;
    if (!fin3(rawOff)) return { ok: false, why: "non-finite mount/socket offset", link: id };
    const rawYaw = m.yaw ?? 0;
    if (!Number.isFinite(rawYaw)) return { ok: false, why: "non-finite mount/socket yaw", link: id };
    const rawQ = Array.isArray(m.q) && m.q.length === 4 ? m.q : null;
    if (rawQ && !rawQ.every(Number.isFinite)) return { ok: false, why: "non-finite mount rotation", link: id };
    const ownScale = e?.scale ?? 1;
    if (!Number.isFinite(ownScale)) return { ok: false, why: "non-finite scale", link: id };

    // child world = parent world ∘ (scaled local offset, then local yaw) —
    // socket coords are model-frame, so the parent's world scale applies to
    // them (world.js runs the offset through matrixWorld for the same reason)
    const PL = parent.lin ?? linQS(parent.quat, parent.scale3);   // a sheared parent's whole linear part, not its diagonal
    const d = applyM(PL, rawOff);
    let pos: [number, number, number] = [parent.pos[0] + d[0], parent.pos[1] + d[1], parent.pos[2] + d[2]];
    // Seat profile correction, bodies only: contact plane onto the socket plane along WORLD up (a seated body renders
    // upright). contactY is at the AUTHORED size and scales by the occupant's own body size, never the parent's.
    let seat: { state: "profiled" | "approximate"; reason?: string } | undefined;
    if (isBody) {
      const station = (view.entity(m.to) as any)?.station;   // what a body does at the socket
      const g = seatGateCore({ sock: station, verdict: view.seatVerdict?.(id), pose: typeof (station?.anim ?? station?.pose) === "string" ? (station.anim ?? station.pose) : "sitchair" });   // `anim`, else the older `pose`
      if (g.apply) {
        const rs = view.occupantScale?.(id) ?? 1;
        const c = applySeatCorrection(pos, g.contactY, Number.isFinite(rs) && rs > 0 ? rs : 1);
        if (c) { pos = c as [number, number, number]; seat = { state: "profiled" }; }
        else seat = { state: "approximate", reason: "non-finite correction" };
      } else seat = { state: "approximate", reason: g.reason };
    }
    // the whole relative rotation where the mount carries one (a tilted socket, cargo at an angle), else its heading
    const localQ = rawQ ?? qAxisAngle([0, 1, 0], rawYaw);
    const quat = qMul(parent.quat, localQ) as [number, number, number, number];
    const yaw = yawOfQuat(quat);
    if (!fin3(pos) || !Number.isFinite(yaw)) return { ok: false, why: "composed transform is non-finite", link: id };
    // the parent's stretch in the child's axes: S' = Rᵀ · diag(parent) · R for the mount's turn R. A turn mixing two
    // unequally stretched axes makes a shear: pos/quat stay exact, scale3 is its diagonal, flagged `sheared`.
    const ax = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((v) => qApply(localQ, v));
    const sp = (i: number, j: number) => ax[i][0] * ax[j][0] * parent.scale3[0] + ax[i][1] * ax[j][1] * parent.scale3[1] + ax[i][2] * ax[j][2] * parent.scale3[2];
    const big = Math.max(...parent.scale3.map(Math.abs));
    const sheared = !!e && [[0, 1], [0, 2], [1, 2]].some(([i, j]) => Math.abs(sp(i, j)) > 1e-6 * big);
    const own3 = e ? scale3Of(e, ownScale) : [1, 1, 1];
    const scale3: [number, number, number] = [sp(0, 0) * own3[0], sp(1, 1) * own3[1], sp(2, 2) * own3[2]];
    if (!fin3(scale3)) return { ok: false, why: "non-finite scale", link: id };
    const lin = mulM(PL, linQS(localQ, own3));
    return { ok: true, pos, yaw, quat, scale: parent.scale * ownScale, scale3, moving: parent.moving, ...(seat ? { seat } : {}), ...(sheared || parent.sheared ? { sheared: true } : {}), lin };
  }

  // ---- unmounted: the folded base, plus the thing's own whole-entity motion --
  if (!e) return { ok: false, why: "unknown id (not a thing, and not mounted)", link: id };
  if (!fin3(e.pos)) return { ok: false, why: "non-finite folded position", link: id };
  const yaw0 = e.yaw ?? 0;
  const scale = e.scale ?? 1;
  if (!Number.isFinite(yaw0) || !Number.isFinite(scale)) return { ok: false, why: "non-finite folded transform", link: id };
  const scale3 = scale3Of(e, scale);
  if (!fin3(scale3)) return { ok: false, why: "non-finite folded transform", link: id };

  const motion = e?.motion;
  if (motion && motion.type != null) {
    const pv = (e as any)?.pivot?.pos; const s3 = Array.isArray((e as any).scale3) ? (e as any).scale3 : [scale, scale, scale];
    const r = evalWholeMotion({ pos: e.pos, yaw: yaw0, ...(fin4(e.q) ? { q: e.q } : {}), ...(Array.isArray(pv) && pv.length === 3 ? { pivot: pv.map((v: number, i: number) => v * s3[i]) } : {}) }, motion, nowMs);   // the same hinge the renderer swings about
    if (!r.ok) return { ok: false, why: r.why, link: id };
    // part-carrying motion leaves the root still (parts swing): report the chain as still
    const rootMoved = typeof motion.part !== "string";
    return { ok: true, pos: r.pos as [number, number, number], yaw: r.yaw,
      quat: r.quat as [number, number, number, number], scale, scale3,
      moving: rootMoved ? String(motion.type) : null };
  }

  // A live pose (a vehicle lease) may carry a full orientation, and so may the stored transform (a pitched or rolled
  // root, its q): honour either, so occupants and sockets compose with the tilt too. Else the heading alone.
  const leased = fin4(e.livePose?.q) ? e.livePose.q as [number, number, number, number] : null;
  const stored = fin4(e.q) ? [e.q[0], e.q[1], e.q[2], e.q[3]] as [number, number, number, number] : null;
  const q0 = leased ?? stored ?? qAxisAngle([0, 1, 0], yaw0) as [number, number, number, number];
  return { ok: true, pos: [e.pos[0], e.pos[1], e.pos[2]], yaw: leased || stored ? yawOfQuat(q0) : yaw0,
    quat: q0, scale, scale3, moving: e.livePose ? "leased" : null };
}
