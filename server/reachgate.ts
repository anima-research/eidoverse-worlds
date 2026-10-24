// server/reachgate.ts — touch consent at the relay (design review 10-15, "spec vs code" item 1). A reach travels as a
// descriptor inside the presence packet (shared/reachwire.js) and every receiver draws the hand where it points, so the gate
// for touching someone can't be the target's own client (it doesn't render other people's screens) and can't be a request
// nobody sends: it is here, on the one path every pose takes. Each limb whose target is ANOTHER body is held to that body's
// table through the authority (WorldLog.reachAdmits → authority.js reachAdmits); a refused limb is taken out of the packet,
// and the rest of the pose relays as it came. Presence only: nothing is logged. Judged by where the hand is aimed, as the
// authority judges a reach (42 P8): a named point by the social/intimate split, a bare point by the body capsule it falls in.
import { namedPointClass, pointClass } from "../shared/protocol/consent.js";
import { normalizeReachTarget, REACH_LIMBS } from "../shared/reachwire.js";
import type { Client } from "./world.ts";

type Cls = "touch" | "intimate";
type Hit = { tc: Client; cls: Cls; point: string | null };

const fin3 = (p: unknown): p is number[] => Array.isArray(p) && p.length === 3 && p.every((n) => typeof n === "number" && Number.isFinite(n));
const scaleOf = (pose: any) => (typeof pose?.scale === "number" && Number.isFinite(pose.scale) && pose.scale > 0 ? pose.scale : 1);
const bodyLeg = (o: Client) => !o.spectator && (o.surface ?? "world") === "world";
const sameBody = (c: Client, o: Client) => o === c || (!!c.actorId && o.actorId === c.actorId);
/** a body's root frame → world, as three.js root.localToWorld does it: the body's scale, then its turn, which is `q` when
 *  the pose carries one (a swimmer's whole-body turn: remotes.js gives q precedence over yaw) and else yaw about +y */
function frameToWorld(pose: any, local: number[]): number[] | null {
  if (!fin3(pose?.p)) return null;
  const p = pose.p as number[], s = scaleOf(pose), l = local.map((v) => v * s);
  const q = pose.q;
  if (Array.isArray(q) && q.length === 4 && q.every((n: unknown) => typeof n === "number" && Number.isFinite(n))) {
    const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1, x = q[0] / n, y = q[1] / n, z = q[2] / n, w = q[3] / n;
    // v' = v + 2w (u × v) + 2 u × (u × v), u = (x, y, z)
    const cx = y * l[2] - z * l[1], cy = z * l[0] - x * l[2], cz = x * l[1] - y * l[0];
    const dx = y * cz - z * cy, dy = z * cx - x * cz, dz = x * cy - y * cx;
    return [p[0] + l[0] + 2 * (w * cx + dx), p[1] + l[1] + 2 * (w * cy + dy), p[2] + l[2] + 2 * (w * cz + dz)];
  }
  const yaw = Number(pose.yaw) || 0, c = Math.cos(yaw), sn = Math.sin(yaw);
  return [p[0] + l[0] * c + l[2] * sn, p[1] + l[1], p[2] - l[0] * sn + l[2] * c];
}
/** which other bodies a world point is in (their capsule, scaled to their size), and how */
function bodiesAt(c: Client, pt: number[]): Hit[] {
  const out: Hit[] = [];
  for (const o of c.world?.clients ?? []) {
    if (!bodyLeg(o) || sameBody(c, o) || !fin3(o.lastPose?.p)) continue;
    const at = o.lastPose!.p!, s = scaleOf(o.lastPose);
    const cls = pointClass([0, 0, 0], [(pt[0] - at[0]) / s, (pt[1] - at[1]) / s, (pt[2] - at[2]) / s]) as Cls | null;
    if (cls) out.push({ tc: o, cls, point: null });
  }
  return out;
}
const legNamed = (c: Client, name: string) => [...(c.world?.clients ?? [])].find((o) => o.id === name && bodyLeg(o)) ?? null;

/** The bodies one limb's target lands on: [] for open air or your own body, null for a body that isn't here. */
function touched(c: Client, pose: any, t: any): Hit[] | null {
  if (t.who !== undefined) {
    if (t.who === c.id) return [];
    const tc = legNamed(c, t.who); if (!tc) return null;
    if (sameBody(c, tc)) return [];
    const np = namedPointClass(t.point); if (!np) return null;   // one classifier with the reach verb (consent.js)
    return [{ tc, cls: np.cls as Cls, point: np.point }];
  }
  if (t.space === undefined) return bodiesAt(c, t.p);
  if (t.space === "self" || t.space === c.id) { const at = frameToWorld(pose, t.p); return at ? bodiesAt(c, at) : null; }
  const tc = legNamed(c, t.space); if (!tc) return null;
  if (sameBody(c, tc)) return [];
  // the point is drawn where it lands in the world (reachnet.js resolves it in their frame), so it is held to every body it
  // lands in, not only theirs: a point in Vic's frame that rests on Tom is Tom's to allow
  const cls = pointClass([0, 0, 0], t.p) as Cls | null;   // in their own root frame, so already at their size
  const own: Hit[] = cls ? [{ tc, cls, point: null }] : [];
  const at = frameToWorld(tc.lastPose, t.p);
  return at ? [...own, ...bodiesAt(c, at).filter((h) => h.tc !== tc && !sameBody(tc, h.tc))] : own;
}

/** Takes out of `pose.reach` (in place) every limb aimed at a body that hasn't consented to it. Then tells the authority
 *  which bodies a relayed limb rests on: a yes to an ask is one touch, and ends on the first packet without its hand
 *  (an absent reach is "nobody is reaching", reachwire.js).
 *
 *  `quiet`: the server re-holding a standing pose to the tables (after a request), not a packet the reacher sent: a limb that
 *  no longer may rest is taken out without a refusal said or an attempt recorded, and no grant is let go here. */
export function gateReach(c: Client, pose: Record<string, unknown>, { quiet = false } = {}): void {
  const log = c.world?.log, aimed = new Set<string>();
  const letGo = () => { if (log && c.actorId && !quiet) log.reachLetGo(c.actorId, aimed); };
  const bag = pose.reach as Record<string, any> | null | undefined;
  if (bag == null) return letGo();
  if (typeof bag !== "object" || Array.isArray(bag)) { delete pose.reach; return letGo(); }
  for (const limb of Object.keys(bag)) {
    if (!REACH_LIMBS.includes(limb)) { delete bag[limb]; continue; }   // receivers drop it too; nobody draws it
    const t = normalizeReachTarget(bag[limb]?.t);
    const hits = t ? touched(c, pose, t) : null;
    // no target a receiver would draw, or a body that isn't here (whoever arrives under the name next would wear the hand)
    if (!hits) { delete bag[limb]; continue; }
    let admitted = true;
    for (const h of hits) {
      const v = log && c.actorId && h.tc.actorId ? log.reachAdmits(c.actorId, h.tc.actorId, h.cls, { point: h.point, limb, quiet }) : { ok: false };
      if (!v.ok) { delete bag[limb]; admitted = false; break; }
    }
    if (admitted) for (const h of hits) if (h.tc.actorId) aimed.add(h.tc.actorId);
  }
  if (!Object.keys(bag).length) delete pose.reach;
  letGo();
}
