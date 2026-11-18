// test/gate/suites.ts — which suites the gate runs, in which lane, from which file; and the local files a suite
// pulls in. run.ts runs them; hygiene-check reads the same list, so the two can't disagree about what "the gate" is.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE } from "./common.ts";

export type Lane = "core" | "main" | "browser";
export const SUITES: [string, string, number][] = [ // name, file, tail lines to show
  ["kernel", "protocol/kernel-check.ts", 1], // the kernel (envelope, kinds, ops, identity grammar, version, roles, access) is trial-kernel: a change is red unless the same change carries a translator, a changelog line and old-red/new-green vectors (spec/kernel-pin.json)
  ["trig", "protocol/trig-check.ts", 1], // the heading law's trig is data: spec/conformance/trig.json, bit for bit
  ["simmath", "shared/simmath-test.ts", 1], // Covenant I: the numerics kernel's accuracy, its digest under a second engine (node or deno), and the committed golden
  ["laws", "protocol/laws-check.ts", 1],            // the ground's height and the sky's forecast are data: spec/conformance/laws.json
  ["engine", "protocol/engine-check.ts", 1],          // what "carries" means: every carried engine version reproduces its conformance digests
  ["normative", "protocol/normative-check.ts", 1], // spec/NORMATIVE.md is the closed set, and its consent/roles tables equal the reference (10-20, nissa-seru)
  ["gov-reserved", "protocol/gov-reserved-check.ts", 1], // governance is RESERVED; the server refuses to serve a log holding a `sequencer` entry, truthfully
  ["freeze", "protocol/freeze-check.ts", 1],       // docs/decisions/LOG-VOCABULARY.md §F: feature declarations, provenance, the hello order, a key is not admission, custody read-only (F22–F31, P3)
  ["diffcheck", "gate/diffcheck.ts", 1], // the range is clean under `git diff --check`; two documented exemptions only
  ["stub-guard", "harness/stub-test.ts", 1], // a test stub that never applied, or applied to an import naming no file (a stale path after a move), fails its run
  ["mv-module", "gate/mv-module-test.ts", 1], // tools/mv-module.ts: --check green on its own tree, page/root-relative specifiers kept, READ rows, a failed git fatal
  ["hygiene", "gate/hygiene-check.ts", 1],       // patterns that broke the gate site by site (Windows paths, sh -c, symlinks, fixed sleeps), refused as a class; debt only goes down
  ["paths", "gate/paths-check.ts", 1],          // every repo path a tracked doc, script or comment cites resolves (CONTRIBUTING "Style"; history and docs/design/ proposals excepted: paths-check ALLOW)
  ["body-state-bundle", "mcpl/body-state-bundle-test.ts", 1], // the built MCP entry points carry body_state and none of the test rig, corpus scanner or fixture paths
  ["run-client-settle", "protocol/run-client-settle-check.ts", 1],   // run-client settles a file on its exit, never on its pipes: a grandchild holding them can't wedge client-tools
  ["procgroup", "protocol/procgroup-check.ts", 1],  // the gate finds and kills a suite's processes on Linux, macOS and Windows
  ["shard", "protocol/shard-check.ts", 1],        // CI's sharded gate: shards cover SUITES once whatever the timings; a merge passes only every shard, every suite, one head
  ["nov1", "protocol/nov1-check.ts", 1],         // no runtime file loads the old-world importer or speaks v1
  ["vocab", "protocol/vocab-check.ts", 1],       // one vocabulary: a record is read in the protocol's names (model, flat components), never lib / comp
  ["vocab-fixtures", "protocol/vocab-fixtures-check.ts", 1], // docs/decisions/LOG-VOCABULARY.md §5: F4, F5, F7, F10, F12, F20 (a reader given the next v: unknown-version, nothing folded; no minor)
  ["nonumber", "protocol/nonumber-check.ts", 1], // the protocol's number lives only in genesis {dialect, v}
  ["determinism", "protocol/determinism-check.ts", 1], // Covenant I: no host sin/cos/atan2/exp/log/pow/random, Date.now or performance.now in fold.js, eidosim or the sim modules they reach
  ["hostile", "protocol/hostile-check.ts", 2],   // PROTOCOL §6 proof 1: hostile logs against the strict fold
  ["attack", "protocol/attack-check.ts", 2],     // §6 proofs 2–3: 25d H1/H2/H4 attacks through the authority (admit, L7)
  ["libfile", "protocol/libfile-check.ts", 2],  // #213 port: the resolver walks /library's own ladder and answers what the route serves
  ["library-decode", "server/library-decode-test.ts", 1], // /library/ percent-decoding: spaces resolve, a literal %xx file is found
  ["idle-stall", "server/idle-stall-test.ts", 1], // a download whose reader stalls past Bun's idle timeout still arrives whole
  ["fetchbytes", "client/fetchbytes-test.mjs", 1], // fetchBytes retries 5xx and network failures, never a 4xx, and evicts a failure
  ["variant-status", "server/variant-status-test.ts", 1], // store-variants variantStatus/classifyVariant: every optimization's state for a model
  ["optimize-pump", "server/optimize-pump-test.ts", 1], // the optimizer pump with a fake child: estimate, defer, queue
  ["rebuild", "server/rebuild-test.ts", 1], // a Build card's rebuild: rebuildAsset reruns one object's KTX2 + LOD passes; POST /rebuild takes a sign-in, refuses a key in the URL, 4 per address per minute
  ["ktx2-tf-purge", "server/ktx2-tf-purge-test.ts", 1], // the KTX2 purge tool's two detectors on synthetic headers
  ["image-lie", "server/image-lie-test.ts", 1], // the optimizer's output check (findImageLies) catches an image that is not what its mimeType says
  ["glbperf-file", "server/glbperf-file-test.ts", 1], // glbPerfOfFile ranks a GLB on disk from its header, JSON chunk and image heads
  ["gaps", "protocol/gaps-check.ts", 2],         // research 34: creator rights, presence track, rate, two hands
  ["phys", "protocol/phys-check.ts", 1],         // design 20: launches, rests by cause, carriers; as the running server holds it (shapes, punt, release pose, one clock) and as a client folds it
  ["physlive", "protocol/physlive-check.ts", 1],
  ["siminputs", "protocol/siminputs-check.ts", 1], // #144: the sim reads outside the log only through SIM_INPUTS; a client that lacks one refolds once it lands
  ["phystick", "protocol/phystick-check.ts", 1], // the engine's heartbeat: rests log on the server beat, requests stay cheap, passes are bounded
  ["sclock", "protocol/sclock-check.ts", 1],     // the client's server clock slews toward a new estimate instead of stepping
  ["server-clock", "client/server-clock-test.ts", 1], // the server sends its time and the client's clock follows it through the real net.js and remotes.js
  ["tick", "server/tick-test.ts", 1], // the server heartbeat (tick.ts): systems run on their period, one that throws never stops the others
  ["agent-tokens-reload", "server/agent-tokens-reload-test.ts", 1], // a tokens.json gone malformed authorizes nobody; reserved names stay reserved
  ["server-clock-readers", "client/server-clock-readers-test.ts", 1], // a server stamp (a sky's ts, a role's until) is read on the authority's clock
  ["physseeds", "protocol/physseeds-check.ts", 1], // shape grammar, physical properties, spin on release, the state sample, one clock (a real server whose log is ahead of wall time)
  ["eidosim", "protocol/eidosim-check.ts", 1], // eidosim's adapter: any schedule reaching tick T gives the same bits; spin capped like v; a mirror is the same box
  ["eidosim-live", "protocol/eidosim-live-check.ts", 1], // eidosim at the authority: locks (own, ancestor, descendant) hold against knocks; knocked children rest on the record; spheres on the live host
  ["mover", "protocol/mover-check.ts", 1],       // ONE walker (shared/mover.js) for the agent, the client and the authority: no caller's own numbers; floor rule, walls, arrival; agreement with the real authority
  ["zone-water", "protocol/zone-water-check.ts", 1], // zone + water (either side) + water-exclusion: the door, shared/zone.js's bodies (the combine law), the client's rebuild rule
  ["water-lifecycle", "mcpl/water-lifecycle-test.ts", 1], // an agent's stature and float follow the current body and water; a late answer for an old body is dropped
  ["waterkind", "shared/waterkind-test.ts", 1], // still water, rivers and the sea, read from the shape a water level fills
  ["underwater-presence", "server/underwater-presence-test.ts", 1], // underwater presence validation (3D orientation, bad q dropped)
  ["buoyancy", "shared/buoyancy-test.ts", 1], // a floating column on the water surface, and the clock the surface runs on
  ["climb-env", "protocol/climb-env-check.ts", 1], // collider.enabled (collision off), climb routes (shared/climb.js), arrivals and KillZ (shared/spawn.js), the sky gradient and the directional sun
  ["drive", "protocol/drive-check.ts", 1], // a hull driven from its helm: drive + station.input at the door, one driver, plausibility, the hull's own collision, the lease's commits and end (shared/drive.js, authority/drive.js)
  ["physics-volume", "protocol/physics-volume-check.ts", 1], // physics-volume {kind: speed} on a zone: the door, shared/zone.js's reader, the one mover (walk, wade, swim, 3D stroke), the authority's track agreeing with it
  ["motion-vectors", "../tools/vectors/motion.ts --check", 1], // shared/conformance/motion.json still what shared/motioneval.js computes (Unreal copies it)
  ["water-vectors", "../tools/vectors/water.ts --check", 1], // shared/conformance/water.json still what shared/water.js computes (waterParams, waveHeight, swimStep)
  ["water-import", "water/import-golden-check.ts", 1], // upstream #248's manifest through tools/water/import.ts --dry: its zone/water/water-exclusion things, taken by a real authority, and mediumOf = main's mediumAt
  ["water-preview", "water/preview-check.ts", 1], // preview.ts uploads the manifest's effects before its batch, as import.ts --apply does
  ["level-dive", "water/level-dive-check.ts", 1], // a real browser in the lake: C dives, looking down with W dives, surfacing hands back to the float
  ["water-cross", "water/crossing-pipelines-check.ts", 1], // #306: crossing the water level makes no new render pipeline after the first time (band, fog, background), and the sky's fog still reaches above it
  ["toast-group", "protocol/toast-group-check.ts", 1],   // load failures of one kind are one toast counting the things; dismissed, that kind stays quiet
  ["avatar", "client/avatar-test.ts", 1], // the avatar rig: clip timing, seat-blend slot, a lowering clip under a limp body (upstream #282/#283)
  ["locomotion-clip", "client/locomotion-clip-test.mjs", 1], // the controller's clip-selection policy (#196), on the real module
  ["fp-view", "client/fp-view-test.ts", 1], // the first-person eye and exclusion contract (#75)
  ["reachwire", "shared/reachwire-test.ts", 1], // the reach descriptor grammar and its event edges
  ["reach", "shared/reach-test.ts", 1], // two-bone IK geometry: no rig, no renderer, no server
  ["posture-tiles", "client/posture-tiles-test.ts", 1], // the action bar's posture tiles drive controller.js sitHere/standUp/getPosture
  ["poseclip-parity", "mcpl/poseclip-parity-test.ts", 1], // headless pose-clip joints equal the browser mixer's on the committed fixture
  ["pose-handler", "server/pose-handler-test.ts", 1], // the pose fence is the real "pose" handler's: non-finite and oversized poses dropped
  ["plateanchor", "client/plateanchor-test.ts", 1], // where a nameplate hangs (plateanchor.js, as avatar.js calls it)
  ["flight", "client/flight-test.ts", 1], // flight T1–T8's physical portions and the determinism proof
  ["firstperson-plate", "client/firstperson-plate-test.ts", 1], // first person hides your own nameplate
  ["bodyscale", "client/bodyscale-test.ts", 1], // a body's chosen size and nameplate lift: the wire, receipt clamps, the server fence, the avatar's plate
  ["worn-name", "client/worn-name-test.mjs", 1], // an avatar-worn payload names the same body in both its shapes (wornNameOf)
  ["avatar-perf", "server/avatar-perf-test.ts", 1], // the avatar loupe rank's server half: POST /thumb?perf= validates, re-ranks, merges meta.json; the roster withholds a stale version
  ["armsolve", "client/armsolve-test.ts", 1], // the swivel arm solver (xrbody.js solveArm/relaxArm): continuity, torso clearance, twist split, legs
  ["ammodoll", "client/ammodoll-test.ts", 1], // the Bullet ragdoll keeps the Verlet one's lifecycle promises, with its anatomy
  ["bodysim", "client/bodysim-test.ts", 1], // the body-engine selection seam: ammo by default, the verlet floor while it warms, one interface across the seam
  ["remotes-limp-edge", "client/remotes-limp-edge-test.ts", 1], // a remote going limp or getting up is drawn at the edge sample, not lerped through it (upstream #283)
  ["remotes-lifecycle", "client/remotes-lifecycle-test.ts", 1], // #95: a departed participant dies whole; only arrive and the roster build a body, presence never
  ["colliders", "client/collider-test.ts", 1], // the walker's reading of placed geometry, incl. things a tumbling engine laid on their sides
  ["supportclass", "client/supportclass-test.ts", 1], // the one support classifier both runtimes consume (#84)
  ["support", "client/support-test.ts", 1], // a settling body rests on what actually holds it up (#17)
  ["structure-field", "shared/structure-field-test.ts", 1], // shared/structure.js: the griddled-building planner
  ["structure-edit", "shared/structure-edit-test.ts", 1], // shared/structure-edit.js: the structure editor's pure half
  ["structure-collider", "client/structure-collider-test.ts", 1], // declared structure colliders (fitStructureBoxes)
  ["collider-off-bodies", "client/collider-off-bodies-test.ts", 1], // collision off for bodies gives the walker nothing to meet, on a mesh's and a building's every realizing path
  ["support-swap", "mcpl/support-swap-test.ts", 1], // #260 I81: a model changed while its geometry is in flight registers nothing from the old fetch (syncSupport's re-check)
  ["knockdown", "server/knockdown-test.ts", 1], // #260 I8/I147/I148: a headless body takes a shove from a body beside it, refuses one with its move gate off (the relay answers), hangs from a nail
  ["sockets", "shared/sockets-test.ts", 1], // #260 I454: sockets as entities (resolveSeat, the seat views); ran only as an import before
  ["seats-store", "server/seats-store-test.ts", 1], // the rights-bearing seats store (#105 B2/B3)
  ["seatcore", "client/seatcore-test.ts", 1], // the seat-profile contract as hand math (#101 B): schema, contact height, the verdict cache
  ["seatlab-measure", "client/seatlab-measure-test.ts", 1], // tools/seatlab measureSeat reports the seat's pose and anchor from its station
  ["msgrate", "server/msgrate-test.ts", 1], // server/msgrate.ts: the message cap is a token bucket (a server stall is not the client's flood)
  ["upload-cap", "server/upload-cap-test.ts", 1], // /upload's whole-body cap bites at UPLOAD_CAP, with a length or chunked (MUTATION-SAMPLE S2)
  ["clientlog", "server/clientlog-test.ts", 1], // the /clientlog tee's door and budget (server/clientlog.ts: rate, size, scrub, disk; no read path) and the client's side of it
  ["shape-render", "shared/shape-render-test.ts", 1], // #260 I515: the shape audit's render rows and the v1 importer's; ran only as an import before
  ["originof", "client/originof-test.ts", 1], // #260 I98: the ?orrery= guard (generate.js originOf) takes only an http(s) base, never markup or javascript:
  ["renderer-cred", "server/renderer-cred-test.ts", 1], // #260 I143/I144: the renderers' credential (flag + key) watches an invite-only world; a stranger's /snap and /heightmap of it are 404
  ["renderer-join", "client/renderer-join-test.ts", 1], // a page claims to be a renderer only when it can render
  ["render-health", "server/render-health-test.ts", 1], // the watchdog's verdict on a renderer page
  ["replay", "protocol/replay-check.ts", 1],     // L1: the fold alone, self-agreement, the lab's digest
  ["replica-freeze", "shared/replica-freeze-test.ts", 1], // the client's fold is frozen in dev: a reader writing into a record throws, and later entries still apply (C7a)
  ["conformance", "protocol/compare.ts", 3],     // the JS fold vs the Python reference reader (+ its own tests)
  ["sweep", "protocol/sweep.ts", 4], // the old-world importer (tools/import-v1/) on every local old world log + her dialect-3 goldens + pins
  ["oracle", "../tools/import-v1/snapshot-oracle.ts", 2], // owner 10-15: the translator against the OLD ENGINE — every old world whose snapshot.json is a complete fold of its log, compared with its translation (and the server's lifted load)
  ["inplace", "protocol/inplace-check.ts", 1],   // translate <world> in place (the name and links kept, the old log beside it as log.original.jsonl), verified before the swap, everything put back on any failure
  ["oneshot", "protocol/oneshot-check.ts", 1],   // Mica 11-05: a one-shot world.ts child (the server's owner lookup and upgrade) is framed; a post-answer stall is bounded forced cleanup, a handle, a partial frame or a descendant refused
  ["version-route", "client/version-route-test.ts", 1],   // its own suite, not client-tools' 15 s import-only run: a kill there left its nonces (#260 review)
  ["migrate-identities", "protocol/migrate-identities-check.ts", 1],   // migrate-identities.ts: one id per person everywhere (actors, role keys, say.to, capability, sponsor, the moderator log), a gate that reads the two logs side by side, refused twice
  ["oldworlds", "server/oldworlds-test.ts", 1], // owner 10-15: an old-format world is found and named at boot (the exact translate command), and a visitor is told in plain words
  ["browser", "protocol/browser-check.ts", 1],   // the shared core imported by headless Chromium, byte-for-byte with bun
  ["descriptors", "shared/descriptor-defaults-test.ts", 1], // C5 (DEBT 10-12 #3a): every record and inspector default is the registry's, through the editor translation
  ["schema-layers", "shared/schema-layers-test.ts", 1], // one description per component field (componentspec.js): the inspector, the door's refusals and limitsOf all read it
  ["light-readers", "client/light-readers-test.ts", 1], // D2 (DEBT-2 #5): a light is found by its light component and the rig's complight key, its gizmo is no box or material slot
  ["ghost-mesh-size", "shared/ghost-mesh-size-test.ts", 1], // D1: every shape × scale the build ghost sends passes the door's mesh check (the plane at 1/1.1 did not)
  ["boot-init", "server/boot-init-test.ts", 1], // D3: every client init* has a caller (initOccupants had none)
  ["splash-lifecycle", "client/splash-lifecycle-test.mjs", 1], // the splash rays worker: Worker, window listener and canvas end together
  ["bodygate", "client/bodygate-test.mjs", 1], // the body-first gate: armed, held, released once, capped; and at loadGLB's boundary the parse waits in body-first
  ["scheduler", "client/scheduler-test.ts", 1], // the one loader (scheduler.js): lanes, priorities, a slow cosmetic job never blocks the rest
  ["editor-range", "shared/editor-range-test.ts", 1], // D4a: the editor writes what was typed inside the door's range, and refuses outside it with nothing sent
  ["editschema", "shared/editschema-test.ts", 1], // the Inspector's schema: rows, edit ops, locks; it sat outside the gate and a stale lock expectation hid there since recut B2 (found 10-21)
  ["worldentity", "shared/worldentity-test.ts", 1], // the world entity @world (worldentity.js) and the Build tab's memory (edit/tabs.js)
  ["layers", "shared/layers-test.ts", 1], // a thing's selection layer (shared/layers.js), by default and by a builder's word
  ["selection", "client/selection-test.ts", 1], // one selection store (edit/selection.js) and its listener
  ["parts", "client/parts-test.ts", 1], // sub-object motion: motion.js's part tier
  ["motioneval", "client/motioneval-test.ts", 1], // motion.js's evaluator matches its parity fixture (#92 B3)
  ["drag-q", "server/drag-q-test.ts", 1], // the rotate gizmo's live drag carries the full orientation
  ["components-corpus", "shared/components-corpus-test.ts", 1], // the component view is lossless on every committed world
  ["component-needs", "shared/component-needs-test.ts", 1], // Add Component brings its needs; Remove names its dependants
  ["scriptcard-expect", "client/scriptcard-expect-test.ts", 1], // house 6340433633: the editor's new-script card sends expect from the thing as planned, not as it stands after the upload
  ["role-grammar", "shared/role-grammar-test.ts", 1], // D7: one role-id grammar (grab, sockbody, rolespanels, commands)
  ["rot", "shared/rot-test.ts", 1], // shared/rot.js: quaternion orientation, and no host transcendental (R1: lyingFrame had three)
  ["one-binding", "client/one-binding-test.ts", 1], // a shared constant, grammar or table has one binding: importers carry no copy (reaches, rounding, roles, rot numerics, names key)
  ["reexport-binding", "client/reexport-binding-test.mjs", 1], // no client module uses a name it only re-exports (export { X } from … binds nothing locally)
  ["wiring", "client/wiring-check.ts", 1], // "this product file still says X / no longer says Y" as one table, every row with its controls
  ["onepose", "protocol/onepose-check.ts", 1], // audit 10-22 #7: one worldPose (simlayer's and hierarchy's agree bit for bit) and one set of quaternion functions (shared/rot.js)
  ["helm-leave", "client/helm-leave-test.ts", 1], // review of PR #260 (vehicles.js:26): getting up from a helm lets its hull go: its relayed moves show, a later seat drives on from where it is
  ["dismount-height", "client/dismount-height-test.ts", 1], // review of PR #260 (localbody.js:151): standing up keeps the height I'm let go at (vacated.at, a socket exit, a leave clip's end)
  ["latestread", "client/latestread-test.ts", 1], // the panels' paced re-read and the History retry's back-off (latestread.js, backoff.js); it existed, but no lane ran it
  ["chat-mention-insert", "client/chat-mention-insert-test.ts", 1], // #313 review: Mention and a name click put a space before `@name ` after a word, through chat.js itself
  ["chat-mention", "client/chat-mention-test.mjs", 1], // #232: a chat name ends where the door's does (`cairn` is not inside `cairn-bridge`)
  ["groundstep", "client/groundstep-test.mjs", 1], // #315: walking downhill keeps the feet on the ground (groundstep.js floor snap), and controller.js calls it
  ["csp", "client/csp-test.ts", 0.5],          // the page's script-src hashes are the browser's: a CRLF copy of index.html still boots (CI windows 10-23)
  ["build-gate", "client/build-gate-test.ts", 1], // build mode is gated at the chokepoint, never trapping a demoted builder (revived D6)
  ["capsule-recovery", "client/capsule-recovery-test.mjs", 1], // a remote's capsule fallback: bounded retries, the identity guard across takeovers (revived D6)
  ["debug-tabs", "client/debug-tabs-test.ts", 1], // the debug window builds only the chosen tab's groups (revived D6)
  ["governor-xr", "client/governor-xr-test.ts", 1], // in a headset the frame governor never moves the pixel ratio (revived D6)
  ["xr-entry-effects", "client/xr-entry-effects-test.mjs", 1], // the XR entry effect owner, executed: entering applies each effect once, exit undoes it (#197 review)
  ["xr-session-lifecycle", "client/xr-session-lifecycle-test.mjs", 1], // the XR session clock's lifecycle, executed (#197 Blocker 2)
  ["xrpanels", "client/xrpanels-test.ts", 1], // the VR seam of the schema factory: panels as headset quads
  ["xrpass", "client/xrpass-test.mjs", 1], // stereo cameras get their own chain map (xrpass.js), once, even when three's rebuild re-enters
  ["xrpixelratio", "client/xrpixelratio-test.mjs", 1], // while presenting, setPixelRatio is deferred and applied at exit (xrpixelratio.js, #32)
  ["xrpointer", "client/xrpointer-test.mjs", 1], // the VR pointer's policy (xrpointer.js): visibility setting, the ray's low-pass, target stickiness
  ["xrshadow", "client/xrshadow-test.mjs", 1], // the shadow pass runs with xr off while presenting and is restored on every exit (xrshadow.js)
  ["framebudget", "shared/framebudget-test.mjs", 1], // framebudget's rules: one budget per frame, first grant carried as debt, a starved lane granted, one GPU unit per frame
  ["gputime", "client/gputime-test.ts", 1], // gputime's shadow A/B gives the shadow maps back however it ends; a new A/B inside a settle survives
  ["draw-batches", "client/draw-batches-test.ts", 1], // scene ownership and batching eligibility: a recursive shadow render never re-collects the hidden scene
  ["gpulost", "client/gpulost-test.mjs", 1], // after a lost GPU the page reloads once, never loops, and drops the XR boot flag (gpulost.js)
  ["render-aside", "client/render-aside-test.mjs", 1], // renderAside: an off-eye render while presenting leaves the XR state as it was
  ["quadcolour", "client/quadcolour-test.mjs", 1], // the VR panel grade (quadgrade.js) as numbers: the JS twin of the shader
  ["headset-seen", "client/headset-seen-test.mjs", 1], // the stored headset bit is history, and says so (#197)
  ["full-detail", "client/full-detail-test.ts", 1], // "keep full detail" (governor.js setFullDetail) pins every placement full
  ["finger-curl", "client/finger-curl-test.mjs", 1], // the analog finger-curl filter (xr-fingercurl.js sampleFingerCurl)
  ["backend-choice", "client/backend-choice-test.mjs", 1], // the renderer choice (backend_choice.js) as a pure matrix; ?xr=0 is not an XR boot
  ["unknown-comp", "client/unknown-comp-test.ts", 1], // an unknown component blocks nothing, from the door to the realizer to the inspector (revived D6)
  ["reach-order", "client/reach-order-test.ts", 1], // reach chains solve in dependency order, cycles refuse and release cleanly (revived D6; needs the avatar corpus at assets/opt/eidoverse)
  ["editcommit", "client/editcommit-test.ts", 1], // inspect.js commitEdit against the real authority: a live call previews, the final one sends ONE request (revived by D2)
  ["hierarchy-commit", "client/hierarchy-commit-test.ts", 1], // a Hierarchy drag is ONE undo step, through commitEdit and the door, and Ctrl+Z takes it back (revived by D2)
  ["hierarchy", "shared/hierarchy-test.ts", 1], // the Hierarchy's tree over 657 door cases: parenting, ordering by name with numbers as numbers, what a drag may do
  ["verbclasses", "protocol/verbclasses-check.ts", 1], // one home for READ_ONLY/GHOST_OK/WIRE_READS/PERSON_ACTS (DEBT 10-12 #10); classes pinned as of 10-12
  ["authority-layers", "protocol/authority-layers-check.ts", 1], // C11 (DEBT 10-12 #4b): the authority split is a DAG — a leaf under shared/protocol/authority/ never imports the gate or a leaf above it
  ["authority", "protocol/authority-check.ts", 1],
  ["ids", "protocol/ids-check.ts", 1], // ID HARDENING: opaque minting, writers never choose ids ($placeholders), delete clears refs, lint finds dangling ones
  ["scars", "protocol/scars-check.ts", 1],       // 02:45 engine-scars + consent gaps: refused acts keep names + code, look's own table, an edit that moves a seat unseats its occupants (sitting is consent), READBACK vs purge, the refusal-code registry, a VERBSPEC row per verb, the spec pins
  ["r8", "protocol/r8-check.ts", 1],             // review round 8 (10-17): a delete never re-sponsors a script; a fork copies no new model-hash; ref clears are the authority's follow-up (no third-party veto); the shape marker is the system's act; enter/leave record no identity
  ["r9", "protocol/r9-check.ts", 1],             // review round 9 (10-17): authorship never comes from a follow-up (cascade in the entry); the seat's own motion as it was when you sat; a script seat keeps the escape; two stand-ins; the agent hears unseated; a seat re-anchors the track
  ["r10", "protocol/r10-check.ts", 1],            // review round 10 (10-17): a sit is within reach; a follow-up restore keeps its author; two stand-ins of two shapes (rerun-anon); the authority's consequences are follow-ups (resettle is the system's act, a delete's set-down passes no lock); unseated on a socket gone and at its `at`
  ["r11", "protocol/r11-check.ts", 1],            // review round 11 (10-17): a friend and a delegate can be removed (unfriend, undelegate; owner only); rename-components in §7 and §4; a seat's stand says detach; a declaration passed on as sent; renames per thing, null a removal; the repo items
  ["names", "protocol/names-check.ts", 1],     // names carry no body plan and set no kind against another (refusal codes, punt {contact}, trusted-components, consent words + delegates, one people list, the occupy family, stale addresses)
  ["parity", "protocol/parity-check.ts", 1],     // one kind of participant — a status is declared at the door, never inferred from the credential or logged; move {client} gone; the spoken trio is anyone's; §6a, §8 by shape
  ["directory", "protocol/directory-check.ts", 1],
  ["keyhints", "client/keyhints-check.ts", 1], // R 10-04: no hidden keys in build mode (every modifier tagged and shown)
  ["client", "protocol/client-check.ts", 1],     // slice 3b: build mode in headless Chromium against a scratch server (one browser, guarded)
  ["upgrade", "protocol/upgrade-check.ts", 1], // an old-format world: the verified backup (CLI and server), the structured join refusal, the operator-only upgrade through the CLI
  ["hello-refused", "protocol/hello-refused-check.ts", 1], // §F F-3: a hello the server refuses (update-required, unsupported-feature) is said in words by every client, never a join timeout
  ["refusedjoin", "protocol/refusedjoin-check.ts", 1], // a refused join (old-format world, no such world) stays on the splash in the server's words — the early socket's refusal is honoured, no redial, no empty world
  ["server", "protocol/server-check.ts", 1],     // the server: real processes, real WebSockets, scratch ports
  ["worlds-route", "server/worlds-route-test.ts", 1], // GET /worlds, fetched: one people list with declared words, spectators absent, a join never founds
  ["served-routes", "server/served-routes-test.ts", 1], // a route per family the client needs (a sample), really served, every response isolated (COOP/COEP)
  ["native-login", "server/native-login-test.ts", 1], // the native login HTTP handler, isolated
  ["mkconfig", "server/mkconfig-test.ts", 1], // deploy/projector/mkconfig.sh renders mediamtx.template.yml
  ["heightmap-route", "server/heightmap-route-test.ts", 1], // GET /heightmap: the export door's budget gates before the work
  ["harness", "client/harness-test.ts", 1], // the bench harness itself: failures keep their evidence, a foreign nonce is refused, a port squatter moves us to a fresh port
  ["config-env", "server/config-env-test.ts", 1], // env numbers are validated (limits.ts envNumber): unset, junk and out-of-range fall back
  ["identity", "protocol/identity-check.ts", 1], // who a joiner is: C1-C3, H1, H3-H5 (security review 10-06), one identity per account
  ["fork-reset", "protocol/fork-reset-check.ts", 1],
  ["simckpt", "protocol/simckpt-check.ts", 1],   // periodic sim checkpoints (SIM_CHECKPOINT_EVERY): a physics world without launches still bounds its boot's engine replay; purges and audits as before
  ["statecache", "protocol/statecache-check.ts", 1], // the derived fold cache (server/statecache.ts): a boot folds only the tail, any doubt at boot folds from genesis, a background re-derive checks it (one that can't run keeps the cache and says so)
  ["foldparity", "protocol/foldparity-check.ts", 1], // the fold cache's views (server/foldviews.ts): a boot reads only genesis and the tail, and every reader answers as a whole-log boot
  ["reset-race", "protocol/reset-race-check.ts", 1], // review 10-14 C1: a request awaiting warm() across a reset refuses instead of writing the old log's line into the new file // world fork (a new world naming its source) and reset (archived, re-founded by its owners)
  ["txn", "protocol/txn-check.ts", 1],           // reviewer items 1–2 (10-18): every request ends committed | rolled-back | ambiguous (persist before publish, publish in a finally, ambiguous never ok); one immutable request capability rechecked at both await→commit seams (liveness, identity, operator, the door, role)
  ["txn-mutants", "protocol/txn-check.ts --mutants", 1], // …and each of its rows turns red under the mutation it exists to catch (a scratch copy of the tree per mutant; the control stays green)
  ["blockers-mutants-a", "protocol/blockers-mutants.ts --group a", 1], // the RED side of every blocker's row: one mutation of each fix (B1–B10, M1–M9, r14) in a scratch tree turns its named row red; the control stays green; one of four pieces (GROUPS there)
  ["blockers-mutants-b", "protocol/blockers-mutants.ts --group b", 1], // blockers-mutants' piece b
  ["blockers-mutants-c", "protocol/blockers-mutants.ts --group c", 1], // blockers-mutants' piece c
  ["blockers-mutants-d", "protocol/blockers-mutants.ts --group d", 1], // blockers-mutants' piece d
  ["scripts", "protocol/scripts-check.ts", 1],   // research 41: scripts in QuickJS on sponsor rights; use → script; a timer through a real server
  ["scripting", "protocol/scripting-check.ts", 1], // the script kit (scripting/): world.d.ts = the sandbox's API; each example through the local runner
  ["grab", "protocol/grab-check.ts", 1],         // grabbable (research grab 10-06): the gate, release modes, the hold record, use while held
  ["shove", "protocol/shove-check.ts", 1],       // body shove at the authority: punt {contact: true}'s own gate (a body against it, at a walk's speed, away from the body, at rest)
  ["shove-walker", "shared/shove-test.ts", 1], // …the walker's side (shared/shove.js): one punt per contact, bounded, none standing still or for what may not be shoved
  ["own-names", "shared/own-names-test.ts", 1], // #297: a bone or contact-point name is an own key; constructor, __proto__, toString never read as one
  ["rand", "shared/rand-test.ts", 1], // #299: the shared seeded stream (shared/rand.js), and no glibc-multiplier product (past 2^53) left in the tree to collapse into a short cycle
  ["force", "protocol/force-check.ts", 1], // force {at, radius, power} (/boom): bodies through their consent, loose things through the punt
  ["physconst", "shared/physconst-test.ts", 1], // one binding for reach and hand numbers (the authority's, the client's); R 10-28: the punt's reach is KICK's alone
  ["agentshove", "protocol/agentshove-check.ts", 1], // …an agent's walk shoves too, through the same punt (a real WorldAgent on a real server)
  ["hands", "protocol/hands-check.ts", 1],       // what is in a hand and where a put lands: held things are not ground, no perching, an edit takes it from the hand, two hands
  ["track-teleport", "client/track-teleport-test.ts", 1], // a forced track re-arrives by teleport at most once in 3 s
  ["put-settle", "client/put-settle-test.ts", 1], // a thing leaving a hand eases from where it was drawn to where the fold puts it
  ["reset", "protocol/reset-check.ts", 1],       // a reset button: reactions kind reset, the home component
  ["settle", "protocol/settle-check.ts", 1], // what a thing at rest is attached to
  ["disabled", "protocol/disabled-check.ts", 1],   // a switched-off thing: no handling, no body, nothing stands on it; back on, all returns
  ["histdiff", "protocol/history-diff-check.ts", 1], // history {id}: each entry says what changed (a field, from what to what)
  ["reachgate", "protocol/reachgate-check.ts", 1], // design review 10-15 item 1: a hand on another body relays only with their consent (the relay strips it, the reacher is told)
  ["consent", "protocol/consent-check.ts", 1],   // the consent tool never writes through a prototype (security pass 2, H-0); a refused change changes nothing
  ["gates", "protocol/gates-check.ts", 1],       // R 10-28: body consent is two gates (move, touch) and two lists (allow, block): the order, the world default, a stored switch or table migrated never wider
  ["consent-client", "client/consent-client-test.ts", 1], // R 10-28: the browser's gates and lists land at the authority, old localStorage keys migrate never wider, a failed sync is heard and retried
  ["media-trust-tabs", "client/media-trust-tabs-test.ts", 1], // bot #141: an untrusted-links revoke in one tab reaches the others (storage event → media:trust)
  ["confirmcenter", "client/confirmcenter-test.ts", 1], // bot #213: an interrupting ask answers the open centre card with ITS cancel (false / null / its own)
  ["rolespanels-access", "client/rolespanels-access-test.ts", 1], // 333-cm a1/a2: a two-write door is one {requests} batch; the newcomer warning reads default-role.can
  ["groundpanel", "client/groundpanel-test.ts", 1], // 333-cm a6/a7: grow never sends a delete; a palette missing a grass dial says so instead of throwing
  ["editquad", "client/editquad-test.ts", 1], // 333-cm a9: the edit quad offers a padlock only where the viewer may lift it (r.lockable), and faces a range as the desktop does
  ["windows-guard", "client/windows-guard-test.ts", 1], // bot #578/#579: windows.js loads where storage throws; the painted min-width yields to a narrow viewport
  ["history-rows", "protocol/history-rows-check.ts", 1],   // the editor History never shows a refused attempt as done (Commons parity audit)
  ["scale", "protocol/scale-check.ts", 1],       // the authority at scale: ten requests timed (best of up to 5 tries): growth 72 → 500/2 000 things, a 500 ms hang backstop; gates before work; capacity; indoors (review 10-06)
  ["roles", "protocol/roles-check.ts", 1],       // roles + moderation (research roles 10-06): ranks, permissions, the grant rule, sanctions
  ["access", "protocol/access-check.ts", 1],     // who may come in (upstream #258/#259 in our terms): @world.access join/watch, per-caller /worlds and /access, the settle (4010), timed grants (expire-roles), reset keeps the door
  ["batch2", "protocol/batch2-check.ts", 1], // build mode v1 batch 2: story, text, picture, sound (+ where media may come from), look-at, Credits in History
  ["describe-particles", "protocol/describe-particles-check.ts", 1], // R 10-07: description (the accessibility reading) and particles as effect documents (Godot's CPUParticles3D ported)
  ["client-b2", "protocol/batch2-probe.ts", 1],  // batch 2 in headless Chromium: a stage per component, and an untrusted link never fetched without the viewer's opt-in
  ["picture-note", "client/picture-note-test.ts", 1], // the picture block's status line: survives a repaint and a demote/promote, not a remove; an agreeing echo keeps it, a disagreeing one retires it
  ["access-panel", "protocol/access-panel-probe.ts", 1], // World Settings › Who may come in › Listed here in headless Chromium: listed rows, add by a name seen here or an exact identity, the authority's refusal in words
  ["lock-strength", "client/lock-strength-test.ts", 1], // review of PR #260 (edit/panels.js:479): the Hierarchy row's padlock word is the lock the thing holds now: a builder's re-lock after an owner's reads as a builder's, and a refused ask is asked again
  ["swim-lists", "client/swim-lists-test.ts", 1], // review of PR #260 (watervolumes.js:123): swimming reads every water body and dry pocket, not only the ones the fog keeps
  ["build", "protocol/build-check.ts", 1],       // ship-list group B (10-07): building walls at the authority, nested blueprints, the editor's new script
  ["counter", "protocol/counter-check.ts", 1],   // PR #208 review's twelve-line list, as a counter button: publish/attach (§4.1), a script on sponsor rights (§8), the algebra (§7a) — C1…C12; shared/blueprint-test.ts (the "blueprint" row) is the pure half it leans on
  ["blueprint", "shared/blueprint-test.ts", 1], // blueprints through the door (publish, create {from}, its undo) and the agent's tools
  ["build-client", "protocol/build-probe.ts", 1], // …and in a real browser: a building edit and its undo, turn/size before placing, the new-script card (one browser, guarded)
  ["shiplist", "protocol/shiplist-check.ts", 1], // ship list group A (audit 10-07): openable, reactions checked at write, motion fields, help text, people's words
  ["comps-parity", "client/comps-parity-test.ts", 1], // the Hierarchy row and the Inspector read one record at the rename's own event (matrix #40/52: lost cover gated again)
  ["world-card", "client/world-card-probe.ts", 1], // 333-cm a5: Create ▸ Environment and an environment row open the world's card (c:<key>) and scroll to it
  ["shiplist-probe", "protocol/shiplist-probe.ts", 1], // …in headless Chromium: E opens a door and it swings; a person's refusal and warning; a moderator's warning in VR
  ["agenttools", "protocol/agenttools-check.ts", 1], // the agent's tools on a real server (tools audit 10-07): move walks the authority's body (walls), create {from}, a refused shove is an error, MCP annotations, look points at real tools
  ["look", "mcpl/look-test.ts", 1], // look says which way each person faces, from pose.yaw (#225)
  ["presence", "protocol/presence-check.ts", 1], // security pass 3 H2: no one shows under another account's name; puppet/bodydrag/typing reach the identity named; a whisper reaches nobody (removed)
  ["modhole", "protocol/modhole-check.ts", 1],   // security pass 3: nothing a world sends runs as code in a visitor's browser; EW.mods.put/run need your hand
  ["xss-probe", "protocol/xss-probe.ts", 1],     // security pass 3 H1 in headless Chromium: a hostile display name is text everywhere; the page's CSP refuses inline script and lets the client run
  ["pretrans", "protocol/pretrans-check.ts", 1], // review 10-07 "protocol shape": the edges the Commons translation makes permanent (names, defaults, ids, refs, governance, models, privacy)
  ["soundclock", "protocol/soundclock-check.ts", 1], // a sound's shared playhead is on the server's clock (serverNow), never Date.now
  ["sound", "shared/sound-test.ts", 1],     // the sound component's meaning and look() line; 200 m, still silent at radius
  ["picture-look", "shared/picture-look-test.ts", 1], // the agent's look() line for a picture (agent-senses saysOf): named, replaced, removed
  ["replica-hierarchy", "shared/replica-hierarchy-test.ts", 1], // the replica's parent/child index agrees with a scan after every write, a carrier-to-carrier move among them (client-check B4b has none)
  ["audioctx", "client/audioctx-test.ts", 1], // one AudioContext per page
  ["sound-editor", "client/sound-editor-test.ts", 1], // the sound editor block (its clock, t0, no guard); 32 world sounds at once, the radius field to 200 m
  ["skypanel", "client/skypanel-state-test.ts", 1], // the sky panel's state lines; R 10-28: every shared select commits what it shows (the world select saved nothing)
  ["sky-bakelock", "client/sky-bakelock-test.mjs", 1], // the sky's one-bake-at-a-time lock (sky_bakelock.js): a queued prebuild waits, BAKE_AFTER runs inside the lock, no deadlock
  ["sky-swapchain", "client/sky-swapchain-test.mjs", 1], // the sky's tier swaps (sky_swapchain.js): a superseded swap records nothing shown, a return after one acts, a stand-down keeps the dome
  ["sky-lifecycle", "client/sky-lifecycle-test.mjs", 1], // the sky's quality lifecycle on a scaled clock: held in the headset and applied once at exit, the cap takes the pending choice, a failed bake puts the live clouds back
  ["sky-degrade", "client/sky-degrade-test.mjs", 1], // 333-cm b2: a storage-texture build failure retries with the light cache off (degrade 1), even at quality high
  ["forecast", "client/forecast-test.ts", 1], // the deterministic weather forecast: late joiner, override, provenance
  ["physics-off", "client/physics-off-test.ts", 1], // the per-client object-physics switch: off, no flights folded or drawn, committed poses
  ["predict-pending", "client/predict-pending-test.ts", 1], // bot #574/#575: a predicted release is presentation only: whereIs never reads the guess; a guess no entry confirms in PENDING_MS is dropped without a sim update
  ["eidomodel", "protocol/eidomodel-check.ts", 1], // review 10-07 H3: a translated world's models are eido:sha256 addresses; the index, /eido/, /library/eido/, the client's mapping
  ["party-probe", "protocol/party-probe.ts", 1], // the editor's party blockers (review 10-07 B1–B5, S1/S4/S5/S7, lock levels, moderation commands) with real mouse and keys
  ["colour-picker", "client/colour-picker-bench.ts", 1], // the Inspector's colour field is a picker of solid cells a headset quad can click, in headless Chromium (one browser, guarded)
  ["vrmic-exec", "client/vrmic-exec-test.mjs", 1], // vrmic.js's effects on a fake clock: the mic ask never blocks entering VR; a promise made in VR is kept after it
  ["xr-nullfb", "client/xr-nullfb-test.mjs", 1], // xr_nullfb.js on a fake renderer: installs only for a null-framebuffer (emulated) session, once, never on hardware
  ["alias", "mcpl/alias-test.ts", 1], // an old tool name is an old tool: exactly the unknown-tool (Mica 11-05); folded/removed tools name what does it now
  ["tool-replies", "mcpl/tool-replies-test.ts", 1], // what the agent's tools and body say and send (pure; #53 shortens the 8 s timeout, pinned)
  // socketteer's pathfinding stack (#235/#236/#239/#241, merged into the protocol 10-15): its own suites, as it ships them
  ["agent-mesh-collision", "mcpl/agent-mesh-collision-test.ts", 1], // #235: an agent's body collides with placed models (the support barrier, the 3-at-once governor)
  ["navgrid", "server/navgrid-test.ts", 1],  // #236: move routes through placed models (round furniture, through doors, up stairs; y picks the floor)
  ["structure-threshold", "shared/structure-threshold-test.ts", 1], // the agent half of structure routing: WorldAgent ticks and the move tool over a structure
  ["structure-route", "shared/structure-route-test.ts", 1], // routing over a griddled structure (structure-route.js)
  ["navgrid-rows", "client/navgrid-rows-test.ts", 1], // a route on built boxes ends where a body stands or says why; a scaled thing scales its places, never the body's tolerances
  ["places", "mcpl/places-test.ts", 1],    // #239: named places (move {to: "thing/place"}, which room you're in, name_place), look's places in sight, "?"
  ["blank-part-uvs", "server/blank-part-uvs-test.ts", 1], // a named blank part keeps its UVs through the store's optimize pass
  ["storey-walk", "mcpl/storey-walk-test.ts", 1], // #140/#200: the storey a body stands on is the one its walk, its feet, its flights and look reason about; a walk from a floor stays on it
  ["walk-support-lifecycle", "mcpl/walk-support-lifecycle-test.ts", 1], // a walk's support from planning to its last tick, and how a walk ends: arrival, stop, replacement, close
  ["agent-reads", "mcpl/agent-reads-test.ts", 1], // every read the agent makes of the world server has a deadline; a geometry read that timed out is asked again
  ["route-shape", "shared/route-shape-test.ts", 1], // GET /geom ships the view record (viewOf) verbatim (C7a)
  ["door-unit", "mcpl/door-unit-test.ts", 0.5],   // the agent door's units: loops, stops, part refusals, speech tags
  ["manifest", "mcpl/manifest-test.ts", 1], // §17.2 manifest digest against the frozen 25-vector corpus; an own manifest's revision excludes itself
  ["token-registry", "mcpl/token-registry-test.ts", 1], // the agent token registry fails closed: missing or malformed files authorize nobody, the tracked example credential is refused, no prototype keys
  ["door-media-whitelist", "mcpl/door-media-whitelist-test.mjs", 1], // the door's media lane to a voice sidecar is a whitelist (sfu-answer, sfu-ice, …), never a pipe (#100)
  ["door-bone-list", "mcpl/door-bone-list-test.ts", 1], // the door's list of the worn body's bones
  ["author-wire", "shared/author-wire-test.mjs", 1], // "who said this" on the wire: an admitted name wins over the token registry's
  ["selfpose", "mcpl/selfpose-test.ts", 1], // the pose/animate authoring surface: canonical bone names, suggestions, the walk-shed rule
  ["effective-mcpl", "mcpl/effective-mcpl-test.ts", 0.3], // the agent's composed transforms (mounts, stretch, shear, stored rotation)
  ["headless-core", "mcpl/headless-core-test.ts", 0.3], // the agent's stand-in core exports each shared name as core.js does: a function where it is a function
  ["effective", "mcpl/effective-test.ts", 0.5],   // the same seen from a seated body (occupant size, seat correction)
  ["stretched-support", "mcpl/stretched-support-test.ts", 1], // a stretched thing's support (box, heightfield, triangles, lying down) holds a body where it's drawn
  ["stretched-places", "mcpl/stretched-places-test.ts", 1], // a named place on a stretched thing is stretched with it; a region's floor slack stays 0.1 m
  ["door-body", "mcpl/door-body-test.ts", 1], // the door's own body state on a bare agent: a tracks loop, a reach held to several bodies, a walk across a rejoin
  ["body-state", "mcpl/body-state-test.ts", 1], // body_state geometry on an owned sequencer: FK round trip, contacts, kneel, seated geometry withheld, a swimmer's stroke, body size end to end
  ["body-runtime", "client/body-runtime-test.ts", 1], // a body that brings its own runtime (§24 avatar defs `runtime`, #309): the def contract and the frame order the avatar runs it in
  ["glb2vrm", "shared/glb2vrm-test.ts", 1], // glb2vrm's rig-family gate (#123, #137): a Mixamo or unknown rig is refused by name, a Tripo-named one gets past the gate
  ["vrmheight", "server/vrmheight-test.ts", 1], // a body's stature read from its VRM (vrmheight.ts via rig.js stature), the door's bodyHeightFor agreeing
  ["shape-attach", "shared/shape-attach-test.ts", 1], // shape audit 10-16 wave 2: socket/station, one action namespace, one home, grabbable registered, reactions frozen, look-at radians, places closed, spawn, lock, reserved names
  ["shape-physics", "shared/shape-physics-test.ts", 1], // shape audit 10-16 wave 2: transform pinned (glTF rule), parent −order, pivot {pos}, motion trims + repair, physics kind/reserved/kinematic, physics-engine, collider mesh, physics-joint + joint, structure, surface, stage
  ["shape-import", "shared/shape-import-test.ts", 1], // the shape audit's rules live in the v1 importer: a translated world comes out in today's spelling, sockets lifted; nothing repairs a world founded today
  ["buildcheck", "server/buildcheck-test.ts", 1], // #241: the build check against the walking body's rules
  ["buildcheck-queue", "server/buildcheck-queue-test.ts", 1], // #241: checks are queued, cached, and answer for the bytes hashed
  ["buildcheck-route", "mcpl/buildcheck-route-test.ts", 1], // #241: GET /check and measure {check: true} (check_model)
  ["flight-exit", "mcpl/flight-exit-test.ts", 1], // #287 #290 #293 #298 #300: an agent's flight has one way out (endFlight) and one current course (setCourse)
  ["door-is-error", "mcpl/door-is-error-test.ts", 1], // #269 (main, merged into #260 10-20): a door call that didn't do what it asked answers isError; flight acts answer {ok, text}
  ["door-wording", "shared/door-wording-test.ts", 1],   // #270 (main, merged into #260 10-21): the door's refusals say what wasn't done and why; deleted here once by mistake (3440e655), restored
  ["stdio-door", "mcpl/stdio-door-test.ts", 1], // the plain-MCP stdio door over its wire: the shared tool table, anim, a lamp made through create, inspect/edit/hierarchy on the folded record
  ["consent-replay", "mcpl/consent-replay-test.ts", 0.1],   // an agent's gates and lists, replayed on arrival, are what it holds when the read returns (house 6340433633; R 10-28)
  ["history-request", "client/history-request-test.ts", 1], // #267 (main): a history request with no answer rejects, so scrolling up can reach what a long disconnect missed
  ["named-pose", "client/named-pose-test.ts", 1], // #159: every named pose rides the presence wire (absence is not release; survives late join, reconnect, swap)
  ["presence-session", "server/presence-session-test.ts", 1], // the presence session on arrive and snapshot.present over raw sockets: a page's id outlives a reconnect
  ["other-body-pose", "mcpl/other-body-pose-test.ts", 1], // posing someone else and letting them go, from an agent's tools and the console's EW.pose/clearPose, on the other body's path
  ["settled-pose", "server/settled-pose-test.ts", 1], // #61: a body looks the same to a joiner as to itself (settledPose strips ragdoll frames on every hand-off)
  ["pose-provenance", "mcpl/pose-provenance-test.ts", 1], // #61's agent half: a physics pose leaves the agent only labelled ragdoll; a decision to move sheds the held pose
  ["skystamp", "shared/skystamp-test.ts", 1], // the sky's seq/by come from the log entry that wrote it (the stored value has none)
  ["skywatch", "shared/skywatch-test.ts", 1], // the ambient sky percept: one event per meaningful boundary, deduped; look()'s effectiveClock names who set the sky (#65)
  ["grant-command", "client/grant-command-test.ts", 1], // /grant keeps exceptions and the end date unless it changes them
  ["environment-realizer", "client/environment-realizer-test.ts", 1], // water on the flat floor; a rejoin clears gone terrain and grass
  ["grass-quality", "client/grass-quality-test.ts", 1], // the resident's local grass cap (#60): density, the governor's shed, one applied report the grass⚙ row reads
  ["terrainshape", "shared/terrainshape-test.ts", 1], // placed features and heightmaps over the terrain noise (shared/terrainshape.js)
  ["flora", "client/flora-test.ts", 1], // the grass verb's translation and a field's retirement (every hook drained)
  ["grant-until", "client/grant-until-test.ts", 1], // a timed grant's end is a whole millisecond (the authority refuses a fractional one)
  ["lite-graph", "client/lite-graph-test.ts", 1], // the lite client never imports the WebGPU renderer
  ["lite-choice", "client/lite-choice-test.mjs", 1], // the lite/full decision inline in client/index.html, as a pure function
  ["net-send-shape", "client/net-send-shape-test.ts", 1], // a message about a person carries their identity or is not sent; a spoken say carries spoken/utt/t0, a live one is refused offline
  ["first-name-account", "client/first-name-account-test.ts", 1], // the first-run door's name becomes the account
  ["retired-commands", "client/retired-commands-test.ts", 1], // a retired command says why it is gone
  ["animnames-retry", "client/animnames-retry-test.ts", 1], // a failed defs fetch is retried with back-off
  ["screenshots", "harness/bun-test.ts test/server/screenshots-test.ts", 1], // the screenshot broker: selection, cooldown, journeys, timeouts
  ["snapframe-render", "client/snapframe-render-test.ts", 1], // where the renderer leg puts the camera
  ["snapframe", "server/snapframe-test.ts", 1], // /snap framing (dist, height, pitch) end to end through the door's agent on an owned sequencer
  ["anim-backpressure", "server/anim-backpressure-test.ts", 1], // an anim skips a socket holding a backlog; a stop never does
  ["anim-wire", "mcpl/anim-wire-test.ts", 1], // an anim's replace flag through the relay: legacy replaces, an explicit merge merges, a puppet's owner rebroadcasts it as sent
  ["panels", "client/panels-test.ts", 1], // steppers per thing, focus keeps the panel, Tab adds to the hidden set
  ["panels-schema", "client/panels-schema-test.ts", 1], // the schema panels (edit/fieldpanels.js): rows, lists, row actions; a refresh held while an input is focused paints a tick after it blurs
  ["dock", "client/dock-test.ts", 1], // ui.js on the real module: the dock rail, the menu, pins, the waterfall's dismiss rules, the registerPanel seam
  ["perfscope", "client/perfscope-test.ts", 1], // the viewer-local cost overlay (perfscope.js) with real three: modes, solid vs overlay, hull and veil
  ["clickuse", "client/clickuse-test.ts", 1], // the mouse on things while holding one: the held thing offers put down, not pick up; a surface offers put here
  ["bodies-wear", "client/bodies-wear-test.mjs", 1], // the Profile's body rows: a failed body keeps its wear action; the size and nameplate sliders write once, at rest, under the body dragged (#196, #212)
  ["settings-panels", "client/settings-panels-test.ts", 1], // the settings panels (style, video, profile, bodies) through the real modules, only the renderer edge stubbed
  ["dropdown", "client/dropdown-test.ts", 1], // the house select skin (dropdown.js) on the real module
  ["namereveal", "client/namereveal-test.mjs", 1], // hold-to-reveal's input side (namereveal.js)
  ["mention-regex", "mcpl/mention-regex-test.mjs", 1], // the mention pattern built from a body's id and display name
  ["icons", "client/icons-test.ts", 1], // the attention glyphs are real, distinct path data
  ["dwell", "client/dwell-test.mjs", 1], // one dwell mechanism for the nameplate card, VR tooltips and VR handles
  ["bus-events", "client/bus-events-test.ts", 1], // the dock's move, the lantern's open/close and a gesture's key hint ride the module bus
  ["actions", "client/actions-test.mjs", 1], // the action registry's ranking tiers and merge on re-register
  ["edittheme", "client/edittheme-test.ts", 1], // edit mode's look keeps its design-spec promises
  ["components-inspector", "shared/components-inspector-test.ts", 1], // the Inspector's component cards (schema.sections) over the real corpus
  ["chat-resync-wire", "client/chat-resync-wire-test.ts", 1], // a re-join asks chat for what it missed, through the real net.js
  ["chat-log", "client/chat-log-test.ts", 1], // the chat log: the spoken-utterance merge and unread accounting
  ["chat-scrollback", "client/chat-scrollback-test.ts", 1], // scrolling up through chat history: pages in world order, every line once, a re-join's hole caught up, the 1,000-line cap
  ["attention", "client/attention-test.ts", 1], // the attention gate (attention-policy.js) and the real chat.js attention prefs
  ["surface-hold", "client/surface-hold-test.ts", 1], // a voice-relay leg holds an actor's lines
  ["sfu-adapter", "server/sfu-adapter-test.ts", 1], // admitParticipant's refusal branches through the decision layer and the in-process SFU adapter, one table; legs keyed per world
  ["relay-decision", "server/relay-decision-test.ts", 1], // relay incarnation and consent rules (#104 amendments 2, 3)
  ["sfu-mic-intent-race", "client/sfu-mic-intent-race-test.mjs", 1], // the SFU transport executed: mic intent that changes while an acquisition is in flight ends where the latest intent says (#148)
  ["voicesfu-devtrack", "client/voicesfu-devtrack-test.mjs", 1], // the mic device stops whenever voicesfu lets go of it: a reconnect, a swap to synth, a gate-unavailable refusal
  ["mic-ptt", "client/mic-ptt-test.mjs", 1], // push-to-talk: the gate decision executed under both regimes, the hang time and the rate limit
  ["mic-meter-gate", "client/mic-meter-gate-test.mjs", 1], // the sensitivity meter reads live exactly when the gate opens (gateThreshold, one dB track)
  ["stt-ptt", "client/stt-ptt-test.mjs", 1], // captions under push-to-talk: nothing posts with the key up; a release still flushes what was heard while held
  ["micstate", "client/micstate-test.mjs", 1], // every micstate export executed; releaseMicrophone keeps its lanes; the SFU hook is the one mic transport
  ["voice-wire", "shared/voice-wire-test.ts", 1], // voice state (mic, hear) on the pose wire, shared with everyone in the world per the owner's ruling; a late joiner sees it
  ["voice-wire-mutation", "server/voice-wire-mutation-test.ts", 1], // every seam of the voice-state wire contract is load-bearing: each broken in place turns its row red
  ["voicesource-real", "client/voicesource-real-test.mjs", 1], // voiceSource() on the shipped module (voicesource.js)
  ["captions", "shared/captions-test.ts", 1], // shared/captions.js: the caption bag a reader sees and the request's rules
  ["voicebot", "services/voicebot-test.ts", 1], // the show voice bot hears a world in DRY_RUN: joins as a replica spectator, voices only configured speakers by display name
  ["tts-fault", "client/tts-fault-test.ts", 1], // TTS failure paths executed: a hung or dead phonemizer worker and an orphaned synthesis fail loudly, never hang (#91 r3 B3)
  ["spoken-form", "client/spoken-form-test.mjs", 1], // what the TTS speaks (tts-chunk.js spokenForm), as a table: fenced code never spoken; ttsChunks only for a fence-only message
  ["ttsrow", "client/ttsrow-test.mjs", 1], // the audio panel's TTS section executed (ttsrow.js, ttslist.js): file and folder picks, the voice list in place
  ["particles", "client/particles-test.ts", 1], // a play/stop change updates the registry key, no rebuild
  ["particles-host", "client/particles-host-test.ts", 1], // the browser particle host (emitters.js) over a stand-in GPU half
  ["shadow-fade", "client/shadow-fade-test.mjs", 1], // registered shadow casters start not casting
  ["shadow-fade-mutants", "client/shadow-fade-test.mjs --mutants", 1], // each of its mutation controls goes red
  ["lamp-slot-policy", "client/lamp-slot-policy-test.mjs", 1], // who may claim the one casting slot (lightrig.js attachLamps)
  ["lamp-skin", "client/lamp-skin-test.mjs", 1], // a lamp inside a skinned body is located through the skeleton
  ["transmission", "client/transmission-test.mjs", 1], // a transmissive glTF material becomes a node material with its transmission, ior and thickness; nothing else is upgraded
  ["body-shadow-gate", "client/body-shadow-gate-test.mjs", 1], // only a lamped body (or the own-body pref) casts and receives; a remote never casts
  ["frames-layout", "client/frames-layout-test.ts", 1], // the frames and panels layout
  ["lantern", "client/lantern-test.ts", 1], // the lantern (commandbar.js): the keys' contract on the real module and the real action registry
  ["frames-resize", "client/frames-resize-test.ts", 1], // the frames' resize drag finish path
  ["models-field", "client/models-field-test.ts", 1], // house client I173: an override's clone is wrapped once
  ["lod-policy", "client/lod-policy-test.ts", 1], // #156: the tier is chosen before the fetch (dial, distance against the radius, pressure), never asked without a published recipe
  ["lod-client", "client/lod-client-test.ts", 1], // #170: the dial, the residency sweep, the loader's wire, an owned sequencer's answer, the in-place swap and the collider agree
  ["realized-lifecycle", "client/realized-lifecycle-test.ts", 1], // the model realizer's lifecycle over a held loader: full life, remove mid-load, re-model over a held load, demote/promote, reset, sockets
  ["components-wire", "client/components-wire-test.ts", 1], // components from the door to the realizer: an Empty is an invisible group (a light-carrying one is a light), lamps, colliders, parents, an imported lamp
  ["axes", "shared/axes-test.ts", 1], // the axis letters are one table (shared/axes.js); motion takes negative letters, look-at's door and turn don't (as before)
  ["catalogue", "protocol/catalogue-check.ts", 1], // a world knows only the catalogue it is handed: no silent lab default; an uncatalogued model refuses truthfully; stored models still fold
  ["compose", "shared/compose-test.ts", 1], // Mica 11-04: one thing carries model + mesh + light + socket, each realized on its own; labels read the components
  ["translate", "protocol/translate-check.ts", 1], // translation rulings (22 rights, 17 particles, 24 name bans, 50 report, version) + SWEEP-3 + light parity
  ["owners", "protocol/owners-check.ts", 1], // R 10-28: a translated world's owners are bound to the accounts main recorded for them; the rest listed, bindable (operator-repair bind)
  ["setup", "protocol/setup-check.ts", 1], // R 10-28: the first-run setup link: no operator → one boot line; a signed-in human or agent claims it once, stored, live; guests, other sites, wrong tokens refused
  ["importer", "protocol/importer-check.ts", 1], // the house's review of #260 (6291883302), the v1 importer: causes, the approval's hash, one identity per person, nothing left half-written, values read as v1 read them
  ["eidosim-v1", "protocol/import-v1/eidosim-v1-test.ts", 1], // the first eidosim's covenant tests, on the copy the importer keeps (house #260, importer I8)
  ["channelbox", "shared/channelbox-test.ts", 1], // #260 I242: the channel box through the real door; the rotate order is the viewer's (PROTOCOL §9.1), never sent
  ["euler", "client/euler-test.ts", 1], // the channel box's rotate math (shared/euler.js): a property sweep over all six orders against three.js
  ["last-world", "client/last-world-test.ts", 1], // #281 (main, merged 10-27): a bare link goes back to the last world you were in; the real net.js writes it at the door's yes and forgets a refused or empty world
  ["event-wire", "mcpl/event-wire-test.ts", 1], // MCPL RFC-001 rev 3 (main, merged 10-27): a world event's tags follow its kind facet; a notice is chat:system, speech never
  ["join-rfc005", "mcpl/join-rfc005-test.ts", 1], // the door's travel tool (RFC-005): join policy, founding refused, epoch across transitions, host decline/mute/error, plain-MCP lane, resume after reconnect and door restart
  ["denoise", "mcpl/denoise-test.ts", 1], // presence flaps, act refractory, self-echo, activity pulse; approach dwell, re-arm, depart wording, first-sight seeding, the disconnect rule, the knobs' clamp under a hostile env
  ["killz-slumped", "server/killz-slumped-test.ts", 1], // a knocked-down agent body is judged by its hips as it falls and lies: on a floor at or above the kill line (KILL_MARGIN under @world.bounds.min.y) it stays; below it, it is sent back once, and arrives standing
  ["consent-scripts-list", "server/consent-scripts-list-test.ts", 1], // consent {allow|block} naming a script or a sponsor's scripts reaches the authority through the server; an allow naming nobody says how to name someone
  ["custody-save", "server/custody-save-test.ts", 1], // a governance key is handed out only once the keys file holds it: a failed save hands out nothing
  ["briefing", "server/briefing-test.ts", 1], // #214: a join's briefing names the agent guide and its version; /agents.md serves it with an etag
  ["door-frame", "mcpl/door-frame-test.ts", 1],   // a malformed frame from anyone closes that one socket, never the MCPL door (Bun 1.4's ws throws an 'error' nobody listens for)
  // gated by the #333 trim: green with no blocker left (their ungated.json reasons had gone stale)
  ["auth", "server/auth-test.ts", 1], // the aid1 doors (garbage, expired, wrong audience, jti replay, spectate-only scope), sessions, an enrolled agent's name; permtest merged in
  ["mutant-anchors", "gate/mutant-anchors-check.ts", 1], // every mutant table's find text occurs exactly once in its file (static: reads the tables, runs no mutant; #333 H1)
  ["wp5-verdict", "water/wp5-verdict-test.ts", 1], // water-cross's WP5 verdict on synthetic evidence: its negative controls, no browser
  ["actionbar", "client/actionbar-test.ts", 1], // the action bar (actionbar.js): nine tiles, whole-tile snapping, postures on the desktop body and at VR entry
  ["aux-binding", "server/aux-binding-test.ts", 1], // B1 (#57): an aux leg binds to the primary's identity authority, or it does not attach
  ["keepalive", "server/keepalive-test.ts", 1], // the MCPL door's keepalive tolerates a thinking agent: missed pongs survive, a reap only after the full grace
  ["chatbridge", "services/chatbridge-test.ts", 1], // the Discord chat bridge (services/chatbridge) against an owned scratch world, in its DRY_RUN
  ["spoken-say-door", "server/spoken-say-door-test.ts", 1], // #100: the advertised MCPL surface (tools/call say) against an owned door, watched on the world socket
  ["sfu", "server/sfu-test.ts", 1], // the SFU's policy over real RTP (loopback werift peers): the acceptance rows checkable without a browser
  ["sfu-verb-gate", "server/sfu-verb-gate-test.mjs", 1], // every sfu-* verb in server.ts dispatch gates on spectator/surface (the sfu-pos remote-mute hole)
  ["tts", "client/tts-test.ts", 1], // the synthesizer, executed (#91 B2)
  ["heightmap-readiness", "mcpl/heightmap-readiness-test.ts", 1], // a real WorldAgent never commits noise in a heightmap's place: a failed grid keeps the last ground, a late one builds once
  ["emitter-percept", "mcpl/emitter-percept-test.ts", 1], // text-tier perception of the particles component (eidoverse-worlds #25), serverless
  ["typing-relay", "mcpl/typing-relay-test.ts", 1], // the door's typing relay (mcpl/typing-relay.ts) on a short clock: start, refresh, stop, a lost stop
  ["door-cap-gate-live", "mcpl/door-cap-gate-live-test.mjs", 1], // the MCPL door's capability gate on a live session
  ["mention-delivery", "server/mention-delivery-test.ts", 1], // MCPL routing for display names: speech, replay cursors, history, travel, aid1 aliases, duplicate credentials
  ["one-libvips", "server/one-libvips-test.ts", 1], // one libvips per optimize process (#122)
  ["ragdoll-floor", "client/ragdoll-floor-test.ts", 1], // the Bullet ragdoll (ammodoll.js) lands on a building's floor
  ["snap-settle", "client/snap-settle-test.ts", 1], // the renderer waits for the world as long as `wait` says
  ["lod-normals", "server/lod-normals-test.ts", 1], // a simplify keeps hard edges and UV seams (simplifyAttributes): an LOD keeps its shading, no encoder needed
  ["client-tools", "harness/run-client.ts --import-only --skip-suites --strict-env", 14], // refactor plan 2 D5: every test/**/*-{test,check} the gate doesn't run as its own row loads (a stub missing an export, a moved module); a hung import reads SLOW, not red (run-client-settle pins it); the full run is `bun test/harness/run-client.ts`
  ["help-words", "shared/help-words-test.ts", 1], // help lists and refusals say what the code holds: role-defs' permissions, undo's roles, the Light note; no review tags
];

// ---- lanes ----
// CORE runs first, in this order, and a failure there stops the gate
export const CORE = ["kernel", "trig", "laws", "engine", "normative", "gov-reserved", "diffcheck", "hygiene", "procgroup", "nov1", "vocab", "authority", "access", "identity", "scars", "reset-race", "txn", "txn-mutants"];
// every suite that launches a Chromium (directly, through playwright, or through test/harness/harness.ts scratchBench). The
// gate checks this list against the files themselves (browserLauncher), so a new browser suite can't hide in MAIN:
// a host without Chromium would fail it there, and a host with one would run Chromes it didn't budget for.
export const BROWSER = ["browser", "comps-parity", "world-card", "level-dive", "water-cross", "toast-group", "client", "refusedjoin", "client-b2", "build-client", "access-panel", "lock-strength", "swim-lists", "shiplist-probe", "xss-probe", "party-probe", "colour-picker", "vrmic-exec", "xr-nullfb", "client-tools", "harness"];
export const laneOf = (name: string): Lane => (CORE.includes(name) ? "core" : BROWSER.includes(name) ? "browser" : "main");
// the order the gate runs them: core (in CORE's order), then main, then browser
export const ORDER = [...CORE, ...SUITES.map(([n]) => n).filter((n) => laneOf(n) === "main"), ...SUITES.map(([n]) => n).filter((n) => laneOf(n) === "browser")];

/** The local files `f` imports, transitively, itself included (tools/ and test/ only; harness.ts is a door, not the suite's code).
 *  Separators are matched either way: on Windows a resolved path uses `\\`, and a `/`-only test stopped the walk there. */
export function localImports(f: string, seen = new Set<string>()): Set<string> {
  if (seen.has(f) || !fs.existsSync(f)) return seen; seen.add(f);
  for (const m of fs.readFileSync(f, "utf8").matchAll(/(?:from|import\(|import)\s*["'`]([^"'`]+)["'`]/g)) {
    if (!m[1].startsWith(".")) continue; let p = path.resolve(path.dirname(f), m[1]);
    if (!fs.existsSync(p)) for (const e of [".ts", ".js", ".mjs"]) if (fs.existsSync(p + e)) { p += e; break; }
    if (fs.existsSync(p) && fs.statSync(p).isFile() && /[\\/](?:tools|test)[\\/]/.test(p) && path.basename(p) !== "harness.ts") localImports(p, seen);
  }
  return seen;
}

export function suitePath(file: string) { return path.resolve(ENGINE, "test", file.split(" ")[0]); }

/** A file that launches a Chromium, directly or through the bench helpers (a helper counts where it is CALLED; a runner
 *  that starts other files says so with the marker comment `gate: launches a browser`). run.ts keeps every such suite in
 *  the browser lane, run-client.ts runs such files one at a time. */
const BROWSER_MARK = /\bscratchBench\s*\(|\bbrowserBench\s*\(|chromium\.launch|from ["']playwright["']|import\(["']playwright["']\)|puppeteer|--remote-debugging-port|gate: launches a browser/;

/** The first file `f` pulls in (itself included) that launches a Chromium, or null. This file is skipped: it holds the
 *  pattern's own text, so every suite importing it would read as a browser suite. */
export function browserLauncher(f: string): string | null {
  for (const d of localImports(f)) if (path.resolve(d) !== SELF && BROWSER_MARK.test(fs.readFileSync(d, "utf8"))) return d;
  return null;
}
const SELF = path.resolve(fileURLToPath(import.meta.url));

export function setAside(root: string, files: string[], base: string, prefix: string): { dir: string; moved: string[]; failed: string[] } {
  const moved: string[] = [], failed: string[] = [];
  let dir = "";
  for (const f of files) {
    try {
      if (!dir) { fs.mkdirSync(base, { recursive: true }); dir = fs.mkdtempSync(path.join(base, prefix)); }
      const to = path.join(dir, f);
      fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(path.join(root, f), to); moved.push(f);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") failed.push(f); }
  }
  return { dir, moved, failed };
}

/** The gate's record of a suite's output: the last `keep` chars once it passes `limit`, plus every verdict line (FAIL, SKIP,
 *  OPTIONAL, ✗) the cut dropped, so an early red can't fall off the tail (the evidence lines under it are not kept). */
export function outputKeeper(limit = 4e6, keep = 2e6) {
  let out = ""; const dropped: string[] = []; const MARK = /^\s*(FAIL|SKIP|OPTIONAL)\b|✗/;
  return {
    add(s: string) { out += s; if (out.length <= limit) return;
      let cut = out.length - keep; const nl = out.indexOf("\n", cut); if (nl >= 0) cut = nl + 1;   // on a line boundary: a kept half-line can't read as a verdict
      for (const l of out.slice(0, cut).split("\n")) if (MARK.test(l)) dropped.push(l);
      out = out.slice(cut); },
    get out() { return out; }, get dropped() { return dropped; },
    lines() { return [...dropped, ...out.trimEnd().split("\n")]; },
  };
}
/** The lines the gate keeps from a failed suite's output: every FAIL / ✗ line, plus the indented lines right under it
 *  (where checks print what they saw), at most `per` each, so a FAIL says WHAT it saw as well as which row failed. */
export function failLines(lines: string[], per = 3): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*FAIL\b|✗/.test(lines[i])) continue;
    out.push(lines[i]);
    for (let k = 1; k <= per && i + k < lines.length && /^\s{2,}\S/.test(lines[i + k]) && !/^\s*(FAIL\b|ok\b)|✗|✓/.test(lines[i + k]); k++) out.push(lines[i + k].slice(0, 1200));
  }
  return out;
}
