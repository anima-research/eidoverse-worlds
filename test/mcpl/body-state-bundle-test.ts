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
    for (const token of ["tools/assets/rig-load.mjs", "test/stubs/core-stub.mjs", "VRM_DIR", "libraryRigs", "function rigs(", "assets/opt/eidoverse/assets/vrms/"]) {
      if (code.includes(token)) throw new Error(`${entry}: test corpus leaked into production: ${token}`);
    }
    console.log(`PASS ${entry}: no test rig module, corpus scanner or fixture path`);
  }
} finally { rmSync(out, { recursive: true, force: true }); }

// every mcpl module parses as a strict ES module (Bun's runtime forgives a binding imported twice; Bun.Transpiler and
// other engines don't)
{ const { readdirSync, readFileSync } = await import("node:fs");
  const bad: string[] = [];
  for (const f of readdirSync("mcpl").filter((n) => /\.ts$/.test(n) && !/-test\.ts$/.test(n))) {
    try { new Bun.Transpiler({ loader: "ts" }).transformSync(readFileSync(join("mcpl", f), "utf8")); } catch (e) { bad.push(`mcpl/${f}: ${String((e as any)?.message ?? e).split("\n")[0]}`); }
  }
  if (bad.length) throw new Error(`not a strict module: ${bad.join("; ")}`);
  console.log("PASS every mcpl module parses as a strict ES module");
}
