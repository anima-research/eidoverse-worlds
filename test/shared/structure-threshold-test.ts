// bun test/shared/structure-threshold-test.ts — the agent half of structure routing: WorldAgent ticks and the move tool over
// real plans, renderer/server-free. The planner's own rows are test/shared/structure-route-test.ts's table; walks are checked
// against the oracle in test/shared/structure-oracle.ts. Also (merged): the authored-plan cache through the agent's fold
// (from route-preparation-test) and real bodies over transformed structures' support (from structure-route-support-test).
import { noWorldUrl } from "../harness/no-world.ts";
import { planStructure, localizePoint, prepareRouteLocal } from "../../shared/structure.js";
import { routeGeometryFor } from "../../shared/structure-route.js";
import { addWall, removeWall, setAperture, setTile, removeTile, drawRoom, eraseRoom, labelCell } from "../../shared/structure-edit.js";
import { WorldAgent, WALK_ARGS_REASON } from "../../mcpl/agent.ts";
import { handleTool } from "../../mcpl/tools.ts";
import { valid, walk, house, sealed, sparse, type P } from "./structure-oracle.ts";
import { agentOnDoor } from "../harness/agent-scratch.ts";
import { qFromYaw } from "../../shared/rot.js";
import { suite } from "../gate/suite.ts";
process.env.AGENT_BODY_ENGINE = "verlet";
const S = suite("structure-threshold");
const check = (ok: unknown, name: string, detail?: unknown) => S.check(name, ok, detail);
const agents: WorldAgent[] = [];
function agent() {
  const a = new WorldAgent({ url: noWorldUrl(), name: "walker", avatar: "", world: "test" });
  agents.push(a); a.joined = true; return a;
}
function entity(data=house, id="house", pos=[0,0,0], yaw=0, scale=1): any {
  return { id, model: "", pos, yaw, scale, structure: data };
}
function worldPoint(e: any, p: P): P {
  const c=Math.cos(e.yaw),s=Math.sin(e.yaw);
  return [e.pos[0]+(p[0]*c+p[1]*s)*e.scale,e.pos[2]+(-p[0]*s+p[1]*c)*e.scale];
}
// A body held on an upper floor, given the floor support walkSupport answers
// there, so the router's floor branch is tested apart from the standing that
// selects it; walkTo's floor branch serves that answer.
function standOn(a: WorldAgent, entity: string, level: number, height: number) {
  (a as any).walkSupport=()=>({kind:"floor",height,entity,level});
}
try {
  // these run FIRST: after the foreign-wall block below, process-wide headless state turns two of their rows red (undiagnosed)
  // ============================================================ the authored-plan cache (from route-preparation-test)
  // its boundaries through real editor operations and the received-entry fold; the cap rows are test/shared/structure-route-test.ts's
  console.log("\nSTRUCTURE — the authored-plan cache through the agent's fold");
  {
const terrain=(height=0)=>({kind:"terrain",heightAt:()=>height,step:.5});
const base:any={levels:[{y:0,tiles:[[0,0],[1,0]],walls:[[1,1,0]],apertures:[]}],labels:{}};
const agent=new WorldAgent({ url: noWorldUrl(), name:"cache-test",avatar:"",world:"cache-test"}); agents.push(agent);
(agent as any).ground.syncSupport=async()=>{}; // the fold/cache, not remote asset support, is under test
// the agent folds the authority's log itself, so each old hand-written entry is the current write doing the same (spawn →
// create, comp → set/delete a component, place → set transform) through the real door (test/harness/agent-scratch.ts agentOnDoor)
const door=agentOnDoor(agent,"route-prep");
async function receive(verb:string,args:any) {
 const a=JSON.parse(JSON.stringify(args));
 const now=agent.entities.get(a.id) as any;
 const tf=(r:any)=>{const s=r.scale??now?.scale??1;return {pos:r.pos??now?.pos??[0,0,0],q:qFromYaw(r.yaw??now?.yaw??0),scale:[s,s,s]};};
 let r:any;
 if(verb==="spawn"){
  if(now){
   // the authority never reuses an id: the old thing is deleted and the door refuses the id's return ("reused"), structure or not
   const gone=await door.act("delete",{id:a.id});
   if(!gone.ok) throw new Error("delete refused: "+JSON.stringify(gone.refused));
   r=door.call("create",{id:a.id,model:a.lib,components:{transform:tf(a)}});
   if(r.ok||r.refused?.code!=="reused") throw new Error("the authority let an id be reused: "+JSON.stringify(r));
   return {verb,args:a};
  }
  r=await door.act("create",{id:a.id,model:a.lib,components:{transform:tf(a)}});
 } else if(verb==="comp") r=await door.act(a.data===null?"delete":"set",a.data===null?{id:a.id,component:a.type}:{id:a.id,component:a.type,value:a.data});
 else if(verb==="place") r=await door.act("set",{id:a.id,component:"transform",value:tf(a)});
 else throw new Error("no current write for old "+verb);
 if(!r.ok) throw new Error(verb+" refused: "+JSON.stringify(r.refused));
 return {verb,args:a};
}
/** The same value: the fold hands the agent a copy of what was written, never the writer's object. */
const same=(x:any,y:any)=>JSON.stringify(x)===JSON.stringify(y);
const data=()=>agent.entities.get("house")?.structure;
const cached=(d:any)=>(agent as any).ground.planOf(d);
async function planned(target:[number,number]) {
 const promise=agent.walkTo(...target,true,1000,0);
 const result={refusal:agent.walkRefusal,legs:(agent as any).legs.length,target:(agent as any).target};
 agent.stop();await promise;return result;
}
/** An accepted straight walk: no refusal, no legs, and the destination as its target. */
const straight=(r:any,[x,z]:[number,number])=>r.refusal===null&&r.legs===0&&r.target?.x===x&&r.target?.z===z;
/** An accepted detour: no refusal, and waypoints before the destination. */
const detour=(r:any)=>r.refusal===null&&r.legs>0&&!!r.target;
{

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
  check(data()!==previous&&same(data(),packet.args.data),name+": received comp replaces data identity in the actual agent fold");
  check(cached(data())!==initial,name+": changed component gets a different plan");
 }
 const door=setAperture(base,edge,"door");
 await receive("comp",{id:"house",type:"structure",data:door});
 const doorPlan=cached(data());
 check(prepareRouteLocal(doorPlan,terrain()).clear(.5,.5,1.5,.5),"replacement opening invalidates old blocking geometry");
 // the editor clearing that door: the wall it leaves blocks again
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
 check(same(data(),undone)&&cached(data())===undonePlan,"entity translation preserves authored-cache identity");
 check(straight(await planned([1.5,.5]),[1.5,.5]),"new walk uses fresh translation rather than an old transformed checker");
 await receive("place",{id:"house",pos:[10,1,-5],yaw:Math.PI/2,scale:2});
 (agent as any).ground.terrain={heightAt:()=>1};agent.pos={x:11,y:1,z:-6};
 check(cached(data())===undonePlan&&detour(await planned([11,-8])),"same geometry uses fresh rotation, scale and terrain origin");
 (agent as any).ground.terrain={heightAt:()=>8};
 check(straight(await planned([11,-8]),[11,-8]),"later walk uses changed terrain height with the same authored plan");
 // walkTo plans each received revision once: a second walk over the same component reads none of its data again
 let reads=0;
 const counted={levels:[{y:0,tiles:[[0,0],[1,0]],walls:[[1,1,0]],apertures:[]}]};
 const watched={get levels(){reads++;return counted.levels;}};
 agent.entities.set("watched",{id:"watched",model:"",pos:[20,0,0],yaw:0,scale:1,structure:watched} as any);
 (agent as any).ground.terrain={heightAt:()=>1};agent.pos={x:20.5,y:1,z:.5};
 check(detour(await planned([21.5,.5]))&&reads>0,"a walk past a new revision plans it");
 const readsAfterFirst=reads;
 check(detour(await planned([21.5,.5]))&&reads===readsAfterFirst,"a second walk over the same revision reads none of it again");
 agent.entities.delete("watched");
 await receive("comp",{id:"house",type:"structure",data:null});
 agent.pos={x:11,y:1,z:-6};
 { const r=await planned([11,-8]); check(data()===undefined&&straight(r,[11,-8]),"component removal drops the obstacle rather than reviving cached data",{data:data(),...r}); }
 await receive("comp",{id:"house",type:"structure",data:base});
 check(data()!==undone&&cached(data())!==undonePlan,"re-attach creates its own received revision");
 for(const primitive of ["junk",true,7,null]){
  const first=cached(primitive);
  check(first.levels.length===0&&cached(primitive)!==first,"malformed primitive "+JSON.stringify(primitive)+" plans empty, afresh each time (uncached)");
 }
 await receive("spawn",{id:"house",lib:"fixture.glb",pos:[0,0,0]});
 check(data()===undefined,"a same-id spawn is refused (an id is never reused), so no cached structure data survives under the old id");
 }
  }

  // ============================================================ real bodies over transformed structures' support (from structure-route-support-test)
  // the support mode, the band and the crossing height in world metres; legs drive the real tick
  console.log("\nSTRUCTURE — real bodies over transformed structures");
  {
const upper={y:3,tiles:[[0,0],[2,0]],walls:[],apertures:[]};
const ground={y:0,tiles:[[0,0],[1,0],[2,0]],walls:[[1,1,0]],apertures:[[1,1,0,"door"]]};
const basement={y:-3,tiles:[[0,0]],walls:[],apertures:[]};
const wall={levels:[{y:0,tiles:[],walls:[[1,1,0]],apertures:[]}]};

function bodyS(entity:any,height:(x:number,z:number)=>number,from:[number,number]) {
 const a=new WorldAgent({ url: noWorldUrl(), name:"walker",avatar:"",world:"support-test"});agents.push(a);a.joined=true;
 a.entities.set(entity.id,entity);(a as any).ground.terrain={heightAt:height};
 a.pos={x:from[0],y:height(...from),z:from[1]};return a;
}
function transformS(e:any,x:number,z:number):[number,number] {
 const c=Math.cos(e.yaw),s=Math.sin(e.yaw);
 return [e.pos[0]+(x*c+z*s)*e.scale,e.pos[2]+(-x*s+z*c)*e.scale];
}
{

 for(const e of [
  {id:"world",pos:[0,0,0],yaw:0,scale:1,structure:{levels:[basement,ground]}},
  {id:"shift",pos:[10,2,-5],yaw:Math.PI/3,scale:2,structure:{levels:[ground,basement]}},
 ]) {
  const a=bodyS(e,()=>e.pos[1],transformS(e,.5,.5));
  const r=await walk(a,transformS(e,3.5,.5));
  check(r.arrived&&r.points.every(p=>p.y===e.pos[1]),"real terrain-mode body exits ground above basement with translated/scaled frame");
 }
 const e={id:"overhead",pos:[10,1,-5],yaw:.6,scale:2,structure:{levels:[upper]}};
 const a=bodyS(e,()=>1,transformS(e,.5,.5));
 check((await walk(a,transformS(e,2.5,.5))).arrived,"real ground body walks beneath translated/scaled overhead floor without confinement");

 // the obstruction band is 0.5 WORLD metres: at scale 2, y 0.4 the wall's base is 0.6 m up, above the band
 const raised={id:"band",pos:[0,.4,0],yaw:0,scale:2,structure:wall};
 const b=bodyS(raised,()=>0,[0,1]);
 const r=await walk(b,[4,1]);
 check(r.arrived&&r.points.every(p=>Math.abs(p.z-1)<1e-10),"world-scaled step band leaves a 0.6m raised wall above a terrain walk");

 const sole={id:"sole",pos:[0,0,0],yaw:0,scale:1,structure:{levels:[upper]}};
 const soleBody=bodyS(sole,()=>0,[.5,.5]);soleBody.pos.y=3.1;
 const soleWalk=await walk(soleBody,[2.5,.5]);
 check(!soleWalk.arrived && /no path across this floor connects the start to the destination/.test(String((soleBody as any).walkRefusal)) && soleBody.pos.y===3.1,"a body on a sole raised floor stands on it, and a walk across the floor's gap is refused rather than taken on the terrain, for its own reason: the hole divides the floor");
 const slope={id:"slope",pos:[10,2,-5],yaw:Math.PI/2,scale:2,structure:wall};
 const highAtCross=(wx:number,wz:number)=>{const [lx]=localizePoint(slope,wx,0,wz);return 2+8*lx;};
 const c=bodyS(slope,highAtCross,transformS(slope,0,.5));
 // walked, not run: shared/mover.js refuses a stride rising over a step (0.8 m); a run's stride here rises 1.6 m, a walk's 0.62 m
 const high=await walk(c,transformS(slope,2,.5),{run:false});
 check(high.arrived&&high.points.every(p=>Math.abs(localizePoint(slope,p.x,p.y,p.z)[2]-.5)<1e-8),
   "transformed real body uses terrain at wall crossing rather than origin height",{arrived:high.arrived,refusal:(c as any).walkRefusal});
 }
  }

  // ============================================================ WorldAgent ticks and the move tool over real plans
  console.log("\nSTRUCTURE — the agent half of routing");
  for (const [label, e] of [["base",entity()],["transformed",entity(house,"house",[10,0,-5],Math.PI/3,2)]] as const) {
    const a=agent(); a.entities.set(e.id,e);
    const from=worldPoint(e,[3.5,3]), to=worldPoint(e,[3.5,.5]); a.pos.x=from[0]; a.pos.z=from[1];
    const w=await walk(a,to,{tolerance:.4});
    check(w.arrived,label+": actual walkTo/ticks arrive");
    const local=w.samples.map(([x,z])=>{const [lx,,lz]=localizePoint(e,x,0,z);return [lx,lz];});
    check(valid(house,local),label+": actual tick trajectory with tolerance 0.4 crosses no wall");
    check(Math.hypot(a.pos.x-to[0],a.pos.z-to[1])<=.4,label+": destination tolerance remains honored");
    // Only the destination takes the caller's tolerance: the body stands on
    // each corner exactly before it turns.
    check(w.planned.length>2&&w.planned.slice(0,-1).every(([x,z])=>w.samples.some(([sx,sz])=>sx===x&&sz===z)),
      label+": every intermediate waypoint is reached exactly despite tolerance 0.4");
  }
  const a=agent(); a.pos={x:.5,y:0,z:-3};
  a.entities.set("junk",entity("junk" as any,"junk",[500,0,500]));
  a.entities.set("irrelevant",entity(house,"irrelevant",[100,0,100]));
  a.entities.set("house",entity());
  check((await walk(a,[3.5,.5])).arrived,"irrelevant and primitive structure data do not prevent the real route");

  const b=agent(); b.entities.set("sealed",entity(sealed,"sealed")); b.pos={x:.5,y:0,z:-3};
  const old=b.walkTo(-3,-3,true);
  const result=await walk(b,[3.5,.5]);
  check(!result.arrived && !(await old) && !(b as any).target && !(b as any).legs.length,"refused replacement settles both walks and clears old target/legs");
  const before=[b.pos.x,b.pos.z]; (b as any).tick();
  check(b.pos.x===before[0]&&b.pos.z===before[1],"refused replacement cannot keep walking toward old target");
  const ctx={agent:b,canPush:()=>false,heldActivity:[],cursor:{caughtUpTo:null}};
  const reply=await handleTool(ctx,"move",{to:[3.5,.5]});
  check(reply.content[0].text.includes("no route") && reply.content[0].text.includes("sealed"),"actual move tool explains sealed-building refusal");

  const badArgs=await handleTool(ctx,"move",{to:[NaN,.5]});
  check(badArgs.isError===true && badArgs.content[0].text===WALK_ARGS_REASON,"the tool and walkTo refuse bad arguments in the same words");

  const c=agent(); c.pos={x:-1,y:0,z:.5};
  c.entities.set("sparse",entity(sparse as any,"sparse"));
  const cap=await handleTool({...ctx,agent:c},"move",{to:[1,.5]});
  check(cap.content[0].text.includes("cells") && !(c as any).target,"actual tool reports budget refusal without movement");

  {
  // A foreign wall's detour must not discharge the floor-only constraint
  // imposed by the structure supporting the start.
  const support=agent(); support.pos={x:.5,y:3.1,z:.5}; standOn(support,"floor",1,3.1);
  const floor={levels:[{y:0,tiles:[],walls:[],apertures:[]},
    {y:3,tiles:[[0,0],[2,0]],walls:[],apertures:[]}]};
  const foreign={levels:[{y:3,tiles:[[10,10]],walls:[[1,1,0]],apertures:[]}]};
  support.entities.set("floor",entity(floor as any,"floor"));
  support.entities.set("foreign",entity(foreign as any,"foreign"));
  const unsupported=await walk(support,[2.5,.5]);
  check(!unsupported.arrived && !!support.walkRefusal,
    "foreign building candidate cannot override supporting upper-floor refusal");
  check(unsupported.samples.every(([x,z])=>x===.5&&z===.5),"foreign detour refusal leaves the body where it stands");
  floor.levels[1].tiles=[[0,0],[0,1],[0,2],[1,2],[2,2],[2,1],[2,0]];
  // Replace component identity too, so #200's plan cache sees the changed floor.
  support.entities.set("floor",entity(structuredClone(floor) as any,"floor"));
  support.pos={x:.5,y:3.1,z:.5};
  const supported=await walk(support,[2.5,.5]);
  const cells=new Set(floor.levels[1].tiles.map(([x,z])=>x+","+z));
  check(supported.arrived && supported.samples.every(([x,z])=>cells.has(Math.floor(x)+","+Math.floor(z))),
    "longer supported route wins over a shorter foreign unsupported shortcut");

  const nearby=agent(); nearby.pos={x:.2,y:3.1,z:.2}; standOn(nearby,"nearby",1,3.1);
  const oneFloor={levels:[{y:0,tiles:[],walls:[],apertures:[]},
    {y:3,tiles:[[0,0]],walls:[],apertures:[]}]};
  nearby.entities.set("nearby",entity(oneFloor as any,"nearby"));
  nearby.entities.set("distant",entity(oneFloor as any,"distant",[100,0,100]));
  const localMove=await walk(nearby,[.3,.3]);
  check(localMove.arrived && localMove.samples.every(([x,z])=>x>=.2&&x<=.3&&z>=.2&&z<=.3),
    "unrelated upper floor cannot veto a direct walk on the supporting floor");
  const stay=await walk(nearby,[.3,.3]);
  check(stay.arrived && stay.samples.every(([x,z])=>x===.3&&z===.3),
    "unrelated upper floor cannot veto a stationary supported walk");
  const free=agent(); free.pos={x:5,y:0,z:5};
  free.entities.set("distant",entity(oneFloor as any,"distant",[100,0,100]));
  check((await walk(free,[5.2,5.2])).arrived,"unrelated upper floor alone cannot veto a clear ground walk");

  }
  // Two structures offer individually legal but mutually conflicting routes.
  const base=entity(house,"one"); const two=entity(house,"two",[-1,0,0]);
  const d=agent(); d.entities.set("one",base); d.entities.set("two",two);
  d.pos={x:-2,y:0,z:1.5};
  const outcome=await walk(d,[5,1.5]);
  check(!outcome.arrived && !!d.walkRefusal?.includes("multi-building"),"conflicting second structure gets explicit local-search refusal");
  check(/\[(one|two)\]'s route is obstructed by \[(one|two)\]/.test(d.walkRefusal!),"the refusal names which structure obstructed which route: "+d.walkRefusal);
  // A third structure, over the search limit, keeps its own reason beside them.
  d.entities.set("huge",entity({ levels: [{ tiles: [], walls: [[1,3,1],[1,100000000,0]], apertures: [] }] } as any,"huge"));
  d.pos={x:-2,y:0,z:1.5};
  const withHuge=await walk(d,[5,1.5]);
  check(!withHuge.arrived && d.walkRefusal!.includes("multi-building") && d.walkRefusal!.includes("[huge]: its footprint")
    && d.walkRefusal!.includes("over the 16384-cell routing limit"),"an over-limit structure's own reason survives the generic refusal");
  // A reason carries its remedy after a semicolon, so each structure's starts a line of its own.
  check(d.walkRefusal!.split("\n").some((l) => l.startsWith("[huge]: its footprint")) && !d.walkRefusal!.includes("; [huge]"),
    "each structure's reason starts its own line: "+JSON.stringify(d.walkRefusal));
  {
    // A body held on an upper floor of a stacked house.
    const u=agent();
    const above=structuredClone(house.levels[0]); above.y=3;
    u.entities.set("stacked",entity({ levels: [structuredClone(house.levels[0]),above] } as any,"stacked"));
    u.pos={x:.2,y:3.1,z:.2}; standOn(u,"stacked",1,3.1);
    const stationary=await walk(u,[.2,.2]);
    check(stationary.arrived && stationary.samples.every(([x,z])=>x===.2&&z===.2),
      "a floor-held body stays put for an off-center stationary walk request");
    u.pos={x:.5,y:3.1,z:.5};
    const out=await walk(u,[.5,-2]);
    check(!out.arrived && !!u.walkRefusal?.includes("the destination isn't on this floor"),"a floor-held body is refused an upper destination beyond the floor");
    check(u.pos.x===.5 && u.pos.z===.5 && u.pos.y===3.1,"and the refusal leaves it standing where it was upstairs");
    u.pos={x:-.5,y:3.1,z:.5};
    const offStart=await walk(u,[.5,.5]);
    check(!offStart.arrived && !!u.walkRefusal?.includes("the start isn't on this floor") && !u.walkRefusal?.includes("destination isn't"),
      "a floor-held body standing off the floor is told the start is the endpoint off it");
    u.pos={x:.5,y:3.1,z:.5};
    above.tiles=[[0,0],[2,0]]; above.walls=[]; above.apertures=[];
    u.entities.set("stacked",entity({ levels: [structuredClone(house.levels[0]),above] } as any,"stacked"));
    const gap=await walk(u,[2.5,.5]);
    check(!gap.arrived && !(u as any).target,"a floor-held body is refused crossing a gap in sparse upper floors");
    check(!!u.walkRefusal?.includes("a hole in the floor can divide it"),"...and told a hole can divide a floor, not only its walls");
  }

  // A structure the agent can't check (its geometry isn't finite: a 10 m
  // tile at x = 1e308) is skipped for every walk, and logged once: it
  // neither refuses an unrelated walk nor stops a real route elsewhere.
  const warned: string[] = [], warn=console.warn;
  console.warn=(...args: unknown[])=>{ warned.push(args.map(String).join(" ")); };
  try {
    const s=agent(); s.pos={x:.5,y:0,z:-3};
    s.entities.set("house",entity());
    s.entities.set("broken",entity({ tile: 10, levels: [{ tiles: [], walls: [[0,1e308,0]], apertures: [] }] } as any,"broken"));
    check((await walk(s,[3.5,.5])).arrived,"an unplannable structure doesn't stop a real route elsewhere");
    s.pos={x:-5,y:0,z:-5};
    check((await walk(s,[-6,-6])).arrived && s.walkRefusal===null,"nor refuse an unrelated walk");
    check(warned.filter(l=>l.includes("[broken]")).length===1,"and the operator's log names it once");
  } finally { console.warn=warn; }

  // A structure carried by another is checked where it is now (the carrier's
  // place), not at its own rest pose.
  const carried=agent();
  carried.entities.set("cart",{ id:"cart", lib:"", pos:[10,0,0], yaw:0, scale:1 } as any);
  carried.entities.set("house",entity());
  carried.mounts.set("house",{ to:"cart" });
  carried.pos={x:10.5,y:0,z:-3};
  const here=await walk(carried,[13.5,.5]);
  const local=here.samples.map(([x,z])=>[x-10,z] as P);
  check(here.arrived && here.planned.length>1 && valid(house,local),"a carried structure's walls are checked at its carrier's place");
  carried.pos={x:.5,y:0,z:-3};
  const rest=await walk(carried,[3.5,.5]);
  check(rest.arrived && rest.planned.length===1,"and its rest pose, where nothing stands now, is walked straight across");

  // A body standing in a wall (a door edited to a window under its feet)
  // steps out to the nearest clear point beside it, and is routed from there.
  const inWall=agent(); inWall.entities.set("house",entity()); inWall.pos={x:0,y:0,z:1.5};
  const out2=await walk(inWall,[3.5,.5]);
  const step=out2.planned[0];
  check(out2.arrived && Math.hypot(step[0],step[1]-1.5)<=.5 && step[0]>0,"a body standing in a wall steps out beside it, toward its destination");
  check(valid(house,out2.samples.slice(1)),"and walks on without crossing a wall");
  const shut={ levels: [{ tiles: [[0,0]], walls: [[0,0,0],[0,0,1],[1,0,0],[1,1,0]], apertures: [] }] };
  const vault={ levels: [{ tiles: [[0,0]], walls: [[0,0,0],[0,0,1],[1,0,0],[1,1,0]], apertures: [] }] };
  const stuck=agent(); stuck.entities.set("shut",entity(shut as any,"shut")); stuck.entities.set("vault",entity(vault as any,"vault",[10,0,10]));
  stuck.pos={x:0,y:0,z:.5};
  const nowhere=await walk(stuck,[10.5,10.5]);
  check(!nowhere.arrived && stuck.walkRefusal!.startsWith("the body stands in a wall, and from beside it:\n") && stuck.walkRefusal!.includes("[vault]")
    && stuck.walkRefusal!.includes("\nfrom another side: "),
    "a body in a wall with no route from either side gives each side's reason, each on its own line: "+stuck.walkRefusal);

} finally { for (const a of agents) a.close(); }
S.done();
