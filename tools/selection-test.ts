// selection-test — the ONE selection store (client/lib/edit/selection.js) and the listener that
// depends on it. Headless: no three, no DOM.
//
// Pins (C6, PLAN-refactor-2026-10-12): set/extend/toggle/clear semantics; primary = first id;
// exactly one 'selection' bus event per change and none for a no-op; the old `extending` flag's
// contract ("un-primary promotes the next and the set survives") as "toggle(primary) emits once";
// and structure_ui follows 'selection', not the retired 'sg:selected' (the mutation: emit
// 'sg:selected' alone and the building must NOT change).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/selection-test.ts
import { fileURLToPath } from "node:url";
import { plugin } from 'bun';
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
plugin({ name: 'selection-test-stubs', setup(b) {
  for (const m of ['core', 'editwrites', 'ui'])
    b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: here('./selection-test-stub.mjs') }));
  b.onResolve({ filter: /^\.\/realize\/structure\.js$/ }, () => ({ path: here('./selection-test-stub.mjs') }));
} });

import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();   // structure_ui's init adds window listeners

const { bus } = await import('../client/lib/base.js');
const Sel = await import('../client/lib/edit/selection.js');
const { state } = await import('../client/lib/state.js');
const SU = await import('../client/lib/structure_ui.js');

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const J = (v: unknown) => JSON.stringify(v);

const events: any[] = [];
bus.on('selection', (s: any) => events.push(J(s)));
const drain = () => events.splice(0);

console.log('SELECTION — one store, one event');

Sel.clear();
drain();
check('empty: ids [] and kind null', J(Sel.selection()) === J({ ids: [], kind: null }), J(Sel.selection()));
check('empty: primary null', Sel.primary() === null);
Sel.clear();
check('clear on empty emits nothing', drain().length === 0);

Sel.set(['a']);
check("set(['a']) → ids ['a'], kind 'things'", J(Sel.selection()) === J({ ids: ['a'], kind: 'things' }), J(Sel.selection()));
check('set emits exactly once, with the new selection', J(drain()) === J([J({ ids: ['a'], kind: 'things' })]));
Sel.set(['a']);
check('set to the same selection emits nothing', drain().length === 0);
check('the returned selection is a copy', (() => { const s = Sel.selection(); s.ids.push('zzz'); return Sel.primary() === 'a' && Sel.selection().ids.length === 1; })());

Sel.set(['b', 'c', 'b', 'c']);
check('set dedupes and keeps order', J(Sel.selection().ids) === J(['b', 'c']), J(Sel.selection().ids));
check('primary = first id', Sel.primary() === 'b');
check('one event', drain().length === 1);

Sel.extend(['c', 'd', 'e']);
check('extend adds the missing ids after the primary, never reorders', J(Sel.selection().ids) === J(['b', 'c', 'd', 'e']), J(Sel.selection().ids));
check('extend emits once', drain().length === 1);
Sel.extend(['c']);
check('extend with nothing new emits nothing', drain().length === 0);
Sel.extend('f');
check('extend takes a single id too', J(Sel.selection().ids) === J(['b', 'c', 'd', 'e', 'f']) && drain().length === 1);

Sel.toggle('d');
check('toggle removes a present non-primary', J(Sel.selection().ids) === J(['b', 'c', 'e', 'f']), J(Sel.selection().ids));
check('toggle emits once', drain().length === 1);
Sel.toggle('g');
check('toggle adds an absent id at the end', J(Sel.selection().ids) === J(['b', 'c', 'e', 'f', 'g']) && drain().length === 1, J(Sel.selection().ids));
Sel.toggle('b');
check("toggle(primary) promotes the next id and KEEPS the rest (the old `extending` contract)", J(Sel.selection().ids) === J(['c', 'e', 'f', 'g']), J(Sel.selection().ids));
check('…in ONE event (the old path emitted sg:selected mid-promotion and relied on a flag to survive it)', drain().length === 1);
check('primary moved', Sel.primary() === 'c');

Sel.clear();
check('clear → empty, kind null', J(Sel.selection()) === J({ ids: [], kind: null }));
check('clear emits once', drain().length === 1);
Sel.toggle('h');
check('toggle on empty selects it (primary)', Sel.primary() === 'h' && Sel.selection().kind === 'things' && drain().length === 1);
Sel.toggle('h');
check('toggle the only id → empty', Sel.selection().ids.length === 0 && Sel.selection().kind === null && drain().length === 1);
Sel.extend(['i', 'j']);
check('extend on empty: first becomes primary', Sel.primary() === 'i' && J(Sel.selection().ids) === J(['i', 'j']) && drain().length === 1);

Sel.set(['@world'], 'world');
check("set with a kind: {ids:['@world'], kind:'world'}", J(Sel.selection()) === J({ ids: ['@world'], kind: 'world' }), J(Sel.selection()));
check('one event', drain().length === 1);
Sel.set(['@world'], 'env:sky');
check('same ids, new kind: a change (one event)', Sel.selection().kind === 'env:sky' && drain().length === 1);
Sel.set([]);
check('set([]) clears (kind null), one event', J(Sel.selection()) === J({ ids: [], kind: null }) && drain().length === 1);
Sel.set(['x'], 'things'); drain();
check('isSelected', Sel.isSelected('x') && !Sel.isSelected('y'));

// ---- the ACTIVE id (R, gym 10-17 20:39): the last one clicked, which the multi-selection Inspector names. It is NOT
// the primary (the first, which the gizmo and every single-thing tool keep); it is only ever one of the ids.
console.log('ACTIVE — the last one clicked');
Sel.set(['a1']); drain();
check('one selected: it is the active one', Sel.active() === 'a1');
Sel.toggle('a2');
check('a Ctrl-click adds it AND makes it active; the primary stays the first', Sel.active() === 'a2' && Sel.primary() === 'a1', J({ a: Sel.active(), p: Sel.primary() }));
Sel.toggle('a3');
check('…again: the newest is active', Sel.active() === 'a3' && J(Sel.selection().ids) === J(['a1', 'a2', 'a3']));
Sel.toggle('a3');
check('dropping the active one falls back to the primary (never an id no longer selected)', Sel.active() === 'a1' && !Sel.isSelected('a3'), String(Sel.active()));
Sel.extend(['a4']);
check('a box select (extend) leaves the active one alone', Sel.active() === 'a1', String(Sel.active()));
drain();
Sel.set(['r1', 'r2', 'r3'], 'things', 'r3');
check("set(list, kind, active): a Shift range names the row clicked as active, the anchor stays primary", Sel.active() === 'r3' && Sel.primary() === 'r1' && drain().length === 1, String(Sel.active()));
Sel.set(['r1', 'r2', 'r3'], 'things', 'r2');
check('same ids, a new active one: a change (one event, so the Inspector repaints)', Sel.active() === 'r2' && drain().length === 1);
Sel.set(['r1', 'r2', 'r3'], 'things', 'r2');
check('…and the same again is a no-op (no event)', drain().length === 0);
Sel.set(['r1', 'r2'], 'things', 'zz');
check('an active id that is not in the list is ignored (the primary stands in)', Sel.active() === 'r1');
Sel.clear();
check('empty: active null', Sel.active() === null);
drain();

// ---- a listener's view: the payload is the state at emit time, and reading the store inside agrees
{
  let seen: any = null; let agreed = false;
  const off = bus.on('selection', (s: any) => { seen = J(s); agreed = J(Sel.selection()) === J(s); });
  Sel.set(['p', 'q']);
  check('listener gets {ids, kind} and the store already holds it', seen === J({ ids: ['p', 'q'], kind: 'things' }) && agreed, seen);
  off();
  drain();
}

// ---- structure_ui follows 'selection' — and ONLY it
console.log('STRUCTURE_UI — the tools edit the selected building');
state.st.entities = {
  b1: { pos: [0, 0, 0], comp: { structure: { tile: 1, levels: [{ y: 0, tiles: [[0, 0]] }] } } },
  b2: { pos: [20, 0, 0], comp: { structure: { tile: 1, levels: [{ y: 0, tiles: [[0, 0]] }] } } },
  crate: { pos: [5, 0, 5], comp: {} },
};
SU.initStructureUI();
Sel.set(['b1']);
check("set(['b1']) → structure_ui's building is b1", SU.structureSelection() === 'b1', String(SU.structureSelection()));
Sel.set(['b2', 'b1']);
check('the PRIMARY is the building (b2)', SU.structureSelection() === 'b2', String(SU.structureSelection()));
bus.emit('sg:selected', 'b1');
check("MUTATION: 'sg:selected' alone moves nothing (structure_ui no longer listens to it)", SU.structureSelection() === 'b2', String(SU.structureSelection()));
Sel.set(['@world'], 'world');
check('a world selection is no building', SU.structureSelection() === null, String(SU.structureSelection()));
Sel.set(['crate']);
check('a thing that is not a building: selectedId follows (target() decides it is not a building)', SU.structureSelection() === 'crate');
Sel.clear();
check('clear → null', SU.structureSelection() === null);
drain();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
