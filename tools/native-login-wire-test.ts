// Real HTTP + WS integration. All state belongs to a fresh scratch directory.
import { strict as assert } from "node:assert";
import { generateKeyPairSync, createPublicKey, sign } from "node:crypto";
import { mkdtempSync, mkdirSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const scratch=mkdtempSync(join(tmpdir(),"ew-native-login-"));
mkdirSync(join(scratch,"opt"),{recursive:true});
const port=18997, origin=`http://127.0.0.1:${port}`;
// Refuse to touch any pre-existing listener, even if it looks like Eidoverse.
try { const probe=Bun.listen({hostname:"127.0.0.1",port,socket:{data(){}}}); probe.stop(true); }
catch { throw Error("Scratch test port is occupied; refusing to run"); }
const pair=generateKeyPairSync("ed25519"), pub=createPublicKey(pair.privateKey).export({format:"der",type:"spki"}) as Buffer;
const issuer=`ed25519:${pub.subarray(pub.length-32).toString("base64url")}`;
const server=Bun.spawn([process.execPath,"server/server.ts"],{env:{...process.env,
  HOST:"127.0.0.1",PORT:String(port),JOIN_TOKEN:"native-test-door",WORLDS_DIR:join(scratch,"worlds"),
  OPT_DIR:join(scratch,"opt"),RELAY_STATE_DIR:join(scratch,"opt"),SKIP_OPT_SWEEP:"1",RECORD_FRAMES:"0",
  HN_SESSIONS_FILE:join(scratch,"sessions.json"),AGENT_TOKENS_PATH:join(scratch,"tokens.json"),
  HN_ISSUER_KEY:issuer,HN_ISS:"id.test",HN_AUD:"eidoverse",HN_NATIVE_ORIGIN:origin,HN_REQUIRE_LOGIN:"0",
},stdout:"ignore",stderr:"pipe"});
const sockets:WebSocket[]=[];
async function wait(fn:()=>boolean,label:string){for(let i=0;i<100;i++){if(fn())return;await Bun.sleep(50);}throw Error("timeout: "+label);}
async function post(path:string,body:object,headers:Record<string,string>={}){
 return fetch(origin+path,{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body)});
}
const cookie=(r:Response)=>/^ew_sess=[a-f0-9]{64}/.exec(r.headers.get("set-cookie")??"")?.[0]??"";
async function connect(world:string,session:string){
 const messages:any[]=[];let closed=0;
 const ws=new WebSocket(origin.replace("http:","ws:")+"/ws",{headers:{cookie:session}} as any);sockets.push(ws);
 ws.onopen=()=>ws.send(JSON.stringify({type:"join",world,id:"untrusted-client-name"}));
 ws.onmessage=e=>messages.push(JSON.parse(String(e.data)));ws.onclose=e=>{closed=e.code;};
 await wait(()=>closed!==0||messages.some(m=>m.type==="snapshot"),"join result");return {ws,messages,closed};
}
try{
 let ready=false;for(let i=0;i<100;i++){
  if(server.exitCode!==null)throw Error("scratch server exited: "+await new Response(server.stderr).text());
  try{ready=(await fetch(origin+"/authcfg")).ok;}catch{}if(ready)break;await Bun.sleep(50);
 }assert.ok(ready);
 const now=Math.floor(Date.now()/1000);
 const payload={v:1,iss:"id.test",sub:"human:discord:fixture",kind:"human",name:"Native Fixture",aud:"eidoverse",scopes:["worlds:join","worlds:spectate"],iat:now,exp:now+600,jti:"native-wire-test"};
 const segment=Buffer.from(JSON.stringify(payload)).toString("base64url");
 const token=`aid1.${segment}.${sign(null,Buffer.from(`aid1.${segment}`),pair.privateKey).toString("base64url")}`;
 const auth=await post("/auth",{token});assert.equal(auth.status,200);const browser=cookie(auth);assert.ok(browser);
 const landing=await(await fetch(origin+"/auth")).text();assert.ok(landing.includes("ew-native-pair-code")&&landing.includes("/native#code="));
 const p=await(await post("/native/start",{})).json();
 assert.equal((await post("/native/poll",{device_code:p.device_code})).status,202);
 assert.ok(!existsSync(join(scratch,"worlds","water")),"pairing must not join/create a world");
 const approved=await post("/native/approve",{user_code:p.user_code},{cookie:browser,origin});
 assert.equal(approved.status,200);assert.equal(approved.headers.get("set-cookie"),null);
 await Bun.sleep(2100);
 const grant=await post("/native/poll",{device_code:p.device_code});assert.equal(grant.status,200);
 const native=cookie(grant);assert.ok(native&&native!==browser,"independent session");
 assert.equal((await post("/native/poll",{device_code:p.device_code})).status,410);
 const wrong=await connect("not-water",native);assert.equal(wrong.closed,4003);
 assert.ok(!existsSync(join(scratch,"worlds","not-water")),"restriction checked before world creation");
 const good=await connect("water",native);const snap=good.messages.find(m=>m.type==="snapshot");assert.ok(snap);
 assert.equal(snap.you,"Native Fixture");
 good.ws.close();
 assert.equal((await post("/logout",{},{cookie:native})).status,200);
 assert.equal((await fetch(origin+"/whoami",{headers:{cookie:native}})).status,401);
 assert.equal((await fetch(origin+"/whoami",{headers:{cookie:browser}})).status,200);
 assert.equal(statSync(join(scratch,"sessions.json")).mode&0o777,0o600);
 console.log("NATIVE_LOGIN_WIRE_PASS: browser auth, approval, independent session, replay refusal, verified water join, other-world rejection, logout isolation, private scratch persistence");
}finally{for(const ws of sockets)ws.close();server.kill();await server.exited;}
