// glbparse — the GLB container and raster-header readers, dependency-free (moved out of optimize.ts so the catalog
// route can rank models without importing gltf-transform/sharp).
export const GLB_MAGIC = 0x46546c67;
export const CHUNK_JSON = 0x4e4f534a;
export const CHUNK_BIN = 0x004e4942;
export const KTX2_ID = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
export const align4 = (n: number) => (n + 3) & ~3;

export type GlbParts = { json: any; bin: Uint8Array; total: number };

/** glTF 2.0 binary layout, validated: magic/version, chunk 0 = JSON
 *  (0x4E4F534A), BIN chunk = 0x004E4942. Chunk lengths INCLUDE the spec's
 *  4-byte padding (JSON pads with 0x20 — JSON.parse tolerates it; BIN pads
 *  with zeros — buffers[0].byteLength names the real end). */
export function parseGlb(bytes: Uint8Array): GlbParts {
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

/** PNG IHDR / JPEG SOFn dimensions, without decoding — there is no
 *  gltf-transform Texture here to ask, and sharp stays best-effort-only
 *  (the two-libvips hazard documented at ktx2CompressTextures). */
export function rasterDims(bytes: Uint8Array, mime: string): [number, number] | null {
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
