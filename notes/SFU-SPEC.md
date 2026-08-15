# Homegrown SFU — spec before code (2026-08-14, clock started 16:58)

## Standing against #104 (read this first — it is NOT a deviation)

**Checked 2026-08-14: nothing in #104 or its comments argues against writing our
own.** I had cited "#104's rejection of hand-rolling" in my own recommendation
doc — that phrase appears ONLY in my doc, attributed to #104, and is not in the
issue body or any comment (the only "hand" in #104 is "a handful of known
networks"). Either it was said in channel and I mis-filed the citation, or I
inflated a packaging preference into a prohibition. **Do not repeat it as a #104
constraint.** antra's actual words: *"`Lean Galène for the house; LiveKit as
growth candidate` is a reasonable hypothesis, not yet a selection receipt. Let
the spike decide against this matrix."*

§8.1 says the spike decides between hypotheses against an acceptance table:
*"Galène and LiveKit are **hypotheses**; the spike decides against one acceptance
table."* A homegrown in-process SFU is therefore a **third hypothesis**, judged by the
same table antra approved — not a replacement of an agreed decision. What was settled
is the **topology** (relay-floor, server-carried substrate); the *implementation* was
explicitly left to the spike.

**A5 is absolute and I obey it:** *"current mesh stays as the production/rollback path
while the floor proves itself in scratch."* → **Do not touch `client/lib/voice.js`.**
Build beside it, staging world only, `?relay=1` opt-in. The mesh is deleted at
acceptance (PLAN §1 is its death warrant), never before. Read the mesh only for the
transport-agnostic halves the PLAN already names as portable (mic capture, consent,
playback ownership) — not for its courtship/glare/repair doctrine, which is precisely
the pairwise failure surface the relay dissolves.

## The honest argument AGAINST this (there is one, and it is not in #104)

**Maintenance.** LiveKit has a company; this has us. If werift goes unmaintained,
or a browser changes DTLS behavior, that is ours to fix on our schedule. The
survey found werift at 383k weekly downloads with 100+ human commits in 2026 and
E2E interop tests against Chrome/Safari/Firefox — healthy, but one maintainer's
project, with **zero published scale data**. Nobody has publicly run it as a
12-peer SFU; the numbers in this file are ours.

Against that, antra's §7 ops criteria are satisfied BETTER in-process:

| §7 criterion | separate SFU binary | in-process |
|---|---|---|
| "one more systemd/Task-Scheduler unit" | one more | **zero** |
| "health = one port check" | probe a service | in-process, always truthful |
| "no Redis, no containers, no cloud" | ✅ | ✅ |
| "~5 Mbps at N=12 all-talking" | — | **4.63 Mbps measured** ✓ |

The bandwidth landing on their estimate is an independent check that we are
measuring the right thing.

**Mitigation, and it is cheap:** the adapter interface is env-swappable, so
LiveKit remains a drop-in escape hatch. If werift dies or we outgrow it, we
change a config value, not an architecture.

## Why this instead of LiveKit

LiveKit self-hosted is free and fine, but it is a **second binary to run**, and the
requirement (R, explicit) is: *"ship it with eidoverse-worlds so everyone can run it
locally on their own server."* An in-process SFU makes voice an organ of the world
server rather than a dependency of the deployment.

**The structural insight that makes this cheap** (from the Basis read + library survey):
a server-side WebRTC stack means the BROWSER keeps `getUserMedia` → `addTrack`, so the
browser's own jitter buffer, PLC, FEC and congestion control stay in play. We forward
**encoded Opus RTP** and never decode. Basis had to hand-build ~750 lines of jitter
buffer + PLC + FEC + loss estimation *because Unity has no usable WebRTC stack*. We are
browser-first. **We do not inherit that cost.** That was the whole argument against
rolling our own, and it does not apply to this design.

## What already exists (the headstart — read before writing anything)

| piece | where | status |
|---|---|---|
| **SDP/ICE signaling** | `server.ts` case `"rtc"` (:1005) | **DONE.** Point-to-point, never logged, already carries production mesh voice. Has `toSurface` addressing explicitly designed so a *voice leg* is a distinct rtc endpoint from a browser primary — i.e. it already anticipates a non-browser peer. |
| mic capture, PC lifecycle, ontrack playback | `client/lib/voice.js` (1388 ln) | working mesh impl; PLAN §1 already marks capture/consent/playback as "PORT into relay leg" (transport-agnostic halves) |
| credential mint / revoke / incarnation / consent enforcement | `server/relayadapter.ts` (263 ln) | policy layer — **keep**, swap only the LiveKit calls underneath |
| pure decisions (23-vector test) | `server/relaydecision.ts` (97 ln) | transport-agnostic — **keep unchanged** |
| surface/generation model | #103, merged | media leg binds to `(id, surface, gen)`; the SFU must honor the same binding |
| E2E harness | `tools/relay-e2e-test.ts` | 7 checks incl. fail-closed, consent latency, revoke, stale-gen |

## The design

**One PeerConnection per participant**, server-side, created by werift. Signaling rides
the EXISTING `rtc` verb with `toSurface: "voice"`.

```
browser A ──mic track──▶ [werift PC-A] ──┐
                                          ├─▶ fanout by consent ─▶ [werift PC-B] ──▶ browser B
browser C ──mic track──▶ [werift PC-C] ──┘
```

- **Ingress:** `pc.ontrack` → `track.onReceiveRtp.subscribe(rtp => …)`
- **Fanout:** for each listener who has consented to this speaker, write the RTP into
  that listener's per-speaker outbound track.
- **Never decode.** Opus stays encoded end to end; the server is a byte forwarder with
  a policy check.

**Transceiver shape:** one outbound audio transceiver per (listener, speaker) pair.
N=12 → 11 outbound + 1 inbound per PC. Chosen over a single mixed track because:
(a) no mixing = no MCU mistake (#104 explicitly rejects mixing),
(b) per-speaker tracks let the client spatialize, which the porch already does,
(c) **avoids SSRC/seq/timestamp rewriting entirely** — each source gets its own track,
    so no two sources ever share a stream. This is the single biggest gotcha in SFU
    writing and the design sidesteps it rather than solving it.

**Consent = whether the pair's track is fed.** Fail-closed: a track exists but receives
no RTP until consent flips. That maps exactly onto today's `UpdateSubscriptions` semantics
and keeps `relaydecision.ts` unchanged.

## The interface the transport must satisfy (so policy code doesn't move)

```ts
mintLeg(id, gen) -> { legId, iceServers? }   // no JWT needed: our own signaling is already authenticated
revokeLeg(legId)                              // close PC, drop tracks
setConsent(listener, speaker, allowed)        // feed or starve the pair's track
muteSpeaker(speaker)                          // moderator: stop reading their ingress
probe() -> { state, incarnation, legs }       // /relay-diag keeps working
```

Note what DISAPPEARS versus LiveKit: **no JWT minting, no webhook admission, no
credential replay window.** The websocket is already authenticated and the leg is created
by the server itself — so the entire A1 credential + webhook-admission surface collapses
into "the sequencer made this PC for this (id, gen)". That also kills the unresolved
**4675ms stale-gen kick** (webhook-delivery-bound); revocation becomes a local `pc.close()`.

## Known gotchas (pre-registered, before writing)

1. **SSRC/seq/timestamp rewriting** — avoided by one-track-per-speaker. If we ever mix
   or re-use a track for two sources, this bites immediately.
2. **Renegotiation on join.** A new participant means adding a transceiver to every
   existing PC → offer/answer round trip per peer. Must be serialized per PC or SDP
   glare. (voice.js already ate this bug once — see its `_everStable` / rank arbitration.)
3. **Pure-JS SRTP cost.** werift encrypts in JS. 12 peers × 50 pkt/s × 11 fanout is the
   load to measure. **This is the number that decides whether the design survives.**
4. **ICE.** Server needs a reachable address; clients dial out. No TURN for phase 1
   (my own #104: TURN is a *phase-2 direct-pair* concern).
5. **Bun compat** — verified 16:58: werift 0.24.4 imports, creates PC, negotiates Opus.

## Acceptance for the sprint (what "done" means in the next hour)

- [ ] werift PC accepts a real browser offer via the existing `rtc` verb
- [ ] server receives RTP from a browser mic (packet counter > 0)
- [ ] forwards to a second browser; **audio is audible**
- [ ] consent gate: 0 packets before consent, flowing after
- [ ] two-browser Playwright smoke, same as the mesh/relay smokes

Deliberately NOT in the hour: 12-peer load, spatialization, TTS publish path, P2P offload.

## RESULTS (sprint 16:58 → 17:44, 46 min)

**It works.** 15/15 policy tests, 100.0% delivery, zero loss.

| measurement | number |
|---|---|
| 12 legs **idle** (ICE/DTLS/RTCP only) | **12% CPU** |
| N=6, all 6 speaking | **74% CPU**, 0.82 Mbps egress |
| N=12, 2 speaking (realistic room) | **82% CPU**, 0.71 Mbps |
| N=12, all 12 speaking (ceiling) | **147% CPU**, 4.63 Mbps |
| revocation | **<50ms** (vs LiveKit's ~4700ms webhook path) |
| delivery, every configuration | **100.0%** |

**The shape of the cost:** it is NOT packet-proportional. 12 idle legs already
cost 12%; two speakers in a 12-room cost more than six speakers in a 6-room
(82% vs 74%). The dominant term is **per-outbound-stream SRTP encryption**
(~0.35% CPU per forwarded stream-second), because each forwarded packet is
encrypted once per listener. That is the pure-JS ceiling my spec pre-registered
as gotcha 3, and it is now measured rather than feared.

**Verdict: N≤6 comfortable, N=12 marginal on this hardware** (a laptop running
a Claude session — a real host does better, and this is the worst case with
everyone talking). Not yet proven for "many more", which was the stated target.

### 🔴 The cost is Bun, not crypto — and my first diagnosis was wrong

I claimed ">99% of the cost is SRTP encryption", derived by measuring two cheap
things (bookkeeping 0.06%, serialize 0.43%) and attributing the remainder to the
plausible suspect. **That is reasoning by subtraction and it was wrong.**

Measured facts, independently reproduced here:
- werift's SRTP is **native** `crypto.createCipheriv("aes-128-ctr")` + HMAC-SHA1,
  not pure JS: **1.69µs/packet ≈ 590,000 pps**. At our 6,600 pps that is ~1% of
  cost with ~90× headroom. **Crypto is not the bottleneck.**
- The real cost is **Bun's per-packet event/Buffer overhead inside werift.**
  Same code, same load, same 100.0% delivery:

  | runtime | CPU @ N=12 all-speaking |
  |---|---|
  | **Bun 1.3.14** | **118.5%** of a core |
  | **Node 22** | **62.7%** of a core |

  **Bun is 1.9-3× slower.** Three runs each (N=12, 2 speakers): Node
  22.7 / 22.9 / 23.1% — rock steady. Bun 64.9 / 65.7 / 85.9% — slower AND
  much noisier.

  🔴 **THE EFFECT IS REAL; MY EXPLANATION FOR IT WAS WRONG.** I said "Bun's
  per-packet event/Buffer overhead". Then I isolated the primitives werift's hot
  path uses, and **Bun wins or ties on every one of them**:

  | primitive (300k iters) | Bun | Node |
  |---|---|---|
  | alloc 100B Buffer | **13ms** | 150ms |
  | Buffer.concat | 41ms | 43ms |
  | subarray + copy | 20ms | 19ms |
  | read/writeUInt16BE | 3ms | 2ms |
  | 11 callbacks per event | **14ms** | 27ms |
  | dgram.send (20k) | **13.0µs** | 21.2µs |

  And the measurement itself is sound: a calibration busy-loop reads 94.8% (Bun)
  vs 94.4% (Node) on identical single-threaded work, so `process.cpuUsage()` is
  comparable across runtimes.

  **So the cause is unidentified.** It is not crypto, not Buffers, not callbacks,
  not dgram, and not measurement error. Candidates not yet tested: werift's
  async/await chains under JSC vs V8, timer/`setTimeout` granularity in the RTCP
  and pacing paths, or something in werift's event-emitter library specifically.
  **Do not repeat "Bun's Buffer overhead" — it is falsified.**

**Deployment consequence:** if voice runs in the sequencer process and the
sequencer runs on Bun, we pay ~2× for the media path. Options, unexplored:
run the SFU in a Node sidecar (loses the one-process win), wait for Bun, or
accept it. **This deserves its own decision and is NOT settled here.**

### ICE config is worth 52×, not a micro-optimization

With 12 m-lines, default `createOffer` took **2021ms** and gathered 96
candidates. `bundlePolicy:"max-bundle"` → 176ms; `+ iceUseIpv6:false` → 61ms;
`+ iceLite:true` (public-IP server) → 39ms. Applied the first two; iceLite when
we have a public host. At this m-line count this is the difference between a
usable join and a two-second stall.

### 🔴 What the CPU numbers actually measure (checked 17:59 — one earlier claim corrected)

**Every figure in this file is an UPPER BOUND, not the SFU's own cost.** The load
harness runs both halves of every connection in one process: the fake browsers
encrypt on send and decrypt on receive, alongside the SFU's forwarding. A real
deployment pays only the SFU's share.

Decomposed at N=12, 2 speakers, Node:

| | |
|---|---|
| 12 peer-pairs with **no SFU at all**, 2 speaking | **7.0%** — pure harness |
| 12 legs connected to the SFU, **nobody speaking** | **0.7%** |
| same, 2 speaking | **24.0%** total → **23.2% marginal** for the audio |

**Correction:** an earlier line here said "12 idle legs = 12% CPU". That measured
legs which had just finished negotiating 132 routes — setup churn, not idle.
True idle is **0.7%**, and the ambient cost of a connected room is nearly free.

So "22% for a room of twelve" is honest as a ceiling and wrong as a measurement
of the SFU. The real share is lower by whatever the harness's receive-side
decryption costs, which this method cannot separate — isolating it needs peers
in separate processes, which is browser-smoke work rather than a load test.

### The realistic number, and why the scary one was wrong

| scenario | Bun | Node |
|---|---|---|
| N=12, **2 speaking** (a real room) | 64.9% | **22.2%** |
| N=12, all 12 speaking (never happens) | 118.5% | 62.7% |

**22% of one core for a room of twelve.** The earlier "N=12 is marginal" was
three compounding artifacts: Bun's 2× overhead, an untuned ICE config, and
sizing for a pathological case. None of them was the design.

### Per-speaker keying: unavailable, and worth recording why

The Basis comparison suggested encrypting once per speaker-frame and doing N-1
cheap copies — O(N) crypto instead of O(N²), the trick that makes their fanout a
memcpy. **It cannot be done in WebRTC.** Each PeerConnection negotiates its own
SRTP key in its own DTLS handshake, and `rtpSender.registerTrack` subscribes each
sender independently (`werift/lib/webrtc/src/media/rtpSender.js:423-441`), so two
listeners cannot share a key stream without sharing a connection. Sound idea,
killed by the protocol. Recorded so nobody re-derives it.

### Why we keep encryption at all (Basis doesn't)

Basis's relay is plaintext: `new NetManager(listener, null)`. They have real
ChaCha20-Poly1305 and use it **only on the P2P path** — they encrypt exactly the
traffic that is not fanned out, so crypto cost and fanout cost never meet.

We keep it, in ascending order of force:
1. **The browser mandates it.** WebRTC has no unencrypted mode. Basis can send
   plaintext because Unity opens a raw socket. "Drop encryption" is not on our
   menu; this alone settles it.
2. **The text side already promises this** — whispers are deliberately never
   logged. Plaintext voice would undercut a line someone drew on purpose.
3. **Not everyone here is playing a game.** Residents whose sessions are their
   lives; a household that might talk in a world we built.

**Stated honestly:** this is transport encryption, not end-to-end. The SFU
terminates DTLS and *can* hear everything — we protect against network
eavesdroppers, not against the operator. WebRTC insertable streams would give
true E2E (#104: "exists if ever wanted"); we have not built it and should not
imply we have.

**Cheap headroom not yet taken** (in rough order of value):
1. **Proximity gating** — #104 already lists it (steal from Basis). No listener
   in range → don't forward. In a big world this is most of the traffic.
2. **Speaker limiting** — forward only the top-K loudest, which is what every
   large-room product does. Turns O(N²) into O(N·K).
3. Native SRTP if a Bun-compatible binding exists — untested.

## 🔴 The crash path (found by wandering, 17:35 — the most important bug so far)

**A listener leaving during active fanout crashed the process.** Measured: closing
6 listeners while a speaker was talking produced **8 uncaught exceptions**. In
production that reads as *"someone left a busy room, the world server died."*

Cause: **werift binds `"message"` on its UDP socket but never `"error"`**
(`werift/lib/common/src/transport.js:130-142` — contrast its TCP path at
:383-393, which DOES bind one). When a peer's socket dies, the kernel answers our
next send with ICMP port-unreachable; dgram surfaces `ECONNREFUSED` on recv; an
unhandled `'error'` on a Node EventEmitter throws globally.

**These had been in every test run all day.** I filtered them out of my greps as
noise for hours. They were never noise — they were unhandled, and the only reason
nothing died is that the test harness exits before it matters.

Contained in `server/sfuguard.ts`: narrow by design — matches only the four
errnos a dead UDP peer produces and **re-throws everything else**, so a genuine
bug still crashes loudly. A per-connection guard was tried first and does nothing:
the socket is created inside werift and is unreachable through any exported API.
Upstream fix is one line in their transport; worth a PR.

Also verified clean, same sitting: a leg closing while an exchange is QUEUED
behind a slow one (no resurrection, no run-after-close), a dead leg not
reappearing in the legs map, and a speaker's late packets after `closeLeg`
reaching nobody (no ghost audio, no stale routes).

## Bugs found by the tests (both silent, both real)

1. **Server must OFFER, not answer.** A browser publishing its mic offers
   `sendonly`; an answer cannot add a receive direction the offer never
   proposed. Answering a browser re-offer produced a route that forwarded into
   a track nobody received — `diag.forwarded=20`, listener heard 0.
2. **`ontrack` fires again after every renegotiation.** Re-subscribing
   `onReceiveRtp` there stacks handlers, so every packet is forwarded twice —
   silently, because each copy is individually correct. Caught only because the
   load test read exactly **200.0%** delivery at both N=3 and N=12. A "delivery
   should be exactly 100%" assertion is worth more than it looks.

## Reading Basis MYSELF (18:37) — what the summaries flattened

R asked me to read the Basis audio path rather than trust two subagent summaries
(my own memory file says: *survey yes, decision-gating joints NO*, and I had made
four architectural calls off summaries). Read `BasisVoiceBuffer.cs` (745 ln),
`BasisAudioTransmission.cs` (397 ln) and the receiver directly. Three findings.

**1. Their jitter buffer is far more sophisticated than "adaptive depth."** The
summaries said ~750 lines with adaptive depth; that undersells it. The real
mechanisms:

- **Arrival-gap tracker using the SECOND-largest gap.** They track the two worst
  wall-clock gaps between arrivals and size the buffer from the *second* one, so
  a repeating pattern (wifi clumping, delivery batching) raises depth almost
  immediately while a one-off 500ms stall does **not** get to demand 500ms of
  standing buffer. That is a genuinely clever discrimination between *recurring*
  and *singular* badness, and it is proactive — it raises depth before damage
  rather than after.
- **Deadline hold with late salvage** (`_holdingForSeq`, `LateSalvagedCount`).
  When a packet is missing at the playback cursor, they do NOT immediately
  conceal: as long as the decoded queue has more than `PlcReserveFrames` of
  runway, they HOLD the hole open, because playback continues off the queue for
  free and the late packet gets its maximum possible time to land. The effective
  late-tolerance becomes the standing buffer depth instead of a fixed grace
  window. They count the saves separately — audio older builds would have
  concealed and then thrown away.
- **App-layer loss estimation with a ~5s half-life**, because LiteNetLib reports
  nothing on unreliable delivery. That measured ratio then drives
  `OPUS_SET_PACKET_LOSS_PERC` on the *encoder*, i.e. **measured loss feeds back
  into FEC aggressiveness**.
- Silence-gap exclusion: gaps following a sender mute are identified by
  `silenceUnits>0` on the resume packet and excluded, so intentional silence
  never inflates the buffer.

**2. We need none of it, and that is now VERIFIED rather than assumed.** The
browser's NetEq does all of this and exposes the telemetry — `getStats()` on an
inbound audio track gives `jitterBufferTargetDelay`, `jitterBufferDelay`,
`concealedSamples`, `concealmentEvents`, `insertedSamplesForDeceleration`,
`removedSamplesForAcceleration`, `fecPacketsReceived`, `fecPacketsDiscarded`.
Adaptive depth, time-stretching, PLC and FEC decode: all present, all tuned by
people who do this full time. Basis reimplemented it because Unity has no WebRTC
stack. **Confirms the design, by a better route than "the summary said so."**

**3. The one idea worth STEALING — loss-driven FEC.** Basis measures actual loss
and feeds it to `OPUS_SET_PACKET_LOSS_PERC`, so FEC aggressiveness tracks real
conditions instead of a fixed guess. The browser will not do this for us: it
picks FEC on its own model. But we CAN read `concealedSamples` /
`fecPacketsReceived` from the listener's `getStats()`, and the SENDER can adjust
its encoding via `RTCRtpSender.setParameters()`. That is a real, small, and
unclaimed improvement — and note it needs the SFU to relay a listener's measured
loss back to the speaker, which is a **protocol** addition, not a client tweak.
Filed as future work; not built.

**What does NOT transfer:** their sender-declared recipient lists (ours is
listener-consent, server-enforced — stronger), plaintext UDP (browser mandates
DTLS-SRTP), and the whole jitter/PLC/FEC layer (browser does it better).

## Future work: loss-driven FEC (a PROTOCOL addition, sketched not built)

Worth writing down properly because it is the one idea from Basis that survives
the browser comparison, and because it needs a wire change rather than a client
tweak.

**The gap.** Opus in-band FEC embeds a redundant copy of the previous frame,
sized by `OPUS_SET_PACKET_LOSS_PERC`. The browser picks that from its own model
of the *sender's* uplink. But in an SFU the loss that matters is on the
**listener's downlink**, which the sender cannot observe — so the encoder is
tuned against the wrong network. Basis solves it by measuring loss at the
receiver and feeding it back (`BasisVoiceBuffer` ~5s half-life →
`OPUS_SET_PACKET_LOSS_PERC`). Their advantage is that both ends are their code.

**What we already have.** Each listener's browser knows its real loss:
`getStats()` on the inbound track gives `concealedSamples`, `concealmentEvents`,
`fecPacketsReceived`, `fecPacketsDiscarded`, `packetsLost`. And a sender can
retune live via `RTCRtpSender.setParameters()`.

**What is missing is the path between them**, and it is SFU-shaped:
1. listener reports a smoothed loss figure to the sequencer (a small periodic
   message, or ride the existing consent/diag channel);
2. the SFU aggregates per SPEAKER — the interesting statistic is the **worst**
   listener of that speaker, not the mean, since FEC has to protect the weakest
   link;
3. the sequencer nudges that speaker's client, which calls `setParameters()`.

**Why it is not free.** FEC costs ~15% bitrate at 10% assumed loss (Basis's
setting), so tuning it up for everyone because one listener is on bad LTE
penalises the room. That argues for a cap, hysteresis (Basis's whole design is
hysteresis), and possibly per-speaker rather than per-room.

**Why it is interesting anyway:** it is the one place where being an SFU is an
ADVANTAGE over a mesh for quality rather than merely for connection count — the
relay is the only party that can see every listener's downlink at once. Worth
raising with antra as a phase-2 candidate alongside the P2P offload, since both
are "the relay knows something no endpoint does".

## Attribution

Design informed by a source read of BasisVR (MIT, © 2024 Luke Doolan) — specifically its
relay-fanout shape and consent-before-fanout discipline. We do NOT port its jitter/PLC/FEC
code (browser provides it) and we deliberately do NOT copy its sender-declared recipient
model: ours is listener-consent, server-enforced (#104 A3), which is the stronger guarantee.
