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
  transform: { defaults: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, help: "where it is: pos (m), q (unit quaternion), scale" },
  model:     { help: "which model it shows: a name from find {kind: 'model'}" },
  label:     { help: "its display name, a short string" },
  parent:    { defaults: { order: "a0" }, help: "{to: id}; its transform becomes local to the parent" },
  light:     { defaults: { kind: "point", color: 0xffd9a0, intensity: 1, range: 6, shadows: false }, enums: { kind: ["point", "spot"] }, help: "a light on this thing: {kind: point|spot, color (0xRRGGBB), intensity, range (m), shadows}" },
  motion:    { enums: { type: ["pendulum", "spin", "bob"] }, help: "{type: pendulum|spin|bob, axis [x,y,z] (local), amp (rad or m), period (s), damp, maxAmp, phase}; a pendulum swings about the point it hangs from; the door stamps t0" },
  lock:      { help: "true: an edit lock (PROTOCOL-v4 §5; v1's lock, same meaning). Nobody, its locker and owners included, may move, replace or delete it, or anything attached to it; edits that don't relocate it (label, light, motion, reactions…) stay open. Any builder or owner may unlock it (delete {id, component: 'lock'}), or act through it by sending a request with through_lock: true. Not on @world. A door's gameplay lock is `door.locked`, not this" },
  sockets:   { help: "{name: {pos, pose}}: places a body can sit" },
  reactions: { help: "{<action>: handler}: what happens when someone uses it. Each handler may add who: 'builder'|'owner' (who may use it) and teach: text (shown on refusal).",
    handlers: {
      toggle: { args: { component: "the component to flip (default 'door')", field: "the field inside it to flip (default 'open' for a door; leave both out for a door). A named component with no field flips its whole value", unless: "a field of the same component that, when true, bars it (e.g. 'locked')" }, example: { open: { kind: "toggle", component: "door", field: "open", unless: "locked" } } },
      set: { args: { component: "which component", field: "optional: the field inside it to set", value: "the value it gets" }, example: { bolt: { kind: "set", component: "door", field: "locked", value: true, who: "builder" } } },
      "pendulum-push": { args: { gain: "amplitude per unit impulse (default 0.25)", default: "impulse when none is given" }, example: { push: { kind: "pendulum-push", gain: 0.25 } } } } },
  door:      { help: "{open: true/false, locked: true/false}: a door's own state. `locked` is gameplay (it bars the open handler); the edit lock is the separate `lock` component" },
  physics:   { defaults: { kind: "dynamic" }, enums: { kind: ["dynamic", "static", "none"], who: ["visitor", "builder", "owner"] },
    help: "how it takes part in physics: {kind: dynamic (can be picked up and thrown) | static (a collider; the default for anything with a model) | none (nothing collides with it), who: who may pick it up (default builder)}. With eidosim@0.5: a thrown thing flies, bounces off what's in the world and comes to rest; it does NOT push or topple things at rest (stacks don't fall over), and things don't spin" },
  sim:       { help: "on @world only (owner): the physics engine this world runs: {engine: 'eidosim@0.5.0', tickMs?}. The door stamps the exact build. Delete it to turn physics off (refused while things are in flight)" },
  blueprint: { help: "set by the server on copies: {from: record hash, key}" },
  placer:    { help: "server-written: who made it" },
};

export const PENDULUM = { type: "pendulum", axis: [1, 0, 0], amp: 0, period: 2.4, damp: 0.08, maxAmp: 0.9, phase: 0 };
