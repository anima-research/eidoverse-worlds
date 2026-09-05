// Shared scratch sequencer/browser ownership and failure evidence for benches.
import { existsSync, mkdtempSync, rmSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");
const BROWSER_CANDIDATES: Record<string, string[]> = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
  win32: ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
  linux: ["/usr/bin/google-chrome", "/usr/bin/chromium"],
};
export const CHROME = process.env.CHROME
  ?? (BROWSER_CANDIDATES[process.platform] ?? []).find((p) => existsSync(p)) ?? "chrome";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
/** Both streams, for assertions about the sequencer's reported refusals. */
export function readSequencerLog(scratch: string): string {
  return ["sequencer.log", "sequencer.stderr.log"].map(file => {
    try { return readFileSync(join(scratch, file), "utf8"); } catch { return ""; }
  }).join("\n");
}
export function freePort(from: number, tries = 40): number {
  for (let p = from; p < from + tries; p++) {
    try { const s = Bun.serve({ port: p, hostname: "127.0.0.1", fetch: () => new Response("") }); s.stop(true); return p; }
    catch { /* occupied */ }
  }
  throw new Error(`no free port in ${from}..${from + tries}`);
}

let failedChecks = 0;
export function mkCheck() {
  const t = { passed: 0, failed: 0 };
  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${detail ? dim(`  ${detail}`) : ""}`);
    if (ok) t.passed++; else { t.failed++; failedChecks++; }
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
        const finish = (err?: Error, result?: T) => {
          clearTimeout(timer);
          ws.removeEventListener("message", onMsg);
          ws.removeEventListener("close", onClose);
          if (err) reject(err); else resolveP(result!);
        };
        const onMsg = (ev: MessageEvent) => {
          const m = JSON.parse(String(ev.data));
          if (m.id === myId) finish(m.error ? new Error(`${method}: ${m.error.message}`) : undefined, m.result);
        };
        const onClose = () => finish(new Error(`${method}: browser connection closed`));
        const timer = setTimeout(() => finish(new Error(`${method}: timed out`)), 60_000);
        ws.addEventListener("message", onMsg);
        ws.addEventListener("close", onClose);
        try { ws.send(JSON.stringify({ id: myId, method, params })); }
        catch (err) { finish(err as Error); }
      });
    },
  };
}

type ScratchOptions = {
  serverEnv?: Record<string, string>;
  portFrom?: number;
  // Tests may seed a log before boot or instrument asset I/O in the child.
  prepare?: (scratch: string) => void | Promise<void>;
  preload?: string;
};

/** Own the child and prove its identity before opening any product door. */
export async function scratchSequencer(name: string, opts: ScratchOptions = {}) {
  const PORT = freePort(opts.portFrom ?? 8950);
  const BASE = `http://127.0.0.1:${PORT}`;
  const SCRATCH = mkdtempSync(join(tmpdir(), `ew-${name}-`));
  const NONCE = crypto.randomUUID();
  const procs: Bun.Subprocess[] = [];
  let cleaned = false, announced = false;
  const record = (file: string, value: unknown) => {
    try { appendFileSync(join(SCRATCH, file), JSON.stringify(value) + "\n"); } catch { /* retain whatever was already written */ }
  };
  const evidence = () => {
    if (announced) return; announced = true;
    console.error(`[bench] failure diagnostics retained at ${SCRATCH}`);
    for (const file of ["sequencer.log", "sequencer.stderr.log", "browser.stderr.log", "browser.events.jsonl", "failure.jsonl"]) {
      try {
        const tail = readFileSync(join(SCRATCH, file), "utf8").trim().split("\n").slice(-12)
          .map(line => line.length > 1000 ? line.slice(0, 1000) + "…" : line).join("\n");
        if (tail) console.error(`[bench] ${file} (preview; full file retained):\n${tail}`);
      } catch { /* child may not have started */ }
    }
  };
  const reap = () => { for (const p of procs) { try { p.kill(); } catch { /* exited */ } } };
  async function cleanup(code = Number(process.exitCode ?? 0) || (failedChecks ? 1 : 0)) {
    if (cleaned) return; cleaned = true;
    reap();
    await Promise.race([Promise.all(procs.map((p) => p.exited)), sleep(2000)]);
    if (code) evidence();
    else { try { rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } }
  }
  async function die(code: number, ...lines: string[]): Promise<never> {
    for (const l of lines) console.error(l);
    record("failure.jsonl", { code, lines });
    await cleanup(code);
    process.exit(code);
  }
  process.on("exit", (code) => {
    reap();
    if (!cleaned && code) evidence();
  });
  process.once("uncaughtException", (err) => { void die(1, err.stack ?? String(err)); });
  process.once("unhandledRejection", (err) => { void die(1, err instanceof Error ? err.stack ?? String(err) : String(err)); });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { void die(130, `interrupted: ${sig}`); });
  const track = (p: Bun.Subprocess) => { procs.push(p); return p; };
  await opts.prepare?.(SCRATCH);
  const EIDOVERSE_DIR = opts.serverEnv?.EIDOVERSE_DIR ?? process.env.EIDOVERSE_DIR ?? join(ROOT, "..", "eidoverse-video");
  const seq = track(Bun.spawn([process.execPath, ...(opts.preload ? ["--preload", opts.preload] : []), join(ROOT, "server", "server.ts")], {
    cwd: ROOT,
    env: { ...process.env, JOIN_TOKEN: "", EIDOVERSE_DIR, ...opts.serverEnv,
      PORT: String(PORT), WORLDS_DIR: join(SCRATCH, "worlds"), RELAY_STATE_DIR: SCRATCH, BENCH_NONCE: NONCE },
    stdout: Bun.file(join(SCRATCH, "sequencer.log")), stderr: Bun.file(join(SCRATCH, "sequencer.stderr.log")),
  }));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    if (seq.exitCode !== null) await die(2, `sequencer exited ${seq.exitCode} before readiness`);
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) {
        const j = await r.json() as { nonce?: string };
        if (j.nonce !== NONCE) await die(2, `:${PORT} answered with another sequencer's nonce`);
        up = true;
      }
    } catch { /* not listening yet */ }
    if (!up) await sleep(250);
  }
  if (!up) await die(2, `sequencer never came up on :${PORT}`);
  return { PORT, BASE, SCRATCH, NONCE, EIDOVERSE_DIR, seq, track, record, cleanup, die, sleep };
}

export async function scratchBench(name: string, opts: ScratchOptions & { headed?: boolean } = {}) {
  const run = await scratchSequencer(name, opts);
  const { PORT, SCRATCH, NONCE, track, record, die } = run;
  if (!existsSync(CHROME)) await die(2, `no browser at ${CHROME}`);
  const DEBUG_PORT = freePort(PORT + 1000);
  const pageURL = `${run.BASE}/health?bench=${NONCE}`;
  const browser = track(Bun.spawn([
    CHROME, ...(opts.headed ? [] : ["--headless=new"]),
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${join(SCRATCH, "profile")}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--disable-background-networking", "--disable-sync", "--mute-audio",
    "--window-size=1280,800", "--enable-unsafe-webgpu", pageURL,
  ], { stdout: Bun.file(join(SCRATCH, "browser.log")), stderr: Bun.file(join(SCRATCH, "browser.stderr.log")) }));
  let target: any = null;
  for (let i = 0; i < 120 && !target; i++) {
    if (browser.exitCode !== null) await die(2, `browser exited ${browser.exitCode} before readiness`);
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
      target = list.find((t: any) => t.type === "page" && t.url === pageURL);
    } catch { /* not listening yet */ }
    if (!target) await sleep(150);
  }
  if (!target) await die(2, `no owned page target on :${DEBUG_PORT}`);
  const cws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { cws.onopen = res as any; cws.onerror = rej as any; });
  cws.addEventListener("message", (ev) => {
    const m = JSON.parse(String(ev.data));
    if (["Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded", "Network.loadingFailed"].includes(m.method)) record("browser.events.jsonl", m);
  });
  const cdp = cdpOn(cws);
  await Promise.all([cdp.send("Runtime.enable"), cdp.send("Page.enable"), cdp.send("Log.enable"), cdp.send("Network.enable")]);
  const evalJson = async (expr: string) => {
    const r = await cdp.send<any>("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      record("browser.events.jsonl", { method: "Runtime.evaluate.exception", params: r.exceptionDetails });
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r?.result?.value;
  };
  return { ...run, browser, cws, cdp, evalJson };
}
