/**
 * Browser-owner wing posture — drive the real controller key path into the
 * real net.sendPose packet. This is the seam a local-looking fold used to
 * miss: the owner rig moved, while every other browser received `false`.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
const { mock } = await import('bun:test');
const THREE = await import('../client/node_modules/three/build/three.module.js');
const base = import.meta.dir + '/../client/lib/';
const hints: string[] = [];
const handlers = new Map<string, Function[]>();
const bus = {
  on(t:string,f:Function){ if(!handlers.has(t)) handlers.set(t,[]); handlers.get(t)!.push(f); },
  emit(t:string,p:any){ for(const f of handlers.get(t)??[]) f(p); },
};
const canvas = Object.assign(document.createElement('canvas'), { requestPointerLock() {} });
mock.module(base+'core.js', () => ({
  THREE, camera: new THREE.PerspectiveCamera(), canvas, CONFIG: { name:'owner', world:'bench' },
  angleDelta:(a:number,b:number)=>b-a, bus, scene:{}, renderer:{}, report() {},
}));
mock.module(base+'terrain.js', () => ({ heightAt:()=>0 }));
mock.module(base+'colliders.js', () => ({ resolveColliders:()=>{}, lastBlockedTop:0, findSeat:()=>null, raySegment:()=>null }));
mock.module(base+'assets.js', () => ({ forgetBytes() {} }));
mock.module(base+'state.js', () => ({ hydrate() {}, foldLive() {}, reset() {} }));
mock.module(base+'scheduler.js', () => ({ pending:new Map(), P:{} }));
mock.module(base+'remotes.js', () => ({ remotes:new Map(), ensureRemote:async()=>null, dropRemote:()=>null, pushPose() {}, noteServerTime() {}, noteSpeaking() {} }));
mock.module(base+'reachnet.js', () => ({ myReachBag:()=>undefined }));
mock.module(base+'chat.js', () => ({ chat:{}, logChat() {}, logWhisper() {}, noteTyping() {}, noteHistoryContext() {} }));
mock.module(base+'fp_view.js', () => ({ resolveFirstPersonAnchor:()=>null, FP_FORWARD:0, FP_EYE_LIFT:0, FP_GAZE_AHEAD:0, FP_GAZE_DROP:0, composeFirstPerson() {} }));
mock.module(base+'boot.js', () => ({ markPhase() {} }));
mock.module(base+'ui.js', () => ({ isOverlayOpen:()=>false, flashHint:(s:string)=>hints.push(s), toast() {} }));

const controller:any = await import('../client/lib/controller.js');
const netmod:any = await import('../client/lib/net.js');
let failures=0, pass=0;
const check=(label:string,ok:boolean,detail='')=>{ console.log(ok?`  ok    ${label}`:`  FAIL  ${label}${detail?' — '+detail:''}`); ok?pass++:failures++; };
const owner:any={wingsFolded:false};
controller.setMeHook(()=>owner);
controller.setRightsHook(()=>({ role:'visitor', can:[] }));
controller.armFlight(['L_Wing_Upper','L_Wing_Upper_1','R_Wing_Upper','R_Wing_Upper_1','L_Wing_Lower','R_Wing_Lower'],'owner');
const sent:string[]=[];
netmod.net.joined=true;
netmod.net.ws={readyState:1,send:(s:string)=>sent.push(s)};
netmod.wireNet({myState:controller.myState,me:()=>owner});
const pressG=()=>bus.emit('key',{code:'KeyG',repeat:false});

console.log('\nBROWSER OWNER → ACTUAL PRESENCE PACKET');
pressG();
netmod.sendPose(100);
let packet=JSON.parse(sent.at(-1));
check('G folds both the owner rig and controller wire state', owner.wingsFolded===true && controller.myState.wingsFolded===true);
check('real sendPose publishes the fold', packet?.pose?.wingsFolded===true, JSON.stringify(packet));
pressG();
netmod.sendPose(200);
packet=JSON.parse(sent.at(-1));
check('G publishes an explicit unfold', owner.wingsFolded===false && packet?.pose?.wingsFolded===false);
check('no-grant unfold says propulsion remains unavailable', /propulsion is still not granted/.test(hints.at(-1)??''), hints.at(-1));
pressG();
controller.armFlight([], 'owner'); // swap to a body with no authored wing chains
pressG();
netmod.sendPose(300);
packet=JSON.parse(sent.at(-1));
check('a wingless swap can release a carried posture', controller.myState.wingsFolded===false && packet?.pose?.wingsFolded===false);
check('the wingless release is truthful', /posture released/.test(hints.at(-1)??''), hints.at(-1));
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures?1:0);
