// door-bone-list-test — the door's list of the worn body's bones is unknown
// until it has been read, and a failed read isn't kept as "no bones".
//
//   bun test/mcpl/door-bone-list-test.ts
//
// An empty list means a body with no bones, so fold_wings reads it as a body with no wings: a failed fetch kept as
// that list would say a winged body has none. Flight never waits on the bones (the grant decides,
// shared/flightcap.js); the fold does, and a fold carried into a wingless body is released.

import { noWorldUrl } from '../harness/no-world.ts';
import { WorldAgent } from '../../mcpl/agent.ts';
import { devFlightProvider } from '../../shared/flightcap.js';
import { rigBonesFor, bodyHeightFor } from '../../mcpl/rigbones.ts';
import { suite } from "../gate/suite.ts";
import { tryUntil } from "../gate/wait.ts";

const S = suite("door-bone-list");
const check = (name: string, ok: unknown, detail?: unknown) => S.check(name, ok, detail);
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

const ag: any = new WorldAgent({ url: noWorldUrl(), name: 'mythos', world: 'bone-bench' });
ag.avatar = 'mythos-wings.vrm';
ag.myRights = { role: 'builder', fly: true };
const realWarn = console.warn; const warned: string[] = [];
console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };

console.log('\nA FAILED READ');
const blind: any = new WorldAgent({ url: noWorldUrl(), name: 'blind', world: 'bone-bench' });
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

console.log('\nA FAILED READ ISN\'T KEPT: THE NEXT FOLD READS AGAIN');
serve = async () => new Response(glb(WINGED));
let before = fetches;
r = await ag.foldWings(true);
check('fold_wings reads the model again, as it says, and folds', fetches === before + 1 && ag.wingsFolded === true, text(r));
check('the bones are now known', Array.isArray(ag.bodyBoneNames) && ag.bodyBoneNames.length === WINGED.length);
await ag.foldWings(false);
before = fetches;
await ag.loadBodyBones();
check('a successful read is kept: the next act reads no model', fetches === before, `${fetches - before} more`);

console.log('\nA BODY THAT REALLY HAS NO BONES');
const bare: any = new WorldAgent({ url: noWorldUrl(), name: 'statue', world: 'bone-bench' });
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
const vigil: any = new WorldAgent({ url: noWorldUrl(), name: 'vigil', world: 'bone-bench' });
vigil.avatar = 'vigil.vrm';
vigil.wingsFolded = true;   // folded before its model became unreadable
serve = DOWN;
r = await vigil.foldWings(false);
check('unfold_wings releases a folded posture while the bones are unknown',
  vigil.wingsFolded === false && /^folded-wing posture released — this body's bones aren't known/.test(text(r)), text(r));

console.log('\nA BENCH GRANT ASKS NO BODY');
const bench: any = new WorldAgent({ url: noWorldUrl(), name: 'mythos', world: 'bone-bench' });
bench.avatar = 'unread.vrm';
bench.flightCap = devFlightProvider({ allow: ['mythos'] });
r = await bench.takeOff();
check('a bench provider flies its allow-listed pilot whatever the body, read or not', /took off/.test(text(r)), text(r));

console.log('\nAN AVATAR CHANGE');
const worn: any = new WorldAgent({ url: noWorldUrl(), name: 'mythos', world: 'bone-bench' });
worn.avatar = 'mythos-wings.vrm';
worn.myRights = { role: 'builder', fly: true };
serve = async () => new Response(glb(WINGED));
await worn.loadBodyBones();
worn.setAvatar('wingless.vrm');
serve = DOWN;
r = await worn.takeOff();
check("after a swap the old body's bones aren't used (the new body's are unknown until read), and take-off doesn't wait for them",
  worn.bodyBoneNames === null && /took off/.test(text(r)), text(r));

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

console.log('\nA FOLD DOES NOT RIDE INTO A WINGLESS BODY');
const vig: any = new WorldAgent({ url: noWorldUrl(), name: 'vig', world: 'bone-bench' });
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
check("...so take_off isn't refused for wings it doesn't have (and says the swap released the fold)", /^took off/.test(text(r)) && !/wings are folded|fold is held/.test(text(r)) && /posture released/.test(text(r)), text(r));
const keep: any = new WorldAgent({ url: noWorldUrl(), name: 'keep', world: 'bone-bench' });
keep.avatar = 'mythos-wings.vrm';
serve = async () => new Response(glb(WINGED));
await keep.loadBodyBones();
await keep.foldWings(true);
keep.setAvatar('mythos-wings-2.vrm');
await keep.loadBodyBones();
check('a swap to another winged body keeps the fold (it is a posture the new wings can hold)', keep.wingsFolded === true);

console.log('\nDEAD WINGS ARE SAID ONCE');
const bee: any = new WorldAgent({ url: noWorldUrl(), name: 'bee', world: 'bone-bench' });
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
const open_: any = new WorldAgent({ url: noWorldUrl(), name: 'open', world: 'bone-bench' });
open_.avatar = 'stalled.vrm'; open_.myRights = { role: 'builder', fly: true };
serve = hang;
r = await within(open_.takeOff(), 1000);
check('with the library stalled, an unfolded take_off answers at once, and flies', /took off/.test(text(r)), text(r));
const shut: any = new WorldAgent({ url: noWorldUrl(), name: 'shut', world: 'bone-bench' });
shut.avatar = 'stalled.vrm'; shut.myRights = { role: 'builder', fly: true }; shut.wingsFolded = true;
const t0 = Date.now();
r = await within(shut.takeOff(), 15000);
check("a folded one answers once the read times out, keeping the fold it can't check, and not claiming wings it hasn't read",
  /a fold is held/.test(text(r)) && /weren't read/.test(text(r)) && !/your wings are folded/.test(text(r)) && shut.wingsFolded === true && Date.now() - t0 < 12000, `${Date.now() - t0} ms: ${text(r)}`);
before = fetches;
r = await within(shut.takeOff(), 1000);
check("...and the next take_off doesn't wait on the library again (its read runs alongside), still keeping the fold", /a fold is held/.test(text(r)) && shut.wingsFolded === true, `${fetches - before} more: ${text(r)}`);

console.log('\nA SWAP RELEASES A FOLD WITHOUT BEING ASKED');
const kick: any = new WorldAgent({ url: noWorldUrl(), name: 'kick', world: 'bone-bench' });
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
  const back: any = new WorldAgent({ url: noWorldUrl(), name: 'back', world: 'bone-bench' });
  back.avatar = 'wingless.vrm';
  serve = async () => new Response(glb(['Hips', 'Spine', 'Head']));
  await back.loadBodyBones();
  back.connect().catch(() => {});
  await back.ws.onmessage({ data: JSON.stringify({ type: 'snapshot', present: [], restore: { p: [3, 0, 4], yaw: 0, poses: ['wings-folded'] } }) });
  (globalThis as any).WebSocket = RealWS;
  check('a fold remembered from a winged body is not restored onto this wingless one', back.restoredPose === true && back.wingsFolded === false, `restored ${back.restoredPose}, folded ${back.wingsFolded}`);
}

console.log('\nA FRESH JOIN FITS A RESTORED FOLD');
{
  const RealWS = globalThis.WebSocket;
  class FakeWS { readyState = 1; onopen: any; onclose: any; onmessage: any; onerror: any; send() {} close() {} }
  (globalThis as any).WebSocket = FakeWS;
  const fresh: any = new WorldAgent({ url: noWorldUrl(), name: 'fresh', world: 'bone-bench' });
  fresh.avatar = 'wingless.vrm';
  serve = async () => new Response(glb(['Hips', 'Spine', 'Head']));
  const asked = fetches;
  fresh.connect().catch(() => {});
  await fresh.ws.onmessage({ data: JSON.stringify({ type: 'snapshot', present: [], restore: { p: [3, 0, 4], yaw: 0, poses: ['wings-folded'] } }) });
  (globalThis as any).WebSocket = RealWS;
  const released = await tryUntil('the restore reads the body and releases the fold', () => fresh.wingsFolded === false, { ms: 2000, step: 5 });
  check('a fold restored with the bones not yet read (first join) is released once they are, by one read', released && fresh.wingsFolded === false && fetches === asked + 1, `folded ${fresh.wingsFolded}; ${fetches - asked} reads`);
}

console.log('\nA RELEASE IS SAID, WHEREVER IT HAPPENS');
{
  const RealWS = globalThis.WebSocket;
  class FakeWS { readyState = 1; onopen: any; onclose: any; onmessage: any; onerror: any; send() {} close() {} }
  (globalThis as any).WebSocket = FakeWS;
  const quiet: any = new WorldAgent({ url: noWorldUrl(), name: 'quiet', world: 'bone-bench' });
  quiet.avatar = 'wingless.vrm';
  serve = async () => new Response(glb(['Hips', 'Spine', 'Head']));
  await quiet.loadBodyBones();
  quiet.connect().catch(() => {});
  await quiet.ws.onmessage({ data: JSON.stringify({ type: 'snapshot', present: [], restore: { p: [3, 0, 4], yaw: 0, poses: ['wings-folded'] } }) });
  (globalThis as any).WebSocket = RealWS;
  check('a fold a restore releases is said in the inbox', quiet.wingsFolded === false && quiet.inbox.some((e: any) => /folded-wing posture released — this body has no wings/.test(e.text ?? '')),
    JSON.stringify(quiet.inbox.map((e: any) => e.text)));
}
const raced: any = new WorldAgent({ url: noWorldUrl(), name: 'raced', world: 'bone-bench' });
raced.avatar = 'mythos-wings.vrm'; raced.myRights = { role: 'builder', fly: true };
serve = async () => new Response(glb(WINGED));
await raced.loadBodyBones(); await raced.foldWings(true);
serve = async () => new Response(glb(['Hips', 'Spine', 'Head']));
raced.setAvatar('wingless.vrm');
await tryUntil("the swap's own read releases the fold", () => raced.wingsFolded === false, { ms: 2000, step: 5 });
r = await raced.takeOff();
check("a take_off after the swap's read already released the fold still says the release", /^took off/.test(text(r)) && /folded-wing posture released/.test(text(r)), text(r));
const nogrant: any = new WorldAgent({ url: noWorldUrl(), name: 'nogrant', world: 'bone-bench' });
nogrant.avatar = 'wingless.vrm'; nogrant.myRights = { role: 'builder', fly: false }; nogrant.wingsFolded = true;
r = await nogrant.takeOff();
check('a take_off refused after its read released a fold says the release too', /cannot fly here/.test(text(r)) && /folded-wing posture released/.test(text(r)) && nogrant.wingsFolded === false, text(r));

console.log('\nA TAKE-OFF THAT RELEASES A FOLD SAYS SO');
const said_: any = new WorldAgent({ url: noWorldUrl(), name: 'said', world: 'bone-bench' });
said_.avatar = 'wingless.vrm'; said_.myRights = { role: 'builder', fly: true }; said_.wingsFolded = true;
serve = async () => new Response(glb(['Hips', 'Spine', 'Head']));
r = await said_.takeOff();
check('take_off on a wingless body carrying a fold flies, and says the fold was released, as the browser does',
  /^took off/.test(text(r)) && /folded-wing posture released — this body has no wings/.test(text(r)) && said_.wingsFolded === false, text(r));
check("flight_status of a wingless flier doesn't report wings it hasn't got", !/\bwings (OPEN|FOLDED|LIMP)\b/.test(said_.flightStatus()), said_.flightStatus());

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
