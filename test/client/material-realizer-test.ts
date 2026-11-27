// material-realizer-test — the browser host for the `material` component (client/lib/realize/material.js), run without a
// browser: its client imports are stubbed (test/stubs/material-realizer-stub.mjs), the realizer and shared/material.js
// are real. A stored bag arrives on the bus as world.js delivers it, and the rows read what the realizer wore.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/material-realizer-test.ts
//
// MR1 is #377 review finding 7: a stored bag whose description is over the cap (written before the cap) is clipped and
// still worn, never refused and taken off. The row runs applyFrom's own call, not a regex over its source.
import { plugin } from "bun";
import { stubResolve } from "../harness/stub.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { suite } from "../gate/suite.ts";

const here = (p: string) => join(dirname(fileURLToPath(import.meta.url)), p);
const { check, done } = suite("material-realizer");

plugin({ name: "material-realizer-stubs", setup(b) {
  for (const m of ["\\.\\./base", "\\.\\./world", "\\.\\./render/materials", "\\.\\./mediaprefs", "\\./pictures"])
    stubResolve(b, new RegExp(`^${m}\\.js$`), (a) => /realize[\\/]material\.js$/.test(a.importer) ? { path: here("../stubs/material-realizer-stub.mjs") } : undefined);
} });

const stub: any = await import("../stubs/material-realizer-stub.mjs");
const { _worn: worn }: any = await import("../../client/lib/realize/material.js");
const { PICTURE_DESCRIPTION_MAX: MAX } = await import("../../shared/picture.js");   // material.js clips to the picture cap

/** a model with one named mesh node, as findPart and meshesOf walk it */
function model(id: string) {
  const original = { isMaterial: true, clone() { return { ...this, clone: undefined, dispose() {}, color: null, emissive: null }; }, dispose() {} };
  const screen: any = { name: "screen", isMesh: true, material: original, userData: {}, parent: null, traverse(f: any) { f(this); } };
  const root: any = { name: id, userData: {}, traverse(f: any) { f(this); f(screen); } };
  screen.parent = root; stub.entities.set(id, root);
  return { root, screen, original };
}
async function wearBag(id: string, data: any) {
  stub.bus.emit("comp", { id, type: "material", data });
  if (stub.lastLoad) await stub.lastLoad;
  return worn.get(id);
}
const bag = (description: string) => ({ node: "screen", texture: "store/images/0123456789abcdef.png", description });

{ const { screen, original } = model("telly");
  const h = await wearBag("telly", bag("the evening news"));
  check("MR0 a stored bag is worn on its node, its description kept (the setup the next row stands on)",
    !!h && h.material.description === "the evening news" && screen.material !== original && screen.material.map?.isTexture, h?.material); }

{ const { screen, original } = model("poster");
  const h = await wearBag("poster", bag("é".repeat(MAX + 50)));
  check(`MR1 a stored bag with a ${MAX + 50}-character description is still worn, its description clipped to ${MAX}`,
    !!h && h.material.description === "é".repeat(MAX) && screen.material !== original, h ? h.material.description.length : "not worn"); }

done();
