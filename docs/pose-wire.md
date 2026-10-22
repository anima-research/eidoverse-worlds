# The pose packet — what rides presence (never the log)

*Field-level contract of the `pose` bag. The message-level inventory (planes, close codes, the message types) is `docs/WIRE.md` §3 — this file is what that table's `{pose}` contains.*

`{ type: 'pose', pose }` at ≤15 Hz per embodied client; the server batches the latest per id into
`frame` messages and keeps `lastPose` for late joiners. Nothing here is persisted. The server
refuses non-finite or malformed samples at the source (`server/posecheck.ts`).

| field | type | meaning |
|---|---|---|
| `p` | `[x, y, z]` | root position (world) |
| `yaw` | number | the body's **facing** (world yaw). Desktop: the controller's yaw. VR: `xrAvatarYaw()` = root + hips-latch + rest — remotes set their root to it |
| `pitch` | number | head pitch (desktop look) |
| `speed`, `clip` | | locomotion for the remote's mixer |
| `anim` | string | an anim played once (a gesture); sent once (its pre-release key is still read for one release) |
| `pose` | `{bone: quat}` | a held custom pose (bodydrag / gestures); blended a→b by receivers |
| `bodyMode` | string | stand \| sit \| lie \| swim \| fly \| fall: the body's mode, apart from `clip` (what plays); the mover sets it on real transitions, the owner may declare any for looks; it grants nothing (`shared/bodymode.js`; a sample without it: read off `clip`) |
| `poses` | `[name]` | the poses this body holds by NAME (one frame each; R 10-17): `"wings-folded"` today, each rig resolving it its own way; `[]` holds none, absent says nothing (`shared/wingpresence.js`; was the boolean `wingsFolded`, still read) |
| `pins`, `reach`, presence | | see their modules (`shared/reachwire.js`, `shared/presencewire.js`) |
| `xr` | object | **tracked head + hands (C18, 2026-09-06)** — below |
| `mic`, `hear` | boolean | this body's mic is live / it is hearing voices — **shared with everyone in the world**, below |
| `t` | number | this sample's **capture time** on the world's authority clock (ms; spec/PHYSICS.md §5.1). Sent once a `clock` round trip has measured the offset; receivers interpolate at it when it's sane against the frame (not after the frame's `t`, not older than 1 s), else at the frame's `t`. A live reading: never remembered for late joiners |
| `seq` | integer ≥ 0 | the sender's own count of samples. A live reading, like `t` |

## `xr` — tracked body, facing-relative

Everything is expressed in the **facing frame**: origin at the root, yaw = the wire `yaw`. A receiver
sets its root to that yaw, so its root frame *is* this frame; no calibration data travels.

```
xr: {
  h: [qx, qy, qz, qw],               // head, relative to the facing (the look-chain input `qRel`)
  l: [px, py, pz, qx, qy, qz, qw],   // left grip in the facing frame — absent if untracked / a gesture owns the arms
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

## Named poses, body-mode, anims, size and voice (moved from PROTOCOL §5, the house's view #260 10-20: one list)

Verbatim when moved; PROTOCOL §5 keeps the rules that bind (a declared body-mode grants nothing; a once-anim is never replayed; `live` is reserved; receivers clamp).

Named poses
  travel the same way: `pose.poses` lists the poses a body holds by name (a
  pose is one frame, only the bones it names; a clip has more than one key), never implementation-specific quaternions: `"wings-folded"` is
  the folded-wing silhouette, which each renderer applies through the worn
  rig's own fold path, and a name a rig doesn't know is ignored (its
  default). An empty list holds none; an absent one says nothing. (Before
  release the packet said `wingsFolded: true|false`; a receiver still reads
  it as that pose.) The same packet carries a body's
  size and a person's voice state, each optional, absence meaning the
  default (or, for voice, *unknown*):
  - `pose.bodyMode` — what the body is doing as a whole: `stand` | `sit` |
    `lie` | `swim` | `fly` | `fall` (R 10-17; was the posture, read off the
    clip, which is what a sample without it still means). The body's owner
    publishes it: the mover sets it on real transitions (into water, an
    actual take-off, airborne, landing) and the owner may declare any of the
    six for looks; a declaration holds until the next real transition or
    declaration. It is apart from `clip` (what plays). It is a self-declared
    description: the authority and every server MUST NOT grant or relax any
    rule, consent check or permission because of a declared body-mode; a rule
    that depends on a body's state checks what it can verify on the act (the
    water at the position, the fly permission at take-off).
  - `pose.anim` — the name of an anim the body plays ONCE (a gesture: a pose
    or a clip, by name), riding exactly one packet: a receiver plays it over
    whatever the body holds and returns to that, and nothing remembers it
    (a joiner never replays it). Before release the packet carried it under
    its pre-release key, which a receiver still reads for one release.
    The anims a body PLAYS OR HOLDS are layers: the clip, a
    held pose (`pose.pose`, `pose.poses`) and live animations relayed by the
    `anim` message each play at once, and a new one replaces only its own
    layer. When a body stops them — all, or one by name — it rests in its
    CURRENT body-mode's own anim (`stand`: idle; `sit`: its sit loop; `lie`;
    `swim`: tread; `fly`: its hover), never the bind pose, and its
    `bodyMode` is unchanged by the stop. `{type: "anim", stop: true}` is the
    relay message that fades out every live animation the sender is
    playing (each receiver hands the bones back to what is beneath). The
    name `live` is reserved: it names every ad-libbed anim (one started from
    joints or tracks, never a name), so no clip, def, pose or world's or
    avatar's anim may be called it, and stopping `live` stops those only.
  - `pose.scale` — the wearer's chosen size multiplier for the whole body
    (mesh, eyes, stride, collider); absent = 1. Range 0.5–2.
  - `pose.plateY` — metres the nameplate hangs above the body's measured
    crown, at its authored size (it grows with `scale`); absent = 0 (auto).
    Range −0.3…+0.8.
  - `pose.mic` — this person's microphone is live; `pose.hear` — they are
    hearing voices. Booleans; absent = unknown, never "off".

  Receivers MUST clamp `scale`/`plateY` to their ranges and read a
  non-number as absent; a non-boolean `mic`/`hear` is absent
  (shared/presencewire.js holds the clamps; the server's pose fence applies
  the same ones). `scale`/`plateY` are body state and ride the settled pose
  a server keeps for late joiners, as `poses` does; `mic`/`hear` are
  a live reading re-sent with every packet and are never part of it. The
  pose packet's fields are `docs/pose-wire.md`.
