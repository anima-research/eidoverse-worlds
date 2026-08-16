# Removing the mesh — scoped 2026-08-16, NOT yet done

**R's call, direct:** *"Moving away from mesh entirely is the goal. You can get
rid of it — the PR can simply be rolled back if it breaks audio."* Plus: antra
told her directly they are moving onto relay, so #104 A5 ("current mesh stays as
the production/rollback path") is superseded by the author of the amendment.
**Rolling back the PR IS the rollback path.** No deviation to apologise for.

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

## ✅ Checked before starting: mouth-flap is SAFE

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
