// The store's KTX2 shadow (server/store-variants.ts, shared/ktx2.js), run
// headless — helpers, the optimizer's refusal seams, and the real sequencer.
//
//   bun tools/store-variants-test.ts
//   KTX2_TOKTX=/path/to/toktx bun tools/store-variants-test.ts   # + one real encode
//
// The contract under test: a store upload gets a KTX2 variant BESIDE the
// original (store/<hash>.glb.ktx2.glb — the library's <rel>.ktx2.glb
// convention, which is the path /library?ktx2=<key> already resolves); the
// variant is built from the ORIGINAL and is really KTX2, ALL of it — the
// optimizer refuses a partial or empty conversion rather than write a
// .ktx2.glb whose name lies (the #122 class), and refuses it RETRYABLY (exit
// 5, no .failed marker; exit 2 + marker only when there was nothing to
// convert); the ghost-listing rule — a variant, a marker, a .tmp is never
// enumerated as an asset, not by the store catalog (/library-models), not by
// the listing the prefetcher warms from (/library-list), not by the boot
// sweep; the negotiation key is a GENERATION (shared/ktx2.js): the current
// key negotiates, a retired one is an unflagged fetch, and a browser only
// ever uses the key the RUNNING sequencer published on /version — none
// published, none used — and section 8 replays the collision itself as a canary:
// a pull landing under a running sequencer cannot poison the next key; the KTX2
// arm keeps the shadow's TEXEL BUDGET (1024², capTexels → toktx --resize) so a
// variant is never a 1.5× quality upgrade the size gate refuses, and a size
// verdict carries its recipe (verdictStands) so a new recipe re-measures the
// old refusals at the next boot; and a flagged fetch
// answered by the webp shadow is PROVISIONAL — no-cache, never immutable —
// so the variant's bytes get through the moment it exists, which the
// If-None-Match round-trip here demonstrates.
//
// No encoder is needed for any of it: a FAKE toktx (a bun script behind a
// platform wrapper, driven by FAKE_TOKTX_MODE) emits a canned real KTX2, or
// fails, or fails on its second call, or writes bytes that are not KTX2 —
// the seams the review asked to see exercised. Section 3 also runs the real
// encoder once if the box has one (the exit-3 doctrine: none → skipped).
// Sections 4-7 spawn the real sequencer (the deps-route-test pattern:
// verified-free port, fixture-as-nonce ownership) with the fake encoder in
// its environment and drive it through POST /upload, the boot sweep, and
// the fetches a browser makes.
//
// Negative control: on the branch base this file dies at import
// (server/store-variants.ts, shared/ktx2.js do not exist). Of the serving
// checks, main fails "flagged → variant" (nothing ever wrote that path) and
// "fall-through is provisional" (the show box, 2026-08-24: every store
// ?ktx2=1 answer immutable, every one webp); of the optimizer checks, main
// writes the partial and the empty variant (review of #142, reproduced).

import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, rmdirSync, chmodSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { PNG } from "pngjs";
import { isStoreOriginal, isKtx2Variant, isServingArtifact, ktx2VariantPath, storeShadowsMissing, KTX2_SUFFIX, KTX2_LEGACY_SUFFIX,
  capTexels, verdictStands, recipeStamp, KTX2_TEXEL_CAP, KTX2_RECIPE,
  LOD_RECIPE, LOD_GEN, LOD_MIN_VERTS, lodRecipeFor, lodVariantPath, isLodVariant, lodVerdictKind, lodVerdictFinal, hasStamp } from "../server/store-variants.ts";
import { findKtx2Encoder, isKtx2Container } from "../server/optimize.ts";
import { KTX2_KEY, KTX2_QUERY, KTX2_GEN, ktx2KeyFor, ktx2RecipeFor, wantsKtx2, withKtx2, keyFromVersion, negotiate } from "../shared/ktx2.js";

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

console.log("\nthe store's KTX2 shadow (store-variants.ts, shared/ktx2.js):\n");

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

  check("the variant lives beside the original, and its NAME carries the recipe that baked it",
    ktx2VariantPath(original) === join(OPT, `store/${hash}.glb.ktx2.${KTX2_RECIPE}.glb`) && ktx2VariantPath(original) === `${original}${KTX2_SUFFIX}`,
    ktx2VariantPath(original));
  // The serving contract: routes.ts resolves a flagged fetch through this
  // same function (one spelling — the door test below proves which file
  // answers), so a bake from ANOTHER generation has another name and is
  // never looked up. Everything baked before the recipe joined the name —
  // the legacy `<rel>.ktx2.glb` — is such a generation.
  const legacy = `${original}${KTX2_LEGACY_SUFFIX}`;
  check("the legacy name is NOT this generation's path — what is on disk under it is never resolved",
    legacy === join(OPT, `${rel}.ktx2.glb`) && legacy !== ktx2VariantPath(original));
  check("another recipe is another name", ktx2VariantPath(original, ktx2RecipeFor({ texel: 2048 })) !== ktx2VariantPath(original)
    && ktx2VariantPath(original, ktx2RecipeFor({ texel: 2048 })).endsWith(".ktx2.texel2048.glb"));

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
  m = missing([legacy, `${legacy}.failed`, ktx2VariantPath(original, "texel2048")]);
  check("ANOTHER generation's variant or verdict present → this generation's shadow is still MISSING (the sweep re-bakes)", m.ktx2);
  m = missing([`${ktx2VariantPath(original)}.failed`]);
  check("a variant .failed counts as answered too", m.min && !m.ktx2);
  m = missing([join(minDir, `${hash}.glb`), ktx2VariantPath(original)]);
  check("both present → nothing to queue", !m.min && !m.ktx2);

  // the texel budget: the shadow's 1024², never more, never UP
  check("the budget is the webp shadow's 1024²", KTX2_TEXEL_CAP === 1024);
  check("a 1024² texture is within budget — no resize", capTexels([1024, 1024]) === null);
  check("a 512² texture is not upscaled", capTexels([512, 512]) === null);
  check("2048² → 1024²", JSON.stringify(capTexels([2048, 2048])) === "[1024,1024]");
  check("2048×1024 → 1024×512 (aspect kept)", JSON.stringify(capTexels([2048, 1024])) === "[1024,512]");
  check("4096×3072 → 1024×768", JSON.stringify(capTexels([4096, 3072])) === "[1024,768]");
  check("2048×1500 → 1024×752 (4-aligned for the block format)", JSON.stringify(capTexels([2048, 1500])) === "[1024,752]");
  check("no size → no resize", capTexels(null) === null && capTexels([0, 0]) === null);

  // the verdict: a size refusal is only as durable as its recipe
  const prodMarker = "[optimize] not smaller (17600988 -> 26716692, 91234ms) — keeping original";   // the show box, 2026-08-25, ×16
  check("the show box's sixteen refusals carry no stamp → stale, a question again", !verdictStands(prodMarker));
  check("a refusal under the CURRENT recipe stands", verdictStands(`[optimize] not smaller (1 -> 2, 3ms) ${recipeStamp()} — keeping original`));
  check("a refusal under an OLDER recipe does not", !verdictStands(`[optimize] not smaller (1 -> 2, 3ms) ${recipeStamp("texel2048")} — keeping original`));
  check("…nor one whose stamp merely EXTENDS this recipe's (texel10240 is not texel1024): the match is delimited, never a prefix",
    !verdictStands(`[optimize] not smaller (1 -> 2, 3ms) ${recipeStamp("texel10240")} — keeping original`)
    && hasStamp(`x ${recipeStamp("texel1024")} y`, "texel1024") && hasStamp(recipeStamp("texel1024"), "texel1024") && !hasStamp(`${recipeStamp("texel1024")}0`, "texel1024"));
  check("a content verdict stands regardless (nothing to convert)", verdictStands("[optimize] ktx2: no convertible raster images (12ms) — keeping original"));
  check("…and so does a hard failure", verdictStands("exit 1") && verdictStands(""));

  // the LOD recipe DERIVES from its parameters — a floor change is a generation change by construction
  check("LOD_RECIPE derives from (gen, ratio, error, texel, floor)",
    LOD_RECIPE === lodRecipeFor() && LOD_RECIPE === `lod${LOD_GEN}-r25e01-texel${KTX2_TEXEL_CAP}-min${LOD_MIN_VERTS}`, LOD_RECIPE);
  check("a lower floor is a NEW recipe — a new URL and a new filename, nothing pinned under the old",
    lodRecipeFor({ minVerts: 6000 }) !== LOD_RECIPE && lodVariantPath("store/x.glb", lodRecipeFor({ minVerts: 6000 })) !== lodVariantPath("store/x.glb"));
  check("…and so is a reducer generation bump, a ratio, an error bound, a texel budget",
    new Set([LOD_RECIPE, lodRecipeFor({ gen: LOD_GEN + 1 }), lodRecipeFor({ ratio: 0.5 }), lodRecipeFor({ error: 0.02 }), lodRecipeFor({ texel: 2048 })]).size === 5);
  check("the recipe is URL- and filename-safe, within the client's bound, and isLodVariant recognizes it",
    /^[a-z0-9.-]+$/.test(LOD_RECIPE) && LOD_RECIPE.length <= 64 && isLodVariant(lodVariantPath("store/x.glb")));
  check("the encoding is INJECTIVE at the reducer's precision: 0.014 is not 0.01, 0.5 is not 0.05 (a rounded percent read them alike)",
    lodRecipeFor({ error: 0.014 }) !== LOD_RECIPE && lodRecipeFor({ error: 0.014 }).includes("e014-")
    && lodRecipeFor({ ratio: 0.5 }) !== lodRecipeFor({ ratio: 0.05 }) && lodRecipeFor({ ratio: 0.5 }).includes("-r5e"), lodRecipeFor({ error: 0.014 }));
  check("a parameter the string cannot carry faithfully is refused, not mangled",
    [() => lodRecipeFor({ ratio: 1 }), () => lodRecipeFor({ error: 0 }), () => lodRecipeFor({ error: 1e-7 }), () => lodRecipeFor({ minVerts: 12000.5 })].every((f) => { try { f(); return false; } catch { return true; } }));

  // standing verdicts: which typed refusals make the original the FINAL answer under the running recipe
  {
    const stamp = recipeStamp(LOD_RECIPE);
    const line = (v: string) => `[optimize] lod: ${v} (47ms) ${stamp} — original stays the only representation`;
    const light = line(`already light (981 verts < ${LOD_MIN_VERTS})`);
    check("skinned / VRM / joint-weights / morph / animated refusals are STRUCTURAL — properties of the content alone",
      ["unsupported: skinned/avatar asset (skins)", "unsupported: skinned/avatar asset (VRM metadata)", "unsupported: skinned/avatar asset (joint weights)",
        "unsupported: morph targets the reducer cannot prove preserved", "unsupported: animated object (v1 reduces static geometry only)"]
        .every((v) => lodVerdictKind(line(v)) === "structural"));
    check("'already light' is a FLOOR verdict — and the floor is in the recipe", lodVerdictKind(light) === "light");
    check("'reduction ineffective' and a preservation failure depend on the REDUCER",
      lodVerdictKind(line("reduction ineffective (14000 -> 9000 verts)")) === "ineffective" && lodVerdictKind(line("preservation failed: bounds moved on axis 1")) === "preservation");
    check("anything else is unclassified: a ktx2 size verdict, a deferral note, an exit code, nothing",
      [`[optimize] not smaller (1 -> 2, 3ms) ${recipeStamp()}`, "estimated 900MB > budget 512MB", "exit 1", ""].every((c) => lodVerdictKind(c) === null));
    check("FINAL: a structural or floor verdict stamped with the running recipe", lodVerdictFinal(line("unsupported: skinned/avatar asset (skins)")) && lodVerdictFinal(light));
    check("NOT final: ineffective / preservation — a better reducer may succeed under the same content",
      !lodVerdictFinal(line("reduction ineffective (14000 -> 9000 verts)")) && !lodVerdictFinal(line("preservation failed: material assignments changed")));
    check("NOT final: a floor verdict without the stamp (an older CLI), under another floor, or judged against another generation",
      !lodVerdictFinal(light.replace(stamp, "")) && !lodVerdictFinal(light.replace(stamp, recipeStamp(lodRecipeFor({ minVerts: 6000 })))) && !lodVerdictFinal(light, lodRecipeFor({ gen: 2 })));
    check("NOT final: unclassified, however stamped", !lodVerdictFinal(`exit 1 ${stamp}`) && !lodVerdictFinal(stamp) && !lodVerdictFinal(""));
    check("NOT final: a stamp that EXTENDS the running recipe's (min120000 for min12000) — the pull-window case, a newer CLI's verdict in the older server's filename",
      !lodVerdictFinal(light.replace(stamp, recipeStamp(`${LOD_RECIPE}0`))) && !lodVerdictFinal(light, `${LOD_RECIPE}0`) && !lodVerdictFinal(light, LOD_RECIPE.slice(0, -1)));
  }
  {
    const minDir2 = join(OPT, "store-min");
    const marker = `${ktx2VariantPath(original)}.failed`;
    const m1 = storeShadowsMissing(original, minDir2, (p) => p === marker, () => prodMarker);
    check("storeShadowsMissing: a stale size verdict → the KTX2 shadow is MISSING (retry)", m1.ktx2);
    const m2 = storeShadowsMissing(original, minDir2, (p) => p === marker, () => `not smaller ${recipeStamp()}`);
    check("…a current one → not missing (no retry)", !m2.ktx2);
  }

  // the negotiation key is a generation, shared by both sides — and it
  // DERIVES from the recipe: a variant's bytes are a function of source and
  // recipe, the key is the only part of a flagged URL a client can vary, so
  // a recipe change that did not rotate it would answer a new generation's
  // bytes under an address caches hold the old generation's for
  check("the key derives from (generation, recipe)", KTX2_KEY === ktx2KeyFor() && KTX2_KEY === `${KTX2_GEN}-${KTX2_RECIPE}` && KTX2_QUERY === `ktx2=${KTX2_KEY}`, KTX2_KEY);
  check("the recipe derives from the texel budget", KTX2_RECIPE === ktx2RecipeFor() && KTX2_RECIPE === `texel${KTX2_TEXEL_CAP}`, KTX2_RECIPE);
  check("a different budget is a different recipe AND a different key — URL and filename rotate together, by construction",
    ktx2RecipeFor({ texel: 2048 }) !== KTX2_RECIPE && ktx2KeyFor({ recipe: ktx2RecipeFor({ texel: 2048 }) }) !== KTX2_KEY);
  check("a generation bump alone rotates the key and leaves the recipe (a poisoned cache, a changed encoder)",
    ktx2KeyFor({ gen: KTX2_GEN + 1 }) !== KTX2_KEY && ktx2KeyFor({ gen: KTX2_GEN + 1 }).endsWith(`-${KTX2_RECIPE}`));
  check("the key is PUBLISHABLE — the shape a client accepts off /version (a key keyFromVersion refuses is no key)", keyFromVersion({ ktx2Key: KTX2_KEY }) === KTX2_KEY);
  check("what the key cannot carry faithfully is refused, not mangled",
    [() => ktx2RecipeFor({ texel: 1023 }), () => ktx2RecipeFor({ texel: 0 }), () => ktx2RecipeFor({ texel: 1024.5 }), () => ktx2KeyFor({ gen: 0 }), () => ktx2KeyFor({ gen: 1.5 }),
      () => ktx2KeyFor({ recipe: "a b" }), () => ktx2KeyFor({ recipe: "x".repeat(40) })].every((f) => { try { f(); return false; } catch { return true; } }));
  check("generation 4 (3 retired with the over-budget bakes pinned under it; 1 and 2 before it)", KTX2_GEN === 4);
  check("the current key negotiates", wantsKtx2(new URLSearchParams(`ktx2=${KTX2_KEY}`)));
  check("the just-retired key (=3) does NOT — it is an unflagged fetch now", !wantsKtx2(new URLSearchParams("ktx2=3")));
  check("…nor the bare generation number, nor the recipe alone, nor a key that merely EXTENDS this one",
    !wantsKtx2(new URLSearchParams(`ktx2=${KTX2_GEN}`)) && !wantsKtx2(new URLSearchParams(`ktx2=${KTX2_RECIPE}`)) && !wantsKtx2(new URLSearchParams(`ktx2=${KTX2_KEY}0`)));
  check("the retired rollout key (=2) does not negotiate", !wantsKtx2(new URLSearchParams("ktx2=2")));
  check("the original retired key does not negotiate either", !wantsKtx2(new URLSearchParams("ktx2=1")));
  check("no key does not", !wantsKtx2(new URLSearchParams("v=123")));
  check("withKtx2 appends with ? on a bare path", withKtx2("store/x.glb") === `store/x.glb?ktx2=${KTX2_KEY}`);
  check("…and with & when ?v= is already there (avatar URLs)", withKtx2("eidoverse/assets/vrms/a.vrm?v=9") === `eidoverse/assets/vrms/a.vrm?v=9&ktx2=${KTX2_KEY}`);

  // The browser's half: the key it uses is the one the RUNNING sequencer
  // published on /version — never one read off a served file.
  check("keyFromVersion reads the published key", keyFromVersion({ sha: "abc", ktx2Key: "3" }) === "3");
  check("…an older sequencer publishes none → null (the rollout collision, made impossible)", keyFromVersion({ sha: "abc", commitTime: "…" }) === null);
  check("…garbage is not a key", keyFromVersion(null) === null && keyFromVersion("3") === null && keyFromVersion({ ktx2Key: "" }) === null && keyFromVersion({ ktx2Key: "a b?" }) === null);
  check("negotiate with a key appends it", negotiate("store/x.glb", "3") === "store/x.glb?ktx2=3" && negotiate("a.vrm?v=9", "3") === "a.vrm?v=9&ktx2=3");
  check("negotiate with NO key is the bare URL — an unflagged fetch, never pinned wrong", negotiate("store/x.glb", null) === "store/x.glb");
  // the collision itself, as a table: what the client asked vs what the server knew
  const onDisk = "2", running = null;                   // pull landed, restart pending
  check("rollout window: the client, taking the key from /version, does not negotiate (old: it asked ?ktx2=2 off disk and got pinned)",
    negotiate("store/x.glb", keyFromVersion({ sha: "old", ktx2Key: running })) === "store/x.glb" && onDisk !== running);
}

// ---------------------------------------------- 2. the ghost-listing rule
{
  // What readdirSync(store/) returns once variants exist. The catalog and the
  // boot sweep both filter with isStoreOriginal; endsWith(".glb") — what
  // they used to do — lists the variant as a second "conjured 305ea800…"
  // and queues it for shadows of its own.
  const listing = ["305ea80018ad4dbf.glb", "305ea80018ad4dbf.glb.ktx2.glb", "305ea80018ad4dbf.glb.ktx2.glb.failed",
    "a1b2c3d4e5f60718.glb", "manifest.json", "manifest.json.tmp", "scripts"];
  const originals = listing.filter(isStoreOriginal);
  check("the catalog lists each upload once", originals.length === 2 && originals[0] === "305ea80018ad4dbf.glb" && originals[1] === "a1b2c3d4e5f60718.glb",
    originals.join(", "));
  check("…and endsWith(\".glb\") would have listed the ghost (the old predicate)",
    listing.filter((f) => f.endsWith(".glb")).length === 3);

  // The listing rule is one predicate for every asset class the §20 arc
  // shadows — what /library-list must skip so the prefetcher (which pushes
  // every listed store path as a fetch) never pulls a variant twice…
  for (const v of [`x.glb${KTX2_SUFFIX}`, "x.glb.ktx2.texel2048.glb", "x.glb.ktx2.glb", "aletheia.vrm.ktx2.vrm", "moon_color_1k.jpg.ktx2", "grass_01.png.ktx2", "UPPER.GLB.KTX2.GLB", "UPPER.GLB.KTX2.TEXEL1024.GLB"])
    check(`${v} is a variant — of whichever generation`, isKtx2Variant(v) && isServingArtifact(v) && !isStoreOriginal(v));
  for (const o of ["x.glb", "aletheia.vrm", "moon_color_1k.jpg", "manifest.json", "sky_system.js"])
    check(`${o} is not`, !isKtx2Variant(o) && !isServingArtifact(o));
  // …nor fetches a marker as a model (review of #142, P2)
  for (const a of ["x.glb.ktx2.glb.failed", "x.glb.failed", "x.glb.tmp", "manifest.json.tmp", "x.glb.ktx2.glb.tmp", "x.glb.ktx2.glb.deferred", "x.glb.lod.lod1-r25e01-texel1024.glb.deferred",
    `x.glb${KTX2_SUFFIX}.failed`, `x.glb${KTX2_SUFFIX}.tmp`, `x.glb${KTX2_SUFFIX}.deferred`])
    check(`${a} is a serving artifact, never a listing entry`, isServingArtifact(a));
  check("the listing the prefetcher sees is originals + the manifest only",
    listing.filter((f) => !isServingArtifact(f)).join(",") === "305ea80018ad4dbf.glb,a1b2c3d4e5f60718.glb,manifest.json,scripts");
}

// ---------------------------------------------- fixtures
// Varying textures — prune() folds a solid one into baseColorFactor and drops
// it. 4-aligned PNGs, so optimize.ts hands them to the encoder as-is (no
// sharp in the loop: one-libvips-test.ts owns that story). The node name
// carries a per-run nonce, so each fixture's content hash — its store path
// — is unique to THIS run: the fixture is its own ownership proof against a
// spawned server (only the tree we spawn from has it).
const NONCE = crypto.randomUUID();
function pngBytes(seed: number, W = 64): Uint8Array {
  const png = new PNG({ width: W, height: W });
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      png.data[i] = (x * 4 + seed) & 0xff; png.data[i + 1] = (y * 4) & 0xff; png.data[i + 2] = ((x ^ y) * 4 + seed) & 0xff; png.data[i + 3] = 255;
    }
  return new Uint8Array(PNG.sync.write(png));
}
/** `textures`: 0 = untextured mesh, 1 = baseColor, 2 = baseColor + normal
 *  (the normal takes the UASTC branch — a different encoder argv). */
async function fixtureGlb(tag: string, textures: 0 | 1 | 2, extraNode = false, texSize = 64, extras: object | null = null): Promise<Uint8Array> {
  const doc = new Document();
  if (extras) doc.getRoot().getAsset().extras = extras;
  const buf = doc.createBuffer();
  const mat = doc.createMaterial("probeMat");
  if (textures >= 1) mat.setBaseColorTexture(doc.createTexture("base").setImage(pngBytes(1, texSize)).setMimeType("image/png"));
  if (textures >= 2) mat.setNormalTexture(doc.createTexture("normal").setImage(pngBytes(7, texSize)).setMimeType("image/png"));
  const prim = doc.createPrimitive().setMaterial(mat)
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setBuffer(buf)
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])))
    // UVs are load-bearing: without them prune() reads the textures as
    // unreferenced and drops them, and the pass has nothing to encode
    .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setBuffer(buf)
      .setArray(new Float32Array([0, 0, 1, 0, 0, 1])));
  const mesh = doc.createMesh("probeMesh").addPrimitive(prim);
  const scene = doc.createScene("s").addChild(doc.createNode(`${tag}-${NONCE}`).setMesh(mesh));
  // a stand-in variant must differ from its original in SIZE, not just in
  // bytes: serveFrom's ETag is size+mtime (a real variant never matches the
  // shadow's size; a fixture written in the same millisecond can)
  if (extraNode) scene.addChild(doc.createNode(`${tag}-second-node-so-the-size-differs`));
  return new NodeIO().writeBinary(doc);
}
const hashOf = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex").slice(0, 16);
const glbJson = (bytes: Uint8Array) => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + dv.getUint32(12, true))));
};
/** [pixelWidth, pixelHeight] of every embedded image, read off the KTX2
 *  header (u32 at 20 and 24) — the encoder's own statement of the size. */
const ktx2Dims = (bytes: Uint8Array): [number, number][] => {
  const j = glbJson(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  const jsonLen = dv.getUint32(12, true), binOff = 20 + jsonLen + 8;
  return (j.images ?? []).map((im: any) => {
    const v = j.bufferViews[im.bufferView], o = binOff + (v.byteOffset ?? 0);
    return [dv.getUint32(o + 20, true), dv.getUint32(o + 24, true)] as [number, number];
  });
};
const isKtx2Glb = (bytes: Uint8Array) => {
  try {
    const j = glbJson(bytes);
    const mimes: string[] = (j.images ?? []).map((im: any) => im.mimeType);
    return (j.extensionsRequired ?? []).includes("KHR_texture_basisu") && mimes.length > 0 && mimes.every((m) => m === "image/ktx2");
  } catch { return false; }
};

// ---------------------------------------------- the fake encoder
// A real 4×4 ETC1S KTX2 (toktx v4.4.2, 506 bytes) — what "ok" emits. The
// optimizer checks the container magic on every encoder output, so the fake
// has to produce the genuine article to be accepted; "garbage" is the
// control for that check.
const CANNED_KTX2 = Uint8Array.from(atob(
  "q0tUWCAyMLsNChoKAAAAAAEAAAAEAAAABAAAAAAAAAAAAAAAAQAAAAMAAAABAAAAmAAAACwAAADEAAAAeAAAAEABAAAAAAAAtwAAAAAAAAD5AQAAAAAAAAEAAAAAAAAAAAAAAAAAAAD4AQAAAAAAAAEAAAAAAAAAAAAAAAAAAAD3AQAAAAAAAAEAAAAAAAAAAAAAAAAAAAAsAAAAAAAAAAIAKACjAQIAAwMAAAgAAAAAAAAAAAA/AAAAAAAAAAAA/////xIAAABLVFhvcmllbnRhdGlvbgByZAAAACcAAABLVFh3cml0ZXIAdG9rdHggdjQuNC4yIC8gbGlia3R4IHY0LjQuMgAALgAAAEtUWHdyaXRlclNjUGFyYW1zAC0tZW5jb2RlIGV0YzFzIC0tcWxldmVsIDEyOAAAAAAAAAADAAMALwAAAA0AAAArAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAALABIAAAAAAACIIEDVAAAAAGBQMu0EYGABMAAAAAAAAIBCAKQAAAAAAEGiR9GgYpPr//4cqVf9XVVVVBQDBRAAAAAAAAPJfbQCYAAAAAAAAQUYATAAQAAAAgEBxADABAAAAAACAAAIMBgo="),
  (c) => c.charCodeAt(0));
check("the canned KTX2 carries the container magic", isKtx2Container(CANNED_KTX2));

const FAKE_DIR = mkdtempSync(join(tmpdir(), "ew-fake-toktx-"));
const FAKE_SCRIPT = join(FAKE_DIR, "fake-toktx.ts");
writeFileSync(join(FAKE_DIR, "canned.ktx2"), CANNED_KTX2);
writeFileSync(FAKE_SCRIPT, `// fake encoder — toktx's argv shape [...flags, outPath, inPath], or \`ktx create … inPath outPath\`
const argv = process.argv.slice(2);
const ktxShape = argv[0] === "create";
const outPath = ktxShape ? argv[argv.length - 1] : argv[argv.length - 2], inPath = ktxShape ? argv[argv.length - 2] : argv[argv.length - 1];
if (process.env.FAKE_TOKTX_DIMLOG) {   // what the encoder was HANDED: the PNG's own IHDR
  const fs = await import("node:fs");
  const b = fs.readFileSync(inPath);
  fs.appendFileSync(process.env.FAKE_TOKTX_DIMLOG, (b.readUInt32BE(12) === 0x49484452 ? b.readUInt32BE(16) + "x" + b.readUInt32BE(20) : "not-png") + String.fromCharCode(10));
}
const mode = process.env.FAKE_TOKTX_MODE ?? "ok";
if (process.env.FAKE_TOKTX_ARGLOG) (await import("node:fs")).appendFileSync(process.env.FAKE_TOKTX_ARGLOG, argv.join(" ") + String.fromCharCode(10));
const counter = process.env.FAKE_TOKTX_COUNTER;
let n = 1;
if (counter) {
  const fs = await import("node:fs");
  n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
  fs.writeFileSync(counter, String(n));
}
if (mode === "fail" || (mode === "fail-second" && n % 2 === 0)) { console.error("fake toktx: refusing " + inPath); process.exit(1); }
const fs = await import("node:fs");
if (mode === "garbage") { fs.writeFileSync(outPath, fs.readFileSync(inPath)); process.exit(0); }   // exit 0, bytes are the PNG
if (mode === "bloat") {   // a real KTX2 header followed by a megabyte of padding — bigger than any fixture source
  const canned = fs.readFileSync(new URL("./canned.ktx2", import.meta.url));
  fs.writeFileSync(outPath, Buffer.concat([canned, Buffer.alloc(1 << 20)])); process.exit(0);
}
fs.copyFileSync(new URL("./canned.ktx2", import.meta.url), outPath);
process.exit(0);
`);
// The wrapper: findKtx2Encoder wants an existing path; the optimizer spawns
// it directly and detects toktx by basename. process.execPath, not "bun"
// (the Windows .cmd shim; docs/INCIDENTS.md).
let FAKE_TOKTX: string;
if (process.platform === "win32") {
  FAKE_TOKTX = join(FAKE_DIR, "toktx.cmd");
  writeFileSync(FAKE_TOKTX, `@echo off\r\n"${process.execPath}" run "${FAKE_SCRIPT}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
} else {
  FAKE_TOKTX = join(FAKE_DIR, "toktx");
  writeFileSync(FAKE_TOKTX, `#!/bin/sh\nexec "${process.execPath}" run "${FAKE_SCRIPT}" "$@"\n`);
  chmodSync(FAKE_TOKTX, 0o755);
}

// …and the same fake under the OTHER encoder's name: optimize.ts tells toktx
// from `ktx` by basename, and `ktx create` has no --resize
const FAKE_KTX_DIR = join(FAKE_DIR, "as-ktx");
mkdirSync(FAKE_KTX_DIR, { recursive: true });
let FAKE_KTX: string;
if (process.platform === "win32") {
  FAKE_KTX = join(FAKE_KTX_DIR, "ktx.cmd");
  writeFileSync(FAKE_KTX, `@echo off\r\n"${process.execPath}" run "${FAKE_SCRIPT}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
} else {
  FAKE_KTX = join(FAKE_KTX_DIR, "ktx");
  writeFileSync(FAKE_KTX, `#!/bin/sh\nexec "${process.execPath}" run "${FAKE_SCRIPT}" "$@"\n`);
  chmodSync(FAKE_KTX, 0o755);
}
const sha256 = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

/** upload.ts's exact spawn for a --ktx2 item, with the encoder chosen. */
async function runKtx2(src: string, dest: string, env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, "run", OPTIMIZE, "--ktx2", src, dest],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const code = await proc.exited;
  const err = (await new Response(proc.stderr).text()).trim();
  const out = (await new Response(proc.stdout).text()).trim();
  return { code, err, out, wrote: existsSync(dest), tmpLeft: existsSync(`${dest}.tmp`) };
}

// ---------------------------------------------- 3. the optimizer's refusal seams
console.log("\n  the optimizer, against the fake encoder:");
{
  const tmp = mkdtempSync(join(tmpdir(), "ew-store-ktx2-"));
  try {
    const store = join(tmp, "store"); mkdirSync(store, { recursive: true });
    const place = (bytes: Uint8Array) => { const p = join(store, `${hashOf(bytes)}.glb`); writeFileSync(p, bytes); return p; };
    const two = place(await fixtureGlb("two", 2));
    const one = place(await fixtureGlb("one", 1));
    const none = place(await fixtureGlb("none", 0));
    const corrupt = join(store, "0000000000000000.glb");
    writeFileSync(corrupt, new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 40, 0, 0, 0, 9, 9, 9, 9]));   // GLB magic, garbage after

    let r = await runKtx2(two, ktx2VariantPath(two), { KTX2_TOKTX: FAKE_TOKTX, FAKE_TOKTX_MODE: "ok" });
    check("ok: two textures → exit 0, variant written", r.code === 0 && r.wrote, `exit ${r.code}: ${r.err.split("\n").pop()}`);
    check("…and it is really KTX2 — basisu required, every image image/ktx2", r.wrote && isKtx2Glb(new Uint8Array(readFileSync(ktx2VariantPath(two)))));
    check("…the tally says 2/2", r.out.includes("2/2 texture(s)"), r.out);
    {   // identity: the variant SAYS what it is a variant of, and how it was made
      const ex = r.wrote ? glbJson(new Uint8Array(readFileSync(ktx2VariantPath(two)))).asset?.extras : null;
      check("identity: extras.ktx2.of is the SOURCE's sha256, .recipe the running recipe, .tools names the encoder",
        ex?.ktx2?.of === sha256(new Uint8Array(readFileSync(two))) && ex?.ktx2?.recipe === KTX2_RECIPE && typeof ex?.ktx2?.tools?.encoder === "string" && ex.ktx2.tools.encoder.length > 0,
        JSON.stringify(ex));
      check("…and it does not read as a LOD (no lodOf, no top-level recipe — the client's tierOf binds to those)", ex?.lodOf === undefined && ex?.recipe === undefined);
      const authored = place(await fixtureGlb("authored", 1, false, 64, { producer: "someone-else", recipe: "chef-special", note: "must survive" }));
      const ra = await runKtx2(authored, ktx2VariantPath(authored), { KTX2_TOKTX: FAKE_TOKTX, FAKE_TOKTX_MODE: "ok" });
      const exa = ra.wrote ? glbJson(new Uint8Array(readFileSync(ktx2VariantPath(authored)))).asset?.extras : null;
      check("the SOURCE's own extras survive beside ours (never clobbered)", ra.code === 0 && exa?.producer === "someone-else" && exa?.recipe === "chef-special" && exa?.note === "must survive" && exa?.ktx2?.recipe === KTX2_RECIPE,
        JSON.stringify(exa));
    }

    r = await runKtx2(one, ktx2VariantPath(one), { KTX2_TOKTX: FAKE_TOKTX, FAKE_TOKTX_MODE: "fail" });
    check("all-fail: exit 5, NOTHING written (the empty variant main would have shipped)", r.code === 5 && !r.wrote, `exit ${r.code}: ${r.err.split("\n").pop()}`);
    check("…no .tmp left behind", !r.tmpLeft);
    check("…and it names the texture it could not convert", r.err.includes("0/1") && r.err.includes("base"), r.err.split("\n").pop());

    const counter = join(tmp, "counter");
    r = await runKtx2(two, ktx2VariantPath(two) + ".partial", { KTX2_TOKTX: FAKE_TOKTX, FAKE_TOKTX_MODE: "fail-second", FAKE_TOKTX_COUNTER: counter });
    check("partial-fail: 1 of 2 converts → exit 5, nothing written (the partial variant main would have shipped)", r.code === 5 && !r.wrote,
      `exit ${r.code}: ${r.err.split("\n").pop()}`);
    check("…the tally says 1/2 and names the normal map", r.err.includes("1/2") && r.err.includes("normal"), r.err.split("\n").pop());

    r = await runKtx2(one, ktx2VariantPath(one) + ".garbage", { KTX2_TOKTX: FAKE_TOKTX, FAKE_TOKTX_MODE: "garbage" });
    check("an encoder that exits 0 but writes non-KTX2 bytes → refused (the container check), exit 5", r.code === 5 && !r.wrote && r.err.includes("not a KTX2 container"),
      `exit ${r.code}: ${r.err.split("\n").pop()}`);

    r = await runKtx2(none, ktx2VariantPath(none), { KTX2_TOKTX: FAKE_TOKTX, FAKE_TOKTX_MODE: "ok" });
    check("nothing to convert (untextured) → exit 2, nothing written — a content verdict, the marker's business", r.code === 2 && !r.wrote,
      `exit ${r.code}: ${r.err.split("\n").pop()}`);

    r = await runKtx2(corrupt, ktx2VariantPath(corrupt), { KTX2_TOKTX: FAKE_TOKTX, FAKE_TOKTX_MODE: "ok" });
    check("a corrupt container → exit 1 (a real failure, marker's business too)", r.code === 1 && !r.wrote, `exit ${r.code}`);

    r = await runKtx2(one, ktx2VariantPath(one) + ".noenc", { KTX2_TOKTX: join(tmp, "no-such-toktx"), PATH: tmp, HOME: tmp, USERPROFILE: tmp });
    check("no encoder anywhere → exit 3 (the env-skip, unchanged)", r.code === 3 && !r.wrote, `exit ${r.code}: ${r.err.split("\n").pop()}`);

    // the texel budget, as the encoder is asked for it: a 2048² source gets
    // --resize 1024x1024 in its argv, a 64² source does not
    const big = place(await fixtureGlb("big", 2, false, 2048));
    const arglog = join(tmp, "argv.log");
    r = await runKtx2(big, ktx2VariantPath(big), { KTX2_TOKTX: FAKE_TOKTX, FAKE_TOKTX_MODE: "ok", FAKE_TOKTX_ARGLOG: arglog });
    let argv = existsSync(arglog) ? readFileSync(arglog, "utf8") : "";
    check("2048² textures: the encoder is asked to --resize 1024x1024, once per texture", r.code === 0 && (argv.match(/--resize 1024x1024/g) ?? []).length === 2, argv.trim().split("\n").map((l) => l.slice(0, 80)).join(" | "));
    rmSync(arglog, { force: true });
    r = await runKtx2(two, ktx2VariantPath(two) + ".small", { KTX2_TOKTX: FAKE_TOKTX, FAKE_TOKTX_MODE: "ok", FAKE_TOKTX_ARGLOG: arglog });
    argv = existsSync(arglog) ? readFileSync(arglog, "utf8") : "";
    check("64² textures: no --resize (never upscaled)", r.code === 0 && !argv.includes("--resize"));
    // the OTHER encoder: `ktx create` has no --resize. The variant's name
    // carries the budget, so the source is scaled BEFORE the encoder sees it
    // (it used to be encoded at source size, with a log line) — and where
    // that cannot be done, the variant is refused, retryably, never written
    // under a name its textures do not honor
    {
      const dimlog = join(tmp, "dims.log");
      rmSync(arglog, { force: true });
      r = await runKtx2(big, ktx2VariantPath(big) + ".ktxcreate", { KTX2_TOKTX: FAKE_KTX, FAKE_TOKTX_MODE: "ok", FAKE_TOKTX_ARGLOG: arglog, FAKE_TOKTX_DIMLOG: dimlog });
      argv = existsSync(arglog) ? readFileSync(arglog, "utf8") : "";
      const dims = existsSync(dimlog) ? readFileSync(dimlog, "utf8").trim().split(/\s+/).filter(Boolean) : [];
      check("(fixture) the fake answered as `ktx create`, which has no --resize", argv.includes("create") && !argv.includes("--resize"), argv.trim().split("\n").map((l) => l.slice(0, 60)).join(" | "));
      if (r.code === 0) {
        check("an encoder that cannot resize: 2048² sources reach it already at the budget — 1024², once per texture",
          r.wrote && dims.length === 2 && dims.every((d) => d === "1024x1024"), `exit ${r.code} handed=${JSON.stringify(dims)}`);
      } else {
        // no usable sharp on this box (one-libvips-test.ts owns that story): the honest outcome is a refusal
        check("an encoder that cannot resize and NO converter: refused retryably (exit 5), nothing written under a name its textures would not honor",
          r.code === 5 && !r.wrote && dims.every((d) => d === "1024x1024"), `exit ${r.code} handed=${JSON.stringify(dims)}: ${r.err.split("\n").pop()}`);
        console.log("  - prescale: no usable sharp here — the refusal arm was exercised instead");
      }
      check("…and on NO path is a source over the budget handed to an encoder that cannot resize it", !dims.includes("2048x2048"), JSON.stringify(dims));
      rmSync(dimlog, { force: true }); rmSync(arglog, { force: true });
      r = await runKtx2(two, ktx2VariantPath(two) + ".ktxsmall", { KTX2_TOKTX: FAKE_KTX, FAKE_TOKTX_MODE: "ok", FAKE_TOKTX_DIMLOG: dimlog });
      const small = existsSync(dimlog) ? readFileSync(dimlog, "utf8").trim().split(/\s+/).filter(Boolean) : [];
      check("…a 64² source passes through untouched (never upscaled, no converter in the loop)", r.code === 0 && small.length === 2 && small.every((d) => d === "64x64"), `exit ${r.code} handed=${JSON.stringify(small)}`);
    }
    // a size refusal names its recipe
    r = await runKtx2(two, ktx2VariantPath(two) + ".bloat", { KTX2_TOKTX: FAKE_TOKTX, FAKE_TOKTX_MODE: "bloat" });
    check("a size refusal (exit 2) carries the recipe stamp — a later recipe can tell it is stale", r.code === 2 && !r.wrote && r.err.includes(recipeStamp()), `exit ${r.code}: ${r.err.split("\n").pop()}`);

    const real = findKtx2Encoder();
    if (!real) console.log("  - real encoder: skipped — none on this box (KTX2_TOKTX / toktx / ktx; docs/ktx2-encoder.md)");
    else {
      r = await runKtx2(two, ktx2VariantPath(two) + ".real", { KTX2_TOKTX: real });
      check(`the real encoder (${real.split(/[\\/]/).pop()}): exit 0, a KTX2 variant`, r.code === 0 && r.wrote && isKtx2Glb(new Uint8Array(readFileSync(ktx2VariantPath(two) + ".real"))),
        `exit ${r.code}: ${r.err.split("\n").pop()}`);
      r = await runKtx2(big, ktx2VariantPath(big) + ".real", { KTX2_TOKTX: real });
      const dims = r.wrote ? ktx2Dims(new Uint8Array(readFileSync(ktx2VariantPath(big) + ".real"))) : [];
      check("…and a 2048² source comes out 1024² in the KTX2 headers — the shadow's budget, GPU-native", r.code === 0 && dims.length === 2 && dims.every((d) => d[0] === 1024 && d[1] === 1024),
        `exit ${r.code} dims=${JSON.stringify(dims)}`);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ---------------------------------------------- the real sequencer
// OPT_DIR is this checkout's assets/opt (gitignored) — the only tree the
// server reads, so fixtures go there under their content hashes and come out
// again in cleanup (including their manifest entries). An EMPTY library for
// the child, so its library sweep has nothing to encode.
const OPT = join(ROOT, "assets", "opt");
const STORE = join(OPT, "store"), STORE_MIN = join(OPT, "store-min");
const madeStore = !existsSync(STORE), madeMin = !existsSync(STORE_MIN);
mkdirSync(STORE, { recursive: true }); mkdirSync(STORE_MIN, { recursive: true });
const EMPTY_LIB = mkdtempSync(join(tmpdir(), "ew-empty-lib-"));
// "No encoder" has to be TRUE for the child: KTX2_TOKTX pointing nowhere is
// not enough when PATH holds the fake — Bun.which("toktx") resolves toktx.cmd
// through PATHEXT on Windows (this file's own first run found it that way).
// An empty dir for PATH and HOME (the ~/.local/ktx fallback) makes it true.
const NOWHERE = mkdtempSync(join(tmpdir(), "ew-nowhere-"));
const NO_ENCODER = { KTX2_TOKTX: join(NOWHERE, "no-such-toktx"), PATH: NOWHERE, HOME: NOWHERE, USERPROFILE: NOWHERE };
const DOOR = "test-door";
const mine = new Set<string>();   // hashes this run put in the store
const shadowsOf = (hash: string) => [
  join(STORE, `${hash}.glb`), join(STORE_MIN, `${hash}.glb`), join(STORE_MIN, `${hash}.glb.failed`), join(STORE_MIN, `${hash}.glb.tmp`),
  // every generation's variant, marker, deferral and .tmp — ktx2 and lod alike
  ...(existsSync(STORE) ? readdirSync(STORE).filter((f) => f.startsWith(`${hash}.glb.`)).map((f) => join(STORE, f)) : [])];
let live: ChildProcess | null = null;
const cleanup = () => {
  try { live?.kill(); } catch { /* gone */ }
  for (const h of mine) for (const p of shadowsOf(h)) try { rmSync(p, { force: true }); } catch { /* best effort */ }
  try {   // our manifest entries, not anyone else's
    const mp = join(STORE, "manifest.json");
    if (existsSync(mp)) {
      const man = JSON.parse(readFileSync(mp, "utf8"));
      for (const h of mine) delete man[h];
      if (Object.keys(man).length) writeFileSync(mp, JSON.stringify(man)); else rmSync(mp);
    }
  } catch { /* best effort */ }
  if (madeStore) try { rmdirSync(STORE); } catch { /* not empty — someone else's uploads */ }
  if (madeMin) try { rmdirSync(STORE_MIN); } catch { /* same */ }
  try { rmSync(FAKE_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
  try { rmSync(EMPTY_LIB, { recursive: true, force: true }); } catch { /* best effort */ }
  try { rmSync(NOWHERE, { recursive: true, force: true }); } catch { /* best effort */ }
};
process.on("exit", cleanup);

async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const cand = 20000 + Math.floor(Math.random() * 20000);
    try { await fetch(`http://127.0.0.1:${cand}/`, { signal: AbortSignal.timeout(400) }); }
    catch { return cand; }
  }
  throw new Error("no free port in 20 tries");
}
/** Spawn the sequencer with `extra` in its environment (the optimize
 *  subprocesses inherit it — that is how the fake encoder's mode reaches
 *  them). Returns the door, the log so far, and a stop. */
async function startServer(extra: Record<string, string | undefined>) {
  const PORT = await freePort();
  const env: Record<string, string | undefined> = { ...process.env, PORT: String(PORT), JOIN_TOKEN: DOOR,
    WORLDS_DIR: mkdtempSync(join(tmpdir(), "ew-store-serve-")), EIDOVERSE_DIR: EMPTY_LIB, ...extra };
  const proc = spawn(process.execPath, [join(ROOT, "server", "server.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
  live = proc;
  let log = "";
  proc.stdout!.on("data", (d) => { log += d; });
  proc.stderr!.on("data", (d) => { log += d; });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/`); up = true; } catch { await sleep(250); }
  }
  const base = `http://127.0.0.1:${PORT}`;
  const get = async (rel: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/library/${rel}`, { headers });
    return { status: res.status, cc: res.headers.get("cache-control") ?? "", etag: res.headers.get("etag") ?? "",
      bytes: res.status === 200 ? new Uint8Array(await res.arrayBuffer()) : new Uint8Array(0) };
  };
  const upload = async (bytes: Uint8Array, name: string) => {
    const res = await fetch(`${base}/upload?token=${DOOR}&name=${name}`, { method: "POST", body: bytes });
    return { status: res.status, body: res.ok ? await res.json() : await res.text() };
  };
  const stop = async () => { try { proc.kill(); } catch { /* gone */ } live = null; await sleep(300); };
  // the key THIS child publishes — what a browser would use (assets.js)
  const key = up ? keyFromVersion(await fetch(`${base}/version`).then((r) => r.json()).catch(() => null)) : null;
  return { up, PORT, base, get, upload, stop, log: () => log, key };
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const whichFile = (b: Uint8Array) => { try { return String(glbJson(b).nodes?.[0]?.name ?? "?").split("-")[0]; } catch { return "unparseable"; } };

// ---------------------------------------------- 4. upload → queue → variant → served (fake encoder, ok)
console.log("\n  the real sequencer — an upload becomes a served variant:");
{
  const S = await startServer({ KTX2_TOKTX: FAKE_TOKTX, FAKE_TOKTX_MODE: "ok" });
  check("child server came up on a verified-free port", S.up, `:${S.PORT}`);
  if (S.up) {
    const glb = await fixtureGlb("uploaded", 2);
    const hash = hashOf(glb); mine.add(hash);
    check("the running sequencer publishes its key on /version — the one a browser negotiates with", S.key === KTX2_KEY, `published ${S.key}, defined ${KTX2_KEY}`);
    const up = await S.upload(glb, "store-variants-test");
    check("POST /upload landed it content-addressed", up.status === 200 && up.body?.path === `store/${hash}.glb`, `${up.status} ${JSON.stringify(up.body)}`);
    // ownership: only the tree we spawned from holds this run's fixture
    const plain = await S.get(`store/${hash}.glb`);
    const owned = plain.status === 200 && same(plain.bytes, glb) || (plain.status === 200 && whichFile(plain.bytes) === "uploaded");
    check("listener is OUR child (the fixture round-trips), not a squatter", owned, `status=${plain.status} file=${whichFile(plain.bytes)}`);
    if (!owned) console.log("\n  refusing to test an unowned server\n");
    else {
      // The pump runs store-min then --ktx2, serially, off the request path.
      // Until the variant lands, the flagged answer is whatever the unflagged
      // one is, marked provisional; once it lands, the variant, immutable.
      const early = await S.get(negotiate(`store/${hash}.glb`, S.key));
      const earlyIsVariant = isKtx2Glb(early.bytes);
      check("a flagged fetch is answered either way, and its caching says which", early.status === 200
        && (earlyIsVariant ? early.cc.includes("immutable") : early.cc === "no-cache"), `variant=${earlyIsVariant} cc=${early.cc}`);
      const landed = await until(() => existsSync(ktx2VariantPath(join(STORE, `${hash}.glb`))), 30_000);
      check("the queue built the KTX2 shadow beside the original", landed, ktx2VariantPath(join(STORE, `${hash}.glb`)));
      // the parent logs a beat after the child's rename lands the file — poll
      const logged = await until(() => S.log().includes(`→ ${hash}.glb${KTX2_SUFFIX}`), 5_000);
      check("…and it says so in the sequencer's log", logged, S.log().split("\n").filter((l) => l.includes("ktx2")).join(" | "));
      const flagged = await S.get(negotiate(`store/${hash}.glb`, S.key));
      check("flagged (current key) → the variant, really KTX2, immutable", flagged.status === 200 && isKtx2Glb(flagged.bytes) && flagged.cc.includes("immutable"),
        `cc=${flagged.cc} ktx2=${isKtx2Glb(flagged.bytes)}`);
      check("…carrying its identity: this source, this recipe", glbJson(flagged.bytes).asset?.extras?.ktx2?.of === sha256(glb) && glbJson(flagged.bytes).asset?.extras?.ktx2?.recipe === KTX2_RECIPE,
        JSON.stringify(glbJson(flagged.bytes).asset?.extras));
      const retired = await S.get(`store/${hash}.glb?ktx2=3`);
      check("the just-retired key (=3) is an unflagged fetch: not the variant, immutable like the address", retired.status === 200 && !isKtx2Glb(retired.bytes) && retired.cc.includes("immutable"),
        `cc=${retired.cc} ktx2=${isKtx2Glb(retired.bytes)}`);
      const bare = await S.get(`store/${hash}.glb`);
      check("unflagged → not the variant, immutable", bare.status === 200 && !isKtx2Glb(bare.bytes) && bare.cc.includes("immutable"), bare.cc);

      // the enumerations, asked of the running server
      const catalog: { path: string }[] = await fetch(`${S.base}/library-models`).then((r) => r.json());
      check("/library-models lists the upload once and the variant never",
        catalog.filter((h) => h.path === `store/${hash}.glb`).length === 1 && !catalog.some((h) => isKtx2Variant(h.path)),
        catalog.filter((h) => h.path.includes(hash)).map((h) => h.path).join(", "));
      // a marker beside it too, so the listing has every artifact class to skip
      writeFileSync(`${ktx2VariantPath(join(STORE, `${hash}.glb`))}.tmp`, "mid-write");
      const listing: { path: string }[] = await fetch(`${S.base}/library-list?dir=store`).then((r) => r.json());
      const listedMine = listing.map((f) => f.path).filter((p) => p.includes(hash));
      check("/library-list?dir=store lists the upload and NO artifact (variant, .failed, .tmp) — what the prefetcher fetches",
        listedMine.length === 1 && listedMine[0] === `store/${hash}.glb`, listedMine.join(", "));
      rmSync(`${ktx2VariantPath(join(STORE, `${hash}.glb`))}.tmp`, { force: true });

      // exit 2's marker, through the pump: an untextured upload
      const none = await fixtureGlb("untextured", 0);
      const h2 = hashOf(none); mine.add(h2);
      await S.upload(none, "untextured");
      const marked = await until(() => existsSync(`${ktx2VariantPath(join(STORE, `${h2}.glb`))}.failed`), 30_000);
      check("nothing to convert → the pump writes the .failed marker (exit 2) and no variant", marked && !existsSync(ktx2VariantPath(join(STORE, `${h2}.glb`))));
      const listing2: { path: string }[] = await fetch(`${S.base}/library-list?dir=store`).then((r) => r.json());
      check("…and the marker is not a listing entry either", !listing2.some((f) => f.path.includes(h2) && f.path !== `store/${h2}.glb`));
    }
  }
  await S.stop();
}

// ---------------------------------------------- 4b. another generation's bakes are walked away from
// The show box, 2026-09-29: 71 of 89 model variants baked BEFORE the texel
// budget, still on disk under the legacy name, the store's pinned immutable
// under their URL. "Exists" meant "done". Here a store holds exactly that —
// an original, its legacy-named variant, and a second original whose only
// answer is a legacy verdict — and a sequencer of THIS generation boots over
// it. The legacy bytes must never answer under this generation's key (not
// for the seconds before the re-bake lands, which is when they would be
// pinned), the sweep must re-bake with no operator step, and the old
// generation's files must be gone when the new outcome lands.
console.log("\n  the generation walk-away — legacy bakes are never served, and are replaced:");
{
  const glb = await fixtureGlb("legacy-src", 2);
  const oldBake = await fixtureGlb("legacy-bake", 2, true);              // stands in for the over-budget bake: different bytes, no identity
  const hash = hashOf(glb); mine.add(hash);
  const orig = join(STORE, `${hash}.glb`);
  const legacy = `${orig}${KTX2_LEGACY_SUFFIX}`;
  writeFileSync(orig, glb);
  writeFileSync(legacy, oldBake);
  writeFileSync(`${legacy}.tmp`, "a dead pass");
  const bare = await fixtureGlb("legacy-untextured", 0);
  const hb = hashOf(bare); mine.add(hb);
  writeFileSync(join(STORE, `${hb}.glb`), bare);
  writeFileSync(`${join(STORE, `${hb}.glb`)}${KTX2_LEGACY_SUFFIX}.failed`, "[optimize] ktx2: no convertible raster images (12ms) — keeping original");
  const S = await startServer({ KTX2_TOKTX: FAKE_TOKTX, FAKE_TOKTX_MODE: "ok" });
  check("child server came up over a store holding another generation's bakes", S.up, `:${S.PORT}`);
  try {
    if (S.up) {
      check("it publishes THIS generation's key", S.key === KTX2_KEY, `published ${S.key}`);
      const url = negotiate(`store/${hash}.glb`, S.key);
      const early = await S.get(url);
      const earlyIsNew = isKtx2Glb(early.bytes) && glbJson(early.bytes).asset?.extras?.ktx2?.recipe === KTX2_RECIPE;
      check("at once, before any re-bake can have been waited for: the flagged answer is NOT the legacy bake", early.status === 200 && !same(early.bytes, oldBake), `file=${whichFile(early.bytes)}`);
      check("…it is this generation's variant (immutable) or a PROVISIONAL fall-through (no-cache) — never a pinned stand-in",
        earlyIsNew ? early.cc.includes("immutable") : early.cc === "no-cache", `new=${earlyIsNew} cc=${early.cc}`);
      const landed = await until(() => existsSync(ktx2VariantPath(orig)), 45_000);
      check("the boot sweep re-baked it — a legacy variant on disk does not count as done", landed,
        S.log().split("\n").filter((l) => l.includes(hash.slice(0, 8)) || l.includes("boot sweep")).slice(-3).join(" | "));
      if (landed) {
        const now = await S.get(url);
        check("flagged → this generation's variant: this source, this recipe, immutable",
          isKtx2Glb(now.bytes) && glbJson(now.bytes).asset?.extras?.ktx2?.of === sha256(glb) && glbJson(now.bytes).asset?.extras?.ktx2?.recipe === KTX2_RECIPE && now.cc.includes("immutable"),
          `cc=${now.cc} extras=${JSON.stringify(glbJson(now.bytes).asset?.extras)}`);
        const pruned = await until(() => !existsSync(legacy) && !existsSync(`${legacy}.tmp`), 5_000);
        check("…and the legacy variant and its dead .tmp are gone — one generation on disk", pruned,
          readdirSync(STORE).filter((f) => f.startsWith(hash)).join(", "));
      }
      const old = await S.get(`store/${hash}.glb?ktx2=3`);
      check("the retired key (=3) is an unflagged fetch — no variant of ANY generation answers it", old.status === 200 && !isKtx2Glb(old.bytes) && !same(old.bytes, oldBake), `file=${whichFile(old.bytes)} cc=${old.cc}`);
      // the verdict side: a legacy marker is another generation's answer
      const remeasured = await until(() => existsSync(`${ktx2VariantPath(join(STORE, `${hb}.glb`))}.failed`), 45_000);
      check("a legacy VERDICT is a question again: re-measured under this generation's name", remeasured);
      if (remeasured) {
        const gone = await until(() => !existsSync(`${join(STORE, `${hb}.glb`)}${KTX2_LEGACY_SUFFIX}.failed`), 5_000);
        check("…and the legacy marker is pruned on the refusal", gone, readdirSync(STORE).filter((f) => f.startsWith(hb)).join(", "));
      }
      const listing: { path: string }[] = await fetch(`${S.base}/library-list?dir=store`).then((r) => r.json());
      const cat: { path: string }[] = await fetch(`${S.base}/library-models`).then((r) => r.json());
      check("no generation's artifact is a listing or catalog entry",
        listing.filter((f) => f.path.includes(hash) || f.path.includes(hb)).every((f) => f.path === `store/${hash}.glb` || f.path === `store/${hb}.glb`)
        && !cat.some((h) => isKtx2Variant(h.path)), listing.filter((f) => f.path.includes(hash)).map((f) => f.path).join(", "));
    }
  } finally { await S.stop(); }
}

// ---------------------------------------------- 5. boot queuing + exit 5 (fake encoder, fail-second)
console.log("\n  the boot sweep — a partial conversion is refused, retryably:");
{
  const glb = await fixtureGlb("booted", 2);
  const hash = hashOf(glb); mine.add(hash);
  writeFileSync(join(STORE, `${hash}.glb`), glb);       // an original with no shadows, before the server exists
  const counter = join(FAKE_DIR, `counter-${hash}`);
  const S = await startServer({ KTX2_TOKTX: FAKE_TOKTX, FAKE_TOKTX_MODE: "fail-second", FAKE_TOKTX_COUNTER: counter });
  check("child server came up", S.up, `:${S.PORT}`);
  if (S.up) {
    // the store sweep fires 5s after boot; store-min first, then --ktx2
    const swept = await until(() => existsSync(join(STORE_MIN, `${hash}.glb`)) || existsSync(join(STORE_MIN, `${hash}.glb.failed`)), 40_000);
    check("the boot sweep queued the pre-existing original (its store-min shadow or verdict appeared)", swept);
    const refused = await until(() => /REFUSED — partial conversion/.test(S.log()), 30_000);
    check("the --ktx2 pass converted 1 of 2 and was REFUSED (exit 5)", refused && /1\/2/.test(S.log()),
      S.log().split("\n").filter((l) => l.includes("ktx2")).join(" | "));
    check("…no variant written", !existsSync(ktx2VariantPath(join(STORE, `${hash}.glb`))));
    check("…and NO .failed marker — environmental, retried next boot", !existsSync(`${ktx2VariantPath(join(STORE, `${hash}.glb`))}.failed`));
    check("…and no ktx2Skip: the encoder is there (no 'no encoder' line)", !/no encoder/.test(S.log()));
    const flagged = await S.get(negotiate(`store/${hash}.glb`, S.key));
    check("meanwhile a flagged fetch falls through, provisional (no-cache) — not pinned", flagged.status === 200 && !isKtx2Glb(flagged.bytes) && flagged.cc === "no-cache", flagged.cc);
  }
  await S.stop();
}

// ---------------------------------------------- 5b. the boot sweep re-measures a stale verdict — and only a stale one
// The show box holds sixteen `not smaller` markers from the native-source
// recipe. Under the texel budget they are questions again: the first boot
// after this lands retries them, with no operator step. A verdict that
// carries the current stamp is not retried.
console.log("\n  the boot sweep — a stale size verdict is re-measured, a current one stands:");
{
  const stale = await fixtureGlb("stale", 1);
  const current = await fixtureGlb("current", 1);
  const hs = hashOf(stale), hc = hashOf(current); mine.add(hs); mine.add(hc);
  writeFileSync(join(STORE, `${hs}.glb`), stale);
  writeFileSync(join(STORE, `${hc}.glb`), current);
  // both have a store-min verdict so only the KTX2 arm is in play
  writeFileSync(join(STORE_MIN, `${hs}.glb.failed`), "fixture"); writeFileSync(join(STORE_MIN, `${hc}.glb.failed`), "fixture");
  writeFileSync(`${ktx2VariantPath(join(STORE, `${hs}.glb`))}.failed`, "[optimize] not smaller (17600988 -> 26716692, 91234ms) — keeping original");   // prod's shape
  writeFileSync(`${ktx2VariantPath(join(STORE, `${hc}.glb`))}.failed`, `[optimize] not smaller (1 -> 2, 3ms) ${recipeStamp()} — keeping original`);
  const S = await startServer({ KTX2_TOKTX: FAKE_TOKTX, FAKE_TOKTX_MODE: "ok" });
  check("child server came up", S.up, `:${S.PORT}`);
  if (S.up) {
    const landed = await until(() => existsSync(ktx2VariantPath(join(STORE, `${hs}.glb`))), 40_000);
    check("the stale verdict was re-measured: its variant landed", landed);
    check("…and the old verdict is gone (a landed variant retires it)", landed && !existsSync(`${ktx2VariantPath(join(STORE, `${hs}.glb`))}.failed`));
    await sleep(1500);
    check("the current verdict stands: no variant, marker intact", !existsSync(ktx2VariantPath(join(STORE, `${hc}.glb`))) && existsSync(`${ktx2VariantPath(join(STORE, `${hc}.glb`))}.failed`));
    const flagged = await S.get(negotiate(`store/${hs}.glb`, S.key));
    check("…and the re-measured one now serves its variant", flagged.status === 200 && isKtx2Glb(flagged.bytes));
  }
  await S.stop();
}

// ---------------------------------------------- 6. ktx2Skip — no encoder, once per boot, and uploads stop queueing
console.log("\n  no encoder on the box — exit 3, once, and no marker:");
{
  const glb = await fixtureGlb("noenc", 1);
  const hash = hashOf(glb); mine.add(hash);
  writeFileSync(join(STORE, `${hash}.glb`), glb);
  const S = await startServer(NO_ENCODER);
  check("child server came up", S.up, `:${S.PORT}`);
  if (S.up) {
    const said = await until(() => /no encoder/.test(S.log()), 40_000);
    check("the sweep's --ktx2 item exited 3: 'no encoder … variants skipped this boot'", said);
    check("…no variant, no marker (environmental)", !existsSync(ktx2VariantPath(join(STORE, `${hash}.glb`))) && !existsSync(`${ktx2VariantPath(join(STORE, `${hash}.glb`))}.failed`));
    const glb2 = await fixtureGlb("noenc-upload", 1);
    const h2 = hashOf(glb2); mine.add(h2);
    await S.upload(glb2, "noenc-upload");
    await until(() => existsSync(join(STORE_MIN, `${h2}.glb`)) || existsSync(join(STORE_MIN, `${h2}.glb.failed`)), 30_000);
    await sleep(1500);
    const noEncoderLines = S.log().split("\n").filter((l) => l.includes("no encoder")).length;
    check("a later upload does not re-spawn an exit-3 pass — ktx2Skip held (the line appears exactly once)", noEncoderLines === 1, `${noEncoderLines} line(s)`);
    check("…and got no marker either", !existsSync(`${ktx2VariantPath(join(STORE, `${h2}.glb`))}.failed`));
  }
  await S.stop();
}

// ---------------------------------------------- 7. the swap — If-None-Match across the variant landing
console.log("\n  the swap a browser makes when the variant lands:");
{
  const glb = await fixtureGlb("swap", 1);
  const variant = await fixtureGlb("swap-variant", 1, true);   // a stand-in: which FILE answers is the question here
  const hash = hashOf(glb); mine.add(hash);
  writeFileSync(join(STORE, `${hash}.glb`), glb);
  writeFileSync(join(STORE_MIN, `${hash}.glb.failed`), "fixture");   // "already lean": the unflagged answer is the original, deterministically
  const S = await startServer(NO_ENCODER);
  check("child server came up", S.up, `:${S.PORT}`);
  if (S.up) {
    const before = await S.get(negotiate(`store/${hash}.glb`, S.key));
    check("no variant yet: flagged → the original, no-cache, with an ETag", before.status === 200 && same(before.bytes, glb) && before.cc === "no-cache" && before.etag !== "",
      `cc=${before.cc} etag=${before.etag}`);
    const revalidated = await S.get(negotiate(`store/${hash}.glb`, S.key), { "if-none-match": before.etag });
    check("revalidating while nothing changed is a 304 (no body), still no-cache", revalidated.status === 304 && revalidated.cc === "no-cache", `${revalidated.status} ${revalidated.cc}`);
    writeFileSync(ktx2VariantPath(join(STORE, `${hash}.glb`)), variant);   // the variant lands
    const swapped = await S.get(negotiate(`store/${hash}.glb`, S.key), { "if-none-match": before.etag });
    check("the variant landed: the same If-None-Match now gets a 200 with the VARIANT — the swap", swapped.status === 200 && same(swapped.bytes, variant),
      `${swapped.status} file=${whichFile(swapped.bytes)}`);
    check("…immutable from here on, under a new ETag", swapped.cc.includes("immutable") && swapped.etag !== before.etag, `cc=${swapped.cc}`);
    const settled = await S.get(negotiate(`store/${hash}.glb`, S.key), { "if-none-match": swapped.etag });
    check("…and revalidating the variant is a 304 that says immutable", settled.status === 304 && settled.cc.includes("immutable"), `${settled.status} ${settled.cc}`);
    const bare = await S.get(`store/${hash}.glb`);
    check("the unflagged answer never moved: the original, immutable — the address IS content-addressed", same(bare.bytes, glb) && bare.cc.includes("immutable"), bare.cc);
  }
  await S.stop();
}

// ---------------------------------------------- 8. the canary — pull before restart cannot poison
// The =2 incident, replayed: a sequencer is RUNNING, then `git pull` lands a
// shared/ktx2.js with a new key on its disk. The old process keeps serving
// that new file (/shared/ktx2.js) while its own key — the one it imported at
// boot — is unchanged. A client that read the key off the served file asked
// with the new key and got pinned; a client that reads /version asks with
// the running key and is answered correctly. Both fetches are made here, so
// the poison is demonstrated, not assumed. The served file is rewritten IN
// PLACE for the duration and restored byte-for-byte (finally + exit hook).
console.log("\n  the canary — a pull lands under a running sequencer:");
{
  const SHARED = join(ROOT, "shared", "ktx2.js");
  const pristine = readFileSync(SHARED);
  const restore = () => { try { writeFileSync(SHARED, pristine); } catch { /* best effort */ } };
  process.on("exit", restore);
  const glb = await fixtureGlb("canary", 1);
  const variant = await fixtureGlb("canary-variant", 1, true);
  const hash = hashOf(glb); mine.add(hash);
  writeFileSync(join(STORE, `${hash}.glb`), glb);
  writeFileSync(ktx2VariantPath(join(STORE, `${hash}.glb`)), variant);
  writeFileSync(join(STORE_MIN, `${hash}.glb.failed`), "fixture");
  const S = await startServer(NO_ENCODER);
  check("child server came up — with the PRISTINE key in memory", S.up && S.key === KTX2_KEY, `${S.up} key=${S.key}`);
  try {
    if (S.up) {
      // the key derives from (generation, recipe): the pull changes a
      // PARAMETER, as a real one would, and is proven to have landed — a
      // literal-replace of a derived constant is a mutation that changes nothing
      const NEXT = ktx2KeyFor({ gen: 99 });   // the pulled generation, not yet running anywhere
      const bumped = pristine.toString("utf8").replace(`export const KTX2_GEN = ${KTX2_GEN};`, "export const KTX2_GEN = 99;");
      check("(fixture) the pull rewrites the generation on disk", bumped !== pristine.toString("utf8") && NEXT !== KTX2_KEY, NEXT);
      writeFileSync(SHARED, bumped);
      const fresh = Bun.spawn([process.execPath, "-e", "import { KTX2_KEY } from './shared/ktx2.js'; console.log(KTX2_KEY)"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      const freshKey = (await new Response(fresh.stdout).text()).trim(); await fresh.exited;
      check("a FRESH process reading the pulled file derives the NEXT key — the pull is real", freshKey === NEXT, `fresh=${freshKey}`);
      const served = await fetch(`${S.base}/shared/ktx2.js`, { cache: "no-store" }).then((r) => r.text());
      check("the running sequencer now SERVES the pulled file — generation 99 — to any client that reads it", served.includes("KTX2_GEN = 99"));
      const version = keyFromVersion(await fetch(`${S.base}/version`).then((r) => r.json()));
      check("…but /version still publishes the key the process RUNS with", version === KTX2_KEY, `published ${version}`);
      // the new client: keyed from /version
      const good = await S.get(negotiate(`store/${hash}.glb`, version));
      check("a client keyed from /version asks with the running key → the variant, immutable: correct", good.status === 200 && same(good.bytes, variant) && good.cc.includes("immutable"), `file=${whichFile(good.bytes)} cc=${good.cc}`);
      // the old client: keyed off the served file — the incident
      const bad = await S.get(negotiate(`store/${hash}.glb`, NEXT));
      check("a client keyed off the served file asks with the NEXT key → the server does not know it: unflagged, NOT the variant, immutable — this is the poison, and it would have been pinned under the NEXT generation before it ever ran",
        bad.status === 200 && !same(bad.bytes, variant) && bad.cc.includes("immutable"), `file=${whichFile(bad.bytes)} cc=${bad.cc}`);
      check("the two answers differ — the split brain is real, and only the on-disk path walks into it", good.etag !== bad.etag);
    }
  } finally {
    restore();
    await S.stop();
  }
  check("the served file is restored byte-for-byte", same(new Uint8Array(readFileSync(SHARED)), new Uint8Array(pristine)));
}

cleanup();
console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : "\n\x1b[32m0 failed\x1b[0m");
process.exit(failures ? 1 : 0);
