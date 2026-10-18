// put-settle-test.ts — a thing leaving a hand eases from where it was drawn to where the fold puts it (R 10-11 23:17,
// WISHLIST-desktop-test-2026-10-10.md: "Lerp on put/attach: presentation-only easing from the hand to the rest/attach
// pose over ~120 ms"). Headless, through the real client/lib/thingphysics.js with the real bus (base.js) and the real
// fold view + change events (state.js); the renderer, socket and DOM modules are stubbed (tools/put-settle-stub.mjs).
// The realizer's part (models.js refreshModel: the change writes the fold's pose onto the object) is played here by a
// subscriber registered AFTER thingphysics', the order main.js gives them (its import precedes initModelsRealizer()).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/put-settle-test.ts
//   … --mutant      the duration set to 0 through the lab knob: the pin must go red
//
// What must hold, after a rest row for a held thing (a 'pose' change while the authority's holds still name it):
//   t=0      the drawn pose is the hand's (position and rotation), not the rest's
//   t=60     between the two, on the segment, part way round
//   t≥120    exactly the rest pose, the object's own transform restored bit for bit (the truth never carried the ease)
//   a second authoritative move at t=30 restarts the ease from what was drawn, toward the new truth, with its own 120 ms
//   a grab at t=30 ends it: the hand's pull takes over from what was drawn
//   'gone' at t=30 ends it
//   the collider sits out the ease and comes back at the end; whereIs (what a request reads) is the truth throughout
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const STUB = here('./put-settle-stub.mjs');
plugin({
  name: 'put-settle-stubs',
  setup(b) {
    b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
    for (const m of ['world', 'remotes', 'colliders', 'autohooks', 'bodyscale', 'net', 'ui', 'chat', 'actions', 'emitters', 'serverclock', 'plainwords', 'markup', 'xrask'])
      b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: STUB }));
  },
});
const MUTANT = process.argv.includes('--mutant');

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const J = (x: any) => JSON.stringify(x, (_k, v) => typeof v === 'number' ? +v.toFixed(4) : v);

const S: any = await import('./put-settle-stub.mjs');
const { THREE } = await import('./core-stub.mjs');
const state: any = await import('../client/lib/state.js');
const { bus }: any = await import('../client/lib/base.js');
let T = 0;
const tick = (t: number) => { T = t; S.setClock(t); };
(globalThis.performance as any).now = () => T;
const tp: any = await import('../client/lib/thingphysics.js');
if (MUTANT) { check('the lab knob exists (physicsApi.settle)', typeof tp.physicsApi.settle === 'function'); tp.physicsApi.settle?.(0); }

// the realizer's part: a 'pose' change writes the fold's pose onto the object; 'gone' takes the object away
state.onWorldChange((ev: any) => {
  if (ev.type !== 'change') return;
  const obj = S.entities.get(ev.id), ent = state.state.st.entities[ev.id];
  if (ev.what === 'gone') { S.entities.delete(ev.id); return; }
  if (ev.what === 'pose' && obj && ent) { obj.position.set(...ent.pos); if (ent.q) obj.quaternion.set(...ent.q); obj.userData.base = { pos: [...ent.pos], q: [...(ent.q ?? [0, 0, 0, 1])] }; }
});

// …and models.js's 'pose-revert' (the fold's pose re-asserted on request)
bus.on('pose-revert', ({ id }: any) => { const obj = S.entities.get(id), ent = state.state.st.entities[id];
  if (obj && ent) { obj.position.set(...ent.pos); if (ent.q) obj.quaternion.set(...ent.q); } });

// me: a body at the origin facing +z (no VRM: the hand is in front of the chest, handOf's fallback)
const me = { root: new THREE.Object3D(), vrm: null };
tp.initThingPhysics({ myPos: () => me.root.position, me: () => me, camera: null, editing: () => false, myState: () => ({ yaw: 0 }) });
const frame = () => { for (const fn of S.hostHooks) fn(); };
const scene = new THREE.Scene();
const crate = new THREE.Group(); crate.name = 'crate'; scene.add(crate);
S.entities.set('crate', crate);
S.replica.st.entities.crate = { c: {} };
const q0 = [0, 0, 0, 1], qRest = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.2).toArray();
const view = (pos: number[], q = q0) => ({ entities: { crate: { kind: 'model', lib: 'x.glb', pos, q } } });
state.applyView(view([0, 0, 0]));
crate.position.set(0, 0, 0);
const world = (o: any) => { o.updateWorldMatrix(true, false); return { p: o.getWorldPosition(new THREE.Vector3()), q: o.getWorldQuaternion(new THREE.Quaternion()) }; };
const same = (a: any, b: any, eps = 1e-6) => a.p.distanceTo(b.p) <= eps && Math.abs(Math.abs(a.q.dot(b.q)) - 1) <= eps;
const between = (x: any, a: any, b: any) => { const d = a.p.distanceTo(b.p), da = x.p.distanceTo(a.p), db = x.p.distanceTo(b.p);
  return da > 1e-3 && db > 1e-3 && Math.abs(da + db - d) < 1e-6 && x.q.angleTo(a.q) > 1e-3 && x.q.angleTo(b.q) > 1e-3; };

// ---- pick it up, and let the pull into the hand finish
tick(0); bus.emit('holds', { crate: { by: 'me' } });
for (let t = 0; t <= 600; t += 16) { tick(t); frame(); }
const HAND = world(crate);
check('held: drawn in the hand, off the floor', HAND.p.y > 0.5 && HAND.p.z > 0.1, J(HAND.p.toArray()));
const T0 = 1000;

// ---- the rest row: the fold moves it while the authority still says it's held
const REST = [2, 0, 2];
tick(T0); state.applyView(view(REST, qRest));
const restTruth = { p: new THREE.Vector3(...REST), q: new THREE.Quaternion(...qRest) };
check('the hold is over for this client as soon as the row lands', !tp.physicsApi.holds().crate);
check('the truth took the rest at once (the object\'s own transform, before any frame)', crate.position.distanceTo(restTruth.p) < 1e-9);
frame();
const at0 = world(crate);
check('t=0: drawn where the hand had it', same(at0, HAND, 1e-4), `drawn ${J(at0.p.toArray())} hand ${J(HAND.p.toArray())}`);
check('t=0: whereIs (what a request reads) is the rest, not the drawn pose', J(tp.physicsApi.whereIs?.('crate') ?? null) === J(REST), J(tp.physicsApi.whereIs?.('crate')));
check('t=0: the collider sits the ease out', S.suspended.has('crate'), J(S.colliderLog.slice(-3)));
tick(T0 + 60); frame();
const at60 = world(crate);
check('t=60: between the hand and the rest (on the segment, part way round)', between(at60, HAND, restTruth), `drawn ${J(at60.p.toArray())} q ${J(at60.q.toArray())} hand q ${J(HAND.q.toArray())} angles ${at60.q.angleTo(HAND.q).toFixed(3)} ${at60.q.angleTo(restTruth.q).toFixed(3)}`);
check('t=60: more than half-way (ease-out)', at60.p.distanceTo(restTruth.p) < at60.p.distanceTo(HAND.p), `${at60.p.distanceTo(HAND.p).toFixed(3)} gone, ${at60.p.distanceTo(restTruth.p).toFixed(3)} left`);
tick(T0 + 90); frame();
const at90 = world(crate);
check('t=90: still closing (monotone)', at90.p.distanceTo(restTruth.p) < at60.p.distanceTo(restTruth.p));
tick(T0 + 120); frame();
const at120 = world(crate);
check('t=120: exactly the rest pose', same(at120, restTruth, 1e-9), `drawn ${J(at120.p.toArray())}`);
check('t=120: the object\'s own transform is the truth bit for bit', crate.position.equals(restTruth.p) && crate.quaternion.equals(restTruth.q));
check('t=120: the collider is back', !S.suspended.has('crate') && S.colliderLog.at(-1)?.[1] === false, J(S.colliderLog.slice(-3)));
check('t=120: the ease is over (nothing left settling)', !(tp.physicsApi.settling?.() ?? []).length, J(tp.physicsApi.settling?.()));
tick(T0 + 400); frame();
check('t=400: nothing moves it after', same(world(crate), restTruth, 1e-9));
check('nothing was sent', S.sent.length === 0, J(S.sent));

// ---- a second authoritative move at t=30 restarts the ease from what was drawn, with its own 120 ms
const T1 = 5000;
tick(T1 - 1000); bus.emit('holds', { crate: { by: 'me' } });
for (let t = T1 - 1000; t < T1; t += 16) { tick(t); frame(); }
const HAND1 = world(crate);
tick(T1); state.applyView(view([4, 0, 1], q0)); frame();
tick(T1 + 30); frame();
const drawn30 = world(crate);
const REST2 = [6, 0, -2];
state.applyView(view(REST2, qRest)); frame();
const rest2 = { p: new THREE.Vector3(...REST2), q: new THREE.Quaternion(...qRest) };
const at30b = world(crate);
check('second move at t=30: drawn where it was (no jump)', same(at30b, drawn30, 1e-4), `drawn ${J(at30b.p.toArray())} was ${J(drawn30.p.toArray())}`);
tick(T1 + 90); frame();
const at90b = world(crate);
check('second move: 60 ms in, between what was drawn and the new truth', between(at90b, drawn30, rest2), `drawn ${J(at90b.p.toArray())}`);
tick(T1 + 149); frame();
check('second move: 119 ms in, not there yet', !same(world(crate), rest2, 1e-6));
tick(T1 + 150); frame();
check('second move: 120 ms in, exactly the new truth', same(world(crate), rest2, 1e-9), J(world(crate).p.toArray()));
check('…and nothing left settling', !(tp.physicsApi.settling?.() ?? []).length);

// ---- a grab at t=30 ends the ease: the hand's pull takes over from what was drawn
const T2 = 9000;
tick(T2 - 1000); bus.emit('holds', { crate: { by: 'me' } });
for (let t = T2 - 1000; t < T2; t += 16) { tick(t); frame(); }
tick(T2); state.applyView(view([1, 0, 3], q0)); frame();
tick(T2 + 30); frame();
const drawnG = world(crate);
bus.emit('holds', { crate: { by: 'me' } }); frame();
check('grab at t=30: the ease is gone', !(tp.physicsApi.settling?.() ?? []).length, J(tp.physicsApi.settling?.()));
check('grab at t=30: drawn where it was (the pull starts there)', same(world(crate), drawnG, 1e-4), J(world(crate).p.toArray()));
for (let t = T2 + 30; t <= T2 + 600; t += 16) { tick(t); frame(); }
check('grab at t=30: in the hand again after the pull (its turn is the one it was taken with: heldTurn)', world(crate).p.distanceTo(HAND.p) < 1e-4, J(world(crate).p.toArray()));

// ---- a component change mid-ease is not a move: the ease goes on
const T4 = 11000;
tick(T4 - 1000); bus.emit('holds', { crate: { by: 'me' } });
for (let t = T4 - 1000; t < T4; t += 16) { tick(t); frame(); }
tick(T4); state.applyView(view([1, 0, 4], q0)); frame();
tick(T4 + 30); frame();
state.applyView({ entities: { crate: { kind: 'model', lib: 'x.glb', pos: [1, 0, 4], q: q0, comp: { label: { text: 'hi' } } } } }); frame();
check('a comp change mid-ease: still easing', (tp.physicsApi.settling?.() ?? []).includes('crate'), J(tp.physicsApi.settling?.()));
tick(T4 + 120); frame();
check('a comp change mid-ease: arrives at the truth', same(world(crate), { p: new THREE.Vector3(1, 0, 4), q: new THREE.Quaternion() }, 1e-9), J(world(crate).p.toArray()));
state.applyView(view([1, 0, 4], q0));

// ---- gone at t=30 ends it
const T3 = 12000;
tick(T3 - 1000); bus.emit('holds', { crate: { by: 'me' } });
for (let t = T3 - 1000; t < T3; t += 16) { tick(t); frame(); }
tick(T3); state.applyView(view([1, 0, 5], q0)); frame();
tick(T3 + 30); frame();
check('gone: an ease was on', (tp.physicsApi.settling?.() ?? []).length === 1);
state.applyView({ entities: {} }); frame();
check('gone at t=30: the ease is gone with the thing', !(tp.physicsApi.settling?.() ?? []).length, J(tp.physicsApi.settling?.()));

// ---- a put back to the very pose it had: no row moves it (the fold didn't change), the hold just ends — eased all the same
const T5 = 15000;
state.applyView(view([3, 0, 3], q0)); S.entities.set('crate', crate); crate.position.set(3, 0, 3); crate.quaternion.identity();   // born again after the 'gone' above
tick(T5 - 1000); bus.emit('holds', { crate: { by: 'me' } });
for (let t = T5 - 1000; t < T5; t += 16) { tick(t); frame(); }
const HAND5 = world(crate);
tick(T5); bus.emit('holds', {}); frame();
check('same-pose put: an ease starts when the hold ends with no row', (tp.physicsApi.settling?.() ?? []).includes('crate'), J(tp.physicsApi.settling?.()));
check('same-pose put: t=0 drawn in the hand', same(world(crate), HAND5, 1e-4), J(world(crate).p.toArray()));
tick(T5 + 60); frame();
check('same-pose put: t=60 between', between(world(crate), HAND5, { p: new THREE.Vector3(3, 0, 3), q: new THREE.Quaternion() }) || world(crate).p.distanceTo(new THREE.Vector3(3, 0, 3)) < HAND5.p.distanceTo(new THREE.Vector3(3, 0, 3)), J(world(crate).p.toArray()));
tick(T5 + 120); frame();
check('same-pose put: t=120 exactly the fold\'s pose (it never stays drawn in the hand)', same(world(crate), { p: new THREE.Vector3(3, 0, 3), q: new THREE.Quaternion() }, 1e-9), J(world(crate).p.toArray()));

// ---- S1 (review round 2): a throw by anyone — the launch entry lands in the CANONICAL fold before the holds message,
// the presentation copy only on the next frame. The hold's end must not ask the realizer to revert to the pre-grab pose.
{
  const T6 = 18000; const reverts: string[] = []; const off = bus.on('pose-revert', ({ id }: any) => reverts.push(id));
  tick(T6 - 1000); bus.emit('holds', { crate: { by: 'me' } });
  for (let t = T6 - 1000; t < T6; t += 16) { tick(t); frame(); }
  S.replica.sim = { sim: { bodies: { crate: { p: [0, 1, 0.35] } } }, foreign: false, launched: { crate: {} } };
  tick(T6); bus.emit('holds', {});
  check('a throw (canonical body, copy not yet refreshed): no pose-revert', reverts.length === 0, J(reverts));
  check('a throw: nothing settling', !(tp.physicsApi.settling?.() ?? []).length, J(tp.physicsApi.settling?.()));
  off(); S.replica.sim = null; frame();
}
// ---- S2.1: a put row for a hold this client never drew (no hand pose): the old snap, never a slide from the old rest
{
  const T7 = 20000;
  state.applyView(view([10, 0, 10], q0)); crate.position.set(10, 0, 10); crate.quaternion.identity();
  tick(T7 - 100); bus.emit('holds', { crate: { by: 'nobody-here' } });   // a holder with no avatar: drawHeld draws nothing
  for (let t = T7 - 100; t < T7; t += 16) { tick(t); frame(); }
  tick(T7); state.applyView(view([0, 0, 0], q0)); frame();
  check('never drawn in a hand: nothing settling', !(tp.physicsApi.settling?.() ?? []).length, J(tp.physicsApi.settling?.()));
  tick(T7 + 60); frame();
  check('never drawn in a hand: t=60 is the new rest (a snap, not a slide along the floor)', world(crate).p.distanceTo(new THREE.Vector3(0, 0, 0)) < 1e-9, J(world(crate).p.toArray()));
}

// ---- a launch (a throw/drop: the engine's flight owns it) is not a put: left to the flight's own smoothing
// (pres.bodies is the flight's; with no engine here there is none, so this only pins the guard's shape)

// ---- R 10-17 20:14 ("holding this crate from far away"): a crate the physics stacked on another is that one's scene child,
// and its own scale is LOCAL (1 under a 0.25 host). A held thing is drawn by its centre and its size (localCentre, sizeOf),
// and both read obj.scale: 4x too big for a child, so it was drawn a metre off the hand. Held, a child and a root of the same
// world size are drawn at the same world place.
{
  const box = { min: new THREE.Vector3(-1.25, 0, -0.75), max: new THREE.Vector3(1.25, 2, 0.75) };
  const host = new THREE.Group(); host.scale.setScalar(0.25); host.position.set(-3, 0, 0); scene.add(host);
  const kid = new THREE.Group(); kid.position.set(0, 2, 0); host.add(kid);
  const solo = new THREE.Group(); solo.scale.setScalar(0.25); solo.position.set(3, 0, 0); scene.add(solo);
  for (const [id, o] of [['kid', kid], ['solo', solo]] as const) { S.entities.set(id, o); S.colliders.set(id, { box }); S.replica.st.entities[id] = { c: { grabbable: {} } }; }
  const drawnAt = (id: string, t0: number) => { tick(t0); bus.emit('holds', { [id]: { by: 'me' } }); for (let t = t0; t <= t0 + 600; t += 16) { tick(t); frame(); } const w = world(S.entities.get(id)); bus.emit('holds', {}); return w; };
  const a = drawnAt('solo', 30000), b = drawnAt('kid', 31000);
  check('held: a stacked crate (a scene child, local scale 1 under a 0.25 host) is drawn where the same crate unstacked is', a.p.distanceTo(b.p) < 1e-6, `root ${J(a.p.toArray())} child ${J(b.p.toArray())}`);
  // …and carried in both arms (a body with hand bones: the crate is 0.625 m, a carry), where its SIZE sets how far out in
  // front of the body it sits: the same place again, against the body (not a metre out)
  const bones: any = {}; for (const [n, x] of [['rightHand', -0.18], ['leftHand', 0.18]] as const) { const o = new THREE.Object3D(); o.position.set(x, 1.0, 0.3); me.root.add(o); bones[n] = o; }
  (me as any).vrm = { humanoid: { getRawBoneNode: (n: string) => bones[n] ?? null, getNormalizedBoneNode: (n: string) => bones[n] ?? null }, userData: {} };
  const c = drawnAt('solo', 32000), d = drawnAt('kid', 33000);
  (me as any).vrm = null; for (const o of Object.values(bones)) me.root.remove(o as any);
  check('carried in both arms: the stacked crate sits where the unstacked one does, against the body', c.p.distanceTo(d.p) < 1e-6 && Math.abs(c.p.z) < 0.6, `root ${J(c.p.toArray())} child ${J(d.p.toArray())}`);
  for (const id of ['kid', 'solo']) { S.entities.delete(id); S.colliders.delete(id); delete S.replica.st.entities[id]; }
}

console.log(`\n${pass} passed, ${fail} failed${MUTANT ? ' (mutant: duration 0 — red is the expected shape)' : ''}`);
process.exit(fail ? 1 : 0);
