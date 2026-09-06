// The geometry LOD for placeable objects (server/optimize.ts --lod,
// store-variants.ts), run headless — v1 of the contract agreed in the #142
// thread, revised per the #156 review: OBJECTS ONLY, BODIES FAIL CLOSED,
// STATIC GEOMETRY ONLY, and the recipe is a GENERATION carried in both the
// URL and the variant's filename.
//
//   bun tools/object-lod-test.ts
//
// The contract under test, in the reviewer's terms — each repaired seam of
// the #156 review has a named control here, and deleting the mechanism
// turns its control red:
//   1. the URL carries the recipe (`?lod=<recipe>`), the filename carries it
//      too, and an unrecognized generation is answered PROVISIONALLY — a
//      recipe change can never pin yesterday's bytes under today's address
//      (the mutation canary rewrites the on-disk recipe under a live child);
//   2. the library sweep queues LODs (the shared `seen` set that killed it
//      is keyed by mode now) — proven with a pre-existing library GLB, not
//      an upload;
//   3. a missing encoder does not delete valid untextured LOD work — the
//      no-encoder child reduces an untextured upload while the textured one
//      keeps its original, no marker, one log line;
//   4. a MUTABLE library source newer than its variant is never served the
//      old variant — provisional until the next boot rebuilds it, then fresh;
//   5. bodies fail closed on STRUCTURE, not well-formedness: top-level
//      `extensions` keys and any JOINTS_n/WEIGHTS_n set, not just
//      extensionsUsed and set 0;
//   6. claims match assertions: node hierarchy + transforms and per-primitive
//      material assignments are signature-checked (not just sorted names),
//      source asset.extras survive under ours, and ANY animation is a typed
//      v1 refusal rather than an untested claim of preservation;
//   7. the child is process-owned: piped diagnostics, a per-run
//      content-hashed fixture as the nonce, failure prints the log tail.
//
// The fake toktx (the store-variants-test pattern) stands in for the
// encoder; the one real-encoder receipt runs when the box has one.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, rmdirSync, chmodSync, utimesSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { PNG } from "pngjs";
import { isLodVariant, isServingArtifact, isStoreOriginal, lodVariantPath, storeShadowsMissing,
  LOD_RECIPE, LOD_MIN_VERTS } from "../server/store-variants.ts";
import { lodExclusion, findKtx2Encoder, optimizeGlbLod, lodNodesSig, lodMatsSig } from "../server/optimize.ts";
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

console.log("\ngeometry LOD for placeable objects — bodies fail closed, recipes are generations:\n");

// ---------------------------------------------- 1. names, predicates, negotiation
{
  check("the variant's filename carries the recipe generation", lodVariantPath("/x/store/abc.glb") === `/x/store/abc.glb.lod.${LOD_RECIPE}.glb`);
  check("…and an explicit recipe names that generation's file", lodVariantPath("/x/a.glb", "lod1-r10") === "/x/a.glb.lod.lod1-r10.glb");
  for (const v of [`abc.glb.lod.${LOD_RECIPE}.glb`, "abc.glb.lod.lod1-r10.glb", "M.GLB.LOD.OLD-GEN.GLB"])
    check(`${v} is a lod variant of SOME generation — artifact, never original`, isLodVariant(v) && isServingArtifact(v) && !isStoreOriginal(v));
  for (const o of ["abc.glb", "abc.glb.ktx2.glb", "lod.glb", "model.lod.glb.txt"])
    check(`${o} is not a lod variant`, !isLodVariant(o));
  check("a lod .failed marker is an artifact, never a listing entry", isServingArtifact(`abc.glb.lod.${LOD_RECIPE}.glb.failed`));
  const m = storeShadowsMissing("/x/store/abc.glb", "/x/store-min", () => false);
  check("a fresh original lacks all three shadows", m.min && m.ktx2 && m.lod);
  const m2 = storeShadowsMissing("/x/store/abc.glb", "/x/store-min",
    (p) => p === `/x/store/abc.glb.lod.${LOD_RECIPE}.glb.failed`, () => "[optimize] lod: unsupported: skinned/avatar asset (skins)");
  check("a typed exclusion verdict STANDS (a body never becomes a retry loop)", !m2.lod);

  check("the client only asks for a tier the running sequencer published", lodFromVersion({ lodRecipe: LOD_RECIPE }) === LOD_RECIPE);
  check("an older sequencer publishes none → null → no ?lod (the split-brain gate)", lodFromVersion({ sha: "old" }) === null && lodFromVersion(null) === null);
  check("withLod carries the RECIPE, never a boolean — two recipes are two URLs",
    withLod("store/x.glb?ktx2=3", "lod1-rA") === "store/x.glb?ktx2=3&lod=lod1-rA"
    && withLod("store/x.glb?ktx2=3", "lod1-rB") !== withLod("store/x.glb?ktx2=3", "lod1-rA"));
  check("…and no recipe → the URL untouched (an unflagged fetch)", withLod("store/x.glb", null) === "store/x.glb");
}

// ---------------------------------------------- 2. the structural exclusion, pure
{
  const base = { meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }] };
  check("a plain object is not excluded", lodExclusion(base) === null);
  check("skins exclude", /skinned\/avatar/.test(lodExclusion({ ...base, skins: [{}] }) ?? ""));
  check("VRM in extensionsUsed excludes", /VRM metadata/.test(lodExclusion({ ...base, extensionsUsed: ["VRMC_vrm"] }) ?? ""));
  check("VRM in extensionsRequired excludes", /VRM metadata/.test(lodExclusion({ ...base, extensionsRequired: ["VRMC_vrm"] }) ?? ""));
  // the reviewer's probes: fail-closed must not trust well-formedness
  check("a VRM extension OBJECT excludes even when extensionsUsed forgot it (review probe)",
    /VRM metadata/.test(lodExclusion({ ...base, extensions: { VRMC_vrm: {} } }) ?? ""));
  check("JOINTS_1/WEIGHTS_1 exclude without set 0 (review probe)",
    /skinned\/avatar/.test(lodExclusion({ meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_1: 1, WEIGHTS_1: 2 } }] }] }) ?? ""));
  check("morph targets exclude", /morph targets/.test(lodExclusion({ meshes: [{ primitives: [{ attributes: { POSITION: 0 }, targets: [{}] }] }] }) ?? ""));
  check("ANY animation is a typed v1 refusal — static geometry only, preservation is earned not claimed",
    /animated object/.test(lodExclusion({ ...base, animations: [{ channels: [{ target: { path: "rotation" } }] }] }) ?? ""));
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
async function gridGlb(tag: string, cells: number, textured: boolean, extras: object | null = null): Promise<Uint8Array> {
  const doc = new Document();
  if (extras) doc.getRoot().getAsset().extras = extras;
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
  doc.createScene("s").addChild(doc.createNode(`hero-${tag}-${NONCE}`).setMesh(doc.createMesh("gridMesh").addPrimitive(prim)));
  return new NodeIO().writeBinary(doc);
}
async function skinnedGlb(tag: string): Promise<Uint8Array> {
  const doc = new Document();
  const buf = doc.createBuffer();
  const prim = doc.createPrimitive()
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setBuffer(buf).setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])))
    .setAttribute("JOINTS_0", doc.createAccessor().setType("VEC4").setBuffer(buf).setArray(new Uint8Array(12)))
    .setAttribute("WEIGHTS_0", doc.createAccessor().setType("VEC4").setBuffer(buf).setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])));
  const joint = doc.createNode(`joint-${tag}`);
  const skin = doc.createSkin("rig").addJoint(joint);
  doc.createScene("s").addChild(doc.createNode(`body-${tag}-${NONCE}`).setMesh(doc.createMesh("m").addPrimitive(prim)).setSkin(skin)).addChild(joint);
  return new NodeIO().writeBinary(doc);
}
/** A dense grid with a node-TRS animation bound on — v1 must refuse it. */
async function animatedGlb(tag: string): Promise<Uint8Array> {
  const bytes = await gridGlb(tag, 160, false);
  const doc = await new NodeIO().readBinary(bytes);
  const buf = doc.getRoot().listBuffers()[0];
  const input = doc.createAccessor().setType("SCALAR").setBuffer(buf).setArray(new Float32Array([0, 1]));
  const output = doc.createAccessor().setType("VEC3").setBuffer(buf).setArray(new Float32Array([0, 0, 0, 0, 1, 0]));
  const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation("LINEAR");
  const channel = doc.createAnimationChannel().setTargetNode(doc.getRoot().listNodes()[0]).setTargetPath("translation").setSampler(sampler);
  doc.createAnimation("bob").addSampler(sampler).addChannel(channel);
  return new NodeIO().writeBinary(doc);
}
/** The re-review's own fixture, verbatim shape: a dense mesh on `root` at
 *  [2,3,4] with an EMPTY NAMED child `seat_socket` at [0.2,1.1,-0.3] — the
 *  node a plain prune() deleted before the old signature existed. */
async function socketGlb(tag: string): Promise<Uint8Array> {
  const bytes = await gridGlb(tag, 160, false);
  const doc = await new NodeIO().readBinary(bytes);
  const root = doc.getRoot().listNodes()[0];
  root.setName("root").setTranslation([2, 3, 4]);
  root.addChild(doc.createNode("seat_socket").setTranslation([0.2, 1.1, -0.3]));
  return new NodeIO().writeBinary(doc);
}
/** Two dense primitives wearing two DIFFERENT materials — the assignment
 *  the material guard must notice being swapped. */
async function twoMatGlb(tag: string): Promise<Uint8Array> {
  const a = await gridGlb(`${tag}-a`, 120, false);
  const doc = await new NodeIO().readBinary(a);
  const buf = doc.getRoot().listBuffers()[0];
  const matB = doc.createMaterial("probeMatB");
  const prim0 = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  const prim2 = doc.createPrimitive().setMaterial(matB)
    .setIndices(prim0.getIndices())
    .setAttribute("POSITION", prim0.getAttribute("POSITION"))
    .setAttribute("TEXCOORD_0", prim0.getAttribute("TEXCOORD_0"));
  doc.getRoot().listMeshes()[0].addPrimitive(prim2);
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
const NOWHERE = mkdtempSync(join(tmpdir(), "ew-lod-nowhere-"));
const NO_ENCODER = { KTX2_TOKTX: join(NOWHERE, "no-such"), PATH: NOWHERE, HOME: NOWHERE, USERPROFILE: NOWHERE };
async function runLod(src: string, dest: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, "run", OPTIMIZE, "--lod", src, dest],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, KTX2_TOKTX: FAKE_TOKTX, ...env } });
  const code = await proc.exited;
  return { code, err: (await new Response(proc.stderr).text()).trim(), out: (await new Response(proc.stdout).text()).trim(), wrote: existsSync(dest) };
}

// ---------------------------------------------- 3. the CLI: verdicts, identity, preservation
console.log("\n  the CLI — bodies and animation refused, objects reduced, identity stamped:");
{
  const tmp = mkdtempSync(join(tmpdir(), "ew-lod-"));
  try {
    const place = (bytes: Uint8Array, name: string) => { const p = join(tmp, name); writeFileSync(p, bytes); return p; };
    const bodyPath = place(await skinnedGlb("a"), "body.glb");
    const bodyBytes = readFileSync(bodyPath);
    let r = await runLod(bodyPath, lodVariantPath(bodyPath));
    check("a skinned asset → exit 2, the typed verdict, NOTHING written", r.code === 2 && !r.wrote && r.err.includes("unsupported: skinned/avatar asset"),
      `exit ${r.code}: ${r.err.split("\n").pop()}`);
    check("…and the original is byte-identical after the refusal", readFileSync(bodyPath).equals(bodyBytes));

    const animPath = place(await animatedGlb("anim"), "anim.glb");
    r = await runLod(animPath, lodVariantPath(animPath));
    check("an ANIMATED object → typed v1 refusal, nothing written", r.code === 2 && !r.wrote && r.err.includes("animated object"),
      `exit ${r.code}: ${r.err.split("\n").pop()}`);

    const vrmish = await gridGlb("vrmish", 8, false);
    { // stamp a VRM extension OBJECT (not extensionsUsed) into the raw container
      const dv = new DataView(vrmish.buffer, vrmish.byteOffset);
      const jl = dv.getUint32(12, true);
      const j = JSON.parse(new TextDecoder().decode(vrmish.subarray(20, 20 + jl)));
      j.extensions = { VRMC_vrm: {} };   // a producer that forgot extensionsUsed — fail-closed must still see it
      let jt = JSON.stringify(j); while (jt.length % 4) jt += " ";
      const jb = new TextEncoder().encode(jt);
      const rest = vrmish.subarray(20 + jl);
      const outB = new Uint8Array(20 + jb.length + rest.length);
      const odv = new DataView(outB.buffer);
      outB.set(vrmish.subarray(0, 12)); odv.setUint32(8, outB.length, true);
      odv.setUint32(12, jb.length, true); odv.setUint32(16, 0x4e4f534a, true);
      outB.set(jb, 20); outB.set(rest, 20 + jb.length);
      const p = place(outB, "vrmish.glb");
      r = await runLod(p, lodVariantPath(p));
      check("a VRM extension OBJECT in a .glb → refused off the CONTAINER (malformed producer, still a body)",
        r.code === 2 && !r.wrote && r.err.includes("VRM metadata"), `exit ${r.code}: ${r.err.split("\n").pop()}`);
    }

    const tiny = place(await gridGlb("tiny", 8, true), "tiny.glb");
    r = await runLod(tiny, lodVariantPath(tiny));
    check(`an already-light object (< ${LOD_MIN_VERTS} verts) → typed verdict, nothing written`, r.code === 2 && !r.wrote && r.err.includes("already light"),
      `exit ${r.code}: ${r.err.split("\n").pop()}`);

    const heroBytes = await gridGlb("hero", 160, true, { producer: "someone-else", note: "must survive" });
    const hero = place(heroBytes, "hero.glb");
    const dest = lodVariantPath(hero);
    r = await runLod(hero, dest);
    check("a dense textured object → exit 0, variant written at the recipe-named path", r.code === 0 && r.wrote, `exit ${r.code}: ${r.err.split("\n").pop()}`);
    if (r.wrote) {
      const j = glbJson(new Uint8Array(readFileSync(dest)));
      check("…really reduced (the CLI names the counts)", /\d+ -> \d+ verts/.test(r.out), r.out);
      check("…textures at the budget, KTX2, required", (j.extensionsRequired ?? []).includes("KHR_texture_basisu"));
      const ex = j.asset?.extras ?? {};
      const fullHash = new Bun.CryptoHasher("sha256").update(heroBytes).digest("hex");
      check("identity: extras.lodOf is the source sha256", ex.lodOf === fullHash, String(ex.lodOf).slice(0, 16));
      check("…extras.recipe is the versioned recipe", ex.recipe === LOD_RECIPE, ex.recipe);
      check("…extras.tools names the reducer and encoder versions", typeof ex.tools?.meshoptimizer === "string" && typeof ex.tools?.encoder === "string",
        JSON.stringify(ex.tools));
      check("…and the SOURCE's own extras survive under ours (never clobbered)", ex.producer === "someone-else" && ex.note === "must survive",
        JSON.stringify(ex));
      check("named nodes preserved", (j.nodes ?? []).some((n: any) => String(n.name ?? "").startsWith("hero-hero-")));
      check("…and the original is byte-identical", readFileSync(hero).equals(Buffer.from(heroBytes)));
    }

    // the socket fixture: v1's whole promise, executable
    const sockBytes = await socketGlb("sock");
    const sock = place(sockBytes, "sock.glb");
    r = await runLod(sock, lodVariantPath(sock));
    check("a dense object with an EMPTY NAMED SOCKET child reduces — the socket is not prune()'s to take", r.code === 0 && r.wrote,
      `exit ${r.code}: ${r.err.split("\n").pop()}`);
    if (r.wrote) {
      const j = glbJson(new Uint8Array(readFileSync(lodVariantPath(sock))));
      const nodes: any[] = j.nodes ?? [];
      const sk = nodes.find((n) => n.name === "seat_socket");
      const rt = nodes.find((n) => n.name === "root");
      const near = (a: number[] | undefined, b: number[]) => !!a && a.every((v, i) => Math.abs(v - b[i]) < 1e-5);
      check("…seat_socket survives WITH its translation", !!sk && near(sk.translation, [0.2, 1.1, -0.3]), JSON.stringify(sk));
      check("…still a child of root, which kept its own transform", !!rt && near(rt.translation, [2, 3, 4])
        && (rt.children ?? []).includes(nodes.indexOf(sk)), JSON.stringify(rt));
    }

    // MUTATION CONTROLS (re-review blocker 1): each preservation guard gets a
    // corruption injected through the pipeline's own test seam — delete the
    // guard and its control goes red, because the corrupted variant would
    // ship. In-process on purpose: the seam must never be CLI-reachable.
    const mutBytes = await gridGlb("mut", 160, false);
    let mres = await optimizeGlbLod(mutBytes, null, (doc) => { doc.getRoot().listNodes()[0].setName("renamed-by-mutation"); });
    check("mutation control, node guard: a node renamed after the reduce is REFUSED", mres.out === null && /node hierarchy/.test(mres.verdict ?? ""),
      String(mres.verdict));
    mres = await optimizeGlbLod(mutBytes, null, (doc) => { doc.getRoot().listNodes()[0].setTranslation([9, 9, 9]); });
    check("…and so is a moved one (transforms are part of the contract)", mres.out === null && /node hierarchy/.test(mres.verdict ?? ""));
    const twoMat = await twoMatGlb("mut2");
    mres = await optimizeGlbLod(twoMat, null, (doc) => {
      const ms = doc.getRoot().listMaterials();
      doc.getRoot().listMeshes()[0].listPrimitives()[0].setMaterial(ms[1]);
    });
    check("mutation control, material guard: a swapped assignment is REFUSED", mres.out === null && /material assignments/.test(mres.verdict ?? ""),
      String(mres.verdict));
    mres = await optimizeGlbLod(twoMat, null);
    check("…and the same fixture un-mutated passes — the guards fire on corruption, not on the reduce", mres.out !== null, String(mres.verdict));

    // the detectors themselves, unit-tested
    {
      const d1 = new Document(); d1.createScene("s").addChild(d1.createNode("a").setTranslation([1, 2, 3]));
      const d2 = new Document(); d2.createScene("s").addChild(d2.createNode("a").setTranslation([1, 2, 4]));
      check("lodNodesSig distinguishes a moved node", lodNodesSig(d1) !== lodNodesSig(d2) && lodNodesSig(d1) === lodNodesSig(d1));
      const m1 = new Document(); { const A = m1.createMaterial("A"), B = m1.createMaterial("B");
        m1.createMesh("m").addPrimitive(m1.createPrimitive().setMaterial(A)).addPrimitive(m1.createPrimitive().setMaterial(B)); }
      const m2 = new Document(); { const A = m2.createMaterial("A"), B = m2.createMaterial("B");
        m2.createMesh("m").addPrimitive(m2.createPrimitive().setMaterial(B)).addPrimitive(m2.createPrimitive().setMaterial(A)); }
      check("lodMatsSig distinguishes swapped assignments", lodMatsSig(m1) !== lodMatsSig(m2));
    }

    const untex = place(await gridGlb("untex", 160, false), "untex.glb");
    r = await runLod(untex, lodVariantPath(untex), NO_ENCODER);
    check("an UNTEXTURED object reduces with no encoder at all", r.code === 0 && r.wrote, `exit ${r.code}: ${r.err.split("\n").pop()}`);
    const t0 = Date.now();
    r = await runLod(hero, join(tmp, "hero2.out"), NO_ENCODER);
    check("a TEXTURED object with no encoder → exit 3, answered from the RAW container (fast, the pump retries this every boot)",
      r.code === 3 && !r.wrote && Date.now() - t0 < 10_000, `exit ${r.code} in ${Date.now() - t0}ms`);

    const real = findKtx2Encoder();
    if (!real) console.log("  - real encoder: skipped — none on this box");
    else {
      r = await runLod(hero, join(tmp, "hero.real.out"), { KTX2_TOKTX: real });
      check(`the real encoder (${real.split(/[\\/]/).pop()}): a reduced, KTX2-textured variant`, r.code === 0 && r.wrote, `exit ${r.code}`);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ---------------------------------------------- the owned-process harness
const OPT = join(ROOT, "assets", "opt");
const STORE = join(OPT, "store"), STORE_MIN = join(OPT, "store-min");
const madeStore = !existsSync(STORE), madeMin = !existsSync(STORE_MIN);
mkdirSync(STORE, { recursive: true }); mkdirSync(STORE_MIN, { recursive: true });
const DOOR = "test-door";
const mine = new Set<string>();          // store hashes this run created
const mineOpt: string[] = [];            // OPT_DIR-relative files the library sweep created for us
let live: ChildProcess | null = null;
const cleanup = () => {
  try { live?.kill(); } catch { /* gone */ }
  for (const h of mine) {
    for (const p of [join(STORE, `${h}.glb`), join(STORE, `${h}.glb.ktx2.glb`), join(STORE, `${h}.glb.ktx2.glb.failed`),
      join(STORE_MIN, `${h}.glb`), join(STORE_MIN, `${h}.glb.failed`), lodVariantPath(join(STORE, `${h}.glb`)), `${lodVariantPath(join(STORE, `${h}.glb`))}.failed`])
      try { rmSync(p, { force: true }); } catch { /* best effort */ }
  }
  for (const rel of mineOpt) { try { rmSync(join(OPT, rel), { force: true }); } catch { /* best effort */ } }
  for (const rel of mineOpt) { let d = dirname(join(OPT, rel)); while (d !== OPT) { try { rmdirSync(d); } catch { break; } d = dirname(d); } }
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
  for (const d of [FAKE_DIR, NOWHERE]) try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
};
process.on("exit", cleanup);

async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const cand = 20000 + Math.floor(Math.random() * 20000);
    try { await fetch(`http://127.0.0.1:${cand}/`, { signal: AbortSignal.timeout(400) }); } catch { return cand; }
  }
  throw new Error("no free port in 20 tries");
}
/** Is this /version body the child WE spawned? Nonce-bound: nothing but our
 *  child was handed this run's WORLD_INSTANCE_NONCE, so no squatter, stale
 *  server, or TOCTOU winner on the probed port can answer with it. */
const ownedBy = (version: any, nonce: string) => version != null && typeof version === "object" && version.instance === nonce;

/** Spawn the sequencer PROCESS-OWNED (re-review blocker 2): a per-run
 *  WORLD_INSTANCE_NONCE goes INTO the child and must come back on /version
 *  before anything counts as up — readiness and identity are one check, so a
 *  foreign responder on the probed port never greens a claim. Logs piped (a
 *  failed boot prints its tail); stop() is the one cleanup owner and every
 *  section holds it in a finally. */
async function startServer(extra: Record<string, string | undefined>, lib?: string) {
  const PORT = await freePort();
  const nonce = crypto.randomUUID();
  const env: Record<string, string | undefined> = { ...process.env, PORT: String(PORT), JOIN_TOKEN: DOOR,
    WORLD_INSTANCE_NONCE: nonce,
    WORLDS_DIR: mkdtempSync(join(tmpdir(), "ew-lod-w-")), EIDOVERSE_DIR: lib ?? mkdtempSync(join(tmpdir(), "ew-lod-lib-")), ...extra };
  const proc = spawn(process.execPath, [join(ROOT, "server", "server.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
  live = proc;
  let log = "";
  proc.stdout!.on("data", (d) => { log += d; });
  proc.stderr!.on("data", (d) => { log += d; });
  let up = false;
  let version: any = null;
  for (let i = 0; i < 120 && !up; i++) {   // a cold transpile can eat 15s before the first log line
    if (proc.exitCode != null) break;   // died at boot — the tail says why
    try {
      version = await fetch(`http://127.0.0.1:${PORT}/version`).then((r) => r.json());
      if (ownedBy(version, nonce)) up = true;            // OUR child, not merely A server
      else break;                                        // someone else answers here — refuse, do not retry into their world
    } catch { await sleep(250); }
  }
  if (!up) console.log(`      child did not come up OWNED — log tail:\n      ${log.split("\n").slice(-6).join("\n      ")}`);
  const base = `http://127.0.0.1:${PORT}`;
  const stop = async () => { try { proc.kill(); } catch { /* gone */ } live = null; await sleep(300); };
  return { up, PORT, base, stop, log: () => log, version, nonce,
    key: keyFromVersion(version), lod: lodFromVersion(version),
    get: async (rel: string, headers: Record<string, string> = {}) => {
      const res = await fetch(`${base}/library/${rel}`, { headers });
      return { status: res.status, cc: res.headers.get("cache-control") ?? "",
        bytes: res.status === 200 ? new Uint8Array(await res.arrayBuffer()) : new Uint8Array(0) };
    },
    upload: async (bytes: Uint8Array, name: string) => fetch(`${base}/upload?token=${DOOR}&name=${name}`, { method: "POST", body: bytes }) };
}
const isLodGlb = (bytes: Uint8Array) => { try { return glbJson(bytes)?.asset?.extras?.recipe === LOD_RECIPE; } catch { return false; } };

// ---------------------------------------------- 4. store door: upload → tier chosen by recipe URL
console.log("\n  the store door — the tier URL carries the generation:");
{
  const S = await startServer({ KTX2_TOKTX: FAKE_TOKTX });
  try {
  check("child server came up OWNED (nonce-bound readiness)", S.up, `:${S.PORT}`);
  if (S.up) {
    check("the running sequencer publishes the LOD recipe on /version", S.lod === LOD_RECIPE, JSON.stringify(S.version?.lodRecipe));
    check("readiness IS identity: /version carries this run's nonce", ownedBy(S.version, S.nonce), JSON.stringify(S.version?.instance));
    check("impostor control: the same body under a WRONG or MISSING nonce is refused by the verifier",
      !ownedBy(S.version, crypto.randomUUID()) && !ownedBy({ ...S.version, instance: undefined }, S.nonce) && !ownedBy(null, S.nonce));
    const glb = await gridGlb("served", 160, true);
    const hash = hashOf(glb); mine.add(hash);
    await S.upload(glb, "lod-test");
    // ownership: only the tree we spawned from holds this run's fixture
    const own = await S.get(`store/${hash}.glb`);
    check("listener is OUR child (per-run fixture round-trips)", own.status === 200 && own.bytes.length === glb.length, `status=${own.status}`);
    const url = withLod(negotiate(`store/${hash}.glb`, S.key), S.lod);
    const early = await S.get(url);
    check("before the variant lands, the recipe URL answers PROVISIONALLY", isLodGlb(early.bytes) || early.cc === "no-cache", `cc=${early.cc}`);
    const landed = await until(() => existsSync(lodVariantPath(join(STORE, `${hash}.glb`))), 45_000);
    check("the queue built the recipe-named LOD shadow", landed, lodVariantPath(join(STORE, `${hash}.glb`)));
    if (landed) {
      const res = await S.get(url);
      check("?ktx2=<key>&lod=<recipe> → the stamped variant, immutable", isLodGlb(res.bytes) && res.cc.includes("immutable"), `cc=${res.cc}`);
      const other = await S.get(withLod(negotiate(`store/${hash}.glb`, S.key), "some-future-recipe"));
      check("an UNRECOGNIZED generation answers provisionally — the next process may negotiate it, nothing gets pinned",
        !isLodGlb(other.bytes) && other.cc === "no-cache", `cc=${other.cc}`);
      const noLod = await S.get(negotiate(`store/${hash}.glb`, S.key));
      check("without ?lod the same client gets the plain ktx2 chain — tiers chosen, never imposed", !isLodGlb(noLod.bytes));
      const listing: { path: string }[] = await fetch(`${S.base}/library-list?dir=store`).then((r) => r.json());
      check("/library-list shows the original once, no lod artifacts",
        listing.filter((f) => f.path.includes(hash)).length === 1 && !listing.some((f) => isLodVariant(f.path)));
      const catalog: { path: string }[] = await fetch(`${S.base}/library-models`).then((r) => r.json());
      check("/library-models lists it once, never the variant",
        catalog.filter((h) => h.path === `store/${hash}.glb`).length === 1 && !catalog.some((h) => isLodVariant(h.path)));
    }
    const body = await skinnedGlb("served");
    const bh = hashOf(body); mine.add(bh);
    await S.upload(body, "body-test");
    const refused = await until(() => existsSync(`${lodVariantPath(join(STORE, `${bh}.glb`))}.failed`), 45_000);
    const verdict = refused ? readFileSync(`${lodVariantPath(join(STORE, `${bh}.glb`))}.failed`, "utf8") : "";
    check("an uploaded BODY gets the typed verdict marker and no variant",
      refused && verdict.includes("unsupported: skinned/avatar asset") && !existsSync(lodVariantPath(join(STORE, `${bh}.glb`))), verdict.slice(0, 80));
    const bodyRes = await S.get(withLod(negotiate(`store/${bh}.glb`, S.key), S.lod));
    check("…and its recipe-URL fetch falls back whole — never a half-valid object", !isLodGlb(bodyRes.bytes));
  }
  } finally { await S.stop(); }
}

// ---------------------------------------------- 5. the library arm + mutable-source freshness
console.log("\n  the library arm — the sweep queues LODs, and mutable sources are never served stale:");
{
  const LIB = mkdtempSync(join(tmpdir(), "ew-lod-reallib-"));
  const modelsDir = join(LIB, "eidoverse", "assets", "models");
  mkdirSync(modelsDir, { recursive: true });
  const libGlb = await gridGlb("library", 160, true);
  const REL = "eidoverse/assets/models/lod_probe_fixture.glb";
  writeFileSync(join(LIB, REL), libGlb);
  mineOpt.push(`${REL}.ktx2.glb`, `${REL}.ktx2.glb.failed`,
    ...[LOD_RECIPE, "x"].map((r0) => `${REL}.lod.${r0}.glb`), `${REL}.lod.${LOD_RECIPE}.glb.failed`);
  let S = await startServer({ KTX2_TOKTX: FAKE_TOKTX }, LIB);
  try {
  check("child server came up OWNED over the fixture library", S.up, `:${S.PORT}`);
  if (S.up) {
    const own = await S.get(REL);
    check("listener is OUR child (the per-run library fixture round-trips)", own.status === 200 && own.bytes.length === libGlb.length);
    const lodPath = join(OPT, `${REL}.lod.${LOD_RECIPE}.glb`);
    const landed = await until(() => existsSync(lodPath), 60_000);
    check("the LIBRARY sweep queued and built the LOD (the shared-seen bug is dead)", landed,
      S.log().split("\n").filter((l) => l.includes("lod") || l.includes("ktx2")).slice(-4).join(" | "));
    check("…and the ktx2 arm still built its own variant beside it", await until(() => existsSync(join(OPT, `${REL}.ktx2.glb`)), 60_000));
    if (landed) {
      const res = await S.get(withLod(negotiate(REL, S.key), S.lod));
      check("the library LOD serves under the recipe URL", isLodGlb(res.bytes));
      // the catalog humans pick from must not show the variant as a model. The
      // store section asserts this for a store hash — where OPT_DIR is never
      // walked as a models dir. THIS is the library side, where /library-models
      // walks OPT_DIR/eidoverse/assets/models beside the originals (routes.ts):
      // the walk's filter was written for the ktx2 arm alone, and every baked
      // library LOD listed as a model of its own. Fails on main; the fix is one
      // predicate, the one /library-list already used (isServingArtifact).
      const catalog: { path: string }[] = await fetch(`${S.base}/library-models`).then((r) => r.json());
      const leaked = catalog.filter((h) => isLodVariant(h.path)).map((h) => h.path);
      check("/library-models lists the library original once and NEVER its lod variant (the OPT_DIR walk)",
        catalog.filter((h) => h.path === REL).length === 1 && leaked.length === 0,
        `original×${catalog.filter((h) => h.path === REL).length}, leaked: ${leaked.slice(0, 2).join(" | ") || "none"}`);
      // the source mutates (a library file is MUTABLE): the old variant must
      // never serve under the new source — provisional until rebuilt
      await sleep(1100);   // a strictly newer mtime, beyond timestamp granularity
      const libGlb2 = await gridGlb("library-v2", 160, true);
      writeFileSync(join(LIB, REL), libGlb2);
      const now = new Date();
      utimesSync(join(LIB, REL), now, now);
      const stale = await S.get(withLod(negotiate(REL, S.key), S.lod));
      check("source newer than variant → the variant is NOT served; the fall-through is provisional",
        !isLodGlb(stale.bytes) && stale.cc === "no-cache", `cc=${stale.cc}`);
      await S.stop();
      // the next boot's sweep rebuilds it (mtime), and the fresh variant serves
      S = await startServer({ KTX2_TOKTX: FAKE_TOKTX }, LIB);
      check("child rebooted", S.up);
      if (S.up) {
        const rebuilt = await until(() => existsSync(lodPath) && Bun.file(lodPath).lastModified > Bun.file(join(LIB, REL)).lastModified, 60_000);
        check("the next boot re-swept the mutated source into a FRESH variant", rebuilt);
        if (rebuilt) {
          const res2 = await S.get(withLod(negotiate(REL, S.key), S.lod));
          check("…which serves — bound to the new source", isLodGlb(res2.bytes));
        }
      }
    }
  }
  } finally { await S.stop(); try { rmSync(LIB, { recursive: true, force: true }); } catch { /* best effort */ } }
}

// ---------------------------------------------- 6. no encoder: untextured LOD work survives
console.log("\n  no encoder — geometry work is not the encoder's hostage:");
{
  const S = await startServer(NO_ENCODER);
  try {
  check("child server came up OWNED with no encoder anywhere", S.up, `:${S.PORT}`);
  if (S.up) {
    const untex = await gridGlb("noenc-untex", 160, false);
    const uh = hashOf(untex); mine.add(uh);
    await S.upload(untex, "noenc-untex");
    const tex = await gridGlb("noenc-tex", 160, true);
    const th = hashOf(tex); mine.add(th);
    await S.upload(tex, "noenc-tex");
    const landed = await until(() => existsSync(lodVariantPath(join(STORE, `${uh}.glb`))), 45_000);
    check("the UNTEXTURED upload got its LOD — ktx2Skip no longer deletes valid geometry work", landed,
      S.log().split("\n").filter((l) => l.includes("lod") || l.includes("encoder")).slice(-4).join(" | "));
    await until(() => existsSync(join(STORE_MIN, `${th}.glb`)) || existsSync(join(STORE_MIN, `${th}.glb.failed`)), 45_000);
    await sleep(1500);
    check("the TEXTURED upload kept its original: no variant, NO marker (environmental)",
      !existsSync(lodVariantPath(join(STORE, `${th}.glb`))) && !existsSync(`${lodVariantPath(join(STORE, `${th}.glb`))}.failed`));
    check("…with the --lod arm's own once-per-boot note, and no ktx2Skip purge of lod items",
      S.log().split("\n").filter((l) => l.includes("[lod] no KTX2 encoder")).length === 1, `${S.log().split("\n").filter((l) => l.includes("[lod] no KTX2 encoder")).length} line(s)`);
  }
  } finally { await S.stop(); }
}

// ---------------------------------------------- 7. the mutation canary: a recipe change cannot pin
console.log("\n  the canary — a pulled recipe lands under a running sequencer:");
{
  const SV = join(ROOT, "server", "store-variants.ts");
  const pristine = readFileSync(SV);
  const restore = () => { try { writeFileSync(SV, pristine); } catch { /* best effort */ } };
  process.on("exit", restore);
  const glb = await gridGlb("canary", 160, true);
  const hash = hashOf(glb); mine.add(hash);
  writeFileSync(join(STORE, `${hash}.glb`), glb);
  const S = await startServer({ KTX2_TOKTX: FAKE_TOKTX });
  check("child server came up with the PRISTINE recipe in memory", S.up && S.lod === LOD_RECIPE, `${S.up} lod=${S.lod}`);
  try {
    if (S.up) {
      const landed = await until(() => existsSync(lodVariantPath(join(STORE, `${hash}.glb`))), 45_000);
      check("its boot sweep built the current-generation variant", landed);
      const NEXT = "lod1-r10-future";
      writeFileSync(SV, pristine.toString("utf8").replace(`export const LOD_RECIPE = "${LOD_RECIPE}";`, `export const LOD_RECIPE = "${NEXT}";`));
      const version2 = await fetch(`${S.base}/version`).then((r) => r.json());
      check("the pull landed; /version still publishes the RUNNING recipe", lodFromVersion(version2) === LOD_RECIPE, JSON.stringify(version2.lodRecipe));
      const good = await S.get(withLod(negotiate(`store/${hash}.glb`, S.key), LOD_RECIPE));
      check("a client keyed from /version gets the variant, immutable — correct", isLodGlb(good.bytes) && good.cc.includes("immutable"), good.cc);
      const bad = await S.get(withLod(negotiate(`store/${hash}.glb`, S.key), NEXT));
      check("the NEXT generation's URL answers no-cache and NOT the old variant — nothing for the new recipe to inherit",
        !isLodGlb(bad.bytes) && bad.cc === "no-cache", `cc=${bad.cc} lod=${isLodGlb(bad.bytes)}`);
    }
  } finally { restore(); await S.stop(); }
  check("the on-disk recipe is restored byte-for-byte", readFileSync(SV).equals(pristine));
}

cleanup();
console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : "\n\x1b[32m0 failed\x1b[0m");
process.exit(failures ? 1 : 0);
