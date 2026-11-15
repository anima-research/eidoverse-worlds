/**
 * §17.2 digest conformance for the eidoverse door, against the frozen
 * 25-vector corpus (vendored byte-for-byte from mcpl main).
 *
 * Run: bun test/mcpl/manifest-test.ts
 */
import { canonicalManifestJson, manifestRevision, ManifestDigestError, MANIFEST_WITH_REVISION } from "../../mcpl/manifest.ts";
import vectors from "../../mcpl/vectors/manifest-digest-vectors.json";
import { suite } from "../gate/suite.ts";

const S = suite("manifest", { quiet: true });
const bad = (name: string, msg: string) => S.check(name, false, msg);

for (const v of (vectors as any).vectors) {
  try {
    const canonical = canonicalManifestJson(v.input);
    if (v.expectError) { bad(v.name, `expected ${v.expectError}, digested`); continue; }
    if (canonical !== v.canonicalJson) { bad(v.name, `canonical mismatch`); continue; }
    const rev = manifestRevision(v.input);
    if (rev !== v.digest) { bad(v.name, `digest mismatch: ${rev}`); continue; }
    S.check(v.name, true);
  } catch (e) {
    if (v.expectError && e instanceof ManifestDigestError && e.code === v.expectError) { S.check(v.name, true); continue; }
    bad(v.name, `unexpected ${e instanceof ManifestDigestError ? e.code : e}`);
  }
}

// Own manifest: conforming, stable, self-consistent.
const own = MANIFEST_WITH_REVISION;
const rev1 = manifestRevision(own);
const rev2 = manifestRevision({ ...own, revision: "sha256:WRONG" });
if (rev1 !== rev2) bad("own-manifest-revision-self-excluding", `${rev1} !== ${rev2}`); else S.check("own-manifest-revision-self-excluding", true);
if (own.revision !== rev1) bad("own-manifest-carries-its-digest", `${own.revision} !== ${rev1}`); else S.check("own-manifest-carries-its-digest", true);

S.done();
