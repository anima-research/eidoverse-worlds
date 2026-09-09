// bun tools/optimize-pump-test.ts — the optimizer pump with a FAKE child (OPT_CMD): estimate defer with queue
// continuation, success (+ stale .deferred retired), 'not smaller' marker, capped child death → .deferred and
// retried, wrapper 126 → environmental (no marker, queue dropped), stale-marker retirement when the variant
// exists already, and both boot sweeps skipped under SKIP_OPT_SWEEP (subprocess). Each case owns its store.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const ok = (v: unknown, why: string) => { if (!v) { console.error("FAIL", why); process.exit(1); } };
const root = mkdtempSync(join(tmpdir(), "optpump-"));
const fake = join(root, "fake-optimizer.sh");
// the fake child reads its verdict from a file beside the source: "0" writes dest, "2" exits 2, "sig" dies by SIGSEGV
writeFileSync(fake, `#!/bin/sh
src=""; dest=""
for a in "$@"; do case "$a" in --*) ;; *) if [ -z "$src" ]; then src="$a"; else dest="$a"; fi;; esac; done
v=$(cat "$src.verdict" 2>/dev/null || echo 0)
[ -n "$OPT_RECEIPTS" ] && echo "$dest" >> "$OPT_RECEIPTS"   # every invocation leaves a receipt the harness can count
case "$v" in
  0) mkdir -p "$(dirname "$dest")"; printf 'tiny' > "$dest"; exit 0;;
  sig) kill -SEGV $$;;
  *) echo "fake verdict $v" >&2; exit "$v";;
esac
`); chmodSync(fake, 0o755);
process.env.SKIP_OPT_SWEEP = "1";   // the parent's own boot timers must not sweep the real library through the fake
process.env.WORLDS_DIR = join(root, "worlds"); process.env.OPT_DIR = join(root, "opt"); process.env.JOIN_TOKEN = "t"; process.env.OPT_CMD = fake;   // OPT_DIR: NEVER the checkout's store
process.env.OPT_MEM_BUDGET_MB = "10"; process.env.OPT_COST_FACTOR = "1"; process.env.KTX2_TOKTX = "";
const { queueOptimize, optIdle } = await import("../server/upload.ts");
const { STORE_MIN } = await import("../server/config.ts");
const src = (name: string, bytes: number, verdict: string) => {
  const dir = join(root, "src"); mkdirSync(dir, { recursive: true });
  const p = join(dir, name); writeFileSync(p, Buffer.alloc(bytes, 1)); writeFileSync(p + ".verdict", verdict); return p;
};
const storeDest = (p: string) => join(STORE_MIN, p.split("/").pop()!);
// 1. estimate defer: 20 MB × factor 1 > 10 MB budget → .deferred, and the NEXT item still runs
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
// 4. a variant that exists already (done elsewhere) retires a stale .deferred without spawning
const s4 = src("s4.glb", 1000, "0"); mkdirSync(STORE_MIN, { recursive: true }); writeFileSync(storeDest(s4), "done-elsewhere"); writeFileSync(storeDest(s4) + ".deferred", "stale");
queueOptimize(s4); await optIdle();
ok(!existsSync(storeDest(s4) + ".deferred") && readFileSync(storeDest(s4), "utf8") === "done-elsewhere", "existing variant: stale .deferred retired, variant untouched");
// 5. capped child death (Linux only: the cap wrapper) → .deferred with 'child died', queue continues
if (process.platform === "linux") {
  const s5 = src("s5.glb", 1000, "sig"), s6 = src("s6.glb", 1000, "0"); queueOptimize(s5); queueOptimize(s6); await optIdle();
  ok(existsSync(storeDest(s5) + ".deferred") && /died/.test(readFileSync(storeDest(s5) + ".deferred", "utf8")), "signalled child under the cap → .deferred 'child died'");
  ok(existsSync(storeDest(s6)), "queue continued after the death");
  // 6. wrapper 126 (a hard RLIMIT_DATA below the budget) → environmental: no marker, queue dropped
  // a 1 MB HARD data limit (soft first — dash refuses to drop the hard limit below the soft one) makes the wrapper's
  // `ulimit -d 20480` fail: the 126 path. bun itself must still start under it, or the case is skipped.
  const canLimit = spawnSync("/bin/sh", ["-c", "ulimit -S -d 2000000 && ulimit -H -d 2000000 && /bin/sh -c 'ulimit -d 4000000000' 2>/dev/null; echo $?"], { encoding: "utf8" }).stdout.trim();   // a 2 GB hard limit (bun starts) that a 4 TB budget cannot raise
  if (canLimit !== "0") {
    const sh = spawnSync("/bin/sh", ["-c", `ulimit -S -d 2000000 && ulimit -H -d 2000000; exec "${process.execPath}" -e 'process.env.OPT_MEM_BUDGET_MB="4000000000"; const {queueOptimize,optIdle}=await import("./server/upload.ts"); const {STORE_MIN}=await import("./server/config.ts"); const fs=await import("node:fs"); const p=${JSON.stringify(join(root, "src", "s8.glb"))}; fs.writeFileSync(p, Buffer.alloc(1000,1)); fs.writeFileSync(p+".verdict","0"); queueOptimize(p); await optIdle(); console.log(JSON.stringify({variant:fs.existsSync(STORE_MIN+"/s8.glb"), deferred:fs.existsSync(STORE_MIN+"/s8.glb.deferred"), failed:fs.existsSync(STORE_MIN+"/s8.glb.failed")}))'`],
      { env: { ...process.env, OPT_MEM_BUDGET_MB: "4000000000" }, cwd: import.meta.dir + "/..", encoding: "utf8" });
    const line = sh.stdout.split("\n").find((l) => l.startsWith("{")) ?? "{}";   // the boot-sweep timers log after the JSON
    try { const v = JSON.parse(line); const loud = /cap wrapper failed/.test(sh.stderr + sh.stdout);
      if (v.variant || v.deferred || v.failed || !loud) console.error("126 case saw", JSON.stringify(v), "loud=" + loud, "| tail:", (sh.stderr + sh.stdout).trim().split("\n").slice(-3).join(" // ").slice(0, 400));
      ok(!v.variant && !v.deferred && !v.failed && loud, "wrapper 126: no variant, no marker, loud"); console.log("(126 case ran: wrapper refused under the hard limit, nothing marked)"); }
    catch { console.log("(126 case: bun could not start under the hard limit — skipped: " + (sh.stderr + sh.stdout).split("\n").pop() + ")"); }
  } else console.log("(126 case: cannot set a hard data limit here — skipped)");
} else console.log("(non-Linux: capped-death and 126 cases skipped)");
// 7. SKIP_OPT_SWEEP: with it set, both sweeps queue NOTHING even with a GLB planted in the store; without it,
//    the same store queues the planted GLB (the positive control). Each direction is its own subprocess: the
//    flag is a config constant read at import.
const { OPT_DIR } = await import("../server/config.ts");
mkdirSync(join(OPT_DIR, "store"), { recursive: true }); writeFileSync(join(OPT_DIR, "store", "planted.glb"), Buffer.alloc(500, 1));
const receipts = join(root, "sweep-receipts");
const sweep = (skip: boolean) => {
  const rf = join(receipts, skip ? "skip.txt" : "run.txt"); mkdirSync(receipts, { recursive: true }); writeFileSync(rf, "");
  const r = spawnSync(process.execPath, ["-e", 'const u = await import("./server/upload.ts"); u.sweepStore(); u.sweepLibrary(); await u.optIdle(); console.log(JSON.stringify(u.optStatus()))'],
    { env: { ...process.env, SKIP_OPT_SWEEP: skip ? "1" : "0", OPT_RECEIPTS: rf }, cwd: import.meta.dir + "/..", encoding: "utf8" });
  const status = JSON.parse(r.stdout.split("\n").find((l) => l.startsWith("{")) || "{}");
  const invoked = readFileSync(rf, "utf8").split("\n").filter(Boolean);
  return { status, invoked };
};
// deterministic: the subprocess awaits optIdle() and the proof is the fake child's own receipts, not a queue snapshot
const skipped = sweep(true), ran = sweep(false);
ok(skipped.invoked.length === 0 && skipped.status.queued === 0, `SKIP_OPT_SWEEP=1: the child was never invoked (${skipped.invoked.length} receipts)`);
ok(ran.invoked.some((d) => d.includes("planted.glb")), `SKIP_OPT_SWEEP unset: the planted GLB reached the child (${ran.invoked.length} receipts)`);
import("node:fs").then((fs) => fs.rmSync(root, { recursive: true, force: true }));
console.log("optimize-pump: cases passed");
