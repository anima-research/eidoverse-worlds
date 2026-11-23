// multimove-test — the rest of the selection follows a drag (client/lib/edit/multimove.js; R gym 10-17 21:40).
// Headless: real three, stubbed world/net/colliders/writes (multimove-test-stub.mjs), the real selection store.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/multimove-test.ts
import { fileURLToPath } from "node:url";
import { plugin } from "bun";
import * as THREE from "three";
import { stubResolve } from "../harness/stub.ts";
import { suite } from "../gate/suite.ts";
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
plugin({ name: "multimove-test-stubs", setup(b) {
  stubResolve(b, /^\.\.\/(world|net|colliders|core)\.js$/, () => ({ path: here("../stubs/multimove-test-stub.mjs") }));
  stubResolve(b, /^\.\/(writes|inspect)\.js$/, () => ({ path: here("../stubs/multimove-test-stub.mjs") }));
} });

const stub: any = await import("../stubs/multimove-test-stub.mjs");
const Sel = await import("../../client/lib/edit/selection.js");
const MM = await import("../../client/lib/edit/multimove.js");

const { check, done } = suite("multimove");
const near = (a: number[], b: number[], e = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < e);
const scene = new THREE.Scene();
function thing(id: string, pos: number[], parent: THREE.Object3D = scene) {
  const o = new THREE.Object3D(); o.userData.entityId = id; o.position.set(pos[0], pos[1], pos[2]); parent.add(o);
  o.updateMatrixWorld(true); stub.entities.set(id, o); return o;
}

console.log("MULTIMOVE — the selection follows the dragged thing");
const a = thing("a", [0, 0, 0]), b = thing("b", [5, 0, 0]), c = thing("c", [0, 0, 5]);
const rider = thing("rider", [0, 1, 0], b);

Sel.set(["a", "b", "rider"]);
let f = MM.followersOf("a");
check("a follower riding another selected thing is left out (never moved twice)", f.ids.join() === "b", JSON.stringify(f));
check("one thing selected: no followers", (Sel.set(["a"]), MM.followersOf("a").ids.length === 0));
Sel.set(["a", "b", "c"]);
f = MM.followersOf("a", (id) => id !== "c");
check("a follower the gesture can't take is skipped and named", f.ids.join() === "b" && f.skipped.join() === "c", JSON.stringify(f));
check("the lead's own ancestor is not its follower", (Sel.set(["rider", "b"]), MM.followersOf("rider").ids.length === 0));
const rider2 = thing("rider2", [0, 2, 0], b);
Sel.set(["b", "rider", "rider2"]);
f = MM.followersOf("rider");
check("...and a sibling under that ancestor (which stays put) follows on its own", f.ids.join() === "rider2", JSON.stringify(f));
Sel.set(["a", "b", "rider"]);
f = MM.followersOf("a", (id) => id !== "b");
check("a thing under a selected carrier the gesture can't take follows on its own", f.ids.join() === "rider" && f.skipped.join() === "b", JSON.stringify(f));
b.remove(rider2); stub.entities.delete("rider2");

// move: every follower moves by the lead's world delta
Sel.set(["a", "b", "c"]);
let st = MM.begin("a", MM.followersOf("a").ids);
a.position.set(1, 2, 3); a.updateMatrixWorld(true);
MM.apply(st, "move");
check("move: each follower moves by the lead's world delta", near(b.position.toArray(), [6, 2, 3]) && near(c.position.toArray(), [1, 2, 8]), JSON.stringify([b.position, c.position]));
check("...and each moved follower's collider is re-indexed", stub.reindexed.includes("b") && stub.reindexed.includes("c"), JSON.stringify(stub.reindexed));

// the rider selected too (ahead of its carrier, so a rider moved on its own would then be carried: twice)
a.position.set(0, 0, 0); b.position.set(5, 0, 0); [a, b].forEach((o) => o.updateMatrixWorld(true));
Sel.set(["a", "rider", "b"]);
const rw0 = rider.getWorldPosition(new THREE.Vector3());
st = MM.begin("a", MM.followersOf("a").ids);
a.position.set(1, 2, 3); a.updateMatrixWorld(true);
MM.apply(st, "move");
const rw1 = rider.getWorldPosition(new THREE.Vector3());
check("...and a selected rider rides its carrier: its world moves by the delta once, its local is unchanged",
  near(rw1.toArray(), rw0.clone().add(new THREE.Vector3(1, 2, 3)).toArray()) && near(rider.position.toArray(), [0, 1, 0]), JSON.stringify({ rw0, rw1, local: rider.position }));

// a follower under an UNSELECTED carrier (moved and turned): the world delta enters its parent's frame
const carrier = thing("carrier", [10, 0, 0]); carrier.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2); carrier.updateMatrixWorld(true);
const kid = thing("kid", [1, 0, 0], carrier);
a.position.set(0, 0, 0); a.updateMatrixWorld(true);
Sel.set(["a", "kid"]);
const kw0 = kid.getWorldPosition(new THREE.Vector3());
st = MM.begin("a", MM.followersOf("a").ids);
a.position.set(1, 2, 3); a.updateMatrixWorld(true);
MM.apply(st, "move");
const kw1 = kid.getWorldPosition(new THREE.Vector3());
check("move: a follower under a turned, unselected carrier moves by the world delta (its local position in the carrier's frame)",
  near(kw1.toArray(), kw0.clone().add(new THREE.Vector3(1, 2, 3)).toArray()), JSON.stringify({ kw0, kw1, local: kid.position }));

// rotate about each follower's OWN origin (no pivot comp): it turns in place
a.position.set(0, 0, 0); b.position.set(5, 0, 0); c.position.set(0, 0, 5); [a, b, c].forEach((o) => { o.quaternion.identity(); o.updateMatrixWorld(true); });
st = MM.begin("a", ["b", "c"]);
a.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2); a.updateMatrixWorld(true);
MM.apply(st, "rotate", "world");
const yaw = (o: THREE.Object3D) => new THREE.Euler().setFromQuaternion(o.quaternion, "YXZ").y;
check("rotate: each follower turns by the lead's turn about its own origin, staying where it is", near(b.position.toArray(), [5, 0, 0]) && Math.abs(yaw(b) - Math.PI / 2) < 1e-6, JSON.stringify({ p: b.position, yaw: yaw(b) }));

// scale: × the lead's ratio, about its own origin
[a, b].forEach((o) => { o.quaternion.identity(); o.scale.set(1, 1, 1); o.updateMatrixWorld(true); });
st = MM.begin("a", ["b"]);
a.scale.set(2, 2, 2); a.updateMatrixWorld(true);
MM.apply(st, "scale");
check("scale: a follower scales by the lead's ratio in place", near(b.scale.toArray(), [2, 2, 2]) && near(b.position.toArray(), [5, 0, 0]), JSON.stringify({ s: b.scale, p: b.position }));

// a `pivot` comp: a turn and a size go about the follower's pivot, not its origin
const pv = thing("pv", [5, 0, 0]); stub.bags.set("pv", { pivot: { pos: [1, 0, 0] } });
[a].forEach((o) => { o.position.set(0, 0, 0); o.quaternion.identity(); o.scale.set(1, 1, 1); o.updateMatrixWorld(true); });
let sp = MM.begin("a", ["pv"]);
a.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2); a.updateMatrixWorld(true);
MM.apply(sp, "rotate", "world");
check("rotate: a follower with a pivot swings about it (pivot at +1 x: origin 5,0,0 → 6,0,1)", near(pv.position.toArray(), [6, 0, 1]), JSON.stringify(pv.position));
pv.position.set(5, 0, 0); pv.quaternion.identity(); pv.updateMatrixWorld(true); a.quaternion.identity(); a.updateMatrixWorld(true);
sp = MM.begin("a", ["pv"]);
a.scale.set(2, 2, 2); a.updateMatrixWorld(true);
MM.apply(sp, "scale");
check("scale: a follower with a pivot grows about it (pivot at +1 x, ×2: origin 5,0,0 → 4,0,0)", near(pv.position.toArray(), [4, 0, 0]) && near(pv.scale.toArray(), [2, 2, 2]), JSON.stringify({ p: pv.position, s: pv.scale }));
a.scale.set(1, 1, 1); a.updateMatrixWorld(true); stub.bags.delete("pv");

// rotate in own axes: each follower turns by the lead's LOCAL turn about its OWN axes (q·Δl), not the world turn (Δw·q)
const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2), roll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
pv.position.set(5, 0, 0); pv.quaternion.copy(tilt); pv.scale.set(1, 1, 1); pv.updateMatrixWorld(true);
a.quaternion.copy(roll); a.updateMatrixWorld(true);
sp = MM.begin("a", ["pv"]);
a.quaternion.copy(roll).multiply(turn); a.updateMatrixWorld(true);   // the lead turns 90° about its own up
MM.apply(sp, "rotate", "local");
const want = tilt.clone().multiply(turn);
check("rotate, own axes: a follower turns about its own up by the lead's local turn", pv.quaternion.angleTo(want) < 1e-6 && near(pv.position.toArray(), [5, 0, 0]), JSON.stringify({ q: pv.quaternion.toArray(), want: want.toArray() }));
a.quaternion.identity(); a.updateMatrixWorld(true);

// release: the followers' writes come back for one batch, each with its start components as the expect base
const out = MM.ops(st, (id: string) => ({ ops: [{ op: "set", id }] }));
check("ops: one write per follower, with its start components for the expect", out.ops.length === 1 && out.ops[0].id === "b" && !!out.base.b, JSON.stringify(out));
MM.revertHeld(MM.hold(["b"]), ["b"]);
check("revertHeld puts a follower its gesture holds back where the log has it", stub.reverted.join() === "b", JSON.stringify(stub.reverted));

// relay budget: ten followers share RELAY_PER_TICK samples a tick, round-robin, so a drag stays under the server's cap
const many = Array.from({ length: 10 }, (_, i) => thing(`m${i}`, [i, 0, 10]).userData.entityId);
st = MM.begin("a", many);
stub.drags.length = 0; const perTick: number[] = [];
for (let t = 0; t < 10; t++) { st.lastSent = performance.now() - MM.RELAY_MS;   // every apply is exactly one relay tick
  const n = stub.drags.length; a.position.x += 0.1; a.updateMatrixWorld(true); MM.apply(st, "move"); perTick.push(stub.drags.length - n); }
const covered = new Set(stub.drags.map((d: any[]) => d[0]));
check("relay: ten followers send RELAY_PER_TICK samples every tick", perTick.every((n) => n === MM.RELAY_PER_TICK), JSON.stringify(perTick));
check("...round-robin, so every follower is relayed once in ten ticks", covered.size === 10, JSON.stringify([...covered]));
stub.drags.length = 0; MM.end(st);
check("end: a last sample for the lead and every follower", stub.drags.length === 11 && stub.drags[0][0] === "a" && stub.drags.every((d: any[]) => d[4]?.end), `${stub.drags.length}`);
// the cap, by behaviour: MAX_GROUP − 1 followers driven through apply on a real frame clock (10 to 144 Hz, ±1 ms jitter: the
// relay's samples land on frames), each relayed again before its claim lapses (CLAIM_MS)
{ const realNow = performance.now; let clock = 0; (performance as any).now = () => clock;
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const fol = Array.from({ length: MM.MAX_GROUP - 1 }, (_, i) => thing(`cap${i}`, [i, 0, 20]).userData.entityId);
  const worst: Record<string, number> = {};
  for (const hz of [10, 16, 17, 18, 19, 20, 50, 60, 144]) {
    clock = 1000; a.position.set(0, 0, 0); a.updateMatrixWorld(true);
    const cst = MM.begin("a", fol); cst.lastSent = clock; const last = new Map(fol.map((id) => [id, clock])); let gap = 0;
    stub.drags.length = 0;
    while (clock < 21000) {
      clock += 1000 / hz + (rnd() * 2 - 1);   // ±1 ms of frame jitter
      a.position.x += 0.01; a.updateMatrixWorld(true);
      const n = stub.drags.length; MM.apply(cst, "move");
      for (const d of stub.drags.slice(n)) { gap = Math.max(gap, clock - last.get(d[0])!); last.set(d[0], clock); }
    }
    for (const id of fol) gap = Math.max(gap, clock - last.get(id)!);
    worst[hz] = Math.round(gap);
  }
  (performance as any).now = realNow;
  check(`the cap: ${MM.MAX_GROUP - 1} followers on a jittered 10–144 Hz frame clock are each relayed within CLAIM_MS (${MM.CLAIM_MS} ms)`,
    Object.values(worst).every((g) => g <= MM.CLAIM_MS), JSON.stringify({ cap: MM.MAX_GROUP, worstGapMs: worst }));
  for (const id of fol) { stub.entities.get(id).removeFromParent(); stub.entities.delete(id); }
}

// a gesture's generation: a late refusal of an older gesture puts back only what no newer gesture has taken since
stub.reverted.length = 0;
const g1 = MM.hold(["a", "b", "c"]), g2 = MM.hold(["b"]);
MM.revertHeld(g1, ["a", "b", "c"]);
check("a late revert of an older gesture leaves a thing a newer gesture holds", stub.reverted.join() === "a,c", JSON.stringify(stub.reverted));
MM.revertHeld(g2, ["b"]);
check("...and the newer gesture's own revert puts it back", stub.reverted.join() === "a,c,b", JSON.stringify(stub.reverted));

done();
