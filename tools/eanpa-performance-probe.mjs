// Matched local performance receipt. Run from exact base and candidate worktrees
// with the same EIDOVERSE_DIR/browser/viewport; label the result with PERF_LABEL.
import { launchBrowser, ownedWorld } from './probe-harness.mjs';
const label=process.env.PERF_LABEL??'unknown';
const world=await ownedWorld({env:{EIDOVERSE_DIR:process.env.EIDOVERSE_DIR,SKIP_OPT_SWEEP:'1'}});
const {page,close}=await launchBrowser();
try{
 const pg=await page();const errors=[];pg.on('pageerror',(e)=>errors.push(e.message));
 await pg.addInitScript(()=>localStorage.setItem('ew-cloud-quality','medium'));
 const t0=Date.now();
 await pg.goto(`${world.origin}/?world=staging&name=eanpa-perf&key=${world.key}`,{waitUntil:'domcontentloaded',timeout:60_000});
 await pg.waitForFunction(()=>document.getElementById('splash')?.classList.contains('gone'),null,{timeout:90_000});
 await pg.evaluate(()=>import('/lib/sky.js').then((sky)=>sky.previewSky({system:'eidoverse',world:'earth',hours:12,weather:'clear',clouds:'cumulus',quality:'medium'})));
 const skyReadyMs=Date.now()-t0;
 await new Promise((r)=>setTimeout(r,12_000));
 const result=await pg.evaluate(async({label,skyReadyMs})=>{
   const sky=await import('/lib/sky.js');const renderer=globalThis.EW.renderer;
   const samples=await new Promise((resolve)=>{const a=[];let last=performance.now();const step=(now)=>{a.push(now-last);last=now;if(a.length>=600)resolve(a);else requestAnimationFrame(step)};requestAnimationFrame((n)=>{last=n;requestAnimationFrame(step)})});
   const sorted=[...samples].sort((a,b)=>a-b);const q=(p)=>sorted[Math.min(sorted.length-1,Math.floor(p*(sorted.length-1)))];
   const resources=performance.getEntriesByType('resource');
   return {label,skyReadyMs,backend:renderer.backend?.isWebGLBackend?'webgl':'webgpu',mode:sky.eanpaDebug?.().displayMode??'legacy',
     capture:sky.eanpaDebug?.().captureStats??null,frames:samples.length,meanMs:samples.reduce((a,b)=>a+b,0)/samples.length,p50Ms:q(.5),p95Ms:q(.95),p99Ms:q(.99),maxMs:sorted.at(-1),
     estimatedFps:1000/(samples.reduce((a,b)=>a+b,0)/samples.length),rendererInfo:renderer.info??null,
     transferBytes:resources.reduce((n,r)=>n+(r.transferSize||0),0),resourceCount:resources.length,userAgent:navigator.userAgent};
 },{label,skyReadyMs});
 result.pageErrors=errors;console.log(JSON.stringify(result,null,2));if(errors.length)process.exitCode=1;
}finally{await close();await world.close()}
