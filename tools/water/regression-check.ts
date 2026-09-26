import {chromium} from 'playwright';
import {strict as assert} from 'node:assert';
const browser=await chromium.launch({headless:true,channel:'chrome',args:['--enable-unsafe-webgpu','--use-angle=metal']});
const page=await browser.newPage({viewport:{width:1280,height:800}}),errors:string[]=[];
page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(process.env.WATER_PREVIEW_URL??'http://127.0.0.1:19347/?world=water-fixes&name=water-regressions');
 for(let i=0;i<900;i++){
  const ready=await page.evaluate(async()=>{
   const {getMe}=await import('/lib/mybody.js'),{colliders}=await import('/lib/colliders.js');
   return !!getMe()&&['water-habitat','water-submarine','water-platform'].every(id=>colliders.has(id));
  });
  if(ready)break;if(i===899)throw Error('scene/avatar did not load');await page.waitForTimeout(100);
 }
 const result=await page.evaluate(async()=>{
  const {THREE,camera}=await import('/lib/core.js'),{entities,comps}=await import('/lib/world.js');
  const c=await import('/lib/controller.js'),w=await import('/lib/water.js'),t=await import('/lib/traversal.js');
  const {getMe}=await import('/lib/mybody.js'),{CONFIG,bus}=await import('/lib/base.js');
  const {resolveColliders,raySegment,reindexCollider}=await import('/lib/colliders.js'),{heightAt}=await import('/lib/terrain.js');
  CONFIG.renderer=true;CONFIG.spectate=false;w.updateWater();
  const me=getMe(),fake={root:new THREE.Group(),vrm:{scene:new THREE.Group()},setClip:()=>{},headWorldPosition:()=>null};
  const sub=entities.get('water-submarine'),hab=entities.get('water-habitat');
  const point=(obj,p)=>new THREE.Vector3().fromArray(p).applyMatrix4(obj.matrixWorld);
  const aisle=[-16.8,-14,-11,-8,-5,-3.3].map(z=>{
   const p=point(sub,[0,-1.7,z]),head=p.clone().add(new THREE.Vector3(0,.9,0));
   const floor=resolveColliders(p.clone(),heightAt);
   c.myState.pos.copy(p);c.keys.clear();for(let i=0;i<30;i++)c.updateMe(1/60,fake);
   return {z,dry:!w.waterAt(head),floor:floor-sub.position.y,walk:!c.myState.locomotion,standing:c.myState.pos.y-sub.position.y};
  });
  c.myState.pos.copy(point(sub,[0,-1.7,-13.8]));c.setCamYaw(sub.rotation.y+Math.PI);c.keys.add('KeyW');
  let walkStayedDry=true;for(let i=0;i<360;i++){c.updateMe(1/60,fake);walkStayedDry&&=!c.myState.locomotion;}
  c.keys.clear();const walkedLocal=sub.worldToLocal(c.myState.pos.clone()).toArray();
  const glass=[];sub.traverse(o=>{for(const m of (Array.isArray(o.material)?o.material:[o.material]))if(m?.name==='V_Glass')glass.push({transparent:m.transparent,opacity:m.opacity});});
  const poolRay=raySegment(point(hab,[0,.09,0]),new THREE.Vector3(0,-1,0),.7);
  const routes=[];
  for(const id of ['water-habitat','water-submarine','water-platform']){
   const o=entities.get(id),route=comps.get(id).traversal.routes[0];
   for(const reverse of [false,true]){
    c.keys.clear();c.myState.pos.copy(point(o,route.path[reverse?route.path.length-1:0]));
    bus.emit('key',{code:'KeyE',repeat:false});const began=t.traversing();
    for(let i=0;i<800&&t.traversing();i++)c.updateMe(1/60,fake);
    const destination=point(o,route.path[reverse?0:route.path.length-1]);
    const error=c.myState.pos.distanceTo(destination);
    for(let i=0;i<20;i++)c.updateMe(1/60,fake);
    routes.push({id,reverse,began,error,medium:c.myState.locomotion?.medium??'air',y:c.myState.pos.y});
   }
  }
  // A rotating/moving carrier must move both the dry volume and active climb.
  const oldP=sub.position.clone(),oldYaw=sub.rotation.y,route=comps.get('water-submarine').traversal.routes[0];
  c.myState.pos.copy(point(sub,route.path[0]));t.startTraversal(c.myState.pos);
  sub.position.x+=15;sub.rotation.y+=.4;sub.updateMatrixWorld(true);reindexCollider('water-submarine');w.updateWater();
  for(let i=0;i<400&&t.traversing();i++)c.updateMe(1/60,fake);
  const carrierError=c.myState.pos.distanceTo(point(sub,route.path.at(-1)));
  const carrierDry=!w.waterAt(point(sub,[0,-.8,-10]));sub.position.copy(oldP);sub.rotation.y=oldYaw;sub.updateMatrixWorld(true);reindexCollider('water-submarine');w.updateWater();
  // Exercise the actual VRM and mixer. Hands must stay on their own side and
  // in front of the chest throughout both swim and surface-sculling cycles.
  me.root.rotation.set(0,0,0);me.locomotion={medium:'water',mode:'swim',body:'diver'};me.setClip('idle',0);
  const bones=[];
  for(const mode of ['swim','surface'])for(let i=0;i<16;i++){
   me.locomotion.mode=mode;me.update(1/60,10000+i*157);me.root.updateMatrixWorld(true);
   const inv=me.root.matrixWorld.clone().invert(),p=name=>me.vrm.humanoid.getNormalizedBoneNode(name).getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
   const chest=p('chest'),left=p('leftHand'),right=p('rightHand');bones.push({mode,left:left.toArray(),right:right.toArray(),chest:chest.toArray()});
  }
  return {walkStayedDry,walkedLocal,aisle,glass,poolRay,routes,carrierError,carrierDry,bones,errors:globalThis.EW?.water?.()};
 });
 console.log(JSON.stringify(result,null,2));
 for(const p of result.aisle){assert.ok(p.dry&&p.walk,`aisle ${p.z} is wet`);assert.ok(Math.abs(p.floor+1.7)<.06,`floor ${p.z}: ${p.floor}`);assert.ok(Math.abs(p.standing+1.7)<.1);}
 assert.ok(result.walkStayedDry&&result.walkedLocal[2]>-5.5,'walking through the aisle failed');
 assert.ok(result.glass.length&&result.glass.every(m=>m.transparent&&m.opacity>0&&m.opacity<.3));
 assert.equal(result.poolRay,null,'moonpool water plane must not collide');
 for(const r of result.routes){assert.ok(r.began&&r.error<.01,`${r.id} ${r.reverse} traversal failed`);assert.equal(r.medium,r.reverse?'water':'air',`${r.id} landing medium`);}
 assert.ok(result.carrierError<.01&&result.carrierDry,'moving carrier lost its climb or air');
 for(const b of result.bones){assert.ok(b.left[0]>b.chest[0]+.08&&b.right[0]<b.chest[0]-.08,'hands crossed');assert.ok(b.left[2]>b.chest[2]-.06&&b.right[2]>b.chest[2]-.06,'hands behind back');}
 assert.equal(errors.length,0,errors.join('\n'));
 for(const view of ['inside','windshield','swim']){
  await page.evaluate(async(view)=>{
   const {THREE,camera}=await import('/lib/core.js'),{getMe}=await import('/lib/mybody.js'),{entities}=await import('/lib/world.js');
   const me=getMe(),sub=entities.get('water-submarine');sub.updateMatrixWorld(true);
   const p=a=>new THREE.Vector3().fromArray(a).applyMatrix4(sub.matrixWorld);
   if(view==='swim'){
    me.root.visible=true;me.root.position.copy(p([7,-1,-5]));me.root.rotation.set(.9,0,0);me.locomotion={mode:'swim',medium:'water',body:'diver'};
    camera.position.copy(me.root.position).add(new THREE.Vector3(2,1.6,3));camera.lookAt(me.root.position.clone().add(new THREE.Vector3(0,.9,.4)));
   }else{
    me.root.visible=false;
    camera.position.copy(p(view==='inside'?[0,-.2,-10]:[4,.8,5]));camera.lookAt(p(view==='inside'?[0,-.2,.5]:[0,-.4,-1]));
   }
  },view);
  await page.waitForTimeout(1200);await page.screenshot({path:`/tmp/water-fix-${view}.png`});
 }
 console.log('PASS: full dry aisle/floors, transparent windshield, open moonpool, all ladders both ways, moving carrier, actual VRM swim pose');
}finally{await browser.close();}
