// servergate — the server's wire-contract battery, one command. Baseline it green before touching server.ts.
//   bun tools/operator/servergate.ts             # the core battery
//   bun tools/operator/servergate.ts --only auth-test,smoke
// For each `server: true` row it boots a scratch sequencer (own WORLDS_DIR and port), runs the tool, kills the
// sequencer's whole tree (procgroup.ts killChild) and prints a PASS/FAIL table. Self-booting suites just run.
// The protocol suites live in the gate (bun run test:protocol), not here.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { killChild } from "../../test/gate/procgroup.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
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

const reap = killChild;

// the battery: `server: true` → a scratch sequencer, handed to the tool as WORLD_URL/JOIN_TOKEN/WORLD_TOKEN/WORLDS_DIR; `env` is the tool's header

type Row = { name: string; tool: string; server?: boolean; serverEnv?: Record<string, string>; env?: Record<string, string>; timeoutMs?: number };
const BATTERY: Row[] = [
  { name: "smoke", tool: "tools/operator/smoke.ts" },   // its own free port (8987 is a live sequencer here)
  { name: "auth-test", tool: "test/server/auth-test.ts" },   // its own free port (permtest merged into it)
  { name: "support-lifecycle", tool: "test/server/support-lifecycle-test.ts", timeoutMs: 420_000 },   // its own free port (freePort): nothing to sweep
];

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
    // stdout/stderr go to a file, never a pipe: a verbose tool blocks on an undrained pipe until the timeout
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
    await sleep(300);
    if (scratch) { try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }); } catch { /* locks */ } }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} — ${results.length - failed.length}/${results.length}${failed.length ? `  (failed: ${failed.map((f) => f.name).join(", ")})` : ""}`);
process.exit(failed.length ? 1 : 0);
