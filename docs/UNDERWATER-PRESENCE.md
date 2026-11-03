# Underwater renderer adapter — optional presence fields

No new verb or log dialect. The sequencer already relays three-dimensional,
Y-up, metre-valued positions, including negative Y. Swimming and vehicle physics
remain with the body's client. Buildings and terrain need not be realized by
every renderer: the Unreal prototype currently realizes presence and live chat
only, not the authored-world fold or deterministic entity simulation.

Example client-to-server message:

```json
{"type":"pose","pose":{"p":[12,-30,8],"yaw":0,"speed":1.4,"clip":"walk","q":[0,0,0,1],"locomotion":{"mode":"swim","medium":"water","body":"diver"}}}
```

- `q`: optional normalized `[x,y,z,w]` quaternion, full body-local to world
  rotation. Same Y-up/right-handed/+Z-forward convention as protocol §9. Keep
  `yaw` for older clients; `pitch` remains the existing look/gaze convention,
  not a replacement for the full body's quaternion.
- `locomotion`: optional descriptive bag. This adapter emits `mode` as `swim`,
  `surface`, `walk`, `climb`, or `pilot`; the ladder's active transition reports
  `climb`. `medium` is `water` or `air`; `body` is `diver` or `submarine`.
  Unknown strings remain legal (bounded to 32 characters), not new privileges.
- Positions refer to the client's body anchor. The Unreal adapter uses the
  controlled pawn's origin, not a reconstructed foot or eye location.
- Older clients keep using `p/yaw/clip`; they do not automatically gain a
  swimming controller, submarine model or full-body orientation rendering.
  `walk`/`idle` clips are a compatibility fallback, not a claim of foot contact.
- The current headless `walk_to` tool still clamps to its terrain. It must not
  be advertised as underwater navigation. A remote client can already send the
  extended poses; an agent swimming controller is a separate client feature.
- These fields ride `frame`, late-join `present[].pose`, and settled restore
  unchanged; neither field belongs in per-frame `place`/`comp` log writes.
- No new authentication authority. Existing join/spectator/takeover gates apply.
  Servers reject non-finite/malformed quaternions and locomotion bags. Absence
  preserves compatibility with legacy presence packets.

For isolated development, `HOST=127.0.0.1 PORT=8993` binds only loopback. Set
`WORLDS_DIR`, `OPT_DIR`, and `RELAY_STATE_DIR` to scratch directories, and
`SKIP_OPT_SWEEP=1`; never test with production logs or a resident's port.
