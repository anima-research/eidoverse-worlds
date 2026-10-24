// @ts-nocheck
// shared/layers.js: a thing's selection layer, by default and by a builder's word.   bun tools/layers-test.ts
import { layerOf, defaultLayer } from "../shared/layers.js";
import { inspectSchema, editOps } from "../shared/editschema.js";
let pass = 0, fail = 0; const check = (n, ok, d = "") => { if (ok) pass++; else { fail++; console.log("  ✗", n, d); } };
const W = {
  floor: { model: "m/floor.glb", physics: { kind: "static", shape: [[-1, 0, -1], [1, 0.1, 1]] }, transform: { pos: [0, 0, 0], scale: [30, 1, 30] } },
  crate: { model: "m/crate.glb", physics: { kind: "dynamic", shape: [[-1, 0, -1], [1, 2, 1]] }, transform: { pos: [0, 0, 0], scale: [0.25, 0.25, 0.25] } },
  lamp: { model: null, light: { kind: "point" } },
  sign: { model: null, text: { text: "hi" } },
  npc: { model: "avatars/bee.vrm" },
  hat: { model: "m/hat.glb", parent: { to: "npc" } },
  wall: { model: null, structure: { tile: 1 } },
  told: { model: "m/crate.glb", "hesperus/layer": "environment" },
  // review S3 (primitives): a mesh thing is sized like a model, not filed with the Empties
  ground: { model: null, mesh: { shape: "plane", size: [200, 0.05, 200] }, physics: { kind: "static", shape: [[-100, 0, -100], [100, 0.05, 100]] }, transform: { pos: [0, 0, 0] } },
  cube: { model: null, mesh: { shape: "box", size: [1, 1, 1] }, physics: { kind: "static", shape: [[-0.5, 0, -0.5], [0.5, 1, 0.5]] }, transform: { pos: [0, 0, 0] } },
};
const got = Object.fromEntries(Object.keys(W).map((k) => [k, layerOf(W, k)]));
check("defaults by kind: a 60 m floor is environment, a crate props, a lone light lights, text signs, an avatar people, a structure structure",
  got.floor === "environment" && got.crate === "props" && got.lamp === "lights" && got.sign === "signs" && got.npc === "people" && got.wall === "structure", JSON.stringify(got));
check("what rides an avatar is on people with it", got.hat === "people", got.hat);
check("a builder's hesperus/layer wins", got.told === "environment", got.told);
check("a 200 m mesh plane is environment and a 1 m mesh box is props (a mesh thing takes the size test, not the Empties' 'other')", got.ground === "environment" && got.cube === "props", JSON.stringify([got.ground, got.cube]));
const s = inspectSchema({ ...W.crate, id: "crate" }, "crate", {}); const f = s.groups.flatMap((g) => g.fields).find((x) => x.k === "layer");
check("the layer row offers auto (its default) and every layer", f?.value === "auto" && f.options[0].label === "auto (props)" && f.options.length === 8, JSON.stringify(f?.options));
const e = editOps({ ...W.crate, id: "crate" }, "crate", { "flags.layer": "environment" }, {});
check("choosing a layer writes hesperus/layer; auto removes it", e.ops.length === 1 && e.ops[0].args?.component === "hesperus/layer" && e.ops[0].args?.value === "environment"
  && editOps({ ...W.told, id: "told" }, "told", { "flags.layer": "auto" }, {}).ops[0]?.verb === "delete", JSON.stringify(e));
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
