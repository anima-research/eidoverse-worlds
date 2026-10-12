// @ts-nocheck
import { sock, show } from "./atk-access-lib.ts";
const M = "eidoverse/assets/models/crate_large_blue.glb";
const log = (t, r) => console.log(`  ${t.padEnd(44)} ${show(r)}`);
let o = await sock(); await o.join("gym","riannon");
await o.req("delete",{id:"atk-ball"});
log("create grabbable ball", await o.req("create",{id:"atk-ball",model:M,components:{physics:{kind:"dynamic",who:"visitor"},grabbable:{who:"visitor"}},place:{at:[6,6]}}));
o.close();
let A=await sock(); await A.join("gym","atk-grab-A");
let B=await sock(); await B.join("gym","atk-grab-B");
log("A teleport", await A.req("move",{to:[6.6,0,6.9],teleport:true}));
log("B teleport", await B.req("move",{to:[5.4,0,5.1],teleport:true}));
log("A grab", await A.req("grab",{id:"atk-ball"}));
log("B grab same (contention)", await B.req("grab",{id:"atk-ball"}));
// expiry
A.close(); await new Promise(r=>setTimeout(r,900));
let C=await sock(); await C.join("gym","atk-grab-C");
log("C teleport", await C.req("move",{to:[6.6,0,6.9],teleport:true}));
log("C grab after A dropped socket", await C.req("grab",{id:"atk-ball"}));
log("C put", await C.req("put",{id:"atk-ball"}));
// B still thinks it might grab now that A gone? try B grab again
log("B grab now (A gone, C put)", await B.req("grab",{id:"atk-ball"}));
log("B put", await B.req("put",{id:"atk-ball"}));
B.close(); C.close();
let o2=await sock(); await o2.join("gym","riannon"); await o2.req("delete",{id:"atk-ball"}); o2.close();
