import {THREE,frameBody,realRigs,frame} from './reach-frame-fixture.ts';
const {initReachNet,setMyReach,clearMyReach,myReachBag,applyRemoteReach,dropRemoteReach}=await import('../client/lib/reachnet.js');
let current:any=null;const messages:string[]=[];
const dispatch=await(await import('./reach-command-fixture.ts')).commandsFor(()=>current,messages);
let fail=0;function check(n:string,v:boolean){console.log(v?'PASS':'FAIL',n);if(!v)fail++;}
const rig=realRigs().find((r:any)=>r.name==='claude_suit');if(!rig)throw new Error('claude_suit fixture required');
function body(){
 const av=frameBody(rig);av.__marks=new Map(['left','right'].map(side=>['hand_'+side[0],{node:av.nodes[side+'Hand'],offset:new THREE.Vector3(),normal:new THREE.Vector3(0,0,1)}]));
 current=av;
 initReachNet({me:()=>av,myId:()=>'owner',avatarOf:(id:string)=>id==='owner'?av:null});clearMyReach();return av;
}
const results:any[]=[];
for(const order of ['follower-first','producer-first']){
 const av=body();const p={p:[.02,1.12,.24],space:'self'};
 const producer=()=>setMyReach('leftHand',p,{palm:false});const follower=()=>dispatch('touch','self hand_l right');
 if(order==='follower-first'){follower();producer();}else{producer();follower();}
 let used:number[]=[];const liveTarget=av._reach.get('rightHand').target;
 av._reach.get('rightHand').target=()=>{const result=liveTarget();used=Array.isArray(result)?result:result.pos;return result;};
 for(let f=0;f<100;f++)frame(av,f);
 const target=used;const left=av.nodes.leftHand.getWorldPosition(new THREE.Vector3()).toArray();
 check(`${order}: target is the producer's live hand`,Math.hypot(...left.map((v:number,i:number)=>v-target[i]))<.021);
 results.push(av.nodes.rightHand.getWorldPosition(new THREE.Vector3()).toArray());
 setMyReach('leftHand',{p:[.1,1.06,.32],space:'self'},{palm:false});for(let f=100;f<200;f++)frame(av,f);
 const frameTarget=av._reach.get('rightHand').target(),moved=Array.isArray(frameTarget)?frameTarget:frameTarget.pos;
 check(`${order}: retargeting producer moves follower target`,Math.hypot(...moved.map((v:number,i:number)=>v-target[i]))>.03);
 dispatch('letgo','left');for(let f=200;f<260;f++)frame(av,f);
 check(`${order}: single-limb clear preserves the other relation`,!av._reach.has('leftHand')&&av._reach.has('rightHand')&&!!myReachBag()?.rightHand);
}
check('same final relations give insertion-order independent hand position',Math.hypot(...results[0].map((v:number,i:number)=>v-results[1][i]))<1e-5);
const receiptBody=body();setMyReach('leftHand',{p:[.02,1.12,.24],space:'self'},{palm:false});dispatch('touch','self hand_l right');for(let f=0;f<100;f++)frame(receiptBody,f);
await new Promise(r=>setTimeout(r,650));
check('human receipt reports endpoint distance rather than rest',messages.some(m=>m.includes('endpoint gap'))&&!messages.some(m=>m.includes('rests on')));
for(const order of ['left-first','right-first'])for(const warmed of [false,true]){
 const av=body(),label=`${order}/${warmed?'previously-solving':'cold'} cycle`;
 if(warmed){
  setMyReach('leftHand',{p:[.02,1.12,.24],space:'self'},{palm:false});
  setMyReach('rightHand',{p:[-.02,1.12,.24],space:'self'},{palm:false});
  for(let f=0;f<100;f++)frame(av,f);
 }
 const commands=order==='left-first'?['self hand_r left','self hand_l right']:['self hand_l right','self hand_r left'];
 for(const command of commands)dispatch('touch',command);
 if(warmed){
  // A paused/sparse clip may not rewrite these bones. Refusing a newly
  // cyclic relation must still withdraw the last successful reach pose.
  av._applyReach(1/60,0);av.root.updateMatrixWorld(true);
  check(`${label}: cyclic retarget restores the paused clip base`,['left','right'].every(side=>['UpperArm','LowerArm','Hand'].every(bone=>av.nodes[side+bone].quaternion.angleTo(new THREE.Quaternion())<1e-6)));
 }
 for(let f=0;f<30;f++)frame(av,f);
 check(`${label}: cyclic refusal clears endpoint attestation`,av._reach.size===2&&[...av._reach.values()].every((r:any)=>r.bound.includes('cyclic-reach')&&r.gap===null)&&!myReachBag()?.leftHand?.reached&&!myReachBag()?.rightHand?.reached);
 const descriptor=myReachBag();
 dispatch('letgo','left');
 for(let f=0;f<200;f++)frame(av,f);
 check(`${label}: release removes private entry and unblocks survivor`,!av._reach.has('leftHand')&&!myReachBag()?.leftHand&&!!myReachBag()?.rightHand&&Number.isFinite(av.reachStatus().rightHand?.gap)&&!av.reachStatus().rightHand?.bound.includes('cyclic-reach'));
 const survivor=av._reach.get('rightHand'),prior=survivor?.solved?.hand?.slice();
 let used:number[]=[];const originalTarget=survivor.target;
 survivor.target=()=>{const result=originalTarget();used=Array.isArray(result)?result:result.pos;return result;};
 av.root.position.x+=.15;for(let f=0;f<30;f++)frame(av,f);
 const target=av.nodes.leftHand.getWorldPosition(new THREE.Vector3()).toArray();
 check(`${label}: survivor updates live target and endpoint receipt`,used.length===3&&Math.hypot(...used.map((v:number,i:number)=>v-target[i]))<.021&&!!prior&&Math.abs(survivor.solved.hand[0]-prior[0]-.15)<1e-5&&Number.isFinite(av.reachStatus().rightHand?.gap));
 // The remote presence door must retire the same private entry when its
 // descriptor disappears, without depending on another explicit command.
 const remote=body(),r:any={id:'owner',avatar:remote};
 if(warmed){
  applyRemoteReach(r,{reach:{leftHand:{t:{p:[.02,1.12,.24],space:'self'},palm:false},rightHand:{t:{p:[-.02,1.12,.24],space:'self'},palm:false}}});
  for(let f=0;f<100;f++)frame(remote,f);
 }
 applyRemoteReach(r,{reach:descriptor});for(let f=0;f<30;f++)frame(remote,f);
 applyRemoteReach(r,{reach:{rightHand:descriptor.rightHand}});for(let f=0;f<200;f++)frame(remote,f);
 check(`${label}: remote descriptor removal unblocks survivor`,!remote._reach.has('leftHand')&&Number.isFinite(remote.reachStatus().rightHand?.gap)&&!remote.reachStatus().rightHand?.bound.includes('cyclic-reach'));
 dropRemoteReach(r);for(let f=0;f<200;f++)frame(remote,f);
 check(`${label}: remote departure removes remaining private entry`,remote._reach.size===0);
 // Recreate through the human door, then clear all without first breaking
 // the cycle. Absence, rather than zero weight, is the release contract.
 const all=body();for(const command of commands)dispatch('touch',command);frame(all,0);
 dispatch('letgo','');for(let f=0;f<200;f++)frame(all,f);
 check(`${label}: letgo all removes every cyclic entry`,all._reach.size===0&&!myReachBag());
}
console.log(fail?`${fail} failed`:'all passed');process.exit(fail?1:0);
