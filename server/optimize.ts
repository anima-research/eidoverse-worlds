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

import { NodeIO, Primitive, getBounds, type Document, type Mesh, type Texture } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRTextureBasisu } from "@gltf-transform/extensions";
import { dedup, prune, resample, textureCompress, draco, listTextureSlots, weld, compactPrimitive, convertPrimitiveToTriangles, getPrimitiveVertexCount } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import draco3d from "draco3dgltf";
import { capTexels, recipeStamp, verdictLine, LOD_RECIPE, KTX2_RECIPE, LOD_MIN_VERTS, LOD_RATIO, LOD_PX, LOD_PPD, LOD_TEXELS_PER_PX, LOD_TEX_ONLY, KTX2_TEXEL_CAP, type LodVerdictKind, type VerdictKind } from "./store-variants.ts";
import { findKtx2Encoder, resolveNestedSharp, toolsStamp } from "./tools-stamp.ts";
export { findKtx2Encoder, resolveNestedSharp };
import { glbPerf } from "./glbperf.ts";
import { lodNearest } from "../shared/lod-distance.js";
import { parseGlb, rasterDims, GLB_MAGIC, CHUNK_JSON, CHUNK_BIN, KTX2_ID, align4, type GlbParts } from "./glbparse.ts";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";

// ---- ONE libvips per process (#122) -----------------------------------------
// The store's root manifest declares `sharp: ^0.33.5`; @gltf-transform/
// functions reaches sharp through ndarray-pixels, which declares `^0.35.0`.
// The ranges do not intersect, so no installer can dedupe them and BOTH land
// on disk — node_modules/sharp (0.33.5) beside
// node_modules/ndarray-pixels/node_modules/sharp (0.35.3). Importing plain
// "sharp" here therefore loads a SECOND native libvips into a process that
// already has one, and the two disagree about libvips' own enums:
//
//   GLib-GObject-CRITICAL: value "32" of type 'gint' is invalid or out of
//   range for property 'space' of type 'VipsInterpretation'
//   Error: colourspace: parameter space not set   (sharp/lib/output.js)
//
// On win32 that THROWS, which is the merciful outcome — the pass dies and the
// original is kept. On the show box's libvips it does not throw: encoding
// returns a buffer of uninitialized memory (a repeated LE uint32, then
// zeros), gltf-transform stamps it `image/webp`, and the store serves an
// image that is not an image. That is #122 — the threshold-lantern's
// baseColor and normal (both JPEG-sourced, so both routed through the
// converting path) came out undecodable, the material fell back to
// baseColorFactor 1,1,1,1, and the lantern rendered white.
//
// So: never import "sharp" by bare specifier in this file. Resolve the copy
// @gltf-transform/functions itself will use, and hand that same module back
// to it as the encoder — one libvips, end to end.
//
// RESOLUTION and IMPORT are kept separate, and the bare specifier is reached
// on exactly one condition: no nested copy could be RESOLVED. That means a
// deduped (or single-copy) install, where the bare import is the same single
// copy and is therefore safe.
//
// A nested copy that resolves but fails to IMPORT — ABI mismatch, missing
// dylib, damaged install — must NOT fall back (#136 review). Doing so loads
// the root copy beside the one gltf-transform already has and recreates the
// exact two-libvips condition this module exists to forbid, in the one
// situation where things are already going wrong. It fails closed instead:
// the rejection propagates, both callers skip the texture pass, and a
// draco-only result ships. Less compression is a cost; an image that is not
// an image is a lie.
// resolveNestedSharp — where gltf-transform's own sharp lives (RESOLUTION ONLY) — is in tools-stamp.ts, which names
// that same copy in the verdict stamp; re-exported above.

/** The choice itself, with its two effects injected so a test can drive the
 *  branch that matters (#136 review). Fails CLOSED: once a nested copy has
 *  been resolved, an import failure PROPAGATES. It must not fall back to the
 *  bare specifier — that would load the root copy beside the one
 *  gltf-transform already has and recreate the exact two-libvips condition
 *  this module forbids, in the one situation (ABI mismatch, missing dylib,
 *  damaged install) where things are already going wrong. Both callers
 *  already know how to degrade on rejection by skipping the texture pass,
 *  which is the correct outcome: a draco-only pass ships nothing false. */
export async function pickSharp(
  resolveNested: () => string | null,
  load: (specifier: string) => Promise<any>,
): Promise<{ sharp: any; from: string }> {
  const nested = resolveNested();
  if (nested !== null) {
    const mod = await load(nested);          // no catch: fail closed
    return { sharp: mod.default ?? mod, from: nested };
  }
  // No nested copy exists, so the bare specifier IS the single copy.
  const mod = await load("sharp");
  return { sharp: mod.default ?? mod, from: "sharp (bare specifier)" };
}

let sharpP: Promise<{ sharp: any; from: string }> | null = null;
/** Exported for tools/one-libvips-test.ts, which asserts `from` lands on the
 *  nested copy whenever one exists — the whole fix in one readable value. */
export function getSharp(): Promise<{ sharp: any; from: string }> {
  sharpP ??= pickSharp(resolveNestedSharp, (s) => import(s));
  return sharpP;
}

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
    // prune with keepAttributes: by default prune also drops a primitive's
    // vertex attributes its MATERIAL doesn't read — TEXCOORD_0 on anything
    // with an untextured material. A named blank part is exactly the picture
    // contract (shared/picture.js: the comp textures the part later), and the
    // frame prop's `picture` quad came back from this pass with no UVs, so a
    // hung picture sampled one texel and painted a flat colour. Attributes
    // are the author's; the shadow only re-encodes what it was given.
    prune({ keepAttributes: true }),      // unreferenced leftovers dropped
    resample(),   // animation keyframes deduplicated (lossless within tolerance)
  ];

  // Texture recompression needs sharp (native). If it can't load on this box,
  // a draco-only pass is still most of the win — degrade, don't die.
  try {
    // getSharp, never a bare import: this encoder must be the SAME module
    // gltf-transform decodes with, or the two libvips corrupt each other's
    // output and we ship it (#122).
    const { sharp } = await getSharp();
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

// findKtx2Encoder lives in tools-stamp.ts (the verdict stamp names the encoder it finds) — re-exported above

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
 *  can't be generated at runtime. `resize` (the GLB arm's texel budget,
 *  store-variants.ts capTexels) rides toktx's own --resize — the encoder
 *  scales before it generates mips, and libvips is nowhere in the loop. */
export function ktx2EncodeArgs(encoder: string, isToktx: boolean, srgb: boolean, uastc: boolean, inPath: string, outPath: string,
  resize: [number, number] | null = null): string[] {
  return isToktx
    ? [encoder, "--t2", "--genmipmap", "--assign_oetf", srgb ? "srgb" : "linear",
       ...(resize ? ["--resize", `${resize[0]}x${resize[1]}`] : []),
       ...(uastc ? ["--encode", "uastc", "--uastc_quality", "2", "--uastc_rdo_l", "1.0", "--zcmp", "18"]
                 : ["--encode", "etc1s", "--qlevel", "128"]),
       outPath, inPath]
    // --assign-tf, never a conversion: ktx create reads an 8-bit PNG with no colour chunk as sRGB and, given a UNORM
    // format, CONVERTS it — every normal/metallic-roughness/occlusion map got the sRGB→linear curve baked in (a flat
    // normal 127 came out 54; measured 09-24 on the rubble pile: normals bent, surfaces darker, highlights gone).
    // toktx's --assign_oetf above has always meant assign.
    : [encoder, "create", "--format", srgb ? "R8G8B8A8_SRGB" : "R8G8B8A8_UNORM", "--assign-tf", srgb ? "srgb" : "linear",
       "--generate-mipmap",
       ...(uastc ? ["--encode", "uastc", "--uastc-quality", "2", "--uastc-rdo", "--uastc-rdo-l", "1.0", "--zstd", "18"]
                 : ["--encode", "basis-lz", "--qlevel", "128"]),
       inPath, outPath];
}

/** Per-texture KTX2 encode, in place on the Document. Supports both
 *  KTX-Software CLIs — toktx (v4.4.2, the primary target) and the newer
 *  unified `ktx create` — detected by basename. A texture that will not
 *  convert is skipped and NAMED in the tally; the caller decides whether a
 *  partial result is a file at all (the GLB arm refuses one — a .ktx2.glb
 *  with png inside is #122's class of lie, served immutable). Every encoder
 *  output is checked for the KTX2 container magic before it is accepted. */
/** Stamped on every image this encoder writes since the transfer fix (ktx2EncodeArgs --assign-tf). A ktx-create
 *  KTX2 image without it, written LINEAR, had the sRGB→linear curve baked in — tools/ktx2-tf-purge.ts finds those.
 *  The image's own KTX metadata can't tell them apart (same writer, same params). */
export const KTX2_TF_MARK = "ktx2Tf";
export type Ktx2Tally = { eligible: number; converted: number; failed: string[] };
const KTX2_MAGIC = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
export const isKtx2Container = (b: Uint8Array) => b.length >= 12 && KTX2_MAGIC.every((v, i) => b[i] === v);
async function ktx2CompressTextures(doc: Document, encoder: string, caps?: Map<Texture, number>): Promise<Ktx2Tally> {
  const isToktx = basename(encoder).toLowerCase().includes("toktx");
  // sharp converts non-PNG sources (webp/jpeg) and 4-aligns dimensions —
  // KHR_texture_basisu (and WebGPU BC upload) wants width/height % 4 == 0.
  // sharp is optional today: without it, only already-aligned PNGs encode.
  let sharp: any = null;
  // KTX2_NO_SHARP=1 behaves as a host without sharp (tools/ktx2-resize-test.ts drives it)
  try { sharp = process.env.KTX2_NO_SHARP === "1" ? null : (await getSharp()).sharp; } catch { /* PNG-only pass below */ }
  const tmp = mkdtempSync(join(tmpdir(), "ew-ktx2-"));
  let converted = 0, eligible = 0;
  const failed: string[] = [];
  try {
    const textures = doc.getRoot().listTextures();
    for (let i = 0; i < textures.length; i++) {
      const tex = textures[i];
      const image = tex.getImage();
      if (!image) continue;
      eligible++;
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
      //
      // The house texel budget: the shadow's 1024², never more (store-variants.ts). toktx resizes itself (--resize);
      // `ktx create` has no such flag, so on that encoder sharp (already the converter here) does it first. Until
      // 2026-09-24 the ktx-create arm logged "encoding at source size" and shipped 2048² under a recipe named
      // texel1024: every KTX2 built on a ktx-create host kept its full-size textures.
      const resize = capTexels(size as [number, number] | null, caps?.get(tex) ?? KTX2_TEXEL_CAP);   // caps: a LOD's density budget (lodTexelCaps)
      const sharpResize = !!resize && !isToktx && !!sharp;
      // no sharp on a `ktx create` host: this texture can't be brought under the cap, so it isn't encoded at all (kept
      // as-is), rather than shipped at source size inside a variant whose recipe says texel1024 (Greptile #207)
      if (resize && !isToktx && !sharp) {
        console.error(`[optimize] ktx2: skip ${label} (${size![0]}x${size![1]}) — over the texel cap, and no sharp to resize it (ktx create has no --resize)`);
        failed.push(label); continue;
      }
      let inPath: string;
      if (!sharpResize && aligned && (mime === "image/png" || (mime === "image/jpeg" && isToktx))) {
        inPath = join(tmp, mime === "image/png" ? `${i}.png` : `${i}.jpg`);
        await Bun.write(inPath, image);
      } else if (sharp) {
        try {
          let s = sharp(Buffer.from(image));
          const meta = await s.metadata();
          const w = meta.width ?? 0, h = meta.height ?? 0;
          if (sharpResize) s = s.resize(resize![0], resize![1], { fit: "fill" });   // capTexels keeps aspect, 4-aligned
          else if (w && h && (w % 4 || h % 4))
            s = s.resize(Math.ceil(w / 4) * 4, Math.ceil(h / 4) * 4, { fit: "fill" });
          inPath = join(tmp, `${i}.png`);
          await Bun.write(inPath, await s.png().toBuffer());
        } catch (e) {
          console.error(`[optimize] ktx2: skip ${label} — sharp convert failed (${(e as Error).message})`);
          failed.push(label); continue;
        }
      } else {
        console.error(`[optimize] ktx2: skip ${label} (${mime}${aligned ? "" : ", not 4-aligned"}) — sharp unavailable`);
        failed.push(label); continue;
      }
      const outPath = join(tmp, `${i}.ktx2`);
      const args = ktx2EncodeArgs(encoder, isToktx, srgb, uastc, inPath, outPath, isToktx ? resize : null);
      const proc = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
      const code = await proc.exited;
      const err = (await new Response(proc.stderr).text()).trim();
      if (code !== 0 || !existsSync(outPath)) {
        console.error(`[optimize] ktx2: encode failed on ${label} (${err.split("\n")[0] || `exit ${code}`}) — texture kept as-is`);
        failed.push(label); continue;
      }
      const encoded = new Uint8Array(await Bun.file(outPath).arrayBuffer());
      // an image must be what it says it is (#122/#124): the encoder exited 0,
      // now the bytes have to carry the container they will be labelled with
      if (!isKtx2Container(encoded)) {
        console.error(`[optimize] ktx2: ${label} — encoder wrote ${encoded.length} bytes that are not a KTX2 container — texture kept as-is`);
        failed.push(label); continue;
      }
      tex.setImage(encoded).setMimeType("image/ktx2").setExtras({ ...tex.getExtras(), [KTX2_TF_MARK]: "assigned" });
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
  return { eligible, converted, failed };
}

/** The --ktx2 diet: dedup + prune + resample (the store recipe minus webp —
 *  KTX2 encodes from the best source) + per-texture KTX2 + draco. ALL or
 *  nothing: `out` is null unless every eligible texture converted. A variant
 *  with some — or no — KTX2 in it is a .ktx2.glb whose name lies about its
 *  contents, and it would be served immutable to every capable client (the
 *  #122 class). The tally says which it was: nothing eligible is exit 2's
 *  business, anything unconverted is exit 5's (see the CLI). */
export async function optimizeGlbKtx2(bytes: Uint8Array, encoder: string): Promise<{ out: Uint8Array | null } & Ktx2Tally> {
  const io = await getIO();
  const doc = await io.readBinary(bytes);
  await doc.transform(dedup(), prune({ keepAttributes: true }), resample());   // keepAttributes: see optimizeGlb
  const tally = await ktx2CompressTextures(doc, encoder);
  if (tally.eligible === 0 || tally.converted < tally.eligible) return { out: null, ...tally };
  await doc.transform(draco());
  return { out: await io.writeBinary(doc), ...tally };
}

// ---- geometry LOD (objects only, fail closed on bodies) ---------------------
// The v1 contract (PR #142 thread): a decimated variant for PLACEABLE
// OBJECTS. Bodies are excluded by POSITIVE STRUCTURAL DETECTION on the raw
// container — before any Document is constructed — and the answer is a typed
// verdict, never a silent attempt. For accepted objects the reduce must
// PROVE it preserved what the world depends on: named nodes (parts, socket
// frames), materials, bounds (seat pans, collider fits) — or refuse.

/** Why this GLB is not an object the reducer may touch — or null. Reads the
 *  raw JSON chunk: gltf-transform must not be the thing deciding whether a
 *  body is a body (it drops extensions it does not know). */
export function lodExclusion(json: any): string | null {
  if (json?.skins?.length) return "unsupported: skinned/avatar asset (skins)";
  // fail-closed means NOT trusting well-formedness (review of #156, point 5):
  // a VRM that forgot extensionsUsed still carries the extension OBJECT, and
  // multi-set skinning may skip set 0 — look everywhere the structure can be
  const extNames = [...(json?.extensionsUsed ?? []), ...(json?.extensionsRequired ?? []),
    ...Object.keys(json?.extensions ?? {})];
  if (extNames.some((e) => /^VRM/i.test(e) || /^VRMC_/i.test(e))) return "unsupported: skinned/avatar asset (VRM metadata)";
  for (const m of json?.meshes ?? []) for (const p of m.primitives ?? []) {
    if (p.targets?.length) return "unsupported: morph targets the reducer cannot prove preserved";
    for (const k of Object.keys(p.attributes ?? {}))
      if (/^(JOINTS|WEIGHTS)_\d+$/.test(k)) return "unsupported: skinned/avatar asset (joint weights)";
  }
  // v1 reduces STATIC geometry only. An animated object could survive the
  // reduce structurally, but "could" is not the contract — preservation of
  // channels/samplers through the diet is unproven here, and fail-closed is
  // the reviewer-offered v1 answer. A later recipe can earn animation back
  // with end-to-end evidence.
  if (json?.animations?.length) return "unsupported: animated object (v1 reduces static geometry only)";
  return null;
}

const totalVerts = (doc: Document) => {
  let n = 0;
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) n += p.getAttribute("POSITION")?.getCount() ?? 0;
  return n;
};
// WORLD space (node transforms applied), like the budget it is compared against. Until gen 3 this unioned raw POSITION
// min/max across meshes with their node transforms ignored: a model of 24 translated parts (store 51e8…) read a 15 cm
// "shift" that was 0.0 in the world and was refused for it — and the same frame-blind box could miss a real one. A
// model authored in centimetres under a 0.01 node would also have mixed units against a metre budget.
const sceneBounds = (doc: Document): [number[], number[]] => {
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  if (!scene) return [[0, 0, 0], [0, 0, 0]];
  const { min, max } = getBounds(scene);
  return [[...min], [...max]];
};

/** The GPU gate's refusal line — the marker the pump writes (the CLI's last `[optimize]` line). Stamped like every
 *  other lod refusal, and a NON-final kind (store-variants.ts lodVerdictKind "gpu"): it depends on the encoder and on
 *  whether the texel cap could be honoured on this host, neither of which the URL pins — so the route answers it
 *  provisional, and a LOD_GEN bump is what re-asks it. */
export const lodGpuRefusal = (origTexMB: number, lodTexMB: number, ms: number): string =>
  `[optimize] lod: not lighter on the GPU (textures ${origTexMB} -> ${lodTexMB} MB, ${ms}ms) ${recipeStamp(LOD_RECIPE)} ${toolsStamp()} — original stays the only representation`;

// `kind`: the typed class of a refusal, named HERE where the phrase is minted (store-variants.ts readVerdict) — the marker
// records it, and no reader has to re-derive it from the text
export type LodResult = { out: Uint8Array | null; verdict: string | null; kind?: LodVerdictKind; before: number; after: number; permissive?: boolean;
  /** served for its textures alone (LOD_TEX_ONLY): the vertices stayed over 0.6× */ texOnly?: boolean; /** LOD / full-tier texel area */ texRatio?: number };

// ATTRIBUTE-AWARE SIMPLIFICATION. gltf-transform's simplify() hands meshoptimizer POSITIONS ONLY (4.4.2 and 4.5.1), so
// every collapse was judged on shape alone: across hard-edge normals (a hovercar's wheel arches smeared dark, its rear
// wheel gone) and across UV seams (a pallet's white blotches, a Joshua tree's foliage gone dull). meshoptimizer's README:
// use Permissive only with attribute-aware simplification; we used it without. So each primitive is simplified here
// with simplifyWithAttributes, normals, COLOR_0 and TEXCOORD_0 in the error metric. Weights were chosen by measurement
// (09-29, six library models rendered at the client's LOD switch distances, notes: lod-look-2026-09-29): normals 0.25,
// UVs 1, colour 1. Normals at 1.0 (meshoptimizer's demo, Godot) or 0.5 (gltfpack) left the desk and streetlight
// 'ineffective'. Protecting UV-seam and crease vertices (meshopt_SimplifyVertex_Protect) instead froze the seamed models
// and changed nothing on the rest, so nothing is locked: weighted UVs let the simplifier trade instead of refuse, and
// a model that can't reach the bar without tearing its UVs is refused as 'ineffective' (a pallet) rather than served
// torn. Against the served KTX2 at the switch distance: the hovercar 25% → 4% of pixels visibly different, its rear
// wheel and arches kept; the Joshua tree 49% → 29%, its foliage colour kept.
// Weld, strip/fan conversion and compaction are gltf-transform's own exported helpers, as its simplify() uses them.
// ErrorClamped (meshoptimizer 1.3): attribute error clamped to the position-error scale — without it the normal error
// used up the error budget and every pass stopped early (all six test models went 'ineffective'); the README recommends
// it for any attribute-aware use.
const LOD_NORMAL_WEIGHT = 0.25, LOD_UV_WEIGHT = 1, LOD_COLOR_WEIGHT = 1;
function readFloats(a: NonNullable<ReturnType<Primitive["getAttribute"]>>, width: number, out: Float32Array, stride: number, at: number) {
  const el = new Array(a.getElementSize()).fill(0);
  for (let i = 0, n = a.getCount(); i < n; i++) { a.getElement(i, el); for (let k = 0; k < width; k++) out[i * stride + at + k] = el[k] ?? 0; }
}
function simplifyAttributes({ ratio, errWorld, permissive }: { ratio: number; errWorld: number; permissive: boolean }) {
  return async (doc: Document) => {
    await MeshoptSimplifier.ready;
    await doc.transform(weld());
    for (const mesh of doc.getRoot().listMeshes()) {
      // the budget is WORLD metres; a mesh's positions are in its own frame, so divide by the largest scale any node
      // draws it at (the strictest instance wins). A mesh no node draws is never seen: left as it is.
      const s = meshWorldScale(mesh);
      if (!(s > 0)) continue;
      const localErr = errWorld / s;
      for (const prim of mesh.listPrimitives()) {
        const mode = prim.getMode();
        if (mode === Primitive.Mode.TRIANGLE_STRIP || mode === Primitive.Mode.TRIANGLE_FAN) convertPrimitiveToTriangles(prim);
        else if (mode !== Primitive.Mode.TRIANGLES) continue;
        const pos = prim.getAttribute("POSITION"), ind = prim.getIndices();
        if (!pos || !ind) continue;
        const n = pos.getCount();
        const P = new Float32Array(n * 3); readFloats(pos, 3, P, 3, 0);
        const nor = prim.getAttribute("NORMAL"), col = prim.getAttribute("COLOR_0"), uv = prim.getAttribute("TEXCOORD_0");
        const S = 8;   // [nx ny nz r g b u v]
        const A = new Float32Array(n * S);
        if (nor) readFloats(nor, 3, A, S, 0);
        if (col) readFloats(col, 3, A, S, 3);
        if (uv) readFloats(uv, 2, A, S, 6);
        const wn = nor ? LOD_NORMAL_WEIGHT : 0, wc = col ? LOD_COLOR_WEIGHT : 0, wu = uv ? LOD_UV_WEIGHT : 0;
        const weights = [wn, wn, wn, wc, wc, wc, wu, wu];
        const src = ind.getArray()!;
        const idx = src instanceof Uint32Array ? src : new Uint32Array(src);
        const target = Math.floor((ratio * idx.length) / 3) * 3;
        const [dst] = MeshoptSimplifier.simplifyWithAttributes(idx, P, 3, A, S, weights, null, target, localErr, ["ErrorClamped", "ErrorAbsolute", ...(permissive ? ["Permissive" as const] : [])]);
        prim.setIndices(ind.clone().setArray(dst));
        if (ind.listParents().length === 1) ind.dispose();
        compactPrimitive(prim);
        if (getPrimitiveVertexCount(prim, "render") === 0) prim.dispose();
      }
      if (mesh.listPrimitives().length === 0) mesh.dispose();
    }
  };
}

/** The largest scale any node draws `mesh` at (max column length of its world matrix), or 0 when no node draws it. */
export function meshWorldScale(mesh: Mesh): number {
  let s = 0;
  for (const n of mesh.listParents()) {
    const m = (n as any).getWorldMatrix?.() as number[] | undefined;
    if (!m) continue;
    s = Math.max(s, Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10]));
  }
  return s;
}

/** A LOD's screen-space budget (store-variants.ts LOD_PX / LOD_TEXELS_PER_PX): the model's world diagonal gives the
 *  closest distance the client's 'auto' dial shows its LOD (shared/lod-distance.js — the client's own geometry; eco
 *  and device pressure halve it, and take 4 px / half a texel per pixel there), and a
 *  headset's pixel density turns pixels there into metres. */
export function lodBudget(doc: Document) {
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const b = scene ? getBounds(scene) : { min: [0, 0, 0], max: [0, 0, 0] };
  const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const nearest = lodNearest(diag);
  const pxPerMetre = (LOD_PPD * 180 / Math.PI) / nearest;
  return { diag, nearest, errWorld: LOD_PX / pxPerMetre, texelsPerMetre: LOD_TEXELS_PER_PX * pxPerMetre };
}

/** A triangle's texel density along its LEAST dense axis, in texels per metre: `f`, `g` its two world edges (3D, from
 *  the same vertex), `t1`, `t2` the matching UV edges in TEXELS. ANISOTROPY: a stretched mapping (a pipe, a trim sheet)
 *  has two densities and a uniform resize scales both, so the sparse axis binds — the smaller singular value of the
 *  world → texel map J = T·P⁻¹, P the world edges in the triangle's own 2D frame. Computed as |det J| / σmax (no
 *  cancellation). 0 for a degenerate triangle. */
export function minTexelDensity(f: number[], g: number[], t1: number[], t2: number[]): number {
  const L = Math.hypot(f[0], f[1], f[2]);
  const c = [f[1] * g[2] - f[2] * g[1], f[2] * g[0] - f[0] * g[2], f[0] * g[1] - f[1] * g[0]], A2 = Math.hypot(c[0], c[1], c[2]);
  if (!(L > 0) || !(A2 > 0)) return 0;
  const gx = (g[0] * f[0] + g[1] * f[1] + g[2] * f[2]) / L, gy = A2 / L;   // g in the frame whose x axis is f: (gx, gy)
  // P = [[L, gx], [0, gy]] → P⁻¹ = [[1/L, −gx/(L·gy)], [0, 1/gy]]
  const j00 = t1[0] / L, j10 = t1[1] / L, j01 = (t2[0] - j00 * gx) / gy, j11 = (t2[1] - j10 * gx) / gy;
  const S = j00 * j00 + j01 * j01 + j10 * j10 + j11 * j11, D = Math.abs(j00 * j11 - j01 * j10);
  const sMax = Math.sqrt((S + Math.sqrt(Math.max(0, S * S - 4 * D * D))) / 2);
  const d = sMax > 0 ? D / sMax : 0;
  return Number.isFinite(d) ? d : 0;
}

/** TEXEL DENSITY: the longest side each texture needs so that every part of the model it covers still gets
 *  `texelsPerMetre`. Per texture, over every triangle that samples it (world area from EVERY drawing node, its UVs in
 *  texels), the density along its LEAST dense axis (a stretched mapping binds on its stretched axis — the geometric
 *  mean sqrt(texels²/m²) let a 10:1 strip come out at half the target). Shrinking the map by k scales every density
 *  by k, so the part that
 *  binds is the LEAST dense: keep the area-weighted 10th percentile at the target, and the densely mapped parts (a
 *  label, a face) keep more than they need. Not the minimum: a sliver of stretched UVs would pin the whole map at full
 *  size. (Gen 3's first cut kept the 90th percentile — backwards: up to 90% of the area fell under 1 texel/px.)
 *  Rounded UP to a power of two, never above the house cap, never below 64. A texture this cannot measure keeps the house cap: sampled from a
 *  texCoord it cannot follow (KHR_texture_transform), or referenced by anything but a core material slot. */
export function lodTexelCaps(doc: Document, texelsPerMetre: number): Map<Texture, number> {
  const slotsOf = (mt: any): [Texture | null, any][] => [
    [mt.getBaseColorTexture(), mt.getBaseColorTextureInfo()], [mt.getEmissiveTexture(), mt.getEmissiveTextureInfo()],
    [mt.getNormalTexture(), mt.getNormalTextureInfo()], [mt.getOcclusionTexture(), mt.getOcclusionTextureInfo()],
    [mt.getMetallicRoughnessTexture(), mt.getMetallicRoughnessTextureInfo()]];
  const samples = new Map<Texture, { d: number; a: number }[]>();
  const unmeasurable = new Set<Texture>();
  for (const tex of doc.getRoot().listTextures()) {
    for (const p of tex.listParents()) {
      if (p.propertyType === "Root") continue;
      if (p.propertyType !== "Material" || !slotsOf(p).some(([t]) => t === tex)) unmeasurable.add(tex);
    }
  }
  const P = [0, 0, 0], Q = [0, 0, 0], R = [0, 0, 0], u = [0, 0], v = [0, 0], w = [0, 0];
  const xf = (m: number[], a: number[]) => [m[0] * a[0] + m[4] * a[1] + m[8] * a[2], m[1] * a[0] + m[5] * a[1] + m[9] * a[2], m[2] * a[0] + m[6] * a[1] + m[10] * a[2]];
  for (const mesh of doc.getRoot().listMeshes()) {
    const mats = mesh.listParents().filter((n: any) => n.propertyType === "Node").map((n: any) => n.getWorldMatrix() as number[]);
    if (!mats.length) continue;
    for (const prim of mesh.listPrimitives()) {
      const mt = prim.getMaterial(), pos = prim.getAttribute("POSITION");
      if (!mt || !pos || prim.getMode() !== Primitive.Mode.TRIANGLES) continue;
      const idx = prim.getIndices();
      const n = idx ? idx.getCount() : pos.getCount();
      for (const [tex, info] of slotsOf(mt)) {
        if (!tex || unmeasurable.has(tex)) continue;
        if (info?.getExtension?.("KHR_texture_transform")) { unmeasurable.add(tex); continue; }
        const uvA = prim.getAttribute(`TEXCOORD_${info?.getTexCoord?.() ?? 0}`);
        const size = tex.getSize();
        if (!uvA || !size) { unmeasurable.add(tex); continue; }
        const [TW, TH] = size;
        const out = samples.get(tex) ?? []; samples.set(tex, out);
        for (let i = 0; i + 2 < n; i += 3) {
          const a = idx ? idx.getScalar(i) : i, b = idx ? idx.getScalar(i + 1) : i + 1, c = idx ? idx.getScalar(i + 2) : i + 2;
          pos.getElement(a, P); pos.getElement(b, Q); pos.getElement(c, R);
          uvA.getElement(a, u); uvA.getElement(b, v); uvA.getElement(c, w);
          // the triangle's edges in TEXELS (u × width, v × height: a 2048×512 map is not square)
          const t1 = [(v[0] - u[0]) * TW, (v[1] - u[1]) * TH], t2 = [(w[0] - u[0]) * TW, (w[1] - u[1]) * TH];
          if (!(Math.abs(t1[0] * t2[1] - t2[0] * t1[1]) > 0)) continue;
          const e1 = [Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]], e2 = [R[0] - P[0], R[1] - P[1], R[2] - P[2]];
          for (const m of mats) {
            const f = xf(m, e1), g = xf(m, e2);
            const area = Math.hypot(f[1] * g[2] - f[2] * g[1], f[2] * g[0] - f[0] * g[2], f[0] * g[1] - f[1] * g[0]) / 2;
            if (!(area > 0)) continue;
            const dMin = minTexelDensity(f, g, t1, t2);
            if (dMin > 0) out.push({ d: dMin, a: area });
          }
        }
      }
    }
  }
  const caps = new Map<Texture, number>();
  for (const [tex, s] of samples) {
    if (unmeasurable.has(tex) || !s.length) continue;
    s.sort((x, y) => x.d - y.d);
    const total = s.reduce((t, x) => t + x.a, 0);
    let acc = 0, d10 = s[s.length - 1].d;
    for (const x of s) { acc += x.a; if (acc >= 0.1 * total) { d10 = x.d; break; } }
    const [W, H] = tex.getSize()!;
    const need = Math.max(W, H) * Math.min(1, texelsPerMetre / d10);
    caps.set(tex, Math.min(KTX2_TEXEL_CAP, Math.max(64, 2 ** Math.ceil(Math.log2(need)))));
  }
  // an EXTENSION's texture (KHR_materials_specular, clearcoat, sheen …) sits on its material's UV layout: it takes the
  // largest cap measured on that material's core slots — never measured itself, never above what they were given
  for (const tex of unmeasurable) {
    let cap = 0, only = true;
    for (const p of tex.listParents()) {
      if (p.propertyType === "Root") continue;
      const owners = p.propertyType === "Material" ? [] : p.listParents().filter((q: any) => q.propertyType === "Material");
      if (!owners.length) { only = false; break; }
      for (const mt of owners) for (const [t] of slotsOf(mt)) if (t && caps.has(t)) cap = Math.max(cap, caps.get(t)!);
    }
    if (only && cap > 0) caps.set(tex, cap);
  }
  return caps;
}

/** The node contract, as a signature: names, transforms, mesh-bearing, and
 *  hierarchy (child order), per scene. Exported so its DETECTION power is a
 *  unit test of its own, separate from the pipeline that consumes it. */
export const lodNodesSig = (d: Document): string => {
  const walk = (n: any): any => [n.getName(), n.getTranslation(), n.getRotation(), n.getScale(),
    n.getMesh()?.getName() ?? null, n.listChildren().map(walk)];
  return JSON.stringify(d.getRoot().listScenes().map((sc) => sc.listChildren().map(walk)));
};
/** Which material each primitive of each mesh wears, by index. */
export const lodMatsSig = (d: Document): string => JSON.stringify(d.getRoot().listMeshes().map((m) =>
  [m.getName(), m.listPrimitives().map((p) => { const mt = p.getMaterial(); return mt ? d.getRoot().listMaterials().indexOf(mt) : -1; })]));

/** The lod1 diet: the ktx2 diet (dedup/prune/resample + texel-budget KTX2 +
 *  draco) with weld + meshopt-simplify between — and the preservation
 *  asserts around the reduce. `verdict` non-null = a typed content refusal
 *  (marker's business); textures follow --ktx2's all-or-nothing. */
/** `mutate` is the MUTATION-CONTROL SEAM demanded by the #156 re-review:
 *  the test suite injects a post-reduce corruption (a renamed node, a
 *  swapped material assignment) and asserts the guard REFUSES it — so
 *  deleting either guard turns a named test red instead of leaving the
 *  suite green. Production callers (the CLI) never pass it. */
export async function optimizeGlbLod(bytes: Uint8Array, encoder: string | null, mutate?: (doc: Document) => void,
  { minVerts = LOD_MIN_VERTS }: { minVerts?: number } = {}): Promise<LodResult & Ktx2Tally> {   // minVerts: the census and the reducer-mechanics tests only; the recipe names the real floor
  const none = { eligible: 0, converted: 0, failed: [] as string[] };
  const rawJson = parseGlb(bytes).json;
  const excluded = lodExclusion(rawJson);
  if (excluded) return { out: null, verdict: excluded, kind: "structural", before: 0, after: 0, ...none };
  // a textured object on an encoder-less box is environmental — and known
  // from the raw container, BEFORE any expensive transform runs (the pump
  // retries this every boot; it must cost a JSON parse, not a simplify)
  if (!encoder && (rawJson?.images?.length ?? 0) > 0) return { out: null, verdict: "__no_encoder__", before: 0, after: 0, ...none };
  const io = await getIO();
  // ONE reduce, run as the proven pass and — only if that pass cannot reach the bar — again PERMISSIVE: meshopt's
  // mode that may collapse edges ACROSS UV/normal seams. Measured 09-24: seams lock the regular pass (a server rack
  // 96% → 25%, a yucca 83% → 25%, all 8 "ineffective" library/store models into 25–60%). Permissive can drag UVs a
  // little across a seam; a LOD is only seen at distance (lod_policy.js), and the owner approved it there ("fine with
  // permissive at a distance"). Every preservation assert below applies to both passes unchanged.
  const reduce = async (permissive: boolean, simplify = true) => {
    const doc = await io.readBinary(bytes);
    // The node contract is captured BEFORE any destructive transform (re-review
    // of #156, blocker 1: a plain prune() deleted an empty named socket helper
    // before the old post-head signature existed — the loss was invisible).
    // prune() runs with keepLeaves so named empty helpers — socket frames,
    // attachment points — survive the head at all; the whole-diet signature
    // then PROVES nothing was lost, or the variant is refused.
    const preNodes = lodNodesSig(doc);
    await doc.transform(dedup(), prune({ keepLeaves: true, keepAttributes: true }), resample());   // keepAttributes: see optimizeGlb
    const before = totalVerts(doc);
    // material assignments are captured after the head — dedup may merge
    // byte-identical materials, which is the ktx2 variant's existing behavior;
    // what may not change from HERE on is which material each primitive wears
    const preMats = lodMatsSig(doc);
    const bounds = sceneBounds(doc);
    const budget = lodBudget(doc);
    if (simplify && before >= minVerts) {
      await doc.transform(weld(), simplifyAttributes({ ratio: LOD_RATIO, errWorld: budget.errWorld, permissive }));
      mutate?.(doc);   // the mutation-control seam (tests only) — see the param doc
    }
    return { doc, preNodes, preMats, bounds, budget, before, after: totalVerts(doc) };
  };
  // The preservation gates, one place: a candidate either passes all of them or names what it broke.
  type Pass = Awaited<ReturnType<typeof reduce>>;
  const broken = (c: Pass): string | null => {
    if (lodNodesSig(c.doc) !== c.preNodes) return "preservation failed: node hierarchy/transforms changed";
    if (lodMatsSig(c.doc) !== c.preMats) return "preservation failed: material assignments changed";
    const [preMin, preMax] = c.bounds, [postMin, postMax] = sceneBounds(c.doc);
    for (let i = 0; i < 3; i++) {
      // 2% of the extent (1 cm floor), or the screen-space budget if that is larger: a silhouette that moved by less
      // than 2 px where the LOD is first seen moved by nothing a viewer can see (a 1 m prop: 2 cm gate, 4 cm budget).
      // A LOD placement owns no collider (lod_policy.js), so the budget is the visible standard here too. Still
      // refused: any silhouette that moved further — a thin spike collapsed into its base scores cheap in the quadric
      // metric (its side planes pass near the base), and this is what catches it.
      const tol = Math.max((preMax[i] - preMin[i]) * 0.02, 0.01, c.budget.errWorld);
      if (Math.abs(postMin[i] - preMin[i]) > tol || Math.abs(postMax[i] - preMax[i]) > tol) return `preservation failed: bounds moved on axis ${i}`;
    }
    return null;
  };
  // The textures' share of the full tier: the ratio of texel areas, LOD caps against the house cap the KTX2 variant
  // is encoded at (same encoder, same formats per slot — so the ratio of GPU memory). No textures → nothing to save.
  const texShare = (c: Pass) => {
    const caps = lodTexelCaps(c.doc, c.budget.texelsPerMetre);
    let fullArea = 0, lodArea = 0;
    for (const tex of c.doc.getRoot().listTextures()) {
      const size = tex.getSize() as [number, number] | null; if (!size || !tex.getImage()) continue;
      const area = (sz: [number, number] | null) => (sz ?? size)[0] * (sz ?? size)[1];
      fullArea += area(capTexels(size)); lodArea += area(capTexels(size, caps.get(tex) ?? KTX2_TEXEL_CAP));
    }
    return { caps, texRatio: fullArea > 0 ? lodArea / fullArea : 1 };
  };
  // Candidates, in order: a GEOMETRY LOD from the regular pass; else from the Permissive retry, if it passes every
  // gate; else a TEXTURE-ONLY LOD (LOD_TEX_ONLY) on the REGULAR pass — the retry's seam-crossing collapses buy a
  // texture-only LOD nothing, and a retry that broke a gate must not take down a LOD the regular pass would carry —
  // or, if the regular pass broke a gate too, on the UNTOUCHED geometry: a simplify that dropped a finial must not
  // cost a model the texture saving it qualifies for. Under the vertex floor nothing is simplified at all.
  const regular = await reduce(false);
  const before = regular.before;
  let r: Pass | null = null, permissive = false, texOnly = false, refused: string | null = null;
  if (before >= minVerts && regular.after <= before * 0.6) {
    refused = broken(regular); if (!refused) r = regular;
  } else if (before >= minVerts) {
    const retry = await reduce(true);
    if (retry.after <= before * 0.6) { refused = broken(retry); if (!refused) { r = retry; permissive = true; } }
  }
  let caps: Map<Texture, number>, texRatio: number;
  if (r) ({ caps, texRatio } = texShare(r));
  else {
    // the texture-only candidate: the regular pass (already untouched under the floor), or untouched geometry
    let base = regular, why = broken(regular);
    if (why && before >= minVerts) { base = await reduce(false, false); why = broken(base); }
    ({ caps, texRatio } = texShare(base));
    if (why || !(texRatio <= LOD_TEX_ONLY)) {
      const tex = `textures ${Math.round(texRatio * 100)}% of the full tier`;
      const none0 = { ...none, texRatio };
      if (before < minVerts) return { out: null, verdict: `already light (${before} verts < ${minVerts}; ${tex})`, kind: "light", before, after: before, ...none0 };
      if (refused) return { out: null, verdict: refused, kind: "preservation", before, after: regular.after, ...none0 };
      if (why) return { out: null, verdict: why, kind: "preservation", before, after: regular.after, ...none0 };
      return { out: null, verdict: `reduction ineffective (${before} -> ${regular.after} verts, permissive too; ${tex})`, kind: "ineffective", before, after: regular.after, ...none0 };
    }
    r = base; texOnly = true;
  }
  const { doc } = r;
  const after = r.after;
  // textures: the ktx2 arm's rules verbatim — all eligible convert or nothing ships
  let tally: Ktx2Tally = none;
  if (encoder) {
    // the mip levels this LOD can never sample stay home: each texture at the density its closest distance needs
    tally = await ktx2CompressTextures(doc, encoder, caps);   // the LOD's density caps — the texture half of the LOD
    if (tally.eligible > 0 && tally.converted < tally.eligible) return { out: null, verdict: null, before, after, ...tally };
  } else if (doc.getRoot().listTextures().some((t) => t.getImage())) {
    return { out: null, verdict: "__no_encoder__", before, after, ...none };   // env, the CLI exit-3s
  }
  // identity: the variant SAYS what it is a variant of, and how it was made
  const srcHash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  let meshoptVer = "unknown";
  try { meshoptVer = JSON.parse(await Bun.file(Bun.resolveSync("meshoptimizer/package.json", import.meta.dir)).text()).version; } catch { /* stays unknown */ }
  // the SOURCE's extras survive; ours ride alongside (never clobber a
  // producer's own annotations — review of #156, point 6)
  const asset = doc.getRoot().getAsset();
  asset.extras = { ...(asset.extras ?? {}), lodOf: srcHash, recipe: LOD_RECIPE, ...(permissive ? { simplify: "permissive" } : {}), ...(texOnly ? { lodBasis: "textures" } : {}),
    tools: { meshoptimizer: meshoptVer, encoder: encoder ? basename(encoder) : "none" } };
  await doc.transform(draco());
  return { out: await io.writeBinary(doc), verdict: null, before, after, permissive, texOnly, texRatio, ...tally };
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
  try { sharp = (await getSharp()).sharp; } catch { /* aligned-PNG/JPEG-only pass below */ }
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
  for (const [i] of newImageBytes) { json.images[i].mimeType = "image/ktx2"; json.images[i].extras = { ...(json.images[i].extras ?? {}), [KTX2_TF_MARK]: "assigned" }; }
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
// --lod shares the whole ladder: exit 2 for typed content verdicts (a body,
// fail closed; nothing to reduce; a preservation assert), exit 3 when a
// textured object meets a box with no encoder, exit 5 for a partial texture
// conversion — REFUSED, retryable.
// Exit 5 (--ktx2) = an encoder answered but not every eligible texture
// converted — the variant is REFUSED, nothing written. Environmental too (a
// flaky or misconfigured encoder, not a bad model): no marker, retried next
// boot; and not exit 3's ktx2Skip either — the encoder is there.

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const mode = argv.includes("--ktx2-img") ? "--ktx2-img"
    : argv.includes("--ktx2-vrm") ? "--ktx2-vrm"
    : argv.includes("--lod") ? "--lod"
    : argv.includes("--ktx2") ? "--ktx2" : null;
  const ktx2Mode = mode !== null;
  const [inPath, outPath] = argv.filter((a) => !a.startsWith("--"));
  if (!inPath || !outPath) {
    console.error("usage: bun run server/optimize.ts [--ktx2|--ktx2-vrm|--ktx2-img] <in> <out>");
    process.exit(1);
  }
  let encoder: string | null = null;
  if (mode === "--lod") encoder = findKtx2Encoder();   // optional here: an untextured object reduces fine without one
  else if (ktx2Mode && !(encoder = findKtx2Encoder())) {
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
        console.error(verdictLine("unsuitable", `ktx2-img: ${r.skip}`, KTX2_RECIPE));
        process.exit(2);
      }
      console.log(`[optimize] ktx2-img: ${basename(inPath)} → ${r.uastc ? "uastc" : "etc1s"}/${r.srgb ? "srgb" : "linear"}, flip baked`);
      out = r.out;
    } else if (mode === "--ktx2-vrm") {
      const r = await transcodeVrmKtx2(src, encoder!);
      if (r.converted === 0) {
        console.error(`[optimize] ktx2-vrm: no convertible raster images (${Math.round(performance.now() - t0)}ms) — keeping original`);
        console.error(verdictLine("nothing", "ktx2-vrm: no convertible raster images", KTX2_RECIPE));
        process.exit(2);
      }
      console.log(`[optimize] ktx2-vrm: ${r.converted} image(s) → ${r.etc1s} etc1s + ${r.uastc} uastc`);
      out = r.out;
    } else if (mode === "--lod") {
      const r = await optimizeGlbLod(src, encoder);
      if (r.verdict === "__no_encoder__") {
        console.error("[optimize] lod: textured object and no KTX2 encoder — set KTX2_TOKTX or put toktx/ktx on PATH (docs/ktx2-encoder.md)");
        process.exit(3);
      }
      if (r.verdict) {   // a typed content refusal — fail closed, marker's business; stamped with the recipe like the ktx2 size verdict
        console.error(`[optimize] lod: ${r.verdict} (${Math.round(performance.now() - t0)}ms) ${recipeStamp(LOD_RECIPE)} ${toolsStamp()} — original stays the only representation`);
        console.error(verdictLine(r.kind ?? "unknown", r.verdict, LOD_RECIPE));
        process.exit(2);
      }
      if (!r.out) {
        console.error(`[optimize] lod: ${r.converted}/${r.eligible} texture(s) converted — REFUSING a partial variant (${r.failed.join(", ")}); retry when the encoder is sane`);
        process.exit(5);
      }
      console.log(`[optimize] lod: ${r.before} -> ${r.after} verts${r.permissive ? " (permissive: collapsed across UV seams)" : ""}, ${r.converted}/${r.eligible} texture(s) at the texel budget`);
      out = r.out;
    } else if (mode === "--ktx2") {
      const r = await optimizeGlbKtx2(src, encoder!);
      if (r.eligible === 0) {
        console.error(`[optimize] ktx2: no convertible raster images (${Math.round(performance.now() - t0)}ms) — keeping original`);
        console.error(verdictLine("nothing", "ktx2: no convertible raster images", KTX2_RECIPE));
        process.exit(2);
      }
      if (!r.out) {
        console.error(`[optimize] ktx2: ${r.converted}/${r.eligible} texture(s) converted — REFUSING a partial variant (${r.failed.join(", ")}); retry when the encoder is sane`);
        process.exit(5);
      }
      console.log(`[optimize] ktx2: ${r.converted}/${r.eligible} texture(s) → KTX2`);
      out = r.out;
    } else {
      out = await optimizeGlb(src);
    }
    const ms = Math.round(performance.now() - t0);
    // An already-lean upload (someone re-uploading our own optimized output,
    // a tiny primitive) gains nothing — don't shadow it with a same-size copy.
    // The --ktx2 gate is deliberately generous: KTX2 variants exist for
    // decode/upload wins (no createImageBitmap, GPU-native mips, 4-8× less
    // VRAM), not just wire bytes — accept anything not grossly bigger than
    // the ORIGINAL source (>1.25×).
    // A LOD is judged by what it is FOR (owner, 09-24: "judge LODs by verts/GPU memory instead of file size"): the
    // vertex cut — or, for a texture-only LOD, the texture cut — is already asserted (optimizeGlbLod), and here its textures must not cost MORE GPU memory
    // than the original's. Its KTX2 textures are routinely 2–5× LARGER ON DISK than a JPEG original while far
    // smaller in VRAM — the byte gate below refused 7 of 8 real candidates for exactly that. The download ratio is
    // logged on success, because a far placement fetches the LOD first (lod_policy.js) and it is a real trade.
    if (mode === "--lod") {
      const a = glbPerf(src), b = glbPerf(out);
      if (b.texMB > a.texMB) {
        console.error(lodGpuRefusal(a.texMB, b.texMB, ms));
        console.error(verdictLine("gpu", `not lighter on the GPU (textures ${a.texMB} -> ${b.texMB} MB)`, LOD_RECIPE));
        process.exit(2);
      }
      console.log(`[optimize] lod: GPU textures ${a.texMB} -> ${b.texMB} MB, tris ${a.tris} -> ${b.tris}; download ${(out.length / src.length).toFixed(2)}x the original`);
    } else if (out.length >= src.length * (ktx2Mode ? 1.25 : 0.95)) {
      // the KTX2 verdict carries its recipe AND its tools: a later recipe or
      // a new encoder re-measures it (store-variants.ts verdictStands)
      // instead of inheriting the refusal
      console.error(`[optimize] not smaller (${src.length} -> ${out.length}, ${ms}ms)${ktx2Mode ? ` ${recipeStamp(mode === "--lod" ? LOD_RECIPE : undefined)} ${toolsStamp()}` : ""} — keeping original`);
      console.error(verdictLine("size", `not smaller (${src.length} -> ${out.length})`, ktx2Mode ? (mode === "--lod" ? LOD_RECIPE : KTX2_RECIPE) : null));
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
    // server will trustingly serve it (atomicWrite, the house idiom — this
    // site used to be the odd one out with a lazy fs import)
    const { atomicWrite } = await import("./fsutil.ts");
    atomicWrite(outPath, out);
    console.log(`[optimize] ${src.length} -> ${out.length} bytes (${(src.length / out.length).toFixed(1)}x, ${ms}ms)`);
    process.exit(0);
  } catch (e) {
    console.error(`[optimize] ${(e as Error).stack ?? e}`);
    process.exit(1);
  }
}
