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
  stubResolve(b, /^\.\/writes\.js$/, () => ({ path: here("../stubs/multimove-test-stub.mjs") }));
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

// move: every follower moves by the lead's world delta
Sel.set(["a", "b", "c"]);
let st = MM.begin("a", MM.followersOf("a").ids);
a.position.set(1, 2, 3); a.updateMatrixWorld(true);
MM.apply(st, "move");
check("move: each follower moves by the lead's world delta", near(b.position.toArray(), [6, 2, 3]) && near(c.position.toArray(), [1, 2, 8]), JSON.stringify([b.position, c.position]));
check("...and the rider rides along in its carrier's frame", near(rider.position.toArray(), [0, 1, 0]));
check("...and each moved follower's collider is re-indexed", stub.reindexed.includes("b") && stub.reindexed.includes("c"), JSON.stringify(stub.reindexed));

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

// release: the followers' writes come back for one batch, each with its start components as the expect base
const out = MM.ops(st, (id: string) => ({ ops: [{ op: "set", id }] }));
check("ops: one write per follower, with its start components for the expect", out.ops.length === 1 && out.ops[0].id === "b" && !!out.base.b, JSON.stringify(out));
MM.revert(st);
check("revert puts each follower back where the log has it", stub.reverted.join() === "b", JSON.stringify(stub.reverted));

done();
