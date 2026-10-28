// tools/protocol/run.ts — the protocol gate: every protocol suite, one command, three required lanes.
//   bun tools/protocol/run.ts                 the declared gate (= bun run test:protocol): core, then main, then browser
//   bun tools/protocol/run.ts hostile phys    only the named suites (a PARTIAL run: it says so, and it is not the gate)
//   bun tools/protocol/run.ts --lane core     only one lane (core | main | browser), also PARTIAL
//   bun tools/protocol/run.ts --manifest      print the suite table docs/GATE-MANIFEST.md carries (generated from here)
//   bun tools/protocol/run.ts --check-manifest   exit 1 if the doc's table is not what --manifest prints
//   bun tools/protocol/run.ts --siblings      fetch, pin and build mcpl's two sibling repos beside this checkout
//   bun tools/protocol/run.ts --library <dir>    clone (or move) the asset library to its pin at <dir>, for EIDOVERSE_DIR
//   bun tools/protocol/run.ts --receipt <file>   also write a JSON receipt of this run (head, OS, runtimes, library, scratch dir, per-suite results and output hashes)
//   bun tools/protocol/run.ts --scratch-out <file>   append `scratch=<the gate's temp dir>` to <file> as soon as it exists (CI: $GITHUB_OUTPUT)
// Lanes, all required: CORE (transaction + security: the authority, access, durability, the reset race, identity, scars,
// no-v1, one vocabulary) runs first and stops the gate on any failure; MAIN is every other non-browser suite; BROWSER is
// every suite that drives a headless Chromium (no Chromium = the gate FAILS and names CHROME; it never skips).
// Each suite runs in its own process GROUP with its own timeout, HOME, TMPDIR and scratch (the gate's temp dir, removed
// after each suite); on exit, timeout or Ctrl-C the gate kills the whole group, so no server or Chromium outlives it.
// Runtimes are pinned in package.json "engines" and checked before anything runs. The end prints passed / failed /
// skipped (with reasons) / optional-not-run, and exits nonzero on any failure or any skip.
// Suites mark: a failed check `FAIL …` or `✗ …`; a skipped check `SKIP <name>: <why>` (fails the gate: every lane is
// required); exit code 77 = the whole suite skipped (fails the gate); `OPTIONAL <name>: <why>` = an optional extension
// that did not run (host data, the lab's control arm) — counted and listed, never a failure.
//   PROTOCOL_LAB=<protocol lab checkout>   also run the control arms (common.ts)
//   PROTOCOL_WORLDS=<dir>[:<dir>…] (`;` on Windows)         also sweep / oracle a host's own world logs (the repo's fixtures always)
//   CHROME=<chromium binary>                the browser lane's Chromium (else chrome.ts findChrome: playwright's, else the OS's Chrome/Edge)
//   PYTHON=<python3>                        the conformance suite's interpreter (else python3 on PATH)
//   PROTOCOL_KEEP=1                         keep the gate's temp dir to read
//   PROTOCOL_TIMEOUT_SCALE=<factor>         multiply every suite's timeout (a very slow host: 2)
//   PROTOCOL_HEADLESS_LOCK=<file> PROTOCOL_PERF_GUARD=<script>   run browser suites under a host's flock + perf guard
import { killSuiteAsync, killSuiteAtExit, suiteMembersAsync } from "./procgroup.ts";
import { findChrome } from "./chrome.ts";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs"; import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { ENGINE, controlNote } from "./common.ts";
import { failLines, type Lane, SUITES, CORE, BROWSER, browserLauncher, laneOf, localImports, suitePath } from "./suites.ts";


// what a suite needs beyond bun and this checkout (a scratch dir, loopback ports: every suite may use those)
const NEEDS: Record<string, string> = { conformance: "python3 + cryptography" };
for (const n of BROWSER) NEEDS[n] = "Chromium";
// seconds each suite took on the reference host (WSL2, 16 threads, 7 GB; 2026-10-18, one suite at a time, inside this gate's
// hermetic env; the browser lane from the house gate's run the same day). The timeout
// is 5x that, at least 180 s: a slow host gets room, a hung suite is still killed.
const EXPECT: Record<string, number> = {
  "agent-mesh-collision": 92, "kernel": 0.5, "hygiene": 0.4, "trig": 0.2, "laws": 0.3, "engine": 0.6, "nov1": 0.7, "vocab": 3.5, "nonumber": 1.4, "hostile": 0.3, "attack": 1.5,
  "libfile": 0.1, "gaps": 5.6, "phys": 3.9, "physlive": 1.2, "phystick": 5.7, "sclock": 2.8, "physseeds": 2.1,
  "eidosim": 12, "eidosim-live": 1.5, "mover": 4.5, "zone-water": 0.6, "climb-env": 0.5, "drive": 0.6, "water-vectors": 0.2, "avatar": 1, "remotes-limp-edge": 0.5, "colliders": 0.2, "lying-support": 16, "replay": 0.4,
  "conformance": 2.9, "sweep": 0.3, "oracle": 0.4, "importer": 1.2, "eidosim-v1": 0.2, "inplace": 15, "migrate-identities": 1.7, "oldworlds": 1.2, "browser": 1.5, "descriptors": 0.1,
  "light-readers": 0.4, "ghost-mesh-size": 0.5, "boot-init": 0.5, "editor-range": 0.3, "editschema": 0.5, "scriptnew-expect": 0.5, "grant-command": 0.3, "grant-until": 1, "lite-graph": 1, "say-live": 1, "presence-actor": 1, "first-name-account": 1, "retired-commands": 1, "animnames-retry": 2.5, "panels": 1, "surface-hold": 19, "particles": 1, "shadow-fade": 1, "frames-layout": 1, "models-field": 1, "environment-realizer": 0.3, "lookat-forward": 0.5,
  "role-grammar": 0.3, "rot": 0.1, "onepose": 0.3, "msgrate": 0.1, "dismount-height": 0.2, "build-gate": 0.3,
  "capsule-recovery": 10, "debug-tabs": 0.3, "governor-xr": 0.2, "unknown-comp": 1.1, "reach-order": 1.5,
  "editcommit": 0.8, "hierarchy-commit": 0.6, "verbclasses": 0.0, "authority-layers": 0.0, "authority": 9.0,
  "ids": 1.4, "scars": 1.0, "r8": 0.9, "r9": 1.5, "r10": 1.7, "r11": 0.6, "names": 2.1, "parity": 5.4,
  "directory": 13, "keyhints": 0.0, "client": 60, "refusedjoin": 150, "upgrade": 70, "server": 40, "identity": 42,
  "fork-reset": 6.0, "reset-race": 0.4, "txn": 0.8, "txn-mutants": 11, "blockers-mutants": 420, "scripts": 48, "scripting": 2, "grab": 3.8, "shove": 2.0, "shove-walker": 0.1,
  "agentshove": 165, "hands": 1.2, "reset": 1.7, "settle": 5.4, "disabled": 1.2, "histdiff": 0.3, "reachgate": 22,
  "consent": 0.0, "history-rows": 0.6, "scale": 125, "roles": 3.1, "access": 8.3, "batch2": 1.9,
  "describe-particles": 1.1, "client-b2": 19, "build": 1.5, "counter": 2.2, "build-client": 8.1, "shiplist": 1.7,
  "shiplist-probe": 197, "agenttools": 20, "presence": 10, "modhole": 0.1, "xss-probe": 15, "pretrans": 2.8,
  "soundclock": 0.2, "eidomodel": 0.7, "party-probe": 486, "colour-picker": 8.1, "alias": 0.4, "navgrid": 64,
  "navgrid-edge": 0.6, "places": 130, "places-scale": 6.3, "storey-walk": 1.5, "shape-attach": 0.7, "shape-physics": 0.7,
  "shape-repair": 0.4, "buildcheck": 18, "buildcheck-queue": 7.4, "buildcheck-route": 22, "client-tools": 202, "door-is-error": 280, "history-request": 0.3, "wing-fold-presence": 0.3, "skystamp": 0.5, "normative": 0.2, "last-world": 0.6, "event-wire": 0.1
};
// PROTOCOL_TIMEOUT_SCALE=<factor> stretches (or, to test the kill, shrinks) every timeout; the manifest shows factor 1
const TIMEOUT_SCALE = Number(process.env.PROTOCOL_TIMEOUT_SCALE ?? 1) > 0 ? Number(process.env.PROTOCOL_TIMEOUT_SCALE ?? 1) : 1;
const baseTimeout = (name: string) => Math.max(180, Math.ceil((EXPECT[name] ?? 60) * 5));
const timeoutOf = (name: string) => Math.max(1, Math.round(baseTimeout(name) * TIMEOUT_SCALE));

// ---- the declared runtimes (package.json "engines": the one place) ----
const ENGINES: Record<string, string> = JSON.parse(fs.readFileSync(ENGINE + "package.json", "utf8")).engines ?? {};
const verOf = (s: string | undefined) => (s?.match(/\d+(?:\.\d+)*/)?.[0] ?? "").split(".").map(Number);
// what launching a Chromium looks like in a suite or a local module it imports (tools/harness.ts defines scratchBench, so it
// counts only where it is CALLED); a runner that starts other files says so with the marker comment `gate: launches a browser`

type Result = { name: string; lane: Lane; status: "pass" | "fail" | "skip"; why?: string; ms: number; rowSkips: string[]; optional: string[]; leftovers: number; outSha256?: string };


function manifest() {
  const rows = ["| # | suite | lane | file | needs | expected | timeout |", "|---|---|---|---|---|---|---|"];
  const ordered = [...CORE.map((n) => SUITES.find((s) => s[0] === n)!), ...SUITES.filter(([n]) => laneOf(n) === "main"), ...SUITES.filter(([n]) => laneOf(n) === "browser")];
  ordered.forEach(([name, file], i) => rows.push(`| ${i + 1} | ${name} | ${laneOf(name)} | \`${path.relative(ENGINE, suitePath(file)).split(path.sep).join("/")}${file.includes(" ") ? " " + file.split(" ").slice(1).join(" ") : ""}\` | ${NEEDS[name] ?? "bun"} | ${EXPECT[name] !== undefined ? `${EXPECT[name]} s` : "?"} | ${baseTimeout(name)} s |`));
  const sum = (l: Lane) => SUITES.filter(([n]) => laneOf(n) === l).reduce((a, [n]) => a + (EXPECT[n] ?? 0), 0);
  rows.push("", `Lanes: core ${CORE.length} suites (~${Math.round(sum("core"))} s), main ${SUITES.filter(([n]) => laneOf(n) === "main").length} (~${Math.round(sum("main"))} s), browser ${BROWSER.length} (~${Math.round(sum("browser"))} s); ${SUITES.length} suites in all.`);
  return rows.join("\n");
}
const DOC = ENGINE + "docs/GATE-MANIFEST.md", BEGIN = "<!-- BEGIN GENERATED: bun tools/protocol/run.ts --manifest -->", END = "<!-- END GENERATED -->";
function manifestDrift(): string | null {
  if (!fs.existsSync(DOC)) return `${path.relative(ENGINE, DOC).split(path.sep).join("/")} is missing`;
  const t = fs.readFileSync(DOC, "utf8"), a = t.indexOf(BEGIN), b = t.indexOf(END);
  if (a < 0 || b < a) return `${path.relative(ENGINE, DOC).split(path.sep).join("/")} has no generated block (${BEGIN} … ${END})`;
  return t.slice(a + BEGIN.length, b).replace(/\r\n/g, "\n").trim() === manifest().trim() ? null   // a Windows checkout may carry CRLF
     : `${path.relative(ENGINE, DOC).split(path.sep).join("/")}'s suite table is not what --manifest prints (regenerate it: bun tools/protocol/run.ts --manifest)`;
}

const argv = process.argv.slice(2);
const VALUED = ["--lane", "--receipt", "--scratch-out", "--library"];
const valueOf = (flag: string) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] ?? null : null;
const headOf = (dir: string) => { const r = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; };
// The browser pages load the asset library (Skye's toolkit modules, sky, avatars): a separate public repo, pinned here.
// Declared like Chrome: required for the browser lane, fetched only by --library, never read from a guessed path.
const LIBRARY_REPO = "https://github.com/SkyeShark/eidoverse-video.git";
const LIBRARY_PIN = "9acc1528b2febac11338107645ef500a95985ca5";   // the library's PUBLIC head (10-19: e9f80d02 was a local snapshot, unfetchable by CI)
// mcpl's package.json takes two sibling repos by path (file:../../<dir>, i.e. beside this checkout). The gate owns that
// closure (Mica, #260 r3): ONE place pins them; --siblings fetches them there; the preflight refuses a missing or
// wrong-commit sibling rather than testing whatever happens to sit next to the repo.
// build: whether the gate's suites import it (its package main is dist/, which only `tsc` makes). agent-framework is only
// resolved by bun install, never imported by a gate suite, so it isn't built.
const SIBLINGS: [dir: string, url: string, commit: string, build: boolean][] = [
  ["agent-framework", "https://github.com/anima-research/agent-framework.git", "2f05c28e1923b7d07c6c6322b871303bd0d2d8d5", false],
  ["mcpl-core-ts", "https://github.com/anima-research/mcpl-core-ts.git", "e17f773a9247c41d5c872d760aac7f243748d134", true],
];
const siblingAt = (dir: string) => path.resolve(ENGINE, "..", dir);
const siblingHead = (dir: string) => headOf(siblingAt(dir));
if (argv.includes("--siblings")) {
  for (const [dir, url, commit, build] of SIBLINGS) {
    const at = siblingAt(dir);
    if (!fs.existsSync(at)) { const c = spawnSync("git", ["clone", "-q", url, at], { stdio: "inherit" }); if (c.status !== 0) { console.error(`--siblings: cloning ${url} failed`); process.exit(1); } }
    if (siblingHead(dir) !== commit) {
      spawnSync("git", ["-C", at, "fetch", "-q", "origin", commit], { stdio: "inherit" });
      const c = spawnSync("git", ["-C", at, "checkout", "-q", commit], { stdio: "inherit" });
      if (c.status !== 0) { console.error(`--siblings: ${dir} could not check out ${commit}`); process.exit(1); }
    }
    if (build && !fs.existsSync(path.join(at, "dist"))) for (const step of [["install"], ["run", "build"]]) {
      const c = spawnSync(process.execPath, step, { cwd: at, stdio: "inherit" });
      if (c.status !== 0) { console.error(`--siblings: \`bun ${step.join(" ")}\` failed in ${dir}`); process.exit(1); }
    }
    console.log(`  ${dir.padEnd(16)} ${commit.slice(0, 12)}${build ? " built" : ""}  ${at}`);
  }
  const m = spawnSync(process.execPath, ["install", "--frozen-lockfile"], { cwd: path.join(ENGINE, "mcpl"), stdio: "inherit" });
  process.exit(m.status ?? 1);
}
// --library <dir>: the pinned asset library at <dir> (cloned, or moved to the pin), for EIDOVERSE_DIR=<dir>
if (argv.includes("--library")) {
  const want = valueOf("--library");
  if (!want || want.startsWith("--")) { console.error("--library <dir>: where the asset library goes (then EIDOVERSE_DIR=<dir>)"); process.exit(2); }
  const at = path.resolve(want);
  if (!fs.existsSync(at)) { const c = spawnSync("git", ["clone", "-q", "--filter=blob:none", LIBRARY_REPO, at], { stdio: "inherit" }); if (c.status !== 0) { console.error(`--library: cloning ${LIBRARY_REPO} failed`); process.exit(1); } }
  if (headOf(at) !== LIBRARY_PIN) {
    if (spawnSync("git", ["-C", at, "cat-file", "-e", `${LIBRARY_PIN}^{commit}`]).status !== 0) spawnSync("git", ["-C", at, "fetch", "-q", "--filter=blob:none", "origin", LIBRARY_PIN], { stdio: "inherit" });
    const c = spawnSync("git", ["-C", at, "checkout", "-q", LIBRARY_PIN], { stdio: "inherit" });
    if (c.status !== 0) { console.error(`--library: ${at} could not check out ${LIBRARY_PIN}`); process.exit(1); }
  }
  console.log(`  library   ${LIBRARY_PIN.slice(0, 12)}  ${at}`);
  process.exit(0);
}
if (argv.includes("--manifest")) { console.log(manifest()); process.exit(0); }
if (argv.includes("--check-manifest")) { const d = manifestDrift(); console.log(d ?? "manifest: docs/GATE-MANIFEST.md matches run.ts"); process.exit(d ? 1 : 0); }
const laneArg = valueOf("--lane");
const only = argv.filter((a, i) => !a.startsWith("--") && !VALUED.includes(argv[i - 1]));
for (const n of only) if (!SUITES.some(([s]) => s === n)) { console.log(`protocol gate: no suite named "${n}" (bun tools/protocol/run.ts --manifest lists them)`); process.exit(2); }
if (laneArg && !["core", "main", "browser"].includes(laneArg)) { console.log(`protocol gate: no lane "${laneArg}" (core | main | browser)`); process.exit(2); }
const selected = (name: string) => (!only.length || only.includes(name)) && (!laneArg || laneOf(name) === laneArg);
const partial = only.length > 0 || !!laneArg;

// ---- preflight: the gate's own shape, then the runtimes. Any problem here stops the gate before a suite runs ----
const problems: string[] = [];
for (const n of CORE) if (!SUITES.some(([s]) => s === n)) problems.push(`CORE names "${n}", which is not a suite`);
for (const n of BROWSER) if (!SUITES.some(([s]) => s === n)) problems.push(`BROWSER names "${n}", which is not a suite`);
for (const [name, file] of SUITES) {
  const f = suitePath(file);
  if (!fs.existsSync(f)) { problems.push(`${name}: ${path.relative(ENGINE, f).split(path.sep).join("/")} does not exist`); continue; }
  if (laneOf(name) !== "browser") { const d = browserLauncher(f); if (d) problems.push(`${name} launches a Chromium (${path.relative(ENGINE, d).split(path.sep).join("/")}) but is not in the BROWSER lane`); }
}
if (!partial) { const d = manifestDrift(); if (d) problems.push(d); }
// the siblings are mcpl's: refuse their absence only when a selected suite reaches mcpl/ (C13: conformance, the kernel and the
// pins must run from this checkout alone, with nothing beside it)
const reachesMcpl = (file: string) => { const f = suitePath(file); if (/[\\/]mcpl[\\/]/.test(f)) return true;
  return [...localImports(f)].some((x) => /(?:from|import\(|import)\s*["'`][^"'`]*\bmcpl\//.test(fs.readFileSync(x, "utf8"))); };
const needSiblings = SUITES.some(([n, file]) => selected(n) && reachesMcpl(file));
if (needSiblings) for (const [dir, , commit] of SIBLINGS) { const h = siblingHead(dir);
  if (h === commit && SIBLINGS.find(([d]) => d === dir)![3] && !fs.existsSync(path.join(siblingAt(dir), "dist"))) problems.push(`mcpl's sibling ${dir} is unbuilt (no dist/): run \`bun tools/protocol/run.ts --siblings\``);
  if (h !== commit) problems.push(`mcpl's sibling ${dir} ${h ? `is at ${h.slice(0, 12)}, not the pinned ${commit.slice(0, 12)}` : `is missing at ${siblingAt(dir)}`}: run \`bun tools/protocol/run.ts --siblings\`, which also installs mcpl/`); }
for (const dir of ["", "client/", ...(needSiblings ? ["mcpl/"] : [])]) if (!fs.existsSync(ENGINE + dir + "node_modules")) problems.push(`${dir || "./"}node_modules is missing: run \`bun install --frozen-lockfile\` in ${dir || "the checkout root"}`);

console.log(`protocol gate @ ${ENGINE}`);
const RUNTIMES: Record<string, { found: string | null; declared?: string; where?: string }> = {};   // for --receipt
const runtime = (label: string, found: string | null, want: string | undefined, rule: "major" | "min-major", extra = "") => {
  RUNTIMES[label] = { found, declared: want, where: extra || undefined };
  if (!want) { problems.push(`package.json engines has no "${label}"`); return; }
  if (!found) { problems.push(`${label}: not found${extra ? ` (${extra})` : ""}; declared ${want}`); console.log(`  ${label.padEnd(9)} NOT FOUND   declared ${want}`); return; }
  const f = verOf(found), w = verOf(want);
  const ok = rule === "major" ? f[0] === w[0] : f[0] >= w[0];
  const exact = f.slice(0, w.length).join(".") === w.join(".");
  console.log(`  ${label.padEnd(9)} ${found.padEnd(11)} declared ${want}${ok ? (exact ? "" : `  (note: not the tested ${w.join(".")}; ${rule === "major" ? "same major" : "same or newer major"}: accepted)`) : "  MISMATCH"}${extra ? `  ${extra}` : ""}`);
  if (!ok) problems.push(`${label} ${found} does not match the declared ${want} (${rule === "major" ? "major must match" : `major must be >= ${w[0]}`})`);
};
// PATH's separator and Windows' executable extensions (PATHEXT) differ by OS
const EXTS = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase())] : [""];
const which = (cmd: string) => { if (cmd.includes("/") || cmd.includes("\\")) return fs.existsSync(cmd) ? cmd : null;
  for (const d of (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter)) for (const x of EXTS) { const p = path.join(d || ".", cmd + x); try { fs.accessSync(p, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK); return p; } catch {} } return null; };
console.log("runtimes (package.json engines):");
runtime("bun", Bun.version, ENGINES.bun, "major", process.execPath);
let PY: string | null = null;
if (SUITES.some(([n]) => selected(n) && NEEDS[n]?.startsWith("python3"))) {
  PY = which(process.env.PYTHON || "python3");
  const r = PY ? spawnSync(PY, ["-c", "import sys; print(sys.version.split()[0]); import cryptography; print(cryptography.__version__)"], { encoding: "utf8" }) : null;
  const [pv, cv] = (r?.stdout ?? "").trim().split("\n");
  runtime("python3", pv || null, ENGINES.python3, "major", PY ? `${PY}${cv ? `, cryptography ${cv}` : ""}` : "set PYTHON or put python3 on PATH");
  if (PY && pv && !cv) problems.push(`python3 at ${PY} has no 'cryptography' module (pip install cryptography): the conformance suite's test_chain.py needs it`);
}
let CHROME: string | null = null;
if (SUITES.some(([n]) => selected(n) && laneOf(n) === "browser")) {
  CHROME = findChrome();
  if (CHROME && !fs.existsSync(CHROME)) CHROME = null;
  let v = CHROME ? spawnSync(CHROME, ["--version"], { encoding: "utf8", timeout: 20000 }).stdout?.trim() ?? "" : "";
  // Chrome on Windows writes nothing to a console for --version; its version is in the executable's file properties
  if (CHROME && !v && process.platform === "win32")
    v = spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${CHROME.replace(/'/g, "''")}').VersionInfo.ProductVersion`],
      { encoding: "utf8", timeout: 20000 }).stdout?.trim() ?? "";
  if (process.env.CHROME && !CHROME) problems.push(`CHROME=${process.env.CHROME} does not exist`);
  runtime("chromium", CHROME ? (v.match(/\d+\.\d+\.\d+\.\d+/)?.[0] ?? null) : null, ENGINES.chromium, "min-major",
    CHROME ? CHROME : "the browser lane is REQUIRED: set CHROME=/path/to/chrome (Chromium or Chrome for Testing), or `bunx playwright install chromium`");
  if (CHROME && !v) problems.push(`${CHROME} --version printed nothing: is it a Chromium?`);
}
let LIBRARY: string | null = null, LIBRARY_HEAD: string | null = null;
// suites outside the browser lane that read the asset library, read-only: knockdown's ragdoll needs a real rig (with none
// it falls back to the canned slump, which is what its rows reject)
const READS_LIBRARY = new Set(["knockdown"]);
if (SUITES.some(([n]) => selected(n) && (laneOf(n) === "browser" || READS_LIBRARY.has(n)))) {
  const want = process.env.EIDOVERSE_DIR;
  const fix = `bun tools/protocol/run.ts --library <dir>, then EIDOVERSE_DIR=<dir>`;
  if (!want) problems.push(`the browser lane (and ${[...READS_LIBRARY].join(", ")}) needs the asset library: set EIDOVERSE_DIR (${fix})`);
  else if (!fs.existsSync(path.join(want, "eidoverse", "terrain.js"))) problems.push(`EIDOVERSE_DIR=${want} is not an eidoverse-video checkout (no eidoverse/terrain.js): ${fix}`);
  else {
    LIBRARY = path.resolve(want);
    const head = spawnSync("git", ["-C", LIBRARY, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim() ?? ""; LIBRARY_HEAD = head || null;
    console.log(`  library   ${head ? head.slice(0, 12) : "(not a git checkout)"}  pinned ${LIBRARY_PIN.slice(0, 12)}  ${LIBRARY}${head && head !== LIBRARY_PIN ? "  (note: not the pinned commit)" : ""}`);
  }
}
if (problems.length) {
  console.log(`\nprotocol gate: FAILED before any suite ran:`); for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}

// ---- running a suite: its own process group, timeout, HOME/TMPDIR/scratch; the group killed when it ends ----
const GATE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "eido-gate-"));
// the gate names its own scratch, so CI uploads a failure's logs from where they are on every OS, instead of forcing a temp
// root to know the path (it can't on Windows). Long form: Windows' TEMP is an 8.3 path (C:\Users\RUNNER~1\…)
const SCRATCH_ROOT = (() => { try { return fs.realpathSync.native(GATE_TMP); } catch { return GATE_TMP; } })();
console.log(`  scratch   ${SCRATCH_ROOT}${process.env.PROTOCOL_KEEP ? " (kept: PROTOCOL_KEEP)" : " (removed at exit)"}`);
const scratchOut = valueOf("--scratch-out");
if (scratchOut) fs.appendFileSync(scratchOut, `scratch=${SCRATCH_ROOT.split(path.sep).join("/")}\n`);
let current: { pid: number; exitCode: number | null; signalCode: string | null } | null = null;
// Linux, macOS and Windows alike (tools/protocol/procgroup.ts): a POSIX process group, or the process tree on Windows
// the kill path never blocks (CI 10-21: a synchronous WMI query froze the gate for two hours on Windows, past every timer)
const killGroup = (pid: number, sig: NodeJS.Signals, o?: { exited?: boolean }) => killSuiteAsync(pid, sig, process.platform, o);
const groupMembers = async (pgid: number) => (await suiteMembersAsync(pgid)).length;
// a suite that dies mid-test can leave a read-only dir behind (clientlog-test's unwritable case did): give every dir its write bit back, then remove
const unlock = (d: string) => { try { fs.chmodSync(d, 0o700); for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) unlock(path.join(d, e.name)); } catch { /* gone */ } };
const cleanup = () => { if (current && current.exitCode == null && current.signalCode == null) killSuiteAtExit(current.pid); if (process.env.PROTOCOL_KEEP) return;
  try { fs.rmSync(GATE_TMP, { recursive: true, force: true }); } catch { unlock(GATE_TMP); try { fs.rmSync(GATE_TMP, { recursive: true, force: true }); } catch (e) { console.error(`[gate] couldn't remove ${GATE_TMP}: ${(e as Error).message}`); } } };
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => { console.log(`\nprotocol gate: ${sig}: killing the running suite's process group`); cleanup(); process.exit(130); });

const OPT_TRACKED = (spawnSync("git", ["-C", ENGINE, "ls-files", "-z", "assets/opt"], { encoding: "utf8" }).stdout ?? "").split("\0").filter(Boolean).map((f) => f.slice("assets/opt/".length));
const PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? process.env.Path ?? "/usr/bin:/bin"}`;   // a nested `bun` is this bun
// files a suite leaves in the checkout fail it (a killed child skips its own cleanup on Windows: #260 review)
const untracked = () => new Set((spawnSync("git", ["-C", ENGINE, "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).stdout ?? "").split("\0").filter(Boolean));
async function run(name: string, file: string): Promise<{ code: number | null; signal: string | null; out: string; timedOut: boolean; leftovers: number; stuck?: boolean }> {
  const dir = fs.mkdtempSync(path.join(GATE_TMP, `${name}-`));
  for (const d of ["home", "library", "opt", "worlds", "patched"]) fs.mkdirSync(path.join(dir, d));
  // the asset cache starts empty EXCEPT for what the repo itself commits there (props/ball.glb, a fixture since 08-03):
  // hermetic means no host cache, not hiding this checkout's own files
  for (const rel of OPT_TRACKED) { const to = path.join(dir, "opt", rel); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(ENGINE, "assets/opt", rel), to); }
  // hermetic: nothing the suite reads by default lies outside this checkout and this dir (no ~, no ../eidoverse-video)
  const env: Record<string, string> = { ...process.env as Record<string, string>, PATH, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    HOME: path.join(dir, "home"), TMPDIR: dir, PROTOCOL_SCRATCH: dir, EIDOVERSE_DIR: path.join(dir, "library"), OPT_DIR: path.join(dir, "opt"),
    WORLDS_DIR: path.join(dir, "worlds"), PATCH_DIR: path.join(dir, "patched"), SKIP_OPT_SWEEP: "1" };
  if (PY) env.PYTHON = PY;
  if (CHROME) env.CHROME = CHROME;
  if (LIBRARY && (laneOf(name) === "browser" || READS_LIBRARY.has(name))) env.EIDOVERSE_DIR = LIBRARY;   // read-only use; every other suite keeps its empty library
  const [script, ...args] = file.split(" ");
  let cmd = [process.execPath, path.resolve(ENGINE, "tools/protocol", script), ...args];
  const lock = process.env.PROTOCOL_HEADLESS_LOCK, guard = process.env.PROTOCOL_PERF_GUARD;
  if (laneOf(name) === "browser" && lock && guard) cmd = ["flock", lock, "bash", guard, "-t", String(timeoutOf(name)), "--", ...cmd];
  const child = spawn(cmd[0], cmd.slice(1), { cwd: ENGINE, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  current = child as unknown as { pid: number; exitCode: number | null; signalCode: string | null };
  let out = "", timedOut = false; const keep = (b: Buffer) => { out += b.toString(); if (out.length > 4e6) out = out.slice(-2e6); };
  child.stdout!.on("data", keep); child.stderr!.on("data", keep);
  const timer = setTimeout(() => { timedOut = true; void killGroup(child.pid!, "SIGTERM"); setTimeout(() => void killGroup(child.pid!, "SIGKILL"), 5000).unref(); }, timeoutOf(name) * 1000);
  // the watchdog: a suite still alive a minute past its timeout (its kill didn't land) is left behind and named, never waited on
  let stuck = false; let watchdog: ReturnType<typeof setTimeout> | undefined;
  const [code, signal] = await new Promise<[number | null, string | null]>((res) => { child.on("exit", (c, s) => res([c, s])); child.on("error", (e) => { out += `\nspawn failed: ${e.message}`; res([null, null]); });
    watchdog = setTimeout(() => { stuck = true; timedOut = true; res([null, null]); }, (timeoutOf(name) + 60) * 1000); });
  clearTimeout(timer); clearTimeout(watchdog);
  const leftovers = child.pid ? await groupMembers(child.pid) : 0;   // anything the suite started and left running
  if (child.pid) await killGroup(child.pid, "SIGKILL", { exited: !stuck });
  await new Promise((r) => { if (child.stdout!.readableEnded) return r(null); child.stdout!.once("end", r); setTimeout(r, 3000); });   // the last output, once the group is gone
  current = null;
  if (!process.env.PROTOCOL_KEEP) fs.rmSync(dir, { recursive: true, force: true });
  return { code, signal, out, timedOut, leftovers, stuck };
}

// ---- the gate ----
const results: Result[] = []; const t0 = performance.now();
const order = [...CORE, ...SUITES.map(([n]) => n).filter((n) => laneOf(n) === "main"), ...SUITES.map(([n]) => n).filter((n) => laneOf(n) === "browser")];
let stopped = "";
for (const name of order) {
  if (!selected(name)) continue;
  const [, file, tail] = SUITES.find(([n]) => n === name)!; const lane = laneOf(name);
  if (stopped) { results.push({ name, lane, status: "skip", why: stopped, ms: 0, rowSkips: [], optional: [], leftovers: 0 }); continue; }
  const t = performance.now();
  if (process.env.CI) console.log(`-- start ${name} (${new Date().toISOString()})`);   // a hang between suites names itself (Windows CI 10-19 went silent for 80 min)
  const before = untracked();
  const r = await run(name, file);
  const residue = [...untracked()].filter((f) => !before.has(f));
  for (const f of residue) fs.rmSync(path.join(ENGINE, f), { force: true });
  const lines = r.out.trimEnd().split("\n");
  const fails = lines.filter((l) => /^\s*FAIL\b|✗/.test(l));   // the browser probes mark a failed check with ✗, not FAIL
  const rowSkips = lines.filter((l) => /^\s*SKIP\b/.test(l)).map((l) => l.trim());
  const optional = lines.filter((l) => /^\s*OPTIONAL\b/.test(l)).map((l) => l.trim());
  const ms = performance.now() - t;
  let status: Result["status"] = r.code === 0 ? "pass" : r.code === 77 ? "skip" : "fail";
  let why = r.stuck ? `timed out after ${timeoutOf(name)} s, and it wouldn't die: left behind after a minute more (its kill didn't land)` : r.timedOut ? `timed out after ${timeoutOf(name)} s (process group killed)` : r.code === 77 ? (rowSkips.at(-1) ?? lines.at(-1)) : r.code === 0 ? undefined : `exit ${r.code ?? r.signal}`;
  if (status === "pass" && rowSkips.length) { status = "skip"; why = `${rowSkips.length} check(s) skipped`; }
  if (r.timedOut) status = "fail";
  if (residue.length) { status = "fail"; why = `${why ? why + "; " : ""}left ${residue.length} file(s) in the checkout (removed): ${residue.slice(0, 5).join(", ")}`; }
  results.push({ name, lane, status, why, ms, rowSkips, optional, leftovers: r.leftovers, outSha256: createHash("sha256").update(r.out).digest("hex") });
  console.log(`\n== ${name} [${lane}] (${file}) ${status.toUpperCase()}${why ? ` (${why})` : ""} ${(ms / 1000).toFixed(1)} s${r.leftovers ? (r.stuck ? ` · ${r.leftovers} process(es) may still be running (the kill didn't land)` : ` · killed ${r.leftovers} leftover process(es)`) : ""}`);
  const evidence = failLines(lines); for (const l of evidence.slice(0, 60)) console.log(l);   // each FAIL with what it saw (10-23)
  for (const l of rowSkips.slice(0, 20)) console.log(l);
  // a suite that failed without one FAIL line crashed: its last line is the runtime's banner, so show enough to read the error (CI 10-21: six Windows reds read 'Bun v1.3.14' and nothing else)
  const crashed = status === "fail" && !fails.length && !r.timedOut;
  for (const l of lines.slice(-(crashed ? Math.max(tail, 30) : tail))) if (!evidence.includes(l) && !rowSkips.includes(l)) console.log(l);
  if (lane === "core" && status !== "pass") stopped = `not run: the core lane failed at ${name}`;
}

// ---- the tally ----
const count = (l: Lane | null, s: Result["status"]) => results.filter((r) => (!l || r.lane === l) && r.status === s).length;
console.log(`\n== protocol gate: tally (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
for (const l of ["core", "main", "browser"] as Lane[]) if (results.some((r) => r.lane === l)) console.log(`  ${l.padEnd(8)} ${count(l, "pass")} passed, ${count(l, "fail")} failed, ${count(l, "skip")} skipped`);
console.log(`  total    ${count(null, "pass")} passed, ${count(null, "fail")} failed, ${count(null, "skip")} skipped (every lane is required: a skip fails the gate)`);
for (const r of results.filter((r) => r.status === "fail")) console.log(`  FAILED  ${r.name} [${r.lane}]: ${r.why}`);
for (const r of results.filter((r) => r.status === "skip")) { console.log(`  SKIPPED ${r.name} [${r.lane}]: ${r.why}`); for (const s of r.rowSkips) console.log(`          ${s}`); }
const optional = new Map<string, string>(); for (const r of results) for (const o of r.optional) { const k = o.match(/^OPTIONAL\s+(\S+?):/)?.[1] ?? o; if (!optional.has(k)) optional.set(k, o.replace(/^OPTIONAL\s+\S+?:\s*/, "")); }
if (!process.env.PROTOCOL_LAB) { const n = controlNote(); const k = n.match(/^OPTIONAL\s+(\S+?):/)?.[1]; if (k && !optional.has(k)) optional.set(k, n.replace(/^OPTIONAL\s+\S+?:\s*/, "")); }
console.log(`  optional, not run: ${optional.size}${optional.size ? "" : " (none)"}`); for (const [k, v] of optional) console.log(`          ${k}: ${v}`);
const left = results.reduce((a, r) => a + r.leftovers, 0); if (left) console.log(`  leftover processes killed with their suite's group: ${left}`);
const bad = count(null, "fail") + count(null, "skip");
const notRun = SUITES.filter(([n]) => !selected(n)).length;
console.log(`protocol gate: ${bad ? "FAILED" : partial ? `PARTIAL PASS (${notRun} suite(s) not selected: this is not the gate)` : "PASS"}`);
// --receipt <file>: a machine-readable record of THIS run at THIS head (review #260 rereview: "a durable exact-head gate
// receipt: environment/runtime identities, source head, pinned library head, tally, and log/artifact hash")
const receiptAt = valueOf("--receipt");
if (receiptAt) {
  const git = (a: string[]) => spawnSync("git", ["-C", ENGINE, ...a], { encoding: "utf8" }).stdout?.trim() ?? "";
  const suites = results.map(({ name, lane, status, why, ms, leftovers, outSha256 }) => ({ name, lane, status, why, ms: Math.round(ms), leftovers, outSha256 }));
  const receipt = {
    v: 1, verdict: bad ? "FAILED" : partial ? "PARTIAL" : "PASS", head: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]) !== "",
    os: { platform: process.platform, release: os.release(), arch: process.arch }, runtimes: { ...RUNTIMES, bun: { ...RUNTIMES.bun, found: Bun.version } },
    library: LIBRARY ? { head: LIBRARY_HEAD, pinned: LIBRARY_PIN } : null, scratch: { dir: SCRATCH_ROOT, kept: !!process.env.PROTOCOL_KEEP }, seconds: Math.round((performance.now() - t0) / 1000),
    tally: Object.fromEntries((["core", "main", "browser"] as Lane[]).map((l) => [l, { pass: count(l, "pass"), fail: count(l, "fail"), skip: count(l, "skip") }])),
    notSelected: notRun, suites,
    // one hash over every suite's captured output, in run order: the log this verdict rests on
    logSha256: createHash("sha256").update(suites.map((x) => `${x.name}\t${x.outSha256 ?? ""}`).join("\n")).digest("hex"),
  };
  fs.writeFileSync(receiptAt, JSON.stringify(receipt, null, 1) + "\n");
  console.log(`receipt: ${receiptAt} (head ${receipt.head.slice(0, 12)}${receipt.dirty ? ", DIRTY tree" : ""}, ${receipt.verdict})`);
}
process.exit(bad ? 1 : 0);
