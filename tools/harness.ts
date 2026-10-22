// Shared scratch sequencer/browser ownership and failure evidence for benches.
import { existsSync, mkdtempSync, rmSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir, loadavg, cpus } from "node:os";
import { join, resolve } from "node:path";
import { chromeArgs, findChrome } from "./protocol/chrome.ts";

export const ROOT = resolve(import.meta.dir, "..");
export const CHROME = findChrome() ?? "";
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

/** Found worlds in a scratch WORLDS_DIR before a server serves it. The server never founds a world on join (RFC-005
 *  §3.2.7, security review 10-06 H3: a name with no world behind it is refused), so a test that joins one founds it
 *  first, the way an operator does: `bun tools/protocol/world.ts found <name> --owner <who>`. `owner` is the name the owner
 *  joins with (on a TRUST_NAMES=1 server that typed name IS the founder's account local:<name>). */
export function foundWorlds(worldsDir: string, names: string[], owner = "owner") {
  for (const name of names) {
    const r = Bun.spawnSync([process.execPath, join(ROOT, "tools/protocol/world.ts"), "found", name, "--owner", owner], {
      cwd: ROOT, env: { ...process.env, WORLDS_DIR: worldsDir, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
    if (r.exitCode !== 0) throw new Error(`founding "${name}" in ${worldsDir} failed: ${r.stdout.toString()}${r.stderr.toString()}`);
  }
}

/** The chat lines in a socket's received messages: `say` entries of the `log` stream (actors are opaque ids; the
 *  stream's `names` and the snapshot's cut.names say who they are). {seq, actor (display name), by (id), text, body}. */
export function saysIn(msgs: any[]) {
  const names: Record<string, string> = {};
  const out: { seq: number; actor: string; by: string; text: string; body: any }[] = [];
  for (const m of msgs) {
    if (m?.type === "snapshot" && m.cut?.names) Object.assign(names, m.cut.names);
    if (m?.type !== "log") continue;
    if (m.names) Object.assign(names, m.names);
    (m.entries ?? []).forEach((e: any, i: number) => {
      if (e?.kind === "say") out.push({ seq: m.from + i, actor: names[e.actor] ?? String(e.actor), by: String(e.actor), text: String(e.body?.text ?? ""), body: e.body ?? {} });
    });
  }
  return out;
}

let failedChecks = 0;
// Headless Chromes that are NOT this process's descendants: another suite's or an agent's browser sharing the box.
// Five gate reds on 2026-10-14 were rows green solo; each cost a solo re-run to classify. The tally line now says so.
function foreignHeadless(): number {
  try {
    const out = Bun.spawnSync(["ps", "-eo", "pid,ppid,args"]).stdout.toString();
    // String.split with a limit TRUNCATES (the third piece is one word, not "the rest"): parse pid/ppid and keep the whole command
    const rows = out.split("\n").slice(1).map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => [m[1], m[2], m[3]] as [string, string, string]);
    const parent = new Map(rows.map(([pid, ppid]) => [Number(pid), Number(ppid)]));
    const mine = (pid: number) => { for (let p = pid, i = 0; p > 1 && i < 64; p = parent.get(p) ?? 0, i++) if (p === process.pid) return true; return false; };
    return rows.filter(([pid, , args]) => /chrom(e|ium).*--headless/.test(args) && !/--type=/.test(args) && !mine(Number(pid))).length;   // browsers, not their renderer/gpu children
  } catch { return -1; }
}
export function mkCheck() {
  const t = { passed: 0, failed: 0, load0: loadavg()[0], foreign0: foreignHeadless(), note: () => "" };
  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${detail ? dim(`  ${detail}`) : ""}`);
    if (ok) t.passed++; else { t.failed++; failedChecks++; }
  };
  // "· load 1.2→9.4 (16 cores) · 2 foreign headless chromes" — the box's state at start→end, so a red can be read as load without a re-run
  t.note = () => { const l1 = loadavg()[0], f1 = foreignHeadless(), cores = cpus().length, hot = Math.max(t.load0, l1) > cores || Math.max(t.foreign0, f1) > 0;
    return ` · load ${t.load0.toFixed(1)}→${l1.toFixed(1)} (${cores} cores) · ${Math.max(t.foreign0, f1)} foreign headless chrome${Math.max(t.foreign0, f1) === 1 ? "" : "s"}${hot ? " · UNDER LOAD: a red here may be timing" : ""}`; };
  return { check, tally: t };
}

export type Cdp = { send<T = any>(m: string, p?: unknown): Promise<T> };
/** One CDP call's budget. SwiftShader can pin a page's main thread past 60 s on a full world (Commons, 10-15), so a
 *  probe that needs to wait sets CDP_CALL_MS; the default is the old 60 s. */
const CDP_CALL_MS = Math.max(1000, Number(process.env.CDP_CALL_MS) || 60_000);
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
        const timer = setTimeout(() => finish(new Error(`${method}: timed out`)), CDP_CALL_MS);
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
  /** worlds to found before boot (joining never founds one); `owner` founds them (default "owner"). */
  worlds?: string[];
  owner?: string;
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
  if (opts.worlds?.length) foundWorlds(join(SCRATCH, "worlds"), opts.worlds, opts.owner);
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

export async function scratchBench(name: string, opts: ScratchOptions & { headed?: boolean; cspExpected?: boolean } = {}) {
  const run = await scratchSequencer(name, opts);
  const { PORT, SCRATCH, NONCE, track, record, die } = run;
  if (!CHROME || !existsSync(CHROME)) await die(2, CHROME ? `no browser at ${CHROME}` : "no Chromium found (set CHROME=/path/to/chrome)");
  const DEBUG_PORT = freePort(PORT + 1000);
  const pageURL = `${run.BASE}/health?bench=${NONCE}`;
  const browser = track(Bun.spawn([
    CHROME, ...chromeArgs({ headed: opts.headed, port: DEBUG_PORT, profile: join(SCRATCH, "profile"), extra: ["--window-size=1280,800", "--enable-unsafe-webgpu"] }), pageURL,
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
  if (!target) {
    // the first lines say why a browser died; a crash's stack frames and registers don't
    let err = ""; try { err = readFileSync(join(SCRATCH, "browser.stderr.log"), "utf8").trim().split("\n").filter((l) => !/^\s*(#\d+ 0x|r\d+:|[a-z]{2,3}: )/.test(l)).slice(0, 8).join(" | "); } catch {}
    await die(2, `no owned page target on :${DEBUG_PORT}${err ? ` (browser said: ${err.slice(0, 900)})` : " (browser printed nothing)"}`);
  }
  const cws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { cws.onopen = res as any; cws.onerror = rej as any; });
  // Every page this bench drives runs under the server's Content-Security-Policy (server/csp.ts). A violation is the
  // client trying something the policy refuses (an inline handler, a host connect-src doesn't name) — a feature that
  // silently stopped working, so every browser probe is a CSP regression test: any violation fails the run at cleanup,
  // unless the probe causes them on purpose (cspExpected).
  const cspViolations: string[] = [];
  cws.addEventListener("message", (ev) => {
    const m = JSON.parse(String(ev.data));
    if (["Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded", "Network.loadingFailed",
      // what can stall a navigation: a dialog (alert, beforeunload), a crashed renderer, the navigations themselves
      "Page.javascriptDialogOpening", "Inspector.targetCrashed", "Page.frameRequestedNavigation", "Page.frameStartedNavigating", "Page.frameNavigated", "Page.loadEventFired"].includes(m.method)) record("browser.events.jsonl", m);
    if (m.method === "Log.entryAdded" && /Content Security Policy/i.test(String(m.params?.entry?.text ?? ""))) cspViolations.push(String(m.params.entry.text).slice(0, 300));
  });
  const cdp = cdpOn(cws);
  await Promise.all([cdp.send("Runtime.enable"), cdp.send("Page.enable"), cdp.send("Log.enable"), cdp.send("Network.enable")]);
  // EIDO_CPU_THROTTLE=<n>: slow only the page n times (Chrome's own CPU throttle), so a slow CI runner's page can be
  // reproduced on a fast host without starving the server or the runner too
  const throttle = Number(process.env.EIDO_CPU_THROTTLE);
  if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  // THE SKY GUARD, before any module reads localStorage: a cloudy sky bakes on the CPU in headless Chromium and has
  // frozen Burrow (memory: feedback_headless_sky_oom). Every page this browser loads from here on starts clouds-off.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "try { localStorage.setItem('ew-cloud-quality', 'off'); } catch {}" });
  // THE GPU GUARD: headless Chrome can't present WebGPU, so it destroys the device ~1 s into every page. The client's
  // recovery (client/lib/gpulost.js) answers a browser-destroyed device with a reload, which would yank the page out
  // from under a probe mid-check. Seed one recent loss so the rule "a second loss inside 2 min doesn't reload" applies:
  // the renderer stops (no leak), the page stays, and DOM/state probes run as before. Recovery itself is
  // gpulost-test.mjs (pure) and gpulost-probe.mjs (its own harness), neither of which loads this.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "try { if (!sessionStorage.getItem('ew-gpu-lost')) sessionStorage.setItem('ew-gpu-lost', JSON.stringify([Date.now()])); } catch {}" });
  const evalJson = async (expr: string) => {
    const r = await cdp.send<any>("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      record("browser.events.jsonl", { method: "Runtime.evaluate.exception", params: r.exceptionDetails });
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r?.result?.value;
  };
  const cleanup = async (code?: number) => {
    if (cspViolations.length && !opts.cspExpected) {
      console.log(`  \x1b[31m✗\x1b[0m FAIL the page broke its Content-Security-Policy ${cspViolations.length}× (server/csp.ts): ${[...new Set(cspViolations)].slice(0, 4).join(" | ")}`);
      await run.cleanup(1);
      process.exit(1);   // the probes exit with their own tally after cleanup; a broken policy outranks it
    }
    return run.cleanup(code);
  };
  return { ...run, cleanup, browser, cws, cdp, evalJson, cspViolations };
}

/** The old authoring words a test written against main used on an agent (`a.verb("spawn", …)`), as the authority
 *  requests the protocol speaks (every world write is a door request; the agent has no raw verbs). Merging the stack
 *  (#235/#236/#239/#241, 10-15) brought tests in that author their scenes this way; this keeps their scenes as they
 *  wrote them. spawn's scale and collide become the transform's scale and the collider component; comp is a set;
 *  mount of the agent itself is the attach tool's path (presence), of a thing a parent set; light is a light thing. */
/** A scene's name for a thing (legacyVerb's spawn) → the id the authority minted for it. */
export const sceneId = (a: any, n: string): string => a?.__sceneIds?.get(n) ?? n;
export async function legacyVerb(a: any, v: string, x: any): Promise<any> {
  if (x?.id === undefined && (v === "spawn" || v === "light")) x = { ...x };
  const { qFromYaw } = await import("../shared/rot.js");
  const tf = (o: any) => ({ ...(o.pos ? { pos: o.pos } : {}), ...(typeof o.yaw === "number" ? { q: qFromYaw(o.yaw) } : {}),
    ...(typeof o.scale === "number" ? { scale: [o.scale, o.scale, o.scale] } : {}) });
  // R 10-17: a writer never chooses an id. A scene's name for a thing becomes a placeholder ('$tower') the authority mints an id
  // for, and the thing's label (tools take a label as they take an id); later words map the name to the minted id
  const ids: Map<string, string> = (a.__sceneIds ??= new Map());
  const id = (n: any) => (typeof n === "string" ? ids.get(n) ?? n : n);
  const made = (r: any, n: string) => { const m = r?.ids?.[`$${n}`]; if (m) ids.set(n, m); return r; };
  const ph = (n: string) => `$${String(n).replace(/[^A-Za-z0-9_-]+/g, "-")}`;
  switch (v) {
    case "spawn": return made(await a.request("create", { ...(x.id ? { id: ph(x.id) } : {}), model: x.lib, components: { transform: tf(x), ...(x.id ? { label: String(x.id) } : {}), ...(x.collide ? { collider: { shape: x.collide } } : {}) } }), ph(x.id).slice(1));
    case "place": return a.request("set", { id: id(x.id), component: "transform", value: tf(x), merge: true });
    case "remove": return a.request("delete", { id: id(x.id) });
    case "comp": return x.data == null ? a.request("delete", { id: id(x.id), component: x.type }) : a.request("set", { id: id(x.id), component: x.type, value: x.data });
    case "light": return made(await a.request("create", { ...(x.id ? { id: ph(x.id) } : {}), components: { transform: tf(x), ...(x.id ? { label: String(x.id) } : {}), light: { ...(x.intensity != null ? { intensity: x.intensity } : {}), ...(x.color != null ? { color: x.color } : {}), ...(x.range != null ? { range: x.range } : {}) } } }), ph(x.id).slice(1));
    case "mount": {
      if (x.id === a.name) { const { handleTool } = await import("../mcpl/tools.ts"); return handleTool({ agent: a } as any, "attach", { to: id(x.to), ...(x.slot ? { socket: x.slot } : {}) }); }
      return a.request("set", { id: id(x.id), component: "parent", value: { to: id(x.to) } });
    }
    default: throw new Error(`legacyVerb: no protocol request for '${v}'`);
  }
}
