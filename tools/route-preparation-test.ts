// bun tools/route-preparation-test.ts — exact cap and authored-cache boundaries.
// Real editor operations and received-entry fold; unrelated geometry I/O is
// disabled so this suite cannot fetch assets from a running sequencer.
import { strict as assert } from "node:assert";
import { WorldAgent } from "../mcpl/agent.ts";
import { planStructure, prepareRouteLocal } from "../shared/structure.js";
import { ROUTE_MAX_CELLS, routeGeometryFor } from "../shared/structure-route.js";
import { addWall, removeWall, setAperture, setTile, removeTile, drawRoom, eraseRoom, labelCell } from "../shared/structure_edit.js";
let count=0;
const check=(ok:unknown,label:string)=>{assert.ok(ok,label);count++;console.log("✓ "+label);};
const terrain=(height=0)=>({kind:"terrain",heightAt:()=>height,step:.5});
function capPlan(x:number,z:number) {
 return planStructure({levels:[{y:0,tiles:[[x,z]],walls:[[1,0,0]],apertures:[]}]});
}
check(128*128===ROUTE_MAX_CELLS && 5*3277===ROUTE_MAX_CELLS+1,"fixtures straddle exactly 16384 and 16385 padded cells");
const exact=prepareRouteLocal(capPlan(125,125),terrain()).route(-.5,.5,.5,.5);
check(exact.kind==="routed","16384-cell region is admitted and routes around the obstructing wall");
const over=prepareRouteLocal(capPlan(2,3274),terrain()).route(-.5,.5,.5,.5);
check(over.kind==="blocked"&&over.reason==="routing region exceeds 16384 cells","16385-cell region refuses before search");

const base:any={levels:[{y:0,tiles:[[0,0],[1,0]],walls:[[1,1,0]],apertures:[]}],labels:{}};
const agent=new WorldAgent({name:"cache-test",avatar:"",world:"cache-test"});
(agent as any).syncSupport=async()=>{}; // the fold/cache, not remote asset support, is under test
let seq=0;
async function receive(verb:string,args:any) {
 const entry=JSON.parse(JSON.stringify({seq:seq++,ts:1000+seq,actor:"builder",verb,args}));
 await (agent as any).applyEntry(entry,false);
 return entry;
}
const data=()=>agent.entities.get("house")?.comp?.structure;
const cached=(d:any)=>(agent as any).planOf(d);
async function planned(target:[number,number]) {
 const promise=agent.walkTo(...target,true,1000,0);
 const result={refusal:agent.walkRefusal,legs:(agent as any).legs.length,target:(agent as any).target};
 agent.stop();await promise;return result;
}
try{
 await receive("spawn",{id:"house",lib:"fixture.glb",pos:[0,0,0],yaw:0});
 await receive("comp",{id:"house",type:"structure",data:base});
 const original=data(), initial=cached(original), originalJSON=JSON.stringify(original);
 check(cached(original)===initial,"same received component identity reuses its pure local plan");
 const geometry=routeGeometryFor(initial);
 check(routeGeometryFor(initial)===geometry,"same immutable plan reuses wall spans and terrain topology");
 const low=prepareRouteLocal(initial,terrain(0)), high=prepareRouteLocal(initial,terrain(4));
 check(low!==high&&!low.clear(.5,.5,1.5,.5)&&high.clear(.5,.5,1.5,.5),"same cached geometry gets fresh terrain/support checkers");

 const edge={axis:1,x:1,z:0}, cell={x:0,z:0};
 const edits:[string,(d:any)=>any][]=[
  ["add wall",d=>addWall(d,{axis:0,x:0,z:0})],
  ["remove wall",d=>removeWall(d,edge)],
  ["door",d=>setAperture(d,edge,"door")],
  ["window",d=>setAperture(d,edge,"window")],
  ["clear aperture",d=>setAperture(d,edge,null)],
  ["tile/half",d=>setTile(d,cell,"floor","A")],
  ["remove tile",d=>removeTile(d,cell)],
  ["draw room",d=>drawRoom(d,cell,{x:1,z:1})],
  ["erase room",d=>eraseRoom(d,cell,cell)],
  ["label",d=>labelCell(d,cell,"kitchen")],
 ];
 for(const [name,edit] of edits){
  const next=edit(original);
  check(next!==original&&JSON.stringify(original)===originalJSON,name+": editor returns new identity and preserves the old value");
  const previous=data();
  const packet=await receive("comp",{id:"house",type:"structure",data:next});
  check(data()!==previous&&data()===packet.args.data,name+": received comp replaces data identity in the actual agent fold");
  check(cached(data())!==initial,name+": changed component gets a different plan");
 }
 const door=setAperture(base,edge,"door");
 await receive("comp",{id:"house",type:"structure",data:door});
 const doorPlan=cached(data());
 check(prepareRouteLocal(doorPlan,terrain()).clear(.5,.5,1.5,.5),"replacement opening invalidates old blocking geometry");
 await receive("comp",{id:"house",type:"structure",data:base}); // UI undo: send the previous value through comp
 const undone=data(), undonePlan=cached(undone);
 check(undonePlan!==doorPlan&&!prepareRouteLocal(undonePlan,terrain()).clear(.5,.5,1.5,.5),"undo restores the prior wall without reusing the changed geometry");

 agent.pos={x:.5,y:0,z:.5};
 check((await planned([1.5,.5])).legs>0,"cached wall produces a real walk detour");
 await receive("place",{id:"house",pos:[10,0,0]});
 check(data()===undone&&cached(data())===undonePlan,"entity translation preserves authored-cache identity");
 check((await planned([1.5,.5])).legs===0,"new walk uses fresh translation rather than an old transformed checker");
 await receive("place",{id:"house",pos:[10,1,-5],yaw:Math.PI/2,scale:2});
 (agent as any).terrain={heightAt:()=>1};agent.pos={x:11,y:1,z:-6};
 check(cached(data())===undonePlan&&(await planned([11,-8])).legs>0,"same geometry uses fresh rotation, scale and terrain origin");
 (agent as any).terrain={heightAt:()=>8};
 check((await planned([11,-8])).legs===0,"later walk uses changed terrain height with the same authored plan");
 await receive("comp",{id:"house",type:"structure",data:null});
 (agent as any).terrain={heightAt:()=>1};
 check(data()===undefined&&(await planned([11,-8])).legs===0,"component removal drops the obstacle rather than reviving cached data");
 await receive("comp",{id:"house",type:"structure",data:base});
 check(data()!==undone&&cached(data())!==undonePlan,"re-attach creates its own received revision");
 for(const primitive of ["junk",true,7,null]){
  check(cached(primitive).levels.length===0,"malformed primitive remains an empty uncached plan");
 }
 await receive("spawn",{id:"house",lib:"fixture.glb",pos:[0,0,0]});
 check(data()===undefined,"same-id spawn replacement does not inherit cached structure data");
 console.log("PASS "+count+" route-preparation assertions");
}finally{agent.close();}
process.exit(0);
