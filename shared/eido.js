// shared/eido.js — content addresses for models (spec/EIDO-URIS.md; review 2026-10-07 H3). A translated world's `model`
// values are `eido:sha256/<64 hex>`, the identity of the original bytes rather than this host's path to them, so a carried
// world resolves anywhere. `model`'s media is fixed by its role (a glTF binary), so the bare string is complete.
export const EIDO = /^eido:sha256\/([0-9a-f]{64})$/;
export const isEido = (s) => typeof s === "string" && EIDO.test(s);
/** The 64-hex digest of an eido: URI, or null. */
export const eidoHex = (s) => (typeof s === "string" ? EIDO.exec(s)?.[1] ?? null : null);
/** What to ask this host's /library/ for: an address as eido/sha256/<hex>.glb (the host maps it to its own file and serves
 *  its best rendition, as for any library path); anything else as it is. The one mapping the client and server share. */
export const libRelOf = (model) => { const h = eidoHex(model); return h ? `eido/sha256/${h}.glb` : model; };
/** The reverse: a /library/ rel naming an address → its digest, or null. Both spellings name it: libRelOf's
 *  eido/sha256/<hex>.glb and the stored address itself (GET /library/eido:sha256/<hex>, the colon raw or %3A), so a reader
 *  that fetches /library/<model> never has to know a model may be an address (shape audit 10-16: the door stores addresses). */
export const hexOfLibRel = (rel) => { const m = /^eido(?:\/|:|%3[Aa])sha256\/([0-9a-f]{64})(\.glb)?$/.exec(String(rel));
  return m && (m[2] ? /^eido\//.test(String(rel)) : !/^eido\//.test(String(rel))) ? m[1] : null; };

// ---- a person's word for a model (shape audit 10-16: the write door stores `model` as its address, so a word, an id, a
// type guess can no longer be read off the value: an address's file name is its hex). One registry, address → the path
// this host knows its bytes by: the server records it when it addresses a path (modelcatalogue address/measure), a client
// or an agent when /library answers an address (the x-library-path header, routes.ts). Words only: nothing is ever
// decided by it that must replay alike (the sandbox's minted ids pass no names).
const learned = new Map();
/** Record that `model` (an address) names the file at `path` here. */
export function learnModelPath(model, path) {
  if (!isEido(model) || typeof path !== "string" || !path || isEido(path) || path.length > 512) return;
  learned.delete(model); learned.set(model, path);
  if (learned.size > 20000) learned.delete(learned.keys().next().value);
}
/** The path this host knows an address's bytes by, or null (a path is its own). */
export const learnedModelPath = (model) => (isEido(model) ? learned.get(model) ?? null : null);
const HEXY = /^(?:eido:sha256\/)?[0-9a-f]{64}$/;
const stemOf = (s) => String(s).split(/[?#]/, 1)[0].split("/").pop().replace(/\.(glb|vrm)$/i, "");
/** A person's word for a model: `nameOf(model)` first (a library listing's name, a catalogue's label, a path), else the
 *  path this host learned for an address, else a path's file name without its extension; an address nobody can name is
 *  'thing', never its hex. A name that looks like a path is cut to its file name. Pass nameOf = null for no lookups. */
export function modelWord(model, nameOf = learnedModelPath) {
  const tryName = (n) => { if (typeof n !== "string" || !n.trim() || HEXY.test(n.trim())) return null;
    const w = /[/]|\.(glb|vrm)$/i.test(n) ? stemOf(n) : n.trim(); return w && !HEXY.test(w) ? w : null; };
  let n = null;
  if (typeof nameOf === "function") { try { n = tryName(nameOf(model)); } catch { n = null; } }
  if (!n && nameOf && nameOf !== learnedModelPath) n = tryName(learnedModelPath(model));
  if (n) return n;
  if (typeof model !== "string" || !model.trim() || isEido(model)) return "thing";
  return stemOf(model) || "thing";
}
/** Is this model a VRM (a body)? An address asks the path this host learned for it. */
export const isVrmModel = (model) => /\.vrm(\?|#|$)/i.test(String(learnedModelPath(model) ?? model ?? ""));
