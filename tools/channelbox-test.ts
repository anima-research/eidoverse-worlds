// channelbox-test — the inspector's channel box (design §5, step 3): Translate,
// Rotate (Euler read from q in the entity's rotation order), Scale, the order,
// and the Quaternion row — schema → editOps → the REAL door (a scratch
// world, tools/protocol/scratchworld.ts) → the view → schema again.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/channelbox-test.ts
//
// The math itself is swept in tools/euler-test.ts; this checks the wiring a
// rigger touches: what each channel reads, what one edit writes, and that the
// other channels read back unchanged after the door writes it.
//
// the protocol port (2026-10-06): a transform is written whole ({pos, q, scale}), so "a yaw-only thing keeps writing a bare yaw
// (its history keeps its bytes)" has no meaning here: those checks now ask that the written q IS that pure heading.
// Light-verb lights and guard are gone. A lock no longer makes Rotate read-only: the door refuses the turn (and the order).
import * as THREE from '../client/node_modules/three/build/three.module.js';
import { inspectSchema, editOps, fieldAt, describeSchema, poseEdits } from '../shared/editschema.js';
import { qFromEuler, eulerFromQ, ROT_ORDERS, sameRotation } from '../shared/euler.js';
import { qHeading, qRotate, qFromYaw } from '../shared/rot.js';
import { scratchWorld, flat } from './protocol/scratchworld.ts';
import { encName } from '../shared/protocol/names.js';
import { recordComponents } from "../shared/protocol/view.js";
const ROT_ORDER = encName('rotOrder');   // camelCase isn't a component name: requests.js escapes it once, the view decodes it

let pass = 0, fail = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else { fail++; if (fails.length < 30) fails.push(`${name}  — ${detail}`); } };
const D = Math.PI / 180;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const close = (a: number, b: number, eps: number) => Math.abs(wrap(a - b)) <= eps;
const rnd = (() => { let s = 4242; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
const LIB = 'eidoverse/assets/models/crate.glb';

// the one transform an edit writes (a set transform's value), or undefined
const tfOf = (r: any) => flat(r.ops).find((o: any) => o.verb === 'set' && o.args.component === 'transform')?.args.value;
const upright = (q: number[]) => Math.abs(q[0]) < 1e-12 && Math.abs(q[2]) < 1e-12;
// through the real door: seed the record as a fresh thing, send what the edit planned, read the view back
const W = scratchWorld('channelbox');
let nth = 0;
const seedOne = (ent: any) => { const id = `e${++nth}`; W.seed({ [id]: ent }); return id; };
const viaDoor = (ent: any, r: any, id: string) => { const res = W.sendAll(r.ops); return { res, after: W.rec(id) }; };
const doorEdit = (ent: any, edits: any, live: any = {}) => { const id = seedOne(ent); const before = W.rec(id); const r = editOps(ent, id, edits, live); return { r, before, id, ...viaDoor(ent, r, id) }; };
const rotOf = (ent: any, live: any = {}) => ['x', 'y', 'z'].map((k) => fieldAt(inspectSchema(ent, 'e', live), `rot.${k}`)?.value);
const withOrder = (ent: any, order: string) => (order === 'XYZ' ? ent : { ...ent, ...recordComponents(ent), rotOrder: order });

console.log('the channels a yaw-only thing shows');
{
  const crate = { model: LIB, pos: [1, 0, 2], yaw: 2.5, scale: 1, actor: 'o', ts: 1 };
  const s = inspectSchema(crate, 'e');
  check('Maya\'s labels: translate x/y/z, rotate x/y/z, scale x/y/z, rotate order',
    ['pos.x:translate x', 'pos.y:translate y', 'pos.z:translate z', 'rot.x:rotate x', 'rot.y:rotate y', 'rot.z:rotate z', 'pos.sx:scale x', 'pos.sy:scale y', 'pos.sz:scale z', 'pos.scale:scale', 'rot.order:rotate order'].every((p) => { const [a, l] = p.split(':'); return fieldAt(s, a)?.label === l; }));
  for (const order of ROT_ORDERS) {
    const r = rotOf(withOrder(crate, order));
    check(`${order}: a yaw-only thing reads exactly Rotate (0, yaw, 0)`, r[0] === 0 && r[1] === 2.5 && r[2] === 0, JSON.stringify(r));
  }
  // and the same thing as the door stores it (every record carries q): an upright q reads (0, yaw, 0) too
  const asStored = W.seed({ yawonly: crate }).rec('yawonly');
  check('…and as the door stores it (a whole q): still (0, 2.5, 0)', Array.isArray(asStored.q) && ROT_ORDERS.every((o) => { const r = rotOf(withOrder(asStored, o)); return close(r[0], 0, 1e-12) && close(r[1], 2.5, 1e-9) && close(r[2], 0, 1e-12); }), JSON.stringify(asStored));
  const card = s.sections.list.find((c: any) => c.type === 'Transform');
  check('the Transform card is the channel box, in Maya\'s row order (scale x/y/z, R 10-04), then the Quaternion row',
    JSON.stringify(card.fields) === JSON.stringify(['pos.x', 'pos.y', 'pos.z', 'pos.yaw', 'rot.order', 'rot.x', 'rot.y', 'rot.z', 'pos.scale', 'pos.sx', 'pos.sy', 'pos.sz', 'rot.qx', 'rot.qy', 'rot.qz', 'rot.qw']) && card.quatOpen === false, JSON.stringify(card));
  check('pos.yaw stays addressable (agents, AGENTS.md) but is marked an alias the panel does not draw', fieldAt(s, 'pos.yaw')?.alias === 'rot');
  check('pos.scale stays addressable (the uniform setter) but is an alias the panel does not draw', fieldAt(s, 'pos.scale')?.alias === 'scale');
  check('the quaternion row reads the yaw as q', sameRotation(['qx', 'qy', 'qz', 'qw'].map((k) => fieldAt(s, `rot.${k}`)!.value), [0, Math.sin(1.25), 0, Math.cos(1.25)], 1e-10));
  check('describeSchema (what an agent reads) lists the Rotate channels in degrees', /rot\.y = 143°/.test(describeSchema(s)), describeSchema(s).split('\n').filter((l: string) => l.includes('rot.')).join(' | '));
}

console.log('one Rotate edit on a yaw-only thing');
{
  const crate = { model: LIB, pos: [1, 0, 2], yaw: 0.4, actor: 'o', ts: 1 };
  for (const order of ROT_ORDERS) {
    const ent = withOrder(crate, order);
    const { r, after } = doorEdit(ent, { 'rot.y': 120 });
    const t0 = tfOf(r);
    check(`${order}: Rotate Y on a yaw-only thing writes ONE transform whose q is the pure 120° heading (no tilt), pos kept`, flat(r.ops).length === 1 && !!t0 && upright(t0.q) && Math.abs(qHeading(t0.q) - 120 * D) < 1e-4 && JSON.stringify(t0.pos) === '[1,0,2]', JSON.stringify(r.ops));
    check(`${order}: …through the door it heads 120°, untilted`, upright(after.q) && Math.abs(after.yaw - 120 * D) < 1e-4, JSON.stringify(after));
    const d2 = doorEdit(ent, { 'rot.x': 30 });
    const p = tfOf(d2.r);
    const t = new THREE.Quaternion().setFromEuler(new THREE.Euler(30 * D, 0.4, 0, [...order].reverse().join('') as THREE.EulerOrder));
    check(`${order}: Rotate X on a yaw-only thing writes q = (30°, yaw, 0) in that order (three agrees)`,
      !!p?.q && sameRotation(p.q, [t.x, t.y, t.z, t.w], 1e-12), JSON.stringify(p));
    const back = rotOf(d2.after, { euler: d2.r.euler.e });
    check(`${order}: …written by the door and read back by the editor: (30°, yaw, 0) exactly`, close(back[0], 30 * D, 1e-9) && close(back[1], 0.4, 1e-9) && close(back[2], 0, 1e-9), JSON.stringify(back.map((v) => v / D)));
  }
  const r = editOps(crate, 'e', { 'rot.x': 0, 'rot.z': '+=0' });
  check('an edit that leaves X and Z at 0 stays a pure heading (the yaw it had)', !!tfOf(r) && upright(tfOf(r).q) && sameRotation(tfOf(r).q, qFromYaw(0.4), 1e-12), JSON.stringify(r.ops));
}

console.log('an upright thing that carries a q (every record does)');
{
  for (const order of ROT_ORDERS) {
    const q = [0, Math.sin(1.1), 0, Math.cos(1.1)];   // a 126° turn about +Y
    const r = rotOf(withOrder({ model: LIB, pos: [0, 0, 0], q, yaw: qHeading(q), actor: 'o', ts: 1 }, order));
    check(`${order}: reads (0, yaw, 0) like its yaw-only twin, not the far branch`, close(r[0], 0, 1e-12) && close(r[1], 2.2, 1e-12) && close(r[2], 0, 1e-12), JSON.stringify(r.map((v) => v / D)));
  }
}

console.log('one Rotate edit on a thing with q: the other two read back unchanged (sweep, every order, through the door)');
{
  let n = 0, skipped = 0;
  for (const order of ROT_ORDERS) for (let i = 0; i < 60; i++) {
    const e0 = [(rnd() * 2 - 1) * 170 * D, (rnd() * 2 - 1) * 80 * D, (rnd() * 2 - 1) * 170 * D];
    const q0 = qFromEuler(e0, order);
    const ent = withOrder({ model: LIB, pos: [0, 0, 0], q: q0, yaw: qHeading(q0), actor: 'o', ts: 1 }, order);
    const before = rotOf(ent);   // a fresh viewer's reading
    const id = seedOne(ent);
    for (const ax of [0, 1, 2]) {
      const typed = +(((rnd() * 2 - 1) * (ax === [...order].indexOf([...order][1]) ? 80 : 170)).toFixed(3));
      const mid = 'XYZ'.indexOf(order[1]);
      if (ax === mid && Math.abs(typed) > 85) { skipped++; continue; }
      const r = editOps(ent, id, { [`rot.${'xyz'[ax]}`]: typed });
      const p = tfOf(r);
      if (!p?.q) { check(`${order} #${i} ${'XYZ'[ax]}: writes q`, false, JSON.stringify(r)); continue; }
      const res = W.send(r.ops[0]);
      const after = W.rec(id);
      const fresh = rotOf(after);                         // another client, no hint
      n++;
      check(`${order} #${i}: the door takes it`, res.ok, JSON.stringify(res.refused));
      check(`${order} #${i}: edit ${'XYZ'[ax]} → the other two unchanged for a fresh viewer`, [0, 1, 2].filter((x) => x !== ax).every((x) => close(fresh[x], before[x], 1e-8)),
        `${before.map((v) => (v / D).toFixed(5))} → ${fresh.map((v) => (v / D).toFixed(5))}`);
      check(`${order} #${i}: edit ${'XYZ'[ax]} → reads back as typed`, close(fresh[ax], typed * D, 1e-8), `${typed} vs ${fresh[ax] / D}`);
      const t3 = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...after.q), [...order].reverse().join('') as THREE.EulerOrder);
      check(`${order} #${i}: three reads the stored q as the same triple`, close(t3.x, fresh[0], 1e-8) && close(t3.y, fresh[1], 1e-8) && close(t3.z, fresh[2], 1e-8));
      check(`${order} #${i}: the transform carries pos and scale unchanged`, JSON.stringify(p.pos) === '[0,0,0]' && JSON.stringify(p.scale) === '[1,1,1]' && JSON.stringify(after.pos) === '[0,0,0]' && after.scale === 1);
    }
  }
  check(`(${n} edits swept, ${skipped} middle-axis draws past ±85° skipped)`, n > 900);
}

console.log('the Quaternion row');
{
  const q0 = qFromEuler([10 * D, 20 * D, 30 * D], 'XYZ');
  const ent = { model: LIB, pos: [0, 0, 0], q: q0, yaw: qHeading(q0), actor: 'o', ts: 1 };
  const r = editOps(ent, 'e', { 'rot.qw': 2 });
  const q = tfOf(r)?.q;
  check('editing w alone normalizes the whole q on commit (the others kept in proportion)', !!q && Math.abs(Math.hypot(...q) - 1) < 1e-15 && Math.abs(q[0] / q[1] - q0[0] / q0[1]) < 1e-12, JSON.stringify(q));
  check('…clamped to the field\'s range first (w ≤ 1), so 2 is read as 1', Math.abs(q[3] - 1 / Math.hypot(q0[0], q0[1], q0[2], 1)) < 1e-12);
  const z = editOps(ent, 'e', { 'rot.qx': 0, 'rot.qy': 0, 'rot.qz': 0, 'rot.qw': 0 });
  check('a zero quaternion is refused, nothing sent', z.ops.length === 0 && /zero length/.test(z.errors[0] ?? ''), JSON.stringify(z));
  const yawOnly = editOps({ model: LIB, pos: [0, 0, 0], yaw: 1, actor: 'o', ts: 1 }, 'e', { 'rot.qx': 0.3 });
  check('a quaternion edit on a yaw-only thing writes a tilted q', !!tfOf(yawOnly)?.q && !upright(tfOf(yawOnly).q), JSON.stringify(yawOnly));
}

console.log('rotate order: changing it never changes q');
{
  for (const from of ROT_ORDERS) for (const to of [...ROT_ORDERS, 'quat']) {
    if (from === to) continue;
    const q0 = qFromEuler([(rnd() - 0.5) * 300 * D, (rnd() - 0.5) * 150 * D, (rnd() - 0.5) * 300 * D], from);
    const ent = withOrder({ model: LIB, pos: [3, 0, 3], q: q0, yaw: qHeading(q0), actor: 'o', ts: 1 }, from);
    const { r, before, after, res } = doorEdit(ent, { 'rot.order': to });
    const o = flat(r.ops);
    const want = to === 'XYZ' ? { verb: 'delete', component: 'rotOrder' } : { verb: 'set', component: 'rotOrder', value: to };
    check(`${from} → ${to}: one set/delete of rotOrder, no transform (the object never moves)`, o.length === 1 && o[0].verb === want.verb && o[0].args.component === ROT_ORDER && (to === 'XYZ' || o[0].args.value === to), JSON.stringify(r.ops));
    check(`${from} → ${to}: q is bit-identical after the door writes it`, res.ok && JSON.stringify(after.q) === JSON.stringify(before.q) && after.yaw === before.yaw && (to === 'XYZ' ? after?.rotOrder === undefined : after?.rotOrder === to), JSON.stringify([res.refused, before.q, after.q, after.comp]));
    if (to !== 'quat') {
      const rd = rotOf(after);
      check(`${from} → ${to}: the channels now read q in ${to} (recomposing them gives q)`, sameRotation(qFromEuler(rd, to), q0, 1e-10), JSON.stringify(rd));
    }
  }
  const ent = { model: LIB, pos: [0, 0, 0], yaw: 0, rotOrder: 'ZXY', actor: 'o', ts: 1 };
  check('choosing the order it already has sends nothing', editOps(ent, 'e', { 'rot.order': 'ZXY' }).ops.length === 0);
  check('XYZ is written as the comp\'s removal (absent means XYZ; nothing writes XYZ)', JSON.stringify(editOps(ent, 'e', { 'rot.order': 'XYZ' }).ops) === JSON.stringify([{ verb: 'delete', args: { id: 'e', component: ROT_ORDER } }]));
  check('a bad order is refused by name', /one of XYZ XZY YXZ YZX ZXY ZYX quat/.test(editOps(ent, 'e', { 'rot.order': 'xyz' }).errors[0] ?? ''));
  const q = inspectSchema({ ...ent, rotOrder: 'quat' }, 'e');
  const card = q.sections.list.find((c: any) => c.type === 'Transform');
  check('quaternion mode: the Rotate channels are hidden, the Quaternion row is shown open', !fieldAt(q, 'rot.x') && !!fieldAt(q, 'rot.qw') && card.quatOpen === true);
  const locked = inspectSchema({ ...ent, rotOrder: 'ZXY', lock: true }, 'e');
  check('locked: Rotate, Quaternion and the order stay editable and say a change asks first (the door decides, §5)',
    !fieldAt(locked, 'rot.x')!.disabled && !fieldAt(locked, 'rot.qw')!.disabled && /locked — moving it asks first/.test(fieldAt(locked, 'rot.x')!.hint)
      && !fieldAt(locked, 'rot.order')!.disabled && /locked — changing it asks first/.test(fieldAt(locked, 'rot.order')!.hint), JSON.stringify(fieldAt(locked, 'rot.order')));
  // a lock covers every component (gate.js, §5), rot.order included: the door refuses the turn and the order change alike.
  // Seeded at XYZ, so this holds whatever the stored spelling of an order turns out to be
  const L = { ...ent, rotOrder: undefined, lock: true };
  const turn = doorEdit(L, { 'rot.y': 45 });
  check('locked: the door refuses a Rotate edit `locked` and the thing keeps its q', turn.res.ok === false && turn.res.refused?.code === 'locked' && JSON.stringify(turn.after.q) === JSON.stringify(turn.before.q), JSON.stringify(turn.res));
  const reorder = W.send(editOps(L, turn.id, { 'rot.order': 'ZXY' }).ops[0]);
  check('locked: …and refuses a rotate-order change `locked` too (a lock covers every component); the order stays XYZ', reorder.ok === false && reorder.refused?.code === 'locked' && W.rec(turn.id).rotOrder === undefined && W.rec(turn.id).lock === true, JSON.stringify(reorder));
  // step 4: a child's Rotate reads its RELATIVE orientation (the mount's), editable; only a part-socket occupant is read-only
  const mounted = inspectSchema({ ...ent, parent: { to: 'cart', yaw: 0.5 } }, 'e');
  check('mounted: Rotate reads the mount\'s relative turn, editable', !fieldAt(mounted, 'rot.y')!.disabled && Math.abs(fieldAt(mounted, 'rot.y')!.value - 0.5) < 1e-9);
  const riding = inspectSchema({ ...ent, parent: { to: 'cart', socket: 'deck' } }, 'e', { world: { e: ent, cart: { model: 'cart.glb', pos: [0, 0, 0], sockets: { deck: { pos: [0, 1, 0], part: 'plank' } } } } });
  check('a part-socket occupant: Rotate is read-only and names the carrier and part', fieldAt(riding, 'rot.y')!.disabled && /cart/.test(fieldAt(riding, 'rot.y')!.hint) && /plank/.test(fieldAt(riding, 'rot.y')!.hint));
  const swing = inspectSchema({ ...ent, motion: { type: 'pendulum', amp: 0.3 } }, 'e');
  check('a whole-entity motion: Rotate is the rest pose, tinted driven', fieldAt(swing, 'rot.x')!.driven === 'motion');
}

console.log('gimbal lock (middle axis at ±90°)');
{
  for (const order of ROT_ORDERS) {
    const [ia, ib, ic] = [...order].map((c) => 'XYZ'.indexOf(c));
    const e0 = [0, 0, 0]; e0[ia] = 25 * D; e0[ib] = 90 * D; e0[ic] = -40 * D;
    const q0 = qFromEuler(e0, order);
    const ent = withOrder({ model: LIB, pos: [0, 0, 0], q: q0, yaw: qHeading(q0), actor: 'o', ts: 1 }, order);
    const s = inspectSchema(ent, 'e');
    const card = s.sections.list.find((c: any) => c.type === 'Transform');
    check(`${order}: the Transform card says it is in gimbal lock`, /gimbal lock/.test(JSON.stringify(card.info ?? '')), JSON.stringify(card.info));
    const fresh = rotOf(ent);
    check(`${order}: a fresh viewer reads the inner channel as 0 and the rest on the outer one`, fresh[ia] === 0 && sameRotation(qFromEuler(fresh, order), q0, 1e-12), JSON.stringify(fresh.map((v) => v / D)));
    const viewer = rotOf(ent, { euler: e0 });
    check(`${order}: the viewer who typed it reads exactly what they typed`, [0, 1, 2].every((x) => close(viewer[x], e0[x], 1e-9)), JSON.stringify(viewer.map((v) => v / D)));
    const { r, after } = doorEdit(ent, { [`rot.${'xyz'[ia]}`]: 55 }, { euler: e0 });
    const want = [...e0]; want[ia] = 55 * D;
    check(`${order}: an inner edit at the lock turns it by exactly that (q = C·B·A with the new angle)`, sameRotation(after.q, qFromEuler(want, order), 1e-12), JSON.stringify(after.q));
    const again = rotOf(after, { euler: r.euler.e });
    check(`${order}: …and the editor reads back exactly what it typed`, [0, 1, 2].every((x) => close(again[x], want[x], 1e-9)), JSON.stringify(again.map((v) => v / D)));
  }
}

console.log('the heading alias and moves');
{
  const tilt = qFromEuler([90 * D, 0, 0], 'XYZ');
  const ent = { model: LIB, pos: [0, 0, 0], q: tilt, yaw: qHeading(tilt), scale: 2, actor: 'o', ts: 1 };
  const { after } = doorEdit(ent, { 'pos.yaw': 90 });
  check('pos.yaw on a tilted thing turns it about +Y and keeps the tilt: still tilted, now heading 90° (through the door)', Math.abs(qRotate(after.q, [0, 1, 0])[1] - qRotate(tilt, [0, 1, 0])[1]) < 1e-12 && Math.abs(qHeading(after.q) - Math.PI / 2) < 1e-4, JSON.stringify(after.q));
  const m = editOps(ent, 'e', { 'pos.x': 5 });
  check('a move carries the thing\'s q unchanged (a move is not a turn)', JSON.stringify(tfOf(m).q) === JSON.stringify(tilt) && tfOf(m).pos[0] === 5 && JSON.stringify(tfOf(m).scale) === '[2,2,2]', JSON.stringify(m.ops));
  const both = editOps(ent, 'e', { 'pos.x': 5, 'rot.z': 10, 'pos.scale': 3 });
  check('Translate + Rotate + Scale in one edit = ONE whole set transform', flat(both.ops).length === 1 && tfOf(both).pos[0] === 5 && JSON.stringify(tfOf(both).scale) === '[3,3,3]' && !sameRotation(tfOf(both).q, tilt, 1e-6), JSON.stringify(both.ops));
}

console.log('the rotate gizmo: any axis, committed as q (poseEdits → editOps → the door)');
{
  const crate = { model: LIB, pos: [1, 0, 2], yaw: 0.4, scale: 1.5, actor: 'o', ts: 1 };
  const tq = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.4, -0.2, 'ZYX'));   // what TransformControls leaves on the object
  const set = poseEdits(crate, 'e', 'rotate', { pos: [9, 9, 9], q: [tq.x, tq.y, tq.z, tq.w], scale: 7 });
  check('rotate sends the orientation only (not the position or scale it did not touch)', Object.keys(set).sort().join() === 'rot.qw,rot.qx,rot.qy,rot.qz', JSON.stringify(set));
  const { after } = doorEdit(crate, set);
  check('…and the door holds exactly the gizmo\'s orientation, pos and scale untouched', Array.isArray(after.q) && sameRotation(after.q, [tq.x, tq.y, tq.z, tq.w], 1e-12) && JSON.stringify(after.pos) === '[1,0,2]' && after.scale === 1.5, JSON.stringify(after));
  const flip = poseEdits(crate, 'e', 'rotate', { q: [-tq.x, -tq.y, -tq.z, -tq.w] });
  check('…a negated quaternion (the same rotation) commits the same rotation', sameRotation(doorEdit(crate, flip).after.q ?? [0, 0, 0, 0], [tq.x, tq.y, tq.z, tq.w], 1e-12));
  const yq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 2.0);
  const ys = poseEdits(crate, 'e', 'rotate', { q: [yq.x, yq.y, yq.z, yq.w] });
  const yd = doorEdit(crate, ys);
  check('a pure turn about up on a yaw-only thing is a heading edit (pos.yaw) and lands untilted at heading 2.0', Object.keys(ys).join() === 'pos.yaw' && upright(yd.after.q) && Math.abs(yd.after.yaw - 2.0) < 1e-4, JSON.stringify([ys, yd.after]));
  const tilted = { ...crate, q: [tq.x, tq.y, tq.z, tq.w], yaw: qHeading([tq.x, tq.y, tq.z, tq.w]) };
  check('…but the same turn on a thing that already has q writes q', 'rot.qw' in poseEdits(tilted, 'e', 'rotate', { q: [yq.x, yq.y, yq.z, yq.w] }));
  const mv = editOps(tilted, 'e', poseEdits(tilted, 'e', 'move', { pos: [4, 0, 4], q: [0, 0, 0, 1], scale: 3 }));
  check('move on a tilted thing sends the position and keeps its q, up to normalization (no stray heading from the object\'s Euler y)', sameRotation(tfOf(mv).q, tilted.q, 1e-12) && tfOf(mv).pos[0] === 4 && JSON.stringify(tfOf(mv).scale) === '[1.5,1.5,1.5]', JSON.stringify(mv.ops));
  check('scale sends the scale only (three channels)', Object.keys(poseEdits(crate, 'e', 'scale', { pos: [9, 9, 9], q: [0, 0, 0, 1], scale: 2 })).join() === 'pos.sx,pos.sy,pos.sz');
  const lk = doorEdit({ ...crate, lock: true }, set);
  check('a locked thing\'s rotate is refused by the door `locked`, and it keeps its heading', lk.res.ok === false && lk.res.refused?.code === 'locked' && JSON.stringify(lk.after.q) === JSON.stringify(lk.before.q), JSON.stringify(lk.res));
}

for (const f of fails) console.log('  ✗', f);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
