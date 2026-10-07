// sockets-test — the attach-point component, through the inspector's planner and the real door (scratch v4 world).
// A socket is a named attachment point with a WHOLE rotation (Unreal sockets); with `body` a person attaches by using
// it (VRChat Station, Roblox Seat). usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/sockets-test.ts
import { inspectSchema, editOps } from '../shared/editschema.js';
import { bodyOf, socketQ } from '../shared/components.js';
import { localOf } from '../shared/hierarchy.js';
import { scratchWorld } from './v4/scratchworld.ts';
import * as OP from '../shared/v4/requests.js';
import { checkSockets, evalPose, choosePose, mayLeave, reachWins, describeBody, NEAR_M } from '../shared/sockbody.js';
import { socketSignals, cycleOf, travelOf } from '../client/lib/socksignals.js';

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
check('…and a person uses it: the door attaches them there, in that pose (presence)', use.ok && use.attach?.socket === 'seat' && use.attach.pose === 'lie', use);
check('a bad action is refused by the planner with the door\'s words', plan({ 'sockets.seat|action': 'Blast Off' }).ops.length === 0);

// people off: an attachment point for things only
r = send(plan({ 'sockets.seat|body': false }));
check('people attach: off → no body; the thing offers nothing to use', r.ok && !C().sockets.seat.body && !(W.call('inspect', { id: 'rocket' }).actions ?? []).length, C().sockets.seat);

// a thing parented at the slot takes the socket's whole rotation as its local one
W.call('create', { id: 'flag', model: 'crate' });
W.sendAll([OP.parent(W.view(), 'flag', 'rocket', { socket: 'seat' })]);   // the planner: a socket gives the socket's pose
const world = W.view().entities;
const L = localOf(world.flag, world);
check('a thing attached at a tilted socket rides it with the socket\'s rotation', !!L?.q && near(L.q, [-0.5, 0.5, 0.5, 0.5], 1e-4)   /* heading 90 then pitch -90: qY(90)·qX(-90) */, L);


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
const B = (body: any) => bodyOf({ pos: [0, 0, 0], body });
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
const line = describeBody('driver', bodyOf({ pos: [0, 0, 0], body: FULL }));
check('describeBody says the action, how it drives and how to leave', /driver: drive/.test(line) && /throttle\/steer/.test(line) && /jump or get up/.test(line) && /builders only/.test(line), line);

// the door: the full shape through a real door, the one-driver rule, the attach answer
W.call('create', { id: 'car', model: 'crate' });
r = W.call('set', { id: 'car', component: 'sockets', value: { driver: { pos: [0, 0.6, 0], body: FULL } } });
check('the door takes the full shape', r.ok, r.refused);
r = W.call('set', { id: 'car', component: 'sockets', value: { driver: { pos: [0, 0.6, 0], body: { input: { move: 'drive' } } }, shotgun: { pos: [0.6, 0.6, 0], body: { input: { move: 'drive' } } } } });
check('…and refuses two drivers on one thing, in the shared words', r.refused?.code === 'shape' && /only one socket may drive/.test(r.refused.reason), r.refused);
r = W.call('set', { id: 'car', component: 'sockets', value: { driver: { pos: [0, 0.6, 0], body: { ...FULL, who: undefined } }, back: { pos: [0, 0.6, -0.6], body: { action: 'drive', who: 'owner' } } } });
const u = W.call('use', { id: 'car', action: 'drive' });
check('use answers attach with what the body does: anchor, pose, reach, input, leaveBy…', u.ok && u.attach?.socket === 'driver' && u.attach.anchor === 'hips' && u.attach.leaveBy === 'jump'
  && u.attach.input?.move === 'drive' && !!u.attach.reach?.leftHand && typeof u.attach.pose === 'object' && u.attach.fromSeat === true, u);
check('…an explicit socket is honoured, an unknown one refused with its name', W.call('use', { id: 'car', action: 'drive', args: { socket: 'back' } }).attach?.socket === 'back'
  && W.call('use', { id: 'car', action: 'drive', args: { socket: 'trunk' } }).refused?.code === 'no-action');

// the inspector: rows for the common fields, edits through the planner and the door
const carRows = () => inspectSchema(W.rec('car'), 'car').groups.find((g: any) => g.group === 'sockets')?.fields ?? [];
const has = (k: string) => carRows().some((f: any) => f.k === k);
check('the Sockets card has rows for anchor, pose, leave by, who, input, look and reach', ['driver|anchor', 'driver|pose', 'driver|leaveBy', 'driver|who', 'driver|input|move', 'driver|input|look', 'driver|look|yaw|0', 'driver|look|up', 'driver|reach'].every(has),
  carRows().map((f: any) => f.k));
const cplan = (edits: any) => editOps(W.rec('car'), 'car', edits);
r = W.sendAll(cplan({ 'sockets.back|anchor': 'feet', 'sockets.back|leaveBy': 'menu', 'sockets.back|input|look': 'locked', 'sockets.back|look|yaw|0': -45, 'sockets.back|look|up': 'socket',
  'sockets.back|reach': '{"rightHand": {"at": [0.3, 1, 0.2], "vr": "track"}}' }).ops);
const back = bodyOf(W.rec('car').comp.sockets.back);
check('…the planner writes them and the door takes them', r.ok && back.anchor === 'feet' && back.leaveBy === 'menu' && back.input.look === 'locked' && back.look.yaw[0] === -45 && back.look.up === 'socket' && back.reach.rightHand?.vr === 'track', [r.refused, W.rec('car').comp.sockets.back]);
const planBad = cplan({ 'sockets.back|input|move': 'drive' });
check('…and refuses what the door would, in its words (a second driver)', planBad.ops.length === 0 && planBad.errors.some((e: string) => /only one socket may drive/.test(e)), planBad.errors);
r = W.sendAll(cplan({ 'sockets.back|anchor': 'root', 'sockets.back|leaveBy': 'any' }).ops);
check('…and a default leaves the key out', r.ok && W.rec('car').comp.sockets.back.body.anchor === undefined && W.rec('car').comp.sockets.back.body.leaveBy === undefined, W.rec('car').comp.sockets.back);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
