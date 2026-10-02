// component-needs-test — Add Component with needs, and Remove with dependants
// (design §3, step 3): shared/editschema.js addVerbs / removeVerbs / editVerbs
// and the Add Component list, through the real fold.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/component-needs-test.ts
//
// The needs today's records carry: Collider, Seats and Picture need a Model
// (placed from the Library — never in place, so it can only be explained);
// Reactions needs the WHOLE entity's Pendulum (what server/reactions.ts pushes):
// one sensible default when nothing moves it, a choice when a spin is in the way.
import { emptyState, foldEntry } from '../shared/fold.js';
import { inspectSchema, editVerbs, addVerbs, removeVerbs, needMet } from '../shared/editschema.js';
import { RECORDS, addable, componentsOf } from '../shared/components.js';
import { pendulumImpulse } from '../server/reactions.ts';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`); };
const J = JSON.stringify;
const LIB = 'eidoverse/assets/models/swing.glb';
const fold = (ent: any, verbs: any[]) => {
  const st: any = emptyState(); st.entities.s = JSON.parse(J(ent)); let n = 1;
  for (const v of verbs) foldEntry(st, { seq: n, ts: 1000 + n++, actor: 'o', verb: v.verb, args: v.args });
  return st.entities.s;
};
const addList = (ent: any) => inspectSchema(ent, 's').sections.add;

console.log('a need with one sensible default is added for you, as real verbs');
{
  const swing = { lib: LIB, pos: [0, 0, 0], yaw: 0, actor: 'o', ts: 1 };
  check('the record says it: Reactions needs Pendulum', J(RECORDS.Reactions.needs) === '["Pendulum"]');
  const r = addVerbs(swing, 's', 'Reactions');
  check('add.Reactions on a thing that does not move: a Pendulum at rest, then the reaction (the swing recipe)',
    J(r.verbs) === J([{ verb: 'motion', args: { id: 's', type: 'pendulum', amp: 0, period: 3.5 } }, { verb: 'comp', args: { id: 's', type: 'reactions', data: { push: { impulse: 0.35 } } } }]) && r.errors.length === 0 && !r.choice, J(r));
  check('…and says what it brought', /Pendulum at rest/.test(r.brings ?? ''), J(r));
  const after = fold(swing, r.verbs);
  check('…folded: the thing now has both, and the need is met', after.comp?.motion?.type === 'pendulum' && after.comp?.reactions?.push?.impulse === 0.35 && needMet('Pendulum', after));
  check('…and a use would push it (the server\'s impulse math accepts the folded pendulum)', !!after.comp?.motion && pendulumImpulse(after.comp.motion, 0.35, 2000).type === 'pendulum');
  const e = editVerbs(swing, 's', { 'add.Reactions': null });
  check('editVerbs carries the same two verbs (one call = one undo step on every surface)', e.verbs.length === 2 && !e.asks, J(e));
  const entry = addList(swing).find((a: any) => a.name === 'Reactions');
  check('the Add Component entry is offered, not blocked, and says what it brings', !!entry && !entry.blocked && /Pendulum/.test(entry.brings ?? ''), J(entry));
  const pend = { ...swing, comp: { motion: { type: 'pendulum', amp: 0.2, period: 3, t0: 5 } } };
  check('with a whole-entity pendulum already there, nothing extra is added', J(addVerbs(pend, 's', 'Reactions').verbs) === J([{ verb: 'comp', args: { id: 's', type: 'reactions', data: { push: { impulse: 0.35 } } } }]));
  const partOnly = { ...swing, comp: { 'motion:seat': { type: 'pendulum', amp: 0.2 } } };
  check('a PART\'s pendulum does not meet it (reactions push the whole entity) — the default is added', addVerbs(partOnly, 's', 'Reactions').verbs[0]?.verb === 'motion');
}

console.log('a need that requires a choice asks, and sends nothing until answered');
{
  const spinner = { lib: LIB, pos: [0, 0, 0], yaw: 0, comp: { motion: { type: 'spin', degPerSec: 30, t0: 5 } }, actor: 'o', ts: 1 };
  const r = addVerbs(spinner, 's', 'Reactions');
  check('add.Reactions on a spinning thing: no verbs, no error, a choice naming the need and the option',
    r.verbs.length === 0 && r.errors.length === 0 && r.choice?.need === 'Pendulum' && r.choice.options.length === 1 && r.choice.options[0].v === 'replace' && /already moves as a whole \(spin\)/.test(r.choice.prompt), J(r));
  const e = editVerbs(spinner, 's', { 'add.Reactions': null });
  check('editVerbs returns it as an ask the panel renders (key, component, prompt, options)', e.verbs.length === 0 && e.asks?.[0]?.kind === 'choice' && e.asks[0].key === 'add.Reactions' && e.asks[0].component === 'Reactions', J(e));
  const ans = editVerbs(spinner, 's', { 'add.Reactions': 'replace' });
  check('answering "replace": the pendulum replaces the spin, then the reaction — in one call', ans.verbs.length === 2 && ans.verbs[0].verb === 'motion' && ans.verbs[0].args.type === 'pendulum' && ans.verbs[1].args.type === 'reactions', J(ans));
  check('…{choose: "replace"} answers the same way', addVerbs(spinner, 's', 'Reactions', { choose: 'replace' }).verbs.length === 2);
  check('…a value that is not one of its options still asks', !!addVerbs(spinner, 's', 'Reactions', 'nope').choice);
  check('…and folded, the spin is gone and the need met', needMet('Pendulum', fold(spinner, ans.verbs)) && fold(spinner, ans.verbs).comp?.motion?.type === 'pendulum');
  const entry = addList(spinner).find((a: any) => a.name === 'Reactions');
  check('the Add Component entry is offered and marked as asking', !!entry && !entry.blocked && entry.asks === 'Pendulum', J(entry));
}

console.log('a need that cannot be met in place is explained (a Model comes from the Library)');
{
  const empty = { pos: [0, 0, 0], yaw: 0, actor: 'o', ts: 1 };
  for (const name of ['Collider', 'Seats', 'Picture']) {
    const r = addVerbs(empty, 'pivot', name);
    check(`add.${name} on an Empty: nothing sent, a reason that names what to do`, r.verbs.length === 0 && /needs a model/.test(r.errors[0] ?? '') && /Library/.test(r.errors[0] ?? '') && /pivot has none/.test(r.errors[0] ?? ''), J(r));
    const entry = addList(empty).find((a: any) => a.name === name);
    check(`…its Add Component entry is listed BLOCKED with that reason (blocked entries show why)`, !!entry && /needs a model/.test(entry.blocked ?? ''), J(entry));
  }
  const light = { kind: 'light', pos: [0, 2, 0], color: 1, intensity: 2, range: 3, actor: 'o', ts: 1 };
  check('a light-verb light has no model either', /needs a model/.test(addVerbs(light, 'L', 'Collider').errors[0] ?? ''));
  check('on a model the Model need is met: add.Collider just adds it', J(addVerbs({ lib: LIB, pos: [0, 0, 0] }, 's', 'Collider').verbs) === J([{ verb: 'comp', args: { id: 's', type: 'collider', data: { shape: 'exact' } } }]));
  check('addable() without {unmet} is unchanged (needs met only)', !addable(componentsOf(empty).components).some((a: any) => a.name === 'Collider') && addable(componentsOf(empty).components, { unmet: true }).find((a: any) => a.name === 'Collider')?.unmet?.[0] === 'Model');
}

console.log('removing something another component needs names the dependant and offers remove-both');
{
  const swing = { lib: LIB, pos: [0, 0, 0], yaw: 0, comp: { motion: { type: 'pendulum', amp: 0, period: 3.5, t0: 5 }, reactions: { push: { impulse: 0.35 } } }, actor: 'o', ts: 1 };
  const r = removeVerbs(swing, 's', 'motion');
  check('remove.motion under a Reactions: nothing sent, a confirm naming Reactions', r.verbs.length === 0 && r.errors.length === 0 && r.confirm?.dependants?.[0]?.type === 'Reactions' && /Reactions needs this Pendulum — remove both\?/.test(r.confirm.prompt), J(r));
  const e = editVerbs(swing, 's', { 'remove.motion': null });
  check('editVerbs returns it as a confirm ask', e.verbs.length === 0 && e.asks?.[0]?.kind === 'confirm' && e.asks[0].key === 'remove.motion' && e.asks[0].both === 'both', J(e));
  const both = editVerbs(swing, 's', { 'remove.motion': 'both' });
  check('"both": the dependant goes first, then the pendulum — one call', J(both.verbs) === J([{ verb: 'comp', args: { id: 's', type: 'reactions', data: null } }, { verb: 'motion', args: { id: 's', type: null } }]), J(both));
  const after = fold(swing, both.verbs);
  check('…folded, both are gone', !after.comp?.motion && !after.comp?.reactions);
  check('removing the Reactions itself needs no confirm', J(removeVerbs(swing, 's', 'reactions').verbs) === J([{ verb: 'comp', args: { id: 's', type: 'reactions', data: null } }]));
  const parts = { ...swing, comp: { ...swing.comp, 'motion:seat': { type: 'pendulum', amp: 0.1 } } };
  check('removing a PART\'s pendulum is not something Reactions needs — no confirm', removeVerbs(parts, 's', 'motion:seat').verbs.length === 1);
  const noPend = { ...swing, comp: { reactions: { push: { impulse: 0.3 } }, lock: true } };
  check('a need that was already unmet is not "broken" by an unrelated removal', removeVerbs(noPend, 's', 'lock').verbs.length === 1);
  check('the old remove.lock / remove.motion on a thing without reactions are unchanged', J(removeVerbs({ ...swing, comp: { motion: swing.comp.motion } }, 's', 'motion').verbs) === J([{ verb: 'motion', args: { id: 's', type: null } }]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
