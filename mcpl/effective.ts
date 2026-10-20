// effective — where a thing ACTUALLY is, composed at read time (#82).
//
// The fold keeps a mounted entity's pre-mount `pos` untouched — that is
// correct log-truth (dismount stamps a fresh absolute; nothing here changes
// that invariant). But perception must never present that stale coordinate
// as current while also saying "mounted on". This module walks the mount
// chain the way the browser's scene graph does — parent base pose, the
// parent's whole-entity motion at `nowMs` (via the SAME evaluator the
// renderer runs, client/lib/motioneval.js), mount offset/yaw overrides
// before socket defaults, socket local frame, recursively mounted parents —
// and returns either a finite world transform or an explicit refusal naming
// the first link it will not vouch for. No partially composed number is
// ever returned as truth.
//
// Pure by construction: state comes in through a caller-supplied view,
// time comes in as an argument. agent.ts wraps it; tests drive it bare.

import { evalWholeMotion, qMul, qApply, qAxisAngle, yawOfQuat } from "../client/lib/motioneval.js";
import { seatGateCore, applySeatCorrection } from "../client/lib/seatcore.js";

export type EffectiveView = {
  /** The folded entity, or undefined when `id` is not a thing (a body, or unknown). */
  entity(id: string): { pos: number[]; yaw?: number; scale?: number; scale3?: number[]; q?: number[]; comp?: Record<string, any> } | undefined;
  /** The live mount record for `id` (thing OR body), or undefined when unmounted. A body's seat is a socket entity
   *  ({to: <socket id>}: PLAN-sockets-entities); a thing's mount is its fold parent (offset/q local to it). */
  mount(id: string): { to: string; offset?: number[]; yaw?: number; q?: number[] } | undefined;
  /** The SERVER-JUDGED seat verdict for this body's current avatar (#101) —
   *  the same value /avatars hands every consumer. Absent method or absent
   *  verdict both read as "no profile": this module never defaults a contact
   *  and never rederives one. */
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
      /** for seated BODIES only (#101): whether the profile correction is in
       *  this composition, or the declared reason it is not. Things never
       *  carry it. */
      seat?: { state: "profiled" | "approximate"; reason?: string } }
  | { ok: false; why: string; link: string };

const fin3 = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const fin4 = (v: unknown): v is [number, number, number, number] =>
  Array.isArray(v) && v.length === 4 && v.every(Number.isFinite);
/** A record's per-axis scale (scale3), else three of its one-number scale. */
const scale3Of = (e: { scale?: number; scale3?: number[] }, s: number): [number, number, number] =>
  fin3(e.scale3) ? [e.scale3[0], e.scale3[1], e.scale3[2]] : [s, s, s];

/** Default local offset when the mount gives none: the parent's origin — for a body on a socket, the socket itself
 *  (the browser: world.js mountTransform reads the socket's own frame; realize/models.js execMount [0,0,0]). */
const DEFAULT_OFFSET: [number, number, number] = [0, 0, 0];
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

  // A socket that rides a model part: the browser carries it in the part's node (animated from loaded geometry, part
  // rest transforms this side does not possess). Refusing is the honest option — slice one of #82; part support follows
  // when the geometry does. Everything on it (an occupant, cargo) inherits the refusal through the chain.
  const ownSock = socketOf(e);
  if (ownSock && typeof ownSock.part === "string")
    return { ok: false, why: `socket "${ownSock.name}" rides part "${ownSock.part}" of ${m?.to ?? "its host"} — part geometry unavailable here`, link: m?.to ?? id };

  // ---- mounted: the parent's frame is the truth, recursively -----------------
  // A mounted entity's OWN root motion is deliberately inert here — the
  // renderer does exactly this (motion.js tickMotion: `if (!obj ||
  // obj.userData.mountedTo) continue` — mounted things ride their parent),
  // so the defined composition order is: mount chain wins, own root motion
  // resumes on dismount. Pinned by test (#92 review, "additional precision").
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
    const local: [number, number, number] = [rawOff[0] * parent.scale3[0], rawOff[1] * parent.scale3[1], rawOff[2] * parent.scale3[2]];
    const d = qApply(parent.quat, local);
    let pos: [number, number, number] = [parent.pos[0] + d[0], parent.pos[1] + d[1], parent.pos[2] + d[2]];
    // The profile correction (#101), bodies only: contact plane onto the
    // authored socket plane, along WORLD up (a mounted body renders upright —
    // yaw only — so the parent's tilted normal would smear it laterally; the
    // B2 discriminator). contactY is measured at the occupant's AUTHORED size and
    // multiplies the occupant's own scalar — its chosen body size, which the
    // browser feeds occupantScalar from avatar.bodyScale() (a 2× body's seat
    // contact sits twice as far below its root); the parent's scale must NOT
    // touch it. The gate here is the contract half
    // (seatGateCore): this reader has no mixer, so the contract IS its
    // runtime truth; steady-state parity with the renderer is pinned by test.
    let seat: { state: "profiled" | "approximate"; reason?: string } | undefined;
    if (isBody) {
      const station = (view.entity(m.to) as any)?.station;   // what a body does at the socket (shape audit 10-16: once socket.body)
      const g = seatGateCore({ sock: station, verdict: view.seatVerdict?.(id), pose: typeof (station?.anim ?? station?.pose) === "string" ? (station.anim ?? station.pose) : "sitchair" });   // anim (R 10-17; pose before)
      if (g.apply) {
        const rs = view.occupantScale?.(id) ?? 1;
        const c = applySeatCorrection(pos, g.contactY, Number.isFinite(rs) && rs > 0 ? rs : 1);
        if (c) { pos = c as [number, number, number]; seat = { state: "profiled" }; }
        else seat = { state: "approximate", reason: "non-finite correction" };
      } else seat = { state: "approximate", reason: g.reason };
    }
    // the whole relative rotation where the mount carries one (a tilted socket, cargo at an angle), else its heading
    const quat = qMul(parent.quat, rawQ ?? qAxisAngle([0, 1, 0], rawYaw)) as [number, number, number, number];
    const yaw = yawOfQuat(quat);
    if (!fin3(pos) || !Number.isFinite(yaw)) return { ok: false, why: "composed transform is non-finite", link: id };
    const own3 = e ? scale3Of(e, ownScale) : [1, 1, 1];
    const scale3: [number, number, number] = [parent.scale3[0] * own3[0], parent.scale3[1] * own3[1], parent.scale3[2] * own3[2]];
    if (!fin3(scale3)) return { ok: false, why: "non-finite scale", link: id };
    return { ok: true, pos, yaw, quat, scale: parent.scale * ownScale, scale3, moving: parent.moving, ...(seat ? { seat } : {}) };
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
    // part-carrying motion returns the base unmoved (parts swing, roots
    // stand still) — report the chain as still in that case
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
