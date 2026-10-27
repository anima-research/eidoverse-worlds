// tools/protocol/suites.ts — which suites the gate runs, in which lane, from which file; and the local files a suite
// pulls in. run.ts runs them; hygiene-check reads the same list, so the two can't disagree about what "the gate" is.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE } from "./common.ts";

export type Lane = "core" | "main" | "browser";
export const SUITES: [string, string, number][] = [ // name, file, tail lines to show
  ["kernel", "kernel-check.ts", 1],
  ["trig", "trig-check.ts", 1],
  ["laws", "laws-check.ts", 1],            // the ground's height and the sky's forecast are data: spec/conformance/laws.json            // the heading law's trig is data: spec/conformance/trig.json, bit for bit
  ["engine", "engine-check.ts", 1],          // what "carries" means: every carried engine version reproduces its conformance digests (house, #260 10-21)
  ["normative", "normative-check.ts", 1], // spec/NORMATIVE.md is the closed set, and its consent/roles tables equal the reference (10-20, nissa-seru)     // reviewer item 5 (10-18): the kernel (envelope, kinds, ops, identity grammar, version, transform, parent) is trial-kernel: a change is red unless the same change carries a translator, a changelog line and old-red/new-green vectors (spec/kernel-pin.json)
  ["gov-reserved", "gov-reserved-check.ts", 1], // reviewer item 8 (10-18): governance is RESERVED; the server refuses to serve a log holding a `sequencer` entry, truthfully
  ["diffcheck", "diffcheck.ts", 1],
  ["hygiene", "hygiene-check.ts", 1],       // patterns that broke the gate site by site (Windows paths, sh -c, symlinks, fixed sleeps), refused as a class; debt only goes down        // review #260 rereview (10-19) blocker 3: the range is clean under `git diff --check`; two documented exemptions only
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
  ["zone-water", "zone-water-check.ts", 1], // zone + water (either side) + water-exclusion: the door, shared/zone.js's bodies (the combine law), the client's rebuild rule
  ["water-vectors", "../water-vectors.ts --check", 1], // shared/conformance/water.json still what shared/water.js computes (waterParams, waveHeight, swimStep)
  ["water-import", "../water/import-golden-check.ts", 1], // upstream #248's manifest through tools/water/import.ts --dry: its zone/water/water-exclusion things, taken by a real authority, and mediumOf = main's mediumAt
  ["colliders", "../collider-test.ts", 1], // the walker's reading of placed geometry, incl. things a tumbling engine laid on their sides (review of b398d7e3 #1)
  ["lying-support", "../lying-support-test.ts", 1], // an agent's support for a thing lying down: its true top, no phantom deck at its origin (review of b398d7e3 #1)
  ["support-swap", "../support-swap-test.ts", 1], // #260 I81: a model changed while its geometry is in flight registers nothing from the old fetch (syncSupport's re-check)
  ["knockdown", "../knockdown-test.ts", 1], // #260 I8/I147/I148: a headless body takes a shove from a body beside it, refuses one under its switch (the relay answers), hangs from a nail
  ["sockets", "../sockets-test.ts", 1],
  ["msgrate", "../msgrate-test.ts", 1], // server/msgrate.ts: the message cap is a token bucket (a server stall is not the client's flood) // #260 I454: sockets as entities (resolveSeat, the seat views); ran only as an import before
  ["shape-render", "../shape-render-test.ts", 1], // #260 I515: the shape audit's render rows and the load's repairs; ran only as an import before
  ["originof", "../originof-test.ts", 1], // #260 I98: the ?orrery= guard (generate.js originOf) takes only an http(s) base, never markup or javascript:
  ["renderer-cred", "../renderer-cred-test.ts", 1], // #260 I143/I144: the renderers' credential (flag + key) watches a members-only world; a stranger's /snap and /heightmap of it are 404
  ["replay", "replay-check.ts", 1],     // L1: the fold alone, self-agreement, the lab's digest
  ["conformance", "compare.ts", 3],     // the JS fold vs the Python reference reader (+ its own tests)
  ["sweep", "sweep.ts", 4],
  ["oracle", "import-v1/snapshot-oracle.ts", 2], // owner 10-15: the translator against the OLD ENGINE — every old world whose snapshot.json is a complete fold of its log, compared with its translation (and the server's lifted load)
  ["inplace", "inplace-check.ts", 1],   // R 10-17 13:36: translate <world> in place (the name and links kept, the old log beside it as log.original.jsonl), verified before the swap, everything put back on any failure
  ["version-route", "../version-route-test.ts", 1],   // its own suite, not client-tools' 15 s import-only run: a kill there left its nonces (#260 review)
  ["migrate-identities", "migrate-identities-check.ts", 1],   // migrate-identities.ts: one id per person everywhere (actors, role keys, say.to, capability, sponsor, the moderator log), a gate that reads the two logs side by side, refused twice
  ["oldworlds", "../oldworlds-test.ts", 1], // owner 10-15: an old-format world is found and named at boot (the exact translate command), and a visitor is told in plain words             // the old-world importer (tools/protocol/import-v1/) on every local old world log + her dialect-3 goldens + pins
  ["browser", "browser-check.ts", 1],   // the shared core imported by headless Chromium, byte-for-byte with bun
  ["descriptors", "../descriptor-defaults-test.ts", 1], // C5 (DEBT 10-12 #3a): every record and inspector default is the registry's, through the editor translation
  ["light-readers", "../light-readers-test.ts", 1], // D2 (DEBT-2 #5): a light is found by kindOf and the rig's complight key, its gizmo is no box or material slot
  ["ghost-mesh-size", "../ghost-mesh-size-test.ts", 1], // D1: every shape × scale the build ghost sends passes the door's mesh check (the plane at 1/1.1 did not)
  ["boot-init", "../boot-init-test.ts", 1], // D3: every client init* has a caller (initOccupants had none)
  ["editor-range", "../editor-range-test.ts", 1], // D4a: the editor writes what was typed inside the door's range, and refuses outside it with nothing sent
  ["editschema", "../editschema-test.ts", 1], // the Inspector's schema: rows, edit ops, locks; it sat outside the gate and a stale lock expectation hid there since recut B2 (found 10-21)
  ["lookat-forward", "../lookat-forward-check.ts", 1], // D7: the authority and the door give one verdict on every LookAt.forward
  ["scriptnew-expect", "../scriptnew-expect-test.ts", 1], // house 6340433633: the editor's new-script card sends expect from the thing as planned, not as it stands after the upload
  ["role-grammar", "../role-grammar-test.ts", 1], // D7: one role-id grammar (grab, sockbody, rolespanels, commands)
  ["rot", "../rot-test.ts", 1], // shared/rot.js: quaternion orientation, and no host transcendental (R1: lyingFrame had three)
  ["onepose", "onepose-check.ts", 1], // audit 10-22 #7: one worldPose (simlayer's and hierarchy's agree bit for bit) and one set of quaternion functions (shared/rot.js)
  ["dismount-height", "../dismount-height-test.ts", 1], // review of PR #260 (localbody.js:151): standing up keeps the height I'm let go at (vacated.at, a socket exit, a leave clip's end)
  ["latestread", "../latestread-test.ts", 1], // the panels' paced re-read and the History retry's back-off (latestread.js, backoff.js); it existed, but no lane ran it
  ["csp", "../csp-test.ts", 0.5],          // the page's script-src hashes are the browser's: a CRLF copy of index.html still boots (CI windows 10-23)
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
  ["storey-walk", "../../mcpl/storey-walk-test.ts", 1], // #140/#200 (merged 10-19): the storey a body stands on is the one its walk, its feet, its flights and look reason about; a walk from a floor stays on it
  ["door-unit", "../../mcpl/door-unit-test.ts", 0.5],   // the agent door's units (house 6340433633 fixes live here: loops, stops, part refusals, speech tags)
  ["effective-mcpl", "../../mcpl/effective-test.ts", 0.3],   // the agent's composed transforms (mounts, stretch, shear, stored rotation)
  ["effective", "../effective-test.ts", 0.5],   // the same seen from a seated body (occupant size, seat correction)
  ["stretched-support", "../../mcpl/stretched-support-test.ts", 1], // a stretched thing's support (box, heightfield, triangles, lying down) holds a body where it's drawn
  ["stretched-places", "../../mcpl/stretched-places-test.ts", 1], // a named place on a stretched thing is stretched with it; a region's floor slack stays 0.1 m
  ["door-body", "../../mcpl/door-body-test.ts", 1], // the door's own body state on a bare agent: a tracks loop, a reach held to several bodies, a walk across a rejoin
  ["shape-attach", "../shape-attach-test.ts", 1], // shape audit 10-16 wave 2: socket/station, one action namespace, one home, grabbable registered, reactions frozen, look-at radians, places closed, spawn, lock, reserved names
  ["shape-physics", "../shape-physics-test.ts", 1], // shape audit 10-16 wave 2: transform pinned (glTF rule), parent −order, pivot {pos}, motion trims + repair, physics kind/reserved/kinematic, physics-engine, collider mesh, physics-joint + joint, structure, surface, stage
  ["shape-repair", "../shape-repair-test.ts", 1], // review r7 (10-16): the load's repair once per world (a marker in the log), per thing, a node's name as data (motion:<slot> {node}); no empty stations by default
  ["buildcheck", "../buildcheck-test.ts", 1], // #241: the build check against the walking body's rules
  ["buildcheck-queue", "../buildcheck-queue-test.ts", 1], // #241: checks are queued, cached, and answer for the bytes hashed
  ["buildcheck-route", "../buildcheck-route-test.ts", 1], // #241: GET /check and measure {check: true} (check_model)
  ["door-is-error", "../door-is-error-test.ts", 1], // #269 (main, merged into #260 10-20): a door call that didn't do what it asked answers isError; flight acts answer {ok, text}
  ["door-wording", "../door-wording-test.ts", 1],   // #270 (main, merged into #260 10-21): the door's refusals say what wasn't done and why; deleted here once by mistake (3440e655), restored
  ["consent-replay", "../consent-replay-test.ts", 0.1],   // an agent's switch replay on arrival sends the switch it holds when the read returns (house 6340433633)
  ["history-request", "../history-request-test.ts", 1], // #267 (main): a history request with no answer rejects, so scrolling up can reach what a long disconnect missed
  ["wing-fold-presence", "../wing-fold-presence-test.ts", 1], // #159: a held posture rides the presence wire (absence is not release; survives late join, reconnect, swap)
  ["skystamp", "../skystamp-test.ts", 1], // #260 r3 I286: the sky's seq/by come from the log entry that wrote it (the stored value has none)
  ["grant-command", "../grant-command-test.ts", 1], // #260 house client I6/I42: /grant keeps exceptions and the end date unless it changes them
  ["environment-realizer", "../environment-realizer-test.ts", 1], // #260 house client I8/I55: water on the flat floor; a rejoin clears gone terrain and grass
  ["grant-until", "../grant-until-test.ts", 1], // house client I124: a timed grant's end is a whole millisecond (the authority refused every fractional one)
  ["lite-graph", "../lite-graph-test.ts", 1], // house client I10 / config I1: the lite client never imports the WebGPU renderer
  ["say-live", "../say-live-test.ts", 1], // house client I135/I217: a transcript is dropped offline, and its say carries spoken/utt/t0
  ["presence-actor", "../presence-actor-test.ts", 1], // house client I197: puppet, bodydrag and typing go only with the target's identity
  ["first-name-account", "../first-name-account-test.ts", 1], // house client I192: the first-run door's name becomes the account
  ["retired-commands", "../retired-commands-test.ts", 1], // house config I19: a retired command says why it is gone
  ["animnames-retry", "../animnames-retry-test.ts", 1], // house config I18: a failed defs fetch is retried with back-off
  ["panels", "../panels-test.ts", 1], // house client I203/I198/I213: steppers per thing, focus keeps the panel, Tab adds to the hidden set
  ["surface-hold", "../surface-hold-test.ts", 1], // house client I240: a voice-relay leg holds an actor's lines (repaired: it drove the wrong bus)
  ["particles", "../particles-test.ts", 1], // house client I159: a play/stop change updates the registry key, no rebuild
  ["shadow-fade", "../shadow-fade-test.mjs", 1], // house client I172: registered shadow casters start not casting
  ["frames-layout", "../frames-layout-test.ts", 1], // the frames and panels layout
  ["models-field", "../models-field-test.ts", 1], // house client I173: an override's clone is wrapped once
  ["importer", "importer-check.ts", 1], // the house's review of #260 (6291883302), the v1 importer: causes, the approval's hash, one identity per person, nothing left half-written, values read as v1 read them
  ["eidosim-v1", "import-v1/eidosim-v1-test.ts", 1], // the first eidosim's covenant tests, on the copy the importer keeps (house #260, importer I8)
  ["render-scene-import", "../render-scene-import-test.ts", 1], // #260 I464: server/render-scene.ts links (nothing serves it), and particles project through resolveParticles
  ["channelbox", "../channelbox-test.ts", 1], // #260 I242: the channel box through the real door; the rotate order is the viewer's (PROTOCOL §9.1), never sent
  ["last-world", "../last-world-test.ts", 1], // #281 (main, merged 10-27): a bare link goes back to the last world you were in; the real net.js writes it at the door's yes and forgets a refused or empty world
  ["event-wire", "../event-wire-test.ts", 1], // MCPL RFC-001 rev 3 (main, merged 10-27): a world event's tags follow its kind facet; a notice is chat:system, speech never
  ["client-tools", "../run-client.ts --import-only --skip-suites", 14], // refactor plan 2 D5: every tools/*-{test,check} loads (a stub missing an export, a moved module); the full run is `bun tools/run-client.ts`
];

// ---- lanes ----
// CORE runs first, in this order, and a failure there stops the gate
export const CORE = ["kernel", "trig", "laws", "engine", "normative", "gov-reserved", "diffcheck", "hygiene", "procgroup", "nov1", "vocab", "authority", "access", "identity", "scars", "reset-race", "txn", "txn-mutants"];
// every suite that launches a Chromium (directly, through playwright, or through tools/harness.ts scratchBench). The
// gate checks this list against the files themselves (browserMarkers), so a new browser suite can't hide in MAIN.
// refusedjoin (scratchBench) and client-tools (run-client.ts runs every tools/*-test file, browser tests among them, those one
// at a time) once
// sat in the non-browser list: a host without Chromium failed them, and this box ran Chromes it didn't budget for.
export const BROWSER = ["browser", "client", "refusedjoin", "client-b2", "build-client", "shiplist-probe", "xss-probe", "party-probe", "colour-picker", "client-tools"];
export const laneOf = (name: string): Lane => (CORE.includes(name) ? "core" : BROWSER.includes(name) ? "browser" : "main");

/** The local files `f` imports, transitively, itself included (tools/ only; harness.ts is a door, not the suite's code).
 *  Separators are matched either way: on Windows a resolved path uses `\\`, and a `/`-only test stopped the walk there. */
export function localImports(f: string, seen = new Set<string>()): Set<string> {
  if (seen.has(f) || !fs.existsSync(f)) return seen; seen.add(f);
  for (const m of fs.readFileSync(f, "utf8").matchAll(/(?:from|import\(|import)\s*["'`]([^"'`]+)["'`]/g)) {
    if (!m[1].startsWith(".")) continue; let p = path.resolve(path.dirname(f), m[1]);
    if (!fs.existsSync(p)) for (const e of [".ts", ".js", ".mjs"]) if (fs.existsSync(p + e)) { p += e; break; }
    if (fs.existsSync(p) && fs.statSync(p).isFile() && /[\\/]tools[\\/]/.test(p) && path.basename(p) !== "harness.ts") localImports(p, seen);
  }
  return seen;
}

export function suitePath(file: string) { return path.resolve(ENGINE, "tools/protocol", file.split(" ")[0]); }

/** A file that launches a Chromium, directly or through the bench helpers; run.ts keeps every such suite in the browser
 *  lane, run-client.ts runs such files one at a time. */
const BROWSER_MARK = /\bscratchBench\s*\(|\bbrowserBench\s*\(|chromium\.launch|from ["']playwright["']|import\(["']playwright["']\)|puppeteer|--remote-debugging-port|gate: launches a browser/;

/** The first file `f` pulls in (itself included) that launches a Chromium, or null. This file is skipped: it holds the
 *  pattern's own text, so every suite importing it would read as a browser suite. */
export function browserLauncher(f: string): string | null {
  for (const d of localImports(f)) if (path.resolve(d) !== SELF && BROWSER_MARK.test(fs.readFileSync(d, "utf8"))) return d;
  return null;
}
const SELF = path.resolve(fileURLToPath(import.meta.url));

/** The lines the gate keeps from a failed suite's output: every FAIL / ✗ line, plus the indented lines right under it
 *  (where checks print what they saw), at most `per` each. The evidence used to be dropped: a FAIL said WHICH row failed
 *  and never WHAT it saw (scripts I2, 10-22: two gate failures, no values to compare with a passing run). */
export function failLines(lines: string[], per = 3): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*FAIL\b|✗/.test(lines[i])) continue;
    out.push(lines[i]);
    for (let k = 1; k <= per && i + k < lines.length && /^\s{2,}\S/.test(lines[i + k]) && !/^\s*(FAIL\b|ok\b)|✗|✓/.test(lines[i + k]); k++) out.push(lines[i + k].slice(0, 1200));
  }
  return out;
}
