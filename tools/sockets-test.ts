// sockets-test — the attach-point component, through the inspector's planner and the real door (scratch world).
// A socket is a named attachment point with a WHOLE rotation (Unreal sockets); with a `station` beside it a person
// attaches by using it (VRChat Station, Roblox Seat). The Inspector's card still reads and writes the old map, each slot's
// body block being its child's station (shape audit 10-16). usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/sockets-test.ts
import { inspectSchema, editOps } from '../shared/editschema.js';
import { bodyOf, socketQ } from '../shared/components.js';
import { localOf, kindHint } from '../shared/hierarchy.js';
import { scratchWorld } from './protocol/scratchworld.ts';
import * as OP from '../shared/protocol/requests.js';
import { checkSockets, evalPose, choosePose, mayLeave, reachWins, describeBody, NEAR_M, resolveSeat, socketMapIn, socketsIn } from '../shared/sockbody.js';
import { socketSignals, cycleOf, travelOf } from '../client/lib/socksignals.js';
import { socketId } from '../shared/protocol/authority/sockets.js';
import { opsOf } from '../shared/protocol/fold.js';
import { worldPose } from '../shared/protocol/simlayer.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: any = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail !== '' ? `  — ${JSON.stringify(detail).slice(0, 300)}` : ''}`); };
const near = (a: number[], b: number[], e = 1e-5) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < e);

// a rocket: a crate with one seat, built through the inspector the way a person would
const W = scratchWorld('sockets').seed({ rocket: { model: 'crate', pos: [0, 0, 0] } });
const ent = () => W.rec('rocket');
// a host's sockets are its socket children (PLAN-sockets-entities): the Inspector reads them as the card's map (live.world)
const live = () => ({ world: W.view().entities });
const C = () => ({ ...(ent()?.comp ?? {}), sockets: socketMapIn(W.view().entities, 'rocket') ?? undefined });
const plan = (edits: Record<string, any>) => editOps(ent(), 'rocket', edits, live());
const send = (p: any) => W.sendAll(p.ops);

let r: any;
// the card reads the socket children as its map and writes the whole map, which the door lifts into the children: a throw
// here is a red, not the end of the file
try {
r = send(plan({ 'sockets.seat|pos|1': 0.4 }));
check('a new socket slot from the inspector is a seat (a person attaches) and the door takes it', r.ok && !!bodyOf(C().sockets?.seat?.body), [r.refused, C().sockets]);
check('…with no rotation stored (identity)', C().sockets.seat.q === undefined, C().sockets.seat);

// lie the seat on its back: pitch -90° (a rocket, a dentist's chair, a bunk)
r = send(plan({ 'sockets.seat|rot|0': -90 }));
const q = C().sockets.seat.q;
check('pitch -90 is stored as a quaternion and the door takes it', r.ok && Array.isArray(q) && near(q, [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]), [r.refused, q]);
const rows = inspectSchema(ent(), 'rocket', live()).groups.find((g: any) => g.group === 'sockets')?.fields ?? [];
const val = (k: string) => rows.find((f: any) => f.k === k)?.value;
check('the inspector reads it back as heading 0, pitch -90°, roll 0', Math.abs(val('seat|rot|0') + Math.PI / 2) < 1e-6 && Math.abs(val('seat|rot|1')) < 1e-6 && Math.abs(val('seat|rot|2')) < 1e-6, rows.map((f: any) => [f.k, f.value]));
r = send(plan({ 'sockets.seat|rot|1': 90 }));
check('a heading edit on a tilted socket keeps the tilt (heading 90, pitch -90)', r.ok && (() => { const f = inspectSchema(ent(), 'rocket', live()).groups.find((g: any) => g.group === 'sockets').fields;
  const v = (k: string) => f.find((x: any) => x.k === k).value; return Math.abs(v('seat|rot|1') - Math.PI / 2) < 1e-6 && Math.abs(v('seat|rot|0') + Math.PI / 2) < 1e-6; })(), C().sockets.seat);

// body: action and pose
r = send(plan({ 'sockets.seat|action': 'ride', 'sockets.seat|pose': 'lie' }));
check('action and pose: the body block, through the door', r.ok && bodyOf(C().sockets.seat.body)?.action === 'ride' && bodyOf(C().sockets.seat.body)?.pose === 'lie', [r.refused, C().sockets.seat]);
const use = W.call('use', { id: 'rocket', action: 'ride' });
check('…and a person uses it: the door attaches them there, in that pose (presence)', use.ok && use.attach?.socket === 'seat' && use.attach.pose === 'lie', use);
check('a bad action is refused by the planner with the door\'s words', plan({ 'sockets.seat|action': 'Blast Off' }).ops.length === 0);

// people off: an attachment point for things only
r = send(plan({ 'sockets.seat|body': false }));
check('people attach: off → no body; the thing offers nothing to use', r.ok && !C().sockets.seat.body && !(W.call('inspect', { id: 'rocket' }).actions ?? []).length, C().sockets.seat);

// a thing parented at the slot rides the socket child, landing on it: identity under the socket, so its world rotation is
// the socket's whole rotation
W.call('create', { id: 'flag', model: 'crate' });
r = W.sendAll([OP.parent(W.view(), 'flag', 'rocket', { socket: 'seat' })]);   // the planner: a socket names the socket child
const world = W.view().entities;
const seatKid = socketsIn(world, 'rocket').find((x: any) => x.name === 'seat')?.id;
const L = localOf(world.flag, world);
check('requests.parent with a socket lands at the socket: parent {to: <the socket child>}, identity local pose', r.ok && !!seatKid && world.flag.parent?.to === seatKid && near(L.pos, [0, 0, 0]) && near(L.q ?? [0, 0, 0, 1], [0, 0, 0, 1]), [r.refused, world.flag.parent, L]);
const fq = worldPose(W.state(), 'flag').q;
check('a thing attached at a tilted socket rides it with the socket\'s rotation', near(fq, [-0.5, 0.5, 0.5, 0.5], 1e-4) || near(fq, [0.5, -0.5, -0.5, -0.5], 1e-4)   /* heading 90 then pitch -90: qY(90)·qX(-90) */, fq);

} catch (e) { check('the Inspector\'s socket section ran to its end', false, String(e)); }

// ===================================================================== the body block (shared/sockbody.js)
// the whole shape: closed keys at every level, ranges, enums, the one-driver rule (the door refuses with these words)
const sk = (body: any, extra: any = {}) => checkSockets({ s: { pos: [0, 0.5, 0], body, ...extra } });
const code = (body: any) => sk(body)?.code ?? 'ok';
const FULL = { action: 'drive', anchor: 'hips', pose: { by: 'speed', clips: [[0, 'idle'], [2, 'walk'], [6, 'run']] },
  poses: { lean: 'sitting_nervous_arm_rub_chair', pump: { clip: 'walk', time: 'phase' } }, sync: 'sofa', approach: [0.8, 0, 0, Math.PI / 2],
  enter: 'stand_to_sit', leave: 'sit_to_stand', exit: [0.9, 0, 0, 1.57],
  reach: { leftHand: { at: [-0.2, 0.9, 0.4], q: [0, 0, 0, 1], part: 'wheel', hint: [-0.5, 0.6, 0], vr: 'near' }, rightFoot: { at: [0.1, 0.1, 0.5] } },
  hold: { spine: [0, 0, 0.0871557, 0.9961947] }, look: { yaw: [-100, 100], pitch: [-40, 60], up: 'socket' }, input: { move: 'drive', look: 'aim' },
  leaveBy: 'jump', fromSeat: true, who: 'builder' };
check('the full research shape is taken whole', sk(FULL) === null, sk(FULL));
check('a two-signal blend and a param signal are taken', sk({ pose: { by: ['steer', 'throttle'], clips: [[[-1, 0], 'idle'], [[0, 0], 'sitchair'], [[1, 0], 'sit']] } }) === null
  && sk({ pose: { by: 'param.lean', clips: [[0, 'sitchair'], [1, 'sit']] } }) === null);
const dym = (body: any) => sk(body)?.didYouMean?.[0];
check('closed keys: an unknown body key is refused (schema), with a did-you-mean', code({ ancor: 'hips' }) === 'schema' && dym({ ancor: 'hips' }) === 'anchor', sk({ ancor: 'hips' }));
check('closed keys: …in a reach, in look, in input, in a pose', code({ reach: { leftHand: { at: [0, 1, 0], aim: 1 } } }) === 'schema' && code({ look: { yaw: [-1, 1], roll: 3 } }) === 'schema'
  && code({ input: { move: 'drive', fly: true } }) === 'schema' && code({ pose: { clip: 'sit', speed: 2 } }) === 'schema');
check('enums: anchor, leaveBy, input.move, input.look, look.up, reach.vr', ['anchor', 'leaveBy'].every((k) => code({ [k]: 'nope' }) === 'shape')
  && code({ input: { move: 'fly' } }) === 'shape' && code({ input: { look: 'stare' } }) === 'shape' && code({ look: { up: 'down' } }) === 'shape'
  && code({ reach: { leftHand: { at: [0, 1, 0], vr: 'grab' } } }) === 'shape');
check('ranges: look limits are [min, max] degrees within ±180 / ±90, min ≤ max', code({ look: { yaw: [-200, 0] } }) === 'shape' && code({ look: { pitch: [-10, 95] } }) === 'shape'
  && code({ look: { yaw: [30, -30] } }) === 'shape' && code({ look: { yaw: [-30, 30], pitch: [-90, 90] } }) === 'ok');
check('clip names are strings of the library\'s spelling (pose, enter, leave, blend rows)', code({ pose: 7 }) === 'shape' && code({ enter: 'stand to sit' }) === 'shape'
  && code({ pose: { by: 'speed', clips: [[0, 'idle'], [1, 3]] } }) === 'shape' && code({ leave: '../x' }) === 'shape');
check('reach limbs are the reach chains (a hand or a foot), with a did-you-mean', code({ reach: { leftHnad: { at: [0, 1, 0] } } }) === 'schema' && dym({ reach: { leftHnad: { at: [0, 1, 0] } } }) === 'leftHand'
  && code({ reach: { head: { at: [0, 1, 0] } } }) === 'schema' && code({ reach: { rightFoot: { at: [0, 0, 1] } } }) === 'ok');
check('a reach needs its target (at), and q is a unit quaternion', code({ reach: { leftHand: { part: 'wheel' } } }) === 'shape' && code({ reach: { leftHand: { at: [0, 1, 0], q: [1, 1, 0, 0] } } }) === 'shape');
check('hold names humanoid bones with unit quaternions', code({ hold: { spline: [0, 0, 0, 1] } }) === 'schema' && code({ hold: { spine: [0, 0, 0, 2] } }) === 'shape');
check('a blend: a closed set of signals, 2+ rows, keys rising', code({ pose: { by: 'mood', clips: [[0, 'idle'], [1, 'walk']] } }) === 'shape'
  && code({ pose: { by: 'speed', clips: [[0, 'idle']] } }) === 'shape' && code({ pose: { by: 'speed', clips: [[2, 'idle'], [1, 'walk']] } }) === 'shape'
  && code({ pose: { clip: 'sit', by: 'speed', clips: [[0, 'idle'], [1, 'walk']] } }) === 'shape' && code({ pose: { by: 'param.Bad-Name', clips: [[0, 'idle'], [1, 'walk']] } }) === 'shape');
check('approach is [x, y, z, yaw]; exit is [x, y, z] or with a yaw', code({ approach: [0, 0, 1] }) === 'shape' && code({ exit: [0, 0] }) === 'shape' && code({ exit: [1, 0, 0] }) === 'ok');
const twoDrivers = checkSockets({ a: { pos: [0, 1, 0], body: { input: { move: 'drive' } } }, b: { pos: [1, 1, 0], body: { input: { move: 'drive' } } } });
check('at most one drive per thing (passengers may walk)', twoDrivers?.code === 'shape' && /only one socket may drive/.test(twoDrivers.reason)
  && checkSockets({ a: { pos: [0, 1, 0], body: { input: { move: 'drive' } } }, b: { pos: [1, 1, 0], body: { input: { move: 'walk' } } } }) === null, twoDrivers);

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
check('one meaning of phase: 0 is the positive extreme for a pendulum (θ = amp·cos) AND a bob (offset = amp·sin)', near1(cycleOf({ type: 'bob', amp: 0.3, period: 4, t0: 0 }, 1000).phase, 0)
  && near1(cycleOf({ type: 'bob', amp: 0.3, period: 4, t0: 0 }, 1000).swing, 1) && near1(cycleOf(pend, 0).phase, 0) && near1(cycleOf(pend, 0).swing, 1));
const orb = travelOf({ pos: [0, 0, 0], yaw: 0 }, { type: 'orbit', radius: 2, degPerSec: 36, center: [0, 0, 0], t0: 0 }, 5000);
check('speed and turn of an orbit: 2πr/period m/s, its angular rate', near1(orb.speed, 2 * Math.PI * 2 / 10, 1e-3) && near1(orb.turn, 36 * Math.PI / 180, 1e-3), orb);
const sg = socketSignals({ comp: { 'motion:plank': pend, params: { lean: 0.3, junk: 'x' } }, sock: { part: 'plank' }, base: { pos: [0, 0, 0], yaw: 0 }, nowMs: 500, input: { throttle: 4, steer: -0.5, aimYaw: 0.2 } });
check('a socket riding a part reads that part\'s motion; input is clamped; params come through', near1(sg.phase, 0.25) && sg.throttle === 1 && sg.steer === -0.5 && sg.aimYaw === 0.2 && sg['param.lean'] === 0.3 && !('param.junk' in sg), sg);

// describeBody: one line for people and agents
const line = describeBody('driver', bodyOf(FULL));
check('describeBody says the action, how it drives and how to leave', /driver: drive/.test(line) && /throttle\/steer/.test(line) && /jump or get up/.test(line) && /builders only/.test(line), line);

// the door: the station's core through a real door (the rest of the research shape is reserved), the attach answer
W.call('create', { id: 'car', model: 'crate' });
r = W.call('set', { id: 'car', component: 'sockets', value: { driver: { pos: [0, 0.6, 0], body: FULL } } });
check('the door refuses the full research shape: its reserved keys (poses, reach, input…) are held for later (shape audit 10-16)', r.refused?.code === 'reserved', r.refused);
const CORE = { action: 'drive', anchor: 'hips', pose: FULL.pose, exit: FULL.exit, leaveBy: 'jump' };
r = W.call('set', { id: 'car', component: 'sockets', value: { driver: { pos: [0, 0.6, 0], body: { input: { move: 'drive' } } }, shotgun: { pos: [0.6, 0.6, 0], body: { input: { move: 'drive' } } } } });
check('…and refuses two drivers on one thing, in the shared words', r.refused?.code === 'shape' && /only one socket may drive/.test(r.refused.reason), r.refused);
r = W.call('set', { id: 'car', component: 'sockets', value: { driver: { pos: [0, 0.6, 0], body: CORE }, back: { pos: [0, 0.6, -0.6], body: { action: 'drive', who: 'owner' } } } });
const u = W.call('use', { id: 'car', action: 'drive' });
check('use answers attach with what the station does: anchor, pose, exit, leaveBy', r.ok && u.ok && u.attach?.socket === 'driver' && u.attach.anchor === 'hips' && u.attach.leaveBy === 'jump'
  && typeof u.attach.pose === 'object' && JSON.stringify(u.attach.exit) === JSON.stringify(FULL.exit), [r.refused, u]);
check('…an explicit socket is honoured, an unknown one refused with its name', W.call('use', { id: 'car', action: 'drive', args: { socket: 'back' } }).attach?.socket === 'back'
  && W.call('use', { id: 'car', action: 'drive', args: { socket: 'trunk' } }).refused?.code === 'no-action');

// the inspector: rows for the common fields, edits through the planner and the door
try {
const carLive = () => ({ world: W.view().entities });
const carSocks = () => socketMapIn(W.view().entities, 'car') ?? {};
const carRows = () => inspectSchema(W.rec('car'), 'car', carLive()).groups.find((g: any) => g.group === 'sockets')?.fields ?? [];
const has = (k: string) => carRows().some((f: any) => f.k === k);
check('the Sockets card has rows for the station\'s core (anchor, pose, leave by, who) and none for its reserved keys', ['driver|anchor', 'driver|pose', 'driver|leaveBy', 'driver|who'].every(has)
  && !['driver|input|move', 'driver|input|look', 'driver|look|yaw|0', 'driver|look|up', 'driver|reach', 'driver|fromSeat', 'driver|enter'].some(has), carRows().map((f: any) => f.k));
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
const cplan = (edits: any) => editOps(W.rec('car'), 'car', edits, carLive());
r = W.sendAll(cplan({ 'sockets.back|anchor': 'feet', 'sockets.back|leaveBy': 'menu' }).ops);
const back = bodyOf(carSocks().back.body);
const backKid = Object.keys(W.state().entities).find((k) => W.state().entities[k].c.socket?.name === 'back');
check('…the planner writes them and the door takes them, as the socket child\'s station', r.ok && back.anchor === 'feet' && back.leaveBy === 'menu' && W.state().entities[backKid]?.c.station?.anchor === 'feet', [r.refused, carSocks().back]);
r = W.call('set', { id: 'car', component: 'sockets', value: { ...carSocks(), back: { ...carSocks().back, body: { ...carSocks().back.body, input: { look: 'locked' } } } } });
check('…a reserved key written through the map is refused as reserved', r.refused?.code === 'reserved', r.refused);
r = W.sendAll(cplan({ 'sockets.back|anchor': 'root', 'sockets.back|leaveBy': 'any' }).ops);
check('…and a default: leaveBy any leaves the key out; the anchor is written down (a station is materialized)', r.ok && carSocks().back.body.anchor === 'root' && carSocks().back.body.leaveBy === undefined, carSocks().back);

} catch (e) { check('the Inspector\'s Sockets card section ran to its end', false, String(e)); }

// ===================================================================== the old spelling, lifted at the door (PLAN §3)
// LS1: a `sockets` map written by anyone (an old agent, an old doc) is stored as socket children, never as the map
{ const L = scratchWorld('lift').seed({ bench: { model: 'crate', pos: [0, 0, 0] } });
  const r1 = L.call('set', { id: 'bench', component: 'sockets', value: { seat: { pos: [0, 0.5, 0], body: { action: 'sit' } }, hook: { pos: [0.4, 0.8, 0], accepts: ['coat'] } } });
  const kids = () => Object.entries(L.state().entities).filter(([, e]: any) => e.c.parent?.to === 'bench' && e.c.socket).map(([k, e]: any) => [k, e.c.socket.name]);
  const stored = () => L.entries().some((e: any) => e.kind === 'change' && opsOf(e).some((o: any) => o.comp === 'sockets'));
  const seatId = socketId('bench', 'seat');
  check('LS1 set sockets {seat, hook} is taken, and the log holds no sockets component', r1.ok && !stored() && L.state().entities.bench.c.sockets === undefined, r1.refused);
  check('LS1 …each slot is a socket child (a deterministic id from host and slot), its pose its transform', JSON.stringify(kids()) === JSON.stringify([[seatId, 'seat'], [socketId('bench', 'hook'), 'hook']])
    && JSON.stringify(L.state().entities[seatId].c.transform) === '{"pos":[0,0.5,0],"q":[0,0,0,1],"scale":[1,1,1]}' && L.state().entities[seatId].c.station?.action === 'sit' && !('body' in L.state().entities[seatId].c.socket), kids());
  check('LS1 …and the reply says what it wrote (a legacy note naming each child)', r1.notes?.some((n: any) => n.legacy === 'sockets' && n.wrote?.seat === seatId), r1.notes);
  L.call('set', { id: 'bench', component: 'sockets', value: { seat: { pos: [0, 0.5, 0], body: { action: 'sit' } }, hook: { pos: [0.4, 0.8, 0], q: [0, 0.7071068, 0, 0.7071068], accepts: ['coat'] } } });
  L.call('create', { id: 'coat', model: 'ball', components: { parent: { to: 'bench', socket: 'hook' }, transform: { pos: [0.4, 0.8, 0.1] } } });
  const coat0 = worldPose(L.state(), 'coat');
  const r2 = L.call('set', { id: 'bench', component: 'sockets', value: { seat: { pos: [0, 0.6, 0], body: { action: 'sit' } } } });
  const coat1 = worldPose(L.state(), 'coat');
  check('LS1 …what sat on the hook stays with the bench, where it was in the world', L.state().entities.coat.c.parent?.to === 'bench' && coat1.pos.every((v: number, i: number) => Math.abs(v - coat0.pos[i]) < 1e-8) && coat1.q.every((v: number, i: number) => Math.abs(v - coat0.q[i]) < 1e-8), [L.state().entities.coat.c.parent, coat0, coat1]);
  check('LS1 a second map is a diff: the seat child is moved in place (same id), the hook child is deleted', r2.ok && JSON.stringify(kids()) === JSON.stringify([[seatId, 'seat']]) && L.state().entities[seatId].c.transform.pos[1] === 0.6 && !stored(), kids());
  const r3 = L.call('delete', { id: 'bench', component: 'sockets' });
  check('LS1 delete sockets deletes the socket children', r3.ok && !kids().length && !L.state().entities[seatId], r3.refused);
  check('LS1 …and with none left, it is refused as nothing there (not-found)', L.call('delete', { id: 'bench', component: 'sockets' }).refused?.code === 'not-found');
  check('LS1 a malformed map is still refused in the old words (schema, did-you-mean)', L.call('set', { id: 'bench', component: 'sockets', value: { s: { pos: [0, 1, 0], pose: 'sit' } } }).refused?.code === 'schema'); }

// LS3: parent {to: host, socket} is parent {to: <the socket child>}, and the thing stays where it was in the world
{ const L = scratchWorld('lift3').seed({ rock: { model: 'crate', pos: [1, 0.2, -2], scale3: [2, 1, 3], q: [0, 0.3826834, 0, 0.9238795] } });
  const qs = [0.1830127, 0.6830127, -0.1830127, 0.6830127];   // a tilted, turned socket
  L.call('set', { id: 'rock', component: 'sockets', value: { perch: { pos: [0.3, 0.5, -0.2], q: qs } } });
  const perch = socketId('rock', 'perch');
  const pq = L.state().entities[perch]?.c.transform.q, n = Math.hypot(...qs);
  check('LS3 the socket child holds the slot\'s whole rotation (its q, normalized)', !!pq && pq.every((v: number, i: number) => Math.abs(v - qs[i] / n) < 1e-12), pq);
  const tx = { pos: [0.05, 0.1, 0.02], q: [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)], scale: [1, 1, 1] };
  const r = L.call('create', { id: 'cup', model: 'ball', components: { parent: { to: 'rock', socket: 'perch' }, transform: tx } });
  const st = L.state(); const c = st.entities.cup?.c;
  const old = { entities: { rock: st.entities.rock, cup: { c: { parent: { to: 'rock' }, transform: tx } } } };   // what the old spelling meant: in the host's frame
  const a = worldPose(st, 'cup'), b = worldPose(old, 'cup');
  const close = (x: number[], y: number[]) => x.every((v, i) => Math.abs(v - y[i]) < 1e-8);
  check('LS3 a create with parent {to, socket} rides the socket child: parent {to: <its id>}, no socket field', r.ok && c?.parent?.to === perch && !('socket' in c.parent), [r.refused, c?.parent]);
  check('LS3 …at the same world pose, within 1e-8 (a turned, non-uniformly scaled host; a tilted socket)', close(a.pos, b.pos) && (close(a.q, b.q) || close(a.q, b.q.map((v: number) => -v))), [a, b]);
  L.call('create', { id: 'mug', model: 'ball', components: { transform: { pos: [5, 0, 5] } } });
  const rb = L.sendAll([{ verb: 'set', args: { id: 'mug', component: 'parent', value: { to: 'rock', socket: 'perch' } } }, { verb: 'set', args: { id: 'mug', component: 'transform', value: tx } }]);
  const st2 = L.state(); const a2 = worldPose(st2, 'mug'); const b2 = worldPose({ entities: { rock: st2.entities.rock, mug: { c: { parent: { to: 'rock' }, transform: tx } } } }, 'mug');
  check('LS3 a batch of parent {to, socket} then a transform (the old planner\'s gesture): the transform is read in the host\'s frame, and lands the same', rb.ok && st2.entities.mug.c.parent.to === perch && close(a2.pos, b2.pos), [rb.refused, a2, b2]);
  check('LS3 a socket the host doesn\'t have is refused not-found', L.call('set', { id: 'mug', component: 'parent', value: { to: 'rock', socket: 'nope' } }).refused?.code === 'not-found');
  const hm0 = L.call('create', { id: 'pin', model: 'ball', components: { home: { pos: [0.05, 0.1, 0.02], parent: { to: 'rock', socket: 'perch' } } } });
  const gh = L.call('set', { id: 'pin', component: 'grabbable', value: { who: 'visitor', release: 'return', home: { pos: [0.05, 0.1, 0.02], q: [0, 0, 0, 1], parent: { to: 'rock', socket: 'perch' } } } });
  check('LS3 a grabbable home is refused (home is its own component now: shape audit 10-16)', gh.refused?.code === 'schema', gh.refused);
  const hm = hm0;
  const pin = L.state().entities.pin?.c;
  const homeAt = (h: any) => worldPose({ entities: { rock: L.state().entities.rock, [perch]: L.state().entities[perch], x: { c: { parent: h.parent, transform: { pos: h.pos, q: h.q ?? [0, 0, 0, 1] } } } } }, 'x').pos;
  const homeWas = worldPose({ entities: { rock: L.state().entities.rock, x: { c: { parent: { to: 'rock' }, transform: { pos: [0.05, 0.1, 0.02] } } } } }, 'x').pos;
  check('LS3 a home naming a socket goes home to the socket child, to the same place', hm.ok && pin?.home?.parent?.to === perch && !('socket' in pin.home.parent) && close(homeAt(pin.home), homeWas), [hm.refused, pin?.home]);
  check('LS3 the log holds no parent.socket', !L.entries().some((e: any) => e.kind === 'change' && opsOf(e).some((o: any) => o.comp === 'parent' && o.value?.socket !== undefined))); }

// LS4: a catalogue model that declares seats (the lab chair) makes them as children when it is created
{ const L = scratchWorld('lift4');
  const r = L.call('create', { id: 'chair1', model: 'chair' });
  const seat = socketId('chair1', 'seat'); const c = L.state().entities[seat]?.c;
  check('LS4 create {model: chair} makes its seat child (its model\'s socket, every number in the log)', r.ok && c?.parent?.to === 'chair1' && c.socket?.name === 'seat' && !('body' in c.socket) && c.station?.pose === 'sitchair' && JSON.stringify(c.transform.pos) === '[0,0.45,0]', [r.refused, c]);
  const u = L.call('use', { id: 'chair1', action: 'sit' });
  check('LS4 …and use {sit} attaches there', u.ok && u.attach?.to === seat, u);
  const d = L.call('create', { from: 'chair1', id: 'chair2' });
  const kids2 = Object.entries(L.state().entities).filter(([, e]: any) => e.c.parent?.to === 'chair2' && e.c.socket);
  check('LS4 a duplicate copies its seat child once (the model\'s seats aren\'t made again)', d.ok && kids2.length === 1, kids2.map(([k]) => k)); }

// K7: a socket child's Hierarchy row says what it is for (seat, snap, attach; derived, never stored), never "(empty)"
{ const H = scratchWorld('kinds').seed({ rack: { model: 'crate', pos: [0, 0, 0] } });
  H.call('set', { id: 'rack', component: 'sockets', value: { seat: { pos: [0, 0.5, 0], body: {} }, hook: { pos: [0.4, 1, 0], accepts: ['coat'] }, eye: { pos: [0, 1.2, 0] } } });
  const v = H.view().entities; const hint = (n: string) => kindHint(v[socketsIn(v, 'rack').find((x: any) => x.name === n)?.id ?? '']);
  check('K7 kindHint: a socket child reads seat / snap / attach by what it has', hint('seat') === 'seat' && hint('hook') === 'snap' && hint('eye') === 'attach', [hint('seat'), hint('hook'), hint('eye')]); }

// OC3: a presence frame's seat, old or new, as a socket id (receivers take the old {to: host, slot} for one release)
{ const view = { entities: { bench: {  }, 'bench-seat': { parent: { to: 'bench' }, socket: { name: 'seat' } }, other: {  } } };
  const fold = { entities: { bench: { c: {} }, 'bench-seat': { c: { parent: { to: 'bench' }, socket: { name: 'seat' } } } } };
  check('OC3 resolveSeat: {to: <socket>} passes; {to: host, slot} names its socket child (a view or a fold state); unknown is null', JSON.stringify(resolveSeat(view, { to: 'bench-seat' })) === '{"to":"bench-seat"}'
    && JSON.stringify(resolveSeat(view, { to: 'bench', slot: 'seat' })) === '{"to":"bench-seat"}' && JSON.stringify(resolveSeat(fold, { to: 'bench', slot: 'seat' })) === '{"to":"bench-seat"}'
    && resolveSeat(view, { to: 'other', slot: 'seat' }) === null && resolveSeat(view, { to: 'bench', slot: 'nope' }) === null && resolveSeat(view, null) === null); }

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
