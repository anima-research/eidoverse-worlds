// Resolver precedence, detached diagnostics and failure isolation.
// bun run tools/spawn-lint-unit-test.ts
import { mock } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { mkCheck } from "./harness.ts";
import { emptyState } from "../shared/fold.js";
const { check, tally } = mkCheck();
/** A one-triangle GLB whose box is [[0,0,0],[size,size,size]]. */
async function triangleGlb(size: number): Promise<Uint8Array> {
  const doc = new Document();
  const position = doc.createAccessor().setType("VEC3").setBuffer(doc.createBuffer())
    .setArray(new Float32Array([0, 0, 0, size, 0, 0, 0, size, size]));
  const mesh = doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute("POSITION", position));
  doc.createScene().addChild(doc.createNode().setMesh(mesh));
  return new NodeIO().writeBinary(doc);
}
const root = mkdtempSync(join(tmpdir(), "ew-spawn-unit-"));
const ladder = ["patched", "overlay", "library"].map(dir => join(root, dir));
for (const dir of ladder) mkdirSync(dir);
mock.module(new URL("../server/config.ts", import.meta.url).pathname, () => ({ LADDER: ladder }));
const { resolveLibFile, lintSpawn, libraryPath } = await import("../server/lint.ts");
try {
  for (const dir of ladder) writeFileSync(join(dir, "shared.glb"), "fixture");
  check("patched models take the same precedence as /library", resolveLibFile("shared.glb") === join(ladder[0], "shared.glb"));
  rmSync(join(ladder[0], "shared.glb"));
  check("uploads take precedence over the base library", resolveLibFile("shared.glb") === join(ladder[1], "shared.glb"));
  rmSync(join(ladder[1], "shared.glb"));
  check("the base library resolves when no override exists", resolveLibFile("shared.glb") === join(ladder[2], "shared.glb"));
  for (const suffix of ["?v=123", "#mesh", "?v=123#mesh"]) {
    check("version/fragment resolves the served file: " + suffix,
      resolveLibFile("shared.glb" + suffix) === join(ladder[2], "shared.glb"));
  }
  for (const name of ["space model.glb", "café.glb"]) {
    writeFileSync(join(ladder[2], name), "literal filename");
    check("a literal disk name with a space or accent resolves, as the route decodes it: " + name,
      resolveLibFile(name) === join(ladder[2], name));
    const encoded = new URL("/library/" + name, "http://library.invalid").pathname.slice("/library/".length);
    writeFileSync(join(ladder[2], encoded), "served filename");
    check("a disk name that is the encoded form wins over decoding, as in the route: " + name,
      resolveLibFile(name) === join(ladder[2], encoded));
    check("already-encoded input is not encoded twice: " + encoded,
      resolveLibFile(encoded) === join(ladder[2], encoded));
  }
  check("URL-normalized traversal out of /library is refused", resolveLibFile("%2e%2e/shared.glb") === null);
  check("a path that leaves /library is refused", resolveLibFile("../x/secret.glb") === null
    && libraryPath("../x/secret.glb", /\.glb$/i) === null && libraryPath("a/../../x.glb", /\.glb$/i) === null);
  writeFileSync(join(ladder[2], "robot..v2.glb"), "two dots, no traversal");
  check("a name with two dots is a name, served and resolved", resolveLibFile("robot..v2.glb") === join(ladder[2], "robot..v2.glb"));
  mkdirSync(join(ladder[2], "folder.glb"));
  check("a directory named like a model is no model", resolveLibFile("folder.glb") === null);
  // The route stops at the first rung where any entry exists, so a directory
  // there shadows a file of the same name on a lower rung.
  mkdirSync(join(ladder[0], "shadow.glb"));
  writeFileSync(join(ladder[2], "shadow.glb"), "shadowed");
  check("a patched directory shadows the library's file of that name", resolveLibFile("shadow.glb") === null);
  mkdirSync(join(ladder[1], "body.vrm"));
  writeFileSync(join(ladder[2], "body.vrm"), "shadowed");
  check("an overlay directory shadows the library's VRM of that name", resolveLibFile("body.vrm") === null);
  // statSync throws for these where existsSync said no: a path through a file
  // (ENOTDIR, in bun) and a name past the filesystem's 255-byte limit
  // (ENAMETOOLONG; 90 é's are 544 bytes once percent-encoded).
  const unservable = ["shared.glb/x.glb", "a".repeat(300) + ".glb", "é".repeat(90) + ".glb"];
  for (const lib of unservable) check("no file, not a throw: " + lib.slice(0, 24), resolveLibFile(lib) === null);
  // An absolute URL can't leave /library: it is appended to "/library/", so
  // it names a path inside the library, which /library would 404.
  check("an absolute URL names a path inside /library, and nothing there",
    libraryPath("http://evil/x.glb", /\.glb$/i) === "http:/evil/x.glb" && resolveLibFile("http://evil/x.glb") === null);
  // The box stamped into a spawn comes from the file clients load: the patch,
  // where one exists, over the base library's model of the same name.
  writeFileSync(join(ladder[0], "boxed.glb"), await triangleGlb(2));
  writeFileSync(join(ladder[2], "boxed.glb"), await triangleGlb(1));
  const { warmBoxes, boxOf } = await import("../server/boxes.ts");
  await warmBoxes(["boxed.glb"]);
  check("a patched lib's box is the patch's, the model clients render", JSON.stringify(boxOf("boxed.glb")) === "[[0,0,0],[2,2,2]]");
  const events: any[] = [];
  const w = { state: emptyState(), debug: (kind: string, detail: unknown) => events.push({ kind, ...detail as object }) };
  const entry = { seq: 7, ts: 1, actor: "script-author", verb: "spawn", args: { id: "ghost", lib: "missing.glb" } };
  const before = JSON.stringify(entry);
  lintSpawn(w, entry);
  check("lint is detached from the caller", events.length === 0);
  await Bun.sleep(0);
  check("the warning carries committed provenance", events.length === 1 && events[0].by === "script-author" && events[0].seq === 7);
  check("lint leaves the entry and folded world unchanged", JSON.stringify(entry) === before && Object.keys(w.state.entities).length === 0);
  // A recorder that throws is contained and logged: without the catch, the
  // throw would escape the microtask and end this process.
  const logged: unknown[][] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    lintSpawn({ ...w, debug() { throw new Error("recorder unavailable"); } }, entry);
    await Bun.sleep(0);
  } finally {
    console.error = consoleError;
  }
  check("a failed recorder is contained, and says so on the console",
    logged.length === 1 && String(logged[0][0]).includes("[lint] spawn-lint failed for seq 7"));
  lintSpawn(w, { ...entry, args: { lib: "missing.glb" } });
  lintSpawn(w, { ...entry, args: { id: "exists", lib: "shared.glb" } });
  await Bun.sleep(0);
  check("a spawn with no id, and one whose model exists, produce no warning", events.length === 1);
  // An entity already in the world, which a fold-inert spawn (no lib) leaves
  // as it is: the lint neither diagnoses nor touches it.
  w.state.entities.existing = { id: "existing", lib: "shared.glb", pos: [1, 0, 1] } as any;
  const standing = JSON.stringify(w.state.entities.existing);
  for (const lib of [undefined, null, "", false, 0]) lintSpawn(w, { ...entry, args: { id: "existing", lib } });
  await Bun.sleep(0);
  check("fold-inert spawns never diagnose an unchanged entity",
    events.length === 1 && JSON.stringify(w.state.entities.existing) === standing);
  delete w.state.entities.existing;
  lintSpawn(w, { ...entry, args: { id: "version-missing", lib: "absent.glb?v=123#mesh" } });
  await Bun.sleep(0);
  check("a missing versioned path is not-found rather than malformed",
    events.at(-1).reason === "not-found" && events.at(-1).lib === "absent.glb?v=123#mesh");
  lintSpawn(w, { ...entry, args: { id: "x".repeat(20_000), lib: "y".repeat(20_000) } });
  lintSpawn(w, { ...entry, args: { id: ["x".repeat(20_000)], lib: { nested: "y".repeat(20_000) } } });
  await Bun.sleep(0);
  check("oversized raw inputs have bounded diagnostic previews",
    events.slice(-2).every(e => JSON.stringify(e).length < 1600));
  check("preview truncation is explicit and the committed seq remains available",
    events.at(-2).lib.endsWith("[truncated]") && events.at(-2).seq === entry.seq);
  check("object payloads are summarized rather than retained", events.at(-1).lib === "[object]");
  check("the entity is named by the fold's key, String(id), bounded",
    events.at(-1).entity.startsWith("xxx") && events.at(-1).entity.endsWith("[truncated]"));
  lintSpawn(w, { ...entry, args: { id: ["a", "b"], lib: "array-id.glb" } });
  await Bun.sleep(0);
  check("an array id is named as the fold keys it", events.at(-1).entity === "a,b");
  const linted = events.length;
  for (const lib of [...unservable, "http://evil/x.glb"]) lintSpawn(w, { ...entry, args: { id: "u", lib } });
  await Bun.sleep(0);
  check("each is recorded not-found", events.length === linted + 4
    && events.slice(linted).every(e => e.reason === "not-found"));

  // Repeats of one lib and reason are recorded once a minute; the next
  // record's repeats counts the spawns that went unrecorded since the last.
  let clock = 1_000_000;
  const tick = () => clock;
  const recorded = events.length;
  for (let i = 0; i < 3; i++) lintSpawn(w, { ...entry, seq: 100 + i, args: { id: "r" + i, lib: "repeated.glb" } }, tick);
  await Bun.sleep(0);
  check("repeated spawns of one missing lib leave one record", events.length === recorded + 1 && events.at(-1).entity === "r0");
  clock += 61_000;
  lintSpawn(w, { ...entry, seq: 200, args: { id: "r3", lib: "repeated.glb" } }, tick);
  await Bun.sleep(0);
  check("a minute on, the next record counts the spawns that went unrecorded",
    events.length === recorded + 2 && events.at(-1).entity === "r3" && events.at(-1).repeats === 2);
  lintSpawn(w, { ...entry, seq: 201, args: { id: "r4", lib: "another-missing.glb" } }, tick);
  await Bun.sleep(0);
  check("another lib is recorded at once", events.length === recorded + 3 && events.at(-1).repeats === undefined);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exitCode = tally.failed ? 1 : 0;
