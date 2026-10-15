// tools/protocol/surface-parity.ts — does the SURFACE look the same? Two trees of this repo, the same two worlds, the same
// fixed cameras, pixel-diffed. The last gate before the v4 PR (R, 10-14: "it'd be incredible if everything on the
// surface looks the same").
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/surface-parity.ts [--check] [flags]
//
//   --check              assert every prerequisite and stop before the first frame (what to run first on a new box)
//   --old <tree>         the OLD checkout to serve (default: a detached worktree of pre-repoint-20261014, made if missing
//                        at $SURFACE_OLD_TREE or /tmp/eido-pre-parity)
//   --new <tree>         the NEW checkout (default: this file's repo)
//   --commons <dir>      the Commons copy to render (default scratch-worlds/nov1-e2e/commons — see NOTE below)
//   --gym <dir>          the gym copy (default scratch-worlds/garden/gym)
//   --out <dir>          where frames and diffs go (default notes/surface-parity/<timestamp>/; never /tmp)
//   --threshold <pct>    changed-pixel percentage that fails a camera (default 0.5)
//   --tolerance <0-255>  per-channel difference under which a pixel counts as unchanged (default 16: SwiftShader dither)
//   --camera <w>:<name>=<x>,<y>,<z>/<lx>,<ly>,<lz>   add a camera to world <w> (commons|gym); repeatable
//   --keep-ui            leave the DOM chrome (panels, chat, HUD) in frame — by default only the canvas is compared
//   --no-pin-clock       let the page's Date.now() run real; by default it is pinned (see "probe hooks")
//   --no-control         skip the second boot of the old tree that measures the noise floor
//   --timeout <s>        how long a client may take to settle and draw (default 150; SwiftShader on WSL is slow)
//   --only <world>       just one of commons|gym
//   --headed             a window you can watch
//
// PREPARE, DON'T PRETEND. Headless Chromium under WSL has been unreliable here all week, so this script asserts every
// prerequisite BY NAME before it takes a frame, and a run that cannot take frames exits 2 saying which step failed —
// never a green. The named steps, in order: browser binary · old tree · world copies · memory · old server · new
// server · world opens (both trees, both worlds, as the spectator the browser will be) · browser page target ·
// client ready (frames drawn) · camera honoured. A red (exit 1) is a pixel verdict; exit 2 is "could not look"; exit 3
// is "looked, but the noise floor is too high to call it".
//
// WHAT IS COMPARED, AND WHAT IS NOT. The browser joins as a SPECTATOR (`?spectate`: client/lib/base.js:42 → net.js:266
// `spectate: true`; localbody.js:335 spawns no local body for a spectator) in a scratch COPY of each world that nobody
// else is in. So there are no bodies, name tags or chat bubbles in frame — presence-only regions are absent rather than
// masked, and the harness asserts that from the server's own snapshot (people[] empty) before each frame. By default the
// DOM chrome over the canvas is hidden too (particles-shots.ts:185 does the same): panels carry names and clocks, and a
// panel regression is a UI diff, not a surface one. --keep-ui puts it back.
//
// PROBE HOOKS (not features): the camera is placed by Runtime.evaluate on client/lib/core.js's exported `camera`
// (particles-shots.ts:189 does the same). There is no URL parameter for a fixed camera; a spectator's camera is only
// moved by controller.js updateSpectator (:1035) when it follows a remote with an avatar, and with nobody present it
// stays where we put it — which the harness verifies by reading it back after a few frames. And Date.now() is pinned
// to the old tag's commit time inside the page (sky.js:385/:416 derive the sun and the forecast's weather from
// Date.now(), so two runs minutes apart would otherwise light the world differently; serverclock.js reads
// performance.timeOrigin, so motion phases and clock sync are untouched). --no-pin-clock turns it off.
//
// NOTE on the default Commons: scratch-worlds/nov1-e2e/commons holds `v4.jsonl`, a log saved BEFORE the 2026-10-07
// names pass. Neither tree opens that (server/livehost.ts isWorldDir wants world.jsonl with a {dialect, v:4} genesis;
// server.ts:351 refuses the join by name). The self-check says so and points at a current-format copy
// (staging/worlds/commons-v4). The default is kept as asked so the failure is named rather than silently redirected.
//
// Browser hygiene it leans on (memory: browser-probe-hygiene): teardown in finally and on signals; every gate prints
// its stage on green and red; waits are on conditions (frames drawn, loads idle) not clocks; evaluate is raced against
// a clock (harness.ts cdpOn: 60 s); frames are PROVED (a renderer.render call counter advances) not assumed; the sky guard
// (ew-cloud-quality=off) and the GPU-loss guard (sessionStorage ew-gpu-lost) from tools/harness.ts:220-226 are applied
// to every page. One Chromium at a time: run under code/scripts/eido-probe.sh or `flock /home/claude/eido/.headless.lock`.
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, copyFileSync, mkdtempSync, rmSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, basename } from "node:path";
import { PNG } from "pngjs";
import { cdpOn, freePort, sleep, bold, dim } from "../harness.ts";

// ---- flags -----------------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const has = (k: string) => argv.includes(`--${k}`);
const opt = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const all = (k: string) => argv.flatMap((a, i) => (a === `--${k}` && argv[i + 1] !== undefined ? [argv[i + 1]] : []));

const NEW = resolve(opt("new", resolve(import.meta.dir, "../..")));
const OLD_TAG = "pre-repoint-20261014";
const OLD = resolve(opt("old", process.env.SURFACE_OLD_TREE ?? "/tmp/eido-pre-parity"));
const CHECK = has("check"), HEADED = has("headed"), KEEP_UI = has("keep-ui"), PIN = !has("no-pin-clock"), CONTROL = !has("no-control");
const THRESHOLD = Number(opt("threshold", "0.5")), TOLERANCE = Number(opt("tolerance", "16")), READY_S = Number(opt("timeout", "150"));
const ONLY = opt("only");   // one world (commons|gym) for a quicker run
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = resolve(opt("out", join(NEW, "notes", "surface-parity", STAMP)));
const WORLDS: Record<string, string> = {
  commons: resolve(opt("commons", "/home/claude/eido/staging/worlds/commons-v4")) /* the live Commons (world.jsonl, v4): the nov1-e2e copy is pre-names v4.jsonl and neither tree opens it */,
  gym: resolve(opt("gym", "/home/claude/eido/scratch-worlds/garden/gym")),
};
type Cam = { name: string; pos: [number, number, number]; look: [number, number, number] };
// Two fixed cameras per world: a wide one from above the origin and a standing eye on the ground. Both worlds are built
// around the origin (the stage floor), so these frame the bulk of each; add more with --camera.
const CAMERAS: Record<string, Cam[]> = {
  commons: [{ name: "wide", pos: [0, 7, 14], look: [0, 1, 0] }, { name: "eye", pos: [6, 1.6, 6], look: [0, 1.2, -2] }],
  gym: [{ name: "wide", pos: [0, 7, 14], look: [0, 1, 0] }, { name: "eye", pos: [6, 1.6, 6], look: [0, 1.2, -2] }],
};
for (const spec of all("camera")) {
  const m = spec.match(/^(\w+):([\w-]+)=([-\d.]+),([-\d.]+),([-\d.]+)\/([-\d.]+),([-\d.]+),([-\d.]+)$/);
  if (!m) { console.error(`--camera ${spec}: want <world>:<name>=<x>,<y>,<z>/<lx>,<ly>,<lz>`); process.exit(2); }
  (CAMERAS[m[1]] ??= []).push({ name: m[2], pos: [+m[3], +m[4], +m[5]], look: [+m[6], +m[7], +m[8]] });
}
const VIEW = { width: 1280, height: 800 };

// ---- the stage line: every gate prints on green and red --------------------------------------------------------------
const stages: string[] = [];
const ok = (name: string, detail = "") => { stages.push(`${name}:ok`); console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? dim("  " + detail) : ""}`); };
const procs: Bun.Subprocess[] = [];
let scratch = "";
let cleaned = false;
async function cleanup() {
  if (cleaned) return; cleaned = true;
  for (const p of procs) { try { p.kill(); } catch { /* gone */ } }
  await Promise.race([Promise.all(procs.map((p) => p.exited)), sleep(2500)]);
  if (scratch && !process.env.PROTOCOL_KEEP) { try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } }
}
/** A named missing prerequisite. Exit 2, never a green. */
async function missing(step: string, ...lines: string[]): Promise<never> {
  stages.push(`${step}:MISSING`);
  console.error(`\n  \x1b[31m✗ PREREQUISITE MISSING — ${bold(step)}\x1b[0m`);
  for (const l of lines) console.error(`    ${l}`);
  console.error(`\n  stage line: ${stages.join(" · ")}`);
  if (scratch) console.error(`  scratch kept for reading: ${scratch}  (sequencer logs are in it)`);
  process.env.PROTOCOL_KEEP = "1";
  await cleanup();
  process.exit(2);
}
process.on("exit", () => { for (const p of procs) { try { p.kill(); } catch { /* gone */ } } });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { void cleanup().then(() => process.exit(130)); });
process.once("uncaughtException", (e) => { console.error(e?.stack ?? String(e)); void cleanup().then(() => process.exit(2)); });
process.once("unhandledRejection", (e) => { console.error(e instanceof Error ? e.stack : String(e)); void cleanup().then(() => process.exit(2)); });

console.log(`\n${bold("surface parity")} — ${OLD_TAG} vs HEAD, ${Object.keys(WORLDS).join(" + ")}, fixed cameras, pixel diff${CHECK ? dim("  (--check: prerequisites only)") : ""}`);
console.log(dim(`  new  ${NEW}\n  old  ${OLD}\n  out  ${OUT}`));

// ---- 1. the browser binary -----------------------------------------------------------------------------------------
// The paths the other probes use: CHROME env (tools/harness.ts:15), the reviewer-matching Chrome 153 that
// code/scripts/eido-probe.sh exports, Playwright's managed build (tools/probe-harness.mjs:8), then harness.ts's list.
// /usr/bin/chromium-browser on this box is a 2 KB shell stub that only says "snap install chromium" — a path that EXISTS
// and is not a browser, which is exactly how a green would lie here.
const CANDIDATES = [
  process.env.CHROME, process.env.SFU_TEST_CHROME,
  join(homedir(), ".local/chrome153/chrome-linux64/chrome"),
  ...(existsSync(join(homedir(), ".cache/ms-playwright")) ? readdirSync(join(homedir(), ".cache/ms-playwright")).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse().map((d) => join(homedir(), ".cache/ms-playwright", d, "chrome-linux64/chrome")) : []),
  "/usr/bin/google-chrome", "/usr/bin/microsoft-edge", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((p): p is string => !!p);
const isStub = (p: string) => { try { const head = readFileSync(p).subarray(0, 64).toString("latin1"); return head.startsWith("#!"); } catch { return true; } };
const CHROME = CANDIDATES.find((p) => existsSync(p) && !isStub(p));
if (!CHROME) await missing("browser binary", `none of these is a real Chromium: ${CANDIDATES.map((p) => `${p}${existsSync(p) ? (isStub(p) ? " (exists, but is a shell stub)" : "") : " (absent)"}`).join("\n      ")}`,
  `set CHROME=/path/to/chrome (eido-probe.sh exports ~/.local/chrome153/chrome-linux64/chrome; Windows: msedge.exe)`);
ok("browser binary", CHROME);

// ---- 2. the two trees ----------------------------------------------------------------------------------------------
const treeOk = (t: string) => ["server/server.ts", "client/lib/core.js", "client/lib/sky.js", "tools/protocol/world.ts"].every((f) => existsSync(join(t, f)));
if (!treeOk(NEW)) await missing("new tree", `${NEW} is not a checkout of this repo (server/server.ts, client/lib/core.js …)`);
const headOf = (t: string) => Bun.spawnSync(["git", "-C", t, "rev-parse", "--short", "HEAD"]).stdout.toString().trim();
const describe = (t: string) => Bun.spawnSync(["git", "-C", t, "log", "-1", "--format=%h %s"]).stdout.toString().trim().slice(0, 100);
if (!treeOk(OLD)) {
  const tagOk = Bun.spawnSync(["git", "-C", NEW, "rev-parse", "--verify", `${OLD_TAG}^{commit}`]);
  if (tagOk.exitCode !== 0) await missing("old tree", `${OLD} is not a checkout and the tag ${OLD_TAG} is not in ${NEW}'s repo`, `pass --old <tree> or fetch the tag`);
  console.log(dim(`  making a detached worktree of ${OLD_TAG} at ${OLD}`));
  const add = Bun.spawnSync(["git", "-C", NEW, "worktree", "add", "--detach", OLD, OLD_TAG]);
  if (add.exitCode !== 0 || !treeOk(OLD)) await missing("old tree", `git worktree add --detach ${OLD} ${OLD_TAG} failed:`, add.stderr.toString().trim().slice(0, 400));
}
// the server needs the repo's node_modules (pngjs here, sharp/quickjs there) and the BROWSER needs client/node_modules
// (three, three-vrm: the server warns "browsers will hang at the splash" without it). A worktree has neither of its own.
// A link from another checkout is honest only while that checkout's manifest is byte-identical — asserted, not assumed.
const depsSources = [NEW, "/home/claude/eido/staging", ...Bun.spawnSync(["git", "-C", NEW, "worktree", "list", "--porcelain"]).stdout.toString().split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9))];
function linkDeps(tree: string, sub: string) {
  const want = join(tree, sub, "node_modules"); if (existsSync(want)) return;
  const src = depsSources.find((t) => t !== tree && existsSync(join(t, sub, "node_modules")) && existsSync(join(t, sub, "package.json")) && readFileSync(join(t, sub, "package.json"), "utf8") === readFileSync(join(tree, sub, "package.json"), "utf8"));
  if (!src) return missing(`deps: ${basename(tree)}/${sub || "."}`, `${want} is missing and no sibling checkout with an identical ${sub ? sub + "/" : ""}package.json has one to link`, `run: cd ${join(tree, sub)} && bun install`);
  symlinkSync(resolve(src, sub, "node_modules"), want);
  console.log(dim(`  linked ${want} → ${resolve(src, sub, "node_modules")} (manifests identical)`));
}
for (const t of [NEW, OLD]) for (const sub of ["", "client"]) await linkDeps(t, sub);
const OLD_HEAD = headOf(OLD), NEW_HEAD = headOf(NEW);
if (OLD_HEAD === NEW_HEAD) await missing("old tree", `old and new are the same commit (${OLD_HEAD}) — a diff of a tree against itself proves nothing`);
ok("old tree", `${describe(OLD)}`);
ok("new tree", `${describe(NEW)}`);

// ---- 3. the world copies -------------------------------------------------------------------------------------------
// A world this server serves is a directory holding world.jsonl whose line 0 is a genesis {dialect:"eidoverse-log", v:4}
// (server/livehost.ts:141). Anything else — a pre-names `v4.jsonl`, a v1 `log.jsonl` — is refused at the door
// (server.ts:351) on BOTH trees, so it is named here, before any server starts.
const genesisOf = (file: string) => { try { return JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]); } catch { return null; } };
const entriesOf = (file: string) => { try { return readFileSync(file, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
for (const [w, dir] of Object.entries(WORLDS)) { if (ONLY && w !== ONLY) continue;
  if (!existsSync(dir)) await missing(`world copy: ${w}`, `${dir} does not exist`, `pass --${w} <dir>`);
  const log = join(dir, "world.jsonl"), g = genesisOf(log);
  if (!g || g.body?.dialect !== "eidoverse-log" || g.body?.v !== 4) {
    const others = (existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.endsWith(".jsonl"));
    const hint = others.includes("v4.jsonl") ? `it holds v4.jsonl: a log saved BEFORE the 2026-10-07 names pass. Neither tree opens it (server.ts:351 refuses the join). A current-format Commons copy is at /home/claude/eido/staging/worlds/commons-v4 — pass --commons /home/claude/eido/staging/worlds/commons-v4`
      : others.includes("log.jsonl") ? `it holds log.jsonl (v1): translate it once with tools/protocol/world.ts translate, or point at a translated copy`
        : `no world.jsonl with a {dialect:"eidoverse-log", v:4} genesis (found: ${others.join(", ") || "nothing"})`;
    await missing(`world copy: ${w}`, `${dir} is not a world this protocol serves —`, hint);
  }
  ok(`world copy: ${w}`, `${dir} (${entriesOf(log)} entries, genesis ${g.body.nonce})`);
}

// ---- 4. memory ------------------------------------------------------------------------------------------------------
// Two sequencers and one headless Chromium under SwiftShader; the sky OOM of 09-26 (memory: feedback_headless_sky_oom)
// took WSL down with it. Refuse below a floor rather than find out.
const availMB = (() => { try { const m = readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)/); return m ? Math.round(+m[1] / 1024) : null; } catch { return null; } })();
const MEM_FLOOR = Number(process.env.SURFACE_MEM_FLOOR_MB ?? 1200);
if (availMB !== null && availMB < MEM_FLOOR) await missing("memory", `MemAvailable is ${availMB} MB; the floor is ${MEM_FLOOR} MB (SURFACE_MEM_FLOOR_MB)`, `close another headless Chrome first (ss -ltnp | grep chrome), or wait for the other probe to finish`);
ok("memory", availMB === null ? "not readable here (not Linux) — skipped" : `${availMB} MB available`);

// ---- 5+6. one sequencer per tree, each serving copies of both worlds -------------------------------------------------
scratch = mkdtempSync(join(tmpdir(), "ew-surface-"));   // OUT is made at the first frame, so a failed self-check leaves no empty folder
const EIDOVERSE_DIR = process.env.EIDOVERSE_DIR ?? (existsSync(join(NEW, "..", "eidoverse-video")) ? resolve(NEW, "..", "eidoverse-video") : "/home/claude/eido/eidoverse-video");
if (!existsSync(join(EIDOVERSE_DIR, "eidoverse", "assets"))) await missing("asset library", `${EIDOVERSE_DIR}/eidoverse/assets is not there — set EIDOVERSE_DIR`);
type Server = { tree: string; label: string; port: number; base: string; nonce: string; log: string; worldsDir: string };
async function spawnServer(tree: string, label: string): Promise<Server> {
  const worldsDir = join(scratch, label, "worlds"); mkdirSync(worldsDir, { recursive: true });
  // the world copies — and the custody/directory files beside the source (the sequencer's keys, the identity directory),
  // as gym-env.lab.ts:220 copies them; a copy with no custody is served read-only-ish, which is all a spectator needs
  for (const [w, dir] of Object.entries(WORLDS)) { if (ONLY && w !== ONLY) continue;
    cpSync(dir, join(worldsDir, w), { recursive: true });
    for (const f of [".custody.json", ".directory.json"]) { const src = join(dir, "..", f); if (existsSync(src) && !existsSync(join(worldsDir, f))) copyFileSync(src, join(worldsDir, f)); }
  }
  const port = freePort(label === "old" ? 8960 : 8990), nonce = crypto.randomUUID(), log = join(scratch, `${label}-sequencer.log`);
  const p = Bun.spawn([process.execPath, join(tree, "server", "server.ts")], {
    cwd: tree,
    env: { ...process.env, PORT: String(port), JOIN_TOKEN: "", TRUST_NAMES: "1", WORLDS_DIR: worldsDir, RELAY_STATE_DIR: join(scratch, label),
      EIDOVERSE_DIR, BENCH_NONCE: nonce, SKIP_OPT_SWEEP: "1", RECORD_FRAMES: "0", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      // one content store for both trees: blobs are by hash, and a tag's export has no store/ (Commons sat at loading:6 on old, 10-15)
      OPT_DIR: process.env.SURFACE_OPT_DIR ?? join(NEW, "assets", "opt") },
    stdout: Bun.file(log), stderr: Bun.file(log),
  });
  procs.push(p);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (p.exitCode !== null) await missing(`${label} server`, `${tree}'s server exited ${p.exitCode} before answering on :${port}`, `log tail:`, ...tail(log));
    try { const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) }); if (r.ok) { const j = await r.json() as any; if (j.nonce !== nonce) await missing(`${label} server`, `:${port} answered with another process's nonce — a stranger's sequencer lives there`); return { tree, label, port, base, nonce, log, worldsDir }; } } catch { /* not yet */ }
    await sleep(250);
  }
  return missing(`${label} server`, `${tree}'s server never answered /health on :${port} in 25 s`, `log tail:`, ...tail(log));
}
const tail = (f: string, n = 12) => { try { return readFileSync(f, "utf8").trim().split("\n").slice(-n).map((l) => l.slice(0, 300)); } catch { return ["(no log)"]; } };
const oldS = await spawnServer(OLD, "old"); ok("old server", `:${oldS.port} (${OLD_HEAD})`);
const newS = await spawnServer(NEW, "new"); ok("new server", `:${newS.port} (${NEW_HEAD})`);

// ---- 7. both world copies open on both trees — as the spectator the browser will be ---------------------------------
// A join that gets a snapshot is the server saying "this is a world I serve"; its people[] is the presence roster, which
// must be EMPTY for a parity frame (bodies/tags/bubbles are presence-only and would differ run to run). The entity count
// is the non-vacuity receipt: a green over an empty world is two blank frames agreeing.
async function spectate(s: Server, world: string): Promise<{ entities: number; people: number }> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
    const t = setTimeout(() => { ws.close(); rej(new Error("no snapshot in 15 s")); }, 15_000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", world, id: "parity-eye", name: "parity-eye", avatar: "", spectate: true, replica: true }));   // replica: a client that folds the log (server.ts:930 refuses one that does not)
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "error") { clearTimeout(t); ws.close(); rej(new Error(String(m.error))); }
      if (m.type === "snapshot") { clearTimeout(t); const ents = m.cut?.state ?? {}; /* clientCutOf (shared/protocol/replica.js:150): state = wireState = {id: {born, c}}, the entity map itself */ const people = (m.present ?? m.people ?? []).length; ws.close(); res({ entities: Object.keys(ents).length, people }); }
    };
    ws.onerror = () => { clearTimeout(t); rej(new Error("socket error")); };
  });
}
for (const s of [oldS, newS]) for (const w of Object.keys(WORLDS)) { if (ONLY && w !== ONLY) continue;
  const r = await spectate(s, w).catch((e) => e as Error);
  if (r instanceof Error) await missing(`world opens: ${w} on ${s.label}`, `join refused: ${r.message}`, `sequencer log tail:`, ...tail(s.log));
  if (r.entities === 0) await missing(`world opens: ${w} on ${s.label}`, `the snapshot's cut folds to ZERO entities — a frame of this would be a blank floor; is the copy complete?`);
  if (r.people > 0) await missing(`world opens: ${w} on ${s.label}`, `${r.people} body(ies) already present in a scratch copy nobody should be in`);
  ok(`world opens: ${w} on ${s.label}`, `${r.entities} entities, nobody present`);
}

if (CHECK) { console.log(`\n  ${bold("--check: every prerequisite up to the browser launch is met.")} Run without --check to take frames.\n  stage line: ${stages.join(" · ")}`); await cleanup(); process.exit(0); }

// ---- 8. the browser ---------------------------------------------------------------------------------------------------
const DEBUG_PORT = freePort(9960);
const PROFILE = join(scratch, "profile");
const firstURL = `${newS.base}/health?bench=${newS.nonce}`;
const browser = Bun.spawn([CHROME, ...(HEADED ? [] : ["--headless=new"]), `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${PROFILE}`,
  "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-sync", "--mute-audio",
  `--window-size=${VIEW.width},${VIEW.height}`, "--enable-unsafe-webgpu", firstURL],
  { stdout: Bun.file(join(scratch, "browser.log")), stderr: Bun.file(join(scratch, "browser.stderr.log")) });
procs.push(browser);
let target: any = null;
for (let i = 0; i < 120 && !target; i++) {
  if (browser.exitCode !== null) await missing("browser page target", `${CHROME} exited ${browser.exitCode} before exposing a debugger`, ...tail(join(scratch, "browser.stderr.log")));
  try { const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`, { signal: AbortSignal.timeout(1000) })).json() as any[]; target = list.find((t) => t.type === "page" && t.url === firstURL); } catch { /* not yet */ }
  if (!target) await sleep(150);
}
if (!target) await missing("browser page target", `no page target for ${firstURL} on :${DEBUG_PORT} in 18 s`, ...tail(join(scratch, "browser.stderr.log")));
const cws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { cws.onopen = res as any; cws.onerror = rej as any; });
const cdp = cdpOn(cws);
const pageErrors: string[] = [];
cws.addEventListener("message", (ev) => { const m = JSON.parse(String(ev.data)); if (m.method === "Runtime.exceptionThrown") pageErrors.push(String(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? "").slice(0, 200)); });
await Promise.all([cdp.send("Runtime.enable"), cdp.send("Page.enable"), cdp.send("Log.enable")]);
await cdp.send("Emulation.setDeviceMetricsOverride", { ...VIEW, deviceScaleFactor: 1, mobile: false });
// the sky guard and the GPU-loss guard every bench applies (tools/harness.ts:220-226)
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "try { localStorage.setItem('ew-cloud-quality', 'off'); } catch {}" });
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "try { if (!sessionStorage.getItem('ew-gpu-lost')) sessionStorage.setItem('ew-gpu-lost', JSON.stringify([Date.now()])); } catch {}" });
// the clock pin (probe hook): the sun and the forecast read Date.now() (sky.js:385, :416)
const PIN_MS = Number(opt("pin-clock", "1791956698000"));   // the tag's commit time (git log -1 --format=%ct pre-repoint-20261014)
if (PIN) await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const p0 = performance.now(); Date.now = () => ${PIN_MS} + (performance.now() - p0); })();` });
const version = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then((r) => r.json()).catch(() => ({})) as any;
ok("browser page target", `${version.Browser ?? "browser"} on :${DEBUG_PORT}${PIN ? `, Date.now pinned to ${new Date(PIN_MS).toISOString()}` : ""}`);
const evalJson = async (expr: string) => { const r = await cdp.send<any>("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r?.result?.value; };
const page = (js: string) => evalJson(`(async () => { ${js} })()`);

// ---- 9. boot a world on a tree, prove it drew frames --------------------------------------------------------------------
async function boot(s: Server, world: string): Promise<string> {
  const url = `${s.base}/?name=parity-eye&world=${world}&webgl=1&spectate`;
  pageErrors.length = 0;
  await cdp.send("Page.navigate", { url });
  // the readiness ladder, each link a condition the client exports on both trees: joined (net.js replicaActive) →
  // loads idle (assets.js loadingItems) → builds settled (world.js anyBuildsPending) → sky not busy → frames ADVANCING
  const stage = () => page(`
    const n = await import('/lib/net.js'); if (!n.replicaActive()) return 'joined:false';
    const a = await import('/lib/assets.js'); const L = a.loadingItems(); if (L.length) return 'loading:' + L.length + ' ' + JSON.stringify(L.map((x) => x.label + (x.total ? ' ' + x.done + '/' + x.total : '')).slice(0, 8));
    const w = await import('/lib/world.js'); if (w.anyBuildsPending()) return 'builds:' + w.anyBuildsPending();
    const sk = await import('/lib/sky.js'); if (sk.skyBusy?.() || sk.skyRendering?.()) return 'sky:busy';
    if (globalThis.__gpuLost?.fired) return 'gpu:lost';
    return 'frames:' + (await globalThis.__spFrames()) + ' vis:' + document.visibilityState + ' focus:' + document.hasFocus() + ' timers:' + (globalThis.__spTicks ?? -1);`);
  /* a timer-driven counter beside the rAF one: if timers advance while frames stand still, rAF is paused (a hidden/occluded
     headless page), not the page; if both stand still the main thread is pinned */
  await page(`if (globalThis.__spTicks === undefined) { globalThis.__spTicks = 0; setInterval(() => { globalThis.__spTicks++; }, 100); } return true;`);
  // the frame counter (probe hook): render.js's renderCensus only ticks in XR (xr.js:1174) and frameloop.js keeps its
  // frameNo private, so the probe counts renderer.render calls itself — batches.render → renderer.render once per drawn
  // frame on both trees and both backends. Installed once per page; a lost GPU draws nothing (render.js:112) and the
  // count then stands still, which is the honest reading.
  await page(`globalThis.__spFrames = async () => { const { renderer } = await import('/lib/core.js');
    if (renderer.__spCount === undefined) { renderer.__spCount = 0; const o = renderer.render.bind(renderer); renderer.render = function (...a) { renderer.__spCount++; return o(...a); }; }
    return renderer.__spCount; }; return true;`);
  const t0 = Date.now(); let last = "", frames0 = -1, framesAt = 0, stillSince = 0;
  while (Date.now() - t0 < READY_S * 1000) {
    last = await stage().catch((e) => `evaluate:${String(e).slice(0, 80)}`);
    const m = last.match(/^frames:(\d+)\b/);
    if (m) { const f = +m[1]; if (frames0 < 0) frames0 = f; else if (f - frames0 >= 12) return last;   /* a dozen frames AFTER settle: drawn, not promised */
      if (f !== framesAt) { framesAt = f; stillSince = Date.now(); } }
    await sleep(400);
  }
  /* name the stall: every upstream condition held and the renderer.render count stood still — an on-demand render loop with
     nothing dirty, or a lost GPU (render.js:112) — so the reader is not left guessing which link of the ladder failed */
  const stalled = last.startsWith("frames:") && stillSince ? ` — the frame count stood at ${framesAt} for ${((Date.now() - stillSince) / 1000).toFixed(0)} s after loads/builds/sky settled: nothing redrew (on-demand loop with nothing dirty, or GPU lost)` : "";
  return missing(`client ready: ${world} on ${s.label}`, `the client did not reach a settled, frame-drawing state in ${READY_S} s (--timeout); last stage: ${last}${stalled}`,
    pageErrors.length ? `page exceptions:` : `no page exceptions`, ...pageErrors.slice(0, 6), `sequencer log tail:`, ...tail(s.log, 8));
}

// ---- 10. place the camera, prove it stayed, capture ---------------------------------------------------------------------
async function frame(s: Server, world: string, cam: Cam, file: string) {
  if (!KEEP_UI) await page(`if (!document.getElementById('surface-parity-hide')) { const st = document.createElement('style'); st.id = 'surface-parity-hide'; st.textContent = 'body > *:not(canvas) { display: none !important; }'; document.head.append(st); } return true;`);
  const aim = `const { camera } = await import('/lib/core.js'); camera.position.set(${cam.pos.join(",")}); camera.lookAt(${cam.look.join(",")}); camera.updateMatrixWorld(true); return true;`;
  await page(aim);
  // a few drawn frames with the camera in place, then read it back: the controller (updateSpectator) must not have moved it
  const f0 = await page(`return await globalThis.__spFrames();`);
  let drawn = 0;
  for (let i = 0; i < 100; i++) { await sleep(100); drawn = (await page(`return await globalThis.__spFrames();`)) - f0; if (drawn >= 6) break; }
  if (drawn < 6) await missing(`frames after aim: ${world}/${cam.name} on ${s.label}`, `only ${drawn} frame(s) drew in 10 s after placing the camera${await page(`return globalThis.__gpuLost?.fired ? ' — the GPU is lost' : '';`)}`);
  const got = await page(`const { camera } = await import('/lib/core.js'); return camera.position.toArray();`) as number[];
  const drift = Math.hypot(got[0] - cam.pos[0], got[1] - cam.pos[1], got[2] - cam.pos[2]);
  if (drift > 0.01) await missing(`camera honoured: ${world}/${cam.name} on ${s.label}`, `asked for ${cam.pos.join(",")}, the camera is at ${got.map((v) => v.toFixed(3)).join(",")} after 6 frames (drift ${drift.toFixed(3)} m) — something is driving it`);
  const r = await cdp.send<any>("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, ...VIEW, scale: 1 } });
  const buf = Buffer.from(r.data, "base64");
  const png = PNG.sync.read(buf);
  // a blank frame is a failed capture, not a surface: the floor and the sky alone give hundreds of distinct colours
  const seen = new Set<number>(); for (let i = 0; i < png.data.length && seen.size < 64; i += 4 * 97) seen.add((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]);
  if (seen.size < 8) await missing(`frame drawn: ${world}/${cam.name} on ${s.label}`, `the capture is ${seen.size} flat colour(s) — the canvas drew nothing (GPU lost? a splash still up?)`, ...pageErrors.slice(0, 4));
  writeFileSync(file, buf);
  return png;
}

// ---- 11. the diff -----------------------------------------------------------------------------------------------------
type Diff = { changed: number; total: number; pct: number; maxAbs: number };
function diffPNG(a: PNG, b: PNG, out: string): Diff {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`frame sizes differ: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  const d = new PNG({ width: a.width, height: a.height }); let changed = 0, maxAbs = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const m = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (m > maxAbs) maxAbs = m;
    const g = Math.round(0.3 * a.data[i] + 0.59 * a.data[i + 1] + 0.11 * a.data[i + 2]) * 0.35;   // the old frame, dimmed, as the map
    if (m > TOLERANCE) { changed++; d.data[i] = 255; d.data[i + 1] = 40; d.data[i + 2] = 40; } else { d.data[i] = d.data[i + 1] = d.data[i + 2] = g; }
    d.data[i + 3] = 255;
  }
  writeFileSync(out, PNG.sync.write(d));
  const total = a.width * a.height;
  return { changed, total, pct: (100 * changed) / total, maxAbs };
}

// ---- 12. the run: per world — old frames, new frames, old again (the noise floor) ------------------------------------------
type Row = { world: string; cam: string; diff: Diff; noise: Diff | null; verdict: "PASS" | "FAIL" | "NOISY" };
const rows: Row[] = [];
try {
  for (const world of Object.keys(WORLDS)) {
    if (ONLY && world !== ONLY) continue;
    const cams = CAMERAS[world] ?? [];
    const dir = join(OUT, world); mkdirSync(dir, { recursive: true });
    const oldPNG = new Map<string, PNG>(), newPNG = new Map<string, PNG>();
    console.log(`\n${bold(`── ${world}`)}`);
    let st = await boot(oldS, world); ok(`client ready: ${world} on old`, st);
    for (const c of cams) oldPNG.set(c.name, await frame(oldS, world, c, join(dir, `${c.name}.old.png`)));
    ok(`frames: ${world} on old`, `${cams.length} camera(s)`);
    st = await boot(newS, world); ok(`client ready: ${world} on new`, st);
    for (const c of cams) newPNG.set(c.name, await frame(newS, world, c, join(dir, `${c.name}.new.png`)));
    ok(`frames: ${world} on new`, `${cams.length} camera(s)`);
    // the control: the OLD tree booted a second time and shot from the first camera. Two boots of the same code differ by
    // whatever is nondeterministic here (asset arrival order, SwiftShader dither, anything still animating); that number is
    // the floor under which an old-vs-new difference means nothing.
    let noise: Diff | null = null;
    if (CONTROL && cams.length) {
      st = await boot(oldS, world); ok(`client ready: ${world} on old (control)`, st);
      const again = await frame(oldS, world, cams[0], join(dir, `${cams[0].name}.old2.png`));
      noise = diffPNG(oldPNG.get(cams[0].name)!, again, join(dir, `${cams[0].name}.noise.png`));
      console.log(`  ${dim(`noise floor (old vs old, ${cams[0].name}): ${noise.changed} / ${noise.total} = ${noise.pct.toFixed(3)}%  max |Δ| ${noise.maxAbs}`)}`);
    }
    for (const c of cams) {
      const d = diffPNG(oldPNG.get(c.name)!, newPNG.get(c.name)!, join(dir, `${c.name}.diff.png`));
      const over = d.pct > THRESHOLD;
      const verdict: Row["verdict"] = !over ? "PASS" : noise && d.pct <= 2 * noise.pct + 0.05 ? "NOISY" : "FAIL";
      rows.push({ world, cam: c.name, diff: d, noise, verdict });
      console.log(`  ${verdict === "PASS" ? "\x1b[32mPASS\x1b[0m" : verdict === "NOISY" ? "\x1b[33mNOISY\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${world} ${c.name}: ${d.changed} / ${d.total} = ${d.pct.toFixed(3)}%  ${dim(`max |Δ| ${d.maxAbs}; threshold ${THRESHOLD}%${noise ? `, noise ${noise.pct.toFixed(3)}%` : ""}`)}`);
    }
  }
} finally {
  try { cws.close(); } catch { /* done */ }
  await cleanup();
}

// ---- 13. the verdict ----------------------------------------------------------------------------------------------------
const fails = rows.filter((r) => r.verdict === "FAIL"), noisy = rows.filter((r) => r.verdict === "NOISY");
const summary = rows.map((r) => `${r.verdict}  ${r.world} ${r.cam}: ${r.diff.changed} / ${r.diff.total} = ${r.diff.pct.toFixed(3)}%${r.noise ? `  (noise ${r.noise.pct.toFixed(3)}%)` : ""}`).join("\n");
writeFileSync(join(OUT, "RESULT.txt"), `surface parity ${STAMP}\nold ${describe(OLD)}\nnew ${describe(NEW)}\nthreshold ${THRESHOLD}% tolerance ${TOLERANCE} clock ${PIN ? `pinned ${PIN_MS}` : "real"} ui ${KEEP_UI ? "kept" : "hidden"}\n\n${summary}\n\nstages: ${stages.join(" · ")}\n`);
console.log(`\n${fails.length ? "\x1b[31mFAIL\x1b[0m" : noisy.length ? "\x1b[33mNOISY\x1b[0m" : "\x1b[32mPASS\x1b[0m"} — ${rows.length} camera(s), ${fails.length} over threshold, ${noisy.length} inside the noise floor`);
console.log(dim(`  frames + diffs: ${OUT}\n  stage line: ${stages.join(" · ")}`));
process.exit(fails.length ? 1 : noisy.length ? 3 : 0);
