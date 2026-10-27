// shared/components.js — the component library, engine rung (RFC #208 steps 3–4, data-only).
//
// An entity is a Transform plus a list of components. Each component type is an
// immutable, content-addressed RECORD: a name, a parameter schema (type, default,
// range, unit), what it needs, what an old client shows instead, and the line a
// text-tier resident reads. No record carries code; the realizers that give the
// built-ins behaviour are the engine's own.
//
// Every spelling the wire has is an ALIAS here (design §2.4, §6): `lib`,
// `collide`, `parent`, `comp.motion` with its `type` enum, `comp.sockets`, …,
// `comp.light` on any entity, `comp.collider`, and the Empty — a spawn with no
// `lib`. (The old protocol's `kind: "light"` light entity is gone from the view:
// the importer rewrites it to comp.light; shared/protocol/kind.js kindOf names
// what a thing is.) `componentsOf` reads any folded entity as a component list,
// and `entityOf` writes a component list back to exactly those bytes; an
// instance's `key` says which comp-bag key it came from. Nothing in an existing
// world is rewritten (RFC: updates are offered, never applied);
// tools/components-corpus-test.ts proves the round trip on every local world.
//
// Pure: no DOM, no three, no I/O. Server, browser, mcpl and tests import it.

import { kindOf } from './protocol/kind.js';
import { recordOf, recordComponents } from './protocol/view.js';
import { materialize, COMPONENTS } from './protocol/componentspec.js';
import { DESCRIPTORS, editorDefault, AXES } from './protocol/descriptors.js';
import { ESSENTIAL_NAMES } from './particle_effects.js';
import { qNorm, qFromYaw } from './rot.js';
import { motionType } from './protocol/names.js';
import { WEATHERS, CLOUDS } from './forecast.js';

// ------------------------------------------------------------ canonical bytes
// RFC 8785 (JCS) for the JSON this module produces: object keys sorted by UTF-16
// code units, no whitespace, numbers in ECMAScript's shortest round-trip form
// (which JSON.stringify already emits), strings JSON-escaped. Non-finite numbers
// and undefined are refused, as JCS requires.
export function canon(v) {
  if (v === null || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('canon: non-finite number');
    return JSON.stringify(v);
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  throw new Error(`canon: unsupported ${typeof v}`);
}

// SHA-256 (shared/sha256.js, a leaf module: protocol/hash.js imports it there, so it never cycles through this file)
import { sha256hex, sha256hexBytes } from './sha256.js';
export { sha256hex, sha256hexBytes };

// ------------------------------------------------------------ the records
// Param types: num (unit, min, max), bool, vec3, color, text, asset (a library path), ref (another entity's id), choice (a
// closed set that IS a set — a particle preset, a loop mode — not a type switch), list, json.
//
// ONE description (schema layers, 10-14): a registered component's params are DERIVED here from the registry
// (shared/protocol/componentspec.js: fields, defaults, ranges, units, docs) through its descriptor (shared/protocol/
// descriptors.js: which fields the card shows, the editor's spellings — rate, burnsAtNoon, slot — and its translations).
// This file adds no type, limit, unit or doc of its own for a registered field: paramsOf() throws if a hand entry tries.
// What a record may still say by hand is the ALIAS LAYER's own: a param the wire doesn't spell as a field (Transform's
// yaw, a Model's lib, Sockets' slots, a card's whole-value json), and READS — the value a reader uses when
// the key is absent and the registry writes nothing (a pendulum's pivot, a path's points): the descriptor's `absent` prose
// says the same in words (tools/descriptor-defaults-test.ts), and `partDefault` where a part's reading differs.
const UNIT_OF = { vec3: 'vec3', bool: 'bool', number: 'num', int: 'num', string: 'text', array: 'json', object: 'json', ref: 'ref', refs: 'list', target: 'ref', axis: 'choice', any: 'json', people: 'list', person: 'ref' };
const WIDGET_OF = { color: 'color', check: 'bool', enum: 'choice', ref: 'ref', text: 'text', num: 'num' };
const AXIS_LETTERS = Object.keys(AXES);
/** A record's params from its descriptor: every shown field with the registry's type, default (through the editor's
 *  translation), limits, unit and doc. `hand` adds the alias layer's own entries and READS (see above); it may not restate
 *  a derived fact (type, min, max, unit, hint) for a registry field. */
function paramsOf(card, hand = {}) {
  const d = DESCRIPTORS[card]; if (!d) return hand;
  const def = COMPONENTS[d.key]; const out = {};
  for (const f of d.fields) {
    if (f.path == null) { out[f.param] = hand[f.param] ?? { t: 'json', default: {} }; continue; }   // the whole-value field (spec, slots, text…) is the hand's
    const h = hand[f.param] ?? {};
    for (const k of ['min', 'max', 'unit', 'hint']) if (k in h) throw new Error(`components: ${card}.${f.param} restates ${k}; it is the registry's (componentspec ${d.key}.${f.path})`);
    // the alias layer may REFINE a registry type into its own vocabulary (a string that is a library path: asset; an array
    // of vectors: list of vec3), never contradict it
    if ('t' in h && !((h.t === 'asset' && f.t === 'string') || (h.t === 'list' && f.t === 'array'))) throw new Error(`components: ${card}.${f.param} restates t; it is the registry's (componentspec ${d.key}.${f.path})`);
    const dflt = editorDefault(card, f.k);
    const p = { t: h.t ?? (f.ui?.t ? WIDGET_OF[f.ui.t] ?? f.ui.t : UNIT_OF[f.t] ?? 'json'), default: dflt !== undefined ? dflt : (h.default ?? null) };
    if (h.of) p.of = h.of;
    if (f.t === 'vec3' && !h.t) p.t = 'vec3';   // a vec3's rows are the card's own channels; the param is the vector
    if (f.t === 'axis') { p.t = 'choice'; p.options = AXIS_LETTERS; p.custom = 'vec3'; }
    else if (def.enums?.[f.path]) { p.t = 'choice'; p.options = [...def.enums[f.path]]; }
    if ((def.required ?? []).includes(f.path)) p.required = true;
    if (f.range) Object.assign(p, f.range);
    if (f.unit) p.unit = f.unit;
    if (f.doc) p.hint = f.doc;
    for (const k of ['default', 'partDefault', 'wire', 'options', 'custom']) if (k in h && !(k === 'default' && dflt !== undefined)) p[k] = h[k];
    out[f.param] = p;
  }
  for (const [k, v] of Object.entries(hand)) if (!(k in out)) out[k] = v;   // the alias layer's own params (yaw, …)
  return out;
}
/** A world record's params from the registry's world component (sky, terrain, grass): type, limits, unit, doc; the
 *  defaults are the renderer's READS of absence (the world verbs fold wholesale; the registry writes none). */
function worldParams(key, hand) {
  const def = COMPONENTS[key]; const out = {};
  for (const [name, h] of Object.entries(hand)) {
    const t = def.fields?.[name];
    for (const k of ['t', 'min', 'max', 'unit', 'hint']) if (t && k in h) throw new Error(`components: ${key}.${name} restates ${k}; it is the registry's`);
    // a default is the registry's where it has one (shape audit 10-16: the inspector's terrain disagreed with the sim's law)
    if ('default' in h && def.defaults && name in def.defaults) throw new Error(`components: ${key}.${name} restates its default; it is the registry's`);
    const p = { ...h, t: h.t ?? (t ? UNIT_OF[t] ?? 'json' : 'json'), ...(def.defaults && name in def.defaults ? { default: def.defaults[name] } : {}) };
    if (h.options) p.t = 'choice';
    const r = def.ranges?.[name]; if (r && r.maxLen === undefined) { if (r.min !== undefined) p.min = r.min; else if (r.gt !== undefined) p.min = r.gt; if (r.max !== undefined) p.max = r.max; }
    if (def.units?.[name]) p.unit = def.units[name]; if (def.docs?.[name]) p.hint = def.docs[name];
    out[name] = p;
  }
  return out;
}
const deg = { t: 'num', deg: true };
const part = { default: null };

const DEFS = [
  { name: 'Transform', category: 'Core', builtin: true, summary: 'where it is: position, heading, size',
    params: paramsOf('Transform', { yaw: { ...deg, default: 0 } }),   // no rotOrder: the rotate order is the viewer's (PROTOCOL §9.1; client/lib/viewprefs.js)
    fallback: { text: 'at (x, y, z)' } },
  // Pivot (research 52, Roblox's PivotOffset): where it turns and scales from, in its own frame before scale. It never
  // moves the thing or changes how it draws: only the handles, the turn and the size go about it.
  { name: 'Pivot', category: 'Core', summary: 'where it turns and scales from (its own frame); never moves it',
    params: paramsOf('Pivot', { pos: { default: [0, 0, 0] } }),
    fallback: { text: 'turns about <pos>' } },
  { name: 'Model', category: 'Rendering', summary: 'a 3D model from the library',
    params: { lib: { t: 'asset', default: null, required: true } },
    fallback: { visual: 'placeholder box until the model loads', text: 'a <file stem>' } },
  { name: 'Collider', category: 'Physics', needs: ['Model'], summary: 'how bodies bump into it',
    params: paramsOf('Collider', { shape: { default: 'mesh' } }),
    fallback: { text: '(none)' }, note: 'wire: comp.collider {shape} (written by comp), or the spawn verb\'s legacy `collide`; comp.collider wins when both are present. Absent = the browser decides by size' },
  { name: 'Light', category: 'Rendering', summary: 'a point light',
    params: paramsOf('Light'),
    fallback: { visual: 'a glowing gizmo when the slot pool is spent', text: '(light)' },
    note: 'wire: comp.light {color, intensity, range, important, day} on any entity (an imported lamp is a Model and a Light)' },
  // the motions' READS: a whole thing swings and turns about its Pivot component, else its origin (shape audit 10-16; a pendulum
  // was [0, 2, 0]); a part about its own origin; an orbit's part circles at 1 m
  { name: 'Pendulum', category: 'Motion', summary: 'swings back and forth about an axis',
    params: paramsOf('Pendulum', { part, pivot: { default: [0, 0, 0], partDefault: [0, 0, 0] } }),
    fallback: { visual: 'stands still', text: 'in motion (pendulum)' } },
  { name: 'Spin', category: 'Motion', summary: 'turns steadily about an axis',
    params: paramsOf('Spin', { part, pivot: { default: [0, 0, 0] } }),
    fallback: { visual: 'stands still', text: 'in motion (spin)' } },
  { name: 'Orbit', category: 'Motion', summary: 'circles a point',
    params: paramsOf('Orbit', { part, radius: { partDefault: 1 }, center: { default: null } }),
    fallback: { visual: 'stands still', text: 'in motion (orbit)' } },
  { name: 'Oscillate', category: 'Motion', summary: 'moves back and forth along an axis (up and down: a float)',
    params: paramsOf('Oscillate', { part }),
    fallback: { visual: 'stands still', text: 'in motion (oscillate)' } },
  { name: 'Path', category: 'Motion', summary: 'follows a list of points',
    params: paramsOf('Path', { part, points: { t: 'list', of: 'vec3', default: [] }, duration: { default: null } }),
    fallback: { visual: 'stands still', text: 'in motion (path)' } },
  { name: 'Sockets', category: 'Interaction', needs: ['Model'], summary: 'attachment points: a person attaches by using one (a chair, a swing, a saddle); things attach by parent',
    params: paramsOf('Sockets', { slots: { t: 'list', of: 'seat', default: {}, hint: 'slot → {pos, yaw?, part?, body?: {action, pose, exit, who}}' } }),
    seat: { bodyDefault: [0, 0.5, 0], cargoDefault: [0, 0, 0], pose: 'sitchair' }, fallback: { text: 'attach points: <slots>' } },
  // grabbable (shared/grab.js; research RESEARCH-grab-2026-10-06): its own component, apart from physics. The spec is the
  // component's whole value; the inspector's card edits its fields, and its JSON hatch reaches grips, home and fx
  { name: 'Grabbable', category: 'Interaction', needs: ['Model'], summary: 'it can be picked up and carried: who may, how it is held (grips), where it goes when let go, what using it while held does',
    params: paramsOf('Grabbable', { spec: { t: 'json', default: {}, hint: '{who, enabled, steal, range, priority, hold, pose, grips, twoHanded, throw, release, returnAfter, home, fits, use, prompt, fx}' } }),
    fallback: { text: 'can be picked up' }, note: 'wire: the grabbable component; a dynamic thing with no grabbable is carryable by physics.who (the migration fallback)' },
  // openable (R 10-07; shared/protocol/componentspec.js): it opens and closes when used. The spec is the component's whole value; the
  // card edits open, locked, how it opens and how long it takes; its JSON hatch reaches the rest (part)
  { name: 'Openable', category: 'Interaction', summary: 'opens and closes when someone uses it: a door, a gate, a lid, a hatch',
    params: paramsOf('Openable', { spec: { t: 'json', default: {}, hint: '{open, locked, angle, axis, slide, time, part}' } }),
    fallback: { visual: 'drawn closed until a client animates it', text: 'opens (open or shut)' } },
  { name: 'Parent', category: 'Interaction', summary: 'what it rides: its parent (wire: parent, written by mount)',
    params: paramsOf('Parent', { to: { default: null }, slot: { default: null }, offset: { t: 'vec3', default: null }, yaw: { ...deg, default: null } }),
    fallback: { text: 'on <to>' } },
  // shape audit 10-16: the push that swings a pendulum was the impulse handler, reserved now; Reactions is added empty (its
  // actions are written on its card: toggle, set, play, reset, script) and needs nothing
  { name: 'Reactions', category: 'Interaction', summary: 'what a `use` does: its actions (toggle, set, play, reset, script); an Openable brings its own',
    params: paramsOf('Reactions', { actions: { t: 'json', default: {} } }), fallback: { text: 'reacts to: <actions>' } },
  // R 10-07 (v2 of Particles, a new hash, L5): the instance names an effect document (shared/particle_effects.js) and sets
  // its params; the first protocol's flat knobs are params of the Essentials now, and an older bag round-trips through
  // `extra` as every unknown key does
  { name: 'Particles', category: 'Effects', summary: 'an effect: fire, smoke, sparks… or a stored effect document',
    params: paramsOf('Particles', { effect: { options: [...ESSENTIAL_NAMES], default: null }, part: { default: null }, at: { default: [0, 0, 0] }, seed: { default: null }, params: { default: null } }),
    fallback: { visual: 'an effect this client doesn\'t know draws nothing', text: 'described by its effect' } },
  // a picture is a quad of its own; its describing text is description (R 10-27); a sound is silent at radius (cap 100)
  { name: 'Picture', category: 'Rendering', summary: 'an image: a framed picture of its own, its height from the image',
    params: paramsOf('Picture', { src: { t: 'asset', default: null } }),
    fallback: { visual: 'nothing hung', text: 'not shown: <why>' } },
  { name: 'Sound', category: 'Audio', summary: 'positional audio, silent past its radius',
    params: paramsOf('Sound', { src: { t: 'asset', default: null }, t0: { default: null } }),
    fallback: { visual: 'silent', text: 'not heard: <why>' } },
  { name: 'Story', category: 'Info', summary: 'why it is here: a title and a few paragraphs (shown on Inspect, read by agents)',
    params: paramsOf('Story', { title: { default: null }, text: { default: null }, marks: { default: null } }),
    fallback: { text: 'story «<title>»' } },
  { name: 'Text', category: 'Rendering', summary: 'words in the world: a sign',
    params: paramsOf('Text', { text: { default: null }, background: { default: null }, outlineColor: { default: null } }),
    fallback: { visual: 'a placeholder plate', text: 'a sign reading «<text>»' } },
  { name: 'Structure', category: 'Building', summary: 'walls, floors, doors and windows on a grid',
    params: { plan: { t: 'json', default: { levels: [] } } },
    fallback: { visual: 'the anchor crate', text: 'a building' }, note: 'rides a hidden anchor model today; ignores motion, mount and hidden' },
  { name: 'LookAt', category: 'Interaction', summary: 'turns to face something: a thing, the viewer, whoever is nearest',
    params: paramsOf('LookAt', { target: { default: null }, yaw: { default: null }, pitch: { default: null } }),
    fallback: { visual: 'stays at rest', text: 'turns to face <target>' } },
  { name: 'Lock', category: 'Rules', summary: 'nailed down: nobody can move, replace or remove it', params: {}, fallback: { text: '🔒 locked' } },
  { name: 'Hidden', category: 'Rendering', summary: 'not drawn, still there', params: {}, fallback: { text: '(hidden)' } },
  { name: 'Label', category: 'Core', summary: 'a display name people see', params: paramsOf('Label', { text: { t: 'text', default: '', max: COMPONENTS.label.maxLen } }), fallback: { text: 'the label' } },
  // R 10-07: how it is described to anyone who reads rather than sees; the header's, beside its name
  { name: 'Description', category: 'Core', summary: 'how it is described to anyone who reads it', params: paramsOf('Description', { text: { t: 'text', default: '', max: COMPONENTS.description.maxLen } }), fallback: { text: 'the description' } },
  { name: 'Captions', category: 'Media', readOnly: true, summary: 'live captions (written by the caption verb)', params: paramsOf('Captions', { feed: { t: 'json', default: null } }), fallback: { text: 'captions' } },
  { name: 'Stage', category: 'Media', summary: 'who is speaking (captionbot)', params: paramsOf('Stage', { speaker: { default: null } }), fallback: { text: 'components: stage' } },
  // R 10-12 (primitives): a parametric body on a thing with no model, registered bare (componentspec `mesh`); one place per
  // thing with a model and a light, as the authority refuses
  { name: 'Mesh', category: 'Rendering', summary: 'a parametric body with no model: a box, sphere, cylinder, plane or capsule, sized in metres',
    params: paramsOf('Mesh', { size: { default: [1, 1, 1] } }),
    fallback: { visual: 'a grey body', text: '(a <shape>)' },
    note: 'wire: comp.mesh {shape, size}; never beside a model or a light on one thing (give it a child). Its one material slot is \'surface\'' },
  { name: 'Annotation', category: 'Data', summary: 'any other data a world invents (recipe, notice, story…)',
    params: { type: { t: 'text', default: null, required: true }, data: { t: 'json', default: null } }, fallback: { text: 'components: <type>' } },
  // The world entity's components (design §3, shared/worldentity.js): `@world`
  // is ONE entity whose bag is these four, aliased both ways onto the fold's
  // state.sky / state.terrain / state.grass. `world: true` keeps them off every
  // other entity's Add Component; the world has exactly one of each. Their
  // defaults are the renderer's READS of absence (the sky, terrain and grass
  // verbs fold wholesale; the registry writes none); types, limits, units and
  // docs are the registry's (worldParams).
  { name: 'Sky', category: 'World', world: true, summary: 'the time of day, the clock, clouds and light',
    params: worldParams('sky', { hours: {}, rate: {}, tz: { default: null },
      clouds: { options: [...CLOUDS] },
      azimuth: {}, ambient: {}, exposure: {}, fog: {} }),
    fallback: { text: 'the sky at <hour>' }, note: 'wire: the sky verb, folded wholesale into state.sky; presets are authoring conveniences (defs/sky/_presets.json), never logged by name' },
  { name: 'Weather', category: 'World', world: true, summary: 'what the sky is doing: rain, storm, clear — or a forecast policy',
    params: worldParams('sky', { weather: { options: [...WEATHERS], default: null },
      weatherK: { default: 1 }, transition: { default: null }, forecast: { default: null }, override: { default: null } }),
    fallback: { text: 'weather <state>' }, note: 'wire: the weather verb (merges onto state.sky), and the sky verb\'s forecast policy' },
  { name: 'Terrain', category: 'World', world: true, summary: 'the terrain: its shape, size and colour',
    params: worldParams('terrain', { seed: {}, size: {}, segments: { default: 200 }, amplitude: {},
      flatRadius: {}, layers: { default: [] } }),
    fallback: { text: 'the ground' }, note: 'wire: the terrain verb, folded wholesale into state.terrain' },
  { name: 'Grass', category: 'World', world: true, summary: 'what grows on the ground',
    params: worldParams('grass', { species: { default: null }, width: { default: null }, depth: { default: null },
      density: { default: 1 }, height: { default: null }, strokes: { default: null } }),
    fallback: { text: 'grass' }, note: 'wire: the grass verb, folded wholesale into state.grass; grass {clear:true} mows it' },
];

function freeze(o) { if (o && typeof o === 'object') { Object.values(o).forEach(freeze); Object.freeze(o); } return o; }
// A record's hash covers its MEANING, not its prose (design §6): `summary`,
// `note`, every `hint` (on the record or any parameter) and `fallback.text`
// are documentation, and rewording them must not mint a new version of the
// component. Everything else — kind, v, name, params with their types,
// defaults and ranges, needs, category, the fallback's visual — is hashed.
// Exactly those places, so a parameter that happens to be NAMED note or hint
// still counts.
function meaningOf(rec) {
  const { summary: _s, note: _n, hint: _h, hash: _x, ...out } = rec;
  if (out.params) out.params = Object.fromEntries(Object.entries(out.params).map(([k, p]) => {
    if (!p || typeof p !== 'object') return [k, p];
    const { hint: _ph, ...rest } = p;
    return [k, rest];
  }));
  if (out.fallback && typeof out.fallback === 'object') { const { text: _t, ...rest } = out.fallback; out.fallback = rest; }
  return out;
}
/** The content hash of a component record: SHA-256 of the canonical JSON of
 *  its meaning (meaningOf). Exported so a test can show what does and does
 *  not move it. */
export const recordHash = (rec) => sha256hex(canon(meaningOf(rec)));
export const RECORDS = freeze(Object.fromEntries(DEFS.map((d) => {
  const rec = { kind: 'eido.component', v: 1, rung: 'engine', ...d };
  return [d.name, { ...rec, hash: recordHash(rec) }];
})));
export const CATEGORIES = [...new Set(DEFS.map((d) => d.category))];
export const recordFor = (name) => RECORDS[name] ?? null;

// ------------------------------------------------------------ aliases: old spelling ⇄ components
const MOTION = { pendulum: 'Pendulum', spin: 'Spin', orbit: 'Orbit', oscillate: 'Oscillate', path: 'Path' };
const MOTION_TYPE = Object.fromEntries(Object.entries(MOTION).map(([k, v]) => [v, k]));
// keys a motion bag may carry that are not parameters: who/when stamps the
// fold or a reaction wrote. Kept so the round trip is byte-exact.
const MOTION_STAMPS = ['t0', 'cause', 'by'];
// keys of the record that are not components: who/when the sequencer stamped
const STAMPS = ['placer', 'born', 'actor', 'ts', 'box'];
const FLAG = { lock: 'Lock' };   // the old `guard` merged into lock (PROTOCOL §5): no world carries one

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

const isBag = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
// A comp-bag Light/Collider: the bag's keys map to the record's params by their
// wire names (Light's `daytime: 'full'` is the record's burnsAtNoon, as an older
// value's `day: false` was); any other daytime (or an older day) is kept verbatim in
// `wire`, and keys the record has no param for ride `extra.unknown`, so the bytes
// always come back.
const COMP_WIRE = { Light: { color: 'color', intensity: 'intensity', range: 'range', decay: 'decay', important: 'important' }, Collider: { shape: 'shape' } };
function compInstance(type, key, data) {
  const params = {}; const extra = {}; let wire;
  for (const [k, v] of Object.entries(data)) {
    if (COMP_WIRE[type][k]) params[COMP_WIRE[type][k]] = v;
    else if (type === 'Light' && k === 'daytime') { if (v === 'full') params.burnsAtNoon = true; else wire = { ...(wire ?? {}), daytime: v }; }
    else if (type === 'Light' && k === 'day') { if (v === false) params.burnsAtNoon = true; wire = { ...(wire ?? {}), day: v }; }   // the older spelling, remembered so its bytes come back
    else (extra.unknown ??= {})[k] = v;
  }
  return { type, key, params, ...(wire ? { wire } : {}), ...(Object.keys(extra).length ? { extra } : {}) };
}
function compBag(inst) {
  const p = inst.params ?? {}; const bag = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === 'burnsAtNoon') { if (v === true) { if (inst.wire?.day !== undefined) bag.day = false; else bag.daytime = 'full'; } } else bag[k] = v;
  }
  if (inst.wire?.daytime !== undefined && bag.daytime === undefined && bag.day === undefined) bag.daytime = inst.wire.daytime;
  // an older day: true comes back as written; an older day: false only while it still burns at noon (else it was edited off)
  if (inst.wire?.day !== undefined && bag.day === undefined && bag.daytime === undefined && (inst.wire.day !== false || p.burnsAtNoon === true)) bag.day = inst.wire.day;
  return Object.assign(bag, inst.extra?.unknown ?? {});
}

/** Read a folded entity (shared/fold.js) as { components, stamps }.
 *  Every key of the record lands in exactly one place: a component instance
 *  (`{ type, key?, params, extra? }`, `key` = the comp-bag key it came from),
 *  or `stamps`. `extra` holds a bag's keys the record has no parameter for, so
 *  nothing is dropped; tools/components-corpus-test.ts counts them. */
export function componentsOf(ent) {
  if (!ent || typeof ent !== 'object') return { components: [], stamps: {} };
  ent = recordOf(ent);
  const out = [];
  const tf = pick(ent, ['pos', 'q', 'yaw', 'scale', 'scale3']);   // scale3: a stretched thing's per-axis scale (view.js), kept through the round trip
  out.push({ type: 'Transform', params: tf });
  if (ent.model !== undefined) out.push({ type: 'Model', params: { lib: ent.model } });
  if (ent.collide !== undefined) out.push({ type: 'Collider', params: { shape: ent.collide } });
  if (ent.parent !== undefined) out.push({ type: 'Parent', params: { ...ent.parent } });
  const c = recordComponents(ent);
  for (const key of Object.keys(c)) {
    const data = c[key];
    if (key === 'model' || key === 'parent') continue;   // lifted above (Model, Parent): the record is flat, so they are in c too
    if (key in FLAG) { out.push({ type: FLAG[key], key, params: {}, wire: { value: data } }); continue; }
    if (key === 'hidden') { out.push({ type: 'Hidden', key, params: {}, wire: { value: data } }); continue; }
    if (key === 'label') { out.push({ type: 'Label', key, params: { text: data } }); continue; }
    if (key === 'description' && typeof data === 'string') { out.push({ type: 'Description', key, params: { text: data } }); continue; }
    if ((key === 'motion' || key.startsWith('motion:')) && data && typeof data === 'object' && MOTION[motionType(data)]) {
      const type = MOTION[motionType(data)];   // a value stored before the rename reads as today's (and is written back in today's word)
      const known = Object.keys(RECORDS[type].params);
      const params = {}; const extra = {};
      for (const [k, v] of Object.entries(data)) {
        if (k === 'type') continue;
        if (k === 'node' && key.startsWith('motion:') && typeof v === 'string') { params.part = v; continue; }   // the node it moves (motion:<slot> {node}): the record's part
        if (known.includes(k)) params[k] = v;
        else if (type === 'Spin' && (k === 'degPerSec' || k === 'rpm')) { params.rate = v; (extra.rateKey ??= k); }
        else if (type === 'Orbit' && k === 'degPerSec') { params.rate = v; extra.rateKey = k; }
        else if ((type === 'Pendulum' || type === 'Oscillate') && k === 'amplitude') { params.amp = v; extra.ampKey = k; }
        else if (MOTION_STAMPS.includes(k)) (extra.stamps ??= {})[k] = v;
        else (extra.unknown ??= {})[k] = v;
      }
      const inst = { type, key, params };
      if (Object.keys(extra).length) inst.extra = extra;
      out.push(inst);
      continue;
    }
    // step 2 (design §6): a Light or a Collider as a component. Only a plain
    // object is one; any other data under these keys predates the meaning
    // (none in the corpus) and stays an Annotation, so its bytes still return.
    if ((key === 'light' || key === 'collider') && isBag(data)) { out.push(compInstance(key === 'light' ? 'Light' : 'Collider', key, data)); continue; }
    if (key === 'mesh' && isBag(data)) { out.push({ type: 'Mesh', key, params: { ...data } }); continue; }
    if (key === 'pivot' && isBag(data) && Array.isArray(data.pos) && data.pos.length === 3 && Object.keys(data).every((k) => k === 'pos')) { out.push({ type: 'Pivot', key, params: { pos: data.pos } }); continue; }
    const simple = { sockets: ['Sockets', 'slots'], reactions: ['Reactions', 'actions'], structure: ['Structure', 'plan'], captions: ['Captions', 'feed'], grabbable: ['Grabbable', 'spec'], openable: ['Openable', 'spec'] };
    if (simple[key]) { out.push({ type: simple[key][0], key, params: { [simple[key][1]]: data } }); continue; }
    if ((key === 'look-at' || key.startsWith('look-at:')) && isBag(data)) { out.push({ type: 'LookAt', key, params: { ...data } }); continue; }
    if (key === 'story' && isBag(data)) { out.push({ type: 'Story', key, params: { ...data } }); continue; }
    if (key === 'text' && isBag(data)) { out.push({ type: 'Text', key, params: { ...data } }); continue; }
    if (key === 'stage' && data && typeof data === 'object' && !Array.isArray(data)) { out.push({ type: 'Stage', key, params: { ...data } }); continue; }
    if ((key === 'particles' || key === 'picture' || key === 'sound') && data && typeof data === 'object' && !Array.isArray(data)) {
      const type = { particles: 'Particles', picture: 'Picture', sound: 'Sound' }[key];
      const rec = RECORDS[type];
      const params = {}; const extra = {};
      for (const [k, v] of Object.entries(data)) {
        const pk = Object.entries(rec.params).find(([name, s]) => (s.wire ?? name) === k)?.[0];
        if (pk) params[pk] = v; else (extra.unknown ??= {})[k] = v;
      }
      out.push({ type, key, params, ...(Object.keys(extra).length ? { extra } : {}) });
      continue;
    }
    out.push({ type: 'Annotation', key, params: { type: key, data } });
  }
  return { components: out, stamps: pick(ent, STAMPS) };
}

/** Write a component list back in today's spelling. The inverse of
 *  componentsOf: entityOf(componentsOf(e)) deep-equals e for every entity the
 *  corpus holds. Key order follows the fold's own order so canon() agrees. */
export function entityOf({ components, stamps = {} }) {
  const ent = {};
  const comp = {};
  for (const inst of components) {
    const p = inst.params ?? {};
    switch (inst.type) {
      case 'Transform': {
        Object.assign(ent, p);
        break;
      }
      case 'Light': {
        comp[inst.key ?? 'light'] = compBag(inst);
        break;
      }
      case 'Model': ent.model = p.lib; break;
      // keyed = comp.collider (step 2); keyless = the spawn verb's legacy `collide`
      case 'Collider': if (inst.key != null) comp[inst.key] = compBag(inst); else ent.collide = p.shape; break;
      case 'Parent': ent.parent = { ...p }; break;
      case 'Pivot': comp[inst.key ?? 'pivot'] = { pos: p.pos }; break;
      case 'Lock': case 'Hidden': comp[inst.key] = inst.wire?.value ?? true; break;
      case 'Label': comp[inst.key ?? 'label'] = p.text; break;
      case 'Description': comp[inst.key ?? 'description'] = p.text; break;
      case 'Pendulum': case 'Spin': case 'Orbit': case 'Oscillate': case 'Path': {
        const x = inst.extra ?? {};
        const bag = { type: MOTION_TYPE[inst.type] };
        for (const [k, v] of Object.entries(p)) {
          if (k === 'rate') bag[x.rateKey ?? 'degPerSec'] = v;
          else if (k === 'amp' && x.ampKey) bag[x.ampKey] = v;
          else bag[k] = v;
        }
        Object.assign(bag, x.stamps ?? {}, x.unknown ?? {});
        comp[inst.key ?? 'motion'] = bag;
        break;
      }
      case 'Sockets': comp[inst.key ?? 'sockets'] = p.slots; break;
      case 'Grabbable': comp[inst.key ?? 'grabbable'] = p.spec; break;
      case 'Openable': comp[inst.key ?? 'openable'] = p.spec; break;
      case 'Reactions': comp[inst.key ?? 'reactions'] = p.actions; break;
      case 'Structure': comp[inst.key ?? 'structure'] = p.plan; break;
      case 'Captions': comp[inst.key ?? 'captions'] = p.feed; break;
      case 'LookAt': comp[inst.key ?? 'look-at'] = { ...p }; break;
      case 'Story': comp[inst.key ?? 'story'] = { ...p }; break;
      case 'Text': comp[inst.key ?? 'text'] = { ...p }; break;
      case 'Stage': comp[inst.key ?? 'stage'] = { ...p }; break;
      case 'Mesh': comp[inst.key ?? 'mesh'] = { ...p }; break;
      case 'Particles': case 'Picture': case 'Sound': {
        const rec = RECORDS[inst.type]; const bag = {};
        for (const [k, v] of Object.entries(p)) bag[rec.params[k]?.wire ?? k] = v;
        Object.assign(bag, inst.extra?.unknown ?? {});
        comp[inst.key ?? inst.type.toLowerCase()] = bag;
        break;
      }
      case 'Annotation': comp[inst.key ?? p.type] = p.data; break;
      default: throw new Error(`entityOf: no alias for ${inst.type}`);
    }
  }
  Object.assign(ent, comp);   // components sit flat on the record (view.js, 10-14): no bag
  return { ...ent, ...stamps };
}

/** Canonical-JSON equality with key order ignored (the corpus test's oracle). */
export const sameRecord = (a, b) => canon(a) === canon(b);

/** The library, grouped for an "Add Component" menu: what may be added to
 *  this entity now (needs met, not already present unless repeatable).
 *  { unmet: true } also lists the ones whose needs are NOT met, each with
 *  `unmet: [names]` — the editor decides whether such a need is added for
 *  you or asked about (shared/editschema.js). `met(need)` may override the
 *  plain "a component of that type is present" test. */
const REPEATABLE = new Set(['Pendulum', 'Spin', 'Orbit', 'Oscillate', 'Path', 'Annotation']);
export function addable(components, { unmet = false, met = null } = {}) {
  const have = new Set(components.map((c) => c.type));
  const isMet = (n) => (met ? met(n) : have.has(n));
  const out = [];
  for (const d of DEFS) {
    if (d.builtin || d.readOnly || d.world || (!REPEATABLE.has(d.name) && have.has(d.name))) continue;
    const missing = (d.needs ?? []).filter((n) => !isMet(n));
    if (missing.length && !unmet) continue;
    out.push({ name: d.name, category: d.category, summary: d.summary, hash: RECORDS[d.name].hash, ...(missing.length ? { unmet: missing } : {}) });
  }
  return out;
}

// ------------------------------------------------------------ one reading, every surface
// The browser, the text tier and the inspector each need to ask "is this a
// light, and with what?" of an entity that may use either spelling. They ask
// HERE, so the answer (and its defaults, which are the fold's) is written once.
// the registry's light (componentspec.js), the three fields every reading needs: what the authority writes into a bare {light: {}}
export const LIGHT_DEFAULTS = Object.freeze((({ color, intensity, range }) => ({ color, intensity, range }))(materialize('light', {}).value));
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** The light an entity casts, normalized, or null: a plain-object comp.light on any entity (a bare light, or an imported
 *  lamp that is a model too). A field of the wrong type reads as its default — never a throw, never NaN reaching the rig. */
// shape audit 10-16: a value a reader can't read is that component absent (one rule with kind.js isMeshBag): an unknown
// kind is no light, never a point light. decay is part of the value (absent: the rig's old 1.7); daytime is dim | full (an
// older value's day: false is full)
export function lightOf(ent) {
  if (!ent || typeof ent !== 'object') return null;
  const src = isBag(ent?.light) ? ent.light : null;
  if (!src) return null;
  if (src.kind !== undefined && !COMPONENTS.light.enums.kind.includes(src.kind)) return null;
  // an unknown daytime drops only daytime (PROTOCOL §9.2): it reads at its meaning of absence; kind says what the light IS, so an unknown kind is no light
  const daytime = COMPONENTS.light.enums.daytime.includes(src.daytime) ? src.daytime : undefined;
  return {
    color: finite(src.color) && src.color >= 0 && src.color <= 0xffffff ? Math.round(src.color) : LIGHT_DEFAULTS.color,
    intensity: finite(src.intensity) && src.intensity >= 0 ? src.intensity : LIGHT_DEFAULTS.intensity,
    range: finite(src.range) && src.range > 0 ? src.range : LIGHT_DEFAULTS.range,
    important: src.important === true,
    decay: finite(src.decay) && src.decay >= 0 && src.decay <= 4 ? src.decay : 1.7,
    daytime: daytime ?? (src.day === false ? 'full' : 'dim'),
    // a spot's cone, glTF's half-angles (rad): angle = outer (default π/4), inner where the edge starts to soften
    // a point light is the default and says nothing more; a spot adds its kind and cone
    ...(src.kind === 'spot' ? (() => { const angle = finite(src.angle) && src.angle > 0 && src.angle <= Math.PI / 2 ? src.angle : Math.PI / 4;
      return { kind: 'spot', angle, inner: finite(src.inner) && src.inner >= 0 && src.inner < angle ? src.inner : 0 }; })() : {}),
  };
}

/** The collider preference the browser hands fitCollider: comp.collider.shape
 *  "mesh" (or the older "exact") as "exact", "box" as itself, else the legacy spawn `collide` verbatim (as
 *  the browser always passed it), else undefined (= decide by size). "sphere" is a physics request (PHYSICS §3.1): to
 *  walk on, a ball is what its size decides. */
export function colliderOf(ent) {
  const s = isBag(ent?.collider) ? ent.collider.shape : undefined;
  if (s === 'mesh' || s === 'exact') return 'exact';   // the walker's word for its triangles; `exact` is the stored word before 10-16
  if (s === 'box') return s;
  return ent?.collide;
}

/** An Empty: an entity with nothing but a Transform (and whatever comps it
 *  carries) — no model, no light, no mesh. A pivot, a group parent, a target. */
export const isEmpty = (ent) => !!ent && typeof ent === 'object' && kindOf(ent) === 'empty';

/** Why a `comp` of type light/collider would be refused, or null. The authority
 *  (server/verbs.ts vComp) and the inspector ask the same question, so a
 *  refusal reads the same from either. `data: null` (removal) is always fine.
 *  Keys a record does not name are allowed, as in every bag (annotations
 *  ride along); the ones it names must have their type. */
/** One place per thing (R 10-11): the refusal's words, the same from the authority and the Inspector. `has` is what the thing
 *  already is (model | light | mesh), `wants` what was asked for. */
export const ONE_PLACE = {
  reason: (id, has, wants) => (has === 'light' ? `${id} is a light; a ${wants} goes on its own thing${wants === 'model' ? '' : ' under it'}`
    : has === 'mesh' ? `${id} is a mesh; a ${wants} goes on its own thing${wants === 'light' ? ' under it' : ''}` : `${id} has a model; a ${wants} ${wants === 'light' ? 'goes on its own thing under it' : 'is its own thing'}`),
  fix: (id, has, wants) => (wants === 'light' ? `create {components: {light: {…}, parent: {to: '${id}'}, transform: {pos: [0, 1, 0]}}}`
    : wants === 'mesh' ? (has === 'light' ? 'create the mesh as its own thing and parent this light to it' : `create {id: '${id}-mesh', components: {mesh: {…}, parent: {to: '${id}'}}}, or delete its model first`)
    : has === 'light' ? 'create the model as its own thing and parent this light to it' : 'create the model as its own thing, or delete the mesh first'),
  socket: {
    reason: (id, comp) => `${id} is a socket (an attachment point); a ${comp} goes on its host, or on its own thing attached to it`,
    fix: (id, comp) => `put the ${comp} on the thing the socket belongs to, or create a thing with parent {to: '${id}'} and give it the ${comp}`,
  },
};
export const MESH_SHAPES = COMPONENTS.mesh.enums.shape;
export function compRefusal(type, data, ent = null) {
  if (data == null) return null;
  if (type === 'mesh') {
    if (ent?.model != null || ent?.model != null) return `${ONE_PLACE.reason('this thing', 'model', 'mesh')} (one place per thing) — ${ONE_PLACE.fix('it', 'model', 'mesh')}`;
    if (isBag(ent?.light)) return `${ONE_PLACE.reason('this thing', 'light', 'mesh')} (one place per thing) — ${ONE_PLACE.fix('it', 'light', 'mesh')}`;
    if (!isBag(data) || !MESH_SHAPES.includes(data.shape)) return `a mesh component is {shape: ${MESH_SHAPES.join('|')}, size: [x, y, z]}`;
    if (data.size !== undefined && !(Array.isArray(data.size) && data.size.length === 3 && data.size.every((x) => finite(x) && x >= 0.05 && x <= 200))) return 'mesh size is [x, y, z] in metres, each 0.05 to 200';
    return null;
  }
  if (type === 'light') {
    if (isBag(ent?.mesh)) return `${ONE_PLACE.reason('this thing', 'mesh', 'light')} (one place per thing) — Add Component ▸ Light makes that child`;
    if (!isBag(data)) return 'a light component is an object: {color?, intensity?, range?, decay?, important?, daytime?}';
    if (data.color !== undefined && !(Number.isInteger(data.color) && data.color >= 0 && data.color <= 0xffffff)) return 'light color is an integer 0…0xffffff (e.g. 16767392 for 0xffd9a0)';
    if (data.intensity !== undefined && !(finite(data.intensity) && data.intensity >= 0)) return 'light intensity is a number ≥ 0';
    if (data.range !== undefined && !(finite(data.range) && data.range > 0)) return 'light range is a number of metres > 0';
    if (data.important !== undefined && typeof data.important !== 'boolean') return 'light important is true or false';
    if (data.day !== undefined && typeof data.day !== 'boolean') return 'light day is true or false (false = burns at noon; it is stored as daytime)';
    if (data.daytime !== undefined && !COMPONENTS.light.enums.daytime.includes(data.daytime)) return 'light daytime is dim (follows the day) or full (burns at noon too)';
    if (data.decay !== undefined && !(finite(data.decay) && data.decay >= 0 && data.decay <= 4)) return 'light decay is a falloff exponent 0..4 (2 = inverse square)';
    return null;
  }
  if (type === 'collider') {
    if (!isBag(data) || (data.shape !== 'mesh' && data.shape !== 'exact' && data.shape !== 'box' && data.shape !== 'sphere')) return 'a collider component is {shape: "mesh"} (its triangles), {shape: "box"} (its bounding box) or {shape: "sphere"} (a ball, for physics); remove it (data: null) to let the size decide';
    return null;
  }
  return null;
}

/** A socket's body block (shared by the authority, the client and the agent): present = a person can attach there by
 *  using it. The whole shape and its defaults live in shared/sockbody.js; read here so every consumer has one name. */
export { bodyOf } from './sockbody.js';

/** A socket's full rotation in its thing's frame (Unreal sockets: a transform, not a heading): a rocket's seat lies
 *  on its back, a bunk lies flat. A socket written with a bare yaw is read the same way. */
export const socketQ = (sock) => qNorm(sock?.q) ?? qFromYaw(Number.isFinite(sock?.yaw) ? sock.yaw : 0);
