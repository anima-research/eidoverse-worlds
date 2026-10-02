// Resolver precedence, detached diagnostics and failure isolation.
// bun run tools/spawn-lint-unit-test.ts
import { mock } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkCheck } from "./harness.ts";
import { emptyState } from "../shared/fold.js";
const { check, tally } = mkCheck();
const root = mkdtempSync(join(tmpdir(), "ew-spawn-unit-"));
const ladder = ["patched", "overlay", "library"].map(dir => join(root, dir));
for (const dir of ladder) mkdirSync(dir);
mock.module(new URL("../server/config.ts", import.meta.url).pathname, () => ({ LADDER: ladder }));
const { resolveLibFile, lintSpawn } = await import("../server/lint.ts");
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
  const events: any[] = [];
  const w = { state: emptyState(), debug: (kind: string, detail: unknown) => events.push({ kind, ...detail as object }) };
  const entry = { seq: 7, ts: 1, actor: "script-author", verb: "spawn", args: { id: "ghost", lib: "missing.glb" } };
  const before = JSON.stringify(entry);
  lintSpawn(w, entry);
  check("lint is detached from the caller", events.length === 0);
  await Bun.sleep(0);
  check("the warning carries committed provenance", events.length === 1 && events[0].by === "script-author" && events[0].seq === 7);
  check("lint leaves the entry and folded world unchanged", JSON.stringify(entry) === before && Object.keys(w.state.entities).length === 0);
  lintSpawn({ ...w, debug() { throw new Error("recorder unavailable"); } }, entry);
  await Bun.sleep(0);
  check("a failed recorder cannot escape the detached callback", true);
  lintSpawn(w, { ...entry, args: { lib: "missing.glb" } });
  lintSpawn(w, { ...entry, args: { id: "exists", lib: "shared.glb" } });
  await Bun.sleep(0);
  check("a non-spawned id and an existing model produce no warning", events.length === 1);
  for (const lib of [undefined, null, "", false, 0]) lintSpawn(w, { ...entry, args: { id: "existing", lib } });
  await Bun.sleep(0);
  check("fold-inert spawns never diagnose an unchanged entity", events.length === 1);
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
  check("object payloads are summarized rather than retained", events.at(-1).lib === "[object]" && events.at(-1).entity === "[array]");
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exitCode = tally.failed ? 1 : 0;
