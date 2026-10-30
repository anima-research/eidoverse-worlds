// bun tools/water/preview.ts BUNDLE_DIR [PORT] — isolated loopback server: founds a scratch world and sends the manifest's
// `requests` (prepare.ts writes them) as its owner, the way import.ts --apply does (the GLBs pre-copied to OPT_DIR).
import {mkdtempSync,mkdirSync,readFileSync,copyFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
const bundle=resolve(process.argv[2]??'');
const port=process.argv[3]??'19347';
const manifest=JSON.parse(readFileSync(join(bundle,'manifest.json'),'utf8'));
if(!Array.isArray(manifest.requests)||!manifest.requests.length)throw Error('manifest has no requests: write it with prepare.ts');
const engine=resolve(import.meta.dir,'../..'),scratch=mkdtempSync(join(tmpdir(),'eido-water-preview-'));
mkdirSync(join(scratch,'worlds'),{recursive:true});
mkdirSync(join(scratch,'opt'),{recursive:true});
for(const f of manifest.files){const dest=join(scratch,'opt',f.path);mkdirSync(dirname(dest),{recursive:true});copyFileSync(join(bundle,f.file),dest);}
const env={...process.env,HOST:'127.0.0.1',PORT:port,WORLDS_DIR:join(scratch,'worlds'),OPT_DIR:join(scratch,'opt'),RELAY_STATE_DIR:join(scratch,'opt'),
 SESSIONS_PATH:join(scratch,'sessions.json'),SKIP_OPT_SWEEP:'1',OPT_MEM_BUDGET_MB:'64',JOIN_TOKEN:'',SERVER_OPERATORS:'',TRUST_NAMES:'1',RECORD_FRAMES:'0'};
const found=Bun.spawnSync([process.execPath,'tools/protocol/world.ts','found','water-preview','--owner','water-author'],{cwd:engine,env});
if(found.exitCode!==0)throw Error(`found failed: ${found.stderr.toString().slice(-400)}`);
const server=Bun.spawn([process.execPath,'server/server.ts'],{cwd:engine,env,stdout:'inherit',stderr:'inherit'});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>server.kill(signal));
let up=false;for(let i=0;i<100&&!up;i++){await Bun.sleep(150);try{up=(await fetch(`http://127.0.0.1:${port}/version`,{signal:AbortSignal.timeout(800)})).ok;}catch{}}
if(!up){server.kill();throw Error('the preview server did not come up');}
const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`);
const reply:any=await new Promise((res,rej)=>{
 const timer=setTimeout(()=>rej(Error('no reply in 30 s')),30000);
 ws.onopen=()=>ws.send(JSON.stringify({type:'join',world:'water-preview',id:'water-author',avatar:'',replica:true}));
 ws.onerror=()=>rej(Error('cannot connect'));
 ws.onmessage=(e)=>{const m=JSON.parse(String(e.data));
  if(m.type==='error'){clearTimeout(timer);rej(Error(m.error??'refused'));}
  if(m.type==='snapshot')ws.send(JSON.stringify({type:'request',id:'water-preview',...manifest.requests[0]}));
  if(m.type==='reply'&&m.id==='water-preview'){clearTimeout(timer);res(m);}};
}).catch((e)=>{server.kill();throw e;});
ws.close();
if(!reply.ok){server.kill();throw Error(`the scene was refused: ${JSON.stringify(reply.reply?.refused??reply).slice(0,600)}`);}
console.log(`Preview: http://127.0.0.1:${port}/?world=water-preview&spectate=1&name=water-review\nScratch data: ${scratch}`);
process.exit(await server.exited);
