// component-needs-test — Add Component with needs, and Remove with dependants
// (design §3, step 3): shared/editschema.js addOps / removeOps / editOps
// and the Add Component list, through the real door (a scratch v4 world,
// tools/v4/scratchdoor.ts).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/component-needs-test.ts
//
// The needs today's records carry: Collider, Seats and Picture need a Model
// (placed from the Library — never in place, so it can only be explained);
// Reactions needs the WHOLE entity's Pendulum (what the door's `use` pushes):
// one sensible default when nothing moves it, a choice when a spin is in the way.
//
// v4 port (2026-10-06): ops are door requests; "folded" means "sent to the door and read back". v1's
// server/reactions.ts pendulumImpulse is replaced by the door's own `use {action: 'push'}`. Light-verb lights are gone.
import { inspectSchema, editOps, addOps, removeOps, needMet } from '../shared/editschema.js';
import { RECORDS, addable, componentsOf } from '../shared/components.js';
import { scratchWorld, flat } from './v4/scratchdoor.ts';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`); };
const J = JSON.stringify;
const LIB = 'eidoverse/assets/models/swing.glb';
const set = (comp: string, value: any) => ({ tool: 'set', args: { id: 's', component: comp, value } });
const del = (comp: string) => ({ tool: 'delete', args: { id: 's', component: comp } });
// through the door: the thing as `s` in a fresh world (hung from a frame, so a pendulum has something to swing from),
// the planned ops sent as ONE request; the world handle comes back for follow-ups
const door = (ent: any, ops: any[]) => {
  const W = scratchWorld('needs').seed({ frame: { lib: 'eidoverse/assets/models/frame.glb', pos: [0, 0, 0] } });
  W.call('create', { id: 'frame-top', model: 'crate', components: { transform: { pos: [0, 3, 0] } } });   // a measured box above it (the lab catalogue's crate)
  W.seed({ s: { ...ent, parent: { to: 'frame-top', offset: [0, -2.5, 0] } } });
  const res = W.sendAll(ops);
  return { W, res, after: W.rec('s') };
};
const addList = (ent: any) => inspectSchema(ent, 's').sections.add;

console.log('a need with one sensible default is added for you, as real door ops');
{
  const swing = { lib: LIB, pos: [0, 0, 0], yaw: 0, actor: 'o', ts: 1 };
  check('the record says it: Reactions needs Pendulum', J(RECORDS.Reactions.needs) === '["Pendulum"]');
  const r = addOps(swing, 's', 'Reactions');
  check('add.Reactions on a thing that does not move: a Pendulum at rest, then the reaction (the swing recipe)',
    r.ops.length === 2 && J(r.ops[0]) === J(set('motion', { type: 'pendulum', amp: 0, period: 3.5 })) && r.ops[1].tool === 'set' && r.ops[1].args.component === 'reactions' && !!r.ops[1].args.value?.push && r.errors.length === 0 && !r.choice, J(r));
  check('…and says what it brought', /Pendulum at rest/.test(r.brings ?? ''), J(r));
  const d = door(swing, r.ops);
  // KNOWN BUG (reported 2026-10-06, not fixed here): the recipe writes v1's handler {push: {impulse: 0.35}}; the v4
  // door's reactions take {<action>: {kind: 'toggle'|'set'|'impulse', …}} and refuse a handler with no kind
  // ("reactions.push: no handler kind 'undefined'"), so Add Component ▸ Reactions is refused in every v4 world.
  check('…the door takes the recipe as ONE request (KNOWN BUG: v1 handler shape refused)', d.res.ok, J(d.res.refused));
  check('…written: the thing now has both, and the need is met (rides on the KNOWN BUG above)', d.after.comp?.motion?.type === 'pendulum' && !!d.after.comp?.reactions?.push && needMet('Pendulum', d.after), J(d.after?.comp));
  const use = d.W.call('use', { id: 's', action: 'push' });
  check('…and a use pushes it: the door\'s push swings the pendulum (amp > 0) (rides on the KNOWN BUG above)', use.ok && d.W.rec('s').comp?.motion?.amp > 0, J([use.refused, d.W.rec('s')?.comp?.motion]));
  const e = editOps(swing, 's', { 'add.Reactions': null });
  check('editOps carries the same two ops (one call = one request = one undo step on every surface)', e.ops.length === 2 && !e.asks && J(e.ops) === J(r.ops), J(e));
  const entry = addList(swing).find((a: any) => a.name === 'Reactions');
  check('the Add Component entry is offered, not blocked, and says what it brings', !!entry && !entry.blocked && /Pendulum/.test(entry.brings ?? ''), J(entry));
  const pend = { ...swing, comp: { motion: { type: 'pendulum', amp: 0.2, period: 3, t0: 5 } } };
  const pr = addOps(pend, 's', 'Reactions');
  check('with a whole-entity pendulum already there, nothing extra is added (just the reaction)', pr.ops.length === 1 && pr.ops[0].args.component === 'reactions', J(pr));
  const partOnly = { ...swing, comp: { 'motion:seat': { type: 'pendulum', amp: 0.2 } } };
  check('a PART\'s pendulum does not meet it (reactions push the whole entity) — the default is added', addOps(partOnly, 's', 'Reactions').ops[0]?.args.component === 'motion');
}

console.log('a need that requires a choice asks, and sends nothing until answered');
{
  const spinner = { lib: LIB, pos: [0, 0, 0], yaw: 0, comp: { motion: { type: 'spin', degPerSec: 30, t0: 5 } }, actor: 'o', ts: 1 };
  const r = addOps(spinner, 's', 'Reactions');
  check('add.Reactions on a spinning thing: no ops, no error, a choice naming the need and the option',
    r.ops.length === 0 && r.errors.length === 0 && r.choice?.need === 'Pendulum' && r.choice.options.length === 1 && r.choice.options[0].v === 'replace' && /already moves as a whole \(spin\)/.test(r.choice.prompt), J(r));
  const e = editOps(spinner, 's', { 'add.Reactions': null });
  check('editOps returns it as an ask the panel renders (key, component, prompt, options)', e.ops.length === 0 && e.asks?.[0]?.kind === 'choice' && e.asks[0].key === 'add.Reactions' && e.asks[0].component === 'Reactions', J(e));
  const ans = editOps(spinner, 's', { 'add.Reactions': 'replace' });
  check('answering "replace": the pendulum replaces the spin, then the reaction — in one call', ans.ops.length === 2 && ans.ops[0].args.component === 'motion' && ans.ops[0].args.value.type === 'pendulum' && ans.ops[1].args.component === 'reactions', J(ans));
  check('…{choose: "replace"} answers the same way', addOps(spinner, 's', 'Reactions', { choose: 'replace' }).ops.length === 2);
  check('…a value that is not one of its options still asks', !!addOps(spinner, 's', 'Reactions', 'nope').choice);
  // the motion half alone (the need's own op) through the door: the spin is gone and the need met — this half doesn't
  // ride on the reactions handler shape (the KNOWN BUG above)
  const half = door(spinner, [ans.ops[0]]);
  check('…sent to the door, the spin is replaced by the pendulum and the need is met', half.res.ok && needMet('Pendulum', half.after) && half.after.comp?.motion?.type === 'pendulum' && half.after.comp.motion.degPerSec === undefined, J([half.res.refused, half.after?.comp]));
  const entry = addList(spinner).find((a: any) => a.name === 'Reactions');
  check('the Add Component entry is offered and marked as asking', !!entry && !entry.blocked && entry.asks === 'Pendulum', J(entry));
}

console.log('a need that cannot be met in place is explained (a Model comes from the Library)');
{
  const empty = { pos: [0, 0, 0], yaw: 0, actor: 'o', ts: 1 };
  for (const name of ['Collider', 'Sockets', 'Picture']) {
    const r = addOps(empty, 'pivot', name);
    check(`add.${name} on an Empty: nothing sent, a reason that names what to do`, r.ops.length === 0 && /needs a model/.test(r.errors[0] ?? '') && /Library/.test(r.errors[0] ?? '') && /pivot has none/.test(r.errors[0] ?? ''), J(r));
    const entry = addList(empty).find((a: any) => a.name === name);
    check(`…its Add Component entry is listed BLOCKED with that reason (blocked entries show why)`, !!entry && /needs a model/.test(entry.blocked ?? ''), J(entry));
  }
  const lamp = { pos: [0, 2, 0], comp: { light: { color: 1, intensity: 2, range: 3 } }, actor: 'o', ts: 1 };
  check('a lamp with no model has no model either', /needs a model/.test(addOps(lamp, 'L', 'Collider').errors[0] ?? ''));
  const col = addOps({ lib: LIB, pos: [0, 0, 0] }, 's', 'Collider');
  check('on a model the Model need is met: add.Collider just adds it', J(col.ops) === J([set('collider', { shape: 'exact' })]), J(col));
  const cd = door({ lib: LIB, pos: [0, 0, 0] }, col.ops);
  check('…and the door writes it', cd.res.ok && cd.after.comp?.collider?.shape === 'exact', J([cd.res.refused, cd.after?.comp]));
  check('addable() without {unmet} is unchanged (needs met only)', !addable(componentsOf(empty).components).some((a: any) => a.name === 'Collider') && addable(componentsOf(empty).components, { unmet: true }).find((a: any) => a.name === 'Collider')?.unmet?.[0] === 'Model');
}

console.log('removing something another component needs names the dependant and offers remove-both');
{
  // a v4 swing: its reactions are the door's own impulse handler (so the door holds what it removes)
  const swing = { lib: LIB, pos: [0, 0, 0], yaw: 0, comp: { motion: { type: 'pendulum', amp: 0, period: 3.5, t0: 5 }, reactions: { push: { kind: 'impulse', strength: 0.5 } } }, actor: 'o', ts: 1 };
  const r = removeOps(swing, 's', 'motion');
  check('remove.motion under a Reactions: nothing sent, a confirm naming Reactions', r.ops.length === 0 && r.errors.length === 0 && r.confirm?.dependants?.[0]?.type === 'Reactions' && /Reactions needs this Pendulum — remove both\?/.test(r.confirm.prompt), J(r));
  const e = editOps(swing, 's', { 'remove.motion': null });
  check('editOps returns it as a confirm ask', e.ops.length === 0 && e.asks?.[0]?.kind === 'confirm' && e.asks[0].key === 'remove.motion' && e.asks[0].both === 'both', J(e));
  const both = editOps(swing, 's', { 'remove.motion': 'both' });
  check('"both": the dependant goes first, then the pendulum — one call', J(both.ops) === J([del('reactions'), del('motion')]), J(both));
  const d = door(swing, both.ops);
  check('…sent to the door as one request, both are gone', d.res.ok && !d.after.comp?.motion && !d.after.comp?.reactions, J([d.res.refused, d.after?.comp]));
  const u = d.W.call('undo', {});
  check('…and the door\'s undo brings both back (one act)', u.ok && d.W.rec('s').comp?.motion?.type === 'pendulum' && d.W.rec('s').comp?.reactions?.push?.kind === 'impulse', J([u.refused, d.W.rec('s')?.comp]));
  check('removing the Reactions itself needs no confirm', J(removeOps(swing, 's', 'reactions').ops) === J([del('reactions')]));
  const parts = { ...swing, comp: { ...swing.comp, 'motion:seat': { type: 'pendulum', amp: 0.1 } } };
  check('removing a PART\'s pendulum is not something Reactions needs — no confirm', removeOps(parts, 's', 'motion:seat').ops.length === 1);
  const noPend = { ...swing, comp: { reactions: swing.comp.reactions, lock: true } };
  check('a need that was already unmet is not "broken" by an unrelated removal', removeOps(noPend, 's', 'lock').ops.length === 1);
  check('remove.motion on a thing without reactions: one delete motion', J(removeOps({ ...swing, comp: { motion: swing.comp.motion } }, 's', 'motion').ops) === J([del('motion')]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
