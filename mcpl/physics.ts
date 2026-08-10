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

const STUB = fileURLToPath(new URL("../tools/core-stub.mjs", import.meta.url));

let simMods: {
  Ragdoll: any;
  rig: { glbJson: any; humanBones: any; worldPositions: any; makeAvatar: any };
  THREE: any;
  terrain: any;
  colliders: any;
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
      simMods = { Ragdoll: rag.Ragdoll, rig, THREE: stub.THREE, terrain, colliders };
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
    this.av = m.rig.makeAvatar(P);
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
    this.rd = new this.m.Ragdoll(this.av, lean, this.av.restBonePositions(), seed);
    for (const p of opts.pins ?? []) this.setPin(p.j, p.at);
  }

  /** Add/update/remove a pin, in WORLD coordinates. */
  setPin(joint: string | null, at?: number[] | null) {
    if (!this.rd) return;
    if (!joint) { this.rd.setPin(null); return; }
    if (!Array.isArray(at)) { this.rd.setPin(joint, null); return; }
    this.rd.setPin(joint, new this.m.THREE.Vector3(at[0], at[1], at[2]));
  }

  /** Advance; returns what to stream, or null once the sim has captured. */
  step(dt: number): { pose: Record<string, number[]>; p: number[]; done: boolean } | null {
    if (!this.rd) return null;
    this.rd.step(dt);
    const pose = this.rd.done ? this.rd.finalPose : this.rd.pose;
    if (!pose) return null;
    const r = this.av.root.position;
    const out = { pose, p: [r.x, r.y, r.z], done: !!this.rd.done };
    if (this.rd.done) this.rd = null;
    return out;
  }

  get active() { return this.rd != null; }
  stop() { this.rd = null; }
}
