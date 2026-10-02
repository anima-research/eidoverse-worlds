// channelbox-test — the inspector's channel box (design §5, step 3): Translate,
// Rotate (Euler read from q in the entity's rotation order), Scale, the order,
// and the Quaternion row — schema → editVerbs → the REAL fold → schema again.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/channelbox-test.ts
//
// The math itself is swept in tools/euler-test.ts; this checks the wiring a
// rigger touches: what each channel reads, what one edit writes, and that the
// other channels read back unchanged after the log folds it.
import * as THREE from '../client/node_modules/three/build/three.module.js';
import { emptyState, foldEntry } from '../shared/fold.js';
import { inspectSchema, editVerbs, fieldAt, describeSchema } from '../shared/editschema.js';
import { qFromEuler, eulerFromQ, ROT_ORDERS, sameRotation } from '../shared/euler.js';
import { qHeading, qRotate } from '../shared/rot.js';

let pass = 0, fail = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else { fail++; if (fails.length < 30) fails.push(`${name}  — ${detail}`); } };
const D = Math.PI / 180;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const close = (a: number, b: number, eps: number) => Math.abs(wrap(a - b)) <= eps;
const rnd = (() => { let s = 4242; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
const LIB = 'eidoverse/assets/models/crate.glb';

// fold a place through the real fold, as every client would
const foldPlace = (ent: any, args: any) => {
  const st: any = emptyState(); st.entities.e = JSON.parse(JSON.stringify(ent));
  foldEntry(st, { seq: 1, ts: 2, actor: 'o', verb: 'place', args: { ...args, id: 'e' } });
  return st.entities.e;
};
const foldComp = (ent: any, type: string, data: unknown) => {
  const st: any = emptyState(); st.entities.e = JSON.parse(JSON.stringify(ent));
  foldEntry(st, { seq: 1, ts: 2, actor: 'o', verb: 'comp', args: { id: 'e', type, data } });
  return st.entities.e;
};
const rotOf = (ent: any, live: any = {}) => ['x', 'y', 'z'].map((k) => fieldAt(inspectSchema(ent, 'e', live), `rot.${k}`)?.value);
const withOrder = (ent: any, order: string) => (order === 'XYZ' ? ent : { ...ent, comp: { ...(ent.comp ?? {}), rotOrder: order } });

console.log('the channels a yaw-only thing shows');
{
  const crate = { lib: LIB, pos: [1, 0, 2], yaw: 2.5, scale: 1, actor: 'o', ts: 1 };
  const s = inspectSchema(crate, 'e');
  check('Maya\'s labels: translate x/y/z, rotate x/y/z, scale, rotate order',
    ['pos.x:translate x', 'pos.y:translate y', 'pos.z:translate z', 'rot.x:rotate x', 'rot.y:rotate y', 'rot.z:rotate z', 'pos.scale:scale', 'rot.order:rotate order'].every((p) => { const [a, l] = p.split(':'); return fieldAt(s, a)?.label === l; }));
  for (const order of ROT_ORDERS) {
    const r = rotOf(withOrder(crate, order));
    check(`${order}: a yaw-only thing reads exactly Rotate (0, yaw, 0)`, r[0] === 0 && r[1] === 2.5 && r[2] === 0, JSON.stringify(r));
  }
  const card = s.sections.list.find((c: any) => c.type === 'Transform');
  check('the Transform card is the channel box, in Maya\'s row order, then the Quaternion row',
    JSON.stringify(card.fields) === JSON.stringify(['pos.x', 'pos.y', 'pos.z', 'pos.yaw', 'rot.order', 'rot.x', 'rot.y', 'rot.z', 'pos.scale', 'rot.qx', 'rot.qy', 'rot.qz', 'rot.qw']) && card.quatOpen === false, JSON.stringify(card));
  check('pos.yaw stays addressable (agents, AGENTS.md) but is marked an alias the panel does not draw', fieldAt(s, 'pos.yaw')?.alias === 'rot');
  check('the quaternion row reads the yaw as q', sameRotation(['qx', 'qy', 'qz', 'qw'].map((k) => fieldAt(s, `rot.${k}`)!.value), [0, Math.sin(1.25), 0, Math.cos(1.25)], 1e-10));
  const lamp = inspectSchema({ kind: 'light', pos: [0, 2, 0], color: 1, intensity: 2, range: 3 }, 'e');
  check('a light-verb light has no Rotate (a point light has no facing), as it had no yaw', !fieldAt(lamp, 'rot.x') && !fieldAt(lamp, 'rot.order') && !lamp.groups.some((g: any) => g.group === 'rot'));
  check('describeSchema (what an agent reads) lists the Rotate channels in degrees', /rot\.y = 143°/.test(describeSchema(s)), describeSchema(s).split('\n').filter((l: string) => l.includes('rot.')).join(' | '));
}

console.log('one Rotate edit on a yaw-only thing');
{
  const crate = { lib: LIB, pos: [1, 0, 2], yaw: 0.4, actor: 'o', ts: 1 };
  for (const order of ROT_ORDERS) {
    const ent = withOrder(crate, order);
    const r = editVerbs(ent, 'e', { 'rot.y': 120 });
    const a = r.verbs[0]?.args;
    check(`${order}: Rotate Y on a yaw-only thing keeps writing yaw (no q: untouched history keeps its bytes)`, r.verbs.length === 1 && r.verbs[0].verb === 'place' && !('q' in a) && Math.abs(a.yaw - 120 * D) < 1e-4, JSON.stringify(r.verbs));
    const r2 = editVerbs(ent, 'e', { 'rot.x': 30 });
    const p = r2.verbs[0]?.args;
    const t = new THREE.Quaternion().setFromEuler(new THREE.Euler(30 * D, 0.4, 0, [...order].reverse().join('') as THREE.EulerOrder));
    check(`${order}: Rotate X on a yaw-only thing writes q = (30°, yaw, 0) in that order (three agrees), with yaw = its heading for yaw-only readers`,
      !!p?.q && sameRotation(p.q, [t.x, t.y, t.z, t.w], 1e-12) && Math.abs(p.yaw - qHeading(p.q)) < 1e-15, JSON.stringify(p));
    const after = foldPlace(ent, p);
    const back = rotOf(after, { euler: r2.euler.e });
    check(`${order}: …folded and read back by the editor: (30°, yaw, 0) exactly`, close(back[0], 30 * D, 1e-9) && close(back[1], 0.4, 1e-9) && close(back[2], 0, 1e-9), JSON.stringify(back.map((v) => v / D)));
  }
  const r = editVerbs(crate, 'e', { 'rot.x': 0, 'rot.z': '+=0' });
  check('an edit that leaves X and Z at 0 stays a yaw', !('q' in (r.verbs[0]?.args ?? {})) && r.verbs[0]?.args.yaw === 0.4, JSON.stringify(r.verbs));
}

console.log('an upright thing that carries a q (a lease release writes one)');
{
  for (const order of ROT_ORDERS) {
    const q = [0, Math.sin(1.1), 0, Math.cos(1.1)];   // a 126° turn about +Y
    const r = rotOf(withOrder({ lib: LIB, pos: [0, 0, 0], q, yaw: qHeading(q), actor: 'o', ts: 1 }, order));
    check(`${order}: reads (0, yaw, 0) like its yaw-only twin, not the far branch`, close(r[0], 0, 1e-12) && close(r[1], 2.2, 1e-12) && close(r[2], 0, 1e-12), JSON.stringify(r.map((v) => v / D)));
  }
}

console.log('one Rotate edit on a thing with q: the other two read back unchanged (sweep, every order, through the fold)');
{
  let n = 0, skipped = 0;
  for (const order of ROT_ORDERS) for (let i = 0; i < 60; i++) {
    const e0 = [(rnd() * 2 - 1) * 170 * D, (rnd() * 2 - 1) * 80 * D, (rnd() * 2 - 1) * 170 * D];
    const q0 = qFromEuler(e0, order);
    const ent = withOrder({ lib: LIB, pos: [0, 0, 0], q: q0, yaw: qHeading(q0), actor: 'o', ts: 1 }, order);
    const before = rotOf(ent);   // a fresh viewer's reading
    for (const ax of [0, 1, 2]) {
      const typed = +(((rnd() * 2 - 1) * (ax === [...order].indexOf([...order][1]) ? 80 : 170)).toFixed(3));
      const mid = 'XYZ'.indexOf(order[1]);
      if (ax === mid && Math.abs(typed) > 85) { skipped++; continue; }
      const r = editVerbs(ent, 'e', { [`rot.${'xyz'[ax]}`]: typed });
      const p = r.verbs[0]?.args;
      if (!p?.q) { check(`${order} #${i} ${'XYZ'[ax]}: writes q`, false, JSON.stringify(r)); continue; }
      const after = foldPlace(ent, p);
      const fresh = rotOf(after);                         // another client, no hint
      n++;
      check(`${order} #${i}: edit ${'XYZ'[ax]} → the other two unchanged for a fresh viewer`, [0, 1, 2].filter((x) => x !== ax).every((x) => close(fresh[x], before[x], 1e-8)),
        `${before.map((v) => (v / D).toFixed(5))} → ${fresh.map((v) => (v / D).toFixed(5))}`);
      check(`${order} #${i}: edit ${'XYZ'[ax]} → reads back as typed`, close(fresh[ax], typed * D, 1e-8), `${typed} vs ${fresh[ax] / D}`);
      const t3 = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...after.q), [...order].reverse().join('') as THREE.EulerOrder);
      check(`${order} #${i}: three reads the folded q as the same triple`, close(t3.x, fresh[0], 1e-8) && close(t3.y, fresh[1], 1e-8) && close(t3.z, fresh[2], 1e-8));
      check(`${order} #${i}: the place carries pos and scale unchanged, and yaw = heading(q)`, JSON.stringify(p.pos) === '[0,0,0]' && p.scale === 1 && Math.abs(p.yaw - qHeading(p.q)) < 1e-15);
    }
  }
  check(`(${n} edits swept, ${skipped} middle-axis draws past ±85° skipped)`, n > 900);
}

console.log('the Quaternion row');
{
  const q0 = qFromEuler([10 * D, 20 * D, 30 * D], 'XYZ');
  const ent = { lib: LIB, pos: [0, 0, 0], q: q0, yaw: qHeading(q0), actor: 'o', ts: 1 };
  const r = editVerbs(ent, 'e', { 'rot.qw': 2 });
  const q = r.verbs[0]?.args.q;
  check('editing w alone normalizes the whole q on commit (the others kept in proportion)', !!q && Math.abs(Math.hypot(...q) - 1) < 1e-15 && Math.abs(q[0] / q[1] - q0[0] / q0[1]) < 1e-12, JSON.stringify(q));
  check('…clamped to the field\'s range first (w ≤ 1), so 2 is read as 1', Math.abs(q[3] - 1 / Math.hypot(q0[0], q0[1], q0[2], 1)) < 1e-12);
  const z = editVerbs(ent, 'e', { 'rot.qx': 0, 'rot.qy': 0, 'rot.qz': 0, 'rot.qw': 0 });
  check('a zero quaternion is refused, nothing sent', z.verbs.length === 0 && /zero length/.test(z.errors[0] ?? ''), JSON.stringify(z));
  const yawOnly = editVerbs({ lib: LIB, pos: [0, 0, 0], yaw: 1, actor: 'o', ts: 1 }, 'e', { 'rot.qx': 0.3 });
  check('a quaternion edit on a yaw-only thing writes q', !!yawOnly.verbs[0]?.args.q, JSON.stringify(yawOnly));
}

console.log('rotate order: changing it never changes q');
{
  for (const from of ROT_ORDERS) for (const to of [...ROT_ORDERS, 'quat']) {
    if (from === to) continue;
    const q0 = qFromEuler([(rnd() - 0.5) * 300 * D, (rnd() - 0.5) * 150 * D, (rnd() - 0.5) * 300 * D], from);
    const ent = withOrder({ lib: LIB, pos: [3, 0, 3], q: q0, yaw: qHeading(q0), actor: 'o', ts: 1 }, from);
    const r = editVerbs(ent, 'e', { 'rot.order': to });
    check(`${from} → ${to}: one comp rotOrder, no place (the object never moves)`, r.verbs.length === 1 && r.verbs[0].verb === 'comp' && r.verbs[0].args.type === 'rotOrder' && r.verbs[0].args.data === (to === 'XYZ' ? null : to), JSON.stringify(r.verbs));
    const after = foldComp(ent, 'rotOrder', r.verbs[0].args.data);
    check(`${from} → ${to}: q is bit-identical after the fold`, JSON.stringify(after.q) === JSON.stringify(ent.q) && after.yaw === ent.yaw);
    if (to !== 'quat') {
      const rd = rotOf(after);
      check(`${from} → ${to}: the channels now read q in ${to} (recomposing them gives q)`, sameRotation(qFromEuler(rd, to), q0, 1e-10), JSON.stringify(rd));
    }
  }
  const ent = { lib: LIB, pos: [0, 0, 0], yaw: 0, comp: { rotOrder: 'ZXY' }, actor: 'o', ts: 1 };
  check('choosing the order it already has sends nothing', editVerbs(ent, 'e', { 'rot.order': 'ZXY' }).verbs.length === 0);
  check('XYZ is written as the comp\'s removal (absent means XYZ; nothing writes XYZ)', JSON.stringify(editVerbs(ent, 'e', { 'rot.order': 'XYZ' }).verbs) === JSON.stringify([{ verb: 'comp', args: { id: 'e', type: 'rotOrder', data: null } }]));
  check('a bad order is refused by name', /one of XYZ XZY YXZ YZX ZXY ZYX quat/.test(editVerbs(ent, 'e', { 'rot.order': 'xyz' }).errors[0] ?? ''));
  const q = inspectSchema({ ...ent, comp: { rotOrder: 'quat' } }, 'e');
  const card = q.sections.list.find((c: any) => c.type === 'Transform');
  check('quaternion mode: the Rotate channels are hidden, the Quaternion row is shown open', !fieldAt(q, 'rot.x') && !!fieldAt(q, 'rot.qw') && card.quatOpen === true);
  const locked = inspectSchema({ ...ent, comp: { rotOrder: 'ZXY', lock: true } }, 'e');
  check('locked: Rotate and Quaternion are read-only with the reason; the order stays open (it moves nothing)',
    fieldAt(locked, 'rot.x')!.disabled && fieldAt(locked, 'rot.qw')!.disabled && /locked/.test(fieldAt(locked, 'rot.x')!.hint) && !fieldAt(locked, 'rot.order')!.disabled);
  const mounted = inspectSchema({ ...ent, parent: { to: 'cart' } }, 'e');
  check('mounted: Rotate is read-only and names the carrier', fieldAt(mounted, 'rot.y')!.disabled && /cart/.test(fieldAt(mounted, 'rot.y')!.hint));
  const swing = inspectSchema({ ...ent, comp: { motion: { type: 'pendulum', amp: 0.3 } } }, 'e');
  check('a whole-entity motion: Rotate is the rest pose, tinted driven', fieldAt(swing, 'rot.x')!.driven === 'motion');
  const held = inspectSchema({ ...ent, comp: { guard: true }, placer: { id: 'someone' } }, 'e', { mayAuthor: false });
  check('guarded by someone else: the order is read-only too', !!fieldAt(held, 'rot.order')!.disabled);
}

console.log('gimbal lock (middle axis at ±90°)');
{
  for (const order of ROT_ORDERS) {
    const [ia, ib, ic] = [...order].map((c) => 'XYZ'.indexOf(c));
    const e0 = [0, 0, 0]; e0[ia] = 25 * D; e0[ib] = 90 * D; e0[ic] = -40 * D;
    const q0 = qFromEuler(e0, order);
    const ent = withOrder({ lib: LIB, pos: [0, 0, 0], q: q0, yaw: qHeading(q0), actor: 'o', ts: 1 }, order);
    const s = inspectSchema(ent, 'e');
    const card = s.sections.list.find((c: any) => c.type === 'Transform');
    check(`${order}: the Transform card says it is in gimbal lock`, /gimbal lock/.test(JSON.stringify(card.info ?? '')), JSON.stringify(card.info));
    const fresh = rotOf(ent);
    check(`${order}: a fresh viewer reads the inner channel as 0 and the rest on the outer one`, fresh[ia] === 0 && sameRotation(qFromEuler(fresh, order), q0, 1e-12), JSON.stringify(fresh.map((v) => v / D)));
    const viewer = rotOf(ent, { euler: e0 });
    check(`${order}: the viewer who typed it reads exactly what they typed`, [0, 1, 2].every((x) => close(viewer[x], e0[x], 1e-9)), JSON.stringify(viewer.map((v) => v / D)));
    const r = editVerbs(ent, 'e', { [`rot.${'xyz'[ia]}`]: 55 }, { euler: e0 });
    const after = foldPlace(ent, r.verbs[0].args);
    const want = [...e0]; want[ia] = 55 * D;
    check(`${order}: an inner edit at the lock turns it by exactly that (q = C·B·A with the new angle)`, sameRotation(after.q, qFromEuler(want, order), 1e-12));
    const again = rotOf(after, { euler: r.euler.e });
    check(`${order}: …and the editor reads back exactly what it typed`, [0, 1, 2].every((x) => close(again[x], want[x], 1e-9)), JSON.stringify(again.map((v) => v / D)));
  }
}

console.log('the heading alias and moves');
{
  const tilt = qFromEuler([90 * D, 0, 0], 'XYZ');
  const ent = { lib: LIB, pos: [0, 0, 0], q: tilt, yaw: qHeading(tilt), scale: 2, actor: 'o', ts: 1 };
  const r = editVerbs(ent, 'e', { 'pos.yaw': 90 });
  check('pos.yaw on a tilted thing travels WITHOUT q (the fold turns it about +Y and keeps the tilt)', !('q' in r.verbs[0].args) && Math.abs(r.verbs[0].args.yaw - Math.PI / 2) < 1e-4);
  const after = foldPlace(ent, r.verbs[0].args);
  check('…and after the fold it is still tilted, now heading 90°', Math.abs(qRotate(after.q, [0, 1, 0])[1] - qRotate(tilt, [0, 1, 0])[1]) < 1e-12 && Math.abs(qHeading(after.q) - Math.PI / 2) < 1e-4);
  const m = editVerbs(ent, 'e', { 'pos.x': 5 });
  check('a move carries the thing\'s q unchanged (a move is not a turn)', JSON.stringify(m.verbs[0].args.q) === JSON.stringify(tilt) && m.verbs[0].args.pos[0] === 5 && m.verbs[0].args.scale === 2);
  const both = editVerbs(ent, 'e', { 'pos.x': 5, 'rot.z': 10, 'pos.scale': 3 });
  check('Translate + Rotate + Scale in one edit = ONE place', both.verbs.length === 1 && both.verbs[0].args.pos[0] === 5 && both.verbs[0].args.scale === 3 && !!both.verbs[0].args.q);
}

for (const f of fails) console.log('  ✗', f);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
