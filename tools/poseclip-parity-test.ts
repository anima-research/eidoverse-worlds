import {PoseClips} from '../mcpl/pose-clips.ts';
import {parsePoseAnimation,retargetPoseAnimation,syncClipPhase} from '../client/lib/poseclips.js';
import {ReachBody} from '../mcpl/physics.ts';
import {glbJson,humanBones,worldPositions} from '../mcpl/rig.ts';
import {fixture,postureFixture} from './body-fixture.ts';
import * as THREE from '../client/node_modules/three/build/three.module.js';
let fail=0;const check=(s:string,v:boolean)=>{console.log(v?'PASS':'FAIL',s);if(!v)fail++;};
const clips=new PoseClips('http://unused.invalid');
for(const vrm0 of [false,true])for(const slot of ['idle','sit','sitchair','lie'] as const){
 const g=glbJson(fixture(1,vrm0)),bones=humanBones(g),wp=worldPositions(g),P:any={};
 for(const [name,index] of Object.entries(bones))P[name]=wp(index);
 Object.defineProperty(P,'__vrm0',{value:vrm0});
 const byNode=new Map(Object.entries(bones).map(([name,index])=>[index,name])),parents=new Map<number,number>();g.nodes.forEach((n:any,i:number)=>(n.children??[]).forEach((c:number)=>parents.set(c,i)));
 const parent:any={};for(const [name,index] of Object.entries(bones)){let up=parents.get(index as number);while(up!=null&&!byNode.has(up))up=parents.get(up);parent[name]=up==null?null:byNode.get(up);}
 const a=await ReachBody.fromSkeleton(P,parent),b=await ReachBody.fromSkeleton(P,parent);if(!a||!b)throw new Error('no rig');
 const bytes=postureFixture(slot),animation=await parsePoseAnimation(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
 const browserClip=retargetPoseAnimation(animation,b.av.vrm),mixer=new THREE.AnimationMixer(b.av.root);mixer.clipAction(browserClip).play();
 for(const time of [.1,.37,.88]){
  a.poseAt([1,2,3],.4,null);b.av.root.position.set(1,2,3);b.av.root.rotation.y=.4;
  clips.apply(animation,a,time);mixer.setTime(time);b.av.root.updateMatrixWorld(true);
  const delta=Math.max(...Object.keys(a.av.nodes).map(name=>a.av.nodes[name].getWorldPosition(new THREE.Vector3()).distanceTo(b.av.nodes[name].getWorldPosition(new THREE.Vector3()))));
  check(`${slot}, VRM${vrm0?'0':'1'}, t=${time}: headless joints match browser mixer`,delta<1e-6);
 }
}
const stamp:any={},avatar:any={currentSlot:'sit',current:{time:0,getClip:()=>({duration:2})}};
check('new phase sample is applied modulo duration',syncClipPhase(avatar,{clip:'sit',clipTime:5.5},stamp)&&avatar.current.time===1.5);
avatar.current.time+=.1;check('same sample does not freeze animation between packets',!syncClipPhase(avatar,{clip:'sit',clipTime:5.5},stamp)&&avatar.current.time===1.6);
avatar.currentSlot='lie';check('same numeric phase in a new slot still applies',syncClipPhase(avatar,{clip:'lie',clipTime:5.5},stamp)&&avatar.current.time===1.5);
check('unloaded/fallback clip is not assigned the wrong phase',!syncClipPhase(avatar,{clip:'sit',clipTime:1},stamp));
check('a paused owner freezes the matching remote clip',syncClipPhase(avatar,{clip:'lie',clipTime:5.5,clipRate:0},stamp)&&avatar.current.timeScale===0);
avatar.current.timeScale=1;syncClipPhase(avatar,{clip:'lie',clipTime:5.5,clipRate:0},stamp);
check('pause remains applied between duplicate phase samples',avatar.current.timeScale===0);
avatar.currentSlot='sitchair';
check('mount-owned phase can differ from the controller clip',syncClipPhase(avatar,{clip:'idle',clipTimeSlot:'sitchair',clipTime:1.25,clipRate:1},stamp)&&avatar.current.time===1.25);
console.log(fail?`${fail} failed`:'all passed');process.exit(fail?1:0);
