// tools/protocol/run.ts — every protocol suite, one command:
//   bun run test:protocol           (= BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/run.ts)
//   PROTOCOL_LAB=<protocol lab checkout>        also run the control arms (the lab's pre-fix door and fold; see common.ts)
//   PROTOCOL_WORLDS=<dir>[:<dir>…]        where the sweep looks for world logs (default: the checkout's parent directory)
//   bun tools/protocol/run.ts hostile phys    run only the named suites
// Each suite runs in its own process (they pin the authority's clock through PROTOCOL_NOW). Prints each suite's tail; exits 1
// if any suite fails.
import { existsSync } from "node:fs";
import { ENGINE, controlNote } from "./common.ts";

const SUITES: [string, string, number][] = [ // name, file, tail lines to show
  ["nov1", "nov1-check.ts", 1],         // R 10-06 "no more v1 anywhere": no runtime file loads the old-world importer or speaks v1
  ["nonumber", "nonumber-check.ts", 1], // R 10-07 "a version number isn't a name": the protocol's number lives only in genesis {dialect, v}
  ["hostile", "hostile-check.ts", 2],   // PROTOCOL §6 proof 1: hostile logs against the strict fold
  ["attack", "attack-check.ts", 2],     // §6 proofs 2–3: 25d H1/H2/H4 attacks through the authority (admit, L7)
  ["gaps", "gaps-check.ts", 2],         // research 34: creator rights, presence track, rate, two hands
  ["phys", "phys-check.ts", 1],         // design 20: launches, rests by cause, carriers
  ["physlive", "physlive-check.ts", 1], // design 20 as the running server holds it (shapes, punt, release pose, one clock) and as a client folds it
  ["physseeds", "physseeds-check.ts", 1], // research physics-seeds 10-07: shape grammar, physical properties, spin on release, the state sample, one clock (a real server whose log is ahead of wall time)
  ["replay", "replay-check.ts", 1],     // L1: the fold alone, self-agreement, the lab's digest
  ["conformance", "compare.ts", 3],     // the JS fold vs the Python reference reader (+ its own tests)
  ["sweep", "sweep.ts", 4],             // the old-world importer (tools/protocol/import-v1/) on every local old world log + her dialect-3 goldens + pins
  ["browser", "browser-check.ts", 1],   // the shared core imported by headless Chromium, byte-for-byte with bun
  ["authority", "authority-check.ts", 1],
  ["directory", "directory-check.ts", 1],
  ["keyhints", "../keyhints-check.ts", 1], // R 10-04: no hidden keys in edit mode (every modifier tagged and shown)
  ["client", "client-check.ts", 1],     // slice 3b: edit mode in headless Chromium against a scratch server (one browser, guarded)
  ["server", "server-check.ts", 1],     // the server: real processes, real WebSockets, scratch ports
  ["identity", "identity-check.ts", 1], // who a joiner is: C1-C3, H1, H3-H5 (security review 10-06), one identity per account
  ["fork-reset", "fork-reset-check.ts", 1], // world fork (a new world naming its source) and reset (archived, re-founded by its owners)
  ["scripts", "scripts-check.ts", 1],   // research 41: scripts in QuickJS on sponsor rights; use → script; a timer through a real server
  ["grab", "grab-check.ts", 1],         // grabbable (research grab 10-06): the gate, release modes, the hold record, use while held
  ["consent", "consent-check.ts", 1],   // the consent tool never writes through a prototype (security pass 2, H-0)
  ["history-rows", "history-rows-check.ts", 1],   // the editor History never shows a refused attempt as done (Commons parity audit)
  ["scale", "scale-check.ts", 1],       // the authority at scale: every request under 50 ms at 72/500/2 000 things; gates before work; capacity; indoors (review 10-06)
  ["roles", "roles-check.ts", 1],       // roles + moderation (research roles 10-06): ranks, permissions, the grant rule, sanctions, ghost
  ["batch2", "batch2-check.ts", 1],
  ["describe-particles", "describe-particles-check.ts", 1], // R 10-07: description (the accessibility reading) and particles as effect documents (Godot's CPUParticles3D ported)     // edit mode v1 batch 2: story, text, picture, sound (+ where media may come from), look-at, Credits in History
  ["client-b2", "batch2-probe.ts", 1],  // batch 2 in headless Chromium: a stage per component, and an untrusted link never fetched without the viewer's opt-in
  ["build", "build-check.ts", 1],       // ship-list group B (10-07): building walls at the authority, nested blueprints, the editor's new script
  ["build-client", "build-probe.ts", 1], // …and in a real browser: a building edit and its undo, turn/size before placing, the new-script card (one browser, guarded)
  ["shiplist", "shiplist-check.ts", 1], // ship list group A (audit 10-07): openable, reactions checked at write, motion fields, help text, people's words
  ["shiplist-probe", "shiplist-probe.ts", 1], // …in headless Chromium: E opens a door and it swings; a person's refusal and warning; a moderator's warning in VR
  ["presence", "presence-check.ts", 1], // security pass 3 H2: no one shows under another account's name; puppet/bodydrag/typing/whisper reach the identity named
  ["modhole", "modhole-check.ts", 1],   // security pass 3: nothing a world sends runs as code in a visitor's browser; EW.mods.put/run need your hand
  ["xss-probe", "xss-probe.ts", 1],     // security pass 3 H1 in headless Chromium: a hostile display name is text everywhere; the page's CSP refuses inline script and lets the client run
  ["pretrans", "pretrans-check.ts", 1], // review 10-07 "protocol shape": the edges the Commons translation makes permanent (names, defaults, ids, refs, governance, models, privacy)
  ["soundclock", "soundclock-check.ts", 1], // a sound's shared playhead is on the server's clock (serverNow), never Date.now
  ["eidomodel", "eidomodel-check.ts", 1], // review 10-07 H3: a translated world's models are eido:sha256 addresses; the index, /eido/, /library/eido/, the client's mapping
  ["party-probe", "party-probe.ts", 1], // the editor's party blockers (review 10-07 B1–B5, S1/S4/S5/S7, lock levels, moderation commands) with real mouse and keys
];
const only = process.argv.slice(2);
const env = { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }; // a cached transpile once hid a stale module (bun cache poison)
let failed: string[] = [];
const t0 = performance.now();
for (const [name, file, tail] of SUITES) {
  if (only.length && !only.includes(name)) continue;
  const t = performance.now();
  // the browser suite runs under the house guards when this host has them (one headless Chrome at a time, perf-guard,
  // no boot re-encoder: memory reference_browser_probe_hygiene); a host with no Chrome skips it, and says so
  let cmd = ["bun", ENGINE + "tools/protocol/" + file]; let senv: Record<string, string | undefined> = env;
  if (name === "client" || name === "client-b2" || name === "build-client" || name === "shiplist-probe" || name === "xss-probe" || name === "party-probe") {   // the browser suites
    const home = process.env.HOME ?? "";
    const chrome = process.env.CHROME ?? [`${home}/.local/chrome153/chrome-linux64/chrome`, "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
    if (!chrome) { console.log(`\n== ${name} (${file}) SKIPPED: no Chrome on this host (set CHROME)`); continue; }
    senv = { ...env, CHROME: chrome, SKIP_OPT_SWEEP: "1" };
    const lock = `${home}/eido/.headless.lock`, guard = "/mnt/c/Users/Claude/code/scripts/perf-guard.sh";
    if (existsSync(guard) && existsSync(lock)) cmd = ["flock", lock, "bash", guard, "-t", name === "party-probe" ? "650" : "400", "--", ...cmd];   // the party probe drives ~12 stages by hand: ~6 min on this host
  }
  const r = Bun.spawnSync(cmd, { cwd: ENGINE, env: senv });
  const out = (r.stdout.toString() + r.stderr.toString()).trimEnd().split("\n");
  const fails = out.filter((l) => /^\s*FAIL\b/.test(l));
  const ok = r.exitCode === 0;
  if (!ok) failed.push(name);
  console.log(`\n== ${name} (${file}) ${ok ? "PASS" : `FAIL (exit ${r.exitCode})`} ${((performance.now() - t) / 1000).toFixed(1)} s`);
  for (const l of fails.slice(0, 20)) console.log(l);
  for (const l of out.slice(-tail)) console.log(l);
}
console.log(`\n${controlNote()}`);
console.log(`protocol: ${failed.length ? `FAILED: ${failed.join(", ")}` : "all suites pass"} (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
process.exit(failed.length ? 1 : 0);
