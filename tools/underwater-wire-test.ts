// Real WS relay/late-join/authority regression on an isolated throwaway sequencer.
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scratch=mkdtempSync(join(tmpdir(),'eido-underwater-'));
const port=Number(process.env.UNDERWATER_TEST_PORT??18993);
const server=Bun.spawn([process.execPath,'server/server.ts'],{env:{...process.env,
  HOST:'127.0.0.1',PORT:String(port),JOIN_TOKEN:'underwater-test-door',WORLDS_DIR:join(scratch,'worlds'),
  OPT_DIR:join(scratch,'opt'),RELAY_STATE_DIR:join(scratch,'opt'),SKIP_OPT_SWEEP:'1',RECORD_FRAMES:'0'},stdout:'ignore',stderr:'pipe'});
const sockets:WebSocket[]=[];
const sleep=(n:number)=>new Promise(r=>setTimeout(r,n));
async function wait(fn:()=>boolean,label:string){for(let i=0;i<100;i++){if(fn())return;await sleep(50);}throw Error('timeout: '+label);}
async function client(id:string,spectate=false){
 const messages:any[]=[];const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`);sockets.push(ws);
 ws.onopen=()=>ws.send(JSON.stringify({type:'join',world:'underwater-test',id,spectate,token:'underwater-test-door'}));
 ws.onmessage=e=>messages.push(JSON.parse(String(e.data)));
 await wait(()=>messages.some(m=>m.type==='snapshot'),id+' join');return {ws,messages};
}
try{
 let ready=false;for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('server exited: '+await new Response(server.stderr).text());try{ready=(await fetch(`http://127.0.0.1:${port}/version`)).ok;}catch{}if(ready)break;await sleep(50);}assert.ok(ready,'scratch server ready');
 const a=await client('diver'),b=await client('observer',true);
 const pose={p:[12,-30,8],yaw:.2,speed:1.4,clip:'walk',q:[0,0,0,1],locomotion:{mode:'swim',body:'diver',medium:'water'}};
 a.ws.send(JSON.stringify({type:'pose',pose}));
 await wait(()=>b.messages.some(m=>m.type==='frame'&&m.poses?.diver),'3D frame');
 assert.deepEqual(b.messages.find(m=>m.type==='frame'&&m.poses?.diver).poses.diver,pose);
 const c=await client('late',true);assert.deepEqual(c.messages.find(m=>m.type==='snapshot').present.find((p:any)=>p.id==='diver').pose,pose);
 const marker=b.messages.length;
 a.ws.send(JSON.stringify({type:'pose',pose:{...pose,q:[0,0,0,0]}}));
 b.ws.send(JSON.stringify({type:'pose',pose}));await sleep(200);
 assert.ok(!b.messages.slice(marker).some(m=>m.type==='frame'&&(m.poses?.observer||m.poses?.diver?.q?.[3]===0)));
 a.ws.send(JSON.stringify({type:'verb',verb:'say',args:{text:'underwater wire check'}}));
 await wait(()=>b.messages.some(m=>m.type==='log'&&m.entry.verb==='say'),'public chat');
 a.ws.close();await wait(()=>b.messages.some(m=>m.type==='leave'&&m.id==='diver'),'departure');
 const log=readFileSync(join(scratch,'worlds','underwater-test','log.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.ok(log.some(e=>e.verb==='say'));assert.ok(!log.some(e=>['pose','place','comp'].includes(e.verb)),'movement never authored');
 console.log('UNDERWATER_WIRE_PASS: 3D pose, orientation, metadata, late join, invalid sample, spectator, chat, leave, no movement log writes');
}finally{for(const ws of sockets)ws.close();server.kill();await server.exited;}
