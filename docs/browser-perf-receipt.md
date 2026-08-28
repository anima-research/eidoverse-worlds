# Browser performance receipts — how to take one that means something (#42)

Issue #42 has never lacked frame rates. It has lacked *comparable* frame rates.
Digi and Deckard moved to Chrome because Firefox was bad; N8python measured
~40fps on an M3 Max and ~120 with the grass out of frame; Chrome itself
collapsed to 1fps at 4.6M triangles with 41 skinned VRMs. Every one of those is
true and none of them can be subtracted from another, because each was taken in
a different place with a different crowd in a different window.

This is the procedure for taking one that can be. It costs about four minutes
per browser and produces a receipt you can paste into the issue whole.

---

## What gets measured

Three **foliage arms**, in a fixed order, from one **fixed camera pose**, with
the UI hidden:

| arm | what it means |
|---|---|
| `full` | everything on, as the world ships |
| `static` | the meadow is **drawn but not animated** — each stroke's own wind clock is released from the shared per-frame array *by identity*, and its wind amplitudes are zeroed. Nothing else in that array is touched: the sky, the weather and every entity emitter keep ticking, and the receipt prints how many of them it left running |
| `off` | the meadow is **not drawn at all** — the ceiling on what foliage costs |

Frame time is reported as **p50 / p95 / p99 / max over raw `requestAnimationFrame`
deltas**, never as an FPS average. A browser that renders 60 frames in a second,
one of which took 300ms, reports "60fps" and feels broken; the complaints on
this issue are about stutter and input lag, which live in the tail.

Everything else on the receipt exists to answer *"is this comparison allowed?"*
— adapter and backend, drawing buffer, render scale and quality tier, people
present, triangles, blades, console output and GPU context loss.

---

## The procedure

**Prerequisites:** node (not bun — see the note at the bottom), the installed
browsers you want to compare, and a local sequencer. Never run this against a
port someone lives on.

```bash
# 1. a scratch sequencer of your own
WORLDS_DIR=/tmp/lab JOIN_TOKEN=lab-door PORT=8949 \
  EIDOVERSE_DIR=../eidoverse-video bun run server/server.ts &

# 2. plant a scene worth measuring. Loopback only, and no default world name:
#    it generates a fresh one and PRINTS the exact --url for the next steps.
node tools/browserlab-seed.mjs

# 3. the reference run — this one fixes the camera for everything after it
node tools/browserlab-run.mjs --browser=chrome --label=chrome-151 --url="<printed above>"

# 4. the other browser, standing in exactly the same place
node tools/browserlab-run.mjs --browser=moz-firefox --label=firefox-154 \
     --camera=tools/receipts-42/chrome-151.json

# 5. the gate, then the delta
node tools/browserlab-compare.mjs \
     tools/receipts-42/chrome-151.json tools/receipts-42/firefox-154.json
```

The seeder writes world verbs, so it is loopback-only **and** refuses a named
world that already holds anything (`--allow-existing` overrides, for a scratch
world you made yourself). A default world name is one typo away from rewriting
somebody's local world, so there isn't one — and the runner has no default
world either.

`--browser` takes **installed** browsers: `chrome`, `msedge`, `moz-firefox`
(stock Firefox over WebDriver BiDi). `chromium` / `firefox` fall back to
Playwright's own patched builds — usable to check the script runs, **not**
evidence about a shipped browser.

Inside a live world you can skip the driver entirely and run the harness from
the console:

```js
await EW.browserlab({ secs: 25, label: 'firefox-154' })
copy(EW.__lab)          // the whole receipt, JSON
```

### Checklist — every one of these is a way a receipt has already gone wrong

- [ ] **One machine, one account, one world.** Cross-machine numbers are not a browser comparison.
- [ ] **The window is visible and stays visible.** The harness refuses `document.hidden`, and flags a cadence lock afterwards, because a backgrounded tab hands out 1000ms timer ticks that look exactly like a frame time. Do not alt-tab during the run.
- [ ] **The same camera pose.** Pass `--camera=<the first receipt>.json`. Flying to "roughly the same spot" changes tile count, frustum and draw calls together.
- [ ] **The same drawing buffer.** `--size=1280x800` is the default for a reason: left to their own window chrome, Chrome and Firefox gave 1249×1285 and 1280×955 on the same monitor — Firefox drawing 24% fewer pixels.
- [ ] **The same people present.** Bodies dominate frame cost at commons scale. If someone walks in mid-run, throw the receipt away.
- [ ] **Foliage actually built.** A meadow is planted asynchronously; the receipt says `foliage: absent` if it never arrived, and the arms then changed nothing.
- [ ] **The same render scale.** Pinned to `1` by default. The governor's cruise moves it under load, and an identical `--size` still gave Chrome 1280x800 and Firefox 960x600 in one run, Firefox having quietly shed a quarter of its pixels. Pass `renderScale: 'auto'` only when measuring the governor deliberately.
- [ ] **The same build.** Every receipt carries a deterministic tree digest — the commit, a hash of the full diff against it, and every untracked file — so it names the code that produced it. Two receipts from different trees do not compare.
- [ ] **Read the gate before the numbers.** `browserlab-compare` exits non-zero and claims nothing when the runs were looking at different things.
- [ ] **Fresh reload in each browser**, so neither is measuring the other's warm caches.

---

## Receipt template

Paste the block `browserlab` prints. It looks like this:

```markdown
### browserlab receipt — <label>

`<full user agent>`

| | |
|---|---|
| backend | `WebGPUBackend` (isWebGPURenderer true, navigator.gpu true) |
| adapter | vendor `nvidia` · arch `turing` · device `` · fallback _not exposed_ |
| pixel ratio | device 1 · renderer 1 · render scale 1 (pinned) |
| buffer | 1280×800 (viewport 1280×800) |
| cadence | 60Hz-ish (fastest arm p50 16.67ms) |
| cores / memory | 16 / 32GB |
| quality tier | casters 6 · light slots 8 · emitters auto · grass 1 · detail shed false |
| scene | 0 people · 5 skinned · 24 entities · 38 textures · 85,910 blades |
| scene digest | `2e324e3b` · world seq 26 |
| camera | pos [-0.62, 2.771, -3.987] yaw 3.1416 pitch 0.32 fov 55 |
| build | server `08276ca…` · tree `2947d074a629935f` (clean checkout) |

| foliage | p50 | p95 | p99 | max | mean | fps (p50) | >40ms | >100ms | blades | draws/frame |
|---|---|---|---|---|---|---|---|---|---|---|
| full | … | … | … | … | … | … | … | … | 85,910 | 110 |

_Static arm scope: 3 meadow-owned hooks released and 1 wind amplitudes zeroed;
N non-meadow hooks (sky, weather, entity emitters) left running._

**Console during the run:** …
**Context loss:** …
```

If any arm is marked ⚠, or the receipt carries a `tainted` line, **do not quote
its numbers** — that arm is a throttle, not a renderer.

---

## Reading the counters

three's info object carries two kinds and does not say which at the call site:
`render.calls` is "since the app has been started"; `render.drawCalls` and
`render.triangles` are "of the current frame". Measured here over six
consecutive frames of the live client, `calls` advanced 1434 → 1437 → 1440 →
1443 → 1446 (+3 per frame, three passes) while `drawCalls` sat flat at 92 and
`triangles` at 2,456,705. An earlier version of this harness read `calls` and
labelled it per-frame, publishing about 6,186 "draws" for a scene that draws 92.

So it no longer trusts a field name. Each counter is sampled over consecutive
frames and classified by SHAPE: flat is per-frame, evenly growing is a running
total reported as its step, and anything else is `unknown` — which prints as
"unknown" rather than as a number.

## What the receipts in `tools/receipts-42/` do and do not show

Two runs on one Windows 10 box, RTX 2080 SUPER, at an identical camera pose,
an identical 1280×800 buffer and an identical scene (2,725,031 triangles,
85,910 blades, 0 other people), in a **local lab world — not the commons**:

- **Chrome 151 and Firefox 154 both hold 60fps in every arm.** Every p50 is
  16.66–16.67ms. Firefox is not slower than Chrome here.
- That is a **floor result, not a tie.** This scene leaves both browsers
  headroom to reach the refresh interval, so the comparison can only report
  that neither failed. It does not contradict the field reports, and it does
  not confirm them — it does not reach them at all.
- **Firefox exposes no WebGPU adapter vendor or architecture** where Chrome
  reports `nvidia` / `turing`. #42's acceptance asks that adapter capability be
  inspectable in a debug receipt; on Firefox that half is currently unavailable
  to any receipt, including this one. `navigator.deviceMemory` is likewise
  absent.
- **Zero people.** The one variable the field evidence points hardest at —
  41 skinned VRMs — is not in this specimen at all.
- **Draws per frame: 110 with the meadow, 67 without**, identical in both
  browsers, from the classified per-frame counter.
- **Both receipts name their build:** commit `08276ca`, tree digest
  `2947d074a629935f`, clean checkout excluding the receipts directory. The
  server's own `/version` flag counts that directory and so reports "dirty";
  the tree digest is the line to read.

**Scope of the comparison:** valid for FROZEN SEEDED SCENES — a world whose
entities and population do not change between the two runs, which the
scene-digest and world-seq gates enforce. It is **not** yet validated for a
live populated commons, where bodies move between sequential browser runs by
definition; there the two runs would have to be simultaneous, or the scene
frozen first.

To reach the reported regime, the same procedure needs to run where the reports
came from: a populated commons, or a lab world seeded with a comparable body
count and triangle budget.

---

## Notes for whoever runs this next

**Run the driver under node, not bun.** Measured here on Windows 10 with bun
1.3.14: `chromium.launch()` starts the browser process and then hangs until the
launch timeout, because Playwright talks to it over `--remote-debugging-pipe`
(fds 3/4) and bun's spawn does not hand those over. The identical call under
node connects in 223ms. `tools/probe-harness.mjs` is exposed to the same wall on
this platform.

**The client door key is `?key=`, not `?token=`.** Without it the page loads,
boots the renderer and draws an *empty* world — no entities, no meadow, three
identical arms — while looking entirely healthy. The driver now refuses to
measure a world with no entities unless you pass `--allow-empty=true`.

**Nothing here writes to a world you are measuring.** `browserlab` sends no
verbs and persists nothing; every toggle is browser-local and restored in a
`finally`, including on a throw mid-arm. `browserlab-seed` *does* write verbs,
and refuses any host that is not loopback.
