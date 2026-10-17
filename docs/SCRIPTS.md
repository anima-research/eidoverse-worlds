# Scripts in worlds

A script is JavaScript that lives in the world and runs on the server, with nobody connected if it must. It is a
component on a thing, `script:<name>`, and every change it makes is an ordinary result that the authority's one gate
(`admit`) checks, exactly as it checks yours. Design: research note 41 (scripts and behaviours); law: PROTOCOL L4
and L7. Code: `shared/protocol/authority.js` (the "behaviours" section), `shared/protocol/sandbox.js` (the sandbox),
`shared/protocol/scriptrules.js` (limits and rules shared with auditors), `shared/protocol/scriptaudit.js` (a reader's re-run).

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

In the editor (desktop), the same loop is **Inspector › Scripts › new script…** on the selected thing: a name, what
starts it (someone using it, or every N seconds), what it may change, whether it may speak, and the source (a template
that runs as it stands). Create sends `upload`, then ONE batch: `script:<name>` and, for a use script, its reaction
(`use`, or the script's own name when the thing's `use` already does something else). One act, so Ctrl+Z takes it off.
Refusals show on the card in these same words. (shared/protocol/newscript.js plans it; client/lib/scriptnew.js is the card.)

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
- **Pausing is a permission, not an edit.** `set {id, component: "script:<name>", value: {paused: true}, merge: true}`
  (or the "paused" check on the script's card in the Inspector) stops it, and `paused: false` resumes it. Its creator
  or an owner may flip it; it needs nothing of the script (no source, no scope: it works even if the source is gone),
  and it adopts nothing: the sponsor stays whoever last changed something else. `scripts` says who paused it and when,
  read from the log (nothing is stored in the value).
- A lock binds scripts like everyone; a script never acts through one. A thing in flight can't be written.
- People are presence. A script's `shove`/`pose` lands only where that body's consent allows it, and a script is a
  stranger to everyone unless they allow it by name: `consent {allow: "script:<thing>", class: "shove"}`, or all of one
  sponsor's scripts: `consent {allow: "scripts-by:<sponsor id>", class: "pose"}`. A script can't ask; an "ask" is a no.

## The API (one global, `world`)

A script names things by **id**, never by label: a label is a name people change and two things may share; an id is
minted once and never changes. (An id from `world.ids()`, `world.children()`, `world.self` or `world.create()` is
always the right one to keep.)

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
| `world.create(components)` | propose a new thing (needs `scope.create`); returns the id it was minted (opaque: a script never chooses an id, and an id never carries a word; API 2) |
| `world.param(id, name, number)` | write `params.<name>` on a thing (merged into what's there; needs `params` in the scope's comps): a signal something else reads (a seat pose blends by `param.<name>`) |
| `world.say(text)` | a say entry (needs `scope.say`) |
| `world.shove(who)`, `world.pose(who, spec)` | effects on a person (needs `scope.bodies`, then their consent) |
| `console.log(...parts)` | its console (`scripts {id}` shows the last lines; never logged). `world.log` is the old spelling, kept for one version |

Events (`e`): every event has `on`.
- `use`: `by` (who), `seq` (their act), `action`, `args` (what they sent); used while held (a `grabbable`'s use
  button), also `held: true`, `hand` and `phase` (`"down"` or `"up"`);
- `grab`: `by`, `id` (the thing), `hand`, `grip?`, `seq?` (the grab's act, when the sim had to be told). A grab is
  presence: like `enter`, its activation's cause is the entry that made the script's sponsor when the grab itself isn't
  logged;
- `release`: `by`, `id`, `how` (`put`, `drop`, `throw`, `stay`, `return` or `snap`), `to?` and `socket?` (the socket it
  snapped into), `seq` (the settlement's act, which is the activation's cause). `grab` and `release` reach every
  script whose scope covers the thing (`self` on the thing itself; `subtree` or ids for a game that watches its pieces);
- `say`: `by`, `text`, `to?`, `seq`;
- `enter` / `leave`: `by`;
- `changed:<comp>`: `id`, `comp`, `by` (whose request caused it), `seq` (the change entry). It fires for a change to that
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
813 act    actor=script:bell1  verb=script  cause=812  body={script, src, sponsor, sponsorAt, on, trigger, event,
                                                         head, seed, depth, engine, api, reads?, bodies?}
814 change actor=script:bell1  cause=813    the batch: every write, all or nothing
815 say    actor=script:bell1  cause=813
```
A timer's or a presence event's act has `cause` = the entry that made its sponsor. Replay never runs code: the fold
reads 814. An auditor may: `shared/protocol/scriptaudit.js` folds to `head`, re-runs the source with the recorded event,
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

## Limits (the server's; an owner may set the ones marked in `@world.script-settings`)

`script-settings` holds `{run?, max?, budget?, cpu?}`. An absent field is this server's current default (`schema` reports
it, and it may change); an owner sets `max` up to the server's ceiling and may only tighten `budget` and `cpu`. Who may
install a script is each role's `scripts` permission (`role-defs`). Everything else here is the server's configuration.

| | |
|---|---|
| fuel | 60 interrupt ticks per activation, about 18–40 ms of dense work (deterministic for one QuickJS build) |
| wall-clock backstop | 300 ms per activation, host calls included; at 500 ms the authority kills the activation's sandbox process |
| memory / native stack | 24 MB / 256 KB per activation |
| reads per activation | 64; writes 32; says 4; body effects 4 |
| logged activations | 6 per minute per script (server) |
| process script time | 500 ms per rolling second across every world on the authority (host-settable); past it, `busy` |
| waiting for a sandbox process | at most 300 ms (after kills), then `unavailable` |
| runs, logged or not | 60 per minute per script (server); 2000 ms of sandbox time per sponsor per minute (`cpu`, owner: at most the server's), 3× that per world |
| uploads | 20 per person per minute |
| script entries per world per hour | 600 (`budget`, owner: at most the server's), each sponsor a fair share |
| cascade depth | 8 (server): script acts in a cause chain |
| failures before pause | 5 in a row (server); set the script again to retry |
| scripts per world | 12 (`max`, owner: up to the server's ceiling, 64) |
| timer floor | 5 s; with nobody present a timer sleeps unless `always` |
| source | 64 KiB of UTF-8; no bidi controls, invisible characters or BOM; no line over 1000 columns |

**Isolation.** A script's code runs in a separate sandbox process; the authority keeps everything the script can read or
write on its own side and answers each `world.*` call down a pipe. Fuel and the 300 ms backstop stop runaway bytecode;
a call into a slow native builtin (`indexOf` on crafted text, a huge BigInt, running out of memory inside `fill`)
can't be interrupted, so at 500 ms the authority kills the process and the activation fails with `time` (a spare process
takes the next one). The authority's thread is never held longer than that by one activation, and script time across every
world in the process is capped at 500 ms per second (refused as `busy` past it), so one request that wakes many
scripts can't add their deadlines up. A killed run counts as a failure and against its sponsor's `cpu`.

A refused or failed activation writes nothing. Its reason goes to the script's console and the status view.
`@world.script-settings {run: false}` (owner) stops every script; `paused: true` stops one.

## Translated v1 worlds

A translated v1 world keeps its bindings as `@world.imported-behavior:<name>`, as a record. They never run: they were
written for v1's API (`world.emit`, `world.kv`), with their author's rights and no scope. `scripts` lists each as
`needs-reinstall`, and a `use` that reaches one says so. To bring one back: rewrite it for this API (`emit(verb)`
becomes `world.set`/`world.say`; `kv` becomes a component in scope; `world.every` becomes `every` in the component),
upload it, and set `script:<name>` on the thing it belongs to with the scope it needs.
