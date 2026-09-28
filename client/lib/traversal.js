// Authored climb routes, in entity-local metres. The same path can board a
// platform, leave a moonpool, or climb a moving vessel's hatch ladder.
import { THREE } from './core.js';
import { bus } from './base.js';
import { state } from './state.js';
let objects=()=>new Map(), active=null;
const validPoint=p=>Array.isArray(p)&&p.length===3&&p.every(Number.isFinite);
export function setTraversalObjects(fn){objects=fn;}
export function traversing(){return active!==null;}
export function cancelTraversal(){active=null;}
bus.on('world-reset',cancelTraversal);
bus.on('net',n=>{if(!n.joined)cancelTraversal();});
export function nearbyTraversal(pos){
 let best=null;
 for(const [id,e] of Object.entries(state.st.entities)){
  const obj=objects().get(id),routes=e.comp?.traversal?.routes;
  if(!obj||!Array.isArray(routes))continue;
  obj.updateWorldMatrix(true,false);
  for(const [index,route] of routes.slice(0,32).entries()){
   if(!Array.isArray(route?.path)||route.path.length<2||route.path.length>16||!route.path.every(validPoint))continue;
   const radius=Number.isFinite(route.radius)?THREE.MathUtils.clamp(route.radius,.3,3):1.4;
   for(const reverse of [false,true]){
    const end=new THREE.Vector3().fromArray(route.path[reverse?route.path.length-1:0]).applyMatrix4(obj.matrixWorld);
    const distance=end.distanceTo(pos);
    if(distance>radius||best&&distance>=best.distance)continue;
    best={id,index,route,reverse,distance,name:typeof route.name==='string'?route.name:'ladder'};
   }
  }
 }
 return best;
}
export function startTraversal(pos,candidate=nearbyTraversal(pos)){
 if(!candidate)return false;
 const obj=objects().get(candidate.id);if(!obj)return false;
 obj.updateWorldMatrix(true,false);
 const path=candidate.route.path.map(p=>new THREE.Vector3().fromArray(p));
 if(candidate.reverse)path.reverse();
 // Ease from the actual hand-off position; every subsequent point stays in
 // the carrier's frame, so moving the carrier cannot leave its climber behind.
 path.unshift(obj.worldToLocal(pos.clone()));
 active={...candidate,path,segment:0,distance:0,
  speed:THREE.MathUtils.clamp(Number(candidate.route.speed)||1.3,.3,4)};
 return true;
}
export function stepTraversal(dt){
 if(!active)return null;
 const a=active,obj=objects().get(a.id);
 if(!obj||!state.st.entities[a.id]?.comp?.traversal){cancelTraversal();return null;}
 obj.updateWorldMatrix(true,false);
 let travel=Math.max(0,Math.min(.1,dt))*a.speed;
 let pos=null,done=false;
 while(a.segment<a.path.length-1){
  const from=a.path[a.segment].clone().applyMatrix4(obj.matrixWorld),to=a.path[a.segment+1].clone().applyMatrix4(obj.matrixWorld);
  const length=from.distanceTo(to),remaining=Math.max(0,length-a.distance);
  if(travel>=remaining){travel-=remaining;a.segment++;a.distance=0;pos=to;continue;}
  a.distance+=travel;pos=from.lerp(to,length?Math.min(1,a.distance/length):1);break;
 }
 done=a.segment>=a.path.length-1;
 const facing=a.path.at(-1).clone().sub(a.path[1]);
 if(a.reverse)facing.negate(); // face the rungs on both ascent and descent
 facing.transformDirection(obj.matrixWorld);
 const yaw=Math.atan2(facing.x,facing.z);
 if(done)cancelTraversal();
 return {pos,yaw,done,speed:a.speed};
}
