// What a builder can discover: models (with real bounds and support surfaces) and component types (with their
// defaults, which the door writes out in full, R7). Models are local-space boxes with the origin at the base centre,
// front = +Z.

export const MODELS = {
  table:       { size: [1.2, 0.75, 0.8],  surfaces: [{ y: 0.75 }], label: "a wooden table" },
  chair:       { size: [0.5, 0.9, 0.5],   surfaces: [{ y: 0.45, inset: 0.05 }], sockets: { seat: { pos: [0, 0.45, 0], pose: "sitchair" } }, label: "a chair" },
  "table-lamp":{ size: [0.3, 0.5, 0.3],   surfaces: [], label: "a small table lamp" },
  "floor-lamp":{ size: [0.4, 1.7, 0.4], solids: [[[-0.2,0,-0.2],[0.2,0.05,0.2]], [[-0.03,0,-0.03],[0.03,1.45,0.03]], [[-0.2,1.45,-0.2],[0.2,1.7,0.2]]],   surfaces: [], label: "a standing lamp" },
  crate:       { size: [0.6, 0.6, 0.6],   surfaces: [{ y: 0.6 }], label: "a wooden crate" },
  wall:        { size: [4, 2.6, 0.15],    surfaces: [], label: "a plaster wall section" },
  door:        { size: [0.9, 2.1, 0.06],  surfaces: [], label: "a plank door (hinge on its left edge)" },
  shelf:       { size: [1.0, 1.8, 0.35], solids: [[[-0.5,0,-0.175],[-0.47,1.8,0.175]], [[0.47,0,-0.175],[0.5,1.8,0.175]], [[-0.5,0,-0.175],[0.5,1.8,-0.155]], [[-0.47,0,-0.155],[0.47,0.03,0.175]], [[-0.47,0.37,-0.155],[0.47,0.4,0.175]], [[-0.47,0.77,-0.155],[0.47,0.8,0.175]], [[-0.47,1.17,-0.155],[0.47,1.2,0.175]], [[-0.47,1.57,-0.155],[0.47,1.6,0.175]], [[-0.47,1.77,-0.155],[0.47,1.8,0.175]]],  surfaces: [{ y: 0.4, inset: 0.03 }, { y: 0.8, inset: 0.03 }, { y: 1.2, inset: 0.03 }, { y: 1.6, inset: 0.03 }], label: "a bookshelf with four shelves" },
  book:        { size: [0.04, 0.22, 0.15], surfaces: [], label: "a book (spine faces +Z)" },
  "swing-frame": { size: [2.0, 2.2, 1.2], solids: [[[-1,0,-0.6],[-0.9,2.2,0.6]], [[0.9,0,-0.6],[1,2.2,0.6]], [[-1,2.1,-0.06],[1,2.2,0.06]]], surfaces: [], label: "an A-frame for a swing" },
  "swing-seat":  { size: [0.6, 0.05, 0.3], surfaces: [{ y: 0.05 }], sockets: { seat: { pos: [0, 0.05, 0], pose: "sit" } }, label: "a plank swing seat on ropes" },
  bed:         { size: [1.0, 0.5, 2.0],   surfaces: [{ y: 0.5 }], label: "a single bed" },
  rug:         { size: [2.0, 0.01, 1.4],  surfaces: [{ y: 0.01 }], label: "a woven rug" },
  ball:        { size: [0.22, 0.22, 0.22], surfaces: [], label: "a rubber ball" },
  bell:        { size: [0.25, 0.3, 0.25], surfaces: [], label: "a brass hand bell" },
};

export const COMPONENTS = {
  transform: { fields: { pos: "vec3", q: "array", scale: "vec3" }, defaults: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, help: "where it is: pos (m), q (unit quaternion), scale" },
  model:     { type: "string", help: "which model it shows: a name from find {kind: 'model'}" },
  label:     { type: "string", help: "its display name, a short string" },
  pivot:     { help: "{pos: [x,y,z]}: where it turns and scales from, in its own frame before scale ([0,0,0] = its origin). Never moves it or changes how it draws" },
  parent:    { fields: { to: "string", order: "string" }, defaults: { order: "a0" }, help: "{to: id}; its transform becomes local to the parent" },
  light:     { fields: { kind: "string", color: "int", intensity: "number", range: "number", shadows: "bool", keep: "bool", day: "bool" }, defaults: { kind: "point", color: 0xffd9a0, intensity: 16, range: 10, shadows: false }, enums: { kind: ["point", "spot"] }, help: "a light on this thing: {kind: point|spot, color (0xRRGGBB), intensity, range (m), shadows}" },
  motion:    { keyed: "optional", fields: { type: "string", axis: "axis", amp: "number", period: "number", damp: "number", maxAmp: "number", phase: "number", t0: "number", part: "string", radius: "number", degPerSec: "number", amplitude: "number", pivot: "vec3" }, enums: { type: ["pendulum", "spin", "orbit", "bob"] }, help: "{type: pendulum|spin|bob, axis [x,y,z] (local), amp (rad or m), period (s), damp, maxAmp, phase}; a pendulum swings about the point it hangs from; the door stamps t0" },
  lock:      { help: "true: an edit lock (PROTOCOL-v4 §5; v1's lock, same meaning). Nobody, its locker and owners included, may move, replace or delete it, or anything attached to it; edits that don't relocate it (label, light, motion, reactions…) stay open. Any builder or owner may unlock it (delete {id, component: 'lock'}), or act through it by sending a request with through_lock: true. Not on @world. A door's gameplay lock is `door.locked`, not this" },
  sockets:   { map: "object", help: "{name: {pos, pose}}: places a body can sit" },
  reactions: { help: "{<action>: handler}: what happens when someone uses it. Each handler may add who: 'builder'|'owner' (who may use it) and teach: text (shown on refusal).",
    handlers: {
      toggle: { args: { component: "the component to flip (default 'door')", field: "the field inside it to flip (default 'open' for a door; leave both out for a door). A named component with no field flips its whole value", unless: "a field of the same component that, when true, bars it (e.g. 'locked')" }, example: { open: { kind: "toggle", component: "door", field: "open", unless: "locked" } } },
      set: { args: { component: "which component", field: "optional: the field inside it to set", value: "the value it gets" }, example: { bolt: { kind: "set", component: "door", field: "locked", value: true, who: "builder" } } },
      // the general primitive pair (Godot apply_impulse / apply_torque_impulse; Unity AddForce / AddTorque with
      // ForceMode.Impulse; Rapier and PhysX applyImpulse / applyTorqueImpulse): a push changes the thing's velocity at its
      // centre (strength, m/s) or its turn rate about its axis (angular, rad/s). A hinged thing (a pendulum motion) takes
      // strength as strength / its distance from the hinge, and angular as it is.
      impulse: { args: { strength: "a push: the speed it gives the thing at its centre, m/s (default 0.5). A use may give its own push as args.impulse [x,y,z] (m/s)", angular: "or a turn: the turn rate it adds about the thing's axis, rad/s (instead of strength)" }, example: { push: { kind: "impulse", strength: 0.5 } } } },
    common: { kind: "the handler kind", who: "who may use it: builder|owner", teach: "text shown on refusal" } },
  door:      { fields: { open: "bool", locked: "bool" }, help: "{open: true/false, locked: true/false}: a door's own state. `locked` is gameplay (it bars the open handler); the edit lock is the separate `lock` component" },
  physics:   { fields: { kind: "string", who: "string" }, defaults: { kind: "dynamic" }, enums: { kind: ["dynamic", "static", "none"], who: ["visitor", "builder", "owner"] },
    help: "how it takes part in physics: {kind: dynamic (can be picked up and thrown) | static (a collider; the default for anything with a model) | none (nothing collides with it), who: who may pick it up (default builder)}. With eidosim@0.5: a thrown thing flies, bounces off what's in the world and comes to rest; it does NOT push or topple things at rest (stacks don't fall over), and things don't spin" },
  sim:       { fields: { engine: "string", build: "any", tickMs: "int" }, help: "on @world only (owner): the physics engine this world runs: {engine: 'eidosim@0.5.0', tickMs?}. The door stamps the exact build. Delete it to turn physics off (refused while things are in flight)" },
  blueprint: { fields: { from: "string", key: "string" }, help: "set by the server on copies: {from: record hash, key}" },
  // round-2 review R8 (2026-10-05): names the engine reads, carried by translated worlds, registered with their v1
  // meaning so it's fixed (L5). Fields from every v1 log on Burrow, translated. A name not here is a world's own
  // invention (heart, inscription…): admitted, unless it's a near-miss of one of these (ligth).
  sky:       { fields: { hours: "number", rate: "number", ts: "number", azimuth: "number", clouds: "string", weather: "string", forecast: "object", override: "object", weatherK: "number", clock: "string", tz: "string", dormantRated: "object", weatherSeconds: "number", fog: "number", exposure: "number", ambient: "number", sun: "number", fill: "number", world: "string" }, help: "on @world: the sky and its clock {hours, rate, weather, clouds, forecast, fog…}" },
  grass:     { fields: { width: "number", depth: "number", center: "array", bladeHeight: "number", wind: "number", spacing: "number", perCell: "number", color: "any", colorTip: "number", species: "string", height: "number", density: "number", preset: "string", rows: "object", corn: "object" }, help: "a grass or crop field {width, depth, center, species, density…}" },
  structure: { fields: { tile: "number", wallH: "number", wallT: "number", labels: "object", levels: "array" }, help: "a built structure's plan {tile, wallH, wallT, levels, labels}" },
  particles: { fields: { preset: "string", seed: "number", origin: "array", count: "number", quality: "string", size: "number", area: "number", speed: "number", opacity: "number", lifetime: "number" }, help: "a particle emitter {preset, count, size, speed, lifetime…}" },
  epoch:     { fields: { sim: "string", tickMs: "number", ts: "number", seq: "number" }, help: "on @world: the physics epoch a translated world began (dialect 3)" },
  behavior:  { keyed: true, key: "instance", fields: { src: "string", attach: "string", caps: "object", knobs: "object", author: "string", ts: "number", state: "object" }, help: "keyed by name: a v1 runtime script binding, carried from translation (v4's are script:<name>)" },
  palette:   { keyed: true, key: "instance", fields: { name: "string", path: "string" }, help: "on @world, keyed: an asset on the world's palette" },
  legacy:    { keyed: true, key: "instance", help: "keyed: a v1 field the translation had no mapping for, carried as it was (R10)" },
  roles:     { keyed: true, key: "instance", fields: { role: "string", gen: "bool", sub: "any" }, help: "on @world, keyed by identity: {role: owner|builder|visitor|none}" },
  "default-role": { fields: { role: "string", gen: "bool" }, help: "on @world: the role of anyone without roles:<id> (absent = visitor)" },
  about:     { fields: { name: "string", text: "string" }, help: "on @world: the world's name and blurb" },
  bounds:    { fields: { min: "vec3", max: "vec3" }, help: "on @world: the box the world lives in (m)" },
  spawn:     { fields: { pos: "vec3", radius: "number" }, help: "on @world: where visitors arrive {pos, radius}" },
  // research 40 §6.1: today's noise bag with `kind` explicit, or an imported raster as a value blob. Keys by kind.
  terrain:   { fields: { kind: "string", seed: "int", size: "number", amplitude: "number", octaves: "int", frequency: "number", flatRadius: "number", flatHeight: "number",
                         blob: "string", w: "int", h: "int", spacing: "number", origin: "array", format: "string", segments: "int", layers: "any" },
               defaultKind: "noise", byKind: { noise: ["kind", "seed", "size", "amplitude", "octaves", "frequency", "flatRadius", "flatHeight", "segments", "layers"], raster: ["kind", "blob", "w", "h", "spacing", "origin", "format"] },
               help: "the ground's base: {kind: 'noise', seed, size, amplitude, octaves, frequency, flatRadius, flatHeight} or {kind: 'raster', blob, w, h, spacing, origin: [x, z], format: 'i32-mm-le'}" },
  "terrain-grid": { fields: { spacing: "number", tile: "int", origin: "array", extent: "array", limits: "object" }, help: "the sculpt grid: {spacing (m), tile (samples per side), origin [x, z], extent [nx, nz] tiles, limits {raise, lower} (mm)}; fixed while any terrain-tile exists" },
  "terrain-tile": { keyed: true, key: "partition", fields: { mm: "array" }, help: "keyed <i>-<j>: {mm: [tile² integer millimetres, row-major]}, a delta over the base; written whole by sculpt" },
  // research 41 §3.2: a behaviour. Keyed, so §5's creator rule decides who may change it and who its SPONSOR is.
  script:    { keyed: true, key: "instance", fields: { src: "string", scope: "object", on: "array", every: "number", always: "bool", knobs: "object", paused: "bool" },
               scopeFields: { ids: "any", comps: "array", create: "bool", say: "bool", launch: "bool", bodies: "array" },
               help: "keyed <name>: {src: sha256 of the source blob, scope: {ids: 'self'|'subtree'|[ids], comps: [names, 'name:*'], create?, say?, bodies?: ['shove'|'pose']}, on: ['use', 'changed:<comp>'], every?: s (>= 5), always?: bool (owner), knobs?, paused?}" },
  // §5 (23:40): keyed names say which kind of key they are. instance: the creator rule; partition: one shared surface
  schemas:   { keyed: true, key: "instance", help: "on @world (owner), keyed by component name: the content hash of that name's written definition; set once, never changed (L5, §3d M6)" },
  library:   { keyed: true, key: "instance", help: "on @world, keyed by a blueprint's hash: {name, …} (publish writes it)" },
  "ground-paint": { keyed: true, key: "partition", help: "keyed <i>-<j>: paint channels for one tile (research 40 §3; not built in the lab)" },
  scripts:   { fields: { run: "bool", install: "string", max: "int", budget: "int", rate: "int" }, help: "on @world (owner): {run: false stops every script, install: 'builder'|'owner', max (scripts, default 12), budget (script entries per hour, default 600), rate (logged activations per script per minute, default 6)}" },
};

export const PENDULUM = { type: "pendulum", axis: [1, 0, 0], amp: 0, period: 2.4, damp: 0.08, maxAmp: 0.9, phase: 0 };
