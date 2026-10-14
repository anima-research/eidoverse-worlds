// The ONE resolver from a library path (a model's lib) to a file on disk. It answers exactly what /library would serve
// (routes.ts): the same ladder, in the same order — a patch, then the optimized copy, then the source library — and the
// first rung holding the NAME decides, so a directory there shadows a file below it, as the route's 404 does. Refuses
// anything that isn't a .glb/.vrm or that walks out of the library. (Upstream #213's contract, ported 2026-10-14; the
// authority refuses a model this can't name, so this is where "does /library have it" is decided once.)
import { statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { LADDER } from "./config.ts";
import { eidoHex } from "../shared/eido.js";
import { eidoFile } from "./eidoindex.ts";

export function resolveLibFile(lib: string): string | null {
  if (typeof lib !== "string") return null;
  // a content address (eido:sha256/<hex>; review 10-07 H3): the original bytes it names, wherever this host keeps them
  const hex = eidoHex(lib); if (hex) return eidoFile(hex);
  // a version or fragment (model.glb?v=3, model.glb#mesh) names the same served file
  const rel = normalize(lib.split(/[?#]/, 1)[0]).replace(/^\/+/, "");
  // `..` is traversal only as a whole segment; "robot..v2.glb" is a name
  if (!rel || rel.split(/[\\/]/).includes("..") || !/\.(glb|vrm)$/i.test(rel)) return null;
  for (const base of LADDER) {
    const p = normalize(join(base, rel));
    if (!p.startsWith(base + sep)) return null;   // normalized out of its base: the route would never serve it
    let st; try { st = statSync(p); } catch (e: any) {
      if (e?.code === "ENOENT") continue;         // nothing on this rung: the next one may hold it
      return null;                                // a path through a file (ENOTDIR), a name too long: no file, not a throw
    }
    return st.isFile() ? p : null;                // the first entry decides; a directory is no model (and shadows lower rungs)
  }
  return null;
}
