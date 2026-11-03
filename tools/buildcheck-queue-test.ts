// bun tools/buildcheck-queue-test.ts — the build check's queue (server/
// buildcheck-queue.ts) answers for the bytes it checked, and always gets its
// worker back:
//   - a file replaced in place — same path, same size, its mtime put back —
//     is checked again, not served the old file's report;
//   - a worker that floods stderr and then answers is heard (its stderr is
//     drained to a bounded tail: Bun buffers an unread pipe itself, so this
//     bounds the sequencer's memory rather than unblocking the child);
//   - a worker that ignores SIGTERM and never answers is killed after the
//     grace, the ask fails, the process is gone, and the next check runs;
//   - output past the cap is no report.
import { mkdtempSync, writeFileSync, readFileSync, statSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "checkq-"));
process.env.OPT_DIR = join(dir, "opt");
const Q = await import("../server/buildcheck-queue.ts");
const { boxes, buildGlb } = await import("./two-storey-fixture.ts");
const { mkCheck } = await import("./harness.ts");
const { check, tally } = mkCheck();

const real = Q.checkConfig.runner;
const worker = (name: string, body: string) => { const f = join(dir, `${name}.ts`); writeFileSync(f, body); return f; };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const outcome = (p: Promise<unknown>) => p.then((r: any) => ({ ok: true as const, r }), (e: Error) => ({ ok: false as const, e: e.message }));

try {
  console.log("the bytes, not the timestamps:");
  {
    const f = join(dir, "model.glb");
    const good = await buildGlb(boxes as any);
    writeFileSync(f, good);
    // a whole-millisecond mtime, so putting it back is exact
    const pinned = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    utimesSync(f, pinned, pinned);
    const first = await outcome(Q.checkFile(f));
    check("a model is checked", first.ok && Array.isArray((first as any).r.levels), JSON.stringify(first).slice(0, 160));
    const { atime, mtime } = statSync(f);
    // the same length, not a GLB, and the old mtime put back
    writeFileSync(f, new Uint8Array(good.length).fill(0x41));
    utimesSync(f, atime, mtime);
    check("(the replacement has the same size and mtime)", statSync(f).size === good.length && statSync(f).mtimeMs === pinned.getTime());
    const second = await outcome(Q.checkFile(f));
    check("the replaced file is checked again — and fails, rather than getting the old file's clean report", !second.ok, JSON.stringify(second).slice(0, 160));
    writeFileSync(f, good);
    const third = await outcome(Q.checkFile(f));
    check("putting the original back answers from the cache at once", third.ok && JSON.stringify((third as any).r) === JSON.stringify((first as any).r));
  }

  console.log("\nthe bytes that were asked about, not the bytes there later:");
  {
    // a worker that reports what it read, slowly enough to queue behind
    Q.checkConfig.runner = worker("seer", `await Bun.sleep(400); console.log(JSON.stringify({ seen: await Bun.file(process.argv[2]).text() }));`);
    const f = join(dir, "mutable.glb");
    writeFileSync(f, "PPPP");
    const ahead = Q.checkFile(f, 4);           // occupies the worker
    writeFileSync(f, "AAAA");
    const askA = Q.checkFile(f, 4.5);          // A is hashed now, its check waits in the queue
    await Bun.sleep(50);
    writeFileSync(f, "BBBB");                  // replaced before A's worker starts
    const [, first] = await Promise.all([outcome(ahead), outcome(askA)]);
    writeFileSync(f, "AAAA");                  // the original back
    const second = await outcome(Q.checkFile(f, 4.5));
    check("a file replaced while its check is queued: the report is of the bytes that were asked about",
      first.ok && (first as any).r.seen === "AAAA", JSON.stringify(first));
    check("...so the original's bytes, put back, get the original's report — never the replacement's",
      second.ok && (second as any).r.seen === "AAAA", JSON.stringify(second));
    Q.checkConfig.runner = real;
  }

  console.log("\nthe worker, owned to the end:");
  Q.checkConfig.timeoutMs = 1500; Q.checkConfig.graceMs = 500;
  const pidFile = join(dir, "pid");
  const f2 = join(dir, "model2.glb");
  writeFileSync(f2, await buildGlb([[-3, 0, -3, 3, 0.2, 3]] as any));
  {
    // 1MB on stderr — far past a pipe's buffer — then a report
    Q.checkConfig.runner = worker("loud", `process.stderr.write("x".repeat(1 << 20)); console.log(JSON.stringify({ loud: true, levels: [] }));`);
    const r = await outcome(Q.checkFile(f2, 1.5));
    check("a worker that floods stderr before answering is heard (its stderr is drained)", r.ok && (r as any).r.loud === true, JSON.stringify(r).slice(0, 160));
  }
  {
    Q.checkConfig.runner = worker("stuck", `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on("SIGTERM", () => {});   // won't stop when asked
process.stderr.write("y".repeat(1 << 20));
setInterval(() => {}, 1000);`);
    const t0 = performance.now();
    const r = await outcome(Q.checkFile(f2, 2.5));
    const ms = performance.now() - t0, pid = Number(readFileSync(pidFile, "utf8"));
    check("a worker that ignores SIGTERM and never answers: the ask fails as timed out, within timeout + grace",
      !r.ok && /timed out/.test((r as any).e) && ms < 1500 + 500 + 1500, `${ms.toFixed(0)}ms ${JSON.stringify(r)}`);
    check("...and the worker is gone (killed after the grace)", !alive(pid), `pid ${pid}`);
  }
  {
    Q.checkConfig.runner = worker("chatty", `process.stdout.write("z".repeat(6 << 20)); console.log("{}");`);
    const r = await outcome(Q.checkFile(f2, 3.5));
    check("output past the cap is no report", !r.ok && /not a report/.test((r as any).e), JSON.stringify(r).slice(0, 160));
  }
  {
    Q.checkConfig.runner = real; Q.checkConfig.timeoutMs = 90_000;
    const r = await outcome(Q.checkFile(f2));
    check("the next ordinary check runs and answers", r.ok && Array.isArray((r as any).r.levels), JSON.stringify(r).slice(0, 160));
  }
  const { readdirSync } = await import("node:fs");
  const left = readdirSync(join(dir, "opt", "checks", "jobs"));
  check("no job snapshots are left behind, finished or failed", left.length === 0, left.join(","));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
