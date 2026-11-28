// The one resolver from a library path (a model's lib) to a file on disk: exactly what /library would serve (routes.ts), the
// same ladder in the same order, the first rung holding the name deciding (a directory shadows a file below it). Refuses
// anything that isn't a .glb/.vrm or walks out of the library.
import { statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { LADDER } from "./config.ts";
import { eidoHex } from "../shared/eido.js";
import { eidoFile } from "./eidoindex.ts";

function entryAt(p: string): boolean {
  try { statSync(p); return true; } catch { return false; }
}

/** The rung-relative disk path /library/<encoded> serves, or null to refuse. `encoded` is the still-encoded remainder of
 *  URL.pathname, so the route and libraryFile() read a name the same way. Each run of %-escapes is decoded on its own:
 *  - a raw path that already names an entry on any rung wins ("box%41.glb" stays itself);
 *  - a malformed run, or one decoding to NUL, keeps its characters; a bare "%" stays, so the rest still decodes;
 *  - a ".." segment after decoding is refused outright (a normalize()+startsWith(base) check is only a string prefix). */
export function libraryRel(encoded: string): string | null {
  let rel = encoded;
  if (rel.includes("%") && !LADDER.some(base => entryAt(join(base, rel)))) {
    rel = rel.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
      try { const d = decodeURIComponent(run); return d.includes("\0") ? run : d; } catch { return run; }
    });
  }
  return rel.split(/[\/\\]/).includes("..") ? null : rel;
}

/** The file /library would serve for a lib with this extension, or null. The lib is read as the client's URL carries it
 *  (query/fragment removed) and decoded by libraryRel(). `..` is traversal only as a whole segment; "robot..v2.glb" is a name. */
export function libraryFile(lib: unknown, extension: RegExp): string | null {
  if (typeof lib !== "string" || lib.split(/[?#]/, 1)[0].includes("\0")) return null;
  let pathname: string;
  try { pathname = new URL("/library/" + lib, "http://library.invalid").pathname; } catch { return null; }
  if (!pathname.startsWith("/library/")) return null;
  const encoded = normalize(pathname.slice("/library/".length)).replace(/^\/+/, "");
  if (!encoded || encoded.split(/[\\/]/).includes("..")) return null;
  const rel = libraryRel(encoded);
  if (rel === null || !extension.test(rel)) return null;
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

export function resolveLibFile(lib: string): string | null {
  if (typeof lib !== "string") return null;
  // a content address (eido:sha256/<hex>): the original bytes it names, wherever this host keeps them
  const hex = eidoHex(lib); if (hex) return eidoFile(hex);
  return libraryFile(lib, /\.(glb|vrm)$/i);
}
