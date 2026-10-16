// component-needs-test — Add Component with needs, and Remove with dependants
// (design §3, step 3): shared/editschema.js addOps / removeOps / editOps
// and the Add Component list, through the real door (a scratch world,
// tools/protocol/scratchworld.ts).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/component-needs-test.ts
//
// The needs today's records carry: Collider and Seats need a Model (placed from the Library — never in place, so it can
// only be explained). Reactions needed the whole entity's Pendulum while its default was a push (the impulse handler);
// that kind is reserved since the shape audit (10-16), so Reactions is added empty and needs nothing, and the rows that
// rode on it (a need with a default, a need that asks) are retired with it: no record carries such a need now.
//
// the protocol port (2026-10-06): ops are door requests; "folded" means "sent to the door and read back". v1's
// server/reactions.ts pendulumImpulse is replaced by the door's own `use {action: 'push'}`. Light-verb lights are gone.
import { inspectSchema, editOps, addOps, removeOps, needMet } from '../shared/editschema.js';
import { RECORDS, addable, componentsOf } from '../shared/components.js';
import { scratchWorld, flat } from './protocol/scratchworld.ts';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`); };
const J = JSON.stringify;
const LIB = 'eidoverse/assets/models/swing.glb';
const set = (comp: string, value: any) => ({ verb: 'set', args: { id: 's', component: comp, value } });
const del = (comp: string) => ({ verb: 'delete', args: { id: 's', component: comp } });
// through the door: the thing as `s` in a fresh world (hung from a frame, so a pendulum has something to swing from),
// the planned ops sent as ONE request; the world handle comes back for follow-ups
const door = (ent: any, ops: any[]) => {
  const W = scratchWorld('needs').seed({ frame: { model: 'eidoverse/assets/models/frame.glb', pos: [0, 0, 0] } });
  W.call('create', { id: 'frame-top', model: 'crate', components: { transform: { pos: [0, 3, 0] } } });   // a measured box above it (the lab catalogue's crate)
  W.seed({ s: { ...ent, parent: { to: 'frame-top', offset: [0, -2.5, 0] } } });
  const res = W.sendAll(ops);
  return { W, res, after: W.rec('s') };
};
const addList = (ent: any) => inspectSchema(ent, 's').sections.add;

console.log('Reactions needs nothing (shape audit 10-16: its push default was the impulse handler, reserved now)');
{
  const swing = { model: LIB, pos: [0, 0, 0], yaw: 0, actor: 'o', ts: 1 };
  check('the record says it: Reactions needs nothing', !RECORDS.Reactions.needs?.length, J(RECORDS.Reactions.needs));
  const r = addOps(swing, 's', 'Reactions');
  check('add.Reactions writes one op: an empty reactions (its actions are written on its card)', r.ops.length === 1 && J(r.ops[0]) === J(set('reactions', {})) && !r.choice, J(r));
  const d = door(swing, r.ops);
  check('…and the door takes it', d.res.ok && J(d.after?.reactions) === '{}', J([d.res.refused, d.after?.reactions]));
}

console.log('a need that cannot be met in place is explained (a Model comes from the Library)');
{
  const empty = { pos: [0, 0, 0], yaw: 0, actor: 'o', ts: 1 };
  // batch 2 (R 10-07): a Picture needs no model any more (no part = a framed picture of its own), so it's offered on an Empty
  { const entry = addList(empty).find((a: any) => a.name === 'Picture');
    check('Picture is offered on an Empty (batch 2: a picture of its own needs no model), not blocked', !!entry && !entry.blocked, J(entry)); }
  for (const name of ['Collider', 'Sockets']) {
    const r = addOps(empty, 'pivot', name);
    check(`add.${name} on an Empty: nothing sent, a reason that names what to do`, r.ops.length === 0 && /needs a model/.test(r.errors[0] ?? '') && /Library/.test(r.errors[0] ?? '') && /pivot has none/.test(r.errors[0] ?? ''), J(r));
    const entry = addList(empty).find((a: any) => a.name === name);
    check(`…its Add Component entry is listed BLOCKED with that reason (blocked entries show why)`, !!entry && /needs a model/.test(entry.blocked ?? ''), J(entry));
  }
  const lamp = { pos: [0, 2, 0], light: { color: 1, intensity: 2, range: 3 }, actor: 'o', ts: 1 };
  check('a lamp with no model has no model either', /needs a model/.test(addOps(lamp, 'L', 'Collider').errors[0] ?? ''));
  const col = addOps({ model: LIB, pos: [0, 0, 0] }, 's', 'Collider');
  check('on a model the Model need is met: add.Collider just adds it', J(col.ops) === J([set('collider', { shape: 'exact' })]), J(col));
  const cd = door({ model: LIB, pos: [0, 0, 0] }, col.ops);
  check('…and the door writes it', cd.res.ok && cd.after?.collider?.shape === 'exact', J([cd.res.refused, cd.after?.comp]));
  check('addable() without {unmet} is unchanged (needs met only)', !addable(componentsOf(empty).components).some((a: any) => a.name === 'Collider') && addable(componentsOf(empty).components, { unmet: true }).find((a: any) => a.name === 'Collider')?.unmet?.[0] === 'Model');
}

console.log('removing something another component needs names the dependant and offers remove-both');
{
  // a model with a collider (Collider needs a Model): was a swing's pendulum under its push reaction (impulse, reserved since 10-16)
  const lamp = { model: LIB, pos: [0, 0, 0], yaw: 0, collider: { shape: 'box' }, actor: 'o', ts: 1 };
  const r = removeOps(lamp, 's', 'model');
  check('remove.model under a Collider: nothing sent, a confirm naming Collider', r.ops.length === 0 && r.errors.length === 0 && r.confirm?.dependants?.[0]?.type === 'Collider' && /Collider needs this/.test(r.confirm.prompt) && /remove both\?/.test(r.confirm.prompt), J(r));
  const e = editOps(lamp, 's', { 'remove.model': null });
  check('editOps returns it as a confirm ask', e.ops.length === 0 && e.asks?.[0]?.kind === 'confirm' && e.asks[0].key === 'remove.model' && e.asks[0].both === 'both', J(e));
  const both = editOps(lamp, 's', { 'remove.model': 'both' });
  check('"both": the dependant goes first, then the model — one call', J(both.ops) === J([del('collider'), del('model')]), J(both));
  const d = door(lamp, both.ops);
  check('…sent to the door as one request, both are gone', d.res.ok && !d.after?.model && !d.after?.collider, J([d.res.refused, d.after]));
  const u = d.W.call('undo', {});
  check('…and the door\'s undo brings both back (one act)', u.ok && d.W.rec('s')?.model === LIB && d.W.rec('s')?.collider?.shape === 'box', J([u.refused, d.W.rec('s')]));
  check('removing the Collider itself needs no confirm', J(removeOps(lamp, 's', 'collider').ops) === J([del('collider')]));
  check('a need that was already unmet is not "broken" by an unrelated removal', removeOps({ pos: [0, 0, 0], collider: { shape: 'box' }, lock: { rank: 'builder' } }, 's', 'lock').ops.length === 1);
  check('remove.model on a thing without a collider: one delete model', J(removeOps((({ collider: _c, ...rest }) => rest)(lamp), 's', 'model').ops) === J([del('model')]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
