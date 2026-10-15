// @ts-nocheck
import { sock, show } from "./atk-access-lib.ts";
const M = "eidoverse/assets/models/crate_large_blue.glb";
const log = (t, r) => console.log(`  ${t.padEnd(52)} ${show(r)}`);

// 1) learn attacker identity id
let a = await sock(); let aj = await a.join("gym", "atk-lock-1");
const atkId = aj.snapshot?.cut?.you; console.log("atk-lock-1 id =", atkId); a.close();

// 2) owner sets up: target, child under it, reaction that relocates, then lock; grant attacker builder
let o = await sock(); await o.join("gym", "marigold");
await o.req("delete", { id: "atk-tgt" }); await o.req("delete", { id: "atk-child" });
console.log("setup create tgt:", show(await o.req("create", { id: "atk-tgt", model: M, place: { at: [9, 9] } })));
console.log("setup reaction   :", show(await o.req("set", { id: "atk-tgt", component: "reactions", value: { shove: { kind: "set", component: "transform", value: { pos: [0,0,0] } } } })));
console.log("setup grant bldr :", show(await o.req("set", { id: "@world", component: "roles:"+atkId, value: { role: "builder" } })));
console.log("setup lock owner :", show(await o.req("set", { id: "atk-tgt", component: "lock", value: { rank: "owner" } })));
o.close();

// 3) attacker (now builder) hits the locked owner-level thing
let b = await sock(); let bj = await b.join("gym", "atk-lock-1");
console.log("attacker role check (rights refusal would mean not builder):");
console.log("ATTACKS on a thing locked at OWNER rank, by a BUILDER:");
log("set transform (relocate)", await b.req("set", { id: "atk-tgt", component: "transform", value: { pos: [1,0,1] } }));
log("set label (state, direct)", await b.req("set", { id: "atk-tgt", component: "label", value: "x" }));
log("set motion spin (add comp)", await b.req("set", { id: "atk-tgt", component: "motion", value: { type: "spin", degPerSec: 30 } }));
log("delete transform component", await b.req("delete", { id: "atk-tgt", component: "transform" }));
log("delete model component", await b.req("delete", { id: "atk-tgt", component: "model" }));
log("delete whole entity", await b.req("delete", { id: "atk-tgt" }));
log("set new model", await b.req("set", { id: "atk-tgt", component: "model", value: M }));
log("place (drag-lane commit)", await b.req("place", { id: "atk-tgt", at: [2,2] }));
log("use reaction that relocates", await b.req("use", { id: "atk-tgt", action: "shove" }));
log("lift the owner lock as builder", await b.req("delete", { id: "atk-tgt", component: "lock" }));
log("lower lock rank to builder", await b.req("set", { id: "atk-tgt", component: "lock", value: true }));
log("throughLock edit as builder", await b.req("set", { id: "atk-tgt", component: "label", value: "y", throughLock: true }));
// child under locked parent
log("create child parented to locked", await b.req("create", { id: "atk-child", model: M, components: { parent: { to: "atk-tgt" } }, place: { at: [9.5, 9.5] } }));
log("edit the child (should be OPEN)", await b.req("set", { id: "atk-child", component: "label", value: "child-ok" }));
// verify position unchanged
const insp = await b.req("inspect", { id: "atk-tgt" });
console.log("  tgt transform.pos after attacks =", JSON.stringify(insp?.components?.transform?.pos), "lock=", JSON.stringify(insp?.components?.lock));
b.close();
