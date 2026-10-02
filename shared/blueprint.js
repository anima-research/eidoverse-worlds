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

import { canon, sha256hex, entityOf, RECORDS } from './components.js';

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
  Attachment: 'a node is attached by nesting it under its parent, not by an Attachment',
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
    if (c.type === 'Attachment') continue;
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
    for (const c of d.comps) {
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
