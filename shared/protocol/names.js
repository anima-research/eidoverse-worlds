// shared/protocol/names.js — the ONE mapping from an engine name (an actor, entity id, role key, component name) to the
// §2.3 grammar, used by both the translator (old logs) and the live authority (server: who is asking). If the two ever
// spelled one person differently, nobody in a translated world would match their own role (research 35, slice-2 #3).
//
//   enc(s)     an identity / entity id / key: [a-z0-9-]{1,64}. A name the grammar already accepts, and that doesn't
//              start with an escape prefix, is kept as it is. Anything else becomes "x--" + hex(utf8) or, when that
//              would pass 64 characters, "h--" + the first 61 hex of its sha256 (not invertible: decode says so).
//   encName(s) a component name: [a-z][a-z0-9-]* (+ domain/version/key per §2.3). A name the grammar accepts is
//              kept; anything else is ALWAYS escaped the same way (x--/h--, which start with a letter).
//   dec(s)     the inverse of enc for x-- names; null for an h-- name (a hash can't be read back).
//
// Injective: a kept name never starts with x-- or h--; an escaped one always does, and x-- names are distinct hex;
// h-- names collide only if sha256 does.
//
// The engine fix (research 35, "a real enc collision"): the lab's encName escaped a name like "0abc" (valid as an
// identity, not as a component, which must start with a letter) by prefixing "n", giving "n0abc" — which is also
// what a genuine component called "n0abc" keeps. Two different old names, one name. Here a component name the
// grammar refuses always takes the x-- form, so "0abc" → "x--30616263" and "n0abc" stays "n0abc". The lab still
// has the old rule (noted for it in research 37; the lab is not edited from here).
import { sha256, utf8Hex } from "./hash.js";
import { isComponent } from "./fold.js";

const ESC = /^[xh]--/;
const escape = (s) => { const hex = utf8Hex(s); return hex.length + 3 <= 64 ? `x--${hex}` : `h--${sha256(s).slice(0, 61)}`; };

/** @param {unknown} s @returns {string} */
export function enc(s) {
  s = String(s);
  return /^[a-z0-9-]{1,64}$/.test(s) && !ESC.test(s) ? s : escape(s);
}
/** @param {unknown} s @returns {string} */
export function encName(s) {
  s = String(s);
  return isComponent(s) && !ESC.test(s) ? s : escape(s);
}
/** The local tag of the component that moves one node of a thing's model: motion:<partSlot(node)> {node, …}. A node's name
 *  comes from a model file and is DATA (any characters: tripo_part_3, "Seat Plank", 座席); the key needs a §2.3 tag
 *  ([a-z0-9-]{1,64}). A name that already is one, and isn't an escape, is its own tag ("seat", "arm-2"); any other is
 *  lowercased, its runs of other characters become one dash, cut to 48, and given 8 hex of its sha256 so two names that
 *  sanitize alike ("Tripo_Part", "tripo-part") still differ: tripo_part_3 → tripo-part-3-<8 hex>. Pure: every server, the
 *  load's repair, the translator and the editors write the same key for the same node. Readers never parse it: they read
 *  the value's `node`.
 *  @param {unknown} node @returns {string} */
export function partSlot(node) {
  const s = String(node);
  if (/^[a-z0-9-]{1,64}$/.test(s) && !ESC.test(s)) return s;
  const base = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  return `${base || "node"}-${sha256(s).slice(0, 8)}`;
}
// The node a motion moves, by its key and value (review r7, R 10-16: a node's name is DATA): a keyed motion's `node`
// (motion:<slot> {node}); a keyed one stored before the node was data, its key's tag (the load's repair writes that
// down); a whole motion naming `part` (the first spelling, before its first load's repair), that part. Null: the whole
// thing. The one reading every reader shares (renderer, seat signals, editor, agent).
/** @param {string} key @param {any} m @returns {string | null} */
export function motionNode(key, m) {
  if (key === "motion") return m && typeof m.part === "string" && m.part ? m.part : null;
  if (typeof key !== "string" || !key.startsWith("motion:")) return null;
  return m && typeof m.node === "string" && m.node ? m.node : key.slice(7);
}

// A motion's type (R 10-17 21:40: the back-and-forth along an axis is `oscillate`; it was bob before release). The old
// spelling is READ for one release (a value an older log stored, a replica that folded it before the load's rename); the
// door takes it and stores today's, and every load renames a stored one (shaperepair.js renameFields, rename-components).
// The one reading every reader shares (renderer, seat signals, editor, agent): the old word is spelled here and nowhere
// else in a reader (tools/protocol/vocab-check.ts).
export const OLD_MOTION_TYPES = Object.freeze({ bob: "oscillate" });
/** @param {any} m a motion value @returns {any} its type in today's spelling (anything else as it is) */
export function motionType(m) {
  const t = m?.type;
  return typeof t === "string" && Object.hasOwn(OLD_MOTION_TYPES, t) ? OLD_MOTION_TYPES[t] : t;
}

/** @param {string} s @returns {string | null} the original name, or null when it was hashed (h--) */
export function dec(s) {
  if (typeof s !== "string") return null;
  if (s.startsWith("h--")) return null;
  if (!s.startsWith("x--")) return s;
  const hex = s.slice(3);
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)))); }
  catch { return null; }
}

// ---- display names for actors (round-2 review R1) ----
// A actor is an opaque id, u- + 20 base32 (server/directory.ts). Its display name lives in the authority's
// directory, outside the log (§2.3), and reaches clients beside the entries ({names: {id: name}}). Every client in a
// process feeds this one registry (ids are random, so worlds and doors can't collide), and every place that shows a
// person reads it: actorName(id) is the name, else an old escaped identity read back, else the id itself.
export const ACTOR_ID = /\bu-[a-z2-7]{20}\b/g;
const NAMES = Object.create(null);
export function learnNames(o) { if (o && typeof o === "object") for (const [k, n] of Object.entries(o)) if (typeof n === "string" && n) NAMES[k] = n; }
export const actorName = (id) => NAMES[String(id)] ?? dec(String(id)) ?? String(id);
