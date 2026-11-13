// bun tools/glbperf-file-test.ts — glbPerfOfFile ranks a GLB on disk from its header, JSON chunk and image HEADS (offset
// reads; the catalog route runs on the sequencer thread), with the same numbers as glbPerf over the whole file:
// a PNG behind 2 MB of vertex data; a JPEG whose SOF sits past the 64 KB head (the retry reads that one image); a
// truncated file is unreadable (null), never a partial rank.
import { mkdtempSync, writeFileSync, readFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { glbPerf, glbPerfOfFile, glbPerfIo } = await import("../server/glbperf.ts");
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d: unknown = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "\x1b[32m✓" : "\x1b[31m✗"}\x1b[0m ${n}${ok ? "" : `  ${JSON.stringify(d)}`}`); };
const pad4 = (b: Uint8Array, fill = 0) => { const o = new Uint8Array((b.length + 3) & ~3).fill(fill); o.set(b); return o; };
function glb(image: Uint8Array, mime: string, filler: number) {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const fill = new Uint8Array(filler);
  const parts = [new Uint8Array(pos.buffer), fill, image].map((p) => pad4(p));
  const offs: number[] = []; let o = 0; for (const p of parts) { offs.push(o); o += p.length; }
  const bin = new Uint8Array(o); parts.forEach((p, i) => bin.set(p, offs[i]));
  const json = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }], textures: [{ source: 0 }],
    images: [{ bufferView: 2, mimeType: mime }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
    bufferViews: [{ buffer: 0, byteOffset: offs[0], byteLength: 36 }, { buffer: 0, byteOffset: offs[1], byteLength: filler },
      { buffer: 0, byteOffset: offs[2], byteLength: image.length }], buffers: [{ byteLength: bin.length }] };
  const js = pad4(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const out = new Uint8Array(12 + 8 + js.length + 8 + bin.length); const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, js.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(js, 20);
  dv.setUint32(20 + js.length, bin.length, true); dv.setUint32(24 + js.length, 0x004e4942, true); out.set(bin, 28 + js.length);
  return out;
}
const png = new Uint8Array(64); png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
new DataView(png.buffer).setUint32(16, 512); new DataView(png.buffer).setUint32(20, 256);
const app = (len: number) => { const s = new Uint8Array(len + 2); s[0] = 0xff; s[1] = 0xe1; new DataView(s.buffer).setUint16(2, len); return s; };
const sof = new Uint8Array([0xff, 0xc0, 0, 17, 8, 0x01, 0x00, 0x02, 0x00, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);   // 512 wide, 256 tall
const jpg = new Uint8Array([0xff, 0xd8, ...app(40000), ...app(40000), ...sof]);
const dir = mkdtempSync(join(tmpdir(), "glbperf-"));
for (const [name, img, mime, filler] of [["png", png, "image/png", 2_000_000], ["jpeg-late-sof", jpg, "image/jpeg", 1_000_000]] as const) {
  const f = join(dir, `${name}.glb`); writeFileSync(f, glb(img, mime, filler));
  const whole = glbPerf(new Uint8Array(readFileSync(f))), byFile = glbPerfOfFile(f);
  check(`${name}: same numbers as the whole-file rank, texture sized (512×256)`, JSON.stringify(whole) === JSON.stringify(byFile)
    && whole.unsizedImages === 0 && whole.texMB > 0.6, { whole, byFile });
  const limit = name === "png" ? 70_000 : 150_000;   // header + JSON + ≤64 KB head (+ the one JPEG, retried up to 1 MB)
  check(`${name}: read ${glbPerfIo.bytes} bytes of a ${readFileSync(f).length}-byte file (≤ ${limit})`, glbPerfIo.bytes <= limit, glbPerfIo.bytes);
}
// a JPEG whose SOF sits behind ~3 MB of APP blocks: the retry stops at its 1 MB ceiling and bills it unsized, rather
// than reading the whole image on the sequencer thread (Greptile #207)
{ const blocks = []; for (let i = 0; i < 48; i++) blocks.push(...app(65000));
  const deep = new Uint8Array([0xff, 0xd8, ...blocks, ...sof]);
  const f = join(dir, "jpeg-deep-sof.glb"); writeFileSync(f, glb(deep, "image/jpeg", 1000));
  const p = glbPerfOfFile(f);
  check(`a JPEG with its SOF ${(deep.length / 1e6).toFixed(1)} MB deep: read ${glbPerfIo.bytes} bytes (≤ 1.2 MB), billed unsized`,
    glbPerfIo.bytes <= 1_200_000 && p?.unsizedImages === 1, [glbPerfIo.bytes, p?.unsizedImages]); }
// an image nothing can size (here AVIF) is unsized from its head; only a JPEG is ever re-read whole
{ const f = join(dir, "avif.glb"); writeFileSync(f, glb(new Uint8Array(900_000).fill(7), "image/avif", 1000));
  const p = glbPerfOfFile(f);
  check(`an unsizeable 900 KB AVIF is billed unsized from its head (read ${glbPerfIo.bytes} bytes)`, p?.unsizedImages === 1 && glbPerfIo.bytes < 70_000, [p?.unsizedImages, glbPerfIo.bytes]); }
// bones = the largest skin a SkinnedMesh actually uses (the loupe's rule), not the largest skin in the file: a 16-joint
// skin on the mesh plus an unused 100-joint skin ranks 16 (Greptile #207)
{ const g = glb(png, "image/png", 64); const dv = new DataView(g.buffer); const jl = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(g.subarray(20, 20 + jl)));
  const joint = (i: number) => ({ name: `j${i}` });
  json.nodes = [{ mesh: 0, skin: 0 }, ...Array.from({ length: 100 }, (_, i) => joint(i))];
  json.skins = [{ joints: Array.from({ length: 16 }, (_, i) => i + 1) }, { joints: Array.from({ length: 100 }, (_, i) => i + 1) }];
  const js = pad4(new TextEncoder().encode(JSON.stringify(json)), 0x20), bin = g.subarray(20 + jl);
  const out = new Uint8Array(20 + js.length + bin.length); const ov = new DataView(out.buffer);
  out.set(g.subarray(0, 12)); ov.setUint32(8, out.length, true); ov.setUint32(12, js.length, true); ov.setUint32(16, 0x4e4f534a, true);
  out.set(js, 20); out.set(bin, 20 + js.length);
  const p = glbPerf(out);
  check(`an unused 100-joint skin doesn't count: bones = the used skin's 16 (got ${p?.bones})`, p?.bones === 16, p);
  json.nodes[0] = { mesh: 0 };   // no node uses any skin: nothing is skinned
  const js2 = pad4(new TextEncoder().encode(JSON.stringify(json)), 0x20), o2 = new Uint8Array(20 + js2.length + bin.length); const v2 = new DataView(o2.buffer);
  o2.set(g.subarray(0, 12)); v2.setUint32(8, o2.length, true); v2.setUint32(12, js2.length, true); v2.setUint32(16, 0x4e4f534a, true); o2.set(js2, 20); o2.set(bin, 20 + js2.length);
  check(`skins no mesh node uses cost nothing (got ${glbPerf(o2)?.bones})`, glbPerf(o2)?.bones === 0); }
const whole = readFileSync(join(dir, "png.glb")); writeFileSync(join(dir, "cut.glb"), whole.subarray(0, whole.length - 100_000));
check("a truncated file is unreadable (null), not a partial rank", glbPerfOfFile(join(dir, "cut.glb")) === null);
// antra's collision (#207 review, 09-29): the rank cache was keyed on size + mtime. A same-size replacement with the
// mtime restored kept the old file's rank. Here the PNG head goes 512×256 → 256×256: same length, different cost.
{ const f = join(dir, "swap.glb"); writeFileSync(f, glb(png, "image/png", 1000));
  const before = glbPerfOfFile(f), st0 = statSync(f);
  const small = png.slice(); new DataView(small.buffer).setUint32(16, 256);
  writeFileSync(f, glb(small, "image/png", 1000)); utimesSync(f, st0.mtimeMs / 1000, st0.mtimeMs / 1000);
  const st1 = statSync(f), after = glbPerfOfFile(f), fresh = glbPerf(new Uint8Array(readFileSync(f)));
  check("collision setup: same size and mtime after the replacement", st1.size === st0.size && st1.mtimeMs === st0.mtimeMs, [st0.size, st1.size, st0.mtimeMs, st1.mtimeMs]);
  check("a same-size replacement with its mtime restored is re-ranked (not the cached rank of the old bytes)",
    JSON.stringify(after) === JSON.stringify(fresh) && JSON.stringify(after) !== JSON.stringify(before), [before, after]); }
console.log(`${fail ? "\x1b[31m" : "\x1b[32m"}${pass} passed, ${fail} failed\x1b[0m`); process.exit(fail ? 1 : 0);
