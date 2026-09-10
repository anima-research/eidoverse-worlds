// Body perception: observations first, optional CPU geometry second. Reads
// never publish a pose, touch a body, or mutate the live reach solver.
import * as THREE from "three";
import { glbJson, humanBones, worldPositions, isVrm0 } from "./rig.ts";
import { CONTACT_POINTS, canonicalPoint } from "../shared/contact.js";
import { normalizeReachBag, TOUCH_GAP, sameReach } from "../shared/reachwire.js";
import { ReachBody } from "./physics.ts";
import { PoseClips } from "./pose-clips.ts";
import { CLIP_SLOTS } from "../shared/clipdefs.js";
import { planReaches, reachKey } from "../shared/reachorder.js";

export type PublicPose = {
  p: number[]; yaw: number; speed: number; clip: string;
  pose?: Record<string, number[]> | null; wingsFolded?: boolean; reach?: unknown;
  clipTime?: number; clipRate?: number; clipTimeSlot?: string; pitch?: number;
};
export type BodyObservation = {
  who: string; avatar: string; generation: number; self: boolean;
  connected: boolean; receivedAt: number | null; pose: PublicPose | null;
  source: "authored" | "physics" | "unknown";
  frame?: any; error?: string;
};
export const BODY_STALE_MS = 5000;
const finite3 = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const round = (n: number) => Math.round(n * 1000) / 1000;
const hasClipPhase = (p: PublicPose) => Number.isFinite(p.clipTime) && p.clipTime! >= 0 && (!p.clipTimeSlot || p.clipTimeSlot === p.clip);
type Rig = { P: Record<string, any>; parent: Record<string, string | null> };

/** Preserve every humanoid bone and its actual nearest humanoid ancestor,
 * including shoulders/fingers/upperChest. A ragdoll's collapsed 19-bone
 * hierarchy cannot read an authored shoulder or finger rotation faithfully. */
function parseRig(bytes: Uint8Array): Rig {
  const g = glbJson(bytes), bones = humanBones(g);
  if (!bones || !Number.isInteger(bones.hips)) throw new Error("avatar has no humanoid skeleton");
  const wp = worldPositions(g), P: Record<string, any> = {};
  const nodeParent = new Map<number, number>();
  g.nodes.forEach((n: any, i: number) => (n.children ?? []).forEach((j: number) => nodeParent.set(j, i)));
  const names = new Map<number, string>();
  for (const [name, index] of Object.entries(bones)) {
    if (!Number.isInteger(index) || !g.nodes[index as number]) continue;
    names.set(index as number, name);
    P[name] = wp(index);
  }
  const parent: Record<string, string | null> = {};
  for (const [index, name] of names) {
    let p = nodeParent.get(index), depth = 0;
    while (p != null && !names.has(p)) {
      if (++depth > g.nodes.length) throw new Error("cyclic skeleton");
      p = nodeParent.get(p);
    }
    parent[name] = p == null ? null : names.get(p)!;
  }
  Object.defineProperty(P, "__vrm0", { value: isVrm0(g) });
  return { P, parent };
}

function validate(o: BodyObservation) {
  if (o.error) return o.error;
  if (!o.pose || !finite3(o.pose.p) || !Number.isFinite(o.pose.yaw)) return "position or orientation is unknown";
  const bag = o.pose.pose;
  if (bag != null && (typeof bag !== "object" || Array.isArray(bag)
    || Object.values(bag).some(q => !Array.isArray(q) || q.length !== 4 || !q.every(Number.isFinite)
      || Math.hypot(...q) < 1e-9))) return "published bone rotations are malformed";
  return null;
}

function freshness(o: BodyObservation, now = Date.now()) {
  const ageMs = o.receivedAt == null ? null : Math.max(0, now - o.receivedAt);
  const status = validate(o) || ageMs == null ? "unknown"
    : !o.connected || ageMs > BODY_STALE_MS ? "stale" : "current";
  return { status, observedAt: o.receivedAt, ageMs, producedAt: null,
    clock: "local observation; producer timestamp unavailable", connected: o.connected };
}

/** Without evaluating the clip, a rest rig is not the current seated, lying,
 * walking, etc. body. An idle estimate and an explicitly supplied ragdoll
 * pose remain supported. The actual posture evaluator is tracked by #179. */
function postureUnavailable(o: BodyObservation) {
  const p = o.pose;
  return !CLIP_SLOTS.includes(p?.clip) && p?.clip !== "sitchair" && !(p?.clip === "ragdoll" && Object.keys(p.pose ?? {}).length > 0);
}

function missingPosture(out: any, o: BodyObservation) {
  return { ...out, ok: false, publishedRotations: structuredClone(o.pose?.pose ?? {}),
    error: `current-body geometry unavailable: posture '${o.pose?.clip ?? "unknown"}' is not evaluated`,
    geometry: { status: "incomplete", basis: "rest_pose_estimate", clip: o.pose?.clip ?? null,
      reason: "posture_not_evaluated", currentBodyTargets: false } };
}

function rootPoint(p: number[], pose: PublicPose) {
  const c = Math.cos(pose.yaw), s = Math.sin(pose.yaw);
  return [pose.p[0] + p[0] * c + p[2] * s, pose.p[1] + p[1], pose.p[2] - p[0] * s + p[2] * c];
}
function selfPoint(p: number[], pose: PublicPose) {
  const x = p[0] - pose.p[0], z = p[2] - pose.p[2], c = Math.cos(pose.yaw), s = Math.sin(pose.yaw);
  return [x * c - z * s, p[1] - pose.p[1], x * s + z * c];
}

export class BodyStateReader {
  // One immutable rig per participant's observed body generation. An old
  // in-flight fetch can finish, but cannot replace the new generation's entry.
  private rigs = new Map<string, { key: string; load: Promise<Rig> }>();
  private clips: PoseClips;
  private solveHistory = new Map<string, { generation: number; entry: any; history: any; at: number }>();
  constructor(private httpBase: string) { this.clips = new PoseClips(httpBase); }
  forget(who?: string) {
    if (who == null) { this.rigs.clear(); this.solveHistory.clear(); }
    else { this.rigs.delete(who); for (const key of this.solveHistory.keys()) if (JSON.parse(key)[0] === who) this.solveHistory.delete(key); }
  }

  private rig(o: BodyObservation): Promise<Rig> {
    const key = JSON.stringify([o.avatar, o.generation]);
    const old = this.rigs.get(o.who);
    if (old?.key === key) return old.load;
    const entry = { key, load: (async () => {
      if (!o.avatar) throw new Error("avatar identity is unknown");
      const r = await fetch(`${this.httpBase}/library/${o.avatar}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`avatar fetch failed (${r.status})`);
      return parseRig(new Uint8Array(await r.arrayBuffer()));
    })() };
    this.rigs.set(o.who, entry);
    entry.load.catch(() => { if (this.rigs.get(o.who) === entry) this.rigs.delete(o.who); });
    return entry.load;
  }

  /** A bounded measurement, not a claim about unseen browser animation.
   * Samples only this query's reconstructed skeleton; no background timer. */
  async readWindow(who: string, detail: string, points: unknown, windowMs: unknown, observe: (who: string) => BodyObservation | null) {
    if (!Number.isInteger(windowMs) || (windowMs as number) < 0 || (windowMs as number) > 5000) {
      return { ok: false, error: "window_ms must be an integer between 0 and 5000" };
    }
    if (!windowMs) return this.read(who, detail, points, observe);
    if (!["summary", "bones", "contacts", "all"].includes(detail)) return { ok: false, error: "detail must be summary, bones, contacts or all" };
    let last = await this.read(who, "all", points, observe);
    if (!last.ok) return last;
    const start = Date.now(), generation = last.bodyGeneration.value;
    let previous = last, previousAt = start, samples = 1, maxDelta = 0, maxSpeed = 0;
    let maxResidual = 0, measuredEndpoints = 0;
    const endpoint = (r: any) => {
      for (const e of Object.values(r.reachEvaluation ?? {}) as any[]) if (Number.isFinite(e.gap)) {
        maxResidual = Math.max(maxResidual, e.gap); measuredEndpoints++;
      }
    };
    endpoint(last);
    while (Date.now() - start < (windowMs as number)) {
      await new Promise(r => setTimeout(r, Math.min(100, (windowMs as number) - (Date.now() - start))));
      last = await this.read(who, "all", points, observe);
      if (!last.ok || last.bodyGeneration.value !== generation) return { ...last, ok: false,
        error: last.error ?? "body changed during observation window", stability: { status: "interrupted", samples } };
      const at = Date.now(), dt = (at - previousAt) / 1000;
      for (const [name, joint] of Object.entries(last.joints) as [string, any][]) {
        const a = previous.joints[name]?.rotation, b = joint.rotation;
        if (!a || !b) continue;
        const dot = Math.abs(a.reduce((s: number, v: number, i: number) => s + v * b[i], 0)) / (Math.hypot(...a) * Math.hypot(...b));
        const angle = 2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI;
        maxDelta = Math.max(maxDelta, angle);
        if (dt > 0) maxSpeed = Math.max(maxSpeed, angle / dt);
      }
      endpoint(last); samples++; previous = last; previousAt = at;
    }
    last.stability = { status: maxDelta > 0.01 ? "motion_observed" : "no_motion_observed", samples,
      durationMs: Date.now() - start, maxJointDeltaDeg: maxDelta, maxAngularVelocityDegS: maxSpeed,
      maxEndpointResidualM: measuredEndpoints ? maxResidual : null, branchFlips: null,
      scope: "sampled headless reconstruction; browser-only motion and between-sample changes are unobserved; solver supplies no branch identity" };
    if (detail === "summary") {
      delete last.publishedRotations; delete last.joints; delete last.contacts; delete last.unmappedBones;
    } else if (detail === "bones") delete last.contacts;
    else if (detail === "contacts") delete last.joints;
    return last;
  }

  async read(who: string, detail: string, requestedPoints: unknown, observe: (who: string) => BodyObservation | null): Promise<any> {
    if (!["summary", "bones", "contacts", "all"].includes(detail)) return { ok: false, error: "detail must be summary, bones, contacts or all" };
    let points = Object.keys(CONTACT_POINTS);
    if (requestedPoints != null) {
      if (!Array.isArray(requestedPoints) || requestedPoints.length > points.length || requestedPoints.some(p => typeof p !== "string" || !points.includes(canonicalPoint(p)))) {
        return { ok: false, error: "points must be a list of named body contacts", availablePoints: points };
      }
      points = [...new Set(requestedPoints.map(p => canonicalPoint(p)!))];
    }
    const initial = observe(who);
    if (!initial) return { ok: false, error: `${who} is not present` };
    const base = (o: BodyObservation): any => {
      const f = freshness(o), p = o.pose, valid = !validate(o);
      const bones = p?.pose ?? {}, reaches = normalizeReachBag(p?.reach);
      const count = valid ? Object.keys(bones).length : null;
      const wing = p?.wingsFolded === true ? ", wings folded" : p?.wingsFolded === false ? ", wings open" : "";
      return {
        ok: f.status === "current", who, avatar: o.avatar || null, self: o.self,
        bodyGeneration: { scope: "this observer", value: o.generation }, freshness: f,
        frame: o.frame ?? { source: "presence" },
        summary: `${who}: ${f.status}; ${valid ? `${p!.clip || "posture unknown"}${wing} at (${p!.p.map(round).join(", ")}), ${count} published bone override(s), ${Object.keys(reaches ?? {}).length} held reach(es)` : "pose unknown"}.`,
        root: valid ? { position: [...p!.p], yaw: p!.yaw, forward: [Math.sin(p!.yaw), 0, Math.cos(p!.yaw)] } : null,
        posture: p?.clip ?? null, wingsFolded: typeof p?.wingsFolded === "boolean" ? p.wingsFolded : null,
        overrides: { state: valid ? count ? "held" : "none" : "unknown", count, source: o.source,
          sourceBasis: o.self ? "owner state" : o.source === "physics" ? "ragdoll clip; original author unknown" : "producer does not publish provenance" },
        reaches: reaches ?? {},
        stability: { status: "unmeasured", reason: "single observation; use window_ms to measure reconstructed joint motion" },
        ...(f.status !== "current" ? { error: validate(o) ?? "body observation is stale; wait for a fresh presence sample" } : {}),
        ...(detail === "summary" ? { more: "detail:'bones' includes rotations and world joint positions; detail:'contacts' includes named points and reach targets; detail:'all' includes both" } : {}),
      };
    };
    let out = base(initial);
    if (detail === "summary" || !out.ok) return out;
    if (postureUnavailable(initial)) return missingPosture(out, initial);

    // Load the requested body and any body its public reach descriptors target.
    // Each query gets private nodes, so solving for readback cannot move the
    // actual body or another concurrent reader's scratch skeleton.
    const loaded = new Map<string, { observation: BodyObservation; body: ReachBody; animation: any; clip: string; rigKey: object }>();
    const loadBody = async (o: BodyObservation) => {
      const rig = await this.rig(o);
      const body = await ReachBody.fromSkeleton(rig.P, rig.parent);
      if (!body) throw new Error("CPU skeleton evaluator is unavailable");
      let animation = null;
      if (o.pose?.clip !== "ragdoll") {
        animation = await this.clips.load(o.pose?.clip ?? "idle");
      }
      loaded.set(o.who, { observation: o, body, animation, clip: o.pose?.clip ?? "idle", rigKey: rig });
    };
    try {
      const deps = new Map<string, BodyObservation>([[who, initial]]);
      for (const [owner, source] of deps) {
        if (deps.size > 64) throw new Error("reach dependency scene exceeds 64 bodies");
        for (const e of Object.values(normalizeReachBag(source.pose?.reach) ?? {}) as any[]) {
          const id = e.t.who ?? (e.t.space === "self" ? owner : e.t.space);
          if (id && !deps.has(id)) { const o = observe(id); if (o) deps.set(id, o); }
        }
      }
      const pendingBodies = deps.values();
      await Promise.all(Array.from({ length: Math.min(4, deps.size) }, async () => {
        for (let next = pendingBodies.next(); !next.done; next = pendingBodies.next()) {
          const o = next.value;
          // Bound parallel VRM downloads even when a relation spans a crowd.
          try { await loadBody(o); } catch (e) { if (o.who === who) throw e; }
        }
      }));
      const latest = observe(who);
      if (!latest || latest.generation !== initial.generation || latest.avatar !== initial.avatar) {
        return { ok: false, who, error: "body changed or left while its skeleton loaded; read again" };
      }
      out = base(latest);
      if (!out.ok) return out;
      if (postureUnavailable(latest)) return missingPosture(out, latest);
      if (loaded.get(who)?.clip !== latest.pose?.clip) return missingPosture(out, latest);
      for (const [id, item] of loaded) {
        const o = observe(id);
        if (!o || o.generation !== item.observation.generation || o.avatar !== item.observation.avatar || freshness(o).status !== "current" || postureUnavailable(o) || item.clip !== o.pose?.clip) {
          loaded.delete(id); continue;
        }
        item.observation = o;
        const mapped = Object.fromEntries(Object.entries(o.pose!.pose ?? {}).filter(([name]) => Object.hasOwn(item.body.av.nodes, name)));
        item.body.poseAt(o.pose!.p, o.pose!.yaw, null);
        if (item.animation) this.clips.apply(item.animation, item.body, hasClipPhase(o.pose!) ? o.pose!.clipTime! : 0, item.rigKey);
        if (Number.isFinite(o.pose!.pitch) && item.body.av.nodes.head) item.body.av.nodes.head.quaternion.premultiply(
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.max(-.5, Math.min(.6, o.pose!.pitch!))));
        for (const [name, q] of Object.entries(mapped)) item.body.av.nodes[name].quaternion.fromArray(q);
        item.body.av.root.updateMatrixWorld(true);
      }
      const own = loaded.get(who)!;
      const pose = own.observation.pose!;
      out.publishedRotations = structuredClone(pose.pose ?? {});
      out.poseEvaluation = { clip: pose.clip, source: own.animation ? "vrma" : pose.clip === "ragdoll" ? "published_physics" : "rest_pose_estimate",
        time: hasClipPhase(pose) ? pose.clipTime : 0, phase: hasClipPhase(pose) ? "published" : "initial_frame_estimate" };
      out.unmappedBones = Object.keys(pose.pose ?? {}).filter(n => !Object.hasOwn(own.body.av.nodes, n));
      out.reachEvaluation = {};
      const entries: any[] = [];
      for (const [owner, item] of loaded) for (const [limb, e] of Object.entries(normalizeReachBag(item.observation.pose?.reach) ?? {}) as [string, any][]) {
        entries.push({ owner, limb, target: e.t, entry: e });
      }
      const plan = planReaches(entries), evaluations = new Map<string, any>();
      for (const key of this.solveHistory.keys()) {
        const [owner, limb] = JSON.parse(key);
        if (loaded.has(owner) && !entries.some(e => e.owner === owner && e.limb === limb)) this.solveHistory.delete(key);
      }
      for (const e of plan.blocked) evaluations.set(reachKey(e.owner, e.limb), { ok: false, why: "cyclic-reach", reached: false });
      for (const task of plan.order) {
        const { owner, limb, entry: e } = task;
        const actor = loaded.get(owner)!;
        const actorPose = actor.observation.pose!;
        let target: any = null;
        if (e.t.who) target = loaded.get(e.t.who)?.body.contact(e.t.point, e.t.standoff ?? 0.02);
        else if (!e.t.space) target = e.t.p;
        else {
          // A root-relative point does not depend on the target's posture
          // clip or on loading its skeleton. Only named body contacts do.
          const other = e.t.space === "self" ? null : observe(e.t.space);
          const frame = e.t.space === "self" ? actorPose : other && freshness(other).status === "current" ? other.pose : null;
          if (frame) target = rootPoint(e.t.p, frame);
        }
        const key = reachKey(owner, limb), prior = this.solveHistory.get(key), at = Date.now();
        const history = prior?.generation === actor.observation.generation && sameReach(prior.entry, e) ? prior : null;
        const r: any = target ? actor.body.solve(limb, target, { palm: e.palm, apply: true, history: history?.history,
          dt: history ? Math.min(.1, Math.max(0, (at - history.at) / 1000)) : undefined }) : { ok: false, why: "target has no current usable body observation" };
        if (r.ok) this.solveHistory.set(key, { generation: actor.observation.generation, entry: e, history: r.history, at });
        const { history: _privateHistory, ...receipt } = r;
        evaluations.set(key, { ...receipt, target: Array.isArray(target) ? target : target?.pos, held: true, tracking: "requested", reached: r.ok && r.gap <= TOUCH_GAP });
      }
      for (const limb of Object.keys(normalizeReachBag(pose.reach) ?? {})) out.reachEvaluation[limb] = evaluations.get(reachKey(who, limb)) ?? { ok: false, why: "unresolved reach", reached: false };
      Object.defineProperty(out, "body", { value: own.body, enumerable: false });
      own.body.av.root.updateMatrixWorld(true);
      const incomplete = Object.values(out.reachEvaluation).some((r: any) => !r.ok);
      if (incomplete) { out.ok = false; out.error = "some held reaches could not be evaluated; geometry is incomplete"; }
      out.geometry = { status: incomplete ? "incomplete" : "derived", frame: "world", units: "metres", method: "humanoid skeleton + published rotations + limb IK",
        inputs: [...loaded.values()].map(({ observation: o }) => ({ who: o.who, observedAt: o.receivedAt, bodyGeneration: o.generation })),
        limitations: ["Base VRMA posture, pitch, published rotations and reach relations are evaluated; clip blending, emotes, gaze, wing/springbone motion and renderer interpolation are not reproduced.",
          "Contact surfaces are bone-bound anatomical estimates, not mesh measurements. Reach producers are evaluated before dependants; cyclic dependencies are reported as incomplete."] };
      if (detail === "bones" || detail === "all") {
        out.joints = Object.fromEntries(Object.entries(own.body.av.nodes).map(([name, raw]) => {
          const n = raw as any, position = n.getWorldPosition(new THREE.Vector3()).toArray();
          return [name, { position, selfPosition: selfPoint(position, pose), rotation: n.quaternion.toArray(),
            rotationSpace: "normalized bone local", quality: "derived" }];
        }));
      }
      if (detail === "contacts" || detail === "all") {
        out.contacts = Object.fromEntries(points.map(point => {
          const c = own.body.contact(point, 0); // report the surface, not reach's default 2cm standoff
          return [point, c ? { position: c.pos, normal: c.normal, selfPosition: selfPoint(c.pos, pose), quality: "anatomical_estimate",
            ...(!incomplete ? { reachTarget: { who, point } } : {}), bone: (CONTACT_POINTS as any)[point].bone }
            : { position: null, normal: null, quality: "unavailable", reason: "required bones are missing" }];
        }));
      }
      return out;
    } catch (e) {
      // Keep the exact published data useful even when the avatar cannot load.
      const latest = observe(who);
      if (!latest || latest.generation !== initial.generation || latest.avatar !== initial.avatar) {
        return { ok: false, who, error: "body changed or left while its skeleton loaded; read again" };
      }
      out = base(latest);
      if (latest.pose?.clip !== "ragdoll") return { ...missingPosture(out, latest), detail: e instanceof Error ? e.message : String(e) };
      out.ok = false;
      out.publishedRotations = structuredClone(latest.pose?.pose ?? {});
      out.geometry = { status: "unavailable", error: e instanceof Error ? e.message : String(e) };
      return out;
    }
  }
}
