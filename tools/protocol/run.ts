// tools/protocol/run.ts — the protocol gate: every protocol suite, one command, three required lanes.
//   bun tools/protocol/run.ts                 the declared gate (= bun run test:protocol): core, then main, then browser
//   bun tools/protocol/run.ts hostile phys    only the named suites (a PARTIAL run: it says so, and it is not the gate)
//   bun tools/protocol/run.ts --lane core     only one lane (core | main | browser), also PARTIAL
//   bun tools/protocol/run.ts --manifest      print the suite table docs/GATE-MANIFEST.md carries (generated from here)
//   bun tools/protocol/run.ts --check-manifest   exit 1 if the doc's table is not what --manifest prints
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
//   PROTOCOL_WORLDS=<dir>[:<dir>…]         also sweep / oracle a host's own world logs (the repo's fixtures always)
//   CHROME=<chromium binary>                the browser lane's Chromium (else playwright's, else /usr/bin/{google-chrome,chromium})
//   PYTHON=<python3>                        the conformance suite's interpreter (else python3 on PATH)
//   PROTOCOL_KEEP=1                         keep the gate's temp dir to read
//   PROTOCOL_TIMEOUT_SCALE=<factor>         multiply every suite's timeout (a very slow host: 2)
//   PROTOCOL_HEADLESS_LOCK=<file> PROTOCOL_PERF_GUARD=<script>   run browser suites under a host's flock + perf guard
import { killSuite, suiteMembers } from "./procgroup.ts";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENGINE, controlNote } from "./common.ts";

type Lane = "core" | "main" | "browser";
const SUITES: [string, string, number][] = [ // name, file, tail lines to show
  ["kernel", "kernel-check.ts", 1],     // reviewer item 5 (10-18): the kernel (envelope, kinds, ops, identity grammar, version, transform, parent) is trial-kernel: a change is red unless the same change carries a translator, a changelog line and old-red/new-green vectors (spec/kernel-pin.json)
  ["gov-reserved", "gov-reserved-check.ts", 1], // reviewer item 8 (10-18): governance is RESERVED; the server refuses to serve a log holding a `sequencer` entry, truthfully
  ["diffcheck", "diffcheck.ts", 1],        // review #260 rereview (10-19) blocker 3: the range is clean under `git diff --check`; two documented exemptions only
  ["procgroup", "procgroup-check.ts", 1],  // review #260 rereview (10-19) blocker 2: the gate finds and kills a suite's processes on Linux, macOS and Windows
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
  ["oracle", "import-v1/snapshot-oracle.ts", 2], // owner 10-15: the translator against the OLD ENGINE — every old world whose snapshot.json is a complete fold of its log, compared with its translation (and the server's lifted load)
  ["inplace", "inplace-check.ts", 1],   // R 10-17 13:36: translate <world> in place (the name and links kept, the old log beside it as log.original.jsonl), verified before the swap, everything put back on any failure
  ["oldworlds", "../oldworlds-test.ts", 1], // owner 10-15: an old-format world is found and named at boot (the exact translate command), and a visitor is told in plain words             // the old-world importer (tools/protocol/import-v1/) on every local old world log + her dialect-3 goldens + pins
  ["browser", "browser-check.ts", 1],   // the shared core imported by headless Chromium, byte-for-byte with bun
  ["descriptors", "../descriptor-defaults-test.ts", 1], // C5 (DEBT 10-12 #3a): every record and inspector default is the registry's, through the editor translation
  ["light-readers", "../light-readers-test.ts", 1], // D2 (DEBT-2 #5): a light is found by kindOf and the rig's complight key, its gizmo is no box or material slot
  ["ghost-mesh-size", "../ghost-mesh-size-test.ts", 1], // D1: every shape × scale the build ghost sends passes the door's mesh check (the plane at 1/1.1 did not)
  ["boot-init", "../boot-init-test.ts", 1], // D3: every client init* has a caller (initOccupants had none)
  ["editor-range", "../editor-range-test.ts", 1], // D4a: the editor writes what was typed inside the door's range, and refuses outside it with nothing sent
  ["lookat-forward", "../lookat-forward-check.ts", 1], // D7: the authority and the door give one verdict on every LookAt.forward
  ["role-grammar", "../role-grammar-test.ts", 1], // D7: one role-id grammar (grab, sockbody, rolespanels, commands)
  ["lock-level", "../lock-level-test.ts", 1], // D7: the lock ladders and the role ranks agree (messages.ts had no moderator)
  ["rot", "../rot-test.ts", 1], // shared/rot.js: quaternion orientation, and no host transcendental (R1: lyingFrame had three)
  ["dismount-height", "../dismount-height-test.ts", 1], // review of PR #260 (localbody.js:151): standing up keeps the height I'm let go at (vacated.at, a socket exit, a leave clip's end)
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
  ["ids", "ids-check.ts", 1],
  ["scars", "scars-check.ts", 1],       // R 10-17 02:45 engine-scars + consent gaps: refused acts keep names + code, look's own table, an edit that moves a seat unseats its occupants (sitting is consent), READBACK vs purge, the refusal-code registry, a VERBSPEC row per verb, the spec pins           // R 10-17 ID HARDENING: opaque minting, writers never choose ids ($placeholders), delete clears refs, lint finds dangling ones
  ["r8", "r8-check.ts", 1],             // review round 8 (10-17): a delete never re-sponsors a script; a fork copies no new model-hash; ref clears are the authority's follow-up (no third-party veto); the shape marker is the system's act; enter/leave record no identity
  ["r9", "r9-check.ts", 1],             // review round 9 (10-17): authorship never comes from a follow-up (followUps in the entry); the seat's own motion as it was when you sat; a script seat keeps the escape; two stand-ins; the agent hears unseated; a seat re-anchors the track
  ["r10", "r10-check.ts", 1],            // review round 10 (10-17): a sit is within reach; a follow-up restore keeps its author; two stand-ins of two shapes (rerun-anon); the authority's consequences are follow-ups (resettle is the system's act, a delete's set-down passes no lock); unseated on a socket gone and at its `at`
  ["r11", "r11-check.ts", 1],            // review round 11 (10-17): a friend and a delegate can be removed (unfriend, undelegate; owner only); rename-components in §7 and §4; a seat's stand says detach; a declaration passed on as sent; renames per thing, null a removal; the repo items
  ["names", "names-check.ts", 1],     // R 10-17 14:34–14:41: names carry no body plan and set no kind against another (refusal codes, punt {contact}, trusted-components, consent words + delegates, one people list, the occupy family, stale addresses)
  ["parity", "parity-check.ts", 1],     // research agent/human parity Part B (R 10-17 12:42): one kind of participant — a status is declared at the door, never inferred from the credential or logged; move {client} gone; the spoken trio is anyone's; §6a, §8 by shape
  ["directory", "directory-check.ts", 1],
  ["keyhints", "../keyhints-check.ts", 1], // R 10-04: no hidden keys in edit mode (every modifier tagged and shown)
  ["client", "client-check.ts", 1],     // slice 3b: edit mode in headless Chromium against a scratch server (one browser, guarded)
  ["refusedjoin", "refusedjoin-check.ts", 1], // R 10-16 00:02: a refused join (old-format world, no such world) stays on the splash in the server's words — the early socket's refusal is honoured, no redial, no empty world
  ["server", "server-check.ts", 1],     // the server: real processes, real WebSockets, scratch ports
  ["identity", "identity-check.ts", 1], // who a joiner is: C1-C3, H1, H3-H5 (security review 10-06), one identity per account
  ["fork-reset", "fork-reset-check.ts", 1],
  ["reset-race", "reset-race-check.ts", 1], // review 10-14 C1: a request awaiting warm() across a reset refuses instead of writing the old log's line into the new file // world fork (a new world naming its source) and reset (archived, re-founded by its owners)
  ["txn", "txn-check.ts", 1],           // reviewer items 1–2 (10-18): every request ends committed | rolled-back | ambiguous (persist before publish, publish in a finally, ambiguous never ok); one immutable request capability rechecked at both await→commit seams (liveness, identity, operator, the door, role)
  ["txn-mutants", "txn-check.ts --mutants", 1], // …and each of its rows turns red under the mutation it exists to catch (a scratch copy of the tree per mutant; the control stays green)
  ["blockers-mutants", "blockers-mutants.ts", 1], // review of PR #260 (10-18): the RED side of every blocker's row, run: one mutation of each fix (B1–B10, M1–M9, r14) in a scratch tree turns its named row red; the control stays green. Its output is the PR's red/green table
  ["scripts", "scripts-check.ts", 1],   // research 41: scripts in QuickJS on sponsor rights; use → script; a timer through a real server
  ["grab", "grab-check.ts", 1],         // grabbable (research grab 10-06): the gate, release modes, the hold record, use while held
  ["shove", "shove-check.ts", 1],       // body shove at the authority: punt {contact: true}'s own gate (a body against it, at a walk's speed, away from the body, at rest)
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
  ["access", "access-check.ts", 1],     // who may come in (upstream #258/#259 in our terms): @world.access join/watch, per-caller /worlds and /access, the settle (4010), timed grants (expire-roles), reset keeps the door
  ["batch2", "batch2-check.ts", 1],
  ["describe-particles", "describe-particles-check.ts", 1], // R 10-07: description (the accessibility reading) and particles as effect documents (Godot's CPUParticles3D ported)     // edit mode v1 batch 2: story, text, picture, sound (+ where media may come from), look-at, Credits in History
  ["client-b2", "batch2-probe.ts", 1],  // batch 2 in headless Chromium: a stage per component, and an untrusted link never fetched without the viewer's opt-in
  ["build", "build-check.ts", 1],       // ship-list group B (10-07): building walls at the authority, nested blueprints, the editor's new script
  ["counter", "counter-check.ts", 1],   // PR #208 review's twelve-line list, as a counter button: publish/attach (§4.1), a script on sponsor rights (§8), the algebra (§7a) — C1…C12; blueprint-test.ts (tools/, run-client) is the pure half it leans on
  ["build-client", "build-probe.ts", 1], // …and in a real browser: a building edit and its undo, turn/size before placing, the new-script card (one browser, guarded)
  ["shiplist", "shiplist-check.ts", 1], // ship list group A (audit 10-07): openable, reactions checked at write, motion fields, help text, people's words
  ["shiplist-probe", "shiplist-probe.ts", 1], // …in headless Chromium: E opens a door and it swings; a person's refusal and warning; a moderator's warning in VR
  ["agenttools", "agenttools-check.ts", 1], // the agent's tools on a real server (tools audit 10-07): move walks the authority's body (walls), create {from}, a refused shove is an error, MCP annotations, look points at real tools
  ["presence", "presence-check.ts", 1], // security pass 3 H2: no one shows under another account's name; puppet/bodydrag/typing reach the identity named; a whisper reaches nobody (removed)
  ["modhole", "modhole-check.ts", 1],   // security pass 3: nothing a world sends runs as code in a visitor's browser; EW.mods.put/run need your hand
  ["xss-probe", "xss-probe.ts", 1],     // security pass 3 H1 in headless Chromium: a hostile display name is text everywhere; the page's CSP refuses inline script and lets the client run
  ["pretrans", "pretrans-check.ts", 1], // review 10-07 "protocol shape": the edges the Commons translation makes permanent (names, defaults, ids, refs, governance, models, privacy)
  ["soundclock", "soundclock-check.ts", 1], // a sound's shared playhead is on the server's clock (serverNow), never Date.now
  ["eidomodel", "eidomodel-check.ts", 1], // review 10-07 H3: a translated world's models are eido:sha256 addresses; the index, /eido/, /library/eido/, the client's mapping
  ["party-probe", "party-probe.ts", 1], // the editor's party blockers (review 10-07 B1–B5, S1/S4/S5/S7, lock levels, moderation commands) with real mouse and keys
  ["colour-picker", "../colour-picker-bench.ts", 1], // the Inspector's colour field is a picker of solid cells a headset quad can click (R 10-12), in headless Chromium (one browser, guarded)
  ["alias", "../../mcpl/alias-test.ts", 1], // old tool names AND their old argument shapes run the new tool (10-15)
  // socketteer's pathfinding stack (#235/#236/#239/#241, merged into the protocol 10-15): its own suites, as it ships them
  ["agent-mesh-collision", "../agent-mesh-collision-test.ts", 1], // #235: an agent's body collides with placed models (the support barrier, the 3-at-once governor)
  ["navgrid", "../navgrid-test.ts", 1],  // #236: move routes through placed models (round furniture, through doors, up stairs; y picks the floor)
  ["navgrid-edge", "../navgrid-edge-test.ts", 1],
  ["places", "../places-test.ts", 1],    // #239: named places (move {to: "thing/place"}, which room you're in, name_place), look's places in sight, "?"
  ["places-scale", "../places-scale-test.ts", 1], // #239: a scaled thing's places scale; the walking body's tolerances don't
  ["shape-attach", "../shape-attach-test.ts", 1], // shape audit 10-16 wave 2: socket/station, one action namespace, one home, grabbable registered, reactions frozen, look-at radians, places closed, spawn, lock, reserved names
  ["shape-physics", "../shape-physics-test.ts", 1], // shape audit 10-16 wave 2: transform pinned (glTF rule), parent −order, pivot {pos}, motion trims + repair, physics kind/reserved/kinematic, physics-engine, collider mesh, physics-joint + joint, structure, surface, stage
  ["shape-repair", "../shape-repair-test.ts", 1], // review r7 (10-16): the load's repair once per world (a marker in the log), per thing, a node's name as data (motion:<slot> {node}); no empty stations by default
  ["buildcheck", "../buildcheck-test.ts", 1], // #241: the build check against the walking body's rules
  ["buildcheck-queue", "../buildcheck-queue-test.ts", 1], // #241: checks are queued, cached, and answer for the bytes hashed
  ["buildcheck-route", "../buildcheck-route-test.ts", 1], // #241: GET /check and measure {check: true} (check_model)
  ["client-tools", "../run-client.ts --import-only", 14], // refactor plan 2 D5: every tools/*-{test,check} loads (a stub missing an export, a moved module); the full run is `bun tools/run-client.ts`
];

// ---- lanes ----
// CORE runs first, in this order, and a failure there stops the gate
const CORE = ["kernel", "gov-reserved", "diffcheck", "procgroup", "nov1", "vocab", "authority", "access", "identity", "scars", "reset-race", "txn", "txn-mutants"];
// every suite that launches a Chromium (directly, through playwright, or through tools/harness.ts scratchBench). The
// gate checks this list against the files themselves (browserMarkers), so a new browser suite can't hide in MAIN.
// refusedjoin (scratchBench) and client-tools (run-client.ts runs every tools/*-test file, browser tests among them, those one
// at a time) once
// sat in the non-browser list: a host without Chromium failed them, and this box ran Chromes it didn't budget for.
const BROWSER = ["browser", "client", "refusedjoin", "client-b2", "build-client", "shiplist-probe", "xss-probe", "party-probe", "colour-picker", "client-tools"];
const laneOf = (name: string): Lane => (CORE.includes(name) ? "core" : BROWSER.includes(name) ? "browser" : "main");
// what a suite needs beyond bun and this checkout (a scratch dir, loopback ports: every suite may use those)
const NEEDS: Record<string, string> = { conformance: "python3 + cryptography" };
for (const n of BROWSER) NEEDS[n] = "Chromium";
// seconds each suite took on the reference host (WSL2, 16 threads, 7 GB; 2026-10-18, one suite at a time, inside this gate's
// hermetic env; the browser lane from the house gate's run the same day). The timeout
// is 5x that, at least 180 s: a slow host gets room, a hung suite is still killed.
const EXPECT: Record<string, number> = {
  "agent-mesh-collision": 92, "kernel": 0.5, "nov1": 0.7, "vocab": 3.5, "nonumber": 1.4, "hostile": 0.3, "attack": 1.5,
  "libfile": 0.1, "gaps": 5.6, "phys": 3.9, "physlive": 1.2, "phystick": 5.7, "sclock": 2.8, "physseeds": 2.1,
  "eidosim": 12, "eidosim-live": 1.5, "mover": 4.5, "colliders": 0.2, "lying-support": 16, "replay": 0.4,
  "conformance": 2.9, "sweep": 0.3, "oracle": 0.4, "inplace": 15, "oldworlds": 1.2, "browser": 1.5, "descriptors": 0.1,
  "light-readers": 0.4, "ghost-mesh-size": 0.5, "boot-init": 0.5, "editor-range": 0.3, "lookat-forward": 0.5,
  "role-grammar": 0.3, "lock-level": 0.1, "rot": 0.1, "dismount-height": 0.2, "build-gate": 0.3,
  "capsule-recovery": 10, "debug-tabs": 0.3, "governor-xr": 0.2, "unknown-comp": 1.1, "reach-order": 1.5,
  "editcommit": 0.8, "hierarchy-commit": 0.6, "verbclasses": 0.0, "authority-layers": 0.0, "authority": 9.0,
  "ids": 1.4, "scars": 1.0, "r8": 0.9, "r9": 1.5, "r10": 1.7, "r11": 0.6, "names": 2.1, "parity": 5.4,
  "directory": 13, "keyhints": 0.0, "client": 60, "refusedjoin": 126, "server": 40, "identity": 42,
  "fork-reset": 6.0, "reset-race": 0.4, "txn": 0.8, "txn-mutants": 11, "blockers-mutants": 420, "scripts": 48, "grab": 3.8, "shove": 2.0, "shove-walker": 0.1,
  "agentshove": 165, "hands": 1.2, "reset": 1.7, "settle": 5.4, "disabled": 1.2, "histdiff": 0.3, "reachgate": 22,
  "consent": 0.0, "history-rows": 0.6, "scale": 125, "roles": 3.1, "access": 8.3, "batch2": 1.9,
  "describe-particles": 1.1, "client-b2": 19, "build": 1.5, "counter": 2.2, "build-client": 8.1, "shiplist": 1.7,
  "shiplist-probe": 197, "agenttools": 20, "presence": 10, "modhole": 0.1, "xss-probe": 15, "pretrans": 2.8,
  "soundclock": 0.2, "eidomodel": 0.7, "party-probe": 486, "colour-picker": 8.1, "alias": 0.4, "navgrid": 64,
  "navgrid-edge": 0.6, "places": 130, "places-scale": 6.3, "shape-attach": 0.7, "shape-physics": 0.7,
  "shape-repair": 0.4, "buildcheck": 18, "buildcheck-queue": 7.4, "buildcheck-route": 22, "client-tools": 202
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
const BROWSER_MARK = /\bscratchBench\s*\(|\bbrowserBench\s*\(|chromium\.launch|from ["']playwright["']|import\(["']playwright["']\)|puppeteer|--remote-debugging-port|gate: launches a browser/;
function localImports(f: string, seen = new Set<string>()): Set<string> {
  if (seen.has(f) || !fs.existsSync(f)) return seen; seen.add(f);
  for (const m of fs.readFileSync(f, "utf8").matchAll(/(?:from|import\(|import)\s*["'`]([^"'`]+)["'`]/g)) {
    if (!m[1].startsWith(".")) continue; let p = path.resolve(path.dirname(f), m[1]);
    if (!fs.existsSync(p)) for (const e of [".ts", ".js", ".mjs"]) if (fs.existsSync(p + e)) { p += e; break; }
    if (fs.existsSync(p) && fs.statSync(p).isFile() && /\/tools\//.test(p) && !p.endsWith("/tools/harness.ts")) localImports(p, seen);
  }
  return seen;
}

type Result = { name: string; lane: Lane; status: "pass" | "fail" | "skip"; why?: string; ms: number; rowSkips: string[]; optional: string[]; leftovers: number };

function suitePath(file: string) { return path.resolve(ENGINE, "tools/protocol", file.split(" ")[0]); }

function manifest() {
  const rows = ["| # | suite | lane | file | needs | expected | timeout |", "|---|---|---|---|---|---|---|"];
  const ordered = [...CORE.map((n) => SUITES.find((s) => s[0] === n)!), ...SUITES.filter(([n]) => laneOf(n) === "main"), ...SUITES.filter(([n]) => laneOf(n) === "browser")];
  ordered.forEach(([name, file], i) => rows.push(`| ${i + 1} | ${name} | ${laneOf(name)} | \`${path.relative(ENGINE, suitePath(file))}${file.includes(" ") ? " " + file.split(" ").slice(1).join(" ") : ""}\` | ${NEEDS[name] ?? "bun"} | ${EXPECT[name] !== undefined ? `${EXPECT[name]} s` : "?"} | ${baseTimeout(name)} s |`));
  const sum = (l: Lane) => SUITES.filter(([n]) => laneOf(n) === l).reduce((a, [n]) => a + (EXPECT[n] ?? 0), 0);
  rows.push("", `Lanes: core ${CORE.length} suites (~${Math.round(sum("core"))} s), main ${SUITES.filter(([n]) => laneOf(n) === "main").length} (~${Math.round(sum("main"))} s), browser ${BROWSER.length} (~${Math.round(sum("browser"))} s); ${SUITES.length} suites in all.`);
  return rows.join("\n");
}
const DOC = ENGINE + "docs/GATE-MANIFEST.md", BEGIN = "<!-- BEGIN GENERATED: bun tools/protocol/run.ts --manifest -->", END = "<!-- END GENERATED -->";
function manifestDrift(): string | null {
  if (!fs.existsSync(DOC)) return `${path.relative(ENGINE, DOC)} is missing`;
  const t = fs.readFileSync(DOC, "utf8"), a = t.indexOf(BEGIN), b = t.indexOf(END);
  if (a < 0 || b < a) return `${path.relative(ENGINE, DOC)} has no generated block (${BEGIN} … ${END})`;
  return t.slice(a + BEGIN.length, b).trim() === manifest().trim() ? null : `${path.relative(ENGINE, DOC)}'s suite table is not what --manifest prints (regenerate it: bun tools/protocol/run.ts --manifest)`;
}

const argv = process.argv.slice(2);
if (argv.includes("--manifest")) { console.log(manifest()); process.exit(0); }
if (argv.includes("--check-manifest")) { const d = manifestDrift(); console.log(d ?? "manifest: docs/GATE-MANIFEST.md matches run.ts"); process.exit(d ? 1 : 0); }
const laneArg = argv.includes("--lane") ? argv[argv.indexOf("--lane") + 1] : null;
const only = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--lane");
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
  if (!fs.existsSync(f)) { problems.push(`${name}: ${path.relative(ENGINE, f)} does not exist`); continue; }
  if (laneOf(name) !== "browser") for (const d of localImports(f)) if (BROWSER_MARK.test(fs.readFileSync(d, "utf8"))) { problems.push(`${name} launches a Chromium (${path.relative(ENGINE, d)}) but is not in the BROWSER lane`); break; }
}
if (!partial) { const d = manifestDrift(); if (d) problems.push(d); }
for (const dir of ["", "client/", "mcpl/"]) if (!fs.existsSync(ENGINE + dir + "node_modules")) problems.push(`${dir || "./"}node_modules is missing: run \`bun install --frozen-lockfile\` in ${dir || "the checkout root"}`);

console.log(`protocol gate @ ${ENGINE}`);
const runtime = (label: string, found: string | null, want: string | undefined, rule: "major" | "min-major", extra = "") => {
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
  const candidates = [process.env.CHROME];
  if (!process.env.CHROME) { try { const { chromium } = await import("playwright"); candidates.push(chromium.executablePath()); } catch {} candidates.push("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"); }
  CHROME = candidates.find((p) => p && fs.existsSync(p)) ?? null;
  const v = CHROME ? spawnSync(CHROME, ["--version"], { encoding: "utf8", timeout: 20000 }).stdout?.trim() ?? "" : "";
  if (process.env.CHROME && !CHROME) problems.push(`CHROME=${process.env.CHROME} does not exist`);
  runtime("chromium", CHROME ? (v.match(/\d+\.\d+\.\d+\.\d+/)?.[0] ?? null) : null, ENGINES.chromium, "min-major",
    CHROME ? CHROME : "the browser lane is REQUIRED: set CHROME=/path/to/chrome (Chromium or Chrome for Testing), or `bunx playwright install chromium`");
  if (CHROME && !v) problems.push(`${CHROME} --version printed nothing: is it a Chromium?`);
}
// The browser pages load the asset library (Skye's toolkit modules, sky, avatars): a separate public repo, pinned here.
// Declared like Chrome: required for the browser lane, never fetched silently, never read from a guessed path.
const LIBRARY_REPO = "https://github.com/SkyeShark/eidoverse-video.git";
const LIBRARY_PIN = "e9f80d02529176a87f292fb0e3aeafad3a9ba09f";
let LIBRARY: string | null = null;
if (SUITES.some(([n]) => selected(n) && laneOf(n) === "browser")) {
  const want = process.env.EIDOVERSE_DIR;
  const fix = `git clone ${LIBRARY_REPO} <dir> && git -C <dir> checkout ${LIBRARY_PIN}, then EIDOVERSE_DIR=<dir>`;
  if (!want) problems.push(`the browser lane needs the asset library: set EIDOVERSE_DIR (${fix})`);
  else if (!fs.existsSync(path.join(want, "eidoverse", "terrain.js"))) problems.push(`EIDOVERSE_DIR=${want} is not an eidoverse-video checkout (no eidoverse/terrain.js): ${fix}`);
  else {
    LIBRARY = path.resolve(want);
    const head = spawnSync("git", ["-C", LIBRARY, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim() ?? "";
    console.log(`  library   ${head ? head.slice(0, 12) : "(not a git checkout)"}  pinned ${LIBRARY_PIN.slice(0, 12)}  ${LIBRARY}${head && head !== LIBRARY_PIN ? "  (note: not the pinned commit)" : ""}`);
  }
}
if (problems.length) {
  console.log(`\nprotocol gate: FAILED before any suite ran:`); for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}

// ---- running a suite: its own process group, timeout, HOME/TMPDIR/scratch; the group killed when it ends ----
const GATE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "eido-gate-"));
let current: { pid: number } | null = null;
// Linux, macOS and Windows alike (tools/protocol/procgroup.ts): a POSIX process group, or the process tree on Windows
const killGroup = (pid: number, sig: NodeJS.Signals) => killSuite(pid, sig);
const groupMembers = (pgid: number) => suiteMembers(pgid).length;
const cleanup = () => { if (current) killGroup(current.pid, "SIGKILL"); if (!process.env.PROTOCOL_KEEP) fs.rmSync(GATE_TMP, { recursive: true, force: true }); };
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => { console.log(`\nprotocol gate: ${sig}: killing the running suite's process group`); cleanup(); process.exit(130); });

const OPT_TRACKED = (spawnSync("git", ["-C", ENGINE, "ls-files", "-z", "assets/opt"], { encoding: "utf8" }).stdout ?? "").split("\0").filter(Boolean).map((f) => f.slice("assets/opt/".length));
const PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? process.env.Path ?? "/usr/bin:/bin"}`;   // a nested `bun` is this bun
async function run(name: string, file: string): Promise<{ code: number | null; signal: string | null; out: string; timedOut: boolean; leftovers: number }> {
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
  if (LIBRARY && laneOf(name) === "browser") env.EIDOVERSE_DIR = LIBRARY;   // read-only use; every other lane keeps its empty library
  const [script, ...args] = file.split(" ");
  let cmd = [process.execPath, path.resolve(ENGINE, "tools/protocol", script), ...args];
  const lock = process.env.PROTOCOL_HEADLESS_LOCK, guard = process.env.PROTOCOL_PERF_GUARD;
  if (laneOf(name) === "browser" && lock && guard) cmd = ["flock", lock, "bash", guard, "-t", String(timeoutOf(name)), "--", ...cmd];
  const child = spawn(cmd[0], cmd.slice(1), { cwd: ENGINE, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  current = { pid: child.pid! };
  let out = "", timedOut = false; const keep = (b: Buffer) => { out += b.toString(); if (out.length > 4e6) out = out.slice(-2e6); };
  child.stdout!.on("data", keep); child.stderr!.on("data", keep);
  const timer = setTimeout(() => { timedOut = true; killGroup(child.pid!, "SIGTERM"); setTimeout(() => killGroup(child.pid!, "SIGKILL"), 5000).unref(); }, timeoutOf(name) * 1000);
  const [code, signal] = await new Promise<[number | null, string | null]>((res) => { child.on("exit", (c, s) => res([c, s])); child.on("error", (e) => { out += `\nspawn failed: ${e.message}`; res([null, null]); }); });
  clearTimeout(timer);
  const leftovers = child.pid ? groupMembers(child.pid) : 0;   // anything the suite started and left running
  if (child.pid) killGroup(child.pid, "SIGKILL");
  await new Promise((r) => { if (child.stdout!.readableEnded) return r(null); child.stdout!.once("end", r); setTimeout(r, 3000); });   // the last output, once the group is gone
  current = null;
  if (!process.env.PROTOCOL_KEEP) fs.rmSync(dir, { recursive: true, force: true });
  return { code, signal, out, timedOut, leftovers };
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
  const r = await run(name, file);
  const lines = r.out.trimEnd().split("\n");
  const fails = lines.filter((l) => /^\s*FAIL\b|✗/.test(l));   // the browser probes mark a failed check with ✗, not FAIL
  const rowSkips = lines.filter((l) => /^\s*SKIP\b/.test(l)).map((l) => l.trim());
  const optional = lines.filter((l) => /^\s*OPTIONAL\b/.test(l)).map((l) => l.trim());
  const ms = performance.now() - t;
  let status: Result["status"] = r.code === 0 ? "pass" : r.code === 77 ? "skip" : "fail";
  let why = r.timedOut ? `timed out after ${timeoutOf(name)} s (process group killed)` : r.code === 77 ? (rowSkips.at(-1) ?? lines.at(-1)) : r.code === 0 ? undefined : `exit ${r.code ?? r.signal}`;
  if (status === "pass" && rowSkips.length) { status = "skip"; why = `${rowSkips.length} check(s) skipped`; }
  if (r.timedOut) status = "fail";
  results.push({ name, lane, status, why, ms, rowSkips, optional, leftovers: r.leftovers });
  console.log(`\n== ${name} [${lane}] (${file}) ${status.toUpperCase()}${why ? ` (${why})` : ""} ${(ms / 1000).toFixed(1)} s${r.leftovers ? ` · killed ${r.leftovers} leftover process(es)` : ""}`);
  for (const l of fails.slice(0, 20)) console.log(l);
  for (const l of rowSkips.slice(0, 20)) console.log(l);
  for (const l of lines.slice(-tail)) if (!fails.includes(l) && !rowSkips.includes(l)) console.log(l);
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
process.exit(bad ? 1 : 0);
