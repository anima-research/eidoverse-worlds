// sockets-test — the attach-point component, through the inspector's planner and the real door (scratch world).
// A socket is a named attachment point with a WHOLE rotation (Unreal sockets); with a `station` beside it a person
// attaches by using it (VRChat Station, Roblox Seat). A socket is a child entity of its host, edited as itself (its
// transform, its socket, its station). usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/sockets-test.ts
import "./protocol/fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import { inspectSchema, editOps } from '../shared/editschema.js';
import { bodyOf, socketQ } from '../shared/components.js';
import { localOf, kindHint } from '../shared/hierarchy.js';
import { scratchWorld } from './protocol/scratchworld.ts';
import * as OP from '../shared/requests.js';
import { checkStation, evalPose, choosePose, mayLeave, reachWins, describeBody, NEAR_M, resolveSeat, socketsIn } from '../shared/sockbody.js';
import { socketSignals, cycleOf, travelOf } from '../client/lib/socksignals.js';
import { opsOf } from '../shared/protocol/fold.js';
import { worldPose } from '../shared/protocol/simlayer.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: any = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail !== '' ? `  — ${JSON.stringify(detail).slice(0, 300)}` : ''}`); };
const near = (a: number[], b: number[], e = 1e-5) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < e);

// a rocket: a crate with one seat, built through the inspector the way a person would
const W = scratchWorld('sockets').seed({ rocket: { model: 'crate', pos: [0, 0, 0] } });
const ent = () => W.rec('rocket');
const live = () => ({ world: W.view().entities });
const send = (p: any) => W.sendAll(p.ops);
// a seat is a socket child with a station (the '+ socket' gesture sends this create); then it is edited as itself
const sid = () => socketsIn(W.view().entities, 'rocket').find((x: any) => x.name === 'seat')?.id;
const kc = () => W.state().entities[sid()]?.c ?? {};
const plan = (edits: Record<string, any>) => editOps(W.rec(sid()), sid(), edits, live());

let r: any;
try {
r = W.sendAll([OP.addSocket('rocket', { name: 'seat' }, { pos: [0, 0.4, 0], station: {} })]);
check('a socket child with a station is a seat (a person attaches) and the door takes it', r.ok && !!sid() && !!bodyOf(kc().station), [r.refused, kc()]);
check('…with no rotation (identity)', JSON.stringify(kc().transform?.q) === '[0,0,0,1]', kc());
const rows = () => inspectSchema(W.rec('rocket'), 'rocket', live()).groups.find((g: any) => g.group === 'sockets')?.fields ?? [];
check('the host\'s Sockets card lists it by its id and name', JSON.stringify(rows().find((f: any) => f.k === 'slots')?.rows.map((x: any) => [x.id, x.label])) === JSON.stringify([[sid(), 'seat']]), rows());

// lie the seat on its back: pitch -90° (a rocket, a dentist's chair, a bunk), on the child's own rot channel
r = send(plan({ 'rot.x': -90 }));
const q = kc().transform.q;
check('pitch -90 is stored as the child\'s quaternion and the door takes it', r.ok && Array.isArray(q) && near(q, [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]), [r.refused, q]);
r = send(plan({ 'pos.yaw': 90 }));
check('a heading edit on a tilted socket keeps the tilt (heading 90, pitch -90)', r.ok && near(kc().transform.q, [-0.5, 0.5, 0.5, 0.5], 1e-6), kc().transform);

// its station: action and anim
r = send(plan({ 'comp.station': JSON.stringify({ action: 'ride', anim: 'lie' }) }));
check('action and anim: the child\'s station, through the door', r.ok && kc().station?.action === 'ride' && kc().station?.anim === 'lie', [r.refused, kc().station]);
const use = W.call('use', { id: 'rocket', action: 'ride' });
check('…and a person uses it: the door attaches them there, in that pose (presence)', use.ok && use.attach?.socket === 'seat' && use.attach.pose === 'lie', use);
check('a bad action is refused by the door', W.sendAll(plan({ 'comp.station': JSON.stringify({ action: 'Blast Off' }) }).ops).refused?.code === 'shape');

// people off: an attachment point for things only
r = send(plan({ 'comp.station': '' }));
check('people attach: off → no station; the thing offers nothing to use', r.ok && !kc().station && !(W.call('inspect', { id: 'rocket' }).actions ?? []).length, kc());

// a thing parented at the slot rides the socket child, landing on it: identity under the socket, so its world rotation is
// the socket's whole rotation
W.call('create', { id: 'flag', model: 'crate' });
r = W.sendAll([OP.parent(W.view(), 'flag', 'rocket', { socket: 'seat' })]);   // the planner: a socket names the socket child
const world = W.view().entities;
const seatKid = sid();
const L = localOf(world.flag, world);
check('requests.parent with a socket lands at the socket: parent {to: <the socket child>}, identity local pose', r.ok && !!seatKid && world.flag.parent?.to === seatKid && near(L.pos, [0, 0, 0]) && near(L.q ?? [0, 0, 0, 1], [0, 0, 0, 1]), [r.refused, world.flag.parent, L]);
const fq = worldPose(W.state(), 'flag').q;
check('a thing attached at a tilted socket rides it with the socket\'s rotation', near(fq, [-0.5, 0.5, 0.5, 0.5], 1e-4) || near(fq, [0.5, -0.5, -0.5, -0.5], 1e-4)   /* heading 90 then pitch -90: qY(90)·qX(-90) */, fq);

} catch (e) { check('the Inspector\'s socket section ran to its end', false, String(e)); }

// ===================================================================== the station (shared/sockbody.js checkStation)
// its core, closed; the researched keys are reserved (held for later); the door refuses with these words
const sk = (st: any) => checkStation(st);
const code = (st: any) => sk(st)?.code ?? 'ok';
const FULL = { action: 'drive', anchor: 'hips', pose: { by: 'speed', clips: [[0, 'idle'], [2, 'walk'], [6, 'run']] },
  poses: { lean: 'sitting_nervous_arm_rub_chair', pump: { clip: 'walk', time: 'phase' } }, sync: 'sofa', approach: [0.8, 0, 0, Math.PI / 2],
  enter: 'stand_to_sit', leave: 'sit_to_stand', exit: [0.9, 0, 0, 1.57],
  reach: { leftHand: { at: [-0.2, 0.9, 0.4], q: [0, 0, 0, 1], part: 'wheel', hint: [-0.5, 0.6, 0], vr: 'near' }, rightFoot: { at: [0.1, 0.1, 0.5] } },
  hold: { spine: [0, 0, 0.0871557, 0.9961947] }, look: { yaw: [-100, 100], pitch: [-40, 60], up: 'socket' }, input: { move: 'drive', look: 'aim' },
  leaveBy: 'jump', fromSeat: true, who: 'builder' };
const { pose: _fp, ...FULL_REST } = FULL; const FULL_ST = { ...FULL_REST, anim: FULL.pose };   // the research shape, as a station
check('the full research shape is reserved at the station', code(FULL_ST) === 'reserved', sk(FULL_ST));
check('a two-signal blend and a param signal are taken as its anim', sk({ anim: { by: ['steer', 'throttle'], clips: [[[-1, 0], 'idle'], [[0, 0], 'sitchair'], [[1, 0], 'sit']] } }) === null
  && sk({ anim: { by: 'param.lean', clips: [[0, 'sitchair'], [1, 'sit']] } }) === null);
const dym = (st: any) => sk(st)?.didYouMean?.[0];
check('closed keys: an unknown station key is refused (schema), with a did-you-mean', code({ ancor: 'hips' }) === 'schema' && dym({ ancor: 'hips' }) === 'anchor', sk({ ancor: 'hips' }));
check('closed keys: …in an anim, in input', code({ anim: { clip: 'sit', speed: 2 } }) === 'schema' && code({ action: 'drive', input: { move: 'drive', fly: true } }) === 'shape');
check('enums: anchor, leaveBy', ['anchor', 'leaveBy'].every((k) => code({ [k]: 'nope' }) === 'shape'));
check('clip names are strings of the library\'s spelling (anim, blend rows)', code({ anim: 7 }) === 'shape' && code({ anim: { by: 'speed', clips: [[0, 'idle'], [1, 3]] } }) === 'shape');
check('the bone overrides (hold) are cut: an unknown key', code({ hold: { spine: [0, 0, 0, 1] } }) === 'schema');
check('a blend: a closed set of signals, 2+ rows, keys rising', code({ anim: { by: 'mood', clips: [[0, 'idle'], [1, 'walk']] } }) === 'shape'
  && code({ anim: { by: 'speed', clips: [[0, 'idle']] } }) === 'shape' && code({ anim: { by: 'speed', clips: [[2, 'idle'], [1, 'walk']] } }) === 'shape'
  && code({ anim: { clip: 'sit', by: 'speed', clips: [[0, 'idle'], [1, 'walk']] } }) === 'shape' && code({ anim: { by: 'param.Bad-Name', clips: [[0, 'idle'], [1, 'walk']] } }) === 'shape');
check('exit is [x, y, z] or with a yaw', code({ exit: [0, 0] }) === 'shape' && code({ exit: [1, 0, 0] }) === 'ok');

// reading: defaults by action
const B = (body: any) => bodyOf(body);   // a station (or a legacy body block: the same shape), read generously
check('defaults: a seat holds sitchair, a standing place idle, and both put the ROOT on the socket (where every seat put a body before anchors: no existing seat moves)',
  B({}).anchor === 'root' && B({}).clip === 'sitchair' && B({ action: 'stand' }).anchor === 'root' && B({ action: 'stand' }).clip === 'idle' && B({ action: 'ride' }).anchor === 'root');
check('defaults: leave any way, the input is yours, the horizon level', B({}).leaveBy === 'any' && B({}).input.move === 'none' && B({}).input.look === 'free' && B({}).look.up === 'world' && B({}).reach && !Object.keys(B({}).reach).length);
check('a reach reads its vr policy as snap when unsaid', B({ reach: { leftHand: { at: [0, 1, 0] } } }).reach.leftHand.vr === 'snap');

// evaluation: 1-D blend, 2-D blend, phase, offset
const near1 = (a: number, b: number, e = 1e-6) => Math.abs(a - b) < e;
const w = (ev: any, c: string) => ev.clips.find((x: any) => x[0] === c)?.[1] ?? 0;
const SPD = { by: 'speed', clips: [[0, 'idle'], [2, 'walk'], [6, 'run']] };
let ev = evalPose(SPD, { speed: 1 });
check('a 1-D blend at speed 1 is half idle, half walk', near1(w(ev, 'idle'), 0.5) && near1(w(ev, 'walk'), 0.5) && ev.clips.length === 2, ev);
ev = evalPose(SPD, { speed: 5 });
check('…at speed 5, a quarter walk and three quarters run', near1(w(ev, 'walk'), 0.25) && near1(w(ev, 'run'), 0.75), ev);
check('…beyond its ends it holds the end clips', w(evalPose(SPD, { speed: -3 }), 'idle') === 1 && w(evalPose(SPD, { speed: 40 }), 'run') === 1);
const TWO = { by: ['steer', 'throttle'], clips: [[[-1, 0], 'lean_l'], [[0, 0], 'mid'], [[1, 0], 'lean_r']] };
ev = evalPose(TWO, { steer: 1, throttle: 0 });
check('a 2-D blend: an exact hit takes that clip whole', w(ev, 'lean_r') === 1 && ev.clips.length === 1, ev);
ev = evalPose(TWO, { steer: 0.5, throttle: 0 });
check('…between, inverse squared distance (mid and right equal, left a ninth of each), summing to 1', near1(w(ev, 'mid'), w(ev, 'lean_r')) && near1(w(ev, 'lean_l') * 9, w(ev, 'mid'))
  && near1(ev.clips.reduce((a: number, c: any) => a + c[1], 0), 1), ev);
check('a param signal drives a blend', w(evalPose({ by: 'param.lean', clips: [[0, 'a'], [1, 'b']] }, { 'param.lean': 0.75 }), 'b') === 0.75);
check('time: phase and an offset are carried', evalPose({ clip: 'swing_pump', time: 'phase', offset: [0, 0.1, 0] }, {}).time === 'phase' && evalPose({ clip: 'x', time: 'phase', offset: [0, 0.1, 0] }, {}).offset?.[1] === 0.1);

// the pose menu and sync groups
const sofa = B({ poses: { lean: 'a', cross: 'b' }, sync: 'sofa' });
check('the menu: the latest choice this socket offers wins; an unknown one is ignored', choosePose(sofa, [{ name: 'lean', at: 5 }, { name: 'cross', at: 9 }, { name: 'nap', at: 99 }]).name === 'cross'
  && choosePose(sofa, []).spec === sofa.pose);

// leaving
const LV = (leaveBy: any, move = 'none') => B({ ...(leaveBy ? { leaveBy } : {}), input: { move } });
check('leaveBy absent: moving, jumping and getting up all leave', ['move', 'jump', 'menu'].every((k) => mayLeave(LV(null), k as any)));
check('leaveBy jump: jump and getting up leave; moving does not', mayLeave(LV('jump'), 'jump') && mayLeave(LV('jump'), 'menu') && !mayLeave(LV('jump'), 'move'));
check('leaveBy menu: only getting up', mayLeave(LV('menu'), 'menu') && !mayLeave(LV('menu'), 'jump') && !mayLeave(LV('menu'), 'move'));
check('leaveBy script: nothing the occupant does; the world (a script) does', !['move', 'jump', 'menu'].some((k) => mayLeave(LV('script'), k as any)) && mayLeave(LV('script'), 'script'));
check('a seat that takes the movement keys (drive) never reads them as getting off', !mayLeave(LV(null, 'drive'), 'move') && mayLeave(LV(null, 'drive'), 'jump'));

// the VR hand policy
check('vr: snap always takes the hand; track never while tracked; near within ' + NEAR_M + ' m; an untracked hand always goes to the target',
  reachWins('snap', [0, 0, 0], [1, 1, 1]) && !reachWins('track', [0, 0, 0], [0, 0, 0]) && reachWins('near', [0, 0, 0.1], [0, 0, 0]) && !reachWins('near', [0, 0, 0.3], [0, 0, 0]) && reachWins('track', null, [0, 0, 0]));

// signals, closed forms
const pend = { type: 'pendulum', amp: 0.5, period: 2, phase: 0, t0: 0 };
let c = cycleOf(pend, 500);
check('pendulum: a quarter period in, phase 0.25 and swing 0 (θ crosses zero)', near1(c.phase, 0.25) && Math.abs(c.swing) < 1e-9, c);
c = cycleOf(pend, 1000);
check('…half a period in, phase 0.5 and swing -1 (the far end)', near1(c.phase, 0.5) && near1(c.swing, -1), c);
check('…damping shrinks swing with time', near1(cycleOf({ ...pend, damp: 0.5 }, 2000).swing, Math.exp(-1)));
check('spin: phase is the turn fraction', near1(cycleOf({ type: 'spin', degPerSec: 90, t0: 0 }, 1000).phase, 0.25));
// a swing at rest doesn't pump: amp 0, or damped out, holds its phase and reads swing 0 (the same on every client)
const still0 = cycleOf({ ...pend, amp: 0 }, 700), still1 = cycleOf({ ...pend, amp: 0 }, 1900);
check('a pendulum at amp 0 is still: its phase doesn\'t advance, swing 0', still0.phase === still1.phase && still0.swing === 0 && still1.swing === 0, [still0, still1]);
const damped = { ...pend, damp: 1 };   // 0.5 rad decays below 0.01 at t = ln(50) ≈ 3.9 s
const d1 = cycleOf(damped, 3000), d2 = cycleOf(damped, 5000), d3 = cycleOf(damped, 9000);
check('a damped pendulum swings, then comes to rest: its phase stops where the swing fell still', Math.abs(d1.swing) > 0 && d2.phase === d3.phase && d2.swing === 0 && !near1(d1.phase, d2.phase), [d1, d2, d3]);
check('one meaning of phase: 0 is the positive extreme for a pendulum (θ = amp·cos) AND an oscillate (offset = amp·sin)', near1(cycleOf({ type: 'oscillate', amp: 0.3, period: 4, t0: 0 }, 1000).phase, 0)
  && near1(cycleOf({ type: 'oscillate', amp: 0.3, period: 4, t0: 0 }, 1000).swing, 1) && near1(cycleOf(pend, 0).phase, 0) && near1(cycleOf(pend, 0).swing, 1));
const orb = travelOf({ pos: [0, 0, 0], yaw: 0 }, { type: 'orbit', radius: 2, degPerSec: 36, center: [0, 0, 0], t0: 0 }, 5000);
check('speed and turn of an orbit: 2πr/period m/s, its angular rate', near1(orb.speed, 2 * Math.PI * 2 / 10, 1e-3) && near1(orb.turn, 36 * Math.PI / 180, 1e-3), orb);
const sg = socketSignals({ comp: { 'motion:plank': pend, params: { lean: 0.3, junk: 'x' } }, sock: { part: 'plank' }, base: { pos: [0, 0, 0], yaw: 0 }, nowMs: 500, input: { throttle: 4, steer: -0.5, aimYaw: 0.2 } });
check('a socket riding a part reads that part\'s motion; input is clamped; params come through', near1(sg.phase, 0.25) && sg.throttle === 1 && sg.steer === -0.5 && sg.aimYaw === 0.2 && sg['param.lean'] === 0.3 && !('param.junk' in sg), sg);

// describeBody: one line for people and agents
const line = describeBody('driver', bodyOf(FULL));
check('describeBody says the action, how it drives and how to leave', /driver: drive/.test(line) && /throttle\/steer/.test(line) && /jump or get up/.test(line) && /builders and up only/.test(line), line);

// the door: the station's core through a real door (the rest of the research shape is reserved), the attach answer
W.call('create', { id: 'car', model: 'crate' });
const seat = (name: string, pos: number[], station: any) => OP.addSocket('car', { name }, { pos, station });
r = W.sendAll([seat('driver', [0, 0.6, 0], FULL_ST)]);
check('the door refuses the full research shape: its reserved keys (poses, reach, input…) are held for later (shape audit 10-16)', r.refused?.code === 'reserved', r.refused);
const CORE = { action: 'drive', anchor: 'hips', anim: FULL.pose, exit: FULL.exit, leaveBy: 'jump' };
r = W.sendAll([seat('driver', [0, 0.6, 0], { action: 'drive', input: { move: 'drive' } }), seat('shotgun', [0.6, 0.6, 0], { action: 'drive', input: { move: 'drive' } })]);
check('…and refuses two drivers on one thing (two helm socket children), in the door\'s words', r.refused?.code === 'shape' && /one seat drives a thing/.test(r.refused.reason), r.refused);
r = W.sendAll([seat('driver', [0, 0.6, 0], CORE), seat('back', [0, 0.6, -0.6], { action: 'drive', who: 'owner' })]);
const u = W.call('use', { id: 'car', action: 'drive' });
check('use answers attach with what the station does: anchor, pose, exit, leaveBy', r.ok && u.ok && u.attach?.socket === 'driver' && u.attach.anchor === 'hips' && u.attach.leaveBy === 'jump'
  && typeof u.attach.pose === 'object' && JSON.stringify(u.attach.exit) === JSON.stringify(FULL.exit), [r.refused, u]);
check('…an explicit socket is honoured, an unknown one refused with its name', W.call('use', { id: 'car', action: 'drive', args: { socket: 'back' } }).attach?.socket === 'back'
  && W.call('use', { id: 'car', action: 'drive', args: { socket: 'trunk' } }).refused?.code === 'no-action');

// the inspector: the host's card lists its socket children; a station is edited on its child, through the planner and the door
try {
const carLive = () => ({ world: W.view().entities });
const carRows = () => inspectSchema(W.rec('car'), 'car', carLive()).groups.find((g: any) => g.group === 'sockets')?.fields ?? [];
check('the Sockets card lists driver and back, and has no per-socket rows (each is edited as itself)', JSON.stringify(carRows().find((f: any) => f.k === 'slots')?.rows.map((x: any) => x.label)) === '["driver","back"]'
  && !carRows().some((f: any) => /\|/.test(f.k)), carRows().map((f: any) => f.k));
// review 10-12 S3-4: a thing's seats are read from its socket children: the Inspector's "reads as", inspect's `can`, and
// the Parent card of something on a socket (it read the old map and the old parent.socket, and said nothing)
{ const reads = inspectSchema(W.rec('car'), 'car', carLive()).groups.flatMap((g: any) => g.fields ?? []).find((f: any) => f.k === 'reads')?.value ?? '';
  const ins = W.call('inspect', { id: 'car' });
  check('S3-4 the seats are read out from the socket children: the Inspector\'s "reads as" and inspect\'s can say what using them is', /used to drive \(driver, back\)/.test(reads) && (ins.can ?? []).some((c: string) => /used to drive \(driver, back\)/.test(c)), [reads, ins.can]);
  const drv = Object.keys(W.view().entities).find((k) => W.view().entities[k].socket?.name === 'driver');
  W.call('create', { id: 'dice', model: 'crate', components: { parent: { to: drv }, transform: { pos: [0, 0.1, 0], scale: [0.1, 0.1, 0.1] } } });
  const par = inspectSchema(W.rec('dice'), 'dice', carLive()).sections?.list?.find((x: any) => x.type === 'Parent');
  check('S3-4 …and the Parent card of a thing on a socket names the socket and its host', JSON.stringify(par?.info ?? null) === '[["socket","driver on car"]]', par);
  W.call('delete', { id: 'dice' }); }
const backKid = Object.keys(W.state().entities).find((k) => W.state().entities[k].c.socket?.name === 'back')!;
const bst = () => W.state().entities[backKid]?.c.station;
const bplan = (st: any) => editOps(W.rec(backKid), backKid, { 'comp.station': JSON.stringify(st) }, carLive());
r = W.sendAll(bplan({ ...bst(), anchor: 'feet', leaveBy: 'menu' }).ops);
check('…the back seat\'s station is written on its child and the door takes it', r.ok && bst()?.anchor === 'feet' && bst()?.leaveBy === 'menu', [r.refused, bst()]);
r = W.sendAll(bplan({ ...bst(), look: { yaw: [-30, 30] } }).ops);
check('…a reserved key in it is refused as reserved', r.refused?.code === 'reserved', r.refused);
r = W.sendAll(bplan({ action: 'drive', who: 'owner' }).ops);
check('…and a station is materialized: the anchor is written down, an absent leaveBy stays absent', r.ok && bst()?.anchor === 'root' && bst()?.leaveBy === undefined, bst());

} catch (e) { check('the Inspector\'s Sockets card section ran to its end', false, String(e)); }

// ===================================================================== the old spelling, refused at the door (PLAN §3)
// LS1: `sockets` is no name: a map written by anyone (an old agent, an old doc) is refused as any unknown name (schema, did you
// mean socket); a socket is a child entity, made, moved and deleted as one
{ const L = scratchWorld('lift').seed({ bench: { model: 'crate', pos: [0, 0, 0] } });
  const MAP = { seat: { pos: [0, 0.5, 0], body: { action: 'sit' } }, hook: { pos: [0.4, 0.8, 0], accepts: ['coat'] } };
  const r0 = L.call('set', { id: 'bench', component: 'sockets', value: MAP });
  const kids = () => Object.entries(L.state().entities).filter(([, e]: any) => e.c.parent?.to === 'bench' && e.c.socket).map(([k, e]: any) => [k, e.c.socket.name]);
  const stored = () => L.entries().some((e: any) => e.kind === 'change' && opsOf(e).some((o: any) => o.comp === 'sockets'));
  const idOf = (n: string) => kids().find(([, m]) => m === n)?.[0];
  check('LS1 set sockets {seat, hook} is refused (schema, did you mean socket); nothing is written', r0.refused?.code === 'schema' && (r0.refused.didYouMean ?? []).includes('socket') && !kids().length && !stored(), r0.refused);
  const r1 = L.sendAll([OP.addSocket('bench', { name: 'seat' }, { pos: [0, 0.5, 0], station: { action: 'sit' } }), OP.addSocket('bench', { name: 'hook', accepts: ['coat'] }, { pos: [0.4, 0.8, 0], q: [0, 0.7071068, 0, 0.7071068] })]);
  const seatId = idOf('seat');
  check('LS1 socket children: each its own create (requests.js addSocket), its pose its transform, its station beside it; no sockets component in the log', r1.ok && JSON.stringify(kids().map(([, n]) => n)) === '["seat","hook"]' && !stored()
    && JSON.stringify(L.state().entities[seatId].c.transform) === '{"pos":[0,0.5,0],"q":[0,0,0,1],"scale":[1,1,1]}' && L.state().entities[seatId].c.station?.action === 'sit' && !('body' in L.state().entities[seatId].c.socket), [r1.refused, kids()]);
  L.call('create', { id: 'coat', model: 'ball', components: { parent: { to: idOf('hook') }, transform: { pos: [0, 0, 0.1] } } });
  const r2 = L.sendAll([OP.set(seatId, 'transform', { pos: [0, 0.6, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }), OP.remove(idOf('hook')!)]);
  check('LS1 moving a socket is a set transform on its child (same id); deleting one deletes what hangs on it, as any delete', r2.ok && JSON.stringify(kids()) === JSON.stringify([[seatId, 'seat']]) && L.state().entities[seatId].c.transform.pos[1] === 0.6 && !L.state().entities.coat && !stored(), [r2.refused, kids()]);
  const r3 = L.call('delete', { id: 'bench', component: 'sockets' });
  check('LS1 delete {component: sockets} names nothing the host has (not-found) and takes no socket child', r3.refused?.code === 'not-found' && !!L.state().entities[seatId], r3.refused);
  check('LS1 a socket child with an unknown key is refused (schema)', L.call('create', { id: 'bench-s', components: { parent: { to: 'bench' }, transform: { pos: [0, 1, 0] }, socket: { name: 's', pose: 'sit' } } }).refused?.code === 'schema'); }

// LS3: parent {to: host, socket} and home {parent: {to, socket}} are refused as legacy; parent {to: <the socket child>} rides it
{ const L = scratchWorld('lift3').seed({ rock: { model: 'crate', pos: [1, 0.2, -2], scale3: [2, 1, 3], q: [0, 0.3826834, 0, 0.9238795] } });
  const qs = [0.1830127, 0.6830127, -0.1830127, 0.6830127];   // a tilted, turned socket
  L.sendAll([OP.addSocket('rock', { name: 'perch' }, { pos: [0.3, 0.5, -0.2], q: qs })]);
  const perch = socketsIn(L.view().entities, 'rock').find((x: any) => x.name === 'perch')?.id;
  const pq = L.state().entities[perch]?.c.transform.q, n = Math.hypot(...qs);
  check('LS3 the socket child holds the slot\'s whole rotation (its q, normalized)', !!pq && pq.every((v: number, i: number) => Math.abs(v - qs[i] / n) < 1e-12), pq);
  const tx = { pos: [0.05, 0.1, 0.02], q: [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)], scale: [1, 1, 1] };
  const legacy = (x: any) => x.refused?.code === 'legacy' && /parent \{to: <the socket's id>\}/.test(x.refused.fix);
  const rl = L.call('create', { id: 'cup', model: 'ball', components: { parent: { to: 'rock', socket: 'perch' }, transform: tx } });
  check('LS3 a create with parent {to, socket} is refused as legacy, its fix naming parent {to: <the socket\'s id>}', legacy(rl) && !L.state().entities.cup, rl.refused);
  const r = L.call('create', { id: 'cup', model: 'ball', components: { parent: { to: perch }, transform: tx } });
  const st = L.state(); const c = st.entities.cup?.c;
  const a = worldPose(st, 'cup'), b = worldPose({ entities: { rock: st.entities.rock, [perch]: st.entities[perch], cup: { c: { parent: { to: perch }, transform: tx } } } }, 'cup');
  const close = (x: number[], y: number[]) => x.every((v, i) => Math.abs(v - y[i]) < 1e-8);
  check('LS3 parent {to: <the socket child>} rides it, its transform in the socket\'s frame', r.ok && c?.parent?.to === perch && close(a.pos, b.pos), [r.refused, c?.parent, a, b]);
  L.call('create', { id: 'mug', model: 'ball', components: { transform: { pos: [5, 0, 5] } } });
  const rb = L.sendAll([{ verb: 'set', args: { id: 'mug', component: 'parent', value: { to: 'rock', socket: 'perch' } } }, { verb: 'set', args: { id: 'mug', component: 'transform', value: tx } }]);
  check('LS3 a batch of parent {to, socket} then a transform (the old planner\'s gesture) is refused as legacy, and nothing of it lands', legacy(rb) && !L.state().entities.mug.c.parent, rb.refused);
  const rp = OP.parent(L.view(), 'mug', 'rock', { socket: 'perch' });
  check('LS3 …the planner\'s parent(…, {socket}) names the socket child instead', rp.verb === 'batch' && rp.args.requests[0].args.value?.to === perch && !('socket' in rp.args.requests[0].args.value) && L.sendAll(rp.args.requests).ok, rp);
  const hm0 = L.call('create', { id: 'pin', model: 'ball', components: { home: { pos: [0.05, 0.1, 0.02], parent: { to: 'rock', socket: 'perch' } } } });
  check('LS3 a home naming a socket is refused as legacy, its fix naming home {parent: {to: <the socket\'s id>}}', hm0.refused?.code === 'legacy' && /home \{parent: \{to: <the socket's id>\}\}/.test(hm0.refused.fix), hm0.refused);
  const gh = L.call('set', { id: 'mug', component: 'grabbable', value: { who: 'member', release: 'return', home: { pos: [0.05, 0.1, 0.02], q: [0, 0, 0, 1], parent: { to: perch } } } });
  check('LS3 a grabbable home is refused (home is its own component now: shape audit 10-16)', gh.refused?.code === 'schema', gh.refused);
  const hm = L.call('create', { id: 'pin', model: 'ball', components: { home: { pos: [0.05, 0.1, 0.02], parent: { to: perch } } } });
  check('LS3 home {parent: {to: <the socket child>}} is taken as sent', hm.ok && L.state().entities.pin?.c.home?.parent?.to === perch, [hm.refused, L.state().entities.pin?.c.home]);
  check('LS3 the log holds no parent.socket', !L.entries().some((e: any) => e.kind === 'change' && opsOf(e).some((o: any) => o.comp === 'parent' && o.value?.socket !== undefined))); }

// LS4: a catalogue model's seats are no longer made by the door (the lab chair has none): a chair's seat is a socket child
// someone creates, and a duplicate of the chair copies that child once
{ const L = scratchWorld('lift4');
  const r = L.call('create', { id: 'chair1', model: 'chair' });
  const kidsOf = (h: string) => Object.entries(L.state().entities).filter(([, e]: any) => e.c.parent?.to === h && e.c.socket).map(([k]) => k);
  check('LS4 create {model: chair} makes no seat child, and use {sit} is refused no-action (a model\'s seats aren\'t made at the door)', r.ok && !kidsOf('chair1').length && L.call('use', { id: 'chair1', action: 'sit' }).refused?.code === 'no-action', kidsOf('chair1'));
  const mk = L.sendAll([OP.addSocket('chair1', { name: 'seat' }, { pos: [0, 0.45, 0], station: { action: 'sit' } })]); const seat = kidsOf('chair1')[0];
  const u = L.call('use', { id: 'chair1', action: 'sit' });
  check('LS4 …its seat child, created, takes use {sit} there', mk.ok && u.ok && u.attach?.to === seat && L.state().entities[seat]?.c.station?.anim === 'sitchair', [mk.refused, u]);
  const d = L.call('create', { from: 'chair1', id: 'chair2' });
  check('LS4 a duplicate copies its seat child once', d.ok && kidsOf('chair2').length === 1, kidsOf('chair2')); }

// K7: a socket child's Hierarchy row says what it is for (seat, snap, attach; derived, never stored), never "(empty)"
{ const H = scratchWorld('kinds').seed({ rack: { model: 'crate', pos: [0, 0, 0] } });
  H.sendAll([OP.addSocket('rack', { name: 'seat' }, { pos: [0, 0.5, 0], station: {} }), OP.addSocket('rack', { name: 'hook', accepts: ['coat'] }, { pos: [0.4, 1, 0] }), OP.addSocket('rack', { name: 'eye' }, { pos: [0, 1.2, 0] })]);
  const v = H.view().entities; const hint = (n: string) => kindHint(v[socketsIn(v, 'rack').find((x: any) => x.name === n)?.id ?? '']);
  check('K7 kindHint: a socket child reads station / snap / attach by what it has', hint('seat') === 'station' && hint('hook') === 'snap' && hint('eye') === 'attach', [hint('seat'), hint('hook'), hint('eye')]); }

// OC3: a presence frame's seat, old or new, as a socket id (receivers take the old {to: host, slot} for one release)
{ const view = { entities: { bench: {  }, 'bench-seat': { parent: { to: 'bench' }, socket: { name: 'seat' } }, other: {  } } };
  const fold = { entities: { bench: { c: {} }, 'bench-seat': { c: { parent: { to: 'bench' }, socket: { name: 'seat' } } } } };
  check('OC3 resolveSeat: {to: <socket>} passes; {to: host, slot} names its socket child (a view or a fold state); unknown is null', JSON.stringify(resolveSeat(view, { to: 'bench-seat' })) === '{"to":"bench-seat"}'
    && JSON.stringify(resolveSeat(view, { to: 'bench', slot: 'seat' })) === '{"to":"bench-seat"}' && JSON.stringify(resolveSeat(fold, { to: 'bench', slot: 'seat' })) === '{"to":"bench-seat"}'
    && resolveSeat(view, { to: 'other', slot: 'seat' }) === null && resolveSeat(view, { to: 'bench', slot: 'nope' }) === null && resolveSeat(view, null) === null); }

// a purged station is no station, to the client and the authority alike, in the fold's form and in a view's JSON form
// (audit 10-22: the client's socketRole read isObj and called a purged station a station; the authority's said attach)
{ const { socketRole: viewRole } = await import('../shared/sockbody.js'); const { socketRole: authRole } = await import('../shared/protocol/authority/sockets.js');
  const { REDACTED } = await import('../shared/protocol/fold.js');
  const cases = [{ socket: { name: 's' }, station: REDACTED }, { socket: { name: 's' }, station: { redacted: true } }, { socket: { name: 's', accepts: ['x'] }, station: REDACTED }];
  const got = cases.map((c) => [viewRole(c), authRole(c)]);
  check('SR1 a purged station reads as no station, the same at the client and the authority, from the fold or from JSON', JSON.stringify(got) === JSON.stringify([['attach', 'attach'], ['attach', 'attach'], ['snap', 'snap']]), got); }

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
