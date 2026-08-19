# Cutover artifacts — the five things amendment 6 makes this PR owe

antra, #104 approval: *"Spike acceptance is not production cutover authority…
Phase one may prove the relay and recommend cutover. It does not yet authorize
deleting the mesh or changing production."* This document is the cutover PR's
side of that contract. Every claim below was verified against the delta on
2026-08-17, not recalled.

## 1 · Removal / retention list

**Removed (2 files, both deletions — no mesh file is mutated):**
- `client/lib/voice.js` — the mesh: per-pair RTCPeerConnections, `sendRtc`
  signaling, ICE-restart plumbing, the teardown-vs-mute machinery.
- `tools/voice-lifecycle-test.ts` — its suite, which pins mesh-specific
  behavior and has no subject after the deletion.

**Retained and modified (transport-agnostic, survives cutover):**
- `client/lib/voicemouths.js` — bubble + mouth pacing for `spoken:true` says;
  consumes the say log, never the transport.
- `client/lib/net.js` — gains the SFU message routes; the mesh's `'rtc'` relay
  case remains for one release (see §3).

Everything else in the stack is **additive** (new files) — the full list is
the pr0–pr3 diffs plus this PR's wiring.

## 2 · `spoken:true` producer migration

**None required, by construction — the wire contract is untouched.** The
spoken-say trio (`spoken`+`utt`, optional `t0`) is validated in
`server/verbs.ts:267–273`, which this delta does not modify. Producers (agent
voice legs via `mcpl/agent.ts`) and the consumer (`voicemouths.js:88`) speak
the same metadata before and after cutover. What moved is the *audio* lane
(mesh pair → relay floor); the *display/continuation* lane rides the say verb
exactly as documented in AGENTS.md: the trio never proved performance, so
changing the performance transport cannot invalidate it.

## 3 · The hard-reload seam

What a stale (pre-cutover) page experiences after the server updates:

- **Text, presence, says: unaffected.** No message type it depends on is
  removed.
- **Voice: silently absent, both directions.** The stale page offers mesh via
  `'rtc'` relay; fresh pages route `'rtc'` to a bus with no subscriber (voice.js
  gone) — a no-op, not an error. The stale page never requests a relay
  credential, so the SFU never offers to it.
- **Diagnosis is built in, not tribal:** `/audio` prints the served build
  (`/version` sha, `+dirty` when applicable) as its first line — a stale page
  and a fresh page are *visibly* different in the one report a phone user can
  produce. This exists because three diagnoses in one morning chased a stale
  page as a code bug.
- **Operator action at cutover:** announce in-world that voice needs a
  reload. No forced-reload mechanism is added — kicking every session on
  deploy is a bigger behavior change than this PR should smuggle in; if the
  project wants version-gated sessions, that is its own proposal.

## 4 · Rollback plan — the settled contract, and the canary

**Rollback = deploying the previous release during the migration acceptance
window** — ordinary release rollback, not an ongoing product architecture
(reviewer correction, 2026-08-18: the mesh-retention requirement was
withdrawn; Eidoverse is not maintaining mesh audio after relay cutover, and
"executable rollback" over-carried the pre-cutover A5 posture). The
step-by-step procedure, with its verification canaries and the window's
boundaries, is `notes/CUTOVER-ROLLBACK.md` — an operator runbook, not a
git-history claim. After the acceptance window closes, the previous release
retires and relay-only is the product.

**Canary, before and after any cutover deploy:** `tools/join-probe.mjs` over
the public URL (protocol-level: good-key joins AND bad-key refused — the
negative control is the half that catches auth wired open), plus `/relay-diag`
showing the six-claim credential path and `tools/audio-cmd-probe.mjs` for the
client chain. The composed receipt set for this PR is the pre-deploy gate.

## 5 · Operator approval

This PR's body ends with an explicit request: **do not merge on review
approval alone — this is the amendment-6 gate, and it asks for the operator's
(antra's) stated go.** The spike report recommended cutover; recommending was
the limit of its authority.
