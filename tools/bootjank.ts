// bootjank — where do the first rough seconds GO?
//
//   bun tools/bootjank.ts                     # replay worlds/commons in a scratch
//                                             #   sequencer, record 40s of frames
//   bun tools/bootjank.ts --wide              # author a far-city world instead:
//                                             #   near models + models at 300-500m,
//                                             #   ASSERT the far libs never fetch
//   bun tools/bootjank.ts --mbit 25           # throttled arrivals (spread storm)
//   bun tools/bootjank.ts --secs 60           # longer observation window
//   bun tools/bootjank.ts --headed --console  # watch it happen
//
// bootbench asks "when is the first frame"; this asks "how bad are the next
// two thousand". A document-start hook wraps the WebGPU device/queue entry
// points (createRenderPipeline / createShaderModule / writeBuffer /
// writeTexture / copyExternalImageToTexture) and a rAF loop records every
// frame's duration with the GPU work that landed inside it, plus longtask
// spans and 1Hz samples of EW.frame()'s per-system bill. The report is a
// timeline of the worst frames, each attributed: compile, upload, or CPU.
//
// The world is a byte-copy of worlds/commons — the actual world whose early
// roughness prompted this tool — served by a scratch sequencer so nothing
// appends to the real log.
//
// Scaffolding (scratch sequencer, CDP, Windows shim rule) is paritybench's.

import { existsSync, mkdtempSync, rmSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const has = (n: string) => args.includes(`--${n}`);
const num = (n: string, d: number) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const HEADED = has("headed");
const ECHO = has("console");
const MBIT = num("mbit", 0);
const WIDE = has("wide");
const HEAVYJOIN = has("heavyjoin");   // a 21MB-avatar resident arrives at t≈+12s
                                      // after boot — measures the VRM-parse halt
                                      // (the same main-thread path an avatar
                                      // SWITCH takes, §19b)
const GRASSDIAG = has("grassdiag");   // §22: run EW.grassDiag() post-boot and
                                      // print its table. Combine with
                                      // --pixels N to force the GPU-bound
                                      // regime the diag needs to show deltas.
const PIXELS = num("pixels", 0);      // renderer.setPixelRatio(N) post-boot
const SECS = num("secs", WIDE ? 25 : HEAVYJOIN ? 50 : GRASSDIAG ? 75 : 40);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EIDOVERSE_DIR = process.env.EIDOVERSE_DIR ?? join(ROOT, "..", "eidoverse-video");
// A WebGPU-capable Chromium, wherever this machine keeps one — CHROME env
// wins, else the first candidate that exists (paritybench's list, copied:
// the tools stay self-contained).
const BROWSER_CANDIDATES: Record<string, string[]> = {
  win32: [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "/usr/bin/google-chrome", "/usr/bin/microsoft-edge",
    "/usr/bin/chromium-browser", "/usr/bin/chromium",
  ],
};
const CHROME = process.env.CHROME
  ?? (BROWSER_CANDIDATES[process.platform] ?? []).find((p) => existsSync(p))
  ?? BROWSER_CANDIDATES[process.platform]?.[0] ?? "chrome";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const mb = (b: number) => `${(b / 1048576).toFixed(1)}MB`;

if (!existsSync(join(EIDOVERSE_DIR, "eidoverse", "assets"))) {
  console.error(`✗ asset library not found at ${EIDOVERSE_DIR}`); process.exit(2);
}
if (!existsSync(CHROME)) { console.error(`✗ no browser at ${CHROME}`); process.exit(2); }
if (!WIDE && !existsSync(join(ROOT, "worlds", "commons", "log.jsonl"))) {
  console.error("✗ worlds/commons/log.jsonl not found — bootjank replays the real commons"); process.exit(2);
}

// --wide: the libs an arrival should and should NOT fetch. Distinct sets, so
// the network log is an unambiguous witness (§16.2.C: far entities never
// load at join — the join gate works from position, geom or no geom).
const NEAR_LIBS = [
  "eidoverse/assets/models/scifi_art_deco_office_desk.glb",
  "eidoverse/assets/models/streetlight_lamp_light_street_blade_runner_cyberpunk.glb",
  "eidoverse/assets/models/scifi_barrels_group_of_four.glb",
];
const FAR_LIBS = [
  "eidoverse/assets/models/crate_large_blue.glb",
  "eidoverse/assets/models/crate_large_green.glb",
  "eidoverse/assets/models/crate_large_red.glb",
  "eidoverse/assets/models/crate_large_yellow.glb",
  "eidoverse/assets/models/scifi_barrels_single.glb",
  "eidoverse/assets/models/modern_sedan_car_grey_vehicle_generic.glb",
];

function freePort(from: number, tries = 40): number {
  for (let p = from; p < from + tries; p++) {
    try {
      const s = Bun.serve({ port: p, hostname: "127.0.0.1", fetch: () => new Response("") });
      s.stop(true);
      return p;
    } catch { /* occupied */ }
  }
  throw new Error(`no free port in ${from}..${from + tries}`);
}
const PORT = process.env.PORT ? Number(process.env.PORT) : freePort(8960);
const DEBUG_PORT = freePort(9960);
const BASE = `http://localhost:${PORT}`;
const SCRATCH = mkdtempSync(join(tmpdir(), "ew-bootjank-"));

let seq: Bun.Subprocess | null = null;
let edge: Bun.Subprocess | null = null;
let cleaned = false;
function reap(p: Bun.Subprocess | null) {
  if (!p) return;
  try { p.kill(); } catch { /* gone */ }
  if (process.platform === "win32" && typeof p.pid === "number") {
    try { Bun.spawnSync(["taskkill", "/PID", String(p.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }); } catch { /* fine */ }
  }
}
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  reap(edge); reap(seq);
  await sleep(400);
  try { rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
}
process.on("exit", () => { reap(edge); reap(seq); });
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { void cleanup().then(() => process.exit(130)); });
}
async function die(code: number, ...lines: string[]) {
  for (const l of lines) console.error(l);
  await cleanup();
  process.exit(code);
}

// ---- sequencer on a byte-copy of commons ------------------------------------

const WORLDS = join(SCRATCH, "worlds");
mkdirSync(WORLDS, { recursive: true });
if (!WIDE) cpSync(join(ROOT, "worlds", "commons"), join(WORLDS, "commons"), { recursive: true });
const WORLD = WIDE ? `wide-${Math.random().toString(36).slice(2, 7)}` : "commons";

console.log(`\n${bold("bootjank")} — ${WIDE ? "far-city world" : "commons replica"} on :${PORT}${MBIT ? ` at ${MBIT}mbit` : ""}, ${SECS}s window`);
seq = Bun.spawn([process.execPath, join(ROOT, "server", "server.ts")], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), JOIN_TOKEN: "", EIDOVERSE_DIR, WORLDS_DIR: WORLDS },
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

// ---- --wide: author the far city (driver socket, lightbench's pattern) ------
if (WIDE) {
  const verbs: Array<[string, unknown]> = [
    ["terrain", { seed: 7, size: 1200, segments: 200, amplitude: 6, flatRadius: 16 }],
    ["sky", { clouds: "clear", hours: 12, azimuth: 180 }],
    ...NEAR_LIBS.map((lib, i): [string, unknown] =>
      ["spawn", { id: `near${i}`, lib, pos: [3 + i * 3, 0, -8 - i * 2], yaw: 0 }]),
    ...FAR_LIBS.map((lib, i): [string, unknown] =>
      ["spawn", { id: `far${i}`, lib, pos: [300 + i * 40, 0, 300 + i * 40], yaw: 0 }]),
  ];
  await new Promise<void>((resolve, reject) => {
    const dws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    dws.onopen = () => dws.send(JSON.stringify({ type: "join", world: WORLD, id: "widedriver", token: "" }));
    dws.onmessage = async (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "snapshot") {
        for (const [verb, args] of verbs) {
          dws.send(JSON.stringify({ type: "verb", verb, args }));
          await sleep(150);
        }
        await sleep(400);
        try { dws.close(); } catch { /* fine */ }
        resolve();
      }
      if (m.type === "error") reject(new Error(`driver refused: ${m.error}`));
    };
    dws.onerror = () => reject(new Error("driver socket failed"));
    setTimeout(() => reject(new Error("driver never got a snapshot")), 15_000);
  }).catch((e) => die(2, `✗ wide-world authoring failed: ${e.message}`));
}

// ---- browser ----------------------------------------------------------------

type Cdp = { send<T = any>(m: string, p?: unknown): Promise<T>; ws: WebSocket };
function cdpOn(ws: WebSocket): Cdp {
  let id = 0;
  return {
    ws,
    send<T = any>(method: string, params: unknown = {}): Promise<T> {
      const myId = ++id;
      return new Promise((resolve, reject) => {
        const onMsg = (ev: MessageEvent) => {
          const m = JSON.parse(String(ev.data));
          if (m.id !== myId) return;
          ws.removeEventListener("message", onMsg as any);
          m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result);
        };
        ws.addEventListener("message", onMsg as any);
        ws.send(JSON.stringify({ id: myId, method, params }));
      });
    },
  };
}

edge = Bun.spawn([
  CHROME,
  ...(HEADED ? [] : ["--headless=new"]),
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${join(SCRATCH, "edge-profile")}`,   // fresh profile = cold HTTP + shader caches
  "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--disable-background-networking", "--disable-sync", "--mute-audio",
  "--window-size=1280,800", "--enable-unsafe-webgpu",
  "about:blank",
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
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res as any; ws.onerror = rej as any; });
const cdp = cdpOn(ws);

const pageErrors: string[] = [];
let bootReady = "";
const consoleLog: { t: number; line: string }[] = [];
const textOf = (a: any) => a?.value !== undefined ? String(a.value) : a?.description ?? "";
ws.addEventListener("message", (ev: any) => {
  const m = JSON.parse(String(ev.data));
  if (m.method === "Runtime.consoleAPICalled") {
    const line = (m.params.args ?? []).map(textOf).join(" ");
    if (ECHO) console.log(dim(`    [page ${m.params.type}] ${line}`));
    consoleLog.push({ t: Date.now(), line });
    if (line.startsWith("[boot] ready")) bootReady = line;
    if (m.params.type === "error") pageErrors.push(line);
  } else if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    pageErrors.push(String(d?.exception?.description ?? d?.text ?? "(exception)"));
  }
});
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");

const evalJson = async (expr: string) => {
  const r = await cdp.send<any>("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
};
if (MBIT > 0) {
  await cdp.send("Network.enable");
  const bps = (MBIT * 1_000_000) / 8;
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false, latency: 40, downloadThroughput: bps, uploadThroughput: bps,
  });
}

// ---- the document-start recorder --------------------------------------------
// Installed before any module runs. Wraps the GPU entry points so each frame
// knows what landed inside it; times the SYNCHRONOUS cost of pipeline/shader
// creation (Chrome defers real compilation to the GPU process, so a long rAF
// gap right AFTER creations is the compile stall even when the sync ms is 0 —
// the correlation is the attribution, the sync ms is a bonus).

const RECORDER = `(() => {
  if (globalThis.__jank) return;
  const J = globalThis.__jank = {
    frames: [], gpu: [], bills: [], longtasks: [],
    _up: 0, _tex: 0, _pipe: 0, _pipeMs: 0, _shad: 0, _shadMs: 0, _bmp: 0,
  };
  try {
    if (globalThis.GPUDevice) {
      const wrap = (proto, name, onCall) => {
        const orig = proto[name];
        if (!orig) return;
        proto[name] = function (...a) {
          const t = performance.now();
          const r = orig.apply(this, a);
          onCall(performance.now() - t, a);
          return r;
        };
      };
      wrap(GPUDevice.prototype, 'createRenderPipeline', (ms, a) => {
        J._pipe++; J._pipeMs += ms;
        J.gpu.push({ t: +performance.now().toFixed(0), k: 'pipe', ms: +ms.toFixed(1) });
      });
      wrap(GPUDevice.prototype, 'createComputePipeline', (ms) => {
        J._pipe++; J._pipeMs += ms;
        J.gpu.push({ t: +performance.now().toFixed(0), k: 'cpipe', ms: +ms.toFixed(1) });
      });
      wrap(GPUDevice.prototype, 'createShaderModule', (ms, a) => {
        J._shad++; J._shadMs += ms;
        J.gpu.push({ t: +performance.now().toFixed(0), k: 'shader', ms: +ms.toFixed(1), len: a?.[0]?.code?.length ?? 0 });
      });
      wrap(GPUQueue.prototype, 'writeBuffer', (ms, a) => { J._up += a?.[2]?.byteLength ?? 0; });
      wrap(GPUQueue.prototype, 'writeTexture', (ms, a) => { J._tex += a?.[1]?.byteLength ?? 0; });
      wrap(GPUQueue.prototype, 'copyExternalImageToTexture', (ms, a) => {
        const s = a?.[2] ?? {};
        const w = s.width ?? s[0] ?? 0, h = s.height ?? s[1] ?? 0;
        J._tex += w * h * 4; J._bmp++;
      });
    }
  } catch (e) { /* recorder must never break the page */ }
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) J.longtasks.push({ t: +e.startTime.toFixed(0), ms: +e.duration.toFixed(0) });
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { /* fine */ }
  let last = 0, n = 0;
  const loop = (t) => {
    if (last) {
      const f = { t: +t.toFixed(0), dt: +(t - last).toFixed(1) };
      if (J._up) { f.up = J._up; J._up = 0; }
      if (J._tex) { f.tex = J._tex; f.bmp = J._bmp; J._tex = 0; J._bmp = 0; }
      if (J._pipe) { f.pipe = J._pipe; f.pipeMs = +J._pipeMs.toFixed(1); J._pipe = 0; J._pipeMs = 0; }
      if (J._shad) { f.shad = J._shad; f.shadMs = +J._shadMs.toFixed(1); J._shad = 0; J._shadMs = 0; }
      J.frames.push(f);
    }
    last = t;
    if (++n % 60 === 0) {
      try { const b = globalThis.EW?.frame?.(); if (b) J.bills.push({ t: +t.toFixed(0), bill: b }); } catch (e) { /* fine */ }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
})();`;
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER });

// ---- run --------------------------------------------------------------------

const t0 = Date.now();
await cdp.send("Page.navigate", { url: `${BASE}/?name=jankbot&world=${WORLD}` });
for (let i = 0; i < 240 && !bootReady; i++) await sleep(250);
if (!bootReady) await die(2, "✗ client never booted", ...pageErrors.slice(0, 5));
console.log(`  ${dim(bootReady)}`);

if (GRASSDIAG) {
  await sleep(14_000);   // let the boot storm and warms fully settle
  if (PIXELS > 0) {
    await evalJson(`(() => { EW.renderer.setPixelRatio(${PIXELS}); return EW.renderer.getPixelRatio(); })()`);
    console.log(dim(`  pixelRatio forced to ${PIXELS} — GPU-bound regime`));
    await sleep(3000);
  }
  console.log(dim("  running EW.grassDiag()…"));
  const rows = await evalJson("EW.grassDiag({ secsPer: 4 })");
  if (rows) {
    const base = rows[0];
    for (const r of rows) {
      const d = r === rows[0] ? "" : `  Δ ${r.fps - base.fps >= 0 ? "+" : ""}${r.fps - base.fps}fps ${(r.ms - base.ms).toFixed(1)}ms`;
      console.log(`  ${String(r.phase).padEnd(28)} ${String(r.fps).padStart(4)}fps ${String(r.ms).padStart(6)}ms  worst ${String(r.worst).padStart(4)}ms${d}`);
    }
  } else console.log("  ✗ grassDiag returned nothing");
}
let heavyAt = 0;
if (HEAVYJOIN) {
  const heavyJoin = (id: string) => {
    const hws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    hws.onopen = () => hws.send(JSON.stringify({
      type: "join", world: WORLD, id, token: "",
      avatar: "eidoverse/assets/vrms/aletheia.vrm",   // library-relative, like resolveMyAvatarPath
    }));
    return hws;
  };
  await sleep(12_000);   // let the boot storm fully settle first
  heavyAt = Date.now() - t0;
  console.log(dim(`  heavy resident joins at t=${(heavyAt / 1000).toFixed(1)}s (aletheia.vrm, 21MB)…`));
  const first = heavyJoin("heavyguest");
  // leave, then a SECOND wearer of the same body: the first parse pooled at
  // departure, so the rejoin must be a pool hit — §19b's whole point. The
  // loadLog witness is a "pool-hit" line for aletheia.
  await sleep(10_000);
  console.log(dim("  heavy resident leaves (body → pool)…"));
  try { first.close(); } catch { /* fine */ }
  await sleep(5_000);
  console.log(dim(`  rejoins at t=${((Date.now() - t0) / 1000).toFixed(1)}s — expect pool-hit…`));
  heavyJoin("heavyguest2");
}
const remaining = SECS * 1000 - (Date.now() - t0);
if (remaining > 0) {
  console.log(dim(`  observing ${Math.round(remaining / 1000)}s more…`));
  await sleep(remaining);
}

// ---- harvest ----------------------------------------------------------------

const data = await evalJson(`(() => {
  const J = globalThis.__jank ?? {};
  const res = performance.getEntriesByType('resource').map((r) => ({
    name: r.name.split('/').slice(-1)[0].slice(0, 60),
    bytes: r.encodedBodySize || 0, start: +r.startTime.toFixed(0), end: +r.responseEnd.toFixed(0),
  }));
  let ew = {};
  try {
    ew = {
      residency: globalThis.EW?.residency?.(),
      gpu: globalThis.EW?.gpu?.(),
      frame: globalThis.EW?.frame?.(),
      grass: globalThis.EW?.grass?.(),
      warm: globalThis.EW?.warm?.(),
    };
  } catch (e) { /* partial is fine */ }
  return { frames: J.frames ?? [], gpu: J.gpu ?? [], bills: J.bills ?? [],
           longtasks: J.longtasks ?? [], res, ew,
           loadLog: globalThis.__loadLog ?? [] };
})()`);
if (!data || !data.frames?.length) await die(2, "✗ recorder captured nothing");

// ---- report -----------------------------------------------------------------

type Frame = { t: number; dt: number; up?: number; tex?: number; bmp?: number; pipe?: number; pipeMs?: number; shad?: number; shadMs?: number };
const frames: Frame[] = data.frames;
const dts = frames.map((f) => f.dt).sort((a, b) => a - b);
const pct = (p: number) => dts[Math.min(dts.length - 1, Math.floor(dts.length * p))];

console.log(`\n${bold("── frames")}  ${frames.length} recorded over ${((frames.at(-1)!.t - frames[0].t) / 1000).toFixed(1)}s`);
console.log(`  p50 ${pct(0.5)}ms · p95 ${pct(0.95)}ms · p99 ${pct(0.99)}ms · max ${dts.at(-1)}ms`);

// when did it get smooth? — last frame > 25ms, and the rolling-second view
const badFrames = frames.filter((f) => f.dt > 25);
if (badFrames.length) {
  const lastBad = badFrames.at(-1)!;
  console.log(`  ${badFrames.length} frames over 25ms; last one at t=${(lastBad.t / 1000).toFixed(1)}s`);
  // per-second worst frame, first 30 lines — the shape of the roughness
  const bySec = new Map<number, Frame>();
  for (const f of frames) {
    const s = Math.floor(f.t / 1000);
    if (!bySec.has(s) || f.dt > bySec.get(s)!.dt) bySec.set(s, f);
  }
  const secs = [...bySec.keys()].sort((a, b) => a - b).slice(0, 40);
  console.log(`\n  ${dim("worst frame per second (■ = 10ms):")}`);
  for (const s of secs) {
    const f = bySec.get(s)!;
    const bar = "■".repeat(Math.min(40, Math.round(f.dt / 10)));
    if (f.dt <= 20 && s > (lastBad.t / 1000)) continue;
    console.log(`  ${String(s).padStart(3)}s ${String(f.dt).padStart(7)}ms ${bar}`);
  }
}

console.log(`\n${bold("── worst 15 frames, attributed")}`);
const gpuEv: { t: number; k: string; ms: number; len?: number }[] = data.gpu;
const lts: { t: number; ms: number }[] = data.longtasks;
const resources: { name: string; bytes: number; start: number; end: number }[] = data.res;
const worst = [...frames].sort((a, b) => b.dt - a.dt).slice(0, 15).sort((a, b) => a.t - b.t);
for (const f of worst) {
  const w0 = f.t - f.dt, w1 = f.t;
  const parts: string[] = [];
  if (f.pipe) parts.push(`${f.pipe} pipeline${f.pipe > 1 ? "s" : ""} created (${f.pipeMs}ms sync)`);
  if (f.shad) parts.push(`${f.shad} shader${f.shad > 1 ? "s" : ""} (${f.shadMs}ms sync)`);
  if (f.up) parts.push(`buf ${mb(f.up)}`);
  if (f.tex) parts.push(`tex ${mb(f.tex)}${f.bmp ? ` (${f.bmp} img)` : ""}`);
  // pipelines created in the PREVIOUS ~3 frames — async compile lands here
  const prior = gpuEv.filter((g) => (g.k === "pipe" || g.k === "cpipe") && g.t >= w0 - 400 && g.t < w0).length;
  if (prior && !f.pipe) parts.push(`(${prior} pipelines created <400ms before — async compile stall)`);
  const lt = lts.filter((l) => l.t < w1 && l.t + l.ms > w0).reduce((s, l) => s + l.ms, 0);
  if (lt) parts.push(`longtask ${lt}ms`);
  const landed = resources.filter((r) => r.end >= w0 && r.end <= w1 && r.bytes > 200_000);
  if (landed.length) parts.push(`arrived: ${landed.map((r) => `${r.name} ${mb(r.bytes)}`).join(", ")}`);
  console.log(`  t=${(f.t / 1000).toFixed(1).padStart(5)}s ${String(f.dt).padStart(7)}ms  ${parts.join(" · ") || dim("(unattributed)")}`);
}

console.log(`\n${bold("── gpu totals")}`);
const pipes = gpuEv.filter((g) => g.k === "pipe" || g.k === "cpipe");
const shads = gpuEv.filter((g) => g.k === "shader");
const upTotal = frames.reduce((s, f) => s + (f.up ?? 0), 0);
const texTotal = frames.reduce((s, f) => s + (f.tex ?? 0), 0);
console.log(`  ${pipes.length} pipelines (${pipes.reduce((s, g) => s + g.ms, 0).toFixed(0)}ms sync) · ${shads.length} shader modules (${shads.reduce((s, g) => s + g.ms, 0).toFixed(0)}ms sync, largest ${Math.max(0, ...shads.map((s) => s.len ?? 0))} chars)`);
console.log(`  buffer uploads ${mb(upTotal)} · texture uploads ${mb(texTotal)}`);
// pipeline creation timeline, bucketed per second
const pipeBySec = new Map<number, number>();
for (const g of pipes) pipeBySec.set(Math.floor(g.t / 1000), (pipeBySec.get(Math.floor(g.t / 1000)) ?? 0) + 1);
console.log(`  pipeline creations by second: ${[...pipeBySec.entries()].sort((a, b) => a[0] - b[0]).map(([s, n]) => `${s}s:${n}`).join(" ")}`);

console.log(`\n${bold("── network")}`);
const totalBytes = resources.reduce((s, r) => s + r.bytes, 0);
console.log(`  ${resources.length} requests, ${mb(totalBytes)}`);
for (const r of [...resources].sort((a, b) => b.bytes - a.bytes).slice(0, 8)) {
  console.log(`  ${mb(r.bytes).padStart(8)}  ${r.name}  ${dim(`done at ${(r.end / 1000).toFixed(1)}s`)}`);
}

if (data.bills?.length) {
  // EW.frame() returns an ARRAY of {name, ms, every, enabled} (ms is an
  // EWMA, α=0.05 — it shows sustained load, never a single spike)
  console.log(`\n${bold("── frame bill over time")}  ${dim("(per-system EWMA ms, 1Hz samples — top 5 at each)")}`);
  for (const b of data.bills.filter((_: any, i: number) => i % 5 === 0 || i === data.bills.length - 1)) {
    const rows = (Array.isArray(b.bill) ? b.bill : [])
      .filter((s: any) => (s?.ms ?? 0) > 0.05)
      .sort((x: any, y: any) => y.ms - x.ms).slice(0, 5);
    console.log(`  ${(b.t / 1000).toFixed(0).padStart(3)}s  ${rows.map((s: any) => `${s.name} ${s.ms.toFixed(1)}`).join(" · ") || dim("(idle)")}`);
  }
}

if (data.loadLog?.length) {
  console.log(`\n${bold("── load log")}`);
  for (const l of data.loadLog.slice(0, 60)) console.log(`  ${dim(String(l))}`);
}
if (data.ew?.residency) {
  const r = data.ew.residency;
  console.log(`\n${bold("── residency at end")}  real=${r.real} standins=${r.standins} promotes=${r.promotes} demotes=${r.demotes}`);
}
if (data.ew?.grass?.field) {
  const g = data.ew.grass;
  const w = data.ew.warm;
  console.log(`${bold("── grass tiles")}  ${g.strokes.map((s: any) =>
    `${s.stroke}:${s.tiled ? `${s.visible}/${s.tiles}t` : "whole"} ${s.drawn}/${s.planted}`).join(" · ")}`);
  if (w) console.log(`${bold("── warm queue")}  done=${w.done} failed=${w.failed} pending=${w.pending}`);
}

// ---- --wide verdict: the join gate's network witness ------------------------
let wideFailed = 0;
if (WIDE) {
  console.log(`\n${bold("── far-city gate")}`);
  const fetched = new Set(resources.map((r) => r.name.split("?")[0]));
  const base = (lib: string) => lib.split("/").at(-1)!.slice(0, 60);
  for (const lib of FAR_LIBS) {
    const hit = fetched.has(base(lib));
    if (hit) wideFailed++;
    console.log(`  ${hit ? "\x1b[31m✗ FETCHED\x1b[0m" : "\x1b[32m✓ never fetched\x1b[0m"}  ${base(lib)}`);
  }
  for (const lib of NEAR_LIBS) {
    const hit = fetched.has(base(lib));
    if (!hit) wideFailed++;
    console.log(`  ${hit ? "\x1b[32m✓ loaded\x1b[0m" : "\x1b[31m✗ NEVER LOADED\x1b[0m"}  ${base(lib)} ${dim("(near)")}`);
  }
  const r = data.ew?.residency;
  const standinsOk = (r?.standins ?? 0) + (r?.loading ?? 0) >= FAR_LIBS.length;
  if (!standinsOk) wideFailed++;
  console.log(`  ${standinsOk ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} far entities are stand-ins/unloaded, not absent  ${dim(`real=${r?.real} standins=${r?.standins} loading=${r?.loading}`)}`);
  console.log(`\n${wideFailed === 0 ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} — far-city gate`);
}

const knownBenign = (l: string) => l.includes("favicon") || l.includes("Autoplay");
const realErrors = pageErrors.filter((l) => !knownBenign(l));
if (realErrors.length) {
  console.log(`\n${bold("── page errors")}`);
  for (const e of realErrors.slice(0, 5)) console.log(`  ✗ ${e}`);
}

console.log("");
await cleanup();
process.exit(wideFailed ? 1 : 0);
