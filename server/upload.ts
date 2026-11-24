// Live asset ingestion: POST /upload (models, avatars, pictures, heightmaps, sound), with the machinery only it feeds: the
// upload rate windows (one per uploader), the store-optimization queue (a subprocess builds each variant off the request
// path), and the deferred boot sweeps. routes.ts delegates the endpoint here.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, statfsSync, rmSync } from "node:fs";
import { addressOf } from "./peer.ts";
import { bearerOf } from "./access.ts";
import { join, basename, dirname, relative } from "node:path";
import { JOIN_TOKEN, UPLOAD_CAP, IMAGE_CAP, ROOT, OPT_DIR, PATCH_DIR, STORE_MIN, LIBRARY_DIR, SKIP_OPT_SWEEP, OPT_MEM_BUDGET_MB, OPT_COST_FACTOR, optChildTimeoutMs } from "./config.ts";
import { isStoreOriginal, ktx2VariantPath, lodVariantPath, storeShadowsMissing, verdictStands, freshOver, diskIdentity, sourceSidecar, recordedSource, sameIdentity, verdictMarker, readVerdict, KTX2_RECIPE, LOD_RECIPE } from "./store-variants.ts";
import { agentTokens, aid1JoinIdentity, sessionOfRequest } from "./auth.ts";
import { worlds } from "./world.ts";
import { atomicWrite } from "./fsutil.ts";
import { ingestHeightmap } from "./heightmap.ts";
import { readCappedBytes } from "./request-body.ts";
import { checkFile } from "./buildcheck-queue.ts";
import { envNumber } from "./limits.ts";
import { sha256Bytes } from "../shared/protocol/hash.js";
import { avatarDefs } from "./defs.ts";
import { resolveLibFile } from "./libfile.ts";
import { ipBucketKey } from "./clientlog.ts";

/** What the handler needs from Bun's server object, structurally: the socket address behind the proxy. */
type UploadSrv = { requestIP(req: Request): { address: string } | null };

/** Uploads a minute for one uploader: the identity an upload stands on (a person's sign-in, an agent's bearer), or, when
 *  it proves none (an open server's anonymous upload, the door key everyone shares), the address it comes from. */
export const UPLOADS_PER_MINUTE = 30;
const uploadWin = new Map<string, { t: number; n: number }>(); // upload rate windows, by uploader (identity, else address)
/** What the store may take. perDayBytes (UPLOAD_MB_PER_DAY, default 2000): the bytes one uploader may store in a day
 *  (refusals and bytes already stored are free), twenty uploads at the 100 MB cap, far past a busy builder's day. minFreeBytes (UPLOAD_MIN_FREE_MB, default 2048): uploads stop
 *  while the store's disk has less free than this, so world logs keep room to grow. 0 turns either off. */
export const uploadBudget = {
  perDayBytes: envNumber("UPLOAD_MB_PER_DAY", 2000) * 1_000_000,
  minFreeBytes: envNumber("UPLOAD_MIN_FREE_MB", 2048) * 1_000_000,
};
const DAY_MS = 86_400_000;
const uploadDay = new Map<string, { t: number; bytes: number }>();   // bytes sent today, by uploader
/** Free bytes on the store's disk; null when the platform can't say (the floor is then not applied). */
function freeBytes(): number | null {
  try { mkdirSync(OPT_DIR, { recursive: true }); const f = statfsSync(OPT_DIR); return Number(f.bavail) * Number(f.bsize); } catch { return null; }
}
/** Whether storing `need` more bytes would take the store's disk under UPLOAD_MIN_FREE_MB (false when that is off or unknown). */
export function diskNearlyFull(need = 0): boolean {
  if (uploadBudget.minFreeBytes <= 0) return false;
  const free = freeBytes(); return free !== null && free - need < uploadBudget.minFreeBytes;
}
/** Drop windows that have ended, once a map holds many (each address that ever uploaded had one, for good). */
function pruneWindows(now: number) {
  if (uploadWin.size > 10_000) for (const [k, w] of uploadWin) if (now - w.t >= 60_000) uploadWin.delete(k);
  if (uploadDay.size > 10_000) for (const [k, w] of uploadDay) if (now - w.t >= DAY_MS) uploadDay.delete(k);
}
let tripoImportBusy = false;   // one Tripo import at a time — they cost CPU-seconds

// ---- store optimization -----------------------------------------------------
// Every uploaded GLB gets a draco+webp shadow in store-min/, a KTX2 variant and a geometry LOD beside the original
// (store-variants.ts), each built by a subprocess: draco encoding is CPU-seconds of synchronous wasm that would freeze pose
// relay for every world. One file at a time; the server never waits on it.
type OptItem = { src: string; dest: string; mode?: "--ktx2" | "--ktx2-vrm" | "--ktx2-img" | "--lod"; force?: boolean };
const optQueue: OptItem[] = [];
let optRunning = false;
let ktx2Skip = false; // set when a --ktx2 run exits 3 (no encoder) — stop queuing variants this boot
let lodEncoderWarned = false; // the --lod arm's own once-per-boot note; it never sets ktx2Skip
/** An older recipe generation's lod files (variant, marker, deferral) are dead: the recipe is in the URL and the
 *  name. Pruned on a bake AND on a refusal, so a recipe bump leaves one generation on disk. */
function pruneOldLodGenerations(src: string, dest: string) {
  const base = basename(src), dir = dirname(dest);
  const keep = new Set([dest, `${dest}.failed`, `${dest}.deferred`, `${dest}.srcid`]);
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f.startsWith(`${base}.lod.`) && /\.glb(\.failed|\.deferred|\.srcid)?$/.test(f) && !keep.has(p))
      try { rmSync(p); } catch { /* best effort */ }
  }
}

// Items this host could not afford (over budget, or the child died under the cap). Informational: the marker never
// blocks a retry (the next boot re-estimates); /version reports the count, which is this boot's.
const optDeferred = new Set<string>();
if (process.env.OPT_CMD) console.warn(`[optimize] OPT_CMD=${process.env.OPT_CMD} — a stand-in optimizer is in charge of every variant this boot`);
export function optStatus() {
  return { budgetMB: OPT_MEM_BUDGET_MB, queued: optQueue.length, running: optRunning, deferred: optDeferred.size };
}
function undefer(dest: string) {
  optDeferred.delete(dest);
  if (existsSync(`${dest}.deferred`)) try { rmSync(`${dest}.deferred`); } catch { /* best effort */ }
}
function defer(dest: string, why: string) {
  optDeferred.add(dest);
  try { mkdirSync(dirname(dest), { recursive: true }); writeFileSync(`${dest}.deferred`, why); } catch { /* best effort */ }
  console.log(`[optimize] deferred ${basename(dest)} — ${why}`);
}
export function queueOptimize(absPath: string) {
  let pushed = false;
  if (!optQueue.some((q) => q.src === absPath && !q.mode)) {
    optQueue.push({ src: absPath, dest: join(STORE_MIN, basename(absPath)) });
    pushed = true;
  }
  // the KTX2 variant too, encoded from the ORIGINAL (the best bytes), beside it where routes.ts looks; not once this
  // boot has learned there is no encoder
  if (!ktx2Skip && !optQueue.some((q) => q.src === absPath && q.mode === "--ktx2")) {
    optQueue.push({ src: absPath, dest: ktx2VariantPath(absPath), mode: "--ktx2" });
    pushed = true;
  }
  // the geometry LOD too (objects only: the CLI fails closed on anything skinned, from the raw container). NOT gated
  // on ktx2Skip: an untextured object needs no encoder, and the CLI decides per file
  if (!optQueue.some((q) => q.src === absPath && q.mode === "--lod")) {
    optQueue.push({ src: absPath, dest: lodVariantPath(absPath), mode: "--lod" });
    pushed = true;
  }
  if (pushed) pumpOptimize();
}
// One forced rebuild per model per window (the route's per-address limit caps presses, not the encode time each buys).
// Read per call; REBUILD_COOLDOWN_MS=0 disables.
const lastRebuild = new Map<string, number>();
// And the pump takes every upload / sweep item before a forced one (pumpOptimize), with at most REBUILD_WAIT_CAP forced
// passes waiting across all callers: rotating presses over many models can then only delay other rebuilds, never uploads.
/** Rebuild one placeable object's KTX2 + LOD variants on request (a Build card's rebuild button, POST /rebuild).
 *  `rel` is the catalog path: `eidoverse/assets/models/<f>.glb` (source in the library, variants in the OPT mirror —
 *  the boot sweep's layout) or `store/<hash>.glb`. Its verdict markers (.failed, .deferred) are cleared so a refusal
 *  is asked again, and the passes are FORCED: a built variant keeps serving until the new one lands over it
 *  (optimize.ts writes atomically). null = not a rebuildable object. */
export function rebuildAsset(rel: string): { queued: string[]; cooldownS?: number; busy?: boolean } | null {
  if (!/^(eidoverse\/assets\/models\/[^/]+|store\/[^/]+)\.glb$/.test(rel) || rel.includes("..")) return null;
  const store = rel.startsWith("store/");
  const src = store ? join(OPT_DIR, rel) : join(LIBRARY_DIR, rel);
  if (!isStoreOriginal(basename(rel))) return null;   // a variant (…ktx2.glb, …lod.*.glb) is never a source
  if (!existsSync(src)) return null;
  const dests = store
    ? { "--ktx2": ktx2VariantPath(src), "--lod": lodVariantPath(src) }
    : { "--ktx2": join(OPT_DIR, ktx2VariantPath(rel)), "--lod": join(OPT_DIR, lodVariantPath(rel)) };
  const cool = envNumber("REBUILD_COOLDOWN_MS", 600_000), last = lastRebuild.get(src) ?? -Infinity;
  if (cool > 0 && Date.now() - last < cool) return { queued: [], cooldownS: Math.ceil((cool - (Date.now() - last)) / 1000) };
  // the cap bounds what WAITS after this ask, its own passes counted. An ask never fits in part; an empty wait always
  // takes one whole ask, so a cap below 2 can't lock a model's two passes out forever
  const cap = envNumber("REBUILD_WAIT_CAP", 4);
  const waitingForced = optQueue.filter((q) => q.force).length;
  const adds = (Object.keys(dests) as NonNullable<OptItem["mode"]>[])
    .filter((mode) => !(mode === "--ktx2" && ktx2Skip) && !optQueue.some((q) => q.src === src && q.mode === mode && q.force)).length;
  if (cap > 0 && waitingForced > 0 && waitingForced + adds > cap) return { queued: [], busy: true };
  const queued: string[] = [];
  for (const [mode, dest] of Object.entries(dests) as [NonNullable<OptItem["mode"]>, string][]) {
    if (mode === "--ktx2" && ktx2Skip) continue;   // no encoder this boot — the pass would only exit 3
    for (const m of [`${dest}.failed`, `${dest}.deferred`]) if (existsSync(m)) try { rmSync(m); } catch { /* best effort */ }
    optDeferred.delete(dest);
    const waiting = optQueue.find((q) => q.src === src && q.mode === mode);
    if (waiting) waiting.force = true; else optQueue.push({ src, dest, mode, force: true });
    queued.push(mode.slice(2));
  }
  if (queued.length) { lastRebuild.set(src, Date.now()); pumpOptimize(); }
  return { queued };
}
// a child's stderr up to EOF, or up to graceMs once asked: a grandchild that inherited the pipe holds EOF off forever
const STDERR_GRACE_MS = 2000;
function drain(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader(), dec = new TextDecoder(); let text = "";
  const eof = (async () => { for (let r; !(r = await reader.read()).done;) text += dec.decode(r.value, { stream: true }); })().catch(() => {});
  return async (graceMs: number) => {
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([eof, new Promise((r) => { t = setTimeout(r, graceMs); })]); clearTimeout(t);
    reader.cancel().catch(() => {}); return text;
  };
}
let optPump: Promise<void> = Promise.resolve();
/** Resolves when the pump has drained (a harness awaits this; the server never does). */
export const optIdle = () => optPump;
async function pumpOptimize() {
  if (optRunning) return;
  optRunning = true;
  let done!: () => void; optPump = new Promise<void>((r) => { done = r; });
  try {
    while (optQueue.length) {
      const next = optQueue.findIndex((q) => !q.force);
      const { src, dest, mode, force } = optQueue.splice(next < 0 ? 0 : next, 1)[0];
      const base = basename(src);                      // <hash>.glb / <model>.glb
      const failed = `${dest}.failed`;
      // the file this pass is ABOUT (store-variants.ts freshOver): null for a content-addressed store original and for
      // the store-min pass, whose shadows are done forever once they exist; the library/overlay file otherwise
      const source = !mode || dirname(src) === join(OPT_DIR, "store") ? null : src;
      // a size verdict from an older recipe does not stand (store-variants.ts), nor does any verdict about a source
      // that has changed since (the route reads the same rule)
      const refused = existsSync(failed)
        && (!mode || verdictStands(readFileSync(failed, "utf8"), mode === "--lod" ? LOD_RECIPE : KTX2_RECIPE))
        && freshOver(failed, source);
      // a FORCED item is a re-ask (↻): a verdict it finds was written after the press, by a run already in flight
      if (!existsSync(src) || (refused && !force)) continue;
      // store shadows are content-addressed (existing = done forever); a library file's variant built from another
      // version of its source rebuilds (it may change while its item waits)
      if (!force && existsSync(dest) && freshOver(dest, source)) { undefer(dest); continue; }   // done elsewhere: a stale .deferred must not outlive the variant
      // the identity of what this pass reads, taken BEFORE it runs: a source rewritten mid-pass must not be recorded as
      // the one the output was built from
      const srcId = source ? diskIdentity(source) : null;
      // budget gate (config.ts OPT_MEM_BUDGET_MB): deferred, not failed, and the queue keeps going
      const estMB = Math.ceil(Bun.file(src).size * OPT_COST_FACTOR / 1_000_000);
      if (OPT_MEM_BUDGET_MB && estMB > OPT_MEM_BUDGET_MB) { defer(dest, `estimated ${estMB}MB > budget ${OPT_MEM_BUDGET_MB}MB`); continue; }
      mkdirSync(dirname(dest), { recursive: true });
      // process.execPath = the running bun binary (PATH under systemd has no bun). Under a budget the child runs beneath sh's
      // `ulimit -d` (KB; RLIMIT_DATA, not RLIMIT_AS: bun reserves far more address space than it touches), so an encode that
      // outgrows it dies as the child. The wrapper's own failures (126, 127) never read as a content verdict.
      const capped = OPT_MEM_BUDGET_MB > 0 && process.platform === "linux";
      // OPT_CMD: a harness may own the child (test/server/optimize-pump-test.ts) — the real optimizer otherwise (logged at boot)
      // a .js/.ts OPT_CMD runs under this bun: a shebang script is no executable on Windows (EFTYPE)
      const opt = process.env.OPT_CMD, viaBun = !!opt && /\.(m?js|ts)$/.test(opt);
      const cmd = [...(opt && !viaBun ? [opt] : [process.execPath, "run", opt || join(ROOT, "server", "optimize.ts")]), ...(mode ? [mode] : []), src, dest];
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        // /bin/sh by absolute path: PATH may hold no shell (a harness's fake encoder), and a spawn that can't start
        // throws here, synchronously
        proc = Bun.spawn(capped
          ? ["/bin/sh", "-c", 'ulimit -d "$0" || exit 126; exec "$@"', String(OPT_MEM_BUDGET_MB * 1024), ...cmd]
          : cmd, { stdout: "pipe", stderr: "pipe" });
      } catch (e) {
        console.error(`[optimize] cannot spawn the optimizer (${String(e).split("\n")[0]}) — nothing marked; set OPT_MEM_BUDGET_MB=0 if /bin/sh is the problem`);
        optQueue.length = 0; break;
      }
      // never wait forever on a child: one that never answers is killed and deferred (test/server/optimize-pump-test.ts 6b)
      const stderr = drain(proc.stderr as ReadableStream<Uint8Array>), limitMs = optChildTimeoutMs();
      let timedOut = false;
      const killer = limitMs > 0 ? setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, limitMs) : null;
      const code = await proc.exited; if (killer) clearTimeout(killer);
      if (timedOut) { await stderr(STDERR_GRACE_MS); defer(dest, `no answer in ${Math.round(limitMs / 1000)}s — killed (OPT_CHILD_TIMEOUT_MS)`); continue; }
      // what a new variant was built FROM (freshOver), recorded the moment the child is gone — before anything else
      // is awaited: until then the new bytes sit beside the previous build's sidecar and read stale (the safe
      // direction: provisional, never old bytes answered as fresh). A store original's needs none.
      if (code === 0 && existsSync(dest)) {
        if (srcId) try { writeFileSync(sourceSidecar(dest), JSON.stringify(srcId)); } catch { /* best effort: reads stale until rebuilt */ }
        else if (existsSync(sourceSidecar(dest))) try { rmSync(sourceSidecar(dest)); } catch { /* best effort */ }
      }
      const err = (await stderr(STDERR_GRACE_MS)).trim();
      if (capped && (code === 126 || code === 127)) {
        // environmental, like a missing dep: no marker, and no point grinding on
        console.error(`[optimize] cap wrapper failed (exit ${code}: ${err.split("\n").pop() || "sh"}) — set OPT_MEM_BUDGET_MB within this process's hard RLIMIT_DATA, or 0`);
        optQueue.length = 0; break;
      }
      if (capped && (proc.signalCode || code >= 128)) {
        // OOM under the cap and a crash on a corrupt file look the same here: both retried next boot
        defer(dest, `child died (${proc.signalCode ?? `exit ${code}`}) under the ${OPT_MEM_BUDGET_MB}MB cap`);
        continue;
      }
      if (code === 0) {
        undefer(dest);
        // a verdict that was re-measured and answered differently is history
        if (existsSync(failed)) try { rmSync(failed); } catch { /* best effort */ }
        if (mode === "--lod") pruneOldLodGenerations(src, dest);
        const ratio = (Bun.file(src).size / Math.max(1, Bun.file(dest).size)).toFixed(1);
        console.log(mode ? `[ktx2] ${base} → ${basename(dest)} (${ratio}x)` : `[store] optimized ${base} (${ratio}x)`);
      } else if (code === 2) {
        // not suitable (bigger than source, non-POT dims, …): marked with a verdict RECORD (store-variants.ts
        // verdictMarker) so the sweep stops re-measuring; for --lod it is read at serve time too (lodVerdictFinal)
        writeFileSync(failed, verdictMarker(err, 2, srcId)); undefer(dest);
        // a variant built from OTHER content than this refusal measured would otherwise serve the old model's bytes
        // forever; one from the same identity still serves (store-variants.ts classifyVariant). With no recorded
        // identity: removed only if strictly older than its source.
        try {
          if (srcId && existsSync(dest)) {
            const rec = recordedSource(dest, (p) => readFileSync(p, "utf8"));
            if (rec ? !sameIdentity(rec, srcId) : statSync(dest).mtimeMs < srcId.mtimeMs) {
              rmSync(dest); try { rmSync(sourceSidecar(dest)); } catch { /* none */ }
              console.log(`[${mode ? "ktx2" : "store"}] ${base} — removed ${basename(dest)}: built from another version of its source, and the re-measure refused`);
            }
          }
        } catch { /* best effort (the source may have vanished mid-run) */ }
        if (mode === "--lod") pruneOldLodGenerations(src, dest);
        console.log(mode ? `[ktx2] ${base} — no variant (${readVerdict(err).kind}: ${readVerdict(err).reason})`
          : `[store] ${base} already lean — serving original`);
      } else if (code === 4) {
        // output failed its own container check (the pass corrupted its images): ENVIRONMENTAL, like code 3: no
        // marker, loud, retried
        console.error(`[${mode ? "ktx2" : "store"}] ${base} REFUSED — optimized output failed its image check, `
          + `serving the original: ${err.split("\n").filter((l) => l.includes("declares")).join(" | ") || err.split("\n").pop()}`);
      } else if (code === 3 && mode === "--lod") {
        // a TEXTURED object met a box with no encoder: per-file, so no global skip (untextured objects keep reducing)
        if (!lodEncoderWarned) { console.log("[lod] no KTX2 encoder — textured objects keep their originals until one lands (docs/operator/KTX2-ENCODER.md)"); lodEncoderWarned = true; }
      } else if (code === 3 && mode) {
        // no KTX2 encoder on this box: ENVIRONMENTAL, never a .failed marker; the rest of the variant queue is dropped
        console.log("[ktx2] no encoder — set KTX2_TOKTX or put toktx/ktx on PATH (docs/operator/KTX2-ENCODER.md); variants skipped this boot");
        ktx2Skip = true;
        for (let i = optQueue.length - 1; i >= 0; i--) if (optQueue[i].mode && optQueue[i].mode !== "--lod") optQueue.splice(i, 1);
      } else if (code === 5 && mode) {
        // partial conversion: the CLI refused a variant whose name would lie about its contents. ENVIRONMENTAL (no
        // marker, retried next boot), and no ktx2Skip: the encoder is there
        console.error(`[ktx2] ${base} REFUSED — partial conversion, serving the original: ${err.split("\n").pop() ?? `exit ${code}`}`);
      } else {
        // environmental failures (deps not installed yet) never mark the file: only content failures stick
        const envFail = /cannot find module|cannot resolve|error: script not found/i.test(err);
        if (!envFail) { writeFileSync(failed, verdictMarker(err, code, srcId)); undefer(dest); }   // kind "failure": never final
        console.error(`[${mode ? "ktx2" : "store"}] optimize ${envFail ? "unavailable (deps?)" : `FAILED ${base}`}: ${err.split("\n")[0] || `exit ${code}`}`);
        if (envFail) { optQueue.length = 0; break; } // no point grinding the rest
      }
    }
  } finally { optRunning = false; done(); }
}
/** The store's boot sweep: every original missing a shadow is queued (deferred so boot serves worlds first;
 *  SKIP_OPT_SWEEP in config.ts). Named so a harness can drive it. */
export function sweepStore() {
  if (SKIP_OPT_SWEEP) return;
  const dir = join(OPT_DIR, "store");
  if (!existsSync(dir)) return;
  // isStoreOriginal, not endsWith(".glb"): variants live here and end in .glb too. The pump skips a shadow that already exists.
  const pending = readdirSync(dir).filter((f) => {
    if (!isStoreOriginal(f)) return false;
    const m = storeShadowsMissing(join(dir, f), STORE_MIN);
    return m.min || m.ktx2 || m.lod;
  });
  if (!pending.length) return;
  console.log(`[store] boot sweep: ${pending.length} upload(s) missing a shadow queued`);
  for (const f of pending) queueOptimize(join(dir, f));
}
setTimeout(sweepStore, 5000).unref?.();   // a harness that imports this must not be held open by the timer
/** The library sweep: variants at OPT_DIR/<rel>.ktx2.glb / .ktx2.vrm / .ktx2 and LODs, served only on ?ktx2=<key> (routes.ts,
 *  shared/ktx2.js). Path-preserving (basenames collide across library rels), through the same serial pump. VRMs get --ktx2-vrm
 *  only (textures swapped, the rest byte-preserved). Avatars come from the overlay first, then the library, as serving does. */
export function sweepLibrary() {
  if (SKIP_OPT_SWEEP) return;
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
      // never re-encode an encode: a variant (<rel>.ktx2.vrm) ends in its source's ext too
      if (e.name.endsWith(`.ktx2${ext}`)) continue;
      const rel = relative(base, p);
      // keyed by (mode, rel): the ktx2 and lod walks cover the SAME rels; overlay-shadows-library holds per mode
      if (seen.has(`${mode}:${rel}`)) continue;
      seen.add(`${mode}:${rel}`);
      // a GLB/VRM variant is itself a container (<rel>.ktx2.glb); a loose image's IS the ktx2 (<rel>.ktx2)
      const dest = join(OPT_DIR, mode === "--ktx2-img" ? `${rel}.ktx2` : mode === "--lod" ? lodVariantPath(rel) : `${rel}.ktx2${ext}`);
      // a standing verdict skips, if it is about THIS version of the source (freshOver)
      if (existsSync(`${dest}.failed`) && verdictStands(readFileSync(`${dest}.failed`, "utf8"), mode === "--lod" ? LOD_RECIPE : KTX2_RECIPE)
        && freshOver(`${dest}.failed`, p)) continue;
      // identity, not mere existence: library files are mutable
      if (existsSync(dest) && freshOver(dest, p)) continue;
      // already waiting (a ↻ press, or an earlier sweep): a second copy would run the same encode twice
      if (optQueue.some((q) => q.src === p && q.mode === mode)) continue;
      items.push({ src: p, dest, mode });
    }
  };
  walk(LIBRARY_DIR, join(LIBRARY_DIR, "eidoverse", "assets", "models"), [".glb"], "--ktx2");
  // the LOD sweep walks the same models (the CLI's structural exclusion is the body gate)
  walk(LIBRARY_DIR, join(LIBRARY_DIR, "eidoverse", "assets", "models"), [".glb"], "--lod");
  // overlay first (it wins in routes.ts serving and the /avatars roster)
  walk(OPT_DIR, join(OPT_DIR, "eidoverse", "assets", "vrms"), [".vrm"], "--ktx2-vrm");
  walk(LIBRARY_DIR, join(LIBRARY_DIR, "eidoverse", "assets", "vrms"), [".vrm"], "--ktx2-vrm");
  // loose toolkit images: curated dirs only. --ktx2-img pre-bakes the vertical flip their loader applies; anywhere else
  // (thumbnails, uploads) a pre-flipped variant would be mirrored
  walk(LIBRARY_DIR, join(LIBRARY_DIR, "eidoverse", "assets", "grass"), [".png"], "--ktx2-img");
  walk(LIBRARY_DIR, join(LIBRARY_DIR, "eidoverse", "assets", "sky"), [".png", ".jpg", ".jpeg"], "--ktx2-img");
  walk(LIBRARY_DIR, join(LIBRARY_DIR, "eidoverse", "assets", "particle_textures"), [".png"], "--ktx2-img");
  if (!items.length) return;
  console.log(`[ktx2] boot sweep: ${items.length} library asset(s) queued for variants`);
  optQueue.push(...items);
  pumpOptimize();
}
setTimeout(sweepLibrary, 15_000).unref?.();

// ---- the endpoint -----------------------------------------------------------

/** Which image container these bytes are, by magic — the three the picture
 *  allow-list admits. `null` for anything else (a GLB, a script, a renamed
 *  GIF): the name someone typed is not evidence. */
export function sniffImage(b: Uint8Array): "png" | "jpg" | "webp" | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  return null;
}

/** The most pixels an uploaded image may have on a side. */
export const MAX_IMAGE_PX = 8192;
/** Why an upload's image is refused for its size: past MAX_IMAGE_PX on a side, or a size its header doesn't give: the cap
 *  holds only if every image's size is known. */
export function imageSizeRefusal(b: Uint8Array, kind: "png" | "jpg" | "webp"): { status: number; why: string } | null {
  const dims = imageDims(b, kind);
  // the remedy is one any uploader can take, human or agent
  if (!dims) return { status: 415, why: `this ${kind === "jpg" ? "JPEG" : kind.toUpperCase()}'s header doesn't say its pixel size, so it can't be checked against the ${MAX_IMAGE_PX}-px cap; sending these bytes again won't change that. Upload a copy whose header gives its size: any encoder writes one (a PNG always has it), so re-encode it with whatever made it, or a library such as sharp or Pillow` };
  if (Math.max(dims[0], dims[1]) > MAX_IMAGE_PX) return { status: 413, why: `image is ${dims[0]}×${dims[1]} px; at most ${MAX_IMAGE_PX} on a side (viewers draw it at 2048)` };
  return null;
}
/** An image's pixel size from its header (PNG IHDR, JPEG SOFn, WebP VP8/VP8L/VP8X), or null when it can't be read. A zero
 *  on either side (a 0×0 WebP, a JPEG whose SOF defers its height) is no size either. */
export function imageDims(b: Uint8Array, kind: "png" | "jpg" | "webp"): [number, number] | null {
  const d = headerDims(b, kind);
  return d && d[0] > 0 && d[1] > 0 ? d : null;
}
function headerDims(b: Uint8Array, kind: "png" | "jpg" | "webp"): [number, number] | null {
  const u16 = (i: number) => (b[i] << 8) | b[i + 1], u32 = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const le16 = (i: number) => b[i] | (b[i + 1] << 8), le24 = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  try {
    if (kind === "png") return b.length >= 24 ? [u32(16), u32(20)] : null;
    if (kind === "jpg") { let i = 2; while (i + 9 < b.length) { if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [u16(i + 7), u16(i + 5)];
        if (m === 0xff) { i++; continue; }   // a fill byte (any number may pad a marker): the marker is the byte after the last
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; } i += 2 + u16(i + 2); } return null; }
    if (kind === "webp" && b.length >= 30) { const c = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (c === "VP8X") return [1 + le24(24), 1 + le24(27)];
      if (c === "VP8 ") return [le16(26) & 0x3fff, le16(28) & 0x3fff];
      if (c === "VP8L") { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return [1 + (v & 0x3fff), 1 + ((v >> 14) & 0x3fff)]; } }
  } catch { /* unreadable */ }
  return null;
}
/** Which audio container these bytes are, by magic — the five the sound
 *  allow-list admits. `null` for anything else: the name is not evidence. */
export function sniffAudio(b: Uint8Array): "mp3" | "ogg" | "wav" | "webm" | "m4a" | null {
  const tag = (off: number, s: string) => b.length >= off + s.length && [...s].every((ch, i) => b[off + i] === ch.charCodeAt(0));
  if (tag(0, "ID3")) return "mp3";
  if (b.length >= 3 && b[0] === 0xff && (b[1] & 0xe6) === 0xe2 && (b[2] & 0xf0) !== 0xf0) return "mp3";   // MPEG frame sync, layer bits set, valid bitrate
  if (tag(0, "OggS")) return "ogg";
  if (tag(0, "RIFF") && tag(8, "WAVE")) return "wav";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
  if (tag(4, "ftyp")) return "m4a";
  return null;
}


/** The 415 for main's `/upload?as=script`: a script is the world authority's `upload {text}` request now. */
export const SCRIPT_MOVED = "not stored: /upload?as=script went with the old protocol. Send the source as the world's upload {text} request (an agent: act {verb: \"upload\", args: {text}}); its reply's src goes in set {id, component: \"script:<name>\", value: {src, …}} (docs/guide/SCRIPTS.md)";

// ?token= is deprecated (tokens in URLs land in access logs; RFC 9745 Deprecation header). Removal waits on Orrery moving to the header
const warnedQuery = new Set<string>();
// A body is read whole into memory (about three times its size at peak: the chunks, their concatenation, the copy
// handed on), so what is being read AT ONCE is bounded too: two caps' worth. Past that an upload is asked to come back;
// one alone always proceeds. A body that states no length counts as a whole cap.
let inFlight = 0;
export async function handleUpload(req: Request, url: URL, srv: UploadSrv): Promise<Response> {
  const stated = Number(req.headers.get("content-length")), holds = stated > 0 ? Math.min(stated, UPLOAD_CAP) : UPLOAD_CAP;
  if (inFlight > 0 && inFlight + holds > 2 * UPLOAD_CAP)
    return new Response("busy: other uploads are being read; try again in a few seconds", { status: 503, headers: { "retry-after": "5" } });
  inFlight += holds;
  let r: Response;
  try { r = await uploadBy(req, url, srv); } finally { inFlight -= holds; }
  if (url.searchParams.has("token") && !bearerOf(req)) {
    const ip = addressOf(req, srv);
    if (!warnedQuery.has(ip) && warnedQuery.size < 1024) { warnedQuery.add(ip); console.warn(`[upload] ?token= is deprecated; send Authorization: Bearer (from ${ip})`); }
    try { r.headers.set("Deprecation", "@1793664000"); } catch { /* an immutable response keeps its headers */ }
  }
  return r;
}
async function uploadBy(req: Request, url: URL, srv: UploadSrv): Promise<Response> {
  // the key by Authorization: Bearer (RFC 6750, as the read door takes it); ?token= still works for older clients
  const upTok = bearerOf(req) || (url.searchParams.get("token") ?? "");
  // Who the request proves, asked before the body read and again after it (a door with JOIN_TOKEN; an open server takes
  // uploads from anyone): the credential the upload stands on must still hold. `ids` lists every credential that holds,
  // the one it stands on first (person, then agent, then the door key: upBy's order).
  const who = () => {
    const key = !!JOIN_TOKEN && upTok === JOIN_TOKEN;
    // an enrolled bearer (the door key too, when it is enrolled), or the aid1 leg the join door has (guests enrolled via
    // archipelago-home carry no tokens.json entry; no jti burn: reusable until expiry)
    const agent = agentTokens().byToken.get(upTok) ?? aid1JoinIdentity(upTok)?.slug;
    // ...and the people who signed in through the home node: they carry a session cookie, not a door key (the join door
    // takes the same cookie), a native client's too; never from another site's page (auth.ts sessionOfRequest).
    // Embodied access (worlds:join), what the join door asks of a login that is not spectating.
    const s = sessionOfRequest(req), person = s && s.scopes.includes("worlds:join") ? s : null;
    const ids = [person && `person:${person.sub}`, agent && `agent:${agent}`, key && "key"].filter((x): x is string => !!x);
    return { ids, agent, person: person?.name ?? null };
  };
  const first = who(), upAgent = first.agent, upPerson = first.person, stoodOn = first.ids[0];
  if (JOIN_TOKEN && !stoodOn)
    return new Response("sign in, or bring the door key (token required)", { status: 401 });
  // a signed-in person is who the session says, whatever ?by= claims
  const upBy = (upPerson ?? url.searchParams.get("by") ?? upAgent ?? "?").slice(0, 64);
  // The window is the uploader's. An identity when the upload proves one: the agent tool server posts every agent's
  // upload from its own address, so a window per address would be one window for all of them. Else the client's address
  // (X-Real-IP only from a trusted proxy: server/peer.ts).
  // …and the door key is nobody's identity even when it is also enrolled as an agent's bearer: everyone holds it
  // An address is keyed as its limiters key it (an IPv6 host holds a whole /64: clientlog.ts ipBucketKey).
  const uploader = stoodOn && stoodOn !== "key" && !(JOIN_TOKEN && upTok === JOIN_TOKEN) ? stoodOn : `address:${ipBucketKey(addressOf(req, srv))}`;
  pruneWindows(Date.now());
  const u = uploadWin.get(uploader) ?? { t: 0, n: 0 };
  if (Date.now() - u.t >= 60_000) { u.t = Date.now(); u.n = 0; }
  u.n++; uploadWin.set(uploader, u);
  if (u.n > UPLOADS_PER_MINUTE) {
    const wait = Math.max(1, Math.ceil((60_000 - (Date.now() - u.t)) / 1000));
    return new Response(`upload rate limit (${UPLOADS_PER_MINUTE} uploads a minute); try again in ${wait}s`, { status: 429, headers: { "retry-after": String(wait) } });
  }
  // the disk's floor, then the uploader's bytes for the day (the stated length now; what was read once it is). The day is
  // charged only for bytes stored (charge, below)
  const stated = Math.max(0, Math.min(Number(req.headers.get("content-length")) || 0, UPLOAD_CAP));
  if (diskNearlyFull(stated)) return new Response("the server's disk is nearly full: uploads are paused (ask whoever runs this server)", { status: 507 });
  // held from the start: two first uploads at once share this one record, or the later charge would replace the earlier
  const day = uploadDay.get(uploader) ?? { t: Date.now(), bytes: 0 }; uploadDay.set(uploader, day);
  if (Date.now() - day.t >= DAY_MS) { day.t = Date.now(); day.bytes = 0; }
  const dayRefused = () => { const wait = Math.max(1, Math.ceil((DAY_MS - (Date.now() - day.t)) / 1000));
    return new Response(`upload limit (${Math.round(uploadBudget.perDayBytes / 1e6)} MB a day) reached; try again in ${Math.ceil(wait / 3600)}h`, { status: 429, headers: { "retry-after": String(wait) } }); };
  if (uploadBudget.perDayBytes > 0 && day.bytes + stated > uploadBudget.perDayBytes) return dayRefused();
  const body = await readCappedBytes(req, UPLOAD_CAP);
  if (body === null) return new Response(`too large (${UPLOAD_CAP / 1e6}MB cap)`, { status: 413 });
  if (uploadBudget.perDayBytes > 0 && day.bytes + body.length > uploadBudget.perDayBytes) return dayRefused();
  // charged only for what is stored: a refusal, and bytes the store already holds (content-addressed), cost the day nothing
  const charge = () => { day.bytes += body.length; uploadDay.set(uploader, day); };
  if (JOIN_TOKEN && !who().ids.includes(stoodOn!))
    return new Response(stoodOn!.startsWith("person:")
      ? "not stored: your sign-in ended while the upload was read (sign in again and resend)"
      : "not stored: the bearer this upload came with could not be confirmed after the read (revoked, expired, or the registry unreadable); renew it and resend", { status: 401 });
  // main's script store left with the old protocol: say where a script goes now
  if (url.searchParams.get("as") === "script") return new Response(SCRIPT_MOVED, { status: 415 });
  if (url.searchParams.get("as") === "image") {
    // Pictures: PNG, JPEG or WebP, content-addressed into store/images/<hash>.<ext>, no optimize pass. The kind is
    // read from the BYTES (the extension is what /library and the picture allow-list key on).
    if (body.length > IMAGE_CAP) return new Response(`image too large (${IMAGE_CAP / 1e6}MB cap)`, { status: 413 });
    const kind = sniffImage(body);
    if (!kind) return new Response("not a PNG, JPEG or WebP image (judged by content, not by name)", { status: 415 });
    // a decompression bomb (a tiny file that decodes to 16k × 16k) is refused before any viewer decodes it
    { const no = imageSizeRefusal(body, kind); if (no) return new Response(no.why, { status: no.status }); }
    const ihash = sha256Bytes(body).slice(0, 16);
    const idir = join(OPT_DIR, "store", "images");
    mkdirSync(idir, { recursive: true });
    const irel = `store/images/${ihash}.${kind}`;
    if (!existsSync(join(OPT_DIR, irel))) { writeFileSync(join(OPT_DIR, irel), body); charge(); }
    // the human name lives only here, same as models: content-addressed
    // means the catalog would otherwise know this picture as a hash
    const iname = (url.searchParams.get("name") ?? "").replace(/\.[a-z0-9]+$/i, "").replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 64).trim();
    {
      // first arrival is the provenance (who, when, what name); a later upload only fills a missing name
      const mp = join(idir, "manifest.json");
      let man: Record<string, { name?: string; by: string; ts: number }> = {};
      try { if (existsSync(mp)) man = JSON.parse(readFileSync(mp, "utf8")); } catch { /* fresh */ }
      const prev = man[ihash];
      if (!prev) man[ihash] = { ...(iname ? { name: iname } : {}), by: upBy, ts: Date.now() };
      else if (!prev.name && iname) prev.name = iname;
      atomicWrite(mp, JSON.stringify(man));
    }
    console.log(`[upload] image ${irel}${iname ? ` ("${iname}")` : ""} (${(body.length / 1e3).toFixed(0)}KB) by ${upBy}`);
    return new Response(JSON.stringify({ path: irel }), { headers: { "content-type": "application/json" } });
  }
  if (url.searchParams.get("as") === "heightmap") {
    // Terrain as an image (server/heightmap.ts): a grayscale PNG, decoded HERE once into the integer grid
    // the client, agents and sim all read. Content-addressed like everything in the store; what changes a
    // WORLD is still the owner's `terrain` verb naming the grid.
    if (body.length > IMAGE_CAP) return new Response(`heightmap too large (${IMAGE_CAP / 1e6}MB cap)`, { status: 413 });
    if (sniffImage(body) !== "png") return new Response("a heightmap must be a PNG (16-bit grayscale is best)", { status: 415 });
    const hhash = sha256Bytes(body).slice(0, 16);
    const hfresh = !existsSync(join(OPT_DIR, "store", "heightmaps", `${hhash}.png`));   // heightmap.ts's own path for these bytes
    const r = ingestHeightmap(body, hhash);
    if ("error" in r) return new Response(r.error, { status: r.status });
    if (hfresh) charge();
    console.log(`[upload] heightmap ${r.grid} (${r.w}×${r.h}, ${r.bits}-bit) by ${upBy}`);
    return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
  }
  if (url.searchParams.get("as") === "audio") {
    // Sound: MP3, Ogg, WAV, WebM or M4A, content-addressed into store/audio/<hash>.<ext>, no transcode; kind from the
    // BYTES (the sound allow-list keys on the extension)
    const kind = sniffAudio(body);
    if (!kind) return new Response("not an MP3, Ogg, WAV, WebM or M4A audio file (judged by content, not by name)", { status: 415 });
    const ahash = sha256Bytes(body).slice(0, 16);
    const adir = join(OPT_DIR, "store", "audio");
    mkdirSync(adir, { recursive: true });
    const arel = `store/audio/${ahash}.${kind}`;
    if (!existsSync(join(OPT_DIR, arel))) { writeFileSync(join(OPT_DIR, arel), body); charge(); }
    const aname = (url.searchParams.get("name") ?? "").replace(/\.[a-z0-9]+$/i, "").replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 64).trim();
    {
      // first arrival is the provenance; a later upload only fills a missing name
      const mp = join(adir, "manifest.json");
      let man: Record<string, { name?: string; by: string; ts: number }> = {};
      try { if (existsSync(mp)) man = JSON.parse(readFileSync(mp, "utf8")); } catch { /* fresh */ }
      const prev = man[ahash];
      if (!prev) man[ahash] = { ...(aname ? { name: aname } : {}), by: upBy, ts: Date.now() };
      else if (!prev.name && aname) prev.name = aname;
      atomicWrite(mp, JSON.stringify(man));
    }
    console.log(`[upload] audio ${arel}${aname ? ` ("${aname}")` : ""} (${(body.length / 1e6).toFixed(1)}MB) by ${upBy}`);
    return new Response(JSON.stringify({ path: arel }), { headers: { "content-type": "application/json" } });
  }
  if (body.length < 12 || new DataView(body.buffer).getUint32(0, true) !== 0x46546c67)
    return new Response("not a GLB container (glb/vrm)", { status: 415 });
  if (url.searchParams.get("as") === "avatar") {
    const raw = url.searchParams.get("name") ?? "unnamed";
    const name = raw.replace(/\.vrm$/i, "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "unnamed";
    // a patch outranks OPT_DIR on /library, so this upload would never be served (#325)
    if (existsSync(join(PATCH_DIR, "eidoverse/assets/vrms", `${name}.vrm`)))
      return new Response(`"${name}" is a patched body: patched/ wins over uploads, so this one would never be served. Upload it under another name.`, { status: 409 });
    // a def that claims the name (and resolves) outranks every scanned file on the roster: the same never-served case
    const def = avatarDefs()[name]?.vrm;
    if (def && resolveLibFile(def))
      return new Response(`"${name}" is declared by a def (defs/avatars/${name}.json → ${def}), which wins over uploads, so this one would never be served. Upload it under another name.`, { status: 409 });
    const dir = join(OPT_DIR, "eidoverse/assets/vrms");
    mkdirSync(dir, { recursive: true });
    // A RAW TRIPO RIG (no VRM extension + the Tripo bone names) runs the import pipeline instead of being saved as-is
    // (proxy hulls, dropped textures, no humanoid map). In a SUBPROCESS, one at a time; its PASS/FAIL exit is the gate:
    // a body that can't settle a fall under both engines never enters the roster.
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
        // process.execPath, never "bun" (docs/history/INCIDENTS.md, the Windows shim)
        const spawnArgs = [process.execPath, "run", join(ROOT, "tools/assets/import-tripo-avatar.ts"),
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
        charge();
        console.log(`[upload] tripo→vrm "${name}" imported by ${upBy}\n${log.split("\n").slice(-8).join("\n")}`);
      } finally { tripoImportBusy = false; }
    } else {
      writeFileSync(join(dir, `${name}.vrm`), body); charge();
      console.log(`[upload] avatar "${name}" (${(body.length / 1e6).toFixed(1)}MB) by ${upBy}`);
    }
    // avatars are name-keyed and mutable: every connected client learns the file changed, and wearers hot-swap
    const rel = `eidoverse/assets/vrms/${name}.vrm`;
    const update = JSON.stringify({ type: "avatar-updated", name, path: rel, v: Date.now() });
    let notified = 0;
    for (const w of worlds.values()) for (const c of w.clients) { c.ws.send(update); notified++; }
    if (notified) console.log(`[upload] avatar-updated "${name}" → ${notified} client(s)`);
    return new Response(JSON.stringify({ name, path: rel }),
      { headers: { "content-type": "application/json" } });
  }
  const hash = sha256Bytes(body).slice(0, 16);
  const dir = join(OPT_DIR, "store");
  mkdirSync(dir, { recursive: true });
  const rel = `store/${hash}.glb`;
  const fresh = !existsSync(join(OPT_DIR, rel));   // new to the store: only then can this upload decide it is a one-off
  if (fresh) { writeFileSync(join(OPT_DIR, rel), body); charge(); }
  queueOptimize(join(OPT_DIR, rel)); // draco+webp shadow, built off the request path
  // content-addressed: the human name arrives ONLY here, so record it (or the catalog lists a hash)
  const upName = (url.searchParams.get("name") ?? "").replace(/\.glb$/i, "").replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 64).trim();
  // ?catalog=0: a one-off, made for one place and not meant to be reused. It is stored, served, optimized and checked like
  // any model, and placed by its path; the catalog (/library-models, the authority's find) leaves it out. Listing wins:
  // the same bytes uploaded for the catalog are listed from then on, and a one-off upload of bytes already in the store
  // and listed leaves them listed (a file with no manifest entry is listed: every model stored before this was).
  const forCatalog = !/^(0|false|no)$/i.test(url.searchParams.get("catalog") ?? "");
  let listed = forCatalog;
  {
    const mp = join(dir, "manifest.json");
    let man: Record<string, { name?: string; by: string; ts: number; catalog?: false }> = {};
    try { if (existsSync(mp)) man = JSON.parse(readFileSync(mp, "utf8")); } catch { /* fresh */ }
    const prev = man[hash];
    if (forCatalog) man[hash] = { ...(upName ? { name: upName } : prev?.name ? { name: prev.name } : {}), by: upBy, ts: Date.now() };   // an unnamed re-upload keeps the name it had
    else if (fresh) man[hash] = { ...(upName ? { name: upName } : {}), by: upBy, ts: Date.now(), catalog: false };
    else { listed = prev?.catalog !== false; if (prev && !prev.name && upName) prev.name = upName; }   // as it was; a name it lacked is taken
    atomicWrite(mp, JSON.stringify(man));
  }
  console.log(`[upload] model ${rel}${upName ? ` ("${upName}")` : ""}${listed ? "" : " (a one-off: not in the catalog)"} (${(body.length / 1e6).toFixed(1)}MB) by ${upBy}`);
  // the build check starts now and never holds the upload up or refuses it:
  // its report is advice, waiting at `check` (server/buildcheck.ts)
  void checkFile(join(OPT_DIR, rel), 1, body).catch((err) => console.warn(`[check] ${rel}: ${String(err?.message ?? err)}`));
  return new Response(JSON.stringify({ path: rel, check: `/check?lib=${encodeURIComponent(rel)}`, catalog: listed }), { headers: { "content-type": "application/json" } });
}
