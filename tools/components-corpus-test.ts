// components-corpus-test — the component view is lossless on every world we have.
//
// For every world log in the corpus, fold it entry by entry; after each entry,
// read every entity it touched as components (shared/components.js
// componentsOf) and write it back (entityOf). The bytes must come back
// identical (canonical JSON), and every key must land in a component parameter,
// a declared stamp, or `extra` (which is counted and printed, never silently
// dropped). One differing entity anywhere = red.
//
// Corpus: spec/fixtures (always), plus any dirs in COMPONENTS_CORPUS
// (colon-separated; each is searched for worlds/*/log.jsonl or */log.jsonl).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/components-corpus-test.ts
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { emptyState, foldEntry } from '../shared/fold.js';
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
  const P: any = RECORDS.Pendulum; const S: any = RECORDS.Seats;
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
check('Picture needs a Model', !addable([{ type: 'Transform' }, { type: 'Light' }]).some((a) => a.name === 'Picture') && addable([{ type: 'Transform' }, { type: 'Model' }]).some((a) => a.name === 'Picture'));

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
  ['comp.light burning at noon (day:false ⇄ burnsAtNoon)', { lib: L, pos: [0, 0, 0], yaw: 0, comp: { light: { day: false, keep: true } }, ...st0 }, ['Model:', 'Light:light']],
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
  canon(lightOf({ lib: L, comp: { light: {} } })) === canon({ spelling: 'comp', color: 0xffd9a0, intensity: 16, range: 10, keep: false, day: true })
  && lightOf({ kind: 'light', color: 1, intensity: 2, range: 3, day: false, comp: { light: { color: 4 } } })?.color === 1
  && lightOf({ kind: 'light', color: 1, intensity: 2, range: 3, day: false })?.day === false
  && lightOf({ lib: L, comp: { light: 'on' } }) === null && lightOf({ lib: L }) === null);
check('lightOf never lets a bad field reach the rig (NaN, string, negative → default)',
  canon(lightOf({ comp: { light: { color: 'red', intensity: -1, range: NaN, keep: 'yes' } } })) === canon({ spelling: 'comp', color: 0xffd9a0, intensity: 16, range: 10, keep: false, day: true }));
check('colliderOf: comp.collider wins, a bad shape falls back to legacy collide, absent = undefined',
  colliderOf({ collide: 'box', comp: { collider: { shape: 'exact' } } }) === 'exact'
  && colliderOf({ collide: 'box', comp: { collider: { shape: 'mesh' } } }) === 'box'
  && colliderOf({ lib: L }) === undefined);
check('isEmpty: no lib and not a legacy light', isEmpty({ pos: [0, 0, 0] }) && !isEmpty({ lib: L }) && !isEmpty({ kind: 'light' }) && !isEmpty(null));
check('a lamp (Model + comp.light) cannot add a second Light; an Empty can add one; Collider still needs a Model',
  !addable(componentsOf({ lib: L, comp: { light: {} } }).components).some((a) => a.name === 'Light')
  && addable(componentsOf({ pos: [0, 0, 0] }).components).some((a) => a.name === 'Light')
  && !addable(componentsOf({ pos: [0, 0, 0] }).components).some((a) => a.name === 'Collider'));

// the same spellings arriving through the REAL fold, as a world would write
// them: round trip after every entry, exactly as the corpus is checked below
{
  const st: any = emptyState(); let n = 0; const badS: string[] = [];
  const log = [
    ['spawn', { id: 'pivot', pos: [0, 1, 0] }], ['spawn', { id: 'lamp', lib: L, collide: 'box' }],
    ['comp', { id: 'lamp', type: 'light', data: { color: 0xffaa66, intensity: 24, range: 9, day: false } }],
    ['comp', { id: 'lamp', type: 'collider', data: { shape: 'exact' } }], ['comp', { id: 'pivot', type: 'light', data: { keep: true } }],
    ['mount', { id: 'pivot', to: 'lamp', offset: [0, 1.8, 0] }], ['place', { id: 'pivot', q: [0, 0.3826834, 0, 0.9238795] }],
    ['light', { id: 'old', pos: [2, 1, 0], intensity: 40 }], ['comp', { id: 'old', type: 'label', data: 'porch' }],
    ['comp', { id: 'lamp', type: 'light', data: null }], ['comp', { id: 'lamp', type: 'rotOrder', data: 'YXZ' }],
    ['place', { id: 'lamp', q: [0.1, 0.2, 0.3, 0.9] }], ['comp', { id: 'lamp', type: 'rotOrder', data: null }], ['spawn', { id: 'pivot', scale: 3 }],
  ] as const;
  for (const [i, [verb, args]] of log.entries()) {
    foldEntry(st, { seq: i, ts: 1000 + i, actor: 'owner', verb, args } as any);
    const ent = st.entities[(args as any).id]; if (!ent) { badS.push(`${verb} ${(args as any).id}: folded to nothing`); continue; }
    n++; if (canon(entityOf(componentsOf(ent))) !== canon(ent)) badS.push(`${verb} ${(args as any).id}: ${canon(ent)}`);
  }
  check(`a synthetic world of the new spellings, through the real fold: round trip exact after every entry (${n} entity states)`, badS.length === 0 && n === log.length, badS.join(' | '));
}

// ------------------------------------------------------------ the corpus
const logs: string[] = [];
const walk = (d: string, depth = 0) => {
  if (depth > 4 || !existsSync(d)) return;
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (n === 'node_modules' || n === '.git') continue; walk(p, depth + 1); }
    else if (n === 'log.jsonl') logs.push(p);
  }
};
walk(join(import.meta.dir, '..', 'spec', 'fixtures'));
for (const d of (process.env.COMPONENTS_CORPUS ?? '').split(':').filter(Boolean)) walk(d);
const seen = new Set<string>(); const unique: string[] = [];
for (const p of logs) { const h = createHash('md5').update(readFileSync(p)).digest('hex'); if (!seen.has(h)) { seen.add(h); unique.push(p); } }

console.log(`\nthe corpus: ${unique.length} distinct world logs (${logs.length} found)`);
let entries = 0, checked = 0, entitiesSeen = 0;
const bad: string[] = [];
// the world entity (design §3, shared/worldentity.js): the fold's sky / terrain / grass
// read as @world's components and written back, after every world verb, exact
const WORLD_VERBS = new Set(['sky', 'weather', 'terrain', 'grass']);
let worldChecked = 0; const worldBad: string[] = []; const worldTypes = new Map<string, number>();
const types = new Map<string, number>();
const extras = new Map<string, number>();
// blueprints (design §3, step 6a): every final entity saved as a one-part
// blueprint — its components minus placement, parenting, captions and the
// stamps — must be a record the door accepts (or be refused for size alone),
// expand back to its exact bytes once the placement is put back, and read
// as a copy with no overrides
let bpSaved = 0; const bpRefused = new Map<string, number>(); const bpBad: string[] = [];
// …and then PLACED (step 6b): each saved blueprint placed as a copy (placeVerbs → the fold) where
// the entity stood, read back (copyTree) as exactly the record, with bytes that are the original's —
// or, for a legacy spelling (kind:"light", spawn's collide), the component spelling of the same
// light / collider (owner, 10-02: every new write uses the component form). Then every root that
// carries children saved WHOLE (its subtree, each child's Transform local) and placed the same way.
let placed = 0, legacyPlaced = 0, treesPlaced = 0, treeParts = 0; const placeBad: string[] = []; const treeBad: string[] = []; const placeRefused = new Map<string, number>();
const STAMP_KEYS = ['placer', 'born', 'actor', 'ts', 'box'];
const bytesOf = (e: any) => { const o: any = { ...e }; for (const k of [...STAMP_KEYS, 'pos', 'q', 'yaw', 'parent']) delete o[k]; if (o.comp) { o.comp = { ...o.comp }; delete o.comp[LINK_KEY]; delete o.comp.captions; if (!Object.keys(o.comp).length) delete o.comp; } return o; };
const placeInto = (pst: any, rec: any, at: any) => {
  const plan = placeVerbs(rec, at, { taken: (x: string) => !!pst.entities[x] });
  if (plan.errors.length) return { plan, error: plan.errors[0] };
  let s = 0; for (const v of plan.verbs) foldEntry(pst, { seq: s++, ts: 1, actor: 'corpus', verb: v.verb, args: v.args });
  return { plan, error: null };
};
for (const path of unique) {
  const st: any = emptyState();
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const ids = new Set<string>();
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    try { foldEntry(st, e); } catch { continue; }
    entries++;
    if (WORLD_VERBS.has(e?.verb)) {
      const view = worldComponents(st);
      worldChecked++;
      for (const c of view.components) worldTypes.set(c.type, (worldTypes.get(c.type) ?? 0) + 1);
      const sky = view.components.find((c: any) => c.type === 'Sky'), wx = view.components.find((c: any) => c.type === 'Weather');
      // the partition by meaning, from an oracle of its own (not worldentity's list): the weather
      // verb's keys, a forecast and its override are the Weather's, never the Sky's
      const split = !(sky?.params && wx?.params && Object.keys(wx.params).some((k) => k in sky.params))
        && !Object.keys(sky?.params ?? {}).some((k) => /^weather|^forecast$|^override$/.test(k));
      if ((canon(worldOf(view)) !== canon(worldState(st)) || !split) && worldBad.length < 8) worldBad.push(`${path.replace(/^.*?(worlds|fixtures)\//, '$1/')} @${e.seq ?? '?'} ${e.verb}\n     was ${canon(worldState(st)).slice(0, 300)}\n     got ${canon(worldOf(view)).slice(0, 300)}`);
    }
    const id = e?.args?.id ?? e?.id;
    const touched = typeof id === 'string' ? [id] : [];
    for (const tid of touched) {
      const ent = st.entities?.[tid];
      if (!ent) continue;
      ids.add(tid);
      const view = componentsOf(ent);
      const back = entityOf(view);
      checked++;
      if (canon(back) !== canon(ent)) { if (bad.length < 12) bad.push(`${path.replace(/^.*?(worlds|fixtures)\//, '$1/')} @${e.seq ?? '?'} ${tid}\n     was ${canon(ent).slice(0, 300)}\n     got ${canon(back).slice(0, 300)}`); }
    }
  }
  entitiesSeen += ids.size;
  for (const [eid, ent] of Object.entries(st.entities ?? {}) as [string, any][]) {
    const { components, stamps } = componentsOf(ent);
    const placement: any = {};
    const design = components.filter((c: any) => c.type !== 'Attachment' && c.type !== 'Captions').map((c: any) => {
      if (c.type !== 'Transform') return c;
      const p = { ...c.params };
      for (const k of ['pos', 'q', 'yaw']) if (p[k] !== undefined) { placement[k] = p[k]; delete p[k]; }
      return { ...c, params: p };
    });
    const rec: any = { kind: 'eido.blueprint', v: 1, name: String(ent.comp?.label ?? eid).slice(0, 64) || 'thing', root: { components: design, children: [] } };
    const why = blueprintRefusal(rec);
    if (why) { const k = why.replace(/\d+/g, 'N').slice(0, 60); bpRefused.set(k, (bpRefused.get(k) ?? 0) + 1); continue; }
    bpSaved++;
    const x = expand(rec);
    const back = { ...x.entity, ...placement, ...(ent.parent ? { parent: ent.parent } : {}), ...stamps };
    if (ent.comp?.captions !== undefined) (back.comp ??= {}).captions = ent.comp.captions;
    const asCopy = { components, children: [] };
    const ov = overridesOf(asCopy, rec);
    // placed: in a world of its own, at the entity's own placement
    {
      const pst: any = emptyState();
      const { error } = placeInto(pst, rec, { id: 'copy', pos: placement.pos ?? [0, 0, 0], ...(placement.q ? { q: placement.q } : {}), ...(placement.yaw != null ? { yaw: placement.yaw } : {}) });
      const tag = `${path.replace(/^.*?(worlds|fixtures)\//, '$1/')} ${eid}`;
      if (error) { const k = error.replace(/\d+/g, 'N').slice(0, 70); placeRefused.set(k, (placeRefused.get(k) ?? 0) + 1); }
      else {
        placed++;
        const got = pst.entities.copy;
        const t = copyTree(pst.entities, 'copy', rec);
        const pov = t ? overridesOf(t.tree, rec) : [{ missing: true }];
        const legacy = ent.kind === 'light' || ent.collide !== undefined;
        if (legacy) legacyPlaced++;
        // the bytes: the original's, or (legacy) the modern spelling's — and then the meaning matches the original's
        const want = legacy ? bytesOf(expand({ ...rec, root: { ...rec.root, components: modernize(rec.root.components) } }).entity) : bytesOf(ent);
        const same = canon(bytesOf(got)) === canon(want)
          && (!legacy || (canon({ ...lightOf(got), spelling: 0 }) === canon({ ...lightOf(ent), spelling: 0 }) && colliderOf(got) === colliderOf(ent) && got.kind == null))
          && J(got.pos) === J(placement.pos ?? [0, 0, 0]) && got.comp?.[LINK_KEY]?.hash === blueprintHash(rec);
        if ((!same || pov.length) && placeBad.length < 8) placeBad.push(`${tag}\n     was ${canon(bytesOf(ent)).slice(0, 240)}\n     got ${canon(bytesOf(got)).slice(0, 240)}${pov.length ? `\n     overrides ${JSON.stringify(pov).slice(0, 200)}` : ''}`);
      }
    }
    if ((canon(back) !== canon(ent) || ov.length || !/^[0-9a-f]{64}$/.test(blueprintHash(rec))) && bpBad.length < 8) {
      bpBad.push(`${path.replace(/^.*?(worlds|fixtures)\//, '$1/')} ${eid}\n     was ${canon(ent).slice(0, 300)}\n     got ${canon(back).slice(0, 300)}${ov.length ? `\n     overrides ${JSON.stringify(ov).slice(0, 200)}` : ''}`);
    }
  }
  // whole trees: every root that carries children, saved with its subtree and placed
  {
    const world = st.entities ?? {};
    const { roots, kids } = treeOf(world);
    const strip = (comps: any[]) => comps.filter((c: any) => c.type !== 'Attachment' && c.type !== 'Captions');
    for (const rid of roots) {
      if (!kids.get(rid)?.length) continue;
      const placement: any = {};
      const node = (id: string, isRoot: boolean): any => {
        const comps = isRoot ? componentsOf(world[id]).components : localComponents(world, world[id]);
        const design = strip(comps).map((c: any) => {
          if (c.type !== 'Transform' || !isRoot) return c;
          const p = { ...c.params }; for (const k of ['pos', 'q', 'yaw']) if (p[k] !== undefined) { placement[k] = p[k]; delete p[k]; }
          return { ...c, params: p };
        });
        const n: any = { components: design, children: (kids.get(id) ?? []).map((k) => node(k, false)) };
        if (!isRoot) n.id = id.replace(/\//g, '_');
        return n;
      };
      const rec: any = { kind: 'eido.blueprint', v: 1, name: 'tree', root: node(rid, true) };
      const why = blueprintRefusal(rec);
      if (why) { const k = `tree: ${why.replace(/\d+/g, 'N').slice(0, 60)}`; placeRefused.set(k, (placeRefused.get(k) ?? 0) + 1); continue; }
      const pst: any = emptyState();
      const { plan, error } = placeInto(pst, rec, { id: 'copy', pos: placement.pos ?? [0, 0, 0], ...(placement.q ? { q: placement.q } : {}), ...(placement.yaw != null ? { yaw: placement.yaw } : {}) });
      if (error) { const k = `tree: ${error.replace(/\d+/g, 'N').slice(0, 60)}`; placeRefused.set(k, (placeRefused.get(k) ?? 0) + 1); continue; }
      treesPlaced++; treeParts += Object.keys(plan.parts).length;
      const t = copyTree(pst.entities, 'copy', rec);
      const pov = t ? overridesOf(t.tree, rec) : [{ missing: true }];
      if ((pov.length || Object.keys(t?.parts ?? {}).length !== Object.keys(plan.parts).length) && treeBad.length < 8) treeBad.push(`${path.replace(/^.*?(worlds|fixtures)\//, '$1/')} tree ${rid} (${Object.keys(plan.parts).length} parts)\n     overrides ${JSON.stringify(pov).slice(0, 300)}`);
    }
  }
  for (const ent of Object.values(st.entities ?? {})) for (const c of componentsOf(ent).components) {
    types.set(c.type, (types.get(c.type) ?? 0) + 1);
    for (const k of Object.keys(c.extra?.unknown ?? {})) extras.set(`${c.type}.${k}`, (extras.get(`${c.type}.${k}`) ?? 0) + 1);
  }
}
check(`round trip exact after every entry (${checked} entity states, ${entries} entries, ${entitiesSeen} entities)`, bad.length === 0 && checked > 0, '\n   ' + bad.join('\n   '));
check(`@world: the world's sky / terrain / grass as components and back, exact after every world verb (${worldChecked} world states; ${[...worldTypes].map(([t, n]) => `${t} ${n}`).join(' · ')})`,
  worldBad.length === 0 && worldChecked > 0 && (worldTypes.get('Sky') ?? 0) > 0, '\n   ' + worldBad.join('\n   '));
check(`blueprints: every final entity saved as a one-part blueprint expands back exact, with no overrides (${bpSaved} saved${bpRefused.size ? `; refused: ${[...bpRefused].map(([k, n]) => `${n}× ${k}`).join(' · ')}` : ''})`,
  bpBad.length === 0 && bpSaved > 0 && [...bpRefused.keys()].every((k) => /bytes|larger than a component/.test(k)), '\n   ' + bpBad.join('\n   '));
check(`blueprints placed: every saved blueprint placed as a copy reads back as its record, with the original's bytes (${placed} placed, ${legacyPlaced} of them legacy lights/colliders written as components${placeRefused.size ? `; refused: ${[...placeRefused].map(([k, n]) => `${n}× ${k}`).join(' · ')}` : ''})`,
  placeBad.length === 0 && placed > 0 && placed === bpSaved - [...placeRefused].filter(([k]) => !k.startsWith('tree:')).reduce((a, [, n]) => a + n, 0) && [...placeRefused.keys()].every((k) => /bytes|larger than a component/.test(k)), '\n   ' + placeBad.join('\n   '));
check(`blueprints placed whole: every root with children saved with its subtree, placed, read back as its record (${treesPlaced} trees, ${treeParts} parts)`,
  treeBad.length === 0 && (treesPlaced > 0 || !process.env.COMPONENTS_CORPUS), '\n   ' + treeBad.join('\n   '));
console.log('\ncomponents in the final worlds:', [...types].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(' · '));
console.log('keys no record names (kept in extra, not lost):', extras.size ? [...extras].map(([k, n]) => `${k} ×${n}`).join(' · ') : 'none');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
