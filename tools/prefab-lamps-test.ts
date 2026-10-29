// tools/prefab-lamps-test.ts — client/lib/prefabs.js's lights are the ones translate-v1@31 writes for the same model
// (import-v1/lamps.ts measured from the library's GLB, then lampPartsOf), and every library model that glows has a prefab.
//   EIDOVERSE_DIR=<the asset library> bun tools/prefab-lamps-test.ts   (no library: fails, naming it)
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { lampsOfDoc } from "./protocol/import-v1/lamps.ts";
import { lampPartsOf } from "./protocol/import-v1/translate-v1.js";
import { PREFABS } from "../client/lib/prefabs.js";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";

let pass = 0, fail = 0;
const check = (ok: boolean, what: string, d?: unknown) => { if (ok) { pass++; console.log(`  ok    ${what}`); } else { fail++; console.log(`  FAIL  ${what}${d !== undefined ? ` -- ${JSON.stringify(d).slice(0, 600)}` : ""}`); } };
const lib = process.env.EIDOVERSE_DIR ?? join(import.meta.dir, "..", "..", "eidoverse-video"), dir = join(lib, "eidoverse/assets/models");
if (!existsSync(dir)) { console.log(`  FAIL  the asset library: no ${dir} (set EIDOVERSE_DIR)`); process.exit(1); }
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "draco3d.decoder": await draco3d.createDecoderModule() });
const glowing: Record<string, any[]> = {};
for (const n of readdirSync(dir).filter((f) => f.endsWith(".glb")).sort()) {
  const L = lampsOfDoc(await io.read(join(dir, n)));
  if (L.length) glowing[`eidoverse/assets/models/${n}`] = lampPartsOf("h", L).map(([, c]: any) => ({ pos: c.transform.pos, light: c.light }));
}
check(JSON.stringify(Object.keys(glowing).sort()) === JSON.stringify(Object.keys(PREFABS).sort()), "PL1 every library model that glows has a prefab, and every prefab is one that glows", { glowing: Object.keys(glowing), prefabs: Object.keys(PREFABS) });
for (const [path, want] of Object.entries(glowing)) { const got: any[] = (PREFABS as any)[path] ?? [];
  const same = got.length === want.length && got.every((g, i) => g.pos.every((x: number, k: number) => Math.abs(x - want[i].pos[k]) < 1e-3) && JSON.stringify(g.light) === JSON.stringify(want[i].light));
  check(same, `PL2 ${path.split("/").pop()}: its lights are translate-v1@31's for that model (position within 1 mm, colour, brightness, range, decay, daytime)`, { got, want }); }
console.log(`[prefab-lamps-test] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
