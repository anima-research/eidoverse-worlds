A seated body's root is its floor reference, so mounting a root at a socket floats the whole body one pelvis-height above the seat — Janus's two-foot hover in Digi's chapel (#101). Phase A measured the seam: the chapel socket is authored 7 mm above the pad (the authorship was clean), the sin is `root = socket point`, and no bone formula survives two rigs (contact spread 7.4 cm > hips spread 4.3 cm). The accepted theorem, implemented here exactly as contracted ([design](https://github.com/anima-research/eidoverse-worlds/issues/101#issuecomment-5261034371) → [B1–B5 amendments](https://github.com/anima-research/eidoverse-worlds/issues/101#issuecomment-5261102753) → authorization): **the socket owns the world anchor; the avatar profile owns where that body's posed contact sits relative to its root.**

## What ships (one bounded PR, as scoped)

**The contract as shared pure math** — `client/lib/seatcore.js`, the forecast.js/motioneval.js pattern: schema validation (placeholder-shaped patch evidence is invalid evidence), the serve-time status verdict, the B1 socket-anchor rule, the two-half gate, the world-up correction, the rider-scale definition, the fetch-generation guard. Browser, sequencer, and agent evaluate this one file; `tools/seatcore-test.ts` pins it with hand math (55 checks), including the B2 discriminator — a pitched/rolled fixture that numerically fails a parent-normal implementation by its exact lateral term (`contactY·sin θ`).

**One judge, three readers** — `server/seats.ts` + `/avatars`: profiles live in `assets/opt/seats/profiles.json` (tmp+rename, append-only provenance log), judged at serve time against the current avatar and clip bytes (mtime-cached sha256), and each roster entry carries its pre-judged `seat` verdict plus the clip digest; the store's monotonic revision rides an `x-profiles-rev` header (the array shape predates seats and stays an array). A stale value cannot be served as fresh, and no consumer ever rehashes a VRM.

**Write authority (B4)** — `POST /seat-profile` writes the *proposed* slot only, and requires a **named actor**: a tokens.json bearer or a home-node-verified aid1 identity — the same two legs `/upload` trusts. The anonymous door token gets a 401 pointing at the operator-import lane. Countersign has **no HTTP path**: `tools/seat-accept.ts` is run by the operator on the box; the live server notices by mtime and pushes the same generation-bearing `avatar-profile-updated` a proposal gets. Bearers are never logged or echoed.

**The correction, at the one seam all consumers share (B2)** — `mountTransform` (browser-local at main.js, remotes at remotes.js) and `effective.ts`'s body branch append one subtraction after the existing socket resolution: `root = socketPoint − ŷ·(seatContactY × riderScale)`, along **world up** — mounted bodies render upright (yaw only), so a tilted parent's normal would smear them laterally while their contact geometry stays vertical. Yaw, part sockets, mount overrides, precedence, and dismount stamping are byte-for-byte the paths that exist.

**Nothing silent (B1/B3)** — the correction applies only behind the full gate: authored `seatAnchor: "surface"` (absent = legacy-root = today's composition, by construction — no heuristic infers intent from socket height), a countersigned fresh verdict, and the runtime truth of each consumer — the browser gates on the mixer slot *actually playing* and the digest of the clip bytes it *actually loaded* (hashed once at fetch in `vrmaBytes`; a filename is not an identity); the headless reader has no mixer, so its runtime truth is the contract identity, with steady-state parity pinned by test. Every closed-gate state is declared in all three consumers: an `≈` on the nameplate + one console line, and `(seat approximate: <reason>)` on the agent's seated lines. Root-at-socket can still happen — it can no longer happen *silently*.

**Generations (B3, the #95 lesson generalized)** — both update events bump a per-name generation before the refetch departs; a resolution stamped before a bump is discarded whole, and a lower `profilesRev` never replaces a higher one. A slow response from before an acceptance cannot roll the acceptance back. The agent gains tested handlers for `avatar-updated` and `avatar-profile-updated` and fetches `/avatars` over its hardened `httpBase` — the same base `/geom` and terrain already ride.

**Evidence hygiene** — seatlab is a `tools/` harness (`tools/seatlab/`), never client runtime: the `_v` register-aliasing bug is fixed by moving the seat claim into pure `seatcore.seatClaim` (nonzero-Y regression pinned in bun), and the derivation records the winning mesh/vertex/coordinate with its support patch — an isolated winner (skirt hem, accessory, outlier) is flagged, never proposed.

## Receipts

**Real derivations** (`tools/receipts-101-phaseb/derivation-receipts.json`): 3 bit-identical runs per rig; the rebuilt instrument reproduces Phase A's accepted numbers exactly — claude **0.2055** (winner char1001 v259, patch 31 verts @ 1.84 cm), aletheia **0.2791** (Body_(merged)baked001 v282, patch 13 @ 0.95 cm). Proposed via the operator lane, countersigned with the contract comment as receipt.

**The founding bench, sat upon** — the chapel-cushion clone at the exact prod transform with **Digi's four authored sockets verbatim** (read from public `/geom`, the live chapel never written); `seat`/`seat3`/`seat4` migrated to `surface` by authored act, `seat2` left legacy as the in-place control:

![claude seated on the chapel bench](https://raw.githubusercontent.com/cormundus/eidoverse-worlds/im/101-seat-profiles/tools/receipts-101-phaseb/claude-seated-on-bench.jpg)
![both rigs seated](https://raw.githubusercontent.com/cormundus/eidoverse-worlds/im/101-seat-profiles/tools/receipts-101-phaseb/aletheia-seated-on-bench.jpg)

Phase A's hover screenshots of this same bench are the before. The numbers (`numeric-receipts.json`, `ACCEPTANCE.md` for the full ×11 table):

- **Gap:** claude contact = 1.4912 + 0.2055 = 1.6967 = the socket plane, **+6.7 mm** above the pad; aletheia ≈ 0–7 mm. Both ≪ the 5 cm cushion tolerance, inside the 2 cm rigid bound too.
- **Three consumers, one value:** browser-remote 1.4912 = headless 1.4912 (claude/seat); aletheia 1.4108/1.4109; browser-local 1.4910 on seat4 (pad authored −0.29 vs −0.291 — authorship, not drift).
- **Legacy control, live:** same cushion, `seat2`: `ground height 1.70m … (seat approximate: legacy socket)` — today's composition, declared.
- **Moving tilting parent (B2, live):** pendulum amp 0.5 about X, five mid-arc samples across 1.6 m of travel: **dY = 0.2055 exactly, dX = dZ = 0 exactly** — the parent-normal signature (±9.8 cm lateral) is absent. The pre-hydration first sample is the designed declared-approximate transient. Headless parity: `3.34m … (riding its pendulum)`, no suffix.
- **Fail-on-main:** `tools/receipts-101-phaseb/fail-on-main-lifecycle.txt` — 19 named failures (main's server + agent, branch instruments), 3 passes = exactly the invariants that must hold on both sides; main's own header reads `seated on crate1.` — the silent hover, verbatim.

**Suites on the committed head:** smoke 85/85 · seatcore 55 · **seat-lifecycle 22/22** (real scratch sequencer + real WorldAgent: 401 for anonymous, 403 for smuggled `accepted`, proposal broadcast, the agent's `look()` correcting **in place** on countersign — 1.00 → 0.79 = 1 − 0.2055 — stale-naming-which-bytes, unsupported-with-refusal, dismount unchanged) · effective 42 · motioneval 33 · supportclass 29 · uneven-support 15 · denoise 31 · remotes-lifecycle green · comptest 33/0 · worldops 23/0. permtest 21/2 and voice-lifecycle 122/2 are pre-existing on main (verified on a main worktree control).

Closes #101.

— I.M. & Cormundus
