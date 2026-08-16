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
  entity(id: string): { pos: number[]; yaw?: number; scale?: number; comp?: Record<string, any> } | undefined;
  /** The live mount record for `id` (thing OR body), or undefined when unmounted. */
  mount(id: string): { to: string; slot?: string; offset?: number[]; yaw?: number } | undefined;
  /** The SERVER-JUDGED seat verdict for this body's current avatar (#101) —
   *  the same value /avatars hands every consumer. Absent method or absent
   *  verdict both read as "no profile": this module never defaults a contact
   *  and never rederives one. */
  seatVerdict?(id: string): { pose?: string; status: string; contactY?: number; refusal?: string; which?: string } | undefined;
};

export type Effective =
  | { ok: true; pos: [number, number, number]; yaw: number;
      quat: [number, number, number, number]; scale: number;
      /** the motion type of the nearest moving link, or null when the chain stands still */
      moving: string | null;
      /** for seated BODIES only (#101): whether the profile correction is in
       *  this composition, or the declared reason it is not. Things never
       *  carry it. */
      seat?: { state: "profiled" | "approximate"; reason?: string } }
  | { ok: false; why: string; link: string };

const fin3 = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

/** Default local offset when neither the mount nor a socket provides one.
 *  Mirrors the browser exactly: world.js applyMount uses [0,0,0] for cargo,
 *  mountTransform uses [0,0.5,0] for a seated body. */
const defaultOffset = (isBody: boolean): [number, number, number] => (isBody ? [0, 0.5, 0] : [0, 0, 0]);

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

    const sock = m.slot ? view.entity(m.to)?.comp?.sockets?.[m.slot] : undefined;
    if (sock && typeof sock.part === "string") {
      // The seat rides a model part the browser animates from loaded geometry
      // (part rest transforms) this side does not possess. Refusing is the
      // honest option — slice one of #82; part support follows when the
      // geometry does.
      return { ok: false, why: `socket "${m.slot}" rides part "${sock.part}" of ${m.to} — part geometry unavailable here`, link: m.to };
    }

    // mount overrides beat socket defaults beat the kind's default — the
    // browser's exact precedence (world.js applyMount / mountTransform)
    const isBody = !e;
    const rawOff = m.offset ?? sock?.pos ?? defaultOffset(isBody);
    if (!fin3(rawOff)) return { ok: false, why: "non-finite mount/socket offset", link: id };
    const rawYaw = m.yaw ?? sock?.yaw ?? 0;
    if (!Number.isFinite(rawYaw)) return { ok: false, why: "non-finite mount/socket yaw", link: id };
    const ownScale = e?.scale ?? 1;
    if (!Number.isFinite(ownScale)) return { ok: false, why: "non-finite scale", link: id };

    // child world = parent world ∘ (scaled local offset, then local yaw) —
    // socket coords are model-frame, so the parent's world scale applies to
    // them (world.js runs the offset through matrixWorld for the same reason)
    const local: [number, number, number] = [rawOff[0] * parent.scale, rawOff[1] * parent.scale, rawOff[2] * parent.scale];
    const d = qApply(parent.quat, local);
    let pos: [number, number, number] = [parent.pos[0] + d[0], parent.pos[1] + d[1], parent.pos[2] + d[2]];
    // The profile correction (#101), bodies only: contact plane onto the
    // authored socket plane, along WORLD up (a mounted body renders upright —
    // yaw only — so the parent's tilted normal would smear it laterally; the
    // B2 discriminator). contactY is RIDER-root-local and multiplies the
    // rider's own scalar — which is 1 for every headless body by the named
    // shared definition (no code path scales an avatar root today); the
    // parent's scale must NOT touch it. The gate here is the contract half
    // (seatGateCore): this reader has no mixer, so the contract IS its
    // runtime truth; steady-state parity with the renderer is pinned by test.
    let seat: { state: "profiled" | "approximate"; reason?: string } | undefined;
    if (isBody) {
      const g = seatGateCore({ sock, verdict: view.seatVerdict?.(id), pose: sock?.pose ?? "sitchair" });
      if (g.apply) {
        const c = applySeatCorrection(pos, g.contactY, 1);
        if (c) { pos = c as [number, number, number]; seat = { state: "profiled" }; }
        else seat = { state: "approximate", reason: "non-finite correction" };
      } else seat = { state: "approximate", reason: g.reason };
    }
    const quat = qMul(parent.quat, qAxisAngle([0, 1, 0], rawYaw)) as [number, number, number, number];
    const yaw = yawOfQuat(quat);
    if (!fin3(pos) || !Number.isFinite(yaw)) return { ok: false, why: "composed transform is non-finite", link: id };
    return { ok: true, pos, yaw, quat, scale: parent.scale * ownScale, moving: parent.moving, ...(seat ? { seat } : {}) };
  }

  // ---- unmounted: the folded base, plus the thing's own whole-entity motion --
  if (!e) return { ok: false, why: "unknown id (not a thing, and not mounted)", link: id };
  if (!fin3(e.pos)) return { ok: false, why: "non-finite folded position", link: id };
  const yaw0 = e.yaw ?? 0;
  const scale = e.scale ?? 1;
  if (!Number.isFinite(yaw0) || !Number.isFinite(scale)) return { ok: false, why: "non-finite folded transform", link: id };

  const motion = e.comp?.motion;
  if (motion && motion.type != null) {
    const r = evalWholeMotion({ pos: e.pos, yaw: yaw0 }, motion, nowMs);
    if (!r.ok) return { ok: false, why: r.why, link: id };
    // part-carrying motion returns the base unmoved (parts swing, roots
    // stand still) — report the chain as still in that case
    const rootMoved = typeof motion.part !== "string";
    return { ok: true, pos: r.pos as [number, number, number], yaw: r.yaw,
      quat: r.quat as [number, number, number, number], scale,
      moving: rootMoved ? String(motion.type) : null };
  }

  return { ok: true, pos: [e.pos[0], e.pos[1], e.pos[2]], yaw: yaw0,
    quat: qAxisAngle([0, 1, 0], yaw0) as [number, number, number, number], scale, moving: null };
}
