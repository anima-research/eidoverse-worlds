// Requires render-scene-wire-test.ts --native. No production access.
const origin='http://127.0.0.1:19002';
const health=await(await fetch(origin+'/health')).json();
if(!health.nonce)throw Error('Not the isolated fixture');
const ws=new WebSocket(origin.replace('http:','ws:')+'/ws');
let tick:ReturnType<typeof setInterval>,states=0;
const send=(x:any)=>ws.send(JSON.stringify(x));
await new Promise<void>((resolve,reject)=>{
 ws.onopen=()=>send({type:'join',world:'scene-test',id:'reach-test',avatar:'store/qa.vrm',token:'scene-test-door'});
 ws.onmessage=e=>{const m=JSON.parse(String(e.data));
  if(m.type==='snapshot'){
   const verb=(verb:string,args:any)=>send({type:'verb',verb,args});
   verb('comp',{id:'moving-crate',type:'reactions',data:{push:{impulse:.35}}});
   tick=setInterval(()=>send({type:'pose',pose:{p:[1,0,2],yaw:Math.PI,clip:'idle',reach:{rightHand:{t:{p:[.65,1.2,1.6],space:'world'}}}}}),100);
   console.log('NATIVE_INTERACTIONS_READY');
  }
  if(m.type==='lease'&&m.op==='state'&&m.by==='unreal-scene-test'){states++;if(states===1)console.log('NATIVE_PHYSICS_STREAM',m.id,m.p);}
  if(m.type==='log'&&m.entry.verb==='place'&&m.entry.args.via==='lease')console.log('NATIVE_PHYSICS_SETTLED',JSON.stringify(m.entry.args),'states='+states);
  if(m.type==='log'&&m.entry.actor==='unreal-scene-test'&&m.entry.verb==='use')console.log('NATIVE_USE_ECHO',JSON.stringify(m.entry.args));
  if(m.type==='frame'&&m.poses?.['unreal-scene-test']?.reach){const r=m.poses['unreal-scene-test'].reach;if(!(globalThis as any).seenReach){(globalThis as any).seenReach=true;console.log('NATIVE_REACH_RECEIVED',JSON.stringify(r));}}
 };
 ws.onerror=reject;
 process.on('SIGTERM',resolve);process.on('SIGINT',resolve);
});
clearInterval(tick!);ws.close();
