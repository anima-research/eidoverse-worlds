// @ts-nocheck
import { sock, show } from "./atk-access-lib.ts";
const M = "eidoverse/assets/models/crate_large_blue.glb";
const log = (t, r) => console.log(`  ${t.padEnd(46)} ${show(r)}`);
// attacker ids + builder grants for drag relay test
let a = await sock(); let aj = await a.join("gym","atk-drag-1"); const d1=aj.snapshot?.cut?.you; a.close();

let o = await sock(); await o.join("gym","marigold");
await o.req("delete",{id:"atk-ball"});
log("create grabbable ball (dynamic, who:visitor)", await o.req("create",{id:"atk-ball",model:M,components:{physics:{kind:"dynamic",who:"visitor"},grabbable:{who:"visitor"}},place:{at:[6,6]}}));
log("grant atk-drag-1 builder", await o.req("set",{id:"@world",component:"roles:"+d1,value:{role:"builder"}}));
o.close();

// (1) two accounts grab same thing at once
let A = await sock(); await A.join("gym","atk-grab-A");
let B = await sock(); await B.join("gym","atk-grab-B");
await A.req("move",{to:[6,0,6.6]}); await B.req("move",{to:[6,0,5.4]});
log("A grab ball", await A.req("grab",{id:"atk-ball"}));
log("B grab same ball (contention)", await B.req("grab",{id:"atk-ball"}));
// (2) claim expiry: A drops socket while holding; reconnect C and grab
A.close(); await new Promise(r=>setTimeout(r,500));
let C = await sock(); await C.join("gym","atk-grab-C");
await C.req("move",{to:[6,0,6.6]});
log("C grab after holder's socket dropped", await C.req("grab",{id:"atk-ball"}));
await C.req("put",{id:"atk-ball"}); B.close(); C.close();

// (3) forge drag `by`: observer watches the broadcast's `by`
let OBS = await sock(); await OBS.join("gym","atk-obs");
let D = await sock(); await D.join("gym","atk-drag-1"); // builder, so drags relay
const before = OBS.msgs.length;
D.raw({ type:"drag", id:"atk-ball", pos:[7,0,7], yaw:0, by:"marigold", byActor:"u-d2xrjjiu64qwaz2a7plp" });
await new Promise(r=>setTimeout(r,400));
const drags = OBS.msgs.slice(before).filter(m=>m.type==="drag");
console.log("  forged-by drag observed as:", JSON.stringify(drags.map(m=>({by:m.by,byActor:m.byActor,id:m.id}))));
// (4) visitor (no build) drag is suppressed
let V = await sock(); await V.join("gym","atk-vis");
const vb = OBS.msgs.length;
V.raw({ type:"drag", id:"atk-ball", pos:[8,0,8], yaw:0, by:"atk-vis" });
await new Promise(r=>setTimeout(r,400));
console.log("  visitor drag relayed?", OBS.msgs.slice(vb).some(m=>m.type==="drag"));
OBS.close(); D.close(); V.close();
let o2=await sock(); await o2.join("gym","marigold"); await o2.req("delete",{id:"atk-ball"}); await o2.req("delete",{id:"@world",component:"roles:"+d1}); o2.close();
