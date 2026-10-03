// bun tools/ktx2-tf-purge-test.ts — the purge tool's two detectors on synthetic KTX2 headers: a ktx-create image with
// a LINEAR transfer (converted data map), and an image over the texel cap (built before the cap). Each must say yes to
// its case and no to the other's, and nothing to a non-KTX2 buffer.
import { convertedLinear, overCap, staleOversize } from "./ktx2-tf-purge.ts";
import { KTX2_TEXEL_CAP } from "../server/store-variants.ts";
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, got?: unknown) => { if (ok) pass++; else fail++; console.log(`  ${ok ? "✓" : "✗"} ${n}${ok ? "" : `  got ${JSON.stringify(got)}`}`); };
function ktx2({ w, h, tf, writer }: { w: number; h: number; tf: number; writer: string }): Uint8Array {
  const kv = new TextEncoder().encode(`KTXwriter\0${writer}\0`);
  const dfd = 104, kvd = dfd + 48, b = new Uint8Array(kvd + kv.length + 8), dv = new DataView(b.buffer);
  b.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  dv.setUint32(20, w, true); dv.setUint32(24, h, true);
  dv.setUint32(48, dfd, true); dv.setUint32(56, kvd, true); dv.setUint32(60, kv.length, true);
  b[dfd + 4 + 10] = tf;                      // transferFunction in the basic DFD block: 1 = linear, 2 = sRGB
  b.set(kv, kvd); return b;
}
const lin = ktx2({ w: 1024, h: 1024, tf: 1, writer: "ktx create v4.4" }), srgb = ktx2({ w: 1024, h: 1024, tf: 2, writer: "ktx create v4.4" });
const big = ktx2({ w: 2048, h: 2048, tf: 2, writer: "ktx create v4.4" }), atCap = ktx2({ w: KTX2_TEXEL_CAP, h: 512, tf: 2, writer: "toktx" });
check("a ktx-create LINEAR image is a converted data map", convertedLinear(lin));
check("…an sRGB one is not (colour was never affected)", !convertedLinear(srgb));
check("a 2048² image is over the cap; one AT the cap is not", overCap(big) && !overCap(atCap), [overCap(big), overCap(atCap)]);
check("…and a 1024² linear map is not over the cap (the detectors are independent)", !overCap(lin));
check("a non-KTX2 buffer is neither", !convertedLinear(new Uint8Array(100)) && !overCap(new Uint8Array(100)));
check("an UNMARKED over-cap image in a GLB variant is purged for size", staleOversize("store/x.glb.ktx2.glb", [{ marked: false, bytes: big }]));
check("…a MARKED over-cap image is not (today's encoder kept it; purging would loop)", !staleOversize("store/x.glb.ktx2.glb", [{ marked: true, bytes: big }]));
check("…and an avatar variant never is (the VRM arm does not resize)", !staleOversize("a/b.vrm.ktx2.vrm", [{ marked: false, bytes: big }]));
// --apply takes a purged variant's verdict markers with it, or the boot sweep (which honours a standing .failed) would
// never rebuild it (Greptile #207); an unrelated variant's markers stay
{ const { mkdtempSync, writeFileSync, existsSync } = await import("node:fs"); const { tmpdir } = await import("node:os");
  const root = mkdtempSync(`${tmpdir()}/purge-`);
  writeFileSync(`${root}/a.ktx2`, lin); writeFileSync(`${root}/a.ktx2.failed`, "kind=failure\n"); writeFileSync(`${root}/a.ktx2.deferred`, "budget");
  writeFileSync(`${root}/b.ktx2`, srgb); writeFileSync(`${root}/b.ktx2.failed`, "kind=failure\n");
  const r = Bun.spawnSync(["bun", new URL("./ktx2-tf-purge.ts", import.meta.url).pathname, root, "--apply"]);
  const gone = (f: string) => !existsSync(`${root}/${f}`);
  check("--apply removes a purged variant AND its .failed/.deferred (so the sweep rebuilds it)", gone("a.ktx2") && gone("a.ktx2.failed") && gone("a.ktx2.deferred"),
    { out: new TextDecoder().decode(r.stdout).slice(-300), left: ["a.ktx2", "a.ktx2.failed", "a.ktx2.deferred"].filter((f) => !gone(f)) });
  check("…and leaves a variant it didn't purge, and that variant's marker, alone", !gone("b.ktx2") && !gone("b.ktx2.failed")); }
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
