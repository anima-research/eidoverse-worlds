# SFU — handoff (2026-08-14, written 18:45 before a trim)

**Read `eido-dev/worlds-native/notes/SFU-SPEC.md` first — it has the design, the
measurements, and every bug with its cause.** This file is the part the spec
can't carry: what to do next, what almost bit me, and what I know that isn't
written in code.

## State: DONE and green

- `server/sfu.ts` (~200 ln) + `server/sfuguard.ts` — in-process SFU, no external
  binary. **41/41 tests** (`bun tools/sfu-test.ts`), 100.0% delivery.
- Branch `relay-spike`, ~12 commits, all local. **NOT pushed, NOT a PR yet.**
- Load: `bun tools/sfu-load.ts [N] [secs] [speakers]`.

## The ONE thing not done: browser interop

Everything so far uses **loopback werift peers as fake browsers**. They are not
Chromium. What is unproven:

- real `getUserMedia` → real Opus → our SDP answer
- Chrome's offer shape vs werift's answer (the most likely place it breaks)
- actual *audible* audio, which no test here can assess

**Do this next**, and do it WITH R — she can judge whether it sounds like a
person; I can only count packets. Pattern to copy: the existing browser smokes
(`tools/relay-browser-smoke.mjs`), Playwright with the chromium-1228 pin noted in
`notes/relay-spike/RECEIPTS.md`. Page boot ≈13s under load → timeouts ≥90s.

## Wiring that is NOT written yet

The SFU is a library; nothing calls it. To make it live:

1. **`server.ts`** — on `relay-cred` (or a new verb), `sfu.createLeg(id, gen)`.
   The existing `rtc` verb (case at ~:1005) already carries SDP point-to-point
   with `toSurface` addressing designed for exactly this — **use it, don't build
   signaling.** The SFU's `onNegotiationNeeded(legId)` means *"SFU, make an
   offer for this leg"* — never "ask the browser to re-offer" (see below).
2. **`voice-consent`** → `sfu.setConsent(listener, speaker, bool)`.
3. **retirement funnel** (`retireRelayLeg`, ~:70) → `sfu.closeLeg(id)`.
4. **`/relay-diag`** → merge `sfu.diag()`.
5. Client: `client/lib/voicerelay.js` is LiveKit-SDK-shaped. The generic halves
   (playback, rolloff, hush, analyser, the `askOnce` join-race guard) port
   as-is; the `livekit-client` calls become plain `RTCPeerConnection`.

`server/relaydecision.ts` (23 tests) is transport-agnostic and **must not
change** — it is the regression anchor. Run it after every step.

## Traps that cost me real time (all fixed, all would recur)

1. **The server must OFFER, never answer.** A browser publishing its mic offers
   `sendonly`; an answer cannot add a receive direction the offer never
   proposed. Answering a browser's re-offer silently forwards into a track
   nobody receives — `forwarded=20, heard=0`.
2. **`ontrack` fires again after every renegotiation.** Re-subscribing stacks
   handlers → every packet forwarded twice. Found only by a delivery assertion
   reading exactly 200%.
3. **Concurrent offers on one PC = SDP glare.** `Promise.allSettled` gave
   "rejected, fulfilled". Fixed by a per-leg promise chain (`negotiate()`).
   This is the failure class that grew the mesh's voice.js to 1388 lines; a
   queue removes it because the relay has ONE place offers happen.
4. **N routes need ONE offer.** werift adds a transceiver per exchange, so
   asking N times inflates the SDP and double-delivers. Coalesced per microtask.
5. **Mark only the routes the exchange COVERED.** Marking all of them after
   success means a route added mid-exchange is claimed negotiated while absent
   from the SDP — silent forever, diag lying. Snapshot keys first.
6. **werift never binds `error` on its UDP socket** — a dead peer's ECONNREFUSED
   is an unhandled EventEmitter error and CRASHES THE PROCESS. `sfuguard.ts`
   contains it, narrowly (structured `err.code` + required `syscall`, never
   message-matching, re-throws everything else). **Worth a PR upstream: one
   line in their transport.**
7. **Run scripts from INSIDE the repo.** Running from /tmp gives
   `Cannot find package 'generate-function'` — a Bun resolution quirk.
8. **`pkill -f <pattern>` kills my own shell** when the pattern matches the
   command line. Use `fuser -k <port>/tcp` or kill by pid from `ss`.

## Numbers, and what they actually mean

**All CPU figures are UPPER BOUNDS** — the harness runs both halves of every
connection in one process, so fake browsers' crypto rides along.

| | Bun | Node |
|---|---|---|
| N=12, 2 speaking (realistic) | ~65% | **22%** |
| N=12, all 12 speaking (ceiling) | ~118% | 63% |
| 12 legs connected, silent | — | **0.7%** |

**Bun is ~3× slower than Node here and I do not know why.** Not crypto (native,
and Bun's is faster), not Buffers (Bun's are 11× faster), not callbacks, not
dgram, not measurement error — all tested. Unexplained; do not repeat the
"Bun Buffer overhead" story, it is falsified. If voice ever needs the headroom,
a Node sidecar recovers 3× at the cost of the one-process property.

## Open decisions for antra / #104

- The acceptance table (#104 §8.1) treats Galène and LiveKit as **hypotheses**;
  this is a third one, judged by the same table. Rows still unproven: browser
  interop, TTS publish path, proximity gating, N=12 on a real network.
- **Nothing in #104 forbids this.** I had cited "#104's rejection of
  hand-rolling" — that phrase exists only in my own doc and is not in the issue.
  Do not re-cite it.
- **Loss-driven FEC** is sketched in the spec as a protocol addition: listeners
  know their real loss (`getStats`), senders can retune (`setParameters`), but
  only the SFU can see every listener at once. Same family as P2P offload.

## WHERE TO LOOK IN BASIS (exact file:line — read the code, not a summary)

Local checkout: `/home/claude/src/basis`. MIT, © 2024 Luke Doolan.
Paths below are relative to `Basis/Packages/com.basis.framework/`.

**⚠️ Read these yourself. Two subagent summaries flattened the three most
interesting mechanisms into "a jitter buffer with adaptive depth."**

### The jitter buffer — `Networking/Recievers/BasisVoiceBuffer.cs` (745 ln)
| what | line | why it's interesting |
|---|---|---|
| **arrival-gap tracker** | `:78-93` (`_peakGapMs`, `_peakGap2Ms`) | sizes depth from the **SECOND**-largest recent gap, so a repeating pattern raises it fast while a one-off stall can't demand a permanent buffer. Proactive, not reactive. |
| gap decay | `:178-182` | ×0.7 per interval — one-off spikes fade in seconds |
| **deadline hold** | `:100` (`PlcReserveFrames`), `:474-502` | do NOT conceal a missing packet while the decoded queue has runway; hold the hole open so a late packet still lands |
| **late salvage counter** | `:102-107`, `:457-462` | counts audio older builds concealed and then *threw away* on arrival |
| adaptive depth logic | `:136-183` (`MaybeAdjustDepthLocked`) | grow on late-ratio >1%/5% or underruns, shrink after 4 clean intervals |
| app-layer loss estimate | `:41-49` (`DecayIntervalMs`, ~5s half-life) | LiteNetLib reports nothing on unreliable delivery, so they count it themselves |
| underrun refill | `:185-201` (`NoteUnderrun`) | after a dry-out, require a partial refill or you underrun on every resume |

### The sender — `Networking/Transmitters/`
| what | file:line |
|---|---|
| Opus encoder setup, **FEC on** | `BasisAudioTransmission.cs:95-119` (`OPUS_SET_INBAND_FEC`, complexity 5) |
| **loss% → FEC aggressiveness** | `BasisAudioTransmission.cs:118` + `Compression/BasisOpusSettings.cs:21` |
| **skip encode when nobody's in range** | `BasisAudioTransmission.cs:233` guarded by `HasReasonToSendAudio` (`BasisTransmissionResults.cs:849`) |
| DTX / silence | `BasisAudioTransmission.cs:195` (`SendSilenceOverNetwork` sends NOTHING, just counts) |
| proximity job (25 m, hysteresis) | `Networking/Transmitters/BasisDistanceJob.cs:11,74-83` |
| recipient-list wire encodings | `BasisTransmissionResults.cs:869-930` — picks cheapest of bitfield / denylist / allowlist |

### The server — `Basis Server/` and `com.basis.server/`
| what | file:line |
|---|---|
| the ENTIRE relay | `BasisNetworkServer/BasisServerHandleEvents.cs:830-854` (`HandleVoiceMessage`) |
| fanout | same file `:954-1007` (`SendVoiceMessageToClients`) |
| **no encryption** | `BasisNetworkCore/LNLNetworkImpl.cs:209` — `new NetManager(listener, null)` |
| P2P crypto (the ONLY encrypted path) | `BasisP2PManager.cs:677` |
| P2P broker / watchdog | `BasisServerP2PBroker.cs:46`, `BasisNetworkCore/BasisP2PLinkHealth.cs:39` |
| load-test evidence in comments | `LiteNetLib/NetManager.Socket.cs:1146,340`; `NetManager.cs:410`; `BasisConfigXmlDocs.cs:240` |

### 🔴 THEIR VOICE TEST SUITE — `Tests/Editor/Voice/` (neither summary mentioned it)
Nine test files. Read these before writing our own browser-side tests; they are
the best available list of what actually goes wrong in a voice pipeline.

- **`BasisVoicePipelineTests.cs`** — includes
  `ReInitializeOnTheSameRenderer_DoesNotStackSubscriptions`. **They hit the
  EXACT bug I hit today** (stacked subscriptions → doubled delivery) and named a
  test after it. Independent convergence on the same failure mode.
- **`BasisMicrophoneAgcTests.cs`** — an entire AGC subsystem neither summary
  mentioned: `QuietTalker_IsBoostedUpToTheCeiling`,
  `LoudTalker_IsBroughtDownAndStaysUnderHeadroom`,
  `GainHoldsAcrossAPause_SoTheNextUtteranceStartsAtLevel`,
  `SteadyRoomNoise_NeverMovesTheGain`,
  `NoiseFloorTracker_FindsTheRoomFloorAndIsNotDraggedUpBySpeech`. The browser
  does AGC for us (`getUserMedia` constraints), but these test NAMES are a
  ready-made checklist for judging whether ours behaves.
- `BasisVoiceTimingTests.cs` — jitter/late-salvage timing, `LateSalvagedCount`
- `BasisVoiceAcousticsTests.cs` — `SameVoiceInNoisierRooms_StillLandsOnTheSameOutputLevel`
- `BasisVisemeLatencyTests.cs` / `BasisVisemeResponseTests.cs` — mouth-flap
  latency, relevant when we wire visemes to `relayPeerLevels()`
- `BasisVoiceTestAutoRun.cs` — how they run the suite headless

## Related, still open

- **eidoverse-worlds#125** (world travel) — rewritten as a local feature,
  **no review yet** as of 18:35. R is pinging Mica.
- `notes/relay-spike/RECEIPTS.md` — the LiveKit spike this supersedes. Its
  staging topology (port **8945**, not 8941) and the "firewall blocked" note is
  **FALSE and corrected in that file**; tailnet already passes.
