# PR 1 — In-process SFU: relay-floor phase 1 (#104)

*Draft. Not pushed. Numbers re-derived 2026-08-16; re-derive again before posting.*

**Target:** `anima-research/eidoverse-worlds` ← `octopusburrow/eidoverse-worlds:relay-spike`
**Closes/advances:** #104 phase 1

---

## What this is

The relay-only, generation-bound staging spike #104 §8.1 authorized, judged
against the nine-row acceptance table antra approved. **It is a third
hypothesis, not a departure from the two named ones.** §8.1's words are
*"Galène and LiveKit are **hypotheses**; the spike decides against one
acceptance table"* — so an in-process SFU is a candidate the same table judges,
and what was settled was the **topology** (relay-floor, server-carried
substrate), not the implementation.

It is ~700 lines of TypeScript on `werift`, terminating WebRTC server-side and
forwarding **encoded Opus without decoding it**. No external service, no second
binary, no API secret, no Redis, no domain.

**Why it stayed small, stated once because it is the whole argument:** we
terminate WebRTC server-side, so the *browser* keeps its own jitter buffer, PLC,
FEC and congestion control. And every (listener, speaker) pair gets its own
track, so no two sources ever share a stream — the SSRC/sequence/timestamp
rewriting that makes SFUs hard **does not exist here to get wrong**.

## The acceptance table, honestly

| # | Row (#104 §8.1) | Status |
|---|---|---|
| 1 | primary/media credential binding and takeover (A1) | **MET** — seven refusals enforced on the live path |
| 2 | publisher/subscriber generation and relay-epoch restart (A2) | **MET** — durable incarnation (verified `i1-`→`i2-`); `gen` now compared on every answer |
| 3 | per-listener consent, hush, mute/moderation, revocation latency (A3) | **MET** — three independent states; revocation is a memory write, unit-measured <50 ms |
| 4 | one stream per speaker with client spatialization | **MET** — msid-carried identity, verified against real Chromium |
| 5 | agent/browser TTS through the same relay contract | **PARTIAL** — browser proven end-to-end by ear; the agent leg's sidecar is not in this repo |
| 6 | reconnect without duplicate playback | **PARTIAL** — reconnect handled and tested; *duplicate playback specifically* is untested |
| 7 | cold relay death and supervised restart | **PARTIAL** — `voice-service {state, incarnation}` + recovery; in-process makes death total rather than impossible, so the row is CONVERTED, not satisfied |
| 8 | N=2/6/12, bandwidth, CPU, loss/FEC, proximity | **PARTIAL** — N=6 loopback: 100.0% delivery, 55.2% CPU (upper bound: all peers in one process), 0.25 Mbps. Loss is now injected and degrades proportionally, but that harness **models** the link rather than routing through the SFU and says so; the real receipt needs two browsers and a shaped link. N=12 on a real network unproven |
| 9 | operational footprint and diagnostics | **MET** — one process, `/relay-diag` per leg/gen/consent/forwarded/suppressed |

**4 MET, 4 PARTIAL, 1 CONVERTED.** No row is dropped; the unmeasured ones are named,
per §8.1's "UNMEASURED rows named, never dropped."

## The six amendments (2026-08-13)

1. **A LiveKit JWT is not revocation** → seven refusals (wrong world, wrong
   identity, retired primary gen, retired media gen, prior incarnation, replay,
   no living primary), enforced at `sfu-answer`, the first authenticated act
   after issuance. Verified against the real adapter: a legitimate client is
   admitted and each forgery class refused **by name**. There is no API secret
   to expose — the credential is a nonce we mint and burn.
2. **`relayEpoch` must survive the failure it names** → durable incarnation,
   atomic tmp+rename, verified `i1-` → `i2-` across restarts. Honestly named an
   *incarnation ID*: only the counter half is ordered.
3. **Separate listener consent from publisher/moderator mute** → three verbs,
   three states. `voice-consent` (listener-authored, gen-bound, fail-closed),
   the client's pre-encode gate, and `voice-moderate` (owner rank; broadcasts
   `voice-moderated` so a silence is never mistaken for a bug).
4. **Split the two Bun kill questions** → moot: no LiveKit SDK, no `rtc-node`,
   no napi. The runtime risk the amendment was written about does not exist for
   this hypothesis.
5. **Name what `performed` proves** → it now ships `rung: "authorized-claim"`
   plus the incarnation that scopes it. It proves an authorized leg *claimed*
   the performance — not ingress, forwarding, decode, or heard.
6. **Spike acceptance is not production cutover authority** → agreed, and this
   PR does not cut over. The mesh removal is a **separate PR** with its own
   removal list and rollback story.

## On A5 and the mesh

A5 asks that the mesh remain the production/rollback path while the floor
proves itself. **This PR leaves the mesh in place.** The follow-up PR removes
it, and answers A5 directly rather than around it: the rollback path is
preserved — it is the revert, one command, no config change, no migration.

## What I would not merge on your behalf

- **Loss/FEC is modelled, not measured.** FEC is now *requested* explicitly
  (`useinbandfec=1`) rather than inherited from a Chromium default, and
  `tools/sfu-loss-test.mjs` asserts loss degrades proportionally — but its own
  header says it does not route packets through the SFU and must never be cited
  as "measured". The instrument for the real receipt exists
  (`voicesfu.js:493-499` reads `fecPacketsReceived`) and has never been read
  under loss.
- **N=12 on a real network is unproven.** The load harness runs every peer in
  one process with a synthetic payload; it measures fanout cost, not codec
  behaviour.
- **The agent TTS leg is incomplete in this repo** — see
  `notes/REVIEW-agent-tts-path.md`, written from the door's source. The
  whitelist and the primary-surface join both check out, and today's credential
  and `gen` fields ride through untouched. But the peer that terminates the
  contract lives in a separate repo, so row 5 is proven for browsers and proven
  only as far as the door for agents.

  🔴 **The one thing most likely to break on first contact with a Connectome
  agent:** a sidecar that does not echo `cred` and `gen` back on `sfu-answer`
  will now be REFUSED, and the refusal path revokes the leg. Correct for a
  browser; worth confirming with antra before the sidecar half ships.

## Evidence

- `bun tools/sfu-test.ts` — 57, incl. mutation-tested fail-closed consent
- `bun tools/sfu-adapter-test.ts` — 25 · `relay-decision-test.ts` — 23 (the
  transport-agnostic decision layer, unchanged by this branch)
- `sfu-ops-test.mjs` 21 · `sfu-verb-gate-test.mjs` 6 · `mic-gate-wired-test.mjs` 5
- **Verified by ear over a real network**, phone ↔ desktop, both directions.
- 🔴 **Not** verified: anything at N=12, under packet loss, or on a real
  multi-machine deployment.

## Review notes

Heavier on instrumentation than on behaviour tests, and the browser-facing
fixes were verified by a human on a phone rather than by CI — stronger evidence
in one way, much weaker in another. Two independent review passes found, among
other things, four voice verbs missing their spectator gate (a remote-mute
primitive via forged position) and a module that imported cleanly while throwing
on first call. **Both classes were invisible to a green suite**, so please read
the seams rather than the summaries.
