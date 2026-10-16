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
  ["vocab", "vocab-check.ts", 1],       // R 10-14 one vocabulary: a record is read in the protocol's names (model, flat components), never lib / comp
  ["nonumber", "nonumber-check.ts", 1], // R 10-07 "a version number isn't a name": the protocol's number lives only in genesis {dialect, v}
  ["hostile", "hostile-check.ts", 2],   // PROTOCOL §6 proof 1: hostile logs against the strict fold
  ["attack", "attack-check.ts", 2],     // §6 proofs 2–3: 25d H1/H2/H4 attacks through the authority (admit, L7)
  ["libfile", "libfile-check.ts", 2],  // #213 port: the resolver walks /library's own ladder and answers what the route serves
  ["gaps", "gaps-check.ts", 2],         // research 34: creator rights, presence track, rate, two hands
  ["phys", "phys-check.ts", 1],         // design 20: launches, rests by cause, carriers
  ["physlive", "physlive-check.ts", 1],
  ["phystick", "phystick-check.ts", 1],
  ["sclock", "sclock-check.ts", 1],     // the client's server clock slews toward a new estimate instead of stepping  // the engine's heartbeat: rests log on the server beat, requests stay cheap, passes are bounded // design 20 as the running server holds it (shapes, punt, release pose, one clock) and as a client folds it
  ["physseeds", "physseeds-check.ts", 1], // research physics-seeds 10-07: shape grammar, physical properties, spin on release, the state sample, one clock (a real server whose log is ahead of wall time)
  ["eidosim", "eidosim-check.ts", 1], // eidosim's adapter: any schedule reaching tick T gives the same bits; spin capped like v; a mirror is the same box
  ["eidosim-live", "eidosim-live-check.ts", 1], // eidosim at the authority: locks (own, ancestor, descendant) hold against knocks; knocked children rest on the record; spheres on the live host
  ["mover", "mover-check.ts", 1],       // ONE walker (shared/mover.js) for the agent, the client and the authority: no caller's own numbers; floor rule, walls, arrival; agreement with the real authority
  ["colliders", "../collider-test.ts", 1], // the walker's reading of placed geometry, incl. things a tumbling engine laid on their sides (review of b398d7e3 #1)
  ["lying-support", "../lying-support-test.ts", 1], // an agent's support for a thing lying down: its true top, no phantom deck at its origin (review of b398d7e3 #1)
  ["replay", "replay-check.ts", 1],     // L1: the fold alone, self-agreement, the lab's digest
  ["conformance", "compare.ts", 3],     // the JS fold vs the Python reference reader (+ its own tests)
  ["sweep", "sweep.ts", 4],
  ["oldworlds", "../oldworlds-test.ts", 1], // owner 10-15: an old-format world is found and named at boot (the exact translate command), and a visitor is told in plain words             // the old-world importer (tools/protocol/import-v1/) on every local old world log + her dialect-3 goldens + pins
  ["browser", "browser-check.ts", 1],   // the shared core imported by headless Chromium, byte-for-byte with bun
  ["descriptors", "../descriptor-defaults-test.ts", 1], // C5 (DEBT 10-12 #3a): every record and inspector default is the registry's, through the editor translation
  ["light-readers", "../light-readers-test.ts", 1], // D2 (DEBT-2 #5): a light is found by kindOf and the rig's complight key, its gizmo is no box or material slot
  ["ghost-mesh-size", "../ghost-mesh-size-test.ts", 1], // D1: every shape × scale the build ghost sends passes the door's mesh check (the plane at 1/1.1 did not)
  ["boot-init", "../boot-init-test.ts", 1], // D3: every client init* has a caller (initSeats had none)
  ["editor-range", "../editor-range-test.ts", 1], // D4a: the editor writes what was typed inside the door's range, and refuses outside it with nothing sent
  ["lookat-forward", "../lookat-forward-check.ts", 1], // D7: the authority and the door give one verdict on every LookAt.forward
  ["role-grammar", "../role-grammar-test.ts", 1], // D7: one role-id grammar (grab, sockbody, rolespanels, commands)
  ["lock-level", "../lock-level-test.ts", 1], // D7: the lock ladders and the role ranks agree (messages.ts had no moderator)
  ["rot", "../rot-test.ts", 1], // shared/rot.js: quaternion orientation, and no host transcendental (R1: lyingFrame had three)
  ["build-gate", "../build-gate-test.ts", 1], // edit mode is gated at the chokepoint, never trapping a demoted builder (revived D6)
  ["capsule-recovery", "../capsule-recovery-test.mjs", 1], // a remote's capsule fallback: bounded retries, the identity guard across takeovers (revived D6)
  ["debug-tabs", "../debug-tabs-test.ts", 1], // the debug window builds only the chosen tab's groups (revived D6)
  ["governor-xr", "../governor-xr-test.ts", 1], // in a headset the frame governor never moves the pixel ratio (revived D6)
  ["unknown-comp", "../unknown-comp-test.ts", 1], // an unknown component blocks nothing, from the door to the realizer to the inspector (revived D6)
  ["reach-order", "../reach-order-test.ts", 1], // reach chains solve in dependency order, cycles refuse and release cleanly (revived D6; needs the avatar corpus at assets/opt/eidoverse)
  ["editcommit", "../editcommit-test.ts", 1], // inspect.js commitEdit against the real authority: a live call previews, the final one sends ONE request (revived by D2)
  ["hierarchy-commit", "../hierarchy-commit-test.ts", 1], // a Hierarchy drag is ONE undo step, through commitEdit and the door, and Ctrl+Z takes it back (revived by D2)
  ["verbclasses", "verbclasses-check.ts", 1], // one home for READ_ONLY/GHOST_OK/WIRE_READS/PERSON_ACTS (DEBT 10-12 #10); classes pinned as of 10-12
  ["authority-layers", "authority-layers-check.ts", 1], // C11 (DEBT 10-12 #4b): the authority split is a DAG — a leaf under shared/protocol/authority/ never imports the gate or a leaf above it
  ["authority", "authority-check.ts", 1],
  ["directory", "directory-check.ts", 1],
  ["keyhints", "../keyhints-check.ts", 1], // R 10-04: no hidden keys in edit mode (every modifier tagged and shown)
  ["client", "client-check.ts", 1],     // slice 3b: edit mode in headless Chromium against a scratch server (one browser, guarded)
  ["refusedjoin", "refusedjoin-check.ts", 1], // R 10-16 00:02: a refused join (old-format world, no such world) stays on the splash in the server's words — the early socket's refusal is honoured, no redial, no empty world
  ["server", "server-check.ts", 1],     // the server: real processes, real WebSockets, scratch ports
  ["identity", "identity-check.ts", 1], // who a joiner is: C1-C3, H1, H3-H5 (security review 10-06), one identity per account
  ["fork-reset", "fork-reset-check.ts", 1],
  ["reset-race", "reset-race-check.ts", 1], // review 10-14 C1: a request awaiting warm() across a reset refuses instead of writing the old log's line into the new file // world fork (a new world naming its source) and reset (archived, re-founded by its owners)
  ["scripts", "scripts-check.ts", 1],   // research 41: scripts in QuickJS on sponsor rights; use → script; a timer through a real server
  ["grab", "grab-check.ts", 1],         // grabbable (research grab 10-06): the gate, release modes, the hold record, use while held
  ["shove", "shove-check.ts", 1],       // body shove at the authority: punt {shove: true}'s own gate (a body against it, at a walk's speed, away from the feet, at rest)
  ["shove-walker", "../shove-test.ts", 1], // …the walker's side (shared/shove.js): one punt per contact, bounded, none standing still or for what may not be shoved
  ["agentshove", "agentshove-check.ts", 1], // …an agent's walk shoves too, through the same punt (a real WorldAgent on a real server)
  ["hands", "hands-check.ts", 1],       // what is in a hand and where a put lands: held things are not ground, no perching, an edit takes it from the hand, two hands
  ["reset", "reset-check.ts", 1],       // a reset button: reactions kind reset, the home component
  ["settle", "settle-check.ts", 1],
  ["disabled", "disabled-check.ts", 1],   // a switched-off thing (R 10-11): no handling, no body, nothing stands on it; back on, all returns     // what a thing at rest is attached to
  ["histdiff", "history-diff-check.ts", 1], // history {id}: each entry says what changed (a field, from what to what)
  ["reachgate", "reachgate-check.ts", 1], // design review 10-15 item 1: a hand on another body relays only with their consent (the relay strips it, the reacher is told)
  ["consent", "consent-check.ts", 1],   // the consent tool never writes through a prototype (security pass 2, H-0)
  ["history-rows", "history-rows-check.ts", 1],   // the editor History never shows a refused attempt as done (Commons parity audit)
  ["scale", "scale-check.ts", 1],       // the authority at scale: every request under 50 ms at 72/500/2 000 things; gates before work; capacity; indoors (review 10-06)
  ["roles", "roles-check.ts", 1],       // roles + moderation (research roles 10-06): ranks, permissions, the grant rule, sanctions, ghost
  ["batch2", "batch2-check.ts", 1],
  ["describe-particles", "describe-particles-check.ts", 1], // R 10-07: description (the accessibility reading) and particles as effect documents (Godot's CPUParticles3D ported)     // edit mode v1 batch 2: story, text, picture, sound (+ where media may come from), look-at, Credits in History
  ["client-b2", "batch2-probe.ts", 1],  // batch 2 in headless Chromium: a stage per component, and an untrusted link never fetched without the viewer's opt-in
  ["build", "build-check.ts", 1],       // ship-list group B (10-07): building walls at the authority, nested blueprints, the editor's new script
  ["counter", "counter-check.ts", 1],   // PR #208 review's twelve-line list, as a counter button: publish/attach (§4.1), a script on sponsor rights (§8), the algebra (§7a) — C1…C12; blueprint-test.ts (tools/, run-client) is the pure half it leans on
  ["build-client", "build-probe.ts", 1], // …and in a real browser: a building edit and its undo, turn/size before placing, the new-script card (one browser, guarded)
  ["shiplist", "shiplist-check.ts", 1], // ship list group A (audit 10-07): openable, reactions checked at write, motion fields, help text, people's words
  ["shiplist-probe", "shiplist-probe.ts", 1], // …in headless Chromium: E opens a door and it swings; a person's refusal and warning; a moderator's warning in VR
  ["agenttools", "agenttools-check.ts", 1], // the agent's tools on a real server (tools audit 10-07): move walks the authority's body (walls), create {from}, a refused shove is an error, MCP annotations, look points at real tools
  ["presence", "presence-check.ts", 1], // security pass 3 H2: no one shows under another account's name; puppet/bodydrag/typing/whisper reach the identity named
  ["modhole", "modhole-check.ts", 1],   // security pass 3: nothing a world sends runs as code in a visitor's browser; EW.mods.put/run need your hand
  ["xss-probe", "xss-probe.ts", 1],     // security pass 3 H1 in headless Chromium: a hostile display name is text everywhere; the page's CSP refuses inline script and lets the client run
  ["pretrans", "pretrans-check.ts", 1], // review 10-07 "protocol shape": the edges the Commons translation makes permanent (names, defaults, ids, refs, governance, models, privacy)
  ["soundclock", "soundclock-check.ts", 1], // a sound's shared playhead is on the server's clock (serverNow), never Date.now
  ["eidomodel", "eidomodel-check.ts", 1], // review 10-07 H3: a translated world's models are eido:sha256 addresses; the index, /eido/, /library/eido/, the client's mapping
  ["party-probe", "party-probe.ts", 1], // the editor's party blockers (review 10-07 B1–B5, S1/S4/S5/S7, lock levels, moderation commands) with real mouse and keys
  ["colour-picker", "../colour-picker-bench.ts", 1], // the Inspector's colour field is a picker of solid cells a headset quad can click (R 10-12), in headless Chromium (one browser, guarded)
  ["alias", "../../mcpl/alias-test.ts", 1], // old tool names AND their old argument shapes run the new tool (10-15)
  ["client-tools", "../run-client.ts --import-only", 14], // refactor plan 2 D5: every tools/*-{test,check} loads (a stub missing an export, a moved module); the full run is `bun tools/run-client.ts`
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
  const [script, ...scriptArgs] = file.split(" ");
  let cmd = ["bun", ENGINE + "tools/protocol/" + script, ...scriptArgs]; let senv: Record<string, string | undefined> = env;
  if (name === "client" || name === "client-b2" || name === "build-client" || name === "shiplist-probe" || name === "xss-probe" || name === "party-probe" || name === "colour-picker") {   // the browser suites
    const home = process.env.HOME ?? "";
    const chrome = process.env.CHROME ?? [`${home}/.local/chrome153/chrome-linux64/chrome`, "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
    if (!chrome) { console.log(`\n== ${name} (${file}) SKIPPED: no Chrome on this host (set CHROME)`); continue; }
    senv = { ...env, CHROME: chrome, SKIP_OPT_SWEEP: "1" };
    const lock = `${home}/eido/.headless.lock`, guard = "/mnt/c/Users/Claude/code/scripts/perf-guard.sh";
    if (existsSync(guard) && existsSync(lock)) cmd = ["flock", lock, "bash", guard, "-t", name === "party-probe" ? "650" : "400", "--", ...cmd];   // the party probe drives ~12 stages by hand: ~6 min on this host
  }
  const r = Bun.spawnSync(cmd, { cwd: ENGINE, env: senv });
  const out = (r.stdout.toString() + r.stderr.toString()).trimEnd().split("\n");
  const fails = out.filter((l) => /^\s*FAIL\b|✗/.test(l));   // the browser probes mark a failed check with ✗, not FAIL
  const ok = r.exitCode === 0;
  if (!ok) failed.push(name);
  console.log(`\n== ${name} (${file}) ${ok ? "PASS" : `FAIL (exit ${r.exitCode})`} ${((performance.now() - t) / 1000).toFixed(1)} s`);
  for (const l of fails.slice(0, 20)) console.log(l);
  for (const l of out.slice(-tail)) console.log(l);
}
console.log(`\n${controlNote()}`);
console.log(`protocol: ${failed.length ? `FAILED: ${failed.join(", ")}` : "all suites pass"} (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
process.exit(failed.length ? 1 : 0);
