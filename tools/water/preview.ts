// bun tools/water/preview.ts BUNDLE_DIR [PORT] — isolated loopback sequencer.
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
const bundle=resolve(process.argv[2]??'');
const port=process.argv[3]??'19347';
const manifest=JSON.parse(readFileSync(join(bundle,'manifest.json'),'utf8'));
const scratch=mkdtempSync(join(tmpdir(),'eido-water-preview-'));
mkdirSync(join(scratch,'worlds/water-preview'),{recursive:true});
mkdirSync(join(scratch,'opt'),{recursive:true});
for(const f of manifest.files){const dest=join(scratch,'opt',f.path);mkdirSync(dirname(dest),{recursive:true});copyFileSync(join(bundle,f.file),dest);}
writeFileSync(join(scratch,'worlds/water-preview/log.jsonl'),manifest.verbs.map((v,i)=>JSON.stringify({...v,seq:i+1,ts:Date.now(),actor:'water-author'})).join('\n')+'\n');
console.log(`Preview: http://127.0.0.1:${port}/?world=water-preview&spectate=1&name=water-review\nScratch data: ${scratch}`);
const server=Bun.spawn([process.execPath,'server/server.ts'],{cwd:resolve(import.meta.dir,'../..'),env:{...process.env,
 HOST:'127.0.0.1',PORT:port,WORLDS_DIR:join(scratch,'worlds'),OPT_DIR:join(scratch,'opt'),RELAY_STATE_DIR:join(scratch,'opt'),
 SKIP_OPT_SWEEP:'1',OPT_MEM_BUDGET_MB:'64',JOIN_TOKEN:'',RECORD_FRAMES:'0'},stdout:'inherit',stderr:'inherit'});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>server.kill(signal));
process.exit(await server.exited);
