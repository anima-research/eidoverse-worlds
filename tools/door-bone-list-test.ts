// door-bone-list-test — the door's list of the worn body's bones is unknown
// until it has been read, and a failed read isn't kept as "no bones".
//
//   bun tools/door-bone-list-test.ts
//
// An empty list means a body with no bones, so the flight check reads it as
// a body missing its hips, spine and head. Before this, a failed fetch of the
// worn model was cached as that empty list until the avatar changed: every
// flight act was refused for a skeleton the body has, and fold_wings said it
// had no wings.

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
let r = await ag.takeOff();
check('take_off says the bones aren\'t known, not that the skeleton lacks them',
  /bones aren't known/.test(text(r)) && !/hip|spine|head/i.test(text(r)), text(r));
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
check('an empty list read from the model is kept, and still refused for its skeleton',
  Array.isArray(bare.bodyBoneNames) && bare.bodyBoneNames.length === 0 && /hip|spine|head/i.test(text(r)), text(r));
r = await bare.foldWings(true);
check('fold_wings on a body read as empty says it has no wings', r === 'this body has no animatable wings to fold', text(r));

console.log('\nA FOLDED BODY CAN ALWAYS UNFOLD');
const vigil: any = new WorldAgent({ name: 'vigil', world: 'bone-bench' });
vigil.avatar = 'vigil.vrm';
vigil.wingsFolded = true;   // folded before its model became unreadable
serve = DOWN;
r = await vigil.foldWings(false);
check('unfold_wings releases a folded posture while the bones are unknown',
  vigil.wingsFolded === false && /^folded-wing posture released — this body's bones aren't known/.test(text(r)), text(r));

console.log('\nA BENCH RIG ISN\'T THE WORN BODY');
const bench: any = new WorldAgent({ name: 'mythos', world: 'bone-bench' });
bench.avatar = 'unread.vrm';
bench.flightCap = devFlightProvider({ allow: ['mythos'], bones: WINGED });
r = await bench.takeOff();
check("a bench provider doesn't fly an unread body on its constructor's rig",
  !/took off/.test(text(r)) && /bones aren't known/.test(text(r)), text(r));

console.log('\nAN AVATAR CHANGE');
const worn: any = new WorldAgent({ name: 'mythos', world: 'bone-bench' });
worn.avatar = 'mythos-wings.vrm';
worn.myRights = { role: 'builder', fly: true };
serve = async () => new Response(glb(WINGED));
await worn.loadBodyBones();
worn.setAvatar('wingless.vrm');
serve = DOWN;
r = await worn.takeOff();
check("after a swap the old body's bones aren't used: the new body's are unknown until read",
  worn.bodyBoneNames === null && /bones aren't known/.test(text(r)), text(r));

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

console.warn = realWarn;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
