// @ts-nocheck
import { sock, show } from "./atk-access-lib.ts";
const M = "eidoverse/assets/models/crate_large_blue.glb";
const log = (t, r) => console.log(`  ${t.padEnd(50)} ${show(r)}`);

// attacker ids
let a = await sock(); let aj = await a.join("gym", "atk-lock-1"); const atk1 = aj.snapshot?.cut?.you; a.close();
let a2 = await sock(); let aj2 = await a2.join("gym", "atk-lock-2"); const atk2 = aj2.snapshot?.cut?.you; a2.close();
console.log("atk1=",atk1,"atk2=",atk2);

// owner setup: thing with a relocating reaction written BEFORE lock, then locked at owner rank
let o = await sock(); await o.join("gym", "riannon");
await o.req("delete", { id: "atk-rel" });
console.log("create atk-rel   :", show(await o.req("create", { id: "atk-rel", model: M, place: { at: [10,10] } })));
// a handler that sets a STATE comp (label) — allowed through a lock; and one that moves it — not allowed
console.log("reaction(label)  :", show(await o.req("set", { id: "atk-rel", component: "reactions", value: { tag: { kind: "set", component: "label", value: "rung" }, moveit: { kind: "place", to: [0,0] } } })));
console.log("grant atk1 bldr  :", show(await o.req("set", { id: "@world", component: "roles:"+atk1, value: { role: "builder" } })));
console.log("grant atk2 bldr  :", show(await o.req("set", { id: "@world", component: "roles:"+atk2, value: { role: "builder" } })));
console.log("lock owner rank  :", show(await o.req("set", { id: "atk-rel", component: "lock", value: { rank: "owner" } })));
o.close();

let b = await sock(); await b.join("gym", "atk-lock-1");
console.log("USE handlers on owner-locked thing (by builder):");
log("use label-setting handler (state=open?)", await b.req("use", { id: "atk-rel", action: "tag" }));
log("use place handler (relocate=blocked?)", await b.req("use", { id: "atk-rel", action: "moveit" }));
const i1 = await b.req("inspect", { id: "atk-rel" });
console.log("   after use: label=", JSON.stringify(i1?.components?.label), " pos=", JSON.stringify(i1?.components?.transform?.pos));
console.log("LOCK-RANK edge cases (by builder atk1):");
await b.req("delete", { id: "atk-own" });
log("builder creates own thing", await b.req("create", { id: "atk-own", model: M, place: { at: [11,11] } }));
log("builder sets OWNER-level lock (above rank)", await b.req("set", { id: "atk-own", component: "lock", value: { rank: "owner" } }));
log("builder sets builder-level lock on own", await b.req("set", { id: "atk-own", component: "lock", value: true }));
b.close();

// another builder tries to lift atk1's builder-level lock on atk-own
let c = await sock(); await c.join("gym", "atk-lock-2");
log("DIFFERENT builder lifts builder-lock", await c.req("delete", { id: "atk-own", component: "lock" }));
log("different builder edits after lift", await c.req("set", { id: "atk-own", component: "label", value: "taken" }));
c.close();
// cleanup
let o2 = await sock(); await o2.join("gym", "riannon");
await o2.req("delete", { id: "atk-rel" }); await o2.req("delete", { id: "atk-own" });
await o2.req("delete", { id: "atk-tgt" }); await o2.req("delete", { id: "atk-child" });
await o2.req("delete", { id: "@world", component: "roles:"+atk1 }); await o2.req("delete", { id: "@world", component: "roles:"+atk2 });
o2.close();
