# Fixture worlds (under `spec/fixtures/replay/` — `.gitignore` ignores any `worlds/`) for `tools/replaybench.ts`

Committed logs a clean checkout can replay, with a committed baseline
(`.replaybench.json` beside them). One authored story under each carried
sim law, so a change that moves an old law's bits is caught by name:

- `eidosim-0.3/` — the collision law without a swept test (thin bodies at
  high power tunnel; that IS 0.3.0, pinned).
- `eidosim-0.4/` — the same story under the swept law.

The story: a terrain, a wall and a deck standing before the epoch (boxed by
the epoch's stamp), a crate and a ball spawned after it (boxed by the spawn
stamp), a punt into the wall, the wall moved mid-flight, a punt onto the
deck, a hard punt at the moved wall, a terrain change under a live epoch
(bodies released, statics rebuilt from the fold), and a punt after it.

`bun tools/replaybench.ts` replays both alongside the operator's worlds;
`--write` refreshes baselines — a changed fixture digest with an unchanged
log is a sim-law change and wants an epoch bump, never a re-record.
