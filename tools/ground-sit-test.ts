/** bun tools/ground-sit-test.ts — real seat selector, stubbed browser boundaries. */
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
const base = import.meta.dir + '/../client/lib/';
class Vector3 { x=0; y=0; z=0; set(x:number,y:number,z:number){Object.assign(this,{x,y,z});return this;} }
const noop = () => {};
const sent:any[] = [];
const comps = new Map();
const myState = { pos:new Vector3(), yaw:0 };
mock.module(base+'core.js', () => ({ THREE:{Vector3} }));
mock.module(base+'base.js', () => ({CONFIG:{name:'self'},bus:{on:noop}}));
mock.module(base+'controller.js', () => ({myState,updateFollowCamera:noop,setPosture:noop,keys:new Set(),setSeatHook:noop}));
mock.module(base+'world.js', () => ({avatarMounts:new Map(),mountTransform:noop,comps,
  socketWorldPos:(id:string,_slot:string,v:Vector3)=>v.set(comps.get(id).x,0,0)}));
mock.module(base+'net.js', () => ({sendVerb:(...args:any[])=>sent.push(args),sendAnim:noop}));
mock.module(base+'bodysim.js', () => ({makeRagdoll:noop}));
mock.module(base+'ragdoll.js', () => ({jointPositions:noop}));
mock.module(base+'bodydrag.js', () => ({initBodyDrag:noop,beingDragged:()=>false,revokeDragged:noop}));
mock.module(base+'ui.js', () => ({toast:noop,flashHint:noop,setAmbientHint:noop}));
mock.module(base+'consent.js', () => ({posable:true,pushable:true}));
mock.module(base+'reachnet.js', () => ({clearMyReach:noop}));
mock.module(base+'mybody.js', () => ({getMe:()=>null}));
const {trySitOn} = await import(base+'localbody.js');
const {COMMANDS} = await import(base+'commands/registry.js');
// Names that previously hijacked the accidental fallback, even far away.
comps.set('ground-bench',{x:3,sockets:{seat:{}}});
comps.set('here-chair',{x:20,sockets:{seat:{}}});
for(const arg of ['ground','here',' GROUND ','Here']) {
  assert.equal(trySitOn(arg),false,`${arg} returns to ground posture`);
  assert.equal(sent.length,0,'explicit ground never emits mount');
  assert.deepEqual([myState.pos.x,myState.pos.y,myState.pos.z],[0,0,0]);
}
assert.equal(trySitOn(null),true,'ordinary sit keeps existing 3.5m discovery');
assert.deepEqual(sent.pop(),['mount',{id:'self',to:'ground-bench',slot:'seat'}]);
assert.equal(trySitOn('here-chair'),true,'full entity IDs remain selectable');
assert.deepEqual(sent.pop(),['mount',{id:'self',to:'here-chair',slot:'seat'}]);
comps.clear();
assert.equal(trySitOn(null),false,'no seat keeps ground fallback');
assert.equal(sent.length,0);
assert.match(COMMANDS.find((c:any)=>c.name==='sit').help,/\/sit ground/);
console.log('ground-sit: explicit bypass, conflicting IDs, named/automatic seats and help passed');
