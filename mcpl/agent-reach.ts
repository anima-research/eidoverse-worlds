// The agent's reaching: hands and feet reaching for points, things and people (shared/reachwire.js), and its consent.
// Its public members are the body's (one-line delegates in agent.ts), and it calls them there (this.a.x), as before.

import type { WorldAgent } from "./agent.ts";
import { REACH_NOTE_MS, namedPointClass, pointClass } from "../shared/protocol/consent.js";
import { type ActResult, type Pose, done, refused, posePosition } from "./agent-result.ts";
import { ReachBody } from "./physics.ts";
import { names } from "../shared/places.js";
import { clampBodyScale } from "../shared/presencewire.js";
import { canonicalLimb, normalizeReachTarget, normalizeReachBag, describeTarget, diffReach, TOUCH_GAP, sameReach } from "../shared/reachwire.js";
import { shown } from "../shared/shown.js";
import { DEFAULT_BODY } from "../shared/avatardefs.js";

/** reach and clear_reach refuse a limb in the same words. */
const unknownLimb = (raw: unknown, done: string) =>
  `there's no limb called ${shown(raw)}, so nothing was ${done}; limb takes leftHand, rightHand, leftFoot or rightFoot`;
/** A point in a body's root frame → world, matching THREE's rotation.y=yaw
 *  (x' = x·cos + z·sin, z' = −x·sin + z·cos) — the same transform every
 *  browser's localToWorld applies to the same descriptor. */
function frameToWorld(p: number[], yaw: number, local: number[]): number[] {
  const c = Math.cos(yaw ?? 0), s = Math.sin(yaw ?? 0);
  return [
    p[0] + local[0] * c + local[2] * s,
    (p[1] ?? 0) + local[1],
    p[2] - local[0] * s + local[2] * c,
  ];
}

export class AgentReach {
  constructor(readonly a: WorldAgent) {}

  // ---- reaching: a relation streamed as a descriptor ----------------------
  //
  // The descriptor (shared/reachwire.js) rides the presence packet, and every
  // browser re-solves the IK against its own scene. HERE is only what a blind
  // body needs: resolving the target from presence + stand-in skeletons
  // (physics.ts ReachBody), solving its arm once for the tool reply, and keeping
  // the `reached` attestation honest (its rising edge is the touch event).
  private reachBodies = new Map<string, ReachBody | null>();               // avatar path -> solver body
  private reachBodyLoads = new Map<string, Promise<ReachBody | null>>();
  reachTicks = 0;
  private reachReading: any = null;
  private reachReadingEpoch = 0;
  private reachReadingBusy = false;
  private async refreshReachReading() {
    const epoch = ++this.reachReadingEpoch;
    const reading = await this.a.bodyState(this.a.name, "all");
    if (epoch === this.reachReadingEpoch) this.reachReading = reading;
  }

  /** reach/touch ping refractory, keyed "kind:who:limb" — a hand trembling
   *  across the touch threshold must not knock twice. */
  lastReachPing = new Map<string, number>();
  /** Stop streaming the limb a refusal names (the relay strips it anyway). Only that one: another limb on the same body may
   *  be one they consented to (r2 holes F9). A refusal from a server that doesn't name the limb drops the limbs held to that
   *  body in the refused class. */
  dropReachesAt(actor: string, limb?: string, cls?: string): string[] {
    const name = this.a.nameOfActor(actor), out: string[] = [];
    for (const [l, e] of [...this.a.reaches]) {
      // a limb's refusal is that reach's only while the relay still holds the reach to the refuser's body (reachHolders: the
      // body it names, and every body its point lands in), or the reach is a world point, which the relay judges by where it
      // lands now: a newer reach on the same hand held to nobody who refused stays
      const held = name ? this.reachHolders(e.t).find((h) => h.name === name) : undefined, atBody = e.t?.who != null || e.t?.space != null;
      const hit = limb !== undefined ? l === limb && (!!held || !atBody) : !!held && (!cls || held.cls === cls);
      if (hit) { this.a.reaches.delete(l); out.push(AgentReach.LIMB_WORD[l] ?? l); } }
    return out;
  }
  /** The other bodies a world point lands in, each with its class there: server/reachgate.ts's bodiesAt, read from the
   *  presence this body holds (each body's capsule, scaled to its size). */
  private bodiesAtPoint(pt: number[]): { name: string; cls: string }[] {
    const out: { name: string; cls: string }[] = [];
    for (const [name, person] of this.a.people) {
      const at = (person.pose as any)?.p;
      if (name === this.a.name || !Array.isArray(at) || at.length !== 3 || !at.every(Number.isFinite)) continue;
      const sc = clampBodyScale((person.pose as any)?.scale);
      const cls = pointClass([0, 0, 0], [(pt[0] - at[0]) / sc, (pt[1] - at[1]) / sc, (pt[2] - at[2]) / sc]);
      if (cls) out.push({ name, cls });
    }
    return out;
  }
  /** Every other body a reach target is held to, as the relay holds it (server/reachgate.ts touched), each with its class:
   *  a named point, that one body; a point in the world or this body's frame, every body it lands in; a point in another
   *  body's frame, that body and every other body it lands in. The relay strips the reach if any of them refuses it. */
  private reachHolders(t: any): { name: string; cls: string }[] {
    if (t?.who !== undefined) {
      const cls = t.who !== this.a.name ? AgentReach.reachClass(t, t.who) : null;
      return cls ? [{ name: t.who, cls }] : [];
    }
    if (!Array.isArray(t?.p) || t.p.length !== 3 || !t.p.every(Number.isFinite)) return [];
    const p = t.p as number[];
    if (t.space === undefined) return this.bodiesAtPoint(p);
    if (t.space === "self" || t.space === this.a.name) {   // this body's root frame, as the pose it sends draws it
      const world = AgentReach.poseToWorld({ p: [this.a.pos.x, this.a.pos.y, this.a.pos.z], yaw: this.a.yaw }, p);
      return world ? this.bodiesAtPoint(world) : [];
    }
    // their own frame: theirs, and wherever it lands in the world, as their pose draws it
    const own = AgentReach.reachClass(t, t.space, clampBodyScale((this.a.people.get(t.space)?.pose as any)?.scale));
    const world = AgentReach.poseToWorld(this.a.people.get(t.space)?.pose, p);
    return [...(own ? [{ name: t.space as string, cls: own }] : []), ...(world ? this.bodiesAtPoint(world).filter((h) => h.name !== t.space) : [])];
  }
  /** As server/reachgate.ts's frameToWorld places it: metres at any size (docs/guide/BODY-STATE.md), turned by the pose's q when it
   *  carries one (a swimmer's whole-body turn), else by its yaw about +y. Null without a position. */
  private static poseToWorld(pose: any, local: number[]): number[] | null {
    const at = pose?.p;
    if (!Array.isArray(at) || at.length !== 3 || !at.every(Number.isFinite)) return null;
    const l = local, q = pose.q;
    if (Array.isArray(q) && q.length === 4 && q.every(Number.isFinite)) {
      const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1, x = q[0] / n, y = q[1] / n, z = q[2] / n, w = q[3] / n;
      const cx = y * l[2] - z * l[1], cy = z * l[0] - x * l[2], cz = x * l[1] - y * l[0];   // v' = v + 2w (u × v) + 2 u × (u × v)
      const dx = y * cz - z * cy, dy = z * cx - x * cz, dz = x * cy - y * cx;
      return [at[0] + l[0] + 2 * (w * cx + dx), at[1] + l[1] + 2 * (w * cy + dy), at[2] + l[2] + 2 * (w * cz + dz)];
    }
    const yaw = Number(pose.yaw) || 0, c = Math.cos(yaw), sn = Math.sin(yaw);
    return [at[0] + l[0] * c + l[2] * sn, at[1] + l[1], at[2] - l[0] * sn + l[2] * c];
  }
  /** The class the relay (server/reachgate.ts) gives a target on `name`'s body: a named point by consent.js's one table, a
   *  point in their own frame by their capsule; null for a point beside them (the relay relays it) or another kind of target. */
  static reachClass(t: any, name: string, scale = 1): string | null {
    if (t?.who === name) return namedPointClass(t.point)?.cls ?? null;
    // the point is metres in their root frame; their capsule is at their size (bodiesAtPoint)
    if (t?.space === name && Array.isArray(t.p)) return pointClass([0, 0, 0], t.p.map((v: number) => v / scale));
    return null;
  }
  /** After streaming a reach at other bodies: did the relay refuse it? A fresh refusal from any body it is held to (waits
   *  a few frames for one), or one said within REACH_NOTE_MS (the relay won't say it again that soon, so silence then is
   *  not a yes). Each body by its class there: a refusal of another class is another reach's. */
  private async reachRefusalFor(limb: string, holders: { name: string; actor: string; cls: string }[], since: number) {
    const holderOf = (x: { to: string; cls: string }) => holders.find((h) => h.actor === x.to && h.cls === x.cls);
    for (let i = 0; i < 16 && this.a.joined && !this.a.closed; i++) {
      const r = this.a.reachRefusals.find((x) => x.ts >= since && (x.limb ?? limb) === limb && holderOf(x));
      if (r) return { r, by: holderOf(r)!.name, fresh: true };
      await new Promise((res) => setTimeout(res, 50));
    }
    const r = [...this.a.reachRefusals].reverse().find((x) => holderOf(x) && x.ts > Date.now() - REACH_NOTE_MS);   // (target, class) exactly (F9)
    return r ? { r, by: holderOf(r)!.name, fresh: false } : null;
  }

  private static readonly LIMB_WORD: Record<string, string> = {
    leftHand: "left hand", rightHand: "right hand", leftFoot: "left foot", rightFoot: "right foot",
  };

  private reachBodyFor(path: string): Promise<ReachBody | null> {
    if (this.reachBodies.has(path)) return Promise.resolve(this.reachBodies.get(path) ?? null);
    let p = this.reachBodyLoads.get(path);
    if (!p) {
      p = ReachBody.create(this.a.httpBase, path)
        .catch(() => null)
        .then((b) => { this.reachBodies.set(path, b); this.reachBodyLoads.delete(path); return b; });
      this.reachBodyLoads.set(path, p);
    }
    return p;
  }
  /** undefined = not loaded yet; null = tried and failed. */
  private reachBodySync(path: string): ReachBody | null | undefined { return this.reachBodies.get(path); }

  /** A normalized target → a world point (+ surface normal for a landmark),
   *  from streamed presence. Sync; undefined means a needed skeleton is still
   *  loading (reach() awaits the loads before asking). */
  private reachTargetPoint(t: { who?: string; point?: string; standoff?: number; p?: number[]; space?: string }):
    { pos: number[]; normal?: number[] } | { err: string } | undefined {
    if (t.p) {
      if (!t.space) return { pos: t.p };
      if (t.space === "self") return { pos: frameToWorld([this.a.pos.x, this.a.pos.y, this.a.pos.z], this.a.yaw, t.p) };
      const person = this.a.people.get(t.space);
      const pp = posePosition(person?.pose);
      if (!person || !pp) return { err: `${t.space} is not here (or has no position yet)` };
      return { pos: frameToWorld(pp, person.pose?.yaw ?? 0, t.p) };
    }
    const self = t.who === this.a.name;
    const person = self ? null : this.a.people.get(t.who!);
    if (!self && !person) return { err: `nobody called "${t.who}" is present` };
    const path = self ? this.a.avatar : (person!.avatar || DEFAULT_BODY);
    const body = this.reachBodySync(path);
    if (body === undefined) return undefined;
    // null: its model, or this door's skeleton solver, didn't load (ReachBody.create)
    if (!body) return { err: `${self ? "your" : `${t.who}'s`} body couldn't be set up on this door (its model, or the door's skeleton solver, didn't load), so it can't check this reach` };
    // A limp body draws no raw layer, so its contacts have none either.
    if (self) body.poseAt([this.a.pos.x, this.a.pos.y, this.a.pos.z], this.a.yaw, this.a.heldPose ?? null, 1, this.a.clip !== "ragdoll");
    else {
      const pose = person!.pose;
      const pp = posePosition(pose);
      if (!pp) return { err: `${t.who} has no known position yet` };
      // their chosen size (absent = 1): contacts scale about their root, as in every browser
      body.poseAt(pp, pose?.yaw ?? 0, (pose as { pose?: Record<string, number[]> | null })?.pose ?? null, pose?.scale, pose?.clip !== "ragdoll");
    }
    const c = body.contact(t.point!, t.standoff ?? 0.02);
    if (!c) return { err: `${t.who}'s rig has no ${t.point}` };
    return c;
  }

  /** One full verdict for one limb entry, at this instant. */
  private solveReachEntry(limb: string, entry: { t: any; palm?: false }):
    | { state: "pending" } | { state: "err"; err: string }
    | { state: "ok"; reached: boolean; gap: number; bound: string[]; dist: number | null; arm: number | null; palmResidual: number | null } {
    if (this.a.joined) {
      const reading = this.reachReading;
      if (!reading || !sameReach(reading.reaches?.[limb], entry)) return { state: "pending" };
      const solved = reading.reachEvaluation?.[limb];
      // cyclic-reach is body_state's code for the loop (docs/guide/BODY-STATE.md); the reply says it in words.
      if (!solved?.ok) return { state: "err", err: solved?.why === "cyclic-reach"
        ? "it depends on a loop of reaches (limbs reaching for limbs that reach back), so it can't be solved until a limb in the loop lets go"
        : solved?.why ?? reading.error ?? "body pose could not be evaluated" };
      const dist = solved.target && solved.shoulder ? Math.hypot(...solved.target.map((v: number, i: number) => v - solved.shoulder[i])) : null;
      return { state: "ok", reached: solved.reached, gap: solved.gap, bound: solved.bound,
        dist, arm: reading.body?.armLength(limb) ?? null, palmResidual: solved.palmResidual };
    }
    const tp = this.reachTargetPoint(entry.t);
    if (tp === undefined) return { state: "pending" };
    if ("err" in tp) return { state: "err", err: tp.err };
    const own = this.reachBodySync(this.a.avatar);
    if (own === undefined) return { state: "pending" };
    if (!own) return { state: "err", err: "your body couldn't be set up on this door (its model, or the door's skeleton solver, didn't load), so it can't check this reach" };
    own.poseAt([this.a.pos.x, this.a.pos.y, this.a.pos.z], this.a.yaw, this.a.heldPose ?? null);
    const s = own.solve(limb, tp, { palm: entry.palm !== false });
    if (!s.ok) return { state: "err", err: s.why };
    const reached = Number.isFinite(s.gap) && s.gap <= TOUCH_GAP && !s.bound.includes("no-target");
    const dist = s.shoulder
      ? Math.hypot(tp.pos[0] - s.shoulder[0], tp.pos[1] - s.shoulder[1], tp.pos[2] - s.shoulder[2]) : null;
    return { state: "ok", reached, gap: s.gap, bound: s.bound, dist, arm: own.armLength(limb), palmResidual: s.palmResidual };
  }

  /** Reach a limb toward a target (wire grammar: {who, point, standoff?} or
   *  {p:[x,y,z], space?: 'world'|'self'|id}). Sets the descriptor streaming
   *  either way; the reply says what the arm actually achieves. */
  async reach(limbRaw: string | undefined, targetRaw: unknown, opts: { palm?: boolean } = {}): Promise<ActResult> {
    const limb = canonicalLimb(limbRaw ?? "rightHand");
    if (!limb) return { ok: false, text: unknownLimb(limbRaw, "reached") };
    const t = normalizeReachTarget(targetRaw);
    if (!t) {
      return { ok: false, text: "reach couldn't use that target, so nothing was reached: pass {who, point} for a named contact point on a body (who a participant id from look), or {x, y, z} with an optional space ('world' by default, 'self' for your own frame, or a participant id for theirs)" };
    }
    // load the skeletons this reach needs BEFORE solving, so the reply is a
    // real verdict rather than a shrug
    if (!this.a.joined) await this.reachBodyFor(this.a.avatar);
    if (t.who !== undefined && t.who !== this.a.name) {
      const person = this.a.people.get(t.who);
      if (!person) {
        const names = [...this.a.people.keys()].filter((n) => n !== this.a.name).slice(0, 12);
        return { ok: false, text: `nobody called "${t.who}" is here${names.length ? ` (present: ${names.join(", ")})` : ""}` };
      }
      if (!this.a.joined) await this.reachBodyFor(person.avatar || DEFAULT_BODY);
    }
    const entry: { t: any; palm?: false; reached?: true } = { t, ...(opts.palm === false ? { palm: false as const } : {}) };
    const since = Date.now();
    this.a.reaches.set(limb, entry);
    if (this.a.joined) await this.refreshReachReading();
    const res = this.solveReachEntry(limb, entry);
    if (res.state === "ok" && res.reached) entry.reached = true;
    const limbW = AgentReach.LIMB_WORD[limb];
    const what = describeTarget(t, this.a.name);
    // a hand on another body is shown only with their consent: the relay strips it otherwise and says why (reachgate.ts)
    // a point in the world or in this body's own frame is judged by the body it lands in, as the relay judges it
    // every body the relay holds it to (none: beside them, nothing for the relay to refuse)
    const holders = this.reachHolders(t).flatMap((h) => { const actor = this.a.actorIds.get(h.name); return actor ? [{ ...h, actor }] : []; });
    if (holders.length && this.a.joined) {
      const refused = await this.reachRefusalFor(limb, holders, since);
      if (refused) {
        if (this.a.reaches.get(limb) === entry) this.a.reaches.delete(limb);
        const { r } = refused, ago = Math.round((Date.now() - r.ts) / 1000);
        return { ok: false, text: `${limbW} toward ${what}: not shown to anyone — ${refused.by}'s consent refused it (class ${r.cls}): ${String(r.why).replace(String(r.to), refused.by)}${r.fix ? ` — ${r.fix}` : ""}. `
          + (refused.fresh ? "The reach is withdrawn; nobody saw your hand there."
            : `That was said ${ago}s ago, and the world says it once per ${REACH_NOTE_MS / 1000}s, so the reach is withdrawn; it may have shown for a moment while this was checked. If they have changed their table since, reach again in ${Math.max(1, Math.ceil((REACH_NOTE_MS - (Date.now() - r.ts)) / 1000))}s.`) };
      }
    }
    if (res.state !== "ok") {
      const why = res.state === "err" ? res.err : "skeletons still loading; the verdict follows on the next check";
      return { ok: true, text: `${limbW} reaching toward ${what} — streamed, but unverified: ${why}` };
    }
    if (res.reached) {
      return { ok: true, text: `${limbW} reaching ${what} (endpoint gap ${Math.round(res.gap * 1000)}mm). The target stays tracked until reach {release: true} or knockdown; this is an endpoint measurement, not a stability measurement.` };
    }
    const short = Number.isFinite(res.gap) ? `${res.gap.toFixed(2)}m short` : "not arriving";
    const why = res.bound.length ? ` (limited by: ${res.bound.join(", ")})` : "";
    const advice = res.bound.includes("reach") && res.dist != null && res.arm != null
      ? ` — the target is ${res.dist.toFixed(1)}m from your shoulder and your arm is ${res.arm.toFixed(2)}m long; get closer and it will land`
      : "";
    return { ok: true, text: `${limbW} reaching toward ${what}: ${short}${why}${advice}. The arm extends that way and keeps tracking; it touches if the distance closes.` };
  }

  /** Let go with one limb, or all of them. Propagates as absence: the next
   *  presence packet simply stops carrying the descriptor. */
  releaseReach(limbRaw?: string | null): ActResult {
    if (limbRaw == null) {
      const n = this.a.reaches.size;
      this.a.reaches.clear();
      return done(n ? "let go — all reaches released" : "you weren't reaching for anything");
    }
    const limb = canonicalLimb(limbRaw);
    if (!limb) return refused(unknownLimb(limbRaw, "released"));
    // A limb that wasn't reaching is already let go, which is what was asked.
    return done(this.a.reaches.delete(limb)
      ? `${AgentReach.LIMB_WORD[limb]} released`
      : `your ${AgentReach.LIMB_WORD[limb]} wasn't reaching for anything`);
  }

  /** Re-attest `reached` for every live reach (~2Hz off tick()). While a needed
   *  skeleton is missing the last attestation HOLDS (a slow load must not fire
   *  spurious release/touch edges); loads are kicked here so blindness heals. */
  reachTick() {
    if (this.a.joined) {
      if (this.reachReadingBusy) return;
      this.reachReadingBusy = true;
      void this.refreshReachReading().then(() => {
        for (const [limb, entry] of this.a.reaches) {
          const res = this.solveReachEntry(limb, entry);
          if (res.state === "ok" && res.reached) entry.reached = true; else delete entry.reached;
        }
      }).catch(() => { for (const entry of this.a.reaches.values()) delete entry.reached; })
        .finally(() => { this.reachReadingBusy = false; });
      return;
    }
    for (const [limb, entry] of this.a.reaches) {
      const t = entry.t;
      if (t.who !== undefined) {
        const path = t.who === this.a.name ? this.a.avatar : (this.a.people.get(t.who)?.avatar || DEFAULT_BODY);
        void this.reachBodyFor(path);
      }
      void this.reachBodyFor(this.a.avatar);
      const res = this.solveReachEntry(limb, entry);
      if (res.state !== "ok") continue;
      if (res.reached) entry.reached = true; else delete entry.reached;
    }
  }

  /** Someone's hands, read off their presence stream: reach/touch events for
   *  hands aimed at THIS body. Ping-grade, edge-triggered by diffReach, with a
   *  per-(kind,limb,person) refractory so a trembling hand knocks once. */
  noteReachEvents(id: string, prev: Pose | null, pose: Pose) {
    const bag = normalizeReachBag((pose as { reach?: unknown }).reach);
    const prevBag = prev ? normalizeReachBag((prev as { reach?: unknown }).reach) : null;
    if (!bag && !prevBag) return;
    // First observation of this body is a BASELINE, not a transition (rejoin
    // replay): seed silently; edges count from the next sample.
    if (!prev) return;
    const REACH_REFRACT_MS = 15_000;
    for (const ev of diffReach(prevBag, bag, this.a.name)) {
      const limbW = AgentReach.LIMB_WORD[ev.limb] ?? ev.limb;
      if (ev.type === "release") {
        this.a.gate.act(id, `reach-release:${ev.limb}`, `withdraws their ${limbW}`);
        continue;
      }
      const key = `${ev.type}:${ev.limb}:${id}`;
      const now = Date.now();
      if (now - (this.lastReachPing.get(key) ?? 0) < REACH_REFRACT_MS) continue;
      this.lastReachPing.set(key, now);
      const what = describeTarget(ev.entry!.t, this.a.name);
      this.a.ping({
        ts: now, kind: ev.type, who: id,
        text: ev.type === "touch" ? `touches ${what} (${limbW})` : `reaches toward ${what} (${limbW})`,
      });
    }
  }
}
