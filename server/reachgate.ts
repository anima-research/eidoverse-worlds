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
/** a body's root frame → world, as three.js root.localToWorld does it (yaw about +y, then the body's scale) */
function frameToWorld(p: number[], yaw: number, s: number, local: number[]) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), l = local.map((v) => v * s);
  return [p[0] + l[0] * cy + l[2] * sy, p[1] + l[1], p[2] - l[0] * sy + l[2] * cy];
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
  if (t.space === "self" || t.space === c.id) return fin3(pose.p) ? bodiesAt(c, frameToWorld(pose.p, Number(pose.yaw) || 0, scaleOf(pose), t.p)) : null;
  const tc = legNamed(c, t.space); if (!tc) return null;
  if (sameBody(c, tc)) return [];
  const cls = pointClass([0, 0, 0], t.p) as Cls | null;   // in their own root frame, so already at their size
  return cls ? [{ tc, cls, point: null }] : [];
}

/** Takes out of `pose.reach` (in place) every limb aimed at a body that hasn't consented to it. Then tells the authority
 *  which bodies a relayed limb rests on: a yes to an ask is one touch, and ends on the first packet without its hand
 *  (an absent reach is "nobody is reaching", reachwire.js). */
export function gateReach(c: Client, pose: Record<string, unknown>): void {
  const log = c.world?.log, aimed = new Set<string>();
  const letGo = () => { if (log && c.actorId) log.reachLetGo(c.actorId, aimed); };
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
      const v = log && c.actorId && h.tc.actorId ? log.reachAdmits(c.actorId, h.tc.actorId, h.cls, { point: h.point, limb }) : { ok: false };
      if (!v.ok) { delete bag[limb]; admitted = false; break; }
    }
    if (admitted) for (const h of hits) if (h.tc.actorId) aimed.add(h.tc.actorId);
  }
  if (!Object.keys(bag).length) delete pose.reach;
  letGo();
}
