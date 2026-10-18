// shared/blueprint.js — blueprints: the record, its hash, and the copy link as
// pure functions (design §3 "Blueprints", §7 step 6a).
//
// A blueprint is the master design of a thing — an entity with its components
// and children — saved as ONE immutable, content-hashed record:
//
//   { kind: "eido.blueprint", v: 1, name, parent?: <hash>, note?,
//     root: { components: [...], children: [ { id, components, children }, … ] } }
//
// `components` are component instances exactly as shared/components.js reads
// them (componentsOf / entityOf: `{ type, key?, params, wire?, extra? }`), so a
// node expands to wire bytes with the same alias table every surface uses.
// The root carries no placement: its Transform may say `scale` and `rotOrder`,
// never `pos`/`q`/`yaw` (where a copy stands is the copy's). A child's
// Transform is LOCAL to its parent node, as a child entity's is to its carrier
// (design §3 "Children"); the nesting is the attachment, so no node carries an
// Attachment. A child names itself with `id`, unique among its siblings — the
// handle an update uses to find the same part in the next version.
//
// Editing a blueprint makes a NEW record naming the old one's hash as `parent`
// (lineage). The hash covers meaning, not prose (design §6's rule for component
// records): `note` is documentation and may be reworded without minting a new
// version; everything else — `name` included, since it is what copies show — is
// hashed.
//
// A COPY is an entity carrying `comp.blueprint = { hash, name }` and its full
// expanded components (principle 1: every client renders it with no resolver).
// overridesOf / rebase compare copies against records; placing copies (6b) and
// offering updates (6c) build on these.
//
// Pure: no DOM, no I/O. The door (server/verbs.ts), the fold (shared/fold.js),
// the agent and the editor all ask the same questions here.

import { canon, sha256hex, entityOf, componentsOf, compRefusal, RECORDS, socketQ } from './components.js';
import { worldPose, childrenOf, socketOf } from './hierarchy.js';
import { qNorm, qHeading } from './rot.js';

import { recordComponents } from './protocol/view.js';
export const BLUEPRINT_KIND = 'eido.blueprint';
/** What the door accepts. A component is written to the world as one `comp`
 *  (≤ 8 KB, PROTOCOL §3), so one instance may not exceed that either. */
export const BLUEPRINT_LIMITS = Object.freeze({
  BYTES: 65536,          // the canonical record
  NODES: 256,            // root + every child, at any depth
  DEPTH: 8,              // root = depth 0
  COMPONENTS: 48,        // per node
  COMPONENT_BYTES: 8192, // per instance, canonical
  NAME: 64, ID: 64, KEY: 32, NOTE: 2000,
});

const HEX64 = /^[0-9a-f]{64}$/;
const CTRL = /[\u0000-\u001f\u007f]/;
const isBag = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const RECORD_KEYS = new Set(['kind', 'v', 'name', 'parent', 'note', 'root']);
const NODE_KEYS = new Set(['id', 'components', 'children']);
const INST_KEYS = new Set(['type', 'key', 'params', 'wire', 'extra']);
// Types a blueprint node may not hold: the nesting IS the attachment, captions
// are server-written (the caption verb), and the world's records are the world's.
const NOT_IN_A_BLUEPRINT = {
  Parent: 'a node is attached by nesting it under its parent, not by a Parent component',
  Captions: 'captions are written by the caption verb, never authored',
};
const PLACEMENT = ['pos', 'q', 'yaw'];

/** A record's meaning: everything but its prose (`note`). */
function meaningOf(rec) {
  const { note: _n, ...out } = rec;
  return out;
}
/** The content hash of a blueprint record: SHA-256 (hex) of the RFC 8785
 *  canonical JSON of its meaning — the same canon() and sha256hex() as
 *  component records (shared/components.js). Throws on what canon refuses
 *  (non-finite numbers); blueprintRefusal says so first. */
export const blueprintHash = (rec) => sha256hex(canon(meaningOf(rec)));

/** The identity of an instance within its node: type + comp-bag key. */
export const compIdOf = (inst) => `${inst.type}${inst.key != null ? `|${inst.key}` : ''}`;

/** Why this is not a v1 blueprint record, or null. The door refuses with this
 *  prose; the editor asks the same before it sends. Never throws. */
export function blueprintRefusal(rec) {
  if (!isBag(rec)) return 'a blueprint is an object: {kind: "eido.blueprint", v: 1, name, parent?, note?, root: {components, children}}';
  for (const k of Object.keys(rec)) if (!RECORD_KEYS.has(k)) return `a v1 blueprint has no "${k}" (it has kind, v, name, parent?, note?, root)`;
  if (rec.kind !== BLUEPRINT_KIND) return `a blueprint's kind is "${BLUEPRINT_KIND}"`;
  if (rec.v !== 1) return 'this door speaks blueprint v: 1';
  if (typeof rec.name !== 'string' || !rec.name.trim() || rec.name.length > BLUEPRINT_LIMITS.NAME || CTRL.test(rec.name)) return `a blueprint's name is 1–${BLUEPRINT_LIMITS.NAME} characters of text`;
  if (rec.parent !== undefined && (typeof rec.parent !== 'string' || !HEX64.test(rec.parent))) return 'a blueprint\'s parent is the hash of the version it was edited from (64 lowercase hex)';
  if (rec.note !== undefined && (typeof rec.note !== 'string' || rec.note.length > BLUEPRINT_LIMITS.NOTE)) return `a blueprint's note is text, at most ${BLUEPRINT_LIMITS.NOTE} characters`;
  let bytes;
  try { bytes = new TextEncoder().encode(canon(rec)).length; } catch (e) { return `a blueprint is plain JSON (${e.message.replace(/^canon: /, '')})`; }
  if (bytes > BLUEPRINT_LIMITS.BYTES) return `this blueprint is ${bytes} bytes; the most a record may be is ${BLUEPRINT_LIMITS.BYTES}`;
  let nodes = 0;
  const node = (n, depth, where) => {
    if (!isBag(n)) return `${where} is an object: {${depth ? 'id, ' : ''}components, children}`;
    for (const k of Object.keys(n)) if (!NODE_KEYS.has(k)) return `${where} has no "${k}" (a node has ${depth ? 'id, ' : ''}components, children)`;
    if (++nodes > BLUEPRINT_LIMITS.NODES) return `a blueprint holds at most ${BLUEPRINT_LIMITS.NODES} parts`;
    if (depth > BLUEPRINT_LIMITS.DEPTH) return `a blueprint nests at most ${BLUEPRINT_LIMITS.DEPTH} deep`;
    if (depth === 0 && n.id !== undefined) return 'the root has no id (a copy is named where it is placed)';
    if (depth > 0 && (typeof n.id !== 'string' || !n.id || n.id.length > BLUEPRINT_LIMITS.ID || CTRL.test(n.id) || n.id.includes('/'))) return `${where} needs an id: 1–${BLUEPRINT_LIMITS.ID} characters, no "/" — the handle an update finds it by`;
    if (!Array.isArray(n.components)) return `${where}.components is a list of components`;
    if (!Array.isArray(n.children)) return `${where}.children is a list (empty when it has none)`;
    if (n.components.length > BLUEPRINT_LIMITS.COMPONENTS) return `${where} holds more than ${BLUEPRINT_LIMITS.COMPONENTS} components`;
    const seen = new Set();
    for (const [i, c] of n.components.entries()) {
      const at = `${where}.components[${i}]`;
      if (!isBag(c)) return `${at} is a component: {type, key?, params, wire?, extra?}`;
      for (const k of Object.keys(c)) if (!INST_KEYS.has(k)) return `${at} has no "${k}" (a component has type, key?, params, wire?, extra?)`;
      if (typeof c.type !== 'string' || !RECORDS[c.type] || RECORDS[c.type].world) return `${at}: "${c.type}" is not a component a thing can carry`;
      if (NOT_IN_A_BLUEPRINT[c.type]) return `${at}: ${NOT_IN_A_BLUEPRINT[c.type]}`;
      if (c.key !== undefined && (typeof c.key !== 'string' || !c.key || c.key.length > BLUEPRINT_LIMITS.KEY)) return `${at}.key is the comp-bag key, 1–${BLUEPRINT_LIMITS.KEY} characters`;
      if (c.type === 'Annotation' && (c.key ?? c.params?.type) === 'blueprint') return `${at}: a blueprint inside a blueprint (a nested copy) is not v1`;
      if (!isBag(c.params)) return `${at}.params is an object`;
      if (c.wire !== undefined && !isBag(c.wire)) return `${at}.wire is an object`;
      if (c.extra !== undefined && !isBag(c.extra)) return `${at}.extra is an object`;
      if (c.type === 'Transform' && depth === 0 && PLACEMENT.some((k) => c.params[k] !== undefined)) return 'the root\'s Transform holds no pos, q or yaw — where a copy stands is the copy\'s own (scale and rotOrder may ride)';
      const id = compIdOf(c);
      if (seen.has(id)) return `${at}: two ${c.type} components${c.key != null ? ` under key "${c.key}"` : ''} on one part`;
      seen.add(id);
      if (new TextEncoder().encode(canon(c)).length > BLUEPRINT_LIMITS.COMPONENT_BYTES) return `${at} is larger than a component may be (${BLUEPRINT_LIMITS.COMPONENT_BYTES} bytes)`;
    }
    // it must expand: the alias table writes every node to wire bytes
    try { entityOf({ components: n.components }); } catch (e) { return `${where} does not expand: ${e.message}`; }
    const ids = new Set();
    for (const [i, k] of n.children.entries()) {
      const why = node(k, depth + 1, `${where}.children[${i}]`);
      if (why) return why;
      if (ids.has(k.id)) return `${where} has two children with id "${k.id}"`;
      ids.add(k.id);
    }
    return null;
  };
  return node(rec.root, 0, 'root');
}

/** Why `hash` is not this record's hash, or null — the door's check. */
export function hashRefusal(rec, hash) {
  if (typeof hash !== 'string' || !HEX64.test(hash)) return 'blueprint wants {hash, record}: hash is the record\'s content hash, 64 lowercase hex';
  const real = blueprintHash(rec);
  return real === hash ? null : `this record hashes to ${real}, not ${hash} — the hash names exactly the record sent (canonical JSON, RFC 8785, without its note)`;
}

/** What a copy's `comp.blueprint` says: which record it follows. */
export const linkOf = (rec, hash = blueprintHash(rec)) => ({ hash, name: rec.name });

/** A record's lineage, newest first: [hash, parent, grandparent, …] as far as
 *  the store holds them (a store keyed by hash: { [hash]: { record } }). */
export function lineageOf(store, hash) {
  const out = [];
  const seen = new Set();
  for (let h = hash; h && !seen.has(h); h = store?.[h]?.record?.parent) {
    seen.add(h); out.push(h);
    if (!store?.[h]) break;
  }
  return out;
}

// ------------------------------------------------------------ the copy link
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** A record's tree, expanded: each node's components (deep copies, safe to
 *  edit) and the wire bytes they write (`entity`, via entityOf — no stamps,
 *  no placement on the root), with its children. 6b places these. */
export function expand(rec) {
  const node = (n) => ({
    ...(n.id !== undefined ? { id: n.id } : {}),
    components: clone(n.components),
    entity: entityOf({ components: clone(n.components) }),
    children: n.children.map(node),
  });
  return node(rec.root);
}

// A node's components with what is not the design taken out: the root's
// placement (pos/q/yaw), any Attachment (the world's parenting; nesting is the
// design's), and the copy link itself. Returns { comps, placement }.
function designOf(components, isRoot) {
  let placement = null;
  const comps = [];
  for (const c of components ?? []) {
    if (c.type === 'Parent') continue;
    if (c.type === 'Annotation' && (c.key ?? c.params?.type) === 'blueprint') continue;
    if (c.type === 'Transform' && isRoot) {
      const p = { ...(c.params ?? {}) };
      placement = {};
      for (const k of PLACEMENT) if (p[k] !== undefined) { placement[k] = p[k]; delete p[k]; }
      comps.push({ ...c, params: p });
      continue;
    }
    comps.push(c);
  }
  return { comps, placement };
}

// Flatten a tree to one map of addressable facts, so overrides and rebase are
// a field-by-field comparison. Keys are JSON arrays: [path, compId?, field?]
// where path is the child ids from the root ("" = root). A node's presence is
// [path], a component's [path, compId], a field [path, compId, field]; fields
// are params/<name>, key, wire and extra (wire/extra compared whole).
const K = (...parts) => JSON.stringify(parts);
function flatten(tree, isCopy) {
  const out = new Map();
  const order = { nodes: new Map(), comps: new Map() };   // for rebuilding in a stable order
  let placement = null;
  const walk = (n, path) => {
    out.set(K(path), true);
    const d = designOf(n.components, path === '');
    if (path === '' && isCopy) placement = d.placement;
    const compOrder = [];
    for (const c of modernize(d.comps)) {
      const id = compIdOf(c);
      compOrder.push(id);
      out.set(K(path, id), c.type);
      if (c.key !== undefined) out.set(K(path, id, 'key'), c.key);
      for (const [f, v] of Object.entries(c.params ?? {})) out.set(K(path, id, `params/${f}`), v);
      if (c.wire !== undefined) out.set(K(path, id, 'wire'), c.wire);
      if (c.extra !== undefined) out.set(K(path, id, 'extra'), c.extra);
    }
    order.comps.set(path, compOrder);
    const kids = [];
    for (const k of n.children ?? []) {
      const p = path ? `${path}/${k.id}` : k.id;
      kids.push(p);
      walk(k, p);
    }
    order.nodes.set(path, kids);
  };
  walk(tree, '');
  return { facts: out, order, placement };
}
const same = (a, b) => (a === undefined || b === undefined ? a === b : canon(a) === canon(b));
function describe(key) {
  const [path, comp, field] = JSON.parse(key);
  return { path: path ? path.split('/') : [], ...(comp !== undefined ? { comp } : {}), ...(field !== undefined ? { field } : {}) };
}

/** What a copy changes for itself, relative to the record it follows: one
 *  entry per differing fact — a field (`{path, comp, field, value, base}`), a
 *  component added or removed (`{path, comp, value: type | undefined, base}`),
 *  or a part added or removed (`{path, value: true | undefined, base}`).
 *  `copy` is a tree in the record's shape ({components, children[{id, …}]}),
 *  read from the world (componentsOf per entity); the root's placement, any
 *  Attachment and the link itself are not overrides. `path` is child ids. */
export function overridesOf(copy, rec) {
  const ours = flatten(copy, true).facts;
  const base = flatten(rec.root, false).facts;
  const out = [];
  for (const k of new Set([...base.keys(), ...ours.keys()])) {
    const o = ours.get(k), b = base.get(k);
    if (!same(o, b)) out.push({ ...describe(k), value: o, base: b });
  }
  return out;
}

/** Bring a copy to a new version of its blueprint, keeping its overrides:
 *  a three-way merge of copy (ours) against oldRec (base) and newRec (theirs),
 *  fact by fact. A fact only one side changed takes that side; a fact both
 *  changed alike is fine; a fact both changed differently is a CONFLICT — an
 *  override on a field the update also changed — and so is removing a part
 *  or component the other side edited. With no conflicts:
 *    { ok: true, tree: {components, children} }   (the copy's placement kept)
 *  else { ok: false, conflicts: [{path, comp?, field?, ours, base, theirs}] }
 *  and nothing is guessed. */
export function rebase(copy, newRec, oldRec) {
  const O = flatten(copy, true), B = flatten(oldRec.root, false), T = flatten(newRec.root, false);
  const merged = new Map();
  const conflicts = [];
  for (const k of new Set([...B.facts.keys(), ...T.facts.keys(), ...O.facts.keys()])) {
    const o = O.facts.get(k), b = B.facts.get(k), t = T.facts.get(k);
    let v;
    if (same(o, b)) v = t;
    else if (same(t, b) || same(o, t)) v = o;
    else { conflicts.push({ ...describe(k), ours: o, base: b, theirs: t }); continue; }
    if (v !== undefined) merged.set(k, v);
  }
  // a fact that survived under a part or component that did not is an edit to
  // something removed: the remover and the editor disagree
  for (const k of merged.keys()) {
    const [path, comp, field] = JSON.parse(k);
    const lost = (field !== undefined && !merged.has(K(path, comp))) || !nodeLives(merged, path);
    if (lost) conflicts.push({ ...describe(k), ours: O.facts.get(k), base: B.facts.get(k), theirs: T.facts.get(k) });
  }
  if (conflicts.length) return { ok: false, conflicts };
  // rebuild, in the new version's order with the copy's additions after
  const nodeOrder = (path) => [...new Set([...(T.order.nodes.get(path) ?? []), ...(O.order.nodes.get(path) ?? [])])];
  const compOrder = (path) => [...new Set([...(T.order.comps.get(path) ?? []), ...(O.order.comps.get(path) ?? [])])];
  const build = (path) => {
    const components = [];
    for (const id of compOrder(path)) {
      const type = merged.get(K(path, id));
      if (type === undefined) continue;
      const inst = { type };
      const key = merged.get(K(path, id, 'key'));
      if (key !== undefined) inst.key = key;
      inst.params = {};
      const prefix = K(path, id, 'params/').slice(0, -2);   // '["path","id","params/'
      for (const [k, v] of merged) if (k.startsWith(prefix)) inst.params[JSON.parse(k)[2].slice(7)] = clone(v);
      if (path === '' && type === 'Transform' && O.placement) Object.assign(inst.params, clone(O.placement));
      const wire = merged.get(K(path, id, 'wire')); if (wire !== undefined) inst.wire = clone(wire);
      const extra = merged.get(K(path, id, 'extra')); if (extra !== undefined) inst.extra = clone(extra);
      components.push(inst);
    }
    if (path === '' && O.placement && !components.some((c) => c.type === 'Transform')) components.unshift({ type: 'Transform', params: clone(O.placement) });
    const children = nodeOrder(path).filter((p) => merged.get(K(p)) === true)
      .map((p) => ({ id: p.split('/').pop(), ...build(p) }));
    return { components, children };
  };
  return { ok: true, tree: build('') };
}
function nodeLives(merged, path) {
  if (path === '') return true;
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) if (merged.get(K(parts.slice(0, i).join('/'))) !== true) return false;
  return true;
}

// ------------------------------------------------------------ one spelling per meaning
// The comp-bag key each type is written under when an instance names none —
// entityOf's own defaults, plus Lock/Guard/Hidden, which entityOf writes
// under whatever key the instance carries (a keyless one would land under
// "undefined").
const DEFAULT_KEY = {
  Lock: 'lock', Guard: 'guard', Hidden: 'hidden', Label: 'label',
  Pendulum: 'motion', Spin: 'motion', Orbit: 'motion', Oscillate: 'motion', Path: 'motion',
  Sockets: 'sockets', Reactions: 'reactions', Structure: 'structure', Captions: 'captions',
  LookAt: 'look', Stage: 'stage', Particles: 'particles', Picture: 'picture', Sound: 'sound',
};
const COLLIDER_SHAPES = new Set(['mesh', 'exact', 'box']);   // exact: the stored word before 10-16 (the door stores mesh)

/** A node's components in the spelling every NEW write uses (owner,
 *  2026-10-02: "everything should go out under the new comp system"):
 *  - a keyless Light (the legacy `kind:"light"` entity) becomes the Light
 *    component `comp.light` — unless the part also holds one, when the two
 *    spellings would collide (placeRefusal names it);
 *  - a keyless Collider (the spawn verb's legacy `collide`) becomes
 *    `comp.collider` when its shape is one the component speaks (exact | box);
 *    any other shape stays the legacy argument, the only way to write it;
 *  - every other comp-bag type with no key takes the key entityOf writes it
 *    under (a hand-written record may leave keys out).
 *  The same function decides what placement writes and what overridesOf /
 *  rebase compare, so a copy placed from a legacy record reads back as that
 *  record: one meaning, one identity, whatever the spelling it was saved in. */
function dropRateKey(c) {
  const { rateKey: _r, ...extra } = c.extra;
  const { extra: _e, ...rest } = c;
  return Object.keys(extra).length ? { ...rest, extra } : rest;
}
export function modernize(components) {
  const list = components ?? [];
  const keyed = (type, key) => list.some((c) => c.type === type && c.key === key);
  return list.map((c0) => {
    // a motion's rate written under the default key reads back naming it
    // (componentsOf keeps extra.rateKey so `rpm` survives): the default is
    // not a fact of the design, so it is left unsaid on both sides
    const c = c0?.extra?.rateKey === 'degPerSec' ? dropRateKey(c0) : c0;
    if (c.key != null || !c?.type) return c;
    if (c.type === 'Light') return keyed('Light', 'light') ? c : { ...c, key: 'light' };
    if (c.type === 'Collider') return !keyed('Collider', 'collider') && COLLIDER_SHAPES.has(c.params?.shape) ? { ...c, key: 'collider' } : c;
    if (c.type === 'Annotation') return typeof c.params?.type === 'string' ? { ...c, key: c.params.type } : c;
    return DEFAULT_KEY[c.type] ? { ...c, key: DEFAULT_KEY[c.type] } : c;
  });
}

// ------------------------------------------------------------ placing a copy (6b)
// A copy is placed as ORDINARY verbs (principle 1: the log records the result):
// each part a `spawn` (an Empty when it has no Model), a child `mount`ed under
// its parent at its LOCAL pose, every other component a `comp`, the link a
// `comp blueprint`. Nothing on the wire is new except what the link says:
//   root   comp.blueprint = { hash, name }   — this is a copy of record `hash`
//   child  comp.blueprint = { part: <id> }   — this is the part `id` of the copy
//                                              it rides (the record's child id)
// The part marker is how a copy is read back as a tree whatever its entity ids
// are (they are minted at placement), and how 6c's update finds "the bulb" in
// the next version. It rides each part rather than a map on the root because a
// comp is at most 8 KB and a record may hold 256 parts.
export const LINK_KEY = 'blueprint';
const isBagV = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
/** Is this comp.blueprint value a copy's link ({hash, name})? */
export const isLink = (v) => isBagV(v) && typeof v.hash === 'string' && HEX64.test(v.hash);
/** Is this comp.blueprint value a part marker ({part})? */
export const isPartMarker = (v) => isBagV(v) && typeof v.part === 'string' && !!v.part && !isLink(v);

const r4 = (v) => +(+v).toFixed(4);
const r9 = (v) => +(+v).toFixed(9);
const upright = (q) => Math.abs(q[0]) < 1e-9 && Math.abs(q[2]) < 1e-9;
const slug = (s) => String(s).replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 24) || 'part';
/** The comp entries a component writes, as `[key, data]` (entityOf's bytes). */
const compEntries = (inst) => Object.entries(recordComponents(entityOf({ components: [inst] }))).filter(([k]) => k !== 'model' && k !== 'parent');
const RULES = new Set(['lock', 'guard']);   // written last: a lock refuses the mount; guard last for symmetry

/** Why this record cannot be placed as ordinary verbs, or null. The shape is
 *  blueprintRefusal's; on top of it, what the door would refuse one verb at a
 *  time — a light or collider the component contract refuses, a comp with no
 *  data, a key the door would truncate — is refused here for the whole copy,
 *  before anything is sent (a half-placed copy is worse than none). */
export function placeRefusal(rec) {
  const shape = blueprintRefusal(rec);
  if (shape) return shape;
  const node = (n, where) => {
    const comps = modernize(n.components);
    if (comps.some((c) => c.type === 'Light' && c.key == null)) return `${where} holds a light in both spellings (kind:"light" and comp.light) — a placed part has one`;
    for (const c of comps) {
      if (c.type === 'Transform') {
        const ro = c.params?.rotOrder;
        const why = ro !== undefined && compRefusal('rotOrder', ro, null);
        if (why) return `${where}: ${why}`;
        continue;
      }
      if (c.type === 'Model') continue;
      if (c.type === 'Collider' && c.key == null) continue;   // the legacy collide, written by spawn
      let entries;
      try { entries = compEntries(c); } catch (e) { return `${where}: ${e.message}`; }
      for (const [key, data] of entries) {
        if (key === LINK_KEY) return `${where}: a "${LINK_KEY}" component is the copy's link, never part of a design`;
        if (key.length > 32) return `${where}: the component key "${key.slice(0, 40)}…" is longer than the 32 characters a comp may be named`;
        if (data === undefined || data === null) return `${where}: the ${c.type} component "${key}" holds no data, and a comp with none is a removal`;
        const why = compRefusal(key, data, null);
        if (why) return `${where}: ${why}`;
      }
    }
    for (const [i, k] of n.children.entries()) { const why = node(k, `${where}.children[${i}] ("${k.id}")`); if (why) return why; }
    return null;
  };
  return node(rec.root, 'root');
}

/** The verbs that place a copy of `rec`, and the verbs that take it away again
 *  — ONE undo step on every surface:
 *    { verbs, inverses, parts: { <path>: <entity id> }, errors }
 *  `at` is where the root stands: {id, pos, q?, yaw?, scale?} (q wins over a
 *  bare yaw; `scale` multiplies the record's own root scale, the ghost's
 *  R-drag). `taken(id)` says an entity id is already in use, so a minted part
 *  id never replaces something standing. Parts are named `<root>-<child id>`
 *  (made unique), so the Hierarchy reads like the design.
 *  Order: per part, `spawn` (parents first) → `mount` → its comps → its link;
 *  then every lock and guard, because a locked part refuses its own mount.
 *  The inverses unlock what the copy locked, then remove the parts leaves
 *  first (a removed carrier would otherwise stamp its occupants down first). */
export function placeVerbs(rec, at, { hash = null, taken = () => false } = {}) {
  const why = placeRefusal(rec);
  if (why) return { verbs: [], inverses: [], parts: {}, errors: [why] };
  if (!at || typeof at.id !== 'string' || !at.id || at.id.length > 64) return { verbs: [], inverses: [], parts: {}, errors: ['a copy needs a root id (1–64 characters)'] };
  if (taken(at.id)) return { verbs: [], inverses: [], parts: {}, errors: [`${at.id} is already in use`] };
  const pos = Array.isArray(at.pos) && at.pos.length === 3 && at.pos.every(Number.isFinite) ? at.pos : null;
  if (!pos) return { verbs: [], inverses: [], parts: {}, errors: ['a copy needs a position: pos [x, y, z]'] };
  hash ??= blueprintHash(rec);
  const used = new Set([at.id]);
  const mint = (partId) => {
    const base = `${at.id}-${slug(partId)}`.slice(0, 60);
    let id = base;
    for (let n = 2; used.has(id) || taken(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };
  // the plan, parents first, with a synthetic fold to compose world poses from
  const plan = [];
  const world = {};
  const walk = (n, path, entId, parentEnt) => {
    const comps = modernize(n.components);
    const tf = { ...(comps.find((c) => c.type === 'Transform')?.params ?? {}) };
    const isRoot = parentEnt == null;
    let scale = tf.scale;
    if (isRoot && Number.isFinite(at.scale) && at.scale !== 1) scale = r9((tf.scale ?? 1) * at.scale);
    if (isRoot) {
      const q = qNorm(at.q);
      world[entId] = { pos, ...(q ? { q } : {}), yaw: q ? qHeading(q) : (Number.isFinite(at.yaw) ? at.yaw : 0), ...(scale != null ? { scale } : {}) };
    } else {
      world[entId] = { pos: [0, 0, 0], parent: { to: parentEnt, ...(Array.isArray(tf.pos) ? { offset: tf.pos } : {}), ...(tf.yaw != null ? { yaw: tf.yaw } : {}), ...(qNorm(tf.q) ? { q: qNorm(tf.q) } : {}) }, ...(scale != null ? { scale } : {}) };
    }
    plan.push({ n, path, entId, parentEnt, comps, tf, scale });
    for (const k of n.children) {
      const p = path ? `${path}/${k.id}` : k.id;
      walk(k, p, mint(k.id), entId);
    }
  };
  walk(rec.root, '', at.id, null);

  const verbs = [], rules = [], parts = {};
  const orient = (q) => (upright(q) ? { yaw: r9(qHeading(q)) } : { q: q.map(r9), yaw: r9(qHeading(q)) });
  for (const { n, path, entId, parentEnt, comps, tf, scale } of plan) {
    parts[path] = entId;
    const model = comps.find((c) => c.type === 'Model');
    const legacyCollide = comps.find((c) => c.type === 'Collider' && c.key == null);
    // spawn where it will stand (a child at its composed world pose, so nothing
    // jumps between its spawn and its mount); a child's own pos/q is then its
    // pre-mount pose, unused until a dismount stamps a new one (hierarchy.js)
    const W = worldPose(world, entId);
    const pose = parentEnt == null
      ? { pos: [...pos], ...(world[entId].q ? { q: world[entId].q, yaw: world[entId].yaw } : { yaw: world[entId].yaw }) }
      : { pos: W.pos.map(r4), ...orient(W.q) };
    verbs.push({ verb: 'spawn', args: { id: entId, ...(model ? { lib: model.params.lib } : {}), ...pose,
      ...(scale != null ? { scale } : {}), ...(legacyCollide ? { collide: legacyCollide.params.shape } : {}) } });
    if (parentEnt != null) {
      verbs.push({ verb: 'mount', args: { id: entId, to: parentEnt, ...(Array.isArray(tf.pos) ? { offset: tf.pos } : {}),
        ...(tf.q !== undefined ? { q: tf.q } : {}), ...(tf.yaw !== undefined ? { yaw: tf.yaw } : {}) } });
    }
    for (const c of comps) {
      if (c.type === 'Model' || c === legacyCollide) continue;
      if (c.type === 'Transform') {
        if (tf.rotOrder !== undefined) verbs.push({ verb: 'comp', args: { id: entId, type: 'rotOrder', data: tf.rotOrder } });
        continue;
      }
      for (const [type, data] of compEntries(c)) (RULES.has(type) ? rules : verbs).push({ verb: 'comp', args: { id: entId, type, data } });
    }
    verbs.push({ verb: 'comp', args: { id: entId, type: LINK_KEY, data: parentEnt == null ? linkOf(rec, hash) : { part: n.id } } });
  }
  verbs.push(...rules);
  const inverses = [
    ...rules.filter((v) => v.args.type === 'lock').map((v) => ({ verb: 'comp', args: { id: v.args.id, type: 'lock', data: null } })),
    ...[...plan].reverse().map((p) => ({ verb: 'remove', args: { id: p.entId } })),
  ];
  return { verbs, inverses, parts, errors: [] };
}

// ------------------------------------------------------------ reading a copy back (6b)
/** The copy `id` belongs to: { root, path } where `root` is the entity holding
 *  the link and `path` the part ids from it down to `id` ([] = the root
 *  itself) — or null when `id` is not in a copy. Walks the fold's parent edges
 *  up; a part whose chain no longer reaches a linked root is in no copy. */
export function copyOf(world, id) {
  const path = [];
  const seen = new Set();
  for (let cur = id; cur != null && world?.[cur] && !seen.has(cur); cur = world[cur].parent?.to) {
    seen.add(cur);
    const b = world[cur]?.[LINK_KEY];
    if (isLink(b)) return { root: cur, path, link: { hash: b.hash, name: typeof b.name === 'string' ? b.name : null } };
    if (!isPartMarker(b)) return null;
    path.unshift(b.part);
  }
  return null;
}

/** A child entity's components with its Transform made LOCAL (exported for
 *  6c's Save as Blueprint, which reads a selection's children the same way): the mount's
 *  offset and relative orientation (a slot's pose when the mount names a slot
 *  and no offset), its own scale and rotation order. The fold's pos/q on a
 *  mounted thing is its pre-mount pose, not where it is (hierarchy.js). */
export function localComponents(world, ent) {
  const { components } = componentsOf(ent);
  const rel = ent.parent ?? {};
  return components.map((c) => {
    if (c.type !== 'Transform') return c;
    const { pos: _p, q: _q, yaw: _y, ...rest } = c.params;
    const tf = { ...rest };
    const sock = !Array.isArray(rel.offset) && rel.socket ? socketOf(world, rel) : null;
    if (Array.isArray(rel.offset)) tf.pos = rel.offset;
    else if (Array.isArray(sock?.pos)) tf.pos = sock.pos;
    if (rel.q !== undefined) tf.q = rel.q;
    if (rel.yaw !== undefined) tf.yaw = rel.yaw;
    else if (rel.q === undefined && sock) tf.q = socketQ(sock);
    return { ...c, params: tf };
  });
}

/** Read a placed copy back as a tree in the record's shape — what 6c hands
 *  overridesOf and rebase:
 *    { root, hash, name, tree: {components, children: [{id, …}]},
 *      parts: { <path>: <entity id> } }
 *  or null when `rootId` holds no link. The root's components are as the world
 *  holds them (its placement, any parent of its own and the link included —
 *  overridesOf leaves those out); every child's Transform is LOCAL. A child is
 *  named by its part marker; a child with none (something parented into the
 *  copy since) or with a marker a sibling already holds is an ADDED part, named
 *  by its entity id — so overridesOf reports it as added, never as the part it
 *  imitates. `rec`, when given, orders children as the record does. A child
 *  that is itself another copy's root is not descended into: it is an added
 *  part carrying its own link (nested copies are not v1). */
export function copyTree(world, rootId, rec = null) {
  const root = world?.[rootId];
  const link = root?.[LINK_KEY];
  if (!isLink(link)) return null;
  const parts = { '': rootId };
  const seen = new Set([rootId]);
  const order = (recNode) => new Map((recNode?.children ?? []).map((k, i) => [k.id, i]));
  const kids = (entId, path, recNode) => {
    const named = [];
    const ids = new Set();
    for (const cid of childrenOf(world, entId)) {
      if (seen.has(cid)) continue;   // a hand-written cycle: never twice
      seen.add(cid);
      const ent = world[cid];
      const b = ent?.[LINK_KEY];
      let id = isPartMarker(b) && !ids.has(b.part) ? b.part : cid;
      for (let n = 2; ids.has(id); n++) id = `${cid}~${n}`;
      ids.add(id);
      named.push({ id, cid, ent, nested: isLink(b) });
    }
    const at = order(recNode);
    named.sort((a, b) => (at.get(a.id) ?? Infinity) - (at.get(b.id) ?? Infinity) || (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0));
    return named.map(({ id, cid, ent, nested }) => {
      const p = path ? `${path}/${id}` : id;
      parts[p] = cid;
      const recKid = recNode?.children?.find((k) => k.id === id) ?? null;
      return { id, components: localComponents(world, ent), children: nested ? [] : kids(cid, p, recKid) };
    });
  };
  const tree = { components: componentsOf(root).components, children: kids(rootId, '', rec?.root ?? null) };
  return { root: rootId, hash: link.hash, name: typeof link.name === 'string' ? link.name : null, tree, parts };
}

/** Where copies stand: { <hash>: [root ids, sorted] } for every linked root. */
export function copiesOf(world) {
  const out = {};
  for (const id of Object.keys(world ?? {}).sort()) {
    const b = world[id]?.[LINK_KEY];
    if (isLink(b)) (out[b.hash] ??= []).push(id);
  }
  return out;
}

/** A record's version number in this world: how many of its lineage the
 *  store holds (v1 = an original). 0 when the store lacks the record. */
export const versionOf = (store, hash) => (store?.[hash] ? lineageOf(store, hash).filter((h) => store[h]).length : 0);

/** One line a reader can act on — `a copy of "Lamp" (v2, 1a2b3c4d5e6f)` for a
 *  root, `part "bulb" of lamp-1, a copy of "Lamp" (v2, …)` for a part — or
 *  null when `id` is in no copy. The text tier, inspect and the panels say
 *  the same words. The name is the store's when it holds the record (the
 *  link's `name` is what it was called when placed). */
export function copyLine(world, id, store = null) {
  const c = copyOf(world, id);
  if (!c) return null;
  const rec = store?.[c.link.hash]?.record;
  const v = versionOf(store, c.link.hash);
  const what = `a copy of "${rec?.name ?? c.link.name ?? '?'}" (${v ? `v${v}, ` : ''}${c.link.hash.slice(0, 12)}${v ? '' : ', not in this world\'s store'})`;
  return c.path.length ? `part "${c.path.join('/')}" of ${c.root}, ${what}` : what;
}
