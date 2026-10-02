// components-inspector-test — the inspector's component cards (schema.sections) over the real corpus.
//
// For every entity in every world the corpus test reads: one card per component,
// every address a card names resolves to a real schema field, no field is owned by
// two cards, and every editable field of the old groups is reachable from some card
// (a field nobody can reach is a field only a model can edit). Then add/remove
// lower to today's verbs.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/components-inspector-test.ts
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { emptyState, foldEntry } from '../shared/fold.js';
import { inspectSchema, fieldAt, editVerbs } from '../shared/editschema.js';
import { componentsOf } from '../shared/components.js';

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
for (const p of logs) {
  const st: any = emptyState();
  for (const line of readFileSync(p, 'utf8').split('\n')) { if (!line) continue; try { foldEntry(st, JSON.parse(line)); } catch { /* skip */ } }
  for (const [id, e] of Object.entries(st.entities ?? {})) ents.push([id, e]);
}
console.log(`${ents.length} final entities from ${logs.length} logs`);

const probs: string[] = [];
let cards = 0;
for (const [id, e] of ents) {
  const s = inspectSchema(e, id);
  const comps = componentsOf(e).components;
  cards += s.sections.list.length;
  const inHeader = comps.filter((c) => c.type === 'Label' || c.type === 'Hidden').length;
  if (s.sections.list.length !== comps.length - inHeader) probs.push(`${id}: ${comps.length} components (${inHeader} in the header), ${s.sections.list.length} cards`);
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
      || (a === 'flags.lock' && addable.has('Lock')) || (a === 'flags.guard' && addable.has('Guard'));
    if (!owned.has(a) && !replaced && !(g.group === 'comp' && owned.has(`comp.${f.k}`))) probs.push(`${id}: ${a} is in no card`);
  }
}
check(`every entity: a card per component (label and hidden in the header), every card field real, owned once, every field reachable (${cards} cards)`, probs.length === 0, '\n   ' + [...new Set(probs)].slice(0, 15).join('\n   '));

const crate = { lib: 'store/x.glb', pos: [0, 1, 0], comp: { motion: { type: 'pendulum', axis: 'z', amp: 0.24, period: 3.4, t0: 1 }, lock: true } };
const v = (set: Record<string, unknown>, e: any = crate) => editVerbs(e, 'c1', set);
check('add.Spin on a part → comp motion:<part>', JSON.stringify(v({ 'add.Spin': 'arm' }).verbs) === JSON.stringify([{ verb: 'comp', args: { id: 'c1', type: 'motion:arm', data: { type: 'spin', degPerSec: 36 } } }]));
check('add.Spin with a whole motion present → refused, says why', v({ 'add.Spin': '' }).verbs.length === 0 && /already moves as a whole/.test(v({ 'add.Spin': '' }).errors[0] ?? ''));
check('remove.motion → motion {type:null}', JSON.stringify(v({ 'remove.motion': null }).verbs) === JSON.stringify([{ verb: 'motion', args: { id: 'c1', type: null } }]));
check('remove.lock → comp lock null', JSON.stringify(v({ 'remove.lock': null }).verbs) === JSON.stringify([{ verb: 'comp', args: { id: 'c1', type: 'lock', data: null } }]));
// step 2 (design §6): a lamp is a Model with a Light component — no longer blocked
check('add.Light on a model → comp light with its fields spelled out (write-new-on-edit)', JSON.stringify(v({ 'add.Light': null }).verbs) === JSON.stringify([{ verb: 'comp', args: { id: 'c1', type: 'light', data: { color: 0xffd9a0, intensity: 16, range: 10 } } }]));
check('a held guard refuses add and remove', (() => { const g = { ...crate, comp: { ...crate.comp, guard: true }, placer: { id: 'someone' } }; const r = editVerbs(g, 'c1', { 'remove.lock': null }, { mayAuthor: false }); return r.verbs.length === 0 && /guarded/.test(r.errors[0] ?? ''); })());
check('Add Component lists blocked entries with a reason; Light and Collider are no longer among them', (() => { const s = inspectSchema(crate, 'c1'); const st = s.sections.add.find((a: any) => a.name === 'Structure'); const ok = (n: string) => s.sections.add.some((a: any) => a.name === n && !a.blocked); return !!st?.blocked && ok('Particles') && ok('Light') && ok('Collider'); })());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
