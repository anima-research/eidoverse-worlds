// door-bone-list-test — the door's list of the worn body's bones is unknown
// until it has been read, and a failed read isn't kept as "no bones".
//
//   bun test/mcpl/door-bone-list-test.ts
//
// An empty list means a body with no bones, so the flight check reads it as
// a body missing its hips, spine and head: a failed fetch kept as that list
// would refuse every flight act for a skeleton the body has, and fold_wings
// would say it has no wings.

import { noWorldUrl } from '../harness/no-world.ts';
import { WorldAgent } from '../../mcpl/agent.ts';
import { devFlightProvider } from '../../shared/flightcap.js';
import { rigBonesFor, bodyHeightFor } from '../../mcpl/rigbones.ts';
import { suite } from "../gate/suite.ts";
import { tryUntil } from "../gate/wait.ts";

const S = suite("door-bone-list");
const check = (name: string, ok: unknown, detail?: unknown) => S.check(name, ok, detail);
const text = (r: unknown) => (typeof r === 'string' ? r : String((r as any)?.text ?? ''));

/** A GLB whose JSON chunk names these nodes (and carries these extensions, e.g. a VRM humanoid map). */
function glb(names: string[], extensions?: object): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify({ nodes: names.map((name) => ({ name })), extensions }));
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

const ag: any = new WorldAgent({ url: noWorldUrl(), name: 'mythos', world: 'bone-bench' });
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
const bare: any = new WorldAgent({ url: noWorldUrl(), name: 'statue', world: 'bone-bench' });
bare.avatar = 'statue.vrm';
bare.myRights = { role: 'builder', fly: true };
serve = async () => new Response(glb([]));
r = await bare.takeOff();
check('an empty list read from the model is kept, and still refused for its skeleton',
  Array.isArray(bare.bodyBoneNames) && bare.bodyBoneNames.length === 0 && /hip|spine|head/i.test(text(r)), text(r));
r = await bare.foldWings(true);
check('fold_wings on a body read as empty says it has no wings', text(r) === 'this body has no animatable wings to fold', text(r));

console.log('\nA VRM NAMES ITS CORE IN ITS HUMANOID MAP');
// a VRoid export: core joints named J_Bip_C_*, found by the humanoid map (VRM1 and VRM0 shapes); the Tripo spelling
// with no map is the WINGED row above
const WINGS = WINGED.slice(3);
const VROID = ['J_Bip_C_Hips', 'J_Bip_C_Spine', 'J_Bip_C_Neck', 'J_Bip_C_Head', ...WINGS];
const vrm1 = (bones: Record<string, number>) => ({ VRMC_vrm: { specVersion: '1.0', humanoid: { humanBones:
  Object.fromEntries(Object.entries(bones).map(([b, node]) => [b, { node }])) } } });
const vrm0 = (bones: Record<string, number>) => ({ VRM: { humanoid: { humanBones:
  Object.entries(bones).map(([bone, node]) => ({ bone, node })) } } });
for (const [shape, ext] of [['VRM1', vrm1], ['VRM0', vrm0]] as const) {
  const vroid: any = new WorldAgent({ url: noWorldUrl(), name: 'gloss', world: 'bone-bench' });
  vroid.avatar = `vroid-${shape}.vrm`;
  vroid.myRights = { role: 'builder', fly: true };
  serve = async () => new Response(glb(VROID, ext({ hips: 0, spine: 1, neck: 2, head: 3 })));
  r = await vroid.takeOff();
  check(`a VRoid-named body (${shape}) whose humanoid map has hips, spine and head takes off`, /took off/.test(text(r)), text(r));
}
// a null entry in either map shape is skipped, not a reason to read the file as unknown
for (const [shape, ext] of [['VRM1', { VRMC_vrm: { humanoid: { humanBones: { hips: { node: 0 }, spine: { node: 1 }, head: { node: 3 }, leftEye: null } } } }],
                            ['VRM0', { VRM: { humanoid: { humanBones: [{ bone: 'hips', node: 0 }, null, { bone: 'spine', node: 1 }, { bone: 'head', node: 3 }] } } }]] as const) {
  const holey: any = new WorldAgent({ url: noWorldUrl(), name: 'gloss', world: 'bone-bench' });
  holey.avatar = `vroid-null-${shape}.vrm`;
  holey.myRights = { role: 'builder', fly: true };
  serve = async () => new Response(glb(VROID, ext));
  r = await holey.takeOff();
  check(`a ${shape} map with a null entry still yields the node names and flies`,
    holey.bodyBoneNames?.includes('J_Bip_C_Hips') && /took off/.test(text(r)), text(r));
}
const headless: any = new WorldAgent({ url: noWorldUrl(), name: 'gloss', world: 'bone-bench' });
headless.avatar = 'vroid-headless.vrm';
headless.myRights = { role: 'builder', fly: true };
serve = async () => new Response(glb(VROID.filter((b) => b !== 'J_Bip_C_Head'), vrm1({ hips: 0, spine: 1, neck: 2 })));
r = await headless.takeOff();
check('a VRM whose map and nodes have no head is still refused, naming the head',
  !/took off/.test(text(r)) && /missing: head\)/.test(text(r)), text(r));

console.log('\nA FOLDED BODY CAN ALWAYS UNFOLD');
const vigil: any = new WorldAgent({ url: noWorldUrl(), name: 'vigil', world: 'bone-bench' });
vigil.avatar = 'vigil.vrm';
vigil.wingsFolded = true;   // folded before its model became unreadable
serve = DOWN;
r = await vigil.foldWings(false);
check('unfold_wings releases a folded posture while the bones are unknown',
  vigil.wingsFolded === false && /^folded-wing posture released — this body's bones aren't known/.test(text(r)), text(r));

console.log('\nA BENCH RIG ISN\'T THE WORN BODY');
const bench: any = new WorldAgent({ url: noWorldUrl(), name: 'mythos', world: 'bone-bench' });
bench.avatar = 'unread.vrm';
bench.flightCap = devFlightProvider({ allow: ['mythos'], bones: WINGED });
r = await bench.takeOff();
check("a bench provider doesn't fly an unread body on its constructor's rig",
  !/took off/.test(text(r)) && /bones aren't known/.test(text(r)), text(r));

console.log('\nAN AVATAR CHANGE');
const worn: any = new WorldAgent({ url: noWorldUrl(), name: 'mythos', world: 'bone-bench' });
worn.avatar = 'mythos-wings.vrm';
worn.myRights = { role: 'builder', fly: true };
serve = async () => new Response(glb(WINGED));
await worn.loadBodyBones();
worn.setAvatar('wingless.vrm');
serve = DOWN;
r = await worn.takeOff();
check("after a swap the old body's bones aren't used: the new body's are unknown until read",
  worn.bodyBoneNames === null && /bones aren't known/.test(text(r)), text(r));

// the read must really be in flight at the swap: a read served without a fetch would pass the last clause vacuously
let release: () => void = () => {};
serve = () => new Promise<Response>((done) => { release = () => done(new Response(glb(WINGED))); });
const fetchedBefore = fetches;
const late = worn.loadBodyBones();
await tryUntil("the late read's fetch is made", () => fetches > fetchedBefore, { ms: 2000 });
worn.setAvatar('another.vrm');
release();
await late;
check("a read that finishes after a swap isn't kept as the new body's bones", fetches > fetchedBefore && worn.bodyBoneNames === null, `${fetches - fetchedBefore} fetch(es)`);

console.log('\nTWO READS AT ONCE');
const two: any = new WorldAgent({ url: noWorldUrl(), name: 'mythos', world: 'bone-bench' });
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

console.log('\nEVERY READER OF A BODY FILE: a failed download is never remembered, a good read is');
// (a model that downloads but can't be used IS remembered for its version: body-state-test.ts)
{
  // one humanoid body all three read: loadBodyBones its node names, rigBonesFor its bones, bodyHeightFor its stature
  const humanoid = (magic = 0x46546c67) => {
    const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [0] }],
      nodes: [{ name: 'Hips', translation: [0, 0.9, 0], children: [1] }, { name: 'Head', translation: [0, 0.47, 0] }],
      extensionsUsed: ['VRMC_vrm'], extensions: { VRMC_vrm: { specVersion: '1.0', humanoid: { humanBones: { hips: { node: 0 }, head: { node: 1 } } } } } }));
    const out = new Uint8Array(20 + json.length), dv = new DataView(out.buffer);
    dv.setUint32(0, magic, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
    dv.setUint32(12, json.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(json, 20);
    return out.buffer;
  };
  let n = 0; const bodies = new Map<string, any>();
  const READERS: Record<string, (path: string) => Promise<unknown>> = {
    loadBodyBones: (path) => { let a: any = bodies.get(path); if (!a) bodies.set(path, a = new WorldAgent({ url: noWorldUrl(), name: 'reader', world: 'bone-bench' })); a.avatar = path; return a.loadBodyBones(); },
    rigBonesFor: (path) => rigBonesFor('http://lib', path),
    bodyHeightFor: (path) => bodyHeightFor('http://lib', path).catch(() => null),   // a failed download rejects (#323)
  };
  const good = async () => new Response(humanoid());
  for (const [reader, read] of Object.entries(READERS)) {
    const path = () => `reader-${reader}-${++n}.vrm`;
    let p = path(); serve = DOWN;
    const failed = await read(p); serve = good;
    const then = await read(p);
    check(`${reader}: a failed read gives none, and the next read of the same file reads it`, failed == null && then != null, JSON.stringify({ failed, then }));
    p = path(); serve = good; const first = await read(p); serve = DOWN; const before = fetches;
    const again = await read(p);
    check(`${reader}: a good read is remembered: the next asks nothing of the server`, first != null && JSON.stringify(again) === JSON.stringify(first) && fetches === before, `${fetches - before} fetches`);
    // loadBodyBones never checks the glTF magic (agent.ts): a bad-magic row for it would be red today
    if (reader !== 'loadBodyBones') { p = path(); serve = async () => new Response(humanoid(0x12345678));
      check(`${reader}: a file whose header isn't glTF's gives none`, (await read(p)) == null); }
  }
}

console.warn = realWarn;
S.done();
