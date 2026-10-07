// hierarchy-test — the scene tree as a pure function of the world view (design §3
// "Children", §5 "Hierarchy"; shared/hierarchy.js), checked against the REAL
// door (a scratch v4 world, tools/v4/scratchdoor.ts, read back through
// shared/v4/record.js viewState) and against three.js composing Object3Ds the
// way the renderer does.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/hierarchy-test.ts
//
// 1. tree building from a v4 world's view (nesting, folds, the filter opening a
//    folded path, a hand-written loop showing both members as roots)
// 2. cycle refusal (the pure rule, parentOps, editOps and the door's `set parent`)
// 3. local ⇄ world: parent in place / unparent keep the world pose, through
//    the real door, for random tilted + scaled carriers and nested chains
// 4. a child's channel box: local values, and an edit writes ONE local transform
// 5. undo: the door's `undo` takes a parent edit back to exactly what it was
//
// v4 port (2026-10-06): mount/dismount/place are gone: parenting is `set parent` + a LOCAL `set transform` (scale
// local too), so "a scaled carrier needs an extra place", "an upright turn travels as a bare yaw" and the v1
// inverses have no v4 meaning; undo is the door's. Guards are gone (merged into lock); a lock is the door's to
// refuse. Light-verb lights are gone (a lamp is a thing with a light component). The v1 server's vMount is
// replaced by the door's `set parent` loop refusal; a body sitting down is presence in v4, not a mount.
import * as THREE from '../client/node_modules/three/build/three.module.js';
import { treeRows, treeOf, cycleRefusal, parentOps, worldPose, localOf, childrenOf, kindHint, ancestors } from '../shared/hierarchy.js';
import { inspectSchema, editOps, fieldAt, describeSchema } from '../shared/editschema.js';
import { qNorm, qFromYaw, qHeading } from '../shared/rot.js';
import { scratchWorld, flat } from './v4/scratchdoor.ts';
import { enc } from '../shared/v4/names.js';

let pass = 0, fail = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else { fail++; if (fails.length < 40) fails.push(`${name}  — ${detail}`); } };
const rnd = (() => { let s = 777; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
const near = (a: number[], b: number[], eps: number) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);
const sameRot = (a: number[], b: number[], eps: number) => near(a, b, eps) || near(a, b.map((v) => -v), eps);
const LIB = 'eidoverse/assets/models/table_oak_round.glb';
const tfOf = (r: any) => flat(r.ops).find((o: any) => o.verb === 'set' && o.args.component === 'transform')?.args.value;

// ---------------------------------------------------------------- 1. the tree
console.log('tree building from a v4 world\'s view');
{
  const D = scratchWorld('hierarchy').seed({
    table: { lib: LIB, pos: [0, 0, 0] },
    lamp: { lib: 'eidoverse/assets/models/lamp_brass_desk.glb', pos: [0, 0.8, 0], parent: { to: 'table', offset: [0, 0.8, 0] }, comp: { light: { color: 0xffd9a0, intensity: 8, range: 4 } } },
    bulb: { pos: [0, 1.2, 0], parent: { to: 'lamp', offset: [0, 0.4, 0] }, comp: { light: { color: 0xffd9a0, intensity: 8, range: 4 } } },   // an Empty with a light
    porch: { pos: [5, 2, 0], comp: { light: { color: 0xffffff, intensity: 10, range: 6 } } },
    marker: { pos: [7, 0, 0] },                                                                                                           // a bare Empty
    chair: { lib: 'eidoverse/assets/models/chair.glb', pos: [2, 0, 0] },
  });
  const W = D.view().entities;
  const rows = treeRows(W);
  const shape = rows.map((r: any) => `${'  '.repeat(r.depth)}${r.id}`).join('|');
  check('nesting: chair, marker, porch and table are roots; lamp under table; bulb under lamp', shape === 'chair|marker|porch|table|  lamp|    bulb', shape);
  check('a row counts its children (the disclosure)', rows.find((r: any) => r.id === 'table').kids === 1 && rows.find((r: any) => r.id === 'bulb').kids === 0);
  const folded = treeRows(W, { collapsed: new Set(['table']) }).map((r: any) => r.id).join(',');
  check('folding a parent hides its subtree', folded === 'chair,marker,porch,table', folded);
  check('…and the folded row says closed', treeRows(W, { collapsed: new Set(['table']) }).find((r: any) => r.id === 'table').open === false);
  const m = (q: string) => (id: string) => id.includes(q);
  const hit = treeRows(W, { collapsed: new Set(['table', 'lamp']), matches: m('bulb') });
  check('a filter match inside a FOLDED parent shows the parent path, dimmed, opened', hit.map((r: any) => `${r.id}${r.dim ? '~' : ''}${r.open ? '' : '!'}`).join(',') === 'table~,lamp~,bulb', JSON.stringify(hit));
  check('a filter with no match is empty', treeRows(W, { matches: m('zzz') }).length === 0);
  const ex = treeRows(W, { extra: (id: string) => (id === 'chair' ? [{ id: 'rider:ann', match: true }] : []) });
  check('extra rows (a seated person) nest under their carrier and count as children', ex[1]?.id === 'rider:ann' && ex[1].depth === 1 && ex[0].kids === 1, JSON.stringify(ex.slice(0, 2)));
  check('kind hints: model stem, a model with a light, an Empty with a light (a lamp), a bare Empty', kindHint(W.table) === 'table oak round' && kindHint(W.lamp) === 'lamp brass desk + light' && kindHint(W.bulb) === 'light' && kindHint(W.porch) === 'light' && kindHint(W.marker) === 'empty',
    JSON.stringify(['table', 'lamp', 'bulb', 'porch', 'marker'].map((k) => kindHint(W[k]))));
  check('childrenOf / ancestors read the view', childrenOf(W, 'lamp').join() === 'bulb' && ancestors(W, 'bulb').join() === 'lamp,table');
  // a loop written by hand (the door refuses one; a hand-edited log file need not): both members are roots, nothing vanishes
  const loop: any = { a: { pos: [0, 0, 0], parent: { to: 'b' } }, b: { pos: [1, 0, 0], parent: { to: 'a' } }, c: { pos: [0, 0, 0], parent: { to: 'a' } } };
  const t = treeOf(loop);
  check('a looped record set: both members are roots, a child of one still nests', t.roots.join() === 'a,b' && t.kids.get('a')?.join() === 'c', JSON.stringify({ roots: t.roots, kids: [...t.kids] }));
  check('…and worldPose terminates on it', !!worldPose(loop, 'c'));
  // a carrier that is gone: the child is a root (the renderer leaves it where it stands)
  check('a missing carrier → a root', treeOf({ x: { pos: [0, 0, 0], parent: { to: 'gone' } } }).roots.join() === 'x');
}

// ---------------------------------------------------------------- 2. cycles
console.log('cycle refusal');
{
  const D = scratchWorld('hierarchy').seed({
    table: { lib: LIB, pos: [0, 0, 0] },
    lamp: { lib: LIB, pos: [0, 1, 0], parent: { to: 'table', offset: [0, 1, 0] } },
    bulb: { pos: [0, 2, 0], parent: { to: 'lamp', offset: [0, 1, 0] } },
  });
  const W = D.view().entities;
  const why = cycleRefusal(W, 'table', 'bulb');
  check('table onto its grandchild bulb is refused, naming the path', !!why && /bulb is inside table/.test(why) && /table › lamp › bulb/.test(why), String(why));
  check('table onto its child lamp is refused', !!cycleRefusal(W, 'table', 'lamp'));
  check('onto itself is refused', /own parent/.test(cycleRefusal(W, 'lamp', 'lamp') ?? ''));
  check('a sideways move is fine (bulb onto table)', cycleRefusal(W, 'bulb', 'table') === null);
  const pv = parentOps(W, 'table', 'bulb');
  check('parentOps sends nothing for a cycle and says why', pv.ops.length === 0 && pv.errors.some((e: string) => /inside table/.test(e)), JSON.stringify(pv));
  const ev = editOps(W.table, 'table', { 'parent.to': 'bulb' }, { world: W });
  check('editOps (the inspector / agent path) refuses it the same way', ev.ops.length === 0 && ev.errors.some((e: string) => /inside table/.test(e)), JSON.stringify(ev));
  // the door: an agent's raw `set parent` gets the same answer, and nothing changes
  const r = D.call('set', { id: 'table', component: 'parent', value: { to: 'bulb' } });
  check('the door refuses a looped parent (`loop`) and the table stays a root', r.ok === false && r.refused?.code === 'loop' && !D.rec('table').parent, JSON.stringify(r));
  const ok = D.send(parentOps(W, 'bulb', 'table').ops[0]);
  check('…and takes an honest one (bulb onto table, through parentOps)', ok.ok && D.rec('bulb').parent?.to === 'table', JSON.stringify(ok.refused));
  // a lock: the planner lets the door ask (no planner error); the door refuses the move, and throughLock answers it
  D.call('set', { id: 'lamp', component: 'lock', value: true });
  const LW = D.view().entities;
  const lp = parentOps(LW, 'lamp', null);
  check('a locked thing: parentOps plans the unparent (the door is the one to ask)', lp.errors.length === 0 && lp.ops.length === 1, JSON.stringify(lp));
  const lr = D.send(lp.ops[0]);
  check('…and the door refuses it `locked`; lamp still under table', lr.ok === false && lr.refused?.code === 'locked' && D.rec('lamp').parent?.to === 'table', JSON.stringify(lr));
  const lt = D.send(lp.ops[0], { throughLock: true });
  check('…throughLock unparents it, in place', lt.ok && !D.rec('lamp').parent && near(D.rec('lamp').pos, [0, 1, 0], 1e-3), JSON.stringify([lt.refused, D.rec('lamp')]));
}

// ---------------------------------------------------------------- 3. local ⇄ world
console.log('parent in place, unparent in place: the world pose survives the door');
const randQ = () => qNorm([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5])!;
const randPos = () => [(rnd() - 0.5) * 20, rnd() * 4, (rnd() - 0.5) * 20];
/** The renderer's composition, independently: three.js Object3Ds built from
 *  the view's records (a child's pos/q/scale are LOCAL to its parent, v4 §2.3). */
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
  const D = scratchWorld('hierarchy');
  let worst = 0, worstQ = 0, worstS = 0, n = 0, threeWorst = 0, scaled = 0, refused = 0;
  for (let i = 0; i < 300; i++) {
    const base = `base${i}`, arm = `arm${i}`, cup = `cup${i}`;
    const tilt = i % 3 !== 0;                                          // a third of carriers stand upright
    const bs = i % 2 ? 0.5 + rnd() * 2 : 1;
    if (bs !== 1) scaled++;
    const childTilt = i % 4 !== 0;
    D.seed({
      [base]: { lib: LIB, pos: randPos(), ...(tilt ? { q: randQ() } : { yaw: (rnd() - 0.5) * 6 }), scale: bs },
      [arm]: { lib: LIB, pos: randPos(), parent: { to: base, offset: randPos(), q: randQ() }, scale: 0.5 + rnd() },   // a nested carrier
      [cup]: { lib: LIB, pos: randPos(), ...(childTilt ? { q: randQ() } : { yaw: (rnd() - 0.5) * 6 }), scale: 0.3 + rnd() * 2 },
    });
    const to = i % 2 ? arm : base;
    const V0 = D.view().entities;
    const before = worldPose(V0, cup)!;
    const pv = parentOps(V0, cup, to);
    if (pv.errors.length) { check('parentOps refused a legal parenting', false, pv.errors.join()); continue; }
    const r1 = D.send(pv.ops[0]);
    if (!r1.ok) { refused++; check('the door takes a legal parenting', false, JSON.stringify(r1.refused)); continue; }
    const V1 = D.view().entities;
    check('the child is now under its new parent', V1[cup].parent?.to === to);
    const after = worldPose(V1, cup)!;
    const tw = threeWorld(V1, cup);
    worst = Math.max(worst, ...after.pos.map((v, k) => Math.abs(v - before.pos[k])));
    worstQ = Math.max(worstQ, sameRot(after.q, before.q, 1e-6) ? 0 : 1);
    worstS = Math.max(worstS, Math.abs(after.scale - before.scale) / before.scale);
    threeWorst = Math.max(threeWorst, ...tw.pos.map((v, k) => Math.abs(v - before.pos[k])), sameRot(tw.q, before.q, 1e-5) ? 0 : 1, Math.abs(tw.scale - before.scale) / before.scale);
    // the carrier moves (the cup rides along), then out again: unparent stands it where it IS, not where it was placed
    D.call('set', { id: base, component: 'transform', value: { pos: randPos(), q: randQ(), scale: [bs, bs, bs] } });
    const V2 = D.view().entities;
    const riding = worldPose(V2, cup)!;
    const out = parentOps(V2, cup, null);
    const r2 = D.send(out.ops[0]);
    const V3 = D.view().entities;
    const back = worldPose(V3, cup)!;
    check('unparent after the carrier moved: a root, where it rode to', r2.ok && !V3[cup].parent && near(back.pos, riding.pos, 2e-3) && sameRot(back.q, riding.q, 1e-6) && Math.abs(back.scale - riding.scale) < 2e-3,
      JSON.stringify({ r2: r2.refused, back, riding }));
    n++;
  }
  check(`parent in place keeps the world position (worst ${worst.toExponential(1)} m over ${n})`, worst < 2e-3 && n === 300, String(worst));
  check('parent in place keeps the world orientation', worstQ === 0);
  check(`parent in place keeps the world size, a scaled carrier included (${scaled} scaled carriers)`, worstS < 2e-3 && scaled > 50, String(worstS));
  check('three.js composing the view\'s records as the renderer does agrees', threeWorst < 2e-3, String(threeWorst));
}
{
  // one gesture is one request: set parent + the LOCAL transform (pos, q and scale), as one batch
  const W: any = { box: { lib: LIB, pos: [1, 0, 0], q: qNorm([0.3, 0.2, 0.1, 0.9]), scale: 2 }, ball: { lib: LIB, pos: [1, 1, 0], yaw: 0, scale: 1 } };
  const pv = parentOps(W, 'ball', 'box');
  const o = flat(pv.ops);
  check('parenting: ONE batch, set parent {to} then a whole local transform (scale local: 1/2 under a ×2 box)', pv.ops.length === 1 && pv.ops[0].verb === 'batch' && o.length === 2 && o[0].args.component === 'parent' && o[0].args.value.to === 'box'
    && o[1].args.component === 'transform' && o[1].args.value.q.length === 4 && o[1].args.value.pos.length === 3 && near(o[1].args.value.scale, [0.5, 0.5, 0.5], 1e-9), JSON.stringify(pv.ops));
  const un = flat(parentOps({ ...W, ball: { ...W.ball, parent: { to: 'box', offset: [0, 0.5, 0] } } }, 'ball', null).ops);
  check('unparenting: delete parent, then the whole WORLD transform', un.length === 2 && un[0].verb === 'delete' && un[0].args.component === 'parent' && un[1].args.component === 'transform' && near(un[1].args.value.scale, [2, 2, 2], 1e-9), JSON.stringify(un));
  check('an id that needs escaping is encoded once in the parent target', flat(parentOps({ Box: W.box, ball: W.ball }, 'ball', 'Box').ops)[0].args.value.to === enc('Box'));
  const L = localOf({ ...W.ball, parent: { to: 'box', yaw: 0.5 } }, W);
  check('localOf a yaw-only mount: q null, yaw the relative turn', L.q === null && L.yaw === 0.5 && L.mounted);
  const S = localOf({ ...W.ball, parent: { to: 'chair', socket: 'seat' } }, { ...W, chair: { lib: LIB, pos: [0, 0, 0], comp: { sockets: { seat: { pos: [0, 0.5, 0], yaw: 3 } } } } });
  check('localOf a socket mount: the socket\'s pos and yaw', near(S.pos, [0, 0.5, 0], 0) && S.yaw === 3);
}

// ---------------------------------------------------------------- 4. the channel box
console.log("a child's channel box: local, and an edit writes one local transform");
{
  const D = scratchWorld('hierarchy').seed({
    lamp: { lib: LIB, pos: [10, 0, 10], yaw: 1 },
    bulb: { pos: [3, 3, 3], yaw: 0, scale: 1, parent: { to: 'lamp', offset: [0, 1.5, 0.2], yaw: 0.25 } },
  });
  const W = D.view().entities;
  const sc = inspectSchema(W.bulb, 'bulb', { world: W });
  check('Translate reads the local offset', fieldAt(sc, 'pos.x')!.value === 0 && fieldAt(sc, 'pos.y')!.value === 1.5 && fieldAt(sc, 'pos.z')!.value === 0.2, JSON.stringify(W.bulb));
  check('Rotate Y reads the relative turn', Math.abs(fieldAt(sc, 'rot.y')!.value - 0.25) < 1e-9);
  check('the channels are editable, and the frame is said', !fieldAt(sc, 'pos.x')!.disabled && /local to its parent, lamp/.test(describeSchema(sc)));
  const card = sc.sections.list.find((c: any) => c.type === 'Transform');
  check('the Transform card says it is local to lamp', card.info?.some(([k, v]: string[]) => k === 'frame' && /lamp/.test(v)));
  check('the Parent card carries the parent field (not the header); children are still listed for agents', !sc.sections.header.includes('parent.to') && sc.sections.list.find((c: any) => c.type === 'Parent')?.fields.includes('parent.to') && fieldAt(inspectSchema(W.lamp, 'lamp', { world: W }), 'parent.children')!.value === 'bulb');
  const e1 = editOps(W.bulb, 'bulb', { 'pos.y': '+=0.5' }, { world: W });
  check('Translate Y += 0.5 → ONE local set transform (no parent op), offset moved, turn kept', flat(e1.ops).length === 1 && near(tfOf(e1).pos, [0, 2, 0.2], 1e-9) && Math.abs(qHeading(tfOf(e1).q) - 0.25) < 1e-9, JSON.stringify(e1));
  const s1 = D.send(e1.ops[0]);
  const W1 = D.view().entities;
  const sc2 = inspectSchema(W1.bulb, 'bulb', { world: W1 });
  check('…and reads back from the door, still under lamp', s1.ok && W1.bulb.parent?.to === 'lamp' && fieldAt(sc2, 'pos.y')!.value === 2 && fieldAt(sc2, 'pos.z')!.value === 0.2 && Math.abs(fieldAt(sc2, 'rot.y')!.value - 0.25) < 1e-9, JSON.stringify([s1.refused, W1.bulb]));
  const e2 = editOps(W1.bulb, 'bulb', { 'rot.x': 30 }, { world: W1 });
  check('Rotate X → ONE local transform carrying a relative tilted q (offset kept)', flat(e2.ops).length === 1 && Math.abs(tfOf(e2).q[0]) > 1e-3 && near(tfOf(e2).pos, [0, 2, 0.2], 1e-9), JSON.stringify(e2.ops));
  D.send(e2.ops[0]);
  const W2 = D.view().entities;
  const sc3 = inspectSchema(W2.bulb, 'bulb', { world: W2, euler: e2.euler?.e });
  check('…Rotate reads back as typed', Math.abs(fieldAt(sc3, 'rot.x')!.value * 180 / Math.PI - 30) < 1e-6 && Math.abs(fieldAt(sc3, 'rot.y')!.value - 0.25) < 1e-6, JSON.stringify(['x', 'y', 'z'].map((k) => fieldAt(sc3, `rot.${k}`)!.value)));
  const e3 = editOps(W2.bulb, 'bulb', { 'pos.scale': 2 }, { world: W2 });
  check('Scale → the local transform with scale 2, pos and q the local ones (never a world pos)', flat(e3.ops).length === 1 && JSON.stringify(tfOf(e3).scale) === '[2,2,2]' && near(tfOf(e3).pos, [0, 2, 0.2], 1e-9) && sameRot(tfOf(e3).q, W2.bulb.q, 1e-12), JSON.stringify(e3.ops));
  D.send(e3.ops[0]);
  const W3 = D.view().entities;
  check('…through the door: local scale 2, still at the same local offset, world scale 2 (the lamp is ×1)', W3.bulb.scale === 2 && near(W3.bulb.pos, [0, 2, 0.2], 1e-9) && Math.abs(worldPose(W3, 'bulb')!.scale - 2) < 1e-9, JSON.stringify(W3.bulb));
  const e4 = editOps(W3.bulb, 'bulb', { 'pos.yaw': 90 }, { world: W3 });
  check('a heading on a tilted child keeps its tilt (q, heading 90°)', !!tfOf(e4) && Math.abs(tfOf(e4).q[0]) > 1e-3 && Math.abs(qHeading(tfOf(e4).q) - Math.PI / 2) < 1e-4, JSON.stringify(e4.ops));
  // a root: its world transform, as always
  const e5 = editOps(W.lamp, 'lamp', { 'pos.x': 11 }, { world: W });
  check('a root writes its world transform', flat(e5.ops).length === 1 && tfOf(e5).pos[0] === 11 && tfOf(e5).pos[2] === 10);
  // a part-socket rider: read-only, says why
  const ride: any = { cart: { lib: LIB, pos: [0, 0, 0], comp: { sockets: { deck: { pos: [0, 1, 0], part: 'plank' } } } }, box: { lib: LIB, pos: [0, 0, 0], parent: { to: 'cart', socket: 'deck' } } };
  const e6 = editOps(ride.box, 'box', { 'pos.x': 1 }, { world: ride });
  check('a rider of a moving part: translate refused with the reason', e6.ops.length === 0 && /moving part plank/.test(e6.errors.join()));
}

// ---------------------------------------------------------------- 5. undo (the door's)
console.log('a parent edit undoes to exactly what it was (the door\'s undo)');
{
  for (const start of ['root', 'other']) {
    const D = scratchWorld('hierarchy').seed({
      shelf: { lib: LIB, pos: [4, 1, -2], q: qNorm([0.1, 0.4, 0, 0.9]), scale: 2 },
      desk: { lib: LIB, pos: [-3, 0, 5], yaw: 2 },
      book: { lib: LIB, pos: [1, 1.5, 1], q: qNorm([0.2, 0, 0.3, 0.9]), scale: 0.8, ...(start === 'other' ? { parent: { to: 'desk', offset: [0.2, 0.9, 0], yaw: 0.3 } } : {}) },
    });
    const W = D.view().entities;
    const snap = D.state().entities.book.c;   // the v4 components as they stood
    const W0 = worldPose(W, 'book')!;
    const r = editOps(W.book, 'book', { 'parent.to': 'shelf' }, { world: W });
    check(`(${start}) the edit is ONE request (set parent + local transform)`, r.ops.length === 1 && flat(r.ops).length === 2 && r.errors.length === 0, JSON.stringify(r));
    const s = D.send(r.ops[0]);
    const W1 = D.view().entities;
    check(`(${start}) parented under the scaled shelf, same world pose`, s.ok && W1.book.parent?.to === 'shelf' && near(worldPose(W1, 'book')!.pos, W0.pos, 2e-3) && Math.abs(worldPose(W1, 'book')!.scale - W0.scale) < 1e-6, JSON.stringify(s.refused));
    const u = D.call('undo', {});
    const back = D.state().entities.book.c;
    check(`(${start}) the door's undo restores the parent, pos, orientation and scale exactly`, u.ok && JSON.stringify(back.parent ?? null) === JSON.stringify(snap.parent ?? null) && JSON.stringify(back.transform) === JSON.stringify(snap.transform),
      JSON.stringify({ u: u.refused, back, snap }));
    check(`(${start}) …and the world pose`, near(worldPose(D.view().entities, 'book')!.pos, W0.pos, 1e-6));
  }
  const W: any = { a: { lib: LIB, pos: [0, 0, 0] } };
  check('unparent on a root is an error, not an op', editOps(W.a, 'a', { 'parent.unparent': true }, { world: W }).errors.some((e: string) => /no parent/.test(e)));
  check('a parent edit without the world records says so (old callers)', editOps(W.a, 'a', { 'parent.to': 'b' }).errors.some((e: string) => /world/.test(e)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fails.length) { console.log(fails.map((f) => '  ✗ ' + f).join('\n')); process.exit(1); }
