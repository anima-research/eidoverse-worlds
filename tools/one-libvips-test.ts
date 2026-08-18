// One libvips per optimize process (#122).
//
//   bun tools/one-libvips-test.ts
//
// The store's root manifest declares `sharp: ^0.33.5`; @gltf-transform/
// functions reaches sharp through ndarray-pixels, which declares `^0.35.0`.
// Non-intersecting ranges cannot be deduped, so both copies land on disk and
// a bare `import("sharp")` inside optimize.ts loads a SECOND native libvips
// beside the one gltf-transform already has. They disagree about libvips'
// own enums, and the encode goes wrong in one of two ways:
//
//   win32     GLib-GObject-CRITICAL: value "32" ... 'VipsInterpretation'
//             Error: colourspace: parameter space not set   — it THROWS
//   show box  no throw. The encode returns uninitialized memory (a repeated
//             LE uint32, then zeros), gltf-transform stamps it `image/webp`,
//             and the store serves an image that is not an image.
//
// The second is #122: the threshold-lantern's baseColor and normal came out
// undecodable, the material fell back to baseColorFactor 1,1,1,1, and the
// lantern rendered white for everyone whose client took the variant.
//
// The throw is the merciful case and the one this box reproduces, so an
// end-to-end check here is a real control: on unmodified main case 1 fails
// outright. But a machine that happens to dedupe (or a future lockfile that
// aligns the ranges) would pass case 1 for reasons unrelated to the fix, so
// case 2 asserts the STRUCTURE — the resolver reaches the nested copy
// whenever a nested copy exists.
//
// Cases 1 and 2 both describe what optimize.ts ASKS for. Case 3 is the one
// that answers the question directly — it censuses the native binaries this
// process actually mapped, after a real optimizeGlb run. "Avoids the bare
// specifier" and "loads one libvips" are different claims, and only the
// second is the fix.

import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { optimizeGlb } from "../server/optimize.ts";

// getSharp does not exist on main — pull it dynamically so this file still
// RUNS there and demonstrates the failure, rather than dying at import and
// proving nothing (the fail-on-main convention, cf. mcpl/effective-test.ts).
const OPT = await import("../server/optimize.ts") as {
  getSharp?: () => Promise<{ sharp: any; from: string }>;
};
const getSharp = OPT.getSharp
  ?? (async () => ({ sharp: (await import("sharp")).default, from: "sharp (bare specifier)" }));

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};

const MAGIC: [number[], string][] = [
  [[0x89, 0x50, 0x4e, 0x47], "image/png"],
  [[0xff, 0xd8, 0xff], "image/jpeg"],
];
/** Declared mimeType vs actual container magic — compared against what the
 *  image CLAIMS to be, never against one hardcoded format. (The first #122
 *  sweep tested every image for webp magic and reported untouched PNGs as
 *  corrupt; the blast radius came out 3× too high.) */
function sniff(b: Uint8Array): string {
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  for (const [m, name] of MAGIC) if (m.every((v, i) => b[i] === v)) return name;
  return `UNKNOWN(${[...b.slice(0, 8)].map((x) => x.toString(16).padStart(2, "0")).join(" ")})`;
}

function imagesOf(glb: Uint8Array): { mime: string; bytes: Uint8Array }[] {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  let off = 12, json: any = null, bin: Uint8Array | null = null;
  while (off < glb.length) {
    const len = dv.getUint32(off, true), ty = dv.getUint32(off + 4, true);
    const chunk = glb.subarray(off + 8, off + 8 + len);
    if (ty === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (ty === 0x004e4942) bin = chunk;
    off += 8 + len;
  }
  return (json.images ?? []).map((im: any) => {
    const v = json.bufferViews[im.bufferView];
    const start = v.byteOffset ?? 0;
    return { mime: im.mimeType, bytes: bin!.subarray(start, start + v.byteLength) };
  });
}

console.log("\none libvips per optimize process (#122):\n");

// ---------------------------------------------- 1. the encode, end to end
// A JPEG source on purpose: JPEG and webp both route through the CONVERTING
// path, which is where the two libvips meet. (The lantern's one surviving
// texture was its PNG-sourced ORM map — the discriminator that named the
// mechanism in the first place.)
// The scaffolding resolves its OWN sharp — gltf-transform's copy, directly.
// It must not go through the module under test: on main that returns the root
// copy, the fixture encode is then the first place the two libvips meet, and
// the file dies at setup instead of reporting which checks failed.
const fixtureSharp = await (async () => {
  try {
    const fd = dirname(Bun.resolveSync("@gltf-transform/functions", join(import.meta.dir, "../server")));
    return (await import(Bun.resolveSync("sharp", dirname(Bun.resolveSync("ndarray-pixels", fd))))).default;
  } catch { return (await import("sharp")).default; }
})();
const { from } = await getSharp();
const sharp = fixtureSharp;
const tmp = mkdtempSync(join(tmpdir(), "ew-libvips-"));
try {
  // A 256² gradient, encoded as JPEG — real image data, deterministic. It has
  // to VARY: prune() folds a solid-colour texture into baseColorFactor and
  // drops it, which would leave the pass under test nothing to encode.
  const W = 256, px = Buffer.alloc(W * W * 3);
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      px[i] = x; px[i + 1] = y; px[i + 2] = (x ^ y) & 0xff;
    }
  const jpeg = await sharp(px, { raw: { width: W, height: W, channels: 3 } }).jpeg().toBuffer();

  const doc = new Document();
  const buf = doc.createBuffer();          // GLB resources need one, images included
  const tex = doc.createTexture("probe").setImage(new Uint8Array(jpeg)).setMimeType("image/jpeg");
  const mat = doc.createMaterial("probeMat").setBaseColorTexture(tex);
  const prim = doc.createPrimitive().setMaterial(mat)
    .setAttribute("POSITION",
      doc.createAccessor().setType("VEC3").setBuffer(buf)
        .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])))
    // TEXCOORD_0 is load-bearing: without UVs prune() reads the baseColor
    // texture as unreferenced and drops it, and the pass under test has
    // nothing left to encode.
    .setAttribute("TEXCOORD_0",
      doc.createAccessor().setType("VEC2").setBuffer(buf)
        .setArray(new Float32Array([0, 0, 1, 0, 0, 1])));
  const mesh = doc.createMesh("probeMesh").addPrimitive(prim);
  const node = doc.createNode("probeNode").setMesh(mesh);
  doc.createScene("probeScene").addChild(node);

  const io = new NodeIO();
  const src = await io.writeBinary(doc);

  let out: Uint8Array | null = null;
  let threw = "";
  try { out = await optimizeGlb(src); } catch (e) { threw = (e as Error).message; }
  check("optimizeGlb completes — two libvips make this throw on win32",
    out !== null, threw);

  if (out) {
    const imgs = imagesOf(out);
    check("the pass produced an image at all", imgs.length > 0, `${imgs.length} images`);
    for (const [i, im] of imgs.entries()) {
      const actual = sniff(im.bytes);
      check(`image ${i}: declared ${im.mime}, and actually is`, actual === im.mime,
        `actual ${actual}, ${im.bytes.length} bytes`);
      let decoded = "";
      try {
        const m = await sharp(Buffer.from(im.bytes)).metadata();
        decoded = `${m.width}x${m.height}`;
      } catch (e) { decoded = `FAILED: ${(e as Error).message}`; }
      check(`image ${i}: decodes for real, not just the right header`,
        /^\d+x\d+$/.test(decoded), decoded);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ------------------------------------------- 2. the structure, not the luck
// Case 1 passes on a machine that happens to have one copy, for reasons that
// have nothing to do with the fix. This is what actually pins it.
const fnDir = dirname(Bun.resolveSync("@gltf-transform/functions", join(import.meta.dir, "../server")));
const npDir = dirname(Bun.resolveSync("ndarray-pixels", fnDir));
let nested: string | null = null;
try { nested = Bun.resolveSync("sharp", npDir); } catch { /* deduped install */ }

if (nested && existsSync(nested)) {
  check("the resolver reaches gltf-transform's OWN sharp, not the root copy",
    from === nested, `from=${from}`);
  check("...and that is a genuinely different copy (else this proves nothing)",
    !from.includes(join("node_modules", "sharp").replace(/\\/g, "/"))
      || from.includes("ndarray-pixels"), `from=${from}`);
} else {
  // Not a failure: a deduped install is the state this fix is chasing.
  console.log("  \x1b[36m—\x1b[0m single sharp install; the bare specifier is safe here");
  console.log(`     resolved: ${from}`);
}

// ------------------------------------------- 3. the process, not the resolver
// Cases 1 and 2 show that optimize.ts ASKS for the right copy. This shows what
// the process actually LOADED, which is the only claim that matters: the fix
// is "one libvips per optimize process", so count the libvips.
//
// process.report.getReport().sharedObjects lists the native binaries mapped
// into this process by absolute path. Two distinct install roots holding a
// sharp binding means two libvips, whatever the resolver intended. Measured
// AFTER case 1's real optimizeGlb run, so it covers the actual optimize path
// and not a synthetic import.
const report = (process as any).report?.getReport?.();
if (!report || !Array.isArray(report.sharedObjects)) {
  console.log("  [36m—[0m process.report unavailable on this runtime; skipping the load census");
} else {
  const installs = [...new Set((report.sharedObjects as string[])
    .filter((s) => /sharp/i.test(s) && s.endsWith(".node"))
    .map((s) => dirname(s)))];
  check("exactly one sharp install is loaded in this process",
    installs.length === 1,
    installs.length === 0
      ? "none loaded — the texture pass never ran, so this proves nothing"
      : `${installs.length} loaded:${installs.map((i) => `
     ${i}`).join("")}`);
}


console.log(`\n${failures === 0 ? "\x1b[32m" : "\x1b[31m"}${failures} failed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
