# PR #160 follow-up

This fixes the nine findings from the follow-up review of `9095328`
(the same code tree as `151a76b`).

Queued requests now catch and report asynchronous failures without terminating
the sequencer or preventing later requests from running. Box reads share a
process-wide pool of four workers and one pending promise per library. The
product-door regression seeds a world before boot, holds observed GLB reads,
and checks the actual folded position/component and epoch/punt ordering.
It generates its own small GLBs and needs no external model library.

New epochs use **eidosim@0.5.0**. Collisions sweep the remaining movement after
each contact, including ground support, so bodies slide on decks, fall from
edges, and meet subsequent walls even on coarse ticks. Existing epochs retain
their recorded laws; adopting 0.5 in an existing world requires an owner-issued
epoch upgrade. Eight contacts bound work per body/tick. Once the final live
body rests, all carried versions jump over remaining idle ticks.

Replay fixtures now have golden digests for complete ordered sim state.
The 0.3/0.4 digests captured before the correction remain unchanged. New
fixtures cover 0.5 and a two-body final state, with mutation checks for boxes,
colliders, and body/static insertion order.

Ground-smoke drives the actual browser applier at fixed 60Hz clock values over
a copy of the client sim, then restores the live fold. It still uses real
product-door intents, hydrated entities, model loading and reloads. It hashes
the asset response actually consumed by the browser; the source GLB and KTX2
variant were separately measured and pinned. Normal rendering and a browser
limited to about 3 fps both sample 95 moving frames per flight and pass all
geometry checks. No sample-count assertion depends on the display frame rate.

The doll suite uses a committed skeleton containing humanoid, wing and hair
nodes plus an explicit digit-free variant. All 69 assertions, including the
renderer-matrix checks, run without the private VRM. `--fleet` additionally
exercises installed avatars. Source VRM hash and extraction instructions are
recorded with the fixture.

The harness verifies server and browser ownership, retains separate stdout,
stderr and browser event logs on startup failures, assertion failures and
uncaught exceptions, and surfaces CDP evaluation exceptions. Scratch servers
also own their relay-incarnation file through `RELAY_STATE_DIR`; production's
default path is unchanged. Existing log-reading checks consume both streams.

## Validation

| Gate | Result |
| --- | --- |
| `bun tools/sim-test.ts` | 59/59, including thin walls at 66/250/1000ms, sliding, edge falls and long-gap resume |
| `bun tools/verb-order-test.ts` | 12/12 through the real WebSocket door |
| `bun tools/verb-order-mutation-test.ts` | Restoring the epoch ordering race makes the door gate fail |
| `bun tools/boxes-test.ts` | 6/6; ten callers, twelve libraries, four concurrent reads, twelve total reads |
| `bun tools/replaybench.ts` with empty operator worlds | 4/4 committed fixture worlds |
| `bun tools/replaybench-test.ts` | 9/9, including five rejected state mutations and Bun/Node/Deno identity |
| `bun tools/harness-test.ts` | 10/10; wrong nonce refused and failure artifacts survive cleanup |
| `bun tools/sim-ground-smoke.ts` | 11/11 |
| `bun tools/sim-ground-smoke.ts --slow-frames` | 11/11 at about 3 browser fps |
| `bun tools/sim-smoke.ts` | 15/15, including sequencer/replay/browser bit identity |
| `bun tools/defs-smoke.ts` | 31/31 |
| `bun tools/ammodoll-test.ts` | 69/69 using committed skeleton fixtures |
| `bun tools/ammodoll-test.ts --fleet` | 69/69 with the installed avatar fleet |
| `bun tools/foldfix-test.ts` / `bun tools/state-test.ts` | 24/24 and 31/31 |
| `bun tools/world-open-test.ts` | 4/4 |
| `bun tools/wing-owner-wire-test.ts` / `bun tools/chat-log-test.ts` | 6/6 and 15/15 |
| `bun tools/simmath-test.ts` | 14/14 including Bun/JSC, Node/V8 and Deno/V8 |
| `bun tools/flight-test.ts` / `bun tools/wing-fold-presence-test.ts` | 231/231 and 28/28 |
| `bun run typecheck:flight` / `git diff --check` | Pass |

The review's crash discriminator now returns a client-visible error and leaves
the sequencer alive in both synchronous and cold-queued cases. The 69-body,
30-day resume discriminator completes in under a millisecond here even when
the last live body settles during catch-up; the regression gate allows 100ms.

Browser gates require the declared client dependencies, Chrome/WebGPU and the
model library. A different served barrels asset is an explicit prerequisite
failure until its geometry is measured and its hash added to the fixture.
