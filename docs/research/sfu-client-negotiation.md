# The browser SFU client (client/lib/audio/voicesfu.js): negotiation notes

Why the client half of the in-process SFU is shaped the way it is. The spec is `docs/design/SFU-SPEC.md`; the transceiver
behaviour below is reproducible in seconds with `test/labs/mini-sfu-repro.mjs`.

## The server offers, always

A browser publishing its mic offers `sendonly`, and an answer cannot add a receive direction the offer never proposed,
so a server that answered would forward into a track nobody receives. Every renegotiation is server-initiated: the
client only ever does `setRemoteDescription(offer)` → answer, and when adding a track makes it want to renegotiate it
ASKS the server to offer (no glare).

## Which transceiver the mic goes on

With anyone else in the room the client's pc holds, in order:

    [sendonly route → speakerA] [sendonly route → speakerB] [recvonly floor]

The FLOOR is the m-line the server offers to receive our mic. `addTrack` reuses the first *compatible* transceiver,
which is a speaker ROUTE, so the mic lands there (answered `a=recvonly`) and the floor is answered `a=inactive`
forever. The server (werift fires ontrack only for sendonly|sendrecv with a non-zero port) never subscribes: server
diag says `publishing:false / rxPackets:0` while the client honestly reports thousands of packets sent. It only
reproduces with 2+ people; a lone client has no routes to mis-pick.

So the hunt, in order:

1. the sender we already own (a SWAP: `replaceTrack` on the same m-line, no renegotiation);
2. the inactive floor (the first publish);
3. bare `addTrack`, only when neither exists (solo, or before the first offer).

"Already own" is decided by `currentDirection` wherever it exists, because it is what the negotiation actually agreed.
`direction` is only our ask: an `addTrack` transceiver created before the first offer can be associated by JSEP with a
speaker route and answer `currentDirection='recvonly'` while `direction` still reads `sendrecv`. `direction` is
consulted only while `currentDirection` is null (never yet negotiated).

After an offer is applied, a live outbound track that no m-line is actually sending (a publish that beat the first
offer into an occupied room) is moved to the floor and renegotiated: the stranded-publish rescue.

## Identity of inbound tracks

The server names each outbound stream after the speaker it carries (`sfu.ts` ensureRoute), so the msid welds identity
to the media. The sideband `sfu-route` queue (pairing tracks with speakers by arrival order) is only a fallback for an
older server; when both are present and disagree, msid wins and the client says so. The route subscription is made
ONCE for the module's lifetime (the bus has no `off`; a per-connect listener would desync the queue).

## ICE

- The ICE config comes from the credential (`iceServers?` in the SFU spec), so an operator can point at their own
  STUN/TURN without a client rebuild. Without STUN there is no reflexive candidate, and a peer on another network
  stalls in `checking` forever without an error. The fallback stays `[]`, so an older server's credential behaves as
  before rather than silently acquiring a public dependency.
- Candidates that arrive while the offer is still being applied are QUEUED, not dropped: `addIceCandidate` throws
  before a remote description exists, and the one viable pair on a constrained network can arrive in that window.
- Candidates carry their generation; the server refuses one that cannot prove which leg it belongs to.
- A connection that never connects SAYS so to the person: `failed`, or 8 s in `checking` (host pairs settle in well
  under a second on a LAN). `disconnected` is not failure; it is often transient. A media-only death emits
  `sfu-media-dead` and the bridge, which owns the retry budget, re-asks for a credential.

## Reconnects

A reconnect builds a new pc. The old mic stream belongs to the old pc, so it is stopped and dropped (intent, `wantMic`,
is kept) and the bridge's replay takes the real `addTrack` path. Under the gate that stream is the gate's destination,
so the device feeding it is dropped too (micstate `dropDevice`): micstate stops a device whenever the transport lets go
of it. The predecessor pc is closed with its handlers nulled first, and every handler, timer and async exchange
snapshots the pc it was armed for and returns if superseded, or a ghost pc would diagnose (and burn the recovery budget
on) its healthy successor.

## Mic acquisition

- ONE ACQUISITION AT A TIME. `getUserMedia` can sit on a permission prompt for seconds, and two callers (a key press
  and the credential-time replay) can be inside it at once: two senders, a double publish, and an orphaned stream whose
  hardware light stays on after leaving. The guard is a promise (late callers await the same acquisition), tagged with
  the pc it was for; a stale one is awaited and then treated as absent, and every waiter re-checks after each await.
- RE-READ INTENT AFTER THE AWAIT: a mic toggled during the prompt means whatever arrived answers a question nobody is
  asking any more; stop it and ask the current question.
- The source comes from `voiceSource()` (the seam), not the device: the mic when wanted and available, else the synth
  provider. Mic OFF with a synth provider SWAPS the published source rather than muting the tracks; mic ON with a synth
  stream published re-acquires the real device.
- The device stream is GATED (`gateFor`) before the sender sees it; if the gate can't run the publish is refused rather
  than silently transmitting an ungated mic. Synthetic sources pass through.
- A denied permission prompt is an answer, not a crash: the intent is cleared (only by the invocation that owns it).

## Levels

The own-level analyser (`sfuMyLevel`) reads the RAW device, not the gated lane: a mouth answers "are you making sound",
and a sensitivity meter that only moves once you are over the threshold cannot help you set it.

## What the browser gives us for free

AGC, noise suppression and echo cancellation come from `getUserMedia` constraints. On receive, NetEq is the jitter
buffer: `jitterBufferTargetDelay` is its adaptive depth, inserted/removed samples its time-stretching,
`concealedSamples` its PLC. `sfuInboundStats` exposes them. (Basis, by comparison, hand-builds a serious AGC, binds
RNNoise natively, has no AEC, and carries a ~745-line jitter buffer.)
