// bun server/buildcheck-run.ts <model.glb> [scale] — print a build check (server/buildcheck.ts) as JSON.
//
// Its own process on purpose: the check loads the client's collider module
// headless (behind the same core.js stub the headless tests use) and can take
// seconds — the sequencer spawns this rather than doing either itself
// (server/buildcheck-queue.ts).
import { plugin } from "bun";
import { fileURLToPath } from "node:url";
const STUB = fileURLToPath(new URL("../tools/core-stub.mjs", import.meta.url));
plugin({ name: "core-stub", setup(b) { b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: STUB })); } });
const { THREE } = await import(STUB);
const C = await import("../client/lib/colliders.js");
const { checkModel } = await import("./buildcheck.ts");
const file = process.argv[2], scale = Number(process.argv[3] ?? 1);
if (!file) { console.error("usage: bun server/buildcheck-run.ts <model.glb> [scale]"); process.exit(2); }
try {
  console.log(JSON.stringify(await checkModel(file, C, THREE, { scale: Number.isFinite(scale) && scale > 0 ? scale : 1 })));
} catch (err) {
  console.log(JSON.stringify({ error: String((err as Error)?.message ?? err) }));
  process.exit(1);
}
