// shared/particle_effects.js — what a particle EFFECT is: the document a `particles` component names, its limits, the
// Essentials (the built-in effects, by name), its params, and how an older value reads. Pure: the authority, every
// client, mcpl and the translator import it, so they can't disagree about what an effect says or whether it's allowed.
//
// The instance is tiny (R 10-07, the Niagara / Godot / bevy_hanabi convergence): `particles {effect, part?, at?, seed?,
// playing?, scale?, params?}`. `effect` names a document: an Essentials name ("fire") or a content address of one stored
// in the world ("sha256:<64 hex>", or the same bytes as "eido:sha256/<64 hex>": spec/EIDO-URIS.md; a document is stored
// as its JCS bytes, so the two spellings name the same document). The document describes emitters as modules, in Godot's
// ParticleProcessMaterial vocabulary (shared/particlesim.js runs it):
//
//   {kind: "particle-effect", v: 1, name?, reads?, emitters: [Emitter, …] (1–4), params?: {<name>: Param, …} (≤ 16)}
//   Emitter = {
//     spawn:    {amount (1–600), lifetime (s), lifetimeRandom? 0..1, explosiveness? 0..1, randomness? 0..1, oneShot?,
//                preprocess? (s simulated before the first frame), speedScale?, ratio? 0..1 (the share of amount drawn)},
//     shape?:   {type: point | sphere | sphere-surface | box | ring, extents? [x, y, z] (m: a sphere's semi-axes, a box's
//                half-sizes), radius? (a round sphere), ring: radius, inner, height, cone (°), axis},
//     velocity?:{direction? [x, y, z], spread? (°), flatness? 0..1, speed? [min, max] (m/s)}  |  {min: [x,y,z], max: [x,y,z]},
//     forces?:  {gravity? [x, y, z] (m/s²), linear?, radial?, tangential? ([min, max] m/s²), damping? ([min, max] m/s²)},
//     rotation?:{angle? [min, max] (°), velocity? [min, max] (°/s)},
//     size?:    {base (m, a quad's side), random? [min, max] (×), curve? [[t, ×], …] over life},
//     color?:   {base? 0xRRGGBB, alpha? 0..1, ramp? [[t, 0xRRGGBB, alpha], …] over life, initial? (a ramp, sampled once at
//                birth), hue? [min, max] (turns)},
//     drift?: {amount (m), rate? (rad/s)}, swirl?: {radius (m), rate (rad/s)}, converge?: {amount 0..1}, flicker?: {amount 0..1, rate? (rad/s)},
//     render?:  {texture? (eidoverse/assets/particle_textures/<name>.png; none: a soft dot), blend?: add | alpha,
//                flipbook?: {h, v (frames across and down), speed? [min, max] (runs per life), offset? [min, max] 0..1, loop?}}
//   }
//   Param = {type: number | area | vec3 | color | texture | enum | bool, default?, min?, max?, values? (enum), help?,
//            to: [{path ("emitters.*.spawn.amount"; * = every emitter), op?: set | mul, times? (× the value: a number or
//            [x, y, z]), map? {<enum value>: number}, round?}, …] (1–8)}
//
// Every number is bounded (EFFECT_LIMITS): a document is authored by anyone who may build, and it runs on every visitor's
// machine, so "how much may one effect cost" is part of what it means, checked at the door, not left to one client.
import { sha256 } from './protocol/hash.js';

export const EFFECT_KIND = 'particle-effect';
export const TEXTURE_DIR = 'eidoverse/assets/particle_textures/';
const TEXTURE_RE = /^eidoverse\/assets\/particle_textures\/[\w.-]+\.png$/;
export const EFFECT_ADDRESS = /^(?:sha256:|eido:sha256\/)([0-9a-f]{64})$/;
/** The blob name (sha256:<hex>) an effect address names, or null. */
export const effectBlobName = (s) => { const m = typeof s === 'string' ? EFFECT_ADDRESS.exec(s) : null; return m ? `sha256:${m[1]}` : null; };

export const EFFECT_LIMITS = Object.freeze({
  emitters: 4, amount: 600, totalAmount: 1000, lifetime: [0.05, 30], preprocess: [0, 30], speedScale: [0.01, 10],
  extent: 32, speed: 50, accel: 100, damping: 100, angle: 3600, angularVelocity: 3600, size: [0.001, 8], random: [0, 10],
  points: 16, curveValue: [0, 16], hue: [-1, 1], params: 16, bindings: 8, frames: 16, animSpeed: 64,
  drift: 2, rate: 60, swirl: 2, bytes: 16384, text: 80,
});
const L = EFFECT_LIMITS;

// ---- the shape check ---------------------------------------------------------------------------------------------
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isVec = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);
const isRange = (v) => isNum(v) || (Array.isArray(v) && v.length === 2 && v.every(isNum) && v[0] <= v[1]);
const range = (v, d) => (v === undefined ? d : isNum(v) ? [v, v] : [v[0], v[1]]);
const MODULES = ['spawn', 'shape', 'velocity', 'forces', 'rotation', 'size', 'color', 'drift', 'swirl', 'converge', 'flicker', 'render', 'name'];
const FIELDS = {
  spawn: ['amount', 'lifetime', 'lifetimeRandom', 'explosiveness', 'randomness', 'oneShot', 'preprocess', 'speedScale', 'ratio'],
  shape: ['type', 'extents', 'radius', 'inner', 'height', 'cone', 'axis'],
  velocity: ['direction', 'spread', 'flatness', 'speed', 'min', 'max'],
  forces: ['gravity', 'linear', 'radial', 'tangential', 'damping'],
  rotation: ['angle', 'velocity'], size: ['base', 'random', 'curve'], color: ['base', 'alpha', 'ramp', 'initial', 'hue'],
  drift: ['amount', 'rate'], swirl: ['radius', 'rate'], converge: ['amount'], flicker: ['amount', 'rate'],
  render: ['texture', 'blend', 'flipbook'],
};
export const SHAPES = ['point', 'sphere', 'sphere-surface', 'box', 'ring'];
export const PARAM_TYPES = ['number', 'area', 'vec3', 'color', 'texture', 'enum', 'bool'];

function checkEmitter(e, at) {
  if (!isObj(e)) return `${at} is an emitter: an object of modules (${MODULES.join(', ')})`;
  for (const k of Object.keys(e)) if (!MODULES.includes(k)) return `${at}: '${k}' isn't a module (${MODULES.join(', ')})`;
  for (const [m, fs] of Object.entries(FIELDS)) if (e[m] !== undefined) {
    if (!isObj(e[m])) return `${at}.${m} is an object {${fs.join(', ')}}`;
    for (const k of Object.keys(e[m])) if (!fs.includes(k)) return `${at}.${m}: '${k}' isn't one of its fields (${fs.join(', ')})`;
  }
  const between = (x, [lo, hi], where) => (x === undefined || (isNum(x) && x >= lo && x <= hi) ? null : `${at}.${where} is a number ${lo}..${hi}`);
  const rangeIn = (x, lo, hi, where) => (x === undefined || (isRange(x) && range(x).every((v) => v >= lo && v <= hi)) ? null : `${at}.${where} is a number or [min, max], each ${lo}..${hi}`);
  const vecIn = (x, lim, where) => (x === undefined || (isVec(x) && x.every((v) => Math.abs(v) <= lim)) ? null : `${at}.${where} is [x, y, z], each within ±${lim}`);
  const S = e.spawn;
  if (!isObj(S)) return `${at}.spawn is required: {amount, lifetime, …}`;
  if (!(Number.isInteger(S.amount) && S.amount >= 1 && S.amount <= L.amount)) return `${at}.spawn.amount is a whole number 1..${L.amount}`;
  const w = between(S.lifetime ?? 1, L.lifetime, 'spawn.lifetime') ?? between(S.lifetimeRandom, [0, 1], 'spawn.lifetimeRandom') ?? between(S.explosiveness, [0, 1], 'spawn.explosiveness')
    ?? between(S.randomness, [0, 1], 'spawn.randomness') ?? between(S.preprocess, L.preprocess, 'spawn.preprocess') ?? between(S.speedScale, L.speedScale, 'spawn.speedScale') ?? between(S.ratio, [0, 1], 'spawn.ratio')
    ?? (S.oneShot === undefined || typeof S.oneShot === 'boolean' ? null : `${at}.spawn.oneShot is true or false`);
  if (w) return w;
  if (e.shape) { const s = e.shape;
    if (s.type !== undefined && !SHAPES.includes(s.type)) return `${at}.shape.type is one of ${SHAPES.join(' | ')}`;
    const x = vecIn(s.extents, L.extent, 'shape.extents') ?? between(s.radius, [0, L.extent], 'shape.radius') ?? between(s.inner, [0, L.extent], 'shape.inner') ?? between(s.height, [0, L.extent], 'shape.height')
      ?? between(s.cone, [0, 90], 'shape.cone') ?? vecIn(s.axis, 1e3, 'shape.axis');
    if (x) return x;
    if (s.extents && s.extents.some((v) => v < 0)) return `${at}.shape.extents are ≥ 0`; }
  if (e.velocity) { const v = e.velocity;
    const box = v.min !== undefined || v.max !== undefined;
    if (box && (v.direction !== undefined || v.spread !== undefined || v.flatness !== undefined || v.speed !== undefined)) return `${at}.velocity is a cone {direction, spread, flatness, speed} or a box {min, max}, not both`;
    if (box) { const x = vecIn(v.min, L.speed, 'velocity.min') ?? vecIn(v.max, L.speed, 'velocity.max'); if (x) return x;
      if (!isVec(v.min) || !isVec(v.max) || v.min.some((m, i) => m > v.max[i])) return `${at}.velocity's box needs min and max, min ≤ max on each axis`; }
    else { const x = vecIn(v.direction, 1e3, 'velocity.direction') ?? between(v.spread, [0, 180], 'velocity.spread') ?? between(v.flatness, [0, 1], 'velocity.flatness') ?? rangeIn(v.speed, 0, L.speed, 'velocity.speed'); if (x) return x; } }
  if (e.forces) { const f = e.forces;
    const x = vecIn(f.gravity, L.accel, 'forces.gravity') ?? rangeIn(f.linear, -L.accel, L.accel, 'forces.linear') ?? rangeIn(f.radial, -L.accel, L.accel, 'forces.radial')
      ?? rangeIn(f.tangential, -L.accel, L.accel, 'forces.tangential') ?? rangeIn(f.damping, 0, L.damping, 'forces.damping'); if (x) return x; }
  if (e.rotation) { const x = rangeIn(e.rotation.angle, -L.angle, L.angle, 'rotation.angle') ?? rangeIn(e.rotation.velocity, -L.angularVelocity, L.angularVelocity, 'rotation.velocity'); if (x) return x; }
  const curve = (c, where) => { if (c === undefined) return null;
    if (!Array.isArray(c) || c.length < 1 || c.length > L.points) return `${at}.${where} is 1..${L.points} points [[t, value], …]`;
    let last = -1; for (const p of c) { if (!Array.isArray(p) || p.length !== 2 || !isNum(p[0]) || !isNum(p[1]) || p[0] < 0 || p[0] > 1 || p[0] < last || p[1] < L.curveValue[0] || p[1] > L.curveValue[1])
      return `${at}.${where}: each point is [t (0..1, ascending), value (${L.curveValue[0]}..${L.curveValue[1]})]`; last = p[0]; }
    return null; };
  const ramp = (g, where) => { if (g === undefined) return null;
    if (!Array.isArray(g) || g.length < 1 || g.length > L.points) return `${at}.${where} is 1..${L.points} stops [[t, 0xRRGGBB, alpha], …]`;
    let last = -1; for (const p of g) { if (!Array.isArray(p) || p.length < 2 || p.length > 3 || !isNum(p[0]) || p[0] < 0 || p[0] > 1 || p[0] < last || !Number.isInteger(p[1]) || p[1] < 0 || p[1] > 0xffffff || (p[2] !== undefined && !(isNum(p[2]) && p[2] >= 0 && p[2] <= 1)))
      return `${at}.${where}: each stop is [t (0..1, ascending), 0xRRGGBB, alpha? 0..1]`; last = p[0]; }
    return null; };
  if (e.size) { const x = between(e.size.base, L.size, 'size.base') ?? rangeIn(e.size.random, L.random[0], L.random[1], 'size.random') ?? curve(e.size.curve, 'size.curve'); if (x) return x; }
  if (e.color) { const c = e.color;
    if (c.base !== undefined && !(Number.isInteger(c.base) && c.base >= 0 && c.base <= 0xffffff)) return `${at}.color.base is 0xRRGGBB`;
    const x = between(c.alpha, [0, 1], 'color.alpha') ?? ramp(c.ramp, 'color.ramp') ?? ramp(c.initial, 'color.initial') ?? rangeIn(c.hue, L.hue[0], L.hue[1], 'color.hue'); if (x) return x; }
  for (const [m, a, b] of [['drift', 'amount', 'rate'], ['flicker', 'amount', 'rate']]) if (e[m]) {
    const x = between(e[m][a], m === 'drift' ? [0, L.drift] : [0, 1], `${m}.${a}`) ?? between(e[m][b], [0, L.rate], `${m}.${b}`);
    if (x) return x; if (e[m][a] === undefined) return `${at}.${m} needs ${a}`; }
  if (e.swirl) { const x = between(e.swirl.radius, [0, L.swirl], 'swirl.radius') ?? between(e.swirl.rate, [-L.rate, L.rate], 'swirl.rate'); if (x) return x; if (e.swirl.radius === undefined) return `${at}.swirl needs radius`; }
  if (e.converge) { const x = between(e.converge.amount, [0, 1], 'converge.amount'); if (x) return x; if (e.converge.amount === undefined) return `${at}.converge needs amount`; }
  if (e.render) { const r = e.render;
    if (r.texture !== undefined && !(typeof r.texture === 'string' && TEXTURE_RE.test(r.texture))) return `${at}.render.texture is a .png in ${TEXTURE_DIR}`;
    if (r.blend !== undefined && !['add', 'alpha'].includes(r.blend)) return `${at}.render.blend is add | alpha`;
    if (r.flipbook !== undefined) { const f = r.flipbook;
      if (!isObj(f) || Object.keys(f).some((k) => !['h', 'v', 'speed', 'offset', 'loop'].includes(k))) return `${at}.render.flipbook is {h, v, speed?, offset?, loop?}`;
      if (![f.h, f.v].every((x) => Number.isInteger(x) && x >= 1 && x <= L.frames)) return `${at}.render.flipbook.h and .v are whole numbers 1..${L.frames}`;
      const x = rangeIn(f.speed, -L.animSpeed, L.animSpeed, 'render.flipbook.speed') ?? rangeIn(f.offset, 0, 1, 'render.flipbook.offset'); if (x) return x;
      if (f.loop !== undefined && typeof f.loop !== 'boolean') return `${at}.render.flipbook.loop is true or false`; } }
  if (e.name !== undefined && !(typeof e.name === 'string' && e.name.length <= L.text)) return `${at}.name is a string ≤ ${L.text}`;
  return null;
}

function checkParam(name, p, at) {
  if (!/^[a-z][a-zA-Z0-9_-]{0,31}$/.test(name)) return `${at}: '${name}' isn't a param name (a lowercase letter, then letters, digits, _ or -, ≤ 32)`;
  if (!isObj(p)) return `${at}.${name} is {type, default?, min?, max?, to: [{path, op?}]}`;
  for (const k of Object.keys(p)) if (!['type', 'default', 'min', 'max', 'values', 'help', 'to'].includes(k)) return `${at}.${name}: '${k}' isn't a param field (type, default, min, max, values, help, to)`;
  if (!PARAM_TYPES.includes(p.type)) return `${at}.${name}.type is one of ${PARAM_TYPES.join(' | ')}`;
  if ((p.min !== undefined && !isNum(p.min)) || (p.max !== undefined && !isNum(p.max)) || (isNum(p.min) && isNum(p.max) && p.min > p.max)) return `${at}.${name}: min and max are numbers, min ≤ max`;
  if (p.type === 'enum' && !(Array.isArray(p.values) && p.values.length >= 1 && p.values.length <= 16 && p.values.every((v) => typeof v === 'string' && v.length <= 32))) return `${at}.${name}.values is 1..16 strings`;
  if (p.help !== undefined && !(typeof p.help === 'string' && p.help.length <= 200)) return `${at}.${name}.help is a string ≤ 200`;
  if (!Array.isArray(p.to) || p.to.length < 1 || p.to.length > L.bindings) return `${at}.${name}.to is 1..${L.bindings} bindings [{path, op?, times?, map?}]`;
  for (const b of p.to) {
    if (!isObj(b) || typeof b.path !== 'string' || !/^emitters\.(\*|[0-3])\.[a-z]+\.[a-zA-Z]+$/.test(b.path)) return `${at}.${name}.to: each binding has a path "emitters.<n|*>.<module>.<field>"`;
    const [, , mod, field] = b.path.split('.');
    if (!FIELDS[mod]?.includes(field)) return `${at}.${name}.to: ${b.path} names no module field`;
    for (const k of Object.keys(b)) if (!['path', 'op', 'times', 'map', 'round'].includes(k)) return `${at}.${name}.to: '${k}' isn't a binding field (path, op, times, map, round)`;
    if (b.op !== undefined && !['set', 'mul'].includes(b.op)) return `${at}.${name}.to: op is set | mul`;
    if (b.times !== undefined && !(isNum(b.times) || isVec(b.times))) return `${at}.${name}.to: times is a number or [x, y, z]`;
    if (b.map !== undefined && !(isObj(b.map) && Object.values(b.map).every(isNum))) return `${at}.${name}.to: map is {<value>: number}`;
  }
  if (p.default !== undefined) { const bad = paramValueProblem(p, p.default); if (bad) return `${at}.${name}.default: ${bad}`; }
  return null;
}

/** Why a value doesn't fit a param's declaration, or null. */
export function paramValueProblem(p, v) {
  const inb = (x) => (p.min === undefined || x >= p.min) && (p.max === undefined || x <= p.max);
  const bounds = `${p.min ?? '−∞'}..${p.max ?? '∞'}`;
  switch (p.type) {
    case 'number': return isNum(v) && inb(v) ? null : `a number ${bounds}`;
    case 'area': return (isNum(v) && inb(v)) || (isVec(v) && v.every(inb)) ? null : `a number or [x, y, z], each ${bounds}`;
    case 'vec3': return isVec(v) && v.every(inb) ? null : `[x, y, z], each ${bounds}`;
    case 'color': return Number.isInteger(v) && v >= 0 && v <= 0xffffff ? null : 'a colour 0xRRGGBB';
    case 'texture': return typeof v === 'string' && TEXTURE_RE.test(v) ? null : `a .png in ${TEXTURE_DIR}`;
    case 'enum': return p.values.includes(v) ? null : `one of ${p.values.join(' | ')}`;
    case 'bool': return typeof v === 'boolean' ? null : 'true or false';
  }
  return 'an unknown type';
}

/** Why a document isn't a particle effect this protocol runs, or null. Bounded in size, shape and cost. */
export function effectProblem(doc) {
  if (!isObj(doc)) return 'a particle effect is an object {kind: "particle-effect", v: 1, emitters: [...]}';
  let bytes = 0; try { bytes = JSON.stringify(doc).length; } catch { return 'a particle effect is plain JSON'; }
  if (bytes > L.bytes) return `a particle effect is at most ${L.bytes} bytes of JSON (this one is ${bytes})`;
  for (const k of Object.keys(doc)) if (!['kind', 'v', 'name', 'reads', 'emitters', 'params'].includes(k)) return `'${k}' isn't a field of a particle effect (kind, v, name, reads, emitters, params)`;
  if (doc.kind !== EFFECT_KIND) return `kind must be "${EFFECT_KIND}"`;
  if (doc.v !== 1) return 'v must be 1 (the only version of the effect document)';
  for (const k of ['name', 'reads']) if (doc[k] !== undefined && !(typeof doc[k] === 'string' && doc[k].length <= L.text && !/[\u0000-\u001f‪-‮⁦-⁩]/.test(doc[k]))) return `${k} is one line of text ≤ ${L.text}`;
  if (!Array.isArray(doc.emitters) || doc.emitters.length < 1 || doc.emitters.length > L.emitters) return `emitters is a list of 1..${L.emitters}`;
  for (const [i, e] of doc.emitters.entries()) { const bad = checkEmitter(e, `emitters[${i}]`); if (bad) return bad; }
  const total = doc.emitters.reduce((s, e) => s + e.spawn.amount, 0);
  if (total > L.totalAmount) return `the emitters' amounts add to ${total}; an effect holds at most ${L.totalAmount} particles`;
  if (doc.params !== undefined) {
    if (!isObj(doc.params) || Object.keys(doc.params).length > L.params) return `params is {<name>: param} (≤ ${L.params})`;
    for (const [n, p] of Object.entries(doc.params)) { const bad = checkParam(n, p, 'params'); if (bad) return bad;
      for (const b of p.to) { const [, idx] = b.path.split('.'); if (idx !== '*' && +idx >= doc.emitters.length) return `params.${n}.to: ${b.path} names an emitter the effect doesn't have`; } }
  }
  return null;
}

// ---- params: an instance's knobs written into a copy of the document ------------------------------------------------
const clone = (x) => JSON.parse(JSON.stringify(x));
/** The document with these params applied (values already checked against their declarations), or {why}. */
export function applyParams(doc, params = {}) {
  const out = clone(doc); const decl = doc.params ?? {};
  for (const [name, p] of Object.entries(decl)) {
    const v = Object.hasOwn(params, name) ? params[name] : p.default; if (v === undefined) continue;
    for (const b of p.to) {
      const [, idx, mod, field] = b.path.split('.');
      const ems = idx === '*' ? out.emitters : [out.emitters[+idx]];
      for (const e of ems) { if (!e) continue;
        let x = b.map ? b.map[v] : v; if (x === undefined) continue;
        if (b.times !== undefined) x = isNum(x) ? (isNum(b.times) ? x * b.times : b.times.map((t) => t * x)) : isVec(x) ? x.map((c, i) => c * (isNum(b.times) ? b.times : b.times[i])) : x;
        if (b.round && isNum(x)) x = Math.round(x);
        e[mod] = e[mod] ?? {};
        if (b.op === 'mul') { const cur = e[mod][field]; e[mod][field] = isNum(cur) && isNum(x) ? cur * x : isVec(cur) && isNum(x) ? cur.map((c) => c * x) : cur; }
        else e[mod][field] = x;
      }
    }
  }
  delete out.params;
  return out;
}

/** What a param stands at when an instance doesn't set it: its default, else what the document itself says at its first
 *  binding (an Essential's count is its emitter's amount), read back through times; an enum's first value. For editors. */
export function paramShown(doc, name) {
  const p = doc?.params?.[name]; if (!p) return undefined;
  if (p.default !== undefined) return p.default;
  if (p.type === 'enum') return p.values[0];
  const b = p.to[0]; const [, idx, mod, field] = b.path.split('.'); const e = doc.emitters[idx === '*' ? 0 : +idx];
  let v = e?.[mod]?.[field];
  if (v === undefined) v = resolveEmitter(e ?? { spawn: { amount: 1 } })[mod]?.[field];
  if (b.times !== undefined && isNum(v)) v = isNum(b.times) ? v / b.times : v;
  if (b.times !== undefined && isVec(v)) { const t = isNum(b.times) ? [b.times, b.times, b.times] : b.times; v = v.map((c, i) => (t[i] ? c / t[i] : c)); if (v.every((c) => c === v[0])) v = v[0]; }
  if (Array.isArray(v) && v.length === 2 && v[0] === v[1]) v = v[0];
  if (p.type === 'texture' && v == null) return '';
  return v;
}

// ---- resolved: every module present, every default written (what particlesim.js runs) -------------------------------
/** Godot's defaults where Godot has one (gravity −9.8 m/s², spread 45°, lifetime 1 s), ours where the meaning is ours. */
export function resolveEmitter(e) {
  const S = e.spawn ?? {}, sh = e.shape ?? {}, v = e.velocity ?? {}, f = e.forces ?? {}, r = e.rotation ?? {}, z = e.size ?? {}, c = e.color ?? {}, rd = e.render ?? {}, fb = rd.flipbook ?? {};
  const type = sh.type ?? (sh.extents || sh.radius !== undefined ? 'sphere' : 'point');
  const extents = sh.extents ?? (sh.radius !== undefined ? [sh.radius, sh.radius, sh.radius] : [1, 1, 1]);
  const box = v.min !== undefined;
  const rgbOf = (x) => [((x >> 16) & 255) / 255, ((x >> 8) & 255) / 255, (x & 255) / 255];
  return {
    spawn: { amount: S.amount, lifetime: S.lifetime ?? 1, lifetimeRandom: S.lifetimeRandom ?? 0, explosiveness: S.explosiveness ?? 0, randomness: S.randomness ?? 0,
      oneShot: S.oneShot === true, preprocess: S.preprocess ?? 0, speedScale: S.speedScale ?? 1, ratio: S.ratio ?? 1 },
    shape: { type, extents, radius: sh.radius ?? 1, inner: sh.inner ?? 0, height: sh.height ?? 0, cone: sh.cone ?? 90, axis: sh.axis ?? [0, 0, 1] },
    velocity: box ? { mode: 'box', min: v.min, max: v.max } : { mode: 'cone', direction: v.direction ?? [0, 1, 0], spread: v.spread ?? 45, flatness: v.flatness ?? 0, speed: range(v.speed, [0, 0]) },
    forces: { gravity: f.gravity ?? [0, -9.8, 0], linear: range(f.linear, [0, 0]), radial: range(f.radial, [0, 0]), tangential: range(f.tangential, [0, 0]), damping: range(f.damping, [0, 0]) },
    rotation: { angle: range(r.angle, [0, 0]), velocity: range(r.velocity, [0, 0]) },
    size: { base: z.base ?? 0.1, random: range(z.random, [1, 1]), curve: z.curve ?? null },
    color: { rgb: rgbOf(c.base ?? 0xffffff), base: c.base ?? 0xffffff, alpha: c.alpha ?? 1, ramp: c.ramp ?? null, initialRamp: c.initial ?? null, hue: range(c.hue, [0, 0]) },
    drift: e.drift ? { amount: e.drift.amount, rate: e.drift.rate ?? 1.2 } : null,
    swirl: e.swirl ? { radius: e.swirl.radius, rate: e.swirl.rate ?? 1 } : null,
    converge: e.converge ? { amount: e.converge.amount } : null,
    flicker: e.flicker ? { amount: e.flicker.amount, rate: e.flicker.rate ?? 7 } : null,
    render: { texture: rd.texture ?? null, blend: rd.blend ?? 'alpha', flipbook: { h: fb.h ?? 1, v: fb.v ?? 1, speed: range(fb.speed, [0, 0]), offset: range(fb.offset, [0, 0]), loop: fb.loop !== false } },
  };
}

// ---- the Essentials --------------------------------------------------------------------------------------------------
// The nine effects the toolkit's builder (eidoverse/particles.js) shipped, as documents, so every world that named one keeps
// its look: the builder's table, read module by module. Its launch was a box (±spread across, up ± 0.2·spread), its area an
// ellipsoid squashed to 0.6 in y, its life a fade in over the first 12% and out over the last 35%, its size grow×life
// linear, its fire a white-hot → red ramp with a taper and a quick-in size; drift, swirl and flicker are its wobble, swirl
// and twinkle. Every one runs preprocessed by a full life (the builder's particles were all in flight on the first frame).
const BUILDER = {
  sparks: { count: 220, size: 0.06, lifetime: 0.9,  gravity: [0, -4.0, 0], area: 0.15, up: 2.2, spread: 1.6, color: 0xffd27f, blend: 'add',   grow: -0.8, wobble: 0,    opacity: 1,    twinkle: 0, reads: 'sparks' },
  embers: { count: 140, size: 0.05, lifetime: 2.6,  gravity: [0, 0.5, 0],  area: 0.4,  up: 0.7, spread: 0.5, color: 0xff7a30, blend: 'add',   grow: -0.5, wobble: 0.25, opacity: 1,    twinkle: 0.4, reads: 'embers' },
  smoke:  { count: 70,  size: 0.7,  lifetime: 4.5,  gravity: [0, 0.45, 0], area: 0.3,  up: 0.5, spread: 0.3, color: 0x8a8a8a, blend: 'alpha', grow: 1.8,  wobble: 0.35, opacity: 0.35, twinkle: 0, reads: 'smoke' },
  dust:   { count: 160, size: 0.04, lifetime: 6.0,  gravity: [0, 0.02, 0], area: 3.0,  up: 0.05, spread: 0.2, color: 0xbcb2a0, blend: 'alpha', grow: 0.2,  wobble: 0.5,  opacity: 0.4,  twinkle: 0.3, reads: 'drifting dust' },
  snow:   { count: 320, size: 0.05, lifetime: 8.0,  gravity: [0, -0.7, 0], area: 6.0,  up: 0,   spread: 0.1, color: 0xffffff, blend: 'alpha', grow: 0,    wobble: 0.55, opacity: 0.9,  twinkle: 0, reads: 'falling snow' },
  magic:  { count: 180, size: 0.08, lifetime: 2.4,  gravity: [0, 0.6, 0],  area: 0.5,  up: 0.4, spread: 0.6, color: 0x9b5cff, blend: 'add',   grow: -0.3, wobble: 0.4,  opacity: 1,    twinkle: 0.7, swirl: 1.4, reads: 'motes of light' },
  stars:  { count: 420, size: 0.07, lifetime: 3.0,  gravity: [0, 0, 0],    area: 22.0, up: 0,   spread: 0,   color: 0xffffff, blend: 'add',   grow: 0,    wobble: 0,    opacity: 1,    twinkle: 1, reads: 'a field of stars' },
  muzzle: { count: 48,  size: 0.45, lifetime: 0.22, gravity: [0, 0, 0],    area: 0.05, up: 0.2, spread: 2.4, color: 0xfff0c0, blend: 'add',   grow: -1.4, wobble: 0,    opacity: 1,    twinkle: 0, reads: 'a muzzle flash' },
  fire:   { count: 150, size: 0.5,  lifetime: 0.55, gravity: [0, 0.5, 0],  area: 0.10, up: 0.55, spread: 0.18, color: 0xffffff, blend: 'add',  grow: 0,    wobble: 0.15, opacity: 1,    twinkle: 0.25, flame: true, converge: 0.85, rotate: 0.35, reads: 'fire' },
};
// stars' area is 22 m: the builder had no cap on a preset's own area (only an authored one was held to 8), so its document
// carries it; the limit binds what anyone writes
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const FADE = (t) => Math.min(1, t / 0.12) * Math.min(1, (1 - t) / 0.35);
const STOPS = [0, 0.06, 0.12, 0.2, 0.3, 0.4, 0.5, 0.65, 0.75, 0.85, 0.93, 1];
function flameRgb(t) {   // the builder's colour-over-life: mix(white-hot, yellow, ss(0,.3)) → orange (ss(.3,.65)) → red tip (ss(.65,1))
  const mix = (a, b, k) => a.map((x, i) => x + (b[i] - x) * k);
  let c = mix([1, 0.97, 0.88], [1, 0.78, 0.25], smooth(0, 0.3, t)); c = mix(c, [1, 0.42, 0.10], smooth(0.3, 0.65, t)); c = mix(c, [0.55, 0.12, 0.04], smooth(0.65, 1, t));
  return (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255);
}
function builderEffect(name, P) {
  const growCurve = P.flame ? STOPS.map((t) => [t, r4(Math.sqrt(smooth(0, 0.12, t)) * (1 - t * 0.55))])
    : P.grow === 0 ? null : P.grow > -1 ? [[0, 1], [1, r4(1 + P.grow)]] : [[0, 1], [r4(-1 / P.grow), 0], [1, 0]];
  const ramp = STOPS.map((t) => [t, P.flame ? flameRgb(t) : 0xffffff, r4(FADE(t))]);
  const e = {
    spawn: { amount: P.count, lifetime: P.lifetime, randomness: 1, preprocess: P.lifetime },
    shape: { type: 'sphere', extents: [P.area, r4(P.area * 0.6), P.area] },
    velocity: { min: [-P.spread, r4(P.up - 0.2 * P.spread), -P.spread], max: [P.spread, r4(P.up + 0.2 * P.spread), P.spread] },
    forces: { gravity: P.gravity },
    size: { base: P.size, random: [0.7, 1.3], ...(growCurve ? { curve: growCurve } : {}) },
    color: { base: P.color, alpha: P.opacity, ramp },
    ...(P.wobble ? { drift: { amount: P.wobble, rate: 1.2 } } : {}),
    ...(P.swirl ? { swirl: { radius: r4(P.swirl * 0.15), rate: P.swirl } } : {}),
    ...(P.converge ? { converge: { amount: P.converge } } : {}),
    ...(P.twinkle ? { flicker: { amount: P.twinkle, rate: 7 } } : {}),
    ...(P.rotate ? { rotation: { angle: [0, 360], velocity: [r4(-P.rotate * 180 / Math.PI), r4(P.rotate * 180 / Math.PI)] } } : {}),
    render: { blend: P.blend },
  };
  return { kind: EFFECT_KIND, v: 1, name, reads: P.reads, emitters: [e], params: LEGACY_PARAMS(P) };
}
// the knobs the first protocol's particles bag had, as params every Essential declares: an older value's count, size,
// opacity, speed, lifetime, area, texture and quality read as these, with the builder's bounds
function LEGACY_PARAMS() {
  return {
    count: { type: 'number', min: 1, max: 600, help: 'how many particles', to: [{ path: 'emitters.*.spawn.amount', round: true }] },
    size: { type: 'number', min: 0.005, max: 4, help: 'a particle\'s size (m)', to: [{ path: 'emitters.*.size.base' }] },
    opacity: { type: 'number', min: 0, max: 1, to: [{ path: 'emitters.*.color.alpha' }] },
    speed: { type: 'number', min: 0.05, max: 8, help: 'how fast it runs (× its own clock)', to: [{ path: 'emitters.*.spawn.speedScale' }] },
    lifetime: { type: 'number', min: 0.05, max: 30, help: 'how long a particle lives (s)', to: [{ path: 'emitters.*.spawn.lifetime' }, { path: 'emitters.*.spawn.preprocess' }] },
    area: { type: 'area', min: 0, max: 8, help: 'the size of the space it fills (m; or [x, y, z])', to: [{ path: 'emitters.*.shape.extents', times: [1, 0.6, 1] }] },
    texture: { type: 'texture', help: 'a sprite from the particle library', to: [{ path: 'emitters.*.render.texture' }] },
    quality: { type: 'enum', values: ['auto', 'high', 'med', 'low'], help: 'the most of it any viewer draws', to: [{ path: 'emitters.*.spawn.ratio', map: { auto: 1, high: 1, med: 0.5, low: 0.25 } }] },
  };
}
export const ESSENTIALS = Object.freeze(Object.fromEntries(Object.entries(BUILDER).map(([k, P]) => [k, Object.freeze(builderEffect(k, P))])));
export const ESSENTIAL_NAMES = Object.freeze(Object.keys(ESSENTIALS));
/** An Essential's content address: the same document stored in a world has this name. */
export const effectAddress = (doc) => `sha256:${sha256(jcs(doc))}`;
function jcs(v) {   // RFC 8785 for the plain JSON a document is (keys sorted, no whitespace)
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`).join(',')}}`;
}

// ---- the instance ---------------------------------------------------------------------------------------------------
// The first protocol's bag, {preset, seed?, origin?, count?, size?, opacity?, speed?, lifetime?, area?, texture?, quality?},
// is still READ (a stored value is read forever: PROTOCOL §4): its preset is the effect, origin is at, and every other
// knob is the param of the same name. It is never written any more (the authority refuses it; the translator writes the
// new shape).
export const LEGACY_FIELDS = Object.freeze(['preset', 'origin', 'count', 'size', 'opacity', 'speed', 'lifetime', 'area', 'texture', 'quality']);
const LEGACY_PARAM_KEYS = ['count', 'size', 'opacity', 'speed', 'lifetime', 'area', 'texture', 'quality'];
export const INSTANCE_FIELDS = Object.freeze(['effect', 'part', 'at', 'seed', 'playing', 'scale', 'params']);
export const isLegacy = (v) => isObj(v) && v.effect === undefined && v.preset !== undefined;
/** Any stored particles value (or grabbable.fx.particles) → the instance it means: {effect, part, at, seed, playing,
 *  scale, params}. An older value's knobs become params; nothing it said is dropped. */
export function instanceOf(v) {
  if (!isObj(v)) return null;
  if (v.effect === undefined && v.preset !== undefined) {
    const params = {}; for (const k of LEGACY_PARAM_KEYS) if (v[k] !== undefined) params[k] = v[k];
    return { effect: v.preset, ...(v.seed !== undefined ? { seed: v.seed } : {}), ...(v.origin !== undefined ? { at: v.origin } : {}), ...(Object.keys(params).length ? { params } : {}) };
  }
  const out = {}; for (const k of INSTANCE_FIELDS) if (v[k] !== undefined) out[k] = v[k];
  return out;
}
/** The translator's (and anyone's) rewrite of an older value in today's spelling; null/other values pass through. Keys
 *  neither spelling knows stay at the top for the caller to carry (imported:particles). */
export function modernize(v) {
  if (!isLegacy(v)) return v;
  const rest = {}; for (const [k, x] of Object.entries(v)) if (!LEGACY_FIELDS.includes(k) && k !== 'seed') rest[k] = x;
  return { ...instanceOf(v), ...rest };
}
/** The effect document a name means here: an Essential, or a stored one through lookup(blobName) (null: unknown or not
 *  loaded yet). */
export function effectFor(name, lookup = () => null) {
  if (typeof name !== 'string') return null;
  if (Object.hasOwn(ESSENTIALS, name)) return ESSENTIALS[name];
  const b = effectBlobName(name); return b ? lookup(b) : null;
}
/** Why an instance value isn't one the authority takes (the doc already found, or null when it isn't), or null. */
export function instanceProblem(v, doc) {
  if (!isObj(v)) return 'particles is {effect, part?, at?, seed?, playing?, scale?, params?}';
  const legacy = Object.keys(v).filter((k) => LEGACY_FIELDS.includes(k));
  if (legacy.length) return `${legacy.join(', ')} ${legacy.length > 1 ? 'are' : 'is'} the first protocol's spelling (read in older values, never written): write {effect: '${typeof v.preset === 'string' ? v.preset : 'fire'}'${legacy.some((k) => LEGACY_PARAM_KEYS.includes(k)) ? `, params: {${legacy.filter((k) => LEGACY_PARAM_KEYS.includes(k)).join(', ')}}` : ''}${legacy.includes('origin') ? ', at: [x, y, z]' : ''}}`;
  if (typeof v.effect !== 'string' || !v.effect) return 'particles needs effect: an Essentials name or a stored effect\'s address (sha256:<64 hex>)';
  if (!doc) return Object.hasOwn(ESSENTIALS, v.effect) ? null : effectBlobName(v.effect) ? `no effect ${v.effect} is stored in this world` : `'${v.effect}' isn't an Essentials effect (${ESSENTIAL_NAMES.join(', ')}); a document of your own goes by its address`;
  if (v.at !== undefined && !(isVec(v.at) && v.at.every((x) => Math.abs(x) <= 8))) return 'at is [x, y, z] in its own frame, each within ±8 m (a far emitter is its own thing)';
  if (v.part !== undefined && !(typeof v.part === 'string' && v.part.length >= 1 && v.part.length <= 64)) return 'part names a node of its model (≤ 64)';
  if (v.scale !== undefined && !(isNum(v.scale) && v.scale >= 0.01 && v.scale <= 100)) return 'scale is a number 0.01..100';
  if (v.playing !== undefined && typeof v.playing !== 'boolean') return 'playing is true or false';
  if (v.seed !== undefined && !(isNum(v.seed) && Math.abs(v.seed) <= 2 ** 53)) return 'seed is a number';
  if (v.params !== undefined) {
    if (!isObj(v.params)) return 'params is {<name>: value}';
    const decl = doc.params ?? {};
    for (const [k, x] of Object.entries(v.params)) {
      if (!Object.hasOwn(decl, k)) return `params.${k}: ${doc.name ?? 'this effect'} has no param '${k}' (${Object.keys(decl).join(', ') || 'it has none'})`;
      const bad = paramValueProblem(decl[k], x); if (bad) return `params.${k} is ${bad}`;
    }
    const applied = applyParams(doc, v.params); const bad = effectProblem(applied);
    if (bad) return `with these params the effect is out of bounds: ${bad}`;
  }
  return null;
}

/** QUALITY: a viewer's local budget (the governor lowers it); it composes with an effect's own ratio as a minimum. */
export const QUALITY_TIERS = Object.freeze({ auto: 1, high: 1, med: 0.5, low: 0.25 });

/**
 * Everything a renderer needs from a stored value: {ok, effect (the resolved document's emitters), seed, at, part,
 * playing, scale, reads, notes} or {ok: false, why, pending?}. A param that doesn't fit is left out (and named in notes):
 * a viewer draws what it can, the authority is where a value is refused.
 */
export function resolveParticles(v, { entityId = '', lookup = () => null } = {}) {
  const inst = instanceOf(v);
  if (!inst) return { ok: false, why: 'particles data must be an object {effect, …}' };
  const doc = effectFor(inst.effect, lookup);
  if (!doc) {
    const stored = effectBlobName(inst.effect);
    return { ok: false, pending: !!stored, why: stored ? `effect ${inst.effect} isn't loaded (yet)` : `effect ${JSON.stringify(inst.effect ?? null)} isn't one this client knows (${ESSENTIAL_NAMES.join('/')}): it reads as an emitter but shows nothing` };
  }
  const notes = []; const params = {};
  for (const [k, x] of Object.entries(inst.params ?? {})) {
    const p = doc.params?.[k]; if (!p) { notes.push(`params.${k}: not a param of ${doc.name ?? 'this effect'}`); continue; }
    let val = x;
    if (p.type === 'number' && isNum(x)) val = Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, x));
    if (p.type === 'area' && isVec(x)) val = x.map((c) => Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, c)));
    if (p.type === 'area' && isNum(x)) val = Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, x));
    if (val !== x) notes.push(`params.${k} clamped to ${p.min}..${p.max}`);
    const bad = paramValueProblem(p, val); if (bad) { notes.push(`params.${k} must be ${bad}: using the effect's own`); continue; }
    params[k] = val;
  }
  const applied = applyParams(doc, params);
  const bad = effectProblem(applied);
  // an Essential's own document may exceed what a writer may (stars' 22 m area); the authority bounds what's WRITTEN
  if (bad && !Object.hasOwn(ESSENTIALS, inst.effect)) return { ok: false, why: `the effect, with its params: ${bad}` };
  const at = isVec(inst.at) ? inst.at.map((x) => Math.max(-8, Math.min(8, x))) : [0, 0, 0];
  if (isVec(inst.at) && inst.at.some((x) => Math.abs(x) > 8)) notes.push('at is bounded to ±8 m — place a far emitter on its own thing');
  const seed = isNum(inst.seed) ? Math.floor(inst.seed) >>> 0 : hashSeed(`${entityId}:${inst.effect ?? ''}`);
  return { ok: true, effect: inst.effect, emitters: applied.emitters.map(resolveEmitter), seed, at, part: typeof inst.part === 'string' ? inst.part : null,
    playing: inst.playing !== false, scale: isNum(inst.scale) && inst.scale > 0 ? inst.scale : 1, reads: doc.reads ?? doc.name ?? null, notes };
}
/** FNV-1a over a string → a 32-bit seed (the derived seed when none is written, as before). */
export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < String(str).length; i++) { h ^= String(str).charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
