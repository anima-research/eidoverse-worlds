// shared/protocol/provenance.js — writer provenance (docs/DESIGN-log-vocabulary.md §F F-2): the object genesis.body.provenance and a
// repair request's body carry; its builder and readback. Pure: the writer side (tree hash, revision) is server/provenance.ts.

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
