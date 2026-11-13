# ammodoll tuning notes: hair, wings, leg limits

Measurements and reasoning behind the tables in `client/lib/ragdoll/ammodoll.js` (`HAIR_TUNING`, `WING_TUNING`,
`JOINT_SPECS`). The values in the code are current; the tables here are the measurements that led to them.

## Hair (`HAIR_TUNING`)

Tuned in-world on a falling body with the debug panel's sliders, not derived. Hair has no honest headless metric for
"flows" versus "whips", so the eye is the instrument.

- **Scale.** The source playground works unit-scaled (height 0.999, gravity -5.7664); this rig is in real metres (1.7 m,
  -9.81). Dimensionless quantities (damping, the gravity fraction, the limit ramp) port straight across; mass goes as
  length cubed.
- **Tune against the render.** Earlier tunings were done while three-vrm's springbones overwrote every hair bone later
  in the frame (see avatar.js's `vrm.update` and the `matrixAutoUpdate` note in `step()`), so the sliders were tuning a
  simulation nobody could see. Only numbers chosen while the render follows the sim mean anything. The current values
  land close to the source playground's own defaults (mass 3 g, tension 8, damping 0.6, gravity 0.45, limit 25,
  rootExp 1.0).
- **Measure local bend.** Mean LOCAL bend per hair joint: world rotation cannot tell "the hair moves" from "the head
  moves" (a lock riding a tumbling body turns 100 degrees while lying straight). One sweep, once the render followed the
  sim:

  | tension | damping | peak bend | at rest | jitter (°/frame) |
  |--------:|--------:|----------:|--------:|-----------------:|
  | 20 | 0.22 | 34.9° | 12.4° | 0.020 |
  | 8  | 0.22 | 43.5° | 15.8° | 0.019 |
  | 3  | 0.22 | 52.8° | 20.3° | 0.018 |
  | 8  | 0.10 | 47.6° | 19.4° | 0.017 |
  | 3  | 0.10 | 52.9° | 24.9° | 0.021 |

  Monotonic in both knobs; jitter does not pay for any of it.

## Wings (`WING_TUNING`)

Measured over 4 lean directions per row (one fall's number is noise). The bend a wing KEEPS at rest matters, not the
bend it reaches. A stiff shoulder (140) spiked on impact and snapped back to its born pose: "rigid and twitchy".

| tension | damping | peak bend | bend at rest | jitter (°/frame) |
|--------:|--------:|----------:|-------------:|-----------------:|
| 140 | 0.15 | 25.9° | 0.3°  | 0.052 |
| 50  | 0.15 | 38.0° | 0.6°  | 0.047 |
| 20  | 0.15 | 46.6° | 1.4°  | 0.037 |
| 8   | 0.15 | 62.2° | 12.5° | 0.025 |
| 3   | 0.15 | 72.4° | 12.4° | 0.064 |

8 is the knee: below it nothing more is gained in fold and jitter climbs (a spring too weak to hold its joint quiet
against contact). Doubling the damping cost fold and doubled jitter at every tension.

**The ramp.** `lim = limit * ((j+1)/n)^rootExp`, so adding a third bone to the chain stiffened the shoulder (12.5° to
6.5° at 38/1.6) with no number changed. On the 3-bone rig:

| limit | rootExp | peak bend | bend at rest | jitter (°/frame) |
|------:|--------:|----------:|-------------:|-----------------:|
| 38 | 1.6 | 69.0° | 4.7° | 0.119 |
| 70 | 1.0 | 74.7° | 5.9° | 0.073 |
| 70 | 0.7 | 74.4° | 5.9° | 0.077 |

The linear ramp beats the steep one on both axes. 0.7 looked calmer on 4 leans but paired over 10 leans the difference
was -0.003 ± 0.024 (t = 0.13): nothing. Once boxes were sized from the mesh (`boneMeshExtents`), the linear row rests at
9.0° ± 2.0.

## Upper-leg limits (`JOINT_SPECS.upperLeg`)

The hand-tuned row was once parked wide (flex 90 / ext 45 / twist 30 / z ±45) because narrowing it made knees read 125°
of "hyperextension": a wide one-sided range put Bullet's wrap midpoint inside reach, and the limit then held the knee on
the wrong side. Range-centering (rotate the parent frame by the range midpoint, wrap at 180°) removed that class, and
the narrow row holds: every leg joint stays within limits through a full topple on both fleet rigs (worst
constraint-frame excursion 6°, the ERP slack). The 125°-signature reads that remained were the tumble suite's
positional instrument misreading a legal fetal fold; it now predicts the legal fold direction from the thigh's own
swing (test/client/ammodoll-test.ts).
