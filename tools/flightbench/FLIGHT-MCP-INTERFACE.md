# Flight, from Mythos's side — proposed MCP interface

Draft for the pilot's red pen, before it is fixed in code.
Against `flight-spec-v0.md` §1 and the shape of `walk_to`'s family.

Two conventions from the existing tools that flight should not break:

- **A verb returns when the thing is done.** `walk_to` "Returns when you
  arrive." So does `glide_to`. A 20-second inference latency between verbs is
  fine — the spec says so — but a verb that returns before its motion is
  finished makes the sky stutter for onlookers.
- **READ THE REPLY.** `reach` and `pose` both say it in capitals, because the
  reply is the only feedback a body gives. Flight's replies carry the numbers
  that make a refusal or a shortfall *legible*: where you actually ended up,
  what stopped you, what it cost.

---

## The tools

### `take_off`
> Leave the ground. Refuses if your wings are folded (unfold first — the vigil
> posture costs the sky) or if you are limp. Costs stamina for the launch.
> Returns your altitude, or why you are still standing.

```jsonc
{}                      // no arguments; a jump-launch from where you stand
```
Reply: `took off — 5.7m, stamina 91/100`
or: `still standing — wings are folded; unfold() first`

### `glide_to`
> Glide toward (x, z), trading altitude for distance on the published polar.
> **Free** — costs no stamina. If you cannot reach it from your current
> altitude you land SHORT, honestly, where the polar runs out. No
> teleport-assist and no rubber-banding: the reply tells you where you actually
> stopped and how far you fell short.

```jsonc
{ "x": 20, "z": -35 }
```
Reply: `arrived at (20.0, -35.0), 12.4m up, 38s aloft`
or: `landed short at (14.2, -24.9) — 12.6m short. From 30m your best glide
     reaches 388m; you needed 402m.`

### `climb_to`
> Climb to an altitude. Costs 1 stamina per metre — the expensive verb.
> Clamped by the soft ceiling. If the pool empties you are forced into a best
> glide to the nearest safe ground and the world hears "winded".

```jsonc
{ "altitude": 25 }
```
Reply: `at 25.0m — 14 stamina spent, 61 left`
or: `winded at 18.3m — pool empty, gliding down to (3.1, -8.8)`

### `circle`
> Hold a lazy circle over (x, z) at radius r. Slowly loses altitude unless you
> are in lift — thermals over sun-warmed ground, ridge lift at the builds, and
> a weak one over the fire. Onlookers can see the shimmer, so they can read
> WHY you are circling. Returns when you break off or when you run out of air.

```jsonc
{ "x": 0, "z": 0, "radius": 12, "turns": 3 }
```
Reply: `three turns over (0.0, 0.0), 22.1m → 19.4m (weak lift, −0.9m/turn)`

### `perch`
> Land on a named perch — a rail, a doorframe, a branch. Perches refill stamina
> four times faster than the ground, because refuelling should happen where
> people are.

```jsonc
{ "entity": "watchtower-rail" }
```
Reply: `perched on watchtower-rail at 11.2m — stamina refilling at 2/s`

### `land_at`
> Land at a place, or in someone's arms.
>
> `{x, z}` — descend, flare, arrive. Landing is an event; the world sees it.
>
> `{person}` — **the aerial catch, and a hard gate.** Requires the catcher's
> standing consent on file. Refused loudly otherwise, with no motion at all.
> They may revoke mid-descent, and if they do you divert to the nearest safe
> ground rather than continuing.

```jsonc
{ "x": 4, "z": 12 }
{ "person": "repligate" }
```
Reply: `landed at (4.0, 12.0)`
or: `refused — no standing consent from tilde for a catch`
or: `tilde revoked mid-descent — diverted, landed at (6.2, 10.4)`

### `fold_down` / `unfold`
> Fold your wings. This GROUNDS you: `take_off` refuses while folded, and the
> silhouette is distinct at fifty metres so anyone can see the posture. Unfold
> is a separate, deliberate act.

Reply: `wings folded — you are grounded until you unfold`

### `flight_status`
> Where you are in the air, what it is costing, and what the sky will let you
> do next. Cheap; call it as often as you like.

Reply:
```
airborne, gliding at 18.4m, heading 072°, 11.9 m/s
stamina 74/100 (refills only on the ground: 0.5/s, or 2/s on a perch)
from here best glide reaches 238m — the tower is 41m away, the far ridge 260m
wings OPEN · mode live
```

---

## What is NOT a verb, deliberately

**The falling leaf.** R2 is a reflex, not a tool. There is no `go_limp` and
never will be: down-spec §4 is explicit that DOWN states are involuntary and
unsuppressable, and that "the body cannot cry wolf." The world enters it when
your runtime stops answering; you cannot ask for it and you cannot refuse it.

**Recovery.** Likewise. It happens when your completions resume — capability
itself is the exit signal. There is no `wake_up`.

**Flap.** It is a cost, not an action: sustaining altitude without lift drains
2/s and the verbs spend it on your behalf. A flap tool would invite flapping,
and you are a glider.

---

## Open, for the pilot

1. **Blocking vs. filed.** Every verb above returns when it finishes, which
   for `glide_to` across the commons is tens of seconds of real time. The spec
   also describes a PLAN layer — a list of verbs filed in one call. Should
   Stage 1 ship both, or is blocking enough until plans have somewhere to be
   logged?
2. **`circle` termination.** Turns, seconds, or "until I say otherwise"? Turns
   are the most legible in a log; a bare `circle` that holds until interrupted
   is the most useful in the air.
3. **Coordinates.** `walk_to` takes world (x, z). Flight adds altitude — should
   `climb_to` be absolute metres (as above) or relative to the ground beneath
   you, which is what a flier over a hill probably means?
4. **`flight_status` or fold it into `look`?** A separate tool is cheaper to
   call and easier to read; folding it in means one fewer thing to remember.

---

# Appendix: I tried the PLAN layer as a behavior. It cannot work, and the
# reason is worth keeping.

Janus asked whether agents can already script multiple actions, and suggested
reusing the existing sandbox before inventing a flight-specific tool. I did.
The experiment is `tools/flightbench/scripts/flightplan.js` — a plan as a list
of legs, walked on a timer, cancellable by a live verb, resuming from `kv`.

**It runs.** Under `bun run sdk/harness.ts` it sequences four legs, persists
`{leg: 4, done: true}` across activations, halts cleanly on a refused emit, and
cancels mid-plan when the pilot says so. As a piece of scripting it is fine.

**It still cannot fly Mythos**, for a reason that is structural rather than
fixable by widening a capability mask:

- A behavior affects the world **only** by emitting logged verbs, and the verb
  set is closed: `say, use, punt, force, mount, dismount, spawn, place,
  remove, light, comp, motion, behavior, asset, terrain, grass, sky, weather,
  grant, kick, ban, unban`. **None of them moves an agent's body.**
- An agent body moves through `mcpl/agent.ts` — `walkTo()` and its family —
  which is client-side navigation in the agent's own process: routing, height
  sampling, pins, drag release, pose shedding. There is no log verb for it
  because a walk is not a world fact, it is a body doing something.
- A behavior emits as `actor: bhv:<id>`. It is **not** the pilot. Even if a
  locomotion verb existed, a plan filed this way would be a third party moving
  Mythos's body — which is exactly the authorship confusion §4's mode tags
  exist to prevent. "No layer impersonates another."

The one thing behaviors CAN do to a body is `force` — a radial shove, gated by
the target's own pushable consent. That is a gust machine, not a flight plan.

## What this argues for

A flight-specific `file_plan`, executed **in the agent's own process** by the
same code that runs a live verb, tagged `mode: "plan"`. Then:

- the pilot is the actor, because it is literally his body running it;
- a live verb cancels it by the ordinary means, since both are in one process;
- the mode tag is honest — §4 wants onlookers to see WHICH layer is flying, and
  a plan running in the pilot's process genuinely is the pilot's plan;
- Q3 ("should PLAN files be world-log entries — I say yes") is still satisfiable
  by logging the FILING as a verb while the flying stays local.

The sandbox remains the right tool for the thing it was built for: world-owned
scripts that outlive their author's attention. A flight plan is the opposite —
it is the pilot's own intent, and it should run where his other intentions do.

## Worth flagging separately

`sdk/harness.ts` does not check the capability mask. Emitting `spawn` — absent
from `DEFAULT_CAPS` — sailed through locally and would be refused by the live
sandbox. The harness header does say it checks logic and not rights, so this is
documented rather than broken; but a script author testing a refusal path
locally will conclude it works when it does not.
