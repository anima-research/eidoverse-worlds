/**
 * Browser-owner wing posture — drive the real controller key path into the
 * real net.sendPose packet. This is the seam a local-looking fold used to
 * miss: the owner rig moved, while every other browser received `false`.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
const { mock } = await import('bun:test');
const THREE = await import('../client/node_modules/three/build/three.module.js');
const TSL = await import('../client/node_modules/three/build/three.tsl.js');   // materials/warmqueue import TSL from core.js
const base = import.meta.dir + '/../client/lib/';
const hints: string[] = [];
const handlers = new Map<string, Function[]>();
const bus = {
  on(t:string,f:Function){ if(!handlers.has(t)) handlers.set(t,[]); handlers.get(t)!.push(f); },
  emit(t:string,p:any){ for(const f of handlers.get(t)??[]) f(p); },
};
const canvas = Object.assign(document.createElement('canvas'), { requestPointerLock() {} });
// the real CONFIG carries `params` (a URLSearchParams render.js reads for
// ?batching=); the bench only renames the wearer and the world
const realBase: any = await import(base+'base.js');
const BENCH_CONFIG = { ...realBase.CONFIG, name:'owner', world:'bench' };
mock.module(base+'core.js', () => ({
  THREE, TSL, camera: new THREE.PerspectiveCamera(), canvas, CONFIG: BENCH_CONFIG,
  angleDelta:(a:number,b:number)=>b-a, bus, scene: new THREE.Scene(), renderer:{}, report() {},
  // the rest of core.js's surface — materials.js (in the controller's cone) imports sun/ground
  sun: new THREE.DirectionalLight(), ground: new THREE.Mesh(), hemi: new THREE.HemisphereLight(), grid: new THREE.Group(),
  BASE_PIXEL_RATIO: 1,
}));
// rimward: bus/CONFIG/report live in base.js (the renderer-free substrate,
// TEL0S_NOTES §24s seam move 2) and the controller listens on THAT bus — so
// the bench's bus must be the one base.js hands out, or a pressed G reaches
// nobody. The real module's other exports ride along untouched.
mock.module(base+'base.js', () => ({ ...realBase, CONFIG: BENCH_CONFIG, bus, report() {} }));
mock.module(base+'terrain.js', () => ({ heightAt:()=>0, setWaterField() {}, rainSurfaceAt:()=>0 }));   // water.js (upstream #242) hands the water to terrain.js; watervolumes.js its floor
mock.module(base+'colliders.js', () => ({ resolveColliders:()=>{}, lastBlockedTop:0, findSeat:()=>null, raySegment:()=>null,
  frameOf:()=>null, lastContacts:()=>[], colliders:new Map() }));   // hiddenbump.js / controller.js / debug.js import these now (10-14)
mock.module(base+'assets.js', () => ({ forgetBytes() {}, primeFiles: async () => {} }));
mock.module(base+'world.js', () => ({ avatarMounts:new Map() }));   // net.js reads the mounts; the realizer behind world.js is not under test
mock.module(base+'state.js', () => ({ state: { st: { entities: {}, roles: {}, recentChat: [] }, lastSeq: -1, hydrated: false }, hydrate() {}, applyView() {}, reset() {}, onWorldChange: () => () => {} }));
mock.module(base+'scheduler.js', () => ({ pending:new Map(), P:{} }));
mock.module(base+'remotes.js', () => ({ remotes:new Map(), ensureRemote:async()=>null, dropRemote:()=>null, pushPose() {}, noteServerTime() {}, noteSpeaking() {} }));
mock.module(base+'reachnet.js', () => ({ myReachBag:()=>undefined }));
mock.module(base+'chat.js', () => ({ chat:{}, logChat() {}, noteTyping() {}, noteHistoryContext() {}, async resyncChatAfter() {} }));
mock.module(base+'fp_view.js', () => ({ resolveFirstPersonAnchor:()=>null, FP_FORWARD:0, FP_EYE_LIFT:0, FP_GAZE_AHEAD:0, FP_GAZE_DROP:0, composeFirstPerson() {} }));
mock.module(base+'boot.js', () => ({ markPhase() {}, refuseBoot() {}, waitBoot() {} }));
const { html } = await import(base+'markup.js');
mock.module(base+'ui.js', () => ({ isOverlayOpen:()=>false, flashHint:(s:any)=>hints.push(String(s)), toast() {}, html }));

const controller:any = await import('../client/lib/controller.js');
const netmod:any = await import('../client/lib/net.js');
let failures=0, pass=0;
const check=(label:string,ok:boolean,detail='')=>{ console.log(ok?`  ok    ${label}`:`  FAIL  ${label}${detail?' — '+detail:''}`); ok?pass++:failures++; };
const owner:any={wingsFolded:false};
controller.setMeHook(()=>owner);
controller.setRightsHook(()=>({ role:'member', can:[] }));
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
check('real sendPose publishes the fold (the named pose wings-folded)', packet?.pose?.poses?.includes('wings-folded') && !('wingsFolded' in packet.pose), JSON.stringify(packet));
pressG();
netmod.sendPose(200);
packet=JSON.parse(sent.at(-1));
check('G publishes an explicit unfold (an empty poses list)', owner.wingsFolded===false && Array.isArray(packet?.pose?.poses) && packet.pose.poses.length===0);
check('no-grant unfold says propulsion remains unavailable', /propulsion is still not granted/.test(hints.at(-1)??''), hints.at(-1));
pressG();
controller.armFlight(null, 'owner'); // a body whose bones couldn't be read (or a capsule): unknown, not "no wings"
check('an unread body keeps a carried fold', controller.folded()===true && owner.wingsFolded===true);
controller.armFlight([], 'owner'); // swap to a body with no authored wing chains
netmod.sendPose(300);
packet=JSON.parse(sent.at(-1));
check('a wingless swap releases a carried posture, on the wire too', controller.myState.wingsFolded===false && Array.isArray(packet?.pose?.poses) && !packet.pose.poses.includes('wings-folded'));
check('the wingless release is said, in the words G used to say it', hints.at(-1)==='folded-wing posture released — this body has no wings', hints.at(-1));
let said=hints.length;
pressG();
check('G on the wingless body then has nothing to fold or release', hints.length===said && controller.folded()===false, hints.at(-1));
controller.setFolded(true);   // a fold restored on rejoin (main.js) onto the wingless body
check('a fold restored onto a known wingless body is released where it is set', controller.folded()===false && owner.wingsFolded===false);
controller.armFlight(['L_Wing_Upper','L_Wing_Upper_1','R_Wing_Upper','R_Wing_Upper_1','L_Wing_Lower','R_Wing_Lower'],'owner');
said=hints.length;
pressG();
check('G on a winged body folds again', controller.folded()===true && /wings folded/.test(hints.at(-1)??''), hints.at(-1));
pressG();   // open the winged body's wings again, so F may take off
controller.setRightsHook(()=>({ role:'member', fly:true }));   // as main.js wires it, before the body is armed
controller.armFlight(['L_Wing_Upper','L_Wing_Upper_1','R_Wing_Upper','R_Wing_Upper_1','L_Wing_Lower','R_Wing_Lower'],'owner');
bus.emit('key',{code:'KeyF',repeat:false});
const up=controller.flying();
controller.armFlight([], 'owner');   // a swap mid-flight, to a wingless body
check('a swap never ends a flight (lead 11-12): the wingless body flies on', up===true && controller.flying()===true, `took off ${up}; flying ${controller.flying()}; ${hints.at(-1)}`);
bus.emit('key',{code:'KeyF',repeat:false});   // land
console.log('\nARMING FROM THE BODY ON SCREEN (mybody.js setMe -> controller.armFlightForBody)');
const WINGS=['L_Wing_Upper','L_Wing_Upper_1','R_Wing_Upper','R_Wing_Upper_1','L_Wing_Lower','R_Wing_Lower'];
const bodyOf=(bones:string[])=>({ vrm:{ scene:{ traverse:(f:Function)=>bones.forEach((name)=>f({ isBone:true, name })) } } });
const arm=(av:any)=>controller.armFlightForBody?.(av);
const firstSay=arm(bodyOf(WINGS));
check('arming a winged body with the grant says flight is available', /^flight available on this body — press F$/.test(firstSay??''), String(firstSay));
check('...once: the same body armed again says nothing', arm(bodyOf(WINGS))==='', String(arm(bodyOf(WINGS))));
pressG();
check('(setup) the winged body folds', controller.folded()===true);
arm({ vrm:{ scene:{ traverse(){ throw new Error('unreadable'); } } } });
check('a body whose skeleton read throws is unknown: the fold is kept', controller.folded()===true);
arm({});
check('a body with no vrm scene (a capsule) is unknown: the fold is kept', controller.folded()===true);
bus.emit('key',{code:'KeyF',repeat:false});
check("F with a fold held on an unread body doesn't claim wings it hasn't read", /a fold is held/.test(hints.at(-1)??'') && /weren't read/.test(hints.at(-1)??'') && !/wings are folded/.test(hints.at(-1)??''), hints.at(-1));
const bareSay=arm(bodyOf(['Hips','Spine','Head']));
check('a read wingless body releases the fold', controller.folded()===false && /posture released — this body has no wings/.test(hints.at(-1)??''), hints.at(-1));
check('...and, its flight unchanged, says nothing new', bareSay==='', String(bareSay));
const beeSay=arm(bodyOf(['Hips','Spine','Head','Wings','Wing_Left_High_Base','Wing_Left_High1']));
check("a mis-named wing rig is told why its wings won't move", /^flight available on this body — press F; its wings won't animate/.test(beeSay??''), String(beeSay));
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures?1:0);
