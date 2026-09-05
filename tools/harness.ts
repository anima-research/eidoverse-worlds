// harness — the browser-bench scaffold, ONE copy (R2, survey B5).
//
// lightbench, paritybench, defs-smoke and sim-smoke each carried ~90
// identical lines of scaffolding: browser discovery, free ports, the CDP
// socket, scratch-sequencer spawn, process reaping. The two §24 smokes
// consume this module now; lightbench/paritybench keep their bespoke
// copies until next touched (their headers carry Windows/Edge lessons
// their scaffolds encode — converting them is a change, not a dedup).
//
// The four browser lessons live in lightbench.ts's header; the one this
// module enforces by shape: attach only to a real page target, never a
// vendor dialog (filter by scheme).

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");

const BROWSER_CANDIDATES: Record<string, string[]> = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
           "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
  win32: ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
  linux: ["/usr/bin/google-chrome", "/usr/bin/chromium"],
};
export const CHROME = process.env.CHROME
  ?? (BROWSER_CANDIDATES[process.platform] ?? []).find((p) => existsSync(p)) ?? "chrome";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

export function freePort(from: number, tries = 40): number {
  for (let p = from; p < from + tries; p++) {
    try { const s = Bun.serve({ port: p, hostname: "127.0.0.1", fetch: () => new Response("") }); s.stop(true); return p; }
    catch { /* occupied */ }
  }
  throw new Error(`no free port in ${from}..${from + tries}`);
}

/** A pass/fail line printer with a shared tally. */
export function mkCheck() {
  const t = { passed: 0, failed: 0 };
  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${detail ? dim(`  ${detail}`) : ""}`);
    ok ? t.passed++ : t.failed++;
  };
  return { check, tally: t };
}

export type Cdp = { send<T = any>(m: string, p?: unknown): Promise<T> };
export function cdpOn(ws: WebSocket): Cdp {
  let id = 0;
  return {
    send<T = any>(method: string, params: unknown = {}): Promise<T> {
      const myId = ++id;
      return new Promise((resolveP, reject) => {
        const onMsg = (ev: MessageEvent) => {
          const m = JSON.parse(String(ev.data));
          if (m.id !== myId) return;
          ws.removeEventListener("message", onMsg as any);
          m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolveP(m.result);
        };
        ws.addEventListener("message", onMsg as any);
        ws.send(JSON.stringify({ id: myId, method, params }));
      });
    },
  };
}

/** One scratch world: temp dirs, a sequencer, a headless browser attached
 *  over CDP, and a cleanup that reaps all of it. */
export async function scratchBench(name: string, opts: {
  serverEnv?: Record<string, string>;
  headed?: boolean;
  portFrom?: number;
} = {}) {
  const EIDOVERSE_DIR = process.env.EIDOVERSE_DIR ?? join(ROOT, "..", "eidoverse-video");
  if (!existsSync(join(EIDOVERSE_DIR, "eidoverse", "assets"))) {
    console.error(`✗ asset library not found at ${EIDOVERSE_DIR}`); process.exit(2);
  }
  if (!existsSync(CHROME)) { console.error(`✗ no browser at ${CHROME}`); process.exit(2); }

  const PORT = freePort(opts.portFrom ?? 8950);
  const DEBUG_PORT = freePort((opts.portFrom ?? 8950) + 1000);
  const BASE = `http://localhost:${PORT}`;
  const SCRATCH = mkdtempSync(join(tmpdir(), `ew-${name}-`));

  let cleaned = false;
  const procs: (Bun.Subprocess | null)[] = [];
  const reap = (p: Bun.Subprocess | null) => { try { p?.kill(); } catch { /* gone */ } };
  async function cleanup() {
    if (cleaned) return; cleaned = true;
    for (const p of procs) reap(p);
    await sleep(400);
    try { rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
  }
  process.on("exit", () => { for (const p of procs) reap(p); });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { void cleanup().then(() => process.exit(130)); });
  async function die(code: number, ...lines: string[]) {
    for (const l of lines) console.error(l);
    // keep the child's diagnostics on failure — the bench is about product-
    // door behaviour, and a silent exit is the one thing it must not do
    try {
      const log = await Bun.file(join(SCRATCH, "sequencer.log")).text();
      const tail = log.trim().split("\n").slice(-40);
      if (tail.length) console.error(`--- sequencer.log (last ${tail.length} lines) ---\n${tail.join("\n")}`);
    } catch { /* no log yet */ }
    await cleanup(); process.exit(code);
  }
  // Nonce-bound child identity: the readiness probe accepts only a sequencer
  // that answers with the nonce THIS process handed it — a free-port
  // preflight plus an unauthenticated 200 could be anyone's server.
  const NONCE = `${process.pid}-${Math.random().toString(36).slice(2)}`;

  const seq = Bun.spawn([process.execPath, join(ROOT, "server", "server.ts")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), JOIN_TOKEN: "", EIDOVERSE_DIR, BENCH_NONCE: NONCE,
           WORLDS_DIR: join(SCRATCH, "worlds"), ...(opts.serverEnv ?? {}) },
    stdout: Bun.file(join(SCRATCH, "sequencer.log")),
    stderr: Bun.file(join(SCRATCH, "sequencer.log")),
  });
  procs.push(seq);
  {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      try {
        const r = await fetch(`${BASE}/health`);
        const j = r.ok ? await r.json() as { nonce?: string | null } : null;
        if (j?.nonce === NONCE) up = true;
        else if (r.ok) await die(2, `✗ :${PORT} answered /health with nonce ${JSON.stringify(j?.nonce)} — not our sequencer`);
        else await sleep(250);
      } catch { await sleep(250); }
    }
    if (!up) await die(2, `✗ sequencer never came up on :${PORT}`);
  }

  const browser = Bun.spawn([
    CHROME, ...(opts.headed ? [] : ["--headless=new"]),
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${join(SCRATCH, "profile")}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--disable-background-networking", "--disable-sync", "--mute-audio",
    "--window-size=1280,800", "--enable-unsafe-webgpu", "about:blank",
  ], { stdout: "ignore", stderr: "ignore" });
  procs.push(browser);
  let target: any = null;
  for (let i = 0; i < 120 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      target = list.find((t: any) => t.type === "page"
        && !String(t.url).startsWith("edge://") && !String(t.url).startsWith("chrome"));
    } catch { /* not yet */ }
    if (!target) await sleep(150);
  }
  if (!target) await die(2, `✗ no page target on :${DEBUG_PORT}`);
  const cws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { cws.onopen = res as any; cws.onerror = rej as any; });
  const cdp = cdpOn(cws);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  const evalJson = async (expr: string) => {
    const r = await cdp.send<any>("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    return r?.result?.value;
  };

  return { PORT, BASE, SCRATCH, seq, browser, cws, cdp, evalJson, cleanup, die, sleep };
}
