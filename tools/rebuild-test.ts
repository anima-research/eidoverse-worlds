// bun tools/rebuild-test.ts — POST /rebuild's worker (upload.ts rebuildAsset) against the real pump with a FAKE child
// (OPT_CMD, as optimize-pump-test): a refused pass is asked again (.failed cleared, the child runs, the variant
// lands); a BUILT variant is rebuilt in place (force — the pump otherwise skips a fresh variant); library layout
// (source in the library, variants in the OPT mirror) and store layout (beside the original) both resolve; anything
// that is not an original object — traversal, a variant name, a missing file, a non-GLB — is refused, with nothing
// queued. Then the route: 401 without the token, 400 on a bad path, 200 with the passes named.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync, statSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d: unknown = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "\x1b[32m✓" : "\x1b[31m✗"}\x1b[0m ${n}${ok ? "" : `  ${JSON.stringify(d)}`}`); };
const root = mkdtempSync(join(tmpdir(), "rebuild-"));
const fake = join(root, "fake.sh"), receipts = join(root, "receipts.txt");
writeFileSync(fake, `#!/bin/sh
src=""; dest=""; mode=""
for a in "$@"; do case "$a" in --*) mode="$a";; *) if [ -z "$src" ]; then src="$a"; else dest="$a"; fi;; esac; done
echo "$mode $dest" >> "${receipts}"
if [ -f "${root}/refuse-once" ]; then cat "${root}/refuse-once" >&2; rm -f "${root}/refuse-once"; exit 2; fi
if [ -f "${root}/refuse$mode" ]; then cat "${root}/refuse$mode" >&2; exit 2; fi
if [ -f "${root}/crash$mode" ]; then echo "TypeError: boom at parse" >&2; exit 1; fi
mkdir -p "$(dirname "$dest")"; printf 'rebuilt' > "$dest"; exit 0
`); chmodSync(fake, 0o755); writeFileSync(receipts, "");
Object.assign(process.env, { REBUILD_COOLDOWN_MS: "0", SKIP_OPT_SWEEP: "1", WORLDS_DIR: join(root, "worlds"), OPT_DIR: join(root, "opt"), EIDOVERSE_DIR: join(root, "lib"),
  JOIN_TOKEN: "t0k", OPT_CMD: fake, OPT_MEM_BUDGET_MB: "0", KTX2_TOKTX: "" });
const { rebuildAsset, optIdle } = await import("../server/upload.ts");
const { ktx2VariantPath, lodVariantPath } = await import("../server/store-variants.ts");
const lib = join(root, "lib", "eidoverse/assets/models"), opt = join(root, "opt"), store = join(opt, "store");
mkdirSync(lib, { recursive: true }); mkdirSync(store, { recursive: true });
writeFileSync(join(lib, "rock.glb"), "orig"); writeFileSync(join(store, "abc123.glb"), "orig");
const runs = () => readFileSync(receipts, "utf8").split("\n").filter(Boolean);

// 1. library, refused LOD: its .failed is cleared and the pass runs; the KTX2 variant is BUILT and fresh → rebuilt too
const libK = join(opt, ktx2VariantPath("eidoverse/assets/models/rock.glb")), libL = join(opt, lodVariantPath("eidoverse/assets/models/rock.glb"));
mkdirSync(join(opt, "eidoverse/assets/models"), { recursive: true });
writeFileSync(libK, "old"); const later = new Date(Date.now() + 60_000); utimesSync(libK, later, later);   // fresher than its source
writeFileSync(`${libL}.failed`, "[optimize] lod: reduction ineffective (20000 -> 19000 verts, permissive too)");
const r1 = rebuildAsset("eidoverse/assets/models/rock.glb"); await optIdle();
check("library object: both passes queued", JSON.stringify(r1?.queued) === '["ktx2","lod"]', r1);
check("…the refused LOD's .failed is gone and the LOD landed", !existsSync(`${libL}.failed`) && readFileSync(libL, "utf8") === "rebuilt");
check("…the fresh BUILT KTX2 variant was rebuilt in place (forced)", readFileSync(libK, "utf8") === "rebuilt");
check("…variants land in the OPT mirror, the library source untouched", readFileSync(join(lib, "rock.glb"), "utf8") === "orig" && runs().length === 2, runs());

// 2. store object, deferred KTX2: .deferred cleared, both beside the original
const stK = ktx2VariantPath(join(store, "abc123.glb")), stL = lodVariantPath(join(store, "abc123.glb"));
writeFileSync(`${stK}.deferred`, "estimated 900MB > budget");
const r2 = rebuildAsset("store/abc123.glb"); await optIdle();
check("store object: variants rebuilt beside the original, .deferred cleared", !!r2 && readFileSync(stK, "utf8") === "rebuilt" && readFileSync(stL, "utf8") === "rebuilt" && !existsSync(`${stK}.deferred`));

// 2b. a pass still WAITING is upgraded to forced, never queued twice. The pump takes its first item synchronously, so
// back-to-back presses find the KTX2 pass in flight (a new forced run is right: it may predate the press) and the LOD
// pass waiting (upgraded in place). 3 runs; an always-push queue would make it 4, with the LOD run twice.
{
  await optIdle();
  const b0 = runs().length;
  rebuildAsset("store/abc123.glb"); rebuildAsset("store/abc123.glb"); await optIdle();
  const mine = runs().slice(b0);
  check("back-to-back presses: the waiting LOD pass is upgraded, not duplicated (3 runs, LOD once)",
    mine.length === 3 && mine.filter((l) => l.startsWith("--lod ")).length === 1, mine);
}
// 2c. a forced item is never dropped by a verdict written AFTER the press: the in-flight KTX2 run (from the first press)
// refuses and writes .failed; the second press's forced KTX2 item, queued behind it, must still run.
{
  await optIdle();
  const b0 = runs().length;
  const { KTX2_RECIPE } = await import("../server/store-variants.ts");
  const { toolsStamp } = await import("../server/tools-stamp.ts");
  writeFileSync(join(root, "refuse-once"), `[optimize] not smaller (1 -> 2, 1ms) recipe=${KTX2_RECIPE} ${toolsStamp()} — keeping original`);   // a verdict that STANDS
  rebuildAsset("store/abc123.glb"); rebuildAsset("store/abc123.glb"); await optIdle();
  const mine = runs().slice(b0);
  check("a forced re-ask queued behind an in-flight refusal still runs (KTX2 twice)", mine.filter((l) => l.startsWith("--ktx2 ")).length === 2, mine);
  const { variantStatus } = await import("../server/store-variants.ts");
  const st = variantStatus(join(store, "abc123.glb"), join(opt, "store-min"));
  check("…and the success that followed cleared the refusal: no .failed left, the card reads built", !existsSync(`${ktx2VariantPath(join(store, "abc123.glb"))}.failed`) && st.ktx2.state === "built", st.ktx2);
}
// 2d. one model, one forced rebuild per window: a second ask inside it queues nothing and says how long to wait
{
  await optIdle(); process.env.REBUILD_COOLDOWN_MS = "60000";
  const b0 = runs().length;
  writeFileSync(join(lib, "stone.glb"), "orig"); writeFileSync(join(store, "def456.glb"), "orig");   // never rebuilt before
  const first = rebuildAsset("eidoverse/assets/models/stone.glb"); await optIdle();
  const again = rebuildAsset("eidoverse/assets/models/stone.glb"); await optIdle();
  const other = rebuildAsset("store/def456.glb"); await optIdle();
  check("cooldown: the second ask for the SAME model inside the window queues nothing and names the wait; another model still rebuilds",
    first?.queued.length === 2 && again?.queued.length === 0 && (again?.cooldownS ?? 0) > 0 && (again?.cooldownS ?? 0) <= 60
    && other?.queued.length === 2 && runs().length - b0 === 4, [first, again, other, runs().length - b0]);
  process.env.REBUILD_COOLDOWN_MS = "0";
}
// 2e. many models, one caller: at most REBUILD_WAIT_CAP (4) forced passes wait across ALL callers, counting what the ask
// itself adds; past it an ask queues nothing and says busy. And an upload arriving behind waiting rebuilds runs FIRST (the pump prefers unforced items).
{
  await optIdle();
  for (const m of ["m1", "m2", "m3", "m4"]) writeFileSync(join(store, `${m}.glb`), "orig");
  const b0 = runs().length;
  const asks = ["m1", "m2", "m3", "m4"].map((m) => rebuildAsset(`store/${m}.glb`));   // m1's KTX2 is taken at once; 1+2 wait
  writeFileSync(join(store, "up1.glb"), "orig");
  const { queueOptimize } = await import("../server/upload.ts");
  queueOptimize(join(store, "up1.glb"));
  await optIdle();
  const mine = runs().slice(b0);
  // m1's KTX2 is taken at once, so 1 + 2 = 3 wait; m3 would make 5 past a cap of 4 (the parent let it: Greptile #207)
  check("cap: forced passes waiting never exceed REBUILD_WAIT_CAP: m1 and m2 queue both (3 wait); m3 and m4 would pass 4 → busy, nothing queued",
    asks.slice(0, 2).every((a) => a?.queued.length === 2) && asks.slice(2).every((a) => a?.busy === true && a?.queued.length === 0)
    && !mine.some((l) => /m[34]\.glb/.test(l)), [asks, mine]);
  const firstUp = mine.findIndex((l) => l.includes("up1.glb")), lastForced = mine.map((l) => /m[12]\.glb/.test(l)).lastIndexOf(true);
  check("priority: the upload queued behind the rebuilds ran before the waiting forced passes (only the in-flight one ran first)",
    firstUp === 1 && lastForced > firstUp, mine);
}
// 2f. SOURCE IDENTITY (store-variants.ts freshOver): the pump records what each outcome was built from — a variant's
// .srcid sidecar, a verdict's `source=` line — and freshness is that identity EQUAL to the source's now, at the pump,
// the route and the card alike. Never marker-vs-source mtime order.
{
  await optIdle();
  const { diskIdentity, sourceSidecar, readVerdict, variantStatus, LOD_RECIPE, recipeStamp } = await import("../server/store-variants.ts");
  const { KTX2_KEY } = await import("../shared/ktx2.js");
  const { route: rt } = await import("../server/routes.ts");
  const REL = "eidoverse/assets/models/prop.glb", src = join(lib, "prop.glb");
  const pK = join(opt, ktx2VariantPath(REL)), pL = join(opt, lodVariantPath(REL));
  writeFileSync(src, "prop v1 bytes");
  const lightLine = `[optimize] lod: already light (900 verts < 1000) (3ms) ${recipeStamp(LOD_RECIPE)} — original stays the only representation`;
  writeFileSync(join(root, "refuse--lod"), lightLine);
  rebuildAsset(REL); await optIdle();
  const id0 = diskIdentity(src)!;
  let side: unknown = null; try { side = JSON.parse(readFileSync(sourceSidecar(pK), "utf8")); } catch { /* absent */ }
  check("identity: a built variant records its source's identity (size + mtime + sha256) in its .srcid sidecar", JSON.stringify(side) === JSON.stringify(id0), [side, id0]);
  const tok = readVerdict(readFileSync(`${pL}.failed`, "utf8")).source;
  check("identity: a verdict records it too (its record's `source`)", JSON.stringify(tok) === JSON.stringify(id0), [tok, id0]);
  // a stand-in optimizer printed only TEXT (no [verdict] line): the pump still writes a typed record, read by the
  // legacy grammar once, at write time
  let rec: any = null; try { rec = JSON.parse(readFileSync(`${pL}.failed`, "utf8")); } catch { /* not JSON */ }
  check("records: the pump writes the verdict as JSON {v, kind, reason, stamp, recipe, source, exit, tail} — kind from a text-only CLI too",
    rec?.v === 1 && rec.kind === "light" && rec.reason === "already light (900 verts < 1000)" && rec.recipe === LOD_RECIPE && rec.exit === 2
    && rec.stamp === recipeStamp(LOD_RECIPE) && rec.tail.includes("already light"), rec);
  const lodAt = async () => (await rt(new Request(`http://x/library/${REL}?ktx2=${KTX2_KEY}&lod=${LOD_RECIPE}`), {} as any)).headers.get("x-eidoverse-lod");
  const card = () => variantStatus(join(opt, REL), join(opt, "eidoverse/assets/models"), { source: src });
  // the flake, made deterministic: a verdict in the SAME mtime tick as its source was "not newer", so not fresh
  { const t = new Date(id0.mtimeMs); utimesSync(`${pL}.failed`, t, t); }
  check("identity: a verdict whose mtime EQUALS its source's still stands at the route (refused=light), since it records that source",
    (await lodAt()) === "refused=light", await lodAt());
  check("…and on the card (not needed)", card().lod.state === "not-needed", card().lod);
  // B4: the route used to judge against the FIRST of PATCH/OPT/LIBRARY — the OPT mirror here — while the sweep built
  // from, and compared against, the LIBRARY file. A newer mirror copy said "stale" forever to a verdict the sweep kept.
  mkdirSync(join(opt, "eidoverse/assets/models"), { recursive: true });
  writeFileSync(join(opt, REL), "an optimized mirror copy"); { const f = new Date(Date.now() + 3_600_000); utimesSync(join(opt, REL), f, f); }
  check("which source: a newer OPT-mirror copy does not unseat a verdict about the LIBRARY file the sweep built from", (await lodAt()) === "refused=light", await lodAt());
  // antra's collision (#207 review, 09-29): SAME size, the ORIGINAL mtime restored, different bytes. The stat pair
  // matches exactly, so only the content digest can tell. Precondition checked, so a botched restore can't pass it.
  writeFileSync(src, "prop V1 bytes"); utimesSync(src, id0.mtimeMs / 1000, id0.mtimeMs / 1000);
  { const st = statSync(src);
    check("collision setup: same size AND the recorded mtime restored exactly (the stat pair can't tell)",
      st.size === id0.size && st.mtimeMs === id0.mtimeMs, [st.size, st.mtimeMs, id0.size, id0.mtimeMs]); }
  check("identity: a same-size replacement with its mtime restored makes the verdict a question again (provisional)",
    (await lodAt()) === "provisional", await lodAt());
  check("…and the card says stale for both arms (content, not the stat pair, is the identity)",
    card().lod.state === "stale" && card().ktx2.state === "stale", card());
  // the dangerous direction of "newer than": a DIFFERENT source that carries an OLDER mtime (cp -p, rsync -a, tar)
  writeFileSync(src, "prop v2 — re-exported, and longer"); { const o = new Date(id0.mtimeMs - 86_400_000); utimesSync(src, o, o); }
  check("identity: a source replaced by a file with an OLDER mtime makes the verdict a question again (provisional)",
    (await lodAt()) === "provisional", await lodAt());
  check("…and the card says stale for both arms (the ktx2 variant is newer than that file, but about another)",
    card().lod.state === "stale" && card().ktx2.state === "stale", card());
  // the pump's M1 by identity: a refused re-measure removes a variant built from OTHER content — here one NEWER than
  // its (older-mtime) source, which the old strictly-older rule kept serving
  writeFileSync(join(root, "refuse--ktx2"), "[optimize] ktx2: no convertible raster images (2ms) — keeping original");
  rebuildAsset(REL); await optIdle();
  check("identity: a refused re-measure removes the variant built from another version of its source (and its sidecar)",
    !existsSync(pK) && !existsSync(sourceSidecar(pK)) && existsSync(`${pK}.failed`), [existsSync(pK), existsSync(sourceSidecar(pK))]);
  // a forced re-ask refused on UNCHANGED content keeps the variant that still serves (same identity)
  rmSync(join(root, "refuse--ktx2")); rebuildAsset(REL); await optIdle();
  writeFileSync(join(root, "refuse--ktx2"), "[optimize] ktx2: no convertible raster images (2ms) — keeping original");
  rebuildAsset(REL); await optIdle();
  check("…but a refusal on the SAME source identity keeps the variant that still serves", existsSync(pK) && existsSync(`${pK}.failed`), existsSync(pK));
  rmSync(join(root, "refuse--ktx2")); rmSync(join(root, "refuse--lod"));
  // a VRM body's ktx2 variant: served only while its sidecar names the winning original
  const vrmRel = "eidoverse/assets/vrms/body.vrm", vrmSrc = join(root, "lib", vrmRel), vK = join(opt, `${vrmRel}.ktx2.vrm`);
  mkdirSync(join(root, "lib", "eidoverse/assets/vrms"), { recursive: true }); mkdirSync(join(opt, "eidoverse/assets/vrms"), { recursive: true });
  writeFileSync(vrmSrc, "body"); writeFileSync(vK, "ktx2 body"); writeFileSync(sourceSidecar(vK), JSON.stringify(diskIdentity(vrmSrc)));
  const vrmAt = async () => await (await rt(new Request(`http://x/library/${vrmRel}?ktx2=${KTX2_KEY}`), {} as any)).text();
  check("VRM: a variant whose sidecar names the current body serves", (await vrmAt()) === "ktx2 body", await vrmAt());
  writeFileSync(sourceSidecar(vK), JSON.stringify({ size: 1, mtimeMs: 1 }));
  check("…and one that names another body does not (the original serves)", (await vrmAt()) === "body", await vrmAt());
  // a content-addressed store original: any standing verdict stands, whatever its mtime (the same bytes forever)
  writeFileSync(join(store, "ca1.glb"), "orig"); mkdirSync(join(opt, "store-min"), { recursive: true });
  writeFileSync(join(opt, "store-min", "ca1.glb.failed"), "lean");
  const caL = lodVariantPath(join(store, "ca1.glb"));
  writeFileSync(`${caL}.failed`, lightLine); writeFileSync(`${ktx2VariantPath(join(store, "ca1.glb"))}.failed`, "[optimize] ktx2: no convertible raster images (2ms) — keeping original");
  { const o = new Date(Date.now() - 86_400_000); utimesSync(`${caL}.failed`, o, o); }   // OLDER than the upload
  const b0 = runs().length;
  const { queueOptimize: qo } = await import("../server/upload.ts");
  qo(join(store, "ca1.glb")); await optIdle();
  check("store (content-addressed): a standing verdict OLDER than the upload's mtime still stands — the pump runs nothing",
    runs().length === b0, runs().slice(b0));
}
// 2g. a CRASH (any exit but 2) is a `failure` record — never a verdict: never final, and re-asked when the tools change
{
  await optIdle();
  const { readVerdict, verdictStands, lodVerdictKind, KTX2_RECIPE } = await import("../server/store-variants.ts");
  const { currentToolsDigest } = await import("../server/tools-stamp.ts");
  writeFileSync(join(lib, "crashy.glb"), "orig");
  const cK = join(opt, ktx2VariantPath("eidoverse/assets/models/crashy.glb"));
  writeFileSync(join(root, "crash--ktx2"), "");
  rebuildAsset("eidoverse/assets/models/crashy.glb"); await optIdle();
  let rec: any = null; try { rec = JSON.parse(readFileSync(`${cK}.failed`, "utf8")); } catch { /* absent */ }
  check("records: a crash (exit 1) is kind `failure`, stamped with the tools that crashed, its stderr kept as the tail",
    rec?.kind === "failure" && rec.exit === 1 && rec.toolsDigest === currentToolsDigest() && rec.tail.includes("TypeError: boom") && rec.reason.includes("boom"), rec);
  const raw = existsSync(`${cK}.failed`) ? readFileSync(`${cK}.failed`, "utf8") : "";
  check("…it stands under the same tools (no crash loop every boot) and falls under new ones; it is never a LOD kind",
    verdictStands(raw, KTX2_RECIPE) && !verdictStands(raw, KTX2_RECIPE, "000000000000") && lodVerdictKind(raw) === null && readVerdict(raw).kind === "failure");
  rmSync(join(root, "crash--ktx2"));
}
// 3. refusals: nothing queued for any of them
const before = runs().length;
const bad = ["../../etc/passwd.glb", "eidoverse/assets/models/../../x.glb", "store/abc123.glb.ktx2.glb", `store/abc123.glb.lod.x.glb`,
  "eidoverse/assets/models/missing.glb", "eidoverse/assets/vrms/a.vrm", "store/abc123.png", "", "eidoverse/assets/models/sub/rock.glb"];
for (const b of bad) check(`refused: ${JSON.stringify(b)}`, rebuildAsset(b) === null);
await optIdle();
check("…and no refused path ran the optimizer", runs().length === before, runs().slice(before));

// 4. the route: the /upload sign-ins + a session cookie; the door key as a Bearer header, never in the URL
const { route } = await import("../server/routes.ts");
const { hnSessions } = await import("../server/auth.ts");
const call = async (q: string, headers: Record<string, string> = {}) => await route(new Request(`http://x/rebuild?${q}`, { method: "POST", headers }), {} as any);
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
const noTok = await call("path=store/abc123.glb");
check("route: no credential → 401", noTok.status === 401, noTok.status);
const wrongTok = await call("path=store/abc123.glb", bearer("nope"));
check("route: wrong key → 401", wrongTok.status === 401, wrongTok.status);
const inUrl = await call("token=t0k&path=store/abc123.glb");
check("route: the RIGHT key in the URL → 401 (it would land in access logs)", inUrl.status === 401, inUrl.status);
const sid = "a".repeat(64); hnSessions.set(sid, { sub: "u_test", name: "tester", scopes: [], exp: Date.now() + 60_000 });
const crossSite = await call("path=store/abc123.glb", { cookie: `ew_sess=${sid}`, "sec-fetch-site": "same-site" });
check("route: a session cookie from ANOTHER origin (a sibling subdomain) → 401", crossSite.status === 401, crossSite.status);
const viaSession = await call("path=store/abc123.glb", { cookie: `ew_sess=${sid}`, "sec-fetch-site": "same-origin", "x-real-ip": "7.7.7.7" }); await optIdle();
check("route: a signed-in session with no door key → 200 (home-node sign-ins could not rebuild before)", viaSession.status === 200, viaSession.status);
hnSessions.set(sid, { sub: "u_test", name: "tester", scopes: [], exp: Date.now() - 1 });
const expired = await call("path=store/abc123.glb", { cookie: `ew_sess=${sid}`, "sec-fetch-site": "same-origin" });
check("route: an EXPIRED session → 401", expired.status === 401, expired.status);
const badPath = await call("path=store/..%2F..%2Fx.glb", bearer("t0k"));
check("route: bad path → 400", badPath.status === 400, badPath.status);
const good = await call("path=store/abc123.glb", bearer("t0k"));
const j = good.status === 200 ? await good.json() : null;
check("route: token + object → 200 naming the passes", j?.ok === true && j.queued.join() === "ktx2,lod", [good.status, j]);
await optIdle();
// rate limit: 4 per IP per minute, like /upload; the 5th is refused before anything is queued
const fromIp = async () => await route(new Request("http://x/rebuild?path=store/abc123.glb", { method: "POST", headers: { "x-real-ip": "9.9.9.9", authorization: "Bearer t0k" } }), {} as any);
const st: number[] = []; for (let i = 0; i < 4; i++) { st.push((await fromIp()).status); await optIdle(); }
const runsBefore5th = runs().length;
const fifth = await fromIp(); await optIdle();
check("route: 4 rebuilds per IP per minute pass, the 5th → 429 and queues nothing", st.every((x) => x === 200) && fifth.status === 429 && runs().length === runsBefore5th, [st, fifth.status]);
const other = await route(new Request("http://x/rebuild?path=store/abc123.glb", { method: "POST", headers: { "x-real-ip": "8.8.8.8", authorization: "Bearer t0k" } }), {} as any);
check("…and the window is per IP (another address still passes)", other.status === 200, other.status);
await optIdle();
console.log(`${fail ? "\x1b[31m" : "\x1b[32m"}${pass} passed, ${fail} failed\x1b[0m`); process.exit(fail ? 1 : 0);
