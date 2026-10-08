// The ONE resolver from a library path (a model's lib) to a file on disk: the optimized copy first, then the source
// library. Refuses anything that isn't a .glb/.vrm or that walks out of its base.
import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { OPT_DIR, LIBRARY_DIR } from "./config.ts";
import { eidoHex } from "../shared/eido.js";
import { eidoFile } from "./eidoindex.ts";

export function resolveLibFile(lib: string): string | null {
  // a content address (eido:sha256/<hex>; review 10-07 H3): the original bytes it names, wherever this host keeps them
  const hex = eidoHex(lib); if (hex) return eidoFile(hex);
  const rel = normalize(lib).replace(/^\/+/, "");
  if (rel.includes("..") || !/\.(glb|vrm)$/i.test(rel)) return null;
  for (const base of [OPT_DIR, LIBRARY_DIR]) {
    const p = normalize(join(base, rel));
    if (p.startsWith(base) && existsSync(p)) return p;
  }
  return null;
}
