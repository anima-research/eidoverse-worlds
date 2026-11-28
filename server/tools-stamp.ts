// tools-stamp — which tools a verdict was measured with, so a tool upgrade re-asks the verdicts it could change.
// The stamp is the third part of the derivation key, beside the recipe's parameters and LOD_GEN. It rides the verdict stamp,
// not the recipe: a tool bump in the recipe would rename every variant and make every client refetch bytes that are still
// correct. Only refusals are re-asked (store-variants.ts verdictStands); a built variant stands under the tools that made it.
// The tools: gltf-transform, meshoptimizer, draco3dgltf, gltf-transform's own sharp (or "absent"), and the KTX encoder binary
// identified by basename + size + mtime, never by running it. No heavy imports (the route reads this on the sequencer thread);
// memoised for a minute, so an encoder installed while the server runs is noticed.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { sha256 } from "../shared/protocol/hash.js";

/** Encoder probe: KTX2_TOKTX env (absolute path) → toktx on PATH → ktx on PATH. Absent is an ENVIRONMENT, not a
 *  failure: the CLI exits 3 so the caller env-skips, never writing a .failed marker. */
export function findKtx2Encoder(): string | null {
  const env = process.env.KTX2_TOKTX;
  if (env && existsSync(env)) return env;
  const which = Bun.which("toktx") ?? Bun.which("ktx");
  if (which) return which;
  // a ~/.local/ktx install (docs/operator/KTX2-ENCODER.md's recipes use KTX2_TOKTX or PATH instead)
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  for (const p of [`${home}/.local/ktx/bin/toktx`, `${home}/.local/ktx/bin/ktx`])
    if (home && existsSync(p)) return p;
  return null;
}

/** Where gltf-transform's own sharp lives: ndarray-pixels' nested copy, else the root's (a deduped install), or null when
 *  none resolves from there. RESOLUTION ONLY: import failure and absence are different facts; only absence makes a bare import safe. */
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
  return sha256(canon).slice(0, 12);
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
