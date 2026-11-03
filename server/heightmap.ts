// heightmap — terrain as an image, both directions (shared/terrainshape.js).
//
//   POST /upload?as=heightmap   a grayscale PNG (16-bit for smooth ground; 8-bit works, in 256 steps) →
//                               store/heightmaps/<hash>.png (the original) + <hash>.json (the decoded grid)
//   GET  /heightmap?world=W     the world's CURRENT ground (noise, heightmap and features together) as a
//                               16-bit grayscale PNG, its height range in the headers and in a tEXt chunk
//
// The server decodes once and stores integers, so the client, the agents and the sim never each run an image
// decoder over the same bytes and disagree about a pixel. The sim (shared/sim.js, via terrainmath.js) must
// read a grid SYNCHRONOUSLY while folding a log, so this module also gives the shared law its disk loader.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { OPT_DIR } from "./config.ts";
import { decodeGrid, encodeGrid, setGridLoader, MAX_GRID } from "../shared/terrainshape.js";
import { terrainParams, makeHeightField } from "../shared/terrainmath.js";

const GRID_REF = /^store\/heightmaps\/[0-9a-f]{16}\.json$/;
setGridLoader((ref: string) => {
  if (!GRID_REF.test(ref)) return null;
  const p = join(OPT_DIR, ref);
  return existsSync(p) ? decodeGrid(JSON.parse(readFileSync(p, "utf8"))) : null;
});

/** What an export says about itself, so an edited image comes back at the heights it left with. */
export type HeightmapMeta = { min: number; max: number; size: number; world?: string };
const META_KEY = "eidoverse-terrain";

// ---- PNG chunk plumbing (pngjs reads and writes pixels, not text chunks) ----
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function withTextChunk(png: Uint8Array, key: string, text: string): Uint8Array {
  const data = new TextEncoder().encode(`${key}\0${text}`);
  const chunk = new Uint8Array(12 + data.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length);
  chunk.set([0x74, 0x45, 0x58, 0x74], 4);               // "tEXt"
  chunk.set(data, 8);
  dv.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  const at = 8 + 25;                                      // after the signature and IHDR
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, at)); out.set(chunk, at); out.set(png.subarray(at), at + chunk.length);
  return out;
}
function readTextChunk(png: Uint8Array, key: string): string | null {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let o = 8; o + 12 <= png.length;) {
    const len = dv.getUint32(o), type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    if (type === "tEXt") {
      const s = new TextDecoder("latin1").decode(png.subarray(o + 8, o + 8 + len));
      const z = s.indexOf("\0");
      if (z > 0 && s.slice(0, z) === key) return s.slice(z + 1);
    }
    if (type === "IEND") break;
    o += 12 + len;
  }
  return null;
}

/** Decode an uploaded PNG into a grid, and store both. */
export function ingestHeightmap(body: Uint8Array, hash: string):
    { grid: string; png: string; w: number; h: number; bits: number; meta: HeightmapMeta | null } | { error: string; status: number } {
  // Dimensions from the IHDR BEFORE decoding (review on #237): a few KB of PNG can claim a 60000² image,
  // and decoding first would make the serving process unpack and allocate all of it just to refuse it.
  // IHDR is always the first chunk: width and height are big-endian u32s at bytes 16 and 20.
  if (body.length < 24 || String.fromCharCode(...body.subarray(12, 16)) !== "IHDR")
    return { error: "not a PNG with an image header", status: 415 };
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const hw = dv.getUint32(16), hh = dv.getUint32(20);
  if (hw < 2 || hh < 2 || hw > MAX_GRID || hh > MAX_GRID)
    return { error: `heightmap is ${hw}×${hh} — want 2 to ${MAX_GRID} pixels a side (257, 513 or 1025 map evenly)`, status: 413 };
  let img: any;
  try { img = PNG.sync.read(Buffer.from(body), { skipRescale: true }); } catch (e) {
    return { error: `could not read the PNG: ${(e as Error).message}`, status: 415 };
  }
  const w = img.width, h = img.height;
  if (w < 2 || h < 2 || w > MAX_GRID || h > MAX_GRID)
    return { error: `heightmap is ${w}×${h} — want 2 to ${MAX_GRID} pixels a side (257, 513 or 1025 map evenly)`, status: 413 };
  // skipRescale keeps the file's own precision: 16-bit samples arrive as 0..65535 in a Uint16Array, low-bit
  // grayscale as 0..2^depth-1, palette images expanded to 8-bit RGBA. Gray is R=G=B; colour images use the mean.
  const max = img.data instanceof Uint16Array ? 65535 : img.colorType === 3 ? 255 : (1 << img.depth) - 1;
  const data = new Uint16Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
    data[i] = Math.round(((r + g + b) / 3) * 65535 / max);
  }
  let meta: HeightmapMeta | null = null;
  try {
    const t = readTextChunk(body, META_KEY);
    if (t) { const m = JSON.parse(t); if (Number.isFinite(m.min) && Number.isFinite(m.max)) meta = m; }
  } catch { /* an editor rewrote the chunk: the caller supplies the range */ }
  const dir = join(OPT_DIR, "store", "heightmaps");
  mkdirSync(dir, { recursive: true });
  const png = `store/heightmaps/${hash}.png`, grid = `store/heightmaps/${hash}.json`;
  if (!existsSync(join(OPT_DIR, png))) writeFileSync(join(OPT_DIR, png), body);
  if (!existsSync(join(OPT_DIR, grid))) writeFileSync(join(OPT_DIR, grid), JSON.stringify(encodeGrid({ w, h, data })));
  return { grid, png, w, h, bits: img.data instanceof Uint16Array ? 16 : img.depth, meta };
}

// Exports run on the thread that serves the worlds (review on #237), so their work is BOUNDED, and the
// bound is checked BEFORE any work is done:
//   · at most EXPORT_MAX samples a side;
//   · the last EXPORT_CACHE results kept by (terrain, resolution) — a terrain that has not changed is
//     never re-sampled, and a cached answer costs nothing and is never refused;
//   · an uncached export must first be granted a slot: EXPORT_PER_ADDRESS a minute per address, and
//     EXPORT_PER_MINUTE a minute for the whole process (so many addresses cannot add up to a busy thread),
//     and only one at a time. A refused request does no sampling and caches nothing.
export const EXPORT_MAX = 513;
export const EXPORT_CACHE = 6;
export const EXPORT_PER_ADDRESS = 6;
export const EXPORT_PER_MINUTE = 30;
const WINDOW_MS = 60_000;
const exportCache = new Map<string, { png: Uint8Array; meta: HeightmapMeta }>();
const byAddress = new Map<string, number[]>();   // address -> start times of its granted exports, this window
let granted: number[] = [];                       // every granted export's start time, this window
let exporting = false;

const exportKey = (terrainArgs: Record<string, unknown>, n: number, world?: string) => `${n}|${world ?? ""}|${JSON.stringify(terrainArgs)}`;
const clampRes = (res: number) => Math.max(2, Math.min(EXPORT_MAX, Math.round(Number.isFinite(res) ? res : 257)));

export type ExportAnswer =
  | { ok: true; png: Uint8Array; meta: HeightmapMeta; cached: boolean }
  | { ok: false; status: 429 | 503; error: string; retryAfter: number };

/** The public export door: a cached answer if there is one; else a granted slot, THEN the work. */
export function serveHeightmapExport(terrainArgs: Record<string, unknown>, res: number, world: string | undefined,
    address: string, now = Date.now()): ExportAnswer {
  const n = clampRes(res), key = exportKey(terrainArgs, n, world);
  const hit = exportCache.get(key);
  if (hit) { exportCache.delete(key); exportCache.set(key, hit); return { ok: true, ...hit, cached: true }; }
  // ---- the gate: nothing below it runs unless a slot is granted
  if (exporting) return { ok: false, status: 503, error: "another heightmap export is running — try again in a moment", retryAfter: 1 };
  granted = granted.filter((t) => now - t < WINDOW_MS);
  const mine = (byAddress.get(address) ?? []).filter((t) => now - t < WINDOW_MS);
  if (mine.length >= EXPORT_PER_ADDRESS)
    return { ok: false, status: 429, error: `heightmap export rate limit (${EXPORT_PER_ADDRESS} new exports a minute)`, retryAfter: Math.ceil((WINDOW_MS - (now - mine[0])) / 1000) };
  if (granted.length >= EXPORT_PER_MINUTE)
    return { ok: false, status: 429, error: `the server is busy exporting heightmaps (${EXPORT_PER_MINUTE} a minute in all)`, retryAfter: Math.ceil((WINDOW_MS - (now - granted[0])) / 1000) };
  mine.push(now); granted.push(now); byAddress.set(address, mine);
  if (byAddress.size > 1024) for (const [a, ts] of byAddress) if (!ts.some((t) => now - t < WINDOW_MS)) byAddress.delete(a);
  // ---- the work, under the slot
  exporting = true;
  try {
    const out = exportHeightmap(terrainArgs, n, world);
    exportCache.set(key, out);
    while (exportCache.size > EXPORT_CACHE) exportCache.delete(exportCache.keys().next().value!);
    return { ok: true, ...out, cached: false };
  } finally { exporting = false; }
}

/** Tests: whether an export is cached, without touching the cache's order; and a clean slate. */
export const exportIsCached = (terrainArgs: Record<string, unknown>, res: number, world?: string) => exportCache.has(exportKey(terrainArgs, clampRes(res), world));
export function resetExportBudget() { exportCache.clear(); byAddress.clear(); granted = []; exporting = false; }

/** The ground's height range alone, from a coarse sampling — what the panel's black/white fields want,
 *  without building (or caching) a PNG. */
export function heightRange(terrainArgs: Record<string, unknown>): HeightmapMeta {
  const P = terrainParams(terrainArgs), hf = makeHeightField(P), n = 129;
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const y = hf((i / (n - 1) - 0.5) * P.size, (j / (n - 1) - 0.5) * P.size);
    if (y < lo) lo = y; if (y > hi) hi = y;
  }
  return { min: lo, max: hi > lo ? hi : lo + 1, size: P.size };
}

/** A world's current ground, sampled into a 16-bit PNG. `res` samples a side, spanning the terrain's `size`
 *  square edge to edge — so a re-import at the same size lands every sample back where it was taken. */
export function exportHeightmap(terrainArgs: Record<string, unknown>, res: number, world?: string):
    { png: Uint8Array; meta: HeightmapMeta } {
  const P = terrainParams(terrainArgs);
  const hf = makeHeightField(P);
  const n = Math.max(2, Math.min(MAX_GRID, Math.round(res)));
  const hs = new Float64Array(n * n);
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = (i / (n - 1) - 0.5) * P.size, z = (j / (n - 1) - 0.5) * P.size;
    const y = hf(x, z); hs[j * n + i] = y;
    if (y < lo) lo = y; if (y > hi) hi = y;
  }
  if (!(hi > lo)) hi = lo + 1;                            // a flat world still maps to a real range
  const img = new PNG({ width: n, height: n, bitDepth: 16, colorType: 0, inputColorType: 0, inputHasAlpha: false });
  const buf = Buffer.alloc(n * n * 2);
  for (let k = 0; k < n * n; k++) buf.writeUInt16LE(Math.round(((hs[k] - lo) / (hi - lo)) * 65535), k * 2);   // pngjs takes 16-bit input little-endian
  img.data = buf;
  const meta: HeightmapMeta = { min: lo, max: hi, size: P.size, ...(world ? { world } : {}) };
  const png = PNG.sync.write(img, { bitDepth: 16, colorType: 0, inputColorType: 0, inputHasAlpha: false });
  return { png: withTextChunk(new Uint8Array(png), META_KEY, JSON.stringify(meta)), meta };
}
