// eidoverse-worlds sequencer — live asset ingestion (TEL0S_NOTES §15, 7c).
// POST /upload (models, avatars, runtime scripts) moved here whole from the
// unsplit fetch(), together with the machinery only it feeds: the per-IP
// upload rate windows and the store-optimization queue whose subprocess
// builds each uploaded GLB its draco+webp shadow off the request path — plus
// the deferred boot sweep that queues whatever accumulated while the server
// was down. routes.ts delegates the endpoint here; nothing else changes hands.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, basename, dirname, relative } from "node:path";
import { JOIN_TOKEN, UPLOAD_CAP, ROOT, OPT_DIR, STORE_MIN, LIBRARY_DIR } from "./config.ts";
import { isStoreOriginal, ktx2VariantPath, storeShadowsMissing, verdictStands } from "./store-variants.ts";
import { agentTokens, aid1JoinIdentity } from "./auth.ts";
import { worlds } from "./world.ts";
import { atomicWrite } from "./fsutil.ts";

/** What the handler needs from Bun's server object, structurally (the
 *  VerbWorld precedent): the socket address behind the nginx front. */
type UploadSrv = { requestIP(req: Request): { address: string } | null };

const uploadWin = new Map<string, { t: number; n: number }>(); // per-IP upload rate windows
let tripoImportBusy = false;   // one Tripo import at a time — they cost CPU-seconds

// ---- store optimization -----------------------------------------------------
// Every uploaded GLB (drag-drop, Orrery conjures) gets a draco+webp shadow in
// store-min/ AND a KTX2 variant beside the original (store-variants.ts — the
// ?ktx2=<key> answer, shared/ktx2.js; the §20a diet), both built by a SUBPROCESS — draco encoding is CPU-seconds of
// synchronous wasm, and inside this process it would freeze pose relay for
// every world. One file at a time; the sequencer never waits on it.
type OptItem = { src: string; dest: string; mode?: "--ktx2" | "--ktx2-vrm" | "--ktx2-img" };
const optQueue: OptItem[] = [];
let optRunning = false;
let ktx2Skip = false; // set when a --ktx2 run exits 3 (no encoder) — stop queuing variants this boot
function queueOptimize(absPath: string) {
  let pushed = false;
  if (!optQueue.some((q) => q.src === absPath && !q.mode)) {
    optQueue.push({ src: absPath, dest: join(STORE_MIN, basename(absPath)) });
    pushed = true;
  }
  // The KTX2 shadow too: same source (the ORIGINAL — the §20a diet encodes
  // from the best bytes, and store-min has been wrong before, #122), the
  // variant beside it where routes.ts already looks. Not once this boot has
  // learned there is no encoder — every upload would otherwise spawn a pass
  // that exits 3 and relearns it.
  if (!ktx2Skip && !optQueue.some((q) => q.src === absPath && q.mode === "--ktx2")) {
    optQueue.push({ src: absPath, dest: ktx2VariantPath(absPath), mode: "--ktx2" });
    pushed = true;
  }
  if (pushed) pumpOptimize();
}
async function pumpOptimize() {
  if (optRunning) return;
  optRunning = true;
  try {
    while (optQueue.length) {
      const { src, dest, mode } = optQueue.shift()!;
      const base = basename(src);                      // <hash>.glb / <model>.glb
      const failed = `${dest}.failed`;
      // a KTX2 size verdict from an older recipe does not stand (store-variants.ts)
      const refused = existsSync(failed) && (!mode || verdictStands(readFileSync(failed, "utf8")));
      if (!existsSync(src) || refused) continue;
      // Store shadows are content-addressed — existing means done forever.
      // KTX2 variants shadow MUTABLE library files, so a variant older than
      // its source rebuilds (the sweep filters too, but a file can change
      // while its item waits behind slow encodes).
      if (existsSync(dest) && (!mode || statSync(dest).mtimeMs > statSync(src).mtimeMs)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      // process.execPath = the running bun binary — PATH under systemd has no bun
      const proc = Bun.spawn([process.execPath, "run", join(ROOT, "server", "optimize.ts"), ...(mode ? [mode] : []), src, dest],
        { stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      const err = (await new Response(proc.stderr).text()).trim();
      if (code === 0) {
        // a verdict that was re-measured and answered differently is history
        if (existsSync(failed)) try { rmSync(failed); } catch { /* best effort */ }
        const ratio = (Bun.file(src).size / Math.max(1, Bun.file(dest).size)).toFixed(1);
        console.log(mode ? `[ktx2] ${base} → ${basename(dest)} (${ratio}x)` : `[store] optimized ${base} (${ratio}x)`);
      } else if (code === 2) {
        // not suitable — bigger than source, or (--ktx2-img) non-POT dims /
        // conflicted consumers. Mark with the CLI's reason so the boot sweep
        // stops re-measuring it; the marker's CONTENT is diagnostic only.
        writeFileSync(failed, err.slice(0, 2000) || "not-smaller");
        console.log(mode ? `[ktx2] ${base} — no variant (${err.split("\n").pop()?.replace(/^\[optimize\]\s*/, "") || "not smaller"})`
          : `[store] ${base} already lean — serving original`);
      } else if (code === 4) {
        // Output failed its own container check — the pass corrupted its
        // images (#122). ENVIRONMENTAL, like code 3: the source is good, so a
        // .failed marker here would permanently skip an asset that will
        // convert fine once the encoder stack is sane. Loud, and retried.
        console.error(`[${mode ? "ktx2" : "store"}] ${base} REFUSED — optimized output failed its image check, `
          + `serving the original: ${err.split("\n").filter((l) => l.includes("declares")).join(" | ") || err.split("\n").pop()}`);
      } else if (code === 3 && mode) {
        // No KTX2 encoder on this box — ENVIRONMENTAL, never a .failed marker
        // (that would permanently skip every model authored before
        // KTX-Software lands — the sharp-degrade doctrine). And no point
        // grinding the rest of the sweep against the same missing binary.
        console.log("[ktx2] no encoder — set KTX2_TOKTX or put toktx/ktx on PATH (docs/ktx2-encoder.md); variants skipped this boot");
        ktx2Skip = true;
        for (let i = optQueue.length - 1; i >= 0; i--) if (optQueue[i].mode) optQueue.splice(i, 1);
      } else if (code === 5 && mode) {
        // An encoder answered, but not every eligible texture converted — the
        // CLI REFUSED to write a variant whose name would lie about its
        // contents (the #122 class, and it would be served immutable).
        // ENVIRONMENTAL like code 3 (a flaky or misconfigured encoder, not a
        // bad model): no marker, so the next boot sweep retries; and no
        // ktx2Skip either — the encoder is there, one file did not convert.
        console.error(`[ktx2] ${base} REFUSED — partial conversion, serving the original: ${err.split("\n").pop() ?? `exit ${code}`}`);
      } else {
        // Environmental failures (deps not installed yet) must NOT mark the
        // file — that would permanently skip every upload made before the
        // first successful `bun install`. Only content failures stick.
        const envFail = /cannot find module|cannot resolve|error: script not found/i.test(err);
        if (!envFail) writeFileSync(failed, err.slice(0, 2000) || `exit ${code}`);
        console.error(`[${mode ? "ktx2" : "store"}] optimize ${envFail ? "unavailable (deps?)" : `FAILED ${base}`}: ${err.split("\n")[0] || `exit ${code}`}`);
        if (envFail) { optQueue.length = 0; break; } // no point grinding the rest
      }
    }
  } finally { optRunning = false; }
}
// Boot sweep: whatever accumulated before this shipped (or failed mid-queue
// last run) gets its shadow now. Deferred so boot stays about serving worlds.
setTimeout(() => {
  const dir = join(OPT_DIR, "store");
  if (!existsSync(dir)) return;
  // isStoreOriginal, not endsWith(".glb"): the KTX2 variants live in this
  // same dir and end in .glb too — a variant must never queue as an upload
  // of its own (the ghost-listing rule, §20c). An original lacking EITHER
  // shadow queues both; the pump skips the one that already exists.
  const pending = readdirSync(dir).filter((f) => {
    if (!isStoreOriginal(f)) return false;
    const m = storeShadowsMissing(join(dir, f), STORE_MIN);
    return m.min || m.ktx2;
  });
  if (!pending.length) return;
  console.log(`[store] boot sweep: ${pending.length} upload(s) missing a shadow queued`);
  for (const f of pending) queueOptimize(join(dir, f));
}, 5000);
// Library KTX2 sweep (§20a, VRMs §20c, loose images §20d): every library
// model gets a GPU-native-texture variant at OPT_DIR/<rel>.ktx2.glb, every
// avatar a surgical-rewrite variant at OPT_DIR/<rel>.ktx2.vrm, and every
// curated loose texture a flip-baked variant at OPT_DIR/<rel>.ktx2 — all
// served only on ?ktx2=<key> (routes.ts, shared/ktx2.js). PATH-PRESERVING, unlike the store arm — basename()
// collides across library rels — and through the SAME serial pump, deferred
// further so boot stays about serving worlds. GLBs go through the full
// gltf-transform diet; VRMs go through --ktx2-vrm ONLY (optimize.ts header
// doctrine: bodies get their textures swapped, everything else
// byte-preserved). Avatars live in TWO bases — Skye's library and the upload
// overlay (assets/opt/...) — and serving prefers the overlay, so the sweep
// sources each rel from the base that actually wins.
setTimeout(() => {
  if (ktx2Skip) return;
  const items: OptItem[] = [];
  const seen = new Set<string>();
  const walk = (base: string, dir: string, exts: string[], mode: OptItem["mode"]) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(base, p, exts, mode); continue; }
      const ext = exts.find((x) => e.name.toLowerCase().endsWith(x));
      if (!ext) continue; // non-matching files (.json, _fit.json, audio, …) never queue
      // never re-encode an encode: variants live beside overlay originals
      // (OPT_DIR/<rel>.ktx2.vrm ends in .vrm too) and must not queue themselves
      // (image variants end .ktx2 — outside every swept ext — but keep the
      // guard uniform)
      if (e.name.endsWith(`.ktx2${ext}`)) continue;
      const rel = relative(base, p);
      if (seen.has(rel)) continue; // overlay walked first — it shadows the library copy
      seen.add(rel);
      // GLB/VRM variants are themselves GLB/VRM containers (<rel>.ktx2.glb);
      // a loose image's variant IS the ktx2 (<rel>.ktx2 — routes.ts serves it
      // as image/ktx2)
      const dest = join(OPT_DIR, mode === "--ktx2-img" ? `${rel}.ktx2` : `${rel}.ktx2${ext}`);
      if (existsSync(`${dest}.failed`) && verdictStands(readFileSync(`${dest}.failed`, "utf8"))) continue;
      // mtime, not mere existence: library files are mutable — an updated
      // model/body/texture rebuilds its variant next boot
      if (existsSync(dest) && statSync(dest).mtimeMs > statSync(p).mtimeMs) continue;
      items.push({ src: p, dest, mode });
    }
  };
  walk(LIBRARY_DIR, join(LIBRARY_DIR, "eidoverse", "assets", "models"), [".glb"], "--ktx2");
  // overlay first (it wins in routes.ts serving and the /avatars roster)
  walk(OPT_DIR, join(OPT_DIR, "eidoverse", "assets", "vrms"), [".vrm"], "--ktx2-vrm");
  walk(LIBRARY_DIR, join(LIBRARY_DIR, "eidoverse", "assets", "vrms"), [".vrm"], "--ktx2-vrm");
  // §20d loose toolkit images — CURATED dirs ONLY. These are consumed through
  // the Deno-shim file layer whose loadImageTexture bakes the vertical flip
  // into the pixels, and --ktx2-img pre-bakes exactly that flip; anywhere the
  // convention doesn't hold (thumbnails, previews, arbitrary uploads) a
  // pre-flipped variant would be wrongly mirrored — so the sweep names its
  // dirs instead of chasing every image in the library.
  walk(LIBRARY_DIR, join(LIBRARY_DIR, "eidoverse", "assets", "grass"), [".png"], "--ktx2-img");
  walk(LIBRARY_DIR, join(LIBRARY_DIR, "eidoverse", "assets", "sky"), [".png", ".jpg", ".jpeg"], "--ktx2-img");
  walk(LIBRARY_DIR, join(LIBRARY_DIR, "eidoverse", "assets", "particle_textures"), [".png"], "--ktx2-img");
  if (!items.length) return;
  console.log(`[ktx2] boot sweep: ${items.length} library asset(s) queued for variants`);
  optQueue.push(...items);
  pumpOptimize();
}, 15_000);

// ---- the endpoint -----------------------------------------------------------

/** POST /upload — live asset ingestion. Two destinations:
 *   - models (default): content-addressed into assets/opt/store/<hash>.glb —
 *     immutable by construction, so spawn verbs can reference the path
 *     forever and clients cache it forever. DESIGN.md's "content-addressed
 *     assets" plane, made real.
 *   - ?as=avatar&name=foo: named into the overlay vrms dir, because the
 *     roster is name-keyed and people re-export their bodies (mtime
 *     versioning handles the cache).
 *  Trust model: the door token, any per-agent bearer from
 *  mcpl/tokens.json, OR an aid1 credential the home node vouches for
 *  (so Orrery and agents can push generated GLBs here directly — the
 *  store is content-addressed and inert; what enters a WORLD is still
 *  the `asset`/`spawn` verbs, which per-world roles gate), plus per-IP
 *  rate limiting — live generation is the feature, an upload flood is
 *  not. `?by=` is attribution for the console trail. */
export async function handleUpload(req: Request, url: URL, srv: UploadSrv): Promise<Response> {
  const upTok = url.searchParams.get("token") ?? "";
  let upAgent = agentTokens().byToken.get(upTok);
  // The aid1 leg the join door has: guests enrolled via archipelago-home
  // carry no tokens.json entry, but the scripting tier's `behavior` verb
  // is already reachable to them through world_verb — the bytes it binds
  // must be landable by the same identity, or the tier is half-open.
  // Same audience/scope/slug derivation as the two doors, no jti burn
  // (an aid1 credential is reusable until expiry at every door).
  if (!upAgent) upAgent = aid1JoinIdentity(upTok)?.slug;
  if (JOIN_TOKEN && upTok !== JOIN_TOKEN && !upAgent)
    return new Response("token required", { status: 401 });
  const upBy = (url.searchParams.get("by") ?? upAgent ?? "?").slice(0, 64);
  // Behind the show's nginx front every socket is 127.0.0.1 — the real
  // client address rides X-Real-IP. (Spoofable only when directly exposed,
  // which is the tailnet dev case where rate limits hardly matter.)
  const ip = req.headers.get("x-real-ip") ?? srv.requestIP(req)?.address ?? "?";
  const u = uploadWin.get(ip) ?? { t: 0, n: 0 };
  if (Date.now() - u.t > 60_000) { u.t = Date.now(); u.n = 0; }
  u.n++; uploadWin.set(ip, u);
  if (u.n > 4) return new Response("upload rate limit (4/min)", { status: 429 });
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length > UPLOAD_CAP) return new Response(`too large (${UPLOAD_CAP / 1e6}MB cap)`, { status: 413 });
  if (url.searchParams.get("as") === "script") {
    // Runtime-script ingestion: plain UTF-8 JS, content-addressed like
    // models, so a `behavior` entry pins exact bytes forever. The store
    // is inert — what RUNS is still gated by the behavior verb + sandbox.
    if (body.length > 64 * 1024) return new Response("script too large (64KB cap)", { status: 413 });
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(body); } catch {
      return new Response("script must be UTF-8 text", { status: 415 });
    }
    if (!text.trim()) return new Response("empty script", { status: 415 });
    const shash = new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 16);
    const sdir = join(OPT_DIR, "store", "scripts");
    mkdirSync(sdir, { recursive: true });
    const srel = `store/scripts/${shash}.js`;
    if (!existsSync(join(OPT_DIR, srel))) writeFileSync(join(OPT_DIR, srel), body);
    console.log(`[upload] script ${srel} (${body.length}B) by ${upBy}`);
    return new Response(JSON.stringify({ path: srel }),
      { headers: { "content-type": "application/json" } });
  }
  if (body.length < 12 || new DataView(body.buffer).getUint32(0, true) !== 0x46546c67)
    return new Response("not a GLB container (glb/vrm)", { status: 415 });
  if (url.searchParams.get("as") === "avatar") {
    const raw = url.searchParams.get("name") ?? "unnamed";
    const name = raw.replace(/\.vrm$/i, "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "unnamed";
    const dir = join(OPT_DIR, "eidoverse/assets/vrms");
    mkdirSync(dir, { recursive: true });
    // A RAW TRIPO RIG at the avatar door runs the import pipeline instead of
    // being saved as-is (a Blender export is not wearable: proxy hulls,
    // dropped textures, no humanoid map — three exports in a row needed all
    // three repairs). Detection is a JSON-chunk peek: no VRM extension +
    // the Tripo bone names. The pipeline runs in a SUBPROCESS (simplify +
    // the verification falls are CPU-seconds; in-process they would freeze
    // pose relay — the optimize queue's own rule), one at a time, and the
    // tool's PASS/FAIL exit code is the gate: a body that cannot settle a
    // fall under both engines never enters the roster.
    let gjson: any = null;
    try {
      const dv = new DataView(body.buffer, body.byteOffset);
      gjson = JSON.parse(new TextDecoder().decode(body.subarray(20, 20 + dv.getUint32(12, true))));
    } catch { /* unparseable chunk — treat as plain save, the client will complain */ }
    const isVRM = !!(gjson?.extensions?.VRMC_vrm || gjson?.extensions?.VRM);
    const nodeNames = new Set((gjson?.nodes ?? []).map((n: any) => n.name));
    if (!isVRM && ["Hip", "L_Thigh", "L_Upperarm"].every((b) => nodeNames.has(b))) {
      if (tripoImportBusy) {
        return new Response("an avatar import is already running — try again in a minute", { status: 429 });
      }
      tripoImportBusy = true;
      try {
        const tmpIn = join(OPT_DIR, `.import-${name}.glb`);
        writeFileSync(tmpIn, body);
        // process.execPath, never "bun" (docs/INCIDENTS.md, the Windows shim)
        const spawnArgs = [process.execPath, "run", join(ROOT, "tools/import-tripo-avatar.ts"),
          tmpIn, "--name", name, "--out", OPT_DIR];
        if (process.env.EW_AVATAR_DONOR) spawnArgs.push("--donor", process.env.EW_AVATAR_DONOR);
        const proc = Bun.spawn(spawnArgs, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
        const killer = setTimeout(() => proc.kill(), 300_000);
        const code = await proc.exited;
        clearTimeout(killer);
        const log = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
        try { Bun.spawnSync(["rm", "-f", tmpIn]); } catch { /* temp */ }
        if (code !== 0) {
          console.log(`[upload] tripo import "${name}" FAILED verification\n${log.slice(-800)}`);
          return new Response(`tripo import failed verification — not installed:\n${log.slice(-800)}`,
            { status: 422 });
        }
        renameSync(join(OPT_DIR, `${name}.vrm`), join(dir, `${name}.vrm`));
        console.log(`[upload] tripo→vrm "${name}" imported by ${upBy}\n${log.split("\n").slice(-8).join("\n")}`);
      } finally { tripoImportBusy = false; }
    } else {
      writeFileSync(join(dir, `${name}.vrm`), body);
      console.log(`[upload] avatar "${name}" (${(body.length / 1e6).toFixed(1)}MB) by ${upBy}`);
    }
    // Live cache invalidation: avatars are name-keyed and mutable (people
    // iterate on their bodies), so every connected client — all worlds —
    // learns the file changed; wearers hot-swap with the fresh version.
    const rel = `eidoverse/assets/vrms/${name}.vrm`;
    const update = JSON.stringify({ type: "avatar-updated", name, path: rel, v: Date.now() });
    let notified = 0;
    for (const w of worlds.values()) for (const c of w.clients) { c.ws.send(update); notified++; }
    if (notified) console.log(`[upload] avatar-updated "${name}" → ${notified} client(s)`);
    return new Response(JSON.stringify({ name, path: rel }),
      { headers: { "content-type": "application/json" } });
  }
  const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 16);
  const dir = join(OPT_DIR, "store");
  mkdirSync(dir, { recursive: true });
  const rel = `store/${hash}.glb`;
  if (!existsSync(join(OPT_DIR, rel))) writeFileSync(join(OPT_DIR, rel), body);
  queueOptimize(join(OPT_DIR, rel)); // draco+webp shadow, built off the request path
  // The store is content-addressed, so the human name arrives ONLY here —
  // record it, or the catalog can never list this object as anything but
  // a hash (an orrery send used to vanish into exactly that black hole).
  const upName = (url.searchParams.get("name") ?? "").replace(/\.glb$/i, "").replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 64).trim();
  {
    const mp = join(dir, "manifest.json");
    let man: Record<string, { name?: string; by: string; ts: number }> = {};
    try { if (existsSync(mp)) man = JSON.parse(readFileSync(mp, "utf8")); } catch { /* fresh */ }
    man[hash] = { ...(upName ? { name: upName } : {}), by: upBy, ts: Date.now() };
    atomicWrite(mp, JSON.stringify(man));
  }
  console.log(`[upload] model ${rel}${upName ? ` ("${upName}")` : ""} (${(body.length / 1e6).toFixed(1)}MB) by ${upBy}`);
  return new Response(JSON.stringify({ path: rel }), { headers: { "content-type": "application/json" } });
}
