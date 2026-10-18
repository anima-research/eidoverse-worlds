// Native Unreal HTTP smoke fixture. NO production identity or persistence.
// bun tools/native-login-fixture.ts ; Eidoverse.TestDiscordPairing in Unreal PIE.
// POST /fixture/approve or /fixture/deny simulates the human's browser approval.
import { createNativeLogin } from "../server/native-login.ts";
const origin="http://127.0.0.1:18996";
let code="",issued=0,polls=0,starts=0,cancels=0,logouts=0;
const session={sub:"human:fixture",name:"Local Discord Fixture",scopes:["worlds:join"],exp:Date.now()+3600_000};
const native=createNativeLogin({origin,login:origin+"/native",enabled:true,
 session:c=>c==="fixture=1"?session:null,issue:()=>{issued++;return "b".repeat(64);}});
Bun.serve({hostname:"127.0.0.1",port:18996,async fetch(req){
 const path=new URL(req.url).pathname;
 if(path==="/fixture/report")return Response.json({issued,polls,starts,cancels,logouts});
 if(path==="/whoami")return Response.json(session,{headers:{"set-cookie":"fixture=1; Path=/; SameSite=Lax; HttpOnly"}});
 if(path==="/logout"){logouts++;return Response.json({ok:true});}
 if((path==="/fixture/approve"||path==="/fixture/deny")&&req.method==="POST")
  return native(new Request(origin+path.replace("fixture","native"),{method:"POST",headers:{origin,cookie:"fixture=1","content-type":"application/json"},body:JSON.stringify({user_code:code})}));
 if(path==="/native/poll")polls++;
 if(path==="/native/cancel")cancels++;
 const response=await native(req);
 if(path==="/native/start"&&response.ok){starts++;code=(await response.clone().json()).user_code;}
 return response;
}});
console.log("Native login fixture on loopback :18996; no production access.");
