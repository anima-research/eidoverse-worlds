// bun tools/route-preparation-bench.ts [checkout]
// Bounded report, not a timing gate: 64 small structures, 1 cold + 30 warm
// walk plans; no server, renderer, body ticks or production filesystem writes.
import { resolve } from "node:path";
const root = process.argv[2] ? resolve(process.argv[2]) : resolve(import.meta.dir,"..");
const { WorldAgent } = await import(root+"/mcpl/agent.ts");
const a = new WorldAgent({name:"bench",avatar:"",world:"bench"});
a.pos={x:-1,y:0,z:0};
let normalizationReads=0;
const level={y:0,tiles:Array.from({length:8},(_,i)=>[i%4,Math.floor(i/4)]),
 walls:[...Array.from({length:4},(_,x)=>[0,x,0]),...Array.from({length:4},(_,x)=>[0,x,2]),
 [1,0,0],[1,0,1],[1,4,0],[1,4,1],[1,2,0],[1,2,1]],
 apertures:[[0,0,0,"door"],[1,2,0,"door"]]};
for(let i=0;i<64;i++){
 const levels=[structuredClone(level)];
 const data={get levels(){normalizationReads++;return levels;}};
 a.entities.set("house-"+i,{id:"house-"+i,lib:"",pos:[(i%8)*10,0,20+Math.floor(i/8)*10],yaw:0,scale:1,comp:{structure:data}});
}
async function plan(){
 const t=performance.now(), p=a.walkTo(-2,0,false,1000,0);
 a.stop();await p;return performance.now()-t;
}
try{
 const coldMs=await plan(), coldReads=normalizationReads, warm:number[]=[];
 for(let i=0;i<30;i++)warm.push(await plan());
 warm.sort((a,b)=>a-b);
 console.log(JSON.stringify({structures:64,warmPlans:30,coldMs:+coldMs.toFixed(3),
  warmMedianMs:+warm[15].toFixed(3),warmP95Ms:+warm[28].toFixed(3),
  coldNormalizationReads:coldReads,warmNormalizationReads:normalizationReads-coldReads,
  rssMiB:+(process.memoryUsage().rss/1048576).toFixed(1)},null,2));
}finally{a.close();}
process.exit(0);
