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

export type EffectiveView = {
  /** The folded entity, or undefined when `id` is not a thing (a body, or unknown). */
  entity(id: string): { pos: number[]; yaw?: number; scale?: number; comp?: Record<string, any> } | undefined;
  /** The live mount record for `id` (thing OR body), or undefined when unmounted. */
  mount(id: string): { to: string; slot?: string; offset?: number[]; yaw?: number } | undefined;
};

export type Effective =
  | { ok: true; pos: [number, number, number]; yaw: number;
      quat: [number, number, number, number]; scale: number;
      /** the motion type of the nearest moving link, or null when the chain stands still */
      moving: string | null }
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
    const pos: [number, number, number] = [parent.pos[0] + d[0], parent.pos[1] + d[1], parent.pos[2] + d[2]];
    const quat = qMul(parent.quat, qAxisAngle([0, 1, 0], rawYaw)) as [number, number, number, number];
    const yaw = yawOfQuat(quat);
    if (!fin3(pos) || !Number.isFinite(yaw)) return { ok: false, why: "composed transform is non-finite", link: id };
    return { ok: true, pos, yaw, quat, scale: parent.scale * ownScale, moving: parent.moving };
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
