// The optimizer's output check: does findImageLies catch an image that is not
// what it says it is, and stay silent on one that is?
//
// The shape under test is the real one from #122 — a GLB whose images are
// declared image/webp while the bytes are uninitialized memory (a repeated
// 32-bit value, then zeros), which is what the two-libvips corruption
// actually produced for the threshold-lantern.
//
//   bun run tools/image-lie-test.ts

import { findImageLies } from "../server/optimize.ts";

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

// ---- fixtures ---------------------------------------------------------------

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 100, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const KTX2 = new Uint8Array([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
/** The lantern's actual head bytes: 0x01d559c8 twice, then zeros. */
const GARBAGE = new Uint8Array([0xc8, 0x59, 0xd5, 0x01, 0xc8, 0x59, 0xd5, 0x01, 0, 0, 0, 0, 0, 0, 0, 0]);

/** Assemble a minimal but VALID GLB: images[i] -> bufferViews[i] -> BIN. */
function makeGlb(images: { bytes: Uint8Array; mime: string; name?: string; uri?: string }[]): Uint8Array {
  const bufferViews: any[] = [];
  const parts: Uint8Array[] = [];
  let off = 0;
  const jsonImages = images.map((im, i) => {
    if (im.uri) return { uri: im.uri, mimeType: im.mime, name: im.name ?? `img${i}` };
    bufferViews.push({ buffer: 0, byteOffset: off, byteLength: im.bytes.length });
    parts.push(im.bytes);
    const pad = (4 - (im.bytes.length % 4)) % 4;
    if (pad) parts.push(new Uint8Array(pad));
    off += im.bytes.length + pad;
    return { bufferView: bufferViews.length - 1, mimeType: im.mime, name: im.name ?? `img${i}` };
  });
  const bin = new Uint8Array(off);
  let w = 0;
  for (const p of parts) { bin.set(p, w); w += p.length; }
  const json = { asset: { version: "2.0" }, images: jsonImages, bufferViews, buffers: [{ byteLength: off }] };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jPad = (4 - (jsonBytes.length % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jPad + (off ? 8 + off : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  let p = 12;
  dv.setUint32(p, jsonBytes.length + jPad, true); dv.setUint32(p + 4, 0x4e4f534a, true);
  out.set(jsonBytes, p + 8); out.fill(0x20, p + 8 + jsonBytes.length, p + 8 + jsonBytes.length + jPad);
  p += 8 + jsonBytes.length + jPad;
  if (off) { dv.setUint32(p, off, true); dv.setUint32(p + 4, 0x004e4942, true); out.set(bin, p + 8); }
  return out;
}

console.log("optimizer output check (an image must be what it says it is):\n");

// ---- honest files stay silent -----------------------------------------------

check("a truthful png/jpeg/webp/ktx2 set raises nothing",
  findImageLies(makeGlb([
    { bytes: PNG, mime: "image/png" }, { bytes: JPEG, mime: "image/jpeg" },
    { bytes: WEBP, mime: "image/webp" }, { bytes: KTX2, mime: "image/ktx2" },
  ])).length === 0);

check("a GLB with no images at all is clean, not a crash",
  findImageLies(makeGlb([])).length === 0);

// ---- the #122 shape ---------------------------------------------------------

const lantern = makeGlb([
  { bytes: GARBAGE, mime: "image/webp", name: "…_Normal_Bake" },
  { bytes: GARBAGE, mime: "image/webp", name: "…_BaseColor" },
  { bytes: WEBP, mime: "image/webp", name: "…metallic-roughness" },
]);
const lies = findImageLies(lantern);
check("the lantern's two corrupt images are caught", lies.length === 2, `found ${lies.length}`);
check("...and the intact third one is NOT flagged",
  !lies.some((l) => l.name.includes("metallic")), JSON.stringify(lies.map((l) => l.name)));
check("...reported as unrecognized, not as some other format",
  lies.every((l) => l.actual === "unrecognized"), JSON.stringify(lies.map((l) => l.actual)));
check("...naming the image so the report is actionable",
  lies[0]?.name === "…_Normal_Bake" && lies[0]?.declared === "image/webp", JSON.stringify(lies[0]));
check("...carrying the head bytes that identify the corruption",
  lies[0]?.head.startsWith("c8 59 d5 01 c8 59 d5 01"), lies[0]?.head);

// ---- a wrong-but-valid format is still a lie --------------------------------

check("a real PNG declared as webp is caught (mislabel, not corruption)",
  findImageLies(makeGlb([{ bytes: PNG, mime: "image/webp" }]))[0]?.actual === "image/png");

check("a real webp declared as png is caught in the other direction",
  findImageLies(makeGlb([{ bytes: WEBP, mime: "image/png" }]))[0]?.actual === "image/webp");

// ---- what the check must NOT do ---------------------------------------------

check("an image referenced by URI is left alone (not our bytes to vouch for)",
  findImageLies(makeGlb([{ bytes: new Uint8Array(0), mime: "image/png", uri: "tex.png" }])).length === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
