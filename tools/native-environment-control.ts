// Scratch-only owner, for live native weather/field QA.
const health=await(await fetch('http://127.0.0.1:19002/health')).json();
if(!health.nonce)throw Error('Not the isolated fixture');
const mode=process.argv[2]??'rain';
const ws=new WebSocket('ws://127.0.0.1:19002/ws');
await new Promise<void>((resolve,reject)=>{
 const timeout=setTimeout(()=>{ws.close();reject(Error('No author echo'));},5000);
 ws.onopen=()=>ws.send(JSON.stringify({type:'join',world:'scene-test',id:'fixture',token:'scene-test-door'}));
 ws.onmessage=e=>{const m=JSON.parse(String(e.data));
  if(m.type==='snapshot'){
   const verb=(verb:string,args:any)=>ws.send(JSON.stringify({type:'verb',verb,args}));
   if(mode==='rain')verb('grass',{species:'grass',width:18,depth:18,center:[0,0],density:.35,seed:37,height:.28});
   if(mode==='clear')verb('grass',{clear:true});
   verb('sky',{hours:mode==='night'?0:14,weather:mode==='rain'?'rain':'clear',weatherK:.5});
  }
  if(m.type==='log'&&m.entry.verb==='sky'){console.log('ENVIRONMENT_CONTROL_PASS',mode);clearTimeout(timeout);ws.close();resolve();}
 };
});
