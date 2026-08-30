// The geometry LOD for placeable objects (server/optimize.ts --lod,
// store-variants.ts), run headless — v1 of the contract agreed in the #142
// thread: OBJECTS ONLY, BODIES FAIL CLOSED.
//
//   bun tools/object-lod-test.ts
//
// The contract under test, in the reviewer's terms:
//   - bodies are excluded by POSITIVE STRUCTURAL DETECTION on the raw
//     container — skins, joint weights, VRM metadata, morph targets,
//     morph-weight animation channels — with a truthful typed verdict
//     (`unsupported: skinned/avatar asset`), no geometry LOD, no silent
//     attempt; the original stays the only served representation;
//   - the original is preserved byte-identically (the variant is a sibling);
//   - variant identity binds source content hash + recipe + tool versions
//     (asset.extras: lodOf / recipe / tools);
//   - named nodes, materials, and bounds are asserted unchanged after the
//     reduce — a failed assert or an ineffective reduce is a typed verdict,
//     never a half-valid object;
//   - the client asks with ?lod=1 riding the ktx2 negotiation, and ONLY when
//     /version published lodRecipe (the ?ktx2=2 split-brain lesson);
//   - a missing variant falls back to the original/ktx2 chain, PROVISIONAL
//     (no-cache) so the variant's bytes get through the moment it lands;
//   - variants and their markers never leak into catalogs or listings.
//
// The fake toktx (the store-variants-test pattern) stands in for the
// encoder, so no KTX-Software is needed; the one real-encoder receipt runs
// when the box has one.
//
// Negative control: on main this file dies at import (no isLodVariant, no
// optimizeGlbLod); the serving checks fail on main with the variant never
// built and ?lod=1 answered immutable (the poison this arm's negotiation
// gate exists to prevent).

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, rmdirSync, chmodSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { PNG } from "pngjs";
import { isLodVariant, isServingArtifact, isStoreOriginal, lodVariantPath, storeShadowsMissing,
  LOD_RECIPE, LOD_MIN_VERTS, recipeStamp } from "../server/store-variants.ts";
import { lodExclusion, findKtx2Encoder } from "../server/optimize.ts";
import { lodFromVersion, withLod, keyFromVersion, negotiate } from "../shared/ktx2.js";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${!ok && detail ? `\n      ${detail}` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, ms: number, step = 250) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(step); }
  return pred();
};
const ROOT = join(import.meta.dir, "..");
const OPTIMIZE = join(ROOT, "server", "optimize.ts");

console.log("\ngeometry LOD for placeable objects — bodies fail closed:\n");

// ---------------------------------------------- 1. names, predicates, negotiation
{
  check("a lod variant is named beside its original", lodVariantPath("/x/store/abc.glb") === "/x/store/abc.glb.lod1.glb");
  for (const v of ["abc.glb.lod1.glb", "model.glb.lod2.glb", "UPPER.GLB.LOD1.GLB"])
    check(`${v} is a lod variant and a serving artifact`, isLodVariant(v) && isServingArtifact(v) && !isStoreOriginal(v));
  for (const o of ["abc.glb", "abc.glb.ktx2.glb", "lod1.glb", "model.lod.glb"])
    check(`${o} is not a lod variant`, !isLodVariant(o));
  check("a lod .failed marker is an artifact, never a listing entry", isServingArtifact("abc.glb.lod1.glb.failed"));
  const m = storeShadowsMissing("/x/store/abc.glb", "/x/store-min", () => false);
  check("a fresh original lacks all three shadows", m.min && m.ktx2 && m.lod);
  const m2 = storeShadowsMissing("/x/store/abc.glb", "/x/store-min",
    (p) => p === "/x/store/abc.glb.lod1.glb.failed", () => "[optimize] lod: unsupported: skinned/avatar asset (skins)");
  check("a typed exclusion verdict STANDS (a body never becomes a retry loop)", !m2.lod);
  const m3 = storeShadowsMissing("/x/store/abc.glb", "/x/store-min",
    (p) => p === "/x/store/abc.glb.lod1.glb.failed", () => "[optimize] not smaller (9 -> 10, 1ms) — keeping original");
  check("an unstamped lod size verdict is stale — re-measured under the current recipe", m3.lod);

  check("the client only asks for a tier the running sequencer published", lodFromVersion({ lodRecipe: LOD_RECIPE }) === LOD_RECIPE);
  check("an older sequencer publishes none → null → no ?lod (the split-brain gate)", lodFromVersion({ sha: "old" }) === null && lodFromVersion(null) === null);
  check("withLod appends", withLod("store/x.glb?ktx2=3") === "store/x.glb?ktx2=3&lod=1" && withLod("x.glb") === "x.glb?lod=1");
}

// ---------------------------------------------- 2. the structural exclusion, pure
{
  const base = { meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }] };
  check("a plain object is not excluded", lodExclusion(base) === null);
  check("skins exclude", /skinned\/avatar/.test(lodExclusion({ ...base, skins: [{}] }) ?? ""));
  check("joint weights exclude even without a skins array",
    /skinned\/avatar/.test(lodExclusion({ meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] }] }) ?? ""));
  check("VRM metadata excludes (VRMC_vrm)", /VRM metadata/.test(lodExclusion({ ...base, extensionsUsed: ["VRMC_vrm"] }) ?? ""));
  check("…and legacy VRM 0.x", /VRM metadata/.test(lodExclusion({ ...base, extensionsUsed: ["VRM"] }) ?? ""));
  check("morph targets exclude", /morph targets/.test(lodExclusion({ meshes: [{ primitives: [{ attributes: { POSITION: 0 }, targets: [{}] }] }] }) ?? ""));
  check("morph-weight animation excludes", /morph-weight/.test(lodExclusion({ ...base, animations: [{ channels: [{ target: { path: "weights" } }] }] }) ?? ""));
  check("node TRS animation does NOT exclude (structure is asserted instead)",
    lodExclusion({ ...base, animations: [{ channels: [{ target: { path: "rotation" } }] }] }) === null);
}

// ---------------------------------------------- fixtures
const NONCE = crypto.randomUUID();
function pngBytes(seed: number, W = 64): Uint8Array {
  const png = new PNG({ width: W, height: W });
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    png.data[i] = (x * 4 + seed) & 0xff; png.data[i + 1] = (y * 4) & 0xff; png.data[i + 2] = ((x ^ y) * 4) & 0xff; png.data[i + 3] = 255;
  }
  return new Uint8Array(PNG.sync.write(png));
}
/** A dense smooth grid — the kind of mesh a reducer actually reduces.
 *  `cells`² quads ≈ (cells+1)² verts; gentle height noise keeps prune()
 *  honest and simplify effective. Textured when `textured`. */
async function gridGlb(tag: string, cells: number, textured: boolean, nodeName = "hero"): Promise<Uint8Array> {
  const doc = new Document();
  const buf = doc.createBuffer();
  const n = cells + 1;
  const pos = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    pos[i * 3] = x / cells; pos[i * 3 + 1] = Math.sin(x * 0.37) * Math.cos(y * 0.29) * 0.02; pos[i * 3 + 2] = y / cells;
    uv[i * 2] = x / cells; uv[i * 2 + 1] = y / cells;
  }
  const idx = new Uint32Array(cells * cells * 6);
  let k = 0;
  for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
    const a = y * n + x, b = a + 1, c = a + n, d = c + 1;
    idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
  }
  const mat = doc.createMaterial("probeMat");
  if (textured) mat.setBaseColorTexture(doc.createTexture("base").setImage(pngBytes(1)).setMimeType("image/png"));
  const prim = doc.createPrimitive().setMaterial(mat)
    .setIndices(doc.createAccessor().setType("SCALAR").setBuffer(buf).setArray(idx))
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setBuffer(buf).setArray(pos))
    .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setBuffer(buf).setArray(uv));
  doc.createScene("s").addChild(doc.createNode(`${nodeName}-${tag}-${NONCE}`).setMesh(doc.createMesh("gridMesh").addPrimitive(prim)));
  return new NodeIO().writeBinary(doc);
}
/** The same grid with a skin bound on — a BODY, structurally. */
async function skinnedGlb(tag: string): Promise<Uint8Array> {
  const doc = new Document();
  const buf = doc.createBuffer();
  const prim = doc.createPrimitive()
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setBuffer(buf).setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])))
    .setAttribute("JOINTS_0", doc.createAccessor().setType("VEC4").setBuffer(buf).setArray(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])))
    .setAttribute("WEIGHTS_0", doc.createAccessor().setType("VEC4").setBuffer(buf).setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])));
  const joint = doc.createNode(`joint-${tag}`);
  const skin = doc.createSkin("rig").addJoint(joint);
  const node = doc.createNode(`body-${tag}-${NONCE}`).setMesh(doc.createMesh("m").addPrimitive(prim)).setSkin(skin);
  doc.createScene("s").addChild(node).addChild(joint);
  return new NodeIO().writeBinary(doc);
}
const hashOf = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex").slice(0, 16);
const glbJson = (bytes: Uint8Array) => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + dv.getUint32(12, true))));
};

// the fake toktx (the store-variants-test pattern, ok-mode only)
const CANNED_KTX2 = Uint8Array.from(atob(
  "q0tUWCAyMLsNChoKAAAAAAEAAAAEAAAABAAAAAAAAAAAAAAAAQAAAAMAAAABAAAAmAAAACwAAADEAAAAeAAAAEABAAAAAAAAtwAAAAAAAAD5AQAAAAAAAAEAAAAAAAAAAAAAAAAAAAD4AQAAAAAAAAEAAAAAAAAAAAAAAAAAAAD3AQAAAAAAAAEAAAAAAAAAAAAAAAAAAAAsAAAAAAAAAAIAKACjAQIAAwMAAAgAAAAAAAAAAAA/AAAAAAAAAAAA/////xIAAABLVFhvcmllbnRhdGlvbgByZAAAACcAAABLVFh3cml0ZXIAdG9rdHggdjQuNC4yIC8gbGlia3R4IHY0LjQuMgAALgAAAEtUWHdyaXRlclNjUGFyYW1zAC0tZW5jb2RlIGV0YzFzIC0tcWxldmVsIDEyOAAAAAAAAAADAAMALwAAAA0AAAArAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAALABIAAAAAAACIIEDVAAAAAGBQMu0EYGABMAAAAAAAAIBCAKQAAAAAAEGiR9GgYpPr//4cqVf9XVVVVBQDBRAAAAAAAAPJfbQCYAAAAAAAAQUYATAAQAAAAgEBxADABAAAAAACAAAIMBgo="),
  (c) => c.charCodeAt(0));
const FAKE_DIR = mkdtempSync(join(tmpdir(), "ew-lod-fake-"));
writeFileSync(join(FAKE_DIR, "canned.ktx2"), CANNED_KTX2);
writeFileSync(join(FAKE_DIR, "fake-toktx.ts"), `const argv = process.argv.slice(2);
const fs = await import("node:fs");
fs.copyFileSync(new URL("./canned.ktx2", import.meta.url), argv[argv.length - 2]);
process.exit(0);
`);
let FAKE_TOKTX: string;
if (process.platform === "win32") {
  FAKE_TOKTX = join(FAKE_DIR, "toktx.cmd");
  writeFileSync(FAKE_TOKTX, `@echo off\r\n"${process.execPath}" run "${join(FAKE_DIR, "fake-toktx.ts")}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
} else {
  FAKE_TOKTX = join(FAKE_DIR, "toktx");
  writeFileSync(FAKE_TOKTX, `#!/bin/sh\nexec "${process.execPath}" run "${join(FAKE_DIR, "fake-toktx.ts")}" "$@"\n`);
  chmodSync(FAKE_TOKTX, 0o755);
}
async function runLod(src: string, dest: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, "run", OPTIMIZE, "--lod", src, dest],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, KTX2_TOKTX: FAKE_TOKTX, ...env } });
  const code = await proc.exited;
  return { code, err: (await new Response(proc.stderr).text()).trim(), out: (await new Response(proc.stdout).text()).trim(), wrote: existsSync(dest) };
}

// ---------------------------------------------- 3. the CLI: verdicts, identity, preservation
console.log("\n  the CLI — bodies refused, objects reduced, identity stamped:");
{
  const tmp = mkdtempSync(join(tmpdir(), "ew-lod-"));
  try {
    const place = (bytes: Uint8Array, name: string) => { const p = join(tmp, name); writeFileSync(p, bytes); return p; };
    const bodyPath = place(await skinnedGlb("a"), "body.glb");
    const bodyBytes = readFileSync(bodyPath);
    let r = await runLod(bodyPath, join(tmp, "body.glb.lod1.glb"));
    check("a skinned asset → exit 2, the typed verdict, NOTHING written", r.code === 2 && !r.wrote && r.err.includes("unsupported: skinned/avatar asset"),
      `exit ${r.code}: ${r.err.split("\n").pop()}`);
    check("…and the original is byte-identical after the refusal", readFileSync(bodyPath).equals(bodyBytes));

    const vrmish = await gridGlb("vrmish", 8, false);
    { // stamp VRM metadata into the raw container — the exclusion must fire off the JSON, not a filename
      const dv = new DataView(vrmish.buffer, vrmish.byteOffset);
      const jl = dv.getUint32(12, true);
      const j = JSON.parse(new TextDecoder().decode(vrmish.subarray(20, 20 + jl)));
      j.extensionsUsed = ["VRMC_vrm"];
      let jt = JSON.stringify(j); while (jt.length % 4) jt += " ";
      const jb = new TextEncoder().encode(jt);
      const rest = vrmish.subarray(20 + jl);
      const outB = new Uint8Array(20 + jb.length + rest.length);
      const odv = new DataView(outB.buffer);
      outB.set(vrmish.subarray(0, 12)); odv.setUint32(8, outB.length, true);
      odv.setUint32(12, jb.length, true); odv.setUint32(16, 0x4e4f534a, true);
      outB.set(jb, 20); outB.set(rest, 20 + jb.length);
      const p = place(outB, "vrmish.glb");
      r = await runLod(p, join(tmp, "vrmish.glb.lod1.glb"));
      check("VRM metadata in a .glb → refused off the CONTAINER, not the filename", r.code === 2 && !r.wrote && r.err.includes("VRM metadata"),
        `exit ${r.code}: ${r.err.split("\n").pop()}`);
    }

    const tiny = place(await gridGlb("tiny", 8, true), "tiny.glb");
    r = await runLod(tiny, join(tmp, "tiny.glb.lod1.glb"));
    check(`an already-light object (< ${LOD_MIN_VERTS} verts) → typed verdict, nothing written`, r.code === 2 && !r.wrote && r.err.includes("already light"),
      `exit ${r.code}: ${r.err.split("\n").pop()}`);

    const heroBytes = await gridGlb("hero", 160, true);   // ~26k verts, textured
    const hero = place(heroBytes, "hero.glb");
    const dest = join(tmp, "hero.glb.lod1.glb");
    r = await runLod(hero, dest);
    check("a dense textured object → exit 0, variant written", r.code === 0 && r.wrote, `exit ${r.code}: ${r.err.split("\n").pop()}`);
    if (r.wrote) {
      const v = new Uint8Array(readFileSync(dest));
      const j = glbJson(v);
      check("…really reduced (the CLI names the counts)", /\d+ -> \d+ verts/.test(r.out), r.out);
      check("…textures at the budget, KTX2, required", (j.extensionsRequired ?? []).includes("KHR_texture_basisu"));
      const ex = j.asset?.extras ?? {};
      const fullHash = new Bun.CryptoHasher("sha256").update(heroBytes).digest("hex");
      check("identity: extras.lodOf is the source sha256", ex.lodOf === fullHash, String(ex.lodOf).slice(0, 16));
      check("…extras.recipe is the versioned recipe", ex.recipe === LOD_RECIPE, ex.recipe);
      check("…extras.tools names the reducer and encoder versions", typeof ex.tools?.meshoptimizer === "string" && typeof ex.tools?.encoder === "string",
        JSON.stringify(ex.tools));
      check("named nodes preserved (parts and socket frames live there)",
        (j.nodes ?? []).some((n: any) => String(n.name ?? "").startsWith("hero-hero-")), (j.nodes ?? []).map((n: any) => n.name).join(", "));
      check("…and the original is byte-identical", readFileSync(hero).equals(Buffer.from(heroBytes)));
    }

    const untex = place(await gridGlb("untex", 160, false), "untex.glb");
    r = await runLod(untex, join(tmp, "untex.glb.lod1.glb"), { KTX2_TOKTX: join(tmp, "no-such"), PATH: tmp, HOME: tmp, USERPROFILE: tmp });
    check("an UNTEXTURED object reduces with no encoder at all", r.code === 0 && r.wrote, `exit ${r.code}: ${r.err.split("\n").pop()}`);
    r = await runLod(hero, join(tmp, "hero2.glb.lod1.glb"), { KTX2_TOKTX: join(tmp, "no-such"), PATH: tmp, HOME: tmp, USERPROFILE: tmp });
    check("a TEXTURED object with no encoder → exit 3 (environmental, no marker's business)", r.code === 3 && !existsSync(join(tmp, "hero2.glb.lod1.glb")),
      `exit ${r.code}: ${r.err.split("\n").pop()}`);

    const real = findKtx2Encoder();
    if (!real) console.log("  - real encoder: skipped — none on this box");
    else {
      r = await runLod(hero, join(tmp, "hero.real.lod1.glb"), { KTX2_TOKTX: real });
      check(`the real encoder (${real.split(/[\\/]/).pop()}): a reduced, KTX2-textured variant`, r.code === 0 && r.wrote, `exit ${r.code}`);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ---------------------------------------------- 4. the sequencer: upload → shadows → served tier
console.log("\n  the real sequencer — choose the tier before the fetch:");
{
  const OPT = join(ROOT, "assets", "opt");
  const STORE = join(OPT, "store"), STORE_MIN = join(OPT, "store-min");
  const madeStore = !existsSync(STORE), madeMin = !existsSync(STORE_MIN);
  mkdirSync(STORE, { recursive: true }); mkdirSync(STORE_MIN, { recursive: true });
  const EMPTY_LIB = mkdtempSync(join(tmpdir(), "ew-lod-lib-"));
  const DOOR = "test-door";
  const mine = new Set<string>();
  let server: ReturnType<typeof spawn> | null = null;
  const cleanup = () => {
    try { server?.kill(); } catch { /* gone */ }
    for (const h of mine) for (const p of [join(STORE, `${h}.glb`), join(STORE, `${h}.glb.ktx2.glb`), join(STORE, `${h}.glb.ktx2.glb.failed`),
      join(STORE, `${h}.glb.lod1.glb`), join(STORE, `${h}.glb.lod1.glb.failed`), join(STORE_MIN, `${h}.glb`), join(STORE_MIN, `${h}.glb.failed`)])
      try { rmSync(p, { force: true }); } catch { /* best effort */ }
    try {
      const mp = join(STORE, "manifest.json");
      if (existsSync(mp)) {
        const man = JSON.parse(readFileSync(mp, "utf8"));
        for (const h of mine) delete man[h];
        if (Object.keys(man).length) writeFileSync(mp, JSON.stringify(man)); else rmSync(mp);
      }
    } catch { /* best effort */ }
    if (madeStore) try { rmdirSync(STORE); } catch { /* not empty */ }
    if (madeMin) try { rmdirSync(STORE_MIN); } catch { /* same */ }
    try { rmSync(FAKE_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(EMPTY_LIB, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  process.on("exit", cleanup);
  let PORT = 0;
  for (let i = 0; i < 20 && !PORT; i++) {
    const cand = 20000 + Math.floor(Math.random() * 20000);
    try { await fetch(`http://127.0.0.1:${cand}/`, { signal: AbortSignal.timeout(400) }); } catch { PORT = cand; }
  }
  server = spawn(process.execPath, [join(ROOT, "server", "server.ts")],
    { env: { ...process.env, PORT: String(PORT), JOIN_TOKEN: DOOR, KTX2_TOKTX: FAKE_TOKTX,
      WORLDS_DIR: mkdtempSync(join(tmpdir(), "ew-lod-w-")), EIDOVERSE_DIR: EMPTY_LIB }, stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`http://127.0.0.1:${PORT}/`); up = true; } catch { await sleep(250); } }
  check("child server came up on a verified-free port", up, `:${PORT}`);
  if (up) {
    const base = `http://127.0.0.1:${PORT}`;
    const version = await fetch(`${base}/version`).then((r) => r.json());
    check("the running sequencer publishes the LOD recipe on /version — the only gate a client trusts",
      lodFromVersion(version) === LOD_RECIPE, JSON.stringify(version.lodRecipe));
    const key = keyFromVersion(version);
    const glb = await gridGlb("served", 160, true);
    const hash = hashOf(glb); mine.add(hash);
    const upRes = await fetch(`${base}/upload?token=${DOOR}&name=lod-test`, { method: "POST", body: glb });
    check("POST /upload landed it", upRes.status === 200);
    const flaggedUrl = `${base}/library/${withLod(negotiate(`store/${hash}.glb`, key))}`;
    const early = await fetch(flaggedUrl);
    const earlyBytes = new Uint8Array(await early.arrayBuffer());
    const earlyIsLod = (() => { try { return glbJson(earlyBytes)?.asset?.extras?.recipe === LOD_RECIPE; } catch { return false; } })();
    check("before the variant lands, a ?lod fetch is answered PROVISIONALLY — never pinned",
      earlyIsLod || early.headers.get("cache-control") === "no-cache", `lod=${earlyIsLod} cc=${early.headers.get("cache-control")}`);
    const landed = await until(() => existsSync(join(STORE, `${hash}.glb.lod1.glb`)), 45_000);
    check("the queue built the LOD shadow beside the original", landed);
    if (landed) {
      const res = await fetch(flaggedUrl);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const j = glbJson(bytes);
      check("?ktx2=<key>&lod=1 → the LOD variant, identity-stamped, immutable",
        j?.asset?.extras?.recipe === LOD_RECIPE && (res.headers.get("cache-control") ?? "").includes("immutable"),
        `recipe=${j?.asset?.extras?.recipe} cc=${res.headers.get("cache-control")}`);
      const noLod = await fetch(`${base}/library/${negotiate(`store/${hash}.glb`, key)}`);
      const noLodJ = glbJson(new Uint8Array(await noLod.arrayBuffer()));
      check("without ?lod the same client gets the plain ktx2 chain — tiers are chosen, never imposed",
        noLodJ?.asset?.extras?.recipe !== LOD_RECIPE);
      const listing: { path: string }[] = await fetch(`${base}/library-list?dir=store`).then((r) => r.json());
      check("/library-list shows the original once, no lod artifacts", listing.filter((f) => f.path.includes(hash)).length === 1
        && !listing.some((f) => isLodVariant(f.path)), listing.map((f) => f.path).filter((p) => p.includes(hash)).join(", "));
      const catalog: { path: string }[] = await fetch(`${base}/library-models`).then((r) => r.json());
      check("/library-models lists it once, never the variant", catalog.filter((h) => h.path === `store/${hash}.glb`).length === 1
        && !catalog.some((h) => isLodVariant(h.path)));
    }
    // a body through the same door: the pump must fail it closed with the typed verdict
    const body = await skinnedGlb("served");
    const bh = hashOf(body); mine.add(bh);
    await fetch(`${base}/upload?token=${DOOR}&name=body-test`, { method: "POST", body });
    const refused = await until(() => existsSync(join(STORE, `${bh}.glb.lod1.glb.failed`)), 45_000);
    const verdict = refused ? readFileSync(join(STORE, `${bh}.glb.lod1.glb.failed`), "utf8") : "";
    check("an uploaded BODY gets the typed verdict marker and no lod variant",
      refused && verdict.includes("unsupported: skinned/avatar asset") && !existsSync(join(STORE, `${bh}.glb.lod1.glb`)), verdict.slice(0, 80));
    const bodyRes = await fetch(`${base}/library/${withLod(negotiate(`store/${bh}.glb`, key))}`);
    const bodyJ = glbJson(new Uint8Array(await bodyRes.arrayBuffer()));
    check("…and a ?lod fetch for it falls back to the original chain — never a half-valid object",
      bodyJ?.asset?.extras?.recipe !== LOD_RECIPE);
  }
  cleanup();
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : "\n\x1b[32m0 failed\x1b[0m");
process.exit(failures ? 1 : 0);
