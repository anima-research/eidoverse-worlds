// bun tools/walk-support-lifecycle-test.ts — a walk's support, from planning
// through its last tick, and how a walk ends: arrival, stop, replacement,
// refusal, timeout and close.
import { strict as assert } from "node:assert";
import { WorldAgent, WALK_ARGS_REASON } from "../mcpl/agent.ts";
let checks=0;
const check=(ok:unknown,label:string)=>{assert.ok(ok,label);checks++;console.log("✓ "+label);};
const agents:WorldAgent[]=[];
const make=(heightAt:(x:number,z:number)=>number=()=>0)=>{
 const a=new WorldAgent({name:"walker",world:"support",avatar:""});
 agents.push(a);a.joined=true;(a as any).terrain={heightAt};return a;
};
const ent=(id:string,structure:any)=>({id,lib:"",pos:[0,0,0],yaw:0,scale:1,comp:{structure}} as any);
async function finish(a:WorldAgent,p:Promise<boolean>,each?:(i:number)=>void){
 const points=[{...a.pos}];
 for(let i=0;i<1000&&(a as any).target;i++){each?.(i);(a as any).tick();points.push({...a.pos});}
 if((a as any).target){a.stop();throw new Error("bounded tick limit");}
 return {arrived:await p,points};
}
// The walks below are given a minute to time out, so a verdict that comes
// within this bound came from its own branch (stop, replacement, refusal,
// close), not from the walk's timer.
const SETTLE_MS=50;
const settled=(p:Promise<boolean>)=>Promise.race([p,Bun.sleep(SETTLE_MS).then(()=>"pending" as const)]);
const LONG=60_000;
// A wall the walk from (0.5,0.5) to (2.5,0.5) must go around, through the
// house's doors: its route has legs to spare at any point before arrival.
const house={levels:[{y:0,tiles:[[0,0],[1,0],[2,0]],walls:[[1,1,0],[0,1,0],[0,1,1],[1,2,0]],apertures:[[0,1,0,"door"],[0,1,1,"door"]]}]};
const sealed={levels:[{y:0,tiles:[[8,0]],walls:[[0,8,0],[0,8,1],[1,8,0],[1,9,0]]}]};
try{
 // A terrain walk reads the live terrain each tick: the feet follow
 // a slope, and terrain that changes mid-walk, or loads late, moves them.
 const slope=(x:number)=>0.1*x;
 const a=make((x)=>slope(x));a.pos={x:0,y:0,z:0};
 let swapped=-1;
 const one=await finish(a,a.walkTo(3,0,true,LONG,0),(i)=>{ if(i===5){(a as any).terrain={heightAt:(x:number)=>2+slope(x)};swapped=i+1;} });
 check(one.arrived&&one.points.slice(1,swapped).every(p=>Math.abs(p.y-slope(p.x))<1e-12),"a terrain walk's feet follow the terrain under them each tick");
 check(one.points.slice(swapped).every(p=>Math.abs(p.y-2-slope(p.x))<1e-12)&&one.points.length>swapped+1,"terrain that changes mid-walk is the terrain the next tick stands on");
 check((a as any).walkHeightAt===null,"arrival releases the walk's basis");
 // A wall the start's height would pass under, and the crossing's height meets.
 const b=make((x)=>x);b.pos={x:0,y:0,z:.5};
 b.entities.set("raised",ent("raised",{levels:[{y:.6,tiles:[],walls:[[1,1,0]],apertures:[]}]}));
 const rising=b.walkTo(2,.5,true,LONG,0);
 check((b as any).legs.length>0,"a wall the band meets at the crossing's terrain height is routed around, not under");
 const around=await finish(b,rising);
 // Whether the step p→q meets the wall at x = 1, z in [0, 1].
 const crossesWall=(p:any,q:any)=>{
  if((p.x-1)*(q.x-1)>0||p.x===q.x) return false;
  const z=p.z+(1-p.x)/(q.x-p.x)*(q.z-p.z);return z>=0&&z<=1;
 };
 check(around.arrived&&!around.points.some((p,i)=>i>0&&crossesWall(around.points[i-1],p)),"and the walk keeps clear of that wall");

 // A floor walk keeps the floor that admitted its route through its last
 // tick. Main's body stands on terrain only, so this body is given the floor
 // support the storey-standing work (#200) supplies, by position.
 const d=make();d.pos={x:.5,y:3.1,z:.5};
 d.entities.set("owner",ent("owner",{levels:[{y:0,tiles:[],walls:[]},{y:3,tiles:[[0,0],[1,0],[2,0]],walls:[]}]}));
 d.entities.set("higher",ent("higher",{levels:[{y:0,tiles:[],walls:[]},{y:3.2,tiles:[[1,0],[2,0]],walls:[]}]}));
 (d as any).walkSupport=()=>d.pos.x>1
  ?{kind:"floor",height:3.3,entity:"higher",level:1}:{kind:"floor",height:3.1,entity:"owner",level:1};
 const floorWalk=await finish(d,d.walkTo(2.5,.5,true,LONG,0));
 check(floorWalk.arrived&&floorWalk.points.every(p=>Math.abs(p.y-3.1)<1e-9),"a floor walk keeps its admitted floor, not another it passes over");
 const next=d.walkTo(2.6,.5,true,LONG,0);
 check(Math.abs(d.pos.y-3.3)<1e-9,"the next walk asks for its support afresh");
 await finish(d,next);

 // How a walk ends. Each verdict comes from its own branch within the bound.
 const e=make();e.entities.set("house",ent("house",house));e.pos={x:.5,y:0,z:.5};
 const stopped=e.walkTo(2.5,.5,true,LONG,0);
 e.stop();
 check(await settled(stopped)===false&&(e as any).walkHeightAt===null&&!(e as any).target&&e.speed===0&&e.clip==="idle","stop settles the walk and clears its target and basis");
 e.entities.set("sealed",ent("sealed",sealed));
 const routed=e.walkTo(2.5,.5,true,LONG,0);
 for(let i=0;i<3;i++)(e as any).tick();
 check((e as any).legs.length>0&&(e as any).target,"a routed walk under way has legs left");
 const refused=e.walkTo(8.5,.5,true,LONG,0);
 check(await settled(refused)===false&&await settled(routed)===false,"a refused replacement settles both walks at once");
 check(!(e as any).target&&!(e as any).legs.length&&(e as any).walkHeightAt===null&&e.speed===0&&e.clip==="idle",
  "a refused replacement cancels the walk under way: no target, no legs, no basis, standing");
 check(e.walkRefusal?.includes("[sealed]"),"and says why it was refused: "+e.walkRefusal);
 e.entities.delete("sealed");
 const expired=e.walkTo(2.5,.5,true,30,0);
 for(let i=0;i<3;i++)(e as any).tick();
 check((e as any).legs.length>0&&e.speed>0&&(e.clip==="run"||e.clip==="walk"),"a walk about to time out is walking, with legs left");
 check(!(await expired)&&(e as any).walkHeightAt===null&&!(e as any).legs.length&&!(e as any).target,"timeout clears its target, legs and basis");
 check(e.speed===0&&e.clip==="idle","and the body stands, as stop leaves it");
 // A superseded walk's timer firing later leaves the newer walk alone.
 const old=e.walkTo(2.5,.5,true,20,0);
 const newer=e.walkTo(2.5,.5,true,LONG,0);
 const target=JSON.stringify((e as any).target);
 await Bun.sleep(60);
 check(await settled(old)===false&&await settled(newer)==="pending"&&JSON.stringify((e as any).target)===target&&(e as any).walkHeightAt!==null,
  "a superseded walk's timer leaves its replacement's target and basis in place");
 e.stop();
 const closed=e.walkTo(2.5,.5,true,LONG,0);e.close();
 check(await settled(closed)===false&&(e as any).walkHeightAt===null,"close settles the walk and releases its basis");

 // A walk refused for its arguments changes nothing: the walk under way goes on.
 const f=make();f.entities.set("house",ent("house",house));f.pos={x:.5,y:0,z:.5};
 const going=f.walkTo(2.5,.5,true,LONG,0);
 const planned=JSON.stringify([(f as any).target,(f as any).legs]);
 check(await f.walkTo(NaN,0)===false&&f.walkRefusal===WALK_ARGS_REASON,
  "a walk refused for its arguments says so");
 check(await settled(going)==="pending"&&JSON.stringify([(f as any).target,(f as any).legs])===planned,"and leaves the walk under way going");
 f.stop();

 // A refused walk leaves the body as it was: seated, pinned, posed and
 // tumbling, with nothing sent. An accepted one gets it up.
 const g=make();g.entities.set("sealed",ent("sealed",sealed));
 const sent:any[]=[];(g as any).ws={send:(m:string)=>sent.push(JSON.parse(m)),close(){}};
 const seated=()=>{
  g.pos={x:.5,y:1.2,z:.5};g.mounts.set(g.name,{to:"chair"});g.pins.set("hand_l",[1,1,1]);
  g.heldPose={chest:[0,0,0,1]};g.clip="ragdoll";g.speed=0;
 };
 seated();
 const state=()=>JSON.stringify({pos:g.pos,pins:[...g.pins],pose:g.heldPose,clip:g.clip,epoch:(g as any).bodyEpoch});
 const before=state();
 check(!(await g.walkTo(8.5,.5,true,LONG,0))&&g.walkRefusal?.includes("[sealed]"),"a walk into a sealed room is refused");
 check(state()===before&&sent.length===0,"and the refused walk leaves the seated, pinned, posed, tumbling body as it was, sending nothing");
 const up=g.walkTo(1.5,.5,true,LONG,0);
 check(g.pins.size===0&&g.heldPose===null&&g.pos.y===0&&sent.some(m=>m.verb==="dismount"),"an accepted walk gets the body up: unpinned, unposed, dismounted, on the ground");
 g.stop();await up;
 console.log("PASS "+checks+" active-support lifecycle checks");
}finally{for(const a of agents)a.close();}
process.exit(0);
