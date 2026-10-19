// /library/ percent-decoding (routes.ts): spaces resolve, a literal "%xx" file
// name is served as itself, a bare "%" or a malformed escape keeps its own
// characters while the rest of the name decodes, and a decoded ".." can't
// reach a sibling directory that shares the library's name prefix. The
// raw-first guard covers the whole ladder: patched, opt and library.
//   bun tools/library-decode-test.ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkCheck, scratchSequencer } from "./harness.ts";

const { check, tally } = mkCheck();
const root = mkdtempSync(join(tmpdir(), "libdecode-"));
const lib = join(root, "library"), models = join(lib, "eidoverse/assets/models");
mkdirSync(models, { recursive: true }); mkdirSync(join(root, "library-backup")); mkdirSync(join(root, "opt"));
mkdirSync(join(root, "patched"));
writeFileSync(join(models, "a b.glb"), "space");
writeFileSync(join(models, "box%41.glb"), "literal");
writeFileSync(join(models, "boxA.glb"), "A");
writeFileSync(join(models, "50% off.glb"), "bare percent");
writeFileSync(join(models, "bad%E0%A4-café.glb"), "malformed run kept");
writeFileSync(join(root, "library-backup", "secret.json"), "SECRET");
// A literal "%42" name only the patched rung holds must win over decoding to
// the library's boxB.glb: the route consults patched first.
writeFileSync(join(root, "patched", "box%42.glb"), "patched-literal");
writeFileSync(join(lib, "boxB.glb"), "B");
// A literal "%43" name only the opt rung holds is served as itself; decoded,
// it would name boxC.glb, which no rung has.
writeFileSync(join(root, "opt", "box%43.glb"), "opt-literal");

const run = await scratchSequencer("library-decode", {
  portFrom: 9780,
  serverEnv: { EIDOVERSE_DIR: lib, OPT_DIR: join(root, "opt"), PATCH_DIR: join(root, "patched"), SKIP_OPT_SWEEP: "1" },
});
try {
  async function expect(path: string, status: number, body?: string) {
    const r = await fetch(`${run.BASE}/library/${path}`);
    const t = await r.text();
    check(path, r.status === status && (body === undefined || t === body),
      `${r.status}${body !== undefined ? ` "${t.slice(0, 20)}"` : ""}, expected ${status}${body !== undefined ? ` "${body}"` : ""}`);
  }
  await expect("eidoverse/assets/models/a%20b.glb", 200, "space");
  // main's native=1 branch comes after the decode, so it resolves the same name
  await expect("eidoverse/assets/models/a%20b.glb?native=1", 200, "space");
  await expect("eidoverse/assets/models/box%41.glb", 200, "literal");
  await expect("eidoverse/assets/models/boxA.glb", 200, "A");
  await expect("box%42.glb", 200, "patched-literal");
  await expect("box%43.glb", 200, "opt-literal");
  // a URL leaves a bare "%" as it is: the "%" stays, and the space after it decodes
  await expect("eidoverse/assets/models/50%%20off.glb", 200, "bare percent");
  // a malformed run keeps its own characters, and the "é" after it decodes
  await expect("eidoverse/assets/models/bad%E0%A4-caf%C3%A9.glb", 200, "malformed run kept");
  await expect("eidoverse/assets/models/bad%E0%A4.glb", 404);
  await expect("..%2flibrary-backup%2fsecret.json", 403);
  await expect("eidoverse%2f..%2f..%2flibrary-backup%2fsecret.json", 403);
  // On Linux, without the split on backslashes, this would be a 404 for a file
  // whose name holds them; the 403 shows the guard that matters on Windows.
  await expect("x%5c..%5c..%5clibrary-backup%5csecret.json", 403);
} finally {
  await run.cleanup(tally.failed ? 1 : 0);
  rmSync(root, { recursive: true, force: true });
}
console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
process.exitCode = tally.failed ? 1 : 0;
