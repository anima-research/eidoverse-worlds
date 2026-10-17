// server/eidoindex.ts — which file on this host holds the bytes an eido:sha256/<hex> address names (spec/EIDO-URIS.md §2:
// the origin host is a resolver). Review 2026-10-07 H3: a translated world's models are addresses, never this host's paths.
//   - a store blob is named by the first 16 hex of its upload's sha256 (server/upload.ts), so an address is found by that
//     prefix and checked against the whole digest of the bytes. Some blobs on a long-lived host no longer hash to their
//     name (rewritten in place after upload): their address is the digest of the bytes this host actually has, recorded
//     in the index, and the translator lists them (storeNameMatches) so the operator knows;
//   - a library model's address is its ORIGINAL's (LIBRARY_DIR), never the optimized mirror in OPT_DIR, which is a
//     different byte string (§1a); whoever computes one (the translator) records it in OPT_DIR/eido-index.json; the model
//     catalogue notes each one it hashes at measure for this process (noteEido).
// R 10-17: a model is stored as its library path, so nothing a world needs to LOAD depends on this index; it resolves an
// address stored before (translate-v1@8–@11) and a model-hash's bytes (/eido/sha256/<hex>).
// The address always names the original; /library/eido/… may still serve the host's rendition (routes.ts).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { OPT_DIR, LIBRARY_DIR } from "./config.ts";

const INDEX = path.join(OPT_DIR, "eido-index.json");
let index: Record<string, string> | null = null, indexMtime = -1;
function load(): Record<string, string> {
  let m = -1; try { m = fs.statSync(INDEX).mtimeMs; } catch { /* no index yet */ }
  if (index && m === indexMtime) return index;
  try { index = m >= 0 ? JSON.parse(fs.readFileSync(INDEX, "utf8")) : {}; } catch { index = {}; }
  indexMtime = m; return index!;
}
const sha = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const inside = (base: string, rel: string) => { const p = path.normalize(path.join(base, rel)); return p.startsWith(base + path.sep) ? p : null; };
/** The original file a library-style path names on this host (the store's blob, or the library's own file), or null. */
export function originalOf(rel: string): string | null {
  if (typeof rel !== "string" || rel.includes("..") || !/\.(glb|vrm)$/i.test(rel)) return null;
  const p = rel.startsWith("store/") ? inside(OPT_DIR, rel) : inside(LIBRARY_DIR, rel);
  return p && fs.existsSync(p) ? p : null;
}
/** The full sha256 of the original bytes a path names on this host, or null (no such file). */
export function contentAddressOf(rel: string): string | null {
  const p = originalOf(rel); return p ? sha(p) : null;
}
/** Whether a store blob's bytes still hash to its name (true for anything that isn't a store blob). */
export function storeNameMatches(rel: string): boolean {
  if (!rel.startsWith("store/")) return true; const h = contentAddressOf(rel);
  return !!h && h.startsWith(path.basename(rel).replace(/\.(glb|vrm)$/i, ""));
}
/** Remember that `hex` is `rel` here (the translator, after computing it). */
export function recordEido(hex: string, rel: string) {
  const I = { ...load(), [hex]: rel }; fs.mkdirSync(OPT_DIR, { recursive: true });
  const tmp = `${INDEX}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(I, null, 1)); fs.renameSync(tmp, INDEX); index = I; indexMtime = fs.statSync(INDEX).mtimeMs;
}
const checked = new Map<string, string | null>();   // hex → rel, verified against the bytes once per process
/** Remember, for this process, that `rel`'s original bytes hash to `hex` (the catalogue, having just hashed them at measure:
 *  R 10-17, a model-hash's bytes are then fetchable here by /eido/sha256/<hex>). Nothing is written to disk. */
export function noteEido(hex: string, rel: string) { if (/^[0-9a-f]{64}$/.test(hex) && typeof rel === "string" && !checked.get(hex)) checked.set(hex, rel); }
/** The library-style path on this host whose ORIGINAL bytes are `hex`, or null. */
export function eidoRel(hex: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  if (checked.has(hex)) return checked.get(hex)!;
  const cands = [load()[hex], ...["glb", "vrm"].map((x) => `store/${hex.slice(0, 16)}.${x}`)].filter((x): x is string => typeof x === "string");
  for (const rel of cands) if (contentAddressOf(rel) === hex) { checked.set(hex, rel); return rel; }
  return null;   // not cached: a blob uploaded later may answer it
}
/** The file holding exactly the bytes `hex` names, or null. */
export const eidoFile = (hex: string): string | null => { const rel = eidoRel(hex); return rel ? originalOf(rel) : null; };
