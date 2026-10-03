// bun tools/ktx2-transfer-test.ts — a KTX2 encode keeps a texture's VALUES: data maps (normal, metallic-roughness,
// occlusion) come back as they went in, colour maps too. Real encoder (findKtx2Encoder), the production argv
// (ktx2EncodeArgs), decoded with `ktx extract --transcode rgba8`. The regression it pins: ktx create read 8-bit PNGs
// as sRGB and CONVERTED them for a linear format — a flat normal (127) came out 54 (09-24, the rubble pile).
import { findKtx2Encoder, ktx2EncodeArgs } from "../server/optimize.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "\x1b[32m✓" : "\x1b[31m✗"}\x1b[0m ${n}${ok ? "" : `  ${d}`}`); };
const enc = findKtx2Encoder();
if (!enc) { console.log("  (no KTX2 encoder on this host — nothing to test)"); process.exit(0); }
const isToktx = enc.toLowerCase().includes("toktx");
const ktxBin = isToktx ? null : enc;   // decode needs `ktx extract`
const tmp = mkdtempSync(join(tmpdir(), "ew-tf-"));
try {
  const sharp = (await import("sharp")).default;
  // 64×64, four flat quadrants: the flat normal, two ramp points, and a bright value
  const W = 64, vals = [127, 64, 192, 250];
  const raw = Buffer.alloc(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const v = vals[(y >= W / 2 ? 2 : 0) + (x >= W / 2 ? 1 : 0)], i = (y * W + x) * 4;
    raw[i] = raw[i + 1] = v; raw[i + 2] = 255 - v; raw[i + 3] = 255;
  }
  const png = join(tmp, "in.png");
  await sharp(raw, { raw: { width: W, height: W, channels: 4 } }).png().toFile(png);
  const decode = async (k: string) => {
    const out = k.replace(/\.ktx2$/, ".png");
    const p = Bun.spawn([ktxBin ?? "ktx", "extract", "--transcode", "rgba8", "--level", "0", k, out], { stderr: "pipe" });
    if (await p.exited) throw new Error(await new Response(p.stderr).text());
    const { data, info } = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width !== W || info.height !== W || info.channels !== 4) throw new Error(`decoded ${info.width}x${info.height}x${info.channels}, expected ${W}x${W}x4`);
    return new Uint8Array(data);
  };
  for (const [label, srgb, uastc] of [["data map (linear, UASTC)", false, true], ["colour map (sRGB, ETC1S)", true, false], ["colour map (sRGB, UASTC)", true, true]] as const) {
    const out = join(tmp, `${label.replace(/\W+/g, "_")}.ktx2`);
    const p = Bun.spawn(ktx2EncodeArgs(enc, isToktx, srgb, uastc, png, out), { stdout: "ignore", stderr: "pipe" });
    if (await p.exited) { check(`${label}: encodes`, false, await new Response(p.stderr).text()); continue; }
    const px = await decode(out);
    const got = vals.map((_, q) => { const x = (q & 1 ? 3 : 1) * W / 4, y = (q & 2 ? 3 : 1) * W / 4; return px[(y * W + x) * 4]; });
    const worst = Math.max(...got.map((g, q) => Math.abs(g - vals[q])));
    check(`${label}: values survive (in ${vals} → out ${got})`, worst <= 6, `worst |Δ| ${worst}`);
  }
} catch (e) { check("test ran", false, String(e).slice(0, 300)); }
finally { rmSync(tmp, { recursive: true, force: true }); }
console.log(`${fail ? "\x1b[31m" : "\x1b[32m"}${pass} passed, ${fail} failed\x1b[0m`); process.exit(fail ? 1 : 0);
