// tools/protocol/import-v1/build.ts — the exact build of the engine's v1 fold, for the translator's stamp (research 35, slice-2 #1).
// A translated log is a regenerable cache of the v1 log (R9); it names the translator AND the v1 fold that read the
// old log, so a later engine can tell whether re-translating would give the same bytes. The build is the sha256 of
// the importer's fold.js and every module it imports (followed through relative imports), in a fixed order, first 16
// hex. NOTE: most of those modules are shared runtime modules (forecast, captions, blueprint, components…), so the stamp
// moves whenever they change, not only when the old fold does; the importer is temporary (README.md), so this stays.
// the same scheme as EIDOSIM_BUILD.
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { sha256 } from "../../../shared/protocol/hash.js";

const ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
/** The importer's fold.js and its import closure, repo-relative, sorted. */
export function v1FoldFiles(entry = "tools/protocol/import-v1/fold.js"): string[] {
  const seen = new Set<string>(); const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!; if (seen.has(f)) continue; seen.add(f);
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const m of src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]/gm))
      stack.push(path.normalize(path.join(path.dirname(f), m[1])));
  }
  return [...seen].sort();
}
let cached: string | null = null;
export function v1FoldBuild(): string {
  return (cached ??= sha256(v1FoldFiles().map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\0")).slice(0, 16));
}
