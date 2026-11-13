// glbperf — a model's loupe rank read from its GLB, without rendering it (library cards; owner, 09-24).
//
// Mirrors what the client does: three's GLTFLoader turns every triangle primitive of every mesh-bearing node in the
// default scene into ONE Mesh (EXT_mesh_gpu_instancing → an InstancedMesh of `count`), and perfscope's accumulate()
// bills per Mesh: tris = index (or position) count / 3 × instances, one draw, its material into a unique set, one
// alpha tick per BLEND material occurrence; textures once per unique texture, w×h×4 bytes (×4/3 with mips); bones =
// the largest skin a skinned mesh in the ranked scene uses. The rule and thresholds are shared/perfrank.js — the loupe's own. tools/glbperf-parity-probe
// loads real library models through the client's loader and checks these numbers against perfscope.statsOf().
//
// Known approximations, disclosed on the card: KTX2/basis images are billed at 1 byte/texel — the desktop worst case
// (ETC1S transcodes to BC7 where BPTC exists; the GPU format depends on the viewer's hardware); an image this cannot size (not PNG/JPEG/WebP/KTX2) is billed as 0 and counted in
// `unsizedImages`. The catalog ranks the file a viewer is SERVED (routes.ts perfPair: the KTX2 variant when one exists)
// and the original upload beside it.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { parseGlb, rasterDims, GLB_MAGIC, CHUNK_JSON, CHUNK_BIN } from "./glbparse.ts";
import { rankOf, TIER_NAMES } from "../shared/perfrank.js";

export type GlbPerf = { tris: number; draws: number; mats: number; alpha: number; bones: number; texMB: number;
  unsizedImages: number; rank: number; rankName: string; worst: string; tiers: Record<string, number> };

const MODE_TRIANGLES = 4, MODE_STRIP = 5, MODE_FAN = 6;
const NEAREST = 9728, LINEAR = 9729;

function webpDims(b: Uint8Array): [number, number] | null {
  if (b.length < 30 || String.fromCharCode(...b.subarray(0, 4)) !== "RIFF" || String.fromCharCode(...b.subarray(8, 12)) !== "WEBP") return null;
  const kind = String.fromCharCode(...b.subarray(12, 16));
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (kind === "VP8X") return [1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16))];
  if (kind === "VP8L") { const v = dv.getUint32(21, true); return [1 + (v & 0x3fff), 1 + ((v >> 14) & 0x3fff)]; }
  if (kind === "VP8 ") return [dv.getUint16(26, true) & 0x3fff, dv.getUint16(28, true) & 0x3fff];
  return null;
}
/** KTX2 size + the bytes/texel the GPU holds after transcode. three's KTX2Loader (priorityETC1S) takes ETC2 first,
 *  then BC7: a desktop with BPTC and no ETC2 (most Windows/Linux GPUs) holds ETC1S as BC7, so the CARD bills the worst
 *  case: 1 B/texel for
 *  everything. `bptc:false` is the regime of a device without it (ETC1S → BC1 0.5, or BC3 1 with an alpha sample) —
 *  the parity probe passes the regime its headless loader actually got. UASTC → BC7 (1) either way. An uncompressed
 *  fallback would be 4 — the card says "estimated". Samples are counted from the DFD's basic descriptor block. */
function ktx2Info(b: Uint8Array, bptc = true): { dims: [number, number]; bpp: number } | null {
  if (b.length < 80 || b[0] !== 0xab || b[1] !== 0x4b) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const dims: [number, number] = [dv.getUint32(20, true), dv.getUint32(24, true)];
  const supercompression = dv.getUint32(44, true);          // 1 = BasisLZ (ETC1S)
  const dfd = dv.getUint32(48, true);
  let samples = 1;
  if (dfd + 12 <= b.length) samples = Math.max(1, Math.round((dv.getUint16(dfd + 4 + 6, true) - 24) / 16));
  return { dims, bpp: supercompression === 1 && !bptc ? (samples > 1 ? 1 : 0.5) : 1 };
}

/** The first `max` bytes of a bufferView (null = out of range). The ranker only needs image HEADERS, so the file path
 *  reads those by offset instead of the whole GLB (the catalog route runs on the sequencer thread). */
type ViewReader = (bv: any, max: number) => Uint8Array | null;
const IMAGE_HEAD = 65536;   // PNG/WebP/KTX2 headers are < 1 KB; only a JPEG's SOF can sit past this (it retries, bounded)
// the JPEG retry's ceiling: a SOF behind big EXIF/ICC blocks is found, but a pathological (or hostile) upload can't make
// a catalog request read a whole multi-MB image on the sequencer thread (Greptile #207). Past it: billed unsized.
const JPEG_RETRY_MAX = 1 << 20;

export function glbPerf(bytes: Uint8Array, opts: { bptc?: boolean } = {}): GlbPerf {
  const { json, bin } = parseGlb(bytes);
  return perfOf(json, (bv, max) => {
    const o = bv.byteOffset ?? 0;
    return o + bv.byteLength <= bin.length ? bin.subarray(o, o + Math.min(bv.byteLength, max)) : null;
  }, opts);
}

function perfOf(json: any, view: ViewReader, { bptc = true }: { bptc?: boolean } = {}): GlbPerf {
  const nodes: any[] = json.nodes ?? [], meshes: any[] = json.meshes ?? [], accessors: any[] = json.accessors ?? [];
  const scene = (json.scenes ?? [])[json.scene ?? 0];
  let tris = 0, draws = 0, alpha = 0, bones = 0;
  const mats = new Set<number>();
  const visit = (ni: number, seen: Set<number>) => {
    if (seen.has(ni)) return; seen.add(ni);
    const n = nodes[ni]; if (!n) return;
    if (n.mesh != null) {
      const inst = n.extensions?.EXT_mesh_gpu_instancing?.attributes;
      const count = inst ? (accessors[Object.values(inst)[0] as number]?.count ?? 1) : 1;
      for (const p of meshes[n.mesh]?.primitives ?? []) {
        const mode = p.mode ?? MODE_TRIANGLES;
        if (mode !== MODE_TRIANGLES && mode !== MODE_STRIP && mode !== MODE_FAN) continue;   // lines/points: not a Mesh
        // a skin counts only where GLTFLoader builds a SkinnedMesh from it: a triangle primitive on a node of the ranked
        // scene that references the skin (the loupe's max over loaded skinned meshes). Unused skins cost nothing (Greptile #207).
        if (n.skin != null) bones = Math.max(bones, json.skins?.[n.skin]?.joints?.length ?? 0);
        const n0 = p.indices != null ? accessors[p.indices]?.count ?? 0 : accessors[p.attributes?.POSITION]?.count ?? 0;
        const idx = mode === MODE_TRIANGLES ? n0 : Math.max(0, n0 - 2) * 3;   // GLTFLoader re-indexes strips/fans
        tris += Math.round(idx / 3) * count;
        draws += 1;
        const mi = p.material ?? -1;                                           // -1: GLTFLoader's one default material
        mats.add(mi);
        if (mi >= 0 && json.materials?.[mi]?.alphaMode === "BLEND") alpha += 1;
      }
    }
    for (const c of n.children ?? []) visit(c, seen);
  };
  const seen = new Set<number>();
  for (const r of scene?.nodes ?? []) visit(r, seen);
  // textures: every texture index the USED materials reference (GLTFLoader loads textures per material)
  const texIdx = new Set<number>();
  // glTF's textureInfo objects are exactly the values of keys ending in "Texture" (baseColorTexture, normalTexture,
  // occlusionTexture, … and every KHR_materials_* extension's *Texture) — walk the material for those
  const walk = (v: any) => {
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (/Texture$/.test(k) && typeof (x as any)?.index === "number") texIdx.add((x as any).index);
      else walk(x);
    }
  };
  for (const mi of mats) if (mi >= 0) walk(json.materials?.[mi]);
  let texBytes = 0, unsizedImages = 0;
  const loaded = new Set<string>();   // GLTFLoader caches Textures by source:sampler — two glTF textures on one image
  for (const ti of texIdx) {          // and sampler are ONE Texture (and one upload); the loupe counts objects
    const t = json.textures?.[ti]; if (!t) continue;
    const src = t.extensions?.KHR_texture_basisu?.source ?? t.extensions?.EXT_texture_webp?.source ?? t.source;
    const cacheKey = `${src}:${t.sampler ?? -1}`;
    if (loaded.has(cacheKey)) continue;
    loaded.add(cacheKey);
    const img = json.images?.[src]; const bv = img?.bufferView != null ? json.bufferViews?.[img.bufferView] : null;
    const mime = img?.mimeType ?? "";
    const dimsOf = (b: Uint8Array | null) => {
      const k = b && mime === "image/ktx2" ? ktx2Info(b, bptc) : null;
      return { k, dims: !b ? null : k?.dims ?? (mime === "image/webp" ? webpDims(b) : rasterDims(b, mime)) };
    };
    let { k: k2, dims } = dimsOf(bv ? view(bv, IMAGE_HEAD) : null);
    if (!dims && mime === "image/jpeg" && bv && bv.byteLength > IMAGE_HEAD) ({ k: k2, dims } = dimsOf(view(bv, JPEG_RETRY_MAX)));
    if (!dims) { unsizedImages++; continue; }
    const sampler = json.samplers?.[t.sampler];
    const mips = !(sampler?.minFilter === NEAREST || sampler?.minFilter === LINEAR);
    // a KTX2 image carries its own mip chain (the loader never generates one); raster images get GPU mips
    texBytes += Math.round(dims[0] * dims[1] * (k2 ? k2.bpp : 4) * (k2 || mips ? 4 / 3 : 1));
  }
  const texMB = texBytes / 1e6;
  const r = rankOf({ tris, draws, texMB, bones, mats: mats.size, alpha });
  return { tris, draws, mats: mats.size, alpha, bones, texMB: +texMB.toFixed(2), unsizedImages,
    rank: r.rank, rankName: TIER_NAMES[r.rank], worst: r.worst, tiers: r.tiers };
}

const cache = new Map<string, { key: string; perf: GlbPerf | null }>();
/** glbPerf for a file on disk, cached on (size, mtime) — the catalog route runs per keystroke. null = unreadable. */
export function glbPerfOfFile(path: string): GlbPerf | null {
  try {
    const st = statSync(path);
    // ino + ctime too: size + mtime survive a same-size replacement with a restored mtime (see store-variants.ts
    // diskIdentity); ctime can't be restored and a rename-replace changes the inode.
    const key = `${st.size}:${st.mtimeMs}:${st.ino}:${st.ctimeMs}`;
    const hit = cache.get(path);
    if (hit?.key === key) return hit.perf;
    const perf = glbPerfByOffsets(path, st.size);
    cache.set(path, { key, perf });
    return perf;
  } catch { return null; }
}
/** Bytes the last glbPerfOfFile read (a harness checks it stays a header's worth, not the file's). */
export const glbPerfIo = { bytes: 0 };
function glbPerfByOffsets(path: string, size: number): GlbPerf {
  const fd = openSync(path, "r");
  glbPerfIo.bytes = 0;
  const at = (pos: number, n: number) => {
    if (pos < 0 || n < 0 || pos + n > size) throw new Error("GLB read out of range");
    const b = Buffer.alloc(n); readSync(fd, b, 0, n, pos); glbPerfIo.bytes += n;
    return new Uint8Array(b.buffer, b.byteOffset, n);
  };
  try {
    const h = new DataView(at(0, 20).buffer);
    if (h.getUint32(0, true) !== GLB_MAGIC || h.getUint32(4, true) !== 2) throw new Error("not a GLB 2 container");
    const total = h.getUint32(8, true), jsonLen = h.getUint32(12, true);
    if (total > size) throw new Error("declared length exceeds file");   // as parseGlb: a truncated upload has no rank
    if (h.getUint32(16, true) !== CHUNK_JSON || 20 + jsonLen > total) throw new Error("first chunk is not JSON");
    const json = JSON.parse(new TextDecoder().decode(at(20, jsonLen)));
    let binStart = -1, binLen = 0;
    const next = 20 + jsonLen;
    if (next + 8 <= total) {
      const c = new DataView(at(next, 8).buffer);
      if (c.getUint32(4, true) === CHUNK_BIN) { binStart = next + 8; binLen = Math.min(c.getUint32(0, true), total - binStart); }
    }
    return perfOf(json, (bv, max) => {
      const o = bv.byteOffset ?? 0;
      return binStart < 0 || o + bv.byteLength > binLen ? null : at(binStart + o, Math.min(bv.byteLength, max));
    });
  } finally { closeSync(fd); }
}
