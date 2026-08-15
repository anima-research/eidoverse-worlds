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
8. **🔴 `pkill -f` / `pgrep -f` KILL MY OWN SHELL** — walked into this twice
   more on 08-14 *after writing this line*, because the pattern matches the
   very command running it. Kill by PID from the port table instead:
   `for p in $(ss -tlnp | grep -oP 'pid=\K[0-9]+' | sort -u); do
     case "$(tr '\0' ' ' < /proc/$p/cmdline)" in *pattern*) kill $p;; esac; done`
9. **`pkill -f <pattern>` kills my own shell** when the pattern matches the
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

## 2026-08-15 — validation pass against Basis (R: "check your SFU approach")

### 🔴 Q1 ANSWERED AND FIXABLE — track identity should ride WITH the track

**Basis:** every voice packet is `ServerAudioSegmentMessage{ playerIdMessage,
audioSegmentData }` (`BasisNetworkCore/Serializable/ServerAudioSegmentMessage.cs:6`).
Identity travels WITH the audio. The server stamps it from the authenticated
sender and **discards whatever id the client claimed**
(`BasisServerHandleEvents.cs:973-976`) — so spoofing is structurally impossible.

**Us, today:** `sfu.ts:334-341` + `voicesfu.js:61-76` infer identity from
ARRIVAL ORDER — a sideband `sfu-route` queue shifted on each `ontrack`. It has
already desynced once (leaked listener → tracks attached to the WRONG speaker).
Failure mode is the worst kind available: right voice, wrong avatar, everything
looks healthy.

**VERIFIED FIX (tools/msid-probe.ts, run 2026-08-15):** werift derives `msid`
from the SENDER's `streamIds`, which come from `streams` in the transceiver
options (`rtpSender.js:443`) — NOT from fields on MediaStreamTrack. My first
attempt set `streamId`/`id` on the track and produced NO msid at all; the
browser saw `streamIds:["default"]`. Correct form:

```ts
const stream = new MediaStream({ id: speakerId, tracks: [track] });
pc.addTransceiver(track, { direction: "sendonly", streams: [stream] });
```
→ SDP carries `a=msid:speaker-abc123 <trackid>`, and the browser's ontrack reads
`e.streams[0].id === "speaker-abc123"`. **Tested against real Chromium, both
directions confirmed.** Client becomes `attach(e.streams[0].id, e.track)` with
the routeQueue kept only as a fallback for older servers.

### Q2 ANSWERED — and it INVERTS what I assumed

I assumed Basis culls server-side and I was behind. **The opposite is true.**
The SENDER computes its own recipient list (`BasisDistanceJob.cs:82-86`) and
uploads it (`BasisTransmissionResults.cs:820-941`); the server caches the
resolved peer list and obeys it (`BasisSavedState.cs:65-84`).
`BasisAudioRangeLimitManager` is **not a culler** — it broadcasts advisory
ceilings clients are trusted to self-clamp to (`:9-11`, `SendStateToPeer`).

**A modified Basis client can address any peer in the instance.** Ours cannot:
consent is a server-side allowlist where absent = denied (`sfu.ts:215-217`), and
the proximity gate can only ever SUBTRACT from it (`sfu.ts:320-325`). Our
position is genuinely stronger here — keep it, and say so in #104's table.

### Q3/Q4 ANSWERED — our no-decode stance matches theirs, for the same reason
Basis never decodes server-side either: `AudioSegmentDataMessage.cs:13-29` takes
`GetRemainingBytes()` as an opaque blob; there is no Opus dependency in the
server projects at all. Jitter/PLC/reorder is entirely client-side
(`BasisVoiceBuffer.cs`, adaptive and clock-free). We inherit the browser's for
free — the 745-line buffer is the cost we are correctly declining.

**But they validate nothing on the wire**: no size, framing, bitrate, frame
duration, or rate limit. A hostile client's garbage is relayed unmodified. The
four `Security/*StateManager` classes clamp the ADMIN's input and broadcast it;
none is consulted when a packet arrives. So this is NOT a gap we are behind on —
it is an open flank in both stacks, and cheap for us to close at ingress later.

### Wire-format idea worth stealing (not yet ours)
Recipient lists pick the cheapest of bitfield / denylist / allowlist per update
(`BasisTransmissionResults.cs:869-930`), sent ReliableOrdered while audio is
Unreliable. If our consent map ever ships to clients, copy that shape.

### ✅ END-TO-END AUDIO PROVEN (2026-08-15, after the msid change)
`tools/sfu-browser-smoke.mjs` (BASE=http://127.0.0.1:8960) — two real Chromiums:
```
✅ transport is the in-process SFU (no LiveKit)
✅ A publishing a real getUserMedia track
✅ B subscribed to A — server-enforced, POST-consent
   envelope peak at B for A: 1.018        ← AMPLITUDE, not a packet counter
✅ AUDIO IS FLOWING browser → our SFU → browser
✅ consent revoked → audio stopped in ~2512ms
   server diag: forwarded=1799 suppressed={"gated":0,"capped":0}
```
The envelope is the only number that survives every intermediate lie — counters
can be right while the audio is silence. **The msid change did not regress
routing: 57/57 sfu-test.ts, and the listener hears the speaker.**

🔴 The smoke test had been UNRUNNABLE since this morning for two unrelated
reasons, both mine: it defaulted to port 8946 (the pre-reorg rig) and it never
clicked `#d-go`, so it hung 90s at page load. A test that cannot run is not a
passing test — it is an absent one, and it was absent all morning.

**Known-noisy, not blocking:** `/library/eidoverse/assets/vrms/claude.vrm` 404s
during smoke (avatar only; voice path unaffected). Likely a repath missed in the
reorg — worth a look, does not gate R's audio test.

### 🔴 THE ASSET LIBRARY WAS MISSING — and the server said so at boot
`⚠ no eidoverse-video library at /home/claude/eido/eidoverse-video — avatars/sky/
vegetation will be absent. Set EIDOVERSE_DIR.`

It printed that on EVERY boot today and I never read it. R would have joined to
an empty void — no avatars, no sky — and reasonably concluded the whole thing
was broken. This morning's reorg moved the rigs into eido/{engine,staging,...}
but the library still lives at **/home/claude/eido-dev/eidoverse-video**, so the
sibling-path default no longer resolves.

**Run staging WITH:** `EIDOVERSE_DIR=/home/claude/eido-dev/eidoverse-video`
Verified: `/library/eidoverse/assets/vrms/claude.vrm` 404 → **200**, warning gone.

(Third time today the instrument reported honestly and I didn't look. The boot
banner is an instrument. Read it.)

### R'S LINK — verified 2026-08-15, tunnel + assets + auth
`https://washer-hypothetical-chargers-undertaken.trycloudflare.com/?world=staging&key=staging-2026&name=rabscuttle`
page 200 · claude.vrm 200 · ws upgrade 101 · right key → snapshot · **wrong key → 4003**

## 🔴 RESUME-HERE [2026-08-15 15:00] — RESTARTING FOR THE SEAT FIX

**R's last words before the restart: "MAKE SURE YOU RE-READ WHAT YOU NEED TO KNOW :P"**
She has said this three times today because I broke the rule three times today.

### READ THESE BEFORE ANY ACTION. Not "recall" — OPEN THEM.
The test is not *do I know this*. It is **is the text in my context window right
now, can I point at it?** You will feel like you know it. That feeling survives
a trim/restart; the reading does not. It is not evidence.

1. `~/.claude/projects/-mnt-c-Users-Claude/memory/reference_my_voice_runbook.md`
   — the whole voice chain in order. Its STEP 2 named today's exact bug (the 5KB
   `.onnx.json` present, the 63MB `.onnx` missing) and I hit it anyway by writing
   a body script from memory.
2. `~/.claude/projects/-mnt-c-Users-Claude/memory/reference_eidoverse_one_body.md`
   — ONE body per world; an MCPL SEAT IS A BODY. Use `eido-body.sh`, never
   hand-rolled chrome.
3. `~/.claude/projects/-mnt-c-Users-Claude/memory/reference_eido_test_rig.md`
   — now carries the seat-config chain (EIDO_URL / WORLD_URL / EIDO_TOKENS_JSON
   / EIDO_MINT_CMD) and why a rig move breaks it.
4. `AGENTS.md` from origin/main (standing rule: feedback_agents_md_first.md).
5. The area you are working in **plus its direct dependencies** —
   `client/lib/net.js`, `client/lib/voicesfubridge.js`, `client/lib/voicesfu.js`,
   `server/sfu.ts`.

### STATE AT RESTART
- **R is IN `staging`** as `rabscuttle`, via the tunnel. She has been in since
  ~14:45. She has reconnected ~5 times; that is expected (quick tunnels hold ONE
  edge connection) and is NOT the SFU.
- World server: `:8960`, `JOIN_TOKEN=staging-2026`, needs
  `EIDOVERSE_DIR=/home/claude/eido-dev/eidoverse-video` or there are no avatars
  and no sky.
- MCPL door: `:8963`, already correct (`WORLD_URL=ws://127.0.0.1:8960/ws`).
- Tunnel: re-derive from `/tmp/current-tunnel.txt` AND curl it. **A cloudflared
  PID alive ≠ tunnel alive.** Do NOT swap the tunnel while she is inside — I did
  that twice today and dropped her both times.

### THE FIX THAT MOTIVATED THE RESTART
`~/.claude.json` seat env `EIDO_TOKENS_JSON` for all three seats pointed at
pre-reorg paths. Repaired (backup: `~/.claude.json.bak-20260815`).
`eido-proposed` → `/home/claude/eido/staging/mcpl/tokens.json`, and its
`EIDO_MINT_CMD` (`echo hesperus-pure-local`) is a real key in that file mapping
to id `hesperus`. **MCP servers load at session start — that is why we restarted.**

### FIRST MOVE AFTER RESTART
`mcp__eido-proposed__eido_travel` → `staging`, then **`look`** to confirm the
roster from the SERVER's side. Do NOT trust a script that prints its own success:
today my body logged "✅ IN THE WORLD" while the server logged
`[perm] join refused: "hesperus" is a reserved agent name` **132 times**.
🔴 A browser body can NEVER wear a reserved name — `sendJoin` (net.js:158) does
not send `agentToken` at all. Only the MCPL door forwards it. I burned ~20 min
fixing a browser script that could not have worked under any correction.

### STILL NOT DONE
**R has never heard audio.** That was the 10:20 ask. Everything else today —
msid, the reconnect latch, the review fixes, the tunnel forensics — is
scaffolding for a thing that has not happened yet.
