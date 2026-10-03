// bun tools/structure-route-support-test.ts
// Actual support mode, terrain crossing height, and world/local transforms.
// No server or renderer; product legs drive the real WorldAgent tick.
import { strict as assert } from "node:assert";
import { planStructure, prepareRouteLocal, localizePoint } from "../shared/structure.js";
import { WorldAgent } from "../mcpl/agent.ts";
let n=0;
const check=(ok:unknown,label:string)=>{assert.ok(ok,label);n++;console.log("✓ "+label);};
const terrain=(heightAt=(x:number,z:number)=>0,step=.5)=>({kind:"terrain",heightAt,step});
const floor=(level:number,height:number)=>({kind:"floor",level,height,step:.5});
const upper={y:3,tiles:[[0,0],[2,0]],walls:[],apertures:[]};
const ground={y:0,tiles:[[0,0],[1,0],[2,0]],walls:[[1,1,0]],apertures:[[1,1,0,"door"]]};
const basement={y:-3,tiles:[[0,0]],walls:[],apertures:[]};
for(const levels of [[ground,basement],[basement,ground]]) {
 const ctx=prepareRouteLocal(planStructure({levels}),terrain());
 const result=ctx.route(.5,.5,3.5,.5);
 check(result.kind==="clear"&&!ctx.confined,"ground exit above basement is independent of level ordering");
}
for(const levels of [[upper], [{y:0,tiles:[],walls:[]},upper],[upper,{y:0,tiles:[],walls:[]}]]) {
 const plan=planStructure({levels}), index=levels.indexOf(upper);
 const below=prepareRouteLocal(plan,terrain());
 check(below.route(.5,.5,2.5,.5).kind==="clear"&&!below.confined,"overhead tiles do not confine a terrain walker");
 const supported=prepareRouteLocal(plan,floor(index,3.1));
 check(supported.route(.5,.5,2.5,.5).kind==="blocked"&&supported.confined,"identified raised-only or upper floor cannot bridge its gap");
 check(supported.route(.5,.5,.5,-2).kind==="blocked","identified floor refuses exterior support transition");
}
const wall={levels:[{y:0,tiles:[],walls:[[1,1,0]],apertures:[]}]};
let ctx=prepareRouteLocal(planStructure(wall),terrain());
check(!ctx.clear(.5,.5,1.5,.5),"ordinary wall base 0.1m above terrain intersects feet-to-step band");
ctx=prepareRouteLocal(planStructure({wallH:5,levels:[{y:-3,tiles:[],walls:[[1,1,0]]}]}),terrain());
check(!ctx.clear(.5,.5,1.5,.5),"tall basement wall obstructs independently of its floor support");
ctx=prepareRouteLocal(planStructure({wallH:2,levels:[{y:-3,tiles:[],walls:[[1,1,0]]}]}),terrain());
check(ctx.clear(.5,.5,1.5,.5),"wall ending below the feet does not obstruct");
ctx=prepareRouteLocal(planStructure({levels:[{y:3,tiles:[[0,0]],walls:[[1,1,0]]}]}),terrain());
check(ctx.clear(.5,.5,1.5,.5),"overhead wall above the feet-to-step band is irrelevant");
ctx=prepareRouteLocal(planStructure(wall),terrain(x=>4*x));
check(ctx.clear(0,.5,2,.5),"terrain height at crossing clears a wall despite low start height");
ctx=prepareRouteLocal(planStructure(wall),terrain(x=>4*(x-1)**2));
check(!ctx.clear(0,.5,2,.5),"terrain dip at crossing obstructs despite high endpoints");
const doorway={levels:[{y:0,tiles:[],walls:[[1,1,0]],apertures:[[1,1,0,"door"]]}]};
check(prepareRouteLocal(planStructure(doorway),terrain()).clear(0,.5,2,.5),"door opening is clear at ordinary terrain height");
check(!prepareRouteLocal(planStructure(doorway),terrain(()=>2)).clear(0,.5,2,.5),"higher terrain meets the door lintel");
check(!prepareRouteLocal(planStructure(wall),terrain(()=>NaN)).clear(0,.5,2,.5),"unknown terrain height is not an assumed clear route");
check(prepareRouteLocal(planStructure({levels:[upper]}),floor(0,0)).route(.5,.5,2.5,.5).kind==="blocked","wrong supplied floor height is refused rather than inferred from x/z");

let preparedReads=0;
const preparedPlan=planStructure(wall);
const wallMap=preparedPlan.levels[0].level.walls;
const iterate=wallMap[Symbol.iterator].bind(wallMap);
wallMap[Symbol.iterator]=function*(){preparedReads++;yield* iterate();};
const frozenBasis:any=terrain();
const frozen=prepareRouteLocal(preparedPlan,frozenBasis);
const readsAfterPrepare=preparedReads;
frozenBasis.kind="floor";frozenBasis.height=100;
for(let i=0;i<20;i++) frozen.clear(0,.5,2,.5);
check(preparedReads===readsAfterPrepare,"candidate checks reuse prepared wall geometry");
check(!frozen.clear(0,.5,2,.5),"mutating caller basis cannot change the prepared walking mode");
const closed={levels:[{y:0,tiles:[[0,0]],walls:[[0,0,0],[0,0,1],[1,0,0],[1,1,0]]}]};
check(prepareRouteLocal(planStructure(closed),terrain()).route(.5,.5,2,.5).kind==="blocked",
  "new prepared API retains sealed-room refusal");

const agents:WorldAgent[]=[];
function body(entity:any,height:(x:number,z:number)=>number,from:[number,number]) {
 const a=new WorldAgent({name:"walker",avatar:"",world:"support-test"});agents.push(a);a.joined=true;
 a.entities.set(entity.id,entity);(a as any).terrain={heightAt:height};
 a.pos={x:from[0],y:height(...from),z:from[1]};return a;
}
async function walk(a:WorldAgent,to:[number,number]) {
 const points=[[a.pos.x,a.pos.y,a.pos.z]];
 const promise=a.walkTo(...to,true,10000,0);
 for(let i=0;i<1000&&(a as any).target;i++){(a as any).tick();points.push([a.pos.x,a.pos.y,a.pos.z]);}
 if((a as any).target){a.stop();throw new Error("bounded tick limit");}
 return {arrived:await promise,points};
}
function transform(e:any,x:number,z:number):[number,number] {
 const c=Math.cos(e.yaw),s=Math.sin(e.yaw);
 return [e.pos[0]+(x*c+z*s)*e.scale,e.pos[2]+(-x*s+z*c)*e.scale];
}
try{
 for(const e of [
  {id:"world",pos:[0,0,0],yaw:0,scale:1,comp:{structure:{levels:[basement,ground]}}},
  {id:"shift",pos:[10,2,-5],yaw:Math.PI/3,scale:2,comp:{structure:{levels:[ground,basement]}}},
 ]) {
  const a=body(e,()=>e.pos[1],transform(e,.5,.5));
  const r=await walk(a,transform(e,3.5,.5));
  if (typeof (a as any).groundAt === "function") {
    check(!r.arrived && !!a.walkRefusal?.includes("floor"),"#200 standing policy selects the floor above a basement; support transition is explicitly refused");
  } else {
    check(r.arrived&&r.points.every(p=>p[1]===e.pos[1]),"real terrain-mode body exits ground above basement with translated/scaled frame");
  }
 }
 const e={id:"overhead",pos:[10,1,-5],yaw:.6,scale:2,comp:{structure:{levels:[upper]}}};
 const a=body(e,()=>1,transform(e,.5,.5));
 check((await walk(a,transform(e,2.5,.5))).arrived,"real ground body walks beneath translated/scaled overhead floor without confinement");

 // The obstruction band is 0.5 WORLD metres, not 0.5 local units: the
 // transformed wall base is 0.6m above terrain and must not become a 1m band.
 const raised={id:"band",pos:[0,.4,0],yaw:0,scale:2,comp:{structure:wall}};
 const b=body(raised,()=>0,[0,1]);
 const r=await walk(b,[4,1]);
 check(r.arrived&&r.points.every(p=>Math.abs(p[2]-1)<1e-10),"world-scaled step band leaves a 0.6m raised wall above a terrain walk");

 const sole={id:"sole",pos:[0,0,0],yaw:0,scale:1,comp:{structure:{levels:[upper]}}};
 const soleBody=body(sole,()=>0,[.5,.5]);soleBody.pos.y=3.1;
 const soleWalk=await walk(soleBody,[2.5,.5]);
 check(soleWalk.arrived && soleBody.pos.y===0,"current standing implementation supplies terrain, not elevated support, for a sole raised floor");
 const slope={id:"slope",pos:[10,2,-5],yaw:Math.PI/2,scale:2,comp:{structure:wall}};
 const highAtCross=(wx:number,wz:number)=>{const [lx]=localizePoint(slope,wx,0,wz);return 2+8*lx;};
 const c=body(slope,highAtCross,transform(slope,0,.5));
 const high=await walk(c,transform(slope,2,.5));
 check(high.arrived&&high.points.every(p=>Math.abs(localizePoint(slope,p[0],p[1],p[2])[2]-.5)<1e-8),
   "transformed real body uses terrain at wall crossing rather than origin height");
 console.log("PASS "+n+" support-basis checks");
}finally{for(const a of agents)a.close();}
process.exit(0);
