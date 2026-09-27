// A named BLANK part keeps its UVs through the store's optimize pass.
//
//   bun tools/blank-part-uvs-test.ts
//
// The picture contract (shared/picture.js) is: a comp names a GLB node, the
// client textures that node's material later. So the part ships with an
// untextured material and real TEXCOORD_0 — and gltf-transform's prune(), by
// default, drops the texture coordinates of any primitive whose material
// reads none. The frame prop's `picture` quad came back from the store-min
// pass with POSITION+NORMAL only; a hung picture sampled one texel. The pass
// now prunes with keepAttributes, and this pins it: the blank part's UVs
// survive, the textured neighbour is untouched, and the pass still prunes
// what it should (an unreferenced material is gone).
import { Document, NodeIO } from "@gltf-transform/core";
import { PNG } from "pngjs";
import { optimizeGlb } from "../server/optimize.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`); };

function pngBytes(size = 64): Uint8Array {
  const png = new PNG({ width: size, height: size });
  for (let i = 0; i < size * size * 4; i += 4) { png.data[i] = i & 0xff; png.data[i + 1] = 90; png.data[i + 2] = 200; png.data[i + 3] = 255; }
  return new Uint8Array(PNG.sync.write(png));
}
const doc = new Document();
const buf = doc.createBuffer();
const quadPos = () => doc.createAccessor().setType("VEC3").setBuffer(buf).setArray(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]));
const quadUv = () => doc.createAccessor().setType("VEC2").setBuffer(buf).setArray(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]));
const quadIdx = () => doc.createAccessor().setType("SCALAR").setBuffer(buf).setArray(new Uint16Array([0, 1, 2, 0, 2, 3]));
const framed = doc.createMaterial("frameMat").setBaseColorTexture(doc.createTexture("base").setImage(pngBytes()).setMimeType("image/png"));
const blank = doc.createMaterial("picture").setBaseColorFactor([0.9, 0.9, 0.9, 1]);
doc.createMaterial("orphan");   // referenced by nothing — prune's actual job
const frame = doc.createMesh("frame").addPrimitive(doc.createPrimitive().setMaterial(framed).setAttribute("POSITION", quadPos()).setAttribute("TEXCOORD_0", quadUv()).setIndices(quadIdx()));
const picture = doc.createMesh("picture").addPrimitive(doc.createPrimitive().setMaterial(blank).setAttribute("POSITION", quadPos()).setAttribute("TEXCOORD_0", quadUv()).setIndices(quadIdx()));
doc.createScene("s").addChild(doc.createNode("frame").setMesh(frame)).addChild(doc.createNode("picture").setMesh(picture));
const bytes = await new NodeIO().writeBinary(doc);

const out = await optimizeGlb(bytes);
// the pass draco-compresses the shadow, so reading it back needs the decoder
const draco3d = (await import("draco3dgltf")).default;
const io = new NodeIO().registerExtensions((await import("@gltf-transform/extensions")).ALL_EXTENSIONS)
  .registerDependencies({ "draco3d.decoder": await draco3d.createDecoderModule() });
const back = await io.readBinary(out);
const prims = Object.fromEntries(back.getRoot().listMeshes().map((m) => [m.getName(), m.listPrimitives()[0]]));
const attrs = (n: string) => prims[n]?.listSemantics().sort().join(",") ?? "(no mesh)";
check("the blank `picture` part keeps TEXCOORD_0 through the store pass", /TEXCOORD_0/.test(attrs("picture")), attrs("picture"));
check("…and POSITION", /POSITION/.test(attrs("picture")), attrs("picture"));
check("the textured `frame` part keeps its UVs as before", /TEXCOORD_0/.test(attrs("frame")), attrs("frame"));
check("the blank material survives (the comp will clone it)", back.getRoot().listMaterials().some((m) => m.getName() === "picture"));
check("prune still prunes: the unreferenced material is gone", !back.getRoot().listMaterials().some((m) => m.getName() === "orphan"), back.getRoot().listMaterials().map((m) => m.getName()).join(","));
check("both named nodes survive", ["frame", "picture"].every((n) => back.getRoot().listNodes().some((x) => x.getName() === n)));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
