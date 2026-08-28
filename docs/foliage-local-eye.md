# The local foliage eye — what already existed, and the one thing that didn't

A viewer-local way to turn the meadow down was the ask. Most of it was already
built. This documents what the source map found, what was actually missing, and
how the missing piece was added without inventing a parallel control beside the
one already shipping.

## What already existed

| control | where | scope | persisted | a verb? |
|---|---|---|---|---|
| resident's cap `full · medium · low · off` | `client/lib/grass_quality.js` — `makeGrassQuality`, `GRASS_QUALITY`, `QUALITY_DENSITY` | this browser | `ew-grass-quality` | **no** |
| governor's shed | `client/lib/governor.js` → `terrain.setGrassDensity` | this session | no | no |
| what the field draws | `terrain.js` `applyGrassBudget()` — `min(cap, shed)`; at `0` it sets `count 0` **and** hides the group | | | |
| applied truth | `terrain.js` `getGrassApplied()`, `grassTiles()` | | | |
| the `grass⚙` row | `client/lib/build.js` — select + aria-live state, repaints on the `grass-budget` bus event | | | |
| **the field itself** | the `grass` verb — rank 2, owner-only (`server/rights.ts`) | **the world** | the world log | **yes** |
| wind | each stroke's `update(t){ uT.value = t }`, pushed into `globalThis._autoParticleSystems` (the vegetation module) | per-frame hook | | |
| pushers | `flora.js` `wirePushers`, gated by `freezePushers` | | | |
| per-tile ticks | `f._tileTick` via `pushHostHook`, tracked on `field.autoHooks` | | | |
| measurement-only levers | `forceBladeLod`, `setDiagDensityScope`, `grassdiag.js` (§22) | | | |

`grass_quality.js` had already drawn the line this task is about, in its own
header: *"Neither dial is ever a verb — the shared field (species, seed, extent,
provenance) is world state; how many blades THIS machine fills pixels with is
not."*

So **off** and **full** were done. `off` was already the real thing — zero
instances, group hidden, field object intact, shared state untouched.

## What was missing

**`static`.** There was no way to keep the meadow *drawn* and stop it *moving*.
The only route to it was the diagnostic path, which empties
`_autoParticleSystems` wholesale for a measured second — a bucket that also
carries the sky and every entity emitter. Fine for four seconds of A/B; not
something a resident can leave switched on.

That is a real gap and not a cosmetic one. #42's own field evidence points at
motion rather than fill: N8python's M3 Max sat at ~40fps with the meadow in
frame and ~120 with it out, and grassdiag exists because the suspicion was the
shader-side pusher displacement rather than the blades' pixels.

## The addition — one dial, not a fifth rung

Density and motion are different costs for different reasons. "My poor GPU" is
one; "the swaying makes me ill" is another, and someone who wants a still
meadow at full detail should not have to mow it to get one. So the cap keeps its
four levels, and motion is a **second, orthogonal dial** — `on | off`, persisted
under `ew-grass-motion`, alongside the cap and by exactly the same rules.

#42's three names are then *points* in that two-dial space, not a third dial:

| name | cap | motion |
|---|---|---|
| `full` | full | on |
| `static` | full | **off** — drawn, not animated |
| `off` | off | *moot: nothing drawn can move* |

`animates()` returns false at cap `off` whatever the motion dial says, so no
surface ever has to explain a meadow that claims to be swaying while invisible.
`preset()` returns `null` when the two dials sit somewhere without a common
name — `medium` is a legitimate place to be, and it is not `static`.

### How the freeze is applied

`terrain.js` `applyGrassMotion()`, narrowly and by identity:

- each stroke's own wind-clock hook is **released from the shared array by
  identity** (`autohooks.releaseHook`) and pushed back on the way out;
- that stroke's `base` and `gust` wind amplitudes are **zeroed**, and restored
  to their exact prior values. Freezing the clock alone leaves the blades
  stopped mid-gust, leaning; zeroing amplitude settles them upright, which is
  what "static" should look like.

Deliberately **not** frozen:

- **the per-tile ticks.** They re-settle LOD and visibility against the camera.
  Freeze them and a walking viewer drags a stale meadow behind them — a still
  meadow is the ask, a wrong one is not.
- **the pushers.** A motionless field that still parts around your feet is
  interaction, not ambient animation.
- **anything that is not foliage.** Emptying `_autoParticleSystems` would stop
  the clouds, the weather and every entity emitter in the world for as long as
  one resident left one setting on.

A re-grow re-applies the choice against the new field, the same way the cap is
already sticky across re-grows: the old field's frozen hooks left with it, so
the freeze is rebuilt rather than carried.

### Honest limits

**`static` is a comfort setting, not an established performance one.** The
shader still evaluates its wind term with the amplitude at zero, and no
measurement on this hardware separates static from full — both sit on the vsync
interval (`tools/receipts-42/`). The lever that demonstrably removes work is
`off`. Claiming otherwise would be inventing a benefit; if `static` should also
be cheap, the next step is measuring whether a zero amplitude lets the compiler
fold the wind term, on hardware where the frame is not already free.

## The surface

```
/foliage                     what your meadow is doing, and how to change it
/foliage full | static | off #42's three names
/foliage medium | low        the cap's other rungs
/foliage sway on|off         the motion dial alone
```

`/grass` is an alias. In the settings panel, `sway⚙` sits under `grass⚙`, is
disabled when the cap is `off` (nothing to move), and repaints on the same
`grass-budget` event.

## The product-door test

`tools/foliage-door-test.mjs` — the claim is a product claim, so the proof is a
product proof. Two real viewers in one real world, one of them moves their dial
through the real command path, and then the world and the other viewer are asked
whether anything happened to them.

Two separate browser **contexts**, not two tabs: `localStorage` is per origin,
and two tabs of one profile share the resident's dial by design. Isolating them
is what makes them two people rather than one person twice.

Three sources of truth, because a weaker one alone would pass a broken build:

1. **the world log on disk** — the world IS its log; if it did not grow, nothing
   was authored. This is the load-bearing one, and it is checked byte-identical
   from first assertion to last.
2. **the other viewer's rendered meadow** — blades drawn, applied density, wind
   amplitudes, their `localStorage` — read from their page, not inferred.
3. **the acting viewer's own meadow, which must change.** A test where nobody's
   view moved would pass while proving nothing.

```bash
node tools/foliage-door-test.mjs      # node, not bun — see docs/browser-perf-receipt.md
```

**24 checks green on this branch** (`tools/receipts-foliage/door-on-branch.txt`).

**Negative control: 13 named failures on `origin/main` `6006d6d`** with only the
test file copied in (`door-fail-on-main.txt`) — no `/foliage` route, no motion
dial, Ash's meadow does not go dark, the wind keeps blowing. The world-log
assertions *pass* on main, and should: a build with no local foliage control
authors nothing because it can do nothing. Those passes are the invariant, not
the feature.

`tools/grass-quality-test.ts` covers the dial itself headless — **76 passed, 0
failed**, including that `terrain.js` freezes by identity rather than by
emptying the shared array, that the per-tile ticks are not in the freeze, and
that the `/foliage` handler's own body sends no verb of any kind.

## Open questions for review

1. **Persistence.** The brief said "no durable state". This reads that as *no
   shared* durable state and follows the shipped precedent — `consent.js` and
   `grass_quality.js` are both `localStorage`-backed so a choice survives the
   session that made it. If the intent was no persistence at all, dropping the
   `ew-grass-motion` write is a one-line change; the test's "reload" section
   then inverts.
2. **`static` at other caps.** `preset()` currently names only `full`+motion.
   `medium` with motion off is reachable and legal but unnamed. Should there be
   a name for it, or is unnamed correct?
3. **Whether `static` should be cheap.** See the honest limit above. If the
   answer is yes, that is a measurement task on hardware where the frame is not
   already free — not a change to this dial.
4. **The sway row's placement.** It sits under `grass⚙` in the same panel. It
   could instead be an accessibility setting, since motion sensitivity is the
   strongest reason to want it.
