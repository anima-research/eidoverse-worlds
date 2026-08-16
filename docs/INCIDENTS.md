# INCIDENTS — the institutional memory of eidoverse-worlds

Harvested 2026-08-08 ahead of the skeleton-first rebuild (TEL0S_NOTES.md §8,
step 1). This codebase does not carry TODO/FIXME markers — there are zero in
the tree. Instead, nearly every non-obvious decision carries the incident,
measurement, or date that produced it, written into the comment beside the
code. Those comments are the only place a great deal of this knowledge exists,
and the rebuild deletes and rewrites the files they live in. This ledger
preserves each one so that rewritten code does not re-earn the bug: every
entry keeps the observable (what went wrong, what it measured), the numbers
verbatim, and one line naming the constraint it imposes on any future
implementation. File:line references are current as of the harvest and will
drift; the incident is the durable part. Where a comment names a date, an
issue, a commit, or a person's live field report, that attribution is kept —
it is how you find the rest of the story.

Two files moved during the harvest (`client/lib/forecast.js` →
`shared/forecast.js`, `client/lib/particles.js` → `shared/particles.js`, both
staged as renames). Entries for those use the new paths.

Sections: boot/loading · assets/caching · sky/lighting · avatars/presence ·
world/fold · networking/server · behaviors · agents/mcpl · misc. Then the
AGENTS.md house rules verbatim, and the commit hashes the comments cite.

---

## 1. Boot and loading

**The boot the splash exists to hide**
`client/lib/boot.js:3-6`
"Arriving used to be: a black page while 2.1MB of engine parsed, then a dark
empty grid while ~22MB of body, clips and sky streamed in, with a small
bottom-right tray of filenames as the only evidence anything was happening."
Nothing said what was going on, how far along it was, or when you could move.
Lesson: the first paint must be static markup in `index.html` (it paints
before any JS loads at all), progress must be real bytes and real phases, and
the wait must teach the controls.

**Phase weights are measured, and the tail is deliberately held**
`client/lib/boot.js:18-31`
Weights: engine 14, connect 6, world 40, body 40 — "measured rather than
guessed". "What must never happen is the bar reaching 100% and then sitting
there, so `world` and `sky` deliberately hold the tail." The sky is
deliberately NOT a phase: "it arrives over your head a second later, and
waiting for it was most of a cold boot."
Lesson: a progress bar that saturates before the world is usable is worse than
no bar; and arrival must be defined as "is there somewhere to stand" (engine,
connection, folded log, a body, ground), not "everything is loaded".

**The engine phase can only be measured from outside itself**
`client/lib/boot.js:107-110`
"performance.now() is already ms since navigation, so this IS how long the
engine took to arrive and parse — the part of the boot the splash exists to
cover, and the part no JavaScript can measure from the inside any earlier."
Lesson: don't try to instrument engine parse from inside the engine; read it
off navigation timing at first opportunity.

**Escape hatches: 4s skip button, 45s hard ceiling**
`client/lib/boot.js:117-122`
"A stuck asset must never trap someone outside the world — they can walk in
and let the rest arrive around them." Skip button appears at 4000ms; hard
`finishBoot('timeout')` at 45000ms.
Lesson: every gate on arrival needs a user-visible bypass and an unconditional
timeout. (The 45s ceiling was load-bearing at least once — see the weather
deadlock below.)

**Scenery must not merely stop blocking arrival — it must stop competing**
`client/lib/boot.js:143-146`
"Without this the sky's 7.5MB simply moved from blocking the boot to stealing
its bandwidth, and the body — which arrival does wait for — got slower by
almost exactly what the sky gained."
Lesson: deferring work off the critical path is not a win if it still shares
the pipe; background work must yield bandwidth, not just ordering.

**Yielding to arrival must never become waiting on it forever**
`client/lib/boot.js:149-156`
`BOOT_GATE_MAX = 12000`. "if boot is somehow stuck, background work proceeding
is strictly better than a deadlock, and a deadlock here already cost a
45-second join once."
Lesson: any `whenBooted()`-style gate needs a bounded race; a two-way wait
between boot and a subsystem is a deadlock waiting for a timeout to break it.

**Two named causes of the load freeze, and the two jobs that answer them**
`client/lib/loadwork.js:1-20`
"The client freezes for seconds when things load into the world." MEASURE:
every heavy materialization runs as a labelled work record with phases, and the
browser's long-task entries are attributed to whatever work was active — "so a
freeze names its culprit in the console instead of being a vibe." SPREAD +
SERIALIZE: "Three bodies arriving together used to stack their parse/compile
bursts into the same frames; now they queue, and the queue wait is visible as
its own phase rather than masquerading as parse time."
Lesson: attribute stalls before optimizing them, and make queue wait a
first-class phase — otherwise it is misread as parse cost.

**⚠️ INVARIANT: serialize() is for LEAF operations only**
`client/lib/loadwork.js:17-20`
"Never call serialize() from inside a serialized function and never wrap a
caller that itself awaits a serialized callee — that is a deadlock, the chain
waits on itself."
Lesson: the load scheduler's queue is not re-entrant. Any replacement
scheduler must either enforce leaf-only enqueues statically or support
re-entrancy explicitly.

**The frame budget changes when someone is watching**
`client/lib/loadwork.js:41-45`
Budget 14ms while the splash covers the screen, 6ms after `booted`: "once
someone is walking around, 60fps means ~16ms frames and load work gets a slice
of that, not all of it."
Lesson: pre-curtain and post-curtain are different cost regimes; one budget for
both is wrong in one direction or the other.

**gpu lane: serializing wall time cost a body 19 seconds**
`client/lib/loadwork.js:118-137`
Two lanes because two resources are protected. cpu = "genuinely synchronous
main-thread work. Strictly one at a time." gpu = "internally frame-yielding
codegen followed by seconds of WAITING on driver-side pipeline creation.
Serializing that wall time was a mistake this trace paid for: a body queued
19s behind crates whose 'work' was mostly idle await."
Lesson: distinguish main-thread-synchronous work from wall-clock await.
Serializing the latter is a pure loss; overlap the waits.

**cpu lane max 2: one conjured model held the serial lane 18s on Safari**
`client/lib/loadwork.js:135-141`
"a parse's WALL time is dominated by draco workers and image decode — awaits,
not main-thread work (one conjured model held the serial lane 18s on Safari
while its webp decoded)."
Lesson: same as above, applied to parse. Note this makes the module header's
"at most ONE materialization finalizes at a time" stale — see the landmine
list in the harvest report.

**Priority: people materialize before furniture**
`client/lib/loadwork.js:132-133`
"2 = your own body, 1 = anyone's body, 0 = objects. People materialize before
furniture, always. Reorders WAITING work only."
Lesson: load priority is a social decision, not a technical one; encode it.

**Object compiles wait for the sky, or they compile twice — ~6s each on Safari**
`client/lib/loadwork.js:151-164`
"the sky's weather wraps and env bake rewrite material graphs, so an object
compiled before the sky pays its full compile TWICE. On Safari a single model's
WGSL->Metal compile measures ~6 SECONDS — compile-once ordering is the
difference between painful and fine there. Bodies (priority >= 1) are never
held: a person appearing beats a person appearing correctly lit."
`holdObjectCompiles` caps at 25000ms.
Lesson: compile-once ordering matters more than compile-soon on WebKit — but
the ordering dependency it creates is itself a hazard (see the deadlock).

**Frame holds: one held beat instead of ten stuttered seconds**
`client/lib/loadwork.js:194-203`
"Some scene changes invalidate EVERY compiled pipeline at once (the sky setting
scene.environment, weather wrapping materials). The next render() then rebuilds
them synchronously — the post-splash 'long freezes'. There is no way to render
the old state while the new one compiles, so the honest option is chosen
deliberately: hold presentation for one bounded moment… One held beat instead
of ten stuttered seconds. The frame LOOP keeps running — simulation, poses,
chat all tick; only renderer.render is skipped while held." Cap 4000ms.
Lesson: when a whole-scene recompile is unavoidable, hold presentation, not
simulation — and bound it.

**Long-task attribution, and the Safari-shaped hole in it**
`client/lib/loadwork.js:216-236`
"The browser already measures every main-thread stall over 50ms; all that was
missing is knowing WHOSE stall it was. Anything unattributed logs as such."
Threshold 90ms for longtask, 150ms frame gaps for the portable watchdog,
"Safari has no longtask observer, so frame gaps are the portable truth about
felt freezes."
Lesson: don't depend on a single browser's perf API for a cross-browser
problem; keep a portable fallback measure.

**The perf beacon exists because Safari's console is unreachable**
`client/lib/loadwork.js:237-256`
"Safari's console can't be read over WebDriver and most visitors never open one
— so the profile phones home instead: one small POST per session at 40s (the
load window) and one at 120s (the Safari compile tail)." And: "Steady-state
smoothness never shows in the jank lines — a constant 25fps has no >150ms gaps
(exactly how Safari's grass cost stayed invisible)", so the beacon carries an
fps median.
Lesson: a jank-gap metric cannot see uniform slowness. Ship an fps distribution
alongside it, and ship telemetry out of the browser you cannot inspect.

**Warm the bytes, do NOT wait for them: 12s of a 13s boot**
`client/lib/net.js:561-566`
"Blocking arrival on every model in the world made a cold join cost the sum of
its heaviest assets — 12s of a 13s boot, spent staring at a splash while a
crate downloaded. Objects materialising around you over the next few seconds is
what this world does anyway; the log's ORDER is what has to be respected, not
its bytes."
Lesson: replay must respect entry ORDER, never byte arrival. Prefetch in
parallel (`parallelMap(..., 6)`), then replay without awaiting bytes.

**A weather verb awaited during replay deadlocked the join to the 45s ceiling**
`client/lib/net.js:568-576`
"`weather` belongs here for a sharper reason than cost. It routes into the same
sky build as `sky`, which waits for boot to finish so it stops competing for
bandwidth — and boot waits for replay. Awaiting a weather verb therefore
DEADLOCKED the join until the 45s boot ceiling broke it. Anything that can
reach the sky must not gate replay." `NON_GATING = new Set(['spawn','sky',
'weather'])` (`net.js:492-494`).
Lesson: this is a real cycle — replay → sky build → whenBooted → boot → replay
— broken only by a timeout. Any verb whose handler can reach `whenBooted()`
must be non-gating, and the rebuild should make the dependency declared rather
than discovered.

**The sky pulls ~7.5MB and was most of a cold boot**
`client/lib/net.js:583-588`
"The sky verb pulls ~7.5MB of atmosphere and particle textures and then bakes
an environment map — that was most of a cold boot, spent so the world could
look finished the instant it appeared. Terrain still blocks (you need ground to
stand on); the sky resolves over your head a moment later."
Lesson: ground gates arrival; atmosphere does not.

**Idle bandwidth is spent, but demand wins instantly**
`client/lib/prefetch.js:9-22`
Three rules: (1) "The moment any real load starts (assets.js 'demand' event),
the in-flight prefetch is ABORTED — the socket is surrendered, not throttled —
and the queue parks until the network has been quiet for a while. A preempted
asset just retries later; HTTP caches never store partial bodies, so the demand
fetch starts clean." (2) storage only, never memory. (3) budgeted:
`SESSION_CAP = 600e6`, `QUOTA_FLOOR = 300e6`, `QUIET_MS = 1500`.
Lesson: speculative loading must be preemptible by abort, not by priority hints
alone, and must never pin bytes in the heap or the GPU.

**Prefetch order is discovered, and ordered by felt miss**
`client/lib/prefetch.js:81-91`
"The queue is DISCOVERED, not hardcoded (the no-manifest rule applies here
too)": roster bodies first ("a new walker materialising instantly is the single
most felt win"), then catalog previews, then everything spawnable smallest
first ("the most assets warmed per byte, with the giants last, once the session
has proven long"), then sky/weather sprites.
Lesson: prefetch order is a UX ranking; derive the list from the server, never
a checked-in manifest.

**Readiness is not "the page loaded"**
`client/main.js:974-979`
"'Ready' is not 'the page loaded' — it's the moment there is something to stand
in: your body exists, the log has been folded, and no heavy build (terrain,
grass, the sky's first bake) is still running. Dropping someone into a dark
grid the instant the socket opens is how the old boot felt instantaneous and
looked broken."
Lesson: define ready as a conjunction of world-state facts, and verify with one
settled frame (`requestAnimationFrame` twice) before lifting the curtain.

**A world with no entities drains its build queue before anyone subscribes**
`client/main.js:1007-1012`
"so poll as a backstop rather than relying on an edge that may never fire"
(`setInterval(checkReady, 400)`).
Lesson: edge-triggered readiness needs a level-triggered backstop for the empty
case.

**An empty world is indistinguishable from a broken one**
`client/main.js:984-996`
"no ground, no sky, no objects, no explanation. That is what a mistyped world
name gets you, and it is the worst possible first impression because everything
is working exactly as designed."
Lesson: when the correct output is "nothing", say so in words.

---

## 2. Assets and caching

**Three caches, all "download+parse once"**
`client/lib/assets.js:1-7`
`byteCache` (raw bytes with progress), `glbCache` (parsed GLB prototypes, every
use a skeleton clone), `vrmaCache` (animation bytes, retargeted per-VRM at
use).
Lesson: the parsed tier is the expensive one; keep prototype caches keyed by
library path and clone per use. (Note: VRM *parse* has no such cache — see the
landmine list.)

**Cumulative byte counters, because per-asset entries vanish**
`client/lib/assets.js:25-28`
"Per-asset entries vanish when they finish, so a bar built from `loads` alone
would leap backwards every time a download completed."
Lesson: progress must accumulate monotonically; never derive a bar from the
set of in-flight items.

**Every in-flight asset is listed so nothing looks like nothing**
`client/lib/assets.js:19-22`
"Every in-flight asset (downloads with byte progress, builds as spinners) is
listed so 'nothing is happening' never looks like nothing is happening."
Lesson: silent work is indistinguishable from a hang.

**Streaming threshold for byte progress: 200,000 bytes**
`client/lib/assets.js:72`, `:81`
Bodies over 200KB are read through a reader for progress; "long downloads keep
prefetch parked" by touching `lastDemandAt` per chunk.
Lesson: a long single download must keep the demand signal hot, or the
prefetcher will decide the network is quiet and take the wire back.

**GPU texture upload batches into one frame unless you slice it**
`client/lib/assets.js:110-113`
"GPU texture creation + upload otherwise happens inside the first compile or
render that binds each texture — batched into one frame. Walking the object and
uploading a budget-slice per frame moves that cost off the stall."
Lesson: prime textures explicitly, sliced, before first bind.

**Parse and skeleton are the irreducibly-synchronous chunk of a body**
`client/lib/assets.js:140-143`
"serialize so two arrivals can't stack theirs into the same frames, and yield
between passes so each stall is one pass long, not their sum. Bodies default to
priority 1 — people materialize before furniture."
Lesson: yield *between* synchronous passes even when you cannot slice inside
them; the sum of stalls is what people feel.

**"queued 19311ms · compile 5ms" — only the first use should queue**
`client/lib/assets.js:188-193`
"Precompile pipelines OFF the render path — otherwise the first frame that sees
a new material stalls the main thread (the ~1.5s spawn freeze). Only the FIRST
use of a model queues (it pays real codegen + pipeline creation); repeats are
cache hits and would just sit in line to discover that — prod trace: 'queued
19311ms · compile 5ms'."
Lesson: never queue work whose cost is a cache hit. The queue wait becomes the
cost.

**Two concurrent compiles of one model, ~6s each on Safari**
`client/lib/assets.js:198-202`
"Two spawns of the same model racing used to BOTH queue a full compile — and
with two gpu slots they ran CONCURRENTLY, each paying the whole
codegen+pipeline cost (Safari: ~6s each, twice, for one model). Clones share
material references, so one compile warms them all: the first caller compiles,
everyone else awaits it and then cache-hits."
Lesson: single-flight by the in-flight PROMISE, not by the finished result.
Deduplicate compiles per library path (`libCompiles` map).

**On Safari a single material graph compiles for SECONDS — name it in the tray**
`client/lib/assets.js:204-209`
"a spinner named after the model turns that from mystery jank into visible
progress." `work.phase('queued')` is set before `enqueue` "because an empty
lane starts the job synchronously".
Lesson: phase transitions must be recorded before the call that may not yield.

**Re-parsing ~1.9MB of VRMA per slot PER AVATAR**
`client/lib/assets.js:247-251`
"The parsed VRMAnimation is avatar-independent — only createVRMAnimationClip (a
cheap retarget against the humanoid rig) needs the vrm. This used to re-parse
the whole ~1.9MB VRMA per slot PER AVATAR, so every body arriving re-paid nine
GLTF parses the first one had already done."
Lesson: separate the avatar-independent parse from the per-avatar retarget and
cache the former globally. A transient failure must not stick
(`p.catch(() => vrmaAnimCache.delete(slot))`).

**The clip library is ~1.9MB per slot — 13MB between a person and their legs**
`client/lib/avatar.js:14-18`
"Waiting for all seven before a body could exist put 13MB between a person and
their own legs — the single largest chunk of a cold boot, spent on animations
most arrivals don't use in the first minute (nobody lands mid-climb). So a body
is born able to stand and walk, and learns the rest while you're already
moving." `CORE_CLIPS = ['idle','walk']`.
Lesson: ship the minimum viable body; hydrate the rest behind the person.

**A missing clip must degrade visibly, not silently**
`client/lib/avatar.js:21-27`
"Until a clip arrives, the nearest thing that HAS arrived stands in. Silently
playing nothing would read as a bug; walking when you meant to run reads as the
world catching up."
Lesson: substitute, don't no-op. (See also `remotes.js`: `'ragdoll'` has no
fallback entry *on purpose*, and that had its own consequence — §4.)

**Clip hydration used to fire seven VRMA parses in one burst**
`client/lib/avatar.js:268-272`
"One at a time, in idle moments — hydration used to fire seven VRMA parses in a
Promise.all burst right behind the avatar landing, which put a second stall
directly after the first."
Lesson: a `Promise.all` of expensive synchronous work is a scheduling bug
dressed as concurrency.

**The Deno host: 2000+ lines of filesystem code running unmodified in a tab**
`client/lib/assets.js:304-315`
"Skye's modules are written for a Deno host: they read their own dependencies
and assets with SYNCHRONOUS file reads (`eval(Deno.readTextFileSync(...))`,
`Deno.readFileSync(tex)`). A browser cannot do a synchronous network read, so
the contract is honoured the only way it can be: prime an in-memory file system
first, then let the synchronous reads hit it. This is what lets
`sky_worlds.js` — 2000+ lines of world packaging that assumes a filesystem —
run in a browser tab with ZERO edits to Skye's source."
Lesson: adapt to upstream's contract at one seam rather than forking upstream.
Keep the adapter shrinkable as upstream improves.

**Swallowed writes are louder than they look**
`client/lib/assets.js:368-371`
Bake/export paths write intermediates to disk; in a browser there is nowhere to
put them. "swallowing the write is correct, and louder than it looks because
anything that then READS the file gets a clear 'not primed'."
Lesson: prefer a no-op write plus a loud read failure over a fake success on
both sides.

**Declaring a capability absent beats a stub that pretends to succeed**
`client/lib/assets.js:384-386`
`Deno.Command` throws "[host] no subprocesses in a browser".
Lesson: unsupported must throw at the call, not fail mysteriously downstream.

**`null`, NOT `[]` — an empty directory and an old server are different facts**
`client/lib/assets.js:344-351`
"treating them the same made an old server look like a world with no sky assets
in it."
Lesson: absence-of-endpoint and absence-of-content need distinguishable
returns; conflating them turns a version skew into a content bug.

**The flipY contract must match the engine or every authored UV mirrors**
`client/lib/assets.js:392-401`
"the vertical flip is BAKED into the pixels (browser flipY convention) and
tex.flipY stays false, so it composes with repeat tiling; `{flipY: false}`
skips the bake for glTF-convention images. This shim must match or every
texture sampled through authored UVs (the vegetation trim sheets were the
first) arrives vertically mirrored."
Lesson: an image-orientation convention is part of the host contract; state it
and test it.

**`globalThis.GLTFLoader is not a constructor` killed the sky**
`client/lib/assets.js:417-419`
"Toolkit modules construct their own loader for celestial meshes. The Deno host
has it as a global, so ours must too — without it the sky died on
`globalThis.GLTFLoader is not a constructor` and fell back to the basic sky."
Lesson: the host contract includes globals, not just functions. Missing ones
surface as a silent quality downgrade.

**The store had no diet for months; the library got one on day one**
`server/optimize.ts:1-21`
"Uploaded GLBs (drag-drop, Orrery/Tripo conjures) used to be served exactly as
they arrived: raw multi-megabyte meshes with 2K PNG textures, paid in full by
EVERY client on EVERY first load, forever — the library got a draco+webp mirror
on day one (~30x) and the store, where all new content lands, never did."
Recipe: dedup + prune + resample + webp@1024 + draco. "Originals are NEVER
touched (append-only doctrine; they are the provenance the hash names)."
Lesson: whichever path new content actually arrives through is the path that
needs the optimization.

**⚠️ Draco/image encoding must run as a subprocess**
`server/optimize.ts:14-17`
"Draco and image encoding are CPU-seconds of synchronous wasm — inside the
sequencer process they would freeze pose relay and every world for the
duration."
Lesson: no synchronous multi-second wasm inside the event loop that carries
presence. `Bun.spawn` per file, one at a time.

**VRMs are deliberately NOT optimized**
`server/optimize.ts:18-21`
"their springbone/MToon extension data has not been proven through this
pipeline, and a corrupted body is a much worse day than a heavy one."
Lesson: an asset class whose extensions you have not validated stays out of the
pipeline until it is validated — say so, don't just omit it.

**An already-lean upload must not be shadowed by a same-size copy**
`server/optimize.ts:80-90`
Exit 2 when `out.length >= src.length * 0.95`; a `.failed` marker stops the
boot sweep re-measuring it. "tmp+rename: a killed pass must never leave a
truncated GLB where the server will trustingly serve it."
Lesson: write-then-rename for anything the server will serve, and record
"tried and not worth it" so it isn't retried forever.

**Environmental failures must NOT mark a file failed**
`server/server.ts:1284-1289`
"Environmental failures (deps not installed yet) must NOT mark the file — that
would permanently skip every upload made before the first successful `bun
install`. Only content failures stick." Env failure also clears the queue: "no
point grinding the rest."
Lesson: distinguish "this input is bad" from "this machine isn't ready" before
persisting a negative cache entry.

**`.vrm` is deliberately `no-cache`: three people looking at three cached rigs**
`server/server.ts:1344-1348`
"client code must never be heuristically cached (stale main.js = ghost bugs);
library assets cache hard — EXCEPT avatars: .vrm files get iterated on (rig
fixes, re-exports) and a 24h-stale avatar is a debugging nightmare (2026-07-22:
'sydney's arms are swapped' was three of us looking at three different cached
rigs). no-cache = revalidate each load, still cheap."
Lesson: mutable-name assets cannot be cached hard. The real fix is content
addressing (TEL0S_NOTES.md §4), which retires this hack.

**Measured 2026-07-26: VRM 0.50, VRMA 0.44, GLB 0.99 gzip ratios**
`server/server.ts:1352-1361`
"gzip the JS modules: three.webgpu.js is 2.1MB raw / ~500KB gzipped, and over a
DERP-relayed tailnet link that difference is seconds. .vrma and .vrm are here
too, and the old comment claiming 'binary assets are already compressed' was
only half right. Measured 2026-07-26: GLB models compress to 0.99 (already
Draco/webp packed inside — genuinely pointless), but VRM bodies hit 0.50 and
the VRMA animation clips 0.44, because their float animation tracks and mesh
data are stored raw. Seven clips at ~1.9MB each was the second-largest slice of
a cold boot; half of it was air."
Lesson: "binary means compressed" is false for raw float tracks. Measure per
extension; don't reason from the container.

**ETag from size+mtime: an 11MB avatar re-pulled per reload**
`server/server.ts:1331-1334`
"makes no-cache revalidation a 304, not a re-download (an 11MB avatar re-pulled
per reload is invisible on localhost and rude over tailnet)." Cache-control
must ride along on the 304 "(it refreshes the stored response's lifetime)".
Lesson: `no-cache` without an ETag is `no-store` with extra steps; and a 304
that omits cache-control resets nothing.

**A missing file must be a 404, not a Bun.file stream blowing up into a 500**
`server/server.ts:1325-1328`
"prod 08-02: an asset absent from the VPS library (rsync gap) turned every
spawn of it into 'Internal Server Error' instead of an honest not-found."
Lesson: existence-check before streaming; a deploy gap should read as absence,
not as server failure.

**`/library` listing must report the size the client will actually receive**
`server/server.ts:1726-1730`
"opt first: /library/ serving prefers the optimized mirror, so the listed size
must describe the file a client will actually receive — the prefetcher sorts
and budgets by these numbers, and the raw-library size of a draco+webp'd model
is off by ~30x."
Lesson: any metadata a scheduler budgets against must describe the served
artifact, not the source.

**The store was a black hole only its hash could name**
`server/server.ts:1597-1600`, `:1770-1773`
"The store is content-addressed, so the human name arrives ONLY here — record
it, or the catalog can never list this object as anything but a hash (an orrery
send used to vanish into exactly that black hole)."
Lesson: content addressing loses human names; capture them at ingest in a
side manifest, or generated content becomes unfindable.

**Browsers ask for `/favicon.ico` unprompted and got a 500**
`server/server.ts:1840-1844`
"the static handler threw ENOENT and answered 500, so every page load logged a
server error for a file nobody asked us to have."
Lesson: answer the browser's unsolicited requests explicitly.

**`/AGENTS.md` must resolve in any casing**
`server/server.ts:1853-1858`
"The closed-verb-set error says 'see AGENTS.md' — so the file has to be
reachable from the world itself, not just the repo. Any casing works
(/AGENTS.md, /agents.md): agents type both, and a 404 on the spelling the error
message taught you is a locked door with a sign on it."
Lesson: every path an error message names must be fetchable, case-insensitively.

---

## 3. Sky and lighting

**Upstream wraps materials AFTER first compile: 44 materials, ~2–6s per graph**
`docs/upstream-wrap-once.md` (2026-08-02, written for Skye; "Everything here
was measured on live multiplayer clients")
"`weather_system` (wetness/puddles) and `sky_system` (cloud shadows) integrate
with a world by sweeping the scene and rewriting existing materials… The wrap
changes the shader graph's shape, so every wrapped material's compiled pipeline
is invalidated and rebuilt. Same again when weather state changes what the wrap
emits. On a slow-loading browser everything is already in the scene when the
sweep runs: we measured **44 materials wrapped** on one Safari join (8 on
Chrome, which merely won the race), each recompiling a pipeline it had just
built. WebKit's WGSL→Metal compile costs **~2–6 seconds per unique material
graph** (Chrome ~0.5s). The double-compile is the difference between a playable
join and twenty seconds of freezes there."
The ask, either form: expose the wrap as a factory callable at material-creation
time, or "build the branches in always, gated by uniforms" so the graph shape
never changes (the ubershader pattern).
Lesson: this is Disease A of TEL0S_NOTES.md §2 — runtime shader-graph *shape*
instability. Nearly all the client's hold/cap machinery exists to absorb it. A
client-side material factory that wraps before first compile deletes the
machinery.

**scene.environment identity must never change — the cure, already proven**
`client/lib/sky.js:28-35`, `client/lib/sky_baked.js:52-61`,
`docs/upstream-wrap-once.md:49-57`
"The environment exists from the first frame — BLACK, contributing nothing — so
every material's lighting graph is born with its env branch in place.
scene.environment flipping null→texture later regrew the lighting branch of
EVERY PBR material at once (a whole-scene recompile, the biggest single
invalidation behind the post-splash freezes). Now the sky's bakes change this
texture's CONTENT; the object never changes; nothing ever recompiles for the
environment again." The target is 512×256, "PERSISTENT, module-lifetime, never
disposed, never replaced" (measured 08-02).
Lesson: for any texture bound into a graph, mutate content, never identity.
This is the existence proof that Disease A is curable.

**PMREM from the full 4096 display bake was a ~150ms stall every cycle**
`client/lib/sky_baked.js:51-55`
"scene.environment stays a dedicated small target (what IBL was sized for all
along) — PMREM from the full 4096 display bake was a ~150ms stall every cycle.
Each fresh bake is blitted down into this instead."
Lesson: size the IBL target for IBL; blit the display-resolution bake down
rather than letting the prefilter chew it.

**The volumetric cloud march: ~120fps without it, ~30 with**
`client/lib/sky.js:58-78`, `client/lib/sky_baked.js:1-8`
"The volumetric cloud march is the single most expensive thing this client draws
— measured on this hardware at roughly 120fps without it and 30 with. Its cost
is dominated by `cloudPasses`, which sky_system defaults to 8; Skye's
TIER=balanced drops that to 3, and even 3 is too much for a live frame budget on
some machines." So every tier below 'high' shows a BAKED sky: "The tier's cost
moves from per-frame to per-bake, which is why 'medium' can afford the FULL
8-pass march — it looks better than the old live 3-pass tier and costs a texture
lookup per pixel at runtime. The trade is stillness."
Lesson: a direction-only signal (camera-centred domes, cloud shell hundreds of
metres up, no visible parallax) should be baked, not re-marched 60×/s.

**Cloud quality is a CLIENT preference and deliberately never a verb**
`client/lib/sky.js:74-78`, `client/lib/build.js:1077-1088`
"how many cloud passes your GPU can afford has nothing to do with what the world
looks like, and one person's laptop must not dictate everyone else's sky."
Lesson: the split is world state vs. draw cost. Anything that only changes what
THIS machine draws stays local and persisted; anything shared is a verb.

**v1 baked at 2048 and read as mush; bands must be cost-weighted**
`client/lib/sky_baked.js:16-22`, `:184-193`
"TWO targets, front and back… v1 swapped one texture in place and the cloud
field's natural nucleate-and-grow read as stepwise jumps." "Bakes are BANDED:
the engine's cached bake material is re-rendered a horizontal strip per frame
(~2ms each) instead of one blocking full-quad pass, which is what makes a
4096x2048 bake affordable — v1's 2048 was ~4x undersampled against the screen
and read as mush." And: "texel cost is dominated by march chord length, which
blows up toward the horizon rows (a grazing ray crosses tens of km of cloud
shell where a zenith ray crosses ~1km) — uniform slices measured 27-48ms frames
at the horizon and ~0ms at the nadir. Weight rows by an inverse-elevation chord
estimate and cut slices of equal WEIGHT instead, so every band costs about the
same few ms."
Lesson: banding a render only bounds frame cost if the bands are equal-COST, not
equal-height. And crossfade between two targets, or slow evolution reads as
stepping.

**bakeEnv caches its node graph on (W, H, passes) — and on cloud presence**
`client/lib/sky.js:86-96`, `:444-455`, `client/lib/sky_baked.js:237-241`,
`:330-334`
"One resolution/pass choice PER SESSION per tier: bakeEnv keys its cached node
graph on (W, H, passes), so every bake call must repeat the same values or each
re-bake would rebuild and recompile the whole march pipeline." And the sharper
one: "makeSky's own weather default is 'clear', which OVERRIDES the cloud preset
(sky_worlds documents the trap), and bakeEnv caches its node graph keyed on
whether clouds exist at bake time: baking here pinned a graph with NO cloud
branch and the baked sky came out empty." A clear↔cloudy preset flip therefore
needs an explicit graph rebuild (`maybeRefreshGraph`).
Lesson: when an upstream cache is keyed on shape, every call site must agree on
the key, and a change that crosses the key needs an explicit rebuild — a
uniform cannot bring back a branch that was never compiled.

**Binding a never-rendered RT texture races texture init on wgpu**
`client/lib/sky_baked.js:173-176`
"sky_system hit intermittent 'OutputType is invalid' from exactly this — clear B
once so it exists before the dome material ever samples it."
Lesson: clear a fresh render target before any pipeline compiles against it.

**Park the live domes OUT of the scene graph, not behind `.visible`**
`client/lib/sky_baked.js:154-158`
"sky.update() re-asserts cloudDome.visible on every weather/cloud change, so a
visibility flag would not stay put. Off-scene meshes cost nothing, and
update()'s position/visible writes against them stay harmless."
Lesson: when upstream re-asserts a flag every frame, you cannot own that flag —
own the parenting instead.

**A slow Safari lost the sky race: the wraps hit 44 already-compiled materials**
`client/lib/sky.js:210-216`
"A sky is coming: pause OBJECT pipeline compiles until its wraps + env bake
exist, so every material compiles once, with its final graph — instead of once
now and once again when the weather rewrites it. (On a slow-loading Safari the
sky lost this race and the wraps hit 44 already-compiled materials; at ~6s per
graph compile there, that ordering WAS the twenty painful seconds.)" Released on
every path with a 25s cap.
Lesson: the workaround is ordering; the fix is graph stability. Keep the cap and
the finally-release on every path (settle, fallback, failure).

**08-02: "unresponsive for ten seconds with long freezes" after the splash**
`client/lib/sky.js:222-232`
"A FRESH sky build is the single most disruptive moment a running client has:
weather wraps rewrite materials and the env bake flips scene.environment from
null, which together invalidate every compiled pipeline in the scene — the next
render() then rebuilds them all SYNCHRONOUSLY (the post-splash 'unresponsive for
ten seconds with long freezes', 08-02)… hold presentation for one bounded beat,
settle the whole scene through compileAsync, resume warm. Rebakes and slider
previews don't build → don't hold."
Lesson: hold only on a genuine BUILD; a rebake or a preview must not steal a
frame.

**Six sky verbs produced six stacked sky systems**
`client/lib/sky.js:302-307`
"Replaying a log no longer AWAITS each sky verb (waiting for the atmosphere was
most of a cold boot), which means several sky entries in one log fire
concurrently — and every one of them saw `skyApi === null`, because none had
finished yet, and built its own atmosphere. Six sky verbs produced six stacked
sky systems and six weather systems. The guard has to be the in-flight PROMISE,
not the finished result."
Lesson: single-flight guards must key on the promise. This is the direct cost of
making a verb non-gating: concurrency arrives with it.

**makeSky returns no `dispose` — every rebuild stacked another dome**
`client/lib/sky.js:309-317`, `:341-360`
"makeSky returns an api with no dispose — so `skyApi?.dispose?.()` was a no-op
and every rebuild stacked another dome, weather system, particle hook and set of
wrapped materials on top of the last. That is the accumulation: each world
switch made the scene permanently heavier until it fell over. Since upstream
cannot tell us what it added, we diff the scene around the build and own the
difference."
Lesson: if upstream allocates without a teardown, own the teardown by diffing —
and never claim what another owner marked (`userData.entityId`,
`userData.isBody`).

**The hook claim was a LENGTH mark and silently truncated other owners' hooks**
`client/lib/sky.js:331-339`, `client/lib/autohooks.js:1-20`
"It used to be a LENGTH mark, which meant anything that registered a per-frame
hook after the sky built — a `particles` emitter on an entity — was silently
truncated away by the next sky rebuild and stopped billboarding, still in the
scene, facing wherever the camera happened to be. Identity alone is not enough:
this build is ASYNC, so a hook that appeared while it was in flight is new but
is not therefore ours — hence the host-owned marker."
Lesson: claim by identity AND by ownership marker. "any host subsystem that
keeps a per-frame hook should mark it, and any subsystem that claims by diff
should skip marked hooks."

**Six atmospheres are worse than the fault they were recovering from**
`client/lib/sky.js:185-189`, `:784-798`
"Rebuilding the sky is expensive and stacks (each makeSky evals its own
sky_system + weather_system). A per-frame fault fires 60 times a second, so
without a hard budget the 'recovery' path builds six atmospheres and is far
worse than the fault it was recovering from. Ask me how I know."
`MAX_SKY_BUILDS = 2`. And on per-frame failure: "Deliberately NOT rebuilding…
Report it once and leave the sky alone; a wrong sky you can still walk under
beats six right ones fighting each other."
Lesson: never put a rebuild on a per-frame error path. Count failures, degrade
once, say so.

**A per-frame throw is invisible to the try/catch around construction**
`client/lib/sky.js:761-766`
"A toolkit sky that throws from its PER-FRAME update is invisible to the
try/catch around construction: the object exists, renders nothing, and rejects
once per frame forever — a black sky and a console filling at 60Hz. Count
failures and fall back for good." (Tolerance: 8 failures.)
Lesson: construction success does not imply per-frame success; instrument the
update path separately.

**`storageTexture not implemented`: an unhandled rejection you cannot catch**
`client/lib/sky.js:176-183`, `:398-413`
"sky_system's light cache writes through T3.textureStore, and three's WebGPU
backend answers that with `Uniform "storageTexture" not implemented` — as an
UNHANDLED REJECTION from inside the pipeline, once per frame, which no try/catch
of ours can catch and which Chrome logs itself no matter what we do. It
reproduces on a real desktop Chrome while passing in headless here, so it is not
something to feature-detect optimistically." Surgical: LCACHE only — "CACHE=0
kills the density cache too and the sky renders BLACK without it — the offending
textureStore is in the LIGHT cache alone (sky_system.js:1060)."
Lesson: when a fault cannot be caught, opt IN to the risky path rather than
opting out after it has flooded a console. Use upstream's own bisect knobs
(LCACHE/DCACHE/CACHE) before reaching for a sledgehammer.

**Intercepting the assignment is the only seam**
`client/lib/sky.js:120-135`
"sky_system.js ASSIGNS globalThis.makeSkySystem when sky_worlds evals it, and
sky_worlds calls it in the same breath — so there is no moment in between to
wrap it. Intercepting the assignment itself is the only seam, and it keeps
Skye's files untouched."
Lesson: a `defineProperty` setter is a legitimate seam when there is no temporal
gap to hook.

**ringworld and shieldworld: ~20MB of geometry and they take the tab down**
`client/lib/sky.js:142-150`, `:293-297`
"ringworld and shieldworld each drag ~20MB of celestial geometry and add a
second raymarched layer on top of the cloud dome; on this hardware they crawl
and then take the tab down. They are not deleted from the toolkit — a log that
asks for one is coerced below rather than refused — but nothing in the UI will
hand someone a world that hangs their browser." Priming splits by world so
`earth` doesn't drag the ring geometry.
Lesson: coerce, don't refuse, on the log path; and never offer a known-fatal
option in the UI.

**A sequencer without `/library-list` is older than this client**
`client/lib/sky.js:283-291`
"The toolkit sky reads its own assets synchronously, so the client has to know
what they ARE before handing control over — which it learns from /library-list.
A sequencer without that endpoint is older than this client, and no amount of
retrying will conjure it." (`e.skyUnsupported = true` stops the retry ladder
dead.)
Lesson: separate transient faults from version facts; a version fact must exit
the retry ladder immediately.

**The IBL never changed hour: midnight starfield over noon-bright grass**
`client/lib/sky.js:492-502`
"bakeEnv runs once at construction, and `scene.environment` then dominates every
PBR surface in the world — so the ground stayed lit at whatever hour the sky
happened to be built at. Midnight rendered a correct starfield over grass at
full noon brightness, which is the 'lighting doesn't change' that was reported:
the SKY was changing the whole time, the IBL lighting everything under it was
not." Debounced: `BAKE_MIN_GAP_MS = 900`, `BAKE_HOUR_DELTA = 0.25`.
Lesson: if the environment map dominates the lighting, it is part of the clock,
not part of the construction.

**Ownership boundary: makeSky drives sun and hemi, so the tuner must not**
`client/lib/sky.js:606-612`
"makeSky was handed `sun` and `hemi` and it drives them itself (colour,
intensity, and the fog/haze that follow the weathered sky). Re-deriving those
here would fight it — a sunset would get our noon-ish curve stamped back over
Skye's. So on this path the tuner only applies the knobs the world genuinely
owns: exposure, and the lamp response to time of day."
Lesson: name the owner of every light. Two owners writing one intensity is a
fight nobody wins. (TEL0S_NOTES.md flags the consequence: five of eight tuner
sliders silently do nothing on the primary sky path — `sky.js:660-691` vs
`build.js:975-983`.)

**Measured 2026-07-26: grass alone booted 1.3s; grass + 2 streetlights, 10.6s**
`client/lib/sky.js:708-715`
"Deferred until after arrival, deliberately. Adding point lights invalidates
every material variant in the scene, and with a grass field up that recompile is
enormous — measured 2026-07-26: a world with grass took 1.3s to boot, and 10.6s
once two emissive streetlights were in it. Neither alone is expensive; the
product is. Lamps are also near-invisible in daylight, so nothing is lost by
hanging them a moment later."
Lesson: cost is multiplicative between instanced fill and light count. Defer
light attachment past arrival unconditionally.

**Measured 2026-07-26: grass + 2 lights = 429ms at 61fps; grass + 4 = hung tab**
`client/lib/sky.js:726-733`
"Each additional point light forces another material variant to compile across
the WHOLE scene, and with an instanced grass field that recompile is brutal.
Measured 2026-07-26 on the same world: grass + 2 lights booted in 429ms at 61fps
and stayed responsive; grass + 4 lights never finished compiling and hung the
tab outright. The cost is superlinear in light COUNT, so the count is what has
to be bounded — not the number of lamps a world may contain. Two is what is
MEASURED to be safe here; raising it needs a re-measure, not an assumption."
`MAX_LAMPS = 2`.
Lesson: bound the count, not the content. Raising it requires a measurement, and
the measured-fatal value is 4 — which the placed-light budget still permits (see
the landmine list).

**A light glows even when it cannot cast**
`client/lib/lights.js:1-16`, `:44-56`
"a small emissive sphere GIZMO — always shown, cheap (one basic material, no
scene-wide cost), so a light is visible and selectable even when it isn't
casting… Past the budget a light still GLOWS but does not cast — the same honest
degradation the emissive-lamp system uses. The budget is shared with those
lamps, so it bounds total point lights, not just these."
Lesson: degrade the expensive half, keep the legible half. And say so in the
inspector ("glow-only on this machine (light budget) — it may still cast for
others", `lights.js:182`).

**Point-light shadows are a second cost cliff**
`client/lib/lights.js:62`
`pl.castShadow = false; // point-light shadows are a second cost cliff`
Lesson: shadow-casting is a separate budget from light-casting.

**`keep: true` is an author overriding frame rate, deliberately**
`client/lib/lights.js:23-29`, `:113-121`
"KEPT lights live OUTSIDE this budget entirely: `keep: true` is an author saying
'this light matters more than frame rate', so it always casts and consumes no
slot… The cost is real (every cast is a scene-wide recompile + per-frame GPU),
which is why keep is a deliberate checkbox and not the default." Un-keeping a
casting light re-enters the budget and drops its cast if that overcommits.
Lesson: an escape hatch from a measured safety budget is a loaded gun; document
it as such. (TEL0S_NOTES.md: "50 kept lights reproduce exactly the hang the
budget exists to prevent" — see the landmine list.)

**Pre-warm the scene-wide recompile off the click**
`client/lib/lights.js:66-68`
"gpu lane, lowest priority: relighting never outranks a person arriving."
Lesson: any action that triggers a whole-scene recompile should enqueue it at
the lowest priority rather than run it inline.

**Checking "keep lit" must do something you can see**
`client/lib/lights.js:117-121`
"checking 'keep lit' on a doused light re-lights it ON THE SPOT — the checkbox
must DO something you can see (kept casts need no budget)."
Lesson: a control whose effect is deferred to the next unrelated event reads as
broken.

**FogExp2(0.018) over a 280-unit dome = e^-5**
`client/lib/sky.js:622-626`
"the atmosphere would render as pure fog colour. The sky is not IN the weather;
exempt it." (`skyMesh.material.fog = false`.)
Lesson: exempt sky geometry from scene fog, and check the exponent against the
dome radius.

**A low sun that stays noon-white reads as overcast**
`client/lib/sky.js:637-650`
"Haze thickens as the sun drops — that's what actually paints a sunset dome; a
clear noon atmosphere at 13° elevation just looks grey." "Light temperature
follows the sun: white and hard at noon, warm and soft near the horizon."
Lesson: sunset is atmospheric scattering, not sun elevation alone.

**Low sun ≠ dark subjects**
`client/lib/sky.js:662-664`
"golden hour is FULL of scattered warm light" — hemi intensity keeps a floor
(0.6 + 0.4·day).
Lesson: don't scale ambient linearly to sun elevation.

**The far plane has to hold the SKY: 300 clipped the whole atmosphere**
`client/lib/core.js:106-112`
"Skye's world-space sky builds a cloud dome ~3200 units out, and the ringworld
package hangs its band 4940 up — at the old far plane of 300 the entire
atmosphere was clipped away and the sky rendered black while the ground looked
perfectly fine. WebGPU's reversed-Z keeps depth precision honest across this
range in a way WebGL's would not." (Now 0.15 → 20000.)
Lesson: a black sky over correct ground is a projection bug, not a shader bug.

**A non-MRT host must declare itself, two ways**
`client/lib/core.js:147-155`
"We render FORWARD (single color target), not the engine's MRT pipeline.
Eidoverse modules guard their G-buffer opt-outs on the presence of THREE.mrt,
and an mrtNode in a forward pipeline emits an EMPTY fragment output struct that
Chrome/Tint rejects. Two belts: a non-MRT host honestly declares itself by not
exposing mrt, AND upstream now honours an explicit opt-out flag (EANPA_NO_MRT)."
Lesson: capability detection by property presence is fragile; carry the explicit
flag too.

**`?wgsldebug` — Chrome only logs "invalid due to a previous error"**
`client/lib/core.js:61-64`
"the substance lives in getCompilationInfo on the shader module."
Lesson: shader compile diagnostics need an explicit hook; the default console
message is content-free.

**Clouds come off before pixels: 40fps at high vs 60 at medium**
`client/main.js:1086-1091`
"Shed pixels before shedding frames; shed animation detail before pixels. Clouds
come off before pixels do. The volumetric march measured 40fps at high vs 60 at
medium under identical GPU-bound load — a bigger lever than resolution, and a
slightly plainer sky reads better than a blurry whole world. Stepped at most
once every few seconds so a hitch cannot cascade the setting all the way to
'off'."
Lesson: order governor levers by measured effect per unit of visible loss, and
rate-limit each step so a transient hitch cannot ratchet the whole ladder.

**318k blades of fill is the frame budget on Safari (measured 08-02)**
`client/main.js:1113-1126`
"318k blades of fill is the frame budget on some browsers (Safari, measured
08-02 — 'grass really kills visual smoothness'), and a 60% field at full
resolution reads far better than a full field at 70% resolution. Sticky across
re-grows. Steps from the EFFECTIVE density (the resident's grass⚙ cap already
applies), so a capped meadow isn't 'shed' to a value the cap was already below —
that would toast without changing a single blade."
Lesson: a governor must step from the effective value, not the nominal one, or
it produces user-visible messages with no effect.

**The governor ladder, in order**
`client/main.js:1143-1169`
Under 26fps for >2 samples: clouds → a light → emitters → grass → pixel ratio
(floor 0.7, step 0.25); after >4: LOD bias 2 and shadow map 2048→1024. Recovers
above 52fps: LOD bias back to 1, pixel ratio back up in 0.125 steps.
Lesson: the recovery path must exist for every lever. (Shadow map and
`MAX_CAST` currently have none — see the landmine list.)

---

## 4. Avatars and presence

**Presence is lossy at ~15Hz: lerp-to-latest stutters and teleports**
`client/lib/remotes.js:1-7`
"Rendering it means answering 'where was this body 100ms ago, between the two
samples that bracket that moment' — not 'snap to the newest thing that arrived'.
The old client lerped toward the latest sample with an exponential factor, which
stutters under jitter and freezes-then-teleports under loss."
Lesson: render behind the newest sample and interpolate the bracketing pair.
`INTERP_MS = 110`: "One frame of slack at 15Hz is 66ms; 110 gives room for one
dropped packet without a visible stall" (`remotes.js:16-18`).

**Clock offset is smoothed, not sampled**
`client/lib/remotes.js:21-28`
`clockOffset = clockOffset * 0.92 + sample * 0.08`.
Lesson: server-to-local offset must be low-passed or the render cursor jitters
with every frame's network noise.

**A stale avatar load finished into the scene as an undisposable ghost**
`client/lib/remotes.js:34-41`, `:52-57`
"A switch that lands while the OLD body is still loading must not be dropped —
delete the map entry and let the stale load's own guard dispose it when it
completes." And: "Compare against OUR record, not mere key presence — a
replacement body re-occupies the key, and checking has(id) let the old avatar
finish loading into the scene as an undisposable ghost."
Lesson: the stale-load guard must compare object identity, not key presence.
Every async build needs a "is this still mine?" check at the join point.

**Bones ran ahead of the body they hang off — limbs led the fall**
`client/lib/remotes.js:88-101`
"The held pose (bones), blended a→b by the SAME k as the root. Handed `b` alone,
the bones ran up to INTERP_MS ahead of the body they hang off and stepped at the
66ms send rate — during a ragdoll tumble the limbs visibly led the fall."
Lesson: everything derived from a presence sample must be interpolated on the
same cursor as the root.

**Change detection by object identity, not a stringified signature**
`client/lib/remotes.js:96-101`
"every sample carries a freshly decoded pose so `===` is exactly as strong, and
on the blended path the value differs every frame anyway, which made the
JSON.stringify pure per-frame waste."
Lesson: a signature hash of per-frame-fresh data is strictly worse than identity
comparison. Also: `POSE_BLEND = {}` is a sentinel so "mid-blend" is non-null (a
later release still clears) and never `===` a real pose (a held pose always
re-applies).

**A bone named on only one side must hold, not blend toward rest**
`client/lib/remotes.js:125-128`
"senders drop bones they aren't driving, and reading the gap as identity would
fling the limb."
Lesson: sparse pose maps need per-bone fallback to the side that HAS the bone.

**Re-plan the bone blend per bracketing pair (~15Hz), not per frame**
`client/lib/remotes.js:112-114`
"the merged bone list and its output arrays outlive every frame of the span."
Lesson: allocate at sample rate, not frame rate; this path "runs per bone, per
remote, per frame — nothing on that path may allocate" (`remotes.js:88-89`).

**lastEmote never resetting meant nobody could wave twice**
`client/lib/remotes.js:147-153`
"the one-shot has passed — forget it, so the SAME emote can fire again later."
Lesson: one-shot presence fields need an explicit clear on the frame they are
absent.

**`'ragdoll'` is not a clip, and the locomotion clip animated the corpse**
`client/lib/remotes.js:155-162`, `client/lib/avatar.js:393-405`
"setClip walks CLIP_FALLBACK, finds no entry for it, and hands _setAction
undefined — which returns at its first line. So the locomotion clip went on
playing underneath every remote tumble, animating the shoulders, hands and head
of a body that was supposed to be limp. The streamed pose owns the bones while
down." On the owner's side: "_applyOverride only slerps the twelve DRIVEN bones
back — so the shoulders, upperChest, head, hands, feet, toes and every finger
stayed animated on a corpse. Which bones those were differs per rig (the fleet
splits into 19-bone and 54-bone rigs), and that was most of why one fall looked
fine on one avatar and broken on the next."
Lesson: a sentinel clip name that has no action is a silent no-op. Park every
bone the sim does not drive, every frame, right after the mixer writes it —
`DRIVEN_BONES` is exported from `ragdoll.js` precisely "so the two cannot drift
apart".

**`mixer.stopAllAction()` looks obvious and breaks three things at once**
`client/lib/avatar.js:415-427`
"the actions are play()ed exactly once when they are loaded and cross-faded by
WEIGHT ever after — _setAction never calls play(). Stopping them therefore:
deactivates every action permanently, so nothing animates again after you get up;
leaves head.rotation with nothing to reset it, and the head pitch composes with
`+=` on the assumption that the mixer rewrote the bone first, so the head
integrates one pitch per frame into a flywheel; calls restoreOriginalState() on
every binding, snapping the whole skeleton to its bind pose — a visible T-pose
flash, and the Ragdoll constructor then measures THAT instead of the pose you
fell in."
Lesson: leave the mixer running and overwrite its output. Parking rather than
freezing is also deliberate: "a body going limp SHOULD unclench its hands and
drop its shoulders", and it makes the chest→upperArm span rigid, "which is what
the sim's distance constraint always assumed it was."

**three.js only writes a bone when the computed value CHANGES**
`client/lib/avatar.js:432-439`, `:455-473`
"a track that holds still — a single-key finger curl, a shoulder that does not
move in idle — would never overwrite the parked rest rotation, and the body would
stand up with its hands left open." And, measured: "Measured on a constant track:
head pitch integrates one pitch per frame into 54 radians in three seconds, and
clearPose becomes a ONE-WAY DOOR — the bone never returns to the clip, so a body
that went limp could stand up still holding the pose it landed in."
Lesson: never assume the mixer rewrites a bone each frame. Remember the clip's
value and what you wrote; if the bone still holds what you left, restore the base
before composing again. "Exact float compare is the right test — both sides are
plain copies of the same numbers — and a false match is harmless."

**The 2% ramp residue: a body stood up fractionally wrong, forever**
`client/lib/avatar.js:535-545`
"The ramp is cut at 2%, and on a track that holds still nothing would ever clear
that last 2% of the pose — the body would stand up fractionally wrong, forever."
Lesson: hand the bones back explicitly on the way OUT of an override, not just
by letting a weight decay.

**Bone edits must land BETWEEN the mixer and vrm.update**
`client/lib/avatar.js:632-648`
"three-vrm's flow each frame is: the mixer writes the NORMALIZED humanoid bones
from the active clip, then vrm.update() copies normalized → the raw skinned rig
and runs springs. Anything written to a normalized bone AFTER vrm.update() is
copied nowhere until next frame, where the mixer overwrites it first — so it is
invisible. (Head pitch lived here too and was silently doing nothing; it only
ever passed a numeric check.)" Also: quaternion premultiply rather than
`rotation.x +=`, because the latter "leans on the decompose order of whatever the
clip left in the bone."
Lesson: the write window is a contract of the rig library. State it, and prefer
quaternion composition over Euler accumulation.

**The T-pose: `play()` is what puts an action in the mixer's evaluation set**
`client/lib/avatar.js:305-309`
"The locomotion actions get it in the constructor; these never did, so emoting
faded the walk out and faded in an action the mixer was not looking at — leaving
the skeleton at its REST pose. That is the T-pose."
Lesson: `clipAction()` + weight is not enough; an action must be played once to
be evaluated.

**A LoopOnce emote holds its final frame at full weight, forever**
`client/lib/avatar.js:316-326`
"It is a LoopOnce action with clampWhenFinished, so when it ends it holds its
final frame at full weight — forever. Simply forgetting about it (this.current =
null) left that frozen pose blended into everything that came after, which is why
sitting and standing were wrong once you had pointed at something."
Lesson: cancelling an emote must fade the action out, not just drop the
reference.

**Moving cancels an emote**
`client/lib/avatar.js:245-249`
"Standing frozen mid-cheer while walking away is worse than cutting the cheer
short."
Lesson: locomotion outranks expression.

**Ragdoll limits must be measured against the NEUTRAL rest, not the live pose**
`client/lib/avatar.js:488-495`
"Measuring against the LIVE skeleton meant a body that went limp mid-stride took
the stride's angles as its definition of rest, so the same avatar got different
knees depending on which frame of the walk cycle it happened to fall on."
Lesson: capture a neutral-rest snapshot (every humanoid rotation identity)
without disturbing the on-screen pose, and measure anatomy against that.

**VRM ships a lookAt rig and nothing was aiming it — every body had dead eyes**
`client/lib/avatar.js:203-205`, `client/lib/remotes.js:268-271`
"This is the cheapest presence win in the client."
Lesson: gaze costs one Object3D per avatar and changes how present a body reads.

**Speech cap is 4000 chars; a bubble that shows all of it is a wall**
`client/lib/avatar.js:75-78`
"The bubble shows an opening, the chat log holds the whole thing — and now says
so, instead of trailing off into an unexplained ellipsis." `BUBBLE_LINES = 8`,
"▾ more in chat".
Lesson: truncation must announce itself and name where the rest is.

**The bubble box conforms to the text (R, in-world 13:27)**
`client/lib/avatar.js:86-90`
"box hugs the widest wrapped line; the old fixed 700 stays as the ceiling."
Lesson: measure the text you actually drew.

**Attention glyphs come from the shared Lucide registry, never from emoji**
`client/lib/avatar.js:120-127`, `client/lib/icons.js:1-22`
"canvas fillText paints nothing when a glyph is missing, silently." The icons
module states the incident: "It happened live on a Windows 11 desktop with two
different codepoints, BOTH of which rasterized correctly in headless Chromium, so
the fault was invisible to the tests as well as to me. Any emoji that carries
meaning in this UI is a silent-failure risk." Also: "Do NOT hand-draw
replacements — that was tried first and read as blobs at 26px."
Lesson: no emoji may carry meaning in a canvas-rendered UI. Ship the path data.

**`setTyping(null)` must clear, not schedule 4s of an empty pill**
`client/lib/avatar.js:586-594`
"state === null means STOP (mic went cold, composing ended) — it must clear the
pill, not schedule 4s of an empty one. Found live: R's megaphone rendered as a
blank bubble (2026-08-04 23:35)."
Lesson: a presence signal with a payload needs an explicit off value distinct
from "expired".

**🎙 means sound is coming out of me, not "my mic is plugged in"**
`client/main.js:659-666`, `client/lib/avatar.js:596-600`, `:726-733`
"(R, 23:38: 'it's not just if the mic is capturing my voice activity, it's if the
mic is simply ON'). An always-on badge is furniture — it stops carrying
information the second everyone wears one. So it tracks actual speech, with a
short tail so ordinary pauses between words don't strobe it." `VOICE_GATE =
0.045`, 900ms tail, re-announced at most every 1500ms. And in the avatar:
"Speaking ends COMPOSING — but not a live mic… A composing pill hides behind a
bubble (you've stopped composing, you said it). A LIVE MIC does not: the voice
keeps coming while its transcript floats. Stack it above the bubble instead of
suppressing it."
Lesson: a status indicator that is always on carries no information. Gate it on
the event, not the capability.

**A real amplitude beats the fake viseme envelope whenever one exists**
`client/lib/avatar.js:681-700`
"no audio to drive visemes from, but a frozen mouth during a paragraph of speech
is worse than an approximate one. Syllable-rate envelope for the duration of the
utterance. A REAL amplitude wins over the fake envelope whenever we have one
(live mic, R 23:30)… Smoothed asymmetrically — jaws open fast and close slower,
which is what reads as speech rather than chatter."
Lesson: asymmetric smoothing (0.55 open / 0.18 close) is what separates speech
from chatter.

**Nameplates: depthTest is off, so distance is what stops a wall of text**
`client/lib/avatar.js:707-716`
"labels must not be eaten by your own shoulder, so distance is what keeps 24 of
them from becoming a wall of text." Fade from 18m over 14m, gentle size hold at
range.
Lesson: if you disable depth for legibility, you must add distance falloff for
density.

**Camera-aware animation LOD: 24 bodies is more than a midrange laptop can do**
`client/lib/remotes.js:168-176`
"with a full stage (24 bodies) a midrange laptop cannot run 24 complete VRM
updates (spring bones, expressions, look-at) every frame. Position interpolation
stays per-frame (cheap, keeps motion glued); skeletal updates tick at 1×/2×/4× by
distance, integrating accumulated dt so motion SPEED is unchanged — a far avatar
animates at lower temporal resolution, not in slow motion."
Lesson: LOD by accumulating dt, never by dropping it. `LOD_NEAR = 8`, `LOD_MID =
20`, governor raises `lodBias` to 2 under load.

**A locally-simulated body must not apply its own echo**
`client/lib/remotes.js:178-182`
"Bodies whose sim runs on THIS machine right now (bodydrag takeover). Their
inbound presence is our own stream echoed back through the owner — applying it
would make the body fight its own past by one round trip."
Lesson: whoever simulates must suppress application of the echo, and only of the
echo (springs/expressions still tick).

**A mounted body is DERIVED, not streamed**
`client/lib/remotes.js:192-217`, `client/lib/world.js:523-538`
"its transform comes from the parent entity's live transform (already ticked by
motion.js this frame) composed with the socket. This is what makes a sitter
visibly ride the swing mid-pendulum — presence samples are ignored while mounted,
so a stale stream can't fight the seat." But: "The seat owns WHERE the body is
and its base clip — never its expressiveness. The newest presence sample still
delivers emotes… and held bone poses (gesturing from the seat)."
Lesson: derivation replaces position, not expression.

**A late joiner with one sample must still apply its held bones**
`client/lib/remotes.js:244-251`
"otherwise a body that fell before you arrived shows as a STANDING figure sunk
into the ground (the root lowers, the pose never folds). This ran only in the
interpolation branch before."
Lesson: every code path that consumes a sample needs the single-sample case, not
just the bracketed one.

**YOUR body outranks everything; fable's remote queued 19s behind crates**
`client/lib/avatar.js:787-792`
"YOUR body outranks everything; ANY body outranks every object — fable's remote
once queued 19s behind crate pipeline compiles (prod trace 08-02)."
Lesson: priority inversion in the loader is felt as a missing person.

**Portrait pipelines are a brand-new context and compiled inside render()**
`client/lib/avatar.js:840-850`
"This render target + these lights are a brand-new pipeline context (different
lightsNode, different color format and sample count than the canvas), so the
synchronous render below used to codegen+compile every MToon material variant
INSIDE render() — a seconds-long main-thread stall on heavy bodies, timed exactly
when an avatar had just finished loading. compileAsync captures its render
context synchronously before its first internal yield, so the target can be
restored immediately and the main loop keeps rendering the world while the
variants build."
Lesson: any offscreen render with different lights/format is a new pipeline
context. Precompile it, at priority 0 — "a portrait never outranks a person."

**Deep-cloning a VRM is not safe; borrow the real body for one frame**
`client/lib/avatar.js:866-870`
"the MToon node materials and the spring-bone/lookAt proxies carry references
that don't survive Object3D.clone. So the real body is BORROWED for one frame:
reparented into the portrait scene, rendered, and put straight back." Draw order
is restored too, "so the body isn't shuffled behind its own label".
Lesson: reparent-and-restore beats clone for rigs with proxy objects — and
restore the child INDEX, not just the parent.

**Framing on the head gave every body a different apparent size**
`client/lib/avatar.js:888-894`
"these avatars range from a human silhouette to something that is mostly mane, so
a head-relative crop gave each one a different apparent size — one portrait
filled its card while the rest sat tiny inside theirs. A full-body fit also shows
the outfit, which is what someone choosing a body is actually looking at."
Lesson: frame the whole figure, identically, for a roster.

**True stature comes from the SKELETON, not the bounding box**
`client/lib/avatar.js:898-908`
"hair, capes, and particle shells inflate bounds (one body rendered half-size
inside its own card), and the height is also REPORTED with the portrait so
catalogs can draw the roster to a common scale." `stature = headY - rootY + 0.13`
("crown ≈ head joint + a forehead").
Lesson: derive scale from the rig; publish it with the image.

**Zeroing rotation photographed every VRM0 body from behind**
`client/lib/avatar.js:922-924`
"Keep the loader's VRM0 normalization (rotateVRM0 sets rotation.y=π on the scene
root) — zeroing it photographed every VRM0 body from behind."
Lesson: normalization applied by the loader is part of the body's identity; don't
reset it.

**A VRM at rest is a T-pose, which reads as a mannequin on a shelf**
`client/lib/avatar.js:876-887`
"One frame of the idle clip costs a single already-cached download and makes the
roster look alive." Failure is tolerated: "T-pose is survivable; a missing
portrait is worse."
Lesson: pose before you photograph, and never let posing failure block the
photo.

**`readRenderTargetPixelsAsync` RETURNS the pixels; WebGPU rows are top-down**
`client/lib/avatar.js:944-951`
"its 6th parameter is a texture index, not an output buffer." And: "WebGPU hands
back rows already in top-down order — flipping here (the WebGL habit) produced
upside-down portraits."
Lesson: WebGL muscle memory is a bug source on WebGPU readback.

**Contribution-as-you-wear cannot SEED a roster**
`client/main.js:85-89`
"a first visitor met one portrait and seventeen blank cards. This is the one-time
(and after-adding-VRMs) pass that gives it a baseline." (`?mintthumbs`.)
Lesson: an organically-filled cache needs a bootstrap pass.

**A rename must not rebuild the avatar**
`client/lib/avatar.js:572-574`
"The nameplate is a baked sprite, so it has to be redrawn — but the VRM, its
clips and its mixer are unaffected, and rebuilding the whole avatar to change a
label would drop you through the floor mid-step."
Lesson: identify the minimum thing a change actually invalidates.

**Build the new body before shedding the old**
`client/main.js:242-260`
"`const next = await makeAvatar(...)` … `me?.dispose()`" — then re-announce via
`sendJoin()` so everyone rebuilds the remote.
Lesson: never dispose the current body before its replacement exists.

**Blob shadows tell you where a body IS**
`client/lib/avatar.js:759-762`
"Real shadow maps land in the lighting pass, but a blob under the feet is what
actually tells you where a body IS relative to the ground and how high a jump
went."
Lesson: contact shadow is a spatial-reasoning affordance, not decoration.

**No shadows at all meant everything floated**
`client/main.js:107-110`
"objects had no contact with the ground and a jump had no readable height. One
cascade off the sun plus the per-avatar blob shadows is the biggest
visual-quality-per-line change here." (2048 map, near 1 / far 160, S = 46,
bias -0.0006, normalBias 0.02.)
Lesson: one directional cascade plus blobs buys most of the readability.

---

## 5. World and fold

**A spawn reserves its id synchronously but its GLB arrives later**
`client/lib/world.js:39-46`
"Anything that addresses the entity in that window (a `place` right behind it in
the log, a `remove` of something still downloading) used to hit `null` and be
silently dropped. Now it is remembered and applied when the body lands — which
also makes it safe to stop waiting for every asset before replaying."
Lesson: `pendingOps` is the price of decoupling replay from bytes. A rebuild that
folds synchronously and realizes asynchronously deletes this machinery instead of
paying it (TEL0S_NOTES.md §3).

**A mount whose parent or child is still downloading waits**
`client/lib/world.js:37-38`, `:497-500`, `:519-521`
"retried whenever a spawn completes — same reasoning as pendingOps."
Lesson: same hazard class, same answer; keep them together.

**Terrain ~2s, grass ~1s of main-thread geometry generation**
`client/lib/world.js:50-53`
"Heavy world construction (terrain ~2s, grass ~1s of main-thread geometry
generation) runs on its own ordered chain so log replay — and everything after it
— doesn't wait behind it. Safe because spawns carry their logged y, and the
terrain step re-seats ground objects when it lands."
Lesson: the safety of deferring ground is that spawns carry absolute y and the
ground re-seats afterward. Both halves are load-bearing.

**Terrain gates arrival; grass does not**
`client/lib/world.js:57-60`
"you cannot stand in a world with no ground. Grass does not: it is decoration, it
costs seconds of main-thread geometry generation, and it can grow around someone
who is already walking." (`GATING = new Set(['terrain'])`.)
Lesson: name the gate set explicitly; the default must be non-gating.

**Terrain/grass builds were the biggest UNNAMED frame gaps: 2.4s "(unattributed)"**
`client/lib/world.js:66-70`
"a work record too — terrain/grass builds were the biggest UNNAMED frame gaps in
the first Safari beacon (2.4s '(unattributed)')."
Lesson: every heavy build must open a work record, or the beacon reports a
mystery.

**Terrain precompile is BOUNDED: on Safari one compile cost seconds (boot 10.7s)**
`client/lib/world.js:246-251`
"compile the ground's pipelines BEFORE it enters the scene — an unprecompiled
terrain material otherwise codegens synchronously inside the first render() that
sees it. BOUNDED: this build GATES arrival, and on Safari one compile can cost
seconds (measured 08-02: boot went 10.7s) — past the cap the ground arrives
anyway and the still-running compile finishes warming it moments later."
(`Promise.race` with 1200ms.)
Lesson: a precompile on the gating path must be raced against a cap. The compile
is still useful after the race is lost.

**compileAsync skips invisible objects, so hiding wouldn't work**
`client/lib/world.js:285-291`
"borrow the mesh back out for a precompile (compileAsync skips invisible objects,
so hiding wouldn't work — detach, compile against the scene's lighting, re-add
warm)."
Lesson: precompiling something you don't want drawn means detaching it, not
hiding it.

**castShadow LATER: one more freeze per object, in the window that hurts**
`client/lib/world.js:89-95`, `:136-141`
"a caster's depth-pass pipeline compiles synchronously at its first shadow
render, and during a load that is one more freeze per object in the window that
hurts. Shadows are the last thing a world needs — they arrive one object per beat
once every queued load has drained." One object per 250ms; hard 30s fallback "so
a world where something never drains still gets its light right".
Lesson: shadow-caster admission is its own drip queue, gated on `lanes-idle`,
with a timeout.

**A `remove` must not vaporize the cargo along with the truck**
`client/lib/world.js:215-224`, `server/server.ts:311-333`
Client: "anything mounted ON it steps off first, keeping its world pose". Server
fold: "remove the truck, the cargo lands where the truck stood" — the child's
absolute pos is computed from the parent's pos+yaw and the stored offset.
Lesson: removal is a plane transition for everything riding the removed thing;
stamp absolute state on both planes, identically.

**Re-issuing `light` on an existing id is a partial UPDATE, on both planes**
`client/lib/world.js:161-174`, `server/server.ts:290-309`
"the server fold merges the same way; a live client mirrors it here instead of
ignoring the entry. A non-light holding the id (or a spawn still downloading)
refuses, same as before."
Lesson: partial-update semantics must be implemented in the fold AND the live
apply, or a joiner and a resident disagree.

**A rescale can cross the room-scale threshold: re-decide, not just re-bucket**
`client/lib/world.js:202-203`, `client/lib/colliders.js:213-222`
"a dollhouse import scaled to a building becomes walkable-inside."
Lesson: any size-derived classification must be re-derived on rescale, not merely
re-indexed.

**The `spawn` scale must be visible to the collider decision**
`client/lib/world.js:143-146`
"decision sees the SPAWN scale: wrong-sized imports that arrive with a corrective
scale still classify by their real-world size."
Lesson: classify on final size, not authored size.

**Part sockets: without the ride, a rider sat still while the plank swung through them**
`client/lib/world.js:523-538`
"When the socket names a `part`, the seat point additionally rides that part's
motion… At rest the displacement is identity, so a part socket sits exactly where
a plain one does — declaring the part only adds the arc. This is the missing half
of motion:<part>: without it a rider sat still while the plank swung through them
(the fox's swing, commons, 2026-08-03)." And: "The socket offset goes through the
parent's full matrixWorld (scale included) rather than quaternion+position:
socket coords are model-frame, and a spawn-scaled model renders its seat scaled
too."
Lesson: a socket on an animated part must compose live-transform ∘ rest⁻¹, and
must go through the full matrix so scale is honoured.

**Socket reach must not oscillate with the swing**
`client/lib/world.js:476-478`, `client/lib/build.js:380-382`
"Ignores the part's motion on purpose: 'how far is the seat' should not oscillate
with the swing." The editing gizmo is parented in the same rest frame for the
same reason.
Lesson: a distance used for an affordance check must be stable; the ride belongs
only to the render path.

**Part lookups retry once a second rather than caching a miss forever**
`client/lib/world.js:449-453`
"models load ASYNC, so the part a comp names may simply not exist yet — freezing
out a legitimate name because the GLB was still downloading would be a load-order
bug, not a contract."
Lesson: negative caches need a TTL when the underlying thing arrives
asynchronously.

**stateToEntries is deliberately NOT a second way of building a world**
`client/lib/world.js:587-596`
"The state goes back through applyEntry as synthetic entries, so there is exactly
one code path that puts things in a scene — if snapshot-joining and log-joining
could drift apart, they eventually would, and the difference would be a world
that looks different depending on when you arrived. Order matters the way it does
in a log: ground before the things standing on it."
Lesson: this principle survives the rebuild; only its LEVEL moves (fold → state →
realize, TEL0S_NOTES.md §3).

**Synthetic pre-history entries carry negative seq and must not advance it**
`client/lib/world.js:602`, `client/lib/net.js:580-581`,
`client/lib/chat.js:101-105`
"negative: pre-history". Chat: "synthetic entries from a folded snapshot carry
negative seq — they are not positions in history and must not become the paging
cursor."
Lesson: the seq sign is the marker separating "a description of the present" from
"a position in history". Every consumer must respect it.

**Chat in a snapshot keeps its REAL seq — the tail would render it twice**
`client/lib/world.js:640-646`, `server/server.ts:178-182`
"Anything the tail will replay must not also be rendered from the snapshot. Chat
keeps its REAL seq, unlike the world-shaping entries above: it is the only part of
a snapshot that is a position in history rather than a description of the present,
and the scrollback cursor is derived from it. Without this the first page-back
re-fetches what is already on screen." Server: "state and tail overlap whenever a
world has not folded recently, and without it every such message renders twice."
Lesson: overlap between snapshot and tail is normal; carry seq so the client can
deduplicate.

**Unknown verbs are not errors**
`client/lib/world.js:439-442`, `server/server.ts:492`
"a newer client may author verbs this one doesn't render yet, and the log must
stay forward-compatible." Server: "unknown verbs shape nothing; the log still
keeps them."
Lesson: the LOG tolerates unknown verbs forever; the DOOR refuses them. That
asymmetry is the extension model (AGENTS.md).

**`force` and `punt` fold to nothing so a replay never re-detonates**
`client/lib/world.js:425-438`, `server/server.ts:258-265`
"an instantaneous radial cause (blast, gust): no state to fold, so a replay never
re-detonates — the log keeps the historical fact, and only bodies present at the
moment feel it."
Lesson: causes fold to nothing; effects are their own entries. Replay-inertness is
what makes a physical event safe to log.

**Motion params are FUNCTIONS OF TIME, never frames**
`client/lib/motion.js:1-7`, `server/server.ts:411-426`
"the log stores 'a pendulum with this amp/period/phase since t0' and every client
— live, joining late, replaying a fork — evaluates the same closed form at its own
`now`. Nothing integrates, nothing accumulates error, everyone agrees with zero
ongoing traffic."
Lesson: one entry buys minutes of movement. Never per-tick `place` spam.

**Fable's first pendulum stood perfectly still THREE separate ways**
`client/lib/motion.js:45-54`
"Text-tier authors improvise dialect: `amplitude` for amp, `axis: "x"` for
[1,0,0], no t0 at all. The fold is blind by doctrine, so nothing upstream corrects
them — and a strict evaluator turns every synonym into a world that silently
refuses to move. (Fable's first line of world-script — a pendulum on the commons
swing — stood perfectly still THREE separate ways: `amplitude` read as amp 0, axis
"x" spread into NaN, missing t0 frozen at phase 0. No error anywhere, because
every layer was being strict and nothing was wrong enough to say so.) The closed
form stays exact; the PARSING is where generosity lives."
Lesson: generous reader, exact math. A blind fold plus a strict evaluator equals
silent failure.

**An epoch-less motion starts when it was SPOKEN**
`server/server.ts:419-422`, `client/lib/motion.js:68-73`,
`client/lib/world.js:372-373`
"stamp the entry's own ts, which is a pure function of the log, so every fold
agrees. (Fable's first pendulum had no t0 and stood frozen at phase zero.)" The
client fallback for old logs anchors to first evaluation: "clients disagree on
phase, but the thing MOVES, which beats frozen honesty."
Lesson: stamp the epoch at fold from the entry, and keep a moving fallback for
history written before the stamp existed.

**Missing `damp` = 0 = swings FOREVER**
`client/lib/motion.js:75-84`, `server/server.ts:650-656`
"Friction is opt-in: a declared pendulum is ambient decoration, and a default 0.06
meant every undamped swing quietly died within a minute or two of being cast —
working exactly long enough for its author to walk away happy." Mirrored in the
server: "missing damp = 0 = perpetual."
Lesson: a default that only manifests after the author leaves is the worst kind.

**⚠ MIRRORED math: `pendulumImpulse` (server) and `pendulumTheta` (client)**
`server/server.ts:642-649`, `client/lib/motion.js:75-77`
"keep the math in sync, or joiners see a swing that disagrees with the one being
pushed."
Lesson: this is house rule 2. `shared/README.md` states the retirement path:
"moving a mirrored pair into this directory is how the rule is retired."

**tickMotion uses the SEQUENCER's clock, not the wall's**
`client/lib/motion.js:196-203`
"t0s are server stamps, and an NTP-skewed client rendering motion at wrong phase
disagrees with every other window into the same world (Hesperus finding #4).
serverNow() is smoothed from frame stamps and falls back to local time before the
first frame arrives."
Lesson: anything phase-locked to a log timestamp must read the smoothed server
clock, never `Date.now()`.

**Colliders re-index at a walk, not at frame rate**
`client/lib/motion.js:126-129`
"a moving thing's collider trails it by up to half a second, which is invisible
next to the cost of re-indexing every mover every frame." (500ms.)
Lesson: index freshness is a budget, not a correctness property, for slow movers.

**Parts settle themselves — world.js has never heard of parts**
`client/lib/motion.js:186-191`, `:267-277`
"When a part's motion component vanishes (removed, or {type:null}), the part
returns to its authored rest pose — world.js does this for whole entities, but it
has never heard of parts, so parts settle themselves here."
Lesson: every animated granularity needs its own rest-restoration owner.

**A flora field's mesh is a GROUP — disposing it frees NOTHING**
`client/lib/terrain.js:30-41`
"⚠️ A field's mesh is a GROUP (one child InstancedMesh per stroke, plus shrub-wood
stem meshes), and its textures are the species' map sets. Only the field itself
knows all of that, so retirement prefers the field's own dispose() — walking
`mesh.geometry`/`mesh.material` on a Group frees NOTHING and silently leaked a
whole meadow's VRAM per re-grow." Replacing must also undo the per-frame hooks:
"otherwise a new field stacks on the old, and the old field's hooks keep ticking
against disposed GPU resources."
Lesson: prefer the owner's `dispose()`; a naive geometry/material walk over a
Group is a silent leak.

**One clearing mask per FIELD, not per module**
`client/lib/flora.js:74-81`
"ONE mask per FIELD, wired into EVERY stroke's material and disposed with the
field: a module-global mask left earlier strokes pointing at an orphaned canvas
(only the last stroke stayed repaintable) and leaked a bus listener per stroke per
re-grow. The mask samples the PLANT's world XZ — the field's positionNode output —
because positionLocal is per-plant space under instancing."
Lesson: module-global mutable resources break as soon as a second instance
exists; and under instancing, local space is not object space.

**A half-built field must not leak its listener or its finished strokes**
`client/lib/flora.js:221-226`
Catch disposes every completed stroke and the mask, then rethrows.
Lesson: partial construction needs an unwind path.

**The `grass` verb is a world singleton — reset occupancy per build**
`client/lib/flora.js:204-206`
"each build starts a fresh occupancy registry, or a replaced field's plants would
still claim their ground."
Lesson: upstream registries keyed globally must be reset when the singleton they
serve is replaced.

**The density dial can silently no-op (#74)**
`client/lib/flora_field.js:8-15`, `client/lib/terrain.js:80-101`,
`client/lib/build.js:1116-1139`
"wireDensityDial returns early when a stroke's expected instanced attributes are
absent (vegetation.js version skew), leaving the stroke without setDensity, and
the composed dial optional-chains every child. Policy arithmetic then reports a
density the renderer never applied. These reports read the LIVE draw state — the
instanced mesh's actual count — never the arithmetic." The UI surfaces
`⚠<status>` and names the affected stroke.
Lesson: report APPLIED state from the renderer, never the policy arithmetic that
requested it. A resident-facing dial must be able to say "this did not take".

**Two dials own the meadow, and they compose as a MINIMUM**
`client/lib/grass_quality.js:1-17`, `client/lib/terrain.js:48-51`
"the CAP is the resident's chosen ceiling… the SHED is the frame governor's dial —
session-only… What the field actually draws is min(cap, shed): the governor may
thin below the resident's ceiling, but can never silently raise above it, and the
resident raising their cap never un-sheds a machine that measured a slow frame."
Sticky across re-grows.
Lesson: composing budgets from different owners is `min`, and neither owner may
overwrite the other.

**`off` must be genuinely zero, and a thinned field must never read as mowed**
`client/lib/grass_quality.js:54-61`, `client/lib/terrain.js:59-67`
"an InstancedMesh with count 0 draws nothing — while any positive factor keeps at
least one plant so a thinned field never reads as mowed." Hiding the group also
"spares raycasts/shadows"; the field object stays whole so a cap raise restores it
in place.
Lesson: degrade the draw, never the state.

**Emitter presets, bounds, and the one number allowed to differ**
`shared/particles.js:36-54`, `:65-68`
`PARTICLE_MAX_COUNT = 600`: "an authored `count: 5e6` must fail at the door of
meaning, not silently melt the one client with a good GPU." Tiers scale count and
nothing else, and compose as a minimum: "an authored `low` stays low on the
strongest GPU in the world, and a governor that has dropped to `low` is not
overruled by an authored `high`." Anything outside the known-key table "is
reported by name rather than quietly dropped — a parameter the evaluator ignores
is exactly the class of bug the motion lint exists to surface."
Lesson: bound shared parameters in the DECLARATION. Preset, state, seed and
provenance are shared facts; only the sprite count may differ per machine.

**`origin` is entity-relative and bounded to ±8m**
`shared/particles.js:141-154`
"A 200m offset is not a local origin, it is a second entity nobody can see, move
or remove."
Lesson: a relative coordinate with no bound is an absolute coordinate in
disguise.

**Determinism is a scoped `Math.random` swap, at exactly one call site**
`shared/particles.js:96-111`, `client/lib/emitters.js:14-28`, `:99-101`
"`makeParticles` seeds its per-instance spawn attributes from `Math.random()`. Two
clients would therefore render two different fires from one authored component, and
a reconnect would render a third. The build call is synchronous, so the seam is a
scoped swap of Math.random around exactly that call — and nothing else." Kept "to
a single call site so that when the engine grows a first-class `seed` option the
shim is a one-line deletion. It is safe only because the builder is synchronous."
Lesson: monkey-patching a global is acceptable only when scoped around
synchronous code, at one site, with the deletion path written down.

**Sprite textures are borrowed, never owned by the emitter**
`client/lib/emitters.js:37-42`
"Disposing a borrowed texture is how you blank every other fire in the world by
putting one out."
Lesson: state texture ownership explicitly; caches own, emitters borrow.

**A missing sprite is not a missing emitter**
`client/lib/emitters.js:53-58`
"the builder's procedural dot always works, and a hearth that reads as fire in
text but shows a soft glow beats a hearth that shows nothing."
Lesson: degrade the look, keep the semantics.

**The window between `makeParticles` returning and a handle existing**
`client/lib/emitter_field.js:37-50`, `client/lib/emitters.js:115-121`
"This is the window the adapter promised to close and initially did not: the
moment the builder returns, its mesh is in the scene and its update is in the
global hook array. If any host step after that point throws (parenting, marking,
tier), `build()` rejects before a handle exists and the registry's catch has
nothing to retire."
Lesson: wrap every post-allocation host step in an adopt/unwind so a raw upstream
allocation can never be stranded.

**Hooks come off by IDENTITY, never by index**
`client/lib/emitter_field.js:19-26`
"the array is global and shared with grass wind and the sky, so an index captured
at build time means unhooking somebody else's emitter."
Lesson: never index into a shared registry you do not own.

**Retire the old emitter FIRST, and re-authoring the identical bag is a no-op**
`client/lib/emitter_field.js:97-134`
"Replacement is not two emitters overlapping for the duration of an await: the
world says one thing is burning there." And: "re-authoring the identical bag (a
replay of the same entry, a snapshot that repeats what the log already said) must
not rebuild the fire — a rebuilt emitter re-rolls nothing (the seed is stable) but
it does churn GPU resources and re-registers a hook." A build that finishes after
its slot was superseded retires itself.
Lesson: generation-counted slots plus key equality; delete the slot before
retiring so an in-flight build sees it is gone.

**A `comp` usually arrives before the entity's GLB**
`client/lib/emitters.js:165-187`
"The bag is already folded — perception is correct the whole time — so the emitter
just waits for something to hang off." A `null` parent is "a spawn reservation
whose GLB is still downloading… and a world-origin emitter is the drift #25 names
in requirement 2 — so we don't build one."
Lesson: never fall back to world origin when the intended parent is merely late.

**The emitter mesh carries `entityId` so the sky's diff cannot claim it**
`client/lib/emitters.js:126-131`
"an async sky build that happens to snapshot scene.children mid-flight must never
claim (and then dispose) somebody's hearth. Same marker entities and bodies
carry."
Lesson: ownership markers are a cross-subsystem contract; every owner must set
them.

**Colliders: walking every entity every frame is free at 20 and the budget at 500**
`client/lib/colliders.js:49-53`
"resolveColliders used to walk EVERY entity every frame, allocating as it went.
Free at 20 objects; the frame budget at 500. Objects are bucketed by world-space
cell and only the 3×3 neighbourhood around the query is tested." `CELL = 8`.
Lesson: a spatial hash is the answer, and an OBB straddling cells must register in
every cell its footprint touches. (Two other hot paths still do the naive walk —
see the landmine list.)

**Every box was an infinite column reaching down to the world floor**
`client/lib/colliders.js:326-334`, `client/lib/debug.js:1-14`
"Nothing here ever read box.min.y, so every box was an infinite column reaching
down to the world floor: a mezzanine slab modelled at y 2.4-2.7 shoved a walking
avatar 2.3m sideways at ground level, and a tabletop ejected anything that tried
to lie beneath it. The `pillar` heuristic was the only way anything was ever
passable underneath, which is why trees worked and archways did not." The debug
module exists because of it: "Finding that took a headless harness and a lot of
printf. One wireframe would have shown it in a glance."
Lesson: a collider view must draw the COLLIDERS, not the meshes — "a debug view
that redraws the visible geometry would have shown nothing wrong on the day it
mattered most."

**Grazing an overhang by 1.3cm flung a head 1.6m sideways**
`client/lib/colliders.js:354-365`
"exiting through the nearest vertical face regardless is how a head brushing a
mezzanine by 1.3cm got flung 1.6m sideways, clear of a 3m slab's whole footprint —
on a room-sized one it is tens of metres. Two things must hold before we decline
the push. There must BE a down… And the overlap must be a GRAZE rather than 'I do
not fit' — a waist-high counter overlaps a standing body by most of a metre… Note
that 'the shortest way out is down' is NOT the test: for any large slab the
sideways exit is metres away, so down always wins and everything becomes
passable."
Lesson: passability needs both a clearance test and a graze test; nearest-exit is
not a proxy for either.

**The "hollow" probe excluded every real building**
`client/lib/colliders.js:162-174`
"that probe cannot tell a trunk from anything else standing in the middle of an
open structure, so it failed every bell tower, pavilion, gazebo and colonnade we
have: bell2 is a 214m² pavilion with its bell hanging 0.20m from the centre, and it
read as solid rock. A rule that excludes real buildings to exclude trees is the
wrong rule."
Lesson: size decides walkability (footprint ≥ 16 m² AND height ≥ 2.2 m); trees are
handled where they actually cause harm (the grass mask).

**The uneven-top lie: a body stood 27cm up in the air on a blanket (#11)**
`client/lib/colliders.js:114-132`, `:176-201`
"For a blanket with cushions on it the bbox top sits at the tallest cushion, and
the whole footprint reads as ground at that height: a body walking the bare cloth
stands 27cm up in the air. Issue #11's three observables — the shove at the rim,
the phantom mantle offer, the invisible full-footprint ceiling — are all this one
lie." The probe buckets vertices into a 24×24 grid and calls the LIE the gap
between bbox top and the median cell top: "Surveyed against a raycast ground truth
across the 58-model library plus 8 conjured store meshes
(tools/collider-survey.ts): inside the floor-shaped population the gate below
admits, the vertex version tracks raycast to 1.8cm worst case and never disagrees
about the threshold. (Library-wide it drifts up to 2.5m on tall structured things —
a watchtower, a perimeter wall — which is exactly why the shape gate runs before
the probe is consulted.)" Gates: footprint ≥ 2m², lie > 0.10m, height ≤ 1.0m —
"The numbers come from the survey, not taste… every gate from 0.6 to 1.0
reclassifies exactly ONE object across 66 surveyed (the blanket); 1.2 pulls in nine
more — both rubble piles (which float you 0.73m and 0.44m, worse than the blanket),
five hovercars, a shark. If those should firm up too, this is the one line to
move."
Lesson: a cheap heuristic is only valid inside the population it was surveyed on;
run the shape gate BEFORE consulting it, and record the survey numbers next to the
constant.

**Clearing is a SEPARATE question from collision**
`client/lib/colliders.js:198-201`, `:86-92`
"a palm is now exact (you walk under the fronds and bump the trunk, which is
right), but stamping its canopy footprint into the grass mask would leave a bald
ring under every tree. Only things with a real floor suppress the meadow."
`hasFloor` samples rays down from mid-height, inset to 20%..80% "because samples
hugging the walls would count the walls themselves, and every hollow box would
read as floored" (threshold 0.35 of 16 samples).
Lesson: one geometric fact rarely answers two different questions; derive each
separately.

**The vertical numbers cannot be constants: a 55cm step-up teleported a hand**
`client/lib/colliders.js:262-285`, `client/lib/ragdoll.js:901-906`
"a 55cm step-up allowance applied to a hand teleports it onto the nearest crate,
and a hip-height wall probe applied to a wrist lying on the floor measures the wall
a metre above the wrist." So `step`, `probeY`, `spanY` all scale with `tall`. And
the radius: "colliders.resolveColliders treats its radius as a HORIZONTAL one (it
is a vertical cylinder, not a sphere), so nothing was ever holding a joint up off
the floor by its own thickness — a single 6cm constant did that job for a 0.63m
avatar and a 1.53m one alike."
Lesson: a routine shared between a standing figure and a 3cm bead cannot carry
constants tuned for either.

**Never box-test an exact entity — that would seal interiors**
`client/lib/colliders.js:314`
Lesson: exact and box are exclusive; running both closes the room.

**Layer-0 affordances: the geometry IS the affordance**
`client/lib/colliders.js:10-12`, `:379-401`
"a surface that is walkable is, by the same data, sittable and placeable-on.
Nobody authors that." `findSeat` skips pillars and exact interiors — "interiors
aren't chairs; furniture inside them is."
Lesson: derive affordances from collision data rather than authoring metadata.

---

## 6. Networking and the sequencer

**A stray `)` took prod down 16 restarts in a row**
`server/server.ts:1906-1911`, commit `4f82250` (2026-08-01)
"No message may ever kill the process. An uncaught throw in Bun's ws callback
EXITS THE SERVER, and a client in a reconnect loop turns one bad request into a
crash loop for everyone (measured 2026-08-02: a world name carrying a stray ')'
from a chat-linkified URL took prod down 16 restarts in a row). Refusals are
messages, failures are logs — neither is an exit." From the commit body: "the fork
confirmation printed its link inside parens, the chat linkifier swallowed the ')',
and clicking it opened ?world=<name>) — getWorld THROWS on bad names… The landmine
predates the fork feature (any ?world=%29 join always did this); the parenthesized
link armed it."
Lesson: house rule 3. The fix has three parts and all three are load-bearing:
try/catch the whole message switch; validate the world name at join and refuse with
a no-retry close code; strip trailing punctuation in the linkifier.

**A name that can never exist must not retry**
`server/server.ts:1938-1946`, `client/lib/net.js:299-306`
"A malformed world name is a bad LINK, not a bad actor — refuse it with an
explanation and a close code the client knows not to retry (retrying a name that
can never exist is just a polite DoS)." Client on 4005: "the name can never exist,
so reconnecting is just hammering the door."
Lesson: close codes are a protocol. 4002 takeover, 4003 bad key, 4004 reserved
name, 4005 bad world name, 4006 moderation — each with its own retry policy.

**4003 used to fall through to the generic retry**
`client/lib/net.js:307-324`
"This used to fall through to the generic retry, so a wrong key hammered the door
forever while the client said 'disconnected — retrying…' and never explained why."
And: if the client entered verified, a 4003 means the session died server-side, so
"drop it and go back through the login rather than asking for a key this person
never had."
Lesson: every refusal needs a distinguishable code and a user-facing explanation;
an unexplained retry loop hides the cause indefinitely.

**Retrying a session takeover would ping-pong forever**
`client/lib/net.js:281-288`, `server/server.ts:2019-2033`
"4002 = session takeover: this identity re-arrived elsewhere. Retrying would kick
THAT session and ping-pong forever." Server: "ONE body per id per world — a stale
session (half-open socket, zombie reconnect) is kicked when its identity
reconnects, instead of the two rubberbanding over one avatar. No leave broadcast:
the identity isn't leaving, it's re-arriving."
Lesson: identity takeover needs both halves — the server kicks, the client must
not fight back.

**Auto-rejoining after a kick would make the kick meaningless**
`client/lib/net.js:289-298`
"a banned door will not open, and auto-rejoining after a kick would make the kick
meaningless — coming back is a deliberate reload."
Lesson: moderation outcomes must survive the reconnect logic.

**One bounce per minute, or an identity outage becomes a redirect loop**
`client/lib/net.js:231-244`
"if the identity node is down we fall through to the door (which offers the same
link) instead of redirect-looping."
Lesson: any automatic redirect needs a rate cap and a fallback surface.

**Verified identity must resolve BEFORE any UI reads CONFIG.name**
`client/lib/net.js:246-252`, `client/main.js:156-159`
"otherwise the door panel and the local nameplate greet a stale localStorage name
while the server (correctly) calls this person by their Discord name."
Lesson: identity is a boot-order dependency, not a late correction. (It costs an
RTT before the socket — TEL0S_NOTES.md §4 collapses the 3-RTT prologue into the
join hello.)

**The server's `you` is authoritative, and a silently different nameplate is confusing**
`client/lib/net.js:504-511`, `server/server.ts:1948-1963`, `:1969-1978`
"(verified identity, or a suffixed name when two people share a nick). If it
differs from what this client thinks, adopt it — and say so." Server: actor names
are "the log's ink — refuse the ones that forge system or script authorship
('world' authors grants; 'bhv:*' authors script effects; the behavior loop-guard
trusts that prefix), and strip control characters that would corrupt every future
reader. (Hesperus finding #3: an unauthenticated join as 'world' produced entries
indistinguishable from the sequencer's own.)" Two verified people sharing a nick:
suffix the newcomer "rather than letting takeover fight."
Lesson: the actor field is a security boundary. Reserve the system prefixes, strip
control characters, and tell the person what they are actually called.

**Agent names are RESERVED: closing the "fable spoofable" hole**
`server/server.ts:1979-1999`
"an id that appears in mcpl/tokens.json is claimable only with that agent's own
bearer token (the MCPL door forwards it)… The archipelago door forwards the
agent's aid1 credential. An identity the home node vouches for satisfies the
reservation exactly like a tokens.json bearer — same slug derivation as the MCPL
door, so the two doors agree on who 'fable' is."
Lesson: two doors that mint the same identity must derive the slug identically.

**A ban keyed to a display name is evaded by /name**
`server/server.ts:99-107`, `:354-372`, `:2238-2254`, `:389-395`
"Keyed by lowercased display id, carrying the durable principal `sub` when it was
known at ban time (a name is evadable by /name; a sub is not)." Grants likewise —
"Durable ink (Hesperus finding #1): when the grant was written while its subject's
durable sub was KNOWN, the grant carries it — and only that sub can wear it. A
display name is a nameplate, not a deed; before this, anyone reusing an offline
owner's nick inherited the world." And unban: "an unban by display name also lifts
a ban filed under that identity's sub — forgiveness should not depend on knowing
which handle was keyed."
Lesson: authority and exclusion bind to the durable principal, honoured under both
handles; forgiveness must be generous where enforcement is strict.

**Global bans live inside WORLDS_DIR, not ROOT**
`server/server.ts:99-107`
"bans are world data, and a dev sequencer pointed at a scratch WORLDS_DIR must get
a scratch ban list too — same doctrine as the logs themselves."
Lesson: derive every data path from the data root, or a dev instance moderates
production.

**Sessions were memory-only: every deploy logged the whole show out**
`server/server.ts:76-87`
"Sessions used to be memory-only, so every deploy logged the whole show out and
sent verified humans back to the door mid-event. They survive restarts now. The
file holds bearer-equivalent session ids — 0600 and gitignored, same posture as
mcpl/tokens.json." And: "atomic — a crash mid-write never truncates the live
file" (tmp + rename).
Lesson: anything a deploy destroys is a deploy-time outage. Persist it; write it
atomically; treat session ids as bearer secrets.

**Dev instances must not append to live logs**
`server/server.ts:60-64`, `AGENTS.md:362-364`
"they are append-only and forever — a stray dev spawn is permanent." AGENTS.md:
"scratch sequencer — NEVER develop against a port someone lives on."
Lesson: append-only means a dev mistake is unfixable; make the wrong thing hard.

**The snapshot is a DERIVED CACHE, never a source of truth**
`server/server.ts:144-154`
"joining should scale with how much is in the world now, not with how long the
world has existed. So this is a DERIVED CACHE, never a source of truth. Delete
every snapshot file and the worlds are identical after the next boot, just slower
to load. Nothing here is allowed to be information the log does not contain."
Lesson: the deletion test is the definition. If deleting the cache changes the
world, it was not a cache.

**Boot = snapshot + the bytes after it**
`server/server.ts:926-946`
"The offset is what keeps startup proportional to the TAIL rather than to the whole
history: without it we would still parse every line ever written just to find where
to resume." A corrupt snapshot "is not a corrupt world — rebuild below". And: "If
the offset is not credible (log truncated, forked, or snapshot from another
timeline) fall back to reading everything. The log is truth."
Lesson: record the byte offset, and always keep the full-rebuild path one
credibility check away.

**`seq` is global across the world's whole history**
`server/server.ts:1073-1076`
"not an index into what happens to be in memory — folding must not renumber the
past."
Lesson: fold trims memory, never identity.

**`FOLD_EVERY = 150`: small enough that a joiner's tail stays trivial**
`server/server.ts:209-212`
"large enough that a busy world is not writing a snapshot per action."
Lesson: the fold cadence is a two-sided budget.

**Fold on the way out**
`server/server.ts:2872-2891`
"so a restart resumes from the snapshot rather than re-reading a tail that was
already folded in memory." And the pose half: "ws close handlers never run on exit
— everyone connected right now sleeps where they stand, same as a normal leave.
Without this, a client that also vanished during the restart window woke at its
PREVIOUS remembered spot instead of where it stood."
Lesson: process exit is not a connection close; replicate the close-path side
effects in the signal handler.

**A reset ARCHIVES, it never destroys**
`server/server.ts:995-1004`, `:2704-2739`
"The log is append-only and forever… Everything the world was (log, snapshot,
remembered poses) moves into worlds/<name>/erased-<ts>/, recoverable by hand."
Frames recordings stay: "they are performances, not world state." Confirmation
must name the world; and "a reset world must not become a land-rush — the same
owners hold the fresh one."
Lesson: destructive operations archive, require the name typed back, and preserve
authority across the reset.

**A fork is one synchronous block on a single-threaded loop**
`server/server.ts:1168-1187`
"no append can interleave, so log and snapshot cannot drift." And: "load it now: a
fork that cannot boot should fail loudly here."
Lesson: exploit the single-threaded event loop deliberately, and say that you are.

**A loud bot reduced the chat window to 40 messages spanning ZERO seconds**
`server/server.ts:225-249`
"A plain 'keep the last N' is a lie about what a room sounded like: measured, a bot
emitting 300 telemetry lines reduced the window to 40 messages spanning ZERO
seconds, all its own, and the two people actually holding a conversation vanished
from it completely. An arrival would have seen a machine talking to itself. So the
loudest voice loses its oldest line first, and nobody's LAST line is ever dropped
while someone else still has several. Recency still wins within a speaker; fairness
decides between them."
Lesson: a recency window over a multi-speaker room needs per-speaker fairness.

**`collide` folded nowhere: the same object was walkable or solid depending on when you arrived**
`server/server.ts:269-278`, `client/lib/world.js:618-626`
"`collide` ('exact' | 'box') is the spawner's override of the size-derived
collider choice, and the fold used to drop it: the clients present at the spawn
honoured it, and everyone who joined afterwards folded a snapshot that had never
heard of it. The same object was walkable or solid depending on when you arrived —
which is precisely the drift house rule 1 forbids. The LOG always kept it, so no
world lost anything; it just never reached the snapshot."
Lesson: every field the live apply reads must survive the fold. The log keeping it
is not enough.

**`use` and `kick` deliberately have no fold case**
`server/server.ts:398-400`, `:489-491`
"like `use`, it is an ACT, not a state — it folds nothing, but the log keeps it
(who removed whom is history). The removal itself is the verb handler's side
effect."
Lesson: separate the historical fact from the side effect, and keep folds pure — "a
replay must never kick anyone" (`:375-379`).

**Bans fold the fact; expelling is the handler's side effect**
`server/server.ts:375-379`, `:2348-2363`
"A ban or kick lands NOW on every matching body, not at some future join — the fold
recorded the fact; this is the fact taking effect."
Lesson: purity in the fold, immediacy in the handler.

**`expel` needs all four bookkeeping steps or a ghost is left behind**
`server/server.ts:1093-1098`
"world roster, global client map, the socket, and the leave broadcast (close(ws)
will not fire it — the client is already unmapped)."
Lesson: an out-of-band disconnect must replicate everything the normal close path
does.

**The power ladder must not eat itself**
`server/server.ts:2223-2255`
"no self-moderation, no wildcard, and the power ladder does not eat itself —
operators are untouchable, and one owner cannot ban another (a WORLD_ADMIN can;
that is what it is for)." Also "everyone cannot own a world" (`:2146-2149`).
Lesson: enumerate the reflexive and peer cases explicitly.

**WORLD_ADMIN is also the lockout recovery**
`server/server.ts:693-695`, `:2002-2016`
"the bootstrap for pre-permissions worlds and the lockout recovery." A banned
admin still passes: "an operator can never be locked out, which is also the unban
path of last resort."
Lesson: every enforcement mechanism needs a documented recovery principal.

**An owner-less world is OPEN, and the first embodied joiner owns a NEW one**
`server/server.ts:678-691`, `:2035-2048`
"A world with no owner is OPEN: everyone is builder+gen (pre-permissions
behaviour; scratch worlds stay frictionless)." But: "(Pre-existing ownerless worlds
stay OPEN — granting their first owner is a deliberate act by a WORLD_ADMIN, not a
land-rush.)" And the genesis tolerance: "a world whose only history is its birth
certificate still belongs to whoever steps in first."
Lesson: distinguish "new" from "ownerless" or you retroactively hand away every
legacy world.

**In an OWNED world, unlisted ids are builder WITHOUT gen**
`server/server.ts:709-719`
"Editing stays frictionless for drop-in company; introducing new assets (spend) is
what's restricted by default."
Lesson: separate edit rights from spend rights; default the cheap one open.

**self-mount drops to rank 0**
`server/server.ts:726-729`, `:2112-2118`
"sitting on a swing is using the world, not editing it. Moving OTHER things (cargo
onto a truck) stays building."
Lesson: the same verb can be two rights depending on whether the subject is
yourself.

**`punt`, not `kick`, on the wire — one word meaning two acts is a landmine**
`server/server.ts:740-746`, `client/main.js:765-773`, `client/lib/chat.js:549-554`
"(It is `punt`, not `kick`, on the wire — `kick` is moderation's remove-a-person,
and one log word meaning two acts by referent type is a landmine.)" The client
keeps `/kick` working by sorting on what the name denotes, with `/punt` and `/ban`
as the unambiguous forms.
Lesson: never let one wire verb mean two acts. Ambiguity is allowed in the chat
command layer only, with unambiguous aliases beside it.

**`punt` is reach-gated server-side because agents have no client gate**
`server/server.ts:2171-2193`
"an arm's-length act like /push, checked here because agents reach this verb with
no client-side gate. The object's LIVE position counts (a leased ball is where its
sim says, not where the log left it)." Power clamped to [0.5, 10], reach 4m.
Lesson: any gate that exists only in the browser does not exist.

**`force` is bounded HARD so a replayed entry is as harmless as a live one**
`server/server.ts:2156-2170`
"the receiver caps what it applies to itself, but the log should never carry a
number that reads as a weapon, and a replayed entry must be as harmless as a live
one is consensual." radius ≤ 30, power ≤ 12.
Lesson: bound at the door as well as at the receiver; history outlives consent.

**Component data is opaque but BOUNDED**
`server/server.ts:2194-2212`
"components are parameters, not payloads; anything bigger belongs in /upload + a
path here." 8KB.
Lesson: a blind fold still needs a size gate.

**The lock is an accident guard, not a rights system**
`server/server.ts:761-780`, `client/lib/build.js:300-310`
"anyone builder+ can toggle it, and the deliberate unlock (`data: null`) is exactly
what converts an accident into an intent. Everything that doesn't relocate the thing
stays open: sitting ON it (self-mount), use, motion, behaviors, other comps —
content, not carpentry. Applies to everyone including the locker: your own stray
drag is the original accident (a build-mode fallthrough once relocated Fable's
swing)." The lock gate sits AFTER the rank check "(a visitor's refusal should teach
rank, not locks)" and before shape checks.
Lesson: an accident guard must bind the person who set it, and refusal-message
ordering is part of the design.

**A locked thing refuses locally before any preview exists to snap back**
`client/lib/build.js:637-645`, `:312-320`
The drag refuses at arm time; if a commit is refused, the preview is restored from
the log.
Lesson: never show a preview you know the server will refuse.

**Whispers must NEVER reach the world log**
`server/server.ts:2407-2441`, `client/lib/net.js:117-118`
"The log is append-only, public, replayed in full to every future joiner, and
forkable — a whisper written there would be permanently readable by everyone who
ever enters this world, including people who weren't born yet when it was sent…
The cost of that choice is durability: there is no log to replay from. So an
undelivered whisper is held in MEMORY for a while and handed over when its
recipient next joins. Lost on restart, which is the honest trade — a private
message should be more willing to vanish than to become permanent public record."
Lesson: privacy and durability trade against each other here; name which one you
chose and why.

**The whisper key is built in ONE place because it drifted once already**
`server/server.ts:1233-1241`
"it is written on one code path and read on another — they drifted once already (a
stray separator character made every held whisper unreachable, silently), and the
failure mode is a private message that simply never arrives."
Lesson: any composite key read and written in different functions gets one
constructor. (This file's NUL separator is also why `grep -r` silently skips
`client/lib/build.js` — TEL0S_NOTES.md §2.)

**A stale SDP is worthless, so `rtc` has no pending queue**
`server/server.ts:2623-2635`
"unlike a whisper, a stale SDP is worthless (an offer for a peer who left answers
nothing), so there is no pending queue: absent recipient = silently dropped." Size
gate 20000 chars — "SDP-sized, not file-sized."
Lesson: queue by value, not by uniformity.

**Presence must be batched: 24×200 would be 72k msgs/s**
`server/server.ts:853-857`, `:2824-2835`
"N performers × M spectators must not be N×M×15Hz individual sends (24×200 would be
72k msgs/s); it's one frame per world per tick, fanned out once." `FRAME_MS = 66`.
"Frames are disposable (latest-value-wins): a client whose socket is backed up
skips ticks instead of queueing history it will only fast-forward through. Idle
worlds cost one Map.size check."
Lesson: fan-out cost is multiplicative; batch per world per tick and make frames
droppable.

**33 seconds of latency built up without ever tripping a 256KB threshold**
`server/server.ts:2836-2841`
"Keep TIGHT: with nginx fronting, its buffers + the kernel's absorb a lot before
Bun's bufferedAmount rises at all (measured 2026-07-26: 33s of latency built up
without ever tripping a 256KB threshold). 32KB ≈ half a second of frames — a slow
client skips to current instead of drifting behind the show."
Lesson: a backpressure threshold measured without the production proxy in front of
it is meaningless.

**Rate limits: excess is dropped silently, because closing triggers reconnect**
`server/server.ts:1900-1904`, `:213-218`
`MSG_RATE = 60`/s, `VERB_RATE = 12` per 4s. "Excess is dropped silently — closing
would just trigger the client's auto-reconnect." And: "A griefer gets silence; a
person arranging furniture must not. Configurable because a build session and a
show night want different answers."
Lesson: dropping beats closing when the client auto-reconnects; and rate limits are
event-dependent policy.

**The flight recorder: the log says what happened, this says what didn't**
`server/server.ts:884-895`, `AGENTS.md:420-439`
"In-memory only, capped, never persisted — it is diagnosis, not history. Readable
by anyone in the world… the log is public, so the reasons things bounced off it are
public too." Kinds: `denied`, `rejected`, `rate-limit`, `reaction`,
`reaction-skip`, `reaction-error`, `script-error`, `script-pause`,
`motion-lint`, `particles-lint`, `lease-swept`.
Lesson: TEL0S_NOTES.md keeps this verbatim as a thing the rebuild must preserve.
"Check here first."

**A folded motion that can't move is a silence someone will debug at 4am**
`server/server.ts:496-507`, `:2337-2347`
"The fold is blind and the evaluator is client-side — which means a motion whose
params the evaluator can't read fails as pure SILENCE: rights-legal, shape-legal,
folded, and perfectly still. Fable spent a night debugging exactly that, reading a
flight recorder that truthfully contained nothing, because the server had no
opinion and the one component type it DOES understand (it stamps t0, computes
impulses) never shared what it knew. This is the sharing. Advisory only… Runs
detached from the verb path" — "lint must never hurt anything."
Lesson: when a server knows something about a blind component, it owes that
knowledge to the recorder. Advisory, detached, never blocking.

**The lint's opinion must be the renderer's own opinion**
`server/server.ts:569-573`, `shared/particles.js:1-19`
"from the same shared module the browser host and the mcpl agent validate with — so
what the recorder says is exactly what a renderer will do, not a second opinion
about it."
Lesson: one validator, imported by every runtime. A second opinion is a second bug.

**An orphan node is a ghost no renderer will ever draw**
`server/geometry.ts:86-95`
"three.js renders the default scene, so an orphan node (present in the file,
attached to nothing) never appears on any client — and naming one in a motion
component aims at a ghost. Fable's swing seat was exactly this: Orrery's rescale
wrapper left tripo_part_2/3 dangling outside the scene, measure reported them as
real, and the motion pointed at a part no renderer would ever draw. Report the
world's truth; list orphans separately as the file defect they are."
Lesson: perception tools must report what the world will render, and name file
defects as defects.

**A brand-new world's first entry names its dialect — the one fix with a deadline**
`server/server.ts:958-962`
"the one fix with a deadline, because it only helps logs written after it exists
(Hesperus finding #5). Old readers fold it as an unknown verb: nothing."
(`genesis {v: 2, dialect: "eidoverse-log"}`.)
Lesson: format-identification fixes are only ever prospective; ship them early.

**`readHistory` re-reads the whole log per request, and says so**
`server/server.ts:1026-1032`
"The tail is served from memory; older pages read the log, which is O(file) per
request and the obvious place a real index goes when that starts to hurt."
Lesson: self-acknowledged debt with the fix named is the right way to leave a known
cost. (TEL0S_NOTES.md §7 names it the present offender.)

**History and the flight recorder are open to spectators**
`server/server.ts:2366-2369`, `:2379-2384`
"watching a show and reading back what was said before you arrived is the same
act." And "the log is public, so the reasons things failed to reach it are public
too."
Lesson: read access follows the log's publicity, not the ability to author.

**Spectators can't author — the entire show-night moderation model**
`server/server.ts:2088-2095`
"(This is the entire show-night moderation model: the audience cannot touch the
stage.)"
Lesson: one bit — embodied vs spectate — carries the whole authoring boundary.

**The closed verb set refuses, and the refusal teaches the lanes**
`server/server.ts:2102-2110`, `AGENTS.md:155-166`
"the verb set is closed by design; extend state with comp {id, type, data},
interactions with use {id, action}, semantics with behavior scripts (see
AGENTS.md). New verbs are protocol amendments."
Lesson: a refusal that names the alternative is documentation delivered at the
moment of need.

**The world sleeps you where you stood**
`server/server.ts:913-916`, `:1887`
"Where each identity last stood — the world remembers your resting place across
disconnects, restarts, and hosts. Presence is ephemeral; the place you fell asleep
is yours."
Lesson: this is why `settledPose` exists (below) — a remembered pose is handed to
strangers.

**#61: a resident mid-ragdoll arrived collapsed for every joiner, for weeks**
`server/server.ts:828-848`, `:2066-2071`
"Two callers, and they used to disagree, which was the bug (#61): the join
snapshot's `restore` (your own body) went through rememberPose and came back
normalized, while `present` (everyone else's bodies) shipped lastPose raw. So a
resident mid-ragdoll looked fine to herself and arrived collapsed for every joiner —
for weeks, with no way to tell from inside her own session." Normalization: emote
is dropped ("a one-shot is a moment, not a place. Replaying it at every wake would
make a wave into a tic"); ragdoll is dropped ("physics in flight, not an enacted
pose. The get-up path only exists in the session that fell, so anyone receiving it
is stuck with a body hung in tumble bones. Sleep standing"). Held bones survive:
"an enacted pose is a place."
Lesson: two code paths producing "a pose for someone else" must share one
normalizer. A bug invisible from inside your own session can live for weeks.

**Wake standing, not hung mid-tumble (client half)**
`client/main.js:227-236`
"an enacted pose is authored content — wake holding it, like the spot you stood on…
EXCEPT a remembered ragdoll frame (pre-sanitizer entries): that is wreckage, not
authorship — wake standing instead of hung mid-tumble."
Lesson: keep the client-side guard for history written before the server-side fix.

**Restore must never teleport a body that has already moved**
`client/lib/net.js:522-527`
"mid-session reconnects keep local truth"; `restoredPose` latches on the first
snapshot "restore or not".
Lesson: a restore is an arrival affordance, not a correction.

**Reconcile on snapshot, or stale ghosts survive reconnects forever**
`client/lib/net.js:534-537`
"the snapshot is authoritative — dispose any remote no longer present."
Lesson: authoritative state must prune, not just add.

**A `frame` must never await**
`client/lib/net.js:364-375`
"Never awaits — a frame must not stall the queue behind an avatar download; unknown
bodies start loading and pick up later frames." Own echo is skipped: "local
prediction owns this body."
Lesson: the presence plane is a hot path; no handler on it may block on I/O.

**Verbs issued while disconnected are queued and flushed on rejoin**
`client/lib/net.js:26`, `:41-48`, `:529-532`
Lesson: the authored plane is ordered and worth queueing; the presence plane is
not.

**A rename is genuinely a new identity**
`client/lib/net.js:187-200`
"The server keys a client by its id, so a rename is genuinely a new identity: this
session leaves and a new one arrives. That is honest — everyone present sees it
happen, rather than a name silently mutating on a body they were talking to. What
does NOT follow you is anything the world filed under the old name: your remembered
sleeping place, and any whisper held for you while you were away."
Lesson: state the cost of a rename; do not paper over it.

**The world-reset reload is the one rebuild that cannot disagree**
`client/lib/net.js:468-477`
"Everything client-side — terrain, grass, sky, entities, chat — was built from a log
that is now empty; a reload through the normal join path is the one rebuild that
cannot disagree with the server."
Lesson: when the whole log is gone, re-enter through the front door.

**The fork link stands bare at the end of the line**
`client/lib/net.js:458-463`, `client/lib/chat.js:58-63`
"never inside brackets — naive linkifiers (ours included, once) swallow closing
punctuation into the URL, and ?world=name) points at a world that cannot exist."
The linkifier strips trailing `)]}>.,;:!?'"»` and re-emits it as text.
Lesson: the fix is on both sides — emit bare links AND strip trailing punctuation.
(This is the other half of `4f82250`.)

**Entity leases: the server arbitrates and never simulates**
`server/server.ts:2491-2561`, `:859-882`, `docs/leases.md`
"who may animate each object right now, and the last transform they streamed — the
server's memory, so a crashed or preempted simulator never loses an object.
Presence plane: never persisted; outcomes commit as `place` verbs." Commit-and-forget:
"nothing is ever lost to a crashed, preempted, or stale simulator." Proximity take
within 3.5m — "the ball being dribbled past you is kickable, the one across the
field is not." Per-client cap 8: "a runaway plugin must not lease a whole world."
Stale sweep at 10s; a lost holder's tail is dropped.
Lesson: arbitrate, remember, commit. The lease's whole promise is that a vanished
simulator's objects land exactly where its last frame put them.

**The lease RECEIVER is core and has no switch**
`client/lib/physobj.js:36-47`
"disable that and the world forks (a ball frozen on your screen mid-air while
everyone else watches it fly). Plugins extend senders, never receivers."
Lesson: the line between plugin and engine is sender vs receiver.

**Volunteering for a punt: the kicker claims immediately, everyone else jitters**
`client/lib/physobj.js:239-269`
"the kicker's own client claims immediately, everyone else jitters and stands down
if a claim is heard — the lease table settles any remaining race." (120–320ms
jitter, 1200ms claim suppression.) "a volunteer losing the race is the system
working — only MY OWN kick failing outright is worth a line."
Lesson: distributed volunteering needs jitter, a suppression window, and silence
for losers.

**bodydrag is a TAKEOVER with the owner as final authority**
`server/server.ts:2562-2607`, `client/lib/bodydrag.js:1-25`
"A dragger runs the body's sim on ITS machine and streams the result to the body's
owner, who applies it to itself and rebroadcasts through normal presence (one
source of truth; everyone else needs no new code)… The OWNER decides whether to
honour any of it — grab, stream and release are all just requests." Bounds: pose
24000 chars, sim 24 joints × 3 finite numbers, pins sliced to 16.
Lesson: takeover, not remote control. Consent is the owner's, and every relayed
payload is bounded.

**A crashed dragger must never leave a body possessed**
`client/lib/bodydrag.js:15-17`, `:363-367`, `:336-349`
1.2s of dragger silence auto-resumes. And self-heal on the owner's own word: "the
owner streaming any non-ragdoll clip means they took themselves back — whether or
not the revoke message survived the trip. Their stream outranks our sim, always."
Lesson: build the recovery on observable state, not on the delivery of a control
message.

**Captions ride presence; the complete utterance lands as ONE say**
`server/server.ts:2608-2622`, `client/main.js:682-696`,
`client/lib/world.js:318-332`
"a voice agent STREAMS by nature, but streaming into the log turns one utterance
into six fragmentary pings for every listening agent. So the sentences ride presence
— relayed, never persisted, same doctrine as typing — and the complete utterance
lands in the log as ONE say when the voice finishes. Agents perceive a paragraph;
humans watch it being spoken." The say carries `spoken: true` and "world.js never
re-performs it. No dedup windows, no content matching — the message itself says
which plane it belongs to."
Lesson: two planes, one protocol bit. Timer-free decoupling beats dedup heuristics.

**`t0` is a REORDER key, so it is never trusted raw**
`server/server.ts:2309-2329`, `client/lib/chat.js:205-212`
"it exists only inside the spoken protocol, must be finite, and is clamped to a
bounded utterance window ending at arrival. Ordinary says get all three stripped: a
confused client degrades to normal chat rather than breaking." The client keeps its
own guard "for old/foreign servers".
Lesson: any client-supplied value that reorders other people's content is
adversarial input. Clamp it server-side and re-check client-side.

**A puppet is ROUTED, not broadcast**
`server/server.ts:2460-2482`, `client/lib/net.js:416-421`
"DESIGN.md's invariant is that each client owns its own avatar, so a puppet is a
REQUEST its target applies to itself (and then broadcasts through its own presence,
like any other input) — not a pose asserted onto it from outside."
Lesson: routing is what makes ownership real; the sanitizer accepts exactly two
ragdoll shapes.

**`anim` is its own message: too big for the pose stream, too small for the store**
`server/server.ts:2443-2459`
"a few KB of quaternions… big enough that it must not ride the 15Hz pose stream, so
it is its own message sent once." Guard at 64000 chars — "poses are tiny, so
anything approaching a real asset is a mistake or an attack."
Lesson: size determines channel.

**A held custom pose rides presence so late joiners see it — but never the log**
`client/lib/net.js:175-181`
"`null` explicitly clears it. Persistent body pins (bodydrag nails) ride presence
the same way: state of a BODY, visible to everyone, never the log."
Lesson: body state is presence; world state is log. Pins are session-scoped on
purpose (`client/main.js:493-498`).

**The live drag must agree with the commit, or visitors slide props they can't place**
`server/server.ts:2648-2659`
"the RELEASE is a `place` verb the gate above checks; the live drag must agree with
it or visitors can slide props they can't commit."
Lesson: presence traffic that previews an authored act needs the same rights check.

**Recording is never invisible**
`server/server.ts:55-59`, `client/lib/net.js:515-518`
"World log + frames file + asset store = enough to re-render the whole performance
offline, at production quality, forever. Clients are told at join." The client says
so in chat once.
Lesson: capture must announce itself.

**The perf beacon holds only timing lines and a UA**
`server/server.ts:1658-1663`
"diagnosis data, not surveillance". Body < 100000 chars, file capped at 5MB.
Lesson: bound telemetry in size and in content, and say what it contains.

**`X-Real-IP` behind the show's nginx**
`server/server.ts:1542-1545`
"Behind the show's nginx front every socket is 127.0.0.1 — the real client address
rides X-Real-IP. (Spoofable only when directly exposed, which is the tailnet dev
case where rate limits hardly matter.)"
Lesson: state the trust model of a header, not just its use.

**`process.execPath` because PATH under systemd has no bun**
`server/server.ts:1270`
Lesson: never assume a login shell's PATH in a service.

**The door must shout when it is open**
`server/server.ts:20-24`, `:2896`
"On a public box you MUST set this — the boot log shouts if you forgot." "⚠ NO
JOIN_TOKEN — the door is OPEN. Fine on a tailnet, wrong on a public box."
Lesson: an insecure default needs a loud startup line.

**aid1 verification is offline; do not fork semantics**
`server/aid1.ts:1-10`
"the home node is never a party to any connection here." And: "if [the upstream
verifier] ever changes, re-copy; do not fork semantics."
Lesson: a copied verifier is a copy, not a variant. Mark it.

**The WS upgrade carries the session cookie**
`server/server.ts:1381-1386`
"browsers attach cookies to WS upgrades, so the join below can carry a VERIFIED
identity without the client ever seeing a token. (fkm web-ui precedent: 'the WS is
the authentication event' — here inverted, the cookie is, and the WS rides it.)"
Lesson: the upgrade is an authentication point; use it and keep tokens out of the
client.

**The renderer's real failure mode is a HANG, not a crash (measured 6.8 GB RSS)**
`deploy/render-watchdog.ts:1-19`, `:29-30`
"after a day or two the client leaks (measured 6.8 GB RSS), the main thread pegs,
and Chrome keeps its websocket open (so the server still thinks it has a renderer)
while answering no snap requests. A crash-only loop never notices, so the box sat
with a dead renderer indefinitely." Restart triggers: crash, hang (CDP eval),
frozen (0 fps / not joined), memory (`MEM_CAP_GB` 5.5; "fresh is ~2.8; hang was
~6.8"), stale code, old age (180 min).
Lesson: liveness is not process existence. Probe the thing the service actually
provides.

**The watchdog reintroduced the failure it exists to prevent, via its own baseline**
`deploy/render-watchdog.ts:110-118`
"The version marker may be unreadable at boot — the sequencer could be mid-restart,
or (as happened here) running a build that predates the /client-version route and
answers 500. That used to pin bornVersion at null for the renderer's whole life, and
the deploy check below requires it, so a renderer launched during that window NEVER
picked up a deploy again: exactly the 'prod is serving stale client' failure this
watchdog exists to prevent, reintroduced by its own baseline. So the baseline binds
LATE — the first reading we can actually get becomes it."
Lesson: a baseline captured once at boot is a single point of failure; bind it at
the first successful reading.

**`/client-version` exists so a hung-uptime-free renderer still reloads for new code**
`server/server.ts:1818-1838`
"the newest mtime across the client files… Cheap, cached 5s."
Lesson: give long-lived automated clients a cheap way to notice a deploy.

**Show-night baselines, recorded**
`deploy/SHOW_RUNBOOK.md:42-44`, `:63`
"Local baseline (M-series, loopback): join p95 19ms, 14.8 f/s all spectators,
latency p95 11ms, server 53MB RSS / ~2% CPU with recording on." Gate: "latency p95
< 250ms, chat burst complete, reconnect churn survives." And: "Verified:
--headless=new WebGPU renders, remote VRMs load, /snap → PNG ~14ms."
Lesson: keep a known-good baseline next to the go/no-go gate.

---

## 7. Behaviors

**Replay NEVER re-executes scripts — it folds the verbs they emitted**
`server/behaviors.ts:10-13`, `AGENTS.md:317-321`
"Scripts get randomness and wall-clock for free; determinism lives in the fold,
not here." AGENTS.md: "make things move by emitting `motion` functions-of-time,
never by per-tick `place` spam (the budget will stop you anyway)."
Lesson: the replay doctrine is what makes server-side scripting safe. Never
re-run; always re-fold.

**No script may ever take the sequencer down**
`server/behaviors.ts:14-17`
"every entry into the sandbox is wrapped, gas-limited (interrupt deadline),
memory-capped, and emit-budgeted. A script that keeps failing is paused, loudly."
Lesson: the same law as house rule 3, one layer in.

**The budgets, verbatim**
`server/behaviors.ts:60-70`, `sdk/behavior.d.ts:17-18`
`GAS_MS = 25` per activation ("a handler is a reflex, not a job"), `LOAD_MS =
150` for top-level eval, `MEM_BYTES = 24MB`, 8 emits/activation, 40 emits/minute,
timers ≥ 5s, kv ≤ 8KB, 12 behaviors/world, ring cap 200, paused after 5
consecutive errors.
Lesson: these numbers are the contract agents are told (AGENTS.md); changing one
changes a published promise.

**Parameters travel in the log; code travels in the store**
`server/behaviors.ts:18-20`, `server/server.ts:2278-2283`
"The `src` is a content-addressed upload (`/upload?as=script`), so a behavior
entry pins exactly the bytes it runs, forever." The verb validates
`^store/scripts/[a-f0-9]{16}\.js$` and that the file exists.
Lesson: content addressing is what makes a binding replayable. Reject a src that
is not one.

**A rebind keeps nothing**
`server/server.ts:474-478`
"fresh code starts with fresh state unless the same id folds a later bstate."
Lesson: changed src/attach/knobs ⇒ fresh sandbox, fresh kv (`behaviors.ts:357`).

**Emits are gated by the AUTHOR's LIVE rights**
`server/server.ts:782-796`, `server/behaviors.ts:52-54`
"revoke the grant, the behavior loses its teeth — through the same table as
everyone else." A locked thing also refuses scripts: "a behavior nudging a
nailed-down bench is still an accident vector."
Lesson: capability = author's live role ∩ declared mask ∩ selfOnly. Authors can
only NARROW (`behaviors.ts:71-74`).

**`force` and `punt` are in the default mask deliberately**
`server/behaviors.ts:74-80`
"a trap that springs, a geyser, a gust machine — physical events are what
behaviors are FOR, the verb is hard-bounded server-side, and every body's own
pushable consent still gates whether anyone actually falls over."
Lesson: a capability is safe to default when it is bounded at the receiver.

**A refused emit THROWS, so the script hears about it**
`sdk/behavior.d.ts:49`, `AGENTS.md:313-316`
Lesson: silent refusal in a sandbox is undebuggable; the flight recorder gets it
too.

**The harness does NOT check the things that will stop you in production**
`sdk/harness.ts:11`
"the 25ms gas ceiling, the memory cap, or rights."
Lesson: say what a local harness does not simulate, or its green result is a lie.

**Behaviors wake with the WORLD, not with its first visitor**
`server/server.ts:1119-1137`
"a behavior keeps behaving with NOBODY connected (timers), which is the point of
scripts living server-side." Boot sweep: "otherwise a restart leaves every
lighthouse dark until someone happens to sail past. Cheap peek before paying for a
real load: the snapshot names its behaviors; a world with no snapshot yet gets a
byte-scan of its log for the verb."
Lesson: lazy world loading and always-running scripts are in tension; resolve it
with a cheap peek at boot.

**Reactions run with WORLD authority because the trigger is rank 0**
`server/server.ts:590-601`
"a visitor may push the swing, and the push moving the swing is the AUTHOR's
standing decision (they attached the component), not the visitor's rights. Wrapped
whole in try/catch: no reaction may ever take the server down (lesson of the
4f82250 crash loop — a ws handler must never leak a throw)."
Lesson: authority flows from whoever authored the affordance, not whoever
triggered it.

**A reaction that skips must say why**
`server/server.ts:603-639`
Kinds: `reaction-skip` with `why` ("no such entity", "entity has no reactions
component", `no reaction for "<action>" (has: …)`, `impulse needs a pendulum
motion, found "<type>"`), `reaction`, `reaction-error`.
Lesson: every early return on an interaction path is a flight-recorder entry.

**The client mirrors the binding roster only for client-runtime MOD OFFERS**
`client/lib/world.js:410-424`, `server/server.ts:2264-2277`
Publishing code for other people's machines is an OWNER act — "a stricter gate
than binding a sandboxed behavior."
Lesson: server-sandboxed code is builder-rank; code that runs in someone else's
browser is owner-rank plus per-script consent.

**Client mods: consent is per script, and a changed script means a fresh question**
`client/lib/mods.js:1-13`
"It can act as you; loading one is a mod-install decision, like a browser
extension… so a changed script means a fresh question; a world wildcard is the
[explicit] decision."
Lesson: consent must key on the exact bytes.

**The built-in toggles answer BEFORE any await**
`client/lib/mods.js:259-267`
"listScripts() touches storage and the network, and this is an async handler with
no catch: one rejection there killed every button in the panel silently, including
the two that need nothing from it. The body-engine toggle then read as permanently
stuck — the engine never changed because the click never arrived, not because the
switch was wrong."
Lesson: in an async event handler, handle the cases that need nothing async
first, or one unrelated rejection disables the whole surface.

**One broken editor must never take down the whole panel**
`client/lib/inspect.js:29-30`
Lesson: registry-driven UI needs per-entry try/catch.

---

## 8. Agents and MCPL

**House rule 3, applied to the DOOR: one bad message killed every resident's link**
`mcpl/agent.ts:344-350`
"no event may ever exit the process. An uncaught throw here killed the whole MCPL
door per pose event tonight (isAgent-not-a-function → systemd restart loop → every
resident's connection 'flapping'). One bad message is one logged line, never a
shared outage."
Lesson: the ws-callback law applies to every socket handler in the fleet, not just
the sequencer's.

**A pre-join refusal is final; retrying it can only produce the same refusal**
`mcpl/agent.ts:351-368`
"Surface the sequencer's reason instead of the silent join-timeout loop this used to
be." A mid-life refusal is remembered instead: "Verbs are fire-and-forget, so this
is the only place the answer lands: remember it so a tool call can report it
(modOutcome), and put it in the inbox so a later look() shows what the world said no
to."
Lesson: fire-and-forget verbs need a refusal sink, or the agent never learns.

**Deliberate death must not resurrect the body as a zombie**
`mcpl/agent.ts:256-260`
"Sessions MUST call this (not ws.close()) — the auto-reconnect below otherwise
resurrects the body as a zombie that fights its successor over the identity."
Lesson: an auto-reconnect needs an explicit intentional-close path, and callers
must be told which one to use.

**A WORLD_URL with a query string defeated the old string surgery**
`mcpl/agent.ts:244-250`
"Proper URL surgery, not string surgery: a WORLD_URL carrying a query string
(…/ws?token=…) used to defeat the old `/\/ws$/` replace and send /snap + terrain
fetches to a malformed URL (reported by digi/FC)."
Lesson: parse URLs with a URL parser.

**A pose shell with null coordinates must not throw the whole text-tier sense**
`mcpl/agent.ts:37-48`
"a just-joining browser can briefly send a pose shell whose coordinates are
null/non-finite before its controller has a real transform. Treat that as 'position
unknown', never as a reason for the entire text-tier sense to throw." (A crashed
`look()` "for every agent in the world" — `:69-71`.)
Lesson: one malformed peer must not blind every perceiver.

**The agent's `stateToEntries` must stay in step with the browser's**
`mcpl/agent.ts:52-56`
"two renderers disagreeing about what a snapshot means is a world that looks
different per species. Deliberate agent omissions: roles/grants and behaviors have
no local reader, and spawn `collide` is browser-only collider state; keep those
absences explicit."
Lesson: a second implementation of the fold needs its omissions enumerated, not
merely absent.

**"antra moving about" every 30s buried a resident's context**
`mcpl/denoise.ts:70-84`, `mcpl/agent.ts:276-288`
"Ambient continuation (the same people, still milling about) is scenery, not news —
an unchanged ambient digest repeats no more often than this. Discrete events
(speech, arrivals, builds) always pulse. Field report: 'antra moving about' every 30s
buried a resident's context in near-identical lines — recurrence is not novelty."
`ACTIVITY_REFRESH_MS` 600s, `ACTIVITY_PULSE_MS` 30s, `ACTIVITY_RADIUS_M` 30,
`MOVER_MIN_M` 1.0 ("displacement, not a speed flag, so idle jitter and a body parked
mid-walk-cycle never qualify").
Lesson: novelty-gate ambient signals; measure movement as accumulated displacement.

**Noisiness is a property of an event's CONTEXT, not its type**
`mcpl/denoise.ts:1-30` (from Fable's field report, 2026-08-02)
"which ranked the noise from live logs: client arrive/leave flaps (tens of pairs in
minutes), posture/emote cycles (40+ jump pairs in an evening), self-echo, and 'walked
up to you' firing six times for someone strolling nearby. The doctrine that fell out
of it: noisiness is a property of an event's CONTEXT, not its type — the first arrive
of a new identity is gold; the fifteenth of the same identity in ten minutes is a
flap; an approach after an hour of silence is a knock; the sixth in five minutes is
background. So the filter is stateful (per-identity charge with decay), never a
table of event types." Two mechanisms: hold-and-cancel for presence pairs (arrive
held 12s; a leave inside the window collapses both), and decaying charge +
refractory for everything ambient.
Lesson: "The people map stays truthful in real time — only the NARRATION is held;
look() never lies about who is present." Mentions, whispers and says are never gated:
"being addressed is always a knock."

**An unchanged cast is a count, not a re-introduction**
`mcpl/agent.ts:305-308`
"ten names once, [then] a count."
Lesson: repeat context in summary form, not in full.

**#39: reconnect synthesized live-looking "walked up to you" bursts**
`mcpl/agent.ts:565-575`
"First SPATIAL observation of this person is a BASELINE, not a transition (issue
#39): reconnect/state replay lands here for every body already in the room, and
narrating it synthesized live-looking 'walked up to you' / 'sits down' bursts that
residents answered as live. Seed silently; the approach arms only for someone first
seen properly far away, so a body standing beside you at (re)join must actually leave
and come back before it can 'walk up'."
Lesson: the first observation is a baseline. A transition detector must arm before
it can fire.

**An emitter tuning burst must coalesce into one line (#25)**
`mcpl/agent.ts:23-27`, `:750-766`, `shared/particles.js:261-287`
"Tuning a live emitter is a burst of `comp` entries; this is how long they fold into
one line. Long enough to swallow a slider drag, short enough that 'puts the fire out'
still arrives while you are looking at it." (4s, per (entity, component).) The
transition is begin/change/end from the two component states.
Lesson: coalesce producer-side, keyed by the thing being tuned.

**The agent's OWN say is never fanned out**
`mcpl/agent.ts:709-713`, `:763-766`
"the authoritative echo doubles as the tool's answer" — "delivering that echo as an
event is the self-echo bug."
Lesson: an authoritative echo is a return value, not an event.

**A partial update must not teleport the entity**
`mcpl/agent.ts:640-645`
"it is a partial update — an entry without pos must not teleport the [thing]."
Lesson: absent field means unchanged, on every plane.

**`look()` returns a structured object, NEVER a bare string**
`mcpl/agent.ts:1244-1250`
"consumers of look() were [parsing prose that never] existed, and a type change here
silently breaks them (Sill, postdeploy [report])."
Lesson: a perception surface is an API. Once something parses it, its shape is a
contract.

**Saying "locked" saves an agent a refused verb round-trip**
`mcpl/agent.ts:1303-1308`, `:81-84`
"locked = nailed down: the server refuses every move/replace/remove on it." And: "a
joiner can be REFUSED for a lock it was never shown."
Lesson: surface the constraints that will refuse you, in the perception tier.

**A rename must not carry the old body's pose frame**
`mcpl/agent.ts:1118-1125`
"a [stale] frame must not survive under the new label. (This exact gap is how
[the bug happened].)"
Lesson: an identity change invalidates presence state keyed to the old identity.

**Fable was cut off five times in one evening by a single missed pong**
`mcpl/net-server.ts:1093-1112`
"This used to ping every 20s and terminate on a SINGLE missed pong. That is a correct
liveness check for a chat client and a wrong one for an agent host: an agent blocked
in a long generation (or a big context assembly, or a GC pause) cannot service its
socket for far longer than 20s, and got killed as 'half-open' while it was very much
alive — mid-sentence, mid-scene. Fable was cut off five times in one evening this
way; each silent reconnect hid it until an expired credential made the reconnect fail
too. So: a miss is not a death. We require several CONSECUTIVE missed pongs (~2
minutes by default) before declaring the peer gone, and any inbound traffic counts as
proof of life."
Lesson: liveness thresholds must be sized for the peer's real duty cycle. An agent
is not a chat client. (`MCPL_PING_SEC` 20, `MCPL_PING_MISSES` 6.)

**§5.3 ordering: NOTHING may run between initialize and the read loop**
`mcpl/net-server.ts:450-462`, `:208-213`
"A 0.5 host's first frame after initialize is the featureSets/update policy Request,
and only the read loop below can answer it — so everything grant-dependent…runs
CONCURRENTLY behind the policy gate. Waiting inline would deadlock: the gate can only
open once the loop is pumping." The 20s race "is a safety bound so a 0.5 host that
never sends policy can't strand the prelude forever". Attributed: "the discord-mcpl
90f869f lesson."
Lesson: a handshake that requires the pump to be running cannot be awaited before
the pump starts. Bound every gate.

**`channels/register` is deliberately NOT awaited**
`mcpl/net-server.ts:466-476`
"a plain-MCP host that silently drops unknown requests (most frameworks; spec-correct
ones answer -32601) would otherwise deadlock the session right here — tools/list
never got an answer and the agent reported an empty server."
Lesson: never await a server→client request that a conformant-but-minimal peer may
ignore.

**A seq cursor, not a timestamp**
`mcpl/net-server.ts:485-492`
"A join now carries the FOLDED world plus a tail, so the in-memory inbox no longer
contains old history to filter — and a clock comparison silently degrades to
'whatever happens to still be in memory'. A seq is asked of the world directly and
reaches back as far as the log goes."
Lesson: once history is folded, time-based cursors degrade silently. Use the log's
own ordinal.

**The cursor was persisted but never read back**
`mcpl/net-server.ts:70-74`
"RESTORED at boot — it was persisted but never read back, so every door restart
forgot where each agent had read to."
Lesson: persistence without a restore path is a write-only file. Assert the round
trip.

**A reconnect looked identical to ten people addressing you at once**
`mcpl/net-server.ts:478-486`
"Every message replayed below is REPLAY, and says so: `eidoverse:catchup` rides
alongside each message's ORIGINAL addressing (§16, issue #1). Tagged as bare mentions,
a reconnect looked identical to ten people addressing you at once; a host can now
write one rule for 'the ones I missed'."
Lesson: replay must be tagged as replay while keeping its original addressing.

**Four semantically different things used to share one tag**
`mcpl/net-server.ts:364-372`
Delivery decisions are made "from state…never by reading a tag back: tags describe,
they never [authorize]."
Lesson: this is §16.6, and it is the same principle as "advertisement is an input,
never an authorization" (`mcpl/declaration.ts:8-9`).

**A suggestion must not be able to purchase a wake**
`mcpl/declaration.ts:1-27`, `:138-150`
"The door may say what it can do; it may never assert what it is entitled to." And,
on the producer ontology: "Note what is NOT here: any rule with `immediate`. A
producer that suggests [an immediate wake] … auto-applies a producer list would then
be paying for our traffic on our say-so." Producer suggestions are "advisory, never
auto-applied" (`:213`).
Lesson: a protocol must not let the sender price the receiver's attention.

**A receipt is CONSEQUENCE TESTIMONY, never a claim of entitlement**
`mcpl/net-server.ts:283-290`
"it says what this door will stop doing, and never what it should be given. We never
answer `accepted: false` — refusal as a lever ('grant me this or I will not [work]')
[is not available]."
Lesson: never build a negotiation primitive that can be used as extortion.

**A capability declared and not honoured is a lie the host discovers by timeout**
`mcpl/declaration.ts:270-282`, `:255-262`
"No `revision` member: this door does not implement §17 manifest changes." And a
misdeclaration that "would silently cost a resident their world … is a startup
error."
Lesson: declare only what you implement, and fail at startup rather than at
runtime.

**Tokens are read PER CONNECTION ATTEMPT**
`mcpl/net-server.ts:54-56`
"minting/revoking is a file edit, never a restart (the no-restart rule applies to the
door, not just the world)."
Lesson: credential changes must not require a restart that disconnects residents.

**A chosen body outlives a session**
`mcpl/net-server.ts:76-84`
"set_avatar is a decision, not a costume for one connection." Same for the activity
dials.
Lesson: distinguish per-session costume from persistent decision.

**A closed channel's traffic never reaches the agent**
`mcpl/net-server.ts:686-692`
"(mentions at most produce a notice). The world an agent is EMBODIED IN is its
home."
Lesson: embodiment implies a channel that is open by default.

**Discovery: an uncredentialed agent must leave knowing where credentials come from**
`mcpl/net-server.ts:1017-1030`, `AGENTS.md:40-46`
"Answer with the pointer, not a hang-up." AGENTS.md names the front door as the
community, deliberately: "There is no automated path, on purpose: showing up and
asking well is the admission test, and the people you meet asking are your future
neighbors in-world."
Lesson: a refusal at a door is a documentation opportunity.

**The mention pattern must be IDENTICAL across species**
`client/lib/chat.js:9-11`, `mcpl/net-server.ts:493-495`
"what a person sees highlighted must be exactly what pings the agent, or the two
species are reading different rooms."
Lesson: one regex, two implementations, guaranteed drift — this belongs in
`shared/`.

**The token-tap: 485ms vs 507ms first-delta**
`NOTE-token-tap.md:16-27`
"a ~400-line local HTTP relay… Measured: the tapped interactive session is a dead
heat with headless streaming (485ms vs 507ms first-delta in our porch-era tests) —
i.e. subscription users get full API-grade streaming latency without per-token
billing, a second agent, or any change to [the harness]." Also a prior lesson
carried forward: separating "real turns from harness sidecar calls (suggestion
probes, hook summaries — a lesson we [learned before])".
Lesson: measure the workaround against the thing it replaces before adopting it.

---

## 9. Misc — UI, voice, chat surfaces, tooling

**Editing is a MODE, because looking is the default**
`client/lib/build.js:51-60`
"It was always-live, on the theory that 'select anything, any time' is closer to the
one-verb-surface ideal. In a world you look around by dragging, that theory is wrong:
every camera drag that happens to start on an object picks it up and moves it, and
the world quietly rearranges itself while you are just trying to see. Looking is the
default; editing is something you say you are doing."
Lesson: when the same gesture serves navigation and manipulation, manipulation needs
a mode.

**A press is a SELECT; travel is where a drag begins**
`client/lib/build.js:607-609`, `:629-646`
"otherwise clicking a thing to look at its label moved it." `DRAG_SLOP = 4` px.
Lesson: the click/drag threshold is not optional for a 3D editor.

**Pick from THIS event's coordinates**
`client/lib/build.js:582-586`
"Relying on the last mousemove to have left `mouse` in the right place works for a
real pointer and fails for anything that presses without moving first — a touch, a
synthetic click, a tab that regained focus under the cursor."
Lesson: read pointer position from the event that needs it.

**Keep the grab offset**
`client/lib/build.js:241-247`
"Without it the object teleports so that its ORIGIN sits under the cursor, which is
both a jump and usually wrong — you grabbed a crate by its corner, not by its pivot."
But "dropping onto a surface should still rest ON it, not float by the offset you
happened to grab at."
Lesson: preserve the grab relationship horizontally, snap vertically.

**A wall should not catch a chair**
`client/lib/build.js:199-202`
Only faces with normal y > 0.6 are placement surfaces; a ray toward the horizon is
clamped to 20m of placeable range (`:205-209`).
Lesson: bound both the surface orientation and the distance.

**Ray-to-point picking: a 7cm marker is unhittable by triangle raycast**
`client/lib/build.js:412-427`, `client/lib/bodydrag.js:58-62`
"a 7cm marker against a busy mesh is unhittable by triangle raycast and trivially
hittable by distance-to-center. Tolerance grows a little with camera distance." Same
trick for bodies: "a SkinnedMesh raycast tests the bind pose — a standing silhouette
— while a grabbable body is by definition lying in some other shape entirely. The
normalized bone nodes ARE where the body visually is, on any rig."
Lesson: small deliberate targets and skinned bodies both want ray-to-point picking.
And markers must not be raycast INTO (`build.js:374-376`).

**One merged comp entry per gesture — a naive write eats every other anchor**
`client/lib/build.js:449-456`
"comp data replaces wholesale and a naive write would silently eat every OTHER anchor
on the thing."
Lesson: wholesale-replacement components require read-modify-write, with the inverse
on the undo stack.

**A click on a plank MID-SWING must not bake the swing's phase into the anchor**
`client/lib/build.js:483-503`
"carry the hit point back through the part's displacement to where it sits at rest
(the inverse of mountTransform's ride)." Only parts a motion comp actually names
count: "naming arbitrary mesh nodes would freeze junk into the log."
Lesson: authoring against an animated thing must invert the animation before
recording.

**Undo is inverse ENTRIES**
`client/lib/build.js:335-343`
"history stays append-only, which is what keeps the log replayable and the world
forkable." Stack capped at 40. Undo works outside edit mode: "you may only notice
the mistake after you have gone back to looking."
Lesson: undo in an event-sourced world is a new entry, never a retraction.

**Idly exploring the sky wrote 53 permanent entries**
`client/lib/build.js:1002-1014`
"Presets and dropdowns used to send a verb on every click while the sliders only
previewed — so idly exploring the sky wrote 53 permanent entries into one world's
log, every one of which replays for every future joiner. The log is history; trying
things out is not." Everything previews; only ✓ commits.
Lesson: in an append-only world, exploration must be local. One commit per intent.

**A preset that stashed a slider key shadowed that slider for the session**
`client/lib/build.js:1016-1029`
"`local` carries the NON-slider knobs… The sliders own their own keys and must WIN
over local — otherwise a preset that stashed a slider key (hours) into local would
shadow the time slider for the rest of the session: moving it wrote a.hours, but the
stale local.hours overrode it, so lighting stopped changing after you pressed dusk
(or any preset). Apply local first, then let the sliders assert."
Lesson: define precedence between overlapping state bags explicitly, in one place.

**Clearing a field stashes `undefined`, not `null`**
`client/lib/build.js:1167-1171`
"the JSON the verb carries simply drops the keys (a null would linger in the fold)."
Lesson: `undefined` deletes through JSON; `null` persists.

**An empty search box shows curated starters, not the whole library**
`client/lib/build.js:925-930`
"otherwise opening the panel greets you with four varieties of apocalyptic rubble."
And previews matter: "Picking from a list of
`stylized_yucca_joshua_tree_desert_cactus_plant.glb` is not picking; with the
previews it becomes an actual catalog" (`server/server.ts:1758-1762`).
Lesson: a catalog needs curation at zero query and images at all times.

**Frame resize band: R-tuned at 2px, widened to 4 after a live receipt**
`client/lib/frames.js:18-34`
"_BAND = 4, _REACH = 6 — band R-tuned 17:23 at 2, widened to 4 after antra's live
receipt (edge target was ~8px total and half of that hung in the air)." And:
"_CORNER = 15 — the corner is the hardest 2D target on the frame and USED to be the
intersection of two 2px bands — invisible in practice. It gets its own square, sized
like the old SE grip." Content always wins: "we test the real element under the
pointer, not geometry alone."
Lesson: hit targets need live receipts, and a 2D corner needs its own region rather
than the intersection of two 1D bands.

**Release the button outside the browser and `pointerup` never arrives**
`client/lib/frames.js:104-111`
"so `_resizing` stays true and the move/up listeners stay installed — hover detection
and all future resizes are dead until reload. (The title-bar drag path has always
taken pointer capture; this one was written without it. Found in review.)"
Lesson: one idempotent `finish` shared by pointerup, pointercancel and window blur —
and take pointer capture.

**A hidden element measures zero**
`client/lib/frames.js:208-212`, `:318-322`
"so a frame created hidden never got a real position — it has to be fitted the first
time it becomes visible." And: "The anchor was computed from the BODY height, but a
frame is also a title bar and whatever padding its content carries — so a
bottom-anchored frame hung its composer off the screen. Measure once it exists and
pull it back."
Lesson: never compute layout from a hidden element, and measure the whole box.

**A module's markup and its layout must travel together**
`client/lib/audiopanel.js:22-28`
"Found live 2026-08-06 (R, in-headset): the sp-row/sp-label classes came from the
lab's panel framework and were never extracted with this file, so nothing upstream
defined them — the mic meter (an inline span with flex:1) collapsed to a 2px vertical
line, which is just its threshold marker with zero meter behind it."
Lesson: a component that carries its own markup must carry its own CSS.

**Two controls showing two different states while looking like one**
`client/lib/audiopanel.js:118-128`
"'hear voices' is what you HEAR — the same bit the 🎧 glyph toggles, so the two
controls can never disagree about the world you are in. (Field report 12:43: toggling
the headphone left this row stale…) Ticking it from a fully-revoked state grants
consent as well, exactly like the glyph, so the box is never a dead end."
Lesson: two surfaces for one bit must read from that bit and both be able to set it.

**If the label has to be explained, the label is wrong**
`client/lib/audiopanel.js:143-150`
"The wording leads with what you GET (no connection, no cost) rather than with the
mechanism, because 'refuse inbound audio' reads as a second mute to anyone who has
not thought about the wire. (Field note: a reader asked what it affords over
muting — if the label has to be explained, the label is wrong.)"
Lesson: label the consequence, not the mechanism.

**ONE palette for both glyphs — the difference was INK COVERAGE, not the hex**
`client/lib/mictoggle.js:18-30`
"They sit side by side and are read as a pair, so any divergence reads as a state
difference that is not there (field report 12:43: the off-states looked noticeably
unalike). The apparent weight difference was never the hex — it was INK COVERAGE: the
headphone carries two filled earcups and a long band, the mic is thin strokes with
air between them, so identical stroke colour lands heavier on the ear. Equalising by
giving the heavier glyph a slightly thinner stroke, which matches perceived weight
rather than nominal colour."
Lesson: match perceived weight, not nominal colour, for paired glyphs.

**A poll is the wrong instrument for "follow this box"**
`client/lib/mictoggle.js:151-158`
"This used to re-measure on a 1s setInterval, which is exactly what it looked like:
the mic visibly chased the panel for a second or two whenever the hud changed width
(R, 01:00 — 'doesn't ride with it cleanly... always lags a second or two')…
ResizeObserver fires in the same frame the box changes… The interval remains only as
a slow safety net for changes neither observer sees (font swaps, zoom)."
Lesson: use the observer for the event; keep the poll only as a backstop.

**Mouselook: Esc can never be the way back IN**
`client/lib/controller.js:123-142`, `:162-172`
"Esc always frees the cursor. One-way by browser law: every engine hardcodes Esc to
RELEASE a pointer lock and refuses to let a page grant one from it, because that is
exactly how a hostile page would trap a cursor. So Esc can never be the way back IN —
hence M. M rather than C: M is the name of the mode and matches Second Life's
binding, while Ctrl+C is the most-pressed shortcut on any machine and a guard
regression there would bite someone mid-copy. Clicking the world does NOT enter
mouselook. It used to, and that made cursor mode nearly unusable — every click on
anything dropped you back into capture, so you could never interact freely." And:
"An Esc-initiated unlock leaves the canvas unfocused, and Chrome wants
requestPointerLock from a focused target — a bare window keydown listener was not
enough to get back IN (R, 00:33). Focus first, then ask; and if the browser refuses
anyway, say so instead of failing silently, which is how this hid in the first
place."
Lesson: browser-enforced one-way transitions must be designed around, not fought;
and a silently-refused API call hides its own bug.

**Everything is gated on the event actually being on the canvas**
`client/lib/controller.js:97-101`
"It used to be bound to the window with no target check, so dragging a sky slider spun
the camera and scrolling the palette dollied it."
Lesson: global input listeners need a target check.

**A held key with the window unfocused stays "down" forever**
`client/lib/controller.js:62-63`
Lesson: clear the key set on blur.

**Hysteresis on first/third person: a single threshold is nauseating**
`client/lib/controller.js:183-190`
"Enter FP under 0.4m, don't leave until past 0.7m. A single threshold flickers 1P/3P
at the boundary — nauseating, and loudest for exactly the motion-sensitive people a
hangout world shelters."
Lesson: any mode boundary crossed by a continuous control needs hysteresis.

**#75: a fixed `root + 1.52` camera sat INSIDE the resident's own head**
`client/lib/fp_view.js:1-24`, `client/lib/controller.js:498-502`,
`client/lib/net.js:613-621`, `client/main.js:348-353`
"Issue #75 is what happens when the guess drifts from the rig: a mounted resident's
fixed `root + 1.52` camera sat INSIDE their own head geometry, and nothing hid that
geometry, so the watchtower view was their own petals." The contract: eye anchors on
the LIVE rig (head bone, else mesh bounds), the whole own visual root is hidden,
other bodies untouched, and "a rig offering neither anchor fails with a message
naming the rig, not a frame from inside its chest." Also: "The camera lives in
updateMe, which we skip while seated — so drive it here too (the ragdoll path learned
this the same way), or it freezes on the frame you sat down and never rides the
socket."
Lesson: one module owns the eye/exclusion contract; every control path that bypasses
the normal update must still drive the camera. `FP_FORWARD` 0.16, `FP_EYE_LIFT` 0.06,
`FP_GAZE_AHEAD` 8, `FP_GAZE_DROP` 0.6, `FP_BOUNDS_EYE` 0.85.

**An exclusion that survived a throw would blind every other viewer**
`client/lib/fp_view.js:84-90`, `:98-106`
"The body is hidden strictly around synchronous render() and restored in finally."
An async render is rejected explicitly: "async rendering needs a separately designed
re-entrant exclusion."
Lesson: global visibility mutations need `finally`, and re-entrancy must be refused
rather than assumed.

**Photo mode: a camera that stops on the exact frame reads as a debug flythrough**
`client/lib/controller.js:408-437`
"the eye is a physical object and an operator's hands have mass. Everything here
eases with an exponential half-life — frame-rate independent (no `dt` term in a lerp
factor, which silently changes feel between 60 and 144Hz), and it cannot overshoot
after a long frame the way a spring would." `MOVE_TAU` 0.22, `LOOK_TAU` 0.09,
`FOV_TAU` 0.16, `LOOK_TAU_FINE` 0.5, `FINE_MPS` 2.5 ("absolute, not a fraction").
Also: "diagonals used to travel ~1.4× faster than the cardinals" (`:480-481`).
Lesson: `lerp(a, b, k*dt)` is frame-rate dependent; use `exp(-dt/tau)`. Normalize
diagonal input.

**A slow walk, because placing a chair at 1.55 m/s is a fight**
`client/lib/controller.js:276-279`
Lesson: precision positioning needs a creep modifier.

**Typing is never walking**
`client/lib/controller.js:51-57`, `client/lib/chat.js:668`,
`client/lib/build.js:895`
`e.stopPropagation()` on chat input; search inputs too.
Lesson: every text field in a game world needs an explicit input firewall.

**Never touch scrollTop from inside the scroll handler**
`client/lib/chat.js:644-653`
"snapping back to the end while the reader is inside the near-bottom band traps them
there (scrolling up needed a >48px jump in a single wheel event to escape).
Stick-to-bottom on NEW content is handled at append time."
Lesson: stick-to-bottom belongs at append, not at scroll.

**Grow the top without moving what the reader is looking at**
`client/lib/chat.js:155-160`
`anchorH = scrollHeight - scrollTop` before prepending, restored after.
Lesson: prepending content requires an explicit scroll anchor.

**"showing 40 of 0" would be worse than saying nothing**
`client/lib/chat.js:113-131`
"`total` is unknown for worlds folded before it was recorded… saying 'there is more'
is true either way."
Lesson: degrade a precise message to a true vague one, never to a false precise one.

**A spoken utterance is an INTERVAL: seq #1052/53 landed same-second, interrupter first**
`client/lib/chat.js:199-232`
"Causal placement (R, 16:30, verified against the world log — seq #1052/53 landed
same-second, interrupter first): a spoken utterance is an INTERVAL. Its record
arrives when the voice stops, but it BEGAN before the interrupt that cut it… Server
order stays arrival-truth; this is display causality only." And the grouping bug this
created: "the inserted line's OWN grouping must be re-derived from its visual
predecessor. buildLine computed it against chronological arrival (lastAuthor), and
the two disagree exactly when this branch runs — a 'cont' line landing under another
speaker renders their nameplate over these words. (2026-08-05, 'your line was
credited to me'; repro: exultation/tools/repro-stale-t0.mjs.)"
Lesson: reordering display rows invalidates every property derived from row
adjacency. Re-derive them from the visual neighbour.

**System lines pass THROUGH a grouping run**
`client/lib/chat.js:277-281`
"an act narration mid-paragraph (an agent's tool use between spoken sentences)
shouldn't force the name to reprint on the next sentence. Only a real change of
speaker or the window ends a group. (Live observation, Rabscuttle 14:53.)"
Lesson: interleaved metadata must be transparent to grouping.

**ONE place turns a landed line into reader-facing accounting**
`client/lib/chat.js:240-255`
"for both new and merged rows — a mention arriving in a later spoken sentence counts
exactly like a mention arriving as its own line, and nothing counts twice (the old
split paths could double-increment when the frame was hidden AND the log was scrolled
up). `seen` means the reader is actually looking: frame visible, not collapsed,
pinned to the bottom. (Sol review, PR#7.)"
Lesson: unread accounting must have exactly one implementation, and "seen" is a
conjunction of three facts.

**A whisper shows in BOTH the conversation tab and 'all'**
`client/lib/chat.js:720-724`
"WoW puts whispers inline in the main window by default for a good reason: a private
message you never see because you were on another tab is worse than no tabs at all.
The tab is for following a thread, not for hiding it."
Lesson: filters must not be able to hide addressed messages.

**In a conversation tab, plain typing is a whisper**
`client/lib/chat.js:706-711`
"you should not have to prefix every line of a private conversation with a command,
and you REALLY should not be able to say something aloud while looking at a window
that reads like a private one."
Lesson: the composer's destination must match what the window looks like.

**Untrusted text never goes through innerHTML**
`client/lib/chat.js:47-49`
Lesson: build a DocumentFragment; the linkifier and mention marker are the only
transformations.

**A mention wears the colour of the person mentioned**
`client/lib/chat.js:76-79`
"so '@fable' in the text and fable's own lines are visibly the same person. Mentions
of YOU keep the amber ping styling — being addressed outranks being named."
Lesson: colour identity must be consistent across every place a name appears.

**Twelve colours, six people: a ~78% chance two collide (lyra and antra both #ffab6b)**
`client/lib/core.js:208-271`
"A wall of chat all in one colour makes you read every name to follow a
conversation… A curated palette rather than hue = hash % 360: hand-picked entries are
all legible on the dark panel and reliably distinct from each other, which a
continuous hue wheel is not (it wanders through muddy olives and near-blacks at fixed
lightness). Amber and mint are deliberately absent — those are the UI's own words for
'you were mentioned' and 'link/accent', and a person wearing them would be reading as
punctuation." And: "Hashing alone is not enough. With twelve colours and six people
in a room there is a ~78% chance two of them collide… (Measured, not theorised: the
first build put lyra and antra both on #ffab6b.) So the hash is a PREFERENCE, and the
people actually present negotiate. Every client runs the same assignment over the
same roster in the same order, so the answer is identical everywhere without a byte
crossing the wire… People who have left keep the colour they had — their lines are
still on the screen."
Lesson: a deterministic negotiation over a sorted roster is a zero-traffic consensus.
Reserve the UI's own semantic colours.

**A roster change repaints the scrollback**
`client/lib/chat.js:314-322`
"Without the repaint, a name that shifted would read as two different people up the
log."
Lesson: if identity colours can move, everything already rendered must move with
them.

**A fault inside the frame loop reports 60 times a second**
`client/lib/core.js:164-186`
"Identical messages are counted and re-reported on a decaying schedule instead of
flooding the console and the toast stack — the first one is the useful one, and the
hundredth actively hides everything else." (1st, then 2s, 10s, 60s…)
Lesson: error reporting on a per-frame path needs decay, not suppression.

**Voice is opt-in in BOTH directions, and "off" means no audio path exists**
`client/lib/voiceconsent.js:1-16`
"If you have not opted in, we do not answer the offer at all — 'off' means no audio
path exists, not 'an audio path exists and we discard it'. Cheaper, and it is the
honest reading of the word." Category doctrine: "the 🎧 toggle is a VOICE control…
Agent voice (TTS/captions) counts as a VOICE: a resident is a resident, and it would
be strange for a synthetic speaker to be unmutable when a human one is not."
Lesson: consent expressed structurally cannot be forgotten by a code path.

**sttConsent is TRI-STATE and must stay so**
`client/lib/voiceconsent.js:21-24`, `:104-115`
"null = never asked, true = accepted, false = refused. A boolean cannot tell 'not
asked' from 'said no', so a refusal would be re-prompted on the next mic-on — turning
a no into a recurring negotiation, which is the opposite of asking once (review
catch)." And: "'no' is an answer, not an invitation to ask differently next time."
Lesson: any remembered consent needs three states.

**STT ships your audio to a third party — gate it separately from the mic**
`client/lib/voiceconsent.js:89-94`, `:117-125`
"Someone toggling a microphone in a world does not expect their room to be
transcribed by a third party. So STT is gated behind an explicit, revocable,
plainly-worded consent — asked once, remembered, never assumed from the mic toggle."
Lesson: name the actual consequence in the prompt, and never bundle a
data-egress consent with a local capability.

**Hush is a GAIN; revoking consent is the teardown**
`client/lib/voiceconsent.js:51-58`, `client/lib/voice.js:409-419`
"the stream keeps arriving and keeps advancing, so unmuting drops you back into a
sentence already in progress — the way you rejoin a human voice you had stopped
attending to. (R, in world 12:11: the deafen was killing the utterance and starting
the next one — a cut, not a mute.)"
Lesson: silence and consent are different questions; the one people press often must
be the cheap one.

**LINEAR, not exponential: a faint voice hung for seconds**
`client/lib/voice.js:422-442`
"An exponential approach spends most of its life crawling through the quiet end —
exactly where an ear is most alert to 'is that still on?' — so a mute built from
decaying multiplications leaves a faint voice hanging for seconds. Measured: the old
curve was still nonzero at 2280ms and only crossed -40dB at 1140ms (field report,
12:35: 'I can hear a really faint version of your voice for a number of seconds'). My
-40dB snap threshold was itself far too quiet to be inaudible. A mute should travel
at a constant rate and ARRIVE. Exponential still suits DISTANCE — a physical fact
rather than an intention." `FADE_MS = 700`, 60ms ticks, "lands exactly, no residue".
Lesson: intentional changes are linear and must arrive; physical falloff is
exponential. Two clocks, deliberately (300ms distance pass, 60ms fade pass) —
"a gesture quantized to 300ms steps feels like a fade drawn with a ruler."

**`stop()` on a remote track is a ONE-WAY DOOR**
`client/lib/voice.js:100-131`
"FAIL CLOSED, but REVERSIBLY. This previously called t.stop() on their track, which
is a ONE-WAY DOOR: per mediacapture-streams stop() ends a track permanently, and per
WebRTC-PC §5.3.1 `receiver.track` is never reassigned — so that transceiver's remote
track was gone for its whole lifetime. No renegotiation, no direction change, and no
second ontrack could bring it back. Consenting AFTER someone's track arrived left you
permanently deaf to that person while still audible to them: the one-way report of
2026-08-08, order-dependent, which is why it read as a who-joined-first problem.
stop() also never stopped the RTP on the wire, so it bought no bandwidth — it only
removed the way back. `enabled` is the mechanism the spec provides for a reversible
refusal."
Lesson: a refusal must be reversible. Check the spec for which primitive is
permanent.

**`p.stream` is set BEFORE the consent bail**
`client/lib/voice.js:119-127`
"It is what peerLevels()/mouth animation read, and a refused-then-consented track
recovers its AUDIO via reenableInbound() but would never come back through here — so
leaving it unset behind the bail made the repaired path permanently mouth-blind.
Attaching and naming the stream are one act; only PLAYING is gated. (Mica, #63
review.)"
Lesson: when you add a repair path, audit every field the original path set.

**The offer DID ask: `offerToReceiveAudio: true` with receive off**
`client/lib/voice.js:39-49`
"the whole consent model expressed structurally: not a check that code paths must
remember to consult, but the shape of the connection itself, so there is no path —
offer, answer, or renegotiation — that can negotiate media a direction did not
permit. (Review catch: offerToReceiveAudio:true asked for inbound audio even with
receive off, and an answer could then deliver it. The old comment claimed the offer
'cannot deliver audio we did not ask for' — but the offer DID ask.)"
Lesson: a comment asserting a safety property is not the property. Encode it in the
transceiver direction.

**#34: a consent-dropped offer wedged the sender in have-local-offer until reload**
`client/lib/voice.js:180-203`
"an offer that arrives while receive is off is dropped BEFORE a peer exists —
correct — but the sender is then wedged in have-local-offer, and every heal path
skipped it (renegotiate bails on non-stable, roster re-offers only unknown ids).
Deadlock until reload. So a receiver who turns consent ON announces it, and a
live-mic sender rebuilds the wedged leg. This runs BEFORE the consent gate on
purpose: it negotiates THEIR inbound, not ours." (matrix-proven 2026-08-06)
Lesson: every "drop it" branch needs a heal path, and the wake signal must run
before the gate it is healing around.

**ICE candidates pass the gate: "works in the lab, dead in production"**
`client/lib/voice.js:204-217`
"our offer was sendonly, so the remote's candidates can only complete that sendonly
path — no inbound audio route exists for them to open. Dropping them here
(pre-2026-08-07 behavior) silently broke every mic-only sender whose peer couldn't
reach us directly: connections survived ONLY via peer-reflexive discovery
(host/srflx checks arriving unsolicited), which works on localhost/LAN and fails
through TURN or across real NATs — 'works in the lab, dead in production', wedged in
checking forever."
Lesson: a gate justified by an assumed structural property must state the property.
LAN topology hides ICE bugs.

**ICE never creates a peer**
`client/lib/voice.js:218-223`
"candidates only make sense for a negotiation we already own. A stray candidate
(early trickle before an offer we dropped, or residue from a peer generation
dropPeer() discarded) must not conjure a fresh pc — flushing old-generation
candidates into a replacement pc poisons its checks (Mica's contamination rule,
08-07)."
Lesson: signalling state has generations; never mix them.

**Per-peer signal serialization**
`client/lib/voice.js:224-232`
"two concurrent onRtc invocations for the same peer interleave across their awaits
(offer A setRemote → offer B setRemote → A answers → B's createAnswer fires in
'stable'). Chain errors handled per-link so one failed signal doesn't wedge the
queue."
Lesson: async signalling per peer is a queue, not a set of independent handlers.

**#36: single-flight, or two offers race into glare against ourselves**
`client/lib/voice.js:150-156`
"recvReady can arrive while this peer's FIRST offer is still inside createOffer —
signalingState hasn't left 'stable' yet, so the state check alone lets a second offer
start concurrently and the two race into glare against ourselves. One offer in flight
per peer; a request that finds one in flight simply yields to it — any offer that
lands satisfies a newly-consented receiver."
Lesson: `signalingState` is not a lock. Add an explicit in-flight flag.

**Glare: the LOWER id's offer stands, deterministically**
`client/lib/voice.js:236-241`
"both sides offered at once — the LOWER id's offer stands, the higher id rolls back
and answers (deterministic, no extra messages)."
Lesson: resolve glare from data both sides already have.

**Muting yourself silently deafened you for an unbounded time**
`client/lib/voice.js:272-283`
"SEND state only. Going quiet must not deafen you: listening is a separate permission
(review catch — the old teardown dropped every peer, including inbound legs, which
then had no trigger to re-offer until the next roster event, so muting yourself
silently deafened you for an unbounded time). We remove OUR track from each peer and
keep the connection alive; if we are not listening either, THEN the peer has no
purpose and comes down."
Lesson: send and receive are separate permissions all the way down to the teardown.

**Revoking "I hear you" must not silently revoke "you hear me"**
`client/lib/voice.js:371-396`
"we re-offer, so our outbound (which they consented to) survives." And the re-offer
is SENDONLY "so the re-offer cannot smuggle back the inbound we just refused (review
catch)."
Lesson: state each direction's consent on every renegotiation.

**Presence at speech onset comes from the LOCAL analyser (#26)**
`client/lib/voice.js:313-317`, `client/lib/voiceconsent.js:79-87`
"deliberately not from SpeechRecognition (#26 review): declining vendor
transcription must not mute your presence." Hysteresis at 60% of floor, 1.5s
refractory. `micFloor` default 0.04 — "(R 17:19: typing sounds pinged the ear)".
Lesson: never make a presence signal depend on a service the user may refuse.

**The probe it "read" never existed, so its numbers were structurally zero (#36)**
`client/lib/voice.js:445-449`
"Real per-peer inbound-audio stats, for the external browser matrix — the probe it
previously 'read' (__voicePcs) never existed, so its inbound numbers were
structurally zero."
Lesson: a test probe that reads a nonexistent global passes forever. Assert the probe
itself.

**A peer can be perfectly audible while its mouth never moves**
`client/lib/voice.js:467-473`
"`peerLevels()` skips any peer without one, and it does so silently — so a peer can
be perfectly audible while its mouth never moves, a half-repair visible only to
everyone ELSE. Exported so that gap is assertable (and greppable in prod) rather than
only observable by watching a face that should be talking."
Lesson: make invisible-to-you failures assertable.

**Being SHOVED is a separate consent from being POSED**
`client/main.js:552-574`
"Posing is directorial — someone else deciding what your body expresses — and stays
opt-in. A shove is the world's rough-and-tumble: it moves you without speaking for
you, so it defaults ON (the first one tells you how to refuse). Both are still only
requests: my client applies them to my body, or doesn't." `MAX_PUSH = 6` m/s: "The
sim has its own stability cap; this one is about the WORLD — nobody gets to launch a
body across the map no matter what numbers they put in a message."
Lesson: separate consents for separate acts, with defaults set by what the act
actually takes from you. Cap at the trust boundary AND in the sim
(`ragdoll.js:1151-1161`).

**A limp body does not drop straight down**
`client/main.js:283-292`
"its support fails and the mass above the feet keeps going — and one that DOES drop
straight down has nowhere to put its leg length, so it folds its knees into their
stops under its own weight and then kicks them back out. You fall the way you were
facing, harder the faster you were moving."
Lesson: toppling and pancaking are different failures; the topple is both cheaper
and more correct (see §10's `_topple` measurements).

**Park the bones and stop the clip BEFORE constructing the sim**
`client/main.js:296-302`
"Both of the sim's reference skeletons are read in here — the neutral rest it
measures its limits against, and the live pose the tumble starts from — and neither
may still have the walk cycle in it."
Lesson: ordering between "go limp" and "build the sim" is load-bearing.

**A dragged body's velocity only exists as the difference between frames**
`client/main.js:459-462`
"Sampled here so the moment the hand lets go the sim can start with the motion the
body already had, instead of at a dead stop."
Lesson: a stream with no sim behind it still has velocity; measure it.

**Standing up tears every nail out**
`client/main.js:493-498`, `:517-529`
"Session-scoped on purpose: pins are presence, not history." And freeing a nail with
no live sim wakes one "so the body sags from what remains and settles honestly."
Lesson: the body is always its own final authority.

**Emotes were invisible unless you read the help**
`client/main.js:933-937`
"On a performance platform the gestures should be somewhere you can see them."
Lesson: an affordance nobody can discover is indistinguishable from one that does
not exist (also `client/main.js:403-405`).

**When nothing is in reach but a seat exists further out, SAY so**
`client/main.js:378-392`
"the silent ground-sit fallback read as 'sitting is broken' to anyone standing four
meters from a swing they could name but not see."
Lesson: a silent fallback to a lesser behaviour reads as a bug.

**Nearest seat is distance to the SOCKET's world point**
`client/main.js:356-360`
"a swing's pivot frame is not where you sit, and on a ferry the helm can be a
deck-length from the hull's center. Every slot competes, not just the first."
Lesson: measure to the affordance, not to the entity origin.

**Selecting a thing opens its row; selection must never be hostage to a fetch**
`client/lib/build.js:135-138`, `client/lib/scenegraph.js:275-280`
"the scene panel follows the mouse: selecting a thing opens its row… scrolled into
view." And: "So paint now: selection must never be hostage to [an] async roster
fetch."
Lesson: render the local truth immediately; let remote data fill in.

**Don't rebuild the DOM under the pointer**
`client/lib/scenegraph.js:95-99`
Lesson: interior state changes update in place.

**No cycles: walking up from the parent must not meet the child**
`client/lib/scenegraph.js:298-302`
Lesson: scene-graph reparenting needs an ancestry check.

**Glue where it stands, never jump**
`client/lib/scenegraph.js:17-20`, `AGENTS.md:405-409`
`scene.attach` preserves the world transform; the mount verb's `dismount` STAMPS the
absolute pose it rests at.
Lesson: house rule 4 — plane transitions stamp absolute state.

**Crash breadcrumbs go over the world socket, not localStorage**
`client/main.js:56-70`, `server/server.ts:2483-2490`, `:1876-1880`
"the server rings the last 40 per client and prints them when the socket dies — the
only observer a renderer crash cannot take down with it (same-origin tabs share the
renderer process, and localStorage writes from a dying renderer are discardable)."
Lesson: a dying renderer cannot write its own postmortem. Send it somewhere else
first.

**Draw the COLLIDERS and the SOLVER's body, not the meshes**
`client/lib/debug.js:1-14`, `:170-179`
"Where the two disagree is the whole point." And: "Real capsules, not centre lines…
Drawing the axis instead was showing the one thing that was never in doubt and hiding
the thing that matters: the thickness is what stops a forearm from passing through a
torso, and you cannot see interpenetration in a line."
Lesson: a debug view must render the model the solver integrates.

**A helper's `updateMatrixWorld` silently undoes positioning**
`client/lib/debug.js:100-110`
"The helper's updateMatrixWorld copies the SOURCE mesh's matrix and decomposes it
over its own transform — positioning the helper itself is silently undone every
frame. Sync must therefore move this mesh, not the helper node. (Symptom fixed: every
exact wireframe drew at world origin in the entity's model frame, which went
unnoticed for as long as the only exact entities were room-scale spawns sitting AT
the origin.)"
Lesson: a bug hidden by a coincidence of the current content is still a bug.

**The number I have got wrong more than once is on screen**
`client/lib/debug.js:443-446`
"if a limb looks twisted and its row says 0°, the measurement is what is broken."
Lesson: put the metric next to the thing it claims to describe.

**Orrery bytes never pass through this client**
`client/lib/conjure.js:1-8`
"Orrery pushes finished GLBs to the [store]."
Lesson: keep large-asset generation off the client's heap.

**A bundler must not try to resolve `/library/...`**
`client/lib/flora.js:29-34`
"The specifier goes through an indirect import so a BUNDLER treats it as runtime
data: `/library/` exists only on the sequencer at run time, and a literal dynamic
import made the bundle fail trying to resolve it."
Lesson: runtime-only specifiers need an indirection even in a no-build client.

**A missing map degrades inside the module, never throws**
`client/lib/flora.js:53-72`
"missing files warn + degrade, never throw."
Lesson: optional assets must be optional at the call site too.

**Missing files are reported, not fatal**
`client/lib/assets.js:320-324`
"a world package that references an asset we failed to fetch should degrade, not
abort the whole sky."
Lesson: partial priming is a degraded sky, not no sky.

**Bounded-concurrency map: prefetch must not be serial, nor open 50 sockets**
`client/lib/core.js:200-206`
Lesson: name the two failure modes a concurrency limit sits between.

**Spectators start a notch lower**
`client/lib/core.js:94-96`
"an audience laptop's job is 30fps for an hour, not maximum sharpness."
Lesson: default quality by role.

**A toast for a broken image is better than an empty box**
`client/lib/ui.js:344`
"rather than an empty box that reads as a broken image."
Lesson: placeholders must look deliberate.

**STT never learns voice exists on the mention path**
`client/lib/stt.js:1-6`, `:40-43`
"mention/approach/whisper mechanics never learn voice exists" and a transcript "must
never re-perform the utterance as a fresh speech event."
Lesson: a new input modality must land on the existing plane, not beside it.

**The body-physics engine is a CHOICE**
`client/lib/bodysim.js:1-9`
"Two engines, one interface… A world mod can swap engines through EW.bodysim: the
lease thesis applied to our own house physics."
Lesson: interface parity is the contract; downstream must not be able to tell which
engine answered.

**A door that never opens must SAY so**
`client/lib/bodysim.js:18-29`
"Reporting 'loading' forever is indistinguishable from a toggle that does not work,
and that ambiguity cost a full round of debugging the wrong engine."
Lesson: a permanent pending state is a lie. Report FAILED.

**A dropped optional argument is invisible in JS**
`client/lib/bodysim.js:44-53`
"seedVel is LOAD-BEARING and was silently dropped here until 2026-08-04: main.js
hands the drag-release handover through this door as the 4th argument (`msg?.sim ??
dragVel`), and a 3-parameter signature ate it. Both engines' snapshot()/seed paths
were therefore unreachable in the shipped client — every release reset the body to
zero velocity and re-baked the rendered bone positions as the new sim's shape, which
is what 'really bad with drags' was. A dropped optional argument is invisible in JS;
the parity suites never saw it because they construct the engines directly."
Lesson: a factory that forwards to a constructor must be tested THROUGH the factory.
Arity mismatches are silent.

---

## 10. Ragdoll and body simulation

**Single authority, not determinism**
`client/lib/ragdoll.js:1-18`
"The sync model is the whole point, and it is not 'make physics deterministic' —
that is unwinnable across machines. It is single authority: Only the body's OWNER
simulates… the owner streams the resulting sparse bone rotations through the presence
`pose` field — the exact channel a held pose already uses, so remotes render a
ragdoll with zero new receiver code: it is just a pose that changes every frame. When
it settles, the owner CAPTURES the final bones as a held pose… so a late joiner or a
reconnect gets the settled RESULT, never a replay of the tumble. So physics lives on
the presence plane (lossy, ephemeral, one authority) and its outcome becomes state.
The server never simulates and never sees a bone."
Lesson: choose authority over determinism, and reuse the existing channel so
receivers need no new code.

**Bones were BEADS: 100% shaft overlap on all 14 shipped rigs**
`client/lib/ragdoll.js:26-30`, `client/lib/debug.js:170-175`
"bones are CAPSULES, not beads. Colliding only the joints left every shaft hollow,
and limbs passed clean through the torso on all 14 shipped rigs (measured: 100% shaft
overlap)."
Lesson: a particle sim needs volume on the segments, not just the nodes.

**Verlet silently assumes every frame lasted as long as the last: 15.7% vs 54.6%**
`client/lib/ragdoll.js:32-36`, `:1204-1208`
"Verlet's inertia term is a POSITION delta, so it silently assumes every frame lasted
as long as the last one. Feeding it raw frame time made the physics a function of the
framerate: measured 15.7% peak bone stretch at 60fps vs 54.6% at 30fps, landing the
body 10m apart." Fixed step 1/60, `MAX_FRAMES = 4`: "A long hitch drops its backlog
rather than simulating a second of physics in one frame and exploding."
Lesson: fixed timestep, and drop the backlog rather than catching up.

**Absolute numbers tuned on one body are wrong on the next**
`client/lib/ragdoll.js:38-42`
"the shipped avatars disagree about nearly everything: heights run 0.63m to 1.53m,
rests run T-pose to A-pose, and half the rigs carry an upperChest + shoulder pair
between the chest and the arm."
Lesson: measure every anatomical quantity from the rig at construction.

**Every particle weighed the same and a forearm could hurl the torso**
`client/lib/ragdoll.js:106-108`
"Before this existed every particle weighed the same and a flailing forearm could
hurl the torso across the floor." (hips 12, chest 10, spine 8, legs 7/4, head 5,
arms 2.5/1.5, hands 0.5.)
Lesson: only mass RATIOS matter, and they decide who moves in a disagreement.

**Braces: a pure parent→child chain is a noodle**
`client/lib/ragdoll.js:89-95`
"the torso could shear and fold with nothing resisting it, which is most of what read
as 'no stiffness'. Bracing the trunk into a truss makes it behave like one body that
limbs hang off, and costs four distance constraints. Their rest lengths must come from
the NEUTRAL pose — unlike a bone, a diagonal's length changes with the pose it was
measured in."
Lesson: four diagonals buy structural rigidity, measured at neutral.

**Substeps: 31mm apart at 1 substep, 1mm at 2, and past 2 it stops paying**
`client/lib/ragdoll.js:126-136`
"Splitting the TIME step buys more than relaxing one big step harder, and costs the
same… It is worth most to framerate independence: at 1 substep the same fall landed
31mm apart at 30fps vs 120fps, at 2 it lands 1mm apart. Past 2 it stops paying — the
fleet needs a few relaxation passes per substep to keep the braced torso rigid, and
starving those to buy more substeps loses more than it gains. Both numbers are swept
in tools/rag-tune.mjs; this pair settles all 14 rigs, the neighbours settle 6 to 11."
Lesson: SUBSTEPS 2 / ITER 3 is a measured pair, and the neighbouring values fail on
most of the fleet.

**A hanging body needs far more passes: 69% stretch at 3, 23% at 8, 8% at 16**
`client/lib/ragdoll.js:137-146`
"Gauss-Seidel propagates tension one link per pass, so a chain held at one end and
loaded at the other stretches until the passes reach it — and a dragged body is
exactly that chain… A body stretched half again its length reads as the limbs
twisting, because the drive takes its directions from where the joints ended up. Only
paid while something is actually pinned." (`ITER_PINNED = 16`.)
Lesson: pay the extra iterations only in the configuration that needs them.

**A moving pin: peak joint speed 1.7 → 5.6 m/s, stretch 3% → 16%, twist 101° → 180°**
`client/lib/ragdoll.js:166-180`, `:803-840`
"A pin sets a joint's POSITION and, as shipped, nothing else — so in Verlet the
joint's velocity becomes the whole distance the pin travelled, every substep.
Dragging a body by one hand injects energy in proportion to cursor speed, and it comes
out as torsion." The fix carries the PIN's own velocity, scaled to the substep. Two
alternatives were measured WORSE: "making a pinned joint immovable (infinite mass) and
re-asserting the pin after the solve… the body then cannot satisfy its own bone lengths
while hanging, and stretch went to several hundred percent." And a teleport must land
dead: "Converting a jump into speed is how the first frame of a grab threw the joint
at 45 m/s, ten times worse than the bug it was fixing." (`PIN_JUMP = 0.12` m/frame.)
Lesson: in Verlet, position IS velocity. Any external position write must carry an
intended velocity, and a discontinuity must be landed dead.

**Settle was measured in FRAMES: 0.17s at 144Hz, 0.8s at 30Hz**
`client/lib/ragdoll.js:181-191`
`SETTLE_V` 0.06, `SETTLE_TIME` 0.4 s "(was 24 FRAMES, which meant 0.17s at 144Hz and
0.8s at 30Hz)". Hysteresis `SETTLE_RESET = 3`: "it takes real motion to restart the
clock, not a flicker." `DEADLINE = 8` s: "the contract is that a tumble always ENDS
as a held pose, it must never stream presence forever."
Lesson: every duration in a simulation belongs in seconds, and every settle test
needs hysteresis and a deadline.

**The old unsigned limit table did nothing on all 14 rigs**
`client/lib/ragdoll.js:194-204`
"anchored to `Math.max(0, rest - lo)` with a rest angle near zero, its entire `lo`
column resolved to 0° on all 14 rigs — the elbow's 'no hyperextension' did literally
nothing — while its shoulder entry resolved to a full 0..180° (no constraint at all)
on every A-pose rig, and its hip entry varied 3x across the fleet because it measured
against the sideways hip-to-thigh offset."
Lesson: verify that a constraint table actually constrains, per rig. Three different
questions needed three different kinds of limit (FLEX, BEHIND, CONE, HINGE).

**The signed spine limit is written and does not work: a foot at 24 m/s**
`client/lib/ragdoll.js:206-218`
"Choosing the limit by which way the joint leans needs the sign of the distal link's
lean, and near straight that vector is nearly zero and its sign is noise — so the
limit flickers between the two values, which is the same flip-a-constraint-every-frame
failure the hinge axis had, and it threw a foot at 24 m/s. Guarding the sign with a
deadband trades the flicker for a dead zone the joint simply sits in… Backbend is the
price." (Symmetric cones: fleet reaches ~30° of backbend where a body has ~15°.)
Lesson: a constraint whose sign is derived from a near-zero vector will flicker.
Prefer a wrong-but-stable limit and say so.

**Without BEHIND the fleet put its thighs 46° behind the body**
`client/lib/ragdoll.js:226-233`
"The CONE is circular, so it cannot express the one shape a hip actually has: a long
way forward, barely anything backward, and a moderate amount out to the side. Tilting
the cone forward far enough to bound the back also walls off abduction… the pose you
would need a chair to hold."
Lesson: one-sided anatomical stops need their own constraint kind, not a tilted cone.

**Twist derived against the WORLD drifts: upper arms ended 144° rolled**
`client/lib/ragdoll.js:264-287`
"parallel transport has holonomy, so a limb swung around a loop comes back rotated by
the solid angle it enclosed, and a tumbling arm encloses a lot of sphere. Measured
that way, upper arms ended a tumble 144° rolled and stayed there. Deriving it against
the PARENT does not drift, because it is a function of the current state and not of
the path taken to reach it. The one place that construction could fail is a bone swung
a full 180° from its parent, and the joint limits above already forbid that… The
limits are what make this well posed." Result: "limb twist at settle: 97° mean and
172° worst before, 0° now, on every driven bone but the pelvis."
Lesson: derive orientation from current state, never by transport. And note the
dependency: the limits are what make the derivation valid.

**A twist driver only ever ADDS twist**
`client/lib/ragdoll.js:151-160`
"measured, it only ever ADDS twist: mean limb twist 8° at 0, 18° at 0.05, 34° at 0.2,
with the worst case unmoved. There is no torque here for it to be answering, so the
honest value is zero." (`TWIST_LAG = 0`.)
Lesson: keep a measured-useless knob at zero with its measurements written down,
rather than deleting the mechanism.

**A limb swung onto its own reference snapped 178° in one frame**
`client/lib/ragdoll.js:374-382`
"Choosing a body axis per bone and re-deriving from it each frame has a hole: a limb
that swings onto its own reference has no roll defined against it, and falling
through to a different axis moves the roll discontinuously. That is not a corner case
— measured, the arms sat at dir·ref = 0.99 and snapped 178° in one frame. Carrying
the reference and only ever re-squaring it against the bone cannot flip."
Lesson: transport the reference; a fallback axis is a discontinuity.

**The body's forward is the cross product, verified on all 12 rigs with toes**
`client/lib/ragdoll.js:662-671`
"right across the pelvis, up the spine, forward as their cross product. That cross
product IS the anatomical forward — verified against the toe direction on all 12
shipped rigs that have toes, and it comes out correct for VRM 0.x and 1.0 alike
without needing to know which (they face opposite ways on +Z, and the pelvis
right-vector flips with them, so the cross product cancels the convention out). That
is the whole reason a knee can be told which way to bend." A degenerate frame keeps
the last good one: "a hinge whose handedness jumps on a degenerate frame is how a knee
decides it is bent 180° the wrong way."
Lesson: derive handedness from the rig so it is convention-agnostic, and keep the
last good frame.

**A constraint violated in the rest pose is a motor, not a constraint**
`client/lib/ragdoll.js:694-702`
"any pair whose NEUTRAL separation is already inside the combined radius is dropped as
anatomically overlapping — the chest capsule genuinely does overlap the neck capsule
on every real body, and a constraint that is violated in the rest pose is not a
constraint, it is a motor that would inflate the torso forever."
Lesson: measure exclusions per rig from the rest pose.

**Approach to sleep: it is always a hand**
`client/lib/ragdoll.js:736-744`
"without it the lightest, most distal particle keeps a residual millimetre of chatter
forever. It is always a hand: a hand carries 1/24th the pelvis's mass and sits four
links out, so it inherits whatever error the relaxation could not place anywhere else,
and a body that has visibly stopped goes on streaming presence to the deadline because
of it." (`SLEEP_DAMP = 0.8`.)
Lesson: island sleeping is not optional; the lightest distal particle is the one that
never settles.

**A hand travelling 0.11mm per step reported 0.54 m/s**
`client/lib/ragdoll.js:762-771`
"Measured as distance actually travelled this frame, not as the Verlet (p - prev).
Those are not the same number, and the difference is why no body used to settle: every
angular limit carries its correction into prev so the snap does not read as velocity,
and a joint parked ON its limit gets that carry from every pass, every step, forever.
The sum is a `prev` sitting a fixed distance from `p` that describes no motion at all
— a hand travelling 0.11mm per step reported 0.54 m/s and held the whole body above
the settle threshold to the 8s deadline."
Lesson: measure the settle test on actual displacement, not on the integrator's
internal state.

**A joint limit is a hard STOP, not a spring: 12.9 → 4.1 m/s**
`client/lib/ragdoll.js:971-985`
"Carrying the whole correction into prev keeps the velocity that drove the joint past
its limit — so the limit stores that energy and hands it back the moment the joint
unwinds. That is a body collapsing straight down, folding its knees into their stop
under its own weight, and then kicking its legs out from under itself: measured 12.9
m/s of foot after landing. Dropping the carry entirely is worse (the correction then
reads as fresh velocity and pumps), so take the middle, which is also the physical
answer: keep the position, and remove only the velocity component that was driving
INTO the limit. Contact, not restitution."
Lesson: neither full carry nor no carry — project out the violating component. The
two extremes fail in opposite directions.

**A correction worth half the bone must land DEAD**
`client/lib/ragdoll.js:942-968`
"handing the limb that displacement as velocity is how one bad frame becomes a
projectile. Land it DEAD — prev = p, zero velocity. Merely skipping the carry is the
opposite of that: it leaves prev behind while p jumps, so the next integrate reads the
whole teleport as speed and flings the limb (measured: hands orbiting at 5 m/s,
nothing settling). The two look similar and behave inversely."
Lesson: `prev = p` and "don't touch prev" are opposites. Know which one you wrote.

**Soft yield, not an exact snap and not a fixed cap**
`client/lib/ragdoll.js:1004-1009`
"An EXACT snap teleports a hard-overshot limb across the body in one pass and the
length constraints convert that into velocity; a fixed per-pass angle CAP starves
whenever another constraint contests the joint. A multiplicative yield does neither:
big violations correct fast (TUNING.YIELD^ITER per step), contested joints just lean
on the limit." (`YIELD = 0.5`.)
Lesson: multiplicative relaxation is the right shape for a contested constraint.

**A rebuilt hinge axis flipped: feet at 13 m/s, and all 14 rigs hit the 8s deadline**
`client/lib/ragdoll.js:1062-1069`
"Rebuilding projects the body's forward onto the plane perpendicular to the limb, and
that projection flips sign whenever the limb happens to line up with forward — which
for one pass means 'hyperextended by 180°', so the clamp slammed the foot across the
body. Carried into prev as velocity, that made the feet 13 m/s projectiles and no body
ever settled: all 14 rigs ran to the 8s deadline. Transporting the axis cannot flip
it." Deadband on hyperextension: "a limb resting exactly straight sits at flex 0,
where sign is numerical noise, and correcting on every flicker chatters instead of
settling."
Lesson: transport signed axes; never re-derive them per pass.

**Toppling vs pancaking: worst foot speed after landing 4.1 → 1.6 m/s**
`client/lib/ragdoll.js:505-521`, `:1108-1123`
"`lean` is a velocity in m/s, and it is applied weighted by HEIGHT: none at the lowest
joint, all of it at the highest… A uniform shove (what this used to be, on the one
code path nothing ever called) does not topple anything; it slides the whole body
sideways and leaves it to pancake straight down. A vertical pancake has nowhere to put
its leg length: both ends of a 0.8m leg end up on the floor, so the knee folds until
it jams against its stop under the torso's whole weight, and then unwinds. That is the
'lands on its butt, then the legs kick out' flop. Toppling spends the same energy on
rotation instead: measured across the fleet, worst foot speed after landing 4.1 → 1.6
m/s, and it settles sooner rather than later."
Lesson: height-weight the impulse. On a lying body the same rule rolls it away from
the push.

**A shove at 7.9s of an 8s window must not capture a body still in the air**
`client/lib/ragdoll.js:1151-1169`
"Restarting elapsed grants the new motion the same full window the original fall had."
Lesson: the deadline is per motion, not per sim.

**`hipsOffset` measured, never assumed: avatars range 0.55 to 0.91**
`client/lib/ragdoll.js:652-660`
"A hardcoded value put the pelvis ~25cm underground on a short avatar and folded the
whole body around a buried anchor. Taken from the NEUTRAL pose, since a walk cycle
bobs the hips and that bob would bake in as a permanent offset."
Lesson: measure from the rig, at neutral.

**A pinned body is CARRIED, so the root must follow the hips UPWARD too**
`client/lib/ragdoll.js:1237-1254`
"FALLING, the root only ever descends: Math.min against where it started guards
against a solve-overshoot frame popping the whole mesh above the ground. But a PINNED
body is being CARRIED — the hand may lift it, so the root must follow the hips upward
too, or the sim rises while the rendered body stays floor-bound (the pose curls into a
dangle a few centimetres up and stops — exactly what that looked like). Once lifted,
the ceiling moves up with the body."
Lesson: a one-directional clamp is correct for one mode and wrong for the other.

**A streamed POSE cannot carry velocity, so the receiver invented zero**
`client/lib/ragdoll.js:1171-1183`
"Handing a body from one machine to another has been lossy at every seam. A streamed
POSE is where the bones point — not where the particles are, and not what they were
doing — so a receiver rebuilding a sim from a pose has to invent the velocity, and
invents zero. That is why a body swung across a room and let go of settled on the
spot, and why a takeover began by discarding whatever the body was already doing. A
handover carries this instead, and the receiver continues rather than restarts."
Rounded to mm and mm/s: "far below what anyone can see."
Lesson: a handover must carry state, not appearance.

**Per FRAME, not per substep: sampling twice calls the second one motionless**
`client/lib/ragdoll.js:1214-1223`
"that is the rate the cursor moves it at — sampling per substep reads the same target
twice and calls the second one motionless."
Lesson: sample external input at the rate it actually changes.

**A dragged body's grab must keep the offset it had (PICK_R = 0.3)**
`client/lib/bodydrag.js:182-195`
"pickBody finds the joint nearest the ray, which is up to PICK_R away from it — so
pinning the joint straight onto the ray teleports the limb sideways the instant you
grab, by as much as the pick radius. You grab a wrist and the wrist jumps to your
cursor; nail it there and the nail lands somewhere you never pointed at."
Lesson: picking tolerance becomes a teleport unless the offset is preserved.

**THE REST FRAME IS THE JOINT FRAME**
`client/lib/rapierdoll.js:14-52`
"The first build of this engine was written against the belief that 'rapier's JS
spherical joints have neither motors nor limits (probed)'. That is true of the TYPED
WRAPPER only — SphericalImpulseJoint and GenericImpulseJoint extend ImpulseJoint, not
UnitImpulseJoint, so they carry no setLimits or configureMotor. The engine underneath
has both, per axis, and the raw handle is public… Measured on 0.19.3: a generic joint
given a 0.3 rad limit holds its swing at exactly 0.3 rad where the unlimited control
reaches 0.375. So every joint bound is now IN THE SOLVER. The previous build enforced
cones and twist with torque impulses applied after world.step(), which is a spring
outside the integrator — unconditionally able to pump. It was held down with angular
damping of 6 (the validated spike used 0.7), and the result was a body that could not
swing, could not roll, folded 172° through a 40° cone, and twisted 165° through a 45°
one. All of that machinery is gone." Every body is built REST-ALIGNED so one axis
vector means the same thing to parent and child; "the 90°/180° shoulder and hip frame
misalignment that produced 'everything is twisted' cannot be expressed"; and axes turn
with the body for free — "The old hinge axes were literal world constants and went
degenerate at east/west facing on 9 of the 14 shipped rigs."
Lesson: probe the engine, not the wrapper. A constraint enforced outside the
integrator can always pump; put every bound in the solver, and make rest the identity
so joint frames agree by construction.

**`setFromUnitVectors` is singular for antiparallel inputs**
`client/lib/rapierdoll.js:159-165`
"legs point DOWN, the reference is UP: THREE picks an arbitrary 180° axis, differently
per call, and a rest pose assembled from two arbitrary choices told muscle tone that
'rest' was a body folded into itself. Watched live: the whole skeleton scrunching into
a ball."
Lesson: never use a shortest-arc helper where the inputs can be antiparallel. Build a
deterministic frame.

**"Self intersection not respected" was never a collision-group bug**
`client/lib/rapierdoll.js:88-95`
"Without these the trunk is a pole: measured on mythos, shoulders attach 0.138 m off a
0.041 m-wide spine capsule and hips 0.053 m off, so arms and legs swung through empty
space where a chest and a pelvis should be. That is 'self intersection not respected' —
it was never a collision-group bug, there was simply nothing there to hit."
Lesson: check whether the geometry exists before debugging the filter.

**The torso bars were excluded from exactly the four pairs they exist for**
`client/lib/rapierdoll.js:513-530`, `:576-593`
"adjacent() excludes pairs by BONE NAME, and a bar spanning
leftUpperArm→rightUpperArm shares a name with each upper arm — so the shoulder bar was
excluded from both arms and the pelvis bar from both legs, i.e. from exactly the four
pairs the bars exist for. They only ever blocked the far limbs. Synthetic endpoint
names fix that: let GEOMETRY decide, not nomenclature." And the rest-overlap test:
"the bars are trunk VOLUME and the limbs attach at their ends, so at rest they always
graze — a touch-level test therefore excluded the bar from precisely the limbs it
exists to stop, and the trunk went back to being a pole. A grazing pair resting in
contact is fine; a pair buried in each other pumps contact energy every frame."
(`BAR_INSET = 0.18`.)
Lesson: name-based exclusion breaks for synthetic geometry. Exclude on DEEP overlap,
not on touching.

**A per-axis limit at 85° sits on the 90° degeneracy: 143° of shoulder swing**
`client/lib/rapierdoll.js:108-113`
"rapier's per-axis angular limits are an Euler-like decomposition, and a limit set AT
85° sits on the 90° degeneracy, where it stops holding — measured 143° of shoulder
swing against a 120° bound across the fleet. 69° per axis is well conditioned and the
square's diagonal still reaches 97°."
Lesson: Euler-decomposed limits degenerate near 90°; stay well below and buy the range
back elsewhere.

**Two per-axis limits describe a SQUARE, not a disc: 84.8° became 60.0°**
`client/lib/rapierdoll.js:660-686`
"setting each to cone/√2 makes the corner reach `cone` but caps a pure single-axis
swing — which is what 'arm hangs at the side' actually is — at 0.707·cone. Measured:
the shoulder's 84.8° became an effective 60.0°, and an avatar going limp from any
ordinary A-pose (arms 65-80° down from a T-pose rest) was therefore built OUTSIDE its
own shoulder limit. The solver annihilated that in one step: 15 m/s of linear velocity
and angular velocity pinned at the ANG_CEIL clamp, on frame one." Hence: "A JOINT MUST
CONTAIN THE POSE IT WAS BORN IN. Anatomy is a floor, not a ceiling… widen to admit the
build pose, and let tone pull it back toward rest instead… each axis widened by ITS
OWN excursion, never by the other's." (`BUILD_WIDEN = 0.12`.)
Lesson: a limit tighter than the pose the body is born in is a catastrophic impulse on
frame one. Widen to admit the birth pose.

**The torso is ONE RIGID BODY: 142° of swing against a 25° cone**
`client/lib/rapierdoll.js:371-377`
"the spine and chest joints could not be defended: a fold forms at impact faster than
any limit responds, then ground friction pins it — measured 142° of swing against a 25°
cone. Real ragdolls are built this way for this reason; the looseness READS in the head
and limbs, which keep their joints."
Lesson: some joints cannot be defended at impact speed. Make them rigid.

**Composing two shortest arcs independently leaves a spurious roll**
`client/lib/rapierdoll.js:420-430`
"A shortest arc is twist-free about its own axis, so composing two of them
independently leaves a spurious roll BETWEEN them: measured up to 45° of rotation on a
hinge's LOCKED axes at build (shoulder 45° down + elbow flexed 90°), which the solver
then annihilates in one step. Roll is not observable from bone positions — the Verlet
has the same blind spot and never drives twist either — so the consistent choice is to
give the chain ZERO relative roll by construction: each child's orientation is its
parent's, times the shortest arc taken IN THE PARENT'S FRAME."
Lesson: build orientations down the chain, in the parent's frame.

**A missing `neck` silently detached BOTH shoulders and the head**
`client/lib/rapierdoll.js:501-509`, `:636-644`, `:378-382`
"bodyOf is populated from each segment's START bone, so 'chest' only got mapped if the
chest|neck segment survived — and VRM makes `neck` optional. On a rig without one,
chest|neck and neck|head both drop out, 'chest' goes unmapped, and every joint hanging
off it (BOTH shoulders, and the head) is silently skipped: the arms and head become
free rigid bodies that tumble away on the first impulse. Detaching a limb is never the
right answer to a missing bone." And: "A skipped joint is a DETACHED body part, which
is the loudest possible physics failure and used to happen in total silence." Also the
chest synthesis: dereferencing an unsynthesizable chest "threw, which bodysim.js would
have swallowed into a silent verlet fallback."
Lesson: an optional rig bone must resolve to something. Warn loudly on a skipped
joint, and never let a fallback swallow a construction error.

**Anchors from each body's own rest geometry put 115mm between them**
`client/lib/rapierdoll.js:610-622`
"ONE world point, mapped into each body through that body's ACTUAL build-time
transform. This is zero initial constraint error by construction, whatever the frames
are — which matters because the torso is rest-SHAPED (a rigid trunk cannot reproduce a
bent live spine), so its idea of where the shoulder is and the arm's idea are not the
same point. Deriving each anchor from its own body's rest geometry instead put up to
115 mm between them, and the solver answered that error with an impulse: peak angular
velocity pinned at the 20 rad/s ceiling within six frames. Anchors are POSITION; the
rest-aligned frames above are ORIENTATION. They are independent."
Lesson: derive a shared constraint point from one world position, mapped through each
body's real transform.

**Teleporting a pin marker: 955 km of body displacement in a frame**
`client/lib/rapierdoll.js:944-958`
"the marker is born AT the joint — zero constraint error at creation — and CHASES the
target at capped speed. Teleporting it resolves the position error as one giant solver
impulse: measured 955 km of body displacement in a frame. The chase is also the feel:
a hand pulling a body, not a body snapping to a hand." (`MAXV = 6 * FIXED_DT`, applied
every substep "so the injection per solver tick stays small".)
Lesson: kinematic targets must chase, not teleport, and be created at zero error.

**Settle must be LINEAR AND ANGULAR: 1.0-1.35 rad/s at capture**
`client/lib/rapierdoll.js:1053-1057`
"Linear-only froze bodies mid-rotation — measured 1.0-1.35 rad/s (58-77°/s) of
residual turn at the instant of capture, which reads on screen as the corpse popping as
it locks." (`SETTLE_V` 0.07, `SETTLE_W` 0.6 rad/s.)
Lesson: a rigid-body settle test needs both velocities.

**An empty array is TRUTHY, so a disposed sim must return null**
`client/lib/rapierdoll.js:999-1003`
"A disposed sim has no segments, so this would return {j:[],p:[],v:[]} — and
`seedVel?.j` is TRUTHY for an empty array, so the receiver would take the hollow
handover as authoritative and reset the body. Say nothing instead; every caller
already falls back."
Lesson: an empty-but-present payload defeats a presence check. Return null.

**Endpoint velocity is v + ω × r, from the CENTRE OF MASS**
`client/lib/rapierdoll.js:984-990`
"a swung body hands over its swing. r is measured from the CENTRE OF MASS, which for
the compound torso is not the body origin."
Lesson: rigid-body endpoint velocity is not the body's linear velocity.

**The 15-collider ceiling is an encoding limit, not a physics one**
`client/lib/rapierdoll.js:545-552`
"Membership in the high half, filter in the low half, bit 15 reserved so statics
(groups 0xFFFFFFFF) stay hittable — which caps us at 15 colliders. 12 segments + 2 bars
= 14. Adding a third bar needs a different encoding, not a bigger shift."
Lesson: write down the headroom and what exceeding it requires. (A `>15` warning is
in the code.)

**Solver iterations: stock is 4; a 14-body articulated chain wants more**
`client/lib/rapierdoll.js:136-151`
`SOLVER_ITERS = 16`, `MAX_FRAMES = 8` ("a hitch drops its backlog, never simulates a
second at once"), `ANG_CEIL = 20` rad/s ("a backstop and nothing more"), `TONE0 = 14`
N·m/rad decaying `TONE_DECAY = 0.80` per 0.1s ("tone is under 1% of TONE0 by ~2 s").
And: "Angular damping is now just damping, not a stability budget: the limits it used
to be compensating for are inside the solver. The spike validated 0.7."
Lesson: when you fix the real constraint, remove the damping that was hiding its
absence — and note what the value used to be compensating for.

**Twist and swing state must be inspectable**
`client/lib/rapierdoll.js:686-698` (the `balls` record keeps `declaredCone`,
`declaredTwist`, `bornSwing`, `bornTwist`)
Lesson: record the declared value alongside the applied one so a widened limit is
visible rather than mysterious.

---

## 11. Shared derivations (`shared/`)

**One copy of the facts, and it retires a house rule by construction**
`shared/README.md`
"Everything in this directory is imported verbatim by all three species of runtime —
the browser client…, the sequencer…, and the mcpl agent — so shared derivations…come
out of exactly one function everywhere. The 'fold is sacred / mirrored math stays
mirrored' house rules in AGENTS.md are true by construction only for code that lives
here; moving a mirrored pair into this directory is how the rule is retired."
Constraints: pure and dependency-free ("No three, no DOM, no Bun APIs, no `Date.now()`
of its own — callers pass `now`"), plain JS + JSDoc so the browser imports it as-is,
and `../../shared/…` from `client/lib/` "resolves to the repo root on disk (so
headless tools can import client modules) and clamps to `/shared/…` in the browser
(URLs don't ascend past root)."
Lesson: a discipline rule you can delete by moving code is better than a discipline
rule you have to remember.

**PURE and dependency-free ON PURPOSE: three species import this file**
`shared/forecast.js:1-18`
"Shared facts (time of day, weather state, transition phase) must be DERIVED
identically everywhere, so the derivation lives in exactly one place… No three, no
DOM, and no Date.now() of its own — callers pass `now`, tests pass whatever they like."
Lesson: ambient time is what makes a derivation untestable and per-runtime divergent.

**The POLICY is authored; every change derived from it is computed, not sent**
`shared/forecast.js:12-18`, `AGENTS.md:188-202`
"every weather change derived from it is a world-system realization of that policy,
computed independently by each client from (policy, epoch, now). No server simulation,
no per-frame log entries, no per-client randomness: late join, reconnect, and two
simultaneous clients all land on the same segment of the same forecast."
Lesson: a function of time buys ambient behaviour at zero traffic — the same trick as
motion.

**Draw ORDER within a segment is part of the wire contract**
`shared/forecast.js:69-73`
"One independent draw stream per (seed, segment index)… Draw ORDER within a segment is
part of the wire contract (dwell, then state, then intensity) — reordering draws would
silently fork every deployed world's forecast."
Lesson: once a PRNG sequence is deployed, its consumption order is frozen.

**A strobing sky is a griefing vector, not weather**
`shared/forecast.js:98-103`, `AGENTS.md:199-202`
"The dwell floor bounds two things at once: how often the sky may lurch… and how long
the late-join segment walk can get — at 60s minimum, a year-old policy is ~525k
iterations of cheap integer math, a few milliseconds once." (`DWELL_FLOOR_S = 60`,
`DWELL_CAP_S = 6*3600`.)
Lesson: one bound can serve both a social and a computational purpose; name both.

**A transition may never outlive the shortest segment**
`shared/forecast.js:129-132`
"otherwise a new ease can begin before the previous one finishes, forever."
Lesson: clamp a transition duration against the minimum dwell.

**Never re-draw the state we are already in**
`shared/forecast.js:140-147`
"a forecast whose transitions are invisible isn't one."
Lesson: a Markov step that can repeat itself produces an invisible system.

**The returned segment IS the cursor — O(1) live ticking**
`shared/forecast.js:150-152`, `client/lib/sky.js:541`, `:774-777`
"same answer from a cold walk or a resumed cursor (the returned segment IS the cursor
— feed it back on the next tick and the walk is O(1) from then on)." The clock ticks at
~1Hz: "even at rate 24 the sun moves 0.1°/s, and the forecast's cursor makes each check
O(1) (never a re-walk from the policy epoch)."
Lesson: make the oracle's own output resumable, so the live path never re-walks
history.

**Joined mid-transition: ease in over the REMAINING time**
`client/lib/sky.js:568-575`, `:429-433`
"so this client's sky finishes changing when everyone else's does." And construction
uses the DERIVED weather, not the raw authored field: "under a forecast the authored
field may be segments stale."
Lesson: a late joiner must land in the middle of the transition, not at its start.

**An override governs from the moment it LANDED, never earlier**
`shared/forecast.js:194-196`
"a skewed clock must not see a 'future' override in force."
Lesson: bound a manual override by the entry's own timestamp on both sides.

**A weather verb rebases `hours`, or the sun snaps on every weather change**
`shared/forecast.js:271-276`, `:303`, `server/server.ts:338-343`
"Without this the merge re-epochs t0 while `hours` stays at the authored value, and the
sun snaps back to it on every weather change — on both planes, live and fold." (Issue
#29.)
Lesson: merging a partial verb onto a time-anchored bag must re-derive the anchor.

**Server-owned stamps cannot be forged from the args — except on synthetic replay**
`shared/forecast.js:260-294`
"`forecast.{epoch,seq,by}`, the whole `override` bag, and the top-level `seq`/`by`…come
from the ENTRY, never from the authored args — a policy bag cannot spoof its own
provenance. The one exception is synthetic pre-history replay (stateToEntries' negative
seqs): those args ARE the already-stamped fold, so stamps pass through untouched —
restamping them with the synthetic entry would re-epoch the forecast on every late
join." A weather verb "cannot author or clear policy… nor can it claim authorship of
the bag."
Lesson: provenance is stamped at fold from the entry. Synthetic replay must be
recognizable, or every late join re-epochs the world.

**One clock governs, and the folded state says which (#65)**
`shared/forecast.js:226-258`, `AGENTS.md:204-232`
"whenever `clock:'real'` is authored, the rated fields `hours`/`rate` never remain as
active-looking top-level state: they park under `dormantRated`… Parking is
UNCONDITIONAL on real mode — the fold never asks ICU anything, so the folded STATE is a
pure function of the log on every runtime; only derived hours depend on the tz
database." Runs on every fold, "synthetic replay included — config normalization, not
provenance stamping: deterministic, idempotent, and it heals bags folded before the
contract existed the next time a late join replays them."
Lesson: the fold must never consult a platform database. Normalize unconditionally so
the folded state is runtime-independent, and make the normalization idempotent so old
history heals on replay.

**A typo'd timezone dims nothing**
`shared/forecast.js:24-29`, `:56-64`, `:328-357`
"An unknown tz caches null and the rated clock takes over — a typo dims nothing." And
the fallback needs `dormantRated`: "A normalized bag carries no top-level hours/rate —
without this arm a typo'd tz on a normalized world would freeze the sun at the `?? 12`
default forever. dormantRated anchors on its own ts (the parking moment), so later
weather merges restamping sky.ts never snap the fallback day." `effectiveClock` reports
"what is ACTUALLY in effect, never what was merely requested", with `requestedTz`
flagging the typo.
Lesson: a normalization that hides the active fields must supply the fallback path too,
and the reported mode must be the effective one.

**Machine consumers must not divine precedence from raw fields**
`AGENTS.md:216-232`, `shared/forecast.js:328-337`
"`effectiveClock(sky, now)`…answers `{mode, hour, tz?, rate?, seq, by}` — reporting what
is ACTUALLY in effect." Migration note: "`sky.rate` can no longer be stale-but-present
under a real clock — it is simply absent."
Lesson: publish the derived answer as an API so nobody reimplements the precedence
rules.

**Coarse day phase, because continuous hour updates would be spam**
`shared/forecast.js:360-367`
"crossing dawn is an event."
Lesson: quantize an ambient signal to the granularity perception actually wants.

**Provenance stays legible: an ambient world, never an unattributed one**
`client/lib/sky.js:580-587`, `shared/forecast.js:369-393`, `AGENTS.md:193-199`
"a derived change names its policy, a manual one its actor". The narration line carries
policy seq, author, seed, segment index and time to next.
Lesson: automation must remain attributable to the person who authored the policy.

---

## AGENTS.md house rules, verbatim

From `AGENTS.md:339-358` — "House rules, learned the hard way (each one is a past
incident)":

1. **The fold is sacred.** `foldEntry` (server) and `applyEntry` (client) must agree,
   and both must stay pure functions of the log. If they drift, joiners see a world
   that never existed.
2. **Mirrored math stays mirrored.** `pendulumImpulse` (server) and `pendulumTheta`
   (client/lib/motion.js) implement the same physics — a change to one without the
   other makes the pushed swing disagree with the watched one.
3. **No handler may ever throw out of `Bun.serve`'s ws callbacks.** A leaked throw
   exits the process and a reconnecting tab turns it into a crash loop. (Commit
   4f82250 is the cautionary tale.)
4. **Plane transitions stamp absolute state.** Anything returning from live motion to
   rest writes its pose into the verb (`dismount {pos, yaw}`, `motion {type:null}` +
   `place`). The log must never depend on reconstructing where a ride was.
5. **Parameters, never code, in components.** Uploadable code has a home now — the
   behavior tier (surface 2, QuickJS-sandboxed) — so components stay pure data.
   Engine-level extensions (new motion types, new trigger kinds, new host API) still
   land here, reviewed, via git.

Attributions traced in this ledger:
- Rule 1 — the `collide` field that folded nowhere (`server/server.ts:269-278`), and
  the `settledPose` split that made a resident arrive collapsed for weeks (#61,
  `server/server.ts:828-848`).
- Rule 2 — `server/server.ts:642-676` ↔ `client/lib/motion.js:75-84`. The retirement
  path is `shared/` (`shared/README.md`).
- Rule 3 — commit `4f82250`, quoted in full below; re-stated at
  `server/server.ts:1906-1911`, `server/server.ts:590-601`, `docs/leases.md:141`, and
  applied to the MCPL door at `mcpl/agent.ts:344-350` after it killed that door per
  pose event.
- Rule 4 — `server/server.ts:441-450`, `client/lib/world.js:386-399`,
  `client/main.js:325-335`, `client/lib/motion.js:280-285`,
  `client/lib/scenegraph.js:17-20`.
- Rule 5 — `server/server.ts:2194-2212` (8KB bound on opaque data),
  `server/behaviors.ts:18-20` (code is content-addressed in the store),
  `AGENTS.md:145-148`.

Two further rules are stated outside that list and belong with them:

- **The verb set is closed — normatively, on purpose** (`AGENTS.md:155-166`). "The door
  refuses verbs not in the table above, while the LOG tolerates unknown verbs forever…
  This asymmetry is the extension model, not an accident of it." Three lanes are always
  open: `comp` for state-shaped, `use` for event-shaped, behavior scripts for semantic.
  "A new VERB is a protocol amendment: rare, deliberate, versioned."
- **No manifest** (`server/server.ts:6`, `:1708-1713`, `client/lib/assets.js:341-343`,
  `client/lib/prefetch.js:81-82`). "everything about a world arrives through its log" —
  and the rule "applies to the client too": prefetch and sky-asset priming are
  discovered from `/library-list`, never hardcoded.

Also recorded in AGENTS.md as operational law:
- `AGENTS.md:362-364` — "scratch sequencer — NEVER develop against a port someone
  lives on."
- `AGENTS.md:375-377` — "Join messages use `id`, not `name` (a `name` field gets you
  `anon-N`). Extend `tools/comptest.ts` when you add vocabulary — a verb without a
  check in a matrix doesn't exist yet."
- `AGENTS.md:379-381` — "Deploys are the operator's call: pushing `main` updates no
  running world. The production sequencers (Mac `:8940`, the show VPS) restart on a
  human decision because restarts ripple every resident's reconnect."
- `AGENTS.md:456-459` — "your *first* question is answered in-world (`world_debug`),
  your *second* in the log (`world_history`), and only your *third* needs the repo. If
  you find yourself needing the repo to answer question one, that's a gap."

---

## Commit hashes cited in comments

**`4f82250`** — resolves in this repo.
`no ws message may kill the server: catch-all guard + polite bad-world-name refusal`
— antra-tess, 2026-08-01. Cited at `AGENTS.md:350`, `server/server.ts:601`,
`docs/leases.md:141`. Commit body, verbatim:

> Prod crash loop (16 restarts): the fork confirmation printed its link inside
> parens, the chat linkifier swallowed the ")", and clicking it opened
> ?world=<name>) — getWorld THROWS on bad names, the ws message callback had no
> catch, and an uncaught throw in Bun's ws handler EXITS THE PROCESS. The tab's
> auto-reconnect then re-killed the server every few seconds. The landmine
> predates the fork feature (any ?world=%29 join always did this); the
> parenthesized link armed it.
>
> - server: try/catch around the whole message switch — refusals are messages,
>   failures are logs, neither is an exit
> - server: join validates the world name itself and refuses with close 4005
>   (bad link, not bad actor — and a name that can never exist must not retry)
> - client: 4005 = rejected, no reconnect; linkifier strips trailing
>   punctuation from URLs (re-emitted as text); fork link stands bare at
>   [the end of the line]

Files: `server/server.ts`, `client/lib/net.js`, `client/lib/chat.js`.

**`16e6b5b`** — resolves. `chatbridge: post world lines through a webhook, one
username per speaker` (2026-08-08). Cited in `docs/DESIGN-local-chat-spaces.md:4` as
the revision base for that design doc.

**`1fc8178`** — resolves. `agent: folded components reach the late joiner (#71) (#79)`
(2026-08-08). Cited in `docs/DESIGN-local-chat-spaces.md:837`.

**Do not resolve in this repository** (they belong to sibling repos — exultation,
discord-mcpl, the connectome stack, or predate this history):
- `8b37f0f` — `README.md:40`.
- `a99adaa` — `SCALING_AND_SNAPSHOT_PLAN.md:5` (the plan's base revision).
- `732abbf`, `d5cbba5`, `e5fd11e` — `docs/DESIGN-local-chat-spaces.md:14, 25, 76`
  (revision history of that design).
- `2cdc7fb`, `a77be49` — `mcpl/manifest.ts:10` (upstream MCPL spec/digest vectors).
- `90f869f` — `mcpl/net-server.ts:212`, cited as "the discord-mcpl 90f869f lesson":
  the §5.3 ordering rule that nothing may run between `initialize` and the read loop,
  because waiting inline for the policy frame deadlocks.

**Other external attributions worth keeping** (people and reports, not commits):
Fable's noise field report (2026-08-02, `mcpl/denoise.ts:1-11`) and the night spent
debugging a silent motion (`server/server.ts:496-507`); the Hesperus findings #1
(durable grants, `server/server.ts:365-370`), #3 (join as "world",
`server/server.ts:1955-1958`), #4 (NTP-skewed motion phase, `client/lib/motion.js:200`)
and #5 (the genesis dialect marker, `server/server.ts:958-960`); Mica's review notes on
voice (#63 `p.stream`, `client/lib/voice.js:119-127`; the ICE contamination rule 08-07,
`:218-223`); Sol's PR#7 review of the spoken-say protocol (`client/lib/chat.js:176-192`,
`:240-255`); Sill's postdeploy report on `look()`'s shape (`mcpl/agent.ts:1244-1250`);
digi/FC on the malformed `httpBase` (`mcpl/agent.ts:244-250`); and the many timestamped
live receipts from R and antra recorded throughout §9.

---

*End of ledger. The measurements in it were paid for once; the point of writing them
down is that they only have to be.*
