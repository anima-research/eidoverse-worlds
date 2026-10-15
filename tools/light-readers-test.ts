// light-readers-test — the readers of a placed light find it by what it IS (kindOf, the light rig's own key), never by a
// userData flag nothing writes (DEBT-SURVEY-2 §2.5, refactor D2).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/light-readers-test.ts
//
// lights.js, matoverride.js, inspect.js and realize/models.js boxOf are real. inspect.js runs in the inspect harness
// (tools/protocol/inspectharness.ts); the realizer in the lod-client stub cone (tools/lod-client-stub.mjs); the light rig
// is a Set of the keys that hold a slot.
// @ts-nocheck
import { plugin } from "bun";
import { fileURLToPath } from "node:url";
import { inspectHarness } from "./protocol/inspectharness.ts";

const H = inspectHarness("light-readers");
const LOD = fileURLToPath(new URL("./lod-client-stub.mjs", import.meta.url));
const castingKeys = (globalThis.__castingKeys = new Set());
plugin({
  name: "light-readers",
  setup(b) {
    for (const f of ["^\\.\\./core\\.js$", "^\\.\\./assets\\.js$", "^\\.\\./colliders\\.js$", "^\\.\\./lightrig\\.js$", "^\\.\\./lights\\.js$", "^\\.\\./world\\.js$", "^\\.\\./materials\\.js$"]) {
      b.onResolve({ filter: new RegExp(f) }, (a) => (a.importer.includes("/client/lib/realize/") ? { path: LOD } : undefined));
    }
    b.onResolve({ filter: /^\.\/(lightrig|materials)\.js$/ }, (a) =>
      (/\/client\/lib\/(lights|matoverride)\.js$/.test(a.importer) ? { path: a.path, namespace: "light-readers" } : undefined));
    b.onLoad({ filter: /.*/, namespace: "light-readers" }, (a) => ({
      loader: "js",
      contents: a.path.includes("lightrig")
        ? "export const isCasting = (k) => globalThis.__castingKeys.has(k); export const shedALight = () => false; export const litCount = () => 0;"
        : "export const prepareMaterial = () => {};",
    }));
  },
});

const { makeLightGizmo, lightCasting } = await import("../client/lib/lights.js");
const { materialsOf } = await import("../client/lib/matoverride.js");
const { liveFor, setEditHooks } = await import("../client/lib/inspect.js");
const lod: any = await import("./lod-client-stub.mjs");
const { boxOf } = await import("../client/lib/realize/models.js");
const { Group } = await import("../client/node_modules/three/build/three.module.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const litEmpty = (id: string) => { const g = new Group(); g.userData.entityId = id; g.userData.empty = true; g.add(makeLightGizmo(0xffd9a0)); return g; };

console.log("\nlight readers — a lit Empty is found by what it is\n");

{
  const obj = litEmpty("lamp");
  check("materialsOf(a lit Empty) is [] — the gizmo is no material slot", materialsOf(obj).length === 0, JSON.stringify(materialsOf(obj).map((m) => m.slot)));
}

{
  const obj = litEmpty("lamp"); obj.position.set(4, 2, -3); obj.updateMatrixWorld(true);
  lod.entities.set("lamp", obj);
  check("boxOf(a lit Empty) ignores its gizmo — an Empty has no model box", boxOf("lamp") === null, JSON.stringify(boxOf("lamp")));
  lod.entities.delete("lamp");
}

{
  H.W.seed({ bulb: { pos: [0, 2, 0], light: { color: 0xff8800, intensity: 16, range: 6 } }, box: { pos: [1, 0, 0] } });
  H.sync();
  H.entities.set("bulb", litEmpty("bulb")); H.entities.set("box", Object.assign(new Group(), { userData: { entityId: "box", empty: true } }));
  setEditHooks({ casting: lightCasting });
  castingKeys.clear();
  const off = liveFor("bulb");
  check("liveFor(a lit Empty).casting is false while its request holds no slot", off.casting === false, String(off.casting));
  castingKeys.add("complight:bulb");
  const on = liveFor("bulb");
  check("…and true once complight:bulb holds one", on.casting === true, String(on.casting));
  check("…and a light lists no parts or materials", on.parts === undefined && on.materials === undefined, JSON.stringify([on.parts, on.materials]));
  check("an unlit thing has no casting", liveFor("box").casting === undefined, String(liveFor("box").casting));
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : "\nall passed");
process.exit(failures ? 1 : 0);
