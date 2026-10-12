// shared/protocol/descriptors.js — one descriptor per engine component, derived from componentspec.js.
//
// The registry (COMPONENTS) is the schema: every field a card can show, its type, its default and what its absence means
// are read from there. What this table adds is the EDITOR'S VOCABULARY — the names and spellings the inspector, the
// records (shared/components.js RECORDS) and the agent's `edit` tool use where they differ from the wire's:
//   an axis is a letter to the editor (x, -y) and a unit vector on the wire ([1, 0, 0]);
//   a spin's or an orbit's rate is one number to the editor (°/s) and degPerSec | period | rpm on the wire;
//   a light's `burns at noon` is the wire's day: false; a uniform scale is one number to the editor, [s, s, s] on the wire;
//   a Grabbable, a Sockets, a Reactions card is its whole value ({spec: {}}): the wire bag is the editor's own.
// A descriptor is {key, card, type?, fields: [{k, param, t, path, wire?: {to, from}}]}: key is the registry name the
// value lives under (comp.<key>), card the record name (RECORDS[card]), type the motion type when the key is shared,
// k the inspector's address inside its group, param the record's parameter name (k when they agree), t the registry's
// field type, path the key inside the wire value (null = the whole value), wire the translation (to: editor → wire,
// from: wire → editor; both take (value, bag)). materialize(key, {type}) through `from` is what a field's default IS;
// tools/descriptor-defaults-test.ts holds RECORDS and editschema to it. No consumer reads this table yet (C8 does).

import { COMPONENTS, materialize } from './componentspec.js';

export const AXES = Object.freeze({ x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], '-x': [-1, 0, 0], '-y': [0, -1, 0], '-z': [0, 0, -1] });
/** A unit-axis vector's letter (x, -z), a letter as itself, anything else null. */
export function axisLetter(a) {
  if (typeof a === 'string') return AXES[a.toLowerCase()] ? a.toLowerCase() : null;
  if (Array.isArray(a) && a.length === 3) for (const [k, v] of Object.entries(AXES)) if (v.every((c, i) => c === a[i])) return k;
  return null;
}
/** A letter's vector; a vector as itself; anything else null. */
export const axisVector = (a) => (typeof a === 'string' ? AXES[a.toLowerCase()] ?? null : Array.isArray(a) && a.length === 3 ? a : null);
/** The editor's rate (°/s) of a motion bag: degPerSec, else 360 / period (seconds a turn), else an old rpm × 6. */
export const rateOf = (m) => (Number.isFinite(m?.degPerSec) ? m.degPerSec : Number.isFinite(m?.period) && m.period > 0 ? 360 / m.period : Number.isFinite(m?.rpm) ? m.rpm * 6 : undefined);

const AXIS = { to: (v) => axisVector(v) ?? v, from: (v) => axisLetter(v) ?? v };
const RATE = { to: (v) => v, from: (_, m) => rateOf(m) };
const NOON = { to: (b) => !b, from: (d) => d === false };
const UNIFORM = { to: (s) => (typeof s === 'number' ? [s, s, s] : s), from: (v) => (Array.isArray(v) && v[0] === v[1] && v[1] === v[2] ? v[0] : v) };

// per card: the registry fields it shows (motion's are per type), and the editor's spellings where they differ from the
// wire's. A card with `whole` edits its value as one JSON field named `whole`.
const MOTION = {
  Pendulum: { type: 'pendulum', show: ['part', 'axis', 'amp', 'period', 'damp', 'maxAmp', 'phase', 'pivot'] },
  Spin: { type: 'spin', show: ['part', 'axis', 'degPerSec', 'pivot', 'phase'] },
  Orbit: { type: 'orbit', show: ['part', 'radius', 'center', 'degPerSec', 'phase', 'face'] },
  Bob: { type: 'bob', show: ['part', 'axis', 'amp', 'period', 'phase'] },
  Path: { type: 'path', show: ['part', 'points', 'speed', 'duration', 'loop', 'face'] },
};
const MOTION_EDITOR = { axis: { wire: AXIS }, degPerSec: { param: 'rate', wire: RATE } };
const CARDS = {
  Transform: { key: 'transform', show: ['pos', 'q', 'scale'], editor: { scale: { wire: UNIFORM } } },
  Pivot: { key: 'pivot', own: { pos: 'vec3' } },   // the registry types pivot by its help only ({pos: [x,y,z]}); registering the field needs a pin regeneration (D8)
  Collider: { key: 'collider' },
  Light: { key: 'light', show: ['color', 'intensity', 'range', 'important', 'day'], editor: { day: { k: 'noon', param: 'burnsAtNoon', wire: NOON } } },
  ...Object.fromEntries(Object.entries(MOTION).map(([card, m]) => [card, { key: 'motion', type: m.type, show: m.show, editor: MOTION_EDITOR }])),
  Sockets: { key: 'sockets', whole: 'slots' },
  Grabbable: { key: 'grabbable', whole: 'spec', show: ['enabled', 'who', 'steal', 'range', 'priority', 'hold', 'twoHanded', 'throw', 'release', 'returnAfter'] },
  Openable: { key: 'openable', whole: 'spec', show: ['open', 'locked', 'angle', 'axis', 'slide', 'time', 'part'], editor: { axis: { wire: AXIS } } },
  Parent: { key: 'parent', show: ['to', 'socket'], editor: { socket: { param: 'slot' } } },
  Reactions: { key: 'reactions', whole: 'actions' },
  Particles: { key: 'particles', show: ['effect', 'part', 'at', 'seed', 'playing', 'scale', 'params'] },
  Picture: { key: 'picture', show: ['src', 'part', 'width', 'alt', 'lit', 'flip'] },
  Sound: { key: 'sound', show: ['src', 'playing', 'loop', 'volume', 'pitch', 'near', 'radius', 'spatial', 't0', 'alt'] },
  Story: { key: 'story' },
  Text: { key: 'text', show: ['text', 'size', 'width', 'align', 'color', 'outline', 'outlineColor', 'background', 'billboard', 'lit'] },
  LookAt: { key: 'look-at', show: ['target', 'mode', 'forward', 'up', 'yaw', 'pitch', 'speed', 'range', 'offset'] },
  Lock: { key: 'lock', whole: 'value' },
  Hidden: { key: 'hidden', whole: 'value' },
  Label: { key: 'label', whole: 'text' },
  Description: { key: 'description', whole: 'text' },
  Captions: { key: 'captions', whole: 'feed' },
  Stage: { key: 'stage' },
};

const TYPEOF = { boolean: 'bool', number: 'number', string: 'string' };
function build(card, c) {
  const def = COMPONENTS[c.key]; if (!def) throw new Error(`descriptors: ${card}'s key ${c.key} is not registered`);
  const typed = def.fields ?? c.own ?? {};
  const names = c.show ?? Object.keys(typed);
  const fields = [];
  if (c.whole) fields.push({ k: c.whole, param: c.whole, t: def.type ?? def.map ?? 'object', path: null });
  for (const path of names) {
    if (!(path in typed) && !(def.defaults && path in def.defaults)) throw new Error(`descriptors: ${card}.${path} is not a field of ${c.key}`);
    const e = c.editor?.[path] ?? {};
    fields.push({ k: e.k ?? path, param: e.param ?? e.k ?? path, t: typed[path] ?? TYPEOF[typeof def.defaults[path]] ?? 'any', path, ...(e.wire ? { wire: e.wire } : {}) });
  }
  return Object.freeze({ key: c.key, card, ...(c.type ? { type: c.type } : {}), fields: Object.freeze(fields.map(Object.freeze)) });
}
export const DESCRIPTORS = Object.freeze(Object.fromEntries(Object.entries(CARDS).map(([card, c]) => [card, build(card, c)])));
export const descriptorFor = (card) => DESCRIPTORS[card] ?? null;

/** What a card's value is with its defaults written in, as the AUTHORITY writes them: materialize(key, {type}). */
export const materializedOf = (card) => { const d = DESCRIPTORS[card]; return d ? materialize(d.key, d.type ? { type: d.type } : {}).value : null; };
/** A field's default as the editor sees it: the materialized value at its path, through `wire.from`. undefined = the
 *  registry writes nothing there (absence has its own meaning, absentMeans). */
export function editorDefault(card, k) {
  const d = DESCRIPTORS[card]; const f = d?.fields.find((x) => x.k === k); if (!f || f.path == null) return undefined;
  const bag = materializedOf(card); const v = bag?.[f.path];
  const out = f.wire ? f.wire.from(v, bag) : v;
  return out === null ? undefined : out;
}
/** An editor value written to the wire: through `wire.to`. */
export function toWire(card, k, v) { const f = DESCRIPTORS[card]?.fields.find((x) => x.k === k); return f?.wire ? f.wire.to(v) : v; }
