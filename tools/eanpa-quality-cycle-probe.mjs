// One-browser ownership receipt across Performance ↔ live ↔ retained baked.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
const { check, done } = checker();
const world = await ownedWorld({ env: { EIDOVERSE_DIR:process.env.EIDOVERSE_DIR, SKIP_OPT_SWEEP:'1' } });
const { page, close } = await launchBrowser();
const errors=[];
try {
  const pg=await page(); pg.on('pageerror',(e)=>errors.push(e.message));
  await pg.goto(`${world.origin}/?world=staging&name=eanpa-cycle&key=${world.key}`, {waitUntil:'domcontentloaded',timeout:60_000});
  await pg.waitForFunction(()=>document.getElementById('splash')?.classList.contains('gone'),null,{timeout:90_000});
  const set = (quality, first=false) => pg.evaluate(async ({quality,first}) => {
    const sky=await import('/lib/sky.js');
    if(first) await sky.previewSky({system:'eidoverse',world:'earth',hours:12,weather:'clear',clouds:'cumulus',quality});
    else await sky.setCloudQuality(quality);
    const names=[]; globalThis.EW.scene.traverse((o)=>{if(o.name)names.push(o.name)});
    return {quality,debug:sky.eanpaDebug(),backgroundProxy:names.filter((x)=>x==='current_frame_background_proxy').length,
      cloudProxy:names.filter((x)=>x==='current_frame_cloud_proxy').length};
  }, {quality,first});
  const medium1=await set('medium',true);
  const high=await set('high');
  const low=await set('low');
  const medium2=await set('medium');
  check('medium starts one cached display', medium1.debug.displayMode==='banded-world-direction-cloud-panorama' && medium1.backgroundProxy===1 && medium1.cloudProxy===1, JSON.stringify(medium1));
  check('switching to high releases cached proxies', high.debug.displayMode==='live-volume' && high.backgroundProxy===0 && high.cloudProxy===0 && high.debug.captureStats===null, JSON.stringify(high));
  check("low uses the current engine's cheapest live volume", low.debug.displayMode==='live-volume' && low.backgroundProxy===0 && low.cloudProxy===0, JSON.stringify(low));
  check('returning to medium owns exactly one fresh display', medium2.debug.displayMode==='banded-world-direction-cloud-panorama' && medium2.backgroundProxy===1 && medium2.cloudProxy===1 && medium2.debug.captureStats?.captures>=1, JSON.stringify(medium2));
  check('all four builds use the frozen standalone source', [medium1,high,low,medium2].every((x)=>x.debug.activeSource?.startsWith('a197d3dc4257')), JSON.stringify([medium1,high,low,medium2]));
  check('no page errors across quality ownership cycle', errors.length===0, errors.join(' | '));
} finally { await close(); await world.close(); }
done();
