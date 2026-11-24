// optimize — the store's diet: dedup + prune + resample + webp@1024 + draco for uploaded GLBs, plus the KTX2
// (--ktx2, --ktx2-vrm, --ktx2-img) and geometry-LOD (--lod) variant arms. Originals are never touched (the hash names
// them); optimized copies live in assets/opt/store-min/<hash>.glb and /library serving prefers them.
//
// RUN AS A SUBPROCESS (see CLI at the bottom): draco and image encoding are CPU-seconds of synchronous wasm that would
// freeze pose relay and every world inside the sequencer. upload.ts's pump spawns `bun run server/optimize.ts [mode] <in> <out>`.
//
// VRMs never go through a Document (springbone/MToon extensions would be dropped): their only arm is --ktx2-vrm's
// raw-container texture swap, which byte-preserves everything else.

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
import { sha256Bytes } from "../shared/protocol/hash.js";

// ---- ONE libvips per process ------------------------------------------------
// Never import "sharp" by bare specifier here: a second libvips in-process corrupts encoder output into bytes that
// are not images. Use getSharp(), which resolves gltf-transform's own copy (resolveNestedSharp, tools-stamp.ts) and
// fails closed. Why: docs/research/optimize-design-notes.md#one-libvips-per-process

/** The choice itself, effects injected so a test can drive it. Fails CLOSED: once a copy resolves from ndarray-pixels, an
 *  import failure PROPAGATES (callers then skip the texture pass) rather than falling back to the bare specifier. */
export async function pickSharp(
  resolveNested: () => string | null,
  load: (specifier: string) => Promise<any>,
): Promise<{ sharp: any; from: string }> {
  const nested = resolveNested();
  if (nested !== null) {
    const mod = await load(nested);          // no catch: fail closed
    return { sharp: mod.default ?? mod, from: nested };
  }
  // nothing resolved from ndarray-pixels: the bare specifier is the one copy left to try
  const mod = await load("sharp");
  return { sharp: mod.default ?? mod, from: "sharp (bare specifier)" };
}

let sharpP: Promise<{ sharp: any; from: string }> | null = null;
/** Exported for test/server/one-libvips-test.ts: `from` is the copy gltf-transform's own ndarray-pixels resolves, nested or the root's. */
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
    // keepAttributes: default prune drops attributes the material doesn't read (TEXCOORD_0 on an untextured part),
    // which breaks the picture contract (shared/picture.js textures a named blank part later)
    prune({ keepAttributes: true }),      // unreferenced leftovers dropped
    resample(),   // animation keyframes deduplicated (lossless within tolerance)
  ];

  // Texture recompression needs sharp (native). If it can't load on this box,
  // a draco-only pass is still most of the win — degrade, don't die.
  try {
    // getSharp, never a bare import: the encoder must be the same libvips gltf-transform decodes with
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

// ---- KTX2: the library variant diet ----------------------------------
// GPU-native compressed textures: no createImageBitmap decode, no raw RGBA uploads, 4-8× less VRAM. The store recipe minus
// webp plus a per-texture KTX2 pass before draco. Serves only on ?ktx2=1: KHR_texture_basisu is in extensionsRequired.

/** An encoder the kernel killed for memory (SIGKILL: the unit's cgroup ran out, docs/research/service-hardening.md) kills
 *  this pass the same way, so the pump defers the item (upload.ts) instead of marking it failed. */
function dieWithEncoder(proc: { signalCode: string | null }) { if (proc.signalCode === "SIGKILL") process.kill(process.pid, "SIGKILL"); }
// findKtx2Encoder lives in tools-stamp.ts (the verdict stamp names the encoder it finds)

// baseColor/emissive are eye-facing sRGB → ETC1S (~4-8× smaller, block noise hides in shading). Every other slot
// carries per-channel DATA (MToon .r/.b scalars, normals) where ETC1S artifacts read as corruption → UASTC+zstd.
const COLOR_SLOT = /baseColor|emissive/i;

/** One encoder invocation's argv (toktx or `ktx create`), shared by every arm. ETC1S rides BasisLZ (zstd would be
 *  invalid there); UASTC gets mild RDO (λ=1.0) + zstd 18 — without RDO zstd barely dents UASTC. Mips are always
 *  generated (compressed mips can't be made at runtime). `resize` (capTexels) uses toktx's own --resize. */
export function ktx2EncodeArgs(encoder: string, isToktx: boolean, srgb: boolean, uastc: boolean, inPath: string, outPath: string,
  resize: [number, number] | null = null): string[] {
  return isToktx
    ? [encoder, "--t2", "--genmipmap", "--assign_oetf", srgb ? "srgb" : "linear",
       ...(resize ? ["--resize", `${resize[0]}x${resize[1]}`] : []),
       ...(uastc ? ["--encode", "uastc", "--uastc_quality", "2", "--uastc_rdo_l", "1.0", "--zcmp", "18"]
                 : ["--encode", "etc1s", "--qlevel", "128"]),
       outPath, inPath]
    // --assign-tf, never a conversion: given a UNORM format, ktx create would CONVERT an untagged 8-bit PNG from sRGB
    // and bake the curve into normal/data maps. toktx's --assign_oetf already means assign.
    : [encoder, "create", "--format", srgb ? "R8G8B8A8_SRGB" : "R8G8B8A8_UNORM", "--assign-tf", srgb ? "srgb" : "linear",
       "--generate-mipmap",
       ...(uastc ? ["--encode", "uastc", "--uastc-quality", "2", "--uastc-rdo", "--uastc-rdo-l", "1.0", "--zstd", "18"]
                 : ["--encode", "basis-lz", "--qlevel", "128"]),
       inPath, outPath];
}

/** Stamped on every image this encoder writes since the transfer fix (ktx2EncodeArgs --assign-tf). A ktx-create
 *  KTX2 image without it, written LINEAR, had the sRGB→linear curve baked in — tools/assets/ktx2-tf-purge.ts finds those.
 *  The image's own KTX metadata can't tell them apart (same writer, same params). */
export const KTX2_TF_MARK = "ktx2Tf";
export type Ktx2Tally = { eligible: number; converted: number; failed: string[] };
const KTX2_MAGIC = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
export const isKtx2Container = (b: Uint8Array) => b.length >= 12 && KTX2_MAGIC.every((v, i) => b[i] === v);
/** Per-texture KTX2 encode, in place on the Document (toktx or `ktx create`, detected by basename). A texture that
 *  will not convert is skipped and NAMED in the tally; the caller decides whether a partial result ships. Every
 *  output is checked for the KTX2 container magic before it is accepted. */
async function ktx2CompressTextures(doc: Document, encoder: string, caps?: Map<Texture, number>): Promise<Ktx2Tally> {
  const isToktx = basename(encoder).toLowerCase().includes("toktx");
  // sharp converts non-PNG sources (webp/jpeg) and 4-aligns dimensions —
  // KHR_texture_basisu (and WebGPU BC upload) wants width/height % 4 == 0.
  // sharp is optional today: without it, only already-aligned PNGs encode.
  let sharp: any = null;
  // KTX2_NO_SHARP=1 behaves as a host without sharp (test/server/ktx2-resize-test.ts drives it)
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
      // The source passes straight through where the encoder reads it natively (PNG; JPEG for toktx); sharp converts
      // the rest, best-effort — a sharp failure skips the TEXTURE, never the file.
      // Texel budget: 1024² (store-variants.ts). toktx resizes itself; for `ktx create` sharp resizes first.
      const resize = capTexels(size as [number, number] | null, caps?.get(tex) ?? KTX2_TEXEL_CAP);   // caps: a LOD's density budget (lodTexelCaps)
      const sharpResize = !!resize && !isToktx && !!sharp;
      // no sharp on a `ktx create` host: can't get under the cap, so not encoded at all (never shipped at source size
      // under a texel1024 recipe)
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
      dieWithEncoder(proc);
      const err = (await new Response(proc.stderr).text()).trim();
      if (code !== 0 || !existsSync(outPath)) {
        console.error(`[optimize] ktx2: encode failed on ${label} (${err.split("\n")[0] || `exit ${code}`}) — texture kept as-is`);
        failed.push(label); continue;
      }
      const encoded = new Uint8Array(await Bun.file(outPath).arrayBuffer());
      // exit 0 isn't enough: the bytes must carry the container they will be labelled with
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

/** The --ktx2 diet. ALL or nothing: `out` is null unless every eligible texture converted (a partial .ktx2.glb's
 *  name would lie, and it is served immutable). Nothing eligible → exit 2; anything unconverted → exit 5 (CLI). */
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
// A decimated variant for PLACEABLE OBJECTS only. Bodies are excluded by structural detection on the raw container
// (typed verdict, never a silent attempt); accepted objects must prove they kept named nodes, materials and bounds.

/** Why this GLB is not an object the reducer may touch — or null. Reads the
 *  raw JSON chunk: gltf-transform must not be the thing deciding whether a
 *  body is a body (it drops extensions it does not know). */
export function lodExclusion(json: any): string | null {
  if (json?.skins?.length) return "unsupported: skinned/avatar asset (skins)";
  // fail closed: don't trust well-formedness — a VRM may omit extensionsUsed, skinning may skip set 0
  const extNames = [...(json?.extensionsUsed ?? []), ...(json?.extensionsRequired ?? []),
    ...Object.keys(json?.extensions ?? {})];
  if (extNames.some((e) => /^VRM/i.test(e) || /^VRMC_/i.test(e))) return "unsupported: skinned/avatar asset (VRM metadata)";
  for (const m of json?.meshes ?? []) for (const p of m.primitives ?? []) {
    if (p.targets?.length) return "unsupported: morph targets the reducer cannot prove preserved";
    for (const k of Object.keys(p.attributes ?? {}))
      if (/^(JOINTS|WEIGHTS)_\d+$/.test(k)) return "unsupported: skinned/avatar asset (joint weights)";
  }
  // static geometry only: preservation of animation channels through the reduce is unproven
  if (json?.animations?.length) return "unsupported: animated object (v1 reduces static geometry only)";
  return null;
}

const totalVerts = (doc: Document) => {
  let n = 0;
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) n += p.getAttribute("POSITION")?.getCount() ?? 0;
  return n;
};
// WORLD space (node transforms applied), like the metre budget it is compared against.
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

// Attribute-aware simplification (normals, COLOR_0, TEXCOORD_0 in the error metric; gltf-transform's simplify() is
// positions-only). Weights were measured; why, and ErrorClamped: docs/research/optimize-design-notes.md#attribute-aware-lod-simplification
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

/** TEXEL DENSITY: the longest side each texture needs so all but its least dense tenth (by area) still gets `texelsPerMetre`. Per
 *  triangle, density along its LEAST dense axis (minTexelDensity); the area-weighted 10th percentile is held at the
 *  target (not the minimum: a sliver of stretched UVs would pin the map at full size). Rounded up to a power of two,
 *  clamped to [64, house cap]. Unmeasurable textures (KHR_texture_transform, non-core slots) keep the house cap, except
 *  an extension's texture whose materials had core slots measured: it takes their largest cap (below). */
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

/** The lod1 diet: the ktx2 diet with weld + attribute-aware simplify between, and preservation asserts around the
 *  reduce. `verdict` non-null = a typed content refusal; textures follow --ktx2's all-or-nothing. `mutate` is the
 *  mutation-control seam: tests inject a post-reduce corruption and assert a guard refuses it. The CLI never passes it. */
export async function optimizeGlbLod(bytes: Uint8Array, encoder: string | null, mutate?: (doc: Document) => void,
  { minVerts = LOD_MIN_VERTS }: { minVerts?: number } = {}): Promise<LodResult & Ktx2Tally> {   // minVerts: the census and the reducer-mechanics tests only; the recipe names the real floor
  const none = { eligible: 0, converted: 0, failed: [] as string[] };
  const rawJson = parseGlb(bytes).json;
  const excluded = lodExclusion(rawJson);
  if (excluded) return { out: null, verdict: excluded, kind: "structural", before: 0, after: 0, ...none };
  // a textured object on an encoder-less box is environmental, decided from the raw JSON before any expensive
  // transform (the pump retries it every boot)
  if (!encoder && (rawJson?.images?.length ?? 0) > 0) return { out: null, verdict: "__no_encoder__", before: 0, after: 0, ...none };
  const io = await getIO();
  // One reduce: the regular pass, and only if it can't reach the bar, again PERMISSIVE (may collapse across seams).
  // docs/research/optimize-design-notes.md#permissive-retry
  const reduce = async (permissive: boolean, simplify = true) => {
    const doc = await io.readBinary(bytes);
    // The node contract is captured BEFORE any destructive transform; prune keepLeaves lets named empty helpers
    // (socket frames) survive, and the signature then proves nothing was lost.
    const preNodes = lodNodesSig(doc);
    await doc.transform(dedup(), prune({ keepLeaves: true, keepAttributes: true }), resample());   // keepAttributes: see optimizeGlb
    const before = totalVerts(doc);
    // captured after the head (dedup may merge identical materials); from here no primitive may change material
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
      // 2% of the extent (1 cm floor), or the screen-space budget if larger (a LOD placement owns no collider,
      // lod_policy.js). Catches e.g. a thin spike collapsed into its base, which the quadric metric scores cheap.
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
  // Candidates, in order: geometry LOD from the regular pass; else from the Permissive retry; else a TEXTURE-ONLY LOD
  // (LOD_TEX_ONLY) on the regular pass, or on untouched geometry if that broke a gate. Under the vertex floor nothing
  // is simplified.
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
  const srcHash = sha256Bytes(bytes);
  let meshoptVer = "unknown";
  try { meshoptVer = JSON.parse(await Bun.file(Bun.resolveSync("meshoptimizer/package.json", import.meta.dir)).text()).version; } catch { /* stays unknown */ }
  // the source's extras survive, except the keys we write (lodOf, recipe, tools, simplify, lodBasis)
  const asset = doc.getRoot().getAsset();
  asset.extras = { ...(asset.extras ?? {}), lodOf: srcHash, recipe: LOD_RECIPE, ...(permissive ? { simplify: "permissive" } : {}), ...(texOnly ? { lodBasis: "textures" } : {}),
    tools: { meshoptimizer: meshoptVer, encoder: encoder ? basename(encoder) : "none" } };
  await doc.transform(draco());
  return { out: await io.writeBinary(doc), verdict: null, before, after, permissive, texOnly, texRatio, ...tally };
}

// ---- KTX2 for VRMs: the surgical container rewrite -------------------
// gltf-transform drops unknown extensions on read, and a VRM is mostly unknown extensions, so a VRM never touches a
// Document: the only mutations are image bytes → KTX2, the bufferView offsets that implies, and the JSON declaring them.
// validateVrmRewrite checks the output and throws (CLI exit 1) rather than return anything questionable.


// ---- output validation ------------------------------------------------------
// An optimizer may give up, but may not emit bytes it has not checked: an intact GLB can still carry image bytes that
// are not images (the two-libvips hazard, docs/research/optimize-design-notes.md#one-libvips-per-process), and every
// consumer trusts the mimeType. So each embedded image's magic is checked against its declared type.

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

/** Slot classification from the JSON alone, folded onto IMAGES (textures sharing an image accumulate marks):
 *    - core glTF: baseColor/emissive = color; normal/occlusion/metallicRoughness = data.
 *    - VRM 1.x VRMC_materials_mtoon: shade/matcap/rimMultiply = color; other *Texture keys = data (MToon samples
 *      .r/.b scalars there; ETC1S noise reads as corruption).
 *    - VRM 0.x materialProperties[].textureProperties: _MainTex/_ShadeTexture/_SphereAdd/_RimTexture/_EmissionMap =
 *      color; anything else = data.
 *  Unrecognized or unreferenced (meta thumbnails) → UASTC: safe, bigger. */
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
  // An image bufferView shared with another image or an accessor (incl. sparse) can't be swapped: skip that image.
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
        // best-effort: a sharp failure skips the TEXTURE, never the file. Unlike --ktx2 (all or nothing),
        // this arm ships a partial result
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
      dieWithEncoder(proc);
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
      // no raster fallback remains, so drop top-level `source` and require the extension (served only on ?ktx2=1)
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

// ---- KTX2 for loose library images -----------------------------------
// Vegetation, sky and particle textures otherwise reach the client as raw RGBA uploads. three's KTX2Loader ignores KTX
// orientation metadata and the client trusts the container, so two contracts are baked at encode time:
//   1. the flip: loadImageTexture bakes the vertical flip into the pixels, so every encode here flips rows first (pure-JS
//      decoders; a flip that silently failed is a mirrored meadow);
//   2. the transfer: the DFD's OETF must match the call site's opts.srgb, classified by filename against the consumers
//      (vegetation.js loadMap, sky_worlds.js readTex, emitters.js spriteTexture).

const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;

/** Filename → codec/transfer, or a refusal. Rules cite their call sites (in ../eidoverse-video unless noted). Order
 *  matters: the particle dir is classified as a DIR; data keywords beat color (asteroid_moon_normal contains "moon"). */
export function classifyLooseImage(srcPath: string): { srgb: boolean; uastc: boolean } | { conflict: string } {
  const p = srcPath.replace(/\\/g, "/").toLowerCase();
  const name = basename(p);
  if (p.includes("/particle_textures/")) {
    // trace_06.png is loaded linear by sky_worlds.js (bolt) and srgb by emitters.js: one DFD can't serve both
    if (name === "trace_06.png") return { conflict: "loaded linear by sky_worlds (bolt) AND srgb by emitters" };
    // emitters.js spriteTexture, { srgb: true }; UASTC because smooth alpha gradients are ETC1S's worst case
    return { srgb: true, uastc: true };
  }
  // Data maps, loaded WITHOUT srgb (vegetation.js loadMap normal/roughness; sky_worlds.js band + solar set):
  // linear + UASTC (§20)
  if (/(normal|rough|metal|_ao\b|height|mask|bump|occlusion|displace)/.test(name)) return { srgb: false, uastc: true };
  // Color maps, loaded { srgb: true } (vegetation albedo/translucency; sky readTex(.., true)): ETC1S q128
  if (/(albedo|translucen|_color|basecolor|diffuse|emissi|_baked|starmap|kloppenheim|puresky|moon|rock_giant|rain_streak)/.test(name)) return { srgb: true, uastc: false };
  // Unmatched ⇒ UASTC + linear. A COLOR file landing here renders with darkened mids: extend the color list.
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
  // lazy imports (pure-JS decoders, §20d): other modes keep working before `bun install`; a resolve failure here
  // reads as env-skip in the pump
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
    dieWithEncoder(proc);
    const err = (await new Response(proc.stderr).text()).trim();
    if (code !== 0 || !existsSync(outPath))
      throw new Error(`ktx2-img: encode failed (${err.split("\n")[0] || `exit ${code}`})`);
    return { out: new Uint8Array(await Bun.file(outPath).arrayBuffer()), srgb: cls.srgb, uastc: cls.uastc };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ---- CLI: bun run server/optimize.ts [--ktx2|--ktx2-vrm|--ktx2-img|--lod] <in> <out>
// Exit codes:
//   0  wrote out.
//   1  failure, reason on stderr.
//   2  nothing written, serve the original: not smaller; --ktx2/--ktx2-vrm nothing convertible; --ktx2-img unsuitable
//      image; --lod a typed content verdict (body, nothing to reduce, preservation, not lighter on the GPU).
//   3  any --ktx2* mode (or --lod with textures): no KTX2 encoder — environmental, env-skip, never a .failed marker.
//   4  an output image failed the container check — retryable, not marked failed.
//   5  --ktx2/--lod: an encoder answered but not every texture converted — refused, no marker, retried next boot.
//   SIGKILL: an encoder was killed for memory (dieWithEncoder) — the pump defers it, retried next boot.

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const mode = argv.includes("--ktx2-img") ? "--ktx2-img"
    : argv.includes("--ktx2-vrm") ? "--ktx2-vrm"
    : argv.includes("--lod") ? "--lod"
    : argv.includes("--ktx2") ? "--ktx2" : null;
  const ktx2Mode = mode !== null;
  const [inPath, outPath] = argv.filter((a) => !a.startsWith("--"));
  if (!inPath || !outPath) {
    console.error("usage: bun run server/optimize.ts [--ktx2|--ktx2-vrm|--ktx2-img|--lod] <in> <out>");
    process.exit(1);
  }
  let encoder: string | null = null;
  if (mode === "--lod") encoder = findKtx2Encoder();   // optional here: an untextured object reduces fine without one
  else if (ktx2Mode && !(encoder = findKtx2Encoder())) {
    console.error("[optimize] ktx2: no encoder — set KTX2_TOKTX or put toktx/ktx on PATH (docs/operator/KTX2-ENCODER.md)");
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
        console.error("[optimize] lod: textured object and no KTX2 encoder — set KTX2_TOKTX or put toktx/ktx on PATH (docs/operator/KTX2-ENCODER.md)");
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
    // Size gate: an already-lean upload isn't shadowed by a same-size copy. --ktx2 accepts up to 1.25× the source
    // (its wins are decode/upload/VRAM, not wire bytes). --lod is judged by GPU texture memory instead of file size:
    // docs/research/optimize-design-notes.md#lod-gate-gpu-cost-not-file-bytes
    if (mode === "--lod") {
      const a = glbPerf(src), b = glbPerf(out);
      if (b.texMB > a.texMB) {
        console.error(lodGpuRefusal(a.texMB, b.texMB, ms));
        console.error(verdictLine("gpu", `not lighter on the GPU (textures ${a.texMB} -> ${b.texMB} MB)`, LOD_RECIPE));
        process.exit(2);
      }
      console.log(`[optimize] lod: GPU textures ${a.texMB} -> ${b.texMB} MB, tris ${a.tris} -> ${b.tris}; download ${(out.length / src.length).toFixed(2)}x the original`);
    } else if (out.length >= src.length * (ktx2Mode ? 1.25 : 0.95)) {
      // the verdict carries recipe and tools so a later recipe/encoder re-measures it (store-variants.ts verdictStands)
      console.error(`[optimize] not smaller (${src.length} -> ${out.length}, ${ms}ms)${ktx2Mode ? ` ${recipeStamp()} ${toolsStamp()}` : ""} — keeping original`);
      console.error(verdictLine("size", `not smaller (${src.length} -> ${out.length})`, ktx2Mode ? KTX2_RECIPE : null));
      process.exit(2);
    }
    // content check: a GLB whose images are not images serves confidently. --ktx2-img emits a bare KTX2, nothing to walk
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
    // tmp+rename: a killed pass must never leave a truncated GLB where the server will serve it
    const { atomicWrite } = await import("./fsutil.ts");
    atomicWrite(outPath, out);
    console.log(`[optimize] ${src.length} -> ${out.length} bytes (${(src.length / out.length).toFixed(1)}x, ${ms}ms)`);
    process.exit(0);
  } catch (e) {
    console.error(`[optimize] ${(e as Error).stack ?? e}`);
    process.exit(1);
  }
}
