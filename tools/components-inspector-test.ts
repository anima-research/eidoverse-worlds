// components-inspector-test — the inspector's component cards (schema.sections) over the real corpus.
//
// For every entity in every world the corpus test reads: one card per component,
// every address a card names resolves to a real schema field, no field is owned by
// two cards, and every editable field of the old groups is reachable from some card
// (a field nobody can reach is a field only a model can edit). Then add/remove
// lower to door requests, checked through the real door.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/components-inspector-test.ts
//
// the protocol port (2026-10-06): the corpus is the spec fixtures (and COMPONENTS_CORPUS) TRANSLATED
// (shared/protocol/translate-v1.js, as a world is migrated) and read as the view (shared/protocol/view.js) — the records an
// inspector sees. Light-verb lights and guard are gone (a translated light is a thing with a light component).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inspectSchema, fieldAt, editOps, partLabel, libLabel } from '../shared/editschema.js';
import { componentsOf } from '../shared/components.js';
import { translate } from './protocol/import-v1/translate-v1.js';
import { viewState } from '../shared/protocol/view.js';
import { emptyState, applyInPlace, opsOf } from '../shared/protocol/fold.js';
import { v1FoldBuild } from './protocol/import-v1/build.ts';
import { scratchWorld, flat } from './protocol/scratchworld.ts';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`); };

const logs: string[] = [];
const walk = (d: string, depth = 0) => {
  if (depth > 4 || !existsSync(d)) return;
  for (const n of readdirSync(d)) {
    const p = join(d, n); let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (n !== 'node_modules' && n !== '.git') walk(p, depth + 1); } else if (n === 'log.jsonl') logs.push(p);
  }
};
walk(join(import.meta.dir, '..', 'spec', 'fixtures'));
for (const d of (process.env.COMPONENTS_CORPUS ?? '').split(':').filter(Boolean)) walk(d);

const ents: [string, any][] = [];
let untranslated = 0;
for (const p of logs) {
  const old: any[] = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) { if (!line) continue; try { old.push(JSON.parse(line)); } catch { /* skip */ } }
  let r: any; try { r = translate(old, { foldBuild: v1FoldBuild() }); } catch { untranslated++; continue; }
  const st: any = emptyState(); r.out.forEach((e: any, seq: number) => { if (e.kind === 'change') applyInPlace(st, opsOf(e), seq); });
  for (const [id, e] of Object.entries(viewState(st).entities ?? {})) ents.push([id, e]);
}
console.log(`${ents.length} final entities from ${logs.length} logs, translated (${untranslated} untranslatable)`);
check('every corpus log translates, and the corpus is not empty', untranslated === 0 && ents.length > 10, `${untranslated} / ${ents.length}`);

const probs: string[] = [];
let cards = 0;
for (const [id, e] of ents) {
  const s = inspectSchema(e, id);
  const comps = componentsOf(e).components;
  cards += s.sections.list.length;
  const inHeader = comps.filter((c) => c.type === 'Label' || c.type === 'Hidden' || c.type === 'Description').length;
  const emptyParent = s.sections.list.filter((c: any) => c.type === 'Parent' && c.present === false).length;   // a root's quiet Parent card (the no-drag path, R 10-04)
  if (s.sections.list.length - emptyParent !== comps.length - inHeader) probs.push(`${id}: ${comps.length} components (${inHeader} in the header), ${s.sections.list.length} cards`);
  const owned = new Map<string, string>();
  for (const a of s.sections.header) owned.set(a, 'header');
  const addable = new Set(s.sections.add.filter((a: any) => !a.blocked).map((a: any) => a.name));
  for (const sec of s.sections.list) for (const a of sec.fields) {
    if (!fieldAt(s, a)) probs.push(`${id}: card ${sec.title} names ${a}, which is no field`);
    if (owned.has(a)) probs.push(`${id}: ${a} owned by ${owned.get(a)} and ${sec.title}`);
    owned.set(a, sec.title);
  }
  // every editable field of the old groups is in some card (the type enum and
  // come-to-rest are replaced by the card itself and its remove button; the
  // put-out/take-down/silence buttons likewise; add:* buttons move to Add Component)
  for (const g of s.groups) for (const f of g.fields) {
    if (f.k == null || f.t === 'info') continue;
    const a = `${g.group}.${f.k}`;
    const replaced = /(^|\|)(type|rest)$/.test(f.k) && g.group === 'motion' || ['particles.out', 'picture.down', 'sound.silence', 'comp.+'].includes(a) || a.startsWith('comp.add:') || /\.json\|/.test(a)
      || (a === 'flags.lock' && addable.has('Lock'));
    if (!owned.has(a) && !replaced && !(g.group === 'comp' && owned.has(`comp.${f.k}`))) probs.push(`${id}: ${a} is in no card`);
  }
}
// the header's lib line reads the Model component, on every corpus entity (it said "lib ?" beside a Model card)
{
  const bad: string[] = []; let titled = 0, lamps = 0; const rawTitles: string[] = [];
  for (const [id, e] of ents) {
    const sec = inspectSchema(e, id).sections;
    const want = e.lib != null ? String(e.lib) : null;
    if (!want && e.comp?.light) lamps++;
    if (sec.lib !== want) bad.push(`${id}: lib ${sec.lib} vs ${want}`);
    if (sec.libLabel !== (want ? libLabel(want) : e.comp?.light ? 'light' : 'empty') || /\?/.test(sec.libLabel)) bad.push(`${id}: label ${sec.libLabel}`);
    for (const c of sec.list) if (c.part) { titled++; if (/tripo_|_fused_|^mesh_\d/.test(c.title.split(' · ')[1] ?? '')) rawTitles.push(`${id}: ${c.title}`); }
  }
  check(`the header's lib line is the Model component's, on every entity (an Empty says empty, a lamp with no model says light; ${lamps} such lamps)`, bad.length === 0, bad.slice(0, 6).join(' | '));
  check(`no part-scoped card is titled with a generator's node name (${titled} part cards in the corpus)`, rawTitles.length === 0, rawTitles.slice(0, 6).join(' | '));
}
{
  const sw = { lib: 'store/swing.glb', pos: [0, 0, 0], comp: { 'motion:tripo_part_fused_0': { type: 'pendulum', amp: 0.2 }, 'motion:tripo_part_fused_3': { type: 'spin' }, 'motion:seat_plank': { type: 'bob' }, 'motion:mesh7': { type: 'bob' } } };
  const titles = (live: any = {}) => inspectSchema(sw, 's', live).sections.list.filter((c: any) => c.part).map((c: any) => c.title);
  check('part cards: "Pendulum · part 1" for tripo_part_fused_0 (its number + 1), the modeller\'s own word kept ("seat plank"), mesh7 → part 8',
    JSON.stringify(titles()) === JSON.stringify(['Pendulum · part 1', 'Spin · part 4', 'Bob · seat plank', 'Bob · part 8']), JSON.stringify(titles()));
  check('…with the model\'s parts known, the number is its place among them', JSON.stringify(titles({ parts: ['frame', 'tripo_part_fused_3', 'tripo_part_fused_0'] }).slice(0, 2)) === JSON.stringify(['Pendulum · part 3', 'Spin · part 2']), JSON.stringify(titles({ parts: ['frame', 'tripo_part_fused_3', 'tripo_part_fused_0'] })));
  check('…and the raw node name rides the card (the panel puts it in the hint)', inspectSchema(sw, 's').sections.list.find((c: any) => c.part === 'tripo_part_fused_0')?.title === 'Pendulum · part 1');
  check('partLabel: machine names (Cube.003, node_4, a uuid) become a place; words stay words', partLabel('Cube.003') === 'part 4' && partLabel('node_4') === 'part 5' && partLabel('3f2a9c1e-77aa-4c3b') === 'part 1' && partLabel('Door_Left') === 'Door Left' && partLabel('wheel2') === 'wheel2');
}
check(`every entity: a card per component (label and hidden in the header), every card field real, owned once, every field reachable (${cards} cards)`, probs.length === 0, '\n   ' + [...new Set(probs)].slice(0, 15).join('\n   '));

// add / remove: the door requests, and what they DO through the real door
const crate = { lib: 'store/x.glb', pos: [0, 1, 0], comp: { motion: { type: 'pendulum', axis: 'z', amp: 0.24, period: 3.4, t0: 1 }, lock: true } };
const v = (set: Record<string, unknown>, e: any = crate) => editOps(e, 'c1', set);
const through = (set: Record<string, unknown>) => { const W = scratchWorld('compinspector').seed({ c1: crate }); const r = v(set); const res = W.sendAll(r.ops); return { r, res, after: W.rec('c1') }; };
{
  const a = through({ 'add.Spin': 'arm' });
  check('add.Spin on a part → set motion:arm {spin 36°/s}', JSON.stringify(a.r.ops) === JSON.stringify([{ verb: 'set', args: { id: 'c1', component: 'motion:arm', value: { type: 'spin', degPerSec: 36 } } }]), JSON.stringify(a.r.ops));
  check('…through the door: the part spins, the whole-entity pendulum is untouched', a.res.ok && a.after.comp['motion:arm']?.type === 'spin' && a.after.comp['motion:arm'].degPerSec === 36 && a.after.comp.motion?.type === 'pendulum', JSON.stringify([a.res.refused, a.after.comp]));
}
check('add.Spin with a whole motion present → refused, says why', v({ 'add.Spin': '' }).ops.length === 0 && /already moves as a whole/.test(v({ 'add.Spin': '' }).errors[0] ?? ''));
{
  const m = through({ 'remove.motion': null });
  check('remove.motion → delete motion; through the door it no longer moves', JSON.stringify(m.r.ops) === JSON.stringify([{ verb: 'delete', args: { id: 'c1', component: 'motion' } }]) && m.res.ok && m.after.comp?.motion === undefined, JSON.stringify([m.r.ops, m.res.refused]));
  const l = through({ 'remove.lock': null });
  check('remove.lock → delete lock; through the door it is unlocked (any builder may unlock)', JSON.stringify(l.r.ops) === JSON.stringify([{ verb: 'delete', args: { id: 'c1', component: 'lock' } }]) && l.res.ok && l.after.comp?.lock === undefined, JSON.stringify([l.r.ops, l.res.refused]));
  // step 2 (design §6): a lamp is a Model with a Light component
  const L = through({ 'add.Light': null });
  check('add.Light on a model → set light with its fields spelled out (write-new-on-edit)', JSON.stringify(L.r.ops) === JSON.stringify([{ verb: 'set', args: { id: 'c1', component: 'light', value: { color: 0xffd9a0, intensity: 16, range: 10 } } }]), JSON.stringify(L.r.ops));
  check('…through the door it is lit with exactly those values (a lock doesn\'t bar a light)', L.res.ok && L.after.comp?.light?.color === 0xffd9a0 && L.after.comp.light.intensity === 16 && L.after.comp.light.range === 10, JSON.stringify([L.res.refused, L.after.comp]));
}
check('Add Component lists blocked entries with a reason; Light and Collider are no longer among them', (() => { const s = inspectSchema(crate, 'c1'); const st = s.sections.add.find((a: any) => a.name === 'Structure'); const ok = (n: string) => s.sections.add.some((a: any) => a.name === n && !a.blocked); return !!st?.blocked && ok('Particles') && ok('Light') && ok('Collider'); })());
// KNOWN BUG (reported 2026-10-06, not fixed here): guard is merged into lock, but shared/components.js RECORDS
// still has Guard, so Add Component offers it UNBLOCKED; choosing it then fails ("Guard: added by a gesture, not a
// value (see its card)") — a menu entry that can only error. Either drop it from the list or block it saying "use Lock".
check('Add Component does not offer Guard as addable (merged into Lock) (KNOWN BUG)', (() => { const g = inspectSchema(crate, 'c1').sections.add.find((a: any) => a.name === 'Guard'); return !g || (!!g.blocked && /lock/i.test(g.blocked)); })(),
  JSON.stringify([inspectSchema(crate, 'c1').sections.add.find((a: any) => a.name === 'Guard'), editOps(crate, 'c1', { 'add.Guard': null }).errors]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
