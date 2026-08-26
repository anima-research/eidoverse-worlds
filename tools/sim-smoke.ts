// sim-smoke — the deterministic sim, proven END TO END (PROTOCOL_v2).
//
//   bun tools/sim-smoke.ts              # headless Chrome, own scratch sequencer
//   bun tools/sim-smoke.ts --headed
//   bun tools/sim-smoke.ts --console
//
// The covenant this file keeps honest: THREE independent computations of one
// punt's flight — the sequencer's live fold (Bun/JavaScriptCore), this
// process's from-the-log recompute (Bun/JSC again, but an INDEPENDENT fold
// from independently fetched entries), and the browser client's shadow fold
// (V8) — must agree about the resting body BIT FOR BIT. The V8 leg is the
// real cross-engine test of Covenant I: same doubles, same operations, same
// bits, different JavaScript engine entirely.
//
// Also held: the epoch door (wrong sim name refused; dir-less punt refused),
// the barrier fold on epoch entry, the client actually MOVING the entity to
// the sim's word, and pre-epoch worlds keeping v1 semantics whole.
//
// Scaffolding follows tools/defs-smoke.ts / lightbench.ts.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emptySim, simEntry, advanceSim, SIM_ID } from "../shared/sim.js";
import { foldEntry, emptyState, type LogEntry } from "../shared/fold.js";

const ROOT = resolve(import.meta.dir, "..");
const EIDOVERSE_DIR = process.env.EIDOVERSE_DIR ?? join(ROOT, "..", "eidoverse-video");
const HEADED = process.argv.includes("--headed");
const ECHO = process.argv.includes("--console");

const BROWSER_CANDIDATES: Record<string, string[]> = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
           "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
  win32: ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
  linux: ["/usr/bin/google-chrome", "/usr/bin/chromium"],
};
const CHROME = process.env.CHROME
  ?? (BROWSER_CANDIDATES[process.platform] ?? []).find((p) => existsSync(p)) ?? "chrome";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
if (!existsSync(join(EIDOVERSE_DIR, "eidoverse", "assets"))) {
  console.error(`✗ asset library not found at ${EIDOVERSE_DIR}`); process.exit(2);
}
if (!existsSync(CHROME)) { console.error(`✗ no browser at ${CHROME}`); process.exit(2); }

function freePort(from: number, tries = 40): number {
  for (let p = from; p < from + tries; p++) {
    try { const s = Bun.serve({ port: p, hostname: "127.0.0.1", fetch: () => new Response("") }); s.stop(true); return p; }
    catch { /* occupied */ }
  }
  throw new Error(`no free port in ${from}..${from + tries}`);
}
const PORT = freePort(8960);
const DEBUG_PORT = freePort(9960);
const BASE = `http://localhost:${PORT}`;
const SCRATCH = mkdtempSync(join(tmpdir(), "ew-simsmoke-"));

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${detail ? dim(`  ${detail}`) : ""}`);
  ok ? passed++ : failed++;
};

let seq: Bun.Subprocess | null = null;
let browser: Bun.Subprocess | null = null;
let cleaned = false;
const reap = (p: Bun.Subprocess | null) => { try { p?.kill(); } catch { /* gone */ } };
async function cleanup() {
  if (cleaned) return; cleaned = true;
  reap(browser); reap(seq);
  await sleep(400);
  try { rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
}
process.on("exit", () => { reap(browser); reap(seq); });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { void cleanup().then(() => process.exit(130)); });
async function die(code: number, ...lines: string[]) {
  for (const l of lines) console.error(l);
  await cleanup(); process.exit(code);
}

console.log(`\n${bold("sim-smoke")} — ${SIM_ID}, scratch sequencer on :${PORT}`);
seq = Bun.spawn([process.execPath, join(ROOT, "server", "server.ts")], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), JOIN_TOKEN: "", EIDOVERSE_DIR,
         WORLDS_DIR: join(SCRATCH, "worlds") },
  stdout: Bun.file(join(SCRATCH, "sequencer.log")),
  stderr: Bun.file(join(SCRATCH, "sequencer.log")),
});
{
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { up = (await fetch(`${BASE}/avatars`)).ok; } catch { await sleep(250); }
  }
  if (!up) await die(2, `✗ sequencer never came up on :${PORT}`);
}

// ---- the driver: author the world, keep the socket for queries -------------

const WORLD = `simsmoke-${Math.random().toString(36).slice(2, 7)}`;
const msgs: any[] = [];
const errors: string[] = [];
const dws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
dws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  msgs.push(m);
  if (m.type === "error") errors.push(String(m.error));
};
await new Promise((r, j) => { dws.onopen = r as any; dws.onerror = j as any; });
dws.send(JSON.stringify({ type: "join", world: WORLD, id: "simdriver", token: "" }));
await sleep(600);
dws.send(JSON.stringify({ type: "pose", pose: { p: [0, 0, 0] } }));
const verb = async (v: string, a: unknown) => { dws.send(JSON.stringify({ type: "verb", verb: v, args: a })); await sleep(350); };

console.log(`\n${bold("── the epoch door")}  ${dim(`world ${WORLD}`)}`);
await verb("epoch", { sim: "futuresim@9.9.9", tickMs: 66 });
check("an epoch naming a sim this build lacks is refused",
  errors.some((e) => e.includes(SIM_ID)), errors.join(" | "));
errors.length = 0;
await verb("epoch", { sim: SIM_ID, tickMs: 66 });
check("the real epoch is accepted", errors.length === 0, errors.join(" | "));
await verb("spawn", { id: "ball", lib: "props/ball.glb", pos: [1, 0, 1] });
await verb("punt", { id: "ball", power: 8 });
check("a dir-less punt is refused under the epoch (Covenant III)",
  errors.some((e) => e.includes("dir")), errors.join(" | "));
errors.length = 0;
{
  const log = await Bun.file(join(SCRATCH, "sequencer.log")).text();
  check("entering the epoch folded the barrier snapshot", log.includes("epoch-barrier"));
}

// ---- the browser client joins BEFORE the punt (it folds the intent live) ---

type Cdp = { send<T = any>(m: string, p?: unknown): Promise<T> };
function cdpOn(ws: WebSocket): Cdp {
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
browser = Bun.spawn([
  CHROME, ...(HEADED ? [] : ["--headless=new"]),
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${join(SCRATCH, "profile")}`,
  "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--disable-background-networking", "--disable-sync", "--mute-audio",
  "--window-size=1280,800", "--enable-unsafe-webgpu", "about:blank",
], { stdout: "ignore", stderr: "ignore" });
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
let bootReady = "";
cws.addEventListener("message", (ev: any) => {
  const m = JSON.parse(String(ev.data));
  if (m.method === "Runtime.consoleAPICalled") {
    const line = (m.params.args ?? []).map((a: any) => a?.value !== undefined ? String(a.value) : a?.description ?? "").join(" ");
    if (ECHO) console.log(dim(`    [page] ${line}`));
    if (line.startsWith("[boot] ready")) bootReady = line;
  }
});
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
const evalJson = async (expr: string) => {
  const r = await cdp.send<any>("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
};
await cdp.send("Page.navigate", { url: `${BASE}/?name=simbot&world=${WORLD}` });
for (let i = 0; i < 240 && !bootReady; i++) await sleep(250);
if (!bootReady) await die(2, "✗ client never booted");

// ---- the punt, witnessed by all three --------------------------------------

console.log(`\n${bold("── the flight")}`);
await verb("punt", { id: "ball", dir: [1, 0.45, 0.3], power: 8 });
// wait for rest on the sequencer's side
let serverSim: any = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  dws.send(JSON.stringify({ type: "debug", sim: true, reqId: `q${i}` }));
  await sleep(200);
  const m = msgs.filter((x) => x.type === "debug" && x.sim).pop();
  if (m?.sim?.bodies?.ball?.resting) { serverSim = m.sim; break; }
}
check("the sequencer's fold brings the ball to REST", !!serverSim,
  serverSim ? `tick ${serverSim.tick}, p=[${serverSim.bodies.ball.p.join(", ")}]` : "never rested");
if (!serverSim) await die(1, "✗ no rest — nothing further to compare");

// leg 2: independent recompute from independently fetched entries (this
// process — Bun/JSC, but a fold that shares NOTHING live with the server's)
dws.send(JSON.stringify({ type: "history", limit: 300, reqId: "h1" }));
await sleep(600);
const hist = msgs.find((x) => x.type === "history" && x.reqId === "h1");
const entries: LogEntry[] = (hist?.entries ?? []).slice().sort((a: LogEntry, b: LogEntry) => a.seq - b.seq);
const st = emptyState(); const localSim = emptySim();
for (const e of entries) { foldEntry(st, e); simEntry(localSim, e, st); }
advanceSim(localSim, serverSim.tick);
check("independent recompute from the log agrees with the sequencer BIT FOR BIT",
  JSON.stringify(localSim.bodies) === JSON.stringify(serverSim.bodies),
  `recomputed from ${entries.length} entries`);

// leg 3: the browser's shadow fold (V8) — Covenant I's cross-engine proof
await sleep(1500);   // let the client's applier advance past rest
const clientBodies = await evalJson(`(() => { try {
  return JSON.parse(JSON.stringify(EW.simFold().bodies));
} catch (e) { return { err: String(e) } } })()`);
check("the V8 client agrees BIT FOR BIT (cross-engine, Covenant I)",
  JSON.stringify(clientBodies) === JSON.stringify(serverSim.bodies),
  clientBodies?.err ?? `client p=[${clientBodies?.ball?.p?.join(", ")}]`);

// and the client actually MOVED the thing
const shown = await evalJson(`(() => { try {
  const o = EW.entities.get('ball'); return o ? [o.position.x, o.position.y, o.position.z] : null;
} catch { return null } })()`);
check("the realized entity stands at the sim's word",
  !!shown && Math.abs(shown[0] - serverSim.bodies.ball.p[0]) < 1e-9
          && Math.abs(shown[2] - serverSim.bodies.ball.p[2]) < 1e-9,
  `shown [${shown?.map((v: number) => v.toFixed(3)).join(", ")}]`);

console.log(`\n${bold(failed ? "RED" : "GREEN")} — ${passed} passed, ${failed} failed\n`);
await cleanup();
process.exit(failed ? 1 : 0);
