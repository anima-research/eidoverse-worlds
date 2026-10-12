// @ts-nocheck
import { sock, show } from "./atk-access-lib.ts";
const M = "eidoverse/assets/models/crate_large_blue.glb";
const log = (t, r) => console.log(`  ${t.padEnd(46)} ${show(r)}`);
let o = await sock(); await o.join("gym","riannon",{replica:false});
await o.req("delete",{id:"atk-ball"});
log("create grabbable ball", await o.req("create",{id:"atk-ball",model:M,components:{physics:{kind:"dynamic",who:"visitor"},grabbable:{who:"visitor"}},place:{at:[6,6]}}));
o.close();

// (1) contention
let A = await sock(); await A.join("gym","atk-grab-A",{replica:false});
let B = await sock(); await B.join("gym","atk-grab-B",{replica:false});
log("A teleport near", await A.req("move",{to:[6.6,0,6.9],teleport:true}));
log("B teleport near", await B.req("move",{to:[5.4,0,5.1],teleport:true}));
await new Promise(r=>setTimeout(r,200));
log("A grab ball", await A.req("grab",{id:"atk-ball"}));
log("B grab same ball (contention)", await B.req("grab",{id:"atk-ball"}));
// (2) claim expiry: A drops socket holding; reconnect C grabs
A.close(); await new Promise(r=>setTimeout(r,800));
let C = await sock(); await C.join("gym","atk-grab-C",{replica:false});
log("C teleport near", await C.req("move",{to:[6.6,0,6.9],teleport:true}));
await new Promise(r=>setTimeout(r,200));
log("C grab after holder dropped socket", await C.req("grab",{id:"atk-ball"}));
log("C put", await C.req("put",{id:"atk-ball"}));
B.close(); C.close();
// (3) never-ending claim via drag on the DRAG lane then socket drop; observer checks if a stuck claim blocks a later place
let D = await sock(); let dj=await D.join("gym","atk-drag-1",{replica:false}); const d1=dj.snapshot?.cut?.you;
let o3=await sock(); await o3.join("gym","riannon",{replica:false}); log("grant drag-1 builder", await o3.req("set",{id:"@world",component:"roles:"+d1,value:{role:"builder"}})); o3.close();
D.raw({type:"drag",id:"atk-ball",pos:[7,0,7],yaw:0}); // start a drag, never send end:true
await new Promise(r=>setTimeout(r,300));
D.close(); // socket dropped mid-drag, no end
await new Promise(r=>setTimeout(r,500));
let E = await sock(); let ej=await E.join("gym","atk-drag-1",{replica:false});
log("after stuck drag: builder can still place ball", await E.req("place",{id:"atk-ball",at:[6,6]}));
E.close();
let o2=await sock(); await o2.join("gym","riannon",{replica:false}); await o2.req("delete",{id:"atk-ball"}); await o2.req("delete",{id:"@world",component:"roles:"+d1}); o2.close();
