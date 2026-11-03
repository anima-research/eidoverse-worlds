// Build the actual MCP entry points and inspect their runtime closure.
// Filesystem calls elsewhere in the server are legitimate; corpus scanners,
// synthetic test helpers and test-only rig paths must not enter the bundles.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const out = mkdtempSync(join(tmpdir(), "body-state-bundles-"));
try {
  for (const entry of ["mcpl/server.ts", "mcpl/net-server.ts"]) {
    const result = await Bun.build({ entrypoints: [entry], target: "bun", outdir: out });
    if (!result.success) throw new Error(result.logs.map(String).join("\n"));
    const code = (await Promise.all(result.outputs.map(o => o.text()))).join("\n");
    if (!code.includes("body_state") || !code.includes("posture_not_evaluated")) throw new Error(`${entry}: perception code missing from bundle`);
    for (const token of ["tools/rig-load.mjs", "tools/core-stub.mjs", "VRM_DIR", "libraryRigs", "function rigs(", "assets/opt/eidoverse/assets/vrms/"]) {
      if (code.includes(token)) throw new Error(`${entry}: test corpus leaked into production: ${token}`);
    }
    console.log(`PASS ${entry}: no test rig module, corpus scanner or fixture path`);
  }
} finally { rmSync(out, { recursive: true, force: true }); }
