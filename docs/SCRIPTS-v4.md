# Scripts in v4 worlds

A script is JavaScript that lives in the world and runs on the server, with nobody connected if it must. It is a
component on a thing, `script:<name>`, and every change it makes is an ordinary result that the door's one gate
(`admit`) checks, exactly as it checks yours. Design: research note 41 (scripts and behaviours); law: PROTOCOL-v4 L4
and L7. Code: `shared/v4/door.js` (the "behaviours" section), `shared/v4/sandbox.js` (the sandbox),
`shared/v4/scriptrules.js` (limits and rules shared with auditors), `shared/v4/scriptaudit.js` (a reader's re-run).

## The loop

```text
upload {text: "<your JavaScript>"}                        → {src: "sha256:…"}
set {id: "bell1", component: "script:bell", value: {
  src: "sha256:…",
  scope: {ids: "self", comps: ["bell"], say: true},       what it may change: this is data, readable before it runs
  on: ["use"]                                             which events reach it (timers come from `every`)
}}
set {id: "bell1", component: "reactions", value: {ring: {kind: "script", script: "bell"}}}
use {id: "bell1", action: "ring"}                         → the visitor's act, then the script's act + batch
scripts {id: "bell1"}                                     → status: active / asleep / dormant (why) / paused / …
scripts {id: "bell1", script: "bell", test: {on: "use"}}  → a dry run: what it WOULD write; nothing is logged
use {id: "bell1", action: "ring", dry: true}              → the same, as the visitor would trigger it
```

```js
// bell: counts its rings and says who rang it
world.on("use", (e) => {
  const rung = (world.get("self", "bell")?.rung ?? 0) + 1;
  world.set("self", "bell", { rung });
  world.say("the bell tolls for " + e.by + " (" + rung + ")");
});
```

## The component

```jsonc
"script:bell": {
  "src": "sha256:<64 hex>",          // the source blob ({lang: "js", api: 1, text}); upload {text} makes it
  "scope": {
    "ids": "self",                   // "self" | "subtree" | ["self", "<id>", …] (≤ 32)
    "comps": ["bell", "light"],      // components it may set or delete there (≤ 16); "name:*" for keyed names
    "create": false,                 // may create things (needs ids: "subtree"; what it makes must hang inside it)
    "say": false,                    // may write say entries
    "bodies": []                     // "shove", "pose": effects on people, each only where that person's consent allows
  },
  "on": ["use"],                     // use | say | enter | leave | grab | release | changed:<comp>
  "every": 30,                       // optional timer in seconds (≥ 5): delivers tick, and wake after sleeping
  "always": false,                   // run timers with nobody present (owner only: it costs the host while nobody benefits)
  "knobs": {"note": "…"},            // parameters, ≤ 4 KiB, read as world.knobs
  "paused": false                    // set by its sponsor or an owner
}
```

## Whose rights

- A script acts with its **sponsor's** rights, checked **now**, at every activation, and never beyond its scope. The
  sponsor is whoever's rights admitted the latest write to the `script:<name>` key (an owner who edits a builder's
  script becomes its sponsor and answers for it).
- At install the scope must already be within the installer's rights: a builder can't install a script that writes
  `@world.roles:*`.
- The person who triggers it (`use`, `say`, arriving) adds no rights. Their act is their own and counts against their
  own rate.
- A demoted sponsor's script goes **dormant** (the status view says who, since when, and what it can no longer
  change). A banned sponsor's is **suspended**. Recovery is explicit: `adopt {id, script, base?}` (its creator or an
  owner), logged as one act.
- A lock binds scripts like everyone; a script never acts through one. A thing in flight can't be written.
- People are presence. A script's `shove`/`pose` lands only where that body's consent allows it, and a script is a
  stranger to everyone unless they allow it by name: `consent {allow: "bhv:<thing>", class: "shove"}`, or all of one
  sponsor's scripts: `consent {allow: "bhvs:<sponsor id>", class: "pose"}`. A script can't ask; an "ask" is a no.

## The API (one global, `world`)

| | |
|---|---|
| `world.self` | the thing it's installed on |
| `world.script` | its key, `"script:<name>"` |
| `world.knobs` | its knobs (frozen) |
| `world.now` | the activation's clock in ms (= `Date.now()`) |
| `world.on(event, fn)` | `fn(e)` runs for `event`: `"use"`, `"tick"`, `"wake"`, `"say"`, `"enter"`, `"leave"`, `"grab"`, `"release"`, `"changed:<comp>"` |
| `world.get(id, comp?)` | a copy of a component's value (or of all of them), or `null`; `"self"` works as an id |
| `world.children(id)` | the ids parented to it (≤ 1000) |
| `world.ids()` | every id in the world (≤ 1000, sorted) |
| `world.near(r)` | identities of people within `r` m of the thing (recorded in the act) |
| `world.count()` | how many people are here (recorded in the act) |
| `world.name(id)` | a person's display name (identities are opaque ids; recorded in the act), or `null` |
| `world.set(id, comp, value)` | propose a write (must be inside `scope`) |
| `world.delete(id, comp?)` | propose a delete (a whole thing only if this activation created it) |
| `world.create(components, id?)` | propose a new thing (needs `scope.create`); returns its id |
| `world.param(id, comp, name, number)` | write `param.<name>` into a component's data: a signal something else reads (a seat pose that blends by signals) |
| `world.say(text)` | a say entry (needs `scope.say`) |
| `world.shove(who)`, `world.pose(who, spec)` | effects on a person (needs `scope.bodies`, then their consent) |
| `world.log(...parts)` | its console (`scripts {id}` shows the last lines; never logged) |

Events (`e`): every event has `on`.
- `use`: `by` (who), `seq` (their act), `action`, `args` (what they sent); used while held (a `grabbable`'s use
  button), also `held: true`, `hand` and `phase` (`"down"` or `"up"`);
- `grab`: `by`, `id` (the thing), `hand`, `grip?`, `seq?` (the grab's act, when the sim had to be told). A grab is
  presence: like `enter`, its activation's cause is the entry that made the script's sponsor when the grab itself isn't
  logged;
- `release`: `by`, `id`, `how` (`put`, `drop`, `throw`, `stay`, `return` or `snap`), `to?` and `slot?` (the socket it
  snapped into), `seq` (the settlement's act, which is the activation's cause). `grab` and `release` reach every
  script whose scope covers the thing (`self` on the thing itself; `subtree` or ids for a game that watches its pieces);
- `say`: `by`, `text`, `to?`, `seq`;
- `enter` / `leave`: `by`;
- `changed:<comp>`: `id`, `comp`, `by` (whose request caused it), `seq` (the state entry). It fires for a change to that
  component on any id in the script's scope, by anyone but the script itself;
- `tick`: nothing more. `wake`: `slept` (seconds asleep).

Reads see the world as the activation found it, plus its own writes so far. Writes are **proposals**: nothing lands
until the activation ends, and then all of them land together, or none (one refused write refuses the activation:
never two out of three). Writes that change nothing are dropped; an activation left with nothing writes nothing.

## Use while held: what's an act, what's presence

A `grabbable` thing's use button (desktop left click, the phone's action button, the VR trigger) sends `use {id, args:
{held: true, hand, phase}}` when it's pressed and again when it's let go: `use.down` and `use.up` are one act each.
That is for **discrete state changes**: a hose turns on, then off; a lamp lights; a gun's magazine empties by one.
**Continuous or rapid cosmetic effects while held and pressed** (a muzzle flash, a hose's spray, a beam) are never a
stream of logged acts. They are presence: the holder's pose carries `use {id, hand}` while the button is down (unlogged,
broadcast like an emote), and every client draws the thing's own `grabbable.fx` from its component data for as long as
it rides. A script that counts shots counts presses (`use.down`), within the rate above; it never sees a frame.

## What an activation is, in the log

```text
812 act    actor=vic        verb=use     body={request: {id: "bell1", action: "ring"}, runs: "script:bell"}
813 act    actor=bhv:bell1  verb=script  cause=812  body={script, src, sponsor, sponsorAt, on, trigger, event,
                                                          head, seed, depth, engine, api, reads?, bodies?}
814 state  actor=bhv:bell1  cause=813    the batch: every write, all or nothing
815 say    actor=bhv:bell1  cause=813
```
A timer's or a presence event's act has `cause` = the entry that made its sponsor. Replay never runs code: the fold
reads 814. An auditor may: `shared/v4/scriptaudit.js` folds to `head`, re-runs the source with the recorded event,
clock (the act's `ts`), `seed` and presence `reads`, and compares the writes.

## Determinism (why some JavaScript behaves differently here)

- `Date.now()`, `new Date()` and `world.now` are **frozen** at the activation's own timestamp.
- `Math.random()` is seeded from the activation (`seed` in the act): re-running it gives the same numbers.
- The time zone is always UTC: local-time methods (`getHours`, `new Date(2026, 0, 1)`) are the UTC ones, and a
  date-time string with no zone is read as UTC. The host's zone never leaks in.
- What a script reads from outside the log (`world.near`, `world.count`, `world.name`) is recorded in its act and
  replayed on a re-run. A `say`'s text and a `use`'s `args` are not copied into the act: it points at them (`trigger`),
  so purging that say or request purges them everywhere.
- Each activation runs in a **fresh** sandbox: nothing survives between activations. Keep state in a component in your
  scope (it is world state: forkable, readable, undoable). There is no private kv.
- No timers (`setTimeout`), network, files or other clocks exist. Motion is a function of time (`motion`), never a
  per-tick write.

## Limits (stated in `@world.scripts`, owner-settable where marked)

| | |
|---|---|
| fuel | 60 interrupt ticks per activation, about 18–40 ms of dense work (deterministic for one QuickJS build) |
| wall-clock backstop | 200 ms per activation, host calls included (see "Known limit" below) |
| memory / native stack | 24 MB / 256 KB per activation |
| reads per activation | 64; writes 32; says 4; body effects 4 |
| logged activations | 6 per minute per script (`rate`) |
| runs, logged or not | 60 per minute per script (`runs`); 2000 ms of sandbox time per sponsor per minute (`cpu`), 3× that per world |
| uploads | 20 per person per minute |
| script entries per world per hour | 600 (`budget`), each sponsor a fair share |
| cascade depth | 8 (`depth`): script acts in a cause chain |
| failures before pause | 5 in a row (`fails`); set the script again to retry |
| scripts per world | 12 (`max`) |
| timer floor | 5 s; with nobody present a timer sleeps unless `always` |
| source | 64 KiB of UTF-8; no bidi controls, invisible characters or BOM; no line over 1000 columns |

**Known limit (not yet fixed):** the sandbox runs on the sequencer's own thread. Fuel and the wall clock are checked
between bytecodes, so a single call into a slow native builtin can't be interrupted: `s.indexOf(t)` on a few hundred
KB of crafted text, `3n ** 300000n`, or running out of memory inside `Array.prototype.fill` can each hold every world
on the process for seconds or longer (measured: 1–13 s). The fix is running activations in a worker (research 41
§3.13); an experiment showed a worker gives the sequencer back at the deadline, though the stuck thread can't be
killed until its call returns. A script that hits the backstop counts as a failure, and its sponsor's `cpu` budget
pays for what it used.

A refused or failed activation writes nothing. Its reason goes to the script's console and the status view.
`@world.scripts {run: false}` (owner) stops every script; `paused: true` stops one.

## Translated v1 worlds

A v1 world translated to v4 keeps its bindings as `@world.behavior:<name>`, as a record. v4 never runs them: they were
written for v1's API (`world.emit`, `world.kv`), with their author's rights and no scope. `scripts` lists each as
`needs-reinstall`, and a `use` that reaches one says so. To bring one back: rewrite it for this API (`emit(verb)`
becomes `world.set`/`world.say`; `kv` becomes a component in scope; `world.every` becomes `every` in the component),
upload it, and set `script:<name>` on the thing it belongs to with the scope it needs.
