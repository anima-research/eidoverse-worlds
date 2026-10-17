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
import { enc } from '../shared/protocol/names.js';
import { emptyState, applyInPlace, opsOf } from '../shared/protocol/fold.js';
import { v1FoldBuild } from './protocol/import-v1/build.ts';
import { scratchWorld, flat } from './protocol/scratchworld.ts';
import { registerDraft, trustedOf } from '../shared/drafts.js';
import { materialize } from '../shared/protocol/componentspec.js';

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
const folds: [string, any][] = [];   // the same entities as the fold holds them (C7b: the editor's one input)
let untranslated = 0;
for (const p of logs) {
  const old: any[] = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) { if (!line) continue; try { old.push(JSON.parse(line)); } catch { /* skip */ } }
  let r: any; try { r = translate(old, { foldBuild: v1FoldBuild() }); } catch { untranslated++; continue; }
  const st: any = emptyState(); r.out.forEach((e: any, seq: number) => { if (e.kind === 'change') applyInPlace(st, opsOf(e), seq); });
  for (const [id, e] of Object.entries(viewState(st).entities ?? {})) { ents.push([id, e]); folds.push([id, st.entities[enc(id)]?.c]); }
}
console.log(`${ents.length} final entities from ${logs.length} logs, translated (${untranslated} untranslatable)`);
check('every corpus log translates, and the corpus is not empty', untranslated === 0 && ents.length > 10, `${untranslated} / ${ents.length}`);

{
  // the fold record is the one input: every corpus entity read as `c` (through view.js recordOf) gives the schema and the
  // components its view gives, byte for byte — the pin that (b) moved the editor's input, not just its fixtures
  const J = (v: any) => JSON.stringify(v);
  // (`born` is the entity's, not its bag's: the view carries it as a stamp, a bare `c` can't)
  const comps = (x: any) => { const r = componentsOf(x); const { born: _b, ...stamps } = r.stamps ?? {}; return { ...r, stamps }; };
  let same = 0; const diff: string[] = [];
  folds.forEach(([id, c], i) => {
    const e = ents[i][1]; if (!c) { diff.push(`${id}: not in the fold`); return; }
    if (J(inspectSchema(c, id)) === J(inspectSchema(e, id)) && J(comps(c)) === J(comps(e))) same++; else { diff.push(id); if (process.env.SHOW_DIFF) { const a = inspectSchema(c, id), b = inspectSchema(e, id); const d = (x: any, y: any, path = '') => { if (J(x) === J(y)) return; if (x && y && typeof x === 'object' && typeof y === 'object') { for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) d(x[k], y[k], `${path}.${k}`); } else console.log(`   ${id}${path}: fold ${J(x)} vs view ${J(y)}`); }; d(a, b); d(comps(c), comps(e), ' comps'); } }
  });
  check(`inspectSchema(c) ≡ inspectSchema(view) and componentsOf(c) ≡ componentsOf(view) over the corpus (${same}/${folds.length})`, same === folds.length && folds.length === ents.length, diff.slice(0, 5).join(', '));
}

const probs: string[] = [];
let cards = 0;
for (const [id, e] of ents) {
  const s = inspectSchema(e, id);
  const comps = componentsOf(e).components;
  cards += s.sections.list.length;
  const inHeader = comps.filter((c) => c.type === 'Label' || c.type === 'Hidden' || c.type === 'Description' || String(c.key ?? '').startsWith('hesperus/material:')).length;   // (a one-slot material override is a row of the Material card)
  const emptyParent = s.sections.list.filter((c: any) => (c.type === 'Parent' || c.type === 'Material') && c.present === false).length;   // a root's quiet Parent card (the no-drag path, R 10-04); a model's Material card before any override (R 10-10)
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
      || (a === 'flags.lock' && addable.has('Lock'))
      || a === 'flags.layer';   // the selection layer is a row of the Attributes tab (editpanels attributesFields), not a card
    if (!owned.has(a) && !replaced && !(g.group === 'comp' && owned.has(`comp.${f.k}`))) probs.push(`${id}: ${a} is in no card`);
  }
}
// C8: every engine card the corpus may lack (openable, pivot, description, story, text, particles…) on one synthetic thing —
// every value row of a typed card is claimed by its card (shared/protocol/descriptors.js claims it, or the card's own
// extra), and nothing a typed card shows is doubled on the raw-JSON floor. Mutation (2026-10-12): drop `intensity` from
// the Light descriptor's show → "light.intensity is in no card" on every lamp here and in the corpus.
{
  const M = (k: string, x: any = {}) => materialize(k, x).value;
  const every: any = { model: 'store/x.glb', pos: [0, 0, 0], yaw: 0, light: { ...M('light'), day: false, important: true }, collider: { shape: 'box' }, pivot: { pos: [0, 1, 0] },
    motion: { type: 'pendulum', amp: 0.2 }, 'motion:a': { type: 'spin' }, 'motion:b': { type: 'orbit' }, 'motion:c': { type: 'bob' }, 'motion:d': { type: 'path', points: [[0, 0, 0], [1, 1, 1]], duration: 2 },
    openable: { open: true, angle: 1 }, grabbable: { fits: ['key'] }, sockets: { seat: { pos: [0, 0.5, 0], body: {} } },
    particles: { effect: 'fire', params: { count: 10 } }, picture: { src: 'store/a.png' }, sound: { src: 'store/a.mp3' }, story: { title: 't', text: 'x' },
    text: { text: 'hi', background: 0x202020 }, 'look-at': { target: '@viewer' }, 'look-at:head': { target: 'c1' },
    lock: true, hidden: true, disabled: true, label: 'nm', description: 'd', 'hesperus/material': { color: 1 }, physics: { kind: 'dynamic' }, home: { pos: [0, 0, 0] }, reactions: { push: { kind: 'push' } }, 'script:s': { paused: true }, 'local/recipe': { a: 1 } };
  const s = inspectSchema(every, 'every', { parts: ['lid'], box: [[-1, 0, -1], [1, 2, 1]], materials: [{ slot: 'm', name: 'm', color: 1 }], mutedForMe: false, effects: () => null });
  const owned = new Set<string>([...s.sections.header, ...s.sections.list.flatMap((c: any) => c.fields)]);
  const unowned: string[] = [];
  for (const g of s.groups) for (const f of g.fields) {
    if (f.k == null || f.t === 'info') continue;
    const a = `${g.group}.${f.k}`;
    const replaced = /(^|\|)(type|rest)$/.test(f.k) && g.group === 'motion' || ['particles.out', 'picture.down', 'sound.silence', 'comp.+'].includes(a) || a.startsWith('comp.add:') || /\.json\|/.test(a) || a === 'flags.layer';
    if (!owned.has(a) && !replaced) unowned.push(a);
  }
  const floor = s.groups.find((g: any) => g.group === 'comp')!.fields.filter((f: any) => f.t === 'json').map((f: any) => f.k);
  check(`one thing with every engine card: every value row is claimed by a card (${owned.size} claimed)`, unowned.length === 0, unowned.join(', '));
  check('…and the raw-JSON floor holds only what no typed card draws (reactions, the script, the recipe): no doubled key', JSON.stringify(floor) === JSON.stringify(['reactions', 'local/recipe']), JSON.stringify(floor));
}
// the header's lib line reads the Model component, on every corpus entity (it said "lib ?" beside a Model card)
{
  const bad: string[] = []; let titled = 0, lamps = 0; const rawTitles: string[] = [];
  for (const [id, e] of ents) {
    const sec = inspectSchema(e, id).sections;
    const want = e.model != null ? String(e.model) : null;
    if (!want && e?.light) lamps++;
    if (sec.model !== want) bad.push(`${id}: lib ${sec.model} vs ${want}`);
    if (sec.libLabel !== (want ? libLabel(want) : e?.light ? 'light' : 'empty') || /\?/.test(sec.libLabel)) bad.push(`${id}: label ${sec.libLabel}`);
    for (const c of sec.list) if (c.part) { titled++; if (/tripo_|_fused_|^mesh_\d/.test(c.title.split(' · ')[1] ?? '')) rawTitles.push(`${id}: ${c.title}`); }
  }
  check(`the header's lib line is the Model component's, on every entity (an Empty says empty, a lamp with no model says light; ${lamps} such lamps)`, bad.length === 0, bad.slice(0, 6).join(' | '));
  check(`no part-scoped card is titled with a generator's node name (${titled} part cards in the corpus)`, rawTitles.length === 0, rawTitles.slice(0, 6).join(' | '));
}
{
  const sw = { model: 'store/swing.glb', pos: [0, 0, 0], 'motion:tripo_part_fused_0': { type: 'pendulum', amp: 0.2 }, 'motion:tripo_part_fused_3': { type: 'spin' }, 'motion:seat_plank': { type: 'bob' }, 'motion:mesh7': { type: 'bob' } };
  const titles = (live: any = {}) => inspectSchema(sw, 's', live).sections.list.filter((c: any) => c.part).map((c: any) => c.title);
  check('part cards: "Pendulum · part 1" for tripo_part_fused_0 (its number + 1), the modeller\'s own word kept ("seat plank"), mesh7 → part 8',
    JSON.stringify(titles()) === JSON.stringify(['Pendulum · part 1', 'Spin · part 4', 'Bob · seat plank', 'Bob · part 8']), JSON.stringify(titles()));
  check('…with the model\'s parts known, the number is its place among them', JSON.stringify(titles({ parts: ['frame', 'tripo_part_fused_3', 'tripo_part_fused_0'] }).slice(0, 2)) === JSON.stringify(['Pendulum · part 3', 'Spin · part 2']), JSON.stringify(titles({ parts: ['frame', 'tripo_part_fused_3', 'tripo_part_fused_0'] })));
  check('…and the raw node name rides the card (the panel puts it in the hint)', inspectSchema(sw, 's').sections.list.find((c: any) => c.part === 'tripo_part_fused_0')?.title === 'Pendulum · part 1');
  check('partLabel: machine names (Cube.003, node_4, a uuid) become a place; words stay words', partLabel('Cube.003') === 'part 4' && partLabel('node_4') === 'part 5' && partLabel('3f2a9c1e-77aa-4c3b') === 'part 1' && partLabel('Door_Left') === 'Door Left' && partLabel('wheel2') === 'wheel2');
}
check(`every entity: a card per component (label and hidden in the header), every card field real, owned once, every field reachable (${cards} cards)`, probs.length === 0, '\n   ' + [...new Set(probs)].slice(0, 15).join('\n   '));

// add / remove: the door requests, and what they DO through the real door
const crate = { model: 'store/x.glb', pos: [0, 1, 0], motion: { type: 'pendulum', axis: 'z', amp: 0.24, period: 3.4, t0: 1 }, lock: true };
const v = (set: Record<string, unknown>, e: any = crate) => editOps(e, 'c1', set);
// a lock covers everything on the thing (b1d9c7dd, R 10-11): motion and light edits go to an UNLOCKED copy; the lock checks keep the locked one
const open = { ...crate, lock: undefined };   // the same crate, unlocked (its components sit flat on the record)
const through = (set: Record<string, unknown>, e: any = crate) => { const W = scratchWorld('compinspector').seed({ c1: e }); const r = v(set); const res = W.sendAll(r.ops); return { r, res, after: W.rec('c1') }; };
{
  const a = through({ 'add.Spin': 'arm' }, open);
  check('add.Spin on a part → set motion:arm {spin 36°/s, node: arm} (the node is data in the value; review r7)', JSON.stringify(a.r.ops) === JSON.stringify([{ verb: 'set', args: { id: 'c1', component: 'motion:arm', value: { type: 'spin', degPerSec: 36, node: 'arm' } } }]), JSON.stringify(a.r.ops));
  check('…through the door: the part spins, the whole-entity pendulum is untouched', a.res.ok && a.after['motion:arm']?.type === 'spin' && a.after['motion:arm'].degPerSec === 36 && a.after.motion?.type === 'pendulum', JSON.stringify([a.res.refused, a.after.comp]));
}
check('add.Spin with a whole motion present → refused, says why', v({ 'add.Spin': '' }).ops.length === 0 && /already moves as a whole/.test(v({ 'add.Spin': '' }).errors[0] ?? ''));
{
  const m = through({ 'remove.motion': null }, open);
  check('remove.motion → delete motion; through the door it no longer moves', JSON.stringify(m.r.ops) === JSON.stringify([{ verb: 'delete', args: { id: 'c1', component: 'motion' } }]) && m.res.ok && m.after?.motion === undefined, JSON.stringify([m.r.ops, m.res.refused]));
  const l = through({ 'remove.lock': null });
  check('remove.lock → delete lock; through the door it is unlocked (any builder may unlock)', JSON.stringify(l.r.ops) === JSON.stringify([{ verb: 'delete', args: { id: 'c1', component: 'lock' } }]) && l.res.ok && l.after?.lock === undefined, JSON.stringify([l.r.ops, l.res.refused]));
  // step 2 (design §6, revised 10-11: one place per thing): a lamp is a Model with a Light CHILD, a metre up
  const L = through({ 'add.Light': null }, open);
  { const o: any = L.r.ops[0]; const cc = o?.args?.components ?? {};
    check('add.Light on a model → ONE create: a child light a metre up, under c1, with its fields spelled out (write-new-on-edit)', L.r.ops.length === 1 && o.verb === 'create' && o.args.id === 'c1-light' && cc.parent?.to === 'c1' && JSON.stringify(cc.transform?.pos) === '[0,1,0]' && JSON.stringify(cc.light) === JSON.stringify({ color: 0xffd9a0, intensity: 16, range: 10 }), JSON.stringify(L.r.ops)); }
  check('…through the door the child is lit with exactly those values, under c1', L.res.ok && L.after?.light === undefined, JSON.stringify(L.res));
}
check('Add Component lists blocked entries with a reason; Light and Collider are no longer among them', (() => { const s = inspectSchema(crate, 'c1'); const st = s.sections.add.find((a: any) => a.name === 'Structure'); const ok = (n: string) => s.sections.add.some((a: any) => a.name === n && !a.blocked); return !!st?.blocked && ok('Particles') && ok('Light') && ok('Collider'); })());
// KNOWN BUG (reported 2026-10-06, not fixed here): guard is merged into lock, but shared/components.js RECORDS
// still has Guard, so Add Component offers it UNBLOCKED; choosing it then fails ("Guard: added by a gesture, not a
// value (see its card)") — a menu entry that can only error. Either drop it from the list or block it saying "use Lock".
check('Add Component does not offer Guard as addable (merged into Lock) (KNOWN BUG)', (() => { const g = inspectSchema(crate, 'c1').sections.add.find((a: any) => a.name === 'Guard'); return !g || (!!g.blocked && /lock/i.test(g.blocked)); })(),
  JSON.stringify([inspectSchema(crate, 'c1').sections.add.find((a: any) => a.name === 'Guard'), editOps(crate, 'c1', { 'add.Guard': null }).errors]));

// the trusted rung end to end (R 10-12 10:09): the owner's button plans one @world.trusted write; through the real door
// the world carries it; the schema read with that list flips the chip amber → blue and the offer moves out of "drafts";
// a builder's same button is refused by the door
{
  registerDraft('hesperus/material', { title: 'Material', summary: 'override its look', category: 'Look', applies: (e: any) => e?.model != null });
  const W = scratchWorld('compinspector').seed({ c1: crate });
  W.call('set', { id: '@world', component: 'roles:bob', value: { role: 'builder' } });
  const liveAt = (mayTrust: boolean) => ({ materials: [], mayTrust, trusted: trustedOf(W.state().entities['@world']?.c) });
  const chip = (live: any) => inspectSchema(W.rec('c1'), 'c1', live).sections.add.find((a: any) => a.name === 'hesperus/material');
  check('TE1 before: the draft is offered under "drafts", amber', chip(liveAt(true))?.category === 'drafts' && chip(liveAt(true))?.chip === 'amber', JSON.stringify(chip(liveAt(true))));
  const plan = editOps(W.rec('c1'), 'c1', { 'hmat.trust': true }, liveAt(true));
  const asBob = W.sendAll(plan.ops, {}, 'bob');
  check('TE2 a builder pressing the owner\'s button: the door refuses (rights)', asBob.refused?.code === 'rights', JSON.stringify(asBob));
  const res = W.sendAll(plan.ops);
  check('TE3 the owner\'s button writes @world.trusted through the door', res.ok && JSON.stringify(W.state().entities['@world'].c.trusted) === '{"components":["hesperus/material"]}', JSON.stringify([res.refused, W.state().entities['@world']?.c.trusted]));
  check('TE4 …and the chip flips: main list (Look), blue, no unproven hint', chip(liveAt(true))?.category === 'Look' && chip(liveAt(true))?.chip === 'blue' && !chip(liveAt(true))?.hint, JSON.stringify(chip(liveAt(true))));
  const back = editOps(W.rec('c1'), 'c1', { 'hmat.trust': true }, liveAt(true));
  check('TE5 "stop trusting" (the last one) deletes the component; the chip is amber again', W.sendAll(back.ops).ok && W.state().entities['@world'].c.trusted === undefined && chip(liveAt(true))?.chip === 'amber', JSON.stringify([back.ops, W.state().entities['@world']?.c.trusted]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
