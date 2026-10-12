// @ts-nocheck
import { sock, show } from "./atk-access-lib.ts";
const M = "eidoverse/assets/models/crate_large_blue.glb";
const log = (t, r) => console.log(`  ${t.padEnd(48)} ${show(r)}`);
let a = await sock(); let aj = await a.join("gym", "atk-lock-1"); const atk1 = aj.snapshot?.cut?.you; a.close();

let o = await sock(); await o.join("gym", "riannon");
await o.req("delete", { id: "atk-s" });
await o.req("create", { id: "atk-s", model: M, place: { at: [12,12] } });
log("install state-only reaction (label)", await o.req("set", { id: "atk-s", component: "reactions", value: { tag: { kind: "set", component: "label", value: "rung" } } }));
log("try install transform reaction", await o.req("set", { id: "atk-s", component: "reactions", value: { mv: { kind: "set", component: "transform", value: { pos: [0,0,0], q:[0,0,0,1], scale:[1,1,1] } } }, merge: true }));
log("grant atk1 builder", await o.req("set", { id: "@world", component: "roles:"+atk1, value: { role: "builder" } }));
log("lock at owner rank", await o.req("set", { id: "atk-s", component: "lock", value: { rank: "owner" } }));
o.close();

let b = await sock(); await b.join("gym", "atk-lock-1");
console.log("builder uses handlers on an OWNER-locked thing:");
log("use STATE handler 'tag' (spec: open)", await b.req("use", { id: "atk-s", action: "tag" }));
log("use TRANSFORM handler 'mv' (spec: blocked)", await b.req("use", { id: "atk-s", action: "mv" }));
const i = await b.req("inspect", { id: "atk-s" });
console.log("   label=", JSON.stringify(i?.components?.label), " pos=", JSON.stringify(i?.components?.transform?.pos));
b.close();
let o2 = await sock(); await o2.join("gym", "riannon");
await o2.req("delete", { id: "atk-s" }); await o2.req("delete", { id: "@world", component: "roles:"+atk1 });
o2.close();
