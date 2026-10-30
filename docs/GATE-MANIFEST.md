# The protocol gate

`tools/protocol/run.ts` is the protocol gate. It runs every protocol suite in its own process, in three lanes, and it
passes only when every suite passed and none was skipped. This file describes what the gate needs and how it reports.
The suite table at the bottom is generated from `run.ts` (`--manifest`), and the gate refuses to start when the two
disagree, so the table can't drift.

## Running it

```sh
bun install --frozen-lockfile                 # in the checkout root, in client/, and in mcpl/
CHROME=/path/to/chrome EIDOVERSE_DIR=/path/to/eidoverse-video bun tools/protocol/run.ts    # or: bun run test:protocol
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

1. **core** covers transactions and security: `kernel`, `gov-reserved`, `nov1`, `vocab`, `authority` (which holds the
   storage and durability rows), `access`, `identity`, `scars`, `reset-race`, `txn` (every request ends committed,
   rolled-back or ambiguous; one request capability rechecked at both await-to-commit seams) and `txn-mutants` (each
   `txn` row turns red under its mutation). It runs first, and the first failure or skip stops the gate.
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
| `EIDOVERSE_DIR` | `<suite dir>/library` (empty) for core and main; **the browser lane requires it** | the asset library is a separate public repo, `SkyeShark/eidoverse-video`, pinned at `9acc1528b2febac11338107645ef500a95985ca5`. Set `EIDOVERSE_DIR` to a checkout of it; without one the gate fails before any suite runs, naming the clone command. Only browser suites see it, read-only |
| `OPT_DIR`, `WORLDS_DIR`, `PATCH_DIR` | `<suite dir>/{opt,worlds,patched}`; `opt` is seeded with the files git tracks under `assets/opt` (today `props/ball.glb`) | nothing writes into the checkout's `assets/opt`, `worlds/` or `patched/`; no host cache is visible, but the repo's own committed fixtures are |
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
OS (`tools/protocol/procgroup.ts`: `/proc` on Linux, `ps` on macOS, the process tree on Windows), and PATH is searched
with the OS's own separator. The script sandbox tells a starved process from a stuck script with `/proc` CPU time on
Linux and, where there is no `/proc`, by whether the process ever took the job (scripts-check I8 and I8n).

`.github/workflows/protocol-gate.yml` runs the whole gate on all three OSes at the exact head of every PR, and each run
uploads a receipt (`--receipt <file>`): the head, whether the tree was dirty, OS, runtimes, the asset library's head,
every suite's result and a hash of its output, and one hash over all of them. That receipt, not a sentence in a PR
comment, is the evidence of a pass.

Known gap, said plainly: the macOS and Windows paths were written and tested on Linux (the macOS process path against
`ps`, the Windows tree walk on fixed tables, the no-`/proc` sandbox path by switching the reading off). Their first real
runs are that workflow's.

## Suites

The expected times come from the reference host (WSL2, 16 threads, 7 GB, 2026-10-18), with one suite running at a
time.

<!-- BEGIN GENERATED: bun tools/protocol/run.ts --manifest -->
| # | suite | lane | file | needs | expected | timeout |
|---|---|---|---|---|---|---|
| 1 | kernel | core | `tools/protocol/kernel-check.ts` | bun | 0.5 s | 180 s |
| 2 | trig | core | `tools/protocol/trig-check.ts` | bun | 0.2 s | 180 s |
| 3 | laws | core | `tools/protocol/laws-check.ts` | bun | 0.3 s | 180 s |
| 4 | engine | core | `tools/protocol/engine-check.ts` | bun | 0.6 s | 180 s |
| 5 | normative | core | `tools/protocol/normative-check.ts` | bun | 0.2 s | 180 s |
| 6 | gov-reserved | core | `tools/protocol/gov-reserved-check.ts` | bun | ? | 300 s |
| 7 | diffcheck | core | `tools/protocol/diffcheck.ts` | bun | ? | 300 s |
| 8 | hygiene | core | `tools/protocol/hygiene-check.ts` | bun | 0.4 s | 180 s |
| 9 | procgroup | core | `tools/protocol/procgroup-check.ts` | bun | ? | 300 s |
| 10 | nov1 | core | `tools/protocol/nov1-check.ts` | bun | 0.7 s | 180 s |
| 11 | vocab | core | `tools/protocol/vocab-check.ts` | bun | 3.5 s | 180 s |
| 12 | authority | core | `tools/protocol/authority-check.ts` | bun | 9 s | 180 s |
| 13 | access | core | `tools/protocol/access-check.ts` | bun | 8.3 s | 180 s |
| 14 | identity | core | `tools/protocol/identity-check.ts` | bun | 42 s | 210 s |
| 15 | scars | core | `tools/protocol/scars-check.ts` | bun | 1 s | 180 s |
| 16 | reset-race | core | `tools/protocol/reset-race-check.ts` | bun | 0.4 s | 180 s |
| 17 | txn | core | `tools/protocol/txn-check.ts` | bun | 0.8 s | 180 s |
| 18 | txn-mutants | core | `tools/protocol/txn-check.ts --mutants` | bun | 11 s | 180 s |
| 19 | nonumber | main | `tools/protocol/nonumber-check.ts` | bun | 1.4 s | 180 s |
| 20 | hostile | main | `tools/protocol/hostile-check.ts` | bun | 0.3 s | 180 s |
| 21 | attack | main | `tools/protocol/attack-check.ts` | bun | 1.5 s | 180 s |
| 22 | libfile | main | `tools/protocol/libfile-check.ts` | bun | 0.1 s | 180 s |
| 23 | gaps | main | `tools/protocol/gaps-check.ts` | bun | 5.6 s | 180 s |
| 24 | phys | main | `tools/protocol/phys-check.ts` | bun | 3.9 s | 180 s |
| 25 | physlive | main | `tools/protocol/physlive-check.ts` | bun | 1.2 s | 180 s |
| 26 | phystick | main | `tools/protocol/phystick-check.ts` | bun | 5.7 s | 180 s |
| 27 | sclock | main | `tools/protocol/sclock-check.ts` | bun | 2.8 s | 180 s |
| 28 | physseeds | main | `tools/protocol/physseeds-check.ts` | bun | 2.1 s | 180 s |
| 29 | eidosim | main | `tools/protocol/eidosim-check.ts` | bun | 12 s | 180 s |
| 30 | eidosim-live | main | `tools/protocol/eidosim-live-check.ts` | bun | 1.5 s | 180 s |
| 31 | mover | main | `tools/protocol/mover-check.ts` | bun | 4.5 s | 180 s |
| 32 | zone-water | main | `tools/protocol/zone-water-check.ts` | bun | 0.6 s | 180 s |
| 33 | climb-env | main | `tools/protocol/climb-env-check.ts` | bun | 0.5 s | 180 s |
| 34 | drive | main | `tools/protocol/drive-check.ts` | bun | 0.6 s | 180 s |
| 35 | physics-area | main | `tools/protocol/physics-area-check.ts` | bun | 0.5 s | 180 s |
| 36 | water-vectors | main | `tools/water-vectors.ts --check` | bun | 0.2 s | 180 s |
| 37 | water-import | main | `tools/water/import-golden-check.ts` | bun | ? | 300 s |
| 38 | avatar | main | `tools/avatar-test.ts` | bun | 1 s | 180 s |
| 39 | remotes-limp-edge | main | `tools/remotes-limp-edge-test.ts` | bun | 0.5 s | 180 s |
| 40 | colliders | main | `tools/collider-test.ts` | bun | 0.2 s | 180 s |
| 41 | collider-off-bodies | main | `tools/collider-off-bodies-test.ts` | bun | 2 s | 180 s |
| 42 | lying-support | main | `tools/lying-support-test.ts` | bun | 16 s | 180 s |
| 43 | support-swap | main | `tools/support-swap-test.ts` | bun | ? | 300 s |
| 44 | knockdown | main | `tools/knockdown-test.ts` | bun | ? | 300 s |
| 45 | sockets | main | `tools/sockets-test.ts` | bun | ? | 300 s |
| 46 | msgrate | main | `tools/msgrate-test.ts` | bun | 0.1 s | 180 s |
| 47 | shape-render | main | `tools/shape-render-test.ts` | bun | ? | 300 s |
| 48 | originof | main | `tools/originof-test.ts` | bun | ? | 300 s |
| 49 | renderer-cred | main | `tools/renderer-cred-test.ts` | bun | ? | 300 s |
| 50 | replay | main | `tools/protocol/replay-check.ts` | bun | 0.4 s | 180 s |
| 51 | conformance | main | `tools/protocol/compare.ts` | python3 + cryptography | 2.9 s | 180 s |
| 52 | sweep | main | `tools/protocol/sweep.ts` | bun | 0.3 s | 180 s |
| 53 | oracle | main | `tools/protocol/import-v1/snapshot-oracle.ts` | bun | 0.4 s | 180 s |
| 54 | inplace | main | `tools/protocol/inplace-check.ts` | bun | 15 s | 180 s |
| 55 | version-route | main | `tools/version-route-test.ts` | bun | ? | 300 s |
| 56 | migrate-identities | main | `tools/protocol/migrate-identities-check.ts` | bun | 1.7 s | 180 s |
| 57 | oldworlds | main | `tools/oldworlds-test.ts` | bun | 1.2 s | 180 s |
| 58 | descriptors | main | `tools/descriptor-defaults-test.ts` | bun | 0.1 s | 180 s |
| 59 | light-readers | main | `tools/light-readers-test.ts` | bun | 0.4 s | 180 s |
| 60 | ghost-mesh-size | main | `tools/ghost-mesh-size-test.ts` | bun | 0.5 s | 180 s |
| 61 | boot-init | main | `tools/boot-init-test.ts` | bun | 0.5 s | 180 s |
| 62 | editor-range | main | `tools/editor-range-test.ts` | bun | 0.3 s | 180 s |
| 63 | editschema | main | `tools/editschema-test.ts` | bun | 0.5 s | 180 s |
| 64 | lookat-forward | main | `tools/lookat-forward-check.ts` | bun | 0.5 s | 180 s |
| 65 | scriptnew-expect | main | `tools/scriptnew-expect-test.ts` | bun | 0.5 s | 180 s |
| 66 | role-grammar | main | `tools/role-grammar-test.ts` | bun | 0.3 s | 180 s |
| 67 | rot | main | `tools/rot-test.ts` | bun | 0.1 s | 180 s |
| 68 | onepose | main | `tools/protocol/onepose-check.ts` | bun | 0.3 s | 180 s |
| 69 | helm-leave | main | `tools/helm-leave-test.ts` | bun | 0.2 s | 180 s |
| 70 | dismount-height | main | `tools/dismount-height-test.ts` | bun | 0.2 s | 180 s |
| 71 | latestread | main | `tools/latestread-test.ts` | bun | ? | 300 s |
| 72 | csp | main | `tools/csp-test.ts` | bun | ? | 300 s |
| 73 | build-gate | main | `tools/build-gate-test.ts` | bun | 0.3 s | 180 s |
| 74 | capsule-recovery | main | `tools/capsule-recovery-test.mjs` | bun | 10 s | 180 s |
| 75 | debug-tabs | main | `tools/debug-tabs-test.ts` | bun | 0.3 s | 180 s |
| 76 | governor-xr | main | `tools/governor-xr-test.ts` | bun | 0.2 s | 180 s |
| 77 | unknown-comp | main | `tools/unknown-comp-test.ts` | bun | 1.1 s | 180 s |
| 78 | reach-order | main | `tools/reach-order-test.ts` | bun | 1.5 s | 180 s |
| 79 | editcommit | main | `tools/editcommit-test.ts` | bun | 0.8 s | 180 s |
| 80 | hierarchy-commit | main | `tools/hierarchy-commit-test.ts` | bun | 0.6 s | 180 s |
| 81 | verbclasses | main | `tools/protocol/verbclasses-check.ts` | bun | 0 s | 180 s |
| 82 | authority-layers | main | `tools/protocol/authority-layers-check.ts` | bun | 0 s | 180 s |
| 83 | ids | main | `tools/protocol/ids-check.ts` | bun | 1.4 s | 180 s |
| 84 | r8 | main | `tools/protocol/r8-check.ts` | bun | 0.9 s | 180 s |
| 85 | r9 | main | `tools/protocol/r9-check.ts` | bun | 1.5 s | 180 s |
| 86 | r10 | main | `tools/protocol/r10-check.ts` | bun | 1.7 s | 180 s |
| 87 | r11 | main | `tools/protocol/r11-check.ts` | bun | 0.6 s | 180 s |
| 88 | names | main | `tools/protocol/names-check.ts` | bun | 2.1 s | 180 s |
| 89 | parity | main | `tools/protocol/parity-check.ts` | bun | 5.4 s | 180 s |
| 90 | directory | main | `tools/protocol/directory-check.ts` | bun | 13 s | 180 s |
| 91 | keyhints | main | `tools/keyhints-check.ts` | bun | 0 s | 180 s |
| 92 | upgrade | main | `tools/protocol/upgrade-check.ts` | bun | 70 s | 350 s |
| 93 | server | main | `tools/protocol/server-check.ts` | bun | 40 s | 200 s |
| 94 | fork-reset | main | `tools/protocol/fork-reset-check.ts` | bun | 6 s | 180 s |
| 95 | simckpt | main | `tools/protocol/simckpt-check.ts` | bun | ? | 300 s |
| 96 | statecache | main | `tools/protocol/statecache-check.ts` | bun | ? | 300 s |
| 97 | foldparity | main | `tools/protocol/foldparity-check.ts` | bun | ? | 300 s |
| 98 | blockers-mutants | main | `tools/protocol/blockers-mutants.ts` | bun | 420 s | 2100 s |
| 99 | scripts | main | `tools/protocol/scripts-check.ts` | bun | 48 s | 240 s |
| 100 | scripting | main | `tools/protocol/scripting-check.ts` | bun | 2 s | 180 s |
| 101 | grab | main | `tools/protocol/grab-check.ts` | bun | 3.8 s | 180 s |
| 102 | shove | main | `tools/protocol/shove-check.ts` | bun | 2 s | 180 s |
| 103 | shove-walker | main | `tools/shove-test.ts` | bun | 0.1 s | 180 s |
| 104 | force | main | `tools/protocol/force-check.ts` | bun | ? | 300 s |
| 105 | physconst | main | `tools/physconst-test.ts` | bun | ? | 300 s |
| 106 | agentshove | main | `tools/protocol/agentshove-check.ts` | bun | 165 s | 825 s |
| 107 | hands | main | `tools/protocol/hands-check.ts` | bun | 1.2 s | 180 s |
| 108 | reset | main | `tools/protocol/reset-check.ts` | bun | 1.7 s | 180 s |
| 109 | settle | main | `tools/protocol/settle-check.ts` | bun | 5.4 s | 180 s |
| 110 | disabled | main | `tools/protocol/disabled-check.ts` | bun | 1.2 s | 180 s |
| 111 | histdiff | main | `tools/protocol/history-diff-check.ts` | bun | 0.3 s | 180 s |
| 112 | reachgate | main | `tools/protocol/reachgate-check.ts` | bun | 22 s | 180 s |
| 113 | consent | main | `tools/protocol/consent-check.ts` | bun | 0 s | 180 s |
| 114 | gates | main | `tools/protocol/gates-check.ts` | bun | 0.1 s | 180 s |
| 115 | consent-client | main | `tools/consent-client-test.ts` | bun | 0.2 s | 180 s |
| 116 | history-rows | main | `tools/protocol/history-rows-check.ts` | bun | 0.6 s | 180 s |
| 117 | scale | main | `tools/protocol/scale-check.ts` | bun | 125 s | 625 s |
| 118 | roles | main | `tools/protocol/roles-check.ts` | bun | 3.1 s | 180 s |
| 119 | batch2 | main | `tools/protocol/batch2-check.ts` | bun | 1.9 s | 180 s |
| 120 | describe-particles | main | `tools/protocol/describe-particles-check.ts` | bun | 1.1 s | 180 s |
| 121 | build | main | `tools/protocol/build-check.ts` | bun | 1.5 s | 180 s |
| 122 | counter | main | `tools/protocol/counter-check.ts` | bun | 2.2 s | 180 s |
| 123 | shiplist | main | `tools/protocol/shiplist-check.ts` | bun | 1.7 s | 180 s |
| 124 | agenttools | main | `tools/protocol/agenttools-check.ts` | bun | 20 s | 180 s |
| 125 | presence | main | `tools/protocol/presence-check.ts` | bun | 10 s | 180 s |
| 126 | modhole | main | `tools/protocol/modhole-check.ts` | bun | 0.1 s | 180 s |
| 127 | pretrans | main | `tools/protocol/pretrans-check.ts` | bun | 2.8 s | 180 s |
| 128 | soundclock | main | `tools/protocol/soundclock-check.ts` | bun | 0.2 s | 180 s |
| 129 | sound | main | `tools/sound-test.ts` | bun | ? | 300 s |
| 130 | sound-editor | main | `tools/sound-guard-test.ts` | bun | ? | 300 s |
| 131 | skypanel | main | `tools/skypanel-state-test.ts` | bun | ? | 300 s |
| 132 | physics-off | main | `tools/physics-off-test.ts` | bun | ? | 300 s |
| 133 | eidomodel | main | `tools/protocol/eidomodel-check.ts` | bun | 0.7 s | 180 s |
| 134 | alias | main | `mcpl/alias-test.ts` | bun | 0.4 s | 180 s |
| 135 | agent-mesh-collision | main | `tools/agent-mesh-collision-test.ts` | bun | 92 s | 460 s |
| 136 | navgrid | main | `tools/navgrid-test.ts` | bun | 64 s | 320 s |
| 137 | navgrid-edge | main | `tools/navgrid-edge-test.ts` | bun | 0.6 s | 180 s |
| 138 | places | main | `tools/places-test.ts` | bun | 130 s | 650 s |
| 139 | places-scale | main | `tools/places-scale-test.ts` | bun | 6.3 s | 180 s |
| 140 | storey-walk | main | `mcpl/storey-walk-test.ts` | bun | 1.5 s | 180 s |
| 141 | door-unit | main | `mcpl/door-unit-test.ts` | bun | ? | 300 s |
| 142 | effective-mcpl | main | `mcpl/effective-test.ts` | bun | ? | 300 s |
| 143 | effective | main | `tools/effective-test.ts` | bun | ? | 300 s |
| 144 | stretched-support | main | `mcpl/stretched-support-test.ts` | bun | ? | 300 s |
| 145 | stretched-places | main | `mcpl/stretched-places-test.ts` | bun | ? | 300 s |
| 146 | door-body | main | `mcpl/door-body-test.ts` | bun | ? | 300 s |
| 147 | shape-attach | main | `tools/shape-attach-test.ts` | bun | 0.7 s | 180 s |
| 148 | shape-physics | main | `tools/shape-physics-test.ts` | bun | 0.7 s | 180 s |
| 149 | shape-repair | main | `tools/shape-repair-test.ts` | bun | 0.4 s | 180 s |
| 150 | buildcheck | main | `tools/buildcheck-test.ts` | bun | 18 s | 180 s |
| 151 | buildcheck-queue | main | `tools/buildcheck-queue-test.ts` | bun | 7.4 s | 180 s |
| 152 | buildcheck-route | main | `tools/buildcheck-route-test.ts` | bun | 22 s | 180 s |
| 153 | door-is-error | main | `tools/door-is-error-test.ts` | bun | 280 s | 1400 s |
| 154 | door-wording | main | `tools/door-wording-test.ts` | bun | ? | 300 s |
| 155 | consent-replay | main | `tools/consent-replay-test.ts` | bun | ? | 300 s |
| 156 | history-request | main | `tools/history-request-test.ts` | bun | 0.3 s | 180 s |
| 157 | wing-fold-presence | main | `tools/wing-fold-presence-test.ts` | bun | 0.3 s | 180 s |
| 158 | skystamp | main | `tools/skystamp-test.ts` | bun | 0.5 s | 180 s |
| 159 | grant-command | main | `tools/grant-command-test.ts` | bun | 0.3 s | 180 s |
| 160 | environment-realizer | main | `tools/environment-realizer-test.ts` | bun | 0.3 s | 180 s |
| 161 | grant-until | main | `tools/grant-until-test.ts` | bun | 1 s | 180 s |
| 162 | lite-graph | main | `tools/lite-graph-test.ts` | bun | 1 s | 180 s |
| 163 | say-live | main | `tools/say-live-test.ts` | bun | 1 s | 180 s |
| 164 | presence-actor | main | `tools/presence-actor-test.ts` | bun | 1 s | 180 s |
| 165 | first-name-account | main | `tools/first-name-account-test.ts` | bun | 1 s | 180 s |
| 166 | retired-commands | main | `tools/retired-commands-test.ts` | bun | 1 s | 180 s |
| 167 | animnames-retry | main | `tools/animnames-retry-test.ts` | bun | 2.5 s | 180 s |
| 168 | panels | main | `tools/panels-test.ts` | bun | 1 s | 180 s |
| 169 | surface-hold | main | `tools/surface-hold-test.ts` | bun | 19 s | 180 s |
| 170 | particles | main | `tools/particles-test.ts` | bun | 1 s | 180 s |
| 171 | shadow-fade | main | `tools/shadow-fade-test.mjs` | bun | 1 s | 180 s |
| 172 | frames-layout | main | `tools/frames-layout-test.ts` | bun | 1 s | 180 s |
| 173 | models-field | main | `tools/models-field-test.ts` | bun | 1 s | 180 s |
| 174 | translate | main | `tools/protocol/translate-check.ts` | bun | 6 s | 180 s |
| 175 | owners | main | `tools/protocol/owners-check.ts` | bun | ? | 300 s |
| 176 | setup | main | `tools/protocol/setup-check.ts` | bun | 3 s | 180 s |
| 177 | importer | main | `tools/protocol/importer-check.ts` | bun | 1.2 s | 180 s |
| 178 | eidosim-v1 | main | `tools/protocol/import-v1/eidosim-v1-test.ts` | bun | 0.2 s | 180 s |
| 179 | render-scene-import | main | `tools/render-scene-import-test.ts` | bun | ? | 300 s |
| 180 | channelbox | main | `tools/channelbox-test.ts` | bun | ? | 300 s |
| 181 | last-world | main | `tools/last-world-test.ts` | bun | 0.6 s | 180 s |
| 182 | event-wire | main | `tools/event-wire-test.ts` | bun | 0.1 s | 180 s |
| 183 | killz-slumped | main | `tools/killz-slumped-test.ts` | bun | 32 s | 180 s |
| 184 | consent-scripts-list | main | `tools/consent-scripts-list-test.ts` | bun | 2 s | 180 s |
| 185 | level-dive | browser | `tools/water/level-dive-check.ts` | Chromium | ? | 300 s |
| 186 | toast-group | browser | `tools/protocol/toast-group-check.ts` | Chromium | ? | 300 s |
| 187 | browser | browser | `tools/protocol/browser-check.ts` | Chromium | 1.5 s | 180 s |
| 188 | client | browser | `tools/protocol/client-check.ts` | Chromium | 60 s | 300 s |
| 189 | refusedjoin | browser | `tools/protocol/refusedjoin-check.ts` | Chromium | 150 s | 750 s |
| 190 | client-b2 | browser | `tools/protocol/batch2-probe.ts` | Chromium | 19 s | 180 s |
| 191 | access-panel | browser | `tools/protocol/access-panel-probe.ts` | Chromium | ? | 300 s |
| 192 | lock-strength | browser | `tools/lock-strength-test.ts` | Chromium | 10 s | 180 s |
| 193 | swim-lists | browser | `tools/swim-lists-test.ts` | Chromium | 10 s | 180 s |
| 194 | build-client | browser | `tools/protocol/build-probe.ts` | Chromium | 8.1 s | 180 s |
| 195 | shiplist-probe | browser | `tools/protocol/shiplist-probe.ts` | Chromium | 197 s | 985 s |
| 196 | xss-probe | browser | `tools/protocol/xss-probe.ts` | Chromium | 15 s | 180 s |
| 197 | party-probe | browser | `tools/protocol/party-probe.ts` | Chromium | 486 s | 2430 s |
| 198 | colour-picker | browser | `tools/colour-picker-bench.ts` | Chromium | 8.1 s | 180 s |
| 199 | client-tools | browser | `tools/run-client.ts --import-only --skip-suites` | Chromium | 202 s | 1010 s |

Lanes: core 18 suites (~79 s), main 166 (~1796 s), browser 15 (~1167 s); 199 suites in all.
<!-- END GENERATED -->
