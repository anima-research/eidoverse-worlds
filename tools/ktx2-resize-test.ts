// bun tools/ktx2-resize-test.ts — the KTX2 shadow really keeps the 1024² texel budget on a `ktx create` host.
//
// Found 2026-09-24 (Commons weight audit): the recipe is named texel1024, toktx honours it with --resize, but
// `ktx create` has no --resize — that arm logged "encoding at source size" and shipped the full 2048². optimize.ts now
// resizes through sharp first on that encoder. This runs the REAL encoder this host has (skips, loudly, if none):
//   capped   — a 2048² base-colour PNG comes out of optimizeGlbKtx2 as a 1024² KTX2        [mutate: revert → 2048]
//   aspect   — a 2048x1024 texture keeps its aspect (1024x512)
//   small    — a 512² texture is untouched (512²)
//   no sharp — on a ktx-create host without sharp, an over-cap texture is skipped, not shipped full-size    [mutate: revert → 2048]
import { Document, NodeIO } from "@gltf-transform/core";
import { optimizeGlbKtx2, findKtx2Encoder, getSharp } from "../server/optimize.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`); };

const encoder = findKtx2Encoder();
if (!encoder) { console.log("  SKIP: no KTX2 encoder on this host (toktx / ktx)"); process.exit(0); }
console.log(`  encoder: ${encoder}`);
const { sharp } = await getSharp();
const NO_SHARP = process.env.KTX2_NO_SHARP === "1";   // the child run below: optimize.ts behaves as a host without sharp

async function png(w: number, h: number): Promise<Uint8Array> {
  // a non-flat image so the encoder has real work (a gradient + stripes)
  const raw = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4; raw[i] = (x * 255 / w) | 0; raw[i + 1] = (y * 255 / h) | 0; raw[i + 2] = ((x >> 5) & 1) * 255; raw[i + 3] = 255;
  }
  return new Uint8Array(await sharp(Buffer.from(raw), { raw: { width: w, height: h, channels: 4 } }).png().toBuffer());
}

async function glbWith(w: number, h: number): Promise<Uint8Array> {
  const doc = new Document();
  const buf = doc.createBuffer();
  const tex = doc.createTexture("albedo").setImage(await png(w, h)).setMimeType("image/png");
  const mat = doc.createMaterial("m").setBaseColorTexture(tex);
  const pos = doc.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buf);
  const uv = doc.createAccessor().setType("VEC2").setArray(new Float32Array([0, 0, 1, 0, 0, 1])).setBuffer(buf);
  const prim = doc.createPrimitive().setAttribute("POSITION", pos).setAttribute("TEXCOORD_0", uv).setMaterial(mat);
  doc.createScene().addChild(doc.createNode("n").setMesh(doc.createMesh("mesh").addPrimitive(prim)));
  return new NodeIO().writeBinary(doc);
}

function ktx2Dims(glb: Uint8Array): [number, number][] {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
  const bin = 20 + jsonLen + 8;
  const out: [number, number][] = [];
  for (const im of json.images ?? []) {
    const bv = json.bufferViews[im.bufferView]; const o = bin + (bv.byteOffset ?? 0);
    if (im.mimeType !== "image/ktx2") { out.push([-1, -1]); continue; }
    out.push([dv.getUint32(o + 20, true), dv.getUint32(o + 24, true)]);   // KTX2 header: pixelWidth @20, pixelHeight @24
  }
  return out;
}

if (NO_SHARP) {   // child: only the over-cap case. It must not come out as a full-size KTX2 under the texel1024 recipe
  const r = await optimizeGlbKtx2(await glbWith(2048, 2048), encoder);
  const dims = r.out ? ktx2Dims(r.out) : [];
  const ok = !dims.some(([w, h]) => w > 1024 || h > 1024);
  console.log(`NO_SHARP ${ok ? "OK" : "OVERCAP"} ${JSON.stringify(dims)}`); process.exit(0);
}
for (const [w, h, want, name] of [[2048, 2048, [1024, 1024], "capped: 2048² → 1024²"], [2048, 1024, [1024, 512], "aspect: 2048x1024 → 1024x512"], [512, 512, [512, 512], "small: 512² untouched"]] as const) {
  const r = await optimizeGlbKtx2(await glbWith(w, h), encoder);
  const dims = r.out ? ktx2Dims(r.out) : [];
  check(name, dims.length === 1 && dims[0][0] === want[0] && dims[0][1] === want[1], `got ${JSON.stringify(dims)}${r.out ? "" : " (no output: " + JSON.stringify(r).slice(0, 160) + ")"}`);
}
{ const child = Bun.spawnSync(["bun", import.meta.path], { env: { ...process.env, KTX2_NO_SHARP: "1" } });
  const line = new TextDecoder().decode(child.stdout).split("\n").find((l) => l.startsWith("NO_SHARP")) ?? "(no answer)";
  check("no sharp on a ktx-create host: a 2048² texture is never shipped over the cap (Greptile #207)", /^NO_SHARP OK/.test(line), line); }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
