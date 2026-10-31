// shape-repair-test — the load's shape repair after review round 7 (notes/eidoverse/REVIEW-holes-r7-2026-10-16.md F1, F2, F5)
// and R's rulings of 10-16: a node's name from a model file is DATA (motion:<slot> {node}), the repair runs ONCE per world
// (a marker the log carries), and one bad value never blocks the rest. Reviewer item 9 (10-18): the repair is an EXPLICIT maintenance
// command (authority repairShapes; world.ts repair, with a backup and --rollback; an operator's operator-repair), never the load's. Each row was written red against wt/repair @
// 080a8fef. Stored "pre-audit" worlds are built in memory (worldOf, unsigned, no custody): their founding has no stamp,
// so liftWorld treats them as old, which is exactly what a log written before the audit looks like.
//   usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/shape-repair-test.ts
// @ts-nocheck
import { fileURLToPath } from "node:url";
import "./protocol/fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import fs from 'node:fs';
import { scratchWorld } from './protocol/scratchworld.ts';
import { worldOf, CHANGE } from '../shared/protocol/authority/storage.js';
import { request, liftWorld, repairShapes, maintain, maintenanceNeeds, posAt, LAB_CATALOGUE } from '../shared/protocol/authority.js';
import { openWorld } from '../server/filehost.ts';
import { isComponent } from '../shared/protocol/fold.js';
import { partSlot, motionNode } from '../shared/protocol/names.js';
import { repairComps, repairWorld, shapesMarked, SHAPES_VERSION } from '../shared/protocol/shaperepair.js';
import { carrierMotion } from '../client/lib/socksignals.js';
import { addOps } from '../shared/editschema.js';
import { translate } from './protocol/import-v1/translate-v1.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: any = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail !== '' ? `  — ${JSON.stringify(detail).slice(0, 400)}` : ''}`); };
const tryRow = async (name: string, f: () => any) => { try { await f(); } catch (e) { check(`${name} (threw)`, false, String(e?.stack ?? e).slice(0, 400)); } };
const ENGINE = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => fs.readFileSync(ENGINE + p, 'utf8');
const KEY = 'ed25519:NP1SCq4fthEWnhu_stdrB1gT8wu06eXvKTemf02lqSw';
const ANY = Object.freeze({ get: (n) => LAB_CATALOGUE.get(n) ?? (typeof n === 'string' && n ? { label: n, surfaces: [] } : undefined), list: (q) => LAB_CATALOGUE.list(q) });
const TF = { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] };

/** A world as a log written before the audit holds it: an unstamped founding, then the old spellings set raw. */
function legacyWorld(things: Record<string, Record<string, any>>, world: Record<string, any> = {}, catalogue: any = ANY) {
  const entries: any[] = []; let T = 1785000000000;
  const io = { name: 'legacy', entries, getBlob: () => { throw new Error('no blobs'); }, putBlob: () => { throw new Error('no blobs'); }, writeLine: () => {}, now: () => (T += 1000), catalogue };
  const w = worldOf(io);
  w.append({ kind: 'genesis', actor: 'system', verb: 'genesis', body: { dialect: 'eidoverse-log', v: 4, minor: 0, nonce: 'j1783lQSA7cL_W-K6NwvNw', owners: [[], [KEY]], sequencer: KEY } });
  const a = w.append({ kind: 'act', actor: 'olive', verb: 'create-world', body: { request: { title: 'old' } } });
  const ops: any[] = [{ verb: 'set', id: '@world', comp: 'roles:olive', value: { role: 'owner' } }];
  for (const [k, v] of Object.entries(world)) ops.push({ verb: 'set', id: '@world', comp: k, value: v });
  for (const [id, c] of Object.entries(things)) { ops.push({ verb: 'create', id }); for (const [k, v] of Object.entries({ transform: TF, ...c })) ops.push({ verb: 'set', id, comp: k, value: v }); }
  w.append({ kind: 'change', actor: 'olive', cause: a, verb: 'batch', body: { ops } }, CHANGE);
  return w;
}
const C = (w, id) => w.state().entities[id]?.c ?? {};
const repairOf = (out) => out.find((x) => x.repair)?.repair;
// reviewer item 9 (10-18): the load never repairs; a stored world is repaired by the explicit command. These rows load, then run it
const repairOut = (w) => { liftWorld(w); const r = repairShapes(w); return [{ repair: { repaired: r.repaired ?? [], failed: r.failed ?? [] } }]; };

// ===================================================================== F1: a node's name is data (motion:<slot> {node})
await tryRow('RP1', () => {
  const r = repairComps({ motion: { type: 'spin', part: 'tripo_part_3', degPerSec: 10 } });
  const keys = Object.keys(r.c).filter((k) => k.startsWith('motion:'));
  check('RP1 a bare motion naming tripo_part_3 becomes motion:<slot> {node: "tripo_part_3"}, its key in the §2.3 grammar', keys.length === 1 && isComponent(keys[0]) && r.c[keys[0]].node === 'tripo_part_3' && !r.c.motion, r.c);
  check('RP1 …the slot is a pure function of the name (the same on every server): a tag keeps itself, any other is sanitized + 8 hex', partSlot('tripo_part_3') === partSlot('tripo_part_3') && partSlot('seat') === 'seat' && /^tripo-part-3-[0-9a-f]{8}$/.test(partSlot('tripo_part_3')) && partSlot('Tripo_Part') !== partSlot('tripo-part'), [partSlot('tripo_part_3'), partSlot('Tripo_Part'), partSlot('tripo-part')]);
  check('RP1 …a second run finds nothing to do', repairComps(r.c).set.length === 0 && repairComps(r.c).del.length === 0, repairComps(r.c));
  const k2 = repairComps({ 'motion:plank': { type: 'oscillate', amp: 0.1, period: 2 } }).c;
  check('RP1 …a keyed motion stored before the node was data gets its key\'s tag as node (what motion.js read)', k2['motion:plank']?.node === 'plank', k2);
  const k3 = repairComps({ motion: { type: 'spin', part: 'Seat Plank' }, 'motion:p0': { type: 'oscillate', node: 'Seat Plank' } }).c;
  check('RP1 …a motion already on that node wins (the bare one is dropped)', !k3.motion && Object.keys(k3).filter((k) => k.startsWith('motion:')).length === 1 && k3['motion:p0'].type === 'oscillate', k3);
});

await tryRow('RP2', () => {
  const w = legacyWorld({ swing: { model: 'crate', motion: { type: 'pendulum', part: 'tripo_part_3', amp: 0.3, period: 2, damp: 0 } }, mill: { model: 'crate', motion: { type: 'spin', part: 'tripo_part_fused_0', degPerSec: 20 } } });
  const out = repairOut(w); const rep = repairOf(out);
  check('RP2 the repair command repairs a world whose parts are named tripo_part_3 / tripo_part_fused_0 (the Commons; was refused whole)', rep && rep.repaired.includes('swing') && rep.repaired.includes('mill') && !rep.failed.length, out);
  const k = `motion:${partSlot('tripo_part_3')}`;
  check('RP2 …the swing\'s part motion is at motion:<slot>, naming its node', C(w, 'swing')[k]?.node === 'tripo_part_3' && C(w, 'swing')[k]?.type === 'pendulum' && !C(w, 'swing').motion, C(w, 'swing'));
  check('RP2 …readers find it by node (motionNode)', motionNode(k, C(w, 'swing')[k]) === 'tripo_part_3' && motionNode('motion:plank', { type: 'spin' }) === 'plank' && motionNode('motion', { type: 'spin' }) === null, '');
});

// ===================================================================== F2: once per world, only on what was stored before
await tryRow('RP3', () => {
  const w = legacyWorld({ bell: { model: 'crate', motion: { type: 'pendulum', amp: 0.3, period: 2, damp: 0 } } });
  check('RP3 a log written before the audit is unmarked', !shapesMarked(w.entries), '');
  repairOut(w);
  check('RP3 the repair writes the old swing point as its pivot (pre-audit data)', JSON.stringify(C(w, 'bell').pivot) === '{"pos":[0,2,0]}', C(w, 'bell'));
  const n = w.entries.length; const again = liftWorld(w);
  check('RP3 …and marks the world: a second load writes nothing and reports no repair', shapesMarked(w.entries) && w.entries.length === n && !repairOf(again), [again, w.entries.length - n]);
  // today's writes, on the repaired world
  let r = request(w, 'olive', 'delete', { id: 'bell', component: 'pivot' });
  check('RP3 the owner deletes the pivot', r.ok, r.refused);
  r = request(w, 'olive', 'create', { id: 'swing-x', model: 'crate', components: { transform: TF } }); const r2 = request(w, 'olive', 'set', { id: 'swing-x', component: 'motion', value: { type: 'pendulum', amp: 0.4 } });
  check('RP3 a pendulum is set today without a pivot', r.ok && r2.ok && !C(w, 'swing-x').pivot, [r.refused, r2.refused]);
  const m = w.entries.length; liftWorld(w); repairShapes(w);
  check('RP3 …a reload (and another repair run) keeps the deleted pivot deleted', !C(w, 'bell').pivot, C(w, 'bell'));
  check('RP3 …and gives today\'s pendulum no pivot (it swings about its origin, as it did when it was set)', !C(w, 'swing-x').pivot && w.entries.length === m, [C(w, 'swing-x'), w.entries.length - m]);
});

await tryRow('RP4', () => {
  const W = scratchWorld('repair');
  W.call('create', { id: 'sw', model: 'crate', components: { transform: TF } });
  const r = W.call('set', { id: 'sw', component: 'motion', value: { type: 'pendulum', amp: 0.4 } });
  const r2 = W.call('create', { id: 'lamp', components: { transform: TF, light: { kind: 'point' } } });
  check('RP4 a world founded today is marked from its founding (create-world {shapes})', shapesMarked(W.entries()) && r.ok && r2.ok, [r.refused, r2.refused]);
  const w2 = openWorld(W.root, W.name); w2.catalogue = ANY; const n = w2.entries.length; const out = liftWorld(w2);
  check('RP4 …its first reload repairs nothing and writes nothing: today\'s pendulum keeps no pivot', !repairOf(out) && w2.entries.length === n && !w2.state().entities.sw.c.pivot && w2.state().entities.lamp.c.light?.decay === 2, [out, w2.state().entities.sw.c]);
});

// ===================================================================== F5: per thing; the sky's azimuth once
await tryRow('RP5', () => {
  const w = legacyWorld({ good: { light: { kind: 'point', color: 1, intensity: 16, range: 10 } }, bad: { light: { kind: 'point', color: 1, intensity: 16, range: 0 } } });
  const out = repairOut(w); const rep = repairOf(out);
  check('RP5 one thing the door refuses (a light with range 0) doesn\'t block the rest: the good light is repaired (decay 1.7)', C(w, 'good').light?.decay === 1.7 && rep?.repaired.includes('good'), [out, C(w, 'good')]);
  check('RP5 …the refused thing keeps its old spelling and is named', C(w, 'bad').light?.decay === undefined && rep?.failed.some((f) => f.id === 'bad' && f.reason), rep);
  const act = w.entries.filter((e) => e?.kind === 'act' && e.verb === 'repair-shapes');
  check('RP5 …in the act too ({v, ids, failed}), which marks the world', act.length === 1 && act[0].body.v === SHAPES_VERSION && act[0].body.failed?.[0]?.id === 'bad' && shapesMarked(w.entries), act.map((e) => e.body));
  check('RP5 …and the server\'s outcome isn\'t a socket host\'s (no top-level failed/host for the lift\'s line to misread)', out.every((x) => !(x.repair && ('failed' in x || 'host' in x))), out);
});

await tryRow('RP6', () => {
  const w = legacyWorld({}, { sky: { hours: 10, rate: 0, azimuth: 90, weatherSeconds: 0 } });
  const out = repairOut(w); const sky = C(w, '@world').sky;
  check('RP6 a stored azimuth of 90° becomes π/2 rad; weatherSeconds 0 (outside today\'s range) is dropped, not refused', Math.abs(sky?.azimuth - Math.PI / 2) < 1e-12 && !('weatherSeconds' in sky) && !('transition' in sky) && repairOf(out)?.repaired.includes('@world'), [out, sky]);
  liftWorld(w); repairShapes(w);
  check('RP6 …converted exactly once (a reload and a second repair run leave it)', Math.abs(C(w, '@world').sky.azimuth - Math.PI / 2) < 1e-12, C(w, '@world').sky);
  const w2 = legacyWorld({}, { sky: { hours: 10, azimuth: 400 } }); const o2 = repairOut(w2);
  check('RP6 …400° is the bearing 40° (inside ±2π), so the sky is repaired instead of refusing', Math.abs(C(w2, '@world').sky?.azimuth - 40 * Math.PI / 180) < 1e-12 && !repairOf(o2)?.failed.length, [o2, C(w2, '@world').sky]);
  const S = read('server/worldlog.ts');
  check('RP6 the server says a world needs repair on its own line, naming the command, and never repairs at load', /needs the shape repair/.test(S) && /world\.ts repair/.test(S) && !/repairShapes\(/.test(S), '');
});

// ===================================================================== the door and the readers speak node
await tryRow('RP7', () => {
  const W = scratchWorld('repair');
  W.call('create', { id: 'fan', model: 'crate', components: { transform: TF } });
  let r = W.call('set', { id: 'fan', component: 'motion:blade', value: { type: 'spin' } });
  const c = () => W.state().entities.fan.c;
  check('RP7 a keyed motion written without node names the node its tag spells, written down', r.ok && c()['motion:blade']?.node === 'blade', [r.refused, c()]);
  r = W.call('set', { id: 'fan', component: `motion:${partSlot('tripo_part_3')}`, value: { type: 'spin', node: 'tripo_part_3' } });
  check('RP7 …a node whose name isn\'t a tag (tripo_part_3) moves as motion:<slot> {node}', r.ok && c()[`motion:${partSlot('tripo_part_3')}`]?.node === 'tripo_part_3', r.refused);
  r = W.call('set', { id: 'fan', component: 'motion', value: { type: 'spin', node: 'blade' } });
  check('RP7 …a whole thing\'s motion naming a node is refused, pointing at motion:<slot> {node}', r.refused?.code === 'shape' && /motion:blade/.test(r.refused?.fix ?? ''), r.refused);
  const sm = carrierMotion({ 'motion:p-1': { type: 'pendulum', node: 'Seat Plank', amp: 0.3, period: 2 } }, { part: 'Seat Plank' });
  check('RP7 the seat signals find a socket\'s carrying motion by node, not by key', sm?.part === true && sm.m.node === 'Seat Plank', sm);
  const a = addOps({ model: 'swing.glb', pos: [0, 0, 0] }, 'sw', 'Spin', 'tripo_part_3');
  check('RP7 the editor adds a part\'s motion as motion:<slot> {node}', a.ops?.length === 1 && a.ops[0].args?.component === `motion:${partSlot('tripo_part_3')}` && a.ops[0].args?.value?.node === 'tripo_part_3', a);
  const M = read('client/lib/motion.js'), SE = read('client/lib/socketedit.js');
  check('RP7 the renderer and the seat editor read the node from the value (motionNode), not the key', /motionNode\(key, m\)/.test(M) && !/key\.slice\(7\)/.test(M) && /motionNode\(key, bag\[key\]\)/.test(SE), '');
});

await tryRow('RP8', () => {
  const old = [{ seq: 0, ts: 1, actor: 'world', verb: 'genesis', args: { v: 2, dialect: 'eidoverse-log', roles: { ann: { role: 'owner' } } } },
    { seq: 1, ts: 2, actor: 'ann', verb: 'spawn', args: { id: 'swing', lib: 'crate', pos: [0, 0, 0] } },
    { seq: 2, ts: 3, actor: 'ann', verb: 'comp', args: { id: 'swing', type: 'motion', data: { type: 'pendulum', part: 'tripo_part_3', amp: 0.2, period: 2, damp: 0 } } },
    { seq: 3, ts: 4, actor: 'ann', verb: 'spawn', args: { id: 'mill', lib: 'crate', pos: [2, 0, 0] } },
    { seq: 4, ts: 5, actor: 'ann', verb: 'comp', args: { id: 'mill', type: 'motion:tripo_part_fused_0', data: { type: 'spin', degPerSec: 20 } } }];
  const t = translate(old); const f = t.final.translated;
  const ks = `motion:${partSlot('tripo_part_3')}`, km = `motion:${partSlot('tripo_part_fused_0')}`;
  check('RP8 translate-v1@12 writes the same shape as the load: motion:<slot> {node}, for a bare part and a keyed v1 part alike', f.swing?.[ks]?.node === 'tripo_part_3' && !f.swing?.motion && f.mill?.[km]?.node === 'tripo_part_fused_0' && Object.keys(f.mill ?? {}).every((k) => !k.startsWith('x--')), [f.swing, f.mill]);
  check('RP8 …and its log is marked (a translated world never runs the load\'s repair)', shapesMarked(t.out), t.out?.slice(0, 2));
});

// ===================================================================== R 10-27: a translated swing swings as it did
await tryRow('RP19', () => {
  const old = [{ seq: 0, ts: 1, actor: 'world', verb: 'genesis', args: { v: 2, dialect: 'eidoverse-log', roles: { ann: { role: 'owner' } } } },
    { seq: 1, ts: 2, actor: 'ann', verb: 'spawn', args: { id: 'swing', lib: 'crate', pos: [0, 0, 0] } },
    { seq: 2, ts: 3, actor: 'ann', verb: 'motion', args: { id: 'swing', type: 'pendulum', axis: [1, 0, 0], amp: 0.3 } }];
  const m = translate(old).final.translated.swing?.motion;
  check('RP19 a translated swing that never said period, damp or maxAmp carries the old reader\'s 3.5 s, 0 and 1.1 (the old push cap)', m?.period === 3.5 && m?.damp === 0 && m?.maxAmp === 1.1, m);
  const kept = repairComps({ motion: { type: 'pendulum', amp: 0.3, period: 2, damp: 0.1, maxAmp: 0.5 } }).c.motion;
  check('RP19 …and one that said them keeps its own', kept.period === 2 && kept.damp === 0.1 && kept.maxAmp === 0.5, kept);
  const W = scratchWorld('repair'); W.call('create', { id: 'seat', model: 'crate', components: { transform: TF } });
  W.call('set', { id: 'seat', component: 'motion', value: { type: 'pendulum', amp: 0.2 } }); const nu = W.state().entities.seat?.c.motion;
  check('RP19 …while a swing set today takes today\'s defaults (2.4 s, 0.08, 0.9)', nu?.period === 2.4 && nu?.damp === 0.08 && nu?.maxAmp === 0.9, nu);
});

// ===================================================================== R 10-16: no empty stations by default
await tryRow('RP9', () => {
  const W = scratchWorld('repair');
  W.call('create', { id: 'hatstand', model: 'crate', components: { transform: TF } });
  const r = W.call('create', { id: 'peg', components: { parent: { to: 'hatstand' }, transform: { pos: [0, 1.6, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, socket: { name: 'peg' } } });
  check('RP9 a socket created today with no station (a hat peg) has none after the write', r.ok && !W.state().entities.peg?.c.station, [r.refused, W.state().entities.peg?.c]);
  const w2 = openWorld(W.root, W.name); w2.catalogue = ANY; liftWorld(w2);
  check('RP9 …nor after a reload through the load\'s lift', !!w2.state().entities.peg && !w2.state().entities.peg.c.station, w2.state().entities.peg?.c);
  const r2 = W.call('create', { id: 'rack', model: 'crate', components: { transform: TF, sockets: { hook: { pos: [0, 1, 0] } } } });
  const kids = Object.entries(W.state().entities).filter(([, e]) => e.c.parent?.to === 'rack' && e.c.socket);
  check('RP9 …nor does the old map spelling, lifted at the door (a slot with no body makes a socket child with no station)', r2.ok && kids.length === 1 && !kids[0][1].c.station, [r2.refused, kids]);
  const w3 = legacyWorld({ coatrack: { model: 'crate', sockets: { peg: { pos: [0, 1.5, 0] } } } }); maintain(w3);
  const k3 = Object.entries(w3.state().entities).filter(([, e]) => e.c.parent?.to === 'coatrack' && e.c.socket);
  check('RP9 …nor a stored world\'s socket map with no body, lifted by the command', k3.length === 1 && !k3[0][1].c.station, k3);
});

// ===================================================================== R 10-17: a model is its library path again. A world stored with
// content addresses (a translation by translate-v1@8–@11, before the path was kept) gets its paths back from the repair where
// this host's index knows the file, the address kept beside it as model-hash; an address no file here names stays and loads
await tryRow('RP10', () => {
  const H = '7'.repeat(64), H2 = '8'.repeat(64);
  const CAT = { ...ANY, get: ANY.get, list: ANY.list, pathOf: (m: string) => (m === `eido:sha256/${H}` ? 'eidoverse/assets/models/crow.glb' : null) };
  const w = legacyWorld({ crow: { model: `eido:sha256/${H}` }, ghost: { model: `eido:sha256/${H2}` }, plain: { model: 'crate' } }, {}, CAT);
  const out = repairOut(w);
  check('RP10 a stored address this host can name becomes its library path, with the address\'s hash beside it as model-hash', C(w, 'crow').model === 'eidoverse/assets/models/crow.glb' && C(w, 'crow')['model-hash'] === `sha256:${H}` && repairOf(out)?.repaired.includes('crow'), [out, C(w, 'crow')]);
  check('RP10 …one no file here names stays as stored (it still loads, and reads as "thing"); a path is untouched', C(w, 'ghost').model === `eido:sha256/${H2}` && !('model-hash' in C(w, 'ghost')) && C(w, 'plain').model === 'crate' && !('model-hash' in C(w, 'plain')), [C(w, 'ghost'), C(w, 'plain')]);
  check('RP10 …the act carries the repair\'s version (2: the rule set with the paths)', SHAPES_VERSION === 2 && w.entries.some((e) => e?.verb === 'repair-shapes' && e.body?.v === 2), SHAPES_VERSION);
  const n = w.entries.length; liftWorld(w); repairShapes(w);
  check('RP10 …once per world (a reload and a second repair run write nothing)', w.entries.length === n, w.entries.length - n);
  const R = repairComps({ model: `eido:sha256/${H}` });
  check('RP10 the pure rule with no resolver changes nothing (the translator and the lab have none)', R.set.length === 0, R);
});

// ===================================================================== reviewer item 9 (10-18): repair is an explicit maintenance command, never the load's
// Each row below was red first: RP11 against the load that still repaired (a732d74e), RP12/RP13 against a world.ts with no `repair`.
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
await tryRow('RP11', async () => {
  const w = legacyWorld({ bell: { model: 'crate', motion: { type: 'pendulum', amplitude: 0.3, axis: 'x', period: 2, damp: 0 } }, lamp: { light: { kind: 'point', color: 1, intensity: 16, range: 10 } } });
  const n = w.entries.length; const out = liftWorld(w);
  check('RP11 the load of an unrepaired world writes NO repair-shapes act and does not rewrite values (motion keeps amplitude, the light has no decay)', !w.entries.some((e) => e?.verb === 'repair-shapes') && w.entries.length === n && C(w, 'bell').motion?.amplitude === 0.3 && C(w, 'bell').motion?.axis === 'x' && C(w, 'lamp').light?.decay === undefined, [out, C(w, 'bell'), C(w, 'lamp')]);
  check('RP11 …but says the world needs repair, naming the command', out.some((x) => x.repairNeeded && /world\.ts repair/.test(x.repairNeeded.fix ?? '')), out);
  const wr = request(w, 'olive', 'create', { id: 'new1', model: 'crate', components: { transform: TF } }), rd = request(w, 'olive', 'look', {});
  check('RP11 …the world loads (folds ok) and reads, but every write is refused with repair-needed naming the command: the shape audit\'s old values (a sky in degrees, an address model) have no reader that serves them (lead 10-18: fail closed, never silently wrong)', w.state().status === 'ok' && rd.ok && !wr.ok && wr.refused.code === 'repair-needed' && /world\.ts repair/.test(wr.refused.fix) && /repair-shapes/.test(wr.refused.reason), [wr.refused, rd.ok]);
  // …and the refusal says who can repair it, to an agent and to a person in the editor alike: only whoever runs the server
  // can, asking again won't help, reads still work. The person's words keep that remedy (plainRefusal drops a tool-syntax fix)
  const { plainRefusal } = await import('../shared/protocol/refusal.js');
  const pr = plainRefusal('make it', wr);
  check('RP11b the repair-needed refusal says only whoever runs the server can repair the world and asking again won\'t help, and a person in the editor reads that too', /whoever runs this server/.test(wr.refused.fix) && /won't change/.test(wr.refused.fix) && /reads still work/.test(wr.refused.fix + wr.refused.reason) && /whoever runs this server/.test(pr), [wr.refused, pr]);
  const ME = read('client/lib/motioneval.js');
  check('RP11 …(the reader fallbacks are real: motioneval.js reads m.amplitude and a letter axis)', /m\.amp \?\? m\.amplitude/.test(ME) && /axis: "x"/.test(ME), '');
  const { repairShapes } = await import('../shared/protocol/authority.js') as any;
  const r = repairShapes(w, { by: 'olive' }); const act = w.entries.find((e) => e?.verb === 'repair-shapes');
  check('RP11 the explicit command repairs it (amp, a vector axis, decay 1.7) and records who asked and what ran (provenance in the act)', r.repaired.includes('bell') && r.repaired.includes('lamp') && C(w, 'bell').motion?.amp === 0.3 && JSON.stringify(C(w, 'bell').motion?.axis) === '[1,0,0]' && C(w, 'lamp').light?.decay === 1.7 && act?.actor === 'system' && act.body.command === 'repair-shapes' && act.body.by === 'olive' && act.body.v === SHAPES_VERSION, [r, act?.body]);
  const m = w.entries.length; const r2 = repairShapes(w);
  check('RP11 …a second run finds the marker and writes nothing (marked: true)', r2.marked === true && w.entries.length === m, [r2, w.entries.length - m]);
  check('RP11 …and once repaired the owner writes again', request(w, 'olive', 'create', { id: 'new1', model: 'crate', components: { transform: TF } }).ok && maintenanceNeeds(w).steps.length === 0, maintenanceNeeds(w));
});

await tryRow('RP12', async () => {
  // a legacy world on disk, the server's layout (<WORLDS_DIR>/<name>/world.jsonl), repaired by the CLI and rolled back byte-identical
  const root = fs.mkdtempSync(path.join(process.env.PROTOCOL_SCRATCH ?? process.env.TMPDIR ?? '/tmp', 'rp12-')); const dir = path.join(root, 'oldw'); fs.mkdirSync(dir);
  // the CLI signs with the worlds dir's custody (<root>/.custody.json): the stored world's sequencer must be that key
  const { custodyAt } = await import('../server/custody.ts'); const { custodyFileIn } = await import('../server/keyfiles.ts');
  const seqKey = custodyAt(custodyFileIn(root)).sequencer();
  const w = legacyWorld({ bell: { model: 'crate', motion: { type: 'pendulum', amplitude: 0.3, period: 2, damp: 0 } } });
  const lines = w.entries.map((e, i) => JSON.stringify(i === 0 ? { ...e, body: { ...e.body, owners: [[], [seqKey]], sequencer: seqKey } } : e));
  const file = path.join(dir, 'world.jsonl'); fs.writeFileSync(file, lines.join('\n') + '\n');
  const before = sha(file), size0 = fs.statSync(file).size;
  const run = (...a: string[]) => spawnSync('bun', [ENGINE + 'tools/protocol/world.ts', 'repair', 'oldw', ...a], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }, encoding: 'utf8' });
  const dry = run('--dry-run');
  check('RP12 --dry-run names all three steps and what would change, and writes nothing', dry.status === 0 && /bell/.test(dry.stdout) && /lift-sockets/.test(dry.stdout) && /rename-components/.test(dry.stdout) && /repair-shapes/.test(dry.stdout) && sha(file) === before, [dry.status, dry.stdout.slice(0, 300), dry.stderr.slice(0, 300)]);
  const rep = run('--by', 'olive');
  const L = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); const act = L.find((e) => e.verb === 'repair-shapes');
  check('RP12 repair writes the act (provenance: command, by) and its change, and keeps a backup of the pre-repair log', rep.status === 0 && act?.body.by === 'olive' && act.body.command === 'repair' && L.length > w.entries.length && fs.existsSync(path.join(dir, 'repair-backups')), [rep.status, rep.stdout.slice(0, 300), rep.stderr.slice(0, 300)]);
  const backups = fs.existsSync(path.join(dir, 'repair-backups')) ? fs.readdirSync(path.join(dir, 'repair-backups')) : [];
  check('RP12 …the backup is the pre-repair file, byte-identical (sha256), with a manifest', backups.length === 1 && sha(path.join(dir, 'repair-backups', backups[0], 'world.jsonl')) === before && JSON.parse(fs.readFileSync(path.join(dir, 'repair-backups', backups[0], 'manifest.json'), 'utf8')).before?.sha256 === before, backups);
  const again = run();
  check('RP12 …a second repair finds the marker and changes nothing', again.status === 0 && /marked|nothing/.test(again.stdout + again.stderr) && backups.length === fs.readdirSync(path.join(dir, 'repair-backups')).length, [again.status, again.stdout.slice(0, 200)]);
  const rb = run('--rollback');
  check('RP12 --rollback restores the pre-repair log byte-identical (size and sha256) and says so', rb.status === 0 && sha(file) === before && fs.statSync(file).size === size0 && /restored/.test(rb.stdout), [rb.status, rb.stdout.slice(0, 300), rb.stderr.slice(0, 300)]);
  const rep2 = run(); fs.appendFileSync(file, JSON.stringify({ ...L.at(-1), kind: 'say', actor: 'olive', verb: 'say', body: { text: 'later' } }) + '\n');
  const rb2 = run('--rollback');
  check('RP12 …a rollback refuses when the log has grown since the repair (later writes would be lost), unless --force', rep2.status === 0 && rb2.status !== 0 && /grown|since/.test(rb2.stderr + rb2.stdout) && sha(file) !== before, [rb2.status, rb2.stderr.slice(0, 300)]);
  const rb3 = run('--rollback', '--force');
  check('RP12 …--force restores it anyway, byte-identical', rb3.status === 0 && sha(file) === before, [rb3.status, rb3.stderr.slice(0, 200)]);
});

await tryRow('RP13', async () => {
  const { operatorRepair } = await import('../shared/protocol/authority.js') as any;
  const w = legacyWorld({ lamp: { light: { kind: 'point', color: 1, intensity: 16, range: 10 } } });
  const r = operatorRepair(w, 'opie', 'repair-shapes', {});
  const act = w.entries.find((e) => e?.verb === 'repair-shapes');
  check('RP13 a server operator\'s repair-shapes through operatorRepair runs the same repair, recorded with the operator\'s id', r.ok && r.repaired?.includes('lamp') && act?.body.by === 'opie' && act.body.operator === true && act.body.command === 'repair' && C(w, 'lamp').light?.decay === 1.7, [r, act?.body]);
});

// ===================================================================== lead's ruling (10-18): a load never writes. lift-sockets and rename-components join the command
// Rows red first against 685879c4 (the load still lifted and renamed): shown by reverting scriptrun.js to that commit and running them.
await tryRow('RP14', () => {
  const w = legacyWorld({ bench: { model: 'crate', sockets: { seat: { pos: [0, 0.5, 0], body: { action: 'sit' } } } } });
  const n = w.entries.length; const out = liftWorld(w); const need = out.find((x) => x.repairNeeded)?.repairNeeded;
  check('RP14 a pre-socket world loads without a write: no lift-sockets act, the sockets map still stored, and the load names lift-sockets as needed AND blocking (no reader serves an un-lifted seat)', w.entries.length === n && !w.entries.some((e) => e?.verb === 'lift-sockets') && !!C(w, 'bench').sockets && need?.steps.includes('lift-sockets') && need.blocking.includes('lift-sockets') && /world\.ts repair/.test(need.fix), out);
  const wr = request(w, 'olive', 'set', { id: 'bench', component: 'label', value: 'a bench' }), rd = request(w, 'olive', 'inspect', { id: 'bench' }), lv = request(w, 'olive', 'leave', {});
  check('RP14 …every write is refused with repair-needed (the text names the command); reads and leave still work', !wr.ok && wr.refused.code === 'repair-needed' && /lift-sockets/.test(wr.refused.reason) && /world\.ts repair/.test(wr.refused.fix) && rd.ok && lv.ok, [wr.refused, rd.ok, lv.refused]);
  const r = maintain(w, { by: 'olive' }); const act = w.entries.find((e) => e?.verb === 'lift-sockets');
  const kid = Object.entries(w.state().entities).find(([, e]) => e.c.parent?.to === 'bench' && e.c.socket?.name === 'seat');
  check('RP14 the command lifts it (its own act, with provenance), the seat is a socket child with a station, the map is gone, and writes work again', r.steps.lift.made.length === 1 && act?.actor === 'system' && act.body.command === 'repair' && act.body.by === 'olive' && !!kid && kid[1].c.station?.action === 'sit' && !C(w, 'bench').sockets && request(w, 'olive', 'set', { id: 'bench', component: 'label', value: 'a bench' }).ok && maintenanceNeeds(w).steps.length === 0, [r.steps.lift, act?.body, kid?.[1].c]);
});

await tryRow('RP15', () => {
  // renames whose old spelling today's readers serve (trusted → drafts.trustedOf; bob → motionType; a station's pose → bodyOf): the world works as it is
  const a = legacyWorld({ buoy: { model: 'crate', motion: { type: 'bob', amp: 0.2, period: 3, axis: [0, 1, 0], phase: 0 } } }, { trusted: { components: ['hesperus/material'] } });
  // …a stored world that is otherwise in today's spelling (marked): only the renames are needed
  a.append({ kind: 'act', actor: 'system', verb: 'repair-shapes', body: { v: SHAPES_VERSION, ids: [], founding: true } });
  const outA = liftWorld(a); const needA = outA.find((x) => x.repairNeeded)?.repairNeeded;
  const wA = request(a, 'olive', 'set', { id: 'buoy', component: 'label', value: 'buoy' });
  check('RP15 a world needing only served renames loads, is said to need rename-components (not blocking), and takes writes', JSON.stringify(needA?.steps) === '["rename-components"]' && needA.blocking.length === 0 && wA.ok && C(a, '@world').trusted && C(a, 'buoy').motion?.type === 'bob', [outA, wA.refused]);
  const rA = maintain(a, { by: 'olive' }); const actA = a.entries.find((e) => e?.verb === 'rename-components');
  check('RP15 …the command renames them in one act with provenance; nothing is renamed at load', rA.steps.rename.renamed.length === 2 && actA?.body.command === 'repair' && actA.body.by === 'olive' && C(a, '@world')['trusted-components'] && !C(a, '@world').trusted && C(a, 'buoy').motion?.type === 'oscillate', [rA.steps.rename, C(a, '@world')]);
  // a rename no reader serves (a grabbable's pose: grab.js reads anim only): fail closed
  const b = legacyWorld({ cup: { model: 'crate', grabbable: { pose: 'pistol' } } });
  b.append({ kind: 'act', actor: 'system', verb: 'repair-shapes', body: { v: SHAPES_VERSION, ids: [], founding: true } });
  const outB = liftWorld(b); const needB = outB.find((x) => x.repairNeeded)?.repairNeeded; const wB = request(b, 'olive', 'set', { id: 'cup', component: 'label', value: 'cup' });
  check('RP15 a stored grabbable.pose blocks writes (repair-needed names rename-components) until the command renames it to anim', needB?.blocking.includes('rename-components') && !wB.ok && wB.refused.code === 'repair-needed' && maintain(b).steps.rename.renamed.length === 1 && C(b, 'cup').grabbable?.anim === 'pistol' && request(b, 'olive', 'set', { id: 'cup', component: 'label', value: 'cup' }).ok, [outB, wB.refused, C(b, 'cup')]);
  for (const [id, comp, value] of [['frame', 'picture', { src: 'store/images/0123456789abcdef.png', alt: 'a red door' }], ['radio', 'sound', { src: 'store/audio/0123456789abcdef.ogg', look: 'rain' }]] as const) {
    const c = legacyWorld({ [id]: { model: 'crate', [comp]: value } });
    c.append({ kind: 'act', actor: 'system', verb: 'repair-shapes', body: { v: SHAPES_VERSION, ids: [], founding: true } });
    const outC = liftWorld(c); const needC = outC.find((x) => x.repairNeeded)?.repairNeeded; const wC = request(c, 'olive', 'set', { id, component: 'label', value: id });
    check(`RP15 a stored ${comp} ${'alt' in value ? 'alt' : 'look'} blocks writes (${comp}.js reads description only), and the load doesn't say its readers serve it`, needC?.blocking.includes('rename-components') && !/serve the old spelling/.test(needC?.why ?? '') && !wC.ok && wC.refused?.code === 'repair-needed', [needC, wC.refused]);
    const rC = maintain(c); const v = C(c, id)[comp] ?? {};
    check(`RP15 …until the command renames the ${comp}'s to description; then writes are taken`, rC.steps.rename.renamed.length === 1 && v.description === ('alt' in value ? value.alt : value.look) && !('alt' in v) && !('look' in v) && request(c, 'olive', 'set', { id, component: 'label', value: id }).ok, [rC.steps.rename, v]);
  }
});

await tryRow('RP16', async () => {
  // a v1 world translated today needs NO maintenance step: the translator lifts, renames and repairs in its projection
  const old = [{ seq: 0, ts: 1, actor: 'world', verb: 'genesis', args: { v: 2, dialect: 'eidoverse-log', roles: { ann: { role: 'owner' } } } },
    { seq: 1, ts: 2, actor: 'ann', verb: 'spawn', args: { id: 'bench', lib: 'crate', pos: [0, 0, 0] } },
    { seq: 2, ts: 3, actor: 'ann', verb: 'comp', args: { id: 'bench', type: 'sockets', data: { seat: { pos: [0, 0.5, 0], body: { action: 'sit' } } } } },
    { seq: 3, ts: 4, actor: 'ann', verb: 'spawn', args: { id: 'cup', lib: 'crate', pos: [1, 0, 0] } },
    { seq: 4, ts: 5, actor: 'ann', verb: 'comp', args: { id: 'cup', type: 'grabbable', data: { pose: 'pistol' } } },
    { seq: 5, ts: 6, actor: 'ann', verb: 'comp', args: { id: 'cup', type: 'motion', data: { type: 'bob', amp: 0.1, period: 2 } } },
    { seq: 6, ts: 7, actor: 'ann', verb: 'comp', args: { id: 'bench', type: 'light', data: { kind: 'point', day: true } } }];
  // the translate COMMAND (import-v1/world.ts translateV1World, what `world.ts translate` runs): its projection renames and repairs, and it runs the maintenance command on its output (lift-sockets)
  const { translateV1World } = await import('./protocol/import-v1/world.ts');
  const root = fs.mkdtempSync(path.join(process.env.PROTOCOL_SCRATCH ?? process.env.TMPDIR ?? '/tmp', 'rp16-')); fs.mkdirSync(path.join(root, 'old'));
  fs.writeFileSync(path.join(root, 'old', 'log.jsonl'), old.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const r = translateV1World(path.join(root, 'old'), path.join(root, 'new'), { name: 'new' });
  const { openLive } = await import('../server/livehost.ts'); const w = openLive(path.join(root, 'new'), 'new', { scripts: null });
  const need = maintenanceNeeds(w); const E = w.state().entities; const lifts = w.entries.filter((e) => e?.verb === 'lift-sockets');
  check('RP16 a v1 world translated today (sockets, a grabbable pose, a bob motion, a light with day) needs no step when served: the translation lifted its seats (one lift-sockets act, by: translate), renamed and repaired in its projection; the load writes nothing and writes work', r.maintenance.lifted === 1 && lifts.length === 1 && lifts[0].body.by === 'translate' && w.state().status === 'ok' && need.steps.length === 0 && liftWorld(w).length === 0 && Object.values(E).some((e) => e.c.socket?.name === 'seat') && !Object.values(E).some((e) => e.c.sockets || e.c.grabbable?.pose || e.c.motion?.type === 'bob' || 'day' in (e.c.light ?? {})) && request(w, 'n' + 'ann', 'look', {}).ok, [need, r.maintenance, Object.values(E).map((e) => Object.keys(e.c))]);
});

// ===================================================================== lead 10-18: a catalogue model that GAINED sockets is a library update, not a stale stored format
// Red first (the old classification refused the write with repair-needed); green once modelSeatsDue is an optional step.
await tryRow('RP17', () => {
  const CAT = { ...ANY, get: (n) => (n === 'chair' ? { label: 'chair', surfaces: [], sockets: { seat: { pos: [0, 0.5, 0], body: { action: 'sit' } } } } : ANY.get(n)) };
  const w = legacyWorld({ ch: { model: 'chair' } }, {}, CAT);
  w.append({ kind: 'act', actor: 'system', verb: 'repair-shapes', body: { v: SHAPES_VERSION, ids: [], founding: true } });   // otherwise in today's spelling
  const out = liftWorld(w); const need = out.find((x) => x.repairNeeded)?.repairNeeded;
  const wr = request(w, 'olive', 'set', { id: 'ch', component: 'label', value: 'a chair' });
  check('RP17 a world whose only need is a model that gained sockets stays writable: the load lists lift-sockets as OPTIONAL (not blocking), the write is accepted, and the seat is not there yet', wr.ok && need?.optional?.includes('lift-sockets') && need.blocking.length === 0 && /optional/.test(need.why) && !Object.values(w.state().entities).some((e) => e.c.socket), [out, wr.refused]);
  const r = maintain(w, { by: 'olive' });
  check('RP17 …the command makes the seat child (lift-sockets, recorded), and the world needs nothing after', r.steps.lift.made.length === 1 && Object.values(w.state().entities).some((e) => e.c.socket?.name === 'seat' && e.c.parent?.to === 'ch') && liftWorld(w).length === 0, [r.steps.lift, maintenanceNeeds(w)]);
});

console.log(`\n${pass} passed, ${fail} failed`);
// RP18 (r14 H1, 10-18): maintain's lift-sockets and rename-components catches swallow REFUSALS only; a durable-write throw (the
// file wedged, EIO) must propagate, so the caller (world.ts repair, the translation) reports ambiguous instead of "repaired"
await tryRow('RP18', () => {
  const w = legacyWorld({ coatrack: { model: 'crate', sockets: { peg: { pos: [0, 1.5, 0] } } } });
  // the lift-sockets act's durable write throws (as a full disk would); every other write is fine, so a swallowed throw would let
  // maintain run on to repair-shapes and return "ok" with the host merely listed as failed
  const real = w.append.bind(w); w.append = (e: any, ...more: any[]) => { if (e.kind === 'act' && e.verb === 'lift-sockets') throw new Error('EIO: disk gone'); return real(e, ...more); };
  let threw: any = null, r: any = null; try { r = maintain(w, { by: 'olive' }); } catch (x) { threw = x; }
  check('RP18 a durable-write throw inside lift-sockets propagates out of maintain (not swallowed into steps.lift.failed as code "error" while the rest runs on)', !!threw && /EIO/.test(String(threw?.message)) && r === null, [String(threw?.message).slice(0, 200), r?.steps?.lift]);
});
// RP19: the repair moves an old amplitude to amp as the old reader read it (Number(m.amp ?? m.amplitude)): a numeric
// string is that number, null and '' are 0 as Number reads them (house 6340433633: null was dropped, so the motion took
// today's default amp where the old reader stood it still), an amp of null gave way to the amplitude, and a value the
// old reader couldn't read is dropped, as before
{ const { repairMotion } = await import('../shared/protocol/shaperepair.js');
  const r = (amplitude: any) => repairMotion({ type: 'pendulum', amplitude, period: 2 });
  check('RP19 a numeric-string amplitude is kept as amp, null and empty are 0; a non-number one goes, as the old reader read none', r('0.4').amp === 0.4 && r(0.3).amp === 0.3 && r('wide').amp === undefined && r(null).amp === 0 && r('').amp === 0 && !('amplitude' in r('0.4')) && !('amplitude' in r(null)) && repairMotion({ amp: 0.2, amplitude: '0.9' }).amp === 0.2 && repairMotion({ amp: null, amplitude: '0.9' }).amp === 0.9,
    [r('0.4'), r('wide'), r(null), r(''), repairMotion({ amp: null, amplitude: '0.9' })]); }
// RP20 (review of #260): a thing with one purged component still has its other components repaired
{ const { shapeRepairOps } = await import('../shared/protocol/shaperepair.js'); const { PURGED } = await import('../shared/protocol/fold.js');
  const st = { entities: { bob: { c: { label: PURGED, motion: { type: 'pendulum', amplitude: 0.3, period: 2 } } } } };
  const ops = shapeRepairOps(st, PURGED);
  check('RP20 a purged component is left alone, and the thing\'s other components are still repaired (its motion\'s amplitude becomes amp)', ops.some((o: any) => o.id === 'bob' && o.comp === 'motion' && o.value?.amp === 0.3) && !ops.some((o: any) => o.comp === 'label'), ops);
  const hinge = shapeRepairOps({ entities: { door: { c: { pivot: PURGED, motion: { type: 'pendulum', pivot: [0, 1, 0], amp: 0.3, period: 2 } } } } }, PURGED);
  check('RP21 …but a thing whose repair would move data into a purged sibling (a motion\'s pivot array, its pivot purged) is left alone', hinge.length === 0, hinge); }
process.exit(fail ? 1 : 0);
