// bun tools/water/import.ts MANIFEST SERVER WORLD [--apply] [--replace]
// Default is read-only preflight. Credentials come only from EIDO_TOKEN.
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {foldEntry,emptyState} from '../../shared/fold.js';
const [file,server,world]=process.argv.slice(2,5);
if(!file||!server||!world)throw Error('usage: import.ts MANIFEST SERVER WORLD [--apply] [--replace]');
const manifest=JSON.parse(readFileSync(file,'utf8')),base=new URL(server);
const apply=process.argv.includes('--apply'),replace=process.argv.includes('--replace');
const bytes=new Map();
for(const f of manifest.files){
 const data=readFileSync(resolve(dirname(file),f.file));
 if(createHash('sha256').update(data).digest('hex')!==f.sha256)throw Error(`asset hash mismatch: ${f.file}`);
 bytes.set(f.path,data);
}
for(const v of manifest.verbs){
 if(!['asset','spawn','comp','light','mount','motion'].includes(v.verb))throw Error(`unsupported import verb: ${v.verb}`);
 if(v.verb==='comp'&&Buffer.byteLength(JSON.stringify(v.args.data))>8192)throw Error(`component too large: ${v.args.id}/${v.args.type}`);
}
const geomURL=new URL('/geom',base);geomURL.searchParams.set('world',world);
const response=await fetch(geomURL);const geom=response.ok?await response.json():{entities:[]};
if(!response.ok&&response.status!==404)throw Error(`preflight failed: HTTP ${response.status}`);
const uploadedPath=new Map(manifest.files.map(f=>[f.path,`store/${f.sha256.slice(0,16)}.glb`]));
const collisions=manifest.verbs.filter(v=>v.verb==='spawn'&&geom.entities?.some(e=>e.id===v.args.id&&e.lib!==v.args.lib&&e.lib!==uploadedPath.get(v.args.lib))).map(v=>v.args.id);
console.log(JSON.stringify({world,server:base.origin,apply,files:bytes.size,verbs:manifest.verbs.length,conflicts:collisions,coordinateSystem:manifest.coordinateSystem},null,2));
if(!apply)process.exit(0);
if(collisions.length&&!replace)throw Error('existing entity ids differ; inspect the world before using --replace');
const token=process.env.EIDO_TOKEN??'',url=new URL('/ws',base);url.protocol=base.protocol==='https:'?'wss:':'ws:';
const ws=new WebSocket(url);let waiter:any=null,st:any=null;
function next(predicate:(m:any)=>boolean,send?:()=>void){
 return new Promise<any>((res,rej)=>{
  const timer=setTimeout(()=>{waiter=null;rej(Error('sequencer response timed out; inspect partial import before retrying'));},15000);
  waiter={predicate,resolve:(m:any)=>{clearTimeout(timer);waiter=null;res(m);},reject:(e:any)=>{clearTimeout(timer);waiter=null;rej(e);}};
  send?.();
 });
}
ws.onmessage=e=>{const m=JSON.parse(String(e.data));if(m.type==='error')waiter?.reject(Error(m.error??'sequencer refused import'));else if(waiter?.predicate(m))waiter.resolve(m);};
ws.onclose=()=>waiter?.reject(Error('sequencer closed the connection'));
await new Promise<void>((res,rej)=>{ws.onopen=()=>res();ws.onerror=()=>rej(Error('cannot connect'));});
try{
 const snap=await next(m=>m.type==='snapshot',()=>ws.send(JSON.stringify({type:'join',id:'water-import',world,token})));
 st={...emptyState(),...snap.state};
 const mapping=new Map();
 for(const f of manifest.files){
  const known=uploadedPath.get(f.path);
  if((await fetch(new URL('/library/'+known,base),{method:'HEAD'})).ok){mapping.set(f.path,known);continue;}
  const u=new URL('/upload',base);u.searchParams.set('token',token);u.searchParams.set('name','Unreal water scene');
  let r;
  for(let retry=0;retry<5;retry++){
    r=await fetch(u,{method:'POST',body:bytes.get(f.path),headers:{'content-type':'model/gltf-binary'}});
    if(r.status!==429)break;
    console.log('Waiting for the server upload rate window');await Bun.sleep(15000);
  }
  if(!r.ok)throw Error(`asset upload failed: HTTP ${r.status}`);
  mapping.set(f.path,(await r.json()).path);
 }
 let applied=0,skipped=0;
 for(const item of manifest.verbs){
  const v=structuredClone(item),a=v.args;
  if(a.lib)a.lib=mapping.get(a.lib)??a.lib;if(a.path)a.path=mapping.get(a.path)??a.path;
  const entity=st.entities[a.id];
  if(v.verb==='asset'&&st.assets.some(x=>x.path===a.path)||
    v.verb==='spawn'&&entity?.lib===a.lib||
    v.verb==='comp'&&JSON.stringify(entity?.comp?.[a.type])===JSON.stringify(a.data)){skipped++;continue;}
  if(v.verb==='spawn'&&entity&&!replace)throw Error(`refusing to overwrite existing entity ${a.id}`);
  const m=await next(m=>m.type==='log'&&m.entry?.verb===v.verb&&JSON.stringify(m.entry.args)===JSON.stringify(a),
   ()=>ws.send(JSON.stringify({type:'verb',...v})));
  foldEntry(st,m.entry);applied++;
  // Stay below the ordinary verb-rate budget, including first-world imports.
  await Bun.sleep(400);
 }
 console.log(JSON.stringify({applied,skipped,world}));
}finally{ws.close();}
