// tools-stamp — WHICH tools a verdict was measured with, so a tool upgrade re-asks the verdicts it could change.
//
// The derivation key is three parts (the research note, §3: Bazel's action digest + salt, Gradle's "the task type and
// its classpath", Unity's importer version): the canonical PARAMETERS (lodRecipeFor / KTX2_RECIPE), a manual
// GENERATION (LOD_GEN — semantics a parameter cannot express), and the IMPLEMENTATION's version. The first two were
// already in the recipe; this is the third. It rides the verdict STAMP, not the recipe: the recipe is in every
// variant URL and filename, so a tool bump there would rename every variant and make every client refetch every LOD
// for bytes that are still correct. A built variant is a valid answer under the tools that made it; what a better
// tool can overturn is a REFUSAL (a size gate, an ineffective or unpreservable reduce, the GPU gate) — so only those
// are re-asked (store-variants.ts verdictStands). Content verdicts (a skinned body, 900 verts under the floor, no raster
// images) are facts about the file and stand.
//
// What the CLI actually runs: gltf-transform (core/functions/extensions — the reader, weld/simplify wrappers, the
// resample/prune/draco stages), meshoptimizer (the reducer), draco3dgltf (the encoder), sharp — the copy
// gltf-transform ITSELF loads (resolveNestedSharp, #122's one-libvips rule), or "absent": its presence decides whether
// the texel cap is honoured on a `ktx create` host — and the KTX encoder binary. The binary is identified by
// basename + size + mtime of its real file, never by running `--version`: the probe must not execute a stand-in
// encoder (a test's fake counts its calls), and a stat is what freshOver already trusts for identity.
//
// DOM-free; no heavy imports (the route reads this on the sequencer thread). Memoized for a minute, so an encoder
// installed while the server runs is noticed without a restart.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";

/** Encoder probe: KTX2_TOKTX env (absolute path) → toktx on PATH → ktx on
 *  PATH. Absent is an ENVIRONMENT, not a failure — the CLI exits 3 so the
 *  caller env-skips, never writing a .failed marker (the sharp-degrade
 *  pattern: the content is fine, this box just can't encode yet). */
export function findKtx2Encoder(): string | null {
  const env = process.env.KTX2_TOKTX;
  if (env && existsSync(env)) return env;
  const which = Bun.which("toktx") ?? Bun.which("ktx");
  if (which) return which;
  // the docs/ktx2-encoder.md recipe lands here (bin+lib siblings for
  // @rpath) — a PATH-less install must not silently exit-3 the sweep
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  for (const p of [`${home}/.local/ktx/bin/toktx`, `${home}/.local/ktx/bin/ktx`])
    if (home && existsSync(p)) return p;
  return null;
}

/** Where gltf-transform's own sharp lives, or null when there is no nested
 *  copy at all (a deduped install — the state this whole fix is chasing).
 *  RESOLUTION ONLY: it must not import, because import failure and absence
 *  are different facts and only one of them makes a bare import safe. */
export function resolveNestedSharp(): string | null {
  try {
    const fnDir = dirname(Bun.resolveSync("@gltf-transform/functions", import.meta.dir));
    const npDir = dirname(Bun.resolveSync("ndarray-pixels", fnDir));
    return Bun.resolveSync("sharp", npDir);
  } catch {
    return null;
  }
}

/** The version in the nearest package.json named `name` above a resolved module file; "absent" when unresolvable. */
function versionAbove(file: string | null, name: string): string {
  if (!file) return "absent";
  for (let d = dirname(file), i = 0; i < 8; d = dirname(d), i++) {
    const pj = join(d, "package.json");
    try { const j = JSON.parse(readFileSync(pj, "utf8")); if (j?.name === name && typeof j.version === "string") return j.version; } catch { /* keep climbing */ }
    if (dirname(d) === d) break;
  }
  return "absent";
}
const resolved = (spec: string): string | null => { try { return Bun.resolveSync(spec, import.meta.dir); } catch { return null; } };

export type ToolVersions = Record<string, string>;
/** The exact tools a pass would run with here and now. `encoder` is injectable (a harness names its stand-in). */
export function toolVersions(encoder: string | null = findKtx2Encoder()): ToolVersions {
  let enc = "none";
  if (encoder) {
    try { const real = realpathSync(encoder), st = statSync(real); enc = `${basename(encoder)}:${st.size}:${st.mtimeMs}`; }
    catch { enc = `${basename(encoder)}:unreadable`; }
  }
  const nested = resolveNestedSharp();
  return {
    "gltf-transform/core": versionAbove(resolved("@gltf-transform/core"), "@gltf-transform/core"),
    "gltf-transform/functions": versionAbove(resolved("@gltf-transform/functions"), "@gltf-transform/functions"),
    "gltf-transform/extensions": versionAbove(resolved("@gltf-transform/extensions"), "@gltf-transform/extensions"),
    meshoptimizer: versionAbove(resolved("meshoptimizer"), "meshoptimizer"),
    draco3dgltf: versionAbove(resolved("draco3dgltf"), "draco3dgltf"),
    sharp: versionAbove(nested ?? resolved("sharp"), "sharp"),
    encoder: enc,
  };
}
/** A short digest of the canonical (key-sorted) tool set — what the stamp carries. */
export function toolsDigest(v: ToolVersions = toolVersions()): string {
  const canon = JSON.stringify(Object.keys(v).sort().map((k) => [k, v[k]]));
  return createHash("sha256").update(canon).digest("hex").slice(0, 12);
}
let memo: { at: number; d: string } | null = null;
/** This process's tools digest, re-read at most once a minute. */
export function currentToolsDigest(): string {
  if (!memo || Date.now() - memo.at > 60_000) memo = { at: Date.now(), d: toolsDigest() };
  return memo.d;
}
export const toolsStamp = (digest = currentToolsDigest()) => `tools=${digest}`;
/** Does `content` carry exactly this tools stamp? Delimited, like hasStamp. */
export const hasToolsStamp = (content: string, digest = currentToolsDigest()) =>
  new RegExp(`(^|\\s)tools=${digest}(\\s|$)`).test(content);
