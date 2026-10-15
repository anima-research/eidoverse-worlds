// @ts-nocheck
import { sock, show } from "./atk-access-lib.ts";
let s0=await sock(); await s0.join("gym","marigold");
const BM=(await s0.req("find",{kind:"model",query:"ball"}))?.models?.[0]?.model;
const BALL="atk-nosteal-"+Date.now().toString(36);
const log=(t,r)=>console.log(`  ${t.padEnd(46)} ${show(r)}`);
log("create ball steal:false", await s0.req("create",{id:BALL,model:BM,components:{physics:{kind:"dynamic",who:"visitor"},grabbable:{who:"visitor",steal:false}},place:{at:[1.2,8]}}));
s0.close();
let A=await sock(); await A.join("gym","atk-ns-A");
let B=await sock(); await B.join("gym","atk-ns-B");
await A.req("move",{to:[0,0,8],teleport:true}); await A.req("move",{to:[0.5,0,8]});
await B.req("move",{to:[0.2,0,8],teleport:true}); await B.req("move",{to:[0.5,0,8]});
log("A grab", await A.req("grab",{id:BALL}));
log("B grab same (steal:false -> refuse?)", await B.req("grab",{id:BALL}));
// A disconnects while holding; does the claim expire so C can grab?
A.close(); await new Promise(r=>setTimeout(r,1000));
let C=await sock(); await C.join("gym","atk-ns-C");
await C.req("move",{to:[0,0,8],teleport:true}); await C.req("move",{to:[0.5,0,8]});
log("C grab after holder A dropped socket", await C.req("grab",{id:BALL}));
const insp=await C.req("inspect",{id:BALL});
console.log("   ball still exists:", !!insp?.components, " pos:", JSON.stringify(insp?.components?.transform?.pos));
if (insp?.components) await C.req("put",{id:BALL});
B.close(); C.close();
// stuck DRAG claim: builder drags, drops socket w/o end; can another builder place it?
let DB=await sock(); let dj=await DB.join("gym","atk-dragger"); const dId=dj.snapshot?.cut?.you;
let og=await sock(); await og.join("gym","marigold"); await og.req("set",{id:"@world",component:"roles:"+dId,value:{role:"builder"}}); og.close();
DB.raw({type:"drag",id:BALL,pos:[3,0,8],yaw:0}); await new Promise(r=>setTimeout(r,250)); DB.close();
await new Promise(r=>setTimeout(r,500));
let E=await sock(); await E.join("gym","atk-dragger");
log("builder place after stuck drag", await E.req("place",{id:BALL,at:[1.2,8]}));
E.close();
let o2=await sock(); await o2.join("gym","marigold"); await o2.req("delete",{id:BALL}); await o2.req("delete",{id:"@world",component:"roles:"+dId}); o2.close();
