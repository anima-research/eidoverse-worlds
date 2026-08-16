# Removing the mesh — scoped 2026-08-16, NOT yet done

**R's call, direct:** *"Moving away from mesh entirely is the goal. You can get
rid of it — the PR can simply be rolled back if it breaks audio."* antra told
her directly they are moving onto relay.

## How to say this to A5 (the framing for the PR, R's words 2026-08-16)

Do NOT present this as ignoring A5. **Acknowledge the amendment and answer it:**

> A5 asks that the mesh remain the production/rollback path while the floor
> proves itself. We are keeping the rollback path — it is the revert. The mesh
> is not deleted from history, it is one `git revert` away, and reverting this
> PR restores it in full with no config change and no migration.
>
> What a clean swap buys is TESTABILITY. Two live transports in one client mean
> every audio result carries the question "which one produced this?" — a
> question that has already cost us real time: a dropped `?sfu=1` served an hour
> of "SFU results" that were actually mesh (main.js:196), and a sidecar signalled
> happily over `rtc` on an SFU server while being heard by NOBODY
> (server.ts:1097). A single transport makes every subsequent test unambiguous,
> which is exactly what an acceptance table needs.

That is the honest argument and it is stronger than a workaround, because A5's
goal — never be stranded without working voice — is fully preserved.

🔴 **The reason keeping it was a mistake in the first place:** SFU-SPEC.md:22
says *"A5 is absolute and I obey it."* I treated a written amendment as binding
and never re-checked it against what R had told me directly. She had already
said we were moving off mesh; I had a document saying otherwise and let the
document win. Same failure as citing a RECEIPTS.md that never existed: trusting
a written artifact over checking. She had ALSO caught it once already
(main.js:196, 08-15: "Why aren't you commenting out the mesh code entirely so
sfu=1 matters?") and I answered with a FLAG when the requirement was that the
wrong path be IMPOSSIBLE.

## Why this is NOT the same shape as the LiveKit delete

LiveKit was shallow: 4 server branches, each `if (sfu) {...return}` with a
fallthrough, and one dynamic client import. It collapsed.

The mesh is load-bearing in the CLIENT. `client/lib/voice.js` is **1403 lines**
and six modules import it — mostly for helpers, not transport:

| symbol | external uses | SFU equivalent |
|---|---|---|
| `micOn` | 23 | `sfuMicOn()` (voicesfu.js:41) |
| `toggleMic` | 16 | `window.__sfuMic` (voicesfubridge.js:197) |
| `micAnalyserLevel` | 8 | `sfuMyLevel()` (voicesfu.js:399) |
| `peerLevels` | 2 | `sfuPeerLevels()` (voicesfu.js:417) |
| `initVoice` | 2 | `initVoiceSfu` |

**Only 2 of 35 `micOn` call sites are SFU-aware today**; the other 33 read
voice.js and some layer a `window.__sfuMicOn` fallback on top. So this is a
rewire of the whole client audio surface, not a delete.

## The order that keeps it safe

1. **Extract the shared helpers first**, exactly as `server/transport.ts` was
   extracted before deleting the LiveKit adapter. A `client/lib/voicestate.js`
   owning `micOn` / `toggleMic` / `micAnalyserLevel` / `peerLevels`, delegating
   to whichever transport is live. Then no consumer imports a transport at all.
2. Repoint all 35 call sites at it. Mechanical, greppable.
3. **Then** delete voice.js, the `?mesh=1` arm, and the server's `rtc` verb
   (server.ts:1091 — mesh signalling, dead once no client speaks it).
4. Re-run the six-suite baseline (155 assertions) AND a real two-browser audio
   check. Tests alone cannot see this one: every mesh bug this year was found by
   two real browsers, never by a suite.

## Do NOT do it inside the SFU PR

It is a second large change to the same files, and it would make an already
oversized PR unreviewable (an independent reviewer already called PR 1 at ~50
files "too big to review honestly"). Ship the SFU, then remove the mesh as its
own PR whose diff is almost entirely deletions — which is the easiest kind to
review and the easiest to revert if audio breaks.

## 🔴 THE FULL READ CHANGED THE PLAN (2026-08-16, R: "Have you read all of the
## audio code to make sure your changes make sense?" — I had not)

A complete read of all 19 client audio modules found things a partial read
missed. **The mesh is not just a transport — it is where the shared audio
machinery lives.** Deleting voice.js as scoped below would have shipped SILENT
capability loss, not a clean swap.

### What dies silently with voice.js (nothing errors; features just vanish)

| Lost | Evidence |
|---|---|
| **The entire mic NOISE GATE** | `gateStream`/`attachSource`/`driveGate`/`setMonitor` — verified: voice.js is their ONLY production caller. `voicesfu.js` never gates anything (zero matches). micgate.js (280 lines) becomes unreachable except audiopanel's 3 escape-hatch symbols. |
| **The mic sensitivity slider becomes decorative** | It still paints a marker, but `gateThreshold()` loses both callers, so nothing consumes the value. Precisely the "control that lies" micgate.js:68-79 exists to prevent. |
| **`releaseMicrophone()`** | The only path that stops the device and clears the OS recording indicator. `sfuClose()` closes the pc but never stops mic tracks. A privacy-visible regression. |
| **Mute, as a concept** | The SFU has none. `voicemouths.js:57` calls `isMuted()` from voice.js on BOTH paths — after deletion that import does not resolve at all. |
| **Self-monitor ("hear yourself")** | micgate.js:144-192 implements the graph; only voice.js reaches it. |

### 🔴 And a calibration bug that would have been blamed on anything else

`micAnalyserLevel()` (mesh) is **RMS**: `sqrt(mean(x²))`, voice.js:876-878.
`sfuMyLevel()` (SFU) is **PEAK**: `max(|x|)`, voicesfu.js:410-412.

Peak runs ~1.4–3x RMS for speech. The sensitivity slider was calibrated against
RMS — voiceconsent.js:57, *"60% = -24 dBFS… R's number, found by TESTING IT IN
HER ROOM"*. Deleting the RMS analyser silently re-scales her calibration.

### Hard breaks (module resolution fails immediately)
main.js:34,541 · mictoggle.js:12,123 · audiopanel.js:19,36 ·
voicemouths.js:9-10 (incl. `isMuted`) · stt.js:74 · tts.js:102,612

### Revised order — extract the SHARED HALF first, and it is bigger than helpers
Move into a transport-neutral module (or into micgate.js) BEFORE deleting:
`micAnalyserLevel` · the onset/gate loop (`onsetTick`/`gateAudio`/
`startOnsetWatch`) · `muted`+`toggleMute`+`isMuted` · `releaseMicrophone` ·
`hasMicDevice` · `setSelfMonitor` · and the acquisition block at voice.js:593-632
that wires `voiceSource()` → `gateStream`/`attachSource`. Then wire
`sfuPublish()` through it. THEN delete.

### Open question for R (I will not guess)
Is the SFU's missing mic gate deliberate spike scope, or an oversight? No
comment in either SFU file mentions gating the outbound mic. If deliberate, the
gate moves anyway (the slider must not lie). If an oversight, the SFU has been
publishing UNGATED mic audio this whole time — which would explain room noise
nobody attributed to a transport change.

## ✅ Also checked: mouth-flap is SAFE

The worry was that `voicemouths.js` and `audiopanel.js` read voice.js's analyser
for mouth-flap and meters, and would go flat when the mesh is deleted — a
regression nobody would blame on a transport change.

Verified it does not happen. `voicemouths.js:43-48` already prefers a global and
only falls back to the mesh:

```js
if (typeof window.relayPeerLevels === 'function') return window.relayPeerLevels();
return meshPeerLevels();
```

and the SFU bridge installs it (`voicesfubridge.js:181`,
`window.relayPeerLevels = sfuPeerLevels`; `:187` does the same for
`__sfuMyLevel`). `voicesfu.js:416` states the shape is deliberately identical
"so mouth-flap code is shared."

So the seam was designed for this. Deleting the mesh removes a FALLBACK arm,
not the live path — which is why step 1 (extract shared helpers) is the right
shape rather than a rewrite: most consumers already ask a neutral global.
