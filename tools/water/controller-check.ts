import {chromium} from 'playwright';
import {strict as assert} from 'node:assert';
const browser=await chromium.launch({headless:true,channel:'chrome',args:['--enable-unsafe-webgpu','--use-angle=metal']});
const page=await browser.newPage();
try {
 await page.goto(process.env.WATER_PREVIEW_URL??'http://127.0.0.1:19347/?world=water-preview&spectate=1&name=water-tests');
 await page.waitForFunction(()=>globalThis.__waterDebug?.().waters===1);
 for(let i=0;i<300;i++){
  const ready=await page.evaluate(async()=>{const {colliders}=await import('/lib/colliders.js');return colliders.has('water-terrain')&&colliders.has('water-habitat');});
  if(ready)break;
  if(i===299)throw Error('colliders did not become ready');
  await page.waitForTimeout(100);
 }
 const result=await page.evaluate(async()=>{
  const {CONFIG}=await import('/lib/base.js');CONFIG.renderer=true;
  const core=await import('/lib/core.js'),w=await import('/lib/water.js'),c=await import('/lib/controller.js');
  const {entities}=await import('/lib/world.js');const {resolveColliders,colliders}=await import('/lib/colliders.js');const {heightAt}=await import('/lib/terrain.js');
  const fake={root:new core.THREE.Group(),vrm:{scene:new core.THREE.Group()},setClip:()=>{},headWorldPosition:()=>null};
  w.updateWater();
  const dryBefore=!w.waterAt([-13,-28.5,80]);const wet=!!w.waterAt([-29,-25,89]);
  const carrier=entities.get('water-habitat');carrier.position.x+=40;w.updateWater();
  const oldRoomWet=!!w.waterAt([-13,-28.5,80]),newRoomDry=!w.waterAt([27,-28.5,80]);carrier.position.x-=40;w.updateWater();
  c.myState.pos.set(-29,-25,89);c.keys.add('Space');
  for(let i=0;i<120;i++)c.updateMe(1/60,fake);
  c.keys.clear();const ascended=c.myState.pos.y;
  c.keys.add('KeyC');for(let i=0;i<120;i++)c.updateMe(1/60,fake);c.keys.clear();
  const descended=c.myState.pos.y;
  const swimmer=c.myState.locomotion?.mode,quaternion=c.myState.q;
  const floor=resolveColliders(new core.THREE.Vector3(-15.5,-29,80),heightAt);
  return {dryBefore,wet,oldRoomWet,newRoomDry,ascended,descended,swimmer,quaternion,floor,colliders:[...colliders.keys()],tiers:[...entities].map(([id,o])=>[id,o.userData.tier])};
 });
 console.log(result);
 assert.ok(result.dryBefore&&result.wet&&result.oldRoomWet&&result.newRoomDry);
 assert.ok(result.ascended>-23&&result.ascended<0);assert.ok(result.descended<result.ascended-2);
 assert.equal(result.swimmer,'swim');assert.equal(result.quaternion.length,4);assert.ok(result.floor<0&&result.floor>-40);
 const vehicle=await page.evaluate(async()=>{
  const {CONFIG,bus}=await import('/lib/base.js'),{net}=await import('/lib/net.js');
  const {THREE}=await import('/lib/core.js'),{entities,comps}=await import('/lib/world.js');
  const c=await import('/lib/controller.js'),v=await import('/lib/vehicles.js');
  const o=entities.get('water-submarine'),spec=comps.get('water-submarine').vehicle;
  const sent=[];const socket=net.ws;net.ws={readyState:1,send:x=>sent.push(JSON.parse(x))};net.joined=true;CONFIG.spectate=false;
  o.updateMatrixWorld(true);c.myState.pos.fromArray(spec.helm).applyMatrix4(o.matrixWorld);
  const start=o.position.clone();const fake={root:new THREE.Group(),vrm:{scene:new THREE.Group()},setClip:()=>{},headWorldPosition:()=>null};
  bus.emit('key',{code:'KeyE',repeat:false});bus.emit('lease',{op:'granted',id:'water-submarine'});
  c.keys.add('KeyW');for(let i=0;i<120;i++)v.updateVehicle(1/60,fake);c.keys.clear();
  const moved=o.position.distanceTo(start),mode=c.myState.locomotion?.mode;
  bus.emit('key',{code:'KeyE',repeat:false});net.ws=socket;
  return {moved,mode,active:v.piloting(),ops:sent.map(m=>m.op),release:sent.at(-1)};
 });
 console.log('VEHICLE',vehicle);
 assert.ok(vehicle.moved>2);assert.equal(vehicle.mode,'pilot');assert.equal(vehicle.active,null);
 assert.equal(vehicle.ops[0],'claim');assert.ok(vehicle.ops.includes('state'));assert.equal(vehicle.release.op,'release');
 assert.ok(vehicle.release.p.every(Number.isFinite));
 console.log('PASS: actual scene loading, moving dry interior, 3D ascent/descent, underwater presence, imported floor collision, vehicle lease/drive/release');
} finally {await browser.close();}
