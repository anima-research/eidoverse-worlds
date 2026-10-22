# Surface parity — does the world look the same?

`tools/protocol/surface-parity.ts` is a visual-regression check between two trees of this repo. It serves both
checkouts (by default `main` and your current checkout), opens scratch copies of the same worlds on each, photographs
them from fixed cameras in a headless Chromium, and pixel-diffs old against new. A change that alters what anyone sees
in a world is meant to be caught here, not by the first person who logs in.

```
BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/surface-parity.ts --check --commons <dir> --gym <dir>   # prerequisites only, no frames
BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/surface-parity.ts --commons <dir> --gym <dir>           # the run
```

Each world is a directory holding a current-format `world.jsonl`. Both `--commons` and `--gym` are required unless
`--only <world>` picks one; `--world <name>=<dir>` (repeatable) adds others. There are no default world paths.

**Both trees must read the current world format.** `main`'s server reads only the first protocol's `log.jsonl`, so until
this protocol is on `main`, `--old-ref main` (the default) cannot open a current world and the run stops at "world
opens: ‹world› on old". The comparisons that work today are between two commits of this branch: name one with
`--old-ref` (the 10-14 gym run used `pre-repoint-20261014`, 3b84e149).

The old tree is a detached worktree of `--old-ref <ref>` (default `main`, env `SURFACE_OLD_REF`), created in the temp
directory if missing; `--old <tree>` points at a checkout you already have instead. Run one headless browser at a time.

## Prepare, don't pretend

Headless Chromium is easy to get half-working, so the script asserts every prerequisite BY NAME before it takes a frame
and exits **2** saying which step failed. It never prints a green it did not earn. The steps, in the order they are
checked:

| step | what it proves | where the fact comes from |
|---|---|---|
| browser binary | a real Chromium exists at `CHROME` or one of the paths the other probes use (and is not a shell stub: on some distros `/usr/bin/chromium-browser` is a 2 KB snap stub that *exists*) | `tools/harness.ts:15`, `tools/probe-harness.mjs:8` (Playwright's build) |
| old tree / new tree | both are checkouts; the old one is made as a detached worktree of `--old-ref` if missing; they are different commits; each has `node_modules` and `client/node_modules` (linked from a sibling checkout only when the manifests are byte-identical) | the server warns "browsers will hang at the splash" without `client/node_modules` |
| clock pin | the old tree's commit time is readable (the default pin) | `git log -1 --format=%ct` in the old tree |
| world copy: ‹world› | a directory was given, and it holds `world.jsonl` whose line 0 is a `{dialect:"eidoverse-log", v}` genesis with the current protocol's `v` | `server/livehost.ts:141 isWorldDir`; `server/server.ts:355-363` refuses anything else at the door, naming `server/oldworlds.ts` |
| memory | `MemAvailable` ≥ 1200 MB (`SURFACE_MEM_FLOOR_MB`) | two sequencers + a SwiftShader Chromium; an OOM can take a small VM down with it |
| old server / new server | each tree's `server/server.ts` answers `/health` with the nonce *we* started it with | `server/routes.ts:1209-1213` (`BENCH_NONCE`) — a stranger's sequencer on the port is refused |
| world opens: ‹world› on ‹tree› | a spectator join gets a snapshot (not an error), its cut folds to > 0 entities, and `present[]` is empty | `server/server.ts:747` buildSnapshot; `shared/protocol/replica.js:150` clientCutOf |
| browser page target | the Chromium we spawned exposes *our* page on *our* debug port | as `tools/harness.ts:187-203` |
| client ready: ‹world› on ‹tree› | joined → loads idle → builds settled → sky not busy → **≥ 12 frames drawn after that** | `net.js replicaActive`, `assets.js loadingItems`, `world.js anyBuildsPending`, `sky.js skyBusy`, a `renderer.render` call counter the probe installs (`render.js renderCensus` ticks only in XR) |
| camera honoured | after 6 drawn frames the camera is still where it was put (< 1 cm drift) | `controller.js:1035 updateSpectator` only moves a spectator's camera to follow a remote body |
| frame drawn | the capture has more than a handful of distinct colours | a blank canvas is a failed capture, not a surface |

Exit codes: **0** every camera inside the threshold · **1** at least one camera over it (a surface diff) · **2** a named
prerequisite is missing (nothing was compared) · **3** over the threshold but inside the noise floor (see below).

## What is compared, and what is deliberately not

- **Spectator, nobody present.** The browser joins with `?spectate` (`client/lib/base.js:42` → `net.js:266`;
  `localbody.js:335` spawns no body for a spectator) in a scratch *copy* of each world that nobody else is in. So there
  are no bodies, name tags or chat bubbles in frame: presence-only regions are **absent rather than masked**, and the
  harness asserts `present[]` is empty from the server's own snapshot before any frame. Pixel parity is blind to
  presence-only regions; this makes that blindness explicit and checked rather than papered over.
- **DOM chrome hidden.** `body > *:not(canvas)` is hidden (as `particles-shots.ts:185` does): panels carry names and
  clocks, and a panel regression is a UI diff, not a surface one. `--keep-ui` puts it back.
- **Clock pinned.** `Date.now()` inside the page is pinned to the old tree's commit time (override with
  `--pin-clock <ms>`). `sky.js:385/:416` derive the sun's hour and the forecast's weather from `Date.now()`, so two runs
  minutes apart would light the world differently — a false red. `serverclock.js` reads `performance.timeOrigin`, so
  motion phases and clock sync are untouched. `--no-pin-clock` turns it off.
- **Fixed cameras**, two per world by default (`wide` at 0,7,14 → 0,1,0; `eye` at 6,1.6,6 → 0,1.2,−2). Add more with
  `--camera gym:stage=3,2,8/0,1,0`. The camera is placed by `Runtime.evaluate` on `core.js`'s exported `camera`
  (`particles-shots.ts:189` does the same). **This is a probe hook, not a feature** — there is no URL parameter for a
  fixed camera.
- **Diff rule.** A pixel counts as changed when any channel differs by more than `--tolerance` (default 16/255:
  SwiftShader dithers). A camera fails when changed pixels exceed `--threshold` percent (default 0.5). `pngjs` does the
  reading; the diff PNG is the old frame dimmed with changed pixels in red.

Output per world per camera, under `notes/surface-parity/<timestamp>/<world>/` in the new tree (git-ignored; `--out`
moves it): `<cam>.old.png`, `<cam>.new.png`, `<cam>.diff.png`, plus `<cam>.old2.png` / `<cam>.noise.png` for the
control; beside the world folders, a `<world>-<tree>.ready.log` trail of the readiness polls and a `RESULT.txt` with
lines like

```
PASS  gym wide: 1234 / 1024000 = 0.121%  (noise 0.090%)
```

## What a red means

Three things can turn a camera red, and the frames tell them apart:

1. **A real regression.** The diff PNG shows a *shape*: a model missing or moved, a lamp dark, a material flat, the
   floor a different colour, a motion component frozen. Open `old.png` and `new.png` side by side; the red in
   `diff.png` outlines the thing. This is what the harness exists for. Before calling it, check the noise frame
   (below) — if `noise.png` shows the same region red, it is not a regression.
2. **Lighting / time nondeterminism.** The whole frame is lightly speckled or a broad gradient differs (sky, shadows,
   fog). With the clock pinned this should not happen; if it does, `--no-pin-clock` was passed, or the world has a
   motion/particle/grass system animating on `serverNow()`. Look at `max |Δ|` — a lighting drift is many pixels at a
   small delta; a regression is fewer pixels at a large one.
3. **Draw-order / dither nondeterminism.** Scattered single red pixels along edges and alpha boundaries: SwiftShader's
   rasteriser is not bit-stable across runs. The `--tolerance 16` absorbs most of it.

**The noise floor is the guard against lying.** After shooting both trees the script boots the *old* tree a second
time and shoots the first camera again: `old` vs `old2` is what two runs of the *same* code disagree by (asset arrival
order, dither, anything still animating). That percentage is printed as `noise`, and an old-vs-new difference that is
within 2× the noise is reported **NOISY** (exit 3), not FAIL — because the harness has just measured that it cannot
tell. A FAIL is a difference the harness has shown it *can* see. `--no-control` skips the second boot (faster, and then
every over-threshold camera is a FAIL you must judge by eye).

A **green over an empty world is two blank frames agreeing**, so the entity count from each tree's snapshot is printed
and a zero fails the prerequisite. Read those counts: the same log can fold to a different number of entities on the
old tree and the new — a fold difference the pixels may or may not show, and worth knowing either way.

## How to run on Windows

The script is Bun + CDP only — no Playwright, no Linux paths it cannot do without.

1. In a shell at a checkout of this repo (the new tree), with `bun` on PATH:
   ```
   set BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
   set CHROME=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
   bun tools/protocol/surface-parity.ts --check --commons D:\path\to\commons --gym D:\path\to\gym --old-ref main --old D:\eido-old
   ```
   `--old` is where the old worktree goes (it is created from `--old-ref` if missing; it needs `node_modules` and
   `client/node_modules` — the script links them from the new tree when the manifests match, else says
   `cd client && bun install`). `EIDOVERSE_DIR` must point at the asset library if it is not `..\eidoverse-video`.
2. When `--check` is green through "world opens", drop `--check`. Edge on Windows has a real GPU, so frames arrive in
   seconds rather than the minute SwiftShader takes; expect ~6 boots (old, new, old-control × 2 worlds).
3. Add `--headed` to watch it. Add `--keep-ui` to include the panels. Frames land under `notes\surface-parity\<time>\`.

On Windows the script spawns `process.execPath`, not `bun` (the PATH shim orphaned sequencers before), and kills by PID.

## Known limits

- One headless browser at a time; the script checks memory but takes no lock.
- A world whose look depends on *who* is there (a seat posed by a body, a held prop) is out of frame by design.
- The noise control is one camera, one extra boot. A world with heavy animation may need `--threshold` raised, and the
  noise floor above explains why that is honest rather than lax: the control measured it.
- The old worktree defaults to a temp directory named for the ref's commit (override with `--old` or
  `SURFACE_OLD_TREE`); it is recreated from the ref if missing.
