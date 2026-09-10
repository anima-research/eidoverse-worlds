import {THREE,frameBody,realRigs,frame} from './reach-frame-fixture.ts';
const {initReachNet,setMyReach,clearMyReach,myReachBag}=await import('../client/lib/reachnet.js');
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
const av=body();setMyReach('leftHand','hand_r');setMyReach('rightHand','hand_l');frame(av,0);
check('cyclic hand relations have an explicit bounded failure',[...av._reach.values()].every((r:any)=>r.bound.includes('cyclic-reach')&&r.gap===null));
console.log(fail?`${fail} failed`:'all passed');process.exit(fail?1:0);
