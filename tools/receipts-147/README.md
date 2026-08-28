# #147 receipts — the yaw unit contract

Base `origin/main` **6006d6d**. Branch `im/147-yaw-unit-contract`.

Nothing in this change touches world state: no entity is re-yawed, no verb is
rewritten, no migration runs. The doors are labelled; the room is left alone.

## The guard

`tools/yaw-units-test.ts` — no servers, no world, no network.

```bash
bun run tools/yaw-units-test.ts
```

| where | result |
|---|---|
| this branch (`on-branch.txt`) | **50 checks, all green** |
| `origin/main` 6006d6d + only the two new files (`fail-on-main.txt`) | **20 named fails**, 30 pass |

The control is the guard run against the *unlabeled* sources, with only
`mcpl/units.ts` and the test itself copied in — so the failures are the defect,
not a missing import. It reproduces the issue's own quoted shapes verbatim:

```
✗ mcpl/server.ts: yaw: z.number().optional() — a typed yaw with no unit
✗ mcpl/net-server.ts: yaw: { type: "number" } — a typed yaw with no unit
```

The 30 that pass on main are the invariants: the arithmetic in `mcpl/units.ts`,
`spec/PROTOCOL.md` §9 Conventions (which already said radians — it was never the file at
fault), and the scanner's own positive controls. The guard cannot pass vacuously:
it asserts a minimum number of typed yaws per door, so deleting a property fails
too, and it proves on synthetic sources that it catches both drift shapes and a
hand-inlined description.

## Suites on this head

| suite | result |
|---|---|
| `bun run tools/yaw-units-test.ts` | 50 / 50 |
| `bun run tools/smoke.ts` | 84 pass, 1 fail — **pre-existing**, see below |
| `bun run mcpl/effective-test.ts` | 42 / 42 |
| `bun run tools/motioneval-test.ts` | 33 / 33 |
| `bun run mcpl/denoise-test.ts` | all green |
| `bun run mcpl/manifest-test.ts` | 28 pass, 0 fail |
| `bun run tools/seatcore-test.ts` | all green |
| parse check, all five edited files | clean (`Bun.Transpiler`, loader ts) |

`smoke`'s **`✗ rtc reaches its recipient`** fails identically on the
`origin/main` control worktree (84 pass / 1 fail there too) — it is not this
change. `manifest-test` is included deliberately: MCPL manifest revisions hash
`declaration.ts`, not the tool table, so labelling a tool schema moves no
revision — confirmed, 28/28 unchanged.

**Not run here:** anything requiring `@animalabs/mcpl-core`, which
`mcpl/package.json` resolves as `file:../../mcpl-core-ts` — a sibling checkout
this box does not have. `mcpl/net-server.ts` therefore could not be executed,
only parsed and scanned. Its two labelled schemas and the `formatYaw` call in
`measure` are verified statically, not by a live tool call. Flagged rather than
papered over.
