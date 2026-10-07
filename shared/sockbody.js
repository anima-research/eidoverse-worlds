// sockbody — what a person's body does at a socket: the `body` block of `sockets.<name>`, as data.
//
// One shape for every way a body attaches to a thing (research: notes/eidoverse/RESEARCH-socket-body-2026-10-06.md,
// "The shape we build"): a chair, a swing, a saddle, a car's driver seat, a rocket couch, a bunk, a lectern you stand
// at. The cross-platform pattern it follows: one occupant per socket (VRChat Station, Roblox Seat); WHICH body point
// lands on the socket (Resonite AvatarAnchor PositionNode); a pose that is a clip, a blend by state, or time locked to
// the thing's motion (Unreal/Godot AnimBP/AnimationTree, without the state machine: data says what the body does in a
// given world state, scripts change the world state); IK targets parented to moving parts (Unity Two Bone IK, Unreal
// Control Rig); a per-limb VR policy (Resonite `Required`, VRChat per-part tracking); exit locks (VRChat Disable
// Station Exit); input published as signals for the vehicle to consume (Roblox VehicleSeat's Throttle/Steer, without
// its physics-on-the-seat weakness).
//
//   body: {
//     action   'sit'            the verb `use` calls it AND the default posture (sit | lie | stand | ride | kneel | …)
//     anchor   'hips'           which body point lands on the socket: hips | feet | head | root (the default: where
//                               every seat put a body before anchors existed, so no existing seat moves)
//     pose     'sitchair'       a clip; {clip, time?, offset?}; or a blend {by, clips, time?, offset?}
//     poses    {lean: …}        a menu of named poses (pose is the default); the occupant picks one
//     sync     'sofa'           sockets sharing a sync group switch same-named poses together (AVsitter SYNC)
//     approach [x,y,z,yaw]      socket frame: where you're brought to first, then `enter` carries you onto the seat
//     enter    'stand_to_sit'   one-shot clip while you're carried on;  leave: one-shot clip while carried off
//     exit     [x,y,z(,yaw)]    where you're set down (the thing's frame)
//     reach    {leftHand: {at, q?, part?, hint?, vr?}}   IK targets in the thing's frame (or a part's: they move with it)
//     hold     {spine: [x,y,z,w]}                       sparse bone overrides over the pose (the escape hatch)
//     look     {yaw: [min,max], pitch: [min,max], up}   head limits in degrees, socket frame; up: world | socket
//     input    {move: none|drive|walk, look: free|aim|locked}   at most one `drive` per thing
//     leaveBy  'jump'           jump | menu | script  (absent: moving, jumping or getting up all leave)
//     fromSeat true             you may move here from another seat without standing up
//     who      'builder'        visitor | builder | owner
//   }
//
// Pure: no DOM, no three, no clock. The door validates with checkSockets; client, door and agent read with bodyOf.

import { REACH_CHAINS } from './joints.js';
import { HUMANOID_BONES } from './humanoid.js';
import { checkAccepts } from './grab.js';

export const ANCHORS = ['hips', 'feet', 'head', 'root'];
export const LEAVE_BY = ['jump', 'menu', 'script'];
export const MOVES = ['none', 'drive', 'walk'];
export const LOOKS = ['free', 'aim', 'locked'];
export const UPS = ['world', 'socket'];
export const VR_POLICIES = ['snap', 'track', 'near'];
export const TIMES = ['loop', 'phase'];
export const WHO = ['visitor', 'builder', 'moderator', 'owner'];
// a `who` may also name a world's custom role (roles.js): the shape is checked here, existence by the door (whoRank)
const isWho = (x) => WHO.includes(x) || (typeof x === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(x) && !['none', 'guest', 'everyone', 'ghost', 'banned'].includes(x));
/** The closed set of signals a pose may blend by. Every client computes each one the same way: speed/turn/phase/swing
 *  from the thing's motion component (closed forms, client/lib/socksignals.js), throttle/steer/aimYaw/aimPitch from the
 *  occupant's input (riding their presence), and param.<name> from the thing's `params` component (scripts write it). */
export const SIGNALS = ['speed', 'turn', 'phase', 'swing', 'throttle', 'steer', 'aimYaw', 'aimPitch'];
export const BODY_KEYS = ['action', 'anchor', 'pose', 'poses', 'sync', 'approach', 'enter', 'leave', 'exit', 'reach', 'hold', 'look', 'input', 'leaveBy', 'fromSeat', 'who'];
// accepts/radius (shared/grab.js): a free socket takes a released thing whose grabbable.fits shares a keyword, within radius
export const SOCKET_KEYS = ['pos', 'q', 'part', 'body', 'accepts', 'radius'];
export const REACH_KEYS = ['at', 'q', 'part', 'hint', 'vr'];
export const LOOK_KEYS = ['yaw', 'pitch', 'up'];
export const INPUT_KEYS = ['move', 'look'];
export const POSE_KEYS = ['clip', 'time', 'offset', 'by', 'clips'];
/** A clip is named the way the animation library names its files (sitting_normal_chair) or a presence slot (sitchair) */
export const CLIP_RE = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
export const ACTION_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const PARAM_RE = /^param\.[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
export const isSignal = (s) => typeof s === 'string' && (SIGNALS.includes(s) || PARAM_RE.test(s));
const MAX_BLEND = 16, MAX_POSES = 16, LIM = 1e4;

/** What an action means when the socket says nothing more: the pose it holds. The anchor defaults to the ROOT for
 *  every action — where every seat put a body before anchors existed (v1's legacy-root, the Commons' twelve seats),
 *  so no existing seat moves; a socket names hips, feet or head to seat that body point instead. (For the house sit
 *  clips the root IS about the seat surface: the clip lifts the hips a pelvis above it.) */
export const ACTION_DEFAULTS = {
  sit: { pose: 'sitchair', anchor: 'root' }, ride: { pose: 'sitchair', anchor: 'root' }, drive: { pose: 'sitchair', anchor: 'root' },
  lie: { pose: 'lie', anchor: 'root' }, kneel: { pose: 'sit', anchor: 'root' }, stand: { pose: 'idle', anchor: 'root' },
};
const defaultsFor = (action) => ACTION_DEFAULTS[action] ?? ACTION_DEFAULTS.sit;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (x) => typeof x === 'number' && Number.isFinite(x);
const nums = (a, n, lim = LIM) => Array.isArray(a) && a.length === n && a.every((x) => num(x) && Math.abs(x) <= lim);
const unitQ = (q) => nums(q, 4, 1.0001) && Math.abs(Math.hypot(...q) - 1) < 1e-3;

// ---------------------------------------------------------------- reading

/** The clip a pose spec stands for when one name is wanted (a menu label, the agent's description, a fallback):
 *  a clip's own name, a blend's first clip. */
export function poseClip(spec) {
  if (typeof spec === 'string') return spec;
  if (isObj(spec) && typeof spec.clip === 'string') return spec.clip;
  if (isObj(spec) && Array.isArray(spec.clips) && Array.isArray(spec.clips[0])) return String(spec.clips[0][1]);
  return null;
}

/** A socket's body block, read generously with its defaults (shared by the door, the client and the agent). Null when
 *  the socket has none: an attachment point for things only (parent {to, slot}). `pose` is the spec as written (a
 *  clip name, or an object); `clip` is the one name it stands for. Absent leaveBy is 'any' (moving, jumping or getting
 *  up all leave: what every seat did before leaveBy existed). */
export function bodyOf(sock) {
  const b = isObj(sock) ? sock.body : null;
  if (!isObj(b)) return null;
  const action = typeof b.action === 'string' && b.action ? b.action : 'sit';
  const d = defaultsFor(action);
  const pose = (typeof b.pose === 'string' && b.pose) || isObj(b.pose) ? b.pose : d.pose;
  const reach = isObj(b.reach) ? Object.fromEntries(Object.entries(b.reach).filter(([k, r]) => REACH_CHAINS[k] && isObj(r) && nums(r.at, 3))
    .map(([k, r]) => [k, { at: r.at, q: unitQ(r.q) ? r.q : null, part: typeof r.part === 'string' ? r.part : null, hint: nums(r.hint, 3) ? r.hint : null, vr: VR_POLICIES.includes(r.vr) ? r.vr : 'snap' }])) : {};
  const lk = isObj(b.look) ? b.look : {};
  const range = (r, lo, hi) => (nums(r, 2, 360) && r[0] <= r[1] ? [Math.max(lo, r[0]), Math.min(hi, r[1])] : [lo, hi]);
  const inp = isObj(b.input) ? b.input : {};
  return {
    action,
    anchor: ANCHORS.includes(b.anchor) ? b.anchor : d.anchor,
    pose, clip: poseClip(pose) ?? d.pose,
    poses: isObj(b.poses) ? b.poses : {},
    sync: typeof b.sync === 'string' && b.sync ? b.sync : null,
    approach: nums(b.approach, 4) ? b.approach : null,
    enter: typeof b.enter === 'string' && b.enter ? b.enter : null,
    leave: typeof b.leave === 'string' && b.leave ? b.leave : null,
    exit: nums(b.exit, 3) || nums(b.exit, 4) ? b.exit : null,
    reach,
    hold: isObj(b.hold) ? Object.fromEntries(Object.entries(b.hold).filter(([, q]) => unitQ(q))) : {},
    look: { yaw: range(lk.yaw, -180, 180), pitch: range(lk.pitch, -90, 90), up: UPS.includes(lk.up) ? lk.up : 'world', limited: nums(lk.yaw, 2, 360) || nums(lk.pitch, 2, 360) },
    input: { move: MOVES.includes(inp.move) ? inp.move : 'none', look: LOOKS.includes(inp.look) ? inp.look : 'free' },
    leaveBy: LEAVE_BY.includes(b.leaveBy) ? b.leaveBy : 'any',
    fromSeat: b.fromSeat === true,
    who: isWho(b.who) ? b.who : null,
  };
}

/** Which pose an occupant holds: the menu entry they chose (or, in a sync group, the latest choice any occupant of the
 *  group made that this socket also offers), else the default. `choices` are [{name, at}] — the occupant's own and
 *  their sync partners', from presence; `at` is the chooser's clock stamp, so every client picks the same one. */
export function choosePose(body, choices = []) {
  let best = null;
  for (const c of choices) if (c && typeof c.name === 'string' && body.poses[c.name] !== undefined && (!best || (c.at ?? 0) > (best.at ?? 0))) best = c;
  return best ? { name: best.name, spec: body.poses[best.name] } : { name: null, spec: body.pose };
}

/** Is a leave request of this kind allowed by the socket? kind: 'move' (a movement key), 'jump', 'menu' (the explicit
 *  get-up: X, the stand tile, /stand, the radial menu), 'script'. A seat whose input takes the movement keys (drive,
 *  walk) never treats them as "get off". */
export function mayLeave(body, kind) {
  if (!body) return true;
  if (kind === 'script') return true;
  const lb = body.leaveBy;   // 'script' falls through every branch below: nothing the occupant does lets go
  if (kind === 'move') return lb === 'any' && body.input.move === 'none';
  if (kind === 'jump') return lb === 'any' || lb === 'jump';
  return lb !== 'script';   // menu: the explicit get-up works for any, jump and menu
}

// ---------------------------------------------------------------- evaluation

/** A pose spec, evaluated against the signals: {clips: [[name, weight]], time: 'loop'|'phase', offset} with weights
 *  summing to 1. A 1-D blend interpolates linearly between its two neighbouring keys and holds the end clips outside
 *  the range (Godot BlendSpace1D); a 2-D blend weights each clip by inverse squared distance to the signal point, an
 *  exact hit taking it whole (a gradient-band-free, deterministic rule every client computes the same). */
export function evalPose(spec, sig = {}) {
  if (typeof spec === 'string') return { clips: [[spec, 1]], time: 'loop', offset: null };
  if (!isObj(spec)) return { clips: [], time: 'loop', offset: null };
  const time = spec.time === 'phase' ? 'phase' : 'loop';
  const offset = nums(spec.offset, 3) ? spec.offset : null;
  if (typeof spec.clip === 'string') return { clips: [[spec.clip, 1]], time, offset };
  const rows = Array.isArray(spec.clips) ? spec.clips : [];
  if (!rows.length) return { clips: [], time, offset };
  const val = (s) => (num(sig[s]) ? sig[s] : 0);
  if (!Array.isArray(spec.by)) {
    const x = val(spec.by);
    const keys = rows.map((r) => r[0]);
    if (x <= keys[0]) return { clips: [[rows[0][1], 1]], time, offset };
    if (x >= keys[keys.length - 1]) return { clips: [[rows[rows.length - 1][1], 1]], time, offset };
    let i = 1; while (keys[i] < x) i++;
    const f = (x - keys[i - 1]) / (keys[i] - keys[i - 1]);
    const out = []; if (1 - f > 1e-6) out.push([rows[i - 1][1], 1 - f]); if (f > 1e-6) out.push([rows[i][1], f]);
    return { clips: merge(out), time, offset };
  }
  const p = spec.by.map(val);
  const w = rows.map((r) => { const d2 = (r[0][0] - p[0]) ** 2 + (r[0][1] - p[1]) ** 2; return d2 < 1e-12 ? Infinity : 1 / d2; });
  const hit = w.findIndex((x) => x === Infinity);
  if (hit >= 0) return { clips: [[rows[hit][1], 1]], time, offset };
  const sum = w.reduce((a, b) => a + b, 0);
  return { clips: merge(rows.map((r, i) => [r[1], w[i] / sum])), time, offset };
}
// two rows naming the same clip are one clip with their weights added
function merge(list) { const m = new Map(); for (const [c, w] of list) m.set(c, (m.get(c) ?? 0) + w); return [...m]; }

/** The VR hand policy (Resonite AvatarAnchor `Required`; VRChat per-part tracking): does the socket's reach target win
 *  over a tracked hand? snap — always (hands on the wheel); track — never while the hand is tracked; near — when the
 *  tracked hand comes within `near` metres of the target (you grab the bar; let go and your hand is yours again).
 *  hand = the tracked hand's world point, or null when the hand isn't tracked (then the target always wins). */
export const NEAR_M = 0.15;
export function reachWins(policy, hand, target) {
  if (!hand) return true;
  if (policy === 'track') return false;
  if (policy === 'near') return Math.hypot(hand[0] - target[0], hand[1] - target[1], hand[2] - target[2]) <= NEAR_M;
  return true;
}

// ---------------------------------------------------------------- the door's check

/** The whole `sockets` component, checked (closed keys, ranges, enums, the one-driver rule). Null when good, else
 *  {code: 'shape'|'schema', reason, teach, didYouMean?} — the door refuses with it verbatim, and the inspector's planner
 *  speaks the same words. */
export function checkSockets(v, at = 'sockets') {
  if (!isObj(v)) return bad('shape', `${at} must be {<name>: {pos, q?, part?, body?}}`);
  let drivers = [];
  for (const [k, sk] of Object.entries(v)) {
    const sat = `${at}.${k}`;
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(k)) return bad('shape', `${sat}: a socket's name is letters, digits, - and _ (up to 32)`);
    if (!isObj(sk)) return bad('shape', `${sat} must be {pos, q?, part?, body?}`);
    let r = keys(sat, sk, SOCKET_KEYS, 'a socket'); if (r) return r;
    if (!nums(sk.pos, 3)) return bad('shape', `${sat}.pos must be [x, y, z] in the thing's own frame`);
    if (sk.q !== undefined && !unitQ(sk.q)) return bad('shape', `${sat}.q is a unit quaternion [x, y, z, w] (the socket's rotation in the thing's frame)`);
    if (sk.part !== undefined && !(typeof sk.part === 'string' && sk.part)) return bad('shape', `${sat}.part names a node of its model`);
    if ((r = checkAccepts(sk, sat))) return r;
    if (sk.body === undefined) continue;
    r = checkBody(sk.body, `${sat}.body`); if (r) return r;
    if (sk.body.input?.move === 'drive') drivers.push(k);
  }
  if (drivers.length > 1) return bad('shape', `${at}: only one socket may drive (${drivers.join(', ')} all have input.move 'drive')`, "one driver per thing (a vehicle has one wheel); passengers' input can still shape their own pose: input.move 'walk'");
  return null;
}

function checkBody(b, at) {
  if (!isObj(b)) return bad('shape', `${at} must be {action?, anchor?, pose?, …}`);
  let r = keys(at, b, BODY_KEYS, "a socket's body"); if (r) return r;
  if (b.action !== undefined && !(typeof b.action === 'string' && ACTION_RE.test(b.action))) return bad('shape', `${at}.action is a verb in lower case ('sit', 'ride', 'drive')`);
  if (b.anchor !== undefined && !ANCHORS.includes(b.anchor)) return bad('shape', `${at}.anchor is ${ANCHORS.join(', ')} (the body point that lands on the socket)`);
  if (b.pose !== undefined && (r = checkPose(b.pose, `${at}.pose`))) return r;
  if (b.poses !== undefined) {
    if (!isObj(b.poses)) return bad('shape', `${at}.poses must be {<name>: pose}`);
    const names = Object.keys(b.poses);
    if (names.length > MAX_POSES) return bad('shape', `${at}.poses: at most ${MAX_POSES}`);
    for (const n of names) { if (!NAME_RE.test(n)) return bad('shape', `${at}.poses: a pose's name is letters, digits, - and _ (up to 32)`); if ((r = checkPose(b.poses[n], `${at}.poses.${n}`))) return r; }
  }
  if (b.sync !== undefined && !(typeof b.sync === 'string' && NAME_RE.test(b.sync))) return bad('shape', `${at}.sync names a group (letters, digits, - and _)`);
  if (b.approach !== undefined && !nums(b.approach, 4)) return bad('shape', `${at}.approach is [x, y, z, yaw] in the socket's frame (yaw in radians)`);
  for (const k of ['enter', 'leave']) if (b[k] !== undefined && !(typeof b[k] === 'string' && CLIP_RE.test(b[k]))) return bad('shape', `${at}.${k} names a clip ('stand_to_sit')`);
  if (b.exit !== undefined && !nums(b.exit, 3) && !nums(b.exit, 4)) return bad('shape', `${at}.exit must be [x, y, z] (or [x, y, z, yaw]) in the thing's own frame`);
  if (b.reach !== undefined) {
    if (!isObj(b.reach)) return bad('shape', `${at}.reach must be {<limb>: {at, q?, part?, hint?, vr?}}`);
    for (const [limb, t] of Object.entries(b.reach)) {
      const lat = `${at}.reach.${limb}`;
      if (!REACH_CHAINS[limb]) return bad('schema', `${at}.reach: no limb '${limb}'`, `limbs: ${Object.keys(REACH_CHAINS).join(', ')}`, near(limb, Object.keys(REACH_CHAINS)));
      if (!isObj(t)) return bad('shape', `${lat} must be {at, q?, part?, hint?, vr?}`);
      if ((r = keys(lat, t, REACH_KEYS, 'a reach'))) return r;
      if (!nums(t.at, 3)) return bad('shape', `${lat}.at must be [x, y, z] (the thing's frame, or its part's)`);
      if (t.q !== undefined && !unitQ(t.q)) return bad('shape', `${lat}.q is a unit quaternion [x, y, z, w] (the hand's frame; the palm faces its -Y)`);
      if (t.part !== undefined && !(typeof t.part === 'string' && t.part)) return bad('shape', `${lat}.part names a node of the model (the target moves with it)`);
      if (t.hint !== undefined && !nums(t.hint, 3)) return bad('shape', `${lat}.hint is [x, y, z]: where the elbow (or knee) points`);
      if (t.vr !== undefined && !VR_POLICIES.includes(t.vr)) return bad('shape', `${lat}.vr is ${VR_POLICIES.join(', ')} (a tracked hand: snap to the target, keep tracking, or snap when near)`);
    }
  }
  if (b.hold !== undefined) {
    if (!isObj(b.hold)) return bad('shape', `${at}.hold must be {<bone>: [x, y, z, w]}`);
    for (const [bone, q] of Object.entries(b.hold)) {
      if (!HUMANOID_BONES.includes(bone)) return bad('schema', `${at}.hold: no bone '${bone}'`, 'VRM humanoid bone names: hips, spine, chest, neck, head, leftUpperArm…', near(bone, HUMANOID_BONES));
      if (!unitQ(q)) return bad('shape', `${at}.hold.${bone} is a unit quaternion [x, y, z, w]`);
    }
  }
  if (b.look !== undefined) {
    if (!isObj(b.look)) return bad('shape', `${at}.look must be {yaw?, pitch?, up?}`);
    if ((r = keys(`${at}.look`, b.look, LOOK_KEYS, 'look'))) return r;
    for (const [k, lim] of [['yaw', 180], ['pitch', 90]]) if (b.look[k] !== undefined && !(nums(b.look[k], 2, lim) && b.look[k][0] <= b.look[k][1])) return bad('shape', `${at}.look.${k} is [min, max] in degrees, within ±${lim}`);
    if (b.look.up !== undefined && !UPS.includes(b.look.up)) return bad('shape', `${at}.look.up is world or socket (does the view roll with the thing?)`);
  }
  if (b.input !== undefined) {
    if (!isObj(b.input)) return bad('shape', `${at}.input must be {move?, look?}`);
    if ((r = keys(`${at}.input`, b.input, INPUT_KEYS, 'input'))) return r;
    if (b.input.move !== undefined && !MOVES.includes(b.input.move)) return bad('shape', `${at}.input.move is ${MOVES.join(', ')}`);
    if (b.input.look !== undefined && !LOOKS.includes(b.input.look)) return bad('shape', `${at}.input.look is ${LOOKS.join(', ')}`);
  }
  if (b.leaveBy !== undefined && !LEAVE_BY.includes(b.leaveBy)) return bad('shape', `${at}.leaveBy is ${LEAVE_BY.join(', ')} (leave it out: moving, jumping or getting up all leave)`);
  if (b.fromSeat !== undefined && typeof b.fromSeat !== 'boolean') return bad('shape', `${at}.fromSeat is true or false`);
  if (b.who !== undefined && !isWho(b.who)) return bad('shape', `${at}.who is visitor, builder or owner`);
  return null;
}

function checkPose(p, at) {
  if (typeof p === 'string') return CLIP_RE.test(p) ? null : bad('shape', `${at} names a clip ('sitchair', 'sitting_normal_chair')`);
  if (!isObj(p)) return bad('shape', `${at} is a clip name, {clip, time?, offset?} or a blend {by, clips, time?, offset?}`);
  const r = keys(at, p, POSE_KEYS, 'a pose'); if (r) return r;
  if (p.time !== undefined && !TIMES.includes(p.time)) return bad('shape', `${at}.time is loop or phase (phase: the clip's time follows the thing's motion)`);
  if (p.offset !== undefined && !nums(p.offset, 3, 10)) return bad('shape', `${at}.offset is [x, y, z] metres in the socket's frame`);
  if (p.clip !== undefined) {
    if (p.by !== undefined || p.clips !== undefined) return bad('shape', `${at}: a pose is one clip OR a blend (by + clips), not both`);
    return typeof p.clip === 'string' && CLIP_RE.test(p.clip) ? null : bad('shape', `${at}.clip names a clip`);
  }
  if (p.by === undefined || p.clips === undefined) return bad('shape', `${at} needs clip, or by + clips`);
  const two = Array.isArray(p.by);
  if (two ? !(p.by.length === 2 && p.by.every(isSignal)) : !isSignal(p.by)) return bad('shape', `${at}.by is a signal or two: ${SIGNALS.join(', ')}, param.<name>`);
  if (!Array.isArray(p.clips) || p.clips.length < 2 || p.clips.length > MAX_BLEND) return bad('shape', `${at}.clips is 2 to ${MAX_BLEND} [key, clip] rows`);
  let last = -Infinity;
  for (const row of p.clips) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[1] !== 'string' || !CLIP_RE.test(row[1])) return bad('shape', `${at}.clips rows are [key, clip name]`);
    if (two) { if (!nums(row[0], 2)) return bad('shape', `${at}.clips keys are [a, b] for a two-signal blend`); }
    else { if (!num(row[0]) || Math.abs(row[0]) > LIM) return bad('shape', `${at}.clips keys are numbers`); if (row[0] <= last) return bad('shape', `${at}.clips keys rise strictly ([0, 'idle'], [2, 'walk'], …)`); last = row[0]; }
  }
  return null;
}

function keys(at, v, allowed, what) {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) { const dym = near(k, allowed);
    return bad('schema', `${at}: unknown key '${k}'${dym.length ? `; did you mean '${dym[0]}'?` : ''}`, `${what} takes: ${allowed.join(', ')}`, dym); }
  return null;
}
const bad = (code, reason, teach = '', didYouMean = null) => ({ code, reason, teach, ...(didYouMean?.length ? { didYouMean } : {}) });
// a near miss: a prefix either way, or an edit distance of at most a third of the word
function near(k, allowed) {
  const x = String(k).toLowerCase();
  const lev = (a, b) => { const d = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) { let prev = d[0]; d[0] = i; for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; } }
    return d[b.length]; };
  return allowed.filter((a) => { const y = a.toLowerCase(); return (x.length > 2 && (y.startsWith(x) || x.startsWith(y))) || lev(x, y) <= Math.max(1, Math.floor(y.length / 3)); }).slice(0, 3);
}

/** One line saying what a body does at a socket, for people and agents alike (the agent's look, the sit reply). */
export function describeBody(slot, b) {
  if (!b) return `${slot}: an attach point (things only)`;
  const pose = typeof b.pose === 'string' ? `holds ${b.pose}`
    : Array.isArray(b.pose?.clips) ? `blends ${b.pose.clips.map((r) => r[1]).join('/')} by ${[].concat(b.pose.by).join('+')}`
    : b.pose?.time === 'phase' ? `plays ${b.pose.clip} in step with its motion` : `holds ${b.clip}`;
  const bits = [pose, `${b.anchor} on the socket`];
  const menu = Object.keys(b.poses ?? {}); if (menu.length) bits.push(`poses: ${menu.join(', ')}${b.sync ? ` (in step with the ${b.sync} group)` : ''}`);
  const limbs = Object.keys(b.reach ?? {}); if (limbs.length) bits.push(`${limbs.join(' and ')} on the thing`);
  if (b.input.move === 'drive') bits.push('drives it (movement is throttle/steer)'); else if (b.input.move === 'walk') bits.push('movement shapes your pose');
  if (b.input.look === 'locked') bits.push('view locked forward'); else if (b.look.limited) bits.push(`head turns ${b.look.yaw[0]}…${b.look.yaw[1]}°`);
  if (b.enter || b.approach) bits.push(`gets on${b.approach ? ' from its approach point' : ''}${b.enter ? ` with ${b.enter}` : ''}`);
  bits.push(b.leaveBy === 'script' ? 'lets you go only when the world does' : b.leaveBy === 'menu' ? 'get up explicitly to leave' : b.leaveBy === 'jump' ? 'jump or get up to leave' : 'walk or get up to leave');
  if (b.fromSeat) bits.push('you can move here from another seat');
  if (b.who) bits.push(`${b.who}s only`);
  return `${slot}: ${b.action} (${bits.join('; ')})`;
}
