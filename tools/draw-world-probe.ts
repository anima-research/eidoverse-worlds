// bun tools/draw-world-probe.ts — real asset loader + warm conductor + world
// lifecycle on an OWNED scratch sequencer. Requires the usual asset library.
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { PNG } from 'pngjs';
import { ownedWorld } from './probe-harness.mjs';
import { qFromYaw } from '../shared/rot.js';

// founded and owned by the driver's id (TRUST_NAMES), so its creates are admitted (#260 house I419)
const world = await ownedWorld({ worlds: ['draw-probe'], owner: 'draw-driver', env: { VERB_RATE: '100', TRUST_NAMES: '1' } });
let browser, ws;
const errors = [];
try {
  ws = new WebSocket(world.origin.replace('http:', 'ws:')+'/ws');
  await new Promise((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ type:'join', id:'draw-driver', world:'draw-probe', token:world.key, replica:true }));
    ws.onmessage = (e) => { const m=JSON.parse(e.data); if(m.type==='snapshot') resolve(m); if(m.type==='error') reject(Error(m.error)); };
    ws.onerror = reject;
  });
  // the request/reply path (#260 house I420): {type:'request', id, verb, args} → {type:'reply', id, reply}
  let reqSeq = 0;
  const request = (verb, args) => new Promise((resolve, reject) => {
    const rid = ++reqSeq;
    const timeout = setTimeout(() => { ws.removeEventListener('message', on); reject(Error(`request timeout: ${verb}`)); }, 10_000);
    const on = (e) => {
      const m=JSON.parse(e.data);
      if(m.type!=='reply' || m.id!==rid) return;
      clearTimeout(timeout); ws.removeEventListener('message',on);
      if(m.reply?.ok) resolve(m.reply); else reject(Error(`${verb} refused: ${JSON.stringify(m.reply?.refused ?? m.reply)}`));
    };
    ws.addEventListener('message',on);
    ws.send(JSON.stringify({type:'request',id:rid,verb,args}));
  });
  // the authority mints ids: each crate is created under a placeholder and known by the id its reply names
  const crate = [];
  for(let i=0;i<32;i++) {
    const r = await request('create',{id:`$crate-${i}`, model:'eidoverse/assets/models/crate_large_blue.glb',
      components:{transform:{pos:[1+(i%8)*3,0,1+Math.floor(i/8)*3],q:qFromYaw((i%3)*0.25),scale:[1,1,1]}}});
    crate[i] = r.ids?.[`$crate-${i}`];
    if(!crate[i]) throw Error(`create named no id: ${JSON.stringify(r)}`);
  }
  const chrome = process.env.SFU_TEST_CHROME
    ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  browser = await chromium.launch({executablePath:chrome,args:['--enable-unsafe-webgpu']});
  const page = await browser.newPage({viewport:{width:800,height:600}});
  page.on('pageerror', e => { errors.push(String(e)); console.error(String(e)); });
  await page.goto(`${world.origin}/?name=draw-camera&world=draw-probe&key=${world.key}&renderer`);
  await page.waitForFunction(() => window.EW?.entities?.size===32
    && [...EW.entities.values()].every(o=>o&&!o.userData.placeholder),null,{timeout:120_000});
  await page.evaluate(() => {
    EW.camera.position.set(26,17,28);
    EW.camera.lookAt(12,0.5,6);
  });
  await page.waitForFunction(() => EW.draws().batching.instanced>0 && !EW.warm().pending && !EW.warm().running,
    null,{timeout:120_000});
  await page.waitForFunction(() => EW.lightrig().casting >= Math.min(12,EW.lightrig().casterBudget)
    && !EW.warm().pending && !EW.warm().running, null, {timeout:120_000});
  console.log('real library clones loaded and instance color/depth pipelines warmed');
  const capture = async (on) => page.evaluate(async (enabled) => {
    const {renderWorld} = await import('/lib/render.js');
    const {setSystemEnabled,frameDebug} = await import('/lib/frameloop.js');
    for(const system of frameDebug()) setSystemEnabled(system.name,false);
    // Toggle directly without disposing warm pools for the A/B receipt.
    if(enabled) renderWorld();
    else EW.renderer.render(EW.scene,EW.camera);
    EW.renderer.info.reset();
    if(enabled) renderWorld();
    else EW.renderer.render(EW.scene,EW.camera);
    return {png:EW.renderer.domElement.toDataURL('image/png'),draws:EW.renderer.info.render.drawCalls,
      triangles:EW.renderer.info.render.triangles,stats:EW.draws().batching,
      diagnostics:EW.draws({sources:true}),parity:EW.foldParity()};
  },on);
  const before = await capture(false), after = await capture(true);
  const b=PNG.sync.read(Buffer.from(before.png.split(',')[1],'base64'));
  const a=PNG.sync.read(Buffer.from(after.png.split(',')[1],'base64'));
  await Bun.write('/tmp/ew-draw-world-before.png', PNG.sync.write(b));
  await Bun.write('/tmp/ew-draw-world-after.png', PNG.sync.write(a));
  let sum=0,over2=0,changed=0;
  for(let i=0;i<a.data.length;i+=4) {
    let max=0;
    for(let c=0;c<3;c++) {const d=Math.abs(a.data[i+c]-b.data[i+c]);sum+=d;max=Math.max(max,d);}
    if(max)changed++; if(max>2)over2++;
  }
  const result={drawsBefore:before.draws,drawsAfter:after.draws,trianglesBefore:before.triangles,
    trianglesAfter:after.triangles,changedPixels:changed,over2Fraction:over2/(a.width*a.height),
    meanChannelError:sum/(a.width*a.height*3),batching:after.stats,foldParity:after.parity.ok};
  console.log(JSON.stringify(result,null,2));
  if(after.diagnostics.render.drawCalls!==after.draws
    || !after.diagnostics.sources.libraries.some((row)=>row.model.endsWith('crate_large_blue.glb')&&row.materialGroups===32)) {
    throw Error('draw diagnostics did not describe the rendered view');
  }
  if(after.draws>=before.draws*0.75 || result.over2Fraction>0.001 || result.meanChannelError>0.05
    || !after.parity.ok) throw Error('real-world draw/pixel/fold check failed');
  // Fold-driven transform, mount, remove and replay still address ORIGINALS.
  await request('set',{id:crate[0],component:'transform',value:{pos:[4,1,4],q:qFromYaw(1.2),scale:[1,1,1]}});
  await request('batch',{ops:[{verb:'set',args:{id:crate[1],component:'parent',value:{to:crate[0]}}},
    {verb:'set',args:{id:crate[1],component:'transform',value:{pos:[0,1,0],q:[0,0,0,1],scale:[1,1,1]}}}]});
  await request('delete',{id:crate[2]});
  await page.waitForFunction(([c0,c1,c2]) => !EW.entities.has(c2) && EW.entities.get(c1)?.userData.mountedTo===c0, [crate[0],crate[1],crate[2]]);
  const lifecycle=await page.evaluate(async()=>{
    const {renderWorld,setDrawBatching}=await import('/lib/render.js');
    renderWorld();
    const first=EW.foldParity();
    EW.reconcileModels(); renderWorld();
    const reconciled=EW.foldParity();
    setDrawBatching(false); renderWorld();
    const disabled=EW.foldParity();
    return {first:first.ok,reconciled:reconciled.ok,disabled:disabled.ok,pools:EW.draws().batching.pools};
  });
  console.log('lifecycle',JSON.stringify(lifecycle));
  if(!lifecycle.first||!lifecycle.reconciled||!lifecycle.disabled||lifecycle.pools!==0) throw Error('lifecycle check failed');
  if(errors.length)throw Error(errors.join('\n'));
  console.log('draw world probe passed');
} finally {
  ws?.close();
  await browser?.close();
  await world.close();
}
