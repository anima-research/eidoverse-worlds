// door-bone-list-test — the door's list of the worn body's bones is unknown
// until it has been read, and a failed read isn't kept as "no bones".
//
//   bun tools/door-bone-list-test.ts
//
// An empty list means a body with no bones, so fold_wings reads it as a body with no wings. Before this, a failed fetch
// of the worn model was cached as that empty list until the avatar changed. Flight never waits on the bones (the
// grant decides, shared/flightcap.js); the fold does, and a fold carried into a wingless body is released.

import { WorldAgent } from '../mcpl/agent.ts';
import { devFlightProvider } from '../shared/flightcap.js';
import { tryUntil } from './protocol/wait.ts';

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}
const text = (r: unknown) => (typeof r === 'string' ? r : String((r as any)?.text ?? ''));

/** A GLB whose JSON chunk names these nodes: all loadBodyBones reads. */
function glb(names: string[]): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify({ nodes: names.map((name) => ({ name })) }));
  const out = new Uint8Array(20 + json.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, json.length, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(json, 20);
  return out.buffer;
}
const WINGED = ['Hip', 'Spine02', 'Head', 'L_Wing_Upper', 'L_Wing_Upper_1', 'R_Wing_Upper', 'R_Wing_Upper_1', 'L_Wing_Lower', 'R_Wing_Lower'];

let serve: (o?: any) => Promise<Response> = async () => new Response('down', { status: 503 });
let fetches = 0;
(globalThis as any).fetch = async (_u: unknown, o?: any) => { fetches++; return serve(o); };
const DOWN = async () => new Response('down', { status: 503 });

const ag: any = new WorldAgent({ name: 'mythos', world: 'bone-bench' });
ag.avatar = 'mythos-wings.vrm';
ag.myRights = { role: 'builder', fly: true };
const realWarn = console.warn; const warned: string[] = [];
console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };

console.log('\nA FAILED READ');
const blind: any = new WorldAgent({ name: 'blind', world: 'bone-bench' });
blind.avatar = 'mythos-wings.vrm';
blind.myRights = { role: 'builder', fly: true };
let r = await blind.takeOff();
check("take_off doesn't need the bones: an unreadable body takes off with the grant", /took off/.test(text(r)), text(r));
r = await ag.loadBodyBones();
check('the failed read is not kept as an empty list', ag.bodyBoneNames === null);
check('the failure goes to the door\'s log', warned.some((l) => /couldn't read the bones of mythos-wings\.vrm: 503/.test(l)), warned.join(' | '));
r = await ag.foldWings(true);
check('fold_wings says the bones aren\'t known, not that the body has no wings',
  /^wings unchanged — this body's bones aren't known .*; calling again reads the model again$/.test(text(r)) &&
  !/no animatable wings/.test(text(r)), text(r));

console.log('\nA FAILED READ IS KEPT, UNTIL A FOLD ASKS AGAIN');
serve = async () => new Response(glb(WINGED));
let before = fetches;
await ag.loadBodyBones();
check('a failed read is not refetched by the next act', fetches === before && ag.bodyBoneNames === null, `${fetches - before} more`);
r = await ag.foldWings(true);
check('fold_wings reads the model again, as it says, and folds', fetches === before + 1 && ag.wingsFolded === true, text(r));
check('the bones are now known', Array.isArray(ag.bodyBoneNames) && ag.bodyBoneNames.length === WINGED.length);
await ag.foldWings(false);
before = fetches;
await ag.loadBodyBones();
check('a successful read is kept: the next act reads no model', fetches === before, `${fetches - before} more`);

console.log('\nA BODY THAT REALLY HAS NO BONES');
const bare: any = new WorldAgent({ name: 'statue', world: 'bone-bench' });
bare.avatar = 'statue.vrm';
bare.myRights = { role: 'builder', fly: true };
serve = async () => new Response(glb([]));
await bare.loadBodyBones();
r = await bare.takeOff();
check('an empty list read from the model is kept, and the body takes off with the grant (no skeleton is asked for)',
  Array.isArray(bare.bodyBoneNames) && bare.bodyBoneNames.length === 0 && /took off/.test(text(r)), text(r));
r = await bare.foldWings(true);
check('fold_wings on a body read as empty says it has no wings', text(r) === 'this body has no animatable wings to fold', text(r));

console.log('\nA FOLDED BODY CAN ALWAYS UNFOLD');
const vigil: any = new WorldAgent({ name: 'vigil', world: 'bone-bench' });
vigil.avatar = 'vigil.vrm';
vigil.wingsFolded = true;   // folded before its model became unreadable
serve = DOWN;
r = await vigil.foldWings(false);
check('unfold_wings releases a folded posture while the bones are unknown',
  vigil.wingsFolded === false && /^folded-wing posture released — this body's bones aren't known/.test(text(r)), text(r));

console.log('\nA BENCH GRANT ASKS NO BODY');
const bench: any = new WorldAgent({ name: 'mythos', world: 'bone-bench' });
bench.avatar = 'unread.vrm';
bench.flightCap = devFlightProvider({ allow: ['mythos'] });
r = await bench.takeOff();
check('a bench provider flies its allow-listed pilot whatever the body, read or not', /took off/.test(text(r)), text(r));

console.log('\nAN AVATAR CHANGE');
const worn: any = new WorldAgent({ name: 'mythos', world: 'bone-bench' });
worn.avatar = 'mythos-wings.vrm';
worn.myRights = { role: 'builder', fly: true };
serve = async () => new Response(glb(WINGED));
await worn.loadBodyBones();
worn.setAvatar('wingless.vrm');
serve = DOWN;
r = await worn.takeOff();
check("after a swap the old body's bones aren't used (the new body's are unknown until read), and take-off doesn't wait for them",
  worn.bodyBoneNames === null && /took off/.test(text(r)), text(r));

// A no-op until the fetch is made, so a read served from a cache fails the check rather than the run.
let release: () => void = () => {};
serve = () => new Promise<Response>((done) => { release = () => done(new Response(glb(WINGED))); });
const late = worn.loadBodyBones();
worn.setAvatar('another.vrm');
release();
await late;
check("a read that finishes after a swap isn't kept as the new body's bones", worn.bodyBoneNames === null);

console.log('\nTWO READS AT ONCE');
const two: any = new WorldAgent({ name: 'mythos', world: 'bone-bench' });
two.avatar = 'mythos-wings.vrm';
let failLate: () => void = () => {};
serve = () => new Promise<Response>((done) => { failLate = () => done(new Response('down', { status: 503 })); });
const slow = two.loadBodyBones();
serve = async () => new Response(glb(WINGED));
await two.loadBodyBones();
failLate();
await slow;
check("a failed read doesn't clear the list another read just stored",
  Array.isArray(two.bodyBoneNames) && two.bodyBoneNames.length === WINGED.length);

console.log('\nA FOLD DOES NOT RIDE INTO A WINGLESS BODY');
const vig: any = new WorldAgent({ name: 'vig', world: 'bone-bench' });
vig.avatar = 'mythos-wings.vrm';
vig.myRights = { role: 'builder', fly: true };
serve = async () => new Response(glb(WINGED));
await vig.loadBodyBones();
r = await vig.foldWings(true);
check('(setup) the winged body folds', vig.wingsFolded === true, text(r));
serve = async () => new Response(glb(['Hips', 'Spine', 'Head']));
vig.setAvatar('wingless.vrm');
await vig.loadBodyBones();
check('a swap to a wingless body releases the fold once its bones are read', vig.wingsFolded === false);
r = await vig.takeOff();
check("...so take_off isn't refused for wings it doesn't have", /took off/.test(text(r)) && !/folded/.test(text(r)), text(r));
const keep: any = new WorldAgent({ name: 'keep', world: 'bone-bench' });
keep.avatar = 'mythos-wings.vrm';
serve = async () => new Response(glb(WINGED));
await keep.loadBodyBones();
await keep.foldWings(true);
keep.setAvatar('mythos-wings-2.vrm');
await keep.loadBodyBones();
check('a swap to another winged body keeps the fold (it is a posture the new wings can hold)', keep.wingsFolded === true);

console.log('\nDEAD WINGS ARE SAID ONCE');
const bee: any = new WorldAgent({ name: 'bee', world: 'bone-bench' });
bee.avatar = 'tigerbee.vrm';
bee.myRights = { role: 'builder', fly: true };
serve = async () => new Response(glb(['Hips', 'Spine', 'Head', 'Wings', 'Wing_Left_High_Base', 'Wing_Left_High1', 'Wing_Right_High_Base']));
await bee.loadBodyBones();   // take_off doesn't wait on a read; a body read before it is told
r = await bee.takeOff();
check("a mis-named wing rig takes off, told your wings won't animate and why", /took off/.test(text(r)) && /your wings won't animate/.test(text(r)) && /Wing_Left_High_Base/.test(text(r)), text(r));
bee.flight = null;
r = await bee.takeOff();
check('...once: the next take-off says nothing more', /took off/.test(text(r)) && !/won't animate/.test(text(r)), text(r));

console.log('\nTAKE-OFF NEVER WAITS ON THE LIBRARY');
const hang = (o?: any) => new Promise<Response>((_, fail) => o?.signal?.addEventListener('abort', () => fail(o.signal.reason)));
const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<string>((done) => setTimeout(() => done('(no answer)'), ms))]);
const open_: any = new WorldAgent({ name: 'open', world: 'bone-bench' });
open_.avatar = 'stalled.vrm'; open_.myRights = { role: 'builder', fly: true };
serve = hang;
r = await within(open_.takeOff(), 1000);
check('with the library stalled, an unfolded take_off answers at once, and flies', /took off/.test(text(r)), text(r));
const shut: any = new WorldAgent({ name: 'shut', world: 'bone-bench' });
shut.avatar = 'stalled.vrm'; shut.myRights = { role: 'builder', fly: true }; shut.wingsFolded = true;
const t0 = Date.now();
r = await within(shut.takeOff(), 15000);
check("a folded one answers once the read times out, keeping the fold it can't check", /folded/.test(text(r)) && shut.wingsFolded === true && Date.now() - t0 < 12000, `${Date.now() - t0} ms: ${text(r)}`);
before = fetches;
r = await within(shut.takeOff(), 1000);
check('...and the timed-out read is kept: the next take_off neither refetches nor waits', fetches === before && /folded/.test(text(r)), `${fetches - before} more: ${text(r)}`);

console.log('\nA SWAP RELEASES A FOLD WITHOUT BEING ASKED');
const kick: any = new WorldAgent({ name: 'kick', world: 'bone-bench' });
kick.avatar = 'mythos-wings.vrm';
serve = async () => new Response(glb(WINGED));
await kick.loadBodyBones(); await kick.foldWings(true);
serve = async () => new Response(glb(['Hips', 'Spine', 'Head']));
kick.setAvatar('wingless.vrm');
const released = await tryUntil('the swap reads the new body and releases the fold', () => kick.wingsFolded === false, { ms: 2000, step: 5 });
check("the new body's bones are read on the swap, so its presence stops showing a fold it can't hold", released && kick.wingsFolded === false);

console.log('\nA RESTORED FOLD FITS THE BODY');
{
  const RealWS = globalThis.WebSocket;
  class FakeWS { readyState = 1; onopen: any; onclose: any; onmessage: any; onerror: any; send() {} close() {} }
  (globalThis as any).WebSocket = FakeWS;
  const back: any = new WorldAgent({ name: 'back', world: 'bone-bench' });
  back.avatar = 'wingless.vrm';
  serve = async () => new Response(glb(['Hips', 'Spine', 'Head']));
  await back.loadBodyBones();
  back.connect().catch(() => {});
  await back.ws.onmessage({ data: JSON.stringify({ type: 'snapshot', present: [], restore: { p: [3, 0, 4], yaw: 0, poses: ['wings-folded'] } }) });
  (globalThis as any).WebSocket = RealWS;
  check('a fold remembered from a winged body is not restored onto this wingless one', back.restoredPose === true && back.wingsFolded === false, `restored ${back.restoredPose}, folded ${back.wingsFolded}`);
}

console.warn = realWarn;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
