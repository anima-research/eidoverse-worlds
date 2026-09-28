import {chromium} from 'playwright';
import {strict as assert} from 'node:assert';
const browser=await chromium.launch({headless:true,channel:'chrome',args:['--enable-unsafe-webgpu','--use-angle=metal']});
const page=await browser.newPage({viewport:{width:1280,height:800}});
const errors:string[]=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('401 (Unauthorized)'))errors.push(m.text().slice(0,900));});
try{
 await page.goto((process.env.WATER_PREVIEW_URL??'http://127.0.0.1:19347/?world=water-preview&spectate=1&name=water-review')+'&wgsldebug');
 for(let i=0;i<600;i++){
  const ready=await page.evaluate(async()=>{const w=await import('/lib/world.js');return w.entities.size===5&&[...w.entities.values()].every(o=>o?.userData.lib);});
  if(ready)break;if(i===599)throw Error('models did not load');await page.waitForTimeout(100);
 }
 const result=await page.evaluate(async()=>{
  const {CONFIG}=await import('/lib/base.js');CONFIG.renderer=true;
  const {camera}=await import('/lib/core.js'),{entities}=await import('/lib/world.js'),w=await import('/lib/water.js');
  camera.position.fromArray(w.environmentSettings().spawn);const target=entities.get('water-habitat').position.clone();target.y+=2;camera.lookAt(target);
  return {water:w.waterDebug(),models:entities.size};
 });
 await page.waitForTimeout(1500);
 await page.screenshot({path:process.env.WATER_SCREENSHOT??'/tmp/eido-water-preview.png'});
 assert.equal(errors.length,0,errors.join('\n'));assert.equal(result.models,5);assert.equal(result.water.air,15);
 console.log('PASS: WebGPU scene, five model groups, 15 dry volumes, no shader/page errors',result);
}finally{await browser.close();}
