# The protocol gate

`test/gate/run.ts` is the protocol gate. It runs every protocol suite in its own process, in three lanes, and it
passes only when every suite passed and none was skipped. This file describes what the gate needs and how it reports.
The suite table at the bottom is generated from `run.ts` (`--manifest`), and the gate refuses to start when the two
disagree, so the table can't drift.

## Running it

```sh
bun install --frozen-lockfile                 # in the checkout root and in client/ (mcpl/ needs .siblings/: --siblings installs it)
bun test/gate/run.ts --siblings          # clones/pins agent-framework, mcpl-core-ts and voice-kit in .siblings/ (gitignored; never a working copy beside the checkout), builds them, and installs mcpl/ and services/captionbot/, whose file: deps point there (the preflight refuses a copy that isn't the pin's build)
CHROME=/path/to/chrome EIDOVERSE_DIR=/path/to/eidoverse-video bun test/gate/run.ts    # or: bun run test:protocol
```

`.siblings/` is named by `mcpl/package.json` and `mcpl/bun.lock`, `services/captionbot/package.json` and its
`bun.lock`, `test/gate/run.ts` and `deploy/deploy-vps.sh`; moving it means changing all of them and re-locking in one step.

Exit 0 from the full run means the gate passed; from a run of named suites, a `--lane` or one `--shard` it means only that part passed
(the last line says PARTIAL PASS or SHARD). Exit 1 means a suite failed, a suite or a check was skipped, or the preflight found a
problem (it lists each one). Exit 2 means a bad argument.

Other forms, none of which is the gate:

| command | what it does |
|---|---|
| `bun test/gate/run.ts hostile phys` | runs only the named suites; the end says `PARTIAL PASS … this is not the gate` |
| `bun test/gate/run.ts --lane core` | runs one lane (`core`, `main` or `browser`), also reported as partial |
| `bun test/gate/run.ts --manifest` | prints the suite table below |
| `bun test/gate/run.ts --check-manifest` | exits 1 when this file's table isn't what `--manifest` prints |

## Runtimes

Runtime versions are declared in one place, `package.json` `"engines"`. Before any suite runs, the gate prints the
version it found of each runtime next to the declared one.

| runtime | declared | rule | where the gate finds it |
|---|---|---|---|
| bun | 1.4.4 | same major (any 1.x); a different minor or patch is printed as a note | the bun running the gate (`process.execPath`). Every nested `bun` a suite spawns is that same binary: its directory goes first on the children's PATH |
| python3 | 3.12, with `cryptography` | same major; the `cryptography` module must import | `PYTHON`, else `python3` on PATH. `conformance` and `simckpt` need `cryptography`; `freeze`, `pretrans` and `migrate-identities` need python3 (`NEEDS` in `test/gate/run.ts`) |
| chromium | 151 | this major or newer (playwright 1.62 ships 151; this box tests with Chrome for Testing 153) | `CHROME`, else playwright's own build, else `/usr/bin/google-chrome`, `/usr/bin/chromium`, `/usr/bin/chromium-browser` |
| node or deno | any | the gate runs on bun; `simmath` runs its digest under a second engine and fails with neither | `node` and `deno` on PATH (each one found is run) |

When the browser lane is selected and no Chromium is found, the gate fails before running anything. The message is:

```
chromium  NOT FOUND   declared 151 (…)
protocol gate: FAILED before any suite ran:
  - chromium: not found (the browser lane is REQUIRED: set CHROME=/path/to/chrome (Chromium or Chrome for Testing), or `bunx playwright install chromium`); declared 151 (…)
```

The preflight also fails, naming what to fix, when:

- `CHROME` names a file that doesn't exist;
- any `node_modules` (root, `client/`, `mcpl/`) is missing;
- a suite launches a Chromium but isn't in the browser lane. The gate reads each suite and the local modules it imports
  for `scratchBench(`, `browserBench(`, playwright, puppeteer, `chromium.launch`, `--remote-debugging-port`, or the
  marker comment `gate: launches a browser`;
- this file's table has drifted from `run.ts`.

## Lanes

Every lane is required. They run in this order:

1. **core** covers the pins, transactions and security: the spec and hygiene checks (`kernel`, `trig`, `laws`,
   `engine`, `normative`, `gov-reserved`, `diffcheck`, `hygiene`, `procgroup`), `nov1`, `vocab`, `authority` (which holds the
   storage and durability rows), `access`, `identity`, `scars`, `reset-race`, `txn` (every request ends committed,
   rolled-back or ambiguous; one request capability rechecked at both await-to-commit seams) and `txn-mutants` (each
   `txn` row turns red under its mutation). It runs first, and the first failure or skip stops the gate.
   Every later suite is then reported as skipped, with "the core lane failed at …" as the reason.
2. **main** is every other suite that needs no browser.
3. **browser** is every suite that drives a headless Chromium. They run one at a time. Inside `client-tools`, the
   test files that launch a browser also run one at a time, so the gate never has two Chromiums open.

A sharded run (`--shard`, as CI runs it) keeps this order and these rules inside each shard only: shards run at once, and
a core failure stops only its own shard.

## Isolation, timeouts, cleanup

The gate creates a temp dir under the host's `TMPDIR`, and each suite gets a fresh directory inside it. Each suite runs
as its own process group, with this environment:

| variable | value | why |
|---|---|---|
| `HOME` | `<suite dir>/home` (empty) | nothing in `~` is read: no playwright cache, no `~/eido`, no dotfiles |
| `TMPDIR`, `PROTOCOL_SCRATCH` | `<suite dir>` | every `mkdtemp`, scratch world, sandbox FIFO and Chromium profile lands here |
| `EIDOVERSE_DIR` | `<suite dir>/library` (empty) for core and main; **the browser lane requires it** | the asset library is a separate public repo, `SkyeShark/eidoverse-video`, pinned at `9acc1528b2febac11338107645ef500a95985ca5`. Set `EIDOVERSE_DIR` to a checkout of it; without one the gate fails before any suite runs, naming the clone command. Only browser suites, `knockdown` (its ragdoll needs a real rig) and `body-runtime` see it, read-only (run.ts `READS_LIBRARY`), and those two need it set too |
| `OPT_DIR`, `WORLDS_DIR`, `PATCH_DIR` | `<suite dir>/{opt,worlds,patched}`; `opt` is seeded with the files git tracks under `test/fixtures/props/` (today `ball.glb`, served as `props/ball.glb`) | nothing writes into the checkout's `assets/opt`, `worlds/` or `patched/`; no host cache is visible, but the repo's own committed fixtures are |
| `PATH` | the gate's bun directory, then the host's PATH | a nested `bun` is the declared bun |
| `BUN_RUNTIME_TRANSPILER_CACHE_PATH` | `0` | a cached transpile once hid a stale module |
| `SKIP_OPT_SWEEP` | `1` | no boot-time re-encoding of the store |
| `PYTHON`, `CHROME` | the binaries the preflight checked | the suites use what the gate verified |

Each suite gets a timeout of 5× its expected runtime (the table below), and never less than 180 s. When a suite times
out, the gate sends SIGTERM to the whole group, waits 5 s, then sends SIGKILL. When a suite exits, the gate SIGKILLs
whatever is left in its group: a server, a sandbox process or a Chromium the suite left running. The count shows on
the suite's line as `killed N leftover process(es)` and again in the tally. The suite's directory is then removed.
Ctrl-C, SIGTERM or SIGHUP to the gate kills the running suite's group and removes the gate's temp dir.
`PROTOCOL_TIMEOUT_SCALE=<factor>` multiplies every timeout, for a very slow host (`2`) or to watch the kill work
(`0.01`).
`PROTOCOL_KEEP=1` keeps the temp dir so you can read it.

Every fixture the gate needs is in the repo:

- `test/fixtures/v1-worlds/*`: old-format logs, with `folded.json` holding the reference fold of each. The sweep reads them,
  and so does the oracle, which uses each `folded.json` as the snapshot.
- `test/fixtures/v1-worlds/01-build/log.jsonl`: the first-protocol world that refusedjoin refuses.
- `test/fixtures/claude_suit-rig.json`: the skeleton reach-order uses. `test/fixtures/rig-fixture.mjs` writes it from the VRM
  and records the VRM's sha256.
- `test/fixtures/dims-1024x512.jpg`: the JPEG header for the decompression-bomb row (batch2 P6).
- `test/fixtures/v1-commons-shape.jsonl`: the Commons' governance lines, for roles T2.

## How results are reported

What a suite prints, and how the gate counts it:

| suite output | the gate counts it as |
|---|---|
| exit 0 | passed |
| exit 77 | **skipped** (the whole suite); the reason is its last `SKIP` line |
| a line `SKIP <name>: <why>` | **skipped** (one check): the suite counts as skipped even when it exits 0 |
| a line `FAIL …` or `✗ …` | the failed check, echoed under the suite |
| a line `OPTIONAL <name>: <why>` | an optional extension that didn't run. It is counted and listed, never a failure |
| any other exit, or a timeout | failed |

A skip fails the gate, because every lane is required. A check that depends on host data should carry a fixture and
print an `OPTIONAL` line for the host-data version. The optional extensions today:

| name | what is missing | turn it on with |
|---|---|---|
| `control-arm` | the protocol lab's pre-fix door and fold (each attack is shown to be an attack) | `PROTOCOL_LAB=<protocol lab checkout>` |
| `sweep-local-worlds` | the translators against a host's own world logs, on top of `test/fixtures/v1-worlds` and `spec/fixtures/replay` | `PROTOCOL_WORLDS=<dir>[:<dir>…]` |
| `oracle-host-worlds` | the snapshot oracle against a host's old worlds (`log.jsonl` + `snapshot.json`) | `ORACLE_WORLDS` or `PROTOCOL_WORLDS` |
| `ep3-real-commons` | directory EP3 (an epoch entered after thousands of instant-fold entries) on the real Commons log instead of its synthetic 3000-entry copy | `PROTOCOL_COMMONS=<commons-0927 log.jsonl>` and `PROTOCOL_COMMONS_LIBRARY=<its library>` |

Other host-only inputs: `V1_COMMONS=<a v1 Commons log>` runs roles T2 against a real Commons log instead of its
fixture, and `V1_LOG=<a v1 log>` does the same for refusedjoin.

The run ends with a tally:

```
== protocol gate: tally (N s)
  core     7 passed, 0 failed, 0 skipped
  main     90 passed, 0 failed, 0 skipped
  browser  10 passed, 0 failed, 0 skipped
  total    107 passed, 0 failed, 0 skipped (every lane is required: a skip fails the gate)
  optional, not run: 3
          control-arm: …
protocol gate: PASS
```

On a host with its own guards (a flock that keeps headless Chromes one at a time, a memory guard), set
`PROTOCOL_HEADLESS_LOCK=<lock file>` and `PROTOCOL_PERF_GUARD=<script>`. Each browser suite then runs as
`flock <lock> bash <script> -t <timeout> -- bun <suite>`. Neither is needed anywhere else.

## Operating systems and receipts

The gate is meant to run the same on **Linux, macOS and Windows**. A suite's leftover processes are found and killed per
OS (`server/procgroup.ts`: `/proc` on Linux, `ps` on macOS, the process tree on Windows), and PATH is searched
with the OS's own separator. The script sandbox tells a starved process from a stuck script with `/proc` CPU time on
Linux and, where there is no `/proc`, by whether the process ever took the job (scripts-check I8 and I8n).

`.github/workflows/protocol-gate.yml` runs the whole gate on all three OSes on every PR and on pushes to `main` and
the protocol PR's own branch, and each run uploads a receipt (`--receipt <file>`): the head (on a pull_request run, GitHub's merge of the PR
into its base), whether the tree was dirty, OS, runtimes, the asset library's head, every suite's result and a hash of its
output, and one hash over all of them; on a pull_request run, also the PR's own head (`prHead`) and the merge's parents
(`mergeOf`), in each shard's receipt and in the merged `gate-receipt-<os>.json`. That receipt, not a sentence in a PR
comment, is the evidence of a pass.

The macOS and Windows paths were first written on Linux (the macOS process path against `ps`, the Windows tree walk on
fixed tables, the no-`/proc` sandbox path by switching the reading off). They now run for real in that workflow, so its
macOS and Windows jobs, not a Linux run, are the evidence for them.

## Suites

The expected times come from the reference host (WSL2, 16 threads, 7 GB, 2026-10-18), with one suite running at a
time.

<!-- BEGIN GENERATED: bun test/gate/run.ts --manifest -->
| # | suite | lane | file | needs | expected | timeout |
|---|---|---|---|---|---|---|
| 1 | kernel | core | `test/protocol/kernel-check.ts` | bun | 0.5 s | 180 s |
| 2 | trig | core | `test/protocol/trig-check.ts` | bun | 0.2 s | 180 s |
| 3 | laws | core | `test/protocol/laws-check.ts` | bun | 0.3 s | 180 s |
| 4 | engine | core | `test/protocol/engine-check.ts` | bun | 0.6 s | 180 s |
| 5 | normative | core | `test/protocol/normative-check.ts` | bun | 0.2 s | 180 s |
| 6 | gov-reserved | core | `test/protocol/gov-reserved-check.ts` | bun | ? | 300 s |
| 7 | diffcheck | core | `test/gate/diffcheck.ts` | bun | ? | 300 s |
| 8 | hygiene | core | `test/gate/hygiene-check.ts` | bun | 0.4 s | 180 s |
| 9 | procgroup | core | `test/protocol/procgroup-check.ts` | bun | ? | 300 s |
| 10 | nov1 | core | `test/protocol/nov1-check.ts` | bun | 0.7 s | 180 s |
| 11 | vocab | core | `test/protocol/vocab-check.ts` | bun | 3.5 s | 180 s |
| 12 | authority | core | `test/protocol/authority-check.ts` | bun | 9 s | 180 s |
| 13 | access | core | `test/protocol/access-check.ts` | bun | 8.3 s | 180 s |
| 14 | identity | core | `test/protocol/identity-check.ts` | bun | 42 s | 210 s |
| 15 | scars | core | `test/protocol/scars-check.ts` | bun | 1 s | 180 s |
| 16 | reset-race | core | `test/protocol/reset-race-check.ts` | bun | 0.4 s | 180 s |
| 17 | txn | core | `test/protocol/txn-check.ts` | bun | 0.8 s | 180 s |
| 18 | txn-mutants | core | `test/protocol/txn-check.ts --mutants` | bun | 11 s | 180 s |
| 19 | simmath | main | `test/shared/simmath-test.ts` | bun | 1 s | 180 s |
| 20 | freeze | main | `test/protocol/freeze-check.ts` | python3 | ? | 300 s |
| 21 | stub-guard | main | `test/harness/stub-test.ts` | bun | ? | 300 s |
| 22 | mv-module | main | `test/gate/mv-module-test.ts` | bun | ? | 300 s |
| 23 | paths | main | `test/gate/paths-check.ts` | bun | 0.3 s | 180 s |
| 24 | body-state-bundle | main | `test/mcpl/body-state-bundle-test.ts` | bun | 0.2 s | 180 s |
| 25 | run-client-settle | main | `test/protocol/run-client-settle-check.ts` | bun | ? | 300 s |
| 26 | shard | main | `test/protocol/shard-check.ts` | bun | 1 s | 180 s |
| 27 | vocab-fixtures | main | `test/protocol/vocab-fixtures-check.ts` | bun | ? | 300 s |
| 28 | nonumber | main | `test/protocol/nonumber-check.ts` | bun | 1.4 s | 180 s |
| 29 | determinism | main | `test/protocol/determinism-check.ts` | bun | 0.1 s | 180 s |
| 30 | hostile | main | `test/protocol/hostile-check.ts` | bun | 0.3 s | 180 s |
| 31 | attack | main | `test/protocol/attack-check.ts` | bun | 1.5 s | 180 s |
| 32 | libfile | main | `test/protocol/libfile-check.ts` | bun | 0.1 s | 180 s |
| 33 | library-decode | main | `test/server/library-decode-test.ts` | bun | 2.6 s | 180 s |
| 34 | idle-stall | main | `test/server/idle-stall-test.ts` | bun | 22.8 s | 180 s |
| 35 | fetchbytes | main | `test/client/fetchbytes-test.mjs` | bun | 0.5 s | 180 s |
| 36 | variant-status | main | `test/server/variant-status-test.ts` | bun | 0.2 s | 180 s |
| 37 | optimize-pump | main | `test/server/optimize-pump-test.ts` | bun | 1 s | 180 s |
| 38 | rebuild | main | `test/server/rebuild-test.ts` | bun | 1 s | 180 s |
| 39 | ktx2-tf-purge | main | `test/server/ktx2-tf-purge-test.ts` | bun | 0.3 s | 180 s |
| 40 | image-lie | main | `test/server/image-lie-test.ts` | bun | 0.2 s | 180 s |
| 41 | glbperf-file | main | `test/server/glbperf-file-test.ts` | bun | 0.3 s | 180 s |
| 42 | gaps | main | `test/protocol/gaps-check.ts` | bun | 5.6 s | 180 s |
| 43 | phys | main | `test/protocol/phys-check.ts` | bun | 3.9 s | 180 s |
| 44 | physlive | main | `test/protocol/physlive-check.ts` | bun | 1.2 s | 180 s |
| 45 | siminputs | main | `test/protocol/siminputs-check.ts` | bun | ? | 300 s |
| 46 | phystick | main | `test/protocol/phystick-check.ts` | bun | 5.7 s | 180 s |
| 47 | sclock | main | `test/protocol/sclock-check.ts` | bun | 2.8 s | 180 s |
| 48 | server-clock | main | `test/client/server-clock-test.ts` | bun | 1.5 s | 180 s |
| 49 | tick | main | `test/server/tick-test.ts` | bun | 1 s | 180 s |
| 50 | agent-tokens-reload | main | `test/server/agent-tokens-reload-test.ts` | bun | ? | 300 s |
| 51 | server-clock-readers | main | `test/client/server-clock-readers-test.ts` | bun | 0.2 s | 180 s |
| 52 | physseeds | main | `test/protocol/physseeds-check.ts` | bun | 2.1 s | 180 s |
| 53 | eidosim | main | `test/protocol/eidosim-check.ts` | bun | 12 s | 180 s |
| 54 | eidosim-live | main | `test/protocol/eidosim-live-check.ts` | bun | 1.5 s | 180 s |
| 55 | mover | main | `test/protocol/mover-check.ts` | bun | 4.5 s | 180 s |
| 56 | zone-water | main | `test/protocol/zone-water-check.ts` | bun | 0.6 s | 180 s |
| 57 | water-lifecycle | main | `test/mcpl/water-lifecycle-test.ts` | bun | 1.8 s | 180 s |
| 58 | waterkind | main | `test/shared/waterkind-test.ts` | bun | 0.5 s | 180 s |
| 59 | underwater-presence | main | `test/server/underwater-presence-test.ts` | bun | 0.2 s | 180 s |
| 60 | buoyancy | main | `test/shared/buoyancy-test.ts` | bun | 0.2 s | 180 s |
| 61 | climb-env | main | `test/protocol/climb-env-check.ts` | bun | 0.5 s | 180 s |
| 62 | drive | main | `test/protocol/drive-check.ts` | bun | 0.6 s | 180 s |
| 63 | physics-volume | main | `test/protocol/physics-volume-check.ts` | bun | 0.5 s | 180 s |
| 64 | motion-vectors | main | `tools/vectors/motion.ts --check` | bun | ? | 300 s |
| 65 | water-vectors | main | `tools/vectors/water.ts --check` | bun | 0.2 s | 180 s |
| 66 | water-import | main | `test/water/import-golden-check.ts` | bun | ? | 300 s |
| 67 | water-preview | main | `test/water/preview-check.ts` | bun | 3 s | 180 s |
| 68 | avatar | main | `test/client/avatar-test.ts` | bun | 1 s | 180 s |
| 69 | locomotion-clip | main | `test/client/locomotion-clip-test.mjs` | bun | 0.2 s | 180 s |
| 70 | fp-view | main | `test/client/fp-view-test.ts` | bun | 0.2 s | 180 s |
| 71 | reachwire | main | `test/shared/reachwire-test.ts` | bun | 0.2 s | 180 s |
| 72 | reach | main | `test/shared/reach-test.ts` | bun | 0.2 s | 180 s |
| 73 | text | main | `test/shared/text-test.ts` | bun | ? | 300 s |
| 74 | posture-tiles | main | `test/client/posture-tiles-test.ts` | bun | 0.5 s | 180 s |
| 75 | poseclip-parity | main | `test/mcpl/poseclip-parity-test.ts` | bun | 0.2 s | 180 s |
| 76 | pose-handler | main | `test/server/pose-handler-test.ts` | bun | 0.2 s | 180 s |
| 77 | plateanchor | main | `test/client/plateanchor-test.ts` | bun | 0.3 s | 180 s |
| 78 | flight | main | `test/client/flight-test.ts` | bun | 0.5 s | 180 s |
| 79 | firstperson-plate | main | `test/client/firstperson-plate-test.ts` | bun | 0.5 s | 180 s |
| 80 | bodyscale | main | `test/client/bodyscale-test.ts` | bun | 0.7 s | 180 s |
| 81 | worn-name | main | `test/client/worn-name-test.mjs` | bun | 0.1 s | 180 s |
| 82 | avatar-perf | main | `test/server/avatar-perf-test.ts` | bun | 0.5 s | 180 s |
| 83 | armsolve | main | `test/client/armsolve-test.ts` | bun | 0.2 s | 180 s |
| 84 | ammodoll | main | `test/client/ammodoll-test.ts` | bun | 8.4 s | 180 s |
| 85 | bodysim | main | `test/client/bodysim-test.ts` | bun | 0.5 s | 180 s |
| 86 | remotes-limp-edge | main | `test/client/remotes-limp-edge-test.ts` | bun | 0.5 s | 180 s |
| 87 | remotes-lifecycle | main | `test/client/remotes-lifecycle-test.ts` | bun | 1 s | 180 s |
| 88 | colliders | main | `test/client/collider-test.ts` | bun | 0.2 s | 180 s |
| 89 | supportclass | main | `test/client/supportclass-test.ts` | bun | 0.2 s | 180 s |
| 90 | support | main | `test/client/support-test.ts` | bun | 0.3 s | 180 s |
| 91 | structure-field | main | `test/shared/structure-field-test.ts` | bun | 0.2 s | 180 s |
| 92 | structure-edit | main | `test/shared/structure-edit-test.ts` | bun | 0.2 s | 180 s |
| 93 | structure-collider | main | `test/client/structure-collider-test.ts` | bun | 0.2 s | 180 s |
| 94 | collider-off-bodies | main | `test/client/collider-off-bodies-test.ts` | bun | 2 s | 180 s |
| 95 | support-swap | main | `test/mcpl/support-swap-test.ts` | bun | ? | 300 s |
| 96 | knockdown | main | `test/server/knockdown-test.ts` | bun | ? | 300 s |
| 97 | sockets | main | `test/shared/sockets-test.ts` | bun | ? | 300 s |
| 98 | seats-store | main | `test/server/seats-store-test.ts` | bun | 0.9 s | 180 s |
| 99 | seatcore | main | `test/client/seatcore-test.ts` | bun | 0.3 s | 180 s |
| 100 | seatlab-measure | main | `test/client/seatlab-measure-test.ts` | bun | 1 s | 180 s |
| 101 | msgrate | main | `test/server/msgrate-test.ts` | bun | 2.8 s | 180 s |
| 102 | upload-cap | main | `test/server/upload-cap-test.ts` | bun | 0.6 s | 180 s |
| 103 | clientlog | main | `test/server/clientlog-test.ts` | bun | 3.5 s | 180 s |
| 104 | shape-render | main | `test/shared/shape-render-test.ts` | bun | ? | 300 s |
| 105 | originof | main | `test/client/originof-test.ts` | bun | ? | 300 s |
| 106 | renderer-cred | main | `test/server/renderer-cred-test.ts` | bun | ? | 300 s |
| 107 | renderer-join | main | `test/client/renderer-join-test.ts` | bun | 0.2 s | 180 s |
| 108 | render-health | main | `test/server/render-health-test.ts` | bun | 0.2 s | 180 s |
| 109 | replay | main | `test/protocol/replay-check.ts` | bun | 0.4 s | 180 s |
| 110 | replica-freeze | main | `test/shared/replica-freeze-test.ts` | bun | 0.5 s | 180 s |
| 111 | conformance | main | `test/protocol/compare.ts` | python3 + cryptography | 2.9 s | 180 s |
| 112 | sweep | main | `test/protocol/sweep.ts` | bun | 0.3 s | 180 s |
| 113 | oracle | main | `tools/import-v1/snapshot-oracle.ts` | bun | 0.4 s | 180 s |
| 114 | inplace | main | `test/protocol/inplace-check.ts` | bun | 15 s | 180 s |
| 115 | oneshot | main | `test/protocol/oneshot-check.ts` | bun | ? | 300 s |
| 116 | version-route | main | `test/client/version-route-test.ts` | bun | ? | 300 s |
| 117 | migrate-identities | main | `test/protocol/migrate-identities-check.ts` | python3 | 1.7 s | 180 s |
| 118 | oldworlds | main | `test/server/oldworlds-test.ts` | bun | 1.2 s | 180 s |
| 119 | descriptors | main | `test/shared/descriptor-defaults-test.ts` | bun | 0.1 s | 180 s |
| 120 | schema-layers | main | `test/shared/schema-layers-test.ts` | bun | 0.3 s | 180 s |
| 121 | light-readers | main | `test/client/light-readers-test.ts` | bun | 0.4 s | 180 s |
| 122 | ghost-mesh-size | main | `test/shared/ghost-mesh-size-test.ts` | bun | 12 s | 180 s |
| 123 | boot-init | main | `test/server/boot-init-test.ts` | bun | 0.5 s | 180 s |
| 124 | splash-lifecycle | main | `test/client/splash-lifecycle-test.mjs` | bun | 0.5 s | 180 s |
| 125 | bodygate | main | `test/client/bodygate-test.mjs` | bun | 0.5 s | 180 s |
| 126 | scheduler | main | `test/client/scheduler-test.ts` | bun | 0.3 s | 180 s |
| 127 | editor-range | main | `test/shared/editor-range-test.ts` | bun | 0.3 s | 180 s |
| 128 | editschema | main | `test/shared/editschema-test.ts` | bun | 0.5 s | 180 s |
| 129 | worldentity | main | `test/shared/worldentity-test.ts` | bun | 1.4 s | 180 s |
| 130 | layers | main | `test/shared/layers-test.ts` | bun | 0.2 s | 180 s |
| 131 | selection | main | `test/client/selection-test.ts` | bun | 0.2 s | 180 s |
| 132 | parts | main | `test/client/parts-test.ts` | bun | 0.2 s | 180 s |
| 133 | motioneval | main | `test/client/motioneval-test.ts` | bun | 0.2 s | 180 s |
| 134 | drag-q | main | `test/server/drag-q-test.ts` | bun | 0.2 s | 180 s |
| 135 | components-corpus | main | `test/shared/components-corpus-test.ts` | bun | 0.2 s | 180 s |
| 136 | component-needs | main | `test/shared/component-needs-test.ts` | bun | 0.6 s | 180 s |
| 137 | scriptcard-expect | main | `test/client/scriptcard-expect-test.ts` | bun | 0.5 s | 180 s |
| 138 | role-grammar | main | `test/shared/role-grammar-test.ts` | bun | 0.3 s | 180 s |
| 139 | rot | main | `test/shared/rot-test.ts` | bun | 0.1 s | 180 s |
| 140 | one-binding | main | `test/client/one-binding-test.ts` | bun | 0.3 s | 180 s |
| 141 | reexport-binding | main | `test/client/reexport-binding-test.mjs` | bun | 0.3 s | 180 s |
| 142 | wiring | main | `test/client/wiring-check.ts` | bun | 0.2 s | 180 s |
| 143 | onepose | main | `test/protocol/onepose-check.ts` | bun | 0.3 s | 180 s |
| 144 | helm-leave | main | `test/client/helm-leave-test.ts` | bun | 0.2 s | 180 s |
| 145 | dismount-height | main | `test/client/dismount-height-test.ts` | bun | 0.2 s | 180 s |
| 146 | latestread | main | `test/client/latestread-test.ts` | bun | ? | 300 s |
| 147 | chat-mention-insert | main | `test/client/chat-mention-insert-test.ts` | bun | ? | 300 s |
| 148 | chat-mention | main | `test/client/chat-mention-test.mjs` | bun | ? | 300 s |
| 149 | groundstep | main | `test/client/groundstep-test.mjs` | bun | ? | 300 s |
| 150 | csp | main | `test/client/csp-test.ts` | bun | ? | 300 s |
| 151 | build-gate | main | `test/client/build-gate-test.ts` | bun | 0.3 s | 180 s |
| 152 | capsule-recovery | main | `test/client/capsule-recovery-test.mjs` | bun | 10 s | 180 s |
| 153 | debug-tabs | main | `test/client/debug-tabs-test.ts` | bun | 0.3 s | 180 s |
| 154 | governor-xr | main | `test/client/governor-xr-test.ts` | bun | 0.2 s | 180 s |
| 155 | xr-entry-effects | main | `test/client/xr-entry-effects-test.mjs` | bun | 0.2 s | 180 s |
| 156 | xr-session-lifecycle | main | `test/client/xr-session-lifecycle-test.mjs` | bun | 0.2 s | 180 s |
| 157 | xrpanels | main | `test/client/xrpanels-test.ts` | bun | 0.3 s | 180 s |
| 158 | xrpass | main | `test/client/xrpass-test.mjs` | bun | 0.3 s | 180 s |
| 159 | xrpixelratio | main | `test/client/xrpixelratio-test.mjs` | bun | 0.2 s | 180 s |
| 160 | xrpointer | main | `test/client/xrpointer-test.mjs` | bun | 0.2 s | 180 s |
| 161 | xrshadow | main | `test/client/xrshadow-test.mjs` | bun | 0.2 s | 180 s |
| 162 | framebudget | main | `test/shared/framebudget-test.mjs` | bun | 1 s | 180 s |
| 163 | gputime | main | `test/client/gputime-test.ts` | bun | 2.6 s | 180 s |
| 164 | draw-batches | main | `test/client/draw-batches-test.ts` | bun | 0.3 s | 180 s |
| 165 | shaderlang | main | `test/shared/shaderlang-test.ts` | bun | 0.3 s | 180 s |
| 166 | shader-emit | main | `test/client/shader-emit-test.ts` | bun | 0.6 s | 180 s |
| 167 | instances | main | `test/shared/instances-test.ts` | bun | 0.3 s | 180 s |
| 168 | gpulost | main | `test/client/gpulost-test.mjs` | bun | 0.3 s | 180 s |
| 169 | render-aside | main | `test/client/render-aside-test.mjs` | bun | 0.3 s | 180 s |
| 170 | quadcolour | main | `test/client/quadcolour-test.mjs` | bun | 1.1 s | 180 s |
| 171 | headset-seen | main | `test/client/headset-seen-test.mjs` | bun | 0.2 s | 180 s |
| 172 | full-detail | main | `test/client/full-detail-test.ts` | bun | 0.2 s | 180 s |
| 173 | finger-curl | main | `test/client/finger-curl-test.mjs` | bun | 0.2 s | 180 s |
| 174 | backend-choice | main | `test/client/backend-choice-test.mjs` | bun | 0.2 s | 180 s |
| 175 | unknown-comp | main | `test/client/unknown-comp-test.ts` | bun | 1.1 s | 180 s |
| 176 | reach-order | main | `test/client/reach-order-test.ts` | bun | 1.5 s | 180 s |
| 177 | editcommit | main | `test/client/editcommit-test.ts` | bun | 0.8 s | 180 s |
| 178 | hierarchy-commit | main | `test/client/hierarchy-commit-test.ts` | bun | 0.6 s | 180 s |
| 179 | hierarchy | main | `test/shared/hierarchy-test.ts` | bun | 17 s | 180 s |
| 180 | verbclasses | main | `test/protocol/verbclasses-check.ts` | bun | 0 s | 180 s |
| 181 | authority-layers | main | `test/protocol/authority-layers-check.ts` | bun | 0 s | 180 s |
| 182 | ids | main | `test/protocol/ids-check.ts` | bun | 1.4 s | 180 s |
| 183 | r8 | main | `test/protocol/r8-check.ts` | bun | 0.9 s | 180 s |
| 184 | r9 | main | `test/protocol/r9-check.ts` | bun | 1.5 s | 180 s |
| 185 | r10 | main | `test/protocol/r10-check.ts` | bun | 1.7 s | 180 s |
| 186 | r11 | main | `test/protocol/r11-check.ts` | bun | 0.6 s | 180 s |
| 187 | names | main | `test/protocol/names-check.ts` | bun | 2.1 s | 180 s |
| 188 | parity | main | `test/protocol/parity-check.ts` | bun | 5.4 s | 180 s |
| 189 | directory | main | `test/protocol/directory-check.ts` | bun | 13 s | 180 s |
| 190 | keyhints | main | `test/client/keyhints-check.ts` | bun | 0 s | 180 s |
| 191 | upgrade | main | `test/protocol/upgrade-check.ts` | bun | 70 s | 350 s |
| 192 | hello-refused | main | `test/protocol/hello-refused-check.ts` | bun | ? | 300 s |
| 193 | server | main | `test/protocol/server-check.ts` | bun | 40 s | 200 s |
| 194 | worlds-route | main | `test/server/worlds-route-test.ts` | bun | 2.8 s | 180 s |
| 195 | served-routes | main | `test/server/served-routes-test.ts` | bun | 2.5 s | 180 s |
| 196 | native-login | main | `test/server/native-login-test.ts` | bun | 0.2 s | 180 s |
| 197 | mkconfig | main | `test/server/mkconfig-test.ts` | bun | 0.3 s | 180 s |
| 198 | heightmap-route | main | `test/server/heightmap-route-test.ts` | bun | 1.2 s | 180 s |
| 199 | config-env | main | `test/server/config-env-test.ts` | bun | 0.2 s | 180 s |
| 200 | fork-reset | main | `test/protocol/fork-reset-check.ts` | bun | 6 s | 180 s |
| 201 | simckpt | main | `test/protocol/simckpt-check.ts` | python3 + cryptography | ? | 300 s |
| 202 | statecache | main | `test/protocol/statecache-check.ts` | bun | ? | 300 s |
| 203 | foldparity | main | `test/protocol/foldparity-check.ts` | bun | ? | 300 s |
| 204 | blockers-mutants-a | main | `test/protocol/blockers-mutants.ts --group a` | bun | 110 s | 550 s |
| 205 | blockers-mutants-b | main | `test/protocol/blockers-mutants.ts --group b` | bun | 110 s | 550 s |
| 206 | blockers-mutants-c | main | `test/protocol/blockers-mutants.ts --group c` | bun | 110 s | 550 s |
| 207 | blockers-mutants-d | main | `test/protocol/blockers-mutants.ts --group d` | bun | 110 s | 550 s |
| 208 | scripts | main | `test/protocol/scripts-check.ts` | bun | 48 s | 240 s |
| 209 | scripting | main | `test/protocol/scripting-check.ts` | bun | 2 s | 180 s |
| 210 | grab | main | `test/protocol/grab-check.ts` | bun | 3.8 s | 180 s |
| 211 | shove | main | `test/protocol/shove-check.ts` | bun | 2 s | 180 s |
| 212 | shove-walker | main | `test/shared/shove-test.ts` | bun | 0.1 s | 180 s |
| 213 | own-names | main | `test/shared/own-names-test.ts` | bun | 0.1 s | 180 s |
| 214 | rand | main | `test/shared/rand-test.ts` | bun | 0.3 s | 180 s |
| 215 | force | main | `test/protocol/force-check.ts` | bun | ? | 300 s |
| 216 | physconst | main | `test/shared/physconst-test.ts` | bun | ? | 300 s |
| 217 | agentshove | main | `test/protocol/agentshove-check.ts` | bun | 165 s | 825 s |
| 218 | hands | main | `test/protocol/hands-check.ts` | bun | 1.2 s | 180 s |
| 219 | track-teleport | main | `test/client/track-teleport-test.ts` | bun | 0.2 s | 180 s |
| 220 | put-settle | main | `test/client/put-settle-test.ts` | bun | 0.2 s | 180 s |
| 221 | reset | main | `test/protocol/reset-check.ts` | bun | 1.7 s | 180 s |
| 222 | settle | main | `test/protocol/settle-check.ts` | bun | 5.4 s | 180 s |
| 223 | disabled | main | `test/protocol/disabled-check.ts` | bun | 1.2 s | 180 s |
| 224 | histdiff | main | `test/protocol/history-diff-check.ts` | bun | 0.3 s | 180 s |
| 225 | reachgate | main | `test/protocol/reachgate-check.ts` | bun | 22 s | 180 s |
| 226 | consent | main | `test/protocol/consent-check.ts` | bun | 0 s | 180 s |
| 227 | gates | main | `test/protocol/gates-check.ts` | bun | 0.1 s | 180 s |
| 228 | consent-client | main | `test/client/consent-client-test.ts` | bun | 0.2 s | 180 s |
| 229 | media-trust-tabs | main | `test/client/media-trust-tabs-test.ts` | bun | 0.1 s | 180 s |
| 230 | confirmcenter | main | `test/client/confirmcenter-test.ts` | bun | 0.5 s | 180 s |
| 231 | rolespanels-access | main | `test/client/rolespanels-access-test.ts` | bun | ? | 300 s |
| 232 | groundpanel | main | `test/client/groundpanel-test.ts` | bun | ? | 300 s |
| 233 | editquad | main | `test/client/editquad-test.ts` | bun | ? | 300 s |
| 234 | windows-guard | main | `test/client/windows-guard-test.ts` | bun | 0.5 s | 180 s |
| 235 | history-rows | main | `test/protocol/history-rows-check.ts` | bun | 0.6 s | 180 s |
| 236 | scale | main | `test/protocol/scale-check.ts` | bun | 125 s | 625 s |
| 237 | roles | main | `test/protocol/roles-check.ts` | bun | 3.1 s | 180 s |
| 238 | batch2 | main | `test/protocol/batch2-check.ts` | bun | 1.9 s | 180 s |
| 239 | describe-particles | main | `test/protocol/describe-particles-check.ts` | bun | 1.1 s | 180 s |
| 240 | picture-note | main | `test/client/picture-note-test.ts` | bun | 0.3 s | 180 s |
| 241 | build | main | `test/protocol/build-check.ts` | bun | 1.5 s | 180 s |
| 242 | counter | main | `test/protocol/counter-check.ts` | bun | 2.2 s | 180 s |
| 243 | blueprint | main | `test/shared/blueprint-test.ts` | bun | 1.2 s | 180 s |
| 244 | shiplist | main | `test/protocol/shiplist-check.ts` | bun | 1.7 s | 180 s |
| 245 | agenttools | main | `test/protocol/agenttools-check.ts` | bun | 20 s | 180 s |
| 246 | look | main | `test/mcpl/look-test.ts` | bun | 0.2 s | 180 s |
| 247 | presence | main | `test/protocol/presence-check.ts` | bun | 10 s | 180 s |
| 248 | modhole | main | `test/protocol/modhole-check.ts` | bun | 0.1 s | 180 s |
| 249 | pretrans | main | `test/protocol/pretrans-check.ts` | python3 | 2.8 s | 180 s |
| 250 | soundclock | main | `test/protocol/soundclock-check.ts` | bun | 0.2 s | 180 s |
| 251 | sound | main | `test/shared/sound-test.ts` | bun | ? | 300 s |
| 252 | picture-look | main | `test/shared/picture-look-test.ts` | bun | ? | 300 s |
| 253 | replica-hierarchy | main | `test/shared/replica-hierarchy-test.ts` | bun | ? | 300 s |
| 254 | audioctx | main | `test/client/audioctx-test.ts` | bun | 0.2 s | 180 s |
| 255 | sound-editor | main | `test/client/sound-editor-test.ts` | bun | ? | 300 s |
| 256 | skypanel | main | `test/client/skypanel-state-test.ts` | bun | ? | 300 s |
| 257 | sky-bakelock | main | `test/client/sky-bakelock-test.mjs` | bun | 0.3 s | 180 s |
| 258 | sky-env-upright | main | `test/client/sky-env-upright-test.mjs` | bun | ? | 300 s |
| 259 | sky-swapchain | main | `test/client/sky-swapchain-test.mjs` | bun | 0.3 s | 180 s |
| 260 | sky-lifecycle | main | `test/client/sky-lifecycle-test.mjs` | bun | 5.2 s | 180 s |
| 261 | sky-degrade | main | `test/client/sky-degrade-test.mjs` | bun | ? | 300 s |
| 262 | forecast | main | `test/client/forecast-test.ts` | bun | 0.2 s | 180 s |
| 263 | physics-off | main | `test/client/physics-off-test.ts` | bun | ? | 300 s |
| 264 | predict-pending | main | `test/client/predict-pending-test.ts` | bun | 0.5 s | 180 s |
| 265 | eidomodel | main | `test/protocol/eidomodel-check.ts` | bun | 0.7 s | 180 s |
| 266 | alias | main | `test/mcpl/alias-test.ts` | bun | 0.4 s | 180 s |
| 267 | tool-replies | main | `test/mcpl/tool-replies-test.ts` | bun | ? | 300 s |
| 268 | agent-mesh-collision | main | `test/mcpl/agent-mesh-collision-test.ts` | bun | 92 s | 460 s |
| 269 | navgrid | main | `test/server/navgrid-test.ts` | bun | 64 s | 320 s |
| 270 | structure-threshold | main | `test/shared/structure-threshold-test.ts` | bun | 0.3 s | 180 s |
| 271 | structure-route | main | `test/shared/structure-route-test.ts` | bun | 0.3 s | 180 s |
| 272 | navgrid-rows | main | `test/client/navgrid-rows-test.ts` | bun | 6.3 s | 180 s |
| 273 | places | main | `test/mcpl/places-test.ts` | bun | 130 s | 650 s |
| 274 | blank-part-uvs | main | `test/server/blank-part-uvs-test.ts` | bun | 0.3 s | 180 s |
| 275 | storey-walk | main | `test/mcpl/storey-walk-test.ts` | bun | 1.5 s | 180 s |
| 276 | walk-support-lifecycle | main | `test/mcpl/walk-support-lifecycle-test.ts` | bun | 0.8 s | 180 s |
| 277 | agent-reads | main | `test/mcpl/agent-reads-test.ts` | bun | ? | 300 s |
| 278 | route-shape | main | `test/shared/route-shape-test.ts` | bun | 1.2 s | 180 s |
| 279 | door-unit | main | `test/mcpl/door-unit-test.ts` | bun | ? | 300 s |
| 280 | manifest | main | `test/mcpl/manifest-test.ts` | bun | 0.2 s | 180 s |
| 281 | token-registry | main | `test/mcpl/token-registry-test.ts` | bun | 0.2 s | 180 s |
| 282 | door-media-whitelist | main | `test/mcpl/door-media-whitelist-test.mjs` | bun | 0.2 s | 180 s |
| 283 | door-bone-list | main | `test/mcpl/door-bone-list-test.ts` | bun | 0.3 s | 180 s |
| 284 | author-wire | main | `test/shared/author-wire-test.mjs` | bun | 0.2 s | 180 s |
| 285 | selfpose | main | `test/mcpl/selfpose-test.ts` | bun | 0.2 s | 180 s |
| 286 | effective-mcpl | main | `test/mcpl/effective-mcpl-test.ts` | bun | ? | 300 s |
| 287 | headless-core | main | `test/mcpl/headless-core-test.ts` | bun | ? | 300 s |
| 288 | effective | main | `test/mcpl/effective-test.ts` | bun | ? | 300 s |
| 289 | stretched-support | main | `test/mcpl/stretched-support-test.ts` | bun | ? | 300 s |
| 290 | stretched-places | main | `test/mcpl/stretched-places-test.ts` | bun | ? | 300 s |
| 291 | door-body | main | `test/mcpl/door-body-test.ts` | bun | ? | 300 s |
| 292 | body-state | main | `test/mcpl/body-state-test.ts` | bun | 8 s | 180 s |
| 293 | body-runtime | main | `test/client/body-runtime-test.ts` | bun | 0.5 s | 180 s |
| 294 | glb2vrm | main | `test/shared/glb2vrm-test.ts` | bun | 1 s | 180 s |
| 295 | vrmheight | main | `test/server/vrmheight-test.ts` | bun | 0.6 s | 180 s |
| 296 | shape-attach | main | `test/shared/shape-attach-test.ts` | bun | 0.7 s | 180 s |
| 297 | shape-physics | main | `test/shared/shape-physics-test.ts` | bun | 0.7 s | 180 s |
| 298 | shape-import | main | `test/shared/shape-import-test.ts` | bun | 0.4 s | 180 s |
| 299 | buildcheck | main | `test/server/buildcheck-test.ts` | bun | 18 s | 180 s |
| 300 | buildcheck-queue | main | `test/server/buildcheck-queue-test.ts` | bun | 7.4 s | 180 s |
| 301 | buildcheck-route | main | `test/mcpl/buildcheck-route-test.ts` | bun | 22 s | 180 s |
| 302 | flight-exit | main | `test/mcpl/flight-exit-test.ts` | bun | 3 s | 180 s |
| 303 | door-is-error | main | `test/mcpl/door-is-error-test.ts` | bun | 280 s | 1400 s |
| 304 | door-wording | main | `test/shared/door-wording-test.ts` | bun | ? | 300 s |
| 305 | stdio-door | main | `test/mcpl/stdio-door-test.ts` | bun | 14 s | 180 s |
| 306 | consent-replay | main | `test/mcpl/consent-replay-test.ts` | bun | ? | 300 s |
| 307 | history-request | main | `test/client/history-request-test.ts` | bun | 0.3 s | 180 s |
| 308 | command-replies | main | `test/client/command-replies-test.ts` | bun | ? | 300 s |
| 309 | scenegraph-scripts | main | `test/client/scenegraph-scripts-test.ts` | bun | ? | 300 s |
| 310 | library-fetch | main | `test/mcpl/library-fetch-test.ts` | bun | ? | 300 s |
| 311 | named-pose | main | `test/client/named-pose-test.ts` | bun | 2.6 s | 180 s |
| 312 | presence-session | main | `test/server/presence-session-test.ts` | bun | 1.5 s | 180 s |
| 313 | other-body-pose | main | `test/mcpl/other-body-pose-test.ts` | bun | 6 s | 180 s |
| 314 | settled-pose | main | `test/server/settled-pose-test.ts` | bun | 0.5 s | 180 s |
| 315 | pose-provenance | main | `test/mcpl/pose-provenance-test.ts` | bun | 0.5 s | 180 s |
| 316 | skystamp | main | `test/shared/skystamp-test.ts` | bun | 0.5 s | 180 s |
| 317 | skywatch | main | `test/shared/skywatch-test.ts` | bun | 1.3 s | 180 s |
| 318 | grant-command | main | `test/client/grant-command-test.ts` | bun | 0.3 s | 180 s |
| 319 | environment-realizer | main | `test/client/environment-realizer-test.ts` | bun | 0.3 s | 180 s |
| 320 | grass-quality | main | `test/client/grass-quality-test.ts` | bun | 0.3 s | 180 s |
| 321 | terrainshape | main | `test/shared/terrainshape-test.ts` | bun | 0.2 s | 180 s |
| 322 | flora | main | `test/client/flora-test.ts` | bun | 0.2 s | 180 s |
| 323 | grant-until | main | `test/client/grant-until-test.ts` | bun | 1 s | 180 s |
| 324 | lite-graph | main | `test/client/lite-graph-test.ts` | bun | 1 s | 180 s |
| 325 | lite-choice | main | `test/client/lite-choice-test.mjs` | bun | 0.2 s | 180 s |
| 326 | net-send-shape | main | `test/client/net-send-shape-test.ts` | bun | 1 s | 180 s |
| 327 | first-name-account | main | `test/client/first-name-account-test.ts` | bun | 1 s | 180 s |
| 328 | retired-commands | main | `test/client/retired-commands-test.ts` | bun | 1 s | 180 s |
| 329 | animnames-retry | main | `test/client/animnames-retry-test.ts` | bun | 2.5 s | 180 s |
| 330 | screenshots | main | `test/harness/bun-test.ts test/server/screenshots-test.ts` | bun | 9 s | 180 s |
| 331 | snapframe-render | main | `test/client/snapframe-render-test.ts` | bun | 0.1 s | 180 s |
| 332 | snapframe | main | `test/server/snapframe-test.ts` | bun | 2 s | 180 s |
| 333 | anim-backpressure | main | `test/server/anim-backpressure-test.ts` | bun | 0.3 s | 180 s |
| 334 | anim-wire | main | `test/mcpl/anim-wire-test.ts` | bun | 6 s | 180 s |
| 335 | panels | main | `test/client/panels-test.ts` | bun | 1 s | 180 s |
| 336 | panels-schema | main | `test/client/panels-schema-test.ts` | bun | 0.3 s | 180 s |
| 337 | dock | main | `test/client/dock-test.ts` | bun | 2.5 s | 180 s |
| 338 | perfscope | main | `test/client/perfscope-test.ts` | bun | 0.5 s | 180 s |
| 339 | clickuse | main | `test/client/clickuse-test.ts` | bun | 0.3 s | 180 s |
| 340 | bodies-wear | main | `test/client/bodies-wear-test.mjs` | bun | 1 s | 180 s |
| 341 | settings-panels | main | `test/client/settings-panels-test.ts` | bun | 0.5 s | 180 s |
| 342 | dropdown | main | `test/client/dropdown-test.ts` | bun | 0.3 s | 180 s |
| 343 | namereveal | main | `test/client/namereveal-test.mjs` | bun | 0.2 s | 180 s |
| 344 | mention-regex | main | `test/mcpl/mention-regex-test.mjs` | bun | 0.2 s | 180 s |
| 345 | icons | main | `test/client/icons-test.ts` | bun | 0.2 s | 180 s |
| 346 | dwell | main | `test/client/dwell-test.mjs` | bun | 0.2 s | 180 s |
| 347 | bus-events | main | `test/client/bus-events-test.ts` | bun | 0.2 s | 180 s |
| 348 | actions | main | `test/client/actions-test.mjs` | bun | 0.2 s | 180 s |
| 349 | edittheme | main | `test/client/edittheme-test.ts` | bun | 0.3 s | 180 s |
| 350 | components-inspector | main | `test/shared/components-inspector-test.ts` | bun | 0.8 s | 180 s |
| 351 | chat-resync-wire | main | `test/client/chat-resync-wire-test.ts` | bun | 0.2 s | 180 s |
| 352 | chat-log | main | `test/client/chat-log-test.ts` | bun | 0.2 s | 180 s |
| 353 | chat-scrollback | main | `test/client/chat-scrollback-test.ts` | bun | 10.5 s | 180 s |
| 354 | attention | main | `test/client/attention-test.ts` | bun | 0.7 s | 180 s |
| 355 | surface-hold | main | `test/client/surface-hold-test.ts` | bun | 19 s | 180 s |
| 356 | sfu-adapter | main | `test/server/sfu-adapter-test.ts` | bun | 0.5 s | 180 s |
| 357 | relay-decision | main | `test/server/relay-decision-test.ts` | bun | 0.2 s | 180 s |
| 358 | sfu-mic-intent-race | main | `test/client/sfu-mic-intent-race-test.mjs` | bun | 0.3 s | 180 s |
| 359 | voicesfu-devtrack | main | `test/client/voicesfu-devtrack-test.mjs` | bun | 0.3 s | 180 s |
| 360 | sfu-mic-gated | main | `test/client/sfu-mic-gated-test.mjs` | bun | 0.3 s | 180 s |
| 361 | mic-ptt | main | `test/client/mic-ptt-test.mjs` | bun | 7.2 s | 180 s |
| 362 | mic-meter-gate | main | `test/client/mic-meter-gate-test.mjs` | bun | ? | 300 s |
| 363 | stt-ptt | main | `test/client/stt-ptt-test.mjs` | bun | ? | 300 s |
| 364 | micstate | main | `test/client/micstate-test.mjs` | bun | 0.6 s | 180 s |
| 365 | voice-wire | main | `test/shared/voice-wire-test.ts` | bun | 2 s | 180 s |
| 366 | voice-wire-mutation | main | `test/server/voice-wire-mutation-test.ts` | bun | 10.5 s | 180 s |
| 367 | voicesource-real | main | `test/client/voicesource-real-test.mjs` | bun | 0.2 s | 180 s |
| 368 | captions | main | `test/shared/captions-test.ts` | bun | 0.2 s | 180 s |
| 369 | voicebot | main | `test/services/voicebot-test.ts` | bun | 3 s | 180 s |
| 370 | tts-fault | main | `test/client/tts-fault-test.ts` | bun | 0.5 s | 180 s |
| 371 | spoken-form | main | `test/client/spoken-form-test.mjs` | bun | 0.2 s | 180 s |
| 372 | ttsrow | main | `test/client/ttsrow-test.mjs` | bun | 0.5 s | 180 s |
| 373 | particles | main | `test/client/particles-test.ts` | bun | 1 s | 180 s |
| 374 | particles-host | main | `test/client/particles-host-test.ts` | bun | 0.2 s | 180 s |
| 375 | shadow-fade | main | `test/client/shadow-fade-test.mjs` | bun | 1 s | 180 s |
| 376 | shadow-fade-mutants | main | `test/client/shadow-fade-test.mjs --mutants` | bun | ? | 300 s |
| 377 | lamp-slot-policy | main | `test/client/lamp-slot-policy-test.mjs` | bun | 0.5 s | 180 s |
| 378 | lamp-skin | main | `test/client/lamp-skin-test.mjs` | bun | 0.3 s | 180 s |
| 379 | transmission | main | `test/client/transmission-test.mjs` | bun | 0.5 s | 180 s |
| 380 | body-shadow-gate | main | `test/client/body-shadow-gate-test.mjs` | bun | 0.3 s | 180 s |
| 381 | frames-layout | main | `test/client/frames-layout-test.ts` | bun | 1 s | 180 s |
| 382 | lantern | main | `test/client/lantern-test.ts` | bun | 1 s | 180 s |
| 383 | frames-resize | main | `test/client/frames-resize-test.ts` | bun | 0.2 s | 180 s |
| 384 | models-field | main | `test/client/models-field-test.ts` | bun | 1 s | 180 s |
| 385 | lod-policy | main | `test/client/lod-policy-test.ts` | bun | 0.3 s | 180 s |
| 386 | lod-client | main | `test/client/lod-client-test.ts` | bun | 20 s | 180 s |
| 387 | realized-lifecycle | main | `test/client/realized-lifecycle-test.ts` | bun | 0.7 s | 180 s |
| 388 | components-wire | main | `test/client/components-wire-test.ts` | bun | 1.2 s | 180 s |
| 389 | axes | main | `test/shared/axes-test.ts` | bun | ? | 300 s |
| 390 | catalogue | main | `test/protocol/catalogue-check.ts` | bun | ? | 300 s |
| 391 | compose | main | `test/shared/compose-test.ts` | bun | ? | 300 s |
| 392 | translate | main | `test/protocol/translate-check.ts` | bun | 6 s | 180 s |
| 393 | owners | main | `test/protocol/owners-check.ts` | bun | ? | 300 s |
| 394 | setup | main | `test/protocol/setup-check.ts` | bun | 3 s | 180 s |
| 395 | importer | main | `test/protocol/importer-check.ts` | bun | 1.2 s | 180 s |
| 396 | eidosim-v1 | main | `test/protocol/import-v1/eidosim-v1-test.ts` | bun | 0.2 s | 180 s |
| 397 | channelbox | main | `test/shared/channelbox-test.ts` | bun | ? | 300 s |
| 398 | euler | main | `test/client/euler-test.ts` | bun | 0.3 s | 180 s |
| 399 | last-world | main | `test/client/last-world-test.ts` | bun | 0.6 s | 180 s |
| 400 | event-wire | main | `test/mcpl/event-wire-test.ts` | bun | 0.1 s | 180 s |
| 401 | join-rfc005 | main | `test/mcpl/join-rfc005-test.ts` | bun | 20 s | 180 s |
| 402 | denoise | main | `test/mcpl/denoise-test.ts` | bun | 6 s | 180 s |
| 403 | killz-slumped | main | `test/server/killz-slumped-test.ts` | bun | 32 s | 180 s |
| 404 | getup-floor | main | `test/client/getup-floor-test.ts` | bun | 3 s | 180 s |
| 405 | arrival-hold | main | `test/client/arrival-hold-test.ts` | bun | 0.5 s | 180 s |
| 406 | arrivalhold | main | `test/client/arrivalhold-test.ts` | bun | 0.5 s | 180 s |
| 407 | geom-followup | main | `test/server/geom-followup-test.ts` | bun | 1 s | 180 s |
| 408 | consent-scripts-list | main | `test/server/consent-scripts-list-test.ts` | bun | 2 s | 180 s |
| 409 | custody-save | main | `test/server/custody-save-test.ts` | bun | 0.1 s | 180 s |
| 410 | briefing | main | `test/server/briefing-test.ts` | bun | ? | 300 s |
| 411 | door-frame | main | `test/mcpl/door-frame-test.ts` | bun | ? | 300 s |
| 412 | auth | main | `test/server/auth-test.ts` | bun | 4 s | 180 s |
| 413 | door-reresolve | main | `test/server/door-reresolve-test.ts` | bun | ? | 300 s |
| 414 | upload-rate | main | `test/server/upload-rate-test.ts` | bun | ? | 300 s |
| 415 | door-admit-revoke | main | `test/mcpl/door-admit-revoke-test.ts` | bun | ? | 300 s |
| 416 | mutant-anchors | main | `test/gate/mutant-anchors-check.ts` | bun | ? | 300 s |
| 417 | wp5-verdict | main | `test/water/wp5-verdict-test.ts` | bun | ? | 300 s |
| 418 | actionbar | main | `test/client/actionbar-test.ts` | bun | ? | 300 s |
| 419 | aux-binding | main | `test/server/aux-binding-test.ts` | bun | ? | 300 s |
| 420 | keepalive | main | `test/server/keepalive-test.ts` | bun | 15 s | 180 s |
| 421 | chatbridge | main | `test/services/chatbridge-test.ts` | bun | 15 s | 180 s |
| 422 | spoken-say-door | main | `test/server/spoken-say-door-test.ts` | bun | ? | 300 s |
| 423 | sfu | main | `test/server/sfu-test.ts` | bun | 22 s | 180 s |
| 424 | sfu-verb-gate | main | `test/server/sfu-verb-gate-test.mjs` | bun | 14 s | 180 s |
| 425 | tts | main | `test/client/tts-test.ts` | bun | ? | 300 s |
| 426 | heightmap-readiness | main | `test/mcpl/heightmap-readiness-test.ts` | bun | 6 s | 180 s |
| 427 | emitter-percept | main | `test/mcpl/emitter-percept-test.ts` | bun | ? | 300 s |
| 428 | typing-relay | main | `test/mcpl/typing-relay-test.ts` | bun | 42 s | 210 s |
| 429 | door-cap-gate-live | main | `test/mcpl/door-cap-gate-live-test.mjs` | bun | 13 s | 180 s |
| 430 | mention-delivery | main | `test/server/mention-delivery-test.ts` | bun | ? | 300 s |
| 431 | one-libvips | main | `test/server/one-libvips-test.ts` | bun | 22 s | 180 s |
| 432 | ragdoll-floor | main | `test/client/ragdoll-floor-test.ts` | bun | 33 s | 180 s |
| 433 | snap-settle | main | `test/client/snap-settle-test.ts` | bun | 5 s | 180 s |
| 434 | lod-normals | main | `test/server/lod-normals-test.ts` | bun | ? | 300 s |
| 435 | help-words | main | `test/shared/help-words-test.ts` | bun | ? | 300 s |
| 436 | level-dive | browser | `test/water/level-dive-check.ts` | Chromium | ? | 300 s |
| 437 | water-cross | browser | `test/water/crossing-pipelines-check.ts` | Chromium | 60 s | 300 s |
| 438 | toast-group | browser | `test/protocol/toast-group-check.ts` | Chromium | ? | 300 s |
| 439 | browser | browser | `test/protocol/browser-check.ts` | Chromium | 1.5 s | 180 s |
| 440 | client | browser | `test/protocol/client-check.ts` | Chromium | 60 s | 300 s |
| 441 | refusedjoin | browser | `test/protocol/refusedjoin-check.ts` | Chromium | 150 s | 750 s |
| 442 | harness | browser | `test/client/harness-test.ts` | Chromium | ? | 300 s |
| 443 | client-b2 | browser | `test/protocol/batch2-probe.ts` | Chromium | 19 s | 180 s |
| 444 | access-panel | browser | `test/protocol/access-panel-probe.ts` | Chromium | ? | 300 s |
| 445 | lock-strength | browser | `test/client/lock-strength-test.ts` | Chromium | 10 s | 180 s |
| 446 | swim-lists | browser | `test/client/swim-lists-test.ts` | Chromium | 10 s | 180 s |
| 447 | build-client | browser | `test/protocol/build-probe.ts` | Chromium | 8.1 s | 180 s |
| 448 | comps-parity | browser | `test/client/comps-parity-test.ts` | Chromium | ? | 300 s |
| 449 | world-card | browser | `test/client/world-card-probe.ts` | Chromium | ? | 300 s |
| 450 | shiplist-probe | browser | `test/protocol/shiplist-probe.ts` | Chromium | 197 s | 985 s |
| 451 | xss-probe | browser | `test/protocol/xss-probe.ts` | Chromium | 15 s | 180 s |
| 452 | party-probe | browser | `test/protocol/party-probe.ts` | Chromium | 486 s | 2430 s |
| 453 | colour-picker | browser | `test/client/colour-picker-bench.ts` | Chromium | 8.1 s | 180 s |
| 454 | vrmic-exec | browser | `test/client/vrmic-exec-test.mjs` | Chromium | 0.5 s | 180 s |
| 455 | xr-nullfb | browser | `test/client/xr-nullfb-test.mjs` | Chromium | 0.3 s | 180 s |
| 456 | client-tools | browser | `test/harness/run-client.ts --import-only --skip-suites --strict-env` | Chromium | 202 s | 1010 s |

Lanes: core 18 suites (~79 s), main 417 (~2279 s), browser 21 (~1228 s); 456 suites in all.
<!-- END GENERATED -->
