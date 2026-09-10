import {THREE,frameBody,realRigs,frame} from './reach-frame-fixture.ts';
let failures=0;const check=(name:string,ok:boolean,detail:any='')=>{console.log(ok?'PASS':'FAIL',name,detail);if(!ok)failures++;};
const rigs=realRigs();check('real avatar corpus available',rigs.length>=14,rigs.length);
let maxJump=0,maxInput=0,maxGap=0;
for(const rig of rigs)for(const limb of ['leftHand','rightHand'])for(const fraction of [.6,.95,.995]){
 const av=frameBody(rig),ch=av._measureChain(limb);if(!ch)throw new Error('chain missing');
 const sh=ch.nodes.upper.getWorldPosition(new THREE.Vector3()),base=sh.clone().addScaledVector(new THREE.Vector3(...ch.dRestU),(ch.L1+ch.L2)*fraction);
 let f=0;av.setReach(limb,()=>[base.x,base.y,base.z+.002*Math.sin(f/9)]);
 let last:any=null,lastInput=0;
 for(f=0;f<240;f++){
  frame(av,f);const el=ch.nodes.lower.getWorldPosition(new THREE.Vector3());const input=.002*Math.sin(f/9);
  if(last&&f>60){maxJump=Math.max(maxJump,el.distanceTo(last));maxInput=Math.max(maxInput,Math.abs(input-lastInput));maxGap=Math.max(maxGap,av._reach.get(limb).gap??0);}
  last=el;lastInput=input;
 }
}
check('lateral bend basis crossing does not snap the elbow',maxJump<.005,{maxJump,maxInput,maxGap});
check('continuity preserves the endpoint',maxGap<.0001,maxGap);
let maxStatic=0;
for(const rig of rigs){
 const av=frameBody(rig),ch=av._measureChain('rightHand');
 const target=av.nodes.leftUpperArm.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0,0,.05)).toArray();
 av.setReach('rightHand',()=>target);let prev:any=null;
 for(let f=0;f<240;f++){frame(av,f);const el=ch.nodes.lower.getWorldPosition(new THREE.Vector3());if(prev&&f>60)maxStatic=Math.max(maxStatic,el.distanceTo(prev));prev=el;}
}
check('constrained stationary self-touch does not self-excite',maxStatic<.001,maxStatic);
const rig=rigs.find((r:any)=>r.name==='princess0');if(!rig)throw new Error('princess0 fixture required');
const av=frameBody(rig),ch=av._measureChain('rightHand');av.setReach('rightHand',()=>({pos:[.07,1.28,.14],normal:[0,0,1]}));
let last:any=null,maxTwist=0,flips=0;
for(let f=0;f<240;f++){
 for(const n of Object.values(av.nodes) as any[])n.quaternion.identity();
 av.nodes.chest.rotation.x=.02*Math.sin(f/9);av.root.updateMatrixWorld(true);av._applyReach(1/60,f*1000/60);av.root.updateMatrixWorld(true);
 const q=ch.nodes.lower.quaternion.clone();if(last&&f>60){const d=q.angleTo(last)*180/Math.PI;maxTwist=Math.max(maxTwist,d);if(d>20)flips++;}last=q;
}
check('palm antipode does not flip between twist limits',maxTwist<5&&flips===0,{maxTwist,flips});
const wristBody=frameBody(rig),wristChain=wristBody._measureChain('rightHand');let f=0;
wristBody.setReach('rightHand',()=>({pos:[.07,1.28,.14],normal:f<100?[0,0,1]:[0,0,-1]}));
let previous:any=null,maxWristStep=0,maxWristAngle=0;
for(f=0;f<180;f++){frame(wristBody,f);const q=wristChain.nodes.end.quaternion.clone();if(previous&&f>60)maxWristStep=Math.max(maxWristStep,q.angleTo(previous)*180/Math.PI);maxWristAngle=Math.max(maxWristAngle,q.angleTo(new THREE.Quaternion())*180/Math.PI);previous=q;}
check('wrist orientation changes stay bounded in time and range',maxWristStep<3.01&&maxWristAngle<50.01,{maxWristStep,maxWristAngle});
console.log(failures?`${failures} failed`:'all passed');process.exit(failures?1:0);
