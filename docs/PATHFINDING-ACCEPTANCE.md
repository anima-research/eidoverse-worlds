# Pathfinding stack: acceptance record

socketteer's four-PR stack (#235 agent-mesh-collision → #236 agent-navgrid → #239 agent-places → #241
build-check) is carried in this branch, merged whole at `ab4002b9` (stack head `4290ac58`). It was held to the
acceptance packet its reviewer wrote for the root-first restack: a list of suites that must pass and four
**negative controls**. A negative control breaks one guarantee on purpose and must turn a named test red; it
proves the test can see the thing it claims to guard. Each control below was run once, seen red, and restored.
The red lines are copied from those runs.

Run every suite from the repo root with `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/run.ts <suite>`.

## The suites (all in `tools/protocol/run.ts`)

| PR | suite(s) |
|---|---|
| #235 | `agent-mesh-collision` |
| #236 | `navgrid`, `navgrid-edge` |
| #239 | `places`, `places-scale` |
| #241 | `buildcheck`, `buildcheck-queue`, `buildcheck-route` |

Outside the gate, run on their own: `tools/walk-precision-test.ts` and #237/#242's water and heightmap tests.
`tools/support-lifecycle-test.ts` is **not** passing: it was red on this branch before the stack merged. One cause is
fixed (`68993f19`: its `geom()` read an undefined name); why it still fails hasn't been re-measured, so it stays out of
the gate.

## The four negative controls

**1. Bypass the support wait** (#235). The agent must not plan or walk before the placed world's colliders exist
(`mcpl/agent.ts` `supportReady()`, the barrier a walk waits on). Make the walk skip it — in `walkTo` (where the walk
waits on `supportReady`), replace `if (!this.supportPending.size) return now();` with `return now();` — then run `agent-mesh-collision`:

```
✗ a pen spawned just now, its shape still downloading: a walk into it waits for it, then is refused — never passes
  through its wall  ended at x 19.00, 1 delayed fetch(es), plan: null, authority: {"code":"solid","reason":"wall is in the way",…}
```

The rejoin row went red with it. Note: the first version of this control stayed green for two reasons — the row
walked outside the founded world's bounds, and the authority's own solids stopped the walk at the wall anyway — so the
row was changed to require that the walk's **plan** refuses it, not the authority (`211c8b67`).

**2. Remove the mesh governor** (#235). At most `MESH_CONCURRENCY` (3) models decode at once
(`mcpl/agent.ts`, `const MESH_CONCURRENCY = 3`). Raise it past the burst (`= 64`), then run `agent-mesh-collision`:

```
✗ 64 unique models replayed at once download a few at a time, and all decode  at most 64 at once (governor 64)
```

**3. Rescale the body-space place tolerance** (#239). A room's floor tolerance (`mcpl/places.ts`
`ROOM_FLOOR_EPS`, 0.1 m) is the walking body's, in metres — not multiplied by the thing's scale. Multiply it by the
scale (`ROOM_FLOOR_EPS * s`), then run `places-scale`:

```
✗ a 20× room's floor tolerance is the body's, in metres (0.1m), not 2m  {"above":2,"below":2}
```

Two more rows went red with it (3 passed, 3 failed).

**4. The worker reopens the mutable source** (#241). A queued check must run on exactly the bytes that were
queued, even if the file changes before the job starts (`server/buildcheck-queue.ts`: the job runs on the
content-addressed snapshot taken at enqueue). Make the worker read the source file instead of the snapshot
(`runWorker(file, s)` in place of `runWorker(snapshot, s)`), then run `buildcheck-queue`:

```
✗ a file replaced while its check is queued: the report is of the bytes that were asked about  {"ok":true,"r":{"seen":"BBBB"}}
✗ ...so the original's bytes, put back, get the original's report — never the replacement's  {"ok":true,"r":{"seen":"BBBB"}}
```

This control matters because a later fix bounded the queue's disk use: snapshots are now one per distinct model
(named by digest, shared by every scale, deleted with its last job). It was re-run after that change and still went
red as above; with the fix restored, `buildcheck-queue` is 18/0.
