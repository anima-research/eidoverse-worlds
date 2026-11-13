// shared/eido.js — content addresses for models (spec/EIDO-URIS.md; review 2026-10-07 H3). R 10-17: a model is stored as its
// LIBRARY PATH (the portable reference) with its bytes' hash beside it (model-hash sha256:<64 hex>); an `eido:sha256/<64 hex>`
// value stored before (translate-v1@8–@11) is still read: these map it to /library and to a word. `model`'s media is fixed by
// its role (a glTF binary), so the bare string is complete.
export const EIDO = /^eido:sha256\/([0-9a-f]{64})$/;
export const isEido = (s) => typeof s === "string" && EIDO.test(s);
/** The 64-hex digest of an eido: URI, or null. */
export const eidoHex = (s) => (typeof s === "string" ? EIDO.exec(s)?.[1] ?? null : null);
/** What to ask this host's /library/ for: an address as eido/sha256/<hex>.glb (the host maps it to its own file and serves
 *  its best rendition, as for any library path); anything else as it is. The one mapping the client and server share. */
export const libRelOf = (model) => { const h = eidoHex(model); return h ? `eido/sha256/${h}.glb` : model; };
/** The reverse: a /library/ rel naming an address → its digest, or null. Both spellings name it: libRelOf's
 *  eido/sha256/<hex>.glb and the stored address itself (GET /library/eido:sha256/<hex>, the colon raw or %3A), so a reader
 *  that fetches /library/<model> never has to know a model may be an (old) address. */
export const hexOfLibRel = (rel) => { const m = /^eido(?:\/|:|%3[Aa])sha256\/([0-9a-f]{64})(\.glb)?$/.exec(String(rel));
  return m && (m[2] ? /^eido\//.test(String(rel)) : !/^eido\//.test(String(rel))) ? m[1] : null; };

// ---- a person's word for a model. A model is its library path (R 10-17), whose file name is the word; an address stored before
// 10-17 has a hex for a file name, so it reads as the word a caller can give (the catalogue's label for the file its index
// names), else "thing", never its hex. Words only: nothing that must replay alike is decided by them.
const HEXY = /^(?:eido:sha256\/)?[0-9a-f]{64}$/;
const stemOf = (s) => String(s).split(/[?#]/, 1)[0].split("/").pop().replace(/\.(glb|vrm)$/i, "");
/** A person's word for a model: `nameOf(model)` first (a library listing's name, a catalogue's label, a path), else a path's
 *  file name without its extension; an address nobody can name is 'thing', never its hex. A name that looks like a path is
 *  cut to its file name. */
export function modelWord(model, nameOf = null) {
  const tryName = (n) => { if (typeof n !== "string" || !n.trim() || HEXY.test(n.trim())) return null;
    const w = /[/]|\.(glb|vrm)$/i.test(n) ? stemOf(n) : n.trim(); return w && !HEXY.test(w) ? w : null; };
  let n = null;
  if (typeof nameOf === "function") { try { n = tryName(nameOf(model)); } catch { n = null; } }
  if (n) return n;
  if (typeof model !== "string" || !model.trim() || isEido(model)) return "thing";
  return stemOf(model) || "thing";
}
/** Is this model a VRM (a body)? By its path. */
export const isVrmModel = (model) => /\.vrm(\?|#|$)/i.test(String(model ?? ""));
