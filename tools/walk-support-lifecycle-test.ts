// bun tools/walk-support-lifecycle-test.ts — planning/execution use one basis.
import { strict as assert } from "node:assert";
import { WorldAgent } from "../mcpl/agent.ts";
let checks=0;
const check=(ok:unknown,label:string)=>{assert.ok(ok,label);checks++;console.log("✓ "+label);};
const agents:WorldAgent[]=[];
const make=()=>{
 const a=new WorldAgent({name:"walker",world:"support",avatar:""});
 agents.push(a);a.joined=true;(a as any).terrain={heightAt:()=>0};return a;
};
const ent=(id:string,structure:any)=>({id,lib:"",pos:[0,0,0],yaw:0,scale:1,comp:{structure}} as any);
async function finish(a:WorldAgent,p:Promise<boolean>){
 const points=[{...a.pos}];
 for(let i=0;i<1000&&(a as any).target;i++){(a as any).tick();points.push({...a.pos});}
 if((a as any).target){a.stop();throw new Error("bounded tick limit");}
 return {arrived:await p,points};
}
try{
 const a=make();a.pos={x:0,y:0,z:0};
 const first=a.walkTo(2,0,true,10000,0);
 (a as any).terrain={heightAt:()=>2};
 const one=await finish(a,first);
 check(one.arrived&&one.points.every(p=>p.y===0),"active terrain walk retains the admitted terrain function through arrival");
 check((a as any).walkHeightAt===null,"arrival releases the active basis");
 const two=await finish(a,a.walkTo(2.5,0,true,10000,0));
 check(two.arrived&&two.points.every(p=>p.y===2),"a later walk resolves a fresh terrain basis");

 const b=make();
 const canceled=b.walkTo(5,0,true,10000,0);
 b.stop();
 check(!(await canceled)&&(b as any).walkHeightAt===null&&!(b as any).target,"stop clears target and active basis");
 const replaced=b.walkTo(5,0,true,10000,0);
 b.entities.set("sealed",ent("sealed",{levels:[{y:0,tiles:[[2,0]],walls:[[0,2,0],[0,2,1],[1,2,0],[1,3,0]]}]}));
 const refused=b.walkTo(2.5,.5,true,10000,0);
 check(!(await refused)&&!(await replaced)&&(b as any).walkHeightAt===null,"refused replacement clears the previous admitted basis");
 b.entities.clear();
 const expired=b.walkTo(10,0,true,5,0);
 await Bun.sleep(15);
 check(!(await expired)&&(b as any).walkHeightAt===null&&!(b as any).legs.length,"timeout clears basis and remaining legs");
 const closed=b.walkTo(10,0,true,10000,0);b.close();
 check(!(await closed)&&(b as any).walkHeightAt===null,"close settles the walk and releases its basis");

 if(typeof (a as any).groundAt==="function"){
  const c=make();c.pos={x:-.5,y:0,z:.5};
  c.entities.set("step",ent("step",{levels:[{y:-3,tiles:[],walls:[]},{y:.1,tiles:[[0,0],[1,0],[2,0]],walls:[]}]}));
  c.entities.set("wall",ent("wall",{levels:[{y:.5,tiles:[],walls:[[1,1,0]],apertures:[]}]}));
  const drift=await finish(c,c.walkTo(2.5,.5,true,10000,0));
  check(drift.arrived&&drift.points.every(p=>p.y===0),"#200 terrain walk does not acquire a nearby floor midwalk or on completion");
  check(drift.points.some(p=>p.x>.8&&p.x<1.2&&p.y===0),"#200 wall crossing uses the admitted terrain band");

  const d=make();d.pos={x:.5,y:3.1,z:.5};
  d.entities.set("owner",ent("owner",{levels:[{y:0,tiles:[],walls:[]},{y:3,tiles:[[0,0],[1,0],[2,0]],walls:[]}]}));
  d.entities.set("higher",ent("higher",{levels:[{y:0,tiles:[],walls:[]},{y:3.2,tiles:[[1,0],[2,0]],walls:[]}]}));
  const floorWalk=await finish(d,d.walkTo(2.5,.5,true,10000,0));
  check(floorWalk.arrived&&floorWalk.points.every(p=>Math.abs(p.y-3.1)<1e-9),"#200 floor walk does not switch to a different overlapping floor midwalk");
  const next=await finish(d,d.walkTo(2.5,.5,true,10000,0));
  check(next.arrived&&Math.abs(d.pos.y-3.3)<1e-9,"#200 next walk resolves the standing policy anew after arrival");
 }
 console.log("PASS "+checks+" active-support lifecycle checks");
}finally{for(const a of agents)a.close();}
process.exit(0);
