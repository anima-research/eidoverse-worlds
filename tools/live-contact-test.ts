import {WorldAgent} from '../mcpl/agent.ts';
import {handleTool} from '../mcpl/tools.ts';
import {scratchSequencer,mkCheck} from './harness.ts';
import {fixture,postureFixture} from './body-fixture.ts';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const {check,tally}=mkCheck(), lib=mkdtempSync(join(tmpdir(),'contact-fixtures-'));
mkdirSync(join(lib,'fixtures'));mkdirSync(join(lib,'defs/animations'),{recursive:true});
writeFileSync(join(lib,'fixtures/body.vrm'),fixture());
const names={idle:'idle',sit:'sitting_on_ground',sitchair:'sitting_normal_chair',lie:'sit_laying_on_ground'};
for(const [kind,name] of Object.entries(names)){
 writeFileSync(join(lib,`fixtures/${kind}.vrma`),postureFixture(kind as any));
 writeFileSync(join(lib,`defs/animations/${name}.json`),JSON.stringify({vrma:`fixtures/${kind}.vrma`}));
}
const h=await scratchSequencer('live-contact',{portFrom:9450,serverEnv:{EIDOVERSE_DIR:lib,DEFS_DIR:join(lib,'defs'),SKIP_OPT_SWEEP:'1'}});
const make=(name:string)=>new WorldAgent({url:h.BASE.replace('http','ws')+'/ws',world:'contact',name,avatar:'fixtures/body.vrm'}) as any;
const a=make('contact-a'),b=make('contact-b');
const call=(ag:any,name:string,args:any={})=>handleTool({agent:ag,canPush:()=>false,heldActivity:[],cursor:{caughtUpTo:null}},name,args);
const read=async(ag:any,args:any={})=>JSON.parse((await call(ag,'body_state',{detail:'all',...args})).content[0].text);
const near=(a:number[],b:number[],e=1e-5)=>a&&b&&Math.hypot(...a.map((v,i)=>v-b[i]))<e;
async function until(f:()=>boolean){const end=Date.now()+5000;while(!f()){if(Date.now()>end)throw new Error('presence timeout');await h.sleep(20);}}
try{
 await a.connect();await b.connect();
 await call(a,'walk_to',{x:-.45,z:0});await call(b,'walk_to',{x:.45,z:0});
 await call(a,'face',{x:.45,z:0});await call(b,'face',{x:-.45,z:0});a.tick();b.tick();
 await until(()=>Math.abs((a.people.get(b.name)?.pose?.yaw??0)+Math.PI/2)<1e-9);
 check('clip phase survives owner/server/peer presence',Number.isFinite(a.people.get(b.name)?.pose?.clipTime));
 const standing=await read(b);
 check('idle clip is actually evaluated',standing.ok&&standing.poseEvaluation.source==='vrma');
 for(const clip of ['sit','sitchair','lie']){
  b.setPosture(clip);b.tick();await until(()=>a.people.get(b.name)?.pose?.clip===clip);
  const own=await read(b),peer=await read(a,{who:b.name});
  check(`${clip} changes the current knee instead of reusing the standing slot`,own.ok&&peer.ok&&!near(own.joints.rightLowerLeg.position,standing.joints.rightLowerLeg.position,.05));
  check(`${clip} self and peer use the same retargeted posture`,near(own.joints.rightLowerLeg.position,peer.joints.rightLowerLeg.position));
 }
 b.setPosture('idle');b.tick();await until(()=>a.people.get(b.name)?.pose?.clip==='idle');
 check('standing restores knee coordinates',near((await read(b)).joints.rightLowerLeg.position,standing.joints.rightLowerLeg.position));
 const canonical=(await read(a,{who:b.name})).contacts.hand_r.position;
 await call(b,'reach',{limb:'rightHand',x:0,y:1.3,z:.4,space:'self',palm:false});b.tick();
 await until(()=>!!a.people.get(b.name)?.pose?.reach?.rightHand);
 const moved=await read(a,{who:b.name});
 check('a public reaching hand leaves its canonical slot',moved.ok&&!near(moved.contacts.hand_r.position,canonical,.15));
 const reply=await call(a,'reach',{limb:'leftHand',who:b.name,point:'hand_r',palm:false});
 const evaluated=a.reachReading.reachEvaluation.leftHand;
 const expected=moved.contacts.hand_r.position.map((v:number,i:number)=>v+.02*moved.contacts.hand_r.normal[i]);
 check('real reach aims at the other hand live transform',near(evaluated.target,expected),reply.content[0].text);
 check('two standing agents can approach and reach without placement',evaluated.reached===true,JSON.stringify(evaluated));
 await call(b,'reach',{limb:'rightHand',x:.05,y:1.25,z:.45,space:'self',palm:false});b.tick();
 await until(()=>a.people.get(b.name)?.pose?.reach?.rightHand?.t?.p?.[2]===.45);
 await a.refreshReachReading();
 check('a held named reach follows a retargeted hand',!near(a.reachReading.reachEvaluation.leftHand.target,evaluated.target,.03));
 check('same-avatar participants do not overwrite each other',a.reachReading.who===a.name&&Math.abs(a.reachReading.root.position[0]+.45)<.01);
 const beforeWrist=(await read(b)).contacts.hand_r.normal;
 b.setPose({rightHand:[0,0,Math.SQRT1_2,Math.SQRT1_2]});b.tick();
 await until(()=>!!a.people.get(b.name)?.pose?.pose?.rightHand);
 const afterWrist=(await read(a,{who:b.name})).contacts.hand_r.normal;
 check('contact normal follows the live hand bone rotation',!near(beforeWrist,afterWrist,.2));
 // Exercise the existing folded mount view at the body read seam. Root pose
 // packets keep pre-mount positions; the socket/motion fold governs rendering.
 b.releaseReach();a.releaseReach();
 const seat={id:'seat',lib:'fixture',pos:[4,1,2],yaw:Math.PI/2,comp:{sockets:{seat:{pos:[0,.5,0],pose:'sitchair'}}}};
 for(const ag of [a,b]){ag.entities.set('seat',seat);ag.mounts.set(b.name,{to:'seat',slot:'seat'});}
 b.tick();await until(()=>a.people.get(b.name)?.pose?.clipTimeSlot==='sitchair');
 const mounted=await read(a,{who:b.name});
 check('mounted readback uses the live socket frame and posture',mounted.ok&&near(mounted.root.position,[4,1.5,2])&&mounted.posture==='sitchair'&&mounted.frame.source==='mount');
 check('mounted phase is associated with the socket clip',mounted.poseEvaluation.phase==='published');
}catch(e){process.exitCode=1;throw e;}finally{a.close();b.close();await h.cleanup(tally.failed||process.exitCode?1:0);rmSync(lib,{recursive:true,force:true});}
console.log(`${tally.passed} passed, ${tally.failed} failed`);process.exit(tally.failed?1:0);
