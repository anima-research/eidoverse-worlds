// Prove the cold-epoch product-door gate rejects the original ordering race.
// bun tools/verb-order-mutation-test.ts
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './harness.ts';
const scratch = mkdtempSync(join(tmpdir(), 'ew-epoch-mutation-'));
try {
  const childPreload = join(scratch, 'child.ts');
  writeFileSync(childPreload, `
await import(${JSON.stringify(join(ROOT,'tools/box-read-gate.ts'))});
const {MESSAGES}=await import(${JSON.stringify(join(ROOT,'server/messages.ts'))});
const {coldLibs,warmBoxes,worldLibs}=await import(${JSON.stringify(join(ROOT,'server/boxes.ts'))});
const {runVerb}=await import(${JSON.stringify(join(ROOT,'server/verbs.ts'))});
const fixed=MESSAGES.verb;
MESSAGES.verb=(ctx,msg)=>{
  if(msg.verb!=='epoch')return fixed(ctx,msg);
  const w=ctx.c.world;if(!w)return;
  const libs=coldLibs(worldLibs(w.state));
  const run=()=>runVerb({w,c:ctx.c,now:ctx.now,expel:ctx.expel},msg.verb,msg.args);
  if(libs.length)void warmBoxes(libs).then(run,run);else run();
};
`);
  const parentPreload = join(scratch, 'parent.ts');
  const harnessPath = join(ROOT,'tools/harness.ts');
  writeFileSync(parentPreload, `
import {mock} from 'bun:test';
const real=await import(${JSON.stringify(harnessPath)});
const spawn=real.scratchSequencer;
mock.module(${JSON.stringify(harnessPath)},()=>({...real,scratchSequencer:(name,opts)=>spawn(name,{...opts,preload:${JSON.stringify(childPreload)}})}));
`);
  const p = Bun.spawn([process.execPath,'--preload',parentPreload,join(ROOT,'tools/verb-order-test.ts')], {cwd:ROOT,stdout:'pipe',stderr:'pipe'});
  const [out,err,code] = await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  const caught = code===1 && out.includes('✗') && out.includes('cold epoch and following punt both wait');
  console.log(`${caught?'PASS':'FAIL'}: restoring the epoch race makes the product-door suite red`);
  if (!caught) { console.error(out,err); process.exitCode=1; }
  const diagnostics=/failure diagnostics retained at ([^\r\n]+)/.exec(err)?.[1];
  if(diagnostics && caught) rmSync(diagnostics,{recursive:true,force:true});
} finally { rmSync(scratch,{recursive:true,force:true}); }
