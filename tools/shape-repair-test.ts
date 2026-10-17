// shape-repair-test — the load's shape repair after review round 7 (notes/eidoverse/REVIEW-holes-r7-2026-10-16.md F1, F2, F5)
// and R's rulings of 10-16: a node's name from a model file is DATA (motion:<slot> {node}), the repair runs ONCE per world
// (a marker the log carries), and one bad value never blocks the rest. Each row was written red against wt/repair @
// 080a8fef. Stored "pre-audit" worlds are built in memory (worldOf, unsigned, no custody): their founding has no stamp,
// so liftWorld treats them as old, which is exactly what a log written before the audit looks like.
//   usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/shape-repair-test.ts
// @ts-nocheck
import fs from 'node:fs';
import { scratchWorld } from './protocol/scratchworld.ts';
import { worldOf, CHANGE } from '../shared/protocol/authority/storage.js';
import { request, liftWorld, LAB_CATALOGUE } from '../shared/protocol/authority.js';
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
const ENGINE = new URL('..', import.meta.url).pathname;
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

// ===================================================================== F1: a node's name is data (motion:<slot> {node})
await tryRow('RP1', () => {
  const r = repairComps({ motion: { type: 'spin', part: 'tripo_part_3', degPerSec: 10 } });
  const keys = Object.keys(r.c).filter((k) => k.startsWith('motion:'));
  check('RP1 a bare motion naming tripo_part_3 becomes motion:<slot> {node: "tripo_part_3"}, its key in the §2.3 grammar', keys.length === 1 && isComponent(keys[0]) && r.c[keys[0]].node === 'tripo_part_3' && !r.c.motion, r.c);
  check('RP1 …the slot is a pure function of the name (the same on every server): a tag keeps itself, any other is sanitized + 8 hex', partSlot('tripo_part_3') === partSlot('tripo_part_3') && partSlot('seat') === 'seat' && /^tripo-part-3-[0-9a-f]{8}$/.test(partSlot('tripo_part_3')) && partSlot('Tripo_Part') !== partSlot('tripo-part'), [partSlot('tripo_part_3'), partSlot('Tripo_Part'), partSlot('tripo-part')]);
  check('RP1 …a second run finds nothing to do', repairComps(r.c).set.length === 0 && repairComps(r.c).del.length === 0, repairComps(r.c));
  const k2 = repairComps({ 'motion:plank': { type: 'bob', amp: 0.1, period: 2 } }).c;
  check('RP1 …a keyed motion stored before the node was data gets its key\'s tag as node (what motion.js read)', k2['motion:plank']?.node === 'plank', k2);
  const k3 = repairComps({ motion: { type: 'spin', part: 'Seat Plank' }, 'motion:p0': { type: 'bob', node: 'Seat Plank' } }).c;
  check('RP1 …a motion already on that node wins (the bare one is dropped)', !k3.motion && Object.keys(k3).filter((k) => k.startsWith('motion:')).length === 1 && k3['motion:p0'].type === 'bob', k3);
});

await tryRow('RP2', () => {
  const w = legacyWorld({ swing: { model: 'crate', motion: { type: 'pendulum', part: 'tripo_part_3', amp: 0.3, period: 2, damp: 0 } }, mill: { model: 'crate', motion: { type: 'spin', part: 'tripo_part_fused_0', degPerSec: 20 } } });
  const out = liftWorld(w); const rep = repairOf(out);
  check('RP2 the load repairs a world whose parts are named tripo_part_3 / tripo_part_fused_0 (the Commons; was refused whole)', rep && rep.repaired.includes('swing') && rep.repaired.includes('mill') && !rep.failed.length, out);
  const k = `motion:${partSlot('tripo_part_3')}`;
  check('RP2 …the swing\'s part motion is at motion:<slot>, naming its node', C(w, 'swing')[k]?.node === 'tripo_part_3' && C(w, 'swing')[k]?.type === 'pendulum' && !C(w, 'swing').motion, C(w, 'swing'));
  check('RP2 …readers find it by node (motionNode)', motionNode(k, C(w, 'swing')[k]) === 'tripo_part_3' && motionNode('motion:plank', { type: 'spin' }) === 'plank' && motionNode('motion', { type: 'spin' }) === null, '');
});

// ===================================================================== F2: once per world, only on what was stored before
await tryRow('RP3', () => {
  const w = legacyWorld({ bell: { model: 'crate', motion: { type: 'pendulum', amp: 0.3, period: 2, damp: 0 } } });
  check('RP3 a log written before the audit is unmarked', !shapesMarked(w.entries), '');
  liftWorld(w);
  check('RP3 the first load writes the old swing point as its pivot (pre-audit data)', JSON.stringify(C(w, 'bell').pivot) === '{"pos":[0,2,0]}', C(w, 'bell'));
  const n = w.entries.length; const again = liftWorld(w);
  check('RP3 …and marks the world: a second load writes nothing and reports no repair', shapesMarked(w.entries) && w.entries.length === n && !repairOf(again), [again, w.entries.length - n]);
  // today's writes, on the repaired world
  let r = request(w, 'olive', 'delete', { id: 'bell', component: 'pivot' });
  check('RP3 the owner deletes the pivot', r.ok, r.refused);
  r = request(w, 'olive', 'create', { id: 'swing-x', model: 'crate', components: { transform: TF } }); const r2 = request(w, 'olive', 'set', { id: 'swing-x', component: 'motion', value: { type: 'pendulum', amp: 0.4 } });
  check('RP3 a pendulum is set today without a pivot', r.ok && r2.ok && !C(w, 'swing-x').pivot, [r.refused, r2.refused]);
  const m = w.entries.length; liftWorld(w);
  check('RP3 …a reload keeps the deleted pivot deleted', !C(w, 'bell').pivot, C(w, 'bell'));
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
  const out = liftWorld(w); const rep = repairOf(out);
  check('RP5 one thing the door refuses (a light with range 0) doesn\'t block the rest: the good light is repaired (decay 1.7)', C(w, 'good').light?.decay === 1.7 && rep?.repaired.includes('good'), [out, C(w, 'good')]);
  check('RP5 …the refused thing keeps its old spelling and is named', C(w, 'bad').light?.decay === undefined && rep?.failed.some((f) => f.id === 'bad' && f.reason), rep);
  const act = w.entries.filter((e) => e?.kind === 'act' && e.verb === 'repair-shapes');
  check('RP5 …in the act too ({v, ids, failed}), which marks the world', act.length === 1 && act[0].body.v === SHAPES_VERSION && act[0].body.failed?.[0]?.id === 'bad' && shapesMarked(w.entries), act.map((e) => e.body));
  check('RP5 …and the server\'s outcome isn\'t a socket host\'s (no top-level failed/host for the lift\'s line to misread)', out.every((x) => !(x.repair && ('failed' in x || 'host' in x))), out);
});

await tryRow('RP6', () => {
  const w = legacyWorld({}, { sky: { hours: 10, rate: 0, azimuth: 90, weatherSeconds: 0 } });
  const out = liftWorld(w); const sky = C(w, '@world').sky;
  check('RP6 a stored azimuth of 90° becomes π/2 rad; weatherSeconds 0 (outside today\'s range) is dropped, not refused', Math.abs(sky?.azimuth - Math.PI / 2) < 1e-12 && !('weatherSeconds' in sky) && !('transition' in sky) && repairOf(out)?.repaired.includes('@world'), [out, sky]);
  liftWorld(w);
  check('RP6 …converted exactly once (a second load leaves it)', Math.abs(C(w, '@world').sky.azimuth - Math.PI / 2) < 1e-12, C(w, '@world').sky);
  const w2 = legacyWorld({}, { sky: { hours: 10, azimuth: 400 } }); const o2 = liftWorld(w2);
  check('RP6 …400° is the bearing 40° (inside ±2π), so the sky is repaired instead of refusing', Math.abs(C(w2, '@world').sky?.azimuth - 40 * Math.PI / 180) < 1e-12 && !repairOf(o2)?.failed.length, [o2, C(w2, '@world').sky]);
  const S = read('server/worldlog.ts');
  check('RP6 the server says the repair\'s outcome on its own line (never "lifting undefined\'s sockets")', /console\.error\(`\[world:\$\{name\}\] the shape repair skipped/.test(S) && !/lifting \$\{f\.host\}'s sockets failed[^\n]*\n[^\n]*rep/.test(S) && /repaired \$\{rep\.repaired\.length\} thing/.test(S) && /"repair-shapes" : "lift-sockets"/.test(S), '');
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
  const M = read('client/lib/motion.js'), SE = read('client/lib/seatedit.js');
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

// ===================================================================== R 10-16: no empty stations by default
await tryRow('RP9', () => {
  const W = scratchWorld('repair');
  W.call('create', { id: 'hatstand', model: 'crate', components: { transform: TF } });
  const r = W.call('create', { id: 'peg', components: { parent: { to: 'hatstand' }, transform: { pos: [0, 1.6, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, socket: { name: 'peg' } } });
  check('RP9 a socket created today with no station (a hat peg) has none after the write', r.ok && !W.state().entities.peg?.c.station, [r.refused, W.state().entities.peg?.c]);
  const w2 = openWorld(W.root, W.name); w2.catalogue = ANY; liftWorld(w2);
  check('RP9 …nor after a reload through the load\'s lift and repair', !!w2.state().entities.peg && !w2.state().entities.peg.c.station, w2.state().entities.peg?.c);
  const r2 = W.call('create', { id: 'rack', model: 'crate', components: { transform: TF, sockets: { hook: { pos: [0, 1, 0] } } } });
  const kids = Object.entries(W.state().entities).filter(([, e]) => e.c.parent?.to === 'rack' && e.c.socket);
  check('RP9 …nor does the old map spelling, lifted at the door (a slot with no body makes a socket child with no station)', r2.ok && kids.length === 1 && !kids[0][1].c.station, [r2.refused, kids]);
  const w3 = legacyWorld({ coatrack: { model: 'crate', sockets: { peg: { pos: [0, 1.5, 0] } } } }); liftWorld(w3);
  const k3 = Object.entries(w3.state().entities).filter(([, e]) => e.c.parent?.to === 'coatrack' && e.c.socket);
  check('RP9 …nor a stored world\'s socket map with no body, lifted at its first load', k3.length === 1 && !k3[0][1].c.station, k3);
});

// ===================================================================== R 10-17: a model is its library path again. A world stored with
// content addresses (a translation by translate-v1@8–@11, before the path was kept) gets its paths back at its first load where
// this host's index knows the file, the address kept beside it as model-hash; an address no file here names stays and loads
await tryRow('RP10', () => {
  const H = '7'.repeat(64), H2 = '8'.repeat(64);
  const CAT = { ...ANY, get: ANY.get, list: ANY.list, pathOf: (m: string) => (m === `eido:sha256/${H}` ? 'eidoverse/assets/models/crow.glb' : null) };
  const w = legacyWorld({ crow: { model: `eido:sha256/${H}` }, ghost: { model: `eido:sha256/${H2}` }, plain: { model: 'crate' } }, {}, CAT);
  const out = liftWorld(w);
  check('RP10 a stored address this host can name becomes its library path, with the address\'s hash beside it as model-hash', C(w, 'crow').model === 'eidoverse/assets/models/crow.glb' && C(w, 'crow')['model-hash'] === `sha256:${H}` && repairOf(out)?.repaired.includes('crow'), [out, C(w, 'crow')]);
  check('RP10 …one no file here names stays as stored (it still loads, and reads as "thing"); a path is untouched', C(w, 'ghost').model === `eido:sha256/${H2}` && !('model-hash' in C(w, 'ghost')) && C(w, 'plain').model === 'crate' && !('model-hash' in C(w, 'plain')), [C(w, 'ghost'), C(w, 'plain')]);
  check('RP10 …the act carries the repair\'s version (2: the rule set with the paths)', SHAPES_VERSION === 2 && w.entries.some((e) => e?.verb === 'repair-shapes' && e.body?.v === 2), SHAPES_VERSION);
  const n = w.entries.length; liftWorld(w);
  check('RP10 …once per world (a second load writes nothing)', w.entries.length === n, w.entries.length - n);
  const R = repairComps({ model: `eido:sha256/${H}` });
  check('RP10 the pure rule with no resolver changes nothing (the translator and the lab have none)', R.set.length === 0, R);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
