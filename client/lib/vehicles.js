// Optional vehicle controller. Authored helms and air boxes ride ordinary entities;
// the existing lease channel arbitrates motion and commits the final resting pose.
import { THREE } from './core.js';
import { bus, CONFIG } from './base.js';
import { entities, comps } from './world.js';
import { sendLease } from './net.js';
import { keys, myState, photoMode, updateFollowCamera, constrainMovement } from './controller.js';
import { raySegment, reindexCollider } from './colliders.js';
import { flashHint } from './ui.js';
let pending=null, pilot=null, lastSent=0, velocity=new THREE.Vector3();
const local=new THREE.Vector3(), old=new THREE.Vector3(), delta=new THREE.Vector3();
const axis=new THREE.Vector3(0,1,0);
function end(release=true,exit=false){
  if(pilot){const o=entities.get(pilot),spec=comps.get(pilot)?.vehicle;
    if(o){o.rotation.set(0,o.rotation.y,0);o.updateMatrixWorld(true);
      if(exit&&spec?.exit)myState.pos.fromArray(spec.exit).applyMatrix4(o.matrixWorld);
      if(release)sendLease('release',pilot,{p:o.position.toArray(),yaw:o.rotation.y});}
  }
  pilot=null;pending=null;velocity.set(0,0,0);myState.locomotion=undefined;myState.q=undefined;
}
bus.on('key',e=>{
  if(e.code!=='KeyE'||e.repeat||CONFIG.spectate||photoMode)return;
  if(pilot){end(true,true);flashHint('left helm');return;}
  if(pending||e.worldHandled)return;
  for(const [id,specs] of comps){const o=entities.get(id),v=specs.vehicle;
    if(!o||!Array.isArray(v?.helm))continue;
    o.updateWorldMatrix(true,false);local.fromArray(v.helm).applyMatrix4(o.matrixWorld);
    if(local.distanceTo(myState.pos)>2.5)continue;
    pending=id;sendLease('claim',id);flashHint('requesting helm');break;
  }
});
bus.on('lease',m=>{
  if(m.id===pending){
    if(m.op==='granted'){pilot=pending;pending=null;lastSent=0;flashHint('piloting — W/S thrust, A/D steer, Space rise, C dive, E exit');}
    else if(m.op==='denied'){pending=null;flashHint(m.why??'helm occupied');}
  }
  if(m.id===pilot&&['lost','released'].includes(m.op))end(false);
});
bus.on('world-reset',()=>end(false));
bus.on('net',n=>{if(!n.joined)end(false);});
export const piloting=()=>pilot;
export function updateVehicle(dt,me){
  if(!pilot||!me)return false;
  const o=entities.get(pilot),spec=comps.get(pilot)?.vehicle;
  if(!o||!spec){end();return false;}
  dt=Math.min(.1,Math.max(0,dt));
  const turn=Number(keys.has('KeyA'))-Number(keys.has('KeyD'));
  const thrust=Number(keys.has('KeyW'))-Number(keys.has('KeyS'));
  const vertical=Number(keys.has('Space'))-Number(keys.has('KeyC')||keys.has('ControlLeft')||keys.has('ControlRight'));
  o.rotation.y+=turn*Math.max(.1,Math.min(2,Number(spec.turnRate)||.45))*dt;
  const speed=Math.max(.1,Math.min(15,Number(spec.speed)||4));
  delta.set(0,vertical*.5,thrust).normalize().multiplyScalar(speed).applyAxisAngle(axis,o.rotation.y);
  velocity.lerp(delta,1-Math.exp(-1.5*dt));old.copy(o.position);
  o.position.addScaledVector(velocity,dt);constrainMovement(o.position);
  const min=spec.minY,max=spec.maxY;
  if(Number.isFinite(min))o.position.y=Math.max(min,o.position.y);
  if(Number.isFinite(max))o.position.y=Math.min(max,o.position.y);
  // Five hull probes are authored in local coordinates. Ignore our own collider.
  delta.copy(o.position).sub(old);const distance=delta.length();
  if(distance>.00001){delta.divideScalar(distance);
    for(const p of spec.probes??[[0,0,0]]){
      local.fromArray(p).applyAxisAngle(axis,o.rotation.y).add(old);
      const hit=raySegment(local,delta,distance+.3,pilot);
      if(hit!==null){o.position.copy(old);velocity.set(0,0,0);break;}
    }
  }
  o.updateMatrixWorld(true);reindexCollider(pilot);
  myState.pos.fromArray(spec.helm).applyMatrix4(o.matrixWorld);myState.yaw=o.rotation.y;
  myState.speed=velocity.length();myState.clip='sitchair';myState.locomotion={mode:'pilot',medium:'air',body:'diver'};
  myState.q=o.quaternion.toArray();me.locomotion=null;me.root.position.copy(myState.pos);me.root.quaternion.copy(o.quaternion);me.setClip('sitchair',0);
  updateFollowCamera(dt,me);
  const now=performance.now();if(now-lastSent>=66){lastSent=now;sendLease('state',pilot,{p:o.position.toArray(),yaw:o.rotation.y,q:o.quaternion.toArray()});}
  return true;
}
