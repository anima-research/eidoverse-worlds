import { test, expect } from "bun:test";
import { emptyState, foldEntry } from "../shared/fold.js";
import { planStructure } from "../shared/structure.js";
import { makeHeightField, terrainParams } from "../shared/terrainmath.js";
import { renderScene, projectEntity, projectEnvironment, projectComponentData } from "../server/render-scene.ts";
import { createNativeLogin } from "../server/native-login.ts";
import { captureCapability } from "../server/snapshots.ts";
import { effectiveClock, effectiveSky } from '../shared/forecast.js';
import { projectFlora } from '../server/render-flora.ts';
import { placeInstances, placeExplicit, resetFloraOccupancy } from '../shared/flora-placement.js';
import grassSpec from '../defs/flora/grass.json';
import { emptySim, simEntry, advanceSim, tickOf } from '../shared/sim.js';
import { registerGrid, shapedHeightAt, encodeGrid, decodeGrid } from '../shared/terrainshape.js';

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

test("water, air and environment components reach native renderers as normalized data",()=>{
  const f=fixture();
  f.write("spawn",{id:"ocean",lib:"ocean.glb",pos:[0,0,0]});
  f.write("comp",{id:"ocean",type:"water",data:{center:[0,-50,0],size:[400,100,-400],absorption:[.2,.06,-1],speed:99,
    waves:[{amplitude:.4,wavelength:12,direction:[3,4]}],script:"ignored"}});
  f.write("comp",{id:"ocean",type:"environment",data:{spawn:[0,-5,0],bounds:{min:[-200,-100,-200],max:[200,20,200]}}});
  f.write("spawn",{id:"habitat",lib:"habitat.glb",pos:[10,-30,5]});
  f.write("comp",{id:"habitat",type:"air",data:{boxes:[{center:[0,1,0],size:[4,-3,6],q:[0,0,0,"x"]}]}});
  const up=Object.fromEntries(f.request(1000).upserts.map((e:any)=>[e.id,e]));
  expect(up.ocean.data.water.size).toEqual([400,100,400]);
  expect(up.ocean.data.water.absorption).toEqual([.2,.06,0]);
  expect(up.ocean.data.water.speed).toBe(20);
  expect(up.ocean.data.water.waves[0].direction[0]).toBeCloseTo(.6);
  expect(up.ocean.data.water.script).toBeUndefined();
  expect(up.ocean.data.environment.spawn).toEqual([0,-5,0]);
  expect(up.habitat.data.air.boxes[0]).toEqual({center:[0,1,0],size:[4,3,6],q:[0,0,0,1]});
  expect(projectComponentData({reactions:{}})).toBeNull();
  // named emitters reach native renderers by name, normalized by the same law
  // (scale and authored motion included); a malformed key is not an emitter
  const fx:any=projectComponentData({particles:{preset:"fire",scale:0.025},"particles:smoke":{preset:"smoke",gravity:0.6,color:"#556"},"particles:two words":{preset:"fire"}},"hearth");
  expect(fx.particles.scale).toBe(0.025);
  expect(Object.keys(fx.emitters)).toEqual(["smoke"]);
  expect(fx.emitters.smoke.gravity).toEqual([0,0.6,0]);expect(fx.emitters.smoke.color).toBe(0x555566);
  expect(fx.emitters.smoke.seed).not.toBe(projectComponentData({particles:{preset:"smoke"}},"hearth").particles.seed);
  f.write("comp",{id:"ocean",type:"water",data:{center:[0,-40,0],size:[400,100,400]}});
  const next=f.request(2000).upserts.map((e:any)=>e.id);
  expect(next).toEqual(["ocean"]);
  expect(()=>projectComponentData({vehicle:{blob:"x".repeat(20000)}})).toThrow();
});

test("moving entities carry closed-form parameters that reproduce the server transform",async()=>{
  const { evalWholeMotion } = await import("../client/lib/motioneval.js");
  const f=fixture();
  f.write("spawn",{id:"ferry",lib:"ferry.glb",pos:[4,0,2],yaw:.3,scale:2});
  f.write("comp",{id:"ferry",type:"motion",data:{type:"orbit",center:[0,0,0],radius:9,degPerSec:15}});
  f.write("spawn",{id:"crate",lib:"crate.glb",pos:[0,0,0]});
  f.write("mount",{id:"crate",to:"ferry",offset:[1,.5,0],yaw:.2});
  const now=5000, s=f.request(now), byId=Object.fromEntries(s.transforms.map((t:any)=>[t.id,t]));
  const ferry=byId.ferry, r=evalWholeMotion(ferry.motion.base,ferry.motion.m,now);
  expect(Number.isFinite(ferry.motion.m.t0)).toBe(true);
  r.pos.forEach((v:number,i:number)=>expect(v).toBeCloseTo(ferry.p[i],9));
  r.quat.forEach((v:number,i:number)=>expect(v).toBeCloseTo(ferry.q[i],9));
  expect(byId.crate.motion).toBeUndefined();
  expect(byId.crate.mount).toEqual({to:"ferry",offset:[1,.5,0],yaw:.2,scale:1});
  // parent ∘ (offset × parent scale, then yaw)
  const {qApply}=await import("../client/lib/motioneval.js");
  const d=qApply(ferry.q,[2,1,0]);
  [0,1,2].forEach(i=>expect(byId.crate.p[i]).toBeCloseTo(ferry.p[i]+d[i],9));
});

test("terrain says whether it was authored, so renderers can honor environment.floor",()=>{
  expect(projectEnvironment(emptyState()).terrain.authored).toBe(false);
  const st:any=emptyState();st.terrain={size:300,amplitude:4};
  expect(projectEnvironment(st).terrain.authored).toBe(true);
});
test("presentation components, part motions, part sockets and light flags reach native renderers",()=>{
  const f=fixture();
  f.write("spawn",{id:"swing",lib:"swing.glb",pos:[0,0,0]});
  f.write("comp",{id:"swing",type:"motion:seat",data:{type:"pendulum",axis:[1,0,0],amp:0.4,period:3}});
  f.write("comp",{id:"swing",type:"sockets",data:{seat:{pos:[0,0.5,0],part:"seat"}}});
  f.write("comp",{id:"swing",type:"particles",data:{preset:"fire",count:5000}});
  f.write("comp",{id:"swing",type:"sound",data:{src:"eidoverse/assets/audio/creak.ogg",volume:2}});
  f.write("comp",{id:"swing",type:"picture",data:{src:"eidoverse/assets/images/a.png",part:"board"}});
  f.write("spawn",{id:"kid",lib:"c.glb"});f.write("mount",{id:"kid",to:"swing",slot:"seat"});
  f.write("light",{id:"lamp",pos:[1,2,3],keep:true,day:false});
  const r=f.request(1000);
  const swing=r.upserts.find((u:any)=>u.id==="swing");
  expect(swing.data.particles.preset).toBe("fire");expect(swing.data.particles.count).toBe(600);
  expect(typeof swing.data.particles.seed).toBe("number");
  expect(swing.data.sound.volume).toBe(1);expect(swing.data.picture.part).toBe("board");
  expect(swing.data.parts.seat.type).toBe("pendulum");
  const st=r.transforms.find((t:any)=>t.id==="swing");expect(st.parts.seat.type).toBe("pendulum");expect(Number.isFinite(st.parts.seat.t0)).toBe(true);
  const kid=r.transforms.find((t:any)=>t.id==="kid");expect(kid.mount.part).toBe("seat");expect(kid.p[1]).toBeCloseTo(0.5);
  const lamp=r.upserts.find((u:any)=>u.id==="lamp");expect(lamp.keep).toBe(true);expect(lamp.day).toBe(false);
  expect(r.warnings.filter((w:string)=>w.includes("unsupported"))).toEqual([]);
});
test("inspector attribution: placer, last actor, lock and guard reach native renderers",()=>{
  const f=fixture();
  f.write("spawn",{id:"lamp1",lib:"l.glb",pos:[0,0,0],placer:{id:"ada",sub:"discord:1"}});
  f.write("comp",{id:"lamp1",type:"guard",data:true});
  f.write("comp",{id:"lamp1",type:"lock",data:true});
  const u=f.request(1000).upserts.find((x:any)=>x.id==="lamp1");
  expect(u.interact.placer).toBe("ada");expect(u.interact.placerSub).toBe("discord:1");
  expect(u.interact.guarded).toBe(true);expect(u.interact.locked).toBe(true);expect(u.interact.lastActor).toBe("builder");
});

// ---- review #248 ----
test("a light's keep/day edit re-projects (the reuse key covers every projected field)",()=>{
  const f=fixture();f.write("light",{id:"lamp",pos:[1,2,3],keep:true,day:false});
  expect(f.request(1000).upserts.find((e:any)=>e.id==="lamp")).toMatchObject({keep:true,day:false});
  f.write("light",{id:"lamp",pos:[1,2,3],keep:false,day:true});
  expect(f.request(1300).upserts.find((e:any)=>e.id==="lamp")).toMatchObject({keep:false,day:true});
});
test("cargo rides a leased carrier where the lease puts it, pitch included",()=>{
  const f=fixture();f.write("spawn",{id:"boat",lib:"b.glb",pos:[0,0,0]});f.write("spawn",{id:"crate",lib:"c.glb"});
  f.write("mount",{id:"crate",to:"boat",offset:[0,1,0]});f.request(1000);
  f.world.leases=new Map([["boat",{lastState:{p:[10,0,0],yaw:0}}]]);
  const crate=(r:any)=>r.transforms.find((t:any)=>t.id==="crate").p.map((v:number)=>Math.round(v*1e6)/1e6);
  expect(crate(f.request(1300))).toEqual([10,1,0]);
  const h=Math.PI/4;f.world.leases.set("boat",{lastState:{p:[10,0,0],q:[Math.sin(h),0,0,Math.cos(h)]}});   // pitched 90° about x
  expect(crate(f.request(1600))).toEqual([10,0,1]);
  f.world.leases.clear();expect(crate(f.request(1900))).toEqual([0,1,0]);
});
test("a rider on a part socket inherits the carrier's scale, like any mount",()=>{
  const f=fixture();f.write("spawn",{id:"swing",lib:"s.glb",pos:[0,0,0],scale:2});f.write("spawn",{id:"doll",lib:"d.glb"});
  f.write("comp",{id:"swing",type:"sockets",data:{seat:{pos:[0,0.5,0],part:"seat"}}});
  f.write("mount",{id:"doll",to:"swing",slot:"seat"});
  expect(f.request(1000).transforms.find((t:any)=>t.id==="doll").scale).toBe(2);
});
test("authored flora placements reach native renderers as the exact plants the browser draws",()=>{
  const placements=[[1,2,1],[3,4,.5],[-2,5]];
  const out=projectFlora({species:"grass",seed:9,placements},()=>0.25);
  expect(out.warnings).toEqual([]);
  const got=out.strokes[0].placements;expect(got).toHaveLength(3);
  resetFloraOccupancy();const want=placeExplicit({seed:9,placements,heightFn:()=>0.25},grassSpec);
  expect(got.map((p:any)=>[p.x,p.z,p.scale,p.y,p.yaw])).toEqual(want.map((p:any)=>[p.x,p.z,p.scale,p.y,p.yaw]));
  expect(got.map((p:any)=>[p.x,p.z])).toEqual([[1,2],[3,4],[-2,5]]);
});
test("a sliver field with a huge density is refused by its real loop count, fast (no server freeze)",()=>{
  const t0=performance.now();
  for(const raw of [{species:"grass",width:500,depth:1e-20,density:1e20},{species:"corn",width:500,depth:2,density:1e20,rows:{spacing:.76,plant:.24}}]){
    const out=projectFlora(raw,()=>0);expect(out.strokes).toEqual([]);expect(out.warnings.join(" ")).toMatch(/budget/);
  }
  expect(performance.now()-t0).toBeLessThan(500);
  // an ordinary field still projects
  expect(projectFlora({species:"grass",width:20,depth:20},()=>0).strokes[0].placements.length).toBeGreaterThan(100);
});
test("a heightmap whose grid has not loaded is refused (no noise ground cached), then projects once it arrives",()=>{
  const f=fixture();const grid=`store/heightmaps/${Date.now().toString(16).padStart(16,'0').slice(-16)}.json`;
  f.write("terrain",{seed:3,size:40,heightmap:{grid,min:-10,max:10}});
  const a=f.request(1000);expect(a.error).toBe("terrain_pending");expect(a.moving).toBe(true);expect(a.detail).toContain(grid);
  registerGrid(grid,decodeGrid(encodeGrid({w:2,h:2,data:new Uint16Array([65535,65535,65535,65535])})));
  const b=f.request(1300);expect(b.error).toBeUndefined();
  // the shaped ground with the grid in it — and not what the same seed's noise fallback gives
  const t={seed:3,size:40,heightmap:{grid,min:-10,max:10}},n=b.environment.terrain.segments;
  const law=makeHeightField(terrainParams(t)),noise=makeHeightField(terrainParams({seed:3,size:40}));   // terrainParams carries the shape
  const h=b.environment.terrain.heights,at=(i:number)=>[((i%(n+1))/n-.5)*40,(Math.floor(i/(n+1))/n-.5)*40];
  for(const i of [0,n,(n+1)*(n+1)>>1,(n+1)*(n+1)-1]){const [x,z]=at(i);expect(h[i]).toBeCloseTo(law(x,z),6);}
  expect(h.some((v:number,i:number)=>{const [x,z]=at(i);return Math.abs(v-noise(x,z))>.5;})).toBe(true);
  // a malformed grid ref is ignored by the height law, so it must not hold the scene pending forever
  const g=fixture();g.write("terrain",{seed:3,size:40,heightmap:{grid:"not/a/grid",min:-10,max:10}});
  expect(g.request(1000).error).toBeUndefined();
});
test("a chain riding a part socket (bag on a seat on a swing) gets poses and mount relations all the way down",()=>{
  const f=fixture();f.write("spawn",{id:"swing",lib:"s.glb",pos:[0,0,0],scale:2});f.write("spawn",{id:"seat",lib:"c.glb"});f.write("spawn",{id:"bag",lib:"b.glb"});
  f.write("comp",{id:"swing",type:"sockets",data:{ride:{pos:[0,1,0],part:"arm"}}});
  f.write("mount",{id:"seat",to:"swing",slot:"ride"});f.write("mount",{id:"bag",to:"seat",offset:[0,.5,0]});
  const r=f.request(1000),get=(id:string)=>r.transforms.find((t:any)=>t.id===id);
  expect(get("seat")).toMatchObject({p:[0,2,0],scale:2,mount:{to:"swing",part:"arm"}});
  const bag=get("bag");expect(bag).toBeDefined();expect(bag.mount).toMatchObject({to:"seat"});
  expect(bag.p.map((v:number)=>Math.round(v*1e6)/1e6)).toEqual([0,3,0]);expect(bag.scale).toBe(2);   // offset .5 scaled by the carrier's 2
  expect(r.warnings.filter((x:string)=>x.startsWith("bag:")||x.startsWith("seat:"))).toEqual([]);
});
test("placed features shape the projected ground ONCE — the same ground the browser builds",()=>{
  const f=fixture();f.write("terrain",{seed:7,size:80,amplitude:0,features:[{type:"hill",x:0,z:0,radius:10,height:-4},{type:"hill",x:20,z:20,radius:8,height:3}],water:{level:-1}});
  const r=f.request(1000),t=r.environment.terrain,n=t.segments,at=(x:number,z:number)=>t.heights[Math.round((z/80+.5)*n)*(n+1)+Math.round((x/80+.5)*n)];
  expect(at(0,0)).toBeCloseTo(-4,6);expect(at(20,20)).toBeCloseTo(3,6);expect(at(-30,-30)).toBeCloseTo(0,6);
  const cells=r.environment.water.cells;let deepest=0;for(let i=0;i<cells.length;i+=8)deepest=Math.max(deepest,-1-t.heights[cells[i]]);
  expect(deepest).toBeCloseTo(3,1);   // a 3 m pit under the -1 m level, not 7
});
