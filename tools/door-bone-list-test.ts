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

let serve: () => Promise<Response> = async () => new Response('down', { status: 503 });
let fetches = 0;
(globalThis as any).fetch = async () => { fetches++; return serve(); };
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

console.log('\nTHE NEXT ACT READS AGAIN');
serve = async () => new Response(glb(WINGED));
r = await ag.takeOff();
check('once the model can be read, the same body takes off', /took off/.test(text(r)), text(r));
check('the bones are now known', Array.isArray(ag.bodyBoneNames) && ag.bodyBoneNames.length === WINGED.length);
let before = fetches;
await ag.loadBodyBones();
check('a successful read is kept: the next act reads no model', fetches === before, `${fetches - before} more`);

console.log('\nA BODY THAT REALLY HAS NO BONES');
const bare: any = new WorldAgent({ name: 'statue', world: 'bone-bench' });
bare.avatar = 'statue.vrm';
bare.myRights = { role: 'builder', fly: true };
serve = async () => new Response(glb([]));
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
r = await bee.takeOff();
check("a mis-named wing rig takes off, told its wings won't animate and why", /took off/.test(text(r)) && /won't animate/.test(text(r)) && /Wing_Left_High_Base/.test(text(r)), text(r));
bee.flight = null;
r = await bee.takeOff();
check('...once: the next take-off says nothing more', /took off/.test(text(r)) && !/won't animate/.test(text(r)), text(r));

console.warn = realWarn;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
