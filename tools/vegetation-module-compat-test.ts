// A host can shadow vegetation.js while sourcing its generator modules from a
// separately updated companion checkout. An optional species must not make the
// entire vegetation module unloadable when that companion is one version old.

import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${ok ? "" : "  " + detail}`);
  ok ? pass++ : fail++;
};

const scratch = mkdtempSync(join(tmpdir(), "ew-vegetation-compat-"));
const source = new URL("../upstream-patched/eidoverse/vegetation.js", import.meta.url);
const modulePath = join(scratch, "vegetation.js");

try {
  copyFileSync(source, modulePath);
  writeFileSync(join(scratch, "vegetation_shrub_gen.js"),
    "export const buildShrubGeometry = () => ({})\n");
  writeFileSync(join(scratch, "vegetation_corn_gen.js"),
    "export const buildCornGeometry = () => ({})\n");

  const Stub = class {};
  (globalThis as any).THREE = {
    Matrix4: Stub,
    Quaternion: Stub,
    Vector3: Stub,
    Euler: Stub,
  };

  console.log("\nvegetation module compatibility");
  const mod = await import(`${pathToFileURL(modulePath).href}?run=${Date.now()}`);
  check("ordinary flora loads without the optional sunflower generator",
    typeof mod.createFlora === "function" && !!mod.FLORA_SPECIES.grass);
} catch (error) {
  check("ordinary flora loads without the optional sunflower generator", false,
    error instanceof Error ? error.message : String(error));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
