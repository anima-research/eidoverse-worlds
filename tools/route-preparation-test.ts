// bun tools/route-preparation-test.ts — exact cap and authored-cache boundaries.
// Real editor operations and received-entry fold; unrelated geometry I/O is
// disabled so this suite cannot fetch assets from a running sequencer.
import { strict as assert } from "node:assert";
import { WorldAgent } from "../mcpl/agent.ts";
import { planStructure, prepareRouteLocal, planRouteLocal } from "../shared/structure.js";
import { ROUTE_MAX_CELLS, routeGeometryFor } from "../shared/structure-route.js";
import { addWall, removeWall, setAperture, setTile, removeTile, drawRoom, eraseRoom, labelCell } from "../shared/structure_edit.js";
let count=0;
const check=(ok:unknown,label:string)=>{assert.ok(ok,label);count++;console.log("✓ "+label);};
const terrain=(height=0)=>({kind:"terrain",heightAt:()=>height,step:.5});
function capPlan(x:number,z:number) {
 return planStructure({levels:[{y:0,tiles:[[x,z]],walls:[[1,0,0]],apertures:[]}]});
}
// The search region is the authored geometry's cells, padded by one: count it
// from the plan itself, not from the planner, so the fixtures are measured.
function paddedCells(plan:any) {
 let minX=Infinity,minZ=Infinity,maxX=-Infinity,maxZ=-Infinity;
 const include=(x:number,z:number)=>{minX=Math.min(minX,x);minZ=Math.min(minZ,z);maxX=Math.max(maxX,x);maxZ=Math.max(maxZ,z);};
 for(const lv of plan.levels){
  for(const k of lv.level.tiles.keys()){const [x,z]=k.split(",").map(Number);include(x,z);include(x+1,z+1);}
  for(const e of lv.level.walls.values()){include(e.x,e.z);include(e.x+1,e.z+1);}
 }
 return (maxX-minX+2)*(maxZ-minZ+2);
}
check(paddedCells(capPlan(125,125))===ROUTE_MAX_CELLS&&paddedCells(capPlan(2,3274))===ROUTE_MAX_CELLS+1,"the fixtures' padded regions are 16384 and 16385 cells");
const exact=prepareRouteLocal(capPlan(125,125),terrain()).route(-.5,.5,.5,.5);
// The wall [1,0,0] stands at x = 0 for z in [0, 1]; a leg meeting it there crosses it.
const meetsWall=(p:number[],q:number[])=>{
 if(p[0]*q[0]>0||p[0]===q[0]) return false;
 const z=p[1]+(0-p[0])/(q[0]-p[0])*(q[1]-p[1]);return z>=0&&z<=1;
};
check(exact.kind==="routed"&&exact.points.length>2&&!exact.points.some((p:number[],i:number)=>i>0&&meetsWall(exact.points[i-1],p)),
 "16384-cell region is admitted and routes around the obstructing wall");
const over=prepareRouteLocal(capPlan(2,3274),terrain()).route(-.5,.5,.5,.5);
check(over.kind==="blocked"&&over.reason.includes("5×3277 cells (5×3277 m)")&&over.reason.includes("over the 16384-cell routing limit")
 &&over.reason.includes("nearer endpoints won't help"),"16385-cell region refuses before search, naming its footprint in metres: "+over.reason);
const scaled=prepareRouteLocal(capPlan(2,3274),{...terrain(),scale:2}).route(-.5,.5,.5,.5);
check(scaled.kind==="blocked"&&scaled.reason.includes("(10×6554 m)"),"a scaled structure's footprint is given in world metres");
const empty=prepareRouteLocal(planStructure({levels:[{y:0,tiles:[],walls:[]},{y:3,tiles:[],walls:[]}]}),{kind:"floor",level:1,height:3.1,step:.5}).route(.5,.5,1.5,.5);
check(empty.kind==="blocked"&&empty.reason==="the identified floor has no cells","a walk on an empty floor is refused as one, not as over the limit");

// The worst case the cap admits: a 126×126 field of short walls, padded to the
// 16,384-cell limit, and a sealed destination, so the search visits every cell
// it can reach. Each wall check reads only the walls filed under the cells its
// leg touches, so the search costs about its cells (this took 38 s when every
// check read every wall).
const field:number[][]=[];
for(let x=0;x<126;x+=2)for(let z=0;z<126;z+=2)field.push([0,x,z]);
field.push([0,63,63],[0,63,64],[1,63,63],[1,64,63],[1,125,125]);
const fieldPlan=planStructure({levels:[{y:0,tiles:[],walls:field,apertures:[]}]});
check(paddedCells(fieldPlan)===ROUTE_MAX_CELLS,"the worst-case field is padded to exactly the limit");
const worstFrom=performance.now();
const worst=planRouteLocal(fieldPlan,-.5,-.5,63.5,63.5);
const worstMs=performance.now()-worstFrom;
check(worst.kind==="blocked"&&worst.reason==="no path through its doorways and arches connects the start to the destination (windows don't count); pick a destination you can reach through an opening"&&worstMs<2000,
 `a search of every cell at the limit, among ${field.length} walls, finishes in ${worstMs.toFixed(0)} ms (bound 2000)`);

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
/** An accepted straight walk: no refusal, no legs, and the destination as its target. */
const straight=(r:any,[x,z]:[number,number])=>r.refusal===null&&r.legs===0&&r.target?.x===x&&r.target?.z===z;
/** An accepted detour: no refusal, and waypoints before the destination. */
const detour=(r:any)=>r.refusal===null&&r.legs>0&&!!r.target;
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
  ["clear aperture",d=>setAperture(setAperture(d,edge,"door"),edge,null)],
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
 // The editor clearing that door: the wall it leaves blocks again.
 await receive("comp",{id:"house",type:"structure",data:setAperture(door,edge,null)});
 const clearedPlan=cached(data());
 check(clearedPlan!==doorPlan&&!prepareRouteLocal(clearedPlan,terrain()).clear(.5,.5,1.5,.5),"clearing an existing door through the editor closes the opening");
 await receive("comp",{id:"house",type:"structure",data:door});
 await receive("comp",{id:"house",type:"structure",data:base}); // UI undo: send the previous value through comp
 const undone=data(), undonePlan=cached(undone);
 check(undonePlan!==doorPlan&&!prepareRouteLocal(undonePlan,terrain()).clear(.5,.5,1.5,.5),"undo restores the prior wall without reusing the changed geometry");

 agent.pos={x:.5,y:0,z:.5};
 check(detour(await planned([1.5,.5])),"cached wall produces a real walk detour");
 await receive("place",{id:"house",pos:[10,0,0]});
 check(data()===undone&&cached(data())===undonePlan,"entity translation preserves authored-cache identity");
 check(straight(await planned([1.5,.5]),[1.5,.5]),"new walk uses fresh translation rather than an old transformed checker");
 await receive("place",{id:"house",pos:[10,1,-5],yaw:Math.PI/2,scale:2});
 (agent as any).terrain={heightAt:()=>1};agent.pos={x:11,y:1,z:-6};
 check(cached(data())===undonePlan&&detour(await planned([11,-8])),"same geometry uses fresh rotation, scale and terrain origin");
 (agent as any).terrain={heightAt:()=>8};
 check(straight(await planned([11,-8]),[11,-8]),"later walk uses changed terrain height with the same authored plan");
 // walkTo plans each received revision once: a second walk over the same
 // component reads none of its data again (the plan is the cached one).
 let reads=0;
 const counted={levels:[{y:0,tiles:[[0,0],[1,0]],walls:[[1,1,0]],apertures:[]}]};
 const watched={get levels(){reads++;return counted.levels;}};
 agent.entities.set("watched",{id:"watched",lib:"",pos:[20,0,0],yaw:0,scale:1,comp:{structure:watched}} as any);
 (agent as any).terrain={heightAt:()=>1};agent.pos={x:20.5,y:1,z:.5};
 check(detour(await planned([21.5,.5]))&&reads>0,"a walk past a new revision plans it");
 const readsAfterFirst=reads;
 check(detour(await planned([21.5,.5]))&&reads===readsAfterFirst,"a second walk over the same revision reads none of it again");
 agent.entities.delete("watched");
 await receive("comp",{id:"house",type:"structure",data:null});
 agent.pos={x:11,y:1,z:-6};
 check(data()===undefined&&straight(await planned([11,-8]),[11,-8]),"component removal drops the obstacle rather than reviving cached data");
 await receive("comp",{id:"house",type:"structure",data:base});
 check(data()!==undone&&cached(data())!==undonePlan,"re-attach creates its own received revision");
 for(const primitive of ["junk",true,7,null]){
  const first=cached(primitive);
  check(first.levels.length===0&&cached(primitive)!==first,"malformed primitive "+JSON.stringify(primitive)+" plans empty, afresh each time (uncached)");
 }
 await receive("spawn",{id:"house",lib:"fixture.glb",pos:[0,0,0]});
 check(data()===undefined,"same-id spawn replacement does not inherit cached structure data");
 console.log("PASS "+count+" route-preparation assertions");
}finally{agent.close();}
process.exit(0);
