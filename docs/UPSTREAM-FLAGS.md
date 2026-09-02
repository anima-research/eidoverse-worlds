# Flags for upstream — what rimward found, fixed, and changed

For whoever merges `overhaul/rimward` into anima/main (or cherry-picks from
it). Everything here carries a commit on this branch; the sections are
ordered by what upstream most needs to know. Compiled 2026-08-30 (§24r).

## 1. Bugs found in upstream's own tree (fixed here, unfixed there)

Found during the 2026-08-28 catch-up merge (283 commits, febba9e) and after.
Each is red on anima/main as it stands:

1. **`tools/smoke.ts` asserts rtc delivery the server deleted.** The #104
   SFU cutover removed the rtc lane; upstream's smoke still asserts a
   message arrives through it. Ours asserts the lane is CLOSED (be36cb0).
2. **The mesh-fallback suite tests deleted delegation.** micstate's
   delegation back to voice.js was removed by the cutover; the suite still
   exercises it. Ours was rewritten post-cutover
   (tools/micstate-mesh-fallback-test.mjs, 5 checks).
3. **`mcpl/agent.ts` imports `three/webgpu` with no `three` in any root
   lockfile** — the agent door cannot boot clean from a fresh clone. Root
   package.json needs `three` (we pinned ^0.184.0).
4. **The typing suite can never pass against the hardened token registry.**
   The registry rejects any key that appears in the tracked example file,
   and `dev-token` is in the example. Ours uses a scratch registry
   (tools/typing-mcpl.test.ts writes its own tokens.json).
5. **`tools/avatar-test.ts` is red at HEAD**: the reach integration calls
   `avatar._reachOwned()` on the test's stand-in avatar, which doesn't
   define it. The stand-in needs the method (or the call needs a `?.`).
6. **The seat-lifecycle clip sha must resolve the serve ladder.** The suite
   hashes the LIBRARY's `sitting_normal_chair.vrma` directly; any deploy
   that serves a patched fork of that clip (prod does — seats.ts's own
   ladder comment records it, live 2026-08-19) gets every verdict reading
   "stale (clip bytes changed)" against bytes no client animates from. Fix
   in 3a5d93d: hash the first existing of [patched, opt, library] + rel —
   the same order the store judges.

- **`tools/flight-headless-test.ts` reads a hard-coded path on its author's
  laptop** (`/Users/lariareynolds/Documents/mythos-models/ragdoll-web/rig.json`,
  the LEAF FORCES section) — ENOENT everywhere else. Wants a fixture under
  `tools/flightbench/` or an env override. (Found merging a678f24, 2026-09-02.)
- **`tools/flight-test.ts` binds to file layout** — it greps `mcpl/net-server.ts`
  for the rehearsal gate and `client/lib/chat.js` for a `case 'flight':`; on
  rimward those live in `mcpl/tools.ts` (one table, one dispatcher, §24r) and
  the command registry. Retargeted here; upstream will meet the same when it
  takes the unification. Its bench world also needs `commit` (rimward's
  `runVerb` commits through the entry bus; `append` alone throws) — added.

## 2. Features upstream shipped dormant, now live here (port candidates)

- **The seat-profile write half (#101/#105) is wired** (3a5d93d):
  `POST /seat-profile` (named actor only — tokens.json bearer or aid1; the
  anonymous door token is 401; proposals only, 4KB cap), verdicts ride
  `/avatars` as `seat` with the `x-profiles-rev` header, a live proposal
  announces immediately. Countersign remains operator-only (no HTTP path),
  exactly per the #101 B4 design. `tools/seat-lifecycle-test.ts` — which
  was authored to fail until these routes exist — passes 37/37.
- **The stdio MCP door registers from the shared tool table** (d44dc02):
  `mcpl/tools.ts` holds ONE `TOOLS` schema table + ONE `HANDLERS`
  dispatcher (load-time advertise⇔handle assertion), `mcpl/server.ts` is a
  pure transport (16 → 34 tools), and `net-server.ts`'s 460-line switch is
  gone. Host differences ride a small `ToolCtx`. First-ever stdio door
  test: `tools/stdio-door-test.ts` (13 checks, real JSON-RPC over stdio).

## 3. Physics: instrument fixes upstream's fleet may want (253bf10)

The doll suites' knee/crumple instruments have false-positive regimes that
our 2-rig local fleet tripped; prod's 14-rig fleet may trip them too:

- **Knee "hyperextension" reads a legal fetal fold as wrong-way** when the
  thigh passes 90° of flexion in the measuring frame (hips at their stop +
  legal spine curl): a legal backward fold then shows a forward deviation
  of exactly −cos(thigh angle). Fixed by predicting the legal fold
  direction from the thigh's own swing-from-rest; a control with inverted
  knees still fires at 123°.
- **The crumple metric trusted the direction of a 7mm bone** (mythos-class
  rigs author the spine millimetres above the hips) — tens of degrees of
  phantom fold from a millimetre of solver slack while the spine joints sat
  at their stops. The metric's lower axis is hips→chest now.
- **The verlet FLEX cone ate the same 7mm bone and exploded** (65 m/s peak
  on a plain topple; six seconds of thrash). FLEX rows whose rest link is
  under 3cm are skipped at build. **Lesson, twice in one day: length-floor
  every direction read.**
- **`JOINT_SPECS.upperLeg` is the hand-tuned row again** (flex 90 / ext 8 /
  twist 0 / z ±13). It was parked for the Bullet wrap-point bug; the
  range-centering fix landed long ago with a "put the row back" note nobody
  collected. Note the coupling since the reach merge: shared/joints.js's
  tables now serve BOTH the tumble clamps and the reach IK — widening a
  limit moves what an arm can reach, not just how a body falls.
- **`tools/rig-load.mjs` excludes `.ktx2.vrm` from the fleet** (3b8e67a):
  texture serving-variants were being tumbled as bodies, and one
  long-standing "8.6cm handover" red was an artifact rig all along.

### 3a. The prod-fleet run (2026-09-01, 44 rigs) — four instrument fixes, one tuning item

Run against prod's full avatar roster (44 VRMs incl. the two overlay rigs).
Board before: ragdoll 56/3, ammodoll 68/1. After: **ragdoll 59/1, ammodoll
69/0, bodysim 20/0** — the one red is a NEW check that names the tuning
item below. None of these touch the joint tables.

- **Handover carried no hinge axes** (`ragdoll.js`, `rigmeasure.js`). The
  hinge normal is transported with the limb each step; a doll seeded from a
  snapshot rebuilt it from REST while its particles were mid-tumble, and the
  first step fired the full elbow/knee correction into the hands: 12–22cm off
  after ONE step on 41/44 rigs. The one-rig check sat on a rig that barely
  moved its arms. Snapshots now carry `h` (hinge normals, in `this.hinge`
  order); a snapshot without it (another engine's) derives them from the live
  limbs. The check runs on every rig.
- **Snapshot rounding is chaos food** (`rigmeasure.js`). 0.1mm / 1mm·s⁻¹
  rounding read as 0.01cm after a step and 1–35cm after 80 on 20 rigs; exact
  numbers continue to 0.00cm. The packer is full-precision now (~1KB, rare).
- **Drive directions from particles, not bone positions** (`ragdoll.js`).
  The bone's world position is only ever placed by `_followRoot`; on a rig
  whose skeleton is authored off its root origin (tel0s: 0.233m forward) the
  hips bone sat 23cm from the hips particle, the hips→spine direction was
  noise, the spine read antiparallel and held a stale frame, and the chest
  inherited 42° of roll. `_followRoot` (bodyengine.js) now honours the
  hips' rest offset from the root too (`_measureHipsLocal`, both engines).
- **Bullet limits contain the born pose as Bullet measures it**
  (`ammodoll.js`). The widening read the born excursion in the uncentred
  frame; the constraint measures in the centred one, and Euler angles are
  not additive across axes — feline's stride (hind leg flexed AND splayed)
  still read 8.6–10.7° over. The widening iterates to the fixed point of its
  own centering (1–2 rounds), and a LOCKED axis the rig is born off is locked
  *at the born angle* (zero freedom kept, no frame-one fight).
- **TUNING ITEM — post-landing creep** (open). A body that is down keeps
  whatever horizontal velocity its joints chatter into it: the ground contact
  is a pure vertical clamp (`_terrain`). mythos-2 after a 2.5 m/s shove lands
  +37cm (correct) then creeps back 39cm over 5.5s while an arm fights its
  limits to the 8s deadline; mythos_painthair 7cm. Disabling ANY constraint
  family changes the outcome (chaos, no single culprit); a sleep-regime grip
  was tried and made feline flail. Wants a tuned ground-friction law swept in
  `rag-tune`. The new ragdoll-test check ("a body that is down does not
  creep") is the instrument.

## 3b. Asset bug: the barrels model's origin is 2m from its mesh

`eidoverse/assets/models/scifi_barrels_group_of_four.glb` ships its
geometry at local z −1.35…−2.56 — the visible cluster is centred **1.95m
from the model origin** (bbox center [−0.001, 0.504, −1.953]). Every
system that treats an entity's origin as "where the thing is" aims at
empty air two metres from the barrels: kick/punt direction stamps, reach
gates, any rotation (which sweeps the mesh in a ~2m arc — this was most
of one playtest's "spinning through the ground in a wide arc"). Our
client now measures things by their collider-box center
(`colliders.entityWorldCenter`, §24t-4) and skips cosmetic spin for
far-offset models, but the honest fix is re-exporting the GLB with the
origin at the cluster's footprint center — worth an asset-library pass
for other offenders (`summarizeGlb` bbox centers make it a one-liner
audit).

The same offset has a VERTICAL consequence on terrain (§24t-6): anything
that grounds the origin — the deterministic sim, the terrain re-seat —
puts the mesh 1.95m away on a slope where the ground is somewhere else;
on commons's hills the cluster sat up to 29cm inside the hillside at
every landing. The sim applier now shows the visual center standing on
ITS ground (`simworld.js`, the terrain difference between the two
footprints — presentation only; `tools/sim-ground-smoke.ts` holds the
proof). Two residues only the asset fix removes: a body RELEASED to the
fold (an epoch-release `place`) is realized at the authored origin
height again, and the static terrain re-seat (world.js) still seats by
the origin — both sink the cluster by the same slope difference.
Re-exporting is a MIGRATION, not a drop-in: every logged `pos` for this
model names the current origin, so a centred re-export shifts every
existing placement 1.95m unless the fold or a one-time `place` pass
compensates.

## 4. Merge-conflict lessons (process)

- **Never `git stash` mid-merge** — it drops MERGE_HEAD (restored by hand:
  `git rev-parse <remote>/main > .git/MERGE_HEAD`). Cost us one scare.
- **The vegetation clobber class**: a merge once took "prod's hand-patched
  vegetation.js" (byte-identical to stock) over a carried override and
  silently dropped a tuned engine. The engine now lives as first-class
  client code (`client/lib/vegetation/`) precisely so a merge cannot do
  this again; the `patched/` directory is an ASSET overlay only.
- `mcpl-core-ts` is a sibling `file:` dependency — clone and `bun run
  build` it BEFORE `bun install` in mcpl/, or the copy under node_modules
  is missing its dist.

## 5. Structural changes a merge will meet on this branch

The refactor survey program (docs/REFACTOR-SURVEY.md, all items closed):

- server: ws handler table (`server/messages.ts`), join split
  (admitJoin/installJoin/buildSnapshot), `server/limits.ts`, `fsutil.ts`
  atomicWrite, one tick heartbeat (`server/tick.ts`), entry bus
  (`server/events.ts`), def registry (`server/defs.ts` + `defs/`).
- client: def-driven panels (`palette/groundpanel/skypanel/seatedit` split
  from build.js; `rows.js` row builders), `rigmeasure.js` +
  `bodyengine.js` under both body engines, `vegetation/` engine home.
- shared: `sim.js` (eidosim@0.1.0 — PROTOCOL_v2, deterministic sim over
  stamped intents), `force.js`, def validators (`floradefs`, `avatardefs`,
  `animdefs`, `skydefs`, `structdefs`, `grounddefs`, `uidefs`).
- Suites that pin source text were retargeted with the moves
  (whisper-disable, the two ws-switch suites). If you move these files
  again, those suites say so by name.
