// bun tools/vrm-ktx2-mark-test.ts — the avatar arm (optimize.ts transcodeVrmKtx2, a JSON-surgery rewrite, not the
// gltf-transform path) also stamps KTX2_TF_MARK on every image it converts: the purge tells fixed images from old by it.
// Real encoder, a minimal textured GLB (the surgery needs images, not VRM metadata). No encoder → FAIL, never a pass.
import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { transcodeVrmKtx2, findKtx2Encoder, KTX2_TF_MARK } from "../server/optimize.ts";
import { parseGlb } from "../server/glbparse.ts";
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, got?: unknown) => { if (ok) pass++; else fail++; console.log(`  ${ok ? "✓" : "✗"} ${n}${ok ? "" : `  got ${JSON.stringify(got)}`}`); };
const enc = findKtx2Encoder();
check("a KTX2 encoder on this host", !!enc, null);
if (enc) {
  const png = new Uint8Array(await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 200, g: 90, b: 40, alpha: 1 } } }).png().toBuffer());
  const doc = new Document(); const buf = doc.createBuffer();
  const mat = doc.createMaterial("m").setBaseColorTexture(doc.createTexture("base").setImage(png).setMimeType("image/png"));
  const prim = doc.createPrimitive().setMaterial(mat)
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setBuffer(buf).setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])))
    .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setBuffer(buf).setArray(new Float32Array([0, 0, 1, 0, 0, 1])));
  doc.createScene("s").addChild(doc.createNode("n").setMesh(doc.createMesh("g").addPrimitive(prim)));
  const r = await transcodeVrmKtx2(await new NodeIO().writeBinary(doc), enc);
  const ims = (parseGlb(r.out).json.images ?? []);
  check(`the avatar arm converted the image (${r.converted})`, r.converted === 1 && ims[0]?.mimeType === "image/ktx2", ims);
  check("…and stamped the transfer mark on it", ims.length > 0 && ims.every((i: any) => i.mimeType !== "image/ktx2" || i.extras?.[KTX2_TF_MARK] === "assigned"), ims.map((i: any) => i.extras));
}
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
