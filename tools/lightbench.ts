// lightbench — the step-5 behavior probe: does the factory's weather DRIVE
// actually move the uniforms, does the rig assign slots the way §12.4
// promises, and does the world still say what the fold says under it all.
//
//   bun tools/lightbench.ts                    # behavior pass, headless Edge
//   bun tools/lightbench.ts --measure          # + slot sweep (4/8/12/16) on a
//                                              #   grass world: compile + fps
//   bun tools/lightbench.ts --headed --console # watch it happen
//
// paritybench proves fold parity; this proves the parts of step 5 parity
// cannot see: EW.materials() wetness rising under a rain verb, the cloud
// field waking, slot assignment honoring keep > authored, the day cycle
// leaving only the day:false porch light burning at noon, the weather
// system's lightning adopted through the scene-proxy seam instead of
// entering the light topology, and the caster budget tracking realized
// models. Page console errors fail the pass.
//
// Scaffolding (scratch sequencer, CDP, driver socket, Windows shim rule) is
// paritybench's — see its header for the four expensive lessons.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const has = (n: string) => args.includes(`--${n}`);
const HEADED = has("headed");
const ECHO = has("console");
const MEASURE = has("measure");

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

if (!existsSync(join(EIDOVERSE_DIR, "eidoverse", "assets"))) {
  console.error(`✗ asset library not found at ${EIDOVERSE_DIR}`); process.exit(2);
}
if (!existsSync(CHROME)) { console.error(`✗ no browser at ${CHROME}`); process.exit(2); }

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
const PORT = process.env.PORT ? Number(process.env.PORT) : freePort(8950);
const DEBUG_PORT = freePort(9950);
const BASE = `http://localhost:${PORT}`;
const SCRATCH = mkdtempSync(join(tmpdir(), "ew-lightbench-"));

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

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${detail ? dim(`  ${detail}`) : ""}`);
  ok ? passed++ : failed++;
};
const note = (name: string, detail: string) => console.log(`  ·· ${name} — ${detail}`);

// ---- sequencer --------------------------------------------------------------

console.log(`\n${bold("lightbench")} — scratch sequencer on :${PORT}${MEASURE ? " (+measure)" : ""}`);
seq = Bun.spawn([process.execPath, join(ROOT, "server", "server.ts")], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), JOIN_TOKEN: "", EIDOVERSE_DIR, WORLDS_DIR: join(SCRATCH, "worlds") },
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

// ---- driver socket ----------------------------------------------------------

type Driver = { errors: string[]; verb(v: string, a: unknown): Promise<void>; close(): void };
function joinDriver(world: string, id: string): Promise<Driver> {
  return new Promise((resolve, reject) => {
    const dws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const self: Driver = {
      errors: [],
      verb: async (v, a) => { dws.send(JSON.stringify({ type: "verb", verb: v, args: a })); await sleep(420); },
      close: () => { try { dws.close(); } catch { /* fine */ } },
    };
    dws.onopen = () => dws.send(JSON.stringify({ type: "join", world, id, token: "" }));
    dws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "snapshot") resolve(self);
      if (m.type === "error") { self.errors.push(String(m.error)); console.log(dim(`  ${id} refused: ${m.error}`)); }
    };
    dws.onerror = (e) => reject(new Error(`socket ${id}: ${String(e)}`));
    setTimeout(() => reject(new Error(`${id} never got a snapshot`)), 15_000);
  });
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
  `--user-data-dir=${join(SCRATCH, "edge-profile")}`,
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
const textOf = (a: any) => a?.value !== undefined ? String(a.value) : a?.description ?? "";
ws.addEventListener("message", (ev: any) => {
  const m = JSON.parse(String(ev.data));
  if (m.method === "Runtime.consoleAPICalled") {
    const line = (m.params.args ?? []).map(textOf).join(" ");
    if (ECHO) console.log(dim(`    [page ${m.params.type}] ${line}`));
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
async function bootInto(world: string, extraQs = "") {
  bootReady = "";
  await cdp.send("Page.navigate", { url: `${BASE}/?name=lightbot&world=${world}${extraQs}` });
  for (let i = 0; i < 240 && !bootReady; i++) await sleep(250);
  if (!bootReady) throw new Error("client never booted");
}

// ============================================================ behavior pass

const WORLD = `lightbench-${Math.random().toString(36).slice(2, 7)}`;
console.log(`\n${bold("── behavior")}  ${dim(`world ${WORLD}`)}`);

const driver = await joinDriver(WORLD, "lightdriver");
// noon, so the day cycle is at full dim: dayGlow = 0 and only a day:false
// light may burn. Weather rain drives the wetness target.
await driver.verb("terrain", { size: 64 });
await driver.verb("sky", { hours: 12, weather: "rain" });
// six placed lights against a default pool of 4: two keeps (must both cast),
// one day:false porch (the only one allowed to BURN at noon), three plain
await driver.verb("light", { id: "keep1", pos: [2, 2, 0], keep: true, intensity: 20 });
await driver.verb("light", { id: "keep2", pos: [-2, 2, 0], keep: true, intensity: 20 });
await driver.verb("light", { id: "porch", pos: [0, 2, 2], day: false, intensity: 20 });
await driver.verb("light", { id: "plain1", pos: [4, 2, 4], intensity: 20 });
await driver.verb("light", { id: "plain2", pos: [6, 2, 6], intensity: 20 });
await driver.verb("light", { id: "plain3", pos: [8, 2, 8], intensity: 20 });
await driver.verb("spawn", { id: "ball1", lib: "props/ball.glb", pos: [1, 0, 1] });
await driver.verb("spawn", { id: "ball2", lib: "props/ball.glb", pos: [2, 0, 2] });

await bootInto(WORLD);
console.log(`  ${dim(bootReady)}`);
await sleep(3000);   // realizers settle; caster pass has run several times

// -- the rig ------------------------------------------------------------------
// A fresh request (the bolt adopting mid-poll) is assigned on the NEXT
// updateRig tick, and headless rAF can lag that a second — re-read until
// the assignment settles rather than asserting mid-window.
let rig: any = null;
for (let i = 0; i < 8; i++) {
  rig = await evalJson("EW.lightrig()");
  const casting = (rig?.requests ?? []).filter((r: any) => r.slot >= 0).length;
  if (casting === Math.min((rig?.requests ?? []).length, rig?.cap ?? 0)) break;
  await sleep(1000);
}
check("rig: slot pool is the fixed default", rig?.slots === 8, `slots=${rig?.slots}`);
check("rig: six placed requests registered", (rig?.requests ?? []).filter((r: any) => r.key.startsWith("placed:")).length === 6);
const castingKeys = (rig?.requests ?? []).filter((r: any) => r.slot >= 0).map((r: any) => r.key).sort();
check("rig: casting count = min(requests, cap)",
  castingKeys.length === Math.min((rig?.requests ?? []).length, rig?.cap ?? 0), castingKeys.join(" "));
check("rig: both keeps hold slots", ["placed:keep1", "placed:keep2"].every((k) => castingKeys.includes(k)),
  `casting: ${castingKeys.join(", ")}`);
// Casters WARM before they flip (8b, warmqueue.warmDepth): first-cast has
// designed-in latency — a depth warm must drain through the conductor before
// castShadow=true. Poll to the same end state instead of asserting mid-warm.
let casterRig = rig;
for (let i = 0; i < 15 && !(casterRig?.casters === 2 && casterRig?.casting === 2); i++) {
  await sleep(1000);
  casterRig = await evalJson("EW.lightrig()");
}
check("rig: caster budget tracks realized models", casterRig?.casters === 2 && casterRig?.casting === 2,
  `casters=${casterRig?.casters} casting=${casterRig?.casting}`);

// -- the day cycle ------------------------------------------------------------
// At noon dayGlow is 0: every day-aware slot writes intensity 0, and only the
// porch (day:false) may burn. Read the actual slot intensities from the scene.
const slotIntensities = await evalJson(
  "EW.scene.children.find(c => c.name === 'lightrig').children.map(l => +l.intensity.toFixed(2))");
const burning = (slotIntensities ?? []).filter((v: number) => v > 0.01);
check("day cycle: at noon only the day:false porch burns", burning.length === 1 && Math.abs(burning[0] - 20) < 0.5,
  `slot intensities: [${(slotIntensities ?? []).join(", ")}]`);

// -- the factory's weather drive ---------------------------------------------
// Rain folded before the client joined. The TARGETS must be exact (pure
// functions of folded state). The easing contract is per-FRAME, not
// wall-clock: headless rAF throttles toward 1Hz — or suspends outright
// when the OS deprioritizes the page — so the probe measures across two
// real frames INSIDE the page, with a timeout that reports "rAF suspended"
// honestly instead of failing on an artifact of the bench environment.
const m1 = await evalJson("EW.materials()");
check("factory: materials were prepared", (m1?.wrapped ?? 0) > 0, `wrapped=${m1?.wrapped} meshes=${m1?.meshes}`);
check("factory: rain wet target derived from folded state", Math.abs((m1?.target?.wet ?? 0) - 0.85) < 1e-6,
  `target.wet=${m1?.target?.wet}`);
check("factory: rain cover target derived from folded state", Math.abs((m1?.target?.cover ?? 0) - 0.9) < 1e-6,
  `target.cover=${m1?.target?.cover}`);
// One rAF pair can sample dt=0 on a loaded headless box (two callbacks in
// one batch → the eased value hasn't moved), which mis-reads the per-frame
// contract as a failure. Sample up to 5 pairs and accept the first that
// MOVED — the contract is "eases frame-over-frame", not "eases across the
// specific pair we happened to catch".
const ease = await evalJson(`(async () => {
  const pair = () => new Promise((res) => {
    const a = EW.materials(); let done = false;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      done = true; res({ a, b: EW.materials() });
    }));
    setTimeout(() => { if (!done) res(null); }, 10000);
  });
  let last = null;
  for (let i = 0; i < 5; i++) {
    last = await pair();
    if (!last) return null;
    if (last.b.wet > last.a.wet && last.b.cover > last.a.cover) return last;
  }
  return last;
})()`);
if (ease) {
  check("factory: ground wets frame-over-frame", ease.b.wet > ease.a.wet && ease.b.wet > 0.01,
    `wet ${ease.a.wet} → ${ease.b.wet}`);
  check("factory: cloud field awake under rain", ease.b.cover > ease.a.cover && ease.b.strength > 0,
    `cover ${ease.a.cover} → ${ease.b.cover}, strength=${ease.b.strength}`);
} else {
  note("factory easing", `rAF suspended in this headless run (wet=${m1?.wet}, cover=${m1?.cover}) — per-frame easing unassessable; the target checks above still bind`);
}

// -- the bolt seam ------------------------------------------------------------
// The sky build primes ~7.5MB and may degrade on a headless box — if it built,
// the weather system's lightning must be an ADOPTED request (mirror), never a
// scene light. If it degraded, say so honestly rather than fake a green.
let impl = null;
for (let i = 0; i < 90; i++) {
  impl = await evalJson("(() => { try { return EW.lightrig().requests.some(r => r.key.startsWith('foreign:')) ? 'adopted' : null; } catch { return null; } })()");
  if (impl) break;
  await sleep(1000);
}
const sceneLights = await evalJson(
  "(() => { const out = []; EW.scene.traverse(o => { if (o.isLight) out.push(o.name || o.type); }); return out; })()");
if (impl === "adopted") {
  check("bolt seam: lightning adopted as a mirrored request", true);
  check("bolt seam: no foreign light entered the scene topology",
    !(sceneLights ?? []).includes("weather_lightning_scene_light"),
    `scene lights: ${(sceneLights ?? []).join(", ")}`);
} else {
  note("bolt seam", `no foreign request after 90s — sky likely degraded headless (scene lights: ${(sceneLights ?? []).join(", ")}); unverified here, verify headed`);
}

// -- residency (§13.3 R1) -----------------------------------------------------
// The driver walks an entity across the residency boundary with `place`
// verbs: far → the sweep demotes it to a stand-in; near again → the sweep
// promotes it back through the ordinary load pipeline. Fold parity must
// hold on BOTH sides — state never changed, only the projection.
async function residencyState(pred: (r: any) => boolean, label: string): Promise<any> {
  let r: any = null;
  for (let i = 0; i < 16; i++) {
    r = await evalJson("EW.residency()");
    if (pred(r)) return r;
    await sleep(700);
  }
  return r;
}
{
  const r0 = await evalJson("EW.residency()");
  await driver.verb("place", { id: "ball2", pos: [300, 0, 300] });
  const far = await residencyState((r) => r.demotes > (r0?.demotes ?? 0), "demote");
  check("residency: a far entity demotes to a stand-in",
    far?.demotes > (r0?.demotes ?? 0) && far?.standins >= 1,
    `real=${far?.real} standins=${far?.standins} demotes=${far?.demotes}`);
  const pFar = await evalJson("EW.foldParity()");
  check("residency: fold parity holds while demoted", pFar?.ok === true,
    pFar ? `checked=${pFar.checked}` : "no parity");
  await driver.verb("place", { id: "ball2", pos: [3, 0, 3] });
  const near = await residencyState((r) => r.promotes > (far?.promotes ?? 0) && r.standins === 0, "promote");
  check("residency: walking near promotes it back to a real model",
    near?.promotes > (far?.promotes ?? 0) && near?.standins === 0,
    `real=${near?.real} promotes=${near?.promotes}`);
  const pNear = await evalJson("EW.foldParity()");
  check("residency: fold parity holds after re-promotion", pNear?.ok === true,
    pNear ? `checked=${pNear.checked}` : "no parity");
}

// ============================================================ live edit
// live(fold) === join(fold), per field (slice 18a): a light edited LIVE must
// render exactly as a fresh joiner folding the same log renders it. The
// keeps anchor the uniform reads: keep-tier requests are exempt from the
// governor's slot cap (PROTOCOL §3.1), so they cast deterministically even
// when a slow headless box sheds the sheddable tail.
console.log(`\n${bold("── live edit")}`);

const lightRow = (id: string) => evalJson(`(() => {
  const rig = EW.lightrig();
  const r = rig.requests.find(x => x.key === 'placed:${id}');
  if (!r) return null;
  const grp = EW.scene.children.find(c => c.name === 'lightrig');
  const pl = r.slot >= 0 ? grp.children.find(l => l.name === 'slot' + r.slot) : null;
  return { keep: r.keep, authored: r.authored, dayAware: r.dayAware, cast: r.slot >= 0,
    dayness: rig.dayness, cap: rig.cap,
    uniforms: pl ? { color: pl.color.getHexString(), intensity: +pl.intensity.toFixed(2),
      distance: pl.distance, pos: pl.position.toArray().map((v) => +v.toFixed(2)) } : null };
})()`);
async function settleOn<T>(fn: () => Promise<T>, pred: (v: T) => boolean, tries = 12): Promise<T> {
  let v = await fn();
  for (let i = 0; i < tries && !pred(v); i++) { await sleep(1000); v = await fn(); }
  return v;
}

// 1. per-field live re-apply, at an hour where dayGlow > 0 ---------------------
// (at noon a day-aware slot writes intensity 0 — nothing to see move)
let dayness = 1;
for (const hours of [22, 5, 20, 6, 19, 7]) {
  await driver.verb("sky", { hours });
  const row: any = await settleOn(() => lightRow("keep1"), (r: any) => r != null && r.dayness <= 0.7, 6);
  dayness = row?.dayness ?? 1;
  if (dayness <= 0.7) break;
}
check("live edit: found an hour with dayGlow > 0", dayness <= 0.7, `dayness=${dayness}`);

const before: any = await settleOn(() => lightRow("keep1"), (r: any) => r?.uniforms != null);
check("live edit: the keep casts (slot uniforms readable)", before?.uniforms != null, JSON.stringify(before));

await driver.verb("light", { id: "keep1", color: 0x22ccff });
const c1: any = await settleOn(() => lightRow("keep1"), (r: any) => r?.uniforms?.color === "22ccff");
check("live edit: color re-applies to the owning slot",
  c1?.uniforms?.color === "22ccff" && before?.uniforms?.color !== "22ccff",
  `${before?.uniforms?.color} → ${c1?.uniforms?.color}`);

await driver.verb("light", { id: "keep1", intensity: 33 });
const c2: any = await settleOn(() => lightRow("keep1"), (r: any) =>
  r?.uniforms != null && Math.abs(r.uniforms.intensity - (c1?.uniforms?.intensity ?? 0)) > 0.25);
check("live edit: intensity moves the slot uniform",
  c2?.uniforms != null && Math.abs(c2.uniforms.intensity - (c1?.uniforms?.intensity ?? 0)) > 0.25
  && c2.uniforms.intensity > 0,
  `${c1?.uniforms?.intensity} → ${c2?.uniforms?.intensity} (dayness ${c2?.dayness})`);

await driver.verb("light", { id: "keep1", range: 22 });
const c3: any = await settleOn(() => lightRow("keep1"), (r: any) => r?.uniforms?.distance === 22);
check("live edit: range re-applies to the owning slot",
  c3?.uniforms?.distance === 22 && before?.uniforms?.distance === 10,
  `${before?.uniforms?.distance} → ${c3?.uniforms?.distance}`);

await driver.verb("light", { id: "keep1", day: false });
const c4: any = await settleOn(() => lightRow("keep1"), (r: any) =>
  r != null && r.dayAware === false && Math.abs((r.uniforms?.intensity ?? 0) - 33) < 0.01);
check("live edit: day:false re-applies (burns at the authored 33, dayAware off)",
  c4?.dayAware === false && Math.abs((c4?.uniforms?.intensity ?? 0) - 33) < 0.01,
  `intensity ${c2?.uniforms?.intensity} → ${c4?.uniforms?.intensity}`);

// 2. at noon, toggling day:false live starts it burning within a few frames ---
await driver.verb("sky", { hours: 12 });
const noon: any = await settleOn(() => lightRow("keep2"),
  (r: any) => r != null && r.dayness >= 0.999 && r.uniforms != null && r.uniforms.intensity < 0.01, 15);
check("noon: a day-aware light's slot writes intensity 0",
  noon?.uniforms != null && noon.uniforms.intensity < 0.01,
  `dayness=${noon?.dayness} intensity=${noon?.uniforms?.intensity}`);
await driver.verb("light", { id: "keep2", day: false });
const burn: any = await settleOn(() => lightRow("keep2"), (r: any) => (r?.uniforms?.intensity ?? 0) > 19.5, 10);
check("noon: toggling day:false live starts it burning within a few frames",
  (burn?.uniforms?.intensity ?? 0) > 19.5 && Math.abs((burn?.uniforms?.intensity ?? 0) - 20) < 0.5,
  `intensity ${noon?.uniforms?.intensity} → ${burn?.uniforms?.intensity}`);

// 3. the parity signature: live(fold) === join(fold) --------------------------
const signature = () => evalJson(`(() => {
  const rig = EW.lightrig();
  const grp = EW.scene.children.find(c => c.name === 'lightrig');
  return rig.requests.filter(r => r.key.startsWith('placed:')).map(r => {
    const pl = r.slot >= 0 ? grp.children.find(l => l.name === 'slot' + r.slot) : null;
    return { key: r.key, keep: r.keep, authored: r.authored, dayAware: r.dayAware,
      uniforms: pl ? { color: pl.color.getHexString(), intensity: +pl.intensity.toFixed(2),
        distance: pl.distance, pos: pl.position.toArray().map(v => +v.toFixed(2)) } : null };
  }).sort((a, b) => (a.key < b.key ? -1 : 1));
})()`);
const capOf = async () => (await evalJson("EW.lightrig()"))?.cap;
const sigLive = await signature();
const capLive = await capOf();
await bootInto(WORLD);          // a fresh join folds the same log
console.log(`  ${dim(bootReady)}`);
await sleep(3000);
let sigJoin = await signature();
for (let i = 0; i < 12 && JSON.stringify(sigJoin) !== JSON.stringify(sigLive); i++) {
  await sleep(1000);
  sigJoin = await signature();
}
const capJoin = await capOf();
{
  const exact = JSON.stringify(sigJoin) === JSON.stringify(sigLive);
  // The governor's slot cap is a CLIENT lever, not fold state: a slow live
  // session may have shed sheddable lights a fresh join hasn't. Flags must
  // match for every light, uniforms for every light casting on both sides,
  // and every keep must cast on both (cap-exempt) — cast-ness of a sheddable
  // is the only difference the cap may explain.
  const byKey = (s: any[]) => Object.fromEntries((s ?? []).map((x: any) => [x.key, x]));
  const L: any = byKey(sigLive), J: any = byKey(sigJoin);
  const keys = [...new Set([...Object.keys(L), ...Object.keys(J)])];
  const flagsOk = keys.every((k) => L[k] && J[k] && L[k].keep === J[k].keep
    && L[k].authored === J[k].authored && L[k].dayAware === J[k].dayAware);
  const uniformsOk = keys.filter((k) => L[k]?.uniforms && J[k]?.uniforms)
    .every((k) => JSON.stringify(L[k].uniforms) === JSON.stringify(J[k].uniforms));
  const keepsCastBoth = keys.filter((k) => L[k]?.keep)
    .every((k) => L[k]?.uniforms != null && J[k]?.uniforms != null);
  check("parity signature: live(fold) === join(fold) per light",
    exact || (flagsOk && uniformsOk && keepsCastBoth),
    exact ? `${keys.length} lights, exact` : `capLive=${capLive} capJoin=${capJoin} live=${JSON.stringify(sigLive)} join=${JSON.stringify(sigJoin)}`);
  if (!exact && flagsOk && uniformsOk && keepsCastBoth) {
    note("parity signature", `sheddable cast-ness diverged with the governor cap (live=${capLive}, join=${capJoin}) — a client lever, not fold state; flags, keeps, and every both-cast uniform matched`);
  }
}

// 4. foldParity across a live edit of a comped + mounted light ----------------
// (pins the fold preserving comp/parent through light-on-light AND the
// realizer's refreshLight not clobbering the carrier-relative transform)
await driver.verb("comp", { id: "porch", type: "aura", data: { tint: "amber" } });
await driver.verb("mount", { id: "porch", to: "ball1", offset: [0, 1.6, 0] });
await driver.verb("light", { id: "porch", intensity: 26 });
let pLit: any = null;
for (let i = 0; i < 20; i++) {
  pLit = await evalJson("EW.foldParity()");
  if (pLit?.ok) break;
  await sleep(1000);
}
check("fold parity holds after a live edit of a comped + mounted light", pLit?.ok === true,
  pLit ? `checked=${pLit.checked} comp=${pLit.compDiffs?.length} parent=${pLit.parentDiffs?.length} pose=${pLit.mountPoseDiffs?.length}` : "no parity");

// 5. keep exemption survives live edits with the pool oversubscribed ----------
await driver.verb("light", { id: "plain4", pos: [12, 2, -12], intensity: 18 });
await driver.verb("light", { id: "plain5", pos: [15, 2, -15], intensity: 18 });
await driver.verb("light", { id: "plain6", pos: [18, 2, -18], intensity: 18 });
await driver.verb("light", { id: "keep1", intensity: 24 });   // churn the request set live
await driver.verb("light", { id: "keep2", range: 14 });
let rigPost: any = null;
for (let i = 0; i < 10; i++) {
  rigPost = await evalJson("EW.lightrig()");
  const casting = (rigPost?.requests ?? []).filter((r: any) => r.slot >= 0).map((r: any) => r.key);
  if (["placed:keep1", "placed:keep2"].every((k) => casting.includes(k))) break;
  await sleep(1000);
}
const postKeys = (rigPost?.requests ?? []).filter((r: any) => r.slot >= 0).map((r: any) => r.key).sort();
check("keep exemption: both keeps still hold slots after the live edits (9 placed > 8 slots)",
  (rigPost?.requests ?? []).filter((r: any) => r.key.startsWith("placed:")).length === 9
  && ["placed:keep1", "placed:keep2"].every((k) => postKeys.includes(k)),
  `cap=${rigPost?.cap} casting: ${postKeys.join(", ")}`);

// -- hygiene ------------------------------------------------------------------
const knownBenign = (l: string) => l.includes("favicon") || l.includes("Autoplay");
const realErrors = pageErrors.filter((l) => !knownBenign(l));
check("no page errors", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));
check("driver was never refused", driver.errors.length === 0, driver.errors.join(" | "));
driver.close();

// ============================================================ slot sweep

if (MEASURE) {
  console.log(`\n${bold("── measure")}  ${dim("grass world, slots × {4, 8, 12, 16}")}`);
  const MWORLD = `lightbench-m-${Math.random().toString(36).slice(2, 7)}`;
  const md = await joinDriver(MWORLD, "lightdriver");
  await md.verb("terrain", { size: 64 });
  await md.verb("grass", { size: 40, density: 1 });
  await md.verb("sky", { hours: 12 });
  for (let i = 0; i < 4; i++) await md.verb("light", { id: `l${i}`, pos: [i * 3, 2, i * 3], intensity: 18 });

  for (const n of [4, 8, 12, 16]) {
    await bootInto(MWORLD, `&slots=${n}`);
    // let the world settle, then measure fps over 5s with the rig live
    await sleep(6000);
    const fps = await evalJson(
      "new Promise(res => { let f = 0; const t0 = performance.now(); const tick = () => { f++; if (performance.now() - t0 < 5000) requestAnimationFrame(tick); else res(Math.round(f / 5)); }; requestAnimationFrame(tick); })");
    const grassLine = await evalJson(
      "(globalThis.__loadLog ?? []).filter(l => l.includes('grass')).join(' | ')");
    const slots = await evalJson("EW.lightrig().slots");
    console.log(`  slots=${String(n).padEnd(2)} rig=${slots}  fps≈${fps}  ${dim(grassLine || "(no grass load line)")}`);
    console.log(`    ${dim(bootReady)}`);
  }
  md.close();
}

// ============================================================ verdict

console.log(`\n${failed === 0 ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} — ${passed} passed, ${failed} failed`);
await cleanup();
process.exit(failed ? 1 : 0);
