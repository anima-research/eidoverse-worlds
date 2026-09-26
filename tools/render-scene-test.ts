import { test, expect } from "bun:test";
import { emptyState, foldEntry } from "../shared/fold.js";
import { planStructure } from "../shared/structure.js";
import { makeHeightField, terrainParams } from "../shared/terrainmath.js";
import { renderScene, projectEntity, projectEnvironment } from "../server/render-scene.ts";
import { createNativeLogin } from "../server/native-login.ts";
import { captureCapability } from "../server/snapshots.ts";
import { effectiveClock, effectiveSky } from '../shared/forecast.js';
import { projectFlora } from '../server/render-flora.ts';
import { placeInstances, resetFloraOccupancy } from '../shared/flora-placement.js';
import grassSpec from '../defs/flora/grass.json';
import { emptySim, simEntry, advanceSim, tickOf } from '../shared/sim.js';

const building = { levels: [{ y: 0, tiles: [[0,0],[1,0]], walls: [[0,0,0],[0,0,1],[1,0,0],[1,2,0]], apertures: [[0,0,0,"door"]] }] };
function fixture() {
  const state=emptyState();let seq=0;
  const world:any={name:"first",state,clients:new Set(),joinPayload:()=>({throughSeq:seq,tail:[]})};
  const client:any={world,gen:1,surface:"world",ws:{readyState:1}};world.clients.add(client);
  return {world,client,write:(verb:string,args:any)=>foldEntry(state,{seq:++seq,ts:1000,actor:"builder",verb,args}),
    request:(now:number,reset=false)=>renderScene(client,{version:1,reset},now) as any};
}
test("projection reuses canonical structure topology and height law",()=>{
  const p=projectEntity("house",{comp:{structure:building}}).structure;
  const canonical=planStructure(building);
  expect(p.boxes).toEqual(canonical.boxes);expect(p.sweeps).toEqual(canonical.levels.flatMap(l=>l.sweeps));
  const terrain={size:80,amplitude:7,seed:82};const e=projectEnvironment({terrain});
  const height=makeHeightField(terrainParams(terrain));expect(e.terrain.heights[32*65+32]).toBe(height(0,0));
  expect(e.terrain.heights[0]).toBe(height(-40,-40));
});
test("spawn/place/comp/remove project from one fold; unchanged geometry is not retransmitted",()=>{
  const f=fixture();f.write("spawn",{id:"house",lib:"house.glb",pos:[1,2,3]});f.write("comp",{id:"house",type:"structure",data:building});
  const a=f.request(1000);expect(a.upserts).toHaveLength(1);expect(a.transforms[0].p).toEqual([1,2,3]);expect(a.environment).toBeDefined();
  expect(f.request(1100)).toBeNull();f.write("place",{id:"house",pos:[8,2,3],yaw:1});
  const b=f.request(1300);expect(b.upserts).toEqual([]);expect(b.environment).toBeUndefined();expect(b.transforms[0].p).toEqual([8,2,3]);
  f.write("remove",{id:"house"});expect(f.request(1600).removed).toEqual(["house"]);
});
test("mount and motion use existing effective world transform",()=>{
  const f=fixture();f.write("spawn",{id:"parent",lib:"p.glb",pos:[10,0,0],scale:2});f.write("spawn",{id:"child",lib:"c.glb"});
  f.write("mount",{id:"child",to:"parent",offset:[1,0,0]});
  expect(f.request(1000).transforms.find((t:any)=>t.id==="child").p).toEqual([12,0,0]);
  f.write("motion",{id:"parent",type:"bob",amp:1,period:4,t0:1000});
  const r=f.request(2000);expect(r.moving).toBe(true);expect(r.transforms.find((t:any)=>t.id==="parent").p[1]).toBeCloseTo(1);
});
test("reset, connection generation and world changes never reuse old deltas",()=>{
  const f=fixture();f.write("spawn",{id:"a",lib:"a.glb"});f.request(1000);
  expect(f.request(1300,true).upserts).toHaveLength(1);
  f.client.gen++;expect(f.request(1400).upserts).toHaveLength(1);
  const g=fixture();g.world.name="second";g.write("spawn",{id:"b",lib:"b.glb"});f.client.world=g.world;g.world.clients.add(f.client);
  expect(f.request(1500).upserts.map((e:any)=>e.id)).toEqual(["b"]);
  f.client.superseded=true;expect(f.request(1800)).toBeNull();
});
test("unsupported versions and oversized scenes fail explicitly without partial success",()=>{
  const f=fixture();expect((renderScene(f.client,{version:9},1000) as any).error).toBe("unsupported_version");
  for(let i=0;i<513;i++)f.write("spawn",{id:String(i),lib:"x.glb"});
  expect(f.request(1400).error).toBe("projection_failed");
});
test('weather derives from canonical clock/forecast without resending terrain',()=>{
  const f=fixture();f.write('sky',{hours:8,rate:24,forecast:{seed:7,states:['rain','clear'],dwellSec:[60,60],transitionSec:10}});
  const a=f.request(2000),b=f.request(63000);
  expect(a.atmosphere.clock).toEqual(effectiveClock(f.world.state.sky,2000));
  expect(b.atmosphere.weather).toEqual(effectiveSky(f.world.state.sky,63000));
  expect(b.environment).toBeUndefined();expect(b.moving).toBe(true);
});
test('flora shares deterministic browser placement, supports presets, caps bad fields',()=>{
  const args={species:'grass',width:4,depth:4,seed:7};
  resetFloraOccupancy();const expected=placeInstances({...args,center:[0,0],maxSlope:.9,heightFn:()=>2},grassSpec);
  expect(projectFlora(args,()=>2).strokes[0].placements).toEqual(expected);
  expect(projectFlora(args,()=>2)).toEqual(projectFlora(args,()=>2));
  expect(projectFlora({preset:'mojave',size:12},()=>0).strokes.length).toBeGreaterThan(1);
  expect(projectFlora({size:500,density:1000},()=>0).warnings.length).toBeGreaterThan(0);
  expect(projectFlora({species:'missing'},()=>0).warnings.length).toBe(1);
  expect(projectFlora({...args,density:0},()=>0).strokes[0].placements).toEqual([]);
});
test('live leases outrank rest transform; interaction changes invalidate entity revision',()=>{
  const f=fixture();f.write('spawn',{id:'ball',lib:'ball.glb',pos:[1,0,0]});f.request(1000);
  f.world.leases=new Map([['ball',{lastState:{p:[4,2,3],yaw:1}}]]);
  expect(f.request(1300).transforms[0]).toMatchObject({p:[4,2,3],leased:true});
  f.write('comp',{id:'ball',type:'reactions',data:{push:{impulse:.35}}});
  expect(f.request(1600).upserts[0].interact.actions).toEqual(['push']);
  f.world.leases.clear();expect(f.request(1900).transforms[0].p).toEqual([1,0,0]);
});
test('large commons meadow is a bounded deterministic subset, not an empty field',()=>{
  const args={species:'grass',width:90,depth:80,center:[0,0],height:.42,density:1,seed:7};
  const a=projectFlora(args,()=>0),b=projectFlora(args,()=>0);
  expect(a.strokes[0].placements).toHaveLength(12000);
  expect(a).toEqual(b);expect(a.warnings[0]).toContain('native draw cap');
  resetFloraOccupancy();
  const all=placeInstances({...args,maxSlope:.9,heightFn:()=>0},grassSpec);
  const keys=new Set(all.map(p=>`${p.x}/${p.z}/${p.yaw}`));
  expect(a.strokes[0].placements.every(p=>keys.has(`${p.x}/${p.z}/${p.yaw}`))).toBe(true);
});
test('authored terrain tessellation and color survive native projection',()=>{
  const e=projectEnvironment({terrain:{size:160,segments:200,layers:[{color:'#4a5d33'}]}});
  expect(e.terrain.segments).toBe(128);expect(e.terrain.heights).toHaveLength(129*129);
  expect(e.terrain.color).toBe(0x4a5d33);
});
test('canonical physics poses advance read-only, carry mounts, and release to authored state',()=>{
  const f=fixture();f.write('spawn',{id:'ball',lib:'ball.glb',pos:[1,0,0]});
  f.write('spawn',{id:'child',lib:'c.glb'});f.write('mount',{id:'child',to:'ball',offset:[0,1,0]});
  const sim=f.world.sim=emptySim();
  simEntry(sim,{seq:4,ts:1000,verb:'epoch',args:{sim:'eidosim@0.5.0',tickMs:66}},f.world.state);
  simEntry(sim,{seq:5,ts:1000,verb:'punt',args:{id:'ball',power:5,dir:[1,.9,0]}},f.world.state);
  const before=structuredClone(sim),expected=structuredClone(sim);advanceSim(expected,tickOf(expected,1300));
  const a=f.request(1300);expect(a.simulation.enabled).toBe(true);expect(a.updateIntervalMs).toBe(66);
  expect(a.transforms.find((t:any)=>t.id==='ball').p).toEqual(expected.bodies.ball.p);
  expect(a.transforms.find((t:any)=>t.id==='child').p).toEqual(expected.bodies.ball.p.map((n:number,i:number)=>n+(i===1?1:0)));
  expect(sim).toEqual(before);expect(f.request(1366)).not.toBeNull();expect(f.request(1370)).toBeNull();
  f.world.leases=new Map([['ball',{lastState:{p:[8,9,10],yaw:0}}]]);
  expect(f.request(1432).transforms.find((t:any)=>t.id==='ball').p).toEqual([8,9,10]);f.world.leases.clear();
  // The next fast poll must receive a final pose even if the server heartbeat
  // has put the body to sleep meanwhile; a silent drop leaves a client waiting.
  sim.bodies.ball.resting=true;
  expect(f.request(1498).updateIntervalMs).toBe(300);sim.bodies.ball.resting=false;
  advanceSim(sim,tickOf(sim,20000));expect(sim.bodies.ball.resting).toBe(true);
  const rest=f.request(20000);expect(rest.updateIntervalMs).toBe(300);expect(rest.transforms.find((t:any)=>t.id==='ball').p).toEqual(sim.bodies.ball.p);
  f.write('place',{id:'ball',pos:[2,3,4]});simEntry(sim,{seq:6,ts:20300,verb:'place',args:{id:'ball',pos:[2,3,4]}},f.world.state);
  expect(f.request(20300).transforms.find((t:any)=>t.id==='ball').p).toEqual([2,3,4]);
});
test('foreign physics epochs keep barrier poses; ordinary props are never snapped',()=>{
  const f=fixture();f.write('spawn',{id:'prop',lib:'p.glb',pos:[0,7,0]});
  f.world.sim={epoch:{sim:'unknown@1',foreign:true,tickMs:66,ts:0,seq:1},tick:0,bodies:{prop:{p:[2,8,4],v:[1,2,3],yaw:0,resting:false}}};
  const before=structuredClone(f.world.sim);const a=f.request(1000);
  expect(a.simulation).toMatchObject({enabled:true,foreign:true,activeBodies:0});expect(a.transforms[0].p).toEqual([2,8,4]);expect(f.world.sim).toEqual(before);
  f.world.sim=emptySim();expect(f.request(1300).transforms[0].p).toEqual([0,7,0]);
});
test("all-world native access requires explicit browser approval; old grants stay water-only",async()=>{
  const issued:any[]=[];const origin="https://example.test";
  const handler=createNativeLogin({origin,login:"https://identity.test",enabled:true,now:()=>1000,
    session:c=>c==="browser"?{sub:"human:test",name:"test",scopes:["worlds:join","admin"],exp:100000}:null,
    issue:s=>{issued.push(s);return "a".repeat(64);}});
  const post=(path:string,body:any,auth=false)=>handler(new Request(origin+path,{method:"POST",headers:{"content-type":"application/json",...(auth?{origin,cookie:"browser"}:{})},body:JSON.stringify(body)}));
  for(const all of [false,true]){
    const p=await(await post("/native/start",{all_worlds:true})).json();
    expect((await post("/native/approve",{user_code:p.user_code,all_worlds:all})).status).toBe(403);
    expect((await post("/native/approve",{user_code:p.user_code,all_worlds:all},true)).status).toBe(200);
    const r=await(await post("/native/poll",{device_code:p.device_code})).json();expect(r.world_scope).toBe(all?"*":"water");
  }
  expect(issued.map(s=>s.nativeWorld)).toEqual(["water","*"]);expect(issued[1].scopes).toEqual(["worlds:join"]);
  expect(captureCapability({version:1,engine:"unreal",scene:"world-projection"})?.scene).toBe("world-projection");
});
