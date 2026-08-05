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
// Frame convention: the sim runs on FLAT GROUND AT ZERO — the stand-in stands
// at (x, 0, z) and the caller offsets streamed y by the terrain height at the
// fall site. Locally-flat is honest for a body-sized patch; tumbling down a
// hillside (and into furniture — no colliders headless yet) is future work.

import { plugin } from "bun";
import { fileURLToPath } from "node:url";

const STUB = fileURLToPath(new URL("../tools/core-stub.mjs", import.meta.url));

let simMods: {
  Ragdoll: any;
  rig: { glbJson: any; humanBones: any; worldPositions: any; makeAvatar: any };
  THREE: any;
} | null = null;
let simFailed = false;

async function loadSim() {
  if (simMods) return simMods;
  if (simFailed) return null;
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
    simMods = { Ragdoll: rag.Ragdoll, rig, THREE: stub.THREE };
    return simMods;
  } catch (e) {
    simFailed = true;
    console.error("[physics] headless ragdoll unavailable — agents will slump instead:", e);
    return null;
  }
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
  groundY = 0;

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

  /** Reset the stand-in to a pose at a place. `pose` is a sparse bone->quat
   *  map (a streamed pose — e.g. where a dragger's hand left this body);
   *  null means standing. */
  private pose(x: number, z: number, groundY: number, yaw: number, pose: Record<string, number[]> | null) {
    this.groundY = groundY;
    this.av.root.position.set(x, 0, z);
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
   *  given pose (a drag release) falling free. Heights in `opts.rootY` and
   *  pins are WORLD y; the sim runs ground-at-zero internally. */
  begin(opts: {
    x: number; z: number; groundY: number; yaw: number;
    lean?: number[] | null;
    pose?: Record<string, number[]> | null;
    rootY?: number;                          // world y of the root at start (a lifted drop)
    pins?: Array<{ j: string; at: number[] }>;
    sim?: { j: string[]; p: number[]; v: number[] } | null;   // a handover
  }) {
    this.pose(opts.x, opts.z, opts.groundY, opts.yaw, opts.pose ?? null);
    if (opts.rootY != null) {
      this.av.root.position.y = opts.rootY - opts.groundY;
      this.av.root.updateMatrixWorld(true);
    }
    const lean = Array.isArray(opts.lean) && opts.lean.length === 3
      ? new this.m.THREE.Vector3(opts.lean[0], opts.lean[1], opts.lean[2]) : null;
    // The rest snapshot must be taken with the root WHERE IT IS NOW. It is a
    // set of WORLD positions, and Ragdoll reads the hips' height out of it
    // against the live root to learn how far the model origin sits below the
    // pelvis. Cached once at construction — with the root at y=0, as it was —
    // it is wrong by exactly the lift for any tumble that begins somewhere
    // else, and `rootY` is precisely that: a body let go of in mid-air. The
    // pelvis then renders a metre from where the sim has it. A plain
    // knock-over starts at y=0 and never noticed; a drag release always did.
    // A handover carries the sim's own state — where each joint was and how
    // fast — so this body CONTINUES what the other machine was running rather
    // than restarting from the bones with the motion thrown away. Positions
    // arrive in world y; this sim runs ground-at-zero, hence dy.
    const seed = opts.sim && Array.isArray(opts.sim.j)
      ? { ...opts.sim, dy: -opts.groundY } : null;
    this.rd = new this.m.Ragdoll(this.av, lean, this.av.restBonePositions(), seed);
    for (const p of opts.pins ?? []) this.setPin(p.j, p.at);
  }

  /** Add/update/remove a pin, in WORLD coordinates. */
  setPin(joint: string | null, at?: number[] | null) {
    if (!this.rd) return;
    if (!joint) { this.rd.setPin(null); return; }
    if (!Array.isArray(at)) { this.rd.setPin(joint, null); return; }
    this.rd.setPin(joint, new this.m.THREE.Vector3(at[0], at[1] - this.groundY, at[2]));
  }

  /** Advance; returns what to stream, or null once the sim has captured. */
  step(dt: number): { pose: Record<string, number[]>; p: number[]; done: boolean } | null {
    if (!this.rd) return null;
    this.rd.step(dt);
    const pose = this.rd.done ? this.rd.finalPose : this.rd.pose;
    if (!pose) return null;
    const r = this.av.root.position;
    const out = { pose, p: [r.x, r.y + this.groundY, r.z], done: !!this.rd.done };
    if (this.rd.done) this.rd = null;
    return out;
  }

  get active() { return this.rd != null; }
  stop() { this.rd = null; }
}
