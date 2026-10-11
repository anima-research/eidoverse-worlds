// @ts-nocheck
// shared/layers.js: a thing's selection layer, by default and by a builder's word.   bun tools/layers-test.ts
import { layerOf, defaultLayer } from "../shared/layers.js";
import { inspectSchema, editOps } from "../shared/editschema.js";
let pass = 0, fail = 0; const check = (n, ok, d = "") => { if (ok) pass++; else { fail++; console.log("  ✗", n, d); } };
const W = {
  floor: { lib: "m/floor.glb", comp: { physics: { kind: "static", shape: [[-1, 0, -1], [1, 0.1, 1]] }, transform: { pos: [0, 0, 0], scale: [30, 1, 30] } } },
  crate: { lib: "m/crate.glb", comp: { physics: { kind: "dynamic", shape: [[-1, 0, -1], [1, 2, 1]] }, transform: { pos: [0, 0, 0], scale: [0.25, 0.25, 0.25] } } },
  lamp: { lib: null, comp: { light: { kind: "point" } } },
  sign: { lib: null, comp: { text: { text: "hi" } } },
  npc: { lib: "avatars/bee.vrm", comp: {} },
  hat: { lib: "m/hat.glb", comp: {}, parent: { to: "npc" } },
  wall: { lib: null, comp: { structure: { tile: 1 } } },
  told: { lib: "m/crate.glb", comp: { "hesperus/layer": "environment" } },
};
const got = Object.fromEntries(Object.keys(W).map((k) => [k, layerOf(W, k)]));
check("defaults by kind: a 60 m floor is environment, a crate props, a lone light lights, text signs, an avatar people, a structure structure",
  got.floor === "environment" && got.crate === "props" && got.lamp === "lights" && got.sign === "signs" && got.npc === "people" && got.wall === "structure", JSON.stringify(got));
check("what rides an avatar is on people with it", got.hat === "people", got.hat);
check("a builder's hesperus/layer wins", got.told === "environment", got.told);
const s = inspectSchema({ ...W.crate, id: "crate" }, "crate", {}); const f = s.groups.flatMap((g) => g.fields).find((x) => x.k === "layer");
check("the layer row offers auto (its default) and every layer", f?.value === "auto" && f.options[0].label === "auto (props)" && f.options.length === 8, JSON.stringify(f?.options));
const e = editOps({ ...W.crate, id: "crate" }, "crate", { "flags.layer": "environment" }, {});
check("choosing a layer writes hesperus/layer; auto removes it", e.ops.length === 1 && e.ops[0].args?.component === "hesperus/layer" && e.ops[0].args?.value === "environment"
  && editOps({ ...W.told, id: "told" }, "told", { "flags.layer": "auto" }, {}).ops[0]?.verb === "delete", JSON.stringify(e));
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
