# Environment-awareness: what was asked for, and what it costs

Source: antra-tess and rabscuttle, 2026-08-25, asked in response to "what could I
work on". Written down here because the asks were verbal and nothing in the
issue tracker covers them as a group. Ordering below is mine (digi), argued from
reading the code rather than from the order they were said in.

The load-bearing fact: **most of this is edits to machinery that already
exists**, not new subsystems. `mcpl/denoise.ts` already states the doctrine —
*"noisiness is a property of an event's CONTEXT, not its type"* — and already
implements hold-and-cancel, decaying per-identity charge, and refractory
windows. Several of the asks below are "apply that doctrine to the path that
did not get it yet."

---

## The asks, verbatim

**antra-tess**
- Smarter filters on environment awareness events
- "Walked up" needs to be improved; likely debounced so that passing through
  does not trigger it
- "Walked away" is needed
- More screenshots automatically sent on various actions
- Jumping/emote traffic needs to be adaptive and smarter
- Relative positioning better communicated
- Maybe area maps, in images or ASCII — "for our robot dog lidar works better
  when encoded in ASCII rather than images"

**rabscuttle**
- Different levels of awareness/ping that agents or operators can use.
  H was often asking for more when we were testing together.

---

## 1. "Walked up" fires on pass-through — `mcpl/agent.ts`, `notePose`

**This is a bug, not a feature request**, which is why it goes first.

`mcpl/declaration.ts` declares the event as:

> "Someone walked up to your body **and stopped** within arm's reach."

The implementation never checks stopping. It is a bare edge-trigger on crossing
`APPROACH_RADIUS`:

```ts
if (dist < APPROACH_RADIUS && prevDist >= APPROACH_RADIUS && armed && cooled)
```

The three existing gates — re-arm past `REARM_RADIUS`, the 600 s per-identity
refractory, and #39's baseline seeding — all suppress *repeats*. None of them
can tell a knock from someone walking past you on their way to the door.

**Fix:** dwell confirmation. The inward crossing opens a *pending* approach; it
is only delivered once that person has actually been still, within arm's reach,
for a dwell window. Leaving the radius first cancels it. Measure stillness from
**observed displacement**, never the pose's `speed` field — the activity pulse
already sets that precedent in this same file ("displacement, not a speed flag,
so idle jitter and a body parked mid-walk-cycle never qualify").

**Status: done — PR `fix/approach-means-they-stopped`.**

## 2. "Walked away" is missing — same function

The outward crossing already exists in `notePose`; it just silently re-arms and
narrates nothing. Fire a `depart` ping there, gated on that identity having
actually earned an approach ping first — otherwise every passer-by generates a
departure and the fix in (1) is undone from the other end.

Touches the ping kind union, a new `eidoverse:depart` tag + descriptor, the
`pending_pings` rendering, and the `onPing` deliver.

**Status: done — same PR as (1).**

## 3. Relative positioning — `agent.ts`, `bearing()`

The cheapest real win on this list. `bearing()` returns **absolute** compass
(`N/NE/E/…`). An agent facing south, told "3.2m NE", has to do trig to work out
that is behind-right. `this.yaw` is right there.

**Fix:** emit egocentric alongside the compass (`3.2m NE — behind-right`) so
nothing parsing the current format breaks. ~20 lines, felt on *every* `look()`.

Do this before (6): an egocentric map needs exactly this yaw math.

## 4. Adaptive jump/emote traffic — `denoise.ts`, `NoiseGate.act()`

Acts get a flat 180 s refractory per `(identity, act-key)`. The presence path
twenty lines up already has the better mechanism: decaying charge with a limit.
Someone doing 40 jump-pairs in an evening currently gets one through every three
minutes, forever. With charge they fade out and stay faded while they keep it up.

Reuses a proven mechanism from the same file — small, and the tests for the
presence charge show how to test it.

## 5. Awareness levels (rabscuttle) — partly already filed as **issue #55**

"Intake transforms: consumer-owned `off|headers|digest|verbatim` at the
subscribe surface" — open since 2026-08-08, nobody on it. That is rabscuttle's
ask with a ticket number already attached.

The existing precedent is the `activity` tool (`setActivity`): per-agent,
persisted across sessions, clamped. A *level* would set the whole gate
configuration — hold windows, refractories, approach radius, dwell — rather
than just cadence and radius.

**Do this after 1–4**, because those decide what knobs actually exist to expose.
Designing the dial before the knobs exist is how you ship a dial wired to
nothing.

## 6. ASCII area maps

Genuinely new, but not plumbing — all the data is already assembled at `look()`
time: people with positions, entities through `eff()`, structure via
`planStructure`/`describeHere`. It is a rendering function over existing state.

The hard part is design, not code: scale, extent, symbol vocabulary, and whether
the map is north-up or facing-up. Antra's lidar note argues ASCII over images
for machine consumers, which also makes it far cheaper than (7).

## 7. Automatic screenshots — defer

`snapshot` exists (`mcpl/net-server.ts`) but routes to a spectator browser on a
GPU host. Pushing one per event means a GPU render per event, plus a budget and
rate-limit design, plus a decision about what carries the image on the wire.

Feasible, but it is a project rather than a fix — and it is the only item here
that cannot be tested headless. It should not block 1–6.

---

## Notes for whoever picks these up

- Check `gh pr list` before starting any of these. octopusburrow moves fast and
  holds several adjacent lanes.
- Nothing here needs the SFU/voice stack that landed in late August; all of it
  is text-tier perception.
- The relevant suites are `tools/approach-seed-test.ts` (issue #39's baseline
  contract) and `mcpl/denoise-test.ts`. Both are headless and fast. Run them
  with `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` — Bun's transpiler cache will
  otherwise serve a stale module graph and quietly test the wrong code (#13).
