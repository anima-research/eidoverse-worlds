// shape-physics-test — the shape audit's wave 2, physics-motion family (notes/eidoverse/shape-audit/physics-motion.md;
// PLAN.md "Wave 2" + LOCKED). Each row is a behaviour the audit changes, through the real door (a scratch world) or the
// pure reader that carries it. Written red first, against the tree before the change (wt/w2-attach, 90725c3e).
//   usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/shape-physics-test.ts
// @ts-nocheck
import "./protocol/fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import fs from 'node:fs';
import { scratchWorld } from './protocol/scratchworld.ts';
import { COMPONENTS, statusOf, pinOf, materialize } from '../shared/protocol/componentspec.js';
import { evalWholeMotion } from '../client/lib/motioneval.js';
import { worldPose, TICK_MS } from '../shared/protocol/simlayer.js';
import { GRID_DEFAULTS, APERTURES } from '../shared/structure.js';
import { colliderOf } from '../shared/components.js';
import { translate } from './protocol/import-v1/translate-v1.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: any = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail !== '' ? `  — ${JSON.stringify(detail).slice(0, 300)}` : ''}`); };
const code = (r: any) => r?.refused?.code ?? (r?.ok ? 'ok' : 'error');
const near = (a: number[], b: number[], e = 1e-9) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < e);
const tryRow = async (name: string, f: () => any) => { try { await f(); } catch (e) { check(`${name} (threw)`, false, String(e?.stack ?? e).slice(0, 300)); } };
const ENGINE = new URL('..', import.meta.url).pathname;
const read = (p: string) => fs.readFileSync(ENGINE + p, 'utf8');

// ===================================================================== transform: glTF TRS, pinned; the composition rule written down
await tryRow('TF', () => {
  const T = COMPONENTS.transform;
  check('TF1 transform pins its units and the door\'s ranges (pos ±1e5 m, scale ±1e3 ×)', T.units?.pos === 'm' && T.units?.scale === '×' && T.ranges?.pos?.max === 1e5 && T.ranges?.pos?.min === -1e5 && T.ranges?.scale?.max === 1e3 && !!pinOf().transform.ranges, T);
  check('TF1 …and every vector names its frame (parent\'s)', /parent's frame/.test(T.docs?.pos ?? '') && /parent's frame/.test(T.docs?.q ?? ''), T.docs);
  const P = read('spec/PROTOCOL.md');
  check('TF2 PROTOCOL §9 writes the composition rule down (glTF: local = T · R · S, world = parent × local)', /T · R · S/.test(P) && /### 9\.3/.test(P), '');
  const S = read('shared/protocol/simlayer.js');
  check('TF3 simlayer worldPose says where it is exact and where it approximates glTF (a TODO, not a silent difference)', /TODO/.test(S.slice(S.indexOf('export function worldPose') - 900, S.indexOf('export function worldPose'))) && /shear/i.test(S.slice(S.indexOf('export function worldPose') - 900, S.indexOf('export function worldPose'))), '');
  // the exact case: a rotated, uniformly scaled parent
  const s = Math.SQRT1_2; const st = { entities: { p: { c: { transform: { pos: [1, 0, 0], q: [0, s, 0, s], scale: [2, 2, 2] } } }, k: { c: { parent: { to: 'p' }, transform: { pos: [1, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } } } } };
  const w = worldPose(st, 'k');
  check('TF4 worldPose under a rotated, uniformly scaled parent is glTF\'s (pos = parent pos + R·(S·pos))', near(w.pos, [1, 0, -2], 1e-9) && near(w.scale, [2, 2, 2]), w);
});

// ===================================================================== parent: −order
await tryRow('PA', () => {
  check('PA1 parent is {to, socket (legacy)}: no order, no default', JSON.stringify(Object.keys(COMPONENTS.parent.fields)) === '["to","socket"]' && !COMPONENTS.parent.defaults, COMPONENTS.parent);
  const W = scratchWorld('w2p-parent').seed({ table: { model: 'crate', pos: [0, 0, 0] }, cup: { model: 'crate', pos: [3, 0, 0] } });
  const r = W.call('set', { id: 'cup', component: 'parent', value: { to: 'table', order: 'a0' } });
  check('PA2 a written order is taken and dropped: the stored parent is {to}', r.ok && JSON.stringify(W.state().entities.cup.c.parent) === '{"to":"table"}', [r.refused, W.state().entities.cup.c.parent]);
  W.call('create', { id: 'sofa', model: 'crate' });
  const m = W.call('set', { id: 'sofa', component: 'sockets', value: { left: { pos: [0, 0.5, 0], body: {} } } });
  const kid = Object.values(W.state().entities).find((e: any) => e.c.parent?.to === 'sofa' && e.c.socket);
  check('PA3 the authority writes no order either (a socket child made by the lift)', m.ok && JSON.stringify(kid?.c.parent) === '{"to":"sofa"}', [m.refused, kid?.c.parent]);
  const old = [{ seq: 0, ts: 1, actor: 'world', verb: 'genesis', args: { v: 2, dialect: 'eidoverse-log', roles: { ann: { role: 'owner' } } } },
    { seq: 1, ts: 2, actor: 'ann', verb: 'spawn', args: { id: 'cart', lib: 'crate', pos: [0, 0, 0] } },
    { seq: 2, ts: 3, actor: 'ann', verb: 'spawn', args: { id: 'box', lib: 'crate', pos: [1, 0, 0] } },
    { seq: 3, ts: 4, actor: 'ann', verb: 'mount', args: { id: 'box', to: 'cart', offset: [0, 1, 0] } }];
  const t = translate(old);
  check('PA4 translate-v1@12 writes a mount\'s parent without order', JSON.stringify(t.final.translated.box?.parent) === '{"to":"cart"}' && !t.stats.divergences, [t.final.translated.box?.parent, t.stats.divergences]);
});

// ===================================================================== pivot: {pos} registered
await tryRow('PV', () => {
  const P = COMPONENTS.pivot;
  check('PV1 pivot registers {pos: vec3}: metres, own frame, ±1e4, and what absence means (its origin)', JSON.stringify(P.fields) === '{"pos":"vec3"}' && P.units?.pos === 'm' && P.ranges?.pos?.max === 1e4 && /origin/.test(P.absentMeans?.pos ?? '') && /origin/.test(pinOf().pivot.absentMeans?.pos ?? ''), P);
  const W = scratchWorld('w2p-pivot').seed({ gate: { model: 'crate', pos: [0, 0, 0] } });
  check('PV2 the door still takes {pos} and refuses anything else', W.call('set', { id: 'gate', component: 'pivot', value: { pos: [0.5, 0, 0] } }).ok && code(W.call('set', { id: 'gate', component: 'pivot', value: { pos: [0, 0, 0], q: [0, 0, 0, 1] } })) !== 'ok');
});

// ===================================================================== motion: trims, readings into the registry, one hinge
await tryRow('MO', async () => {
  const M = COMPONENTS.motion;
  check('MO1 motion has no amplitude and no part field', !('amplitude' in M.fields) && !('part' in M.fields), Object.keys(M.fields));
  check('MO1 …the reader-only readings are written down (pendulum 3.5 s, damp 0, a whole thing about its origin) and t0 is epoch ms', /3\.5/.test(M.absentMeans?.period ?? '') && /^0/.test(M.absentMeans?.damp ?? '') && /origin/.test(M.absentMeans?.pivot ?? '') && M.units?.t0 === 'ms', M.absentMeans);
  const W = scratchWorld('w2p-motion').seed({ swing: { model: 'crate', pos: [0, 0, 0] }, fan: { model: 'crate', pos: [3, 0, 0] } });
  const C = (id: string) => W.state().entities[id].c;
  let r = W.call('set', { id: 'swing', component: 'motion', value: { type: 'pendulum', amplitude: 0.3 } });
  check('MO2 amplitude is refused (did you mean amp)', code(r) === 'schema' && (r.refused?.didYouMean ?? []).includes('amp'), r.refused);
  r = W.call('set', { id: 'fan', component: 'motion', value: { type: 'spin', part: 'blade' } });
  check('MO3 a part field is refused: a node\'s motion is motion:<slot> {node} (review r7: the name is data)', code(r) === 'schema' && /motion:<slot>/.test(r.refused?.fix ?? '') && /node/.test(r.refused?.fix ?? ''), r.refused);
  check('MO3 …and motion:<part> is taken', W.call('set', { id: 'fan', component: 'motion:blade', value: { type: 'spin' } }).ok);
  r = W.call('set', { id: 'fan', component: 'motion', value: { type: 'spin', axis: 'x' } });
  check('MO4 a letter axis is stored as its vector', r.ok && JSON.stringify(C('fan').motion.axis) === '[1,0,0]', [r.refused, C('fan').motion]);
  r = W.call('set', { id: 'fan', component: 'motion', value: { type: 'bob', axis: '-z' } });
  check('MO4 …a negative one too', r.ok && JSON.stringify(C('fan').motion.axis) === '[0,0,-1]', [r.refused, C('fan').motion]);
  r = W.call('set', { id: 'swing', component: 'motion', value: { type: 'pendulum', pivot: [0, 2, 0] } });
  check('MO5 a whole motion\'s pivot is refused (not silently dropped): its hinge is the pivot component', code(r) === 'derived' && /pivot component|component: 'pivot'/.test(`${r.refused?.reason} ${r.refused?.fix}`), r.refused);
  r = W.call('set', { id: 'swing', component: 'motion:seat', value: { type: 'pendulum', pivot: [0, 0.6, 0] } });
  check('MO6 a part\'s motion keeps its pivot (in the part\'s frame)', r.ok && JSON.stringify(C('swing')['motion:seat'].pivot) === '[0,0.6,0]', [r.refused, C('swing')['motion:seat']]);
  const base = { pos: [0, 0, 0], yaw: 0 }; const m = { type: 'pendulum', axis: [1, 0, 0], amp: 0.5, period: 2, damp: 0, phase: 0, t0: 0 };
  const a = evalWholeMotion(base, m, 300), b = evalWholeMotion({ ...base, pivot: [0, 0, 0] }, m, 300);
  check('MO7 a whole pendulum with no pivot component swings about its origin', a.ok && near(a.pos, b.pos) && near(a.pos, [0, 0, 0]), [a.pos, b.pos]);

  const { repairComps, shapeRepairOps } = await import('../shared/protocol/shaperepair.js');
  const R = repairComps({ motion: { type: 'pendulum', amplitude: 0.4, axis: 'z' }, collider: { shape: 'exact' } }).c;
  check('MO8 repair: amplitude → amp, a letter axis → its vector, the old period/damp readings written, the old swing point a pivot', JSON.stringify(R.motion) === '{"type":"pendulum","axis":[0,0,1],"amp":0.4,"period":3.5,"damp":0}' && JSON.stringify(R.pivot) === '{"pos":[0,2,0]}', R);
  check('MO8 …collider exact → mesh', R.collider?.shape === 'mesh', R.collider);
  const P2 = repairComps({ motion: { type: 'spin', part: 'arm', degPerSec: 10 } }).c;
  check('MO8 …a bare motion naming a part becomes motion:<slot> {node} (arm is a tag: its own slot)', !P2.motion && JSON.stringify(P2['motion:arm']) === '{"type":"spin","degPerSec":10,"node":"arm"}', P2);
  const P3 = repairComps({ motion: { type: 'spin', part: 'arm' }, 'motion:arm': { type: 'bob' } }).c;
  check('MO8 …an existing motion:<part> wins', !P3.motion && P3['motion:arm'].type === 'bob', P3);
  const P4 = repairComps({ motion: { type: 'spin', pivot: [0.1, 0.2, 0.3] } }).c;
  check('MO8 …a whole motion\'s pivot field moves to the pivot component', !('pivot' in P4.motion) && JSON.stringify(P4.pivot) === '{"pos":[0.1,0.2,0.3]}', P4);
  const P5 = repairComps({ motion: { type: 'pendulum', period: 2, damp: 0.1 }, pivot: { pos: [0, 1, 0] } });
  check('MO8 …a pendulum that already has its pivot and readings is left alone (a second run finds nothing)', P5.set.length === 0 && P5.del.length === 0, P5);
  const st = { entities: { '@world': { c: {} }, s: { c: { motion: { type: 'pendulum', amp: 0.3, period: 2, damp: 0 } } }, t: { c: { motion: { type: 'spin', axis: 'y' } } } } };
  const ops = shapeRepairOps(st);
  check('MO9 the load\'s ops: a pivot for the pendulum that relied on [0, 2, 0], a vector axis for the spin', ops.some((o: any) => o.id === 's' && o.comp === 'pivot' && JSON.stringify(o.value) === '{"pos":[0,2,0]}') && ops.some((o: any) => o.id === 't' && o.comp === 'motion' && JSON.stringify(o.value.axis) === '[0,1,0]') && ops.length === 2, ops);
  const Ld = read('shared/protocol/authority.js');
  check('MO9 …and the server\'s first load applies them (liftWorld: repair-shapes)', /shapeRepairOps\(/.test(Ld.slice(Ld.indexOf('export function liftWorld'), Ld.indexOf('export function liftWorld') + 4000)) && /"repair-shapes"/.test(Ld), '');

  const old = [{ seq: 0, ts: 1, actor: 'world', verb: 'genesis', args: { v: 2, dialect: 'eidoverse-log', roles: { ann: { role: 'owner' } } } },
    { seq: 1, ts: 2, actor: 'ann', verb: 'spawn', args: { id: 'bell', lib: 'crate', pos: [0, 0, 0] } },
    { seq: 2, ts: 3, actor: 'ann', verb: 'comp', args: { id: 'bell', type: 'motion', data: { type: 'pendulum', amplitude: 0.2, axis: 'z' } } },
    { seq: 3, ts: 4, actor: 'ann', verb: 'spawn', args: { id: 'mill', lib: 'crate', pos: [2, 0, 0] } },
    { seq: 4, ts: 5, actor: 'ann', verb: 'comp', args: { id: 'mill', type: 'motion', data: { type: 'spin', part: 'sails', degPerSec: 20 } } },
    { seq: 5, ts: 6, actor: 'ann', verb: 'comp', args: { id: 'mill', type: 'collider', data: { shape: 'exact' } } }];
  const t = translate(old); const f = t.final.translated;
  check('MO10 translate-v1@12 repairs as the load does: amp, vector axis, the readings, the pivot', JSON.stringify(f.bell?.motion) === '{"type":"pendulum","axis":[0,0,1],"amp":0.2,"period":3.5,"damp":0}' && JSON.stringify(f.bell?.pivot) === '{"pos":[0,2,0]}', f.bell);
  check('MO10 …a part\'s motion under its key, collider mesh; 0 divergences', JSON.stringify(f.mill?.['motion:sails']) === '{"type":"spin","degPerSec":20,"node":"sails"}' && !f.mill?.motion && f.mill?.collider?.shape === 'mesh' && !t.stats.divergences, [f.mill, t.stats.divergences]);
});

// ===================================================================== physics: kind required, reserved fields, cuts, kinematic stamps
await tryRow('PH', () => {
  // deviation from the audit, by evidence: mass and density are READ (shared/shove.js massOf, the body shove's cap), so they
  // stay open fields; the other eight have no reader and are reserved
  const P = COMPONENTS.physics; const RES = ['surface', 'friction', 'restitution', 'frictionCombine', 'restitutionCombine', 'linearDamping', 'angularDamping', 'centerOfMass'];
  check('PH1 physics.kind is required, with no default', (P.required ?? []).includes('kind') && !P.defaults?.kind, [P.required, P.defaults]);
  check('PH1 …its fields are kind, who, shape, mass, density (the shove reads the last two); the eight unread properties are reserved fields (names held)', JSON.stringify(Object.keys(P.fields)) === '["kind","who","shape","mass","density"]' && JSON.stringify(P.reservedFields) === JSON.stringify(RES) && JSON.stringify(pinOf().physics.reservedFields) === JSON.stringify(RES), [Object.keys(P.fields), P.reservedFields]);
  check('PH1 …material is renamed surface; layers, mask, ccd are cut', !('material' in P.fields) && RES.includes('surface') && !['layers', 'mask', 'ccd'].some((k) => k in P.fields || RES.includes(k)), '');
  const W = scratchWorld('w2p-physics').seed({ ball: { model: 'crate', pos: [0, 0, 0] } });
  check('PH2 physics {} is refused: kind is required', code(W.call('set', { id: 'ball', component: 'physics', value: {} })) === 'schema');
  const ok = W.call('set', { id: 'ball', component: 'physics', value: { kind: 'dynamic' } });
  check('PH2 …{kind: dynamic} is taken, who materialized', ok.ok && W.state().entities.ball.c.physics.who === 'visitor', [ok.refused, W.state().entities.ball.c.physics]);
  check('PH3 …mass is taken (the shove reads it)', W.call('set', { id: 'ball', component: 'physics', value: { kind: 'dynamic', mass: 2 } }).ok);
  check('PH3 a reserved field is refused as reserved: friction, surface, centerOfMass', ['centerOfMass', 'friction', 'surface'].every((k) => code(W.call('set', { id: 'ball', component: 'physics', value: { kind: 'dynamic', [k]: k === 'surface' ? 'ice' : k === 'centerOfMass' ? [0, 0, 0] : 1 } })) === 'reserved'));
  check('PH4 layers, mask, ccd are refused (cut)', ['layers', 'mask', 'ccd'].every((k) => code(W.call('set', { id: 'ball', component: 'physics', value: { kind: 'dynamic', [k]: k === 'ccd' ? true : 1 } })) === 'schema'));
  const mat = W.call('set', { id: 'ball', component: 'physics', value: { kind: 'dynamic', material: 'ice' } });
  check('PH5 material says it is renamed surface', code(mat) === 'schema' && (mat.refused?.didYouMean ?? []).includes('surface'), mat.refused);
  // the stamp: kinematic for what moves
  const S = scratchWorld('w2p-stamp').seed({ door: { model: 'crate', pos: [0, 0, 0] }, wheel: { model: 'crate', pos: [3, 0, 0] }, rock: { model: 'crate', pos: [6, 0, 0] } });
  S.call('set', { id: 'door', component: 'openable', value: { open: false } });
  S.call('set', { id: 'wheel', component: 'motion', value: { type: 'spin' } });
  const e = S.call('set', { id: '@world', component: 'physics-engine', value: { engine: 'eidosim@1.0.0' } });
  const K = (id: string) => S.state().entities[id].c.physics?.kind;
  check('PH6 a world that turns physics on stamps kinematic on what moves (openable, motion), static on the rest', e.ok && K('door') === 'kinematic' && K('wheel') === 'kinematic' && K('rock') === 'static', [e.refused, K('door'), K('wheel'), K('rock')]);
  S.call('set', { id: 'rock', component: 'motion', value: { type: 'bob' } });
  check('PH6 …and a static thing that starts moving becomes kinematic', K('rock') === 'kinematic', K('rock'));
  check('PH7 mass\'s meaning of absence says the box, and agrees with eidosim (1000 kg/m³ × its box)', /bounding box/.test(P.absentMeans?.mass ?? '') && /1000 kg\/m³/.test(P.absentMeans?.mass ?? '') && /1000 kg\/m³/.test(P.absentMeans?.density ?? '') && /DENSITY = 1000/.test(read('shared/sim.js')), P.absentMeans);
  check('PH8 carrying keeps today\'s rule (physics.who reads as carry for a dynamic thing with no grabbable)', /physics\.who/.test(COMPONENTS.grabbable.help) && /pick it up/.test(P.docs?.who ?? ''), '');
});

// ===================================================================== physics-engine, collider, joints, structure, surface, stage
await tryRow('PE', () => {
  const E = COMPONENTS['physics-engine'];
  check('PE1 physics-engine: tickMs default 33 in the registry, its range the engine\'s (TICK_MS), ms; build a string', E.defaults?.tickMs === 33 && E.ranges?.tickMs?.min === TICK_MS.min && E.ranges?.tickMs?.max === TICK_MS.max && E.units?.tickMs === 'ms' && E.fields.build === 'string', E);
  check('PE1 …gravity is documented as the engine\'s own', /−9\.81|-9\.81/.test(E.help) && /gravity/.test(JSON.stringify(E.absentMeans ?? {})), E.help);
  const A = read('shared/protocol/authority.js');
  check('PE2 the authority reads the default from the registry, not a literal 33', /COMPONENTS\["physics-engine"\]\.defaults\.tickMs/.test(A) && !/tickMs\) \? v\.tickMs : 33/.test(A), '');
});
await tryRow('CO', () => {
  const Co = COMPONENTS.collider;
  check('CO1 collider\'s vocabulary is mesh | box | sphere', JSON.stringify(Co.enums?.shape) === '["mesh","box","sphere"]', Co.enums);
  check('CO1 …and its absence is pinned for both readers (physics: its box; walking: the size rule)', /physics/.test(Co.absentMeans?.shape ?? '') && /16 m²/.test(Co.absentMeans?.shape ?? '') && /2 m²/.test(Co.absentMeans?.shape ?? ''), Co.absentMeans);
  const W = scratchWorld('w2p-collider').seed({ hut: { model: 'crate', pos: [0, 0, 0] } });
  const r = W.call('set', { id: 'hut', component: 'collider', value: { shape: 'exact' } });
  check('CO2 exact is taken and stored as mesh', r.ok && W.state().entities.hut.c.collider.shape === 'mesh', [r.refused, W.state().entities.hut.c.collider]);
  check('CO3 the walker reads mesh as its triangles (and an old exact the same)', colliderOf({ collider: { shape: 'mesh' } }) === 'exact' && colliderOf({ collider: { shape: 'exact' } }) === 'exact' && colliderOf({ collider: { shape: 'box' } }) === 'box');
});
await tryRow('JT', () => {
  check('JT1 the physics constraint is physics-joint: reserved, no pinned fields', statusOf('physics-joint') === 'reserved' && !COMPONENTS['physics-joint'].fields && !pinOf()['physics-joint'].fields, COMPONENTS['physics-joint']);
  check('JT2 joint is a reserved SKELETON node (Maya/glTF/VRM), not the constraint', statusOf('joint') === 'reserved' && /skeleton/i.test(COMPONENTS.joint.help) && /glTF/.test(COMPONENTS.joint.help) && /VRM/.test(COMPONENTS.joint.help) && !COMPONENTS.joint.fields, COMPONENTS.joint);
  const W = scratchWorld('w2p-joint').seed({ a: { model: 'crate', pos: [0, 0, 0] } });
  check('JT3 a write of either is refused as reserved', code(W.call('set', { id: 'a', component: 'joint', value: {} })) === 'reserved' && code(W.call('set', { id: 'a', component: 'physics-joint:hinge', value: {} })) === 'reserved');
  check('JT4 PHYSICS §3.3 sketches the two-frame target shape (docs only)', /physics-joint/.test(read('spec/PHYSICS.md')) && /two\s+frames|two-frame/.test(read('spec/PHYSICS.md')), '');
});
await tryRow('SR', () => {
  const S = COMPONENTS.structure;
  check('SR1 structure\'s grid numbers are the registry\'s and equal structure.js GRID_DEFAULTS', S.defaults?.tile === GRID_DEFAULTS.tile && S.defaults?.wallH === GRID_DEFAULTS.wallH && S.defaults?.wallT === GRID_DEFAULTS.wallT && /0\.10/.test(S.absentMeans?.slabT ?? '') && GRID_DEFAULTS.slabT === 0.1, [S.defaults, S.absentMeans]);
  check('SR1 …its nested grammar is pinned: the aperture kinds are structure.js APERTURES', JSON.stringify(pinOf().structure.nestedEnums?.['levels[].apertures[][3]']) === JSON.stringify(Object.keys(APERTURES)) && S.units?.wallH === 'm', pinOf().structure);
  const m = materialize('structure', { levels: [] }).value;
  check('SR2 a structure written without its numbers gets them (slabT stays absent)', m.tile === 1 && m.wallH === 2.8 && m.wallT === 0.15 && !('slabT' in m), m);
});
await tryRow('SU', () => {
  const U = COMPONENTS.surface;
  check('SU1 surface is reserved (writes closed with physics\' reserved fields), its fields and absence written down', statusOf('surface') === 'reserved' && !!U.fields && !!U.absentMeans?.frictionCombine && U.absentMeans?.restitutionCombine === 'max', U);
  check('SU2 the combine order is documented, KHR\'s reversal included', /KHR/.test(U.help) && /KHR/.test(read('spec/PHYSICS.md').slice(read('spec/PHYSICS.md').indexOf('3.2'))), '');
  const W = scratchWorld('w2p-surface');
  check('SU3 a surface write is refused as reserved', code(W.call('set', { id: '@world', component: 'surface:ice', value: { friction: 0.02 } })) === 'reserved');
});
await tryRow('SG', () => {
  const G = COMPONENTS.stage;
  check('SG1 stage.speaker is a string ≤ 80, with its absence written down', G.fields.speaker === 'string' && G.ranges?.speaker?.maxLen === 80 && !!G.absentMeans?.speaker, G);
  const W = scratchWorld('w2p-stage').seed({ screen: { model: 'crate', pos: [0, 0, 0] } });
  check('SG2 a non-string speaker is refused; a name is taken', code(W.call('set', { id: 'screen', component: 'stage', value: { speaker: 5 } })) === 'shape' && W.call('set', { id: 'screen', component: 'stage', value: { speaker: 'Mica' } }).ok);
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
