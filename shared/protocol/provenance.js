// shared/protocol/provenance.js — writer provenance (docs/DESIGN-log-vocabulary.md §F F-2): the object genesis.body.provenance and a
// repair request's body carry; the builder the server and the translator call; the tree hash it names. Browser-safe: node is imported lazily.

export const WRITER_NAME = /^[a-z][a-z0-9-]{0,47}$/;
export const SOURCE_REVISION = /^git:(?:sha1:[0-9a-f]{40}|sha256:[0-9a-f]{64})$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const bag = (x) => x && typeof x === "object" && !Array.isArray(x);
const keysOf = (x, want) => Object.keys(x).sort().join(",") === want;

/** Why `p` is not a provenance object ({code, detail}), or null. Every field is required; `sourceTreeSha256` always. */
export function checkProvenance(p) {
  if (!bag(p) || !keysOf(p, "registry,writer")) return { code: "provenance-shape", detail: "provenance is {registry, writer}" };
  const r = p.registry, w = p.writer;
  if (!bag(r) || !keysOf(r, "id,sha256") || r.id !== "registry-pin" || !HEX64.test(String(r.sha256))) return { code: "provenance-registry", detail: "registry is {id: \"registry-pin\", sha256: <64 hex>}" };
  if (!bag(w) || !keysOf(w, "dirty,name,sourceRevision,sourceTreeSha256,version")) return { code: "provenance-writer", detail: "writer is {name, version, sourceRevision, sourceTreeSha256, dirty}" };
  if (typeof w.name !== "string" || !WRITER_NAME.test(w.name)) return { code: "provenance-writer-name", detail: `${JSON.stringify(w.name)} is not a writer name (^[a-z][a-z0-9-]{0,47}$)` };
  if (typeof w.version !== "string" || !SEMVER.test(w.version)) return { code: "provenance-writer-version", detail: `${JSON.stringify(w.version)} is not a semver` };
  if (typeof w.sourceRevision !== "string" || !SOURCE_REVISION.test(w.sourceRevision)) return { code: "provenance-writer-revision", detail: "sourceRevision is git:sha1:<40 hex> or git:sha256:<64 hex>" };
  if (typeof w.sourceTreeSha256 !== "string" || !HEX64.test(w.sourceTreeSha256)) return { code: "provenance-writer-tree", detail: "sourceTreeSha256 is the 64-hex hash of the exact source tree; it is required, and dirty: true without it is invalid" };
  if (typeof w.dirty !== "boolean") return { code: "provenance-writer-dirty", detail: "dirty is true or false" };
  return null;
}

/** The provenance object for a writer; throws on a malformed input (a writer never records a guess). */
export function provenanceOf({ registrySha256, name, version, sourceRevision, sourceTreeSha256, dirty }) {
  const p = { registry: { id: "registry-pin", sha256: registrySha256 }, writer: { name, version, sourceRevision, sourceTreeSha256, dirty } };
  const bad = checkProvenance(p); if (bad) throw new Error(`provenance: ${bad.code}: ${bad.detail}`);
  return p;
}

/** What a reader says of a request body that carried provenance: after a redaction only the commitment remains. */
export function provenanceReadback(body) {
  if (!bag(body)) return { available: false, reason: "provenance unavailable: no body" };
  if (bag(body.provenance)) { const bad = checkProvenance(body.provenance); return bad ? { available: false, reason: `provenance unavailable: ${bad.code}` } : { available: true, provenance: body.provenance }; }
  if (typeof body.commitment === "string" || typeof body.commit === "string") return { available: false, reason: "provenance unavailable: the body was redacted; only its commitment remains" };
  return { available: false, reason: "provenance unavailable: the body carries none" };
}

/** sha256 over the working tree at `root`, as git sees it (tracked and untracked-unignored files, sorted paths, each path and
 *  its content hash): the exact source that ran. Node only. */
export async function sourceTreeSha256(root) {
  const [{ spawnSync }, fs, path, crypto] = await Promise.all([import("node:child_process"), import("node:fs"), import("node:path"), import("node:crypto")]);
  const ls = spawnSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (ls.status !== 0) throw new Error(`git ls-files in ${root}: ${ls.stderr.trim()}`);
  const h = crypto.createHash("sha256");
  for (const rel of ls.stdout.split("\0").filter(Boolean).sort()) {
    const f = path.join(root, rel); if (!fs.statSync(f, { throwIfNoEntry: false })?.isFile()) continue;
    h.update(rel); h.update("\0"); h.update(crypto.createHash("sha256").update(fs.readFileSync(f)).digest()); h.update("\n");
  }
  return h.digest("hex");
}
/** git's HEAD at `root` as a sourceRevision, and whether the tree differs from it. Node only. */
export async function sourceRevisionOf(root) {
  const { spawnSync } = await import("node:child_process");
  const git = (...a) => { const r = spawnSync("git", ["-C", root, ...a], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; };
  const head = git("rev-parse", "HEAD"); if (!head) throw new Error(`no git revision at ${root}`);
  return { sourceRevision: `git:${head.length === 64 ? "sha256" : "sha1"}:${head}`, dirty: (git("status", "--porcelain") ?? "") !== "" };
}
