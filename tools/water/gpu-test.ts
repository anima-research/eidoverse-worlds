import {chromium} from 'playwright';
import {strict as assert} from 'node:assert';
const browser=await chromium.launch({headless:true,channel:'chrome',args:['--enable-unsafe-webgpu','--use-angle=metal']});
// Both backends: the optics are portable TSL, and VR on a headset without WebGPU-XR runs on WebGL.
const base=process.env.WATER_PREVIEW_URL??'http://127.0.0.1:19347/?world=water-preview&spectate=1&name=water-gpu';
try{
for(const backend of ['webgpu','webgl']){
 const page=await browser.newPage();
 const errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto(`${base}&${backend}=1`);
 await page.waitForFunction(()=>!!globalThis.__waterDebug);
 // wait for the join snapshot: a hydrate landing mid-test replaces the state under the checks
 await page.evaluate(async()=>{const st=await import('/lib/state.js');for(let i=0;i<200&&!st.state.hydrated;i++)await new Promise(r=>setTimeout(r,50));if(!st.state.hydrated)throw Error('world never hydrated');});
 const {pixels,ran}=await page.evaluate(async()=>{
  const {THREE,scene,camera,renderer}=await import('/lib/core.js');
  await renderer.init?.();
  const {CONFIG}=await import('/lib/base.js');CONFIG.renderer=true;
  const {state}=await import('/lib/state.js');const w=await import('/lib/watervolumes.js');
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
  return {pixels:result,ran:renderer.backend?.isWebGLBackend?'webgl':'webgpu'};
 });
 console.log(`GPU pixels (${ran}): water, room, duplicate room, overlapping rooms, entirely dry`,pixels);
 assert.equal(ran,backend,`asked for ${backend}, the renderer ran ${ran}`);
 const shaderErrors=errors.filter(e=>/shader|WGSL|GLSL|compile|TSL/i.test(e));
 assert.deepEqual(shaderErrors,[],`${backend}: shader errors`);
 assert.ok(pixels[1][0]>pixels[0][0]);assert.ok(Math.abs(pixels[1][0]-pixels[2][0])<=1);
 assert.ok(pixels[3][0]>pixels[1][0]);assert.ok(pixels[4][0]>=250);
 console.log(`PASS (${backend}): compiled optics, overlapping dry-volume union, fully dry identity`);
 if(backend==='webgpu'){
  // Rebuilds follow water/environment data only — through the real fold/event path (review #248).
  const r=await page.evaluate(async()=>{
   const w=await import('/lib/watervolumes.js'),st=await import('/lib/state.js');
   let seq=1e9;const fold=(verb:string,args:any)=>{st.foldLive({seq:++seq,ts:Date.now(),actor:'test',verb,args});w.updateWater();return w.waterDebug();};
   const n=()=>w.waterDebug().rebuilds,out:any={};let b=n();const step=(k:string,d:any)=>{out[k]={rebuilt:n()-b,waters:d.waters};b=n();};
   const water={center:[0,-5,0],size:[10,10,10]};
   fold('spawn',{id:'boat',lib:'b.glb',pos:[0,0,0]});step('spawn carrier',w.waterDebug());
   fold('spawn',{id:'pool',lib:'p.glb',pos:[0,0,0]});step('spawn plain',w.waterDebug());
   step('water comp',fold('comp',{id:'pool',type:'water',data:water}));
   fold('spawn',{id:'rock',lib:'r.glb',pos:[5,0,0]});step('unrelated spawn',fold('place',{id:'rock',pos:[6,0,0]}));
   step('mount owner',fold('mount',{id:'pool',to:'boat',offset:[0,0,0]}));
   step('scale carrier',fold('place',{id:'boat',pos:[0,0,0],scale:2}));
   step('respawn owner without water',fold('spawn',{id:'pool',lib:'p.glb',pos:[0,0,0]}));
   st.reset();w.updateWater();
   return out;
  });
  console.log('rebuilds:',r);
  assert.equal(r['water comp'].rebuilt,1);assert.equal(r['water comp'].waters,1);
  assert.equal(r['unrelated spawn'].rebuilt,0,'an unrelated edit must not rebuild the water');
  assert.equal(r['mount owner'].rebuilt,1);assert.equal(r['scale carrier'].rebuilt,1,'scaling a carrier resizes the water it carries');
  assert.equal(r['respawn owner without water'].rebuilt,1);assert.equal(r['respawn owner without water'].waters,0,'a former owner respawned without water leaves none behind');
  console.log('PASS: water rebuilds track water/environment owners, former owners and their carriers');
 }
 await page.close();
}
}finally{await browser.close();}
