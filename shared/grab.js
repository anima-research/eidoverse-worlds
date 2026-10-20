// grab — what a hand may do with a thing: the `grabbable` component, as data.
//
// One component for every way a person picks a thing up (research: notes/eidoverse/RESEARCH-grab-2026-10-06.md, "The
// shape we build"). The cross-platform pattern it follows: grabbing is its OWN component, apart from dynamics (Meta's
// physics-less hand grab, Resonite Grabbable, Horizon's Interaction vs Motion); a grip is a named point in the thing's
// frame (VRChat ExactGrip, Unity Attach Transform, Godot GrabPoint); no grip means it's held where it was grabbed
// (Unreal Free); use-while-held is its own button with a down and an up (VRChat OnPickupUseDown/Up, Unity Activated);
// theft, who may and reach are per-thing (VRChat Disallow Theft, Horizon Who Can Grab, VRChat Proximity); a release
// can snap into a socket that accepts it (Resonite Snapper, XRI Socket, Godot SnapZone) or go home.
//
//   grabbable: {
//     enabled     true          can it be picked up now (false: a dynamic ball you can only kick)
//     who         'builder'     inhabitant | builder | owner: who may pick it up
//     steal       true          may someone take it from a holder's hand (owners always may)
//     range       1.5           m from the hand; past 1.5 it flies to the hand (0.1..10)
//     priority    0             -10..10: wins over lower when several things are in reach (the key, not the table)
//     hold        'auto'        auto (press-to-hold in VR, sticky on desktop and phone) | press | toggle
//     anim        (by size)     how a body without tracked hands holds it: a pose or clip by NAME, open (R 10-17 15:09/15:11;
//                               was pose, a closed enum): built in hand | carry | torch | pistol | shoulder (HOLD_POSES); a name
//                               the body doesn't know is its default hold (by size), never a refusal. two-hand is twoHanded.
//     grips       {}            {<name>: {pos, q?, hand?, role?, grasp?, part?}}: where the PALM goes, in the
//                               thing's own frame (+Z out of the palm, +Y along the fingers' base)
//     twoHanded   false         a second hand on a secondary grip steers it (false: a second hand takes it over)
//     carries     (absent=false) a tray: what rests on it comes along when it is picked up (false: it falls off; R 10-10)
//     throw       1             0..3: scales the release velocity (0: it can only be dropped)
//     release     'drop'        drop | stay (hangs where you let go) | return (goes home)
//     returnAfter 0             s, 0..3600: goes home after this long unheld (0: never)
//     (home)                    where it goes home to is the thing's own `home` component (shape audit 10-16: one home;
//                               the authority stamps it when a returning grabbable is written without one)
//     fits        []            keywords: it snaps into a socket whose `accepts` shares one, released within its radius
//     use         null          a reactions action, or {down, up}: what the use button fires while held
//     prompt      null          hover text (≤ 40); absent: "Pick up <label>"
//     (fx)                      reserved (shape audit 10-16): refused; presence-only particles while use is held come back
//                               as an addition if wanted. A grip's bone overrides (hold) are cut.
//   }
//
// Pure: no DOM, no three, no clock. The authority validates with checkGrabbable; the browser, the door and the agent process read with grabOf.

import { REACH } from './protocol/physconst.js';
import { materialize, COMPONENTS } from './protocol/componentspec.js';
import { BUILTIN_IDS, isWhoValue, isBase, whoWords } from './protocol/roles.js';
import { isReservedAnimName } from './animdefs.js';

export const WHO = BUILTIN_IDS;
// a `who` may also name a world's custom role: the shape is roles.js's, existence the authority's (whoRank)
const isWho = isWhoValue;   // a role id, {permission} or {roles} (recut item 8)
// the registry's (componentspec.js grabbable: its fields and enums are the shape; this file reads and checks it)
export const HOLDS = COMPONENTS.grabbable.enums.hold;      // auto, press, toggle
/** The hold poses every body knows by name (an anim may name any pose or clip; these are the built-in ones). */
export const HOLD_POSES = ['hand', 'carry', 'torch', 'pistol', 'shoulder'];
/** An anim names a pose or clip: the animation library's file names or a presence slot (sockbody.js CLIP_RE, one grammar). */
export const ANIM_RE = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
export const HANDS = ['left', 'right', 'either'];
export const ROLES = ['primary', 'secondary'];
/** A grip's grasp (R 10-17: was fingers; the XR-hands / robotics word): how the hand closes on it. */
export const GRASPS = ['fist', 'pinch', 'point', 'flat', 'open', 'trigger'];
export const RELEASES = COMPONENTS.grabbable.enums.release; // drop, stay, return
export const KEYS = Object.keys(COMPONENTS.grabbable.fields);
export const RESERVED_KEYS = COMPONENTS.grabbable.reservedFields;   // fx
export const GRIP_KEYS = ['pos', 'q', 'hand', 'role', 'grasp', 'part'];
// Who may carry or punt a thing that doesn't say (grabbable.who, physics.who absent): ONE value, read by the hand here and by
// the authority's punt (review 10-06 finding 5: the old protocol let visitors punt and carry, rank 0; the grabbable migration chose builder).
// Flipping it to 'inhabitant' is this one line plus the cases that pin builder today: grab-check M2, G6, I1 and phys-check F.
export const DEFAULT_WHO = materialize('grabbable', {}).value.who;   // 'inhabitant' (R 10-07: "I vote for visitors being able to grab and throw"; a world narrows it per thing with who)
// the written defaults are the registry's (componentspec.js grabbable.defaults: what the authority writes into a bare
// {grabbable: {}}); the rest is what a reader fills in for a field the authority leaves absent
export const DEFAULTS = Object.freeze({ ...materialize('grabbable', {}).value, anim: null, grips: Object.freeze({}), home: null, fits: Object.freeze([]), use: null, prompt: null, fx: null });
/** The authority's hand reach (physconst.js REACH): a range past it is granted as a pull (the thing flies to the hand). */
export const HAND_REACH = REACH;
/** A free socket takes a released thing that fits within this many metres of it, unless it says otherwise. */
export const SOCKET_RADIUS = 0.15;
/** VR near-grab: the hover sphere around a hand, × the avatar's scale (VRChat's number). */
export const NEAR_GRAB = 0.4;
/** The largest side under which a thing is carried in one hand on desktop and phone (else in both arms). */
export const HAND_SIZE = 0.5;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const ACTION_RE = /^[a-z][a-z0-9_-]{0,31}$/i;
const WORD_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const MAX_GRIPS = 8, MAX_FITS = 8, LIM = 1e4;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (x) => typeof x === 'number' && Number.isFinite(x);
const nums = (a, n, lim = LIM) => Array.isArray(a) && a.length === n && a.every((x) => num(x) && Math.abs(x) <= lim);
const unitQ = (q) => nums(q, 4, 1.0001) && Math.abs(Math.hypot(...q) - 1) < 1e-3;

// ---------------------------------------------------------------- reading

/** A grip, read generously with its defaults. */
export function gripOf(g) {
  if (!isObj(g) || !nums(g.pos, 3)) return null;
  return { pos: g.pos, q: unitQ(g.q) ? g.q : [0, 0, 0, 1], hand: HANDS.includes(g.hand) ? g.hand : 'either', role: ROLES.includes(g.role) ? g.role : 'primary',
    grasp: GRASPS.includes(g.grasp) ? g.grasp : GRASPS.includes(g.fingers) ? g.fingers : 'fist', hold: {},   // fingers: its spelling before 10-17 (a stored grip the maintenance command hasn't renamed yet); a grip's bone overrides are cut (shape audit 10-16)
    part: typeof g.part === 'string' && g.part ? g.part : null };
}

/**
 * What a hand may do with a thing, read from its components (an entity's `c`) with every default filled in, or null
 * when it can't be held at all. The ONE reader: the authority's gates, the client and the agent all ask this.
 *
 * Migration (research §Decisions 5): a thing with `physics {kind: 'dynamic'}` and no `grabbable` reads as
 * {who: physics.who ?? 'builder'} plus the defaults, which reproduce what the authority did before grabbable existed: the
 * latest grab wins, reach 1.5 m from the hand, held by its centre in the right hand, dropped or thrown on release.
 * `source` says which it was ('grabbable' or 'physics').
 */
export function grabOf(c) {
  if (!isObj(c)) return null;
  const v = c.grabbable;
  if (isObj(v)) return v.purged === true && Object.keys(v).length === 1 ? null : fill(v, 'grabbable', c.home);   // a purged value is absent, not a grabbable
  if (v === undefined && isObj(c.physics) && c.physics.kind === 'dynamic') return fill({ who: isWho(c.physics.who) ? c.physics.who : DEFAULT_WHO }, 'physics', c.home);
  return null;
}
/** A `home` component, read with its defaults ({pos, q, parent?, scale?}), or null. The one home (shape audit 10-16). */
export function homeOf(h) {
  return isObj(h) && nums(h.pos, 3, 1e5) ? { pos: h.pos, q: unitQ(h.q) ? h.q : [0, 0, 0, 1], ...(isObj(h.parent) && typeof h.parent.to === 'string' ? { parent: { to: h.parent.to } } : {}), ...(h.scale !== undefined ? { scale: h.scale } : {}) } : null;
}
function fill(v, source, home) {
  const g = { source };
  g.enabled = v.enabled !== false;
  g.who = isWho(v.who) ? v.who : DEFAULTS.who;
  g.steal = v.steal !== false;
  g.range = num(v.range) ? Math.min(10, Math.max(0.1, v.range)) : DEFAULTS.range;
  g.priority = Number.isInteger(v.priority) ? Math.max(-10, Math.min(10, v.priority)) : 0;
  g.hold = HOLDS.includes(v.hold) ? v.hold : 'auto';
  // anim: any name (the body resolves it; unknown → its default hold). pose: the spelling before 10-17, a stored value not yet renamed
  const anim = v.anim !== undefined ? v.anim : v.pose === 'two-hand' ? undefined : v.pose;
  g.anim = typeof anim === 'string' && ANIM_RE.test(anim) ? anim : null;
  g.grips = isObj(v.grips) ? Object.fromEntries(Object.entries(v.grips).map(([k, x]) => [k, gripOf(x)]).filter(([k, x]) => x && NAME_RE.test(k))) : {};
  g.twoHanded = v.twoHanded === true || (v.anim === undefined && v.pose === 'two-hand');
  g.carries = v.carries === true;
  g.throw = num(v.throw) ? Math.min(3, Math.max(0, v.throw)) : 1;
  g.release = RELEASES.includes(v.release) ? v.release : 'drop';
  g.returnAfter = num(v.returnAfter) ? Math.min(3600, Math.max(0, v.returnAfter)) : 0;
  g.home = homeOf(home);   // the thing's home component (grabbable.home is gone)
  g.fits = Array.isArray(v.fits) ? v.fits.filter((x) => typeof x === 'string' && WORD_RE.test(x)).map((x) => x.toLowerCase()) : [];
  g.use = useOf(v.use);
  g.prompt = typeof v.prompt === 'string' && v.prompt ? v.prompt.slice(0, 40) : null;
  g.fx = null;   // reserved (shape audit 10-16)
  return g;
}
/** `use` as {down, up} (either may be null): a bare action name is its down. */
export function useOf(u) {
  if (typeof u === 'string' && ACTION_RE.test(u)) return { down: u, up: null };
  if (isObj(u)) { const d = typeof u.down === 'string' && ACTION_RE.test(u.down) ? u.down : null, p = typeof u.up === 'string' && ACTION_RE.test(u.up) ? u.up : null; return d || p ? { down: d, up: p } : null; }
  return null;
}
/** The returning modes need a home: stamped by the authority when one is wanted and none is set. */
export const wantsHome = (v) => isObj(v) && (v.release === 'return' || (num(v.returnAfter) && v.returnAfter > 0));

/** The hold pose a body without tracked hands takes for this thing: the named one when the body knows it (HOLD_POSES
 *  today; a world's anim-pose later), else its default: by size (one hand under HAND_SIZE, both arms at or above it; a
 *  two-handed thing in both hands). An unknown name is never an error, only the default. size = [x, y, z] metres, or null. */
export function holdPoseOf(g, size) {
  if (g?.anim && ARMS[g.anim] && g.anim !== BOTH_HANDS) return g.anim;
  if (g?.source === 'physics') return 'hand';   // migration: a dynamic thing with no grabbable is held as before, by its centre in one hand
  if (g?.twoHanded) return BOTH_HANDS;
  return Array.isArray(size) && Math.max(...size) >= HAND_SIZE ? 'carry' : 'hand';
}

/** Which grip a hand takes (Godot GrabPointHand's fitness: hand match, then role, then the declared order). With
 *  `named`, that grip if this hand may take it. role: 'primary' for the first hand, 'secondary' for a second.
 *  Returns the grip's name, or null (no grips declared, or none for this hand: held where grabbed). */
export function pickGrip(g, hand, { named = null, role = 'primary' } = {}) {
  const ok = (x) => x.hand === 'either' || x.hand === hand;
  if (named != null) { const x = g?.grips?.[named]; return x && ok(x) ? named : null; }
  const all = Object.entries(g?.grips ?? {}).filter(([, x]) => ok(x));
  const exact = all.find(([, x]) => x.role === role && x.hand === hand) ?? all.find(([, x]) => x.role === role);
  return exact ? exact[0] : role === 'primary' && all.length ? all[0][0] : null;
}

/** Does a socket take this thing? Its `accepts` and the thing's `fits` share a keyword. */
export function fitsSocket(g, sock) {
  const acc = Array.isArray(sock?.accepts) ? sock.accepts.map((x) => String(x).toLowerCase()) : [];
  return !!g && acc.length > 0 && g.fits.some((k) => acc.includes(k));
}
export const socketRadius = (sock) => (num(sock?.radius) ? sock.radius : SOCKET_RADIUS);

/** What every client is told of a hold (the authority's presence plane, sent whenever it changes and in every join cut):
 *  who holds it, with which hand, by which grip or at which offset, and the second hand. Never logged. */
export function holdWire(h) {
  if (!isObj(h)) return null;
  return { by: h.by, ...(h.hand ? { hand: h.hand } : {}), ...(h.grip ? { grip: h.grip } : {}), ...(h.offset ? { offset: h.offset } : {}), ...(h.second ? { second: h.second } : {}) };
}
/** An offset as a hand may send it: {pos: [x, y, z] (≤ 2 m), q: [x, y, z, w]}. */
export const offsetOk = (o) => isObj(o) && nums(o.pos, 3, 2) && unitQ(o.q) && Object.keys(o).every((k) => k === 'pos' || k === 'q');

// ---------------------------------------------------------------- finger presets (VRM normalized bones)
// A curl per segment in radians, as each finger bends toward the palm: [proximal, intermediate, distal]; the thumb's are
// [metacarpal, proximal, distal]. Normalized VRM bones rest in a T-pose (identity), the right hand's fingers along -X and
// the left's along +X, palms down: a finger bends toward the palm about +Z on the right and -Z on the left, and the thumb
// folds in about Y. Every client poses fingers from the same table (presence: what the preset IS is data, never streamed).
const CURL = {
  fist:    { f: [1.45, 1.55, 1.0], thumb: [0.35, 0.6, 0.6] },
  pinch:   { f: [0.55, 0.75, 0.45], thumb: [0.45, 0.5, 0.45], index: [0.8, 0.9, 0.6] },
  point:   { f: [1.45, 1.55, 1.0], thumb: [0.4, 0.6, 0.6], index: [0.05, 0.05, 0.05] },
  flat:    { f: [0, 0, 0], thumb: [0, 0, 0] },
  open:    { f: [0.25, 0.3, 0.2], thumb: [0.15, 0.2, 0.15] },
  trigger: { f: [1.45, 1.55, 1.0], thumb: [0.35, 0.6, 0.6], index: [0.75, 0.85, 0.5] },
};
const SEG = { Thumb: ['Metacarpal', 'Proximal', 'Distal'], Index: ['Proximal', 'Intermediate', 'Distal'], Middle: ['Proximal', 'Intermediate', 'Distal'], Ring: ['Proximal', 'Intermediate', 'Distal'], Little: ['Proximal', 'Intermediate', 'Distal'] };
const axisQ = (ax, a) => { const s = Math.sin(a / 2), c = Math.cos(a / 2); return [ax[0] * s, ax[1] * s, ax[2] * s, c].map((x) => Math.round(x * 1e6) / 1e6); };
/** {<finger bone>: [x, y, z, w]} for one hand: the preset's curl, then the grip's sparse `hold` overrides on top. */
export function fingerPose(preset, side, hold = {}) {
  const p = CURL[preset] ?? CURL.fist; const sgn = side === 'left' ? -1 : 1; const out = {};
  for (const [f, segs] of Object.entries(SEG)) {
    const curl = f === 'Thumb' ? p.thumb : f === 'Index' && p.index ? p.index : p.f;
    segs.forEach((s, i) => { out[`${side}${f}${s}`] = f === 'Thumb' ? axisQ([0, sgn * -1, 0], curl[i]) : axisQ([0, 0, sgn], curl[i]); });
  }
  for (const [b, q] of Object.entries(hold)) if (b.startsWith(side)) out[b] = q;
  return out;
}

// ---------------------------------------------------------------- the body's hold pose (no tracked hands)
// Where each arm points for a preset, in the body's frame (+Z forward, +Y up, the right arm's side is -X): the upper arm,
// then the forearm. Every client turns these into normalized-bone rotations (shortest arc from the T-pose: a rest arm
// lies along -X on the right, +X on the left), so a desktop or phone body visibly holds what it holds, the same for
// everyone. Every direction is written for a RIGHT arm and mirrored for a left one; `other` is the other arm of a
// two-armed preset (carry: both arms round it; both-hands, a twoHanded thing: the support hand forward on it). both-hands
// is not a name an anim may give (twoHanded says it); the others are HOLD_POSES.
const BOTH_HANDS = 'both-hands';
const ARMS = {
  hand:       { hold: [[-0.12, -0.95, 0.28], [-0.05, -0.3, 0.95]] },
  torch:      { hold: [[-0.25, -0.55, 0.8], [-0.05, 0.55, 0.83]] },
  pistol:     { hold: [[-0.08, -0.05, 1], [0, 0, 1]] },
  shoulder:   { hold: [[-0.55, -0.7, 0.45], [0.35, 0.9, 0.25]] },
  carry:      { hold: [[-0.15, -0.8, 0.58], [0.45, -0.05, 0.89]], other: [[-0.15, -0.8, 0.58], [0.45, -0.05, 0.89]] },
  'both-hands': { hold: [[-0.12, -0.85, 0.5], [0.4, 0.1, 0.91]], other: [[-0.1, -0.6, 0.79], [0.3, 0.2, 0.93]] },
};
const vnorm = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const qmulA = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qrotA = (q, v) => { const p = qmulA(qmulA(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]); return [p[0], p[1], p[2]]; };
/** The shortest-arc rotation taking unit a onto unit b (three.js setFromUnitVectors). */
export function arc(a, b) {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d < -0.999999) { const ax = Math.abs(a[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0]; const c = vnorm(vcross(a, ax)); return [c[0], c[1], c[2], 0]; }
  const c = vcross(a, b); const q = [c[0], c[1], c[2], 1 + d]; const n = Math.hypot(...q); return q.map((x) => x / n);
}
const r6 = (q) => q.map((x) => Math.round(x * 1e6) / 1e6);
function armQ(side, upper, lower) {
  const rest = side === 'left' ? [1, 0, 0] : [-1, 0, 0];
  const mir = (v) => (side === 'left' ? [-v[0], v[1], v[2]] : v);
  const u = vnorm(mir(upper)), l = vnorm(mir(lower));
  const qu = arc(rest, u);
  const inv = [-qu[0], -qu[1], -qu[2], qu[3]];
  return { [`${side}UpperArm`]: r6(qu), [`${side}LowerArm`]: r6(arc(rest, vnorm(qrotA(inv, l)))) };
}
/** {<normalized bone>: [x, y, z, w]} for a body without tracked hands holding a thing in `hand` with `preset`. */
export function armPose(preset, hand = 'right') {
  const a = ARMS[preset] ?? ARMS.hand; const other = hand === 'left' ? 'right' : 'left';
  return { ...armQ(hand, ...a.hold), ...(a.other ? armQ(other, ...a.other) : {}) };
}
/** Does this preset take both arms (the thing sits between the hands)? */
export const bothArms = (preset) => !!ARMS[preset]?.other;

// ---------------------------------------------------------------- the authority's check

/** The whole `grabbable` component, checked (closed keys, ranges, enums, grips). Null when good, else
 *  {code: 'shape'|'schema'|'bounds', reason, fix, didYouMean?} — the authority refuses with it verbatim, and the inspector's
 *  planner speaks the same words. */
export function checkGrabbable(v, at = 'grabbable') {
  if (!isObj(v)) return bad('shape', `${at} must be an object {who?, grips?, release?, …} ({} takes every default)`);
  const held = Object.keys(v).find((k) => RESERVED_KEYS.includes(k));
  if (held) return bad('reserved', `${at}.${held} is reserved: held for a shape that isn't settled, and nothing may write it`, `leave ${held} out`);
  if (v.home !== undefined) return bad('schema', `${at}.home: where a thing goes home to is its own home component now`, "home {pos, q?, scale?, parent?: {to}} (the authority stamps it for a returning grabbable)", ['home']);
  let r = keys(at, v, KEYS, 'grabbable'); if (r) return r;
  for (const k of ['enabled', 'steal', 'twoHanded', 'carries']) if (v[k] !== undefined && typeof v[k] !== 'boolean') return bad('shape', `${at}.${k} is true or false`);
  if (v.who !== undefined && !isWho(v.who)) return bad('shape', `${at}.who is a role (${WHO.join(', ')} or this world's own), {permission: '<name>'} or {roles: [...]} (who may pick it up)`);
  if (v.hold !== undefined && !HOLDS.includes(v.hold)) return bad('shape', `${at}.hold is ${HOLDS.join(', ')} (auto: press-to-hold in VR, sticky on desktop)`);
  if (v.anim !== undefined && !(typeof v.anim === 'string' && ANIM_RE.test(v.anim))) return bad('shape', `${at}.anim names a pose or clip (built in: ${HOLD_POSES.join(', ')}; a name the body doesn't know is held by size)`, 'leave it out: held by size');
  if (isReservedAnimName(v.anim)) return bad('shape', `${at}.anim "${v.anim}" is reserved: it names ad-libbed anims, never a pose or clip`, 'name the pose or clip');
  if (v.release !== undefined && !RELEASES.includes(v.release)) return bad('shape', `${at}.release is ${RELEASES.join(', ')}`);
  for (const [k, lo, hi, what] of [['range', 0.1, 10, 'm from the hand'], ['throw', 0, 3, 'a multiplier on the release velocity'], ['returnAfter', 0, 3600, 's unheld before it goes home']])
    if (v[k] !== undefined && !(num(v[k]) && v[k] >= lo && v[k] <= hi)) return bad(num(v[k]) ? 'bounds' : 'shape', `${at}.${k} is ${v[k]}; it is ${lo}..${hi} (${what})`);
  if (v.priority !== undefined && !(Number.isInteger(v.priority) && v.priority >= -10 && v.priority <= 10)) return bad('shape', `${at}.priority is a whole number -10..10 (higher wins when several things are in reach)`);
  if (v.grips !== undefined) {
    if (!isObj(v.grips)) return bad('shape', `${at}.grips must be {<name>: {pos, q?, hand?, role?, grasp?, part?}}`);
    const names = Object.keys(v.grips); if (names.length > MAX_GRIPS) return bad('shape', `${at}.grips: at most ${MAX_GRIPS}`);
    for (const n of names) { const g = v.grips[n], gat = `${at}.grips.${n}`;
      if (!NAME_RE.test(n)) return bad('shape', `${at}.grips: a grip's name is letters, digits, - and _ (up to 32)`);
      if (!isObj(g)) return bad('shape', `${gat} must be {pos, q?, hand?, role?, grasp?, part?}`);
      if ((r = keys(gat, g, GRIP_KEYS, 'a grip'))) return r;
      if (!nums(g.pos, 3)) return bad('shape', `${gat}.pos must be [x, y, z] in the thing's own frame (where the palm goes)`);
      if (g.q !== undefined && !unitQ(g.q)) return bad('shape', `${gat}.q is a unit quaternion [x, y, z, w] (the palm's frame: +Z out of the palm, +Y along the fingers' base)`);
      if (g.hand !== undefined && !HANDS.includes(g.hand)) return bad('shape', `${gat}.hand is ${HANDS.join(', ')}`);
      if (g.role !== undefined && !ROLES.includes(g.role)) return bad('shape', `${gat}.role is ${ROLES.join(', ')} (a second hand takes a secondary grip)`);
      if (g.grasp !== undefined && !GRASPS.includes(g.grasp)) return bad('shape', `${gat}.grasp is ${GRASPS.join(', ')}`);
      if (g.part !== undefined && !(typeof g.part === 'string' && g.part)) return bad('shape', `${gat}.part names a node of its model (the grip rides it)`);
    }
  }
  if (v.fits !== undefined && !(Array.isArray(v.fits) && v.fits.length <= MAX_FITS && v.fits.every((x) => typeof x === 'string' && WORD_RE.test(x)))) return bad('shape', `${at}.fits is up to ${MAX_FITS} keywords (letters, digits, - and _, up to 32 each): a socket whose accepts shares one takes it`);
  if (v.use !== undefined && v.use !== null && !useOf(v.use)) return bad('shape', `${at}.use names a reactions action ('light'), or {down: 'fire', up: 'cease'}`);
  if (isObj(v.use) && Object.keys(v.use).some((k) => !['down', 'up'].includes(k))) return bad('schema', `${at}.use takes down and up`);
  if (v.prompt !== undefined && !(typeof v.prompt === 'string' && v.prompt.length <= 40)) return bad('shape', `${at}.prompt is a short text (up to 40 characters)`);
  return null;
}

/** A socket's `accepts`/`radius`, checked (sockbody.js calls this for each socket). */
export function checkAccepts(sk, sat) {
  if (sk.accepts !== undefined && !(Array.isArray(sk.accepts) && sk.accepts.length >= 1 && sk.accepts.length <= MAX_FITS && sk.accepts.every((x) => typeof x === 'string' && WORD_RE.test(x))))
    return bad('shape', `${sat}.accepts is 1 to ${MAX_FITS} keywords: a released thing whose grabbable.fits shares one snaps in`);
  if (sk.radius !== undefined && !(num(sk.radius) && sk.radius >= 0.02 && sk.radius <= 1)) return bad('shape', `${sat}.radius is 0.02..1 m (how near a release must be to snap in; default ${SOCKET_RADIUS})`);
  return null;
}

function keys(at, v, allowed, what) {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) { const dym = near(k, allowed);
    return bad('schema', `${at}: unknown key '${k}'${dym.length ? `; did you mean '${dym[0]}'?` : ''}`, `${what} takes: ${allowed.join(', ')}`, dym); }
  return null;
}
const bad = (code, reason, fix = '', didYouMean = null) => ({ code, reason, fix, ...(didYouMean?.length ? { didYouMean } : {}) });
function near(k, allowed) {
  const x = String(k).toLowerCase();
  const lev = (a, b) => { const d = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) { let prev = d[0]; d[0] = i; for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; } }
    return d[b.length]; };
  return allowed.filter((a) => { const y = a.toLowerCase(); return (x.length > 2 && (y.startsWith(x) || x.startsWith(y))) || lev(x, y) <= Math.max(1, Math.floor(y.length / 3)); }).slice(0, 3);
}

/** One line saying what a hand may do with it, for anyone reading it as text (the agent process's look). */
export function describeGrab(g, label = 'it') {
  if (!g) return null;
  if (!g.enabled) return `${label} can't be picked up now`;
  const bits = [isBase(g.who) ? 'anyone may pick it up' : `${whoWords(g.who)} may pick it up`];
  if (g.range > HAND_REACH) bits.push(`from ${g.range} m (it flies to your hand)`); else if (g.range < HAND_REACH) bits.push(`within ${g.range} m`);
  const grips = Object.keys(g.grips); if (grips.length) bits.push(`held by ${grips.join(', ')}`);
  if (g.twoHanded) bits.push('two-handed');
  if (!g.steal) bits.push("can't be taken from a hand");
  if (g.use) bits.push(`use while held: ${[g.use.down, g.use.up].filter(Boolean).join(' / ')}`);
  if (g.release === 'stay') bits.push('stays where you let go');
  else if (g.release === 'return') bits.push('goes home when let go');
  if (g.returnAfter > 0) bits.push(`goes home after ${g.returnAfter} s`);
  if (g.fits.length) bits.push(`fits sockets for ${g.fits.join(', ')}`);
  if (g.throw === 0) bits.push("can't be thrown"); else if (g.throw !== 1) bits.push(`throws ×${g.throw}`);
  return `${g.prompt ?? `pick up ${label}`} (${bits.join('; ')})`;
}
