// The REAL ragdoll for headless bodies.
//
// A WorldAgent has no renderer, but the tumble never needed one: the Verlet
// solver drives bone NODES and emits a sparse quaternion pose — the same pose
// a browser body streams. The fleet test has run this exact solver against
// every shipped VRM headless under Bun since the day it shipped; this module
// gives that machinery to the agents themselves, so a pushed agent TUMBLES —
// simulated on its own side, streamed through its own presence — instead of
// being semantically informed that it fell.
//
// What the agent needs in-process is only its skeleton: joint rest positions
// parsed straight from its VRM's GLB JSON chunk (tools/rig-load.mjs — no
// meshes, no textures, no fs), wrapped in a stand-in Avatar whose normalized
// bone nodes are exactly what Ragdoll drives.
//
// The one piece of ceremony: client/lib/ragdoll.js imports './core.js', which
// builds a WebGPURenderer at import time. Headless callers swap in the test
// stub via a Bun loader plugin — which must be registered BEFORE the dynamic
// import, which is why everything here loads lazily and the module exports
// only async doors. Sim unavailable (plugin failure, unparseable VRM) is a
// soft state: the agent falls back to the slump.
//
// Frame convention: the sim runs in WORLD COORDINATES against the live ground.
// It used to run on flat ground at zero, offset by ONE terrain sample taken at
// the fall site — locally-flat, blind to slopes the body tumbles across and to
// every placed structure, which is how a body released over an elevated floor
// settled through it to the terrain underneath (issue #17). Now the caller
// hands over its terrain height function (setHeightField — the same generator
// the browsers run, replicated in agent.ts) and registers support boxes for
// placed entities (registerSupport, fed from the server's /geom summaries);
// Ragdoll's own _terrain()/_world() clamps then see exactly what a browser's
// would. Walls of room-scale interiors remain a browser-side concern — data
// boxes carry floors, not architecture (see colliders.fitSupportBox).
//
// Declared seam: terrain and the collider map are MODULE state in the client
// libs, so one process serves ONE world's geometry. Agents co-resident in a
// process share it (every current harness runs one world per process); the
// caller re-asserts its height field before each begin() so at least the
// terrain is always the last faller's truth.

import { plugin } from "bun";
import { fileURLToPath } from "node:url";
import { isFiniteVec3 } from "./shape.ts";
// pure shared geometry — no client import cone, safe to load eagerly
import { CONTACT_POINTS } from "../shared/contact.js";
// The aerodynamics of a limp fall -- forces, not a scripted path.
import { leafForceFor, DEFAULT_LEAF_FORCE } from "../shared/leafforce.js";
import { bodyFrame, fromBody } from "../shared/joints.js";

const STUB = fileURLToPath(new URL("../tools/core-stub.mjs", import.meta.url));

let simMods: {
  Ragdoll: any;
  Body: any;                 // the engine that actually runs: AmmoRagdoll or Ragdoll
  engine: string;
  rig: { glbJson: any; humanBones: any; worldPositions: any; makeAvatar: any };
  THREE: any;
  terrain: any;
  colliders: any;
  reachbone: { measureChain: any; solveChain: any };
} | null = null;
let simFailed = false;
// The in-flight load, not just the finished one. A joining agent asserts its
// height field and replays a world's worth of spawns in the same tick, so
// dozens of callers reach loadSim() before any of them resolves — each one
// registering the plugin again and racing the same imports. One promise,
// awaited by everyone.
let simLoading: Promise<typeof simMods> | null = null;

function loadSim(): Promise<typeof simMods> {
  if (simMods) return Promise.resolve(simMods);
  if (simFailed) return Promise.resolve(null);
  simLoading ??= (async () => {
    try {
      plugin({
        name: "ragdoll-core-stub",
        setup(build) {
          build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: STUB }));
        },
      });
      const stub = await import("../tools/core-stub.mjs");
      const rag = await import("../client/lib/ragdoll.js");
      const rig = await import("../tools/rig-load.mjs");
      const terrain = await import("../client/lib/terrain.js");
      const colliders = await import("../client/lib/colliders.js");
      // the reach solver's frame algebra — same door, same stub (its own
      // import cone is core.js + pure shared modules; tools/reachlive-test.ts
      // is the standing proof it runs headless)
      const reachbone = await import("../client/lib/reachbone.js");
      // Bullet, not the Verlet floor. The browser has defaulted to ammo since
      // it beat every other engine on live falls (bodysim.js), but a headless
      // body hard-coded Ragdoll -- so a shoved agent tumbled under one solver
      // while the human dragging it ran another, and every drag-release handed
      // authority back to the SLOWER model mid-fall. That solver swap is what
      // "the joints twist up and it doesn't fall naturally when I let go"
      // actually is. ammodoll's ensureAmmo() already carries a bun branch and
      // imports the same three modules the Verlet does; nothing needed inventing.
      let Body: any = rag.Ragdoll;
      let engine = "verlet";
      const want = process.env.AGENT_BODY_ENGINE ?? "ammo";
      if (want === "ammo") {
        try {
          const ammo = await import("../client/lib/ammodoll.js");
          if (await ammo.ensureAmmo()) { Body = ammo.AmmoRagdoll; engine = "ammo"; }
          else console.warn("[physics] ammo wasm did not open — falling back to verlet");
        } catch (e) {
          console.warn("[physics] ammodoll unavailable — falling back to verlet:", e);
        }
      }
      // Say which engine answered. A silent fallback here is indistinguishable
      // from a toggle that does not work -- the same ambiguity bodysim.js's
      // status string was added to kill.
      console.log(`[physics] headless body engine: ${engine}`);
      simMods = { Ragdoll: rag.Ragdoll, Body, engine, rig, THREE: stub.THREE, terrain, colliders, reachbone };
      return simMods;
    } catch (e) {
      simFailed = true;
      console.error("[physics] headless ragdoll unavailable — agents will slump instead:", e);
      return null;
    }
  })();
  return simLoading;
}

/** Hand the sim the world's ground truth: the same heightAt the walking
 *  clamp uses. Null restores the bare stage (flat zero). Soft no-op when the
 *  sim is unavailable — a slumping agent has no clamp to feed. */
export async function setHeightField(fn: ((x: number, z: number) => number) | null) {
  const m = await loadSim();
  if (!m) return;
  m.terrain.setTerrain(fn ? { mesh: null, heightAt: fn } : null);
}

// Who is currently claiming each support box.
//
// Support ids are world/entity scoped, which is right — two agents in one
// world are looking at ONE platform and should not each register their own
// copy of it. But it means the registration is shared, and the first agent to
// leave was deleting the floor out from under the one who stayed. Holders are
// counted: the box lives while anyone claims it, and goes when the last
// claimant lets go. A Set rather than a number so a holder that registers the
// same id twice (a re-sync after a place) still counts once.
const holders = new Map<string, Set<string>>();

/** Register a placed entity's support geometry (a local-frame box + world
 *  transform) so settling bodies rest on it. `holder` is the claiming agent;
 *  the box survives until every holder has removed it. */
export async function registerSupport(
  holder: string, id: string, min: number[], max: number[],
  xform: { position: number[]; yaw?: number; scale?: number },
) {
  // Last line of defense (#88): this runs detached (`void registerSupport`),
  // so a throw here is an unhandled rejection that takes the WHOLE DOOR
  // down — every agent in the process, not the one with the bad entity.
  // A box or transform that is not finite geometry abstains instead.
  if (![min, max, xform?.position].every(isFiniteVec3)
      || !Number.isFinite(xform.yaw ?? 0) || !Number.isFinite(xform.scale ?? 1)) {
    console.error(`[physics] support ${id} abstained — non-finite geometry/transform`);
    return;
  }
  const m = await loadSim();
  if (!m) return;
  (holders.get(id) ?? holders.set(id, new Set()).get(id)!).add(holder);
  // re-fit unconditionally: a place moves the box, and the newest claimant's
  // transform is the freshest reading of where the thing actually is
  m.colliders.fitSupportBox(id, min, max, xform);
}

/** test/debug probe — who holds which support box (the world_debug spirit:
 *  the first question about a ghost floor is answered by looking, not by
 *  re-deriving process state). Copies, not live references. */
export const supportHolders = (): Record<string, string[]> =>
  Object.fromEntries([...holders].map(([id, hs]) => [id, [...hs]]));

/** Register HEIGHTFIELD support from a served topGrid (#84) — the sibling of
 *  registerSupport for floor-shaped assets whose box top is a known lie.
 *  Same holder discipline, same lifetime. Returns false when the payload is
 *  refused (validTopGrid, non-finite transform): the caller must then
 *  ABSTAIN — registering the box top instead is the bug this exists to fix. */
export async function registerSupportGrid(
  holder: string, id: string, topGrid: unknown,
  xform: { position: number[]; yaw?: number; scale?: number },
): Promise<boolean> {
  if (!isFiniteVec3(xform?.position)
      || !Number.isFinite(xform.yaw ?? 0) || !Number.isFinite(xform.scale ?? 1)) {
    console.error(`[physics] grid support ${id} abstained — non-finite transform`);
    return false;
  }
  const m = await loadSim();
  if (!m) return false;
  if (!m.colliders.fitSupportGrid(id, topGrid, xform)) return false;
  (holders.get(id) ?? holders.set(id, new Set()).get(id)!).add(holder);
  return true;
}

export async function removeSupport(holder: string, id: string) {
  const m = await loadSim();
  if (!m) return;
  const hs = holders.get(id);
  if (!hs) return;
  hs.delete(holder);
  if (hs.size) return;              // someone else is still standing on it
  holders.delete(id);
  m.colliders.removeCollider(id);
}

// skeletons are per-VRM and immutable — parse each avatar file once
const skeletons = new Map<string, Record<string, any> | null>();

async function skeletonFor(httpBase: string, avatarPath: string) {
  const key = avatarPath.split("?")[0];
  if (skeletons.has(key)) return skeletons.get(key);
  const m = await loadSim();
  if (!m) return null;
  try {
    const res = await fetch(`${httpBase}/library/${key}`);
    if (!res.ok) throw new Error(`fetch ${key}: ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const g = m.rig.glbJson(buf);
    const bones = m.rig.humanBones(g);
    if (!bones) throw new Error("no humanoid extension");
    const wp = m.rig.worldPositions(g);
    const P: Record<string, any> = {};
    for (const [b, n] of Object.entries(bones)) if (g.nodes[n as number]) P[b] = wp(n);
    if (!P.hips) throw new Error("no hips bone");
    // Hair chains too, with their real parenting.
    //
    // The stand-in carried HUMANOID bones only, so a headless body had no
    // Hair_<chain>_<idx> nodes — and that is exactly what ammodoll's hair block
    // looks for. Agents therefore ran with NO hair simulation while the browser
    // ran 75 locks of it, and the fleet suite never touched that code path
    // either: a whole subsystem absent and untested in the process that is
    // supposed to BE the body.
    const byName = new Map<string, number>();
    g.nodes.forEach((n: any, i: number) => { if (n.name) byName.set(n.name, i); });
    const parentOf = new Map<number, number>();
    g.nodes.forEach((n: any, i: number) =>
      (n.children ?? []).forEach((c: number) => parentOf.set(c, i)));
    const hairParent: Record<string, string> = {};
    for (const [name, i] of byName) {
      if (!/^Hair_\d+_\d+$/.test(name)) continue;
      P[name] = wp(i);
      const pi = parentOf.get(i);
      const pn = pi != null ? g.nodes[pi]?.name : null;
      // a lock either continues another lock, or hangs off the head
      hairParent[name] = (pn && /^Hair_\d+_\d+$/.test(pn)) ? pn : "head";
    }

    // WINGS, by the same argument and for the same reason the hair needed it.
    //
    // The stand-in is built from HUMANOID bones, and [LR]_Wing_* are not
    // humanoid -- VRM has no slot for them. So a headless body arrived with no
    // wing nodes at all, exactly as it once arrived with no hair: ammodoll's
    // wing block traverses looking for those names, finds nothing, and an
    // agent's ragdoll falls with no wings while the browser's has twelve.
    // Measured on the shipped mythos-wings.vrm: 327 hair bones grafted, 12
    // wing bones present in the file, 0 reaching the stand-in.
    //
    // It matters more than a missing decoration. Those twelve bodies are 63%
    // of the doll's broadside DRAG AREA against 10% of its mass -- so a
    // wingless stand-in is not merely unadorned, it is aerodynamically a
    // different object, and any leaf-force model applied to it is measuring
    // the wrong body.
    //
    // Chains hang off the CLAVICLE in the rig, which has no ragdoll body in
    // this cut (the arms hang off 'chest' for the same reason), so a root wing
    // bone is reparented to chest and the rest continue their own chain.
    const wingParent: Record<string, string> = {};
    for (const [name, i] of byName) {
      if (!/^[LR]_Wing_(Upper|Lower)(_\d+)?$/.test(name)) continue;
      P[name] = wp(i);
      const pi = parentOf.get(i);
      const pn = pi != null ? g.nodes[pi]?.name : null;
      wingParent[name] = (pn && /^[LR]_Wing_/.test(pn)) ? pn : "chest";
    }

    const extraParent = { ...hairParent, ...wingParent };
    if (Object.keys(extraParent).length) {
      // Named __hairParent still: ammodoll and HeadlessBody both read that key,
      // and renaming it would be a rename in three files to say the same thing.
      // It has always meant "bones the humanoid table does not know about".
      Object.defineProperty(P, "__hairParent", { value: extraParent, enumerable: false });
      Object.defineProperty(P, "__wingBones", { value: Object.keys(wingParent), enumerable: false });
    }
    // VRM 0.x bodies face -Z; the reach frame algebra needs to know (six of
    // the shipped rigs). The ragdoll never asked, so this rides as a
    // non-enumerable rider rather than a change to its P contract.
    Object.defineProperty(P, "__vrm0", { value: !!g.extensions?.VRM, enumerable: false });
    skeletons.set(key, P);
    return P;
  } catch (e) {
    console.error(`[physics] cannot read a skeleton out of ${key} — this body will slump:`, e);
    skeletons.set(key, null);
    return null;
  }
}

/** One headless body's physics: a stand-in skeleton plus whichever Ragdoll is
 *  currently running on it. The caller owns cadence (call step from its own
 *  ticker) and streaming (read pose/root after each step). */
export class HeadlessBody {
  private m: NonNullable<typeof simMods>;
  private av: any;
  rd: any = null;

  private constructor(m: NonNullable<typeof simMods>, P: Record<string, any>) {
    this.m = m;
    // realParent carries the NON-HUMANOID chains -- hair, and now wings.
    // Without it makeAvatar drops any bone that is not in its humanoid PARENT
    // table, which is every one of them.
    const hp = (P as any).__hairParent;
    this.av = hp ? m.rig.makeAvatar(P, { realParent: { ...(m.rig as any).PARENT, ...hp } })
      : m.rig.makeAvatar(P);
  }

  /** null when physics is unavailable for this process or this VRM. */
  static async create(httpBase: string, avatarPath: string): Promise<HeadlessBody | null> {
    const m = await loadSim();
    if (!m) return null;
    const P = await skeletonFor(httpBase, avatarPath);
    if (!P) return null;
    return new HeadlessBody(m, P);
  }

  /** Reset the stand-in to a pose at a place, standing on the live ground.
   *  `pose` is a sparse bone->quat map (a streamed pose — e.g. where a
   *  dragger's hand left this body); null means standing. */
  private pose(x: number, z: number, yaw: number, pose: Record<string, number[]> | null) {
    this.av.root.position.set(x, this.m.terrain.heightAt(x, z), z);
    this.av.root.rotation.y = yaw;
    for (const n of Object.values(this.av.nodes) as any[]) n.quaternion.identity();
    if (pose) {
      for (const [j, q] of Object.entries(pose)) {
        const n = this.av.nodes[j];
        if (n && Array.isArray(q) && q.length === 4) n.quaternion.set(q[0], q[1], q[2], q[3]);
      }
    }
    this.av.root.updateMatrixWorld(true);
  }

  /** Start a tumble: from standing (pose null) with a topple lean, or from a
   *  given pose (a drag release) falling free. Everything is WORLD y —
   *  `rootY`, pins, the seed — and the sim clamps against the live height
   *  field and registered supports as it runs. */
  begin(opts: {
    x: number; z: number; yaw: number;
    lean?: number[] | null;
    pose?: Record<string, number[]> | null;
    rootY?: number;                          // world y of the root at start (a lifted drop)
    pins?: Array<{ j: string; at: number[] }>;
    sim?: { j: string[]; p: number[]; v: number[] } | null;   // a handover
  }) {
    this.pose(opts.x, opts.z, opts.yaw, opts.pose ?? null);
    if (opts.rootY != null) {
      this.av.root.position.y = opts.rootY;
      this.av.root.updateMatrixWorld(true);
    }
    const lean = Array.isArray(opts.lean) && opts.lean.length === 3
      ? new this.m.THREE.Vector3(opts.lean[0], opts.lean[1], opts.lean[2]) : null;
    // The rest snapshot must be taken with the root WHERE IT IS NOW. It is a
    // set of WORLD positions, and Ragdoll reads the hips' height out of it
    // against the live root to learn how far the model origin sits below the
    // pelvis. Cached once at construction — with the root on the ground, as it
    // was — it is wrong by exactly the lift for any tumble that begins
    // somewhere else, and `rootY` is precisely that: a body let go of in
    // mid-air. The pelvis then renders a metre from where the sim has it.
    // A handover carries the sim's own state — where each joint was and how
    // fast — so this body CONTINUES what the other machine was running rather
    // than restarting from the bones with the motion thrown away. Positions
    // arrive in world y and the sim now RUNS in world y: no offset.
    const seed = opts.sim && Array.isArray(opts.sim.j) ? { ...opts.sim } : null;
    // Free the previous body FIRST. Every drag release begins a new one, and a
    // Bullet body owns wasm: a world, its bodies and constraints, and up to
    // 1089 ground tiles. The verlet owned nothing but JS, so dropping the
    // reference was a complete release and this line never needed to exist —
    // under ammo the same code leaked a whole world per release and killed the
    // agent with Aborted(OOM) in `new AmmoRagdoll` after a few minutes of being
    // dragged around. dispose() is idempotent (`_freed`), so this is safe even
    // when the body already finished and freed itself.
    this.rd?.dispose?.();
    this.rd = new this.m.Body(this.av, lean, this.av.restBonePositions(), seed);
    for (const p of opts.pins ?? []) this.setPin(p.j, p.at);
    // hipsOffset is how far the render root hangs below the hips — a property
    // of the RIG, so it must read the same on every build of the same body.
    // When it moves, everyone else sees this body float or sink by exactly the
    // difference, and nothing on THIS side looks wrong, which is why it needs
    // saying out loud. Only a handover can move it, so only log then.
    if (process.env.BODY_DEBUG && this.rd) {
      console.log(`[physics] ${opts.sim ? "handover" : "fresh"} build: `
        + `hipsOffset=${this.rd.hipsOffset?.toFixed(4)} `
        + `rootY=${this.av.root.position.y.toFixed(3)} `
        + `hips=${this.rd.p?.hips?.y?.toFixed(3)}`);
    }
  }

  /** Add/update/remove a pin, in WORLD coordinates. */
  setPin(joint: string | null, at?: number[] | null, firm = true) {
    if (!this.rd) return;
    if (!joint) { this.rd.setPin(null); return; }
    if (!Array.isArray(at)) { this.rd.setPin(joint, null); return; }
    // Pins arriving here are NAILS (begin's opts.pins, and the bodydrag relay's
    // pin map) — a hand is simulated by whoever is holding it, not replicated.
    this.rd.setPin(joint, new this.m.THREE.Vector3(at[0], at[1], at[2]), firm);
  }

  /** Aerodynamic forces on every body this step, so a limp fall FLUTTERS.
   *
   *  Janus asked for this shape: "use the normal ragdoll physics for falling,
   *  but add forces that cause it to fall like a leaf". The alternative --
   *  scripting the path -- cannot be hit by a thrown prop, cannot catch a wing
   *  on a rail, and cannot land badly. Bullet can do all three; it just needs
   *  to be told what the air is doing.
   *
   *  Two terms, both real (shared/leafforce.js): drag along each plate's
   *  NORMAL rather than along its motion, which makes a plate seek edge-on and
   *  overshoot; and a centre of pressure forward of centre, which turns that
   *  overshoot into a periodic tumble. The oscillation is emergent.
   *
   *  Silently a no-op on the Verlet fallback, which has no bodies to push.
   */
  applyLeaf(cfg: any, t: number) {
    const rd: any = this.rd;
    const bodies = rd?._bodies;
    if (!Array.isArray(bodies) || !bodies.length) return 0;
    const A = this.m.THREE ? null : null;
    let pushed = 0;
    for (const rb of bodies) {
      try {
        if (!rb || typeof rb.getLinearVelocity !== "function") continue;
        if (typeof rb.getMotionState !== "function") continue;
        const v = rb.getLinearVelocity();
        const vel = { x: v.x(), y: v.y(), z: v.z() };
        const sp = Math.hypot(vel.x, vel.y, vel.z);
        if (sp < 0.05) continue;
        const shape = rb.getCollisionShape?.();
        const he = shape?.getHalfExtentsWithMargin?.();
        const half = he ? [he.x(), he.y(), he.z()] : [0.05, 0.12, 0.05];
        const mass = 1 / Math.max(1e-6, rb.getInvMass?.() ?? 1);
        // The plate's normal in WORLD space: the thinnest local axis, rotated
        // by the body. A box's smallest face IS its plate.
        const thin = half.indexOf(Math.min(...half));
        const basis = rb.getWorldTransform().getBasis();
        const col = (i: number) => {
          const c = basis.getColumn(i);
          return { x: c.x(), y: c.y(), z: c.z() };
        };
        const normal = col(thin);
        const right = col((thin + 1) % 3);
        const { force, torque } = leafForceFor(cfg, { mass, halfExtents: half, vel, normal, right }, t);
        const F = new this.m.THREE.Vector3(force.x, force.y, force.z);
        const T = new this.m.THREE.Vector3(torque.x, torque.y, torque.z);
        rb.applyCentralForce?.(this.btVec(F));
        rb.applyTorque?.(this.btVec(T));
        rb.activate?.();
        pushed++;
      } catch { /* one awkward body must not stop the fall */ }
    }
    return pushed;
  }

  private _bv: any = null;
  private btVec(v: any) {
    const AMMO = (this.m as any).AMMO ?? (globalThis as any).Ammo;
    if (!AMMO) return v;
    this._bv ??= new AMMO.btVector3(0, 0, 0);
    this._bv.setValue(v.x, v.y, v.z);
    return this._bv;
  }

  /** Advance; returns what to stream, or null once the sim has captured. */
  step(dt: number): { pose: Record<string, number[]>; p: number[]; done: boolean } | null {
    if (!this.rd) return null;
    this.rd.step(dt);
    const pose = this.rd.done ? this.rd.finalPose : this.rd.pose;
    if (!pose) return null;
    const r = this.av.root.position;
    const out = { pose, p: [r.x, r.y, r.z], done: !!this.rd.done };
    if (this.rd.done && process.env.BODY_DEBUG) {
      // Where did she actually COME TO REST? Build-time numbers say nothing
      // about this: the question "does she settle above the floor" is about the
      // sim's own ground plane and its lowest joint, and both are only knowable
      // once it stops. groundY is what the solver believes the floor is; if
      // that disagrees with the world's floor, everything else is downstream
      // of it and no amount of root arithmetic will help.
      let lo = Infinity, who = "";
      for (const [j, v] of Object.entries(this.rd.p ?? {})) {
        const y = (v as any)?.y;
        if (Number.isFinite(y) && y < lo) { lo = y; who = j; }
      }
      console.log(`[physics] SETTLED: groundY=${this.rd.groundY?.toFixed(3)} `
        + `lowestJoint=${lo.toFixed(3)} (${who}) hips=${this.rd.p?.hips?.y?.toFixed(3)} `
        + `rootY=${r.y.toFixed(3)}  [lowest joint should sit just above groundY]`);
    }
    if (this.rd.done) { this.rd.dispose?.(); this.rd = null; }
    return out;
  }

  get active() { return this.rd != null; }
  /** Drop the body. dispose() before the reference goes: under ammo the
   *  reference is the only handle on a wasm world. */
  stop() { this.rd?.dispose?.(); this.rd = null; }
}

// ---------------------------------------------------------------- reaching
//
// The same stand-in skeleton, driven by the reach solver instead of the
// ragdoll. A headless body reaching for something needs two answers a browser
// gets from its scene: "where is the target" (for a landmark, on the OTHER
// body) and "does my arm get there" (measureChain/solveChain on its own).
// Both run on rig-load stand-ins here — no mesh, no renderer.
//
// One honest limitation, stated rather than hidden: a browser derives
// landmarks by raycasting the actual mesh (client/lib/landmarks.js); a
// stand-in has no mesh, so contact() uses the derivation's own FALLBACK rule
// (proportionally off the bone, along the approach direction). The two agree
// to a few centimetres — good enough for "did my hand arrive" and for the
// reply an agent reads, while every browser still renders against its own
// mesh-derived truth.

/** A body the reach solver can pose and interrogate, per VRM. */
export class ReachBody {
  private m: NonNullable<typeof simMods>;
  av: any;
  private chains = new Map<string, any>();

  private constructor(m: NonNullable<typeof simMods>, P: Record<string, any>) {
    this.m = m;
    // humanoid chain only (no hair): measureChain wants the simplified
    // hierarchy, and refuses chains whose lower bone is not the upper's child.
    this.av = m.rig.makeAvatar(P, { vrm0: !!(P as any).__vrm0 });
  }

  static async create(httpBase: string, avatarPath: string): Promise<ReachBody | null> {
    const m = await loadSim();
    if (!m) return null;
    const P = await skeletonFor(httpBase, avatarPath);
    if (!P) return null;
    return new ReachBody(m, P);
  }

  /** Test seam: build from an already-parsed skeleton (tools/rig-load's P
   *  map), so suites run against shipped rigs without a sequencer to fetch
   *  from. Same constructor the live path uses. */
  static async fromSkeleton(P: Record<string, any>): Promise<ReachBody | null> {
    const m = await loadSim();
    return m ? new ReachBody(m, P) : null;
  }

  /** Put the stand-in where the streamed presence says the body is. `pose` is
   *  the sparse bone map off the wire (held pose / ragdoll frame), or null. */
  poseAt(p: number[], yaw: number, pose: Record<string, number[]> | null) {
    this.av.root.position.set(p[0], p[1] ?? 0, p[2]);
    this.av.root.rotation.y = yaw ?? 0;
    for (const n of Object.values(this.av.nodes) as any[]) n.quaternion.identity();
    if (pose) {
      for (const [j, q] of Object.entries(pose)) {
        const n = this.av.nodes[j];
        if (n && Array.isArray(q) && q.length === 4) n.quaternion.set(q[0], q[1], q[2], q[3]);
      }
    }
    this.av.root.updateMatrixWorld(true);
  }

  private chain(limb: string) {
    if (!this.chains.has(limb)) this.chains.set(limb, this.m.reachbone.measureChain(this.av, limb));
    return this.chains.get(limb);
  }

  /** Arm span of one chain, for "walk closer" advice. */
  armLength(limb: string): number | null {
    const ch = this.chain(limb);
    return ch ? ch.L1 + ch.L2 : null;
  }

  /** Solve one limb toward a world target at the CURRENT pose. Returns plain
   *  data — the same verdict fields the browser's reachStatus reports. */
  solve(limb: string, target: number[] | { pos: number[]; normal?: number[] }, opts: { palm?: boolean } = {}) {
    const ch = this.chain(limb);
    if (!ch) return { ok: false as const, why: `no measurable ${limb} chain on this rig` };
    const tw = Array.isArray(target) ? target : target.pos;
    const n = !Array.isArray(target) && opts.palm !== false ? target.normal : null;
    const palm = Array.isArray(n) && n.length === 3 ? { dir: [-n[0], -n[1], -n[2]] } : null;
    const out = this.m.reachbone.solveChain(ch, this.av, tw, null, { palm });
    if (!out.ok) return { ok: false as const, why: String(out.why) };
    return {
      ok: true as const,
      gap: Number(out.res.gap ?? NaN),
      bound: (out.res.bound ?? []) as string[],
      penetration: Number(out.penetration ?? 0),
      palmResidual: out.palmResidual == null ? null : Number(out.palmResidual),
      shoulder: ch.nodes.upper.getWorldPosition(new this.m.THREE.Vector3()).toArray() as number[],
    };
  }

  /** A named contact point on THIS body at its current pose — the fallback
   *  derivation (landmarks.js), sans mesh: proportionally off the bone along
   *  the body-frame approach direction, normal facing out the same way. */
  contact(point: string, standoff = 0.02): { pos: number[]; normal: number[] } | null {
    const spec = (CONTACT_POINTS as any)[point];
    if (!spec) return null;
    const node = this.av.nodes[spec.bone];
    if (!node) return null;
    const P: Record<string, number[]> = {};
    for (const [k, n] of Object.entries(this.av.nodes) as [string, any][]) {
      P[k] = n.getWorldPosition(new this.m.THREE.Vector3()).toArray();
    }
    const F = bodyFrame(P);
    if (!F) return null;
    const d = fromBody(spec.from, F);
    const l = Math.hypot(d[0], d[1], d[2]);
    if (!(l > 1e-9)) return null;
    const dir = [d[0] / l, d[1] / l, d[2] / l];
    const hips = P.hips, head = P.head;
    const scale = hips && head
      ? Math.max(0.2, Math.hypot(head[0] - hips[0], head[1] - hips[1], head[2] - hips[2]))
      : 0.6;
    const at = P[spec.bone];
    const r = scale * 0.18 + standoff;
    return {
      pos: [at[0] + dir[0] * r, at[1] + dir[1] * r, at[2] + dir[2] * r],
      normal: dir,
    };
  }
}
