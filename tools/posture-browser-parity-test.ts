// Optional real-VRM gate: EIDOVERSE_DIR=/path/to/library bun tools/posture-browser-parity-test.ts
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import * as THREE from '../client/node_modules/three/build/three.module.js';
import {GLTFLoader} from '../client/node_modules/three/examples/jsm/loaders/GLTFLoader.js';
import {VRMLoaderPlugin,VRMUtils} from '../client/node_modules/@pixiv/three-vrm/lib/three-vrm.module.js';
import {parsePoseAnimation,retargetPoseAnimation} from '../client/lib/poseclips.js';
import {BodyStateReader} from '../mcpl/body-state.ts';
import {scratchSequencer} from './harness.ts';
if(!process.env.EIDOVERSE_DIR)throw new Error('set EIDOVERSE_DIR to the real avatar/animation library');
let checks=0;const inputs=new Map<string,any>();
function record(path:string,bytes:ArrayBuffer){const data={path:path.split('?')[0],bytes:bytes.byteLength,sha256:createHash('sha256').update(new Uint8Array(bytes)).digest('hex')};const prior=inputs.get(data.path);if(prior&&prior.sha256!==data.sha256)throw new Error('fixture changed during measurement');inputs.set(data.path,data);}
const h=await scratchSequencer('raw-vrm-posture',{portFrom:9510,serverEnv:{EIDOVERSE_DIR:process.env.EIDOVERSE_DIR,SKIP_OPT_SWEEP:'1'}});
try{
 const reader=new BodyStateReader(h.BASE);const roster=await (await fetch(h.BASE+'/animations')).json() as any[];
 for(const name of ['claude','orion','claude_suit']){
  const path='eidoverse/assets/vrms/'+name+'.vrm',bytes=await(await fetch(h.BASE+'/library/'+path)).arrayBuffer();
  record(path,bytes);
  const loader=new GLTFLoader();loader.register((p:any)=>new VRMLoaderPlugin(p));loader.register(()=>({name:'no-texture-upload',loadTexture:async()=>new THREE.Texture()}));
  const gltf:any=await new Promise((res,rej)=>loader.parse(bytes,'',res,rej));const vrm=gltf.userData.vrm;VRMUtils.rotateVRM0(vrm);
  for(const [slot,file] of [['idle','idle'],['sit','sitting_on_ground'],['sitchair','sitting_normal_chair'],['lie','sit_laying_on_ground']]){
   const rel=roster.find(e=>e.name===file)?.path??'eidoverse/assets/animations/'+file+'.vrma';
   const clipBytes=await(await fetch(h.BASE+'/library/'+rel)).arrayBuffer();record(rel,clipBytes);
   const anim=await parsePoseAnimation(clipBytes);
   const mixer=new THREE.AnimationMixer(vrm.scene);mixer.clipAction(retargetPoseAnimation(anim,vrm)).play();mixer.setTime(1);vrm.humanoid.update();vrm.scene.updateMatrixWorld(true);
   const o:any={who:name,avatar:path,generation:1,self:true,connected:true,source:'unknown',pose:{p:[0,0,0],yaw:0,speed:0,clip:slot,clipTime:1}};
   const r=await reader.read(name,'bones',undefined,()=>({...o,receivedAt:Date.now()}));
   const delta=Math.max(...Object.keys(r.joints??{}).filter(k=>vrm.humanoid.getNormalizedBoneNode(k)).map(k=>new THREE.Vector3(...r.joints[k].position).distanceTo(vrm.humanoid.getNormalizedBoneNode(k).getWorldPosition(new THREE.Vector3()))));
   const missing=Object.keys(r.joints??{}).filter(k=>!vrm.humanoid.getNormalizedBoneNode(k));
   if(!r.ok||missing.length||!Number.isFinite(delta)||delta>1e-5)throw new Error(`${name}/${slot}: mismatch ${delta}m; missing ${missing}`);
   console.log(`PASS ${name}/${slot}: max normalized-joint error ${delta}m`);checks++;

   mixer.stopAllAction();
  }
 }
}catch(e){process.exitCode=1;throw e;}finally{await h.cleanup(process.exitCode?1:0);}
if(process.env.POSTURE_MANIFEST_OUT)writeFileSync(process.env.POSTURE_MANIFEST_OUT,JSON.stringify({checks,inputs:[...inputs.values()]},null,2)+'\n');
console.log(`${checks} real VRM/posture comparisons passed`);process.exit(0);
