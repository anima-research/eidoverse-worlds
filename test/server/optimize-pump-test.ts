// bun test/server/optimize-pump-test.ts — the optimizer pump with a FAKE child (OPT_CMD): estimate defer with queue
// continuation, success (+ stale .deferred retired), 'not smaller' marker, child death → .deferred (its retry by a later
// boot sweep isn't driven here), the child's memory standing (no data rlimit, the kernel's first pick), stale-marker
// retirement when the variant exists already, and both boot sweeps skipped under SKIP_OPT_SWEEP (subprocess). Each case owns its store.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
const ok = (v: unknown, why: string) => { if (!v) { console.error("FAIL", why); process.exit(1); } };
const root = mkdtempSync(join(tmpdir(), "optpump-"));
const fake = join(root, "fake-optimizer.ts");   // TS, run by bun (upload.ts OPT_CMD): a #!/bin/sh fake is no executable on Windows
// the fake child reads its verdict from a file beside the source: "0" writes dest, "2" exits 2, "sig" dies by a signal
writeFileSync(fake, `import { readFileSync, appendFileSync, mkdirSync, writeFileSync, writeSync, existsSync } from "node:fs";
import { dirname } from "node:path";
const [src, dest] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
let v = "0"; try { v = readFileSync(src + ".verdict", "utf8").trim(); } catch { /* none: success */ }
if (process.env.OPT_RECEIPTS) appendFileSync(process.env.OPT_RECEIPTS, dest + "\\n");   // every invocation leaves a receipt the harness can count
if (v === "limits") {   // what it runs under (6), beside its source; then a success
  writeFileSync(src + ".limits", JSON.stringify({ data: readFileSync("/proc/self/limits", "utf8").match(/^Max data size\\s+(\\S+)/m)?.[1], oom: readFileSync("/proc/self/oom_score_adj", "utf8").trim() }));
  v = "0";
}
const err = (s: string) => writeSync(2, s + "\\n");
if (v === "sig") process.kill(process.pid, "SIGKILL");   // a signal death; SIGSEGV made bun dump core (~13 s a run). Linux-only row
if (v === "hang") { setInterval(() => {}, 1 << 30); await new Promise(() => {}); }   // never answers
if (v === "orphan" && !existsSync(src + ".orphan")) {   // first run: a grandchild keeps our stderr open past our exit
  const { spawn } = await import("node:child_process");
  const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: ["ignore", "ignore", "inherit"] }); g.unref();
  writeFileSync(src + ".orphan", String(g.pid)); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, "tiny"); process.exit(0);
} else if (v === "orphan") v = "0";
if (v === "0") { mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, "tiny"); process.exit(0); }
if (v === "long") {
  for (let i = 0; i < 30; i++) err(\`[optimize] per-texture note \${i}: no sharp to resize it — a long line padded out to well over one hundred characters of text\`);
  err("[optimize] not smaller (1.00x) recipe=texel1024 __TOOLS__"); process.exit(2);
}
err("fake verdict " + v); process.exit(Number(v));
`);
process.env.SKIP_OPT_SWEEP = "1";   // the parent's own boot timers must not sweep the real library through the fake
process.env.WORLDS_DIR = join(root, "worlds"); process.env.OPT_DIR = join(root, "opt"); process.env.JOIN_TOKEN = "t"; process.env.OPT_CMD = fake;   // OPT_DIR: NEVER the checkout's store
process.env.OPT_MEM_BUDGET_MB = "4000"; process.env.OPT_COST_FACTOR = "1000";   // the estimate gate: 4 MB of source and up is deferred
 process.env.KTX2_TOKTX = "";
// the verdict names the tools it was measured with (tools-stamp.ts) — THIS process's, the stamp the pump reads verdicts by
const { toolsStamp } = await import("../../server/tools-stamp.ts");
writeFileSync(fake, readFileSync(fake, "utf8").replace("__TOOLS__", toolsStamp()));
const { queueOptimize, optIdle } = await import("../../server/upload.ts");
const { STORE_MIN } = await import("../../server/config.ts");
const src = (name: string, bytes: number, verdict: string) => {
  const dir = join(root, "src"); mkdirSync(dir, { recursive: true });
  const p = join(dir, name); writeFileSync(p, Buffer.alloc(bytes, 1)); writeFileSync(p + ".verdict", verdict); return p;
};
const storeDest = (p: string) => join(STORE_MIN, basename(p));
// 1. estimate defer: 20 MB × factor 1000 > 4000 MB budget → .deferred, and the NEXT item still runs
const big = src("big.glb", 20_000_000, "0"), small = src("small.glb", 1000, "0");
queueOptimize(big); queueOptimize(small); await optIdle();
ok(existsSync(storeDest(big) + ".deferred") && /budget/.test(readFileSync(storeDest(big) + ".deferred", "utf8")), "over-budget item deferred with the reason");
ok(existsSync(storeDest(small)) && readFileSync(storeDest(small), "utf8") === "tiny", "queue continued: the small item after it succeeded");
// 2. success retires a stale .deferred
const s2 = src("s2.glb", 1000, "0"); writeFileSync(storeDest(s2) + ".deferred", "old");
queueOptimize(s2); await optIdle();
ok(existsSync(storeDest(s2)) && !existsSync(storeDest(s2) + ".deferred"), "success removed the stale .deferred");
// 3. exit 2 = not smaller → .failed marker, no .deferred
const s3 = src("s3.glb", 1000, "2"); queueOptimize(s3); await optIdle();
ok(existsSync(storeDest(s3) + ".failed") && !existsSync(storeDest(s3)), "exit 2 → .failed marker, no variant");
// 3b. a long stderr (per-texture notes, then the verdict LAST): the marker keeps the TAIL, so the stamped verdict stands
const { verdictStands } = await import("../../server/store-variants.ts");
const s3b = src("s3b.glb", 1000, "long"); queueOptimize(s3b); await optIdle();
const m3b = existsSync(storeDest(s3b) + ".failed") ? readFileSync(storeDest(s3b) + ".failed", "utf8") : "";
let r3b: any = null; try { r3b = JSON.parse(m3b); } catch { /* not a record */ }
ok(r3b?.kind === "size" && r3b.recipe === "texel1024" && r3b.tail.trimEnd().endsWith(`recipe=texel1024 ${toolsStamp()}`) && verdictStands(m3b), `long stderr → the marker keeps the verdict tail (${m3b.length} chars, ends: ${m3b.slice(-50)})`);
// 4. a variant that exists already (done elsewhere) retires a stale .deferred without spawning
const s4 = src("s4.glb", 1000, "0"); mkdirSync(STORE_MIN, { recursive: true }); writeFileSync(storeDest(s4), "done-elsewhere"); writeFileSync(storeDest(s4) + ".deferred", "stale");
queueOptimize(s4); await optIdle();
ok(!existsSync(storeDest(s4) + ".deferred") && readFileSync(storeDest(s4), "utf8") === "done-elsewhere", "existing variant: stale .deferred retired, variant untouched");
// 5. child death (Linux only: a signal) → .deferred with 'child died', queue continues
if (process.platform === "linux") {
  const s5 = src("s5.glb", 1000, "sig"), s6 = src("s6.glb", 1000, "0"); queueOptimize(s5); queueOptimize(s6); await optIdle();
  ok(existsSync(storeDest(s5) + ".deferred") && /died/.test(readFileSync(storeDest(s5) + ".deferred", "utf8")), "signalled child → .deferred 'child died'");
  ok(existsSync(storeDest(s6)), "queue continued after the death");
  // 6. the child's memory is capped by the unit's cgroup (MemoryMax=), not an rlimit: it runs under this process's own
  //    data limit (RLIMIT_DATA charges bun's startup reservations and turns its JIT off, docs/research/service-hardening.md),
  //    and at oom_score_adj 1000, so the kernel kills it, not the server, when the cgroup runs out
  const s7 = src("s7.glb", 1000, "limits"); queueOptimize(s7); await optIdle();
  const own = readFileSync("/proc/self/limits", "utf8").match(/^Max data size\s+(\S+)/m)?.[1];
  const seen = existsSync(s7 + ".limits") ? JSON.parse(readFileSync(s7 + ".limits", "utf8")) : {};
  ok(existsSync(storeDest(s7)) && seen.data === own, `the child runs under no data limit of the pump's (${own}; saw ${JSON.stringify(seen)})`);
  ok(seen.oom === "1000", `the child is the kernel's first pick for an OOM kill (oom_score_adj; saw ${JSON.stringify(seen)})`);
  // 6b. an encoder the kernel kills for memory (SIGKILL; the real optimizer, a fake toktx) kills the pass the same way,
  //     so row 5's rule defers it: never a .failed "failure" for what the box couldn't afford
  const killer = join(root, "toktx"); writeFileSync(killer, "#!/bin/sh\nkill -KILL $$\n"); chmodSync(killer, 0o755);
  const { PNG } = await import("pngjs"); const png = new PNG({ width: 4, height: 4 }); png.data.fill(200);
  const img = join(root, "src", "tile.png"); writeFileSync(img, PNG.sync.write(png));
  const enc = spawnSync(process.execPath, ["run", "server/optimize.ts", "--ktx2-img", img, join(root, "tile.ktx2")],
    { env: { ...process.env, KTX2_TOKTX: killer }, cwd: import.meta.dir + "/../..", encoding: "utf8" });
  ok(enc.signal === "SIGKILL", `an encoder killed by SIGKILL kills --ktx2-img the same way (saw status ${enc.status}, signal ${enc.signal}: ${(enc.stderr ?? "").trim().split("\n").pop()})`);
} else console.log("(non-Linux: child-death and oom cases skipped)");
// 6b. the pump never waits forever on a child (it would hold optIdle and every pass behind it): one that never answers is
//     killed at OPT_CHILD_TIMEOUT_MS and deferred; one whose grandchild keeps its stderr open is read up to a grace past
//     its exit; one that cannot start marks nothing. Each settles, and the item queued behind it runs.
const settles = async () => { let t: any; const r = await Promise.race([optIdle().then(() => true), new Promise<boolean>((res) => { t = setTimeout(() => res(false), 30_000); })]); clearTimeout(t); return r; };
{ process.env.OPT_CHILD_TIMEOUT_MS = "1500";
  const s9 = src("s9.glb", 1000, "hang"), s10 = src("s10.glb", 1000, "0"); queueOptimize(s9); queueOptimize(s10);
  ok(await settles(), "a child that never answers: optIdle still resolves");
  ok(existsSync(storeDest(s9) + ".deferred") && /no answer/.test(readFileSync(storeDest(s9) + ".deferred", "utf8")) && !existsSync(storeDest(s9) + ".failed"), "…it is killed and deferred (no verdict)");
  ok(existsSync(storeDest(s10)), "…and the item behind it ran");
  delete process.env.OPT_CHILD_TIMEOUT_MS; }
{ const s11 = src("s11.glb", 1000, "orphan"), s12 = src("s12.glb", 1000, "0"); queueOptimize(s11); queueOptimize(s12);
  const t0 = Date.now(), settled = await settles();
  try { process.kill(Number(readFileSync(s11 + ".orphan", "utf8"))); } catch { /* gone */ }
  ok(settled, `a child whose grandchild holds its stderr open: optIdle still resolves (${Date.now() - t0} ms)`);
  ok(existsSync(storeDest(s11)) && !existsSync(storeDest(s11) + ".failed") && existsSync(storeDest(s12)), "…its success is recorded, and the item behind it ran"); }
{ const real = process.env.OPT_CMD; process.env.OPT_CMD = join(root, "no-such-optimizer");
  const s13 = src("s13.glb", 1000, "0"); queueOptimize(s13);
  ok(await settles(), "a child that cannot start: optIdle still resolves");
  ok(!existsSync(storeDest(s13)) && !existsSync(storeDest(s13) + ".failed") && !existsSync(storeDest(s13) + ".deferred"), "…and nothing is marked");
  process.env.OPT_CMD = real; }
// 7. SKIP_OPT_SWEEP: with it set, both sweeps queue NOTHING even with a GLB planted in the store; without it,
//    the same store queues the planted GLB (the positive control). Each direction is its own subprocess: the
//    flag is a config constant read at import.
const { OPT_DIR } = await import("../../server/config.ts");
mkdirSync(join(OPT_DIR, "store"), { recursive: true }); writeFileSync(join(OPT_DIR, "store", "planted.glb"), Buffer.alloc(500, 1));
const receipts = join(root, "sweep-receipts");
const sweep = (skip: boolean) => {
  const rf = join(receipts, skip ? "skip.txt" : "run.txt"); mkdirSync(receipts, { recursive: true }); writeFileSync(rf, "");
  const r = spawnSync(process.execPath, ["-e", 'const u = await import("./server/upload.ts"); u.sweepStore(); u.sweepLibrary(); await u.optIdle(); console.log(JSON.stringify(u.optStatus()))'],
    { env: { ...process.env, SKIP_OPT_SWEEP: skip ? "1" : "0", OPT_RECEIPTS: rf }, cwd: import.meta.dir + "/../..", encoding: "utf8" });
  const status = JSON.parse(r.stdout.split("\n").find((l) => l.startsWith("{")) || "{}");
  const invoked = readFileSync(rf, "utf8").split("\n").filter(Boolean);
  return { status, invoked };
};
// deterministic: the subprocess awaits optIdle() and the proof is the fake child's own receipts, not a queue snapshot
const skipped = sweep(true), ran = sweep(false);
ok(skipped.invoked.length === 0 && skipped.status.queued === 0, `SKIP_OPT_SWEEP=1: the child was never invoked (${skipped.invoked.length} receipts)`);
ok(ran.invoked.some((d) => d.includes("planted.glb")), `SKIP_OPT_SWEEP unset: the planted GLB reached the child (${ran.invoked.length} receipts)`);
// 8. the library sweep never queues a (source, mode) that is already waiting (Greptile #207): a second sweep, or a ↻
//    rebuild pressed before the boot sweep, must not run the same encode twice. The costly case: a ↻ queues both passes
//    FORCED (one starts, one waits), then the sweep adds the same passes unforced; the pump prefers unforced items, so the
//    waiting pass ran unforced AND forced (a plain unforced duplicate is harmless: the pump skips a fresh dest).
//    One planted library model: exactly one --ktx2 and one --lod invocation for it.
{ const lib = join(root, "lib"), models = join(lib, "eidoverse", "assets", "models"); mkdirSync(models, { recursive: true });
  writeFileSync(join(models, "dup.glb"), Buffer.alloc(500, 2));
  const rf = join(receipts, "dup.txt"); writeFileSync(rf, "");
  spawnSync(process.execPath, ["-e", 'const u = await import("./server/upload.ts"); u.rebuildAsset("eidoverse/assets/models/dup.glb"); u.sweepLibrary(); await u.optIdle();'],
    { env: { ...process.env, SKIP_OPT_SWEEP: "0", OPT_RECEIPTS: rf, EIDOVERSE_DIR: lib }, cwd: import.meta.dir + "/../..", encoding: "utf8" });
  const got = readFileSync(rf, "utf8").split("\n").filter((d) => d.includes("dup.glb"));
  ok(got.length === 2, `a ↻ then the boot sweep, one model: ${got.length} encode(s) for it (want 2: one --ktx2, one --lod) ${JSON.stringify(got)}`); }
import("node:fs").then((fs) => fs.rmSync(root, { recursive: true, force: true }));
console.log("optimize-pump: cases passed");
