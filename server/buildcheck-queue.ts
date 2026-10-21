// buildcheck-queue — the sequencer's side of the build check: one check at a
// time, each in its own process (server/buildcheck-run.ts), cached by what
// was checked.
//
// A check loads the collider module and can take seconds; the sequencer only
// ever spawns it and reads the JSON back. Reports are cached in memory and on
// disk (OPT_DIR/checks/), keyed by the model's BYTES (a digest), the scale it
// was checked at and CHECK_VERSION — so a library file replaced in place is
// checked again however its timestamps read, and a store upload (content-
// addressed) is checked once. The digest itself is remembered per path
// against size, mtime, ctime and inode, so an unchanged file isn't re-read on
// every ask; restoring an mtime moves the ctime, so it can't fake that. The
// worker checks a snapshot of the hashed bytes, never the path itself.
// Concurrent asks for one check share the run.
//
// The worker is owned to the end: its output is drained (stdout up to a cap,
// stderr's tail kept), it is asked to stop at the timeout and killed after a
// grace, and the queue moves on even if it is never seen to exit.

import { mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { OPT_DIR, ROOT } from "./config.ts";
import { atomicWrite } from "./fsutil.ts";

/** Bump when what a check finds changes (server/buildcheck.ts, the navgrid
 *  moves it walks, the collider rules): stored reports from before are stale. */
export const CHECK_VERSION = 3;
/** The worker and its limits; tests swap the runner for a misbehaving one. */
export const checkConfig = {
  runner: join(ROOT, "server", "buildcheck-run.ts"),
  timeoutMs: 90_000,
  /** after the soft stop, how long before SIGKILL */
  graceMs: 3_000,
  /** a report is a few KB; more than this is not a report */
  maxOut: 4 << 20,
};
/** The scales a check can be asked at (a placed thing's), to 2 places. */
export const CHECK_SCALE = { min: 0.05, max: 20 };

const memo = new Map<string, unknown>();
const running = new Map<string, Promise<unknown>>();
const digests = new Map<string, { id: string; digest: string }>();
let queue: Promise<unknown> = Promise.resolve();

const diskPath = (key: string) => join(OPT_DIR, "checks", `${Bun.hash(key).toString(16)}.json`);

/** A scale as checks are keyed: finite, clamped, two places. */
export function checkScale(s: unknown): number {
  const n = typeof s === "string" ? Number(s) : typeof s === "number" ? s : 1;
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.round(Math.min(CHECK_SCALE.max, Math.max(CHECK_SCALE.min, n)) * 100) / 100;
}

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const statId = (file: string) => { const st = statSync(file); return `${st.size}|${st.mtimeMs}|${st.ctimeMs}|${st.ino}`; };

/** The build check for the model at `file`, at `scale` — cached, else run
 *  (queued behind any check already running). Rejects when the model can't
 *  be checked. `bytes`: the file's contents when the caller already holds
 *  them (an upload), so they are not read again.
 *
 *  A report answers for exactly the bytes its key names: the worker never
 *  opens `file` — it checks a snapshot of the bytes that were hashed, so a
 *  file replaced while its check waits in the queue cannot have its report
 *  filed under the old digest. */
export async function checkFile(file: string, scale = 1, bytes?: Uint8Array): Promise<unknown> {
  const s = checkScale(scale);
  let id: string;
  try { id = statId(file); } catch { throw new Error("no such file"); }
  // an unchanged file is answered without reading it
  const known = digests.get(file);
  if (!bytes && known?.id === id) {
    const hit = cached(`${CHECK_VERSION}|${known.digest}|${s}`);
    if (hit !== undefined) return hit;
  }
  // otherwise its bytes, read once (asynchronously), name the check
  const data = bytes ?? new Uint8Array(await Bun.file(file).arrayBuffer());
  const digest = sha256(data);
  digests.set(file, { id, digest });   // the id from before the read: a change during it shows next time
  const key = `${CHECK_VERSION}|${digest}|${s}`;
  const hit = cached(key);
  if (hit !== undefined) return hit;
  const inflight = running.get(key);
  if (inflight) return inflight;
  // frozen: the worker reads this copy, never the mutable path
  const jobs = join(OPT_DIR, "checks", "jobs");
  mkdirSync(jobs, { recursive: true });
  const snapshot = join(jobs, `${Bun.hash(key).toString(16)}.glb`);
  const frozen = Bun.write(snapshot, data);
  const run = queue.then(async () => {
    await frozen;
    try {
      const report: any = await runWorker(snapshot, s);
      memo.set(key, report);
      try { atomicWrite(diskPath(key), JSON.stringify({ key, version: CHECK_VERSION, digest, scale: s, file, report })); }
      catch { /* memory still has it */ }
      return report;
    } finally { try { unlinkSync(snapshot); } catch { /* gone */ } }
  });
  running.set(key, run);
  queue = run.catch(() => {});
  void run.finally(() => running.delete(key)).catch(() => {});
  return run;
}

/** A stored report for this key, from memory or disk; undefined if none. */
function cached(key: string): unknown {
  if (memo.has(key)) return memo.get(key);
  try {
    const d = JSON.parse(readFileSync(diskPath(key), "utf8"));
    if (d?.key === key) { memo.set(key, d.report); return d.report; }
  } catch { /* not checked yet */ }
  return undefined;
}

/** Read a stream to its end, keeping at most `cap` bytes (the head, or with
 *  `tail` the last ones) — always draining, so the writer never blocks on a
 *  full pipe. */
async function drain(stream: ReadableStream<Uint8Array>, cap: number, tail = false): Promise<{ text: string; over: boolean }> {
  const parts: Uint8Array[] = [];
  let kept = 0, over = false;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (tail) {
        parts.push(value); kept += value.length;
        while (parts.length > 1 && kept - parts[0].length >= cap) kept -= parts.shift()!.length;
      } else if (kept < cap) {
        const take = value.subarray(0, cap - kept);
        parts.push(take); kept += take.length;
        if (take.length < value.length) over = true;
      } else over = true;
    }
  } catch { /* the stream died with the process */ }
  return { text: Buffer.concat(parts).toString("utf8"), over };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function runWorker(file: string, scale: number): Promise<unknown> {
  const { runner, timeoutMs, graceMs, maxOut } = checkConfig;
  const proc = Bun.spawn([process.execPath, runner, file, String(scale)], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const out = drain(proc.stdout as ReadableStream<Uint8Array>, maxOut);
  const err = drain(proc.stderr as ReadableStream<Uint8Array>, 8 << 10, true);
  let stopped = false;
  const term = setTimeout(() => { stopped = true; try { proc.kill("SIGTERM"); } catch { /* gone */ } }, timeoutMs);
  const kill = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs + graceMs);
  // the queue is never held past the hard kill plus a grace, whatever the process does
  const exited = await Promise.race([proc.exited.then(() => true), sleep(timeoutMs + 2 * graceMs).then(() => false)]);
  clearTimeout(term); clearTimeout(kill);
  if (!exited) {
    console.warn(`[check] worker ${proc.pid} for ${file} did not exit after SIGKILL — abandoned`);
    throw new Error("the check timed out");
  }
  if (stopped) throw new Error("the check timed out");
  // its pipes close with it; a grandchild holding them open doesn't hold the queue
  const [o, e] = await Promise.all([
    Promise.race([out, sleep(graceMs).then(() => ({ text: "", over: true }))]),
    Promise.race([err, sleep(graceMs).then(() => ({ text: "", over: false }))])]);
  if (o.over) throw new Error("the check's output was not a report");
  let report: any;
  try { report = JSON.parse(o.text.trim().split("\n").pop() ?? ""); }
  catch {
    if (e.text.trim()) console.warn(`[check] ${file}: ${e.text.trim().split("\n").slice(-3).join(" | ")}`);
    throw new Error("the check failed");
  }
  if (report?.error) throw new Error(report.error);
  return report;
}
