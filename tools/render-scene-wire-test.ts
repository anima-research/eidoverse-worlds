// Isolated server + two independent worlds; --native keeps the fixture running.
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir=mkdtempSync(join(tmpdir(),"ew-scene-")), port=Number(process.env.EIDO_SCENE_TEST_PORT??19002), origin=`http://127.0.0.1:${port}`;
mkdirSync(join(dir,"relay"));
mkdirSync(join(dir,"library"));mkdirSync(join(dir,"opt"));
writeFileSync(join(dir,"library","test.glb"),"original-test-bytes");
writeFileSync(join(dir,"opt","test.glb"),"optimized-test-bytes");
const probe=Bun.listen({hostname:"127.0.0.1",port,socket:{data(){}}});probe.stop(true);
const nonce=crypto.randomUUID();
const child=Bun.spawn([process.execPath,"server/server.ts"],{env:{...process.env,HOST:"127.0.0.1",PORT:String(port),
 WORLDS_DIR:join(dir,"worlds"),OPT_DIR:join(dir,"opt"),RELAY_STATE_DIR:join(dir,"relay"),HN_SESSIONS_FILE:join(dir,"sessions.json"),
 AGENT_TOKENS_PATH:join(dir,"tokens.json"),EIDOVERSE_DIR:join(dir,"library"),JOIN_TOKEN:"scene-test-door",HN_REQUIRE_LOGIN:"0",HN_ISSUER_KEY:"",SKIP_OPT_SWEEP:"1",RECORD_FRAMES:"0",BENCH_NONCE:nonce},stdout:"ignore",stderr:"pipe"});
const sockets:WebSocket[]=[];
async function wait(f:()=>boolean,label:string){for(let i=0;i<200;i++){if(f())return;await Bun.sleep(30);}throw Error(label);}
async function connect(world:string,id:string){const messages:any[]=[];const ws=new WebSocket(origin.replace("http:","ws:")+"/ws");sockets.push(ws);
 ws.onopen=()=>ws.send(JSON.stringify({type:"join",world,id,token:"scene-test-door"}));ws.onmessage=e=>messages.push(JSON.parse(String(e.data)));
 await wait(()=>messages.some(m=>m.type==="snapshot"),"join");return {messages,send:(v:any)=>ws.send(JSON.stringify(v)),ws};}
try{
 let ready=false;for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error(await new Response(child.stderr).text());try{ready=(await(await fetch(origin+"/health")).json()).nonce===nonce;}catch{}if(ready)break;await Bun.sleep(30);}assert.ok(ready);
 const a=await connect("scene-test","fixture"),b=await connect("other-scene","other");
 assert.equal(await(await fetch(origin+"/library/test.glb")).text(),"optimized-test-bytes");
 assert.equal(await(await fetch(origin+"/library/test.glb?native=1")).text(),"original-test-bytes");
 assert.equal(a.messages.find(m=>m.type==="snapshot").renderSceneVersion,1);
 const verb=(v:string,args:any)=>a.send({type:"verb",verb:v,args});
 verb("terrain",{size:120,amplitude:3,flatRadius:18,flatHeight:0,seed:5});
 const tiles=[];for(let x=0;x<6;x++)for(let z=0;z<5;z++)tiles.push([x,z]);
 const walls=[];for(let x=0;x<6;x++){walls.push([0,x,0],[0,x,5]);}for(let z=0;z<5;z++)walls.push([1,0,z],[1,6,z]);
 verb("spawn",{id:"house",lib:"missing.glb",pos:[-3,0,7]});
 verb("comp",{id:"house",type:"structure",data:{levels:[{y:0,tiles,walls,apertures:[[0,2,0,"door"],[0,4,0,"window"],[1,6,2,"window"]]}]}});
 verb("light",{id:"lamp",pos:[0,2,9],color:0xffb474,intensity:40,range:8});
 await wait(()=>a.messages.some(m=>m.type==="log"&&m.entry.verb==="light"),"fixture authored");
 a.send({type:"render-scene",version:1});b.send({type:"render-scene",version:1});
 await wait(()=>a.messages.some(m=>m.type==="render-scene")&&b.messages.some(m=>m.type==="render-scene"),"projection");
 const p=a.messages.find(m=>m.type==="render-scene");assert.equal(p.world,"scene-test");assert.equal(p.upserts.length,2);assert.ok(p.upserts.find((e:any)=>e.id==="house").structure.sweeps.length);
 assert.equal(b.messages.find(m=>m.type==="render-scene").upserts.length,0);
 const before=readFileSync(join(dir,"worlds","scene-test","log.jsonl"),"utf8");
 await Bun.sleep(320);a.send({type:"render-scene",version:1});await wait(()=>a.messages.filter(m=>m.type==="render-scene").length===2,"delta");
 assert.equal(a.messages.filter(m=>m.type==="render-scene")[1].upserts.length,0);
 assert.equal(readFileSync(join(dir,"worlds","scene-test","log.jsonl"),"utf8"),before);
 console.log("RENDER_SCENE_WIRE_PASS: canonical scene, world isolation, geometry deltas, no scene-request log writes");
 if(process.argv.includes("--native")){console.log("RENDER_SCENE_NATIVE_READY "+dir);await new Promise<void>(resolve=>{process.on("SIGTERM",resolve);process.on("SIGINT",resolve);});}
}finally{for(const s of sockets)s.close();child.kill();await child.exited;}
