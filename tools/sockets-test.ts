// sockets-test — the attach-point component, through the inspector's planner and the real door (scratch v4 world).
// A socket is a named attachment point with a WHOLE rotation (Unreal sockets); with `body` a person attaches by using
// it (VRChat Station, Roblox Seat). usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/sockets-test.ts
import { inspectSchema, editOps } from '../shared/editschema.js';
import { bodyOf, socketQ } from '../shared/components.js';
import { localOf } from '../shared/hierarchy.js';
import { scratchWorld } from './v4/scratchdoor.ts';
import * as OP from '../shared/v4/ops.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: any = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail !== '' ? `  — ${JSON.stringify(detail).slice(0, 300)}` : ''}`); };
const near = (a: number[], b: number[], e = 1e-5) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < e);

// a rocket: a crate with one seat, built through the inspector the way a person would
const W = scratchWorld('sockets').seed({ rocket: { lib: 'crate', pos: [0, 0, 0] } });
const ent = () => W.rec('rocket');
const C = () => ent()?.comp ?? {};
const plan = (edits: Record<string, any>) => editOps(ent(), 'rocket', edits);
const send = (p: any) => W.sendAll(p.ops);

let r = send(plan({ 'sockets.seat|pos|1': 0.4 }));
check('a new socket slot from the inspector is a seat (a person attaches) and the door takes it', r.ok && !!bodyOf(C().sockets?.seat), [r.refused, C().sockets]);
check('…with no rotation stored (identity)', C().sockets.seat.q === undefined, C().sockets.seat);

// lie the seat on its back: pitch -90° (a rocket, a dentist's chair, a bunk)
r = send(plan({ 'sockets.seat|rot|0': -90 }));
const q = C().sockets.seat.q;
check('pitch -90 is stored as a quaternion and the door takes it', r.ok && Array.isArray(q) && near(q, [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]), [r.refused, q]);
const rows = inspectSchema(ent(), 'rocket').groups.find((g: any) => g.group === 'sockets')?.fields ?? [];
const val = (k: string) => rows.find((f: any) => f.k === k)?.value;
check('the inspector reads it back as heading 0, pitch -90°, roll 0', Math.abs(val('seat|rot|0') + Math.PI / 2) < 1e-6 && Math.abs(val('seat|rot|1')) < 1e-6 && Math.abs(val('seat|rot|2')) < 1e-6, rows.map((f: any) => [f.k, f.value]));
r = send(plan({ 'sockets.seat|rot|1': 90 }));
check('a heading edit on a tilted socket keeps the tilt (heading 90, pitch -90)', r.ok && (() => { const f = inspectSchema(ent(), 'rocket').groups.find((g: any) => g.group === 'sockets').fields;
  const v = (k: string) => f.find((x: any) => x.k === k).value; return Math.abs(v('seat|rot|1') - Math.PI / 2) < 1e-6 && Math.abs(v('seat|rot|0') + Math.PI / 2) < 1e-6; })(), C().sockets.seat);

// body: action and pose
r = send(plan({ 'sockets.seat|action': 'ride', 'sockets.seat|pose': 'lie' }));
check('action and pose: the body block, through the door', r.ok && bodyOf(C().sockets.seat)?.action === 'ride' && bodyOf(C().sockets.seat)?.pose === 'lie', [r.refused, C().sockets.seat]);
const use = W.call('use', { id: 'rocket', action: 'ride' });
check('…and a person uses it: the door attaches them there, in that pose (presence)', use.ok && use.attach?.slot === 'seat' && use.attach.pose === 'lie', use);
check('a bad action is refused by the planner with the door\'s words', plan({ 'sockets.seat|action': 'Blast Off' }).ops.length === 0);

// people off: an attachment point for things only
r = send(plan({ 'sockets.seat|body': false }));
check('people attach: off → no body; the thing offers nothing to use', r.ok && !C().sockets.seat.body && !(W.call('inspect', { id: 'rocket' }).actions ?? []).length, C().sockets.seat);

// a thing parented at the slot takes the socket's whole rotation as its local one
W.call('create', { id: 'flag', model: 'crate' });
W.sendAll([OP.parent(W.view(), 'flag', 'rocket', { slot: 'seat' })]);   // the planner: a slot gives the socket's pose
const world = W.view().entities;
const L = localOf(world.flag, world);
check('a thing attached at a tilted socket rides it with the socket\'s rotation', !!L?.q && near(L.q, [-0.5, 0.5, 0.5, 0.5], 1e-4)   /* heading 90 then pitch -90: qY(90)·qX(-90) */, L);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
