# The protocol gate

`tools/protocol/run.ts` is the protocol gate. It runs every protocol suite in its own process, in three lanes, and it
passes only when every suite passed and none was skipped. This file describes what the gate needs and how it reports.
The suite table at the bottom is generated from `run.ts` (`--manifest`), and the gate refuses to start when the two
disagree, so the table can't drift.

## Running it

```sh
bun install --frozen-lockfile                 # in the checkout root, in client/, and in mcpl/
CHROME=/path/to/chrome bun tools/protocol/run.ts    # or: bun run test:protocol
```

Exit 0 means the gate passed. Exit 1 means a suite failed, a suite or a check was skipped, or the preflight found a
problem (it lists each one). Exit 2 means a bad argument.

Other forms, none of which is the gate:

| command | what it does |
|---|---|
| `bun tools/protocol/run.ts hostile phys` | runs only the named suites; the end says `PARTIAL PASS … this is not the gate` |
| `bun tools/protocol/run.ts --lane core` | runs one lane (`core`, `main` or `browser`), also reported as partial |
| `bun tools/protocol/run.ts --manifest` | prints the suite table below |
| `bun tools/protocol/run.ts --check-manifest` | exits 1 when this file's table isn't what `--manifest` prints |

## Runtimes

Runtime versions are declared in one place, `package.json` `"engines"`. Before any suite runs, the gate prints the
version it found of each runtime next to the declared one.

| runtime | declared | rule | where the gate finds it |
|---|---|---|---|
| bun | 1.3.14 | same major (any 1.x); a different minor or patch is printed as a note | the bun running the gate (`process.execPath`). Every nested `bun` a suite spawns is that same binary: its directory goes first on the children's PATH |
| python3 | 3.12, with `cryptography` | same major; the `cryptography` module must import | `PYTHON`, else `python3` on PATH. Only the `conformance` suite needs it |
| chromium | 151 | this major or newer (playwright 1.62 ships 151; this box tests with Chrome for Testing 153) | `CHROME`, else playwright's own build, else `/usr/bin/google-chrome`, `/usr/bin/chromium`, `/usr/bin/chromium-browser` |
| node | not used | the gate and its suites run on bun | none |

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

1. **core** covers transactions and security: `nov1`, `vocab`, `authority` (which holds the storage and durability
   rows), `access`, `identity`, `scars` and `reset-race`. It runs first, and the first failure or skip stops the gate.
   Every later suite is then reported as skipped, with "the core lane failed at …" as the reason.
2. **main** is every other suite that needs no browser.
3. **browser** is every suite that drives a headless Chromium. They run one at a time. Inside `client-tools`, the
   test files that launch a browser also run one at a time, so the gate never has two Chromiums open.

## Isolation, timeouts, cleanup

The gate creates a temp dir under the host's `TMPDIR`, and each suite gets a fresh directory inside it. Each suite runs
as its own process group, with this environment:

| variable | value | why |
|---|---|---|
| `HOME` | `<suite dir>/home` (empty) | nothing in `~` is read: no playwright cache, no `~/eido`, no dotfiles |
| `TMPDIR`, `PROTOCOL_SCRATCH` | `<suite dir>` | every `mkdtemp`, scratch world, sandbox FIFO and Chromium profile lands here |
| `EIDOVERSE_DIR` | `<suite dir>/library` (empty) | the asset library (`../eidoverse-video` by default) is host data; the gate never sees it |
| `OPT_DIR`, `WORLDS_DIR`, `PATCH_DIR` | `<suite dir>/{opt,worlds,patched}` | nothing writes into the checkout's `assets/opt`, `worlds/` or `patched/` |
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

- `spec/fixtures/*`: old-format logs, with `folded.json` holding the reference fold of each. The sweep reads them,
  and so does the oracle, which uses each `folded.json` as the snapshot.
- `spec/fixtures/01-build/log.jsonl`: the first-protocol world that refusedjoin refuses.
- `spec/fixtures/claude_suit-rig.json`: the skeleton reach-order uses. `tools/rig-fixture.mjs` writes it from the VRM
  and records the VRM's sha256.
- `tools/protocol/fixtures/dims-1024x512.jpg`: the JPEG header for the decompression-bomb row (batch2 P6).
- `tools/protocol/fixtures/v1-commons-shape.jsonl`: the Commons' governance lines, for roles T2.

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
| `sweep-local-worlds` | the translators against a host's own world logs, on top of `spec/fixtures` | `PROTOCOL_WORLDS=<dir>[:<dir>…]` |
| `oracle-host-worlds` | the snapshot oracle against a host's old worlds (`log.jsonl` + `snapshot.json`) | `ORACLE_WORLDS` or `PROTOCOL_WORLDS` |

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

## Suites

The expected times come from the reference host (WSL2, 16 threads, 7 GB, 2026-10-18), with one suite running at a
time.

<!-- BEGIN GENERATED: bun tools/protocol/run.ts --manifest -->
| # | suite | lane | file | needs | expected | timeout |
|---|---|---|---|---|---|---|
| 1 | nov1 | core | `tools/protocol/nov1-check.ts` | bun | 0.8 s | 180 s |
| 2 | vocab | core | `tools/protocol/vocab-check.ts` | bun | 3.4 s | 180 s |
| 3 | authority | core | `tools/protocol/authority-check.ts` | bun | 8.6 s | 180 s |
| 4 | access | core | `tools/protocol/access-check.ts` | bun | 8.3 s | 180 s |
| 5 | identity | core | `tools/protocol/identity-check.ts` | bun | 45 s | 225 s |
| 6 | scars | core | `tools/protocol/scars-check.ts` | bun | 1 s | 180 s |
| 7 | reset-race | core | `tools/protocol/reset-race-check.ts` | bun | 0.5 s | 180 s |
| 8 | nonumber | main | `tools/protocol/nonumber-check.ts` | bun | 1.6 s | 180 s |
| 9 | hostile | main | `tools/protocol/hostile-check.ts` | bun | 0.4 s | 180 s |
| 10 | attack | main | `tools/protocol/attack-check.ts` | bun | 2.5 s | 180 s |
| 11 | libfile | main | `tools/protocol/libfile-check.ts` | bun | 0.1 s | 180 s |
| 12 | gaps | main | `tools/protocol/gaps-check.ts` | bun | 6.3 s | 180 s |
| 13 | phys | main | `tools/protocol/phys-check.ts` | bun | 4.3 s | 180 s |
| 14 | physlive | main | `tools/protocol/physlive-check.ts` | bun | 1.3 s | 180 s |
| 15 | phystick | main | `tools/protocol/phystick-check.ts` | bun | 6 s | 180 s |
| 16 | sclock | main | `tools/protocol/sclock-check.ts` | bun | 2.8 s | 180 s |
| 17 | physseeds | main | `tools/protocol/physseeds-check.ts` | bun | 2.3 s | 180 s |
| 18 | eidosim | main | `tools/protocol/eidosim-check.ts` | bun | 12 s | 180 s |
| 19 | eidosim-live | main | `tools/protocol/eidosim-live-check.ts` | bun | 1.5 s | 180 s |
| 20 | mover | main | `tools/protocol/mover-check.ts` | bun | 5 s | 180 s |
| 21 | colliders | main | `tools/collider-test.ts` | bun | 0.2 s | 180 s |
| 22 | lying-support | main | `tools/lying-support-test.ts` | bun | 16 s | 180 s |
| 23 | replay | main | `tools/protocol/replay-check.ts` | bun | 0.4 s | 180 s |
| 24 | conformance | main | `tools/protocol/compare.ts` | python3 + cryptography | 2.9 s | 180 s |
| 25 | sweep | main | `tools/protocol/sweep.ts` | bun | 2 s | 180 s |
| 26 | oracle | main | `tools/protocol/import-v1/snapshot-oracle.ts` | bun | 5 s | 180 s |
| 27 | inplace | main | `tools/protocol/inplace-check.ts` | bun | 15 s | 180 s |
| 28 | oldworlds | main | `tools/oldworlds-test.ts` | bun | 1.2 s | 180 s |
| 29 | descriptors | main | `tools/descriptor-defaults-test.ts` | bun | 0.1 s | 180 s |
| 30 | light-readers | main | `tools/light-readers-test.ts` | bun | 0.4 s | 180 s |
| 31 | ghost-mesh-size | main | `tools/ghost-mesh-size-test.ts` | bun | 0.5 s | 180 s |
| 32 | boot-init | main | `tools/boot-init-test.ts` | bun | 0.7 s | 180 s |
| 33 | editor-range | main | `tools/editor-range-test.ts` | bun | 0.2 s | 180 s |
| 34 | lookat-forward | main | `tools/lookat-forward-check.ts` | bun | 0.5 s | 180 s |
| 35 | role-grammar | main | `tools/role-grammar-test.ts` | bun | 0.3 s | 180 s |
| 36 | lock-level | main | `tools/lock-level-test.ts` | bun | 0.1 s | 180 s |
| 37 | rot | main | `tools/rot-test.ts` | bun | 0.1 s | 180 s |
| 38 | dismount-height | main | `tools/dismount-height-test.ts` | bun | 0.2 s | 180 s |
| 39 | build-gate | main | `tools/build-gate-test.ts` | bun | 0.3 s | 180 s |
| 40 | capsule-recovery | main | `tools/capsule-recovery-test.mjs` | bun | 10 s | 180 s |
| 41 | debug-tabs | main | `tools/debug-tabs-test.ts` | bun | 0.4 s | 180 s |
| 42 | governor-xr | main | `tools/governor-xr-test.ts` | bun | 0.2 s | 180 s |
| 43 | unknown-comp | main | `tools/unknown-comp-test.ts` | bun | 1.1 s | 180 s |
| 44 | reach-order | main | `tools/reach-order-test.ts` | bun | 1 s | 180 s |
| 45 | editcommit | main | `tools/editcommit-test.ts` | bun | 0.8 s | 180 s |
| 46 | hierarchy-commit | main | `tools/hierarchy-commit-test.ts` | bun | 0.5 s | 180 s |
| 47 | verbclasses | main | `tools/protocol/verbclasses-check.ts` | bun | 0 s | 180 s |
| 48 | authority-layers | main | `tools/protocol/authority-layers-check.ts` | bun | 0 s | 180 s |
| 49 | ids | main | `tools/protocol/ids-check.ts` | bun | 1.5 s | 180 s |
| 50 | r8 | main | `tools/protocol/r8-check.ts` | bun | 1 s | 180 s |
| 51 | r9 | main | `tools/protocol/r9-check.ts` | bun | 1.5 s | 180 s |
| 52 | r10 | main | `tools/protocol/r10-check.ts` | bun | 1.8 s | 180 s |
| 53 | r11 | main | `tools/protocol/r11-check.ts` | bun | 0.6 s | 180 s |
| 54 | names | main | `tools/protocol/names-check.ts` | bun | 2.3 s | 180 s |
| 55 | parity | main | `tools/protocol/parity-check.ts` | bun | 5.4 s | 180 s |
| 56 | directory | main | `tools/protocol/directory-check.ts` | bun | 87 s | 435 s |
| 57 | keyhints | main | `tools/keyhints-check.ts` | bun | 0.1 s | 180 s |
| 58 | server | main | `tools/protocol/server-check.ts` | bun | 44 s | 220 s |
| 59 | fork-reset | main | `tools/protocol/fork-reset-check.ts` | bun | 8 s | 180 s |
| 60 | scripts | main | `tools/protocol/scripts-check.ts` | bun | 60 s | 300 s |
| 61 | grab | main | `tools/protocol/grab-check.ts` | bun | 4.6 s | 180 s |
| 62 | shove | main | `tools/protocol/shove-check.ts` | bun | 2.4 s | 180 s |
| 63 | shove-walker | main | `tools/shove-test.ts` | bun | 0.2 s | 180 s |
| 64 | agentshove | main | `tools/protocol/agentshove-check.ts` | bun | 166 s | 830 s |
| 65 | hands | main | `tools/protocol/hands-check.ts` | bun | 1.4 s | 180 s |
| 66 | reset | main | `tools/protocol/reset-check.ts` | bun | 2.3 s | 180 s |
| 67 | settle | main | `tools/protocol/settle-check.ts` | bun | 6 s | 180 s |
| 68 | disabled | main | `tools/protocol/disabled-check.ts` | bun | 1.2 s | 180 s |
| 69 | histdiff | main | `tools/protocol/history-diff-check.ts` | bun | 0.3 s | 180 s |
| 70 | reachgate | main | `tools/protocol/reachgate-check.ts` | bun | 22 s | 180 s |
| 71 | consent | main | `tools/protocol/consent-check.ts` | bun | 0 s | 180 s |
| 72 | history-rows | main | `tools/protocol/history-rows-check.ts` | bun | 0.5 s | 180 s |
| 73 | scale | main | `tools/protocol/scale-check.ts` | bun | 131 s | 655 s |
| 74 | roles | main | `tools/protocol/roles-check.ts` | bun | 3.4 s | 180 s |
| 75 | batch2 | main | `tools/protocol/batch2-check.ts` | bun | 1.9 s | 180 s |
| 76 | describe-particles | main | `tools/protocol/describe-particles-check.ts` | bun | 1.1 s | 180 s |
| 77 | build | main | `tools/protocol/build-check.ts` | bun | 1.6 s | 180 s |
| 78 | counter | main | `tools/protocol/counter-check.ts` | bun | 2.2 s | 180 s |
| 79 | shiplist | main | `tools/protocol/shiplist-check.ts` | bun | 1.7 s | 180 s |
| 80 | agenttools | main | `tools/protocol/agenttools-check.ts` | bun | 22 s | 180 s |
| 81 | presence | main | `tools/protocol/presence-check.ts` | bun | 10 s | 180 s |
| 82 | modhole | main | `tools/protocol/modhole-check.ts` | bun | 0.1 s | 180 s |
| 83 | pretrans | main | `tools/protocol/pretrans-check.ts` | bun | 3 s | 180 s |
| 84 | soundclock | main | `tools/protocol/soundclock-check.ts` | bun | 0.5 s | 180 s |
| 85 | eidomodel | main | `tools/protocol/eidomodel-check.ts` | bun | 0.8 s | 180 s |
| 86 | alias | main | `mcpl/alias-test.ts` | bun | 0.4 s | 180 s |
| 87 | agent-mesh-collision | main | `tools/agent-mesh-collision-test.ts` | bun | 93 s | 465 s |
| 88 | navgrid | main | `tools/navgrid-test.ts` | bun | 64 s | 320 s |
| 89 | navgrid-edge | main | `tools/navgrid-edge-test.ts` | bun | 0.7 s | 180 s |
| 90 | places | main | `tools/places-test.ts` | bun | 146 s | 730 s |
| 91 | places-scale | main | `tools/places-scale-test.ts` | bun | 16 s | 180 s |
| 92 | shape-attach | main | `tools/shape-attach-test.ts` | bun | 1.7 s | 180 s |
| 93 | shape-physics | main | `tools/shape-physics-test.ts` | bun | 1.4 s | 180 s |
| 94 | shape-repair | main | `tools/shape-repair-test.ts` | bun | 0.7 s | 180 s |
| 95 | buildcheck | main | `tools/buildcheck-test.ts` | bun | 36 s | 180 s |
| 96 | buildcheck-queue | main | `tools/buildcheck-queue-test.ts` | bun | 11 s | 180 s |
| 97 | buildcheck-route | main | `tools/buildcheck-route-test.ts` | bun | 38 s | 190 s |
| 98 | browser | browser | `tools/protocol/browser-check.ts` | Chromium | 1.5 s | 180 s |
| 99 | client | browser | `tools/protocol/client-check.ts` | Chromium | 60 s | 300 s |
| 100 | refusedjoin | browser | `tools/protocol/refusedjoin-check.ts` | Chromium | 126 s | 630 s |
| 101 | client-b2 | browser | `tools/protocol/batch2-probe.ts` | Chromium | 19 s | 180 s |
| 102 | build-client | browser | `tools/protocol/build-probe.ts` | Chromium | 8.1 s | 180 s |
| 103 | shiplist-probe | browser | `tools/protocol/shiplist-probe.ts` | Chromium | 197 s | 985 s |
| 104 | xss-probe | browser | `tools/protocol/xss-probe.ts` | Chromium | 15 s | 180 s |
| 105 | party-probe | browser | `tools/protocol/party-probe.ts` | Chromium | 486 s | 2430 s |
| 106 | colour-picker | browser | `tools/colour-picker-bench.ts` | Chromium | 8.1 s | 180 s |
| 107 | client-tools | browser | `tools/run-client.ts --import-only` | Chromium | 202 s | 1010 s |

Lanes: core 7 suites (~68 s), main 90 (~1115 s), browser 10 (~1123 s); 107 suites in all.
<!-- END GENERATED -->
