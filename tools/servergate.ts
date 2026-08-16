// servergate — the step-7 battery, one command.
//
//   bun tools/servergate.ts             # the core battery
//   bun tools/servergate.ts --only permtest,comptest
//
// The server split (TEL0S_NOTES §15) walks through a dense lattice of
// wire-contract suites, each with its own env header. This runner makes
// that lattice one command: for every external-server tool it boots a
// fresh scratch sequencer (own WORLDS_DIR, own port, the tool's exact
// env), runs the tool, kills the sequencer by child handle (§ Windows:
// taskkill /T — the PID we hold is bun's own since we spawn
// process.execPath, never the PATH shim), and prints a PASS/FAIL table.
// Self-booting suites (smoke, authtest, support-lifecycle, collide-fold)
// just run. Baseline this GREEN before touching server.ts; run it after
// every slice.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const only = (() => {
  const i = process.argv.indexOf("--only");
  return i >= 0 ? new Set(process.argv[i + 1].split(",")) : null;
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(from: number): number {
  for (let p = from; p < from + 60; p++) {
    try {
      const s = Bun.serve({ port: p, hostname: "127.0.0.1", fetch: () => new Response("") });
      s.stop(true);
      return p;
    } catch { /* occupied */ }
  }
  throw new Error("no free port");
}

function reap(p: Bun.Subprocess | null) {
  if (!p) return;
  try { p.kill(); } catch { /* gone */ }
  if (process.platform === "win32" && typeof p.pid === "number") {
    try { Bun.spawnSync(["taskkill", "/PID", String(p.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }); } catch { /* fine */ }
  }
}

// ---- the battery ------------------------------------------------------------
// `server: true` → boot a scratch sequencer and hand the tool WORLD_URL/
// JOIN_TOKEN/HTTP. `env` on either kind is the tool's documented header.

type Row = { name: string; tool: string; server?: boolean; serverEnv?: Record<string, string>; env?: Record<string, string>; timeoutMs?: number; sweepPorts?: number[] };
const BATTERY: Row[] = [
  { name: "smoke", tool: "tools/smoke.ts", sweepPorts: [8987] },
  { name: "authtest", tool: "tools/authtest.ts", sweepPorts: [8992] },
  { name: "collide-fold", tool: "tools/collide-fold-test.ts", sweepPorts: [8990] },
  { name: "support-lifecycle", tool: "tools/support-lifecycle-test.ts", timeoutMs: 420_000, sweepPorts: [8940] },
  { name: "permtest", tool: "tools/permtest.ts", server: true },
  { name: "comptest", tool: "tools/comptest.ts", server: true },
  { name: "modtest", tool: "tools/modtest.ts", server: true, serverEnv: { WORLD_ADMIN: "admin" } },
  { name: "locktest", tool: "tools/locktest.ts", server: true },
  { name: "leasetest", tool: "tools/leasetest.ts", server: true },
  { name: "worldops", tool: "tools/worldops-test.ts", server: true },
  { name: "compfold", tool: "tools/compfold-test.ts", server: true, serverEnv: { FOLD_EVERY: "1" } },
  { name: "behaviortest", tool: "tools/behaviortest.ts", server: true, serverEnv: { BHV_TIMER_MIN: "1" }, timeoutMs: 240_000 },
];

/** Kill whatever LISTENS on `port` (Windows netstat) — self-booting suites
 *  can leak their servers on exit, since Windows children outlive parents. */
function sweepPort(port: number) {
  if (process.platform !== "win32") return;
  try {
    const out = Bun.spawnSync(["netstat", "-ano"], { stdout: "pipe" }).stdout.toString();
    for (const line of out.split("\n")) {
      if (!line.includes(`:${port} `) || !line.includes("LISTENING")) continue;
      const pid = line.trim().split(/\s+/).pop();
      if (pid && pid !== "0") {
        Bun.spawnSync(["taskkill", "/PID", pid, "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
        console.log(`  \x1b[2m(swept leaked listener on :${port}, pid ${pid})\x1b[0m`);
      }
    }
  } catch { /* sweep is best-effort */ }
}

const LOGDIR = mkdtempSync(join(tmpdir(), "ew-servergate-"));
console.log(`\x1b[2mtool logs: ${LOGDIR}\x1b[0m`);
const results: { name: string; ok: boolean; ms: number; tail: string }[] = [];

for (const row of BATTERY) {
  if (only && !only.has(row.name)) continue;
  const t0 = Date.now();
  let seq: Bun.Subprocess | null = null;
  let scratch: string | null = null;
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...(row.env ?? {}) };

  try {
    if (row.server) {
      scratch = mkdtempSync(join(tmpdir(), `ew-gate-${row.name}-`));
      const port = freePort(9200);
      seq = Bun.spawn([process.execPath, join(ROOT, "server", "server.ts")], {
        cwd: ROOT,
        env: {
          ...process.env as Record<string, string>,
          PORT: String(port), JOIN_TOKEN: "test-door",
          WORLDS_DIR: join(scratch, "worlds"), RECORD_FRAMES: "0",
          ...(row.serverEnv ?? {}),
        },
        stdout: Bun.file(join(scratch, "seq.log")),
        stderr: Bun.file(join(scratch, "seq.log")),
      });
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        try { up = (await fetch(`http://127.0.0.1:${port}/avatars`)).ok; } catch { await sleep(250); }
      }
      if (!up) throw new Error("scratch sequencer never came up");
      env.WORLD_URL = `ws://127.0.0.1:${port}/ws`;
      env.JOIN_TOKEN = "test-door";
      env.WORLD_TOKEN = env.WORLD_TOKEN ?? "test-door";
      env.WORLDS_DIR = join(scratch, "worlds");
    }
    // stdout/stderr go to a FILE, never a pipe: a verbose tool fills an
    // undrained pipe buffer, blocks on write, and "hangs" until the
    // timeout — the first baseline run spent 37 minutes learning this
    const logPath = join(LOGDIR, `${row.name}.log`);
    const run = Bun.spawn([process.execPath, join(ROOT, row.tool)], {
      cwd: ROOT, env, stdout: Bun.file(logPath), stderr: Bun.file(logPath),
    });
    const timeout = row.timeoutMs ?? 120_000;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; reap(run); }, timeout);
    const code = await run.exited;
    clearTimeout(timer);
    const out = await Bun.file(logPath).text().catch(() => "");
    const tail = (timedOut ? "TIMEOUT | " : "") + out.trim().split("\n").slice(-3).join(" | ").slice(0, 200);
    results.push({ name: row.name, ok: code === 0, ms: Date.now() - t0, tail });
    console.log(`${code === 0 ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${row.name.padEnd(18)} ${String(Date.now() - t0).padStart(6)}ms  \x1b[2m${tail}\x1b[0m`);
  } catch (e) {
    results.push({ name: row.name, ok: false, ms: Date.now() - t0, tail: String(e) });
    console.log(`\x1b[31m✗\x1b[0m ${row.name.padEnd(18)} — ${String(e)}`);
  } finally {
    reap(seq);
    for (const p of row.sweepPorts ?? []) sweepPort(p);
    await sleep(300);
    if (scratch) { try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }); } catch { /* locks */ } }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} — ${results.length - failed.length}/${results.length}${failed.length ? `  (failed: ${failed.map((f) => f.name).join(", ")})` : ""}`);
process.exit(failed.length ? 1 : 0);
