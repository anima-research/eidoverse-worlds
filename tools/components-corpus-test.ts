// components-corpus-test — the component view is lossless on every world we have.
//
// The primitives (sha256, canon), the step-2 spellings (synthetic entity records), and then the corpus: for every v4
// world log, fold it (shared/protocol/fold.js), take the view a client reads (shared/protocol/view.js viewState), and read every
// entity as components (shared/components.js componentsOf) and back (entityOf). The bytes must come back identical
// (canonical JSON), and every key must land in a component parameter, a declared stamp, or `extra` (which is counted
// and printed, never silently dropped). One differing entity anywhere = red.
//
// Corpus: spec/conformance (always), plus any dirs in COMPONENTS_CORPUS (colon-separated; each is searched for
// <world>/world.jsonl).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/components-corpus-test.ts
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { componentsOf, entityOf, canon, sha256hex, RECORDS, addable, lightOf, colliderOf, isEmpty, recordHash } from '../shared/components.js';
import { worldComponents, worldOf, worldState } from '../shared/worldentity.js';
import { blueprintRefusal, blueprintHash, expand, overridesOf, placeVerbs, placeRefusal, copyTree, modernize, localComponents, LINK_KEY } from '../shared/blueprint.js';
import { treeOf } from '../shared/hierarchy.js';

const J = JSON.stringify;
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`); };

console.log('the primitives:');
check('sha256("abc") is the FIPS 180-2 vector', sha256hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
check('sha256 agrees with node:crypto on a long multi-block string', (() => { const s = 'ε∃'.repeat(500) + 'x'; return sha256hex(s) === createHash('sha256').update(s).digest('hex'); })());
check('canon sorts keys and drops undefined', canon({ b: 1, a: [1, { d: undefined, c: 'x' }] }) === '{"a":[1,{"c":"x"}],"b":1}');
check('canon refuses NaN', (() => { try { canon({ a: NaN }); return false; } catch { return true; } })());
const hashes = Object.values(RECORDS).map((r: any) => r.hash);
check(`every record has a distinct 64-hex hash (${hashes.length} records)`, hashes.every((h) => /^[0-9a-f]{64}$/.test(h)) && new Set(hashes).size === hashes.length);
// design §6: a record's hash covers meaning, not prose
{
  const P: any = RECORDS.Pendulum; const S: any = RECORDS.Sockets;
  const re = (r: any) => recordHash(JSON.parse(JSON.stringify(r)));
  const tweak = (r: any, f: (x: any) => void) => { const x = JSON.parse(JSON.stringify(r)); f(x); return recordHash(x); };
  check('every record\'s hash is recordHash of itself (the stored hash is the rule\'s)', Object.values(RECORDS).every((r: any) => re(r) === r.hash));
  check('rewording summary / note / a param hint / fallback.text leaves the hash alone',
    tweak(P, (x) => { x.summary = 'sways'; }) === P.hash && tweak(RECORDS.Collider, (x) => { x.note = 'reworded'; }) === RECORDS.Collider.hash
    && tweak(P, (x) => { x.params.pivot.hint = 'reworded'; }) === P.hash && tweak(P, (x) => { x.fallback.text = 'swinging'; }) === P.hash
    && tweak(P, (x) => { x.hint = 'a record-level hint'; }) === P.hash);
  check('…but a default, a range, a type, a need, a seat default or the fallback visual moves it',
    [(x: any) => { x.params.period.default = 3.6; }, (x: any) => { x.params.amp.min = 0.1; }, (x: any) => { x.params.damp.t = 'text'; },
      (x: any) => { x.needs = ['Model']; }, (x: any) => { x.fallback.visual = 'swings'; }, (x: any) => { x.name = 'Swing'; }].every((f) => tweak(P, f) !== P.hash)
    && tweak(S, (x) => { x.seat.pose = 'lie'; }) !== S.hash);
  check('a parameter that is NAMED hint or note still counts', tweak(P, (x) => { x.params.note = { t: 'text', default: 'a' }; }) !== tweak(P, (x) => { x.params.note = { t: 'text', default: 'b' }; }));
}
check('Pendulum is not addable twice on a part-less basis but motion types repeat', addable([{ type: 'Transform' }, { type: 'Pendulum' }]).some((a) => a.name === 'Pendulum'));
check('a tilted entity keeps q through the view', (() => { const e = { lib: 'x.glb', pos: [0, 1, 0], q: [0.2588, 0, 0, 0.9659], yaw: 0, comp: { lock: true } }; return canon(entityOf(componentsOf(e))) === canon(e); })());
// batch 2 (R 10-07): no part = a picture of its own, so Picture is offered on any thing, a model or not
check('Picture is offered on any thing (batch 2: quad mode)', addable([{ type: 'Transform' }, { type: 'Light' }]).some((a) => a.name === 'Picture') && addable([{ type: 'Transform' }, { type: 'Model' }]).some((a) => a.name === 'Picture'));

// ------------------------------------------------------------ the step-2 spellings (design §6)
// No world in the corpus carries these yet, so the round trip is proven here
// on synthetic records — and each case also says WHAT it must read as: a round
// trip alone would pass if every new spelling fell through to an Annotation.
console.log('\nthe step-2 spellings (synthetic):');
const L = 'eidoverse/assets/models/lamp.glb';
const st0 = { actor: 'a', ts: 1, born: 1 };
const cases: [string, any, string[]][] = [
  // [name, folded entity, expected "Type:key" list after Transform]
  ['a lamp: a Model and a comp.light on one entity', { lib: L, pos: [0, 0, 0], yaw: 0, comp: { light: { color: 0xff8800, intensity: 20, range: 8 } }, ...st0 }, ['Model:', 'Light:light']],
  ['comp.light burning at noon (day:false ⇄ burnsAtNoon)', { lib: L, pos: [0, 0, 0], yaw: 0, comp: { light: { day: false, important: true } }, ...st0 }, ['Model:', 'Light:light']],
  ['comp.light with day:true kept verbatim', { lib: L, pos: [0, 0, 0], yaw: 0, comp: { light: { day: true } }, ...st0 }, ['Model:', 'Light:light']],
  ['comp.light with a key no record names (extra, not lost)', { lib: L, pos: [0, 0, 0], yaw: 0, comp: { light: { color: 1, flicker: 0.3, burnsAtNoon: 'x' } }, ...st0 }, ['Model:', 'Light:light']],
  ['an empty comp.light {} (all defaults)', { lib: L, pos: [0, 0, 0], yaw: 0, comp: { light: {} }, ...st0 }, ['Model:', 'Light:light']],
  ['a comp.light that is not an object stays an Annotation', { lib: L, pos: [0, 0, 0], yaw: 0, comp: { light: 'on' }, ...st0 }, ['Model:', 'Annotation:light']],
  ['comp.collider box', { lib: L, pos: [0, 0, 0], yaw: 0, comp: { collider: { shape: 'box' } }, ...st0 }, ['Model:', 'Collider:collider']],
  ['legacy collide AND comp.collider together', { lib: L, pos: [0, 0, 0], yaw: 0, collide: 'box', comp: { collider: { shape: 'exact' } }, ...st0 }, ['Model:', 'Collider:', 'Collider:collider']],
  ['a comp.collider array stays an Annotation', { lib: L, pos: [0, 0, 0], yaw: 0, comp: { collider: ['box'] }, ...st0 }, ['Model:', 'Annotation:collider']],
  ['legacy kind:"light" AND comp.light (hand-written log)', { kind: 'light', pos: [0, 1, 0], color: 1, intensity: 2, range: 3, comp: { light: { color: 4 } }, ...st0 }, ['Light:', 'Light:light']],
  ['an Empty: nothing but a Transform', { pos: [1, 2, 3], yaw: 0.5, ...st0 }, []],
  ['an Empty with a scale, a q and a comp.light', { pos: [1, 2, 3], yaw: 0, q: [0, 0, 0, 1], scale: 2, comp: { light: { intensity: 4 } }, placer: { id: 'p' }, ...st0 }, ['Light:light']],
  // step 3: the Transform's rotation order rides comp.rotOrder (design §3)
  ['a rotation order is part of the Transform, not a component of its own', { lib: L, pos: [0, 0, 0], yaw: 0, q: [0, 0.38, 0, 0.92], comp: { rotOrder: 'ZXY', lock: true }, ...st0 }, ['Model:', 'Lock:lock']],
  ['quaternion mode, on an Empty', { pos: [0, 0, 0], yaw: 0, comp: { rotOrder: 'quat' }, ...st0 }, []],
  ['a rotOrder that is not one of the seven names stays an Annotation (bytes kept)', { lib: L, pos: [0, 0, 0], yaw: 0, comp: { rotOrder: 'zxy' }, ...st0 }, ['Model:', 'Annotation:rotOrder']],
  ['…as does a non-string one', { lib: L, pos: [0, 0, 0], yaw: 0, comp: { rotOrder: { order: 'XYZ' } }, ...st0 }, ['Model:', 'Annotation:rotOrder']],
];
check('the Transform reads its rotOrder (absent = no key at all, so XYZ is never written back)',
  componentsOf({ pos: [0, 0, 0], comp: { rotOrder: 'YZX' } }).components[0].params.rotOrder === 'YZX'
  && !('rotOrder' in componentsOf({ pos: [0, 0, 0] }).components[0].params) && !('comp' in entityOf(componentsOf({ pos: [0, 0, 0], yaw: 0 }))));
for (const [name, ent, want] of cases) {
  const view = componentsOf(ent);
  const got = view.components.map((c: any) => `${c.type}:${c.key ?? ''}`);
  const back = entityOf(view);
  check(`${name}: reads as ${['Transform:', ...want].join(' + ')} and round-trips`,
    canon(back) === canon(ent) && canon(got) === canon(['Transform:', ...want]), `got ${got.join(' + ')} / ${canon(back)}`);
}
check('lightOf reads both spellings with the fold\'s defaults; the legacy one wins when both',
  canon(lightOf({ lib: L, comp: { light: {} } })) === canon({ spelling: 'comp', color: 0xffd9a0, intensity: 16, range: 10, important: false, day: true })
  && lightOf({ kind: 'light', color: 1, intensity: 2, range: 3, day: false, comp: { light: { color: 4 } } })?.color === 1
  && lightOf({ kind: 'light', color: 1, intensity: 2, range: 3, day: false })?.day === false
  && lightOf({ lib: L, comp: { light: 'on' } }) === null && lightOf({ lib: L }) === null);
check('lightOf never lets a bad field reach the rig (NaN, string, negative → default)',
  canon(lightOf({ comp: { light: { color: 'red', intensity: -1, range: NaN, important: 'yes' } } })) === canon({ spelling: 'comp', color: 0xffd9a0, intensity: 16, range: 10, important: false, day: true }));
check('colliderOf: comp.collider wins, a bad shape falls back to legacy collide, absent = undefined',
  colliderOf({ collide: 'box', comp: { collider: { shape: 'exact' } } }) === 'exact'
  && colliderOf({ collide: 'box', comp: { collider: { shape: 'mesh' } } }) === 'box'
  && colliderOf({ lib: L }) === undefined);
check('isEmpty: no lib and not a legacy light', isEmpty({ pos: [0, 0, 0] }) && !isEmpty({ lib: L }) && !isEmpty({ kind: 'light' }) && !isEmpty(null));
check('a lamp (Model + comp.light) cannot add a second Light; an Empty can add one; Collider still needs a Model',
  !addable(componentsOf({ lib: L, comp: { light: {} } }).components).some((a) => a.name === 'Light')
  && addable(componentsOf({ pos: [0, 0, 0] }).components).some((a) => a.name === 'Light')
  && !addable(componentsOf({ pos: [0, 0, 0] }).components).some((a) => a.name === 'Collider'));

// ------------------------------------------------------------ the corpus (v4)
// Every world log we have: fold it (shared/protocol/fold.js), take the view a client reads (view.js viewState: the
// entity records the editor's componentsOf reads), and every entity must read as components and write back exact.
// (Protocol v1 removed, 2026-10-07: the v1 corpus went with it — every entry of every v1 log through the v1 fold, the
//  @world sky/terrain/grass components after every v1 world verb, and each entity saved as a blueprint and PLACED
//  through placeVerbs into the v1 fold. v4 blueprints are the door's: tools/blueprint-test.ts sections 6–7.)
const { readLog, fold } = await import('../shared/protocol/fold.js');
const { viewState } = await import('../shared/protocol/view.js');
const logs: string[] = [];
const walk = (d: string, depth = 0) => {
  if (depth > 4 || !existsSync(d)) return;
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (n === 'node_modules' || n === '.git') continue; walk(p, depth + 1); }
    else if (n.endsWith('.jsonl') && (n === 'world.jsonl' || d.endsWith(join('spec', 'v4', 'fixtures')))) logs.push(p);
  }
};
walk(join(import.meta.dir, '..', 'spec', 'v4', 'fixtures'));
for (const d of (process.env.COMPONENTS_CORPUS ?? '').split(':').filter(Boolean)) walk(d);
const seen = new Set<string>(); const unique: string[] = [];
for (const p of logs) { const h = createHash('md5').update(readFileSync(p)).digest('hex'); if (!seen.has(h)) { seen.add(h); unique.push(p); } }
console.log(`\nthe corpus: ${unique.length} distinct world logs (${logs.length} found; COMPONENTS_CORPUS adds dirs holding <world>/world.jsonl)`);
let checkedE = 0; const bad: string[] = []; const types = new Map<string, number>(); const extras = new Map<string, number>();
for (const path of unique) {
  let view: any;
  try { view = viewState(fold(readLog(readFileSync(path)))); } catch (e) { bad.push(`${path}: unreadable (${(e as Error).message})`); continue; }
  for (const [id, ent] of Object.entries(view.entities ?? {}) as [string, any][]) {
    const { born, ...rec } = ent;   // the fold's creation stamp rides beside the record, not in it
    const comps = componentsOf(rec);
    checkedE++;
    if (canon(entityOf(comps)) !== canon(rec) && bad.length < 12) bad.push(`${path.replace(/^.*?(worlds|fixtures)\//, '$1/')} ${id}\n     was ${canon(rec).slice(0, 300)}\n     got ${canon(entityOf(comps)).slice(0, 300)}`);
    for (const c of comps.components) { types.set(c.type, (types.get(c.type) ?? 0) + 1); for (const k of Object.keys(c.extra?.unknown ?? {})) extras.set(`${c.type}.${k}`, (extras.get(`${c.type}.${k}`) ?? 0) + 1); }
  }
}
check(`every entity of every world, as the view a client reads, round-trips through its components exactly (${checkedE} entities)`, bad.length === 0 && checkedE > 0, '\n   ' + bad.join('\n   '));
console.log('\ncomponents in the worlds:', [...types].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(' · '));
console.log('keys no record names (kept in extra, not lost):', extras.size ? [...extras].map(([k, n]) => `${k} ×${n}`).join(' · ') : 'none');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
