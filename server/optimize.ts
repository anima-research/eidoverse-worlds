// optimize — the store's diet.
//
// Uploaded GLBs (drag-drop, Orrery/Tripo conjures) used to be served exactly
// as they arrived: raw multi-megabyte meshes with 2K PNG textures, paid in
// full by EVERY client on EVERY first load, forever — the library got a
// draco+webp mirror on day one (~30x) and the store, where all new content
// lands, never did.
//
// This is the same proven recipe, programmatic: dedup + prune + resample +
// webp@1024 + draco. Originals are NEVER touched (append-only doctrine; they
// are the provenance the hash names). Optimized copies live in
// assets/opt/store-min/<hash>.glb and /library serving prefers them.
//
// ⚠️ RUN AS A SUBPROCESS (see CLI below). Draco and image encoding are
// CPU-seconds of synchronous wasm — inside the sequencer process they would
// freeze pose relay and every world for the duration. server.ts spawns
// `bun run server/optimize.ts <in> <out>` per file, one at a time.
//
// VRMs are deliberately NOT run through this pipeline: their springbone/MToon
// extension data has not been proven through it, and a corrupted body is a
// much worse day than a heavy one. The ONE thing a VRM gets is §20c's
// --ktx2-vrm surgical texture rewrite below — raw container work that never
// constructs a Document, swaps image bytes only, and byte-preserves
// everything else (no draco, no prune, no resample on bodies, ever).

import { NodeIO, type Document } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRTextureBasisu } from "@gltf-transform/extensions";
import { dedup, prune, resample, textureCompress, draco, listTextureSlots } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

let ioP: Promise<NodeIO> | null = null;
function getIO(): Promise<NodeIO> {
  ioP ??= (async () =>
    new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      "draco3d.decoder": await draco3d.createDecoderModule(),
      "draco3d.encoder": await draco3d.createEncoderModule(),
    }))();
  return ioP;
}

export async function optimizeGlb(bytes: Uint8Array): Promise<Uint8Array> {
  const io = await getIO();
  const doc = await io.readBinary(bytes);

  const transforms = [
    dedup(),      // shared textures/accessors stored once
    prune(),      // unreferenced leftovers dropped
    resample(),   // animation keyframes deduplicated (lossless within tolerance)
  ];

  // Texture recompression needs sharp (native). If it can't load on this box,
  // a draco-only pass is still most of the win — degrade, don't die.
  try {
    const sharp = (await import("sharp")).default;
    transforms.push(textureCompress({
      encoder: sharp,
      targetFormat: "webp",
      resize: [1024, 1024],
    }));
  } catch (e) {
    console.error(`[optimize] sharp unavailable (${(e as Error).message}) — skipping texture pass`);
  }

  transforms.push(draco());

  await doc.transform(...transforms);
  return io.writeBinary(doc);
}

// ---- KTX2 (§20a): the library variant diet ----------------------------------
// GPU-native compressed textures pay the texture bill in the right currency:
// no createImageBitmap decode (1.0-1.2s/GLB on the MacBook trace), no raw
// RGBA uploads (1.07GB of them), 4-8× less VRAM. The variant is the store
// recipe MINUS the webp stage (KTX2 encodes from the best source) PLUS a
// per-texture KTX2 pass between resample and draco. Output serves ONLY on
// ?ktx2=1 — KHR_texture_basisu lands in extensionsRequired, and parsers
// without a KTX2 decoder throw on required extensions.

/** Encoder probe: KTX2_TOKTX env (absolute path) → toktx on PATH → ktx on
 *  PATH. Absent is an ENVIRONMENT, not a failure — the CLI exits 3 so the
 *  caller env-skips, never writing a .failed marker (the sharp-degrade
 *  pattern: the content is fine, this box just can't encode yet). */
export function findKtx2Encoder(): string | null {
  const env = process.env.KTX2_TOKTX;
  if (env && existsSync(env)) return env;
  const which = Bun.which("toktx") ?? Bun.which("ktx");
  if (which) return which;
  // the docs/ktx2-encoder.md recipe lands here (bin+lib siblings for
  // @rpath) — a PATH-less install must not silently exit-3 the sweep
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  for (const p of [`${home}/.local/ktx/bin/toktx`, `${home}/.local/ktx/bin/ktx`])
    if (home && existsSync(p)) return p;
  return null;
}

// baseColor/emissive are the eye-facing sRGB slots — ETC1S block noise hides
// in shading there and the files come out ~4-8× smaller. Everything else
// (normal, occlusion-roughness-metallic, packed maps, any slot we can't name)
// carries per-channel DATA: MToon samples .r/.b scalars and normals get
// renormalized, so ETC1S artifacts read as corruption — those go UASTC+zstd.
const COLOR_SLOT = /baseColor|emissive/i;

/** One encoder invocation's argv, shared by the GLB arm and the VRM rewrite.
 *  ETC1S rides BasisLZ (zstd would be invalid there); UASTC gets mild RDO
 *  (λ=1.0, quality-preserving) + zstd 18 — raw UASTC is a flat 8bpp and zstd
 *  alone barely dents it (the crow's 2048² maps came out 2.6× the JPEG
 *  source; RDO is what makes zstd bite). --genmipmap always: compressed mips
 *  can't be generated at runtime. */
function ktx2EncodeArgs(encoder: string, isToktx: boolean, srgb: boolean, uastc: boolean, inPath: string, outPath: string): string[] {
  return isToktx
    ? [encoder, "--t2", "--genmipmap", "--assign_oetf", srgb ? "srgb" : "linear",
       ...(uastc ? ["--encode", "uastc", "--uastc_quality", "2", "--uastc_rdo_l", "1.0", "--zcmp", "18"]
                 : ["--encode", "etc1s", "--qlevel", "128"]),
       outPath, inPath]
    : [encoder, "create", "--format", srgb ? "R8G8B8A8_SRGB" : "R8G8B8A8_UNORM",
       "--generate-mipmap",
       ...(uastc ? ["--encode", "uastc", "--uastc-quality", "2", "--uastc-rdo", "--uastc-rdo-l", "1.0", "--zstd", "18"]
                 : ["--encode", "basis-lz", "--qlevel", "128"]),
       inPath, outPath];
}

/** Per-texture KTX2 encode, in place on the Document. Supports both
 *  KTX-Software CLIs — toktx (v4.4.2, the primary target) and the newer
 *  unified `ktx create` — detected by basename. Content problems skip the
 *  TEXTURE, never the file. Returns how many textures were converted. */
async function ktx2CompressTextures(doc: Document, encoder: string): Promise<number> {
  const isToktx = basename(encoder).toLowerCase().includes("toktx");
  // sharp converts non-PNG sources (webp/jpeg) and 4-aligns dimensions —
  // KHR_texture_basisu (and WebGPU BC upload) wants width/height % 4 == 0.
  // sharp is optional today: without it, only already-aligned PNGs encode.
  let sharp: any = null;
  try { sharp = (await import("sharp")).default; } catch { /* PNG-only pass below */ }
  const tmp = mkdtempSync(join(tmpdir(), "ew-ktx2-"));
  let converted = 0;
  try {
    const textures = doc.getRoot().listTextures();
    for (let i = 0; i < textures.length; i++) {
      const tex = textures[i];
      const image = tex.getImage();
      if (!image) continue;
      const label = tex.getName() || tex.getURI() || `#${i}`;
      const slots = listTextureSlots(tex);
      const srgb = slots.some((s) => COLOR_SLOT.test(s));
      // any non-color reference (or a slot we can't classify) ⇒ UASTC
      const uastc = slots.length === 0 || slots.some((s) => !COLOR_SLOT.test(s));
      const size = tex.getSize(); // [w, h] | null (png/jpeg/webp all readable)
      const aligned = !!size && size[0] % 4 === 0 && size[1] % 4 === 0;
      const mime = tex.getMimeType();
      // Pass the source straight through wherever the encoder reads it
      // natively — PNG always, JPEG for toktx. sharp is only the CONVERTER
      // for the rest (webp, unaligned dims), and it must be treated as
      // best-effort here: @gltf-transform/functions' ndarray-pixels vendors
      // its OWN sharp, and two libvips copies in one process can corrupt
      // each other's GLib state (observed on win32: "colourspace: parameter
      // space not set"). A sharp failure skips the TEXTURE, never the file.
      let inPath: string;
      if (aligned && (mime === "image/png" || (mime === "image/jpeg" && isToktx))) {
        inPath = join(tmp, mime === "image/png" ? `${i}.png` : `${i}.jpg`);
        await Bun.write(inPath, image);
      } else if (sharp) {
        try {
          let s = sharp(Buffer.from(image));
          const meta = await s.metadata();
          const w = meta.width ?? 0, h = meta.height ?? 0;
          if (w && h && (w % 4 || h % 4))
            s = s.resize(Math.ceil(w / 4) * 4, Math.ceil(h / 4) * 4, { fit: "fill" });
          inPath = join(tmp, `${i}.png`);
          await Bun.write(inPath, await s.png().toBuffer());
        } catch (e) {
          console.error(`[optimize] ktx2: skip ${label} — sharp convert failed (${(e as Error).message})`);
          continue;
        }
      } else {
        console.error(`[optimize] ktx2: skip ${label} (${mime}${aligned ? "" : ", not 4-aligned"}) — sharp unavailable`);
        continue;
      }
      const outPath = join(tmp, `${i}.ktx2`);
      const args = ktx2EncodeArgs(encoder, isToktx, srgb, uastc, inPath, outPath);
      const proc = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
      const code = await proc.exited;
      const err = (await new Response(proc.stderr).text()).trim();
      if (code !== 0 || !existsSync(outPath)) {
        console.error(`[optimize] ktx2: encode failed on ${label} (${err.split("\n")[0] || `exit ${code}`}) — texture kept as-is`);
        continue;
      }
      tex.setImage(new Uint8Array(await Bun.file(outPath).arrayBuffer())).setMimeType("image/ktx2");
      const uri = tex.getURI();
      if (uri) tex.setURI(uri.replace(/\.[a-zA-Z0-9]+$/, "") + ".ktx2");
      converted++;
    }
    // the extension's write hook moves converted textures' sources under
    // KHR_texture_basisu; required per spec (no fallback image is written)
    if (converted > 0) doc.createExtension(KHRTextureBasisu).setRequired(true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return converted;
}

/** The --ktx2 diet: dedup + prune + resample (the store recipe minus webp —
 *  KTX2 encodes from the best source) + per-texture KTX2 + draco. */
export async function optimizeGlbKtx2(bytes: Uint8Array, encoder: string): Promise<Uint8Array> {
  const io = await getIO();
  const doc = await io.readBinary(bytes);
  await doc.transform(dedup(), prune(), resample());
  await ktx2CompressTextures(doc, encoder);
  await doc.transform(draco());
  return io.writeBinary(doc);
}

// ---- KTX2 for VRMs (§20c): the surgical container rewrite -------------------
// gltf-transform DROPS unknown extensions on read, and a VRM is mostly
// unknown extensions (VRM 0.x: everything under extensions.VRM; 1.x:
// VRMC_vrm, VRMC_materials_mtoon, VRMC_springBone, VRMC_node_constraint…) —
// one round-trip through a Document and the body loses its springs, its face,
// its humanoid. So a VRM never touches a Document: raw GLB container work
// where the ONLY mutations are (a) image bytes swapped for their KTX2
// encodes, (b) the bufferView byteOffsets/byteLengths that move implies, and
// (c) the minimal JSON that declares them (mimeType, KHR_texture_basisu).
// Every bufferView keeps its INDEX and ORDER; accessors, skins, sparse
// blocks, and every VRM/VRMC_* JSON section ride through byte-untouched. A
// torn VRM is someone's BODY: transcodeVrmKtx2 validates its own output —
// re-parse, per-view byte comparison, untouched-section equality — and
// throws (CLI exit 1) over returning anything questionable.

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const KTX2_ID = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
const align4 = (n: number) => (n + 3) & ~3;

type GlbParts = { json: any; bin: Uint8Array; total: number };

/** glTF 2.0 binary layout, validated: magic/version, chunk 0 = JSON
 *  (0x4E4F534A), BIN chunk = 0x004E4942. Chunk lengths INCLUDE the spec's
 *  4-byte padding (JSON pads with 0x20 — JSON.parse tolerates it; BIN pads
 *  with zeros — buffers[0].byteLength names the real end). */
function parseGlb(bytes: Uint8Array): GlbParts {
  if (bytes.length < 20) throw new Error("truncated GLB header");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error("not a GLB container");
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error(`unsupported GLB version ${version}`);
  const total = dv.getUint32(8, true);
  if (total > bytes.length) throw new Error(`declared length ${total} exceeds file (${bytes.length} bytes)`);
  const chunks: { type: number; data: Uint8Array }[] = [];
  let off = 12;
  while (off + 8 <= total) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    if (off + 8 + len > total) throw new Error(`chunk at ${off} overruns the container`);
    chunks.push({ type, data: bytes.subarray(off + 8, off + 8 + len) });
    off += 8 + len;
  }
  if (chunks[0]?.type !== CHUNK_JSON) throw new Error("first chunk is not JSON");
  const binChunks = chunks.filter((c) => c.type === CHUNK_BIN);
  if (binChunks.length > 1) throw new Error("multiple BIN chunks");
  const json = JSON.parse(new TextDecoder().decode(chunks[0].data));
  return { json, bin: binChunks[0]?.data ?? new Uint8Array(0), total };
}

// ---- output validation ------------------------------------------------------
// The write below is already careful about TRUNCATION (tmp+rename: "a killed
// pass must never leave a truncated GLB where the server will trustingly serve
// it"). A whole GLB can still arrive intact and carry image bytes that are not
// images: `textureCompress` runs ndarray-pixels' vendored sharp alongside ours,
// and two libvips copies in one process can corrupt each other's state (the
// hazard documented at ktx2CompressTextures). When that happens the encoder
// returns a buffer, gltf-transform stamps `image/webp` on it, draco packs it,
// and the file ships. Nothing downstream looks, because every consumer trusts
// the mimeType — so the failure surfaces as one asset rendering untextured
// white, days later, in someone's screenshot (#122).
//
// The rule: an optimizer may give up, but it may not emit bytes it has not
// checked. The VRM arm already validates its own output and throws rather than
// return anything questionable; this is the same doctrine for the other arms,
// at the one place where a lie is cheap to detect — the first four bytes.

const IMAGE_MAGIC: { mime: string; test: (b: Uint8Array) => boolean }[] = [
  { mime: "image/png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/webp", test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
  { mime: "image/ktx2", test: (b) => KTX2_ID.every((v, i) => b[i] === v) },
];

export type ImageLie = { index: number; name: string; declared: string; actual: string; head: string };

/** Every embedded image's DECLARED mimeType against what its bytes actually
 *  are. Images referenced by URI are somebody else's file and are left alone;
 *  an image with no recognizable magic reports "unrecognized", which is the
 *  case that matters — corruption does not usually land on another format. */
export function findImageLies(bytes: Uint8Array): ImageLie[] {
  const { json, bin } = parseGlb(bytes);
  const out: ImageLie[] = [];
  const images: any[] = json.images ?? [];
  for (let i = 0; i < images.length; i++) {
    const im = images[i];
    if (im.bufferView == null) continue;              // external URI — not ours to vouch for
    const bv = json.bufferViews?.[im.bufferView];
    if (!bv) continue;
    const b = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + (bv.byteLength ?? 0));
    const actual = IMAGE_MAGIC.find((m) => m.test(b))?.mime ?? "unrecognized";
    if (actual === im.mimeType) continue;
    out.push({
      index: i, name: im.name ?? "", declared: im.mimeType ?? "(none)", actual,
      head: [...b.subarray(0, 12)].map((x) => x.toString(16).padStart(2, "0")).join(" "),
    });
  }
  return out;
}

/** Slot classification from the JSON alone — the three vocabularies a VRM can
 *  speak, folded onto IMAGES (encoding is per image; textures sharing one
 *  image accumulate their marks onto it):
 *    - core glTF materials: baseColor/emissive = color; normal/occlusion/
 *      metallicRoughness = data.
 *    - VRM 1.x VRMC_materials_mtoon: shade/matcap/rimMultiply = color;
 *      shadingShift/uvAnimationMask/outlineWidthMultiply = data (MToon
 *      samples .r/.b SCALARS there — ETC1S block color noise reads as
 *      corruption, the §20 extraction's finding).
 *    - VRM 0.x extensions.VRM.materialProperties[].textureProperties:
 *      _MainTex/_ShadeTexture/_SphereAdd/_RimTexture/_EmissionMap = color;
 *      _BumpMap/_OutlineWidthTexture/_UvAnimMaskTexture = data.
 *  Anything unrecognized — unknown slot keys, the VRM 1.x meta
 *  thumbnailImage (an image no texture references), VRM 0.x meta.texture —
 *  ends up data-or-unreferenced, i.e. UASTC: safe, bigger. */
function classifyVrmImages(json: any): Map<number, { color: boolean; data: boolean }> {
  const marks = new Map<number, { color: boolean; data: boolean }>();
  const texIndex = (ref: any): number | undefined =>
    typeof ref === "number" ? ref : typeof ref?.index === "number" ? ref.index : undefined;
  const mark = (ref: any, color: boolean) => {
    const ti = texIndex(ref);
    if (ti === undefined) return;
    const src = json.textures?.[ti]?.source ?? json.textures?.[ti]?.extensions?.KHR_texture_basisu?.source;
    if (typeof src !== "number") return;
    const m = marks.get(src) ?? { color: false, data: false };
    if (color) m.color = true; else m.data = true;
    marks.set(src, m);
  };
  const MTOON_COLOR = new Set(["shadeMultiplyTexture", "matcapTexture", "rimMultiplyTexture"]);
  for (const m of json.materials ?? []) {
    const pbr = m.pbrMetallicRoughness ?? {};
    mark(pbr.baseColorTexture, true);
    mark(m.emissiveTexture, true);
    mark(pbr.metallicRoughnessTexture, false);
    mark(m.normalTexture, false);
    mark(m.occlusionTexture, false);
    const mtoon = m.extensions?.VRMC_materials_mtoon;
    if (mtoon) {
      for (const [k, v] of Object.entries(mtoon)) {
        if (!k.endsWith("Texture")) continue;
        mark(v, MTOON_COLOR.has(k)); // unknown *Texture keys ⇒ data ⇒ UASTC
      }
    }
  }
  const VRM0_COLOR = new Set(["_MainTex", "_ShadeTexture", "_SphereAdd", "_RimTexture", "_EmissionMap"]);
  for (const mp of json.extensions?.VRM?.materialProperties ?? []) {
    for (const [k, v] of Object.entries(mp.textureProperties ?? {})) {
      mark(v, VRM0_COLOR.has(k)); // unknown keys ⇒ data ⇒ UASTC
    }
  }
  return marks;
}

/** PNG IHDR / JPEG SOFn dimensions, without decoding — there is no
 *  gltf-transform Texture here to ask, and sharp stays best-effort-only
 *  (the two-libvips hazard documented at ktx2CompressTextures). */
function rasterDims(bytes: Uint8Array, mime: string): [number, number] | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === "image/png") {
    if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
    return [dv.getUint32(16, false), dv.getUint32(20, false)];
  }
  if (mime === "image/jpeg") {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let o = 2;
    while (o + 9 < bytes.length) {
      if (bytes[o] !== 0xff) return null;
      const marker = bytes[o + 1];
      if (marker >= 0xd0 && marker <= 0xd9) { o += 2; continue; } // RSTn/SOI/EOI: no payload
      const len = dv.getUint16(o + 2, false);
      const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) return [dv.getUint16(o + 7, false), dv.getUint16(o + 5, false)]; // [width, height]
      o += 2 + len;
    }
    return null;
  }
  return null;
}

/** The self-check before anything is written. Compares the OUTPUT container
 *  against the source: header/chunk shape, every untouched JSON section
 *  stringify-identical, every bufferView field-identical apart from the
 *  recomputed offsets, every non-replaced view BYTE-identical, every
 *  converted image carrying the KTX2 identifier, every texture patch exact.
 *  Throws on the first discrepancy — refusal is the correct output here. */
function validateVrmRewrite(srcJson: any, srcBin: Uint8Array, out: Uint8Array, converted: Set<number>): void {
  const { json: oj, bin: ob, total } = parseGlb(out); // structural re-parse — throws on a torn container
  if (total !== out.length) throw new Error(`output declares ${total} bytes but is ${out.length}`);
  const UNTOUCHED = ["asset", "scene", "scenes", "nodes", "meshes", "skins", "accessors",
    "animations", "samplers", "materials", "cameras", "extensions", "extras"];
  for (const k of UNTOUCHED) {
    if (JSON.stringify(srcJson[k]) !== JSON.stringify(oj[k])) throw new Error(`JSON section "${k}" drifted`);
  }
  for (const k of ["bufferViews", "images", "textures"]) {
    if ((srcJson[k]?.length ?? 0) !== (oj[k]?.length ?? 0)) throw new Error(`${k} count changed`);
  }
  const obufLen = oj.buffers?.[0]?.byteLength ?? 0;
  if (obufLen > ob.length) throw new Error(`buffers[0].byteLength ${obufLen} exceeds BIN chunk (${ob.length})`);
  const replacedViews = new Set([...converted].map((i) => srcJson.images[i].bufferView as number));
  for (const [idx, sbv] of (srcJson.bufferViews ?? []).entries()) {
    const nbv = oj.bufferViews[idx];
    for (const key of new Set([...Object.keys(sbv), ...Object.keys(nbv)])) {
      if (key === "byteOffset" || key === "byteLength") continue;
      if (JSON.stringify(sbv[key]) !== JSON.stringify(nbv[key])) throw new Error(`bufferView ${idx} field "${key}" drifted`);
    }
    if ((sbv.buffer ?? 0) !== 0) continue; // external buffer — bytes not ours
    const noff = nbv.byteOffset ?? 0;
    if (noff % 4) throw new Error(`bufferView ${idx} misaligned (${noff})`);
    if (noff + nbv.byteLength > ob.length) throw new Error(`bufferView ${idx} out of bounds`);
    if (!replacedViews.has(idx)) {
      if (nbv.byteLength !== sbv.byteLength) throw new Error(`untouched bufferView ${idx} changed length`);
      const soff = sbv.byteOffset ?? 0;
      const same = Buffer.compare(
        Buffer.from(srcBin.buffer, srcBin.byteOffset + soff, sbv.byteLength),
        Buffer.from(ob.buffer, ob.byteOffset + noff, nbv.byteLength)) === 0;
      if (!same) throw new Error(`bufferView ${idx} bytes drifted`);
    }
  }
  for (const [i, img] of (oj.images ?? []).entries()) {
    if (!converted.has(i)) {
      if (JSON.stringify(img) !== JSON.stringify(srcJson.images?.[i])) throw new Error(`untouched image ${i} drifted`);
      continue;
    }
    if (img.mimeType !== "image/ktx2") throw new Error(`converted image ${i} not marked image/ktx2`);
    const bv = oj.bufferViews?.[img.bufferView];
    if (!bv) throw new Error(`converted image ${i} lost its bufferView`);
    const b = ob.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    if (b.length < 12 || KTX2_ID.some((v, k) => b[k] !== v)) throw new Error(`image ${i} does not carry the KTX2 identifier`);
  }
  for (const [j, st] of (srcJson.textures ?? []).entries()) {
    const nt = oj.textures[j];
    if (typeof st.source === "number" && converted.has(st.source)) {
      if (nt.source !== undefined) throw new Error(`texture ${j} kept a raster source`);
      if (nt.extensions?.KHR_texture_basisu?.source !== st.source) throw new Error(`texture ${j} basisu source wrong`);
      for (const key of Object.keys(st)) {
        if (key === "source" || key === "extensions") continue;
        if (JSON.stringify(st[key]) !== JSON.stringify(nt[key])) throw new Error(`texture ${j} field "${key}" drifted`);
      }
    } else if (JSON.stringify(st) !== JSON.stringify(nt)) {
      throw new Error(`untouched texture ${j} drifted`);
    }
  }
  if (!oj.extensionsUsed?.includes("KHR_texture_basisu")) throw new Error("KHR_texture_basisu missing from extensionsUsed");
  if (!oj.extensionsRequired?.includes("KHR_texture_basisu")) throw new Error("KHR_texture_basisu missing from extensionsRequired");
}

/** The rewrite itself. Returns converted = 0 (out = the input, unwritten by
 *  the CLI) when nothing was convertible — a body with no raster images, or
 *  every encode skipped. Content problems skip the IMAGE, never the file;
 *  structural problems throw. */
export async function transcodeVrmKtx2(bytes: Uint8Array, encoder: string):
  Promise<{ out: Uint8Array; converted: number; etc1s: number; uastc: number }> {
  const { json, bin } = parseGlb(bytes);
  // Refuse to operate on a source that is already questionable
  for (const [idx, bv] of (json.bufferViews ?? []).entries()) {
    if ((bv.buffer ?? 0) !== 0) continue;
    if ((bv.byteOffset ?? 0) + (bv.byteLength ?? 0) > bin.length)
      throw new Error(`SOURCE bufferView ${idx} out of bounds — refusing to touch this file`);
  }
  // An image bufferView shared by two images — or by an ACCESSOR (never seen
  // from a real exporter, but a swap would silently feed KTX2 bytes to
  // whatever reads it) — cannot be replaced. Count image owners; collect the
  // views accessors (incl. sparse) read; either disqualifies the image.
  const viewOwners = new Map<number, number>();
  for (const img of json.images ?? []) {
    if (typeof img.bufferView === "number") viewOwners.set(img.bufferView, (viewOwners.get(img.bufferView) ?? 0) + 1);
  }
  const accessorViews = new Set<number>();
  for (const a of json.accessors ?? []) {
    if (typeof a.bufferView === "number") accessorViews.add(a.bufferView);
    if (typeof a.sparse?.indices?.bufferView === "number") accessorViews.add(a.sparse.indices.bufferView);
    if (typeof a.sparse?.values?.bufferView === "number") accessorViews.add(a.sparse.values.bufferView);
  }
  const marks = classifyVrmImages(json);
  const isToktx = basename(encoder).toLowerCase().includes("toktx");
  let sharp: any = null;
  try { sharp = (await import("sharp")).default; } catch { /* aligned-PNG/JPEG-only pass below */ }
  const tmp = mkdtempSync(join(tmpdir(), "ew-ktx2vrm-"));
  const newImageBytes = new Map<number, Uint8Array>(); // image idx -> ktx2 bytes
  let etc1s = 0, uastcN = 0;
  try {
    for (const [i, img] of (json.images ?? []).entries()) {
      if (typeof img.bufferView !== "number") continue; // uri image — not ours
      const mime = img.mimeType;
      if (mime !== "image/png" && mime !== "image/jpeg") continue; // skip anything else
      const bv = json.bufferViews[img.bufferView];
      if ((bv.buffer ?? 0) !== 0) continue; // external buffer — can't rewrite
      if ((viewOwners.get(img.bufferView) ?? 0) > 1 || accessorViews.has(img.bufferView)) {
        console.error(`[optimize] ktx2-vrm: skip image ${i} — bufferView ${img.bufferView} is shared`);
        continue;
      }
      const label = img.name || `#${i}`;
      const src = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
      const m = marks.get(i);
      const srgb = !!m?.color;                 // any color reference ⇒ sRGB OETF
      const uastc = !m || m.data;              // any data reference, or unclassifiable ⇒ UASTC (safe, bigger)
      const dims = rasterDims(src, mime);
      const aligned = !!dims && dims[0] % 4 === 0 && dims[1] % 4 === 0;
      let inPath: string;
      if (aligned && (mime === "image/png" || (mime === "image/jpeg" && isToktx))) {
        inPath = join(tmp, mime === "image/png" ? `${i}.png` : `${i}.jpg`);
        await Bun.write(inPath, src);
      } else if (sharp) {
        // best-effort, exactly the GLB arm's posture: a sharp failure skips
        // the TEXTURE, never the file
        try {
          let s = sharp(Buffer.from(src));
          const meta = await s.metadata();
          const w = meta.width ?? 0, h = meta.height ?? 0;
          if (w && h && (w % 4 || h % 4))
            s = s.resize(Math.ceil(w / 4) * 4, Math.ceil(h / 4) * 4, { fit: "fill" });
          inPath = join(tmp, `${i}.png`);
          await Bun.write(inPath, await s.png().toBuffer());
        } catch (e) {
          console.error(`[optimize] ktx2-vrm: skip ${label} — sharp convert failed (${(e as Error).message})`);
          continue;
        }
      } else {
        console.error(`[optimize] ktx2-vrm: skip ${label} (${mime}${aligned ? "" : ", not 4-aligned"}) — sharp unavailable`);
        continue;
      }
      const outPath = join(tmp, `${i}.ktx2`);
      const proc = Bun.spawn(ktx2EncodeArgs(encoder, isToktx, srgb, uastc, inPath, outPath), { stdout: "ignore", stderr: "pipe" });
      const code = await proc.exited;
      const err = (await new Response(proc.stderr).text()).trim();
      if (code !== 0 || !existsSync(outPath)) {
        console.error(`[optimize] ktx2-vrm: encode failed on ${label} (${err.split("\n")[0] || `exit ${code}`}) — image kept as-is`);
        continue;
      }
      newImageBytes.set(i, new Uint8Array(await Bun.file(outPath).arrayBuffer()));
      if (uastc) uastcN++; else etc1s++;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (newImageBytes.size === 0) return { out: bytes, converted: 0, etc1s: 0, uastc: 0 };

  // ---- rebuild: image bytes swapped IN PLACE, zero reindexing ----
  // (a pristine second parse of the source JSON — `json` is about to mutate,
  // and the validator needs the untouched original to diff against)
  const srcJson = parseGlb(bytes).json;
  const replaced = new Map<number, Uint8Array>(); // bufferView idx -> new bytes
  for (const [i, data] of newImageBytes) replaced.set(json.images[i].bufferView, data);
  let cursor = 0;
  const placements: { idx: number; data: Uint8Array; off: number }[] = [];
  for (const [idx, bv] of (json.bufferViews ?? []).entries()) {
    if ((bv.buffer ?? 0) !== 0) continue; // external buffer views keep their JSON verbatim
    const data = replaced.get(idx) ?? bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + (bv.byteLength ?? 0));
    cursor = align4(cursor); // 4-byte alignment satisfies every accessor componentType stride
    placements.push({ idx, data, off: cursor });
    cursor += data.length;
  }
  const newBin = new Uint8Array(cursor); // inter-view padding zero-filled by construction
  for (const p of placements) {
    newBin.set(p.data, p.off);
    const bv = json.bufferViews[p.idx];
    bv.byteOffset = p.off;
    bv.byteLength = p.data.length;
  }
  if (json.buffers?.[0]) json.buffers[0].byteLength = newBin.length; // unpadded, matching the input convention

  // ---- JSON patch, minimal ----
  for (const [i] of newImageBytes) json.images[i].mimeType = "image/ktx2";
  for (const t of json.textures ?? []) {
    if (typeof t.source === "number" && newImageBytes.has(t.source)) {
      // No raster fallback exists any more, so the spec's top-level `source`
      // fallback would dangle — remove it and require the extension, matching
      // the GLB arm's negotiated-serving contract (variants serve ONLY to
      // clients that asked with ?ktx2=1).
      (t.extensions ??= {}).KHR_texture_basisu = { source: t.source };
      delete t.source;
    }
  }
  for (const listName of ["extensionsUsed", "extensionsRequired"]) {
    const list: string[] = (json[listName] ??= []);
    if (!list.includes("KHR_texture_basisu")) list.push("KHR_texture_basisu");
  }

  // ---- assemble ----
  const jsonText = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = align4(jsonText.length);
  const binPad = align4(newBin.length);
  const total = 12 + 8 + jsonPad + 8 + binPad;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonPad, true);
  dv.setUint32(16, CHUNK_JSON, true);
  out.set(jsonText, 20);
  out.fill(0x20, 20 + jsonText.length, 20 + jsonPad); // JSON pads with spaces per spec
  const bo = 20 + jsonPad;
  dv.setUint32(bo, binPad, true);
  dv.setUint32(bo + 4, CHUNK_BIN, true);
  out.set(newBin, bo + 8); // BIN pads with the buffer's own zeros

  validateVrmRewrite(srcJson, bin, out, new Set(newImageBytes.keys()));
  return { out, converted: newImageBytes.size, etc1s, uastc: uastcN };
}

// ---- KTX2 for loose library images (§20d) -----------------------------------
// Vegetation, sky, and particle textures reach the client as RAW image bytes
// through the Deno-shim file layer (assets.js primeFiles → readFileSync →
// loadImageTexture): ~92.5MB of decoded RGBA uploads for the meadow, a 34MB
// single-frame upload for the 4K starmap alone. The .ktx2 sibling pays that in
// GPU currency — but TWO contracts must be baked at ENCODE time, because
// three's KTX2Loader ignores KTX orientation metadata and the client takes the
// container's word over the call site's:
//   1. THE FLIP. The engine's loadImageTexture contract bakes the vertical
//      flip into the PIXELS (browser flipY convention; tex.flipY stays false
//      so it composes with repeat tiling — UV-authored trim sheets arrive
//      mirrored without it). Every curated-dir call site takes the default
//      flip, so every encode here flips rows before the encoder ever runs.
//      Decoding is pngjs/jpeg-js — pure JS, deterministic on every platform.
//      sharp is deliberately NOT used in this mode: it is broken on the win32
//      dev box (the recorded two-libvips clash), and a flip that silently
//      failed to happen is a vertically mirrored meadow.
//   2. THE TRANSFER. The DFD's OETF must match what the call site's opts.srgb
//      would have set on the raster texture — the client reads colorSpace
//      from the DFD (KTX2Loader parseColorSpace) and must not override it, so
//      a mismatch is a visible lighting error. Classification is by FILENAME,
//      verified against the actual consumers: vegetation.js loadMap,
//      sky_worlds.js readTex, and the client's own emitters.js spriteTexture.

const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;

/** Filename → codec/transfer, or a refusal. Every rule cites the call site it
 *  matches (all in ../eidoverse-video unless noted). Order matters: the
 *  particle dir is classified as a DIR (its consumer ignores filenames), data
 *  keywords beat color keywords (asteroid_moon_normal contains "moon"). */
export function classifyLooseImage(srcPath: string): { srgb: boolean; uastc: boolean } | { conflict: string } {
  const p = srcPath.replace(/\\/g, "/").toLowerCase();
  const name = basename(p);
  if (p.includes("/particle_textures/")) {
    // trace_06.png is consumed BOTH ways: sky_worlds.js loads it linear as
    // the storm bolt (readTex(..., false)) while emitters.js loads every
    // authored sprite { srgb: true }. One DFD cannot serve both callers —
    // no variant; both keep today's raster bytes.
    if (name === "trace_06.png") return { conflict: "loaded linear by sky_worlds (bolt) AND srgb by emitters" };
    // Every other sprite has ONE loader: emitters.js spriteTexture,
    // { srgb: true }. UASTC, not ETC1S: smooth radial alpha gradients are
    // ETC1S's worst case, and the whole dir is 4.7MB — quality over bytes.
    return { srgb: true, uastc: true };
  }
  // Data maps — sampled as per-channel scalars/vectors, loaded WITHOUT srgb
  // (vegetation.js loadMap normal/roughness; sky_worlds.js band + solar set:
  // NormalGL/Roughness/Metalness/ao/height/landmask): linear + UASTC (ETC1S
  // block color noise reads as data corruption there — §20 doctrine).
  if (/(normal|rough|metal|_ao\b|height|mask|bump|occlusion|displace)/.test(name)) return { srgb: false, uastc: true };
  // Color maps — loaded { srgb: true }: vegetation albedo/translucency
  // (loadMap srgb:true), everything the sky reads as color (readTex(.., true):
  // starmap/moon/rock_giant/rain_streak/solar Color; asteroid_moon_baked is
  // the shattered moon's albedo atlas). ETC1S q128: eye-facing sRGB, 4-8×
  // smaller, block noise hides in shading.
  if (/(albedo|translucen|_color|basecolor|diffuse|emissi|_baked|starmap|kloppenheim|puresky|moon|rock_giant|rain_streak)/.test(name)) return { srgb: true, uastc: false };
  // Unmatched ⇒ UASTC + linear (safe for data, merely bigger). A COLOR file
  // landing here would render with darkened mids — extend the color list when
  // a new name shows up rather than letting it fall through.
  return { srgb: false, uastc: true };
}

/** The --ktx2-img arm: decode (pure JS) → flip rows → temp PNG → toktx.
 *  Refusals (`skip`) are content judgements — exit 2, serve the original:
 *  non-POT/non-4-aligned dims (a compressed mip ladder breaks mid-chain on
 *  upload), or a file whose consumers disagree about the transfer. */
export async function transcodeImageKtx2(src: Uint8Array, srcPath: string, encoder: string):
  Promise<{ out: Uint8Array; srgb: boolean; uastc: boolean } | { skip: string }> {
  const cls = classifyLooseImage(srcPath);
  if ("conflict" in cls) return { skip: `conflicted consumers — ${cls.conflict}` };
  const ext = srcPath.toLowerCase().match(/\.(png|jpe?g)$/)?.[1];
  if (!ext) return { skip: `not a png/jpeg (${basename(srcPath)})` };
  // pngjs/jpeg-js: the ONE deliberate dep addition of §20d (pure JS — the
  // flip must gate locally and sharp cannot be trusted on this box). Lazy
  // imports so every other optimize mode keeps working before `bun install`
  // catches up (a resolve failure here reads as env-skip in the pump).
  let w: number, h: number, data: Uint8Array;
  if (ext === "png") {
    const { PNG } = (await import("pngjs")) as any;
    const img = PNG.sync.read(Buffer.from(src)); // normalized to 8-bit RGBA
    w = img.width; h = img.height; data = img.data;
  } else {
    const jpeg = (await import("jpeg-js")) as any;
    const img = (jpeg.decode ?? jpeg.default.decode)(src, { useTArray: true }); // RGBA out
    w = img.width; h = img.height; data = img.data;
  }
  if (!(isPow2(w) && isPow2(h) && w % 4 === 0 && h % 4 === 0))
    return { skip: `${w}x${h} is not POT/4-aligned — compressed mip chain would break mid-ladder` };
  // THE FLIP — bake the engine contract into the pixels (see section header)
  const row = w * 4;
  const flipped = Buffer.allocUnsafe(row * h);
  for (let y = 0; y < h; y++) flipped.set(data.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  const { PNG } = (await import("pngjs")) as any;
  const png = new PNG({ width: w, height: h });
  png.data = flipped;
  // deflateLevel 1: this PNG exists for milliseconds, purely to feed toktx —
  // and pngjs writes no gAMA/sRGB chunk, so --assign_oetf stays authoritative
  const pngBytes = PNG.sync.write(png, { deflateLevel: 1 });
  const tmp = mkdtempSync(join(tmpdir(), "ew-ktx2img-"));
  try {
    const inPath = join(tmp, "in.png");
    await Bun.write(inPath, pngBytes);
    const outPath = join(tmp, "out.ktx2");
    const isToktx = basename(encoder).toLowerCase().includes("toktx");
    const proc = Bun.spawn(ktx2EncodeArgs(encoder, isToktx, cls.srgb, cls.uastc, inPath, outPath), { stdout: "ignore", stderr: "pipe" });
    const code = await proc.exited;
    const err = (await new Response(proc.stderr).text()).trim();
    if (code !== 0 || !existsSync(outPath))
      throw new Error(`ktx2-img: encode failed (${err.split("\n")[0] || `exit ${code}`})`);
    return { out: new Uint8Array(await Bun.file(outPath).arrayBuffer()), srgb: cls.srgb, uastc: cls.uastc };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ---- CLI: bun run server/optimize.ts [--ktx2|--ktx2-vrm|--ktx2-img] <in> <out>
// Exit 0 = wrote out. Exit 2 = optimization made it BIGGER — or, for
// --ktx2-vrm, there was nothing to convert (no raster images); or, for
// --ktx2-img, the image is not suitable (non-POT/4-misaligned dims,
// conflicted consumers) — nothing written, serve the original. Exit 1 =
// failure, reason on stderr.
// Exit 3 (any --ktx2* mode) = no KTX2 encoder on this box — environmental,
// the caller must env-skip (never a .failed marker).

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const mode = argv.includes("--ktx2-img") ? "--ktx2-img"
    : argv.includes("--ktx2-vrm") ? "--ktx2-vrm"
    : argv.includes("--ktx2") ? "--ktx2" : null;
  const ktx2Mode = mode !== null;
  const [inPath, outPath] = argv.filter((a) => !a.startsWith("--"));
  if (!inPath || !outPath) {
    console.error("usage: bun run server/optimize.ts [--ktx2|--ktx2-vrm|--ktx2-img] <in> <out>");
    process.exit(1);
  }
  let encoder: string | null = null;
  if (ktx2Mode && !(encoder = findKtx2Encoder())) {
    console.error("[optimize] ktx2: no encoder — set KTX2_TOKTX or put toktx/ktx on PATH (docs/ktx2-encoder.md)");
    process.exit(3);
  }
  try {
    const src = new Uint8Array(await Bun.file(inPath).arrayBuffer());
    const t0 = performance.now();
    let out: Uint8Array;
    if (mode === "--ktx2-img") {
      const r = await transcodeImageKtx2(src, inPath, encoder!);
      if ("skip" in r) {
        console.error(`[optimize] ktx2-img: ${r.skip} — keeping original`);
        process.exit(2);
      }
      console.log(`[optimize] ktx2-img: ${basename(inPath)} → ${r.uastc ? "uastc" : "etc1s"}/${r.srgb ? "srgb" : "linear"}, flip baked`);
      out = r.out;
    } else if (mode === "--ktx2-vrm") {
      const r = await transcodeVrmKtx2(src, encoder!);
      if (r.converted === 0) {
        console.error(`[optimize] ktx2-vrm: no convertible raster images (${Math.round(performance.now() - t0)}ms) — keeping original`);
        process.exit(2);
      }
      console.log(`[optimize] ktx2-vrm: ${r.converted} image(s) → ${r.etc1s} etc1s + ${r.uastc} uastc`);
      out = r.out;
    } else {
      out = mode === "--ktx2" ? await optimizeGlbKtx2(src, encoder!) : await optimizeGlb(src);
    }
    const ms = Math.round(performance.now() - t0);
    // An already-lean upload (someone re-uploading our own optimized output,
    // a tiny primitive) gains nothing — don't shadow it with a same-size copy.
    // The --ktx2 gate is deliberately generous: KTX2 variants exist for
    // decode/upload wins (no createImageBitmap, GPU-native mips, 4-8× less
    // VRAM), not just wire bytes — accept anything not grossly bigger than
    // the ORIGINAL source (>1.25×).
    if (out.length >= src.length * (ktx2Mode ? 1.25 : 0.95)) {
      console.error(`[optimize] not smaller (${src.length} -> ${out.length}, ${ms}ms) — keeping original`);
      process.exit(2);
    }
    // …and the same care about CONTENT: a GLB whose images are not images is
    // worse than no variant, because it serves confidently (#122). --ktx2-img
    // emits a bare KTX2 file rather than a container, so it has nothing to walk.
    if (mode !== "--ktx2-img") {
      const lies = findImageLies(out);
      if (lies.length) {
        for (const l of lies) {
          console.error(`[optimize] image[${l.index}]${l.name ? ` "${l.name}"` : ""} declares ${l.declared} `
            + `but the bytes are ${l.actual} — head: ${l.head}`);
        }
        console.error(`[optimize] REFUSED ${basename(inPath)}: ${lies.length} image(s) failed the container `
          + `check — keeping the original. The SOURCE is fine; this is the pass corrupting its own output `
          + `(see the two-libvips note at ktx2CompressTextures), so it is worth retrying, not marking failed.`);
        process.exit(4);
      }
    }
    // tmp+rename: a killed pass must never leave a truncated GLB where the
    // server will trustingly serve it
    await Bun.write(`${outPath}.tmp`, out);
    const { renameSync } = await import("node:fs");
    renameSync(`${outPath}.tmp`, outPath);
    console.log(`[optimize] ${src.length} -> ${out.length} bytes (${(src.length / out.length).toFixed(1)}x, ${ms}ms)`);
    process.exit(0);
  } catch (e) {
    console.error(`[optimize] ${(e as Error).stack ?? e}`);
    process.exit(1);
  }
}
