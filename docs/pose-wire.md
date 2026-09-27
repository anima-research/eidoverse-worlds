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
