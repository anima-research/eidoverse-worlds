// server/provenance.ts — the writer's side of §F F-2 (docs/DESIGN-log-vocabulary.md): the exact source tree a writer runs, as
// shared/protocol/provenance.js's object records it. Node only; the server, the migration tool and their checks call it.
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { provenanceOf } from "../shared/protocol/provenance.js";
import { VERSION, MINOR } from "../shared/protocol/fold.js";

/** sha256 over the working tree at `root`, as git sees it (tracked and untracked-unignored files, sorted paths, each path and
 *  its content hash): the exact source that ran. */
export function sourceTreeSha256(root) {
  const ls = spawnSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (ls.status !== 0) throw new Error(`git ls-files in ${root}: ${ls.stderr.trim()}`);
  const h = crypto.createHash("sha256");
  for (const rel of ls.stdout.split("\0").filter(Boolean).sort()) {
    const f = path.join(root, rel); if (!fs.statSync(f, { throwIfNoEntry: false })?.isFile()) continue;
    h.update(rel); h.update("\0"); h.update(crypto.createHash("sha256").update(fs.readFileSync(f)).digest()); h.update("\n");
  }
  return h.digest("hex");
}
/** git's HEAD at `root` as a sourceRevision, and whether the tree differs from it. */
export function sourceRevisionOf(root) {
  const git = (...a) => { const r = spawnSync("git", ["-C", root, ...a], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; };
  const head = git("rev-parse", "HEAD"); if (!head) throw new Error(`no git revision at ${root}`);
  return { sourceRevision: `git:${head.length === 64 ? "sha256" : "sha1"}:${head}`, dirty: (git("status", "--porcelain") ?? "") !== "" };
}
/** The provenance of writer `name`@`version` running from the source tree at `root` (its registry pin, revision and tree). */
export function provenanceAt(root, name, version) {
  const registrySha256 = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "spec/registry-pin.json"))).digest("hex");
  return provenanceOf({ registrySha256, name, version, ...sourceRevisionOf(root), sourceTreeSha256: sourceTreeSha256(root) });
}
/** This server's provenance, read once from the tree it runs: every genesis it founds records it. Null (said once) when the tree
 *  is no git checkout: genesis then carries none, never a guess. */
let SERVER;
export function serverProvenance() {
  if (SERVER === undefined) try { SERVER = provenanceAt(path.resolve(import.meta.dir, ".."), "eidoverse-server", `${VERSION}.${MINOR}.0`); }
  catch (e) { SERVER = null; console.warn(`[provenance] ${e?.message ?? e}: worlds founded by this process carry no genesis provenance`); }
  return SERVER;
}
