// tools/protocol/import-v1/build.ts — the exact build of the engine's v1 fold, for the translator's stamp (research 35, slice-2 #1).
// A translated log is a regenerable cache of the v1 log (R9); it names the translator AND the v1 fold that read the
// old log, so a later engine can tell whether re-translating would give the same bytes. The build is the sha256 of
// the importer's fold.js and every module it imports (followed through relative imports), in a fixed order, first 16
// hex. Every one of them is a frozen copy under ./frozen/ (6dab22f5, README.md), so the stamp moves only when the old fold
// or a frozen copy does.
// (a hash of its source files).
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
      stack.push(path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1])));   // posix on every OS: the list is hashed (v1FoldBuild), so a separator must never change it
  }
  return [...seen].sort();
}
let cached: string | null = null;
export function v1FoldBuild(): string {
  return (cached ??= sha256(v1FoldFiles().map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\0")).slice(0, 16));
}
