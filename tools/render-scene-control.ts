// One-shot test author, pinned to the isolated native fixture's port/world.
const ws=new WebSocket("ws://127.0.0.1:19002/ws");
const action=process.argv[2]??"models";
let timer:ReturnType<typeof setTimeout>;
await new Promise<void>((resolve,reject)=>{
 timer=setTimeout(()=>{ws.close();reject(Error("fixture timeout"));},7000);
 ws.onopen=()=>ws.send(JSON.stringify({type:"join",world:"scene-test",id:"test-author",token:"scene-test-door"}));
 const verb=(verb:string,args:any)=>ws.send(JSON.stringify({type:"verb",verb,args}));
 ws.onmessage=e=>{
  const m=JSON.parse(String(e.data));
  if(m.type==="snapshot"){
   if(action==="models"){
    verb("spawn",{id:"crate",lib:"store/crate.glb",pos:[-2,0,4],scale:1});
    verb("spawn",{id:"moving-crate",lib:"store/crate.glb",pos:[2,0,4],scale:.7});
    verb("motion",{id:"moving-crate",type:"bob",amp:.25,period:4,t0:Date.now()});
   }else if(action==="edit")verb("place",{id:"crate",pos:[-4,0,4],yaw:.6});
   else if(action==="remove")verb("remove",{id:"crate"});
  }
  if(m.type==="log"&&((action==="models"&&m.entry.verb==="motion")||(action==="edit"&&m.entry.verb==="place")||(action==="remove"&&m.entry.verb==="remove"))){console.log("SCENE_CONTROL_OK",action);clearTimeout(timer);ws.close();resolve();}
 };
});
