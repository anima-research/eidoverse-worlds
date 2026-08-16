// paritybench — shadow-fold parity, measured in a REAL browser.
//
//   bun tools/paritybench.ts                     # headless Edge, own scratch sequencer
//   bun tools/paritybench.ts --headed            # same, with a window you can watch
//   bun tools/paritybench.ts --console           # echo every page console line
//   CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe" bun tools/paritybench.ts
//   EIDOVERSE_DIR=/path/to/eidoverse-video PORT=8970 bun tools/paritybench.ts
//
// tools/state-test.ts proves shared/fold.js folds correctly in a vacuum, and
// tools/compfold-test.ts proves the server's fold and the agent's agree. Neither
// runs the browser, and the browser is where the migration actually lives: the
// scene the client builds and the shadow fold in client/lib/state.js stand side
// by side there, fed by the same socket. EW.foldParity() (client/lib/parity.js)
// is the number; this file is the machine that makes the number happen without a
// human in a tab. Boot a scratch sequencer, join it with a headless Chromium,
// drive a build sequence over a SECOND socket, then read the probe over CDP.
//
// ONE PASS since the 3c deletion: the realizers are the only writers, and
// the probe measures the scene they build against the fold that drove them.
// (During the migration this ran a second, ?realize=0 pass against legacy
// applyEntry — the original House-rule-1 mirror. That seam is gone; what
// keeps this pass honest now is the reconnect leg, the mount-pose bucket,
// and the server-fold witness below.)
//
// The probe is read TWICE per pass, and a third socket vouches for the reading.
// Read only at the end of a build-then-teardown sequence and the comp-rich
// entity is already gone: "2 entities checked, 0 diffs" is then two empty bags
// agreeing about nothing. So parity is read mid-sequence — five components
// alive, a sixth deleted, cargo mounted, a body in the seat — and again after
// the teardown; and a spectator join prints what the SERVER's fold says was
// there, so a green run cannot be a green run over an empty world.
//
// Four things this cost to learn, so nobody pays twice:
//
//  1. about:blank IS NOT A SECURE CONTEXT, so `navigator.gpu` does not exist
//     there. The first version of this harness asked for an adapter before
//     navigating and concluded — confidently, wrongly — that this machine had
//     no WebGPU at all. Ask only after the document is really the world's.
//  2. Edge opens an `edge://sync-confirmation-dialog/` PAGE target on a fresh
//     profile, and it is often first in /json/list. Attach to that and you
//     evaluate your parity probe inside a sign-in dialog. Filter by scheme.
//  3. Headless Edge on Windows needed NO gpu flags at all (measured: a real
//     nvidia / lovelace adapter under --headless=new). Reaching for more can
//     make it worse: `--enable-unsafe-webgpu --use-angle=swiftshader` measured
//     `adapter null` on this box. `--enable-unsafe-webgpu` alone is passed
//     because it costs nothing here and rescues stricter boxes; anything else
//     you want to try goes in EDGE_FLAGS.
//  4. On Windows `bun` on PATH is an npm .cmd shim, so Bun.spawn(["bun", …])
//     hands back the SHIM's pid and killing it orphans the real bun.exe — two
//     abandoned sequencers, found by a third run of this bench discovering
//     :8970 and :8971 both occupied. Spawn process.execPath.
//
// Exit 0 only if EVERY pass is green: parity.ok at both readings, the witness
// says the sequence really landed, and no `[state] seq gap` warning appeared (a
// gap means the shadow missed entries, which makes an "ok" meaningless). Exit 2
// is reserved for "the environment could not run the client at all" — a missing
// asset library, a browser that never produced a GPU adapter — so a red run is
// never mistaken for drift.
//
// Wire facts it leans on: join is {type:'join', world, id, token} and uses `id`,
// never `name`; verbs are {type:'verb', verb, args} capped at 12 per 4s (paced
// at 420ms here, so a refusal is a finding); the browser carries the door token
// as `?key=` (client/lib/core.js CONFIG), and with JOIN_TOKEN empty the door is
// simply open — correct for a loopback scratch box, and one less moving part.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const has = (n: string) => args.includes(`--${n}`);
const HEADED = has("headed");
const ECHO = has("console");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EIDOVERSE_DIR = process.env.EIDOVERSE_DIR ?? join(ROOT, "..", "eidoverse-video");
// A WebGPU-capable Chromium, wherever this machine keeps one. CHROME env
// always wins; otherwise the first of these that exists. (The old default
// was the Windows Edge path alone — unrunnable on a MacBook.)
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
function findBrowser(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const found = (BROWSER_CANDIDATES[process.platform] ?? []).find((p) => existsSync(p));
  return found ?? (BROWSER_CANDIDATES[process.platform]?.[0] ?? "chrome");
}
const CHROME = findBrowser();
// Empty = open door. Set JOIN_TOKEN to exercise the door; the browser gets it
// as ?key= and the driver socket as join.token.
const TOKEN = process.env.JOIN_TOKEN ?? "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

// ---- preflight --------------------------------------------------------------

if (!existsSync(join(EIDOVERSE_DIR, "eidoverse", "assets"))) {
  console.error(`\n✗ asset library not found at ${EIDOVERSE_DIR}`);
  console.error(`  The sequencer needs an eidoverse-video checkout to serve /library.`);
  console.error(`  Point EIDOVERSE_DIR at one:  EIDOVERSE_DIR=D:\\Anima\\eidoverse-video bun tools/paritybench.ts\n`);
  process.exit(2);
}
if (!existsSync(CHROME)) {
  console.error(`\n✗ no browser found (tried ${(BROWSER_CANDIDATES[process.platform] ?? []).length} known locations, last resort: ${CHROME})`);
  console.error(`  Set CHROME to any Chromium with WebGPU (Edge, Chrome, Brave), e.g.:`);
  console.error(`    CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" bun tools/paritybench.ts\n`);
  process.exit(2);
}

/** A port nothing answers on AND that we can bind — the scratch-sequencer rule
 *  is never to develop against a port someone lives on, and this is that rule
 *  mechanized. */
function freePort(from: number, tries = 40): number {
  for (let p = from; p < from + tries; p++) {
    try {
      const s = Bun.serve({ port: p, hostname: "127.0.0.1", fetch: () => new Response("") });
      s.stop(true);
      return p;
    } catch { /* someone lives there */ }
  }
  throw new Error(`no free port in ${from}..${from + tries}`);
}

const PORT = process.env.PORT ? Number(process.env.PORT) : freePort(8970);
const DEBUG_PORT = freePort(9970);
const BASE = `http://localhost:${PORT}`;
const SCRATCH = mkdtempSync(join(tmpdir(), "ew-paritybench-"));
const WORLDS_DIR = join(SCRATCH, "worlds");
const PROFILE = join(SCRATCH, "edge-profile");
const SEQ_LOG = join(SCRATCH, "sequencer.log");

// ---- teardown, once, from wherever we die -----------------------------------

let seq: Bun.Subprocess | null = null;
let edge: Bun.Subprocess | null = null;
let cleaned = false;
/** Kill by PID, never by image name: an operator's own browser and the show's
 *  sequencer must survive a bench run. `taskkill /PID /T` is still PID-scoped —
 *  it reaps the tree under OUR pid, which is how a Chromium's renderer children
 *  stop being orphans. */
function reap(p: Bun.Subprocess | null) {
  if (!p) return;
  try { p.kill(); } catch { /* already gone */ }
  if (process.platform === "win32" && typeof p.pid === "number") {
    try { Bun.spawnSync(["taskkill", "/PID", String(p.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }); }
    catch { /* nothing to reap */ }
  }
}
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  reap(edge);
  reap(seq);
  await sleep(400);                     // let the profile's file locks drop
  try { rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
  // Say so if we leaked. A bench that quietly leaves a sequencer holding a port
  // is how the next run silently moves to a different port and nobody notices
  // until there are five of them.
  const alive = await fetch(`${BASE}/avatars`).then((r) => r.ok).catch(() => false);
  if (alive) console.error(`\n  ⚠ something still answers on :${PORT} — a sequencer survived cleanup`);
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

// ---- 1. a sequencer of our own ---------------------------------------------

console.log(`\n${bold("fold parity in a real browser")} — scratch sequencer on :${PORT}`);
console.log(dim(`  library ${EIDOVERSE_DIR}`));
console.log(dim(`  scratch ${SCRATCH}`));
console.log(dim(`  browser ${CHROME}${HEADED ? " (headed)" : " (headless)"}`));

// process.execPath, NOT "bun": on Windows the `bun` on PATH is an npm .cmd
// shim, so Bun.spawn hands back the SHIM's pid. Killing that leaves the real
// bun.exe holding :PORT forever — two orphaned sequencers, discovered by a
// third run of this bench finding 8970 and 8971 both occupied. The shim is not
// in the middle if we spawn the interpreter we are already running under.
seq = Bun.spawn([process.execPath, join(ROOT, "server", "server.ts")], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT), JOIN_TOKEN: TOKEN, EIDOVERSE_DIR, WORLDS_DIR,
    // A brand-new log every run: the bench must never append to worlds anyone
    // lives in (they are append-only and forever).
    RECORD_FRAMES: "0",
  },
  stdout: Bun.file(SEQ_LOG),
  stderr: Bun.file(SEQ_LOG),
});
{
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { up = (await fetch(`${BASE}/avatars`)).ok; } catch { await sleep(250); }
  }
  if (!up) {
    await die(2, `\n✗ the scratch sequencer never came up on :${PORT}`,
      `  log tail:\n${(await Bun.file(SEQ_LOG).text().catch(() => "(no log)")).split("\n").slice(-20).join("\n")}`);
  }
}
console.log(`  sequencer up`);

// ---- 2. CDP mechanics (bootbench's, minus the macOS assumptions) -----------

type Cdp = {
  send<T = any>(method: string, params?: unknown): Promise<T>;
  ws: WebSocket;
};
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

const EXTRA = (process.env.EDGE_FLAGS ?? "").split(" ").filter(Boolean);
edge = Bun.spawn([
  CHROME,
  ...(HEADED ? [] : ["--headless=new"]),
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${PROFILE}`,
  "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--disable-background-networking", "--disable-sync", "--mute-audio",
  "--window-size=1280,800",
  // Harmless where WebGPU already works, decisive where the box is stricter.
  "--enable-unsafe-webgpu",
  ...EXTRA,
  "about:blank",
], { stdout: "ignore", stderr: "ignore" });

/** The page target we want is an ordinary web one. Edge's fresh-profile
 *  sign-in dialog is ALSO type "page", and it is frequently first. */
let target: any = null;
for (let i = 0; i < 120 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    target = list.find((t: any) => t.type === "page"
      && !String(t.url).startsWith("edge://") && !String(t.url).startsWith("chrome"));
  } catch { /* debugger not listening yet */ }
  if (!target) await sleep(150);
}
if (!target) {
  await die(2, `\n✗ ${CHROME} never exposed a page target on :${DEBUG_PORT}`,
    `  Try --headed, or add flags with EDGE_FLAGS=…`);
}
const version = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then((r) => r.json()).catch(() => ({}));
console.log(`  ${version.Browser ?? "browser"} attached on :${DEBUG_PORT}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res as any; ws.onerror = rej as any; });
const cdp = cdpOn(ws);

// ---- 3. watch the page talk -------------------------------------------------

const consoleLines: string[] = [];
const pageErrors: string[] = [];
const seqGaps: string[] = [];
let bootReady = "";
const textOf = (a: any) =>
  a?.value !== undefined ? String(a.value)
    : a?.description !== undefined ? String(a.description)
      : a?.preview?.description !== undefined ? String(a.preview.description) : "";
ws.addEventListener("message", (ev: any) => {
  const m = JSON.parse(String(ev.data));
  if (m.method === "Runtime.consoleAPICalled") {
    const line = (m.params.args ?? []).map(textOf).join(" ");
    consoleLines.push(`${m.params.type}: ${line}`);
    if (ECHO) console.log(dim(`    [page ${m.params.type}] ${line}`));
    if (line.includes("[state] seq gap")) seqGaps.push(line);
    if (line.startsWith("[boot] ready")) bootReady = line;
    if (m.params.type === "error") pageErrors.push(line);
  } else if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    const line = d?.exception?.description ?? d?.text ?? "(exception)";
    consoleLines.push(`exception: ${line}`);
    pageErrors.push(String(line));
    if (ECHO) console.log(dim(`    [page throw] ${line}`));
  }
});
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
await cdp.send("Log.enable");

// ---- 4. the pass -------------------------------------------------------------
//
// The realizers own the scene (client/lib/realize/); the probe measures what
// they built against the fold that drove them. The reading is kept honest by
// the reconnect leg (reconcile over a live scene), the mount-pose bucket, the
// refusal gate, and the server-fold witness — not by a second implementation.

const evalJson = async (expr: string) => {
  const r = await cdp.send<any>("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
};

type Driver = {
  ws: WebSocket;
  snapshot: any;
  errors: string[];
  verb(verb: string, args: unknown): Promise<void>;
  close(): void;
};
function joinSocket(world: string, id: string, extra: Record<string, unknown> = {}): Promise<Driver> {
  return new Promise((resolve, reject) => {
    const dws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const self: Driver = {
      ws: dws, snapshot: null, errors: [],
      // 12 verbs / 4s server-side: pace them so a refusal is a finding and not
      // an artifact of the window (fp-snap-probe / locktest precedent).
      verb: async (verb, vargs) => { dws.send(JSON.stringify({ type: "verb", verb, args: vargs })); await sleep(420); },
      close: () => { try { dws.close(); } catch { /* already */ } },
    };
    dws.onopen = () => dws.send(JSON.stringify({ type: "join", world, id, token: TOKEN, ...extra }));
    dws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "snapshot") { self.snapshot = m.state; resolve(self); }
      if (m.type === "error") { self.errors.push(String(m.error)); console.log(`  ${dim(`${id} refused: ${m.error}`)}`); }
    };
    dws.onerror = (e) => reject(new Error(`socket ${id}: ${String(e)}`));
    setTimeout(() => reject(new Error(`${id} never got a snapshot`)), 15_000);
  });
}

// props/ball.glb is tracked in this repo (assets/opt/props/ball.glb, 6.7KB), so
// it is the one lib guaranteed to EXIST and to load fast. That matters more
// than it looks: a 404 lib leaves the legacy path holding a reserved null
// forever while the fold has already moved on, and the harness would report
// drift that is really a missing file.
const LIB = "props/ball.glb";

// ---- 5. read the probe, twice per pass -------------------------------------
//
// TWO readings, because one is a trap. Read only at the end and the comp-rich
// entity has already been removed: the probe reports "2 entities checked" with
// two empty bags and calls it agreement. So the first read happens while
// bench1 is ALIVE — five components, a deleted sixth, cargo aboard, a body in
// its seat — and the second after the deletions and the removal.
//
// The shadow folds synchronously; the scene side awaits GLB bytes. A diff that
// exists for 200ms and then does not is realization lag, not drift — so poll
// until it clears, and report whatever the LAST reading said.

type Parity = {
  ok?: boolean; checked?: number; hydrated?: boolean; lastSeq?: number;
  onlyShadow?: string[]; onlyLegacy?: string[];
  // …plus one array per comparison the probe makes. NOT enumerated here on
  // purpose: `identityDiffs` appeared mid-writing of this file (commit cfc45fc,
  // kind + lib), and a harness that names the buckets it knows would have
  // printed a green summary while ignoring a red one. Every `*Diffs` key is
  // reported, whatever it is called, and `ok` — the probe's own verdict, which
  // already accounts for buckets this file has never heard of — is the gate.
  [k: string]: unknown;
};
const diffBuckets = (p: Parity) =>
  Object.entries(p).filter(([k, v]) => /Diffs$/.test(k) && Array.isArray(v)) as [string, any[]][];

async function readParity(label: string, indent = "  "): Promise<{ p: Parity; tries: number }> {
  await sleep(1200);
  let p: Parity = {};
  let tries = 0;
  for (; tries < 8; tries++) {
    const raw = await evalJson(`JSON.stringify(EW.foldParity())`);
    p = (typeof raw === "string" ? JSON.parse(raw) : raw) ?? {};
    if (p.ok) break;
    await sleep(700);
  }
  const buckets = diffBuckets(p);
  console.log("");
  console.log(`${indent}${p.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗ DRIFT\x1b[0m"} ${bold(label)}`
    + ` — ${p.checked} entities checked · +${p.onlyShadow?.length ?? "?"} shadow-only`
    + ` · +${p.onlyLegacy?.length ?? "?"} legacy-only`
    + buckets.map(([k, v]) => ` · ${v.length} ${k.replace(/Diffs$/, "")} diffs`).join(""));
  console.log(`${indent}  hydrated=${p.hydrated} lastSeq=${p.lastSeq}`
    + `  ${dim(`probe reports: ${["onlyShadow", "onlyLegacy", ...buckets.map(([k]) => k)].join(", ")}`)}`
    + (tries ? `  ${dim(`(settled after ${tries} re-read${tries > 1 ? "s" : ""})`)}` : ""));
  if (!p.ok) {
    if (p.onlyShadow?.length) console.log(`${indent}  shadow-only ids: ${JSON.stringify(p.onlyShadow)}`);
    if (p.onlyLegacy?.length) console.log(`${indent}  legacy-only ids: ${JSON.stringify(p.onlyLegacy)}`);
    for (const [name, rows] of buckets) {
      for (const d of rows) {
        console.log(`${indent}  ${name.replace(/Diffs$/, "")} ${d.id}:`);
        console.log(`${indent}    legacy ${JSON.stringify(d.legacy)}`);
        console.log(`${indent}    shadow ${JSON.stringify(d.shadow)}`);
      }
    }
  }
  return { p, tries };
}

// ---- 6. one pass = one side of the seam, in a world of its own --------------

async function runPass(name: string, extraParams: string): Promise<boolean> {
  const world = `paritybench-${name}-${Math.random().toString(36).slice(2, 7)}`;
  const gapsBefore = seqGaps.length;
  console.log(`\n${bold(`── pass: ${name}`)}  ${dim(`world ${world}`)}`);

  // The driver joins FIRST and owns the world (first embodied joiner):
  // the 3c recipe drives owner-rank verbs (terrain/grass/sky/weather/
  // grant), which a second joiner's builder rank cannot. The browser joins
  // after, as a pure observer — every entry under test still arrives over
  // the wire, not from the tab's own hand.
  const driver = await joinSocket(world, "paritydriver").catch(async (e) => {
    await die(2, `\n✗ ${e}`, `  sequencer log: ${SEQ_LOG}`);
    return null as never;
  });
  console.log(`  driver joined first — owns the world`);

  const url = `${BASE}/?name=paritybot&world=${world}`
    + (TOKEN ? `&key=${encodeURIComponent(TOKEN)}` : "") + extraParams;
  console.log(`  navigating ${url}`);
  bootReady = "";
  await cdp.send("Page.navigate", { url });

  /** Does the client exist at all yet? `await renderer.init()` sits at module
   *  top level in client/lib/core.js, so a WebGPU failure means main.js never
   *  runs and globalThis.EW never appears — the symptom is silence, and the
   *  reason is only in the page console. The world name is part of the test so
   *  the PREVIOUS pass's still-live EW cannot answer for this one. */
  let live = false;
  for (let i = 0; i < 200 && !live; i++) {
    live = await evalJson(
      `!!(globalThis.EW && typeof EW.foldParity === 'function' && EW.net && EW.net.joined === true`
      + ` && location.search.includes(${JSON.stringify(world)}))`,
    ).catch(() => false);
    if (!live) await sleep(300);
  }
  if (!live) {
    const diag = await evalJson(`(async () => {
      let adapter = 'not asked';
      try {
        if (!navigator.gpu) adapter = 'navigator.gpu MISSING (secure=' + isSecureContext + ')';
        else { const a = await navigator.gpu.requestAdapter(); adapter = a ? 'adapter ok' : 'requestAdapter -> null'; }
      } catch (e) { adapter = 'requestAdapter threw: ' + String(e); }
      return JSON.stringify({ href: location.href, ew: !!globalThis.EW,
        joined: globalThis.EW ? !!(EW.net && EW.net.joined) : null, adapter });
    })()`).catch((e) => `{"error":${JSON.stringify(String(e))}}`);
    const gpuish = consoleLines.filter((l) => /gpu|webgpu|adapter|device|WGSL/i.test(l));
    const env = /MISSING|requestAdapter -> null|threw/.test(String(diag));
    await die(env ? 2 : 1,
      `\n✗ the client never hydrated (pass ${name})`,
      `  page: ${diag}`,
      gpuish.length ? `  gpu-ish console lines:\n${gpuish.map((l) => `    ${l}`).join("\n")}`
        : consoleLines.length ? `  last console lines:\n${consoleLines.slice(-12).map((l) => `    ${l}`).join("\n")}`
          : `  the page said NOTHING — it never reached the client's own code`,
      env
        ? `\n  This reads as an ENVIRONMENT problem, not drift. The client requires WebGPU.\n`
          + `  Try:  bun tools/paritybench.ts --headed\n`
          + `  or:   EDGE_FLAGS="--enable-features=Vulkan" bun tools/paritybench.ts\n`
          + `  (note: --use-angle=swiftshader makes it WORSE — measured adapter null)\n`
        : `\n  The GPU came up but the join did not — check the sequencer log:\n  ${SEQ_LOG}\n`);
  }
  console.log(`  client joined${bootReady ? ` — ${bootReady.split("(")[0].trim()}` : ""}`);
  // The splash lifts before the last asset lands; give realization a beat so the
  // scene side is not still mid-load when the driver starts talking.
  await sleep(1500);

  console.log(`  driver authoring (owner rank)`);

  await driver.verb("spawn", { id: "bench1", lib: LIB, pos: [0, 0, 0], yaw: 0 });
  await driver.verb("comp", { id: "bench1", type: "sockets", data: { seat: { pos: [0, 0.55, 0], yaw: 0, pose: "sitchair" } } });
  await driver.verb("comp", { id: "bench1", type: "reactions", data: { push: { impulse: 0.35 } } });
  await driver.verb("comp", { id: "bench1", type: "sparkle", data: { hue: "amber" } });   // a type NOBODY knows
  await driver.verb("motion", { id: "bench1", type: "pendulum", axis: [1, 0, 0], pivot: [0, 2.4, 0], amp: 0.2, period: 3.2, damp: 0.06 });
  await driver.verb("comp", { id: "bench1", type: "particles", data: { preset: "fire", seed: 99, origin: [0, 0.25, 0], count: 120 } });
  await driver.verb("comp", { id: "bench1", type: "doomed", data: { gone: "soon" } });
  await driver.verb("spawn", { id: "crate1", lib: LIB, pos: [3, 0, 3], yaw: 0 });
  await driver.verb("mount", { id: "crate1", to: "bench1", offset: [0, 0.8, 0] });        // cargo
  await driver.verb("comp", { id: "bench1", type: "doomed", data: null });                // deletion
  await driver.verb("place", { id: "bench1", pos: [1, 0, 1], yaw: 0.4 });
  await driver.verb("place", { id: "bench1", pos: [1.5, 0, 0.5], yaw: 1.1, scale: 1.2 });
  await driver.verb("light", { id: "lamp1", pos: [2, 2, 2], color: "#ffd9a0", intensity: 18, range: 9 });
  await driver.verb("light", { id: "lamp1", intensity: 30 });                             // partial UPDATE, not a respawn
  // 3c — the environment/social/causes paths. The driver is the world's
  // first embodied joiner and therefore its owner: terrain/grass/sky/grant
  // are in rank. Bags mirror what the build panel actually sends; a page
  // error from any of these fails the run (the console watch is armed).
  await driver.verb("terrain", { seed: 7, size: 160, segments: 200, amplitude: 2.5, flatRadius: 16,
    layers: [{ color: "#4a5d33", repeat: 16 }] });
  await driver.verb("grass", { species: "grass", width: 90, depth: 80, center: [0, 0], height: 0.5 });
  await driver.verb("sky", { hours: 9, rate: 0, clouds: "cumulus" });
  await driver.verb("weather", { weather: "rain" });                                      // merges onto the standing sky
  await driver.verb("grant", { id: "parityfriend", role: "builder", gen: true });         // roles mirror + narration
  await driver.verb("say", { text: "parity check — rain over the bench" });               // chat line + recentChat fold
  await driver.verb("mount", { id: "paritydriver", to: "bench1", slot: "seat" });          // a BODY mount (self-rank)

  const mid = await readParity(`${name}: mid-sequence (bench alive, bag full, body seated)`);

  // Reconnect leg (review finding B3): re-hydration over a LIVE scene is the
  // reconcile ∘ reconcile = reconcile contract (§11.4), and it is exactly
  // where a non-idempotent realizer shows — the crate must still sit at its
  // mount offset afterwards, not at its pre-mount absolute pose re-applied
  // in the carrier's frame. Close the page's socket; the client's own retry
  // rejoins and hydrates again.
  await evalJson(`(EW.net.ws.close(), true)`);
  let rejoined = false;
  for (let i = 0; i < 60 && !rejoined; i++) {
    await sleep(500);
    rejoined = await evalJson(`!!(EW.net && EW.net.joined === true)`).catch(() => false);
  }
  if (!rejoined) {
    await die(1, `\n✗ the client never rejoined after the forced reconnect (pass ${name})`,
      `  sequencer log: ${SEQ_LOG}`);
  }
  await sleep(2000);   // let the second reconcile settle
  const re = await readParity(`${name}: after reconnect (reconcile over a live scene)`);

  // Non-vacuity receipt, from the SERVER's own fold: a third socket joins and
  // its snapshot says what the browser was actually asked to agree about.
  // "3 entities checked, 0 diffs" only means something if one of those three
  // carried a real component bag and a body was really in its seat.
  const eye = await joinSocket(world, "parityeye", { spectate: true }).catch(() => null);
  const bag = eye?.snapshot?.entities?.bench1?.comp ?? {};
  const bagKeys = Object.keys(bag).sort();
  const seated = eye?.snapshot?.mounts?.paritydriver?.to === "bench1";
  const cargo = eye?.snapshot?.entities?.crate1?.parent?.to === "bench1";
  console.log(`\n  ${dim("witness (server fold):")} bench1 bag = ${JSON.stringify(bagKeys)}`
    + ` · doomed ${bag.doomed === undefined ? "deleted" : bold("STILL THERE")}`
    + ` · cargo ${cargo ? "aboard" : bold("MISSING")} · body ${seated ? "seated" : bold("NOT SEATED")}`);
  const WANT = ["motion", "particles", "reactions", "sockets", "sparkle"];
  const thin = WANT.filter((k) => !bagKeys.includes(k));
  let vacuous = false;
  if (thin.length || bag.doomed !== undefined || !cargo || !seated) {
    vacuous = true;
    console.log(`  ${bold("✗ the sequence did not fully land")} — missing ${JSON.stringify(thin)}`
      + `; a green parity here would be vacuous`);
  }

  await driver.verb("dismount", { id: "paritydriver", pos: [2, 0, 2], yaw: 1.2 });
  await driver.verb("comp", { id: "bench1", type: "sparkle", data: null });               // live deletion
  await driver.verb("remove", { id: "bench1" });                                          // a parent with cargo aboard
  await driver.verb("say", { text: "parity, please" });
  const post = await readParity(`${name}: post-teardown (deletions + removed carrier)`);

  if (driver.errors.length) {
    console.log(`\n  ${bold("note")}: the driver was refused ${driver.errors.length} verb(s):`);
    for (const e of driver.errors.slice(0, 6)) console.log(`    ${e}`);
  }
  const gaps = seqGaps.slice(gapsBefore);
  if (gaps.length) {
    // A gap means the shadow missed entries; "ok" past a gap is a coincidence,
    // not a proof, so it fails the pass either way.
    console.log(`\n  ${bold("seq gaps")} — the shadow missed entries, so parity proves nothing:`);
    for (const g of gaps) console.log(`    ${g}`);
  }
  eye?.close();
  driver.close();
  // Driver refusals fail the pass outright: the vacuous-green incident (the
  // owner-rank verbs silently bouncing) is exactly one unread refusal away.
  return Boolean(mid.p.ok) && Boolean(re.p.ok) && Boolean(post.p.ok)
    && !vacuous && !gaps.length && !driver.errors.length;
}

// ---- 7. both sides, then the verdict ---------------------------------------

const PASSES: [string, string][] = [];
// One path since the 3c deletion: the realizers own the scene, and the
// probe measures them against the fold. (--legacy-only/--realize-only died
// with the ?realize seam.)
PASSES.push(["realize", ""]);
const results: [string, boolean][] = [];
for (const [name, params] of PASSES) results.push([name, await runPass(name, params)]);

if (pageErrors.length) {
  console.log(`\n  ${dim(`page errors across the run (informational, ${pageErrors.length}):`)}`);
  for (const e of pageErrors.slice(0, 6)) console.log(dim(`    ${e}`));
}

const failed = results.some(([, ok]) => !ok);
console.log("");
for (const [name, ok] of results) {
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}`
    + dim(name === "realize" ? "  (models realizer owns the scene)" : "  (legacy applyEntry owns the scene)"));
}
console.log(`\n${failed ? "\x1b[31mFAIL\x1b[0m" : "\x1b[32mPASS\x1b[0m"} — fold parity in ${CHROME.split(/[\\/]/).pop()}\n`);
try { ws.close(); } catch { /* done */ }
await cleanup();
process.exit(failed ? 1 : 0);
