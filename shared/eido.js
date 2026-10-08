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
/** The reverse: a /library/ rel naming an address → its digest, or null. */
export const hexOfLibRel = (rel) => { const m = /^eido\/sha256\/([0-9a-f]{64})\.glb$/.exec(String(rel)); return m ? m[1] : null; };
