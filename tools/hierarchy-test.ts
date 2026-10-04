// hierarchy-test — the scene tree as a pure function of the fold (design §3
// "Children", §5 "Hierarchy"; shared/hierarchy.js), checked against the REAL
// fold and against three.js composing Object3Ds the way the renderer does.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/hierarchy-test.ts
//
// 1. tree building from a folded log (nesting, folds, the filter opening a
//    folded path, a hand-written loop showing both members as roots)
// 2. cycle refusal (the pure rule, parentVerbs, editVerbs and the door's vMount)
// 3. local ⇄ world: parent in place / unparent keep the world pose, through
//    the real fold, for random tilted + scaled carriers and nested chains
// 4. a child's channel box: local values, and an edit writes ONE mount
// 5. undo: a parent edit's inverses fold the record back to what it was
import * as THREE from '../client/node_modules/three/build/three.module.js';
import { emptyState, foldEntry } from '../shared/fold.js';
import { treeRows, treeOf, cycleRefusal, parentVerbs, worldPose, localOf, childrenOf, kindHint, ancestors } from '../shared/hierarchy.js';
import { inspectSchema, editVerbs, fieldAt, describeSchema } from '../shared/editschema.js';
import { qNorm, qFromYaw } from '../shared/rot.js';
import { VERBS } from '../server/verbs.ts';

let pass = 0, fail = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else { fail++; if (fails.length < 40) fails.push(`${name}  — ${detail}`); } };
const rnd = (() => { let s = 777; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
const near = (a: number[], b: number[], eps: number) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);
const sameRot = (a: number[], b: number[], eps: number) => near(a, b, eps) || near(a, b.map((v) => -v), eps);
let seq = 0;
const fold = (st: any, verb: string, args: any) => foldEntry(st, { seq: ++seq, ts: 1000 + seq, actor: 'o', verb, args });
const LIB = 'eidoverse/assets/models/table_oak_round.glb';

// ---------------------------------------------------------------- 1. the tree
console.log('tree building from a fold state');
{
  const st: any = emptyState();
  fold(st, 'spawn', { id: 'table', lib: LIB, pos: [0, 0, 0] });
  fold(st, 'spawn', { id: 'lamp', lib: 'eidoverse/assets/models/lamp_brass_desk.glb', pos: [0, 0.8, 0] });
  fold(st, 'spawn', { id: 'bulb', pos: [0, 1.2, 0] });                       // an Empty
  fold(st, 'comp', { id: 'bulb', type: 'light', data: { color: 0xffd9a0, intensity: 8, range: 4 } });
  fold(st, 'light', { id: 'porch', pos: [5, 2, 0], color: 0xffffff, intensity: 10, range: 6 });
  fold(st, 'spawn', { id: 'chair', lib: 'eidoverse/assets/models/chair.glb', pos: [2, 0, 0] });
  fold(st, 'mount', { id: 'lamp', to: 'table', offset: [0, 0.8, 0] });
  fold(st, 'mount', { id: 'bulb', to: 'lamp', offset: [0, 0.4, 0] });
  const W = st.entities;
  const rows = treeRows(W);
  const shape = rows.map((r: any) => `${'  '.repeat(r.depth)}${r.id}`).join('|');
  check('nesting: chair, porch and table are roots; lamp under table; bulb under lamp', shape === 'chair|porch|table|  lamp|    bulb', shape);
  check('a row counts its children (the disclosure)', rows.find((r: any) => r.id === 'table').kids === 1 && rows.find((r: any) => r.id === 'bulb').kids === 0);
  const folded = treeRows(W, { collapsed: new Set(['table']) }).map((r: any) => r.id).join(',');
  check('folding a parent hides its subtree', folded === 'chair,porch,table', folded);
  check('…and the folded row says closed', treeRows(W, { collapsed: new Set(['table']) }).find((r: any) => r.id === 'table').open === false);
  const m = (q: string) => (id: string) => id.includes(q);
  const hit = treeRows(W, { collapsed: new Set(['table', 'lamp']), matches: m('bulb') });
  check('a filter match inside a FOLDED parent shows the parent path, dimmed, opened', hit.map((r: any) => `${r.id}${r.dim ? '~' : ''}${r.open ? '' : '!'}`).join(',') === 'table~,lamp~,bulb', JSON.stringify(hit));
  check('a filter with no match is empty', treeRows(W, { matches: m('zzz') }).length === 0);
  const ex = treeRows(W, { extra: (id: string) => (id === 'chair' ? [{ id: 'rider:ann', match: true }] : []) });
  check('extra rows (a seated person) nest under their carrier and count as children', ex[1]?.id === 'rider:ann' && ex[1].depth === 1 && ex[0].kids === 1, JSON.stringify(ex.slice(0, 2)));
  check('kind hints: model stem, an Empty with a light, a light-verb light', kindHint(W.table) === 'table oak round' && kindHint(W.bulb) === 'empty + light' && kindHint(W.porch) === 'light');
  check('childrenOf / ancestors read the fold', childrenOf(W, 'lamp').join() === 'bulb' && ancestors(W, 'bulb').join() === 'lamp,table');
  // a loop written by hand (no door refuses a log file): both members are roots, nothing vanishes
  const loop: any = { a: { pos: [0, 0, 0], parent: { to: 'b' } }, b: { pos: [1, 0, 0], parent: { to: 'a' } }, c: { pos: [0, 0, 0], parent: { to: 'a' } } };
  const t = treeOf(loop);
  check('a looped log: both members are roots, a child of one still nests', t.roots.join() === 'a,b' && t.kids.get('a')?.join() === 'c', JSON.stringify({ roots: t.roots, kids: [...t.kids] }));
  check('…and worldPose terminates on it', !!worldPose(loop, 'c'));
  // a carrier that is gone: the child is a root (the renderer leaves it where the fold put it)
  check('a missing carrier → a root', treeOf({ x: { pos: [0, 0, 0], parent: { to: 'gone' } } }).roots.join() === 'x');
}

// ---------------------------------------------------------------- 2. cycles
console.log('cycle refusal');
{
  const st: any = emptyState();
  fold(st, 'spawn', { id: 'table', lib: LIB, pos: [0, 0, 0] });
  fold(st, 'spawn', { id: 'lamp', lib: LIB, pos: [0, 1, 0] });
  fold(st, 'spawn', { id: 'bulb', pos: [0, 2, 0] });
  fold(st, 'mount', { id: 'lamp', to: 'table', offset: [0, 1, 0] });
  fold(st, 'mount', { id: 'bulb', to: 'lamp', offset: [0, 1, 0] });
  const W = st.entities;
  const why = cycleRefusal(W, 'table', 'bulb');
  check('table onto its grandchild bulb is refused, naming the path', !!why && /bulb is inside table/.test(why) && /table › lamp › bulb/.test(why), String(why));
  check('table onto its child lamp is refused', !!cycleRefusal(W, 'table', 'lamp'));
  check('onto itself is refused', /own parent/.test(cycleRefusal(W, 'lamp', 'lamp') ?? ''));
  check('a sideways move is fine (bulb onto table)', cycleRefusal(W, 'bulb', 'table') === null);
  const pv = parentVerbs(W, 'table', 'bulb');
  check('parentVerbs sends nothing for a cycle and says why', pv.verbs.length === 0 && pv.errors.some((e: string) => /inside table/.test(e)));
  const ev = editVerbs(W.table, 'table', { 'parent.to': 'bulb' }, { world: W });
  check('editVerbs (the inspector / agent path) refuses it the same way', ev.verbs.length === 0 && ev.errors.some((e: string) => /inside table/.test(e)), JSON.stringify(ev));
  // the door: an agent's raw mount gets the same answer, and nothing is logged
  const debug: any[] = [];
  const ctx: any = { w: { state: st, debug: (k: string, d: any) => debug.push([k, d]) }, c: { id: 'agent' } };
  const r: any = VERBS.mount.validate!(ctx, { id: 'table', to: 'bulb' });
  check('the door refuses a looped mount (vMount) and records why', !!r.error && /inside table/.test(r.error) && debug.some(([k]) => k === 'rejected'), JSON.stringify(r));
  const ok: any = VERBS.mount.validate!(ctx, { id: 'bulb', to: 'table', offset: [0, 2, 0] });
  check('…and passes an honest one', !ok.error && ok.args?.to === 'table');
  const body: any = VERBS.mount.validate!(ctx, { id: 'ann', to: 'lamp', slot: 'seat' });
  check('…and a body sitting down (not an entity) is not a cycle question', !body.error);
  // locks and guards answer before anything is sent
  const locked = { ...W, lamp: { ...W.lamp, comp: { lock: true } } };
  check('a locked thing does not move under a new parent', parentVerbs(locked, 'lamp', null).errors.some((e: string) => /locked/.test(e)));
  const g = { ...W, table: { ...W.table, comp: { guard: true }, placer: { id: 'mia' } } };
  check('a guarded old carrier: only its placer unloads it', parentVerbs(g, 'lamp', null, { mayAuthor: (x: string) => x !== 'table' }).errors.some((e: string) => /table is guarded by mia/.test(e)));
  check('a guarded new carrier: only its placer loads it', parentVerbs(g, 'bulb', 'table', { mayAuthor: (x: string) => x !== 'table' }).errors.some((e: string) => /table is guarded by mia/.test(e)));
  check('unknown authority (an agent): the server decides', parentVerbs(g, 'bulb', 'table').errors.length === 0);
}

// ---------------------------------------------------------------- 3. local ⇄ world
console.log('parent in place, unparent in place: the world pose survives the fold');
const randQ = () => qNorm([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5])!;
const randPos = () => [(rnd() - 0.5) * 20, rnd() * 4, (rnd() - 0.5) * 20];
/** The renderer's composition, independently: three.js Object3Ds built from
 *  the folded records exactly as realize/models.js does (execMount). */
function threeWorld(W: any, id: string) {
  const objs = new Map<string, THREE.Object3D>();
  const scene = new THREE.Scene();
  const make = (k: string) => {
    if (objs.has(k)) return objs.get(k)!;
    const e = W[k]; const o = new THREE.Object3D(); objs.set(k, o);
    o.scale.setScalar(e.scale ?? 1);
    if (e.parent && W[e.parent.to]) {
      make(e.parent.to).add(o);
      o.position.set(...(e.parent.offset ?? [0, 0, 0]) as [number, number, number]);
      if (e.parent.q) o.quaternion.set(e.parent.q[0], e.parent.q[1], e.parent.q[2], e.parent.q[3]); else o.rotation.set(0, e.parent.yaw ?? 0, 0);
    } else {
      scene.add(o);
      o.position.set(...(e.pos as [number, number, number]));
      if (e.q) o.quaternion.set(e.q[0], e.q[1], e.q[2], e.q[3]); else o.rotation.set(0, e.yaw ?? 0, 0);
    }
    return o;
  };
  const o = make(id); scene.updateMatrixWorld(true);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  o.matrixWorld.decompose(p, q, s);
  return { pos: p.toArray(), q: [q.x, q.y, q.z, q.w], scale: s.x };
}
{
  let worst = 0, worstQ = 0, worstS = 0, n = 0, threeWorst = 0, scaled = 0, upright = 0;
  for (let i = 0; i < 300; i++) {
    const st: any = emptyState();
    const tilt = i % 3 !== 0;                                          // a third of carriers stand upright
    fold(st, 'spawn', { id: 'base', lib: LIB, pos: randPos(), ...(tilt ? { q: randQ() } : { yaw: (rnd() - 0.5) * 6 }), scale: i % 2 ? 0.5 + rnd() * 2 : 1 });
    fold(st, 'spawn', { id: 'arm', lib: LIB, pos: randPos(), q: randQ(), scale: 0.5 + rnd() });
    fold(st, 'mount', { id: 'arm', to: 'base', offset: randPos(), q: randQ() });   // a nested carrier
    const childTilt = i % 4 !== 0;
    fold(st, 'spawn', { id: 'cup', lib: LIB, pos: randPos(), ...(childTilt ? { q: randQ() } : { yaw: (rnd() - 0.5) * 6 }), scale: 0.3 + rnd() * 2 });
    const to = i % 2 ? 'arm' : 'base';
    const before = worldPose(st.entities, 'cup')!;
    const pv = parentVerbs(st.entities, 'cup', to);
    if (pv.errors.length) { check('parentVerbs refused a legal parenting', false, pv.errors.join()); continue; }
    if (pv.verbs.some((v: any) => v.verb === 'place')) scaled++;
    if (pv.verbs[0].args.q === undefined) upright++;
    for (const v of pv.verbs) fold(st, v.verb, v.args);
    check('the child is now under its new parent', st.entities.cup.parent?.to === to);
    const after = worldPose(st.entities, 'cup')!;
    const tw = threeWorld(st.entities, 'cup');
    worst = Math.max(worst, ...after.pos.map((v, k) => Math.abs(v - before.pos[k])));
    worstQ = Math.max(worstQ, sameRot(after.q, before.q, 1e-6) ? 0 : 1);
    worstS = Math.max(worstS, Math.abs(after.scale - before.scale) / before.scale);
    threeWorst = Math.max(threeWorst, ...tw.pos.map((v, k) => Math.abs(v - before.pos[k])), sameRot(tw.q, before.q, 1e-5) ? 0 : 1, Math.abs(tw.scale - before.scale) / before.scale);
    // the carrier moves (the cup rides along: the fold's own pos for it is now stale),
    // then out again: dismount stamps where it IS, not where it was placed
    fold(st, 'place', { id: 'base', pos: randPos(), q: randQ() });
    const riding = worldPose(st.entities, 'cup')!;
    const out = parentVerbs(st.entities, 'cup', null);
    for (const v of out.verbs) fold(st, v.verb, v.args);
    const back = worldPose(st.entities, 'cup')!;
    check('unparent after the carrier moved: a root, where it rode to', !st.entities.cup.parent && near(back.pos, riding.pos, 2e-3) && sameRot(back.q, riding.q, 1e-6) && Math.abs(back.scale - riding.scale) < 2e-3,
      JSON.stringify({ back, riding }));
    n++;
  }
  check(`parent in place keeps the world position (worst ${worst.toExponential(1)} m over ${n})`, worst < 2e-3);
  check('parent in place keeps the world orientation', worstQ === 0);
  check(`parent in place keeps the world size, a scaled carrier included (${scaled} needed a place)`, worstS < 2e-3 && scaled > 50);
  check('three.js composing the folded records as the renderer does agrees', threeWorst < 2e-3, String(threeWorst));
  check(`an upright relative turn travels as a bare yaw (${upright} of ${n})`, upright > 10);
}
{
  // the mount alone is enough when nothing is scaled, and it carries the full relative q
  const W: any = { box: { lib: LIB, pos: [1, 0, 0], q: qNorm([0.3, 0.2, 0.1, 0.9]) }, ball: { lib: LIB, pos: [1, 1, 0], yaw: 0 } };
  const pv = parentVerbs(W, 'ball', 'box');
  check('unscaled: exactly one verb, a mount with offset + q + yaw', pv.verbs.length === 1 && pv.verbs[0].verb === 'mount' && pv.verbs[0].args.q?.length === 4 && typeof pv.verbs[0].args.yaw === 'number' && pv.verbs[0].args.offset?.length === 3, JSON.stringify(pv.verbs));
  const L = localOf({ ...W.ball, parent: { to: 'box', yaw: 0.5 } }, W);
  check('localOf a yaw-only mount: q null, yaw the relative turn', L.q === null && L.yaw === 0.5 && L.mounted);
  const S = localOf({ ...W.ball, parent: { to: 'chair', slot: 'seat' } }, { ...W, chair: { lib: LIB, pos: [0, 0, 0], comp: { sockets: { seat: { pos: [0, 0.5, 0], yaw: 3 } } } } });
  check('localOf a socket mount: the socket\'s pos and yaw', near(S.pos, [0, 0.5, 0], 0) && S.yaw === 3);
}

// ---------------------------------------------------------------- 4. the channel box
console.log("a child's channel box: local, and an edit writes one mount");
{
  const st: any = emptyState();
  fold(st, 'spawn', { id: 'lamp', lib: LIB, pos: [10, 0, 10], yaw: 1 });
  fold(st, 'spawn', { id: 'bulb', pos: [3, 3, 3], yaw: 0, scale: 1 });
  fold(st, 'mount', { id: 'bulb', to: 'lamp', offset: [0, 1.5, 0.2], yaw: 0.25 });
  const W = st.entities;
  const sc = inspectSchema(W.bulb, 'bulb', { world: W });
  check('Translate reads the mount offset, not the fold\'s pre-mount pos', fieldAt(sc, 'pos.x')!.value === 0 && fieldAt(sc, 'pos.y')!.value === 1.5 && fieldAt(sc, 'pos.z')!.value === 0.2);
  check('Rotate Y reads the relative turn', Math.abs(fieldAt(sc, 'rot.y')!.value - 0.25) < 1e-9);
  check('the channels are editable, and the frame is said', !fieldAt(sc, 'pos.x')!.disabled && /local to its parent, lamp/.test(describeSchema(sc)));
  const card = sc.sections.list.find((c: any) => c.type === 'Transform');
  check('the Transform card says it is local to lamp', card.info?.some(([k, v]: string[]) => k === 'frame' && /lamp/.test(v)));
  check('the Parent card carries the parent field (not the header); children are still listed for agents', !sc.sections.header.includes('parent.to') && sc.sections.list.find((c: any) => c.type === 'Parent')?.fields.includes('parent.to') && fieldAt(inspectSchema(W.lamp, 'lamp', { world: W }), 'parent.children')!.value === 'bulb');
  const e1 = editVerbs(W.bulb, 'bulb', { 'pos.y': '+=0.5' }, { world: W });
  check('Translate Y += 0.5 → ONE mount, same carrier, offset moved, turn kept', e1.verbs.length === 1 && e1.verbs[0].verb === 'mount' && e1.verbs[0].args.to === 'lamp' && near(e1.verbs[0].args.offset, [0, 2, 0.2], 1e-9) && e1.verbs[0].args.yaw === 0.25, JSON.stringify(e1));
  for (const v of e1.verbs) fold(st, v.verb, v.args);
  const sc2 = inspectSchema(st.entities.bulb, 'bulb', { world: st.entities });
  check('…and reads back from the fold', fieldAt(sc2, 'pos.y')!.value === 2 && fieldAt(sc2, 'pos.z')!.value === 0.2 && Math.abs(fieldAt(sc2, 'rot.y')!.value - 0.25) < 1e-9);
  const e2 = editVerbs(st.entities.bulb, 'bulb', { 'rot.x': 30 }, { world: st.entities });
  check('Rotate X → ONE mount carrying a relative q (offset kept)', e2.verbs.length === 1 && e2.verbs[0].verb === 'mount' && e2.verbs[0].args.q?.length === 4 && near(e2.verbs[0].args.offset, [0, 2, 0.2], 1e-9), JSON.stringify(e2.verbs));
  for (const v of e2.verbs) fold(st, v.verb, v.args);
  const sc3 = inspectSchema(st.entities.bulb, 'bulb', { world: st.entities, euler: e2.euler?.e });
  check('…Rotate reads back as typed', Math.abs(fieldAt(sc3, 'rot.x')!.value * 180 / Math.PI - 30) < 1e-6 && Math.abs(fieldAt(sc3, 'rot.y')!.value - 0.25) < 1e-6, JSON.stringify(['x', 'y', 'z'].map((k) => fieldAt(sc3, `rot.${k}`)!.value)));
  const e3 = editVerbs(st.entities.bulb, 'bulb', { 'pos.scale': 2 }, { world: st.entities });
  check('Scale → a place carrying ONLY scale (never the pre-mount pos)', e3.verbs.length === 1 && e3.verbs[0].verb === 'place' && JSON.stringify(Object.keys(e3.verbs[0].args).sort()) === '["id","scale"]', JSON.stringify(e3.verbs));
  const e4 = editVerbs(st.entities.bulb, 'bulb', { 'pos.yaw': 90 }, { world: st.entities });
  const q4 = e4.verbs[0]?.args.q;
  check('a heading on a tilted child keeps its tilt (q, not a bare yaw)', e4.verbs[0]?.verb === 'mount' && q4?.length === 4 && Math.abs(e4.verbs[0].args.yaw - Math.PI / 2) < 1e-4);
  // a root is unchanged: place, as always
  const e5 = editVerbs(W.lamp, 'lamp', { 'pos.x': 11 }, { world: W });
  check('a root still writes place', e5.verbs.length === 1 && e5.verbs[0].verb === 'place' && e5.verbs[0].args.pos[0] === 11);
  // a part-socket rider: read-only, says why
  const ride: any = { cart: { lib: LIB, pos: [0, 0, 0], comp: { sockets: { deck: { pos: [0, 1, 0], part: 'plank' } } } }, box: { lib: LIB, pos: [0, 0, 0], parent: { to: 'cart', slot: 'deck' } } };
  const e6 = editVerbs(ride.box, 'box', { 'pos.x': 1 }, { world: ride });
  check('a rider of a moving part: translate refused with the reason', e6.verbs.length === 0 && /moving part plank/.test(e6.errors.join()));
}

// ---------------------------------------------------------------- 5. undo
console.log('a parent edit undoes to exactly what it was');
{
  for (const start of ['root', 'other']) {
    const st: any = emptyState();
    fold(st, 'spawn', { id: 'shelf', lib: LIB, pos: [4, 1, -2], q: qNorm([0.1, 0.4, 0, 0.9]), scale: 2 });
    fold(st, 'spawn', { id: 'desk', lib: LIB, pos: [-3, 0, 5], yaw: 2 });
    fold(st, 'spawn', { id: 'book', lib: LIB, pos: [1, 1.5, 1], q: qNorm([0.2, 0, 0.3, 0.9]), scale: 0.8 });
    if (start === 'other') fold(st, 'mount', { id: 'book', to: 'desk', offset: [0.2, 0.9, 0], yaw: 0.3 });
    const snap = JSON.stringify(st.entities.book);
    const W0 = worldPose(st.entities, 'book')!;
    const r = editVerbs(st.entities.book, 'book', { 'parent.to': 'shelf' }, { world: st.entities });
    check(`(${start}) the edit carries its own inverses`, r.verbs.length === 2 && r.inverses?.length === 2, JSON.stringify(r));
    for (const v of r.verbs) fold(st, v.verb, v.args);
    check(`(${start}) parented under the scaled shelf, same world pose`, st.entities.book.parent?.to === 'shelf' && near(worldPose(st.entities, 'book')!.pos, W0.pos, 2e-3));
    for (const v of [...r.inverses].reverse()) fold(st, v.verb, v.args);   // undo sends them in reverse (inspect.js commitEdit)
    const back = st.entities.book;
    const was = JSON.parse(snap);
    check(`(${start}) undo restores the parent, pos, orientation and scale`, JSON.stringify(back.parent ?? null) === JSON.stringify(was.parent ?? null) && near(back.pos, was.pos, 1e-9)
      && sameRot(back.q ?? qFromYaw(back.yaw), was.q ?? qFromYaw(was.yaw), 1e-9) && back.scale === was.scale, JSON.stringify({ back, was }));
    check(`(${start}) …and the world pose`, near(worldPose(st.entities, 'book')!.pos, W0.pos, 1e-6));
  }
  const W: any = { a: { lib: LIB, pos: [0, 0, 0] } };
  check('unparent on a root is an error, not a verb', editVerbs(W.a, 'a', { 'parent.unparent': true }, { world: W }).errors.some((e: string) => /no parent/.test(e)));
  check('a parent edit without the world records says so (old callers)', editVerbs(W.a, 'a', { 'parent.to': 'b' }).errors.some((e: string) => /world/.test(e)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fails.length) { console.log(fails.map((f) => '  ✗ ' + f).join('\n')); process.exit(1); }
