# The pose packet — what rides presence (never the log)

*Field-level contract of the `pose` bag. The message-level inventory (planes, close codes, the verb set) is `docs/WIRE.md` §3 — this file is what that table's `{pose}` contains.*

`{ type: 'pose', pose }` at ≤15 Hz per embodied client; the server batches the latest per id into
`frame` messages and keeps `lastPose` for late joiners. Nothing here is persisted. The server
refuses non-finite or malformed samples at the source (`server/posecheck.ts`).

| field | type | meaning |
|---|---|---|
| `p` | `[x, y, z]` | root position (world) |
| `yaw` | number | the body's **facing** (world yaw). Desktop: the controller's yaw. VR: `xrAvatarYaw()` = root + hips-latch + rest — remotes set their root to it |
| `pitch` | number | head pitch (desktop look) |
| `speed`, `clip` | | locomotion for the remote's mixer |
| `emote` | string | one-shot; sent once |
| `pose` | `{bone: quat}` | a held custom pose (bodydrag / gestures); blended a→b by receivers |
| `pins`, `reach`, wing-fold, presence | | see their modules (`shared/reachwire.js`, `shared/wingpresence.js`, `shared/presencewire.js`) |
| `xr` | object | **tracked head + hands (C18, 2026-09-06)** — below |
| `mic`, `hear` | boolean | this body's mic is live / it is hearing voices — **shared with everyone in the world**, below |

## `xr` — tracked body, facing-relative

Everything is expressed in the **facing frame**: origin at the root, yaw = the wire `yaw`. A receiver
sets its root to that yaw, so its root frame *is* this frame; no calibration data travels.

```
xr: {
  h: [qx, qy, qz, qw],               // head, relative to the facing (the look-chain input `qRel`)
  l: [px, py, pz, qx, qy, qz, qw],   // left grip in the facing frame — absent if untracked / an emote owns the arms
  r: [ … same … ],                   // right grip
  c: [lIndex, lGrip, rIndex, rGrip]  // finger curl 0..1
}
```

Receivers **re-solve**, they do not receive bones: the same distributed look-at (spine→head weights),
the same two-bone arm IK to the grip, the same finger curl (`client/lib/xrbody.js: applyRemoteXR`),
composed at the avatar's pre-`vrm.update` seam. Same law as `reach`: send the relation, let every
body solve it for its own skeleton. ~25 numbers per sample. Feet are not on the wire (remotes keep
the mixer's legs; the sender plants its own — C14).

Design note (from headset testing, 2026-09-05): the body root stays yaw-only on the wire; tracked parts get full
quaternions — Basis's shape (hips-anchored, T-pose-relative streaming) without Basis's 51-bone payload.

## Voice state — who sees it

*Recorded product-owner decision, 2026-10-02 (#212 review B2): "yes, see globally for mic/headphones."*

`mic` (the microphone is live: the HUD mic glyph's reading) and `hear` (the body is hearing voices: receiving **and**
not hushed, the HUD headphone glyph) are **shared with everyone in the world**, the way a voice app shows mute and
deafen. "Everyone" means every client the stage frame reaches: browsers at any distance, spectators, and agents'
sockets (`mcpl/agent.ts` keeps the raw pose in `people`, and `look` describes it).

- **What `hear: false` says:** this person will not hear you. It does not say *why*: never allowed voices, revoked
  them, or hushed the room all read the same. That is the disclosure the owner accepted.
- **Live only.** The server never remembers them: `settledPose` (server.ts) strips both, so a late joiner's
  `present` roster and a returning sender's `restore` carry neither; the next live frame does.
- **Absent = unknown.** A client that predates this sends neither field; receivers show "not shared" and never
  assume "can't hear you". The fence (`server/posecheck.ts`) drops a non-boolean field and keeps the rest of the pose.
- **Display is narrower than the data: hover only** (owner, 2026-10-02). Nothing is drawn beside a nameplate; mic
  and headphones appear only in the hover card (`client/lib/platecard.js`): "mic on/off", "headphones on/off", and
  in VR or not. In VR, a laser resting on a plate is the hover. The headphone toggle gates voice only (mic and TTS, not
  world sound), so an always-on mark mattered only to someone speaking aloud. Agents get it in words: `look`
  (mcpl/agent.ts `voiceNote`) says e.g. "headphones off: they won't hear anything spoken aloud, yours included, but
  they still see chat text", or "mic on: they may be talking aloud", or "in VR"; no claim when the client didn't say. None of this narrows the field itself, which reaches the whole world.
- **The UI says so.** The HUD mic and headphone tooltips end with "mic and hearing on/off are visible to everyone
  in this world" (`client/lib/mictoggle.js`).
- **No per-person opt-out yet.** A sharing switch (or server-scoped nearby state) would be a later change; it would
  only need to stop sending, since absence already reads as unknown.

Bound by `tools/voice-wire-test.ts` (owner → fence → frame → peer, spectator, agent; latest wins; fence; unknown;
not remembered) and `tools/voice-wire-mutation-test.ts` (sender, fence, settledPose and the look note each turn it red).
