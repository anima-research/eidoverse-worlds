// shared/components.js — the component library, engine rung (RFC #208 steps 3–4, data-only).
//
// An entity is a Transform plus a list of components. Each component type is an
// immutable, content-addressed RECORD: a name, a parameter schema (type, default,
// range, unit), what it needs, what an old client shows instead, and the line a
// text-tier resident reads. No record carries code; the realizers that give the
// built-ins behaviour are the engine's own.
//
// Every spelling the wire has ever had is an ALIAS here (design §2.4, §6):
// the old ones (`lib`, `kind: "light"`, `collide`, `parent`, `comp.motion`
// with its `type` enum, `comp.sockets`, …) and the step-2 ones (`comp.light`
// on any entity, `comp.collider`, and the Empty — a spawn with no `lib`).
// `componentsOf` reads any folded entity as a component list, and `entityOf`
// writes a component list back to exactly those bytes; an instance's `key`
// says which spelling it came from (a Light with no key is `kind: "light"`, a
// Light with key "light" is `comp.light`). Nothing in an existing world is
// rewritten (RFC: updates are offered, never applied);
// tools/components-corpus-test.ts proves the round trip on every local world.
//
// Pure: no DOM, no three, no I/O. Server, browser, mcpl and tests import it.

import { ROT_MODES } from './euler.js';
import { qNorm, qFromYaw } from './rot.js';
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

// SHA-256, synchronous and dependency-free so a record's hash is the same
// function in bun, the browser and the agent (crypto.subtle is async).
const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
export function sha256hex(str) { return sha256hexBytes(new TextEncoder().encode(str)); }
/** SHA-256 of raw bytes (a v4 chain step hashes two digests, which aren't UTF-8 text). */
export function sha256hexBytes(bytes) {
  const n =((bytes.length + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(n); m.set(bytes); m[bytes.length] = 0x80;
  const bits = bytes.length * 8;
  const dv = new DataView(m.buffer);
  dv.setUint32(n - 8, Math.floor(bits / 2 ** 32)); dv.setUint32(n - 4, bits >>> 0);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rotr = (x, r) => (x >>> r) | (x << (32 - r));
  for (let o = 0; o < n; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return [...H].map((x) => x.toString(16).padStart(8, '0')).join('');
}

// ------------------------------------------------------------ the records
// Param types: num (unit, min, max, softMax, deg), bool, vec3, color, text,
// asset (a library path), ref (another entity's id), choice (a closed set that
// IS a set — a particle preset, a loop mode — not a type switch), list, json.
// `default` is the value the engine's realizer applies when the key is absent;
// where today's code applies two different defaults by scope, the record says
// both (`partDefault`) rather than pretending there is one.
const deg = { t: 'num', deg: true, step: 5 };
const axis = (d) => ({ t: 'choice', options: ['x', 'y', 'z', '-x', '-y', '-z'], default: d, custom: 'vec3' });
const part = { t: 'text', default: null, hint: 'a named node of the model; empty = the whole thing' };

const DEFS = [
  { name: 'Transform', category: 'Core', builtin: true, summary: 'where it is: position, heading, size',
    params: { pos: { t: 'vec3', unit: 'm', default: [0, 0, 0] }, q: { t: 'quat', default: [0, 0, 0, 1], hint: 'full orientation (shared/rot.js); yaw is its friendly subset' }, yaw: { ...deg, default: 0 }, scale: { t: 'num', default: 1, min: 0.01, softMax: 12, step: 0.05 },
      rotOrder: { t: 'choice', options: ROT_MODES, default: 'XYZ', wire: 'comp.rotOrder', hint: 'how the Rotate channels read q (Maya\'s rotateOrder: XYZ = X applied first); quat = edit the quaternion. Never moves the thing' } },
    fallback: { text: 'at (x, y, z)' } },
  // Pivot (research 52, Roblox's PivotOffset): where it turns and scales from, in its own frame before scale. It never
  // moves the thing or changes how it draws: only the handles, the turn and the size go about it.
  { name: 'Pivot', category: 'Core', summary: 'where it turns and scales from (its own frame); never moves it',
    params: { pos: { t: 'vec3', unit: 'm', default: [0, 0, 0], hint: 'in its own frame, before scale: [0, 0, 0] is its origin' } },
    fallback: { text: 'turns about <pos>' } },
  { name: 'Model', category: 'Rendering', summary: 'a 3D model from the library',
    params: { lib: { t: 'asset', default: null, required: true } },
    fallback: { visual: 'placeholder box until the model loads', text: 'a <file stem>' } },
  { name: 'Collider', category: 'Physics', needs: ['Model'], summary: 'how bodies bump into it',
    params: { shape: { t: 'choice', options: ['exact', 'box'], default: 'exact' } },
    fallback: { text: '(none)' }, note: 'wire: comp.collider {shape} (written by comp), or the spawn verb\'s legacy `collide`; comp.collider wins when both are present. Absent = the browser decides by size' },
  { name: 'Light', category: 'Rendering', summary: 'a point light',
    params: { color: { t: 'color', default: 0xffd9a0 }, intensity: { t: 'num', default: 16, min: 0, softMax: 64, step: 1 }, range: { t: 'num', unit: 'm', default: 10, min: 1, softMax: 40, step: 1 },
      important: { t: 'bool', default: false, hint: 'always casts: first claim on a light slot, never shed by the governor' }, burnsAtNoon: { t: 'bool', default: false, hint: 'opts out of the day cycle (wire: day:false)' } },
    fallback: { visual: 'a glowing gizmo when the slot pool is spent', text: '(light)' },
    note: 'wire: comp.light {color, intensity, range, important, day} on any entity (a lamp is a Model and a Light), or the light verb\'s legacy kind:"light" entity; the legacy spelling wins when both are present' },
  { name: 'Pendulum', category: 'Motion', summary: 'swings back and forth about an axis',
    params: { part, axis: axis('x'), amp: { ...deg, default: 0, min: 0 }, period: { t: 'num', unit: 's', default: 3.5, min: 0.05, step: 0.1 }, pivot: { t: 'vec3', unit: 'm', default: [0, 2, 0], partDefault: [0, 0, 0], hint: 'the point it swings about, in its own frame' }, phase: { ...deg, default: 0 }, damp: { t: 'num', default: 0, min: 0, softMax: 2, step: 0.01 }, maxAmp: { t: 'num', default: 1.1, hint: 'cap on a push (server reaction only), radians' } },
    fallback: { visual: 'stands still', text: 'in motion (pendulum)' } },
  { name: 'Spin', category: 'Motion', summary: 'turns steadily about an axis',
    params: { part, axis: axis('y'), rate: { t: 'num', unit: '°/s', default: 36, step: 5 }, pivot: { t: 'vec3', unit: 'm', default: [0, 0, 0] }, phase: { ...deg, default: 0 } },
    fallback: { visual: 'stands still', text: 'in motion (spin)' } },
  { name: 'Orbit', category: 'Motion', summary: 'circles a point',
    params: { part, radius: { t: 'num', unit: 'm', default: 3, partDefault: 1, min: 0, step: 0.1 }, center: { t: 'vec3', unit: 'm', default: null, hint: 'what it circles; absent = where it stands' }, rate: { t: 'num', unit: '°/s', default: 12, step: 5 }, phase: { ...deg, default: 0 }, face: { t: 'bool', default: true, hint: 'face along the circle' } },
    fallback: { visual: 'stands still', text: 'in motion (orbit)' } },
  { name: 'Bob', category: 'Motion', summary: 'floats up and down',
    params: { part, axis: axis('y'), amp: { t: 'num', unit: 'm', default: 0.3, min: 0, step: 0.05 }, period: { t: 'num', unit: 's', default: 4, min: 0.05, step: 0.1 }, phase: { ...deg, default: 0 } },
    fallback: { visual: 'stands still', text: 'in motion (bob)' } },
  { name: 'Path', category: 'Motion', summary: 'follows a list of points',
    params: { part, points: { t: 'list', of: 'vec3', default: [] }, speed: { t: 'num', unit: 'm/s', default: 1, min: 0 }, duration: { t: 'num', unit: 's', default: null, hint: 'instead of speed' },
      loop: { t: 'choice', options: ['loop', 'pingpong', 'once'], default: 'loop' }, face: { t: 'bool', default: true } },
    fallback: { visual: 'stands still', text: 'in motion (path)' } },
  { name: 'Sockets', category: 'Interaction', needs: ['Model'], summary: 'attachment points: a person attaches by using one (a chair, a swing, a saddle); things attach by parent',
    params: { slots: { t: 'list', of: 'seat', default: {}, hint: 'slot → {pos, yaw?, part?, body?: {action, pose, exit, who}}' } },
    seat: { bodyDefault: [0, 0.5, 0], cargoDefault: [0, 0, 0], pose: 'sitchair' }, fallback: { text: 'attach points: <slots>' } },
  // grabbable (shared/grab.js; research RESEARCH-grab-2026-10-06): its own component, apart from physics. The spec is the
  // component's whole value; the inspector's card edits its fields, and its JSON hatch reaches grips, home and fx
  { name: 'Grabbable', category: 'Interaction', needs: ['Model'], summary: 'it can be picked up and carried: who may, how it is held (grips), where it goes when let go, what using it while held does',
    params: { spec: { t: 'json', default: {}, hint: '{who, enabled, steal, range, priority, hold, pose, grips, twoHanded, throw, release, returnAfter, home, fits, use, prompt, fx}' } },
    fallback: { text: 'can be picked up' }, note: 'wire: the grabbable component; a dynamic thing with no grabbable is carryable by physics.who (the migration fallback)' },
  // openable (R 10-07; shared/protocol/componentspec.js): it opens and closes when used. The spec is the component's whole value; the
  // card edits open, locked, how it opens and how long it takes; its JSON hatch reaches the rest (part)
  { name: 'Openable', category: 'Interaction', summary: 'opens and closes when someone uses it: a door, a gate, a lid, a hatch',
    params: { spec: { t: 'json', default: {}, hint: '{open, locked, angle, axis, slide, time, part}' } },
    fallback: { visual: 'drawn closed until a client animates it', text: 'opens (open or shut)' } },
  { name: 'Parent', category: 'Interaction', summary: 'what it rides: its parent (wire: parent, written by mount)',
    params: { to: { t: 'ref', default: null, required: true }, slot: { t: 'text', default: null }, offset: { t: 'vec3', default: null }, yaw: { ...deg, default: null } },
    fallback: { text: 'on <to>' } },
  { name: 'Reactions', category: 'Interaction', needs: ['Pendulum'], summary: 'what a `use` does (added here: a push that swings it; an Openable brings its own)',
    params: { actions: { t: 'json', default: {} } }, fallback: { text: 'reacts to: <actions>' } },
  { name: 'Particles', category: 'Effects', summary: 'fire, smoke, sparks…',
    params: { preset: { t: 'choice', options: ['fire', 'sparks', 'embers', 'smoke', 'dust', 'snow', 'magic', 'stars', 'muzzle'], default: null, required: true },
      seed: { t: 'num', default: null, hint: 'from the id when absent' }, origin: { t: 'vec3', unit: 'm', default: [0, 0, 0], min: -8, max: 8 },
      count: { t: 'num', default: null, presetDefault: true, min: 1, max: 600 }, size: { t: 'num', default: null, presetDefault: true, min: 0.005 },
      opacity: { t: 'num', default: null, presetDefault: true, min: 0, max: 1 }, speed: { t: 'num', default: null, presetDefault: true, min: 0.05 },
      lifetime: { t: 'num', unit: 's', default: null, presetDefault: true, max: 30 }, area: { t: 'json', default: null }, texture: { t: 'asset', default: null },
      quality: { t: 'choice', options: ['auto', 'high', 'med', 'low'], default: 'auto' } },
    fallback: { visual: 'an unknown preset draws nothing', text: 'described by preset' } },
  // batch 2 (10-07): v2 of Picture and Sound (new hashes, L5): a picture needs no model (no part = a quad of its own),
  // `look` became `alt`; a sound is silent at radius (cap 100), with near, pitch and spatial
  { name: 'Picture', category: 'Rendering', summary: 'an image: on a part of its model, or a framed picture of its own',
    params: { src: { t: 'asset', default: null, required: true, hint: 'store/images/…, eidoverse/assets/…, or an https link' }, part: { t: 'text', default: null, hint: 'absent = a picture of its own (a quad facing its front)' },
      width: { t: 'num', unit: 'm', default: 1, min: 0.01, max: 20 }, alt: { t: 'text', default: null, max: 200, hint: 'Alternative text: describes this for people who can\'t see it, and for agents' },
      lit: { t: 'choice', options: ['scene', 'self'], default: 'scene' }, flip: { t: 'bool', default: false } },
    fallback: { visual: 'nothing hung', text: 'not shown: <why>' } },
  { name: 'Sound', category: 'Audio', summary: 'positional audio, silent past its radius',
    params: { src: { t: 'asset', default: null, required: true, hint: 'store/audio/…, eidoverse/assets/…, or an https link' }, playing: { t: 'bool', default: true }, loop: { t: 'bool', default: true }, volume: { t: 'num', default: 0.8, min: 0, max: 1 },
      pitch: { t: 'num', default: 1, min: 0.5, max: 2 }, near: { t: 'num', unit: 'm', default: 1.5, min: 0.01, max: 100, hint: 'full volume inside it' },
      radius: { t: 'num', unit: 'm', default: 12, min: 1, max: 100, hint: 'silent at and beyond it' }, spatial: { t: 'bool', default: true, hint: 'off: heard evenly inside radius, no panning' },
      t0: { t: 'num', default: null, hint: 'shared playhead start (stamped by the authority)' },
      alt: { t: 'text', default: null, max: 200, hint: 'Alternative text: describes this for people who can\'t hear it, and for agents' } },
    fallback: { visual: 'silent', text: 'not heard: <why>' } },
  { name: 'Story', category: 'Info', summary: 'why it is here: a title and a few paragraphs (shown on Inspect, read by agents)',
    params: { title: { t: 'text', default: null, required: true, max: 80 }, text: { t: 'text', default: null, required: true, max: 1000 }, marks: { t: 'list', of: 'ref', default: null, hint: 'what it marks or commemorates (≤ 8)' } },
    fallback: { text: 'story «<title>»' } },
  { name: 'Text', category: 'Rendering', summary: 'words in the world: a sign',
    params: { text: { t: 'text', default: null, required: true, max: 400 }, size: { t: 'num', unit: 'm', default: 0.15, min: 0.02, max: 2 }, width: { t: 'num', unit: 'm', default: 2, min: 0.1, max: 10 },
      align: { t: 'choice', options: ['left', 'center', 'right'], default: 'center' }, color: { t: 'color', default: 0xffffff }, outline: { t: 'bool', default: true },
      background: { t: 'color', default: null }, billboard: { t: 'choice', options: ['off', 'yaw', 'full'], default: 'off' }, lit: { t: 'choice', options: ['self', 'scene'], default: 'self' } },
    fallback: { visual: 'a placeholder plate', text: 'a sign reading «<text>»' } },
  { name: 'Structure', category: 'Building', summary: 'walls, floors, doors and windows on a grid',
    params: { plan: { t: 'json', default: { levels: [] } } },
    fallback: { visual: 'the anchor crate', text: 'a building' }, note: 'rides a hidden anchor model today; ignores motion, mount and hidden' },
  { name: 'LookAt', category: 'Interaction', summary: 'turns to face something: a thing, the viewer, whoever is nearest',
    params: { target: { t: 'ref', default: null, required: true }, mode: { t: 'choice', options: ['yaw', 'aim'], default: 'yaw' }, forward: { t: 'choice', options: ['x', 'y', 'z', '-x', '-y', '-z'], default: 'z' },
      up: { t: 'choice', options: ['x', 'y', 'z', '-x', '-y', '-z'], default: 'y' }, yaw: { t: 'json', default: null }, pitch: { t: 'json', default: null },
      speed: { t: 'num', unit: '°/s', default: 240, min: 0, max: 3600 }, range: { t: 'num', unit: 'm', default: 12, min: 0.01, max: 100 }, offset: { t: 'vec3', default: [0, 0, 0] } },
    fallback: { visual: 'stays at rest', text: 'turns to face <target>' } },
  { name: 'Lock', category: 'Rules', summary: 'nailed down: nobody can move, replace or remove it', params: {}, fallback: { text: '🔒 locked' } },
  { name: 'Hidden', category: 'Rendering', summary: 'not drawn, still there', params: {}, fallback: { text: '(hidden)' } },
  { name: 'Label', category: 'Core', summary: 'a display name people see', params: { text: { t: 'text', default: '', max: 80 } }, fallback: { text: 'the label' } },
  { name: 'Captions', category: 'Media', readOnly: true, summary: 'live captions (written by the caption verb)', params: { feed: { t: 'json', default: null } }, fallback: { text: 'captions' } },
  { name: 'Stage', category: 'Media', summary: 'who is speaking (captionbot)', params: { speaker: { t: 'text', default: null } }, fallback: { text: 'components: stage' } },
  { name: 'Annotation', category: 'Data', summary: 'any other data a world invents (recipe, notice, story…)',
    params: { type: { t: 'text', default: null, required: true }, data: { t: 'json', default: null } }, fallback: { text: 'components: <type>' } },
  // The world entity's components (design §3, shared/worldentity.js): `@world`
  // is ONE entity whose bag is these four, aliased both ways onto the fold's
  // state.sky / state.terrain / state.grass. `world: true` keeps them off every
  // other entity's Add Component; the world has exactly one of each.
  { name: 'Sky', category: 'World', world: true, summary: 'the time of day, the clock, clouds and light',
    params: { hours: { t: 'num', unit: 'h', default: 12, min: 0, max: 24 }, rate: { t: 'num', default: 0, min: 0, softMax: 48, hint: 'world hours per real hour; 0 = the sun stands still' },
      clock: { t: 'choice', options: ['real'], default: null, hint: 'real = the hour IS a timezone\'s wall hour' }, tz: { t: 'text', default: null },
      clouds: { t: 'choice', options: [...CLOUDS], default: 'cumulus' },
      azimuth: { t: 'num', unit: '°', default: 180 }, sun: { t: 'num', default: 1 }, ambient: { t: 'num', default: 1 }, fill: { t: 'num', default: 1 },
      exposure: { t: 'num', default: 1 }, fog: { t: 'num', default: 1 }, dormantRated: { t: 'json', default: null, hint: 'the rated clock parked under a real clock' } },
    fallback: { text: 'the sky at <hour>' }, note: 'wire: the sky verb, folded wholesale into state.sky; presets are authoring conveniences (defs/sky/_presets.json), never logged by name' },
  { name: 'Weather', category: 'World', world: true, summary: 'what the sky is doing: rain, storm, clear — or a forecast policy',
    params: { weather: { t: 'choice', options: [...WEATHERS], default: null },
      weatherK: { t: 'num', default: 1 }, weatherSeconds: { t: 'num', unit: 's', default: null }, forecast: { t: 'json', default: null }, override: { t: 'json', default: null, hint: 'a manual weather inside a forecast segment (stamped by the fold)' } },
    fallback: { text: 'weather <state>' }, note: 'wire: the weather verb (merges onto state.sky), and the sky verb\'s forecast policy' },
  { name: 'Terrain', category: 'World', world: true, summary: 'the terrain: its shape, size and colour',
    params: { seed: { t: 'num', default: 7 }, size: { t: 'num', unit: 'm', default: 160 }, segments: { t: 'num', default: 200 }, amplitude: { t: 'num', unit: 'm', default: 0 },
      flatRadius: { t: 'num', unit: 'm', default: 16 }, layers: { t: 'json', default: [] } },
    fallback: { text: 'the ground' }, note: 'wire: the terrain verb, folded wholesale into state.terrain' },
  { name: 'Grass', category: 'World', world: true, summary: 'what grows on the ground',
    params: { species: { t: 'text', default: null }, preset: { t: 'text', default: null }, width: { t: 'num', unit: 'm', default: null }, depth: { t: 'num', unit: 'm', default: null },
      density: { t: 'num', default: 1 }, height: { t: 'num', unit: 'm', default: null } },
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
const MOTION = { pendulum: 'Pendulum', spin: 'Spin', orbit: 'Orbit', bob: 'Bob', path: 'Path' };
const MOTION_TYPE = Object.fromEntries(Object.entries(MOTION).map(([k, v]) => [v, k]));
// keys a motion bag may carry that are not parameters: who/when stamps the
// fold or a reaction wrote. Kept so the round trip is byte-exact.
const MOTION_STAMPS = ['t0', 'cause', 'by'];
// keys of the record that are not components: who/when the sequencer stamped
const STAMPS = ['placer', 'born', 'actor', 'ts', 'box'];
const FLAG = { lock: 'Lock' };   // the old `guard` merged into lock (PROTOCOL-v4 §5): no world carries one

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

const isBag = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
// A comp-bag Light/Collider: the bag's keys map to the record's params by their
// wire names (Light's `day: false` is the record's burnsAtNoon, as on the legacy
// spelling); a `day` other than false is kept verbatim in `wire`, and keys the
// record has no param for ride `extra.unknown`, so the bytes always come back.
const COMP_WIRE = { Light: { color: 'color', intensity: 'intensity', range: 'range', important: 'important' }, Collider: { shape: 'shape' } };
function compInstance(type, key, data) {
  const params = {}; const extra = {}; let wire;
  for (const [k, v] of Object.entries(data)) {
    if (COMP_WIRE[type][k]) params[COMP_WIRE[type][k]] = v;
    else if (type === 'Light' && k === 'day') { if (v === false) params.burnsAtNoon = true; else wire = { day: v }; }
    else (extra.unknown ??= {})[k] = v;
  }
  return { type, key, params, ...(wire ? { wire } : {}), ...(Object.keys(extra).length ? { extra } : {}) };
}
function compBag(inst) {
  const p = inst.params ?? {}; const bag = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === 'burnsAtNoon') { if (v === true) bag.day = false; } else bag[k] = v;
  }
  if (inst.wire?.day !== undefined && bag.day === undefined) bag.day = inst.wire.day;
  return Object.assign(bag, inst.extra?.unknown ?? {});
}

/** Read a folded entity (shared/fold.js) as { components, stamps }.
 *  Every key of the record lands in exactly one place: a component instance
 *  (`{ type, key?, params, extra? }`, `key` = the comp-bag key it came from),
 *  or `stamps`. `extra` holds a bag's keys the record has no parameter for, so
 *  nothing is dropped; tools/components-corpus-test.ts counts them. */
export function componentsOf(ent) {
  if (!ent || typeof ent !== 'object') return { components: [], stamps: {} };
  const out = [];
  const tf = pick(ent, ['pos', 'q', 'yaw', 'scale', 'scale3']);   // scale3: a stretched thing's per-axis scale (view.js), kept through the round trip
  // rotOrder rides the comp bag (written by `comp`, so it folds blind on every
  // client and replays; design §3) but belongs to the Transform: a valid one is
  // read here, and anything else under that key stays an Annotation below
  const ro = ent.comp?.rotOrder;
  const hasOrder = typeof ro === 'string' && ROT_MODES.includes(ro);
  if (hasOrder) tf.rotOrder = ro;
  out.push({ type: 'Transform', params: tf });
  if (ent.kind === 'light') {
    const p = pick(ent, ['color', 'intensity', 'range']);
    if (ent.keep !== undefined) p.important = ent.keep;   // the legacy kind:"light" entity's own spelling
    if (ent.day === false) p.burnsAtNoon = true;
    // the fold stores `day` only as false; any other stored value is kept as-is
    out.push({ type: 'Light', params: p, ...(ent.day !== undefined && ent.day !== false ? { wire: { day: ent.day } } : {}) });
  }
  if (ent.lib !== undefined) out.push({ type: 'Model', params: { lib: ent.lib } });
  if (ent.collide !== undefined) out.push({ type: 'Collider', params: { shape: ent.collide } });
  if (ent.parent !== undefined) out.push({ type: 'Parent', params: { ...ent.parent } });
  const c = ent.comp ?? {};
  for (const key of Object.keys(c)) {
    const data = c[key];
    if (key === 'rotOrder' && hasOrder) continue;   // the Transform's (above)
    if (key in FLAG) { out.push({ type: FLAG[key], key, params: {}, wire: { value: data } }); continue; }
    if (key === 'hidden') { out.push({ type: 'Hidden', key, params: {}, wire: { value: data } }); continue; }
    if (key === 'label') { out.push({ type: 'Label', key, params: { text: data } }); continue; }
    if ((key === 'motion' || key.startsWith('motion:')) && data && typeof data === 'object' && MOTION[data.type]) {
      const type = MOTION[data.type];
      const known = Object.keys(RECORDS[type].params);
      const params = {}; const extra = {};
      for (const [k, v] of Object.entries(data)) {
        if (k === 'type') continue;
        if (known.includes(k)) params[k] = v;
        else if (type === 'Spin' && (k === 'degPerSec' || k === 'rpm')) { params.rate = v; (extra.rateKey ??= k); }
        else if (type === 'Orbit' && k === 'degPerSec') { params.rate = v; extra.rateKey = k; }
        else if ((type === 'Pendulum' || type === 'Bob') && k === 'amplitude') { params.amp = v; extra.ampKey = k; }
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
        const { rotOrder, ...tf } = p;
        Object.assign(ent, tf);
        if (rotOrder !== undefined) comp.rotOrder = rotOrder;
        break;
      }
      case 'Light': {
        // keyed = comp.light (step 2); keyless = the legacy kind:"light" entity
        if (inst.key != null) { comp[inst.key] = compBag(inst); break; }
        ent.kind = 'light';
        Object.assign(ent, pick(p, ['color', 'intensity', 'range']));
        if (p.important !== undefined) ent.keep = p.important;   // the legacy entity's spelling
        if (p.burnsAtNoon === true) ent.day = false;
        else if (inst.wire?.day !== undefined) ent.day = inst.wire.day;
        break;
      }
      case 'Model': ent.lib = p.lib; break;
      // keyed = comp.collider (step 2); keyless = the spawn verb's legacy `collide`
      case 'Collider': if (inst.key != null) comp[inst.key] = compBag(inst); else ent.collide = p.shape; break;
      case 'Parent': ent.parent = { ...p }; break;
      case 'Pivot': comp[inst.key ?? 'pivot'] = { pos: p.pos }; break;
      case 'Lock': case 'Hidden': comp[inst.key] = inst.wire?.value ?? true; break;
      case 'Label': comp[inst.key ?? 'label'] = p.text; break;
      case 'Pendulum': case 'Spin': case 'Orbit': case 'Bob': case 'Path': {
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
  if (Object.keys(comp).length) ent.comp = comp;
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
const REPEATABLE = new Set(['Pendulum', 'Spin', 'Orbit', 'Bob', 'Path', 'Annotation']);
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
export const LIGHT_DEFAULTS = Object.freeze({ color: 0xffd9a0, intensity: 16, range: 10 });
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** The light an entity casts, normalized, or null. Either spelling:
 *  kind:"light" (the light verb; the fold already defaulted its fields) or a
 *  plain-object comp.light on any other entity. When both are present the
 *  legacy kind:"light" wins (the authority refuses `comp light` on such an entity;
 *  this rule is for hand-written logs). A comp.light field of the wrong type
 *  reads as its default — never a throw, never NaN reaching the rig. */
export function lightOf(ent) {
  if (!ent || typeof ent !== 'object') return null;
  const legacy = ent.kind === 'light';
  const src = legacy ? ent : (isBag(ent.comp?.light) ? ent.comp.light : null);
  if (!src) return null;
  return {
    spelling: legacy ? 'kind' : 'comp',
    color: finite(src.color) && src.color >= 0 && src.color <= 0xffffff ? Math.round(src.color) : LIGHT_DEFAULTS.color,
    intensity: finite(src.intensity) && src.intensity >= 0 ? src.intensity : LIGHT_DEFAULTS.intensity,
    range: finite(src.range) && src.range > 0 ? src.range : LIGHT_DEFAULTS.range,
    important: (legacy ? src.keep : src.important) === true,
    day: src.day !== false,
    // a spot's cone, glTF's half-angles (rad): angle = outer (default π/4), inner where the edge starts to soften
    // a point light is the default and says nothing more; a spot adds its kind and cone
    ...(src.kind === 'spot' ? (() => { const angle = finite(src.angle) && src.angle > 0 && src.angle <= Math.PI / 2 ? src.angle : Math.PI / 4;
      return { kind: 'spot', angle, inner: finite(src.inner) && src.inner >= 0 && src.inner < angle ? src.inner : 0 }; })() : {}),
  };
}

/** The collider preference the browser hands fitCollider: comp.collider.shape
 *  when it is "exact" or "box", else the legacy spawn `collide` verbatim (as
 *  the browser always passed it), else undefined (= decide by size). */
export function colliderOf(ent) {
  const s = isBag(ent?.comp?.collider) ? ent.comp.collider.shape : undefined;
  if (s === 'exact' || s === 'box') return s;
  return ent?.collide;
}

/** An Empty: an entity with nothing but a Transform (and whatever comps it
 *  carries) — no model, not a legacy light. A pivot, a group parent, a target. */
export const isEmpty = (ent) => !!ent && typeof ent === 'object' && ent.kind !== 'light' && ent.lib == null;

/** Why a `comp` of type light/collider would be refused, or null. The authority
 *  (server/verbs.ts vComp) and the inspector ask the same question, so a
 *  refusal reads the same from either. `data: null` (removal) is always fine.
 *  Keys a record does not name are allowed, as in every bag (annotations
 *  ride along); the ones it names must have their type. */
export function compRefusal(type, data, ent = null) {
  if (data == null) return null;
  if (type === 'light') {
    if (ent?.kind === 'light') return 'this is already a light (made with the light verb) — change it with light {id, …}; a light component is for things that are not lights yet (a lamp model, an Empty)';
    if (!isBag(data)) return 'a light component is an object: {color?, intensity?, range?, important?, day?}';
    if (data.color !== undefined && !(Number.isInteger(data.color) && data.color >= 0 && data.color <= 0xffffff)) return 'light color is an integer 0…0xffffff (e.g. 16767392 for 0xffd9a0)';
    if (data.intensity !== undefined && !(finite(data.intensity) && data.intensity >= 0)) return 'light intensity is a number ≥ 0';
    if (data.range !== undefined && !(finite(data.range) && data.range > 0)) return 'light range is a number of metres > 0';
    if (data.important !== undefined && typeof data.important !== 'boolean') return 'light important is true or false';
    if (data.day !== undefined && typeof data.day !== 'boolean') return 'light day is true or false (false = burns at noon)';
    return null;
  }
  if (type === 'rotOrder') {
    if (!ROT_MODES.includes(data)) return `a rotation order is one of ${ROT_MODES.join(', ')} (Maya's rotateOrder: XYZ applies X first; quat edits the quaternion); remove it (data: null) for XYZ`;
    return null;
  }
  if (type === 'collider') {
    if (!isBag(data) || (data.shape !== 'exact' && data.shape !== 'box')) return 'a collider component is {shape: "exact"} (its triangles) or {shape: "box"} (its bounding box); remove it (data: null) to let the size decide';
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
