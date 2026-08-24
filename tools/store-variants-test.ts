// The store's KTX2 shadow (server/store-variants.ts), run headless.
//
//   bun tools/store-variants-test.ts
//   KTX2_TOKTX=/path/to/toktx bun tools/store-variants-test.ts   # + the encode section
//
// The contract under test: a store upload gets a KTX2 variant BESIDE the
// original (store/<hash>.glb.ktx2.glb — the library's <rel>.ktx2.glb
// convention, which is the path /library?ktx2=1 already resolves), the
// variant is built from the ORIGINAL and is really KTX2 (KHR_texture_basisu
// required, every image image/ktx2 — the #122 shape is exactly what a webp
// fall-through looks like), and the ghost-listing rule — a variant is never
// enumerated as an upload of its own: not by the store catalog
// (/library-models), not by the directory listing the prefetcher warms from
// (/library-list), not by the boot sweep, not by the "what does this original
// still lack" question. Plus the serving rule that makes any of it reach a
// client: a flagged fetch answered by the webp shadow is PROVISIONAL —
// no-cache, never immutable — so the variant's bytes get through the moment
// it exists, instead of being pinned out for a year.
//
// Sections 1-2 are pure and always run. Section 3 spawns the real
// optimize.ts --ktx2 CLI on a fixture upload and is gated on an encoder the
// way the server is: none on this box → reported as skipped, never as a
// failure (the exit-3 doctrine — environmental, not a .failed). Section 4
// spawns the real sequencer (the deps-route-test pattern: verified-free port,
// nonce-proven ownership) and fetches the store fixture the way a browser
// does — with and without the flag, with and without the variant on disk —
// asserting bytes AND cache-control. It needs no encoder: which FILE answers
// is the question, not what is in it.
//
// Negative control: on the branch base this file dies at import
// (server/store-variants.ts does not exist). Of the serving checks, main
// fails "flagged → variant" (nothing ever wrote that path) and "flagged
// fall-through is provisional" (the show box, 2026-08-24: every store
// ?ktx2=1 answer immutable, every one webp).

import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, rmdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { PNG } from "pngjs";
import { isStoreOriginal, isKtx2Variant, ktx2VariantPath, storeShadowsMissing, KTX2_SUFFIX } from "../server/store-variants.ts";
import { findKtx2Encoder } from "../server/optimize.ts";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${!ok && detail ? `\n      ${detail}` : ""}`);
  if (!ok) failures++;
};

console.log("\nthe store's KTX2 shadow (store-variants.ts):\n");

// ---------------------------------------------- 1. the pure contract
{
  const OPT = "/srv/assets/opt";                    // any base; only the shape matters
  const hash = "305ea80018ad4dbf";                  // #122's lantern, for the record
  const rel = `store/${hash}.glb`;
  const original = join(OPT, rel);

  check("an upload is a store original", isStoreOriginal(`${hash}.glb`));
  check("its KTX2 variant is NOT (it is the same model)", !isStoreOriginal(`${hash}.glb${KTX2_SUFFIX}`));
  check("the manifest is not", !isStoreOriginal("manifest.json"));
  check("a .failed marker is not", !isStoreOriginal(`${hash}.glb${KTX2_SUFFIX}.failed`));
  check("a body is not (store holds models only)", !isStoreOriginal("someone.vrm"));

  check("the variant lives beside the original", ktx2VariantPath(original) === join(OPT, `store/${hash}.glb.ktx2.glb`),
    ktx2VariantPath(original));
  // The serving contract, stated the way routes.ts states it — a flagged
  // fetch for rel resolves join(OPT_DIR, `${rel}.ktx2.glb`). The two files
  // must agree on that path WITHOUT importing each other; this is the check
  // that names the gap on main (routes resolved it, nothing wrote it).
  const routesResolution = join(OPT, `${rel}.ktx2.glb`);
  check("…which is exactly the path /library?ktx2=1 resolves (routes.ts)", ktx2VariantPath(original) === routesResolution,
    `wrote ${ktx2VariantPath(original)}, routes reads ${routesResolution}`);

  const minDir = join(OPT, "store-min");
  const missing = (present: string[]) => storeShadowsMissing(original, minDir, (p) => present.includes(p));
  let m = missing([]);
  check("a fresh upload lacks both shadows", m.min && m.ktx2);
  m = missing([join(minDir, `${hash}.glb`)]);
  check("store-min present → only the KTX2 shadow is missing", !m.min && m.ktx2);
  m = missing([join(minDir, `${hash}.glb.failed`)]);
  check("a store-min .failed counts as answered (never re-measured)", !m.min && m.ktx2);
  m = missing([ktx2VariantPath(original)]);
  check("variant present → only store-min is missing", m.min && !m.ktx2);
  m = missing([`${ktx2VariantPath(original)}.failed`]);
  check("a variant .failed counts as answered too", m.min && !m.ktx2);
  m = missing([join(minDir, `${hash}.glb`), ktx2VariantPath(original)]);
  check("both present → nothing to queue", !m.min && !m.ktx2);
}

// ---------------------------------------------- 2. the ghost-listing rule
{
  // What readdirSync(store/) returns once variants exist. The catalog and the
  // boot sweep both filter with isStoreOriginal; endsWith(".glb") — what
  // they used to do — lists the variant as a second "conjured 305ea800…"
  // and queues it for shadows of its own.
  const listing = ["305ea80018ad4dbf.glb", "305ea80018ad4dbf.glb.ktx2.glb", "305ea80018ad4dbf.glb.ktx2.glb.failed",
    "a1b2c3d4e5f60718.glb", "manifest.json", "scripts"];
  const originals = listing.filter(isStoreOriginal);
  check("the catalog lists each upload once", originals.length === 2 && originals[0] === "305ea80018ad4dbf.glb" && originals[1] === "a1b2c3d4e5f60718.glb",
    originals.join(", "));
  check("…and endsWith(\".glb\") would have listed the ghost (the old predicate)",
    listing.filter((f) => f.endsWith(".glb")).length === 3);

  // The listing rule is one predicate for every asset class the §20 arc
  // shadows — what /library-list must skip so the prefetcher (which warms
  // every listed .glb/.vrm with ?ktx2=1) never pulls a variant twice.
  for (const v of ["x.glb.ktx2.glb", "aletheia.vrm.ktx2.vrm", "moon_color_1k.jpg.ktx2", "grass_01.png.ktx2", "UPPER.GLB.KTX2.GLB"])
    check(`${v} is a variant`, isKtx2Variant(v));
  for (const o of ["x.glb", "aletheia.vrm", "moon_color_1k.jpg", "x.glb.ktx2.glb.failed", "manifest.json", "sky_system.js"])
    check(`${o} is not`, !isKtx2Variant(o));
}

// ---------------------------------------------- fixtures: two distinct GLBs
// A 256² varying PNG — 4-aligned, so optimize.ts hands it to the encoder
// as-is (no sharp in the loop: this file is about the KTX2 arm, and
// one-libvips-test.ts already owns the webp/sharp story). It has to VARY:
// prune() folds a solid texture into baseColorFactor and drops it.
// The node name carries a per-run nonce, so the content hash — and with it
// the store path — is unique to THIS run: the fixture is its own ownership
// proof in section 4 (only the tree we spawn from has it).
const NONCE = crypto.randomUUID();
async function fixtureGlb(tag: string): Promise<Uint8Array> {
  const W = 256, png = new PNG({ width: W, height: W });
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      png.data[i] = x; png.data[i + 1] = y; png.data[i + 2] = (x ^ y) & 0xff; png.data[i + 3] = 255;
    }
  const doc = new Document();
  const buf = doc.createBuffer();
  const tex = doc.createTexture("probe").setImage(new Uint8Array(PNG.sync.write(png))).setMimeType("image/png");
  const mat = doc.createMaterial("probeMat").setBaseColorTexture(tex);
  const prim = doc.createPrimitive().setMaterial(mat)
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setBuffer(buf)
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])))
    // UVs are load-bearing: without them prune() reads the texture as
    // unreferenced and drops it, and the pass has nothing to encode
    .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setBuffer(buf)
      .setArray(new Float32Array([0, 0, 1, 0, 0, 1])));
  const mesh = doc.createMesh("probeMesh").addPrimitive(prim);
  const scene = doc.createScene("s").addChild(doc.createNode(`${tag}-${NONCE}`).setMesh(mesh));
  // The stand-in variant must differ from the original in SIZE, not just in
  // bytes: serveFrom's ETag is size+mtime, and two same-size files written in
  // the same millisecond share one — which is a fixture artifact (a real
  // variant is never the size of the webp shadow), not the contract.
  if (tag !== "original") scene.addChild(doc.createNode(`${tag}-second-node-so-the-size-differs`));
  return new NodeIO().writeBinary(doc);
}
const glb = await fixtureGlb("original");
const hash = new Bun.CryptoHasher("sha256").update(glb).digest("hex").slice(0, 16);
const glbJson = (bytes: Uint8Array) => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + dv.getUint32(12, true))));
};

// ---------------------------------------------- 3. the encode, end to end (encoder permitting)
const encoder = findKtx2Encoder();
if (!encoder) {
  console.log("\n  - encode: skipped — no KTX2 encoder on this box (set KTX2_TOKTX or put toktx/ktx on PATH; docs/ktx2-encoder.md)");
} else {
  console.log(`\n  the encode, with ${encoder}:`);
  const tmp = mkdtempSync(join(tmpdir(), "ew-store-ktx2-"));
  try {
    // Land it the way POST /upload does: content-addressed under store/.
    const store = join(tmp, "store"), minDir = join(tmp, "store-min");
    mkdirSync(store, { recursive: true });
    const original = join(store, `${hash}.glb`);
    writeFileSync(original, glb);
    const dest = ktx2VariantPath(original);

    // The exact spawn upload.ts's pump makes for a --ktx2 item.
    const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "../server/optimize.ts"), "--ktx2", original, dest],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, KTX2_TOKTX: encoder } });
    const code = await proc.exited;
    const err = (await new Response(proc.stderr).text()).trim();
    check("optimize.ts --ktx2 wrote the variant (exit 0)", code === 0, `exit ${code}: ${err.split("\n").pop() ?? ""}`);
    check("…at the path beside the original", existsSync(dest), dest);

    if (existsSync(dest)) {
      const json = glbJson(new Uint8Array(await Bun.file(dest).arrayBuffer()));
      const req: string[] = json.extensionsRequired ?? [];
      check("the variant REQUIRES KHR_texture_basisu (a real KTX2 variant, not a webp fall-through)",
        req.includes("KHR_texture_basisu"), req.join(", "));
      check("…and draco, the rest of the §20a diet", req.includes("KHR_draco_mesh_compression"), req.join(", "));
      const mimes: string[] = (json.images ?? []).map((im: any) => im.mimeType);
      check("every image is image/ktx2", mimes.length > 0 && mimes.every((m) => m === "image/ktx2"), mimes.join(", "));
      check("no image is webp (the #122 shape)", !mimes.includes("image/webp"));
    }

    // With a real variant on disk: the enumeration questions, asked of the disk.
    const listed = readdirSync(store).filter(isStoreOriginal);
    check("the catalog would list exactly the one upload", listed.length === 1 && listed[0] === `${hash}.glb`, listed.join(", "));
    const m = storeShadowsMissing(original, minDir);
    check("the boot sweep sees the KTX2 shadow as done, store-min as still owed", !m.ktx2 && m.min);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------- 4. serving, through the real sequencer
console.log("\n  serving, through the real sequencer:");
{
  // OPT_DIR is this checkout's assets/opt (gitignored) — the only tree the
  // server reads, so the fixture goes there, under its content hash, and
  // comes out again in cleanup. A stand-in variant: section 4 asks WHICH
  // file answers a URL and how it is cached, not what a KTX2 file contains
  // (section 3's job) — so it runs on a box with no encoder, which is also
  // the box that most needs the provisional rule.
  const variant = await fixtureGlb("variant");
  const OPT = join(import.meta.dir, "..", "assets", "opt");
  const storeDir = join(OPT, "store"), minDir = join(OPT, "store-min");
  const madeStore = !existsSync(storeDir), madeMin = !existsSync(minDir);
  mkdirSync(storeDir, { recursive: true }); mkdirSync(minDir, { recursive: true });
  const original = join(storeDir, `${hash}.glb`);
  const variantPath = ktx2VariantPath(original);
  // a store-min .failed: "already lean, serve the original" — so the child's
  // boot sweep has nothing to build for this hash and the unflagged answer is
  // deterministic (the original), not a race with a subprocess
  const minFailed = join(minDir, `${hash}.glb.failed`);
  writeFileSync(original, glb); writeFileSync(variantPath, variant); writeFileSync(minFailed, "fixture");

  // deps-route-test's two defenses: a verifiably-free port, and ownership.
  let PORT = 0;
  for (let i = 0; i < 20 && !PORT; i++) {
    const cand = 20000 + Math.floor(Math.random() * 20000);
    try { await fetch(`http://127.0.0.1:${cand}/`, { signal: AbortSignal.timeout(400) }); }
    catch { PORT = cand; }
  }
  // process.execPath, not "bun" (the Windows .cmd shim dies at launch and
  // kill() reaps nothing — the stale-listener trap). An EMPTY library and no
  // encoder for the child: its boot sweeps must find nothing to encode.
  const env: Record<string, string | undefined> = { ...process.env, PORT: String(PORT),
    WORLDS_DIR: mkdtempSync(join(tmpdir(), "ew-store-serve-")), EIDOVERSE_DIR: mkdtempSync(join(tmpdir(), "ew-empty-lib-")) };
  delete env.KTX2_TOKTX;
  const server = spawn(process.execPath, [join(import.meta.dir, "..", "server", "server.ts")], { env, stdio: "ignore" });
  const cleanup = () => {
    try { server.kill(); } catch { /* already gone */ }
    for (const p of [original, variantPath, minFailed]) try { rmSync(p, { force: true }); } catch { /* best effort */ }
    if (madeStore) try { rmdirSync(storeDir); } catch { /* not empty — someone else's uploads */ }
    if (madeMin) try { rmdirSync(minDir); } catch { /* same */ }
  };
  process.on("exit", cleanup);

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/`); up = true; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  check("child server came up on a verified-free port", up, `:${PORT}`);

  const url = (flag: boolean) => `http://127.0.0.1:${PORT}/library/store/${hash}.glb${flag ? "?ktx2=1" : ""}`;
  const get = async (flag: boolean) => {
    const res = await fetch(url(flag));
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, cc: res.headers.get("cache-control") ?? "", etag: res.headers.get("etag") ?? "", bytes };
  };
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
  const whichFile = (b: Uint8Array) => { try { return String(glbJson(b).nodes?.[0]?.name ?? "?").split("-")[0]; } catch { return "unparseable"; } };

  if (up) {
    // ownership: only the tree we spawned from holds this run's fixture
    const plain = await get(false);
    const owned = plain.status === 200 && same(plain.bytes, glb);
    check("listener is OUR child (the fixture round-trips), not a squatter", owned, `status=${plain.status} file=${whichFile(plain.bytes)}`);
    if (!owned) { console.log("\n  refusing to test an unowned server\n"); }
    else {
      check("unflagged → the original, immutable (content-addressed)", plain.cc.includes("immutable"), plain.cc);

      const flagged = await get(true);
      check("flagged → the variant beside it", flagged.status === 200 && same(flagged.bytes, variant), `file=${whichFile(flagged.bytes)}`);
      check("…immutable too (the variant is the final answer for that URL)", flagged.cc.includes("immutable"), flagged.cc);

      // the enumerations, asked of the running server
      const catalog: { path: string }[] = await fetch(`http://127.0.0.1:${PORT}/library-models`).then((r) => r.json());
      const mine = catalog.filter((h) => h.path === `store/${hash}.glb`);
      const ghosts = catalog.filter((h) => isKtx2Variant(h.path));
      check("/library-models lists the upload once and the variant never", mine.length === 1 && ghosts.length === 0,
        `mine=${mine.length} ghosts=${ghosts.map((g) => g.path).join(", ")}`);
      const listing: { path: string }[] = await fetch(`http://127.0.0.1:${PORT}/library-list?dir=store`).then((r) => r.json());
      check("/library-list?dir=store lists the upload and not the variant (the prefetcher warms this)",
        listing.some((f) => f.path === `store/${hash}.glb`) && !listing.some((f) => isKtx2Variant(f.path)),
        listing.map((f) => f.path).join(", "));

      // the variant is not there yet (or never will be — no encoder): the
      // flagged answer is the original, and it must not be pinned
      rmSync(variantPath);
      const provisional = await get(true);
      check("flagged, no variant → falls through to the original", provisional.status === 200 && same(provisional.bytes, glb),
        `file=${whichFile(provisional.bytes)}`);
      check("…PROVISIONAL: no-cache, never immutable", provisional.cc === "no-cache", provisional.cc);
      check("…and a different ETag than the variant's, so the swap is a 200 not a 304", provisional.etag !== flagged.etag && provisional.etag !== "",
        `${provisional.etag} vs ${flagged.etag}`);
      const still = await get(false);
      check("the unflagged answer stays immutable — the address IS content-addressed", still.cc.includes("immutable"), still.cc);
    }
  }
  cleanup();
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : "\n\x1b[32m0 failed\x1b[0m");
process.exit(failures ? 1 : 0);
