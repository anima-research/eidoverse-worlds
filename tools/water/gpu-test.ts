import {chromium} from 'playwright';
import {strict as assert} from 'node:assert';
const browser=await chromium.launch({headless:true,channel:'chrome',args:['--enable-unsafe-webgpu','--use-angle=metal']});
const page=await browser.newPage();
try{
 await page.goto(process.env.WATER_PREVIEW_URL??'http://127.0.0.1:19347/?world=water-preview&spectate=1&name=water-gpu');
 await page.waitForFunction(()=>!!globalThis.__waterDebug);
 const pixels=await page.evaluate(async()=>{
  const {THREE,scene,camera,renderer}=await import('/lib/core.js');
  const {CONFIG}=await import('/lib/base.js');CONFIG.renderer=true;
  const {state}=await import('/lib/state.js');const w=await import('/lib/water.js');
  for(const o of scene.children)o.visible=false;
  w.setWaterObjects(()=>new Map());
  const ent={pos:[0,0,0],comp:{water:{center:[0,-5,0],size:[100,10,100],absorption:[.1,.1,.1],scatter:[0,0,0]}}};
  state.st.entities={test:ent};w.updateWater();
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(10,10),new THREE.MeshBasicNodeMaterial({color:0xffffff,side:THREE.DoubleSide}));
  mesh.position.set(0,-5,10);scene.add(mesh);camera.position.set(0,-5,-10);camera.lookAt(0,-5,10);camera.updateMatrixWorld();
  const rt=new THREE.RenderTarget(32,32);rt.texture.colorSpace=THREE.LinearSRGBColorSpace;
  renderer.toneMapping=THREE.NoToneMapping;
  const result=[];
  const box={center:[0,-5,0],size:[4,4,4]};
  for(const boxes of [[],[box],[box,box],[box,{center:[0,-5,2],size:[4,4,4]}],[{center:[0,-5,0],size:[100,100,100]}]]){
    ent.comp.air={boxes};w.updateWater();renderer.setRenderTarget(rt);await renderer.compileAsync(scene,camera);
    renderer.render(scene,camera);const pixel=await renderer.readRenderTargetPixelsAsync(rt,16,16,1,1);result.push([...pixel]);renderer.setRenderTarget(null);
  }
  rt.dispose();mesh.geometry.dispose();mesh.material.dispose();
  const stateModule=await import('/lib/state.js');stateModule.reset();w.updateWater();
  if(w.waterDebug().enabled||w.waterDebug().air)throw Error('water leaked across world reset');
  return result;
 });
 console.log('GPU pixels: water, room, duplicate room, overlapping rooms, entirely dry',pixels);
 assert.ok(pixels[1][0]>pixels[0][0]);assert.ok(Math.abs(pixels[1][0]-pixels[2][0])<=1);
 assert.ok(pixels[3][0]>pixels[1][0]);assert.ok(pixels[4][0]>=250);
 console.log('PASS: compiled WebGPU optics, overlapping dry-volume union, fully dry identity');
}finally{await browser.close();}
