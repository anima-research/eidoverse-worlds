// bun tools/served-path-test.ts — the catalog's "perf if loaded" names the file /library actually serves, and a
// deliberate upstream patch (PATCH_DIR) wins over everything there, so it must win here too (routes.ts servedGlbPath).
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, got: unknown) => { if (ok) pass++; else fail++; console.log(`  ${ok ? "✓" : "✗"} ${n}${ok ? "" : `  got ${JSON.stringify(got)}`}`); };
const root = mkdtempSync(join(tmpdir(), "served-")), lib = join(root, "lib"), models = join(lib, "eidoverse/assets/models");
mkdirSync(models, { recursive: true });
const name = `zz-served-${crypto.randomUUID().slice(0, 8)}.glb`, ball = join(import.meta.dir, "..", "assets/opt/props/ball.glb");
copyFileSync(ball, join(models, name));
Object.assign(process.env, { SKIP_OPT_SWEEP: "1", EIDOVERSE_DIR: lib, OPT_DIR: join(root, "opt"), WORLDS_DIR: join(root, "worlds") });
const { route } = await import("../server/routes.ts");
const { PATCH_DIR } = await import("../server/config.ts");
const patched = join(PATCH_DIR, "eidoverse/assets/models", name);
const pdir = join(PATCH_DIR, "eidoverse/assets/models"), pdirWas = existsSync(pdir);   // leave patched/ exactly as found
const ask = async () => ((await (await route(new Request(`http://x/library-models?q=${name.slice(0, 16)}`), {} as any)).json()) as any[]).find((h) => h.path.endsWith(name));
try {
  const plain = await ask();
  check("an unpatched library model is ranked as its original", plain?.perf?.servedAs === "original", plain?.perf);
  mkdirSync(join(PATCH_DIR, "eidoverse/assets/models"), { recursive: true }); copyFileSync(ball, patched);
  const p = await ask();
  check("with a PATCH_DIR copy, the rank is of the patched copy (what /library serves)", p?.perf?.servedAs === "patched copy", p?.perf);
  // #7: a model only in the OPT overlay has no library source — ↻ would 400, so the catalog says it can't rebuild
  const ovName = `zz-overlay-${crypto.randomUUID().slice(0, 8)}.glb`, ovDir = join(root, "opt", "eidoverse/assets/models");
  mkdirSync(ovDir, { recursive: true }); copyFileSync(ball, join(ovDir, ovName));
  const hits = (await (await route(new Request(`http://x/library-models?q=zz`), {} as any)).json()) as any[];
  const ov = hits.find((h) => h.path.endsWith(ovName)), lib = hits.find((h) => h.path.endsWith(name));
  check("an overlay-only library model is rebuildable:false; one with a library source is rebuildable:true", ov?.rebuildable === false && lib?.rebuildable === true, [ov?.rebuildable, lib?.rebuildable]);
} finally { rmSync(patched, { force: true }); if (!pdirWas) try { rmdirSync(pdir); } catch { /* not empty: not ours */ } rmSync(root, { recursive: true, force: true }); }
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
