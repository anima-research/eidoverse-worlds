// shared/protocol/componentspec.js — the component types a builder can discover: their fields, defaults, ranges and help.
// The lab's hand-written models are shared/protocol/labmodels.js.
//
// Every parameter is written down (PROTOCOL §4; review 10-07 H2, R: "the parameter is the parameter"). The authority writes a
// component's defaults into the stored value when it's created or set (materialize, below): `defaults` always, and each
// `when` rule ({if: {field: value}, absent: [fields], set: {…}}) when it holds. So a renderer never supplies a number the
// log doesn't hold, and changing a default here never changes an old world. A default that lives only in help text or a
// renderer is a bug (pretrans-check D7); a changed default, type or enum is a changed meaning (spec/registry-pin.json, D8).
//
// ONE description, derived readers (review 10-14 §3.4, R: "fix"): a field's type (`fields`), default (`defaults`/`when`),
// limits (`ranges`), unit (`units`) and one-line doc (`docs`) are written HERE and nowhere else. shared/protocol/descriptors.js
// derives the inspector's rows from them (keeping only widget facts: step, decimals, soft maxima, which rows a card shows),
// shared/components.js derives its records' params, shared/editschema.js and shared/worldentity.js read limits from here, and
// the agent's `schema` request returns this table. tools/schema-layers-test.ts holds every reader to it. `units` and `docs`
// are prose about a field, not its meaning: they aren't pinned, and rewording one is not a new version.

// how two touching surfaces' coefficients combine: the modes PhysX, Unity and Rapier name (Jolt and Box2D take any rule as a
// callback), so every engine can carry them; when two differ, the later in this list wins (PhysX's and Unity's priority)
import { RANK, BUILTIN_IDS, PERMISSION_NAMES, CUSTOM_ID, RESERVED_IDS } from "./roles.js";
import { BODY_RANGE, bodyRangeWords } from "./physconst.js";
export const COMBINE = ["average", "min", "multiply", "max"];
export const COMPONENTS = {
  // glTF's node TRS (shape audit 10-16, physics-motion §1): local matrix = T · R · S, world = parent's world × local, down the
  // tree (PROTOCOL §9.3 writes the rule down). The door's limits, pinned: pos within ±1e5 m, each scale within ±1e3 and at
  // least 1e-4 from zero (a negative one mirrors; physics reads |scale|, KHR_physics_rigid_bodies' rule)
  transform: { status: "trial", on: "thing", fields: { pos: "vec3", q: "array", scale: "vec3" }, defaults: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, units: { pos: "m", scale: "×" },
    ranges: { pos: { min: -1e5, max: 1e5 }, scale: { min: -1e3, max: 1e3 } },
    docs: { pos: "where it stands, [x, y, z] in metres, in its parent's frame (the world's when it has no parent)", q: "its orientation, a unit quaternion [x, y, z, w] (glTF order), in its parent's frame; normalized on write", scale: "its size per axis, [x, y, z] (1 = as made), each within ±1000 and never within 1e-4 of zero; a negative one mirrors (physics reads its size, |scale|)" },
    help: "where it is, glTF's node TRS: pos (m), q (unit quaternion [x, y, z, w]), scale [x, y, z], all in its parent's frame. Composed as glTF composes a node: local = T · R · S, world = parent's world × local (PROTOCOL §9.3)" },
  // R 10-17 (binding: "definitely serve path again alongside hash"): a model is its LIBRARY PATH, stored as written: the
  // portable reference (a world loads anywhere the library exists, as on anima/main). What its bytes were rides beside it,
  // optionally, as model-hash (below), never instead. A content address stored before 10-17 (eido:sha256/<64 hex>: translate-v1
  // @8–@11, and this branch's door for a day) still loads where this host's index knows it, and the maintenance command's repair writes its path
  // back (shaperepair.js); one no file here names reads as "thing"
  model:     { status: "trial", on: "thing", type: "string", help: "which model it shows: its library path (eidoverse/assets/models/…glb, store/<hash>.glb; a name from find {kind: 'model'} gives one), stored as written. The server stamps model-hash beside it when it knows the file's bytes. An older eido:sha256/<64 hex> address still loads where this host can find its bytes" },
  // the bytes a model's path named when it was written: Godot's ext_resource {path, uid}, an npm lock's {resolved, integrity},
  // a web page's <script src integrity>. Optional (a host that can't hash, or hasn't yet, writes none; nothing breaks without
  // it), never the reference: readers load the path. Stamped by the authority from what its catalogue measured off the request
  // path (server/modelcatalogue.ts), dropped when the model changes to one it can't hash
  "model-hash": { on: "thing", type: "sha256", writtenBy: "server",
               help: "set by the server beside model (never by hand below owner): sha256:<64 hex> of the original bytes its library path named when it was written (the file in the library, never an optimized copy). An integrity and version fact only: readers load the path; absent, nothing is lost" },
  label:     { on: "thing", type: "string", maxLen: 80, help: "its display name, a short string (its name to every reader: the accessible name; description says what it is)" },
  // R 10-07 (our answer to upstream PR #168's label {name, description, visibility, offset}): the accessibility model's
  // name / description / role+state. label stays the name; description is how the thing is described to any text-based
  // reader, one plain string, like label and picture.description; what it can do and its state are GENERATED from its
  // components (shared/a11y.js), so a description never restates them; why it's here, as a titled placard with marks, is
  // story's (the long-form details beside the short description). A visible nameplate is a child thing with text.
  description: { on: "thing", type: "string", maxLen: 500, cleanAs: "lines",
               help: "how it is described to anyone who reads rather than sees it, a sentence or two of plain text (≤ 500): what it is and what it looks like. Its name is label. What it can do and its state (it opens, it's locked, it can be picked up or sat on, it's playing…) are read out from its components, so don't restate them here; why it is here, as a titled placard, is story. A visible nameplate isn't a component: it's a child thing (parent {to: this}) with text {text, billboard: 'yaw'}" },
  // every client honours it (the editor's Hide; shared/editschema.js flags); registered 10-07 when bare names became the
  // registry's (PROTOCOL §4), with the meaning it already had
  // the collision shape every client and the authority's solids honour (shared/editschema.js Collider): its triangles or
  // its box; and the caption bot's speaker mark (shared/components.js Stage). Registered 10-07 with the meanings they had
  // two readers, one vocabulary (shape audit 10-16, physics-motion §7): `mesh` is shapes.js's word, KHR's geometry.mesh, Unity's
  // MeshCollider, Godot's trimesh (it was `exact`; the door takes that and stores mesh). The physics stamp (authority
  // shapeFor) and the walker (client/lib/colliders.js decide) read it, and its absence, differently: both written down
  // enabled: collision off is its own axis, apart from how it moves (Godot CollisionShape3D.disabled, Unity Collider.enabled,
  // Roblox CanCollide; DESIGN.md env-components "the laws"); every solidity reader asks shared/protocol/simlayer.js solidOff
  // blocks: which kinds of mover it stops (R 10-28 item 50); layer/mask: Godot's CollisionObject3D collision_layer/collision_mask
  // (owner 10-30: "Godot is the exemplar"), per pair; both must pass (simlayer.js solidOff, scans)
  collider:  { on: "thing", fields: { shape: "string", enabled: "bool", blocks: "array", layer: "array", mask: "array" }, enums: { shape: ["mesh", "box", "sphere"] },
    itemEnums: { blocks: ["bodies", "hulls", "things"] }, ranges: { blocks: { maxItems: 3 }, layer: { maxItems: 32 }, mask: { maxItems: 32 } },
    docs: { shape: "mesh = its triangles (to walk on; physics collides a mesh as its box, PhysX's rule for a dynamic body, and eidosim carries boxes), box = its bounding box, sphere = a ball (rolls, under an engine that carries spheres); remove the component to let its size decide",
      enabled: "false: not solid. Nothing collides with it, stands on it or bumps into it (walkers, agents, the authority's track, the physics engine); it still moves as its physics.kind and motion say, and is still drawn, clicked and grabbed",
      blocks: "what it stops, a list of layers: bodies (people and agents walking or swimming), hulls (driven vehicles: the authority's hull sweep), things (loose things in the physics engine). What it leaves out passes through it: [\"hulls\"] with hidden is an invisible wall only vehicles meet",
      layer: "the collision layers it is IN (Godot's collision_layer): a list of layer numbers 1..32 or names (a lowercase letter, then letters, digits, - or _; ≤ 40), each once. A mover meets it only when the mover's mask scans one of them (Godot: \"Object A can detect a contact with object B only if object B is in any of the layers that object A scans\")",
      mask: "the collision layers it SCANS when it moves (Godot's collision_mask), same items as layer: read for a hull (the authority's hull sweep meets only what is in a layer its mask scans). People and agents walking or swimming, and loose things in the physics engine, scan [1] (eidosim carries no layers between things); a still thing's mask is unread" },
    absentMeans: { shape: "its size decides, for each reader: physics collides it as its measured box; walking uses its triangles (mesh) when it is room-scale (footprint ≥ 16 m² and ≥ 2.2 m tall) or floor-shaped and uneven (footprint ≥ 2 m², ≤ 1.0 m tall, its box top > 0.10 m above its surface), else its box (client/lib/supportclass.js)",
      enabled: "true: it is solid", blocks: "everything: bodies, hulls and things", layer: "[1] (Godot's default): every mover meets it", mask: "[1] (Godot's default)" },
    help: "how it collides: {shape: mesh (its triangles: walked on as they are; physics collides it as its box) | box (its bounding box) | sphere (a ball: under an engine that carries spheres it rolls; the authority fits one to its box), enabled? (false: not solid at all, a walk-through thing that still moves; absent true), blocks? [bodies|hulls|things] (what it stops; absent: everything; [\'hulls\'] = a wall only vehicles meet), layer? [1..32 | name] (the layers it is in; absent [1]), mask? (the layers it scans as a hull; absent [1]): a mover meets it when blocks names the mover's kind AND the mover's mask scans its layer (Godot's rule; bodies and things scan [1])}; absent shape, its size decides (a room-scale or uneven floor-shaped thing walks as its mesh, else its box; physics uses its box). enabled: false with physics {kind: 'dynamic'} is refused (it would fall forever). exact, the old word for mesh, is taken and stored as mesh" },
  stage:     { on: "thing", fields: { speaker: "string" }, ranges: { speaker: { maxLen: 80 } }, docs: { speaker: "who is speaking here, a name (≤ 80; the caption bot's mark, WebVTT's <v Name>)" },
    absentMeans: { speaker: "no stage cue: the caption bot uses its own speaker" }, help: "the caption bot's stage mark: {speaker?: who is speaking here, a name ≤ 80}" },
  // recut B2 (R 10-20; house 21:59Z): a lock is just true. Its strength is its setter's rank NOW (read from the log), so
  // anyone at that rank or above may lift it or act through it (throughLock), with the padlock asking first. The
  // {rank} levels of 10-07 are gone: no stored world used one, and a stored {rank} still reads as locked.
  lock:      { on: "thing", type: "bool", help: "true: an edit lock (PROTOCOL §7, Locks). Nobody, its locker and owners included, may change it or anything attached to it (any component set, added or removed; a move, replacement or delete) without throughLock: true; only use (its reactions' own writes) stays open. Anyone at the rank its setter holds now, or above, may lift it or act through it. Delete it to unlock" },
  hidden:    { on: "thing", type: "bool", help: "true: not drawn by any client (it's still there: it collides, look and inspect list it). Delete it to show the thing again; false reads the same as absent" },
  clickthrough: { on: "thing", type: "bool", help: "true: a pointer click passes through it to whatever is behind (it is still drawn, collides, and can be grabbed by a hand or a tool; the editor still selects it). Delete it to make it a click target again; false reads the same as absent" },
  disabled:  { on: "thing", type: "bool", help: "true: switched off. It stays in the record and the Hierarchy, but no client loads or draws it, it has no collider and no physics, and nothing may grab, punt, use or sit on it; what hangs under it is switched off with it. Delete it to switch the thing back on; false reads the same as absent" },
  // the one hinge (shape audit 10-16, physics-motion §3): a whole thing's motion, openable, the gizmo all turn about it; a part's
  // motion carries its own (motion:<part>.pivot, in the part's frame), since a part can't carry components
  pivot:     { on: "thing", fields: { pos: "vec3" }, required: ["pos"], units: { pos: "m" }, ranges: { pos: { min: -1e4, max: 1e4 } },
    docs: { pos: "the point it turns and scales about, [x, y, z] metres in its own frame before scale" },
    absentMeans: { pos: "it turns and scales about its origin, [0, 0, 0]" },
    help: "{pos: [x,y,z]}: where it turns and scales from, in its own frame before scale ([0,0,0] = its origin). Never moves it or changes how it draws. A whole thing's motion and openable turn about it; absent, about its origin" },
  // attaching to a NAMED point on the parent is general (Unreal AttachToComponent's SocketName, Roblox Attachment,
  // Godot BoneAttachment3D): socket names one of the parent's sockets
  // shape audit 10-16 (physics-motion §2): `order` is gone. Its materialized "a0" ordered nothing (every child tied; no reader
  // sorted by it); a sibling order comes back as an addition (a fractional index) when a reader needs one. The door takes a
  // written order and drops it; a stored one is read by nothing (and dropped at its next write)
  parent:    { status: "trial", on: "thing", fields: { to: "ref", socket: "string" }, required: ["to"], legacy: ["socket"], dropped: { order: "sibling order: read by nothing (every stored value was \"a0\")" },
    docs: { to: "the thing it rides: its transform becomes local to this parent", socket: "the old spelling of a socket attachment: parent to the socket child instead" }, help: "{to: id}; its transform becomes local to the parent. To attach at a socket, parent to the socket (a child entity of its host). socket: the old spelling, read in old logs and lifted at the door" },
  // the punctual light every engine shares (glTF KHR_lights_punctual, Godot OmniLight3D/SpotLight3D, Unity Light,
  // three.js): kind, color, intensity, range; a spot adds its cone as HALF-angles in radians (glTF outer/innerConeAngle,
  // Godot spot_angle, three.js angle/penumbra) and shines along the thing's local -Z (glTF, Godot)
  // shape audit 10-16 (render-media-env §3): the falloff law is part of the value (decay, glTF's and Godot's exponent: 2 =
  // inverse square, so intensity is candela as in KHR_lights_punctual); a light stored before it was written fell off as
  // three.js decay 1.7 (the rig's constant), and the maintenance command's repair writes 1.7 on it so it keeps its look. shadows was read by
  // nothing (it returns, absent = false, when the rig reads it); day (a double negative) is daytime: dim | full
  // intensity 25.93 = main's 16 cd at decay 1.7, matched at 5 m (half the default range): 16 × 5^0.3 (translate-v1 parityIntensity)
  light:     { on: "thing", fields: { kind: "string", color: "int", intensity: "number", range: "number", angle: "number", inner: "number", decay: "number", important: "bool", daytime: "string" },
    defaults: { kind: "point", color: 0xffd9a0, intensity: 25.93, range: 10, decay: 2, important: false, daytime: "dim" }, enums: { kind: ["point", "spot", "directional"], daytime: ["dim", "full"] },
    dropped: { shadows: "read by nothing (it returns when the light rig reads it; absent = no shadows)", day: "renamed daytime: 'dim' (true) | 'full' (false); a write of day is taken and stored as daytime" },
    when: [{ if: { kind: "spot" }, set: { angle: Math.PI / 4, inner: 0 } }],
    ranges: { color: { min: 0, max: 0xffffff }, intensity: { min: 0 }, range: { gt: 0 }, angle: { gt: 0, max: Math.PI / 2 }, inner: { min: 0, max: Math.PI / 2 }, decay: { min: 0, max: 4 } },
    units: { range: "m", angle: "rad", inner: "rad" },
    absentMeans: { decay: "1.7: the falloff exponent the light rig used before it was written (three.js decay); a value stored before 10-16 is repaired to 1.7 by the maintenance command (repair-shapes; docs/MAINTENANCE.md), never at load",
      intensity: "the default; on a light with no decay (stored before 10-16) 16, the old rig's, written by the same repair",
      daytime: "dim: it follows the day cycle (an older value's day: false meant full)" },
    docs: { kind: "point (shines every way), spot (a cone along its -Z) or directional (a sun: parallel light along its -Z everywhere, KHR_lights_punctual's; range and decay unread; the first by id is the renderer's sun)", color: "its colour, 0xRRGGBB, sRGB", intensity: "how bright it is: candela at decay 2 (KHR_lights_punctual); three.js units under this light's decay otherwise. Default 25.93: main's default light's brightness at 5 m", range: "a hard cutoff, metres: nothing beyond it is lit", angle: "a spot's cone half-angle, radians",
      inner: "where a spot's edge starts to soften, radians", decay: "how it falls off with distance, an exponent: 2 = inverse square (physical, glTF), 0 = not at all", important: "always casts: first claim on a light slot, never governor-shed", daytime: "dim (it dims by day, follows the day cycle) | full (it burns at noon too)" },
    help: "a light on this thing: {kind: point|spot|directional, color (0xRRGGBB, sRGB), intensity (candela at decay 2), range (m, a hard cutoff), decay (falloff exponent, default 2 = inverse square), important, daytime: dim|full}; a spot shines along the thing's -Z with angle (its cone's half-angle, rad, default π/4) and inner (where the edge starts to soften, rad, default 0); a directional light is a sun shining along the thing's -Z everywhere (intensity in lux, as KHR_lights_punctual; the first by id lights the world, in place of the sky's own sun). day (true/false) is taken and stored as daytime" },
  // a parametric body on a model-less thing (R 10-12: Create ▸ Box/Sphere/…, as Create ▸ Light is an Empty with a light).
  // Base-centred like a measured model (boxOfM): y runs 0..size[1], so a mesh thing stands on its own origin. Registered
  // bare at once (ladder rung 3): the authority needs its size to place it, stack on it and stamp its physics shape. No
  // colour: its one material slot is 'surface', and hesperus/material colours it as it colours a model's.
  mesh:      { on: "thing", fields: { shape: "string", size: "vec3" }, defaults: { shape: "box", size: [1, 1, 1] }, enums: { shape: ["box", "sphere", "cylinder", "plane", "capsule"] },
    ranges: { size: { min: 0.05, max: 200 } },   // a vec3's range holds for each element (valueCheck)
    // pinned facts (shape audit 10-16): where it stands on its origin, and what a primitive does with the axes it ignores
    absentMeans: { origin: "the centre of its base: it stands on its own origin (every referent centres primitives; ours stands, as a model does)", ignored: "a sphere ignores size[1] and size[2], a cylinder and a capsule size[2], a plane size[1]" },
    units: { size: "m" }, docs: { shape: "box, sphere, cylinder, plane (flat on the ground, drawn on both sides) or capsule; it stands on its own origin", size: "its size [x, y, z] in metres; a sphere reads x as its diameter, a cylinder or capsule x as diameter and y as height, a plane x × z" },
    help: "a parametric body drawn without a model: {shape: box|sphere|cylinder|plane|capsule, size: [x, y, z] (m, each 0.05..200)}. Its origin is the centre of its base (it stands on its own pos, as a model does). A sphere reads size[0] as its diameter; a cylinder and a capsule read size[0] as diameter and size[1] as height (a capsule is at least its diameter tall); a plane is size[0] × size[2] on the ground plane, 0.05 thick (it collides as a thin slab; things rest on it at 0.05), drawn on both sides. Never on a thing with a model or a light (one place per thing: give it a child). Its one material slot is 'surface' (hesperus/material:surface)" },
  // the closed forms every client and the agent evaluate (client/lib/motioneval.js). Rates are degrees a second (Unreal's
  // RotatingMovementComponent RotationRate, Unity's Rotate) or a period in seconds; a path is control points with a speed
  // or a duration and a loop mode (Unreal's InterpToMovementComponent: ControlPoints, Duration, OneShot/Loop/PingPong)
  // the per-type defaults are motioneval.js's readings, written down (a spin with no rate turned at 36°/s in every renderer)
  // shape audit 10-16 (physics-motion §4): amplitude (the first protocol's amp) and a whole motion's `part` field are gone (a node's
  // motion is motion:<slot> {node}: the node's name is DATA from the model file, any characters, never part of a key; review r7 F1),
  // refused at write, and repaired in a stored world by its maintenance command (shaperepair.js) and by translate-v1@12; an
  // axis is stored as a vector (x|y|z|-x|-y|-z taken at write); `pivot` is a PART motion's hinge only (a whole thing turns
  // about its pivot component). The readings that lived only in motioneval.js are here, as absentMeans
  motion:    { on: "thing", keyed: "optional", when: [
                 { if: { type: "pendulum" }, set: { axis: [1, 0, 0], period: 2.4, damp: 0.08, maxAmp: 0.9, phase: 0 } }, { if: { type: "pendulum" }, absent: ["amp"], set: { amp: 0 } },
                 { if: { type: "spin" }, set: { axis: [0, 1, 0], phase: 0 } }, { if: { type: "spin" }, absent: ["degPerSec", "period", "rpm"], set: { degPerSec: 36 } },
                 { if: { type: "orbit" }, set: { radius: 3, phase: 0, face: true } }, { if: { type: "orbit" }, absent: ["degPerSec", "period", "rpm"], set: { degPerSec: 12 } },
                 { if: { type: "oscillate" }, set: { axis: [0, 1, 0], period: 4, phase: 0 } }, { if: { type: "oscillate" }, absent: ["amp"], set: { amp: 0.3 } },
                 { if: { type: "path" }, set: { loop: "loop", face: true } }, { if: { type: "path" }, absent: ["speed", "duration"], set: { speed: 1 } }],
               fields: { type: "string", axis: "axis", amp: "number", period: "number", damp: "number", maxAmp: "number", phase: "number", t0: "number", radius: "number", degPerSec: "number", pivot: "vec3",
                 center: "vec3", face: "bool", points: "array", speed: "number", duration: "number", loop: "string", node: "string" }, required: ["type"], enums: { type: ["pendulum", "spin", "orbit", "oscillate", "path"], loop: ["loop", "pingpong", "once"] },
               dropped: { amplitude: "the first protocol's spelling of amp (repaired to amp)", part: "a node's motion is motion:<slot> {node: <its name>} (repaired to that: the slot is shared/protocol/names.js partSlot of the name)" },
               ranges: { node: { maxLen: 256 }, period: { gt: 0, max: 3600 }, degPerSec: { min: -36000, max: 36000 }, radius: { min: 0, max: 10000 }, speed: { min: 0, max: 1000 }, duration: { gt: 0, max: 36000 } },
               units: { amp: { pendulum: "rad", oscillate: "m" }, period: "s", degPerSec: "°/s", radius: "m", speed: "m/s", duration: "s", pivot: "m", center: "m", phase: "rad", maxAmp: "rad", damp: "1/s", t0: "ms" },
               docs: { type: "pendulum | spin | orbit | oscillate | path (oscillate: back and forth along its axis, a sine)", axis: "the axis it moves about or along, a direction [x, y, z] in its own frame (x, y, z, -x, -y or -z is taken and stored as one)", amp: "how far it swings (a pendulum: radians) or travels each way from where it stands (an oscillate: metres)", period: "seconds for one swing, one turn or one lap",
                 damp: "how fast a swing dies down, 1/s; 0 swings forever", maxAmp: "the most a push may swing it, radians", phase: "where in its cycle it starts, radians", t0: "when it started, epoch ms on the authority's clock (the authority stamps it)",
                 radius: "the circle's radius, metres", degPerSec: "degrees a second (a lap of 30 s is 12°/s)", pivot: "a part's motion only: the point the part turns about, metres in the part's own frame (a whole thing turns about its pivot component)", center: "what it circles, in its parent's frame (absent: where it stands)",
                 node: "a keyed motion only (motion:<slot>): the node of its model it moves, its name exactly as the model file spells it (any characters: data, never part of the key; the key's <slot> is a short tag of your choosing, the editors' is partSlot of the name)", face: "turns to face along the way it moves", points: "the path's control points, 2–64, in its parent's frame", speed: "metres a second along the path", duration: "seconds for the whole path (instead of speed)", loop: "loop | pingpong | once" },
               // what an older value WITHOUT a field reads as (every one of these is materialized on write now; a value stored
               // before, or written by a translator, can lack them): motioneval.js's readings, written down
               absentMeans: { period: "pendulum: 3.5 s (an old value's reading; a swing written today carries the default, 2.4 s); spin and orbit: their degPerSec; oscillate: 4 s", damp: "0: it swings forever (an old value's reading; the default is 0.08)", amp: "pendulum 0 (still); oscillate 0.3 m", axis: "pendulum [1, 0, 0]; spin and oscillate [0, 1, 0]",
                 pivot: "a part turns about its own origin; a whole thing (which never holds one) about its pivot component, else its origin [0, 0, 0]", phase: "0", maxAmp: "1.1 rad (an old value's reading, the first protocol's push cap; the default is 0.9 rad)", degPerSec: "spin 36°/s, orbit 12°/s (when no period either)", radius: "3 m",
                 center: "where it stands", face: "true", speed: "1 m/s (when no duration either)", duration: "speed decides", loop: "loop", t0: "the reader's own first look (a value from before t0 was stamped)", node: "a keyed motion: the node its key's tag names (the reading before 10-16, when the key was the node's name); the door writes that down. A whole motion never has one", points: "fewer than 2 points: it stands still" },
               help: "{type, …} (the authority stamps t0, epoch ms): pendulum {axis [x,y,z] (own frame), amp (rad), period (s), damp (1/s), maxAmp, phase} swings about its pivot component (absent: its origin); spin {axis, degPerSec (degrees a second) or period (s a turn), phase} turns steadily about its pivot; orbit {radius (m), center? [x,y,z] (in its parent's frame; default where it stands), period (s a lap) or degPerSec, face? (false: keeps its own heading), phase} circles in its parent's XZ plane about +Y; oscillate {axis, amp (m), period (s), phase} moves back and forth along its axis (a sine: amp each way, one period a cycle; the default axis is up, a float); path {points [[x,y,z], …] (2–64, in its parent's frame), speed (m/s) or duration (s), loop?: loop|pingpong|once, face?} follows its points. A node of its model moves instead as motion:<slot> {node: <the node's name, as the file spells it>, …}, whose pivot? [x,y,z] (the part's own frame) is its hinge; <slot> is any short tag [a-z0-9-] (the editors write the name itself when it is one, else a sanitized form with a hash: tripo_part_3 → tripo-part-3-c9dc783a)" },
  // the first spelling of attachment points: a map on the host. Reserved and lift-only (shape audit 10-16): nothing stores it;
  // the door lifts a write of it into socket children (each body block a station on its child), and the maintenance command
  // lifts a stored world's. The name is held so it can't come back meaning something else.
  sockets:   { status: "reserved", on: "thing", map: "object", lifted: "socket children + their stations (lifted at the door)", instead: "socket children: create {components: {parent: {to: <host>}, transform, socket: {name, accepts?, radius?, part?}, station?: {action, anim, anchor, exit?, leaveBy?, who?}}}", help: "reserved, lift-only: the old spelling of sockets (socket children now: the door lifts a write of it into socket children, each body block a station on its child, and the maintenance command lifts a world stored with it): {<name>: {pos: [x,y,z] (its own frame), q? [x,y,z,w] (its rotation: a rocket seat lies on its back), part? (a model node it rides), accepts? [keywords] + radius? (m, default 0.15): a thing released within radius whose grabbable.fits shares a keyword snaps in (a key on its hook, a sword in its rack), body?: what a person's body does there: {action ('sit'; what 'use' calls it), anchor (root, the default | hips | feet | head: the body point on the socket), pose (a clip; {clip, time: 'phase'}; or a blend {by: 'speed'|'steer'|…|'param.<name>', clips: [[0,'idle'],[2,'walk']]}), poses {<name>: pose} + sync, approach [x,y,z,yaw], enter/leave (clips), exit [x,y,z], reach {leftHand: {at, q?, part?, hint?, vr: snap|track|near}}, hold {<bone>: q}, look {yaw: [min,max]°, pitch, up: world|socket}, input {move: none|drive|walk, look: free|aim|locked} (one drive per thing), leaveBy (jump|menu|script), fromSeat, who (builder|owner)}}}" },
  // an attachment point as an entity of its own (Godot's Marker3D under its node, Unity's child Transform, Unreal's socket):
  // a child of the thing it belongs to, its pose its own transform (scale 1). Shape audit 10-16 (R: "a socket is just
  // anything where something may attach something else"): ONLY the attach point. What a person's body does there is the
  // sibling `station` on the same entity (Resonite AvatarAnchor ≠ SnapTarget; VRChat Station ≠ Pickup). Seat if it has a
  // station, snap point if accepts, else attach point (read, never stored).
  socket:    { on: "thing", fields: { name: "string", part: "string", accepts: "array", radius: "number" }, required: ["name"],
               ranges: { accepts: { maxItems: 8 }, radius: { min: 0.02, max: 1 } }, units: { radius: "m" },
               absentMeans: { part: "it rides its host's root, not a moving node of the host's model", accepts: "nothing snaps in by fits", radius: "0.15 m (read only with accepts)" },
               docs: { name: "letters, digits, - and _ (≤ 32), unique among its host's sockets: what use {args: {socket}} names", part: "a node of its host's model it rides", accepts: "keywords (≤ 8): a released thing whose grabbable.fits shares one snaps in",
                 radius: "how near a released thing must be to snap in, metres", occupancy: "it holds one thing or one body at a time", attach: "who may attach: a thing, whoever may edit that thing's parent, or whoever releases a fitting grabbable within radius; a person, by using its station (station.who)" },
               help: "an attachment point on its parent (its host): {name (letters, digits, - and _, unique among the host's sockets; what use {args: {socket}} names), part? (a node of the host's model it rides), accepts? [keywords, ≤ 8] + radius? (m; absent, 0.15): a thing released within radius whose grabbable.fits shares a keyword snaps in}. Its pose is its transform (local to the host; scale 1). It holds one thing or one body at a time. A person attaches by using it when the same entity has a station. It carries nothing else but station, label, description, disabled, lock and motion. Things attach with parent {to: <its id>}" },
  // what a person's body does at a socket (shape audit 10-16; research RESEARCH-socket-body-2026-10-06; VRChat Station,
  // Resonite AvatarAnchor, Roblox Seat), on the socket entity beside `socket`. The alpha registers the core only; the rest of
  // the researched shape is reserved (refused, names held: STATION_RESERVED below; docs/COMPONENT-LADDER.md) and comes back
  // as additions. Materialized on write: the action table fills anim, so editing the table never re-poses a stored seat.
  // anim (R 10-17 15:09/15:11; was pose): an OPEN name, of a pose (one frame) or a clip (more than one key): a built-in
  // name today, a world's anim-pose/anim-clip later; one the body doesn't know is its default, never a refusal.
  station:   { on: "thing", fields: { action: "string", anim: "any", anchor: "string", exit: "array", leaveBy: "string", who: "any", input: "object" },
               defaults: { action: "sit", anchor: "root" },
               when: [{ if: { action: "sit" }, set: { anim: "sitchair" } }, { if: { action: "ride" }, set: { anim: "sitchair" } }, { if: { action: "drive" }, set: { anim: "sitchair" } },
                 { if: { action: "lie" }, set: { anim: "lie" } }, { if: { action: "kneel" }, set: { anim: "sit" } }, { if: { action: "stand" }, set: { anim: "idle" } }, { absent: ["anim"], set: { anim: "sitchair" } }],
               enums: { anchor: ["hips", "feet", "head", "root", "surface"], leaveBy: ["jump", "menu", "script"] }, units: { exit: "m" },
               absentMeans: { exit: "set down where they got on", input: "the occupant drives nothing: movement keys leave the seat", leaveBy: "moving, jumping or getting up all leave", who: "anyone who may use the host", anim: "the action's default, materialized at write (sit/ride/drive sitchair, lie lie, kneel sit, stand idle); a value stored before 10-17 says pose, renamed anim at load" },
               dropped: { pose: "renamed anim (R 10-17): a write of pose is taken and stored as anim; a stored one is renamed by the world's maintenance command" },
               docs: { action: "the verb use calls it (sit, lie, ride, stand…): a label; at write it picks the default anim", anim: "what the body holds: a pose or clip by name (an open name: one the body doesn't know is its default); {clip, time?: loop|phase, offset?}; or a blend {by: <signal>, clips: [[key, clip], …], time?, offset?}",
                 anchor: "the body point that lands on the socket: root (where every seat put a body), hips, feet, head, or surface (the body's measured seat contact)", exit: "where they're set down, [x, y, z] or [x, y, z, yaw] in its host's frame", leaveBy: "jump | menu | script: how the occupant may leave (script: only when the world lets go; the occupant's escape, a held get-up or a second one, always works)", who: "who may take it: a role id (this rank or above)",
                 input: "{move: 'drive'}: this seat's occupant drives its host (the host's drive); only on a drive station, one per host" },
               reservedFields: ["poses", "sync", "approach", "enter", "leave", "reach", "look", "fromSeat"],
               help: "what a person's body does at this socket (only on a socket entity): {action (default sit: what use calls it), anim (a pose or clip by name, open: one the body doesn't know is its default; {clip, time?, offset?}; or a blend {by, clips}; absent, picked from the action at write: sit/ride/drive sitchair, lie lie, kneel sit, stand idle, else sitchair), anchor (root, the default | hips | feet | head | surface), exit? [x, y, z(, yaw)] (its host's frame), leaveBy? (jump | menu | script; absent, any way; script makes leaving deliberate, never impossible: holding X ~1.5 s, a second get-up, or an agent's detach {escape: true} always gets the occupant up), who? (a role id: this rank or above)}. input? {move: 'drive'} (this seat drives its host's drive: the helm). Reserved for later (refused now): poses, sync, approach, enter, leave, reach, look, fromSeat" },
  // the numbers a thing exposes to the bodies on it, the ONE signal store (shape audit 10-16: no `param.*` keys in other
  // components): a seat pose blends by the signal param.<name>; scripts write them with world.param(id, name, n)
  // where a thing goes back to (R 10-10): {pos, q?, scale?, parent?: {to}} in its home parent's frame. The ONE home (shape
  // audit 10-16: grabbable.home is gone): a reset, a grabbable's release: return and its returnAfter all read this.
  home:      { on: "thing", refPaths: { "parent.to": "ref" }, fields: { pos: "vec3", q: "array", scale: "vec3", parent: "object" }, required: ["pos"],
               absentMeans: { scale: "its size in the world is kept as it is when it goes home", q: "no turn: [0, 0, 0, 1]", parent: "goes home under no parent (the world root)" }, units: { pos: "m" },
               docs: { pos: "where it goes back to, [x, y, z] in its home parent's frame", q: "which way it faces at home, [x, y, z, w]", scale: "its size at home, [x, y, z] (1 is the model as made); a number is taken and stored as one", parent: "what it hangs under at home: {to}" }, help: "where it goes back to when a reset sends it home, or a grabbable returns: {pos: [x,y,z], q?: [x,y,z,w], scale? [x,y,z] (else its size in the world is kept), parent?: {to}} (its home parent's frame). Stamped where it stands when a reset handler naming it, or a returning grabbable, is written without one" },
  // named places to walk to (shape audit 10-16): a closed entry, checked at the door; `kind` is gone (a seat is a station,
  // a door a reading of the model). Frame: the thing's full transform (pos, q, scale); on @world, world coordinates.
  places:    { map: "any", keyPattern: "^[A-Za-z0-9_][A-Za-z0-9_ .:'-]{0,47}$", units: { at: "m", min: "m", max: "m" },
               docs: { at: "a spot to stand, [x, y, z] in the thing's own frame (its y the floor there)", min: "a room's low corner (its y the floor)", max: "a room's high corner", label: "how it reads, ≤ 80 characters" },
               help: "{<name>: {at: [x, y, z]} | {min: [x, y, z], max: [x, y, z]} | null}, each with label? (how it reads, ≤ 80); nothing else: named places to walk to (move {to: '<thing>/<name>'}, or the name alone), in the thing's own frame so they move with it (on @world: world coordinates, places that belong to no thing). at is a spot to stand (its y the floor there); min/max a room (its min y its floor; look says which room you're in); null hides a place the model's own file declares (its glTF extras `building`). name_place {name} names the spot where you stand" },
  params:    { on: "thing", map: "number", keyPattern: "^[a-z][a-zA-Z0-9_-]{0,31}$", maxKeys: 64, help: "{<name>: number}: up to 64 named numbers this thing exposes (a name: a lowercase letter, then letters, digits, _ or -, up to 32). A socket's pose blends by one as the signal param.<name>; a script writes one with world.param(id, name, number)" },
  // shape audit 10-16: the handler kinds are FROZEN (VRChat SDK2's lesson: an action set that grows without end, then a hard
  // break) and pinned with their args; anything new goes to the script handler. `impulse` is reserved: it had a general name
  // and a pendulum-only meaning, and comes back with its general one when an engine carries impulses. One action namespace
  // per thing: a reaction key never equals a station action of its own sockets (the door refuses the clash).
  reactions: { refPaths: { "*.targets": "refs" }, help: "{<action>: handler}: what happens when someone uses it. Each handler may add who: a role id (who may use it: that rank or above) and fix: text (shown on refusal). The kinds are fixed: toggle, set, script, play, reset (anything else is a script); impulse is reserved. An action never shares its name with a station action of the thing's own sockets.",
    handlers: {
      toggle: { args: { component: "the component to flip (default 'openable')", field: "the true/false field inside it to flip (default 'open' for openable; leave both out for an openable). A named component with no field flips its whole value. The component must be on the thing when the handler is written", unless: "a field of the same component that, when true, bars it (e.g. 'locked')" }, example: { open: { kind: "toggle", component: "openable", field: "open", unless: "locked" } } },
      set: { args: { component: "which component", field: "optional: the field inside it to set (the component must then be on the thing)", value: "the value it gets (checked when the handler is written, as the authority would check that write)" }, example: { bolt: { kind: "set", component: "openable", field: "locked", value: true, who: "builder" } } },
      // research 41 §3.1: the join between the two tiers. The action list, its `who` gate and its `fix` stay data; only
      // the effect is computed, by the script:<name> on the same thing, with its sponsor's rights narrowed to its scope
      script: { args: { script: "the name of a script on this same thing (its component is script:<name>)" }, example: { ring: { kind: "script", script: "bell" } } },
      // batch 2: a doorbell plays its sound again from the top, whether or not it's playing (set can't restart it, toggle
      // would stop it): the authority writes sound {…, playing: true, t0: now}
      play: { args: {}, example: { ring: { kind: "play" } } },
      // R 10-10: a reset button (VRChat's shape: each thing remembers a home, a button lists what it sends home; research
      // notes/eidoverse/RESEARCH-grips-and-reset-2026-10-10.md). Each target goes back to its home component, out of any hand; a target with no home, gone or locked is skipped and named in the reply.
      // main's script-free swing (Mica 10-31, decision row 19): use pushes a pendulum (motion pendulum; absent, the default one)
      impulse: { args: { strength: "m/s at its centre along its front (default 0.5)", angular: "or the push as rad/s of swing (main's {impulse: n})" }, example: { push: { kind: "impulse", strength: 0.5 } } },
      reset: { args: { targets: "the ids it sends home: 1 to 64 things. Each needs a home (stamped where it stands when the handler is written, if it has none)" }, example: { reset: { kind: "reset", targets: ["ball-0", "ball-1"] } } },
    },
    reservedKinds: {},
    common: { kind: "the handler kind", who: "who may use it: a role id (builtin or this world's own), that rank or above; absent, anyone who may use the thing", fix: "text shown on refusal" } },
  // R 10-07: the behaviour is `openable` (a door, a gate, a lid, a hatch, a cabinet), not the asset. The conventional shape
  // (Unity/Godot/Roblox door recipes, Unreal's door timeline): a turn about a hinge (angle about axis, through the thing's
  // pivot) or a slide, tweened over a time (Roblox TweenInfo's default 1 s). `open` is the state; every client animates to it
  openable:  { on: "thing", fields: { open: "bool", locked: "bool", angle: "number", axis: "axis", slide: "vec3", time: "number", part: "string" },
               defaults: { open: false, locked: false, time: 1 }, when: [{ absent: ["slide"], set: { angle: Math.PI / 2, axis: [0, 1, 0] } }],
               ranges: { angle: { min: -Math.PI, max: Math.PI }, time: { min: 0, max: 10 }, slide: { min: -10, max: 10 } },
               units: { angle: "rad", slide: "m", time: "s" },
               docs: { open: "its state now; anyone using it flips this (its reactions); false reads the same as absent", locked: "bars opening while on (an open handler with unless: 'locked'): the door's own lock for the people using it; pinning it in place is the Lock component's; false reads the same as absent",
                 angle: "how far it turns when open, radians; negative turns the other way", axis: "the hinge axis in its own frame: y an upright hinge (a door), x a lid or a hatch", slide: "how far it moves when open, [x, y, z] metres in its own frame (instead of turning)",
                 time: "seconds to open or close", part: "a node of its model that moves instead of the whole thing" },
               help: "it opens and closes when someone uses it: a door, a gate, a lid, a hatch. {open: true/false (its state), locked? (true bars an open handler with unless: 'locked'; the edit lock is the separate `lock`), angle? (rad it turns when open, default π/2; negative turns the other way), axis? (its own frame, default [0,1,0]: an upright hinge), slide? [x,y,z] (m it moves in its own frame when open, instead of turning), time? (s to open or close, 0–10, default 1), part? (a node of its model that moves instead of the whole thing)}. It turns about its pivot (pivot {pos}: put it on the hinge edge). Usable with reactions {open: {kind: 'toggle', unless: 'locked'}} (toggle's default flips openable.open)" },
  // spec/PHYSICS.md §3.1–§3.2 (research physics-seeds 10-07, seeds 3–4): shape has a grammar (shared/protocol/shapes.js).
  // Shape audit 10-16 (physics-motion §5): kind is REQUIRED (no default: a bare {} was "dynamic" while the component's
  // absence means static or nothing, the trap PROTOCOL §9.2's last rule names); the eight physical properties nothing here
  // reads are RESERVED fields (mass and density stay open: the body shove reads them) (named, unit-ed and their absence written down, so the first engine that reads them can't
  // invent either; refused until one does, so nobody tunes numbers nothing honours); layers, mask and ccd are cut (filters
  // come back as named groups, KHR's collisionSystems; ccd is a solver knob no format maps). `material` is renamed
  // `surface` (it names a surface:<name>; `material` means appearance). Angular velocity everywhere (acts, launches, state
  // samples) is w: [x, y, z] rad/s in the world frame.
  physics:   { on: "thing", fields: { kind: "string", who: "any", shape: "any", mass: "number", density: "number" }, required: ["kind"],
    grammar: { shape: "shape" },   // `any` is the pinned type of every value ever stored; the grammar narrows what may be written
    enums: { kind: ["dynamic", "static", "none", "kinematic"] },
    when: [{ if: { kind: "dynamic" }, set: { who: "member" } }],   // shared/grab.js DEFAULT_WHO, written down
    // mass and density stay OPEN: the body shove reads them (shared/shove.js massOf: the authority's shove gate, the walker,
    // the agent), so they are not unread. The other eight have no reader
    reservedFields: ["surface", "friction", "restitution", "frictionCombine", "restitutionCombine", "linearDamping", "angularDamping", "centerOfMass"],
    dropped: { layers: "32-bit collision layers: cut (filters return as named groups)", mask: "the layers it collides with: cut", ccd: "swept collision: cut (eidosim sweeps every body)", material: "renamed surface (it names a surface:<name>)" },
    ranges: { mass: { gt: 0, max: 1e6 }, density: { gt: 0, max: 1e5 } }, units: { mass: "kg", density: "kg/m³" },
    docs: { kind: "dynamic (falls, tumbles, can be pushed) | static (never moves) | kinematic (moves only by its motion, an edit or a script, pushes others; what the authority stamps on a thing with motion or openable) | none (not simulated: the engine never moves it). Whether it is solid is collider.enabled's, never the kind's", who: "who may punt it (and pick it up when it has no grabbable): a role id, this rank or above",
      shape: "its collision shape, measured from its model by the authority (you never send it)",
      mass: "how heavy it is, kg (a body's shove reads it; eidosim's flight doesn't yet); blank: its density × its size", density: "kg/m³; blank: water's (1000)" },
    absentMeans: {
      shape: "no measured shape: the thing is no body to the engine (it neither flies nor collides)",
      mass: "kg; absent, density × the volume of its stamped shape at its scale (shapes.js shapeVolume; shared/shove.js massOf). Today that shape is its measured bounding box, so a chair weighs as a solid box of its density; eidosim's flight computes the same (shared/sim.js: 1000 kg/m³ × its box) and reads no mass yet. Never a constant",
      density: "kg/m³; absent, its surface's density, else 1000 kg/m³ (water: eidosim's, shared/sim.js DENSITY)",
      // reserved fields (refused today): their absence is today's behaviour, and stays their meaning of absence
      surface: "a surface:<name> on @world; absent (or naming no surface there now), friction and restitution are its own fields', else the engine's own law",
      friction: "≥ 0, one coefficient (static = dynamic); absent, its surface's, else the engine's own law (eidosim: its fixed constants)",
      restitution: "0..1; absent, its surface's, else the engine's own law (eidosim: its fixed bounce)",
      frictionCombine: "average|min|multiply|max, how its friction meets another's (the later in that list wins, PhysX's priority); absent, its surface's, else average",
      restitutionCombine: "average|min|multiply|max, as frictionCombine; absent, its surface's, else max",
      linearDamping: "1/s; absent, the engine's own law (eidosim: none)",
      angularDamping: "1/s; absent, the engine's own law (eidosim: none; it doesn't spin)",
      centerOfMass: "[x, y, z] m in its own frame before scale; absent, the centroid of its stamped shape" },
    help: "how it takes part in physics: {kind (required): dynamic (it flies when thrown, dropped or punted; with no grabbable it can also be picked up) | static (a collider; what anything with a model becomes when the world runs physics) | kinematic (a collider moved only by edits and motion, never by the engine; it is never launched; what a thing with motion or openable is stamped) | none (not simulated: the engine never moves it; still solid: collision off is collider {enabled: false}), who: who may punt it (and pick it up, when it has no grabbable; default member), shape: stamped by the authority (its measured box; you never send it)}. mass (kg; absent: density × its box's volume) and density (kg/m³; absent 1000), which a body's shove reads. Reserved until an engine reads them (refused now): surface (a surface:<name> on @world), friction, restitution (0..1), frictionCombine, restitutionCombine (average|min|multiply|max), linearDamping, angularDamping (1/s), centerOfMass [x,y,z]. Grabbable makes a thing carryable; physics makes it fall. With eidosim (gravity [0, −9.81, 0] m/s²): a thrown thing flies, tumbles, rolls if it's a sphere, and comes to rest; it knocks over dynamic things it hits unless a lock holds them (their own, or one on what they're under or what they hold)" },
  // what a hand may do with it (research RESEARCH-grab-2026-10-06; shared/grab.js holds the shape, the defaults and the
  // check). Its own component, apart from dynamics: a lantern, a key, a book can be carried in a world with no physics.
  // shared/grab.js DEFAULTS, written down: the ones absent by meaning (no grips, no home, no use, a size-chosen pose)
  // stay absent. grab-check pins that these equal grab.js's own.
  grabbable: { on: "thing", fields: { enabled: "bool", who: "any", steal: "bool", range: "number", priority: "int", hold: "string", anim: "string", grips: "object", twoHanded: "bool", carries: "bool",
                 throw: "number", release: "string", returnAfter: "number", fits: "array", use: "any", prompt: "string" },
    // shape audit 10-16: the shape lives here now (grab.js derives its enums from these). Gone: home (the home component is
    // the one home), a grip's bone overrides (hold). Reserved: fx (refused; presence-only particles while use is held)
    enums: { hold: ["auto", "press", "toggle"], release: ["drop", "stay", "return"] },
    // anim (R 10-17 15:09/15:11; was pose, a closed enum): an OPEN name of a pose or a clip. Built in today: hand, carry,
    // torch, pistol, shoulder (grab.js HOLD_POSES); a world's anim-pose/anim-clip later; one the body doesn't know is the
    // body's default hold (by size), never a refusal. two-hand is gone: twoHanded says it.
    dropped: { pose: "renamed anim (R 10-17): a write of pose is taken and stored as anim (two-hand as twoHanded: true); a stored one is renamed by the world's maintenance command" },
    reservedFields: ["fx"],
    // the defaulted fields are materialized on every write since grabbable was registered; an older value without one reads
    // as its default (grab.js fill), written down here so the pin holds that reading too
    absentMeans: { enabled: "true: it can be picked up", who: "member", steal: "true", range: "1.5 m", priority: "0", hold: "auto", twoHanded: "false", throw: "1 (×)", release: "drop", returnAfter: "0 s: never",
      anim: "by size: one hand under 0.5 m, both arms at or above; both hands if twoHanded", grips: "held where it was grabbed", carries: "false: what rests on it falls off when it is picked up",
      fits: "it snaps into no socket", use: "the use button does nothing while it is held", prompt: "Pick up <its label>" },
    defaults: { enabled: true, who: "member", steal: true, range: 1.5, priority: 0, hold: "auto", twoHanded: false, throw: 1, release: "drop", returnAfter: 0 },
    // the hand's own rules (shared/grab.js checkGrabbable) refuse outside these; written here so the inspector reads one source
    ranges: { range: { min: 0.1, max: 10 }, priority: { min: -10, max: 10 }, throw: { min: 0, max: 3 }, returnAfter: { min: 0, max: 3600 }, fits: { maxItems: 8 }, prompt: { maxLen: 40 } }, units: { range: "m", throw: "×", returnAfter: "s" },
    docs: { anim: "how a body without tracked hands holds it: a pose or clip by name (hand, carry, torch, pistol, shoulder built in); one the body doesn't know is held by size", grips: "named places the palm goes, in its own frame: {pos, q?, hand?, role?, grasp?, part?}", carries: "true: what rests on it rides with it when it is picked up", fits: "keywords: it snaps into a socket whose accepts shares one", use: "what the use button fires while it is held: a reactions action, or {down, up}", prompt: "the hover text (≤ 40)", enabled: "off: nobody can pick it up for now (a loose ball can still be punted)", who: "who may pick it up: a role id (this rank or above): member (anyone), builder, owner or this world's own", steal: "on: someone else can take it out of a hand; off: it stays with its holder (owners may still take it)",
      range: "how far from the hand it can be picked up, metres; past arm's reach (1.5) it flies to the hand", priority: "when several things are in reach the highest wins: the key, not the table it sits on", hold: "auto (grip in VR, sticky on desktop) | press (only while gripping) | toggle (sticky everywhere: a tool)",
      twoHanded: "on: both hands may hold it at once (a rifle, a broom): the first carries, the second aims", throw: "how hard it flies when thrown: 1 is normal, 2 twice as fast, 0 can only be dropped", release: "drop (it falls or is set down) | stay (where you let go) | return (it goes home)",
      returnAfter: "left unheld this many seconds it goes home; 0 never" },
    help: "it can be picked up and carried (grab, put, drop, throw; a VR hand's grip; desktop T): {who?: a role id (default member), enabled? (false: not now), steal? (false: nobody takes it from a hand; owners may), range? (m from the hand, 0.1..10, default 1.5; past 1.5 it flies to you), priority? (-10..10: wins when several are in reach), hold?: auto|press|toggle, anim? (how a body without tracked hands holds it: a pose or clip by name; built in: hand, carry, torch, pistol, shoulder; one the body doesn't know, or none, is held by size), grips? {<name>: {pos, q?, hand?: left|right|either, role?: primary|secondary, grasp?: fist|pinch|point|flat|open|trigger, part?}} (where the palm goes, in its own frame; none: held where grabbed), twoHanded?, throw? (0..3, ×the release velocity; 0: drop only), release?: drop|stay|return, returnAfter? (s unheld, then it goes home), fits? [keywords] (snaps into a socket whose accepts shares one), use? (a reactions action, or {down, up}: what the use button fires while held), prompt? (hover text, ≤ 40)}; where it goes home to is its home component (stamped when a returning grabbable has none); fx is reserved. Grabbable makes it carryable; physics {kind: 'dynamic'} makes it fall. A dynamic thing with no grabbable is carryable by physics.who (the rule: absent grabbable, a dynamic thing reads as {who: physics.who})" },
  // shape audit 10-16 (physics-motion §6): tickMs's default lives here (the authority read a literal 33); its range is the
  // engine's (eidosim TICK_MS; tools/shape-physics-test holds them equal); build is the authority's stamp, a string. Gravity
  // is the engine's own, not in the log (eidosim: [0, −9.81, 0] m/s²): a field is an addition once an engine reads one
  // recut B3 (house 22:03Z: "starter config, switched on"): two world settings the authority reads at decision time.
  "body-default": { on: "world", fields: { move: "bool", touch: "bool", range: "number" }, ranges: { range: { min: 0.5, max: 10000 } }, units: { range: "m" },
    absentMeans: { move: "true: an untouched body may be moved (shoved, dragged, carried, seated)", touch: "false: an untouched body may not be touched or posed", range: `no limit: the server forwards a puppet or a grab ${bodyRangeWords(BODY_RANGE)}` },
    docs: { move: "the move gate an untouched body has here: being shoved (a /boom's force too), dragged, carried, seated or occupied", touch: "the touch gate an untouched body has here: being touched (intimate points too) and posed", range: "how near (m, between the two bodies) someone must be for the server to forward their knock-over, pose or grab of another body; consent still decides" },
    help: "the two consent gates a body that never chose has in this world: {move?, touch?, range?}, gates true or false (absent: move on, touch off); range (m) limits how far away a knock-over, pose or grab of another body may come from (absent: no limit). A person's own gates, and their allow and block lists, always win (PROTOCOL §5, Body consent)" },
  "keep-owner": { on: "world", type: "bool", help: "absent or true: the authority refuses a change that would leave this world with no owner ('last-owner'). false: an owner may leave it ownerless on purpose (the host operator can still mend it). Starter config, switched on" },
  "physics-engine": { on: "world", fields: { engine: "string", tickMs: "int" }, required: ["engine"], defaults: { tickMs: 33 },
    ranges: { tickMs: { min: 16, max: 1000 } }, units: { tickMs: "ms" },
    docs: { engine: "the engine and its version, name@semver (eidosim@1.0.0); a request may name the engine alone (eidosim), and the authority stamps the version it carries. A version is what its conformance digests say it computes (spec/conformance/physics/)", tickMs: "milliseconds a step (33 = 30 steps a second)" },
    absentMeans: { gravity: "not a field: the engine's own (eidosim: [0, −9.81, 0] m/s², world frame)" },
    help: "on @world only (owner): the physics engine this world runs: {engine: 'eidosim' or 'eidosim@1.0.0', tickMs? (ms a step, default 33)}. Name no version and the authority stamps the one it carries. Gravity is the engine's own (eidosim: [0, −9.81, 0] m/s²). Delete it to turn physics off (refused while things are in flight)" },
  // spec/PHYSICS.md §3.2: a world's named surface materials (Marrow's Surface Data Cards: one name bundles a surface's
  // physical numbers; SLZ's format names materials, not raw per-object numbers). physics.surface names one. Reserved with
  // physics' reserved fields (shape audit 10-16): no engine reads either, so neither is written yet; both open together.
  // The combine modes and their order are PhysX's, Unity's and Rapier's (COMBINE, above); KHR_physics_rigid_bodies names the
  // same four (minimum, maximum) but resolves a mismatch the other way round (average first), so an importer resolves per
  // pair, never per mode
  surface:   { status: "reserved", instead: "nothing yet: no engine here reads surfaces (eidosim's friction and bounce are its own constants)", on: "world", keyed: true, key: "instance",
               help: "reserved (refused until an engine reads surfaces): on @world, keyed by name, a surface material things name with physics.surface; no shape is pinned until a world needs one (a sketch: docs/RESERVED-SHAPES.md)" },
  // spec/PHYSICS.md §3.3: the constraint between two bodies is `physics-joint` (OMI_physics_joint; it sits beside physics and
  // physics-engine). R 15:04: `joint` is the skeleton node (Maya, glTF, VRM: an avatar's entity tree), below. Both reserved:
  // one anchor can't carry the two frames every engine and glTF/OMI use, so no fields are pinned (the target shape is
  // sketched in PHYSICS §3.3, not here). parent is a rigid attachment, never a solver joint; openable is kinematic animation
  "physics-joint": { status: "reserved", instead: "parent {to} attaches rigidly; openable animates a door, lid or gate; motion swings a pendulum (PHYSICS §3.3)", on: "thing", keyed: true, key: "instance",
               help: "reserved (refused until this world's engine carries joints): keyed by name, a physical constraint between this thing and another (OMI_physics_joint: two frames, one on each body, with limits and drives; PHYSICS §3.3 sketches the shape)" },
  joint:     { status: "reserved", instead: "nothing yet: a skeleton's nodes come with avatar entity trees", on: "thing",
               help: "reserved: a skeleton node (Maya's joint, glTF's skin joint, a VRM humanoid bone): an entity that is one bone of an articulated body, for avatar entity trees. Not the physics constraint (that is physics-joint)" },
  // server-written (shape audit 10-16): a hand set below owner is refused (a forged copy-of mis-routes a rebase)
  "copy-of": { on: "thing", fields: { from: "string", key: "string" }, required: ["from", "key"], grammar: { from: "sha256" }, writtenBy: "server",
               docs: { from: "the blueprint record it was copied from, sha256:<64 hex>", key: "which part of that record it is" }, help: "set by the server on copies (never by hand below owner): {from: the record's hash sha256:<64 hex>, key: its part key in that record}" },
  // a sound a thing plays (shared/sound.js; batch 2, 10-07): silent AT radius (a true taper to zero, not Web Audio's clamp,
  // which leaked about −21 dB across the whole world), cap 200 m (R 10-28; = shared/sound.js SOUND_MAX_RADIUS), near ≤ radius (valueCheck), the authority stamps t0 when it
  // starts. src: this server's store, an allowlisted host's https link (everyone hears it), or another https link (only
  // viewers who allow untrusted links hear it; shared/mediasrc.js). Registered so it isn't refused as a near-miss of bounds
  sound:      { on: "thing", fields: { src: "string", playing: "bool", loop: "bool", volume: "number", pitch: "number", near: "number", radius: "number", spatial: "bool", t0: "number", description: "string" },
                defaults: { playing: true, loop: true, volume: 0.8, pitch: 1, near: 1.5, radius: 12, spatial: true }, required: ["src"],
                ranges: { volume: { min: 0, max: 1 }, pitch: { min: 0.5, max: 2 }, near: { gt: 0, max: 200 }, radius: { min: 1, max: 200 }, src: { maxLen: 2048 }, description: { maxLen: 200 } }, clean: { description: "line" },
                units: { near: "m", radius: "m", t0: "ms" },
                // pinned (shape audit 10-16, render-media-env §6): the distance law every client hears (shared/sound.js gainAt);
                // a future curve choice is an addition (rolloff, absent = this law)
                absentMeans: { description: "no description: a reader gets the file name", law: "gain = min(1, near / distance) (inverse distance, full volume inside near), then a (1−t)² taper over the last 5% of radius to exactly 0 at radius: shared/sound.js gainAt" },
                docs: { src: "the sound file: store/audio/…, eidoverse/assets/…, or an https link", playing: "it plays now (false: paused)", loop: "plays again when it ends", volume: "linear amplitude gain (not dB): 0 silent to 1 full", pitch: "playback rate: 2 = an octave up and twice as fast",
                  near: "full volume within this many metres", radius: "silent at and beyond this many metres: nobody further hears it at all", spatial: "positional; off: heard evenly everywhere inside its radius (room tone, music in a hall)", t0: "when it started, epoch ms (the authority stamps it)",
                  description: "what is playing, in words: for people who can't hear it and for agents" },
                help: "a sound this thing plays: {src (store/audio/…, eidoverse/assets/…, or an https link: an allowlisted host's plays for everyone, any other only for viewers who allow untrusted links), playing? (default true), loop?, volume? 0..1, pitch? 0.5..2 (playback rate), near? m (full volume inside it), radius? m (≤ 200: silent at and beyond it; inverse distance from near, a (1−t)² taper over the last 5% to 0 at radius), spatial? (false: heard evenly inside radius, no panning), t0? (stamped by the authority when it starts), description? (what is playing, in words: what agents and people who can't hear it read)}. A reaction {kind: 'play'} plays it again from the top" },
  // an image on a thing (shared/picture.js; batch 2): a framed quad of its own (width m, height from the image's aspect,
  // facing +Z on its origin). src as sound's, for images. Shape audit 10-16 (render-media-env §5): texturing one node of a
  // model (part, flip) is the `material` component's, not a picture of its own: both are cut (0 stored)
  picture:    { on: "thing", fields: { src: "string", width: "number", description: "string", lit: "string" },
                defaults: { lit: "scene", width: 1 }, required: ["src"], enums: { lit: ["scene", "self"] },
                dropped: { part: "an image on a node of a model is the material component's (a picture is a quad of its own)", flip: "a node's image is the material component's, with its node" },
                ranges: { width: { gt: 0, max: 20 }, src: { maxLen: 2048 }, description: { maxLen: 200 } }, clean: { description: "line" },
                units: { width: "m" }, absentMeans: { description: "no description: a reader gets the file name" },
                docs: { src: "the image: store/images/…, eidoverse/assets/…, or an https link", width: "the quad's width, metres; its height follows the image", description: "what it shows, in words: for people who can't see it and for agents",
                  lit: "scene (takes the scene's light) | self (a screen, unlit)" },
                help: "an image on this thing: {src (store/images/…, eidoverse/assets/…, or an https link: see sound), width? m (the quad's, facing +Z on its origin; its height follows the image), description? (what it shows, in words: for people who can't see it and for agents), lit?: scene|self (self = a screen, unlit)}. To put an image on a node of its model: the material component" },
  // an image on a NAMED node of its model (R 10-27; shared/material.js): glTF's baseColorTexture on that node's material,
  // Godot's surface_material_override. The host wears a clone and restores the original on removal (client/lib/materialcomp.js)
  material:   { on: "thing", fields: { node: "string", texture: "string", description: "string", lit: "string" },
                defaults: { lit: "scene" }, required: ["node", "texture"], enums: { lit: ["scene", "self"] },
                ranges: { node: { maxLen: 64 }, texture: { maxLen: 2048 }, description: { maxLen: 200 } }, clean: { description: "line" },
                absentMeans: { description: "no description: a reader gets the file name" },
                docs: { node: "the node of its model the image goes on, its name as the file spells it (measure lists them)", texture: "the image: store/images/…, eidoverse/assets/…, or an https link (as a picture's src)",
                  description: "what it shows, in words: for people who can't see it and for agents", lit: "scene (takes the scene's light) | self (a screen, unlit)" },
                help: "an image on one node of this thing's model (a screen, a canvas, a poster frame): {node (its name, as the model file spells it: measure lists them), texture (store/images/…, eidoverse/assets/…, or an https link: see picture), description? (what it shows, in words: for people who can't see it and for agents), lit?: scene|self (self = a screen, unlit)}. The node's own material comes back when it is removed. A standalone image is a picture" },
  // why a thing is here (batch 2; R: {title, text, marks?}): a museum label's title and text. Who wrote it is a view over
  // the log (History), never stored. The world's own blurb is @world.about
  story:      { on: "thing", fields: { title: "string", text: "string", marks: "refs" }, required: ["title", "text"],
                ranges: { title: { maxLen: 80 }, text: { maxLen: 1000 }, marks: { maxItems: 8 } }, clean: { title: "line", text: "lines" },
                docs: { title: "its headline, ≤ 80 characters", text: "why it is here, ≤ 1000 characters of plain text, a blank line between paragraphs", marks: "what it marks or commemorates: up to 8 things' ids" },
                help: "why this thing is here, a museum label: {title (≤ 80), text (≤ 1000; plain text, a blank line between paragraphs), marks? [ids] (≤ 8: what it marks or commemorates)}. Shown on Inspect and in look" },
  // words in the world (batch 2): signage, on the canvas text path (a browser font stack: CJK, RTL and emoji). Long-form
  // text (a book, a library) will be its own component; this one stays a sign
  text:       { on: "thing", fields: { text: "string", size: "number", width: "number", align: "string", color: "int", outline: "bool", outlineColor: "int", background: "int", billboard: "string", lit: "string" },
                absentMeans: { outlineColor: "the edge takes the colour that contrasts with the text colour: black behind light text, white behind dark",
                  anchor: "the block is centred on its origin in its local X–Y plane, facing +Z (horizontally by align's box of width, vertically on the middle of its lines): pinned (shape audit 10-16)" },
                defaults: { size: 0.15, width: 2, align: "center", color: 0xffffff, outline: true, billboard: "off", lit: "self" }, required: ["text"],
                enums: { align: ["left", "center", "right"], billboard: ["off", "yaw", "full"], lit: ["self", "scene"] },
                ranges: { text: { maxLen: 400 }, size: { min: 0.02, max: 2 }, width: { min: 0.1, max: 10 }, color: { min: 0, max: 0xffffff }, background: { min: 0, max: 0xffffff }, outlineColor: { min: 0, max: 0xffffff } }, clean: { text: "lines" },
                units: { size: "m", width: "m" },
                docs: { text: "what it says, ≤ 400 characters and ≤ 16 lines", size: "the height of a line, metres", width: "where lines wrap, metres", align: "left | center | right", color: "the letters' colour, 0xRRGGBB", outline: "an edge around the letters, so they read on any background",
                  outlineColor: "the edge's colour, 0xRRGGBB; left alone, the one that contrasts with the text colour", background: "a plate behind the words, 0xRRGGBB; absent: none", billboard: "off (flat, readable from both sides) | yaw (turns to face each viewer) | full (always faces each viewer)", lit: "self (glows, unlit) | scene (takes the scene's light)" },
                help: "a sign: {text (≤ 400 characters, ≤ 16 lines), size? (line height, m; 0.02..2), width? (wrap width, m; 0.1..10), align?: left|center|right, color? 0xRRGGBB, outline? (a contrasting edge), background? 0xRRGGBB (a plate behind it; absent = none), billboard?: off (flat, facing +Z, readable from both sides) | yaw (turns about up toward each viewer) | full (faces each viewer, kept upright), lit?: self|scene}" },
  // a thing (or one part, look-at:<part>) turns to face something (batch 2; Unity AimConstraint, Blender Locked/Damped
  // Track, Resonite LookAt). State is logged; the turn is a view each client computes, like motion
  // shape audit 10-16: radians (PROTOCOL §9.2) and axes stored as vectors (a letter is taken at write and stored as its
  // vector); offset is gone (speculative, unused)
  "look-at":  { on: "thing", keyed: "optional", fields: { target: "target", mode: "string", forward: "axis", up: "axis", yaw: "array", pitch: "array", speed: "number", range: "number" },
                defaults: { mode: "yaw", forward: [0, 0, 1], up: [0, 1, 0], speed: 240 * Math.PI / 180, range: 12 }, required: ["target"], enums: { mode: ["yaw", "aim"] },
                ranges: { speed: { min: 0, max: 20 * Math.PI }, range: { gt: 0, max: 100 }, yaw: { min: -Math.PI, max: Math.PI }, pitch: { min: -Math.PI / 2, max: Math.PI / 2 } },
                units: { speed: "rad/s", range: "m", yaw: "rad", pitch: "rad" },
                docs: { target: "what it turns to face: a thing's id, @viewer (each viewer's own eyes), @nearest (whoever is nearest within range), or a person's identity", mode: "yaw (turns about its up only, stays upright) | aim (tilts too)", forward: "which of its own axes points at the target, [x, y, z] (a letter x, y or z is taken and stored as its vector); [0, 0, 1] is its front",
                  up: "its up axis, [x, y, z]", yaw: "[min, max] radians it may turn from rest, within ±π", pitch: "[min, max] radians it may tilt from rest, within ±π/2", speed: "radians a second; 0 = turns at once", range: "a person further than this many metres: it turns back to rest" },
                help: "it turns to face something: {target (a thing's id, @viewer: each viewer's own eyes, @nearest: whoever is nearest within range, or a person's identity u-…), mode?: yaw (turns about up only, stays upright) | aim (tilts too), forward? ([x, y, z] in its own frame, default [0, 0, 1], its front; a letter x|y|z is taken and stored as its vector; a negative one is a vector, [0, 0, -1]), up? (default [0, 1, 0]), yaw? [min, max] and pitch? [min, max] (radians from rest), speed? rad/s (default 240°/s; 0 = at once), range? m (a person beyond it: back to rest)}. look-at:<part> turns one model part" },
  // captions (a screen's live subtitles): written only by the caption request, a line at a time (shared/captions.js);
  // who may caption a screen is the screen's own captioners list (R leaned that way, 10-06, as the roles branch's CAPTION_ON_SCREENS does)
  // shape audit 10-16 (render-media-env §11): each caption write holds ITS line, once (WebVTT/TTML store a cue once); the 20-line
  // window re-logged each line up to twenty times, the very cost the caption request was made to remove. A reader wanting
  // the last lines reads the last captions changes (the log is the transcript); mediaTime was line.t1. An older value
  // keeps its lines in `window` (with mediaTime), which captions.js still reads (normalizeCaptions): `fields` names
  // neither, since neither is written now, and `line`'s absentMeans (pinned) is that older window
  captions:   { on: "thing", fields: { session: "string", n: "int", gen: "number", title: "string", line: "object" }, required: ["session", "n", "line"],
                ranges: { title: { maxLen: 120 } }, units: { gen: "the leg's generation" },
               absentMeans: { line: "an older value's window [{t0, t1, text, speaker?}]: its last entry is the line on screen" },
                docs: { session: "the captioning session's id", n: "the line's number in its session", gen: "the generation of the feed", title: "what is playing", line: "the line on screen now: {t0, t1 (seconds of media time), text (≤ 240), speaker? (≤ 48)}" },
                help: "a screen's captions, written by the caption request only: {session, n, gen, title?, line: {t0, t1, text, speaker?}} (the current line; earlier ones are the earlier captions changes)" },
  captioners: { on: "thing", fields: { ids: "people" }, docs: { ids: "the identities who may caption this screen, beside anyone who may edit it" }, help: "who may caption this screen with the caption request: {ids: [<identity u-…>]}; anyone who may edit the screen may caption it too" },
  // round-2 review R8 (2026-10-05): names the engine reads, carried by imported worlds, registered with their old
  // meaning so it's fixed (L5). Fields from every old world log on Burrow, translated. A name not here is a world's own
  // invention (heart, inscription…): admitted, unless it's a near-miss of one of these (ligth).
  // shape audit 10-16 (render-media-env §13): 19 fields → 14. clock and dormantRated (fold bookkeeping) are gone: a tz present
  // means the wall clock governs, and hours/rate/ts stay as the rated fallback; sun, fill and world (never stored) and
  // weatherSeconds (now transition: no unit in a name) are gone; azimuth is radians. ts, override and a forecast's epoch
  // are stamped by the authority's sky and weather acts, never taken from a writer (stamped). The forecast's segment law is
  // forecast@1: shared/forecast.js's draw order (dwell, then state, then intensity) at this commit; a changed law is a new name
  sky:       { on: "world", fields: { hours: "number", rate: "number", ts: "number", tz: "string", clouds: "string", weather: "string", weatherK: "number", transition: "number", azimuth: "number", fog: "number", exposure: "number", ambient: "number", forecast: "object", override: "object", gradient: "object", system: "string", colors: "object", audio: "bool" },
               defaults: { hours: 12, rate: 0, clouds: "cumulus", azimuth: Math.PI, fog: 1, exposure: 1, ambient: 1 },
               enums: { clouds: ["clear", "cumulus", "stratus", "cirrus"], weather: ["clear", "fair", "sunshower", "overcast", "rain", "storm", "cyclone", "darkstorm"], system: ["eidoverse", "skymesh"] },
               stamped: ["ts", "override", "forecast.epoch"],
               dropped: { clock: "a tz present means the wall clock governs: {tz: 'Europe/Paris'}", dormantRated: "fold bookkeeping: hours and rate stay put as the fallback clock", sun: "a knob on the renderer's own light rig (never stored)", fill: "a knob on the renderer's own light rig (never stored)", world: "a one-member enum (earth), never stored", weatherSeconds: "renamed transition (seconds)" },
               ranges: { hours: { min: 0, max: 24 }, rate: { min: -1000, max: 1000 }, azimuth: { min: -2 * Math.PI, max: 2 * Math.PI }, fog: { min: 0 }, exposure: { min: 0 }, ambient: { min: 0 }, transition: { gt: 0, max: 600 }, weatherK: { min: 0, max: 2 }, tz: { maxLen: 64 } },
               units: { hours: "h", rate: "world hours per real hour", ts: "ms", azimuth: "rad", transition: "s" },
               absentMeans: { tz: "no wall clock: hours, rate and ts govern the day", weather: "no authored weather (a forecast may still say one)", weatherK: "1: full intensity", transition: "the renderer's own ease (30 s in a forecast)",
                 forecast: "no forecast: the authored weather holds", override: "no manual weather inside the current forecast segment", gradient: "the renderer's own sky (its day, clouds and weather)", system: "eidoverse: the detailed sky", colors: "the sky's own colours", audio: "off: no weather sounds (main's default)", law: "forecast@1: per (seed, segment), drawn in the order dwell, then state, then intensity; spec/conformance/laws.json pins its segments" },
               docs: { hours: "the hour of day at ts, 0 ≤ h ≤ 24", rate: "world hours a real hour (0: the sun stands still)", ts: "the instant hours held, epoch ms (stamped by the authority)", tz: "an IANA time zone: present, the world's hour is that zone's wall clock", clouds: "clear | cumulus | stratus | cirrus", weather: "clear | fair | sunshower | overcast | rain | storm | cyclone | darkstorm",
                 weatherK: "the weather's intensity, 0..2", transition: "how long a change of weather eases in, seconds", azimuth: "where the sun stands round the horizon, radians (π: the default)", fog: "× this renderer's own fog curve", exposure: "× this renderer's tone mapping", ambient: "× this renderer's ambient curve",
                 forecast: "a weather policy {seed, states: [name | {state, weight}], dwell: [min, max] s, k: [min, max], transition: s, epoch (stamped)}", override: "a weather act inside a forecast segment {state, k?, ts} (stamped)",
                 gradient: "a painted sky in place of the day's: {top, horizon, bottom?}, each a linear [r, g, b] 0..1 (OMI_environment_sky gradient; absent bottom = horizon). rate: 0 already pins the clock",
                 system: "eidoverse (the detailed sky) | skymesh (the basic sky, for weak GPUs)", colors: "tints {star? (or sun), cloud?, sky?, fog?, shield?}, each [r, g, b] 0..1 (SWEEP-3 S1, main's)",
                 audio: "plays the asset library's weather sounds (rain, thunder) when this server has them; silent otherwise (main's sky.audio; read when the sky is built)" },
               help: "on @world: the sky and its clock {hours, rate, tz? (present: the wall clock of that zone governs), clouds, weather, weatherK, transition (s), azimuth (rad), fog, exposure, ambient (× this renderer's own curves), forecast?, gradient? {top, horizon, bottom?} (linear [r, g, b] 0..1: a painted sky, OMI_environment_sky; absent bottom = horizon), system? (eidoverse | skymesh: the basic sky), colors? {star, cloud, sky, fog, shield} ([r, g, b] tints), audio? (plays the asset library's weather sounds when this server has them, silent otherwise; absent: off)}. rate: 0 pins the clock. ts, override and forecast.epoch are stamped by the sky and weather acts; the sky act also takes clock: 'real' (stored as tz) and weatherSeconds (stored as transition)" },
  // shape audit 10-16 (render-media-env §14): ONE spelling, the flora one. The first protocol's makeGrass knobs (bladeHeight,
  // spacing, perCell, colorTip, an int colour) are taken at write and stored through the reader's own mapping (flora_args
  // mapGrassArgs), once; a preset is stored by its NAME (R 10-17; Fable #4: expansion is cheap later, un-expansion impossible)
  // and checked at write against shared/flora_presets.js; the reader composes its strokes (flora_args presetStrokes).
  // seed and size were read and refused: registered. colour stays a palette name or a [r, g, b] multiplier: the flora
  // palette's recolors (defs/flora/_colors.json) aren't an sRGB int (deviation from the audit's int)
  grass:     { on: "world", fields: { species: "string", width: "number", depth: "number", size: "number", center: "array", height: "number", density: "number", wind: "number", color: "any", seed: "int", preset: "string", rows: "object", corn: "object", heading: "number", strokes: "array" },
               dropped: { bladeHeight: "the flora spelling is height (a write of the old knobs is taken and mapped)", spacing: "the flora spelling is density", perCell: "the flora spelling is density", colorTip: "the flora spelling is color (a multiplier)" },
               ranges: { width: { gt: 0, max: 1000 }, depth: { gt: 0, max: 1000 }, size: { gt: 0, max: 1000 }, height: { gt: 0, max: 10 }, density: { min: 0, max: 4 }, wind: { min: 0, max: 10 }, strokes: { maxItems: 16 } },
               units: { width: "m", depth: "m", size: "m", height: "m", heading: "rad" },
               absentMeans: { size: "80 m wide and 70 m deep when width and depth aren't given either (a stroke's own: 30 m)", species: "grass", width: "size, else 80 m (a stroke's own: 30 m)", depth: "size, else 70 m (a stroke's own: 30 m)", center: "[0, 0]", height: "the species' own", density: "1", wind: "1", color: "the species' own", seed: "7",
                 strokes: "one stroke: the value itself (a species' own composition, corn's and sunflower's rows, still applies)", preset: "no preset: the value's own strokes, else one stroke", heading: "-0.6 rad for sunflowers (they face one way together)" },
               docs: { species: "what grows (a flora def: grass, corn, sunflower, galleta_dry…)", width: "the field's width, metres", depth: "the field's depth, metres", size: "width and depth when they aren't given, metres", center: "[x, z] of the field's middle, metres", height: "plant height, metres", density: "how thickly it grows (0..4)", wind: "how much it sways (×)", color: "a palette name (defs/flora/_colors.json) or a multiplier [r, g, b]", seed: "the planting's random seed",
                 rows: "a crop's rows {spacing, plant, stride?, phase?}", corn: "corn's own knobs {peel?, peelChance?}", heading: "the way sunflowers face, radians", preset: "a named planting (defs/flora/_presets.json: mojave, …), stored by its name and composed into strokes by the reader; an unknown name is refused", strokes: "the plantings this field is made of: [{species, width, depth, center, seed, density, variant?, footprint?}] (they win over a preset)" },
               help: "a grass or crop field {species, width, depth (or size), center, height, density, wind, color, seed} or {width, depth, seed, strokes: […]}; a preset ({preset: 'mojave'}) is stored by its name and composed by the reader, and the first protocol's knobs (bladeHeight, spacing, perCell, colorTip) are taken and stored in this spelling" },
  // carried from the first protocol, with real readers (shared/structure.js; shape audit 10-16, physics-motion §9): its grid numbers and its nested
  // grammar were only in structure.js (GRID_DEFAULTS, APERTURES, normalize), "a CONTRACT". Pinned here; tools/shape-physics-test
  // holds them equal to structure.js. A level entry a reader can't parse reads as absent (normalize skips it)
  structure: { on: "thing", fields: { tile: "number", wallH: "number", wallT: "number", slabT: "number", labels: "object", levels: "array" },
    defaults: { tile: 1, wallH: 2.8, wallT: 0.15 }, units: { tile: "m", wallH: "m", wallT: "m", slabT: "m" },
    ranges: { tile: { gt: 0, max: 100 }, wallH: { gt: 0, max: 100 }, wallT: { gt: 0, max: 10 }, slabT: { gt: 0, max: 10 } },
    absentMeans: { slabT: "0.10 m (structure.js GRID_DEFAULTS; never written by the editor)" },
    nested: { levels: "[{y (m), tiles: [[x int, z int, mat?, half?: A|B]], walls: [[axis 0..3, x int, z int, mat?]], apertures: [[axis 0..3, x int, z int, kind]]}]", labels: "{<cellKey>: string}" },
    nestedEnums: { "levels[].apertures[][3]": ["door", "window", "arch"], "levels[].walls[][0]": [0, 1, 2, 3], "levels[].apertures[][0]": [0, 1, 2, 3], "levels[].tiles[][3]": ["A", "B"] },
    docs: { tile: "metres a cell", wallH: "wall height, floor to floor, metres", wallT: "wall thickness, metres", slabT: "floor slab thickness, metres (its top at the level's y)", labels: "room names by cell", levels: "the storeys: tiles, walls on cell edges, apertures (door, window, arch) in walls" },
    help: "a built structure's plan (The Sims' grid: walls on cell edges) {tile (m, default 1), wallH (m, default 2.8), wallT (m, default 0.15), slabT? (m; absent 0.10), levels: [{y, tiles: [[x, z, mat?, half?]], walls: [[axis 0..3, x, z, mat?]], apertures: [[axis, x, z, door|window|arch]]}], labels: {<cell>: name}}" },
  // R 10-07: "not the kitchen sink style for particles". The instance is tiny and names an effect document (the
  // Niagara / Godot / bevy_hanabi shape; shared/particle_effects.js): an Essentials name or a stored document's content
  // address, with the document's own params. The first protocol's bag (preset, origin, count, quality, size, area,
  // texture, speed, opacity, lifetime) stays here because a stored value is read forever (PROTOCOL §4): it reads as
  // {effect: preset, at: origin, params: {count, …}} (instanceOf), and the authority no longer takes it in a write
  // R 10-17: an Essential is stored by its NAME, as written (the code that ships it resolves it everywhere, as a library path
  // does a model). An Essential's pinned address (shared/particle_effects.js ESSENTIAL_ADDRESSES), stored for a day by this
  // branch's door, still reads as that Essential. The first protocol's ten fields are gone from
  // the registry: no current value holds them; a first-protocol bag is read (instanceOf) only by the translator
  particles: { on: "thing", fields: { effect: "string", part: "string", at: "vec3", seed: "number", playing: "bool", scale: "number", params: "object" },
               defaults: { playing: true, scale: 1 }, required: ["effect"],
               // lead 10-17: held for a synced start instant (as sound.t0), so every viewer fires a one-shot or a burst together
               reservedFields: ["t0"],
               reservedWhy: { t0: "a synced start instant (epoch ms, as sound.t0) so every viewer fires a one-shot or a burst together" },
               ranges: { scale: { min: 0.01, max: 100 }, part: { maxLen: 64 }, effect: { maxLen: 80 }, at: { min: -8, max: 8 } },
               units: { at: "m", scale: "×" },
               docs: { effect: "an Essentials name (fire, sparks, embers, smoke, dust, snow, magic, stars, muzzle), stored as written, or the content address sha256:<64 hex> of a document uploaded here (an Essential's eido:sha256/… address stored before 10-17 still reads as that Essential)", part: "a node of its model it emits from", at: "where it emits, [x, y, z] metres in its own frame, each within ±8", seed: "the random seed; absent: derived from its id",
                 playing: "off: no new particles; the living finish", scale: "every length in the effect (positions, sizes, speeds, accelerations) × this, on top of the thing's own transform scale; 0.01..100", params: "the effect's own knobs {<name>: value}" },
               absentMeans: {
                 part: "it emits from the thing itself, not one node of its model",
                 at: "[0, 0, 0] in its own frame",
                 seed: "derived from its id and its effect's name (hashSeed(`${id}:${name}`))",
                 playing: "playing: it emits (the component's presence was its state)",
                 scale: "1: the effect at its own size",
                 params: "none: the effect's own defaults" },
               help: "it emits particles: {effect (an Essentials name, fire, sparks, embers, smoke, dust, snow, magic, stars, muzzle, or a document of your own by its address: upload {effect: {…}} stores one, sha256:<64 hex>), part? (a node of its model it emits from), at? [x, y, z] (m in its own frame, ±8), seed? (absent: derived from its id), playing? (false: no new particles; the living finish), scale? (0.01..100: every length in the effect × this, on top of the thing's own scale), params? {<name>: value} (the effect's own knobs, schema {component: 'particles'} and the inspector list them; every Essential takes count, size, opacity, speed, lifetime, area, texture, quality)}. An effect document is emitters of modules: spawn, shape, velocity, forces, rotation, size, color, render (spec in shared/particle_effects.js: angles in radians, gravity world-down, every other vector in the emitter's frame; a trial format, expected to grow)" },
  "imported-behavior": { on: "world", keyed: true, key: "instance", fields: { src: "string", attach: "ref", caps: "object", knobs: "object", author: "string", ts: "number", state: "object" }, docs: { src: "the old script's source, as the translation carried it", attach: "the thing it was bound to", caps: "the capabilities it was granted", knobs: "its settings", author: "who wrote it, as the old world recorded", ts: "when it was bound (epoch ms)", state: "its saved state" }, help: "keyed by name: an imported world's old runtime-script binding, carried from translation (scripts are script:<name>)" },
  assets:    { on: "world", keyed: true, key: "instance", fields: { name: "string", path: "string" }, docs: { name: "the asset's display name", path: "its library path" }, help: "on @world, keyed: one of the world's assets (a model added here)" },
  imported:  { keyed: true, key: "instance", help: "keyed: a field an imported world's translation had no mapping for, carried as it was" },
  "imported-roles": { on: "world", keyed: true, key: "instance", help: "on @world, keyed by identity: an imported grant this protocol has no rung for (spectator or none: R 10-21, nothing below member), carried as it was; the person holds the world's newcomer role" },
  "imported-bans": { on: "world", keyed: true, key: "instance", help: "on @world, keyed by identity: a ban an imported world carried, as it was (live bans are the moderator log's)" },
  // research roles 10-06 (shared/protocol/roles.js): ranked membership (member 0, builder 100, moderator 200, owner 255,
  // custom roles between) and a closed list of permissions. Banned is a state in the moderator log, never a role.
  // no `sub` (shape audit 10-16): an account subject is person data, never a value (PROTOCOL §9.2); the translator strips it
  roles:     { status: "trial-kernel", on: "world", keyed: true, key: "instance", fields: { role: "string", can: "object", note: "string", until: "int" },
    // the ladder's vocabulary (recut C11: out of the kernel pin, which holds what the fold reads): a grant names one of these ids, a
    // role-def keys on these permissions, so any change is a break needing --ack (pinBreakList `vocab`), an addition too
    vocab: { rank: { ...RANK }, builtin: [...BUILTIN_IDS], permissions: [...PERMISSION_NAMES], customId: CUSTOM_ID.source, reserved: [...RESERVED_IDS].sort() },
    absentMeans: { until: "the grant has no end: it stands until someone with the right changes or removes it (every role written before 10-17)" }, docs: { role: "the role this person holds: a built-in (member, builder, moderator, owner) or one the world defines", can: "{<permission>: true|false}: exceptions on top of the role, for this person", note: "a note on the grant (≤ 80)", until: "when the grant ends, epoch ms; never on owner" }, help: "on @world, keyed by identity: {role: member|builder|moderator|owner|<a custom role>, can?: {<permission>: true|false} (exceptions on top of the role), note? (≤ 80), until? (epoch ms: when the grant ends; the authority ends it then, warning the holder 5 min before; never on owner)}. A grantRoles holder may give roles ranked below their own, with only permissions they hold" },
  // guests isn't written down: absent means member whatever the newcomer role (roles.js guestRoleOf, R 10-21: guests start
  // as members even where newcomers build). Pinned as a known gap (pretrans D7)
  "default-role": { on: "world", fields: { role: "string", can: "object", guests: "string" }, docs: { role: "the newcomer role: what anyone without their own grant holds; never owner", can: "{<permission>: true|false} on top of that role, for everyone holding it this way (not guests)", guests: "the role people without an account start as; never above role" }, help: "on @world (owner): the NEWCOMER role: what anyone without roles:<id> holds (absent = member; a world founded since R 10-21 starts with builder): any role but owner; can? {<permission>: true|false} on top of that role for everyone who holds it this way (not guests); guests (people without an account) get guests (default member), never above role" },
  "role-defs": { on: "world", help: "on @world (owner): {<role id>: {name, rank (custom: 1–254, unique), can: {<permission>: true|false}, note?}}. Built-ins member, builder, moderator may be renamed and their permissions edited (rank fixed); owner holds every permission and isn't listed. Permissions: build, editOthers, editWorld, generate, fly, scripts, pauseScripts, mute, kick, ban, grantRoles" },
  access:    { status: "trial-kernel", on: "world", fields: { join: "string", watch: "string", max: "int", soft: "int", minAccountDays: "int" }, enums: { join: ["anyone", "signed-in", "listed"], watch: ["anyone"] },
    absentMeans: { watch: "watching follows join: whoever join turns away can't watch either, and a world that admits only people listed is invisible to everyone else (what every access before 10-17 meant)" }, ranges: { max: { min: 1, max: 200 }, soft: { min: 1, max: 200 }, minAccountDays: { min: 0, max: 365 } }, docs: { join: "who may come in: anyone, signed-in, or listed (people the world has granted a role, unexpired)", watch: "anyone: whoever join turns away may still watch, with no body", max: "most bodies at once (1–200)", soft: "the recommended capacity (≤ max)", minAccountDays: "an account must be at least this many days old to come in (0–365; 0 is off)" }, help: "on @world (owner): who may come in {join: anyone|signed-in|listed (only people the world has granted a role, unexpired; a listed-only world is invisible to everyone else), watch? (anyone: whoever join turns away may still watch, with no body), max? (1–200 at once), soft? (≤ max: the recommended capacity), minAccountDays? (0–365: a person's account must be at least this many days old; a guest is then refused, an enrolled agent is exempt; 0 or absent = off)}; moderators and owners always get in" },
  about:     { on: "world", fields: { name: "string", text: "string" }, ranges: { name: { maxLen: 80 }, text: { maxLen: 2000 } }, docs: { name: "the world's name, ≤ 80 characters", text: "its blurb, ≤ 2000 characters" }, help: "on @world: the world's name (≤ 80) and blurb (≤ 2000)" },
  // the component ladder's second rung (docs/COMPONENT-LADDER.md; R 10-12): the drafts this world's owner trusts here.
  // A fact about the world, not the engine: the authority still doesn't read a trusted draft. Owner-gated like the rest of @world.
  "trusted-components": { on: "world", fields: { components: "array" }, ranges: { components: { maxItems: 64 } }, docs: { components: "the namespaced draft component names trusted in this world (≤ 64, each once)" }, help: "on @world (owner): {components: [<namespaced draft names>]} — the draft COMPONENTS used and trusted in this world (never a list of people; was `trusted`, renamed by the world's maintenance command) (a blue chip in the Inspector, offered in the main Add Component list); never a bare name (that is the engine's or nothing); ≤ 64, each once. Trust ≠ engine understanding: the authority doesn't read them" },
  bounds:    { on: "world", fields: { min: "vec3", max: "vec3" }, required: ["min", "max"], units: { min: "m", max: "m" }, docs: { min: "the box's low corner [x, y, z], world metres", max: "its high corner [x, y, z], world metres" },
               help: "on @world: the box the world lives in, {min: [x, y, z], max: [x, y, z]} in world metres, min < max on every axis. Absent (no bounds component), anywhere is in the world" },
  // shape audit 10-16: units, a range, and the absent radius written down (shared/mover.js TRACK.spawnR; tools/shape-attach-test pins they agree)
  // yaw: which way an arrival faces (OMI_spawn_point's facing, on @world's own spawn); more spawns are spawn-point things (shared/spawn.js)
  spawn:     { on: "world", fields: { pos: "vec3", radius: "number", yaw: "number" }, required: ["pos"], units: { pos: "m", radius: "m", yaw: "rad" }, ranges: { radius: { min: 0, max: 100 }, yaw: { min: -2 * Math.PI, max: 2 * Math.PI } },
               absentMeans: { radius: "2 m", yaw: "0: facing the world's +z" }, docs: { pos: "where visitors arrive, [x, y, z] world metres", radius: "a visitor's arrival must lie within this many metres of pos (the client chooses where inside)", yaw: "which way an arrival faces, radians about +y (0: the world's +z)" },
               help: "on @world: where visitors arrive {pos: [x, y, z], radius? (m, 0..100; absent, 2 m): a visitor's arrival must lie within radius of pos, yaw? (rad: which way they face; absent 0, the world's +z)}. More arrival places are things with spawn-point" },
  // an arrival place on a thing, after OMI_spawn_point {title, team, group}; its facing is the thing's rotation (shared/spawn.js spawnOf)
  "spawn-point": { on: "thing", fields: { title: "string", team: "string", group: "string" }, ranges: { title: { maxLen: 80 }, team: { maxLen: 80 }, group: { maxLen: 80 } },
               absentMeans: { title: "untitled", team: "any team's", group: "no group" },
               docs: { title: "its name, as a menu lists it (≤ 80)", team: "the team that arrives here (≤ 80; OMI_spawn_point team)", group: "a group of spawn points chosen among together (≤ 80; OMI_spawn_point group)" },
               help: "a place visitors may arrive, on a thing: {title?, team?, group?} (OMI_spawn_point). They arrive at its origin (within 2 m), facing its rotation. With @world.spawn present that is the default arrival; without it, the spawn-point whose id sorts first (among those of the team or group asked for) is" },
  // a climb route (a ladder, a rope), one per thing: linear between points (Godot Path3D + PathFollow3D); a climber's presence is
  // {host, progress} along it, resolved through the host's live pose (shared/climb.js; upstream main #248 traversal)
  climb:     { on: "thing", fields: { points: "array", reach: "number", speed: "number", face: "vec3", ends: "string" }, required: ["points"],
               enums: { ends: ["both", "start", "end"] },
               ranges: { points: { maxItems: 16 }, reach: { min: 0.3, max: 3 }, speed: { min: 0.3, max: 4 }, face: { min: -1e4, max: 1e4 } },
               units: { points: "m", reach: "m", speed: "m/s" },
               absentMeans: { reach: "1.4 m", speed: "1.3 m/s", face: "along the route's run in the ground plane, from its first point to its last; a route with no run (straight up) faces the thing's own +z", ends: "both: it may be boarded at either end" },
               docs: { points: "2–16 points [x, y, z] in the thing's own frame (metres before its scale), climbed in straight lines between them", reach: "how near an end a body must stand to board it, metres", speed: "how fast a climber moves along it, metres a second in its own frame",
                 face: "which way a climber faces, a direction [x, y, z] in the thing's frame (its ground-plane part is used)", ends: "which ends it may be boarded at: both, start (the first point) or end (the last)" },
               help: "a climb route on a thing (one per thing; a ladder, a rope, a hatch): {points: [[x, y, z], …] (2–16, its own frame), reach? m (0.3..3, absent 1.4: how near an end to board), speed? m/s (0.3..4, absent 1.3), face? [x, y, z] (which way the climber faces; absent, along the route's run, or the thing's +z when it runs straight up), ends?: both|start|end}. Its name is the thing's label. A climber rides it as {host, progress}: a moving host carries them" },
  // a hull driven from its helm (shared/drive.js; OMI_vehicle_body's names where it has one, the rest ours; upstream main #248 vehicle)
  drive:     { on: "thing", fields: { maxSpeed: "number", turnRate: "number", climbRate: "number", response: "number", throttle: "bool" }, required: ["maxSpeed", "turnRate"],
               ranges: { maxSpeed: { min: 0.1, max: 50 }, turnRate: { min: 0.1, max: 4 }, climbRate: { min: 0, max: 50 }, response: { min: 0.05, max: 10 } },
               units: { maxSpeed: "m/s", turnRate: "rad/s", climbRate: "m/s", response: "s" },
               absentMeans: { climbRate: "0: it holds its height", response: "1/1.5 s (upstream's ease)", throttle: "false: thrust is held, never set" },
               docs: { maxSpeed: "its top speed in the ground plane, m/s (OMI_vehicle_body maxSpeed)", turnRate: "how fast it turns about its up axis, rad/s (ours; Roblox VehicleSeat TurnSpeed)", climbRate: "how fast it rises or sinks, m/s (ours)",
                 response: "how fast its velocity eases to the driver's ask: the time constant, s (ours)", throttle: "true: thrust is a level the driver sets and leaves (OMI_vehicle_body useThrottle)" },
               help: "a hull driven from its helm (a socket child with station {action: 'drive', input: {move: 'drive'}}): {maxSpeed m/s (0.1..50), turnRate rad/s (0.1..4), climbRate? m/s (0..50; absent 0, it holds its height), response? s (0.05..10; absent 1/1.5), throttle?: bool}. Forward is its +Z. The driver's client moves it; the authority checks each step and commits the last accepted pose" },
  // research 40 §6.1, trimmed by the shape audit 10-16 (render-media-env §15): the noise ground. Its defaults ARE the sim's law
  // (shared/terrainmath.js terrainParams, held by eidosim's conformance digests (engine-check)), written into every stored value, so the sim, the mesh and
  // the inspector read one ground. raster had no reader anywhere: reserved (refused) until one exists, its fields
  // unregistered. Layer colours are ints (sRGB), like every colour here ("#rrggbb" is taken at write). Water is its own
  // component (everyone separates water from ground): terrain.water is refused with where it went
  terrain:   { on: "world", fields: { kind: "string", seed: "int", size: "number", amplitude: "number", octaves: "int", frequency: "number", flatRadius: "number", flatHeight: "number",
                         segments: "int", layers: "array", features: "array", heightmap: "object", height: "number" },   // upstream #237/#242 (merged 10-15): shared/terrainshape.js reads and bounds them
               defaults: { kind: "noise" },
               when: [{ if: { kind: "noise" }, set: { seed: 1, size: 80, amplitude: 3, octaves: 4, frequency: 2.5, flatRadius: 0, flatHeight: 0 } }, { if: { kind: "flat" }, set: { height: 0 } }],
               enums: { kind: ["noise", "flat"] },
               reservedKinds: { raster: "an imported height raster {blob, w, h, spacing, origin, format: 'i32-mm-le'}: no reader draws or walks it yet" },
               dropped: { water: "water is its own component on @world: set {id: '@world', component: 'water', value: {level, color?, opacity?, kind?, flow?}}" },
               // what every visitor's client can build: past these a single write freezes or breaks everyone (review T0)
               ranges: { size: { gt: 0, max: 4096 }, segments: { min: 2, max: 512 }, octaves: { min: 1, max: 8 }, frequency: { gt: 0, max: 64 },
                         amplitude: { min: -500, max: 500 }, flatRadius: { min: 0, max: 4096 }, features: { maxItems: 64 }, layers: { maxItems: 8 }, height: { min: -10000, max: 10000 } },
               nullable: ["features", "heightmap"],   // null = removed (a merge patch can take one away)
               absentMeans: { height: "on a flat ground 0 m (written at write); a noise ground has none", features: "no placed shapes: the base alone is the ground", heightmap: "no image: the noise is the base", segments: "the renderer's own mesh resolution (a drawing choice, not part of the height law)", layers: "one plain layer, 0x4a5d33 repeated 16 times across its size",
                 law: "the ground's height over these numbers, then features and heightmap; spec/conformance/laws.json pins heights bit for bit" },
               units: { size: "m", amplitude: "m", flatRadius: "m", flatHeight: "m", height: "m" },
               docs: { kind: "the base's kind: noise, or flat (level ground at height; a raster kind is reserved)", height: "a flat ground's height, metres (kind flat only)", seed: "the noise seed", size: "the ground's size, metres", amplitude: "its relief: how high the ground rises, metres", segments: "samples per side (the drawn mesh's resolution)", flatRadius: "flat within this many metres of the centre", flatHeight: "the height of that flat centre, metres", octaves: "noise octaves (1–8)", frequency: "noise frequency", layers: "its colour layers, at most 8: [{color: 0xRRGGBB (sRGB), repeat: tiles across its size}]", features: "placed shapes over the base, in order (at most 64): {type: hill|ridge|flatten, …} (shared/terrainshape.js)", heightmap: "an uploaded grayscale grid as the base: {grid: 'store/heightmaps/<hash>.json', min, max} (m)" },
               help: "the ground's base: {kind: 'flat', height (m)} (level everywhere; nothing else), or {kind: 'noise', seed, size, amplitude, octaves, frequency, flatRadius, flatHeight, segments, layers? [{color: 0xRRGGBB, repeat}], features?, heightmap?} (absent numbers are the sim's: seed 1, size 80 m, amplitude 3 m, octaves 4, frequency 2.5, flat radius 0); a raster kind is reserved; water is its own component" },
  // split out of terrain (shape audit 10-16, render-media-env §15): on @world the world's one level (SL's per-region water); on a
  // thing a water body filling its sibling zone (Unity WaterSurface, Unreal WaterBody; optics named as KHR_materials_volume's).
  // shared/terrainshape.js waterParams reads the level (an older terrain.water too); shared/zone.js reads the bodies
  water:     { fields: { level: "number", color: "int", opacity: "number", kind: "string", flow: "array", waves: "array", attenuationColor: "vec3", attenuationDistance: "number", scatterColor: "vec3", density: "number" },
               enums: { kind: ["still", "river", "ocean", "lake", "pool"] },
               ranges: { level: { min: -500, max: 500 }, color: { min: 0, max: 0xffffff }, opacity: { min: 0.1, max: 1 }, waves: { maxItems: 8 }, attenuationColor: { min: 0, max: 1 }, attenuationDistance: { gt: 0, max: 1e4 },
                 scatterColor: { min: 0, max: 1 }, density: { gt: 0, max: 2e4 } },
               units: { level: "m", flow: "m/s", attenuationDistance: "m", density: "kg/m³" },
               absentMeans: { color: "0x1d5a6e", opacity: "0.82", kind: "decided from the ground it fills (shared/waterkind.js)", flow: "still: no current",
                 level: "on @world never (it is required there); on a thing, its zone's top", waves: "a flat surface",
                 attenuationColor: "the reader's own look for its kind (a level by kind; a body σ [0.16, 0.055, 0.025] per metre: shared/water.js waterParams)", attenuationDistance: "the reader's own look for its kind, as attenuationColor",
                 scatterColor: "the reader's own look (a level by kind and daylight; a body [0.015, 0.12, 0.18]: shared/water.js waterParams)", density: "1000 kg/m³ (fresh water)" },
               docs: { level: "its surface height, metres, in its entity's frame (the world's on @world; on a thing, absent: its zone's top)", color: "its colour, 0xRRGGBB (sRGB)", opacity: "0.1..1", kind: "still | river | ocean | lake | pool",
                 flow: "a current, metres a second: [x, z] on @world; on a thing [x, z] or [x, y, z], in its own frame",
                 waves: "up to 8 waves summed on the surface, each {amplitude (m, 0..5), wavelength (m, ≥ 0.1), direction [x, z], phase? (rad)}",
                 attenuationColor: "the colour white light becomes after attenuationDistance of water, linear [r, g, b] 0..1 (KHR_materials_volume; absorption σ = −ln(c) / d per metre)",
                 attenuationDistance: "the distance, metres, at which light has become attenuationColor (KHR_materials_volume)", scatterColor: "the colour the water scatters back, linear [r, g, b] 0..1 (Unity HDRP scatteringColor)",
                 density: "how dense the water is, kg/m³; reserved: nothing reads it yet (swimming and floating don't)" },
               help: "the world's water on @world {level (m), color? 0xRRGGBB, opacity? 0.1..1, kind?: still|river|ocean|lake|pool, flow? [x, z] m/s}, delete it to drain; or a water body on a thing, which needs a sibling zone {shape, size} (a box for now): the same fields, level in the thing's frame (absent: the zone's top), flow [x, y, z] allowed. Both take waves?, attenuationColor? + attenuationDistance?, scatterColor?, density? (kg/m³; reserved: nothing reads it yet); a body inherits nothing from @world's. How fast a body moves in it is a sibling physics-area {kind: speed, factor}. Where zones overlap the highest priority decides, @world's lowest of all; world-wide water goes on @world" },
  // the volume effects ride on as siblings: shapes after OMI_physics_shape, priority after Godot Area3D, blend/weight/global after Unity Volume
  zone:      { on: "thing", fields: { shape: "string", size: "vec3", radius: "number", height: "number", priority: "int", blend: "number", weight: "number", global: "bool" }, required: ["shape"],
               enums: { shape: ["box", "sphere", "capsule", "cylinder"] },
               ranges: { size: { gt: 0, max: 1e4 }, radius: { gt: 0, max: 1e4 }, height: { gt: 0, max: 1e4 }, priority: { min: -1e6, max: 1e6 }, blend: { min: 0, max: 1e3 }, weight: { min: 0, max: 1 } },
               units: { size: "m", radius: "m", height: "m", blend: "m" },
               absentMeans: { shape: "never absent: a zone names its shape", size: "not a box (a box needs its size)", radius: "not a sphere, capsule or cylinder (each needs a radius)", height: "not a capsule or cylinder (each needs a height)",
                 priority: "0", blend: "0: a hard edge", weight: "1: full strength", global: "false: the zone is its shape" },
               docs: { shape: "box, sphere, capsule or cylinder (OMI_physics_shape's), centred on the thing's origin in its own frame; a capsule or cylinder stands along its y",
                 size: "a box's full size [x, y, z], metres, before the thing's scale", radius: "a sphere's, capsule's or cylinder's radius, metres", height: "a capsule's or cylinder's full height along its y, metres (a capsule's includes its caps)",
                 priority: "which of two overlapping zones' effects wins: the higher (Godot Area3D); a tie goes to the later id", blend: "how far outside its shape a look effect fades out, metres (Unity Volume blend distance); look only, never the medium",
                 weight: "how strongly a look effect applies, 0..1 (Unity Volume weight); look only, never the medium", global: "true: everywhere in the world, its shape unused (Unity Volume global, Unreal unbound)" },
               help: "a volume that effects (water, water-exclusion, physics-area) ride on as siblings on the same thing: {shape: box|sphere|capsule|cylinder, size? [x, y, z] m (a box), radius? m (sphere, capsule, cylinder), height? m (capsule, cylinder), priority? int (higher wins; absent 0), blend? m (absent 0), weight? 0..1 (absent 1), global? (true: everywhere)}, centred on the thing's origin" },
  // a dry pocket carved out of water bodies, after Unreal's Water Body Exclusion Volume
  "water-exclusion": { on: "thing", fields: { bodies: "refs" }, ranges: { bodies: { maxItems: 16 } },
               absentMeans: { bodies: "every water body its zone overlaps, @world's level included" },
               docs: { bodies: "the water bodies (things with water, or @world) it keeps out: only those named (name @world to keep the level out), and of them only those at or below its zone's priority (@world's level is lowest of all)" },
               help: "a dry pocket on a thing with a zone {shape: 'box', size}: inside it there is no water from the bodies it names (bodies? [ids]; absent: every body it overlaps) whose zone's priority is at or below its own" },
  // R 10-28 item 50: a zone effect that changes how bodies move inside it (Godot Area3D's overrides, Unreal Physics Volume); one kind now
  "physics-area": { on: "thing", fields: { kind: "string", factor: "number", modes: "array" }, required: ["kind"], enums: { kind: ["speed"] },
               ranges: { factor: { min: 0.05, max: 10 } }, units: { factor: "×" },
               absentMeans: { factor: "1: no change", modes: "every mode" },
               docs: { kind: "what it does to bodies inside its zone: speed (× their own speed); direction, point and vortex are planned, not open",
                 factor: "speed: × a body's own speed inside (walking, running, wading, swimming): < 1 slows (mud, deep snow), > 1 boosts; 0.05..10. The authority's track widens inside a boost, never narrows",
                 modes: "which movement modes it touches: walk | swim | fly | climb (Unreal's per-mode settings); absent: all. Main's slow water translates to ['swim']" },
               help: "on a thing with a zone {shape: 'box', size} (or global): {kind: 'speed', factor? (× a body's own speed inside, 0.05..10; absent 1)}. Where speed areas overlap the zone's priority decides" },
  "terrain-grid": { status: "reserved", on: "world", help: "reserved: the sculpt grid; no shape is pinned until a world needs one (a sketch: docs/RESERVED-SHAPES.md)" },
  "terrain-tile": { status: "reserved", on: "world", keyed: true, key: "partition", help: "reserved: a sculpted tile, keyed <i>-<j>; no shape is pinned until a world needs one (a sketch: docs/RESERVED-SHAPES.md)" },
  // research 41 §3.2: a behaviour. Keyed, so §5's creator rule decides who may change it and who its SPONSOR is.
  // the lists the install check reads are here, so the pin sees them (shape audit 10-16): each item of `on` is one of
  // itemEnums.on ('changed:*' = changed:<a component name>), each of scope.bodies one of itemEnums["scope.bodies"]; scope's
  // own keys are scopeFields (launch is gone: always refused, so never more than speculative surface)
  script:    { keyed: true, key: "instance", fields: { src: "string", scope: "object", on: "array", every: "number", always: "bool", knobs: "object", paused: "bool" },
               required: ["src", "scope"], grammar: { src: "sha256" }, units: { every: "s" }, ranges: { every: { min: 5 } },
               itemEnums: { on: ["use", "say", "enter", "leave", "grab", "release", "changed:*"], "scope.bodies": ["shove", "pose"] },
               scopeFields: { ids: "scope", comps: "array", create: "bool", say: "bool", bodies: "array" },
               docs: { src: "the source blob's name", scope: "what it may touch: {ids, comps, create?, say?, bodies?}", on: "the events that wake it (use, say, enter, leave, grab, release, changed:<comp>)", every: "seconds between ticks (≥ 5)", always: "true: it runs with nobody present (owner)", knobs: "its settings (≤ 4 KiB)", paused: "true: it doesn't run" }, help: "keyed <name>: a script (JavaScript; docs/SCRIPTS.md). {src: the source blob's name (upload {text} gives it), scope: {ids: 'self'|'subtree'|[ids], comps: [names, 'name:*'], create?, say?, bodies?: ['shove'|'pose']}, on: ['use', 'say', 'enter', 'leave', 'grab', 'release', 'changed:<comp>'], every?: s (>= 5; it gets tick, and wake after sleeping), always?: bool (run with nobody present; owner), knobs?: {…} (<= 4 KiB), paused?}. It acts with its sponsor's rights now, never beyond its scope; a `use` reaches it through a reactions handler {kind: 'script', script: <name>}" },
  // §5 (23:40): keyed names say which kind of key they are. instance: the creator rule; partition: one shared surface
  // reserved (shape audit 10-16): no format for a "written definition" exists yet and nothing writes one, so the name is held
  // until one does (it may then be a set-once string sha256:<64 hex>)
  schemas:   { status: "reserved", instead: "nothing yet: the pinned registry (spec/registry-pin.json) carries a name's meaning; schemas:<name> waits for a definition document format", on: "world", keyed: true, key: "instance", help: "reserved: on @world, keyed by component name, for the content hash of that name's written definition once a format for one exists. Not written yet (PROTOCOL §4)" },
  blueprints: { on: "world", keyed: true, key: "instance", help: "on @world, keyed by a blueprint's hash: {name, …} (publish writes it)" },
  "terrain-paint": { status: "reserved", on: "world", keyed: true, key: "partition", help: "keyed <i>-<j>: paint channels for one tile (research 40 §3; not built in the lab)" },
  // capacity: R's 10-14 14:13 call (VRChat/Resonite scale: gates against a world nobody can load, not targets), cut to ONE
  // entity budget by R 10-15 22:48 (a socket is a child entity, so it counts like any other). A POLICY number (PROTOCOL
  // §9.2; shape audit 10-16): no pinned default. Absent, a field is this server's current default (authority CAPACITY, which
  // `schema` reports and which may change); the ceiling an owner may set is the server's (CAPACITY_CEILING), not a range
  // here. A field the owner writes is stored as written, even at today's default, and nothing is written whole.
  capacity:  { on: "world",
               fields: { entities: "int", guestEntities: "int", avatar: "int" },
               ranges: { entities: { min: 1 }, guestEntities: { min: 0 }, avatar: { min: 1 } },
               units: { entities: "entities", guestEntities: "entities", avatar: "entities" },
               absentMeans: { entities: "this server's current default (schema reports it); it may change",
                              guestEntities: "this server's current default (schema reports it); it may change",
                              avatar: "this server's current default (schema reports it); it may change. Not enforced yet" },
               docs: { entities: "the whole world's entities: every one but @world, sockets included (absent: this server's default; at most the server's ceiling)",
                       guestEntities: "all account-less people's entities together: what people without an account made that still stands here, sockets included (absent: this server's default)",
                       avatar: "one worn avatar's entity tree, at most: the largest one avatar may be, checked when it's worn and not counted in entities (absent: this server's default); not enforced yet: no avatar trees exist" },
               help: "on @world (owner): how much this world holds: {entities (the whole world's entities, every one but @world, sockets included), guestEntities (all account-less people's entities together), avatar (one worn avatar's entity tree at most, checked when worn, not counted in entities; not enforced yet)}. Each is optional: absent, it is this server's current default, and no field may go above the server's ceiling (schema reports both). One thing holds at most 64 sockets. A gate against a world nobody can load, not a target: a create past entities or guestEntities is refused (full)" },
  // script-settings (shape audit 10-16, trimmed): the owner's two decisions (scripts on or off, how many) and the two budgets an
  // owner may TIGHTEN. A policy number like capacity: absent is this server's current default (authority scriptDefaults(),
  // reported by schema), never above the server's ceiling (scriptCeiling()). Who may install is the role's `scripts`
  // permission (role-defs), not a setting here. Rate, cascade depth, failures before a pause and runs per minute are the
  // server's own configuration; a stored value of the old fields is read as absent.
  "script-settings": { on: "world", fields: { run: "bool", max: "int", budget: "int", cpu: "int" },
               ranges: { max: { min: 0 }, budget: { min: 0 }, cpu: { min: 0 } },
               units: { budget: "script entries per hour", cpu: "ms of authority time per sponsor per minute" },
               absentMeans: { run: "true: scripts run", max: "this server's current default (schema reports it)",
                              budget: "this server's current default (schema reports it)", cpu: "this server's current default (schema reports it)" },
               docs: { run: "false stops every script here", max: "how many scripts this world may hold", budget: "script entries per hour, each sponsor a fair share", cpu: "ms of the authority's time each sponsor's scripts may use a minute (the world 3×)" },
               help: "on @world (owner): {run? (false stops every script), max? (how many scripts), budget? (script entries per hour; each sponsor gets a fair share), cpu? (ms of the authority's time per sponsor per minute; the world 3×)}. Each absent field is this server's current default, and none may go above the server's ceiling (schema reports both). Who may install a script is the role's scripts permission (role-defs)" },
};

// ---- status (shape audit 10-16, R: "all components trial for the alpha"; PROTOCOL §4 Status, docs/COMPONENT-LADDER.md) ----
// Every registered name has one. trial: admitted and written, but its shape may still change during the alpha (about a
// year); where it changes we translate or repair stored values where we can. reserved: the name is held (nobody else may
// take it) but the authority refuses every write of it, with one wording (authority.js, the write door); `instead` says
// what to use meanwhile. stable: promised, additions only (none yet). A ladder DRAFT (a namespaced name the authority
// doesn't know) has no status here: it isn't admitted at all. The pin records each status (spec/registry-pin.json); a
// change to a trial or reserved entry is allowed only with an acknowledgement (pretrans --pin --ack), a stable one never.
// held names (R 15:16, shape audit 10-16; research reserved-names.md): registered reserved, so no write can squat a name the
// alpha means to give a settled shape. No fields: each says what it is held for. `joint` (the skeleton node) and
// `physics-joint` (the constraint) are registered above, with physics.
for (const [name, what] of Object.entries({
  "anim-pose": "a pose: one frame, only the bones it names (R 10-17 15:09; a station's or a grabbable's anim may name one)",
  "anim-clip": "an animation clip (more than one key) and its playhead; when it has a shape, its own mode (once | loop | hold) and the bodyMode it asks for are fields of it (R 10-17: the agent's anim reads both)",
  "anim-states": "an animation state machine (states, transitions, params driving clips)",
  camera: "a camera a world places (a view, a screen's source)",
  video: "a video a thing plays",
  "spring-joint": "a spring between two bodies",
  link: "a link a thing opens (a portal, a page)",
  tags: "labels a thing carries for search and rules",
})) COMPONENTS[name] = { status: "reserved", instead: "nothing yet: the name is held for a shape that isn't settled. A namespaced name of your own (such as example.org/<name>) is kept and shown, though nothing here acts on it", help: `reserved: ${what}. Not written yet` };
// the avatar guard rails (PROTOCOL §7a, normative before avatar entity trees ship; R 10-17 02:45): the names are held now so
// nobody squats them under the must-ignore escape hatch before the shapes land. A body's owner is a PERMISSION RULE
// stamped by the authority at wear, never a component anyone writes (body ownership is a rule, not a component).
COMPONENTS["body-owner"] = { status: "reserved", on: "thing", instead: "nothing yet: avatar entity trees aren't built",
  help: "reserved: on a body root, the identity that owns the body (its wearer, or the world for a lent body), stamped by the authority at wear and never set by a request; every entity under the root is that person's (PROTOCOL §7a)" };
COMPONENTS["edit-grant"] = { status: "reserved", on: "thing", keyed: true, key: "instance", instead: "nothing yet: avatar entity trees aren't built",
  help: "reserved: keyed by an identity, on a body root, in the WEARER's log: {until?, scope?: 'subtree' | [ids]} lets that person edit the body without build; revoking (deleting it) stops future edits, never past ones; a co-editor gets attribution, not rights (PROTOCOL §7a)" };
COMPONENTS["avatar-deny"] = { status: "reserved", on: "world", instead: "nothing yet: avatar entity trees aren't built",
  help: "reserved: on @world, {ids?, hashes?}: avatars this world refuses at arrive (the world may refuse a body, never edit one; PROTOCOL §7a)" };

export const STATUSES = {
  trial: "admitted, but its shape may still change during the alpha (about a year); stored values are translated or repaired where they can be",
  "trial-kernel": "the kernel (the log envelope and kinds, the fold's operations, the identity grammar, the version, and the two components every reader rests on: roles and access, each as its field shape only): it may still change during the alpha, but never by a re-pin with an acknowledgement alone: the same change must carry a translator, a changelog line and vectors an old reader refuses and a new one folds (shared/protocol/kernelspec.js; tools/protocol/kernel-check.ts)",
  reserved: "the name is held for a shape that isn't settled: every write of it is refused",
  stable: "promised: its meaning never changes; it only grows by additions",
};
for (const d of Object.values(COMPONENTS)) d.status ??= "trial";
/** A name's status (trial | reserved | stable), or null for a name the registry doesn't know. */
export const statusOf = (comp) => { const d = defOf(comp); return d ? d.status ?? "trial" : null; };

// ---- names (PROTOCOL §4, review 10-07 H1 + M7, R's ruling) ----
// A component name is [<namespace>/]<name>[@<n>][:<key>]. A BARE name (no '/') is the registry's: it is one of COMPONENTS
// or the authority refuses it. Anyone else's carries a namespace: a domain they control or a handle (`example.org/heart`,
// `mica/heart`). The registry never uses '/', the way HTML's own elements never have a hyphen (custom elements must): the
// mark is the separator itself. ':' already means a key (script:bell) and registered names already have hyphens
// (look-at, copy-of), so neither could be the mark; '/' is already in the frozen grammar (§3.1's domain prefix).
// A name that proves itself is promoted by a PR that registers it bare and lists its namespaced spelling in `aliases`:
// both then mean the same definition, and old values keep working. A changed meaning is a NEW name, `<name>@<n>`,
// registered before anyone writes it, with `supersedes: <name>` so a reader knows what it replaces.
export const baseOf = (comp) => { const i = String(comp).indexOf(":"); return i < 0 ? String(comp) : String(comp).slice(0, i); };
export const isNamespaced = (comp) => baseOf(comp).includes("/");
/** The registered name a base answers to (itself, or the name that lists it as an alias), or null. */
export function registered(base) {
  if (Object.hasOwn(COMPONENTS, base)) return base;
  if (!base.includes("/")) return null;   // an alias is always a namespaced spelling
  for (const [k, d] of Object.entries(COMPONENTS)) if (d.aliases?.includes(base)) return k;
  return null;
}
/** The definition a component name is checked against (an alias reaches its registered name's), or undefined. */
export const defOf = (comp) => { const r = registered(baseOf(comp)); return r ? COMPONENTS[r] : undefined; };
/** One spelling per meaning: an alias read as its registered name (its key kept). Renderers that read by name use this. */
export const canonicalName = (comp) => { const b = baseOf(comp), r = registered(b); return r && r !== b ? r + String(comp).slice(b.length) : String(comp); };
/** What a versioned name replaces (light@2 → light), from its definition; null if it says nothing. */
export const supersedes = (comp) => defOf(comp)?.supersedes ?? null;
/** The ONE reader of a versioned name (§4). For a base name on a record's components `c`:
 *  the newest registered `<name>@<n>` that is WRITTEN on c wins; else a written `<name>` keeps its own meaning; else the
 *  newest registered definition's defaults. Returns {name, value, def}: `value` is what's written (or null), `def` the
 *  definition whose defaults fill the gaps. Readers never hand-code `c["x@2"] ?? c.x`: a second @n would copy the chain. */
export function resolveVersioned(c, base) {
  const versions = Object.keys(COMPONENTS).filter((k) => k === base || k.startsWith(base + "@"))
    .sort((a, b) => (Number(a.split("@")[1] ?? 0)) - (Number(b.split("@")[1] ?? 0)));   // base, @2, @3 …
  for (let i = versions.length - 1; i >= 0; i--) { const k = versions[i]; if (c && c[k] != null) return { name: k, value: c[k], def: COMPONENTS[k] }; }
  const newest = versions[versions.length - 1]; return { name: newest, value: null, def: COMPONENTS[newest] };
}

// ---- references (PROTOCOL §4, "References are typed"; review 10-07 H5) ----
// A field that names another thing or a person says so in its type, so copy, publish and a merge can find every
// reference without knowing the component: ref (one entity id), refs (a list of them), person (an identity), people (a
// list), target (a ref, a person, or an @word such as @viewer), scope (a script's 'self' | 'subtree' | [refs]). A nested
// one a fields map can't name is listed in the definition's refPaths ("home.parent.to": "ref"). People are never copied,
// so only thing references are ever rebound.
export const REF_TYPES = new Set(["ref", "refs", "person", "people", "target", "scope"]);
const PERSON_SHAPE = /^u-[a-z2-7]{20}$/;   // shared/protocol/ids.js PERSON_ID: an entity may never wear it
/** [{path: ["field", …], type}] for every reference-bearing field of a name (its scope's ids included). */
export function refFields(comp) {
  const d = defOf(comp); if (!d) return [];
  const out = Object.entries(d.fields ?? {}).filter(([, t]) => REF_TYPES.has(t)).map(([f, t]) => ({ path: [f], type: t }));
  for (const [f, t] of Object.entries(d.scopeFields ?? {})) if (REF_TYPES.has(t)) out.push({ path: ["scope", f], type: t });
  for (const [p, t] of Object.entries(d.refPaths ?? {})) out.push({ path: p.split("."), type: t });
  return out;
}
const isThingRef = (x) => typeof x === "string" && x !== "" && !x.startsWith("@") && !PERSON_SHAPE.test(x);
const getAt = (v, path) => path.reduce((o, k) => (o && typeof o === "object" && !Array.isArray(o) ? o[k] : undefined), v);
// a refPaths entry may hold a '*' segment (reactions "*.targets": every action's targets): the concrete paths it names in v
// each "*" is expanded once, at its own position, left to right: a key that is itself "*" stands for that key, never for
// another wildcard (searching the expanded path for "*" again found that key and recursed on it forever)
function expandPath(v, path, from = 0) {
  const i = path.indexOf("*", from); if (i < 0) return [path];
  const o = getAt(v, path.slice(0, i)); if (!o || typeof o !== "object" || Array.isArray(o)) return [];
  return Object.keys(o).flatMap((k) => expandPath(v, [...path.slice(0, i), k, ...path.slice(i + 1)], i + 1));
}
const concrete = (comp, v) => refFields(comp).flatMap(({ path, type }) => expandPath(v, path).map((p) => ({ path: p, type })));
/** Every THING an entity's component value refers to: [{path: "story.marks[1]", id}]. People and @words aren't things. */
export function refsOf(comp, v) {
  const out = []; const name = baseOf(comp);
  for (const { path, type } of concrete(comp, v)) { const x = getAt(v, path); const at = `${name}.${path.join(".")}`;
    if (type === "ref" || type === "target") { if (isThingRef(x)) out.push({ path: at, id: x }); }
    else if ((type === "refs" || type === "scope") && Array.isArray(x)) x.forEach((y, i) => { if (isThingRef(y)) out.push({ path: `${at}[${i}]`, id: y }); }); }
  return out;
}
/** The value with each thing reference x replaced by f(x, path); f returning null drops it (a list entry is removed; a
 *  single reference's field is removed, and if that field is required the whole value is: returns undefined). Returns
 *  {value, dropped: [paths]}. Never touches people or @words. */
export function mapRefs(comp, v, f) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { value: v, dropped: [] };
  const out = copy(v), dropped = []; const d = defOf(comp); const name = baseOf(comp); let gone = false;
  for (const { path, type } of concrete(comp, v)) {
    const parent = getAt(out, path.slice(0, -1)); const k = path.at(-1); if (!parent || typeof parent !== "object" || Array.isArray(parent)) continue;
    const x = parent[k]; const at = `${name}.${path.join(".")}`;
    if (type === "ref" || type === "target") { if (!isThingRef(x)) continue; const y = f(x, at);
      if (y === null) { delete parent[k]; dropped.push(at); if (path.length === 1 && (d?.required ?? []).includes(k)) gone = true; if (comp === "parent" || baseOf(comp) === "parent") gone = true; }
      else parent[k] = y; }
    else if ((type === "refs" || type === "scope") && Array.isArray(x)) {
      const kept = []; x.forEach((y, i) => { if (!isThingRef(y)) { kept.push(y); return; } const z = f(y, `${at}[${i}]`); if (z === null) dropped.push(`${at}[${i}]`); else kept.push(z); });
      parent[k] = kept; }
  }
  return { value: gone ? undefined : out, dropped };
}

// ---- every parameter written down (PROTOCOL §4) ----
const copy = (x) => (x && typeof x === "object" ? JSON.parse(JSON.stringify(x)) : x);
// A transform's q is stored as a unit quaternion, whoever writes it (its doc: "normalized on write"): a request (writes.js
// resolve, and put's own op), a script's set (the host's materialize, below, so an auditor's re-run writes the same), a
// reaction's set and reset (use.js), and a return home (manipulate.js returnPlan; a home's q is held only near a
// rotation). The authority's maths reads q as a rotation, so a scaled one would skew every inverse. A zero q stays as
// sent, for the gate to refuse; anything that isn't four finite numbers is left for the gate's shape check
export function unitTransform(v) {
  const q = v && typeof v === "object" && !Array.isArray(v) ? v.q : undefined;
  if (!Array.isArray(q) || q.length !== 4 || !q.every(Number.isFinite)) return v;
  const n = Math.hypot(...q); return n >= 1e-6 && Math.abs(n - 1) > 1e-9 ? { ...v, q: q.map((x) => x / n) } : v;
}
/** A value with its definition's defaults written in: `defaults`, then each `when` rule that holds, never over a field
 *  that's there. {value, filled: [fields written]}. A non-object value, or a name with no definition, comes back as it is. */
export function materialize(comp, v) {
  const def = defOf(comp);
  if (!def || !v || typeof v !== "object" || Array.isArray(v)) return { value: v, filled: [] };
  if (comp === "transform") v = unitTransform(v);
  const out = { ...v }, filled = [];
  const put = (set) => { for (const [k, x] of Object.entries(set)) if (!(k in out)) { out[k] = copy(x); filled.push(k); } };
  if (def.defaults) put(def.defaults);
  for (const r of def.when ?? []) {
    if (r.if && !Object.entries(r.if).every(([k, x]) => out[k] === x)) continue;
    if (r.absent && r.absent.some((k) => k in out)) continue;
    put(r.set);
  }
  return { value: out, filled };
}
/** Every default a name can write (its `defaults` and every `when` rule's), for tools that ask "is this one written?" */
export const defaultsOf = (name) => { const d = COMPONENTS[name]; return Object.assign({}, d?.defaults ?? {}, ...(d?.when ?? []).map((r) => r.set)); };

// ---- what a name means, pinned (PROTOCOL §4; the pin is a TRIPWIRE during the alpha) ----
// The checkable part of a definition: its status, each field's type, each default (and when it applies), each enum's
// members, each range and what's required, each field's meaning of absence and grammar. spec/registry-pin.json holds them
// and test:protocol fails (pretrans-check D8) when one is removed, changed or narrowed; a NEW field, default, enum member,
// widened range or name is an addition and is fine. A field added to a name after its first registration must say what an
// older value without it means (`absentMeans`, PROTOCOL §4; D11).
// During the alpha every registered name is `trial` (or `reserved`), so a break is ALLOWED, but never silently: re-pinning
// over one needs an acknowledgement, `bun tools/protocol/pretrans-check.ts --pin --ack "<why>"`, which writes a line to
// spec/REGISTRY-CHANGELOG.md naming what changed and why (pinVerdict). A `stable` name's breaks are never re-pinned: a
// changed meaning of a stable name is a new versioned name (PROTOCOL §4). Additions re-pin with a plain --pin.
export function pinOf() {
  const out = {};
  for (const [name, d] of Object.entries(COMPONENTS)) {
    const p = { status: d.status ?? "trial" };
    if (d.type) p.type = d.type;
    if (d.fields) p.fields = { ...d.fields };
    if (d.defaults) p.defaults = copy(d.defaults);
    if (d.when) p.when = copy(d.when);
    if (d.enums) p.enums = copy(d.enums);
    if (d.ranges) p.ranges = copy(d.ranges);
    if (d.maxLen !== undefined) p.maxLen = d.maxLen;
    if (d.required) p.required = [...d.required];
    if (d.keyPattern) p.keyPattern = d.keyPattern;
    if (d.itemEnums) p.itemEnums = copy(d.itemEnums);
    if (d.scopeFields) p.scopeFields = { ...d.scopeFields };
    if (d.writtenBy) p.writtenBy = d.writtenBy;
    if (d.maxKeys !== undefined) p.maxKeys = d.maxKeys;
    if (d.absentMeans) p.absentMeans = { ...d.absentMeans };
    // what each field means, and its unit: the normative home of a component's meaning (the house's view, #260 10-20)
    if (d.docs) p.docs = Object.fromEntries(Object.entries(d.docs).filter(([f]) => Object.hasOwn(d.fields ?? {}, f) || d.map !== undefined));
    if (d.units) p.units = copy(d.units);
    if (d.grammar) p.grammar = { ...d.grammar };
    if (d.vocab) p.vocab = copy(d.vocab);
    if (d.keyed !== undefined) p.keyed = d.keyed;
    if (d.on) p.on = d.on;
    // reactions' handler kinds and their args are part of its meaning (shape audit 10-16: the kinds are frozen)
    if (d.handlers) p.handlers = Object.fromEntries(Object.entries(d.handlers).map(([k, h]) => [k, Object.keys(h.args ?? {})]));
    if (d.reservedKinds) p.reservedKinds = Object.keys(d.reservedKinds);
    if (d.reservedFields) p.reservedFields = [...d.reservedFields];
    // what a reserved field will mean when it opens (physics: units, limits, enums), held as the absentMeans are
    // a nested grammar's closed vocabularies (structure's aperture kinds and wall axes: shape audit 10-16)
    if (d.nestedEnums) p.nestedEnums = copy(d.nestedEnums);
    out[name] = p;
  }
  return out;
}
// is range b narrower than range a anywhere (a bound added, a lower bound raised, an upper bound lowered)?
const LOWER = (r) => (r.gt !== undefined ? [r.gt, 1] : r.min !== undefined ? [r.min, 0] : null);
function narrows(a = {}, b = {}) {
  const la = LOWER(a), lb = LOWER(b);
  if (lb && (!la || lb[0] > la[0] || (lb[0] === la[0] && lb[1] > la[1]))) return "its lower bound rose";
  for (const k of ["max", "maxLen", "maxItems"]) if (b[k] !== undefined && (a[k] === undefined || b[k] < a[k])) return `its ${k} fell`;
  return null;
}
/** Every break between a pin and now, as [{name, status, text}]: removals, changes and narrowings (additions aren't).
 *  status is the PIN's (what was promised): trial or reserved breaks may be re-pinned with an acknowledgement, stable never. */
export function pinBreakList(pin, now = pinOf()) {
  const out = [], j = (x) => JSON.stringify(x);
  for (const [name, p] of Object.entries(pin)) {
    const status = p.status ?? "trial"; const push = (text) => out.push({ name, status, text });
    const n = now[name]; if (!n) { push(`${name}: the name is gone (stored values need a repair or a translation; a stable name never goes)`); continue; }
    if (p.status !== undefined && p.status !== n.status) push(`${name}: status ${p.status} → ${n.status}`);
    for (const k of ["type", "keyed", "on"]) if (p[k] !== undefined && j(p[k]) !== j(n[k])) push(`${name}: ${k} ${j(p[k])} → ${j(n[k])}`);
    for (const [f, t] of Object.entries(p.fields ?? {})) if (n.fields?.[f] !== t) push(`${name}.${f}: type ${t} → ${n.fields?.[f] ?? "gone"}`);
    for (const [f, v] of Object.entries(p.defaults ?? {})) if (j(n.defaults?.[f]) !== j(v)) push(`${name}.${f}: default ${j(v)} → ${j(n.defaults?.[f]) ?? "gone"}`);
    for (const r of p.when ?? []) if (!(n.when ?? []).some((q) => j(q.if) === j(r.if) && j(q.absent) === j(r.absent) && Object.entries(r.set).every(([f, v]) => j(q.set?.[f]) === j(v)))) push(`${name}: a conditional default changed: ${j(r)}`);
    for (const [f, vals] of Object.entries(p.enums ?? {})) for (const x of vals) if (!(n.enums?.[f] ?? []).includes(x)) push(`${name}.${f}: ${j(x)} is no longer allowed`);
    // ranges, maxLen and required entered the pin with status (10-16): a pin from before holds none of them, so none is judged
    if (p.status !== undefined) for (const f of new Set([...Object.keys(p.ranges ?? {}), ...Object.keys(n.ranges ?? {})])) { const why = narrows(p.ranges?.[f], n.ranges?.[f]);
      if (why && Object.hasOwn(p.fields ?? {}, f)) push(`${name}.${f}: its range narrowed (${why}): ${j(p.ranges?.[f] ?? {})} → ${j(n.ranges?.[f])}`); }
    if (p.status !== undefined && n.maxLen !== undefined && (p.maxLen === undefined || n.maxLen < p.maxLen)) push(`${name}: maxLen ${p.maxLen ?? "none"} → ${n.maxLen}`);
    for (const [f, vals] of Object.entries(p.itemEnums ?? {})) for (const x of vals) if (!(n.itemEnums?.[f] ?? []).includes(x)) push(`${name}.${f}[]: ${j(x)} is no longer allowed`);
    // a reserved field that opens (moves into fields) is an addition; one that leaves both lists frees a held name
    for (const f of p.reservedFields ?? []) if (!(n.reservedFields ?? []).includes(f) && !Object.hasOwn(n.fields ?? {}, f)) push(`${name}.${f}: a reserved field is gone (its name is no longer held)`);
    for (const [f, vals] of Object.entries(p.nestedEnums ?? {})) for (const x of vals) if (!(n.nestedEnums?.[f] ?? []).includes(x)) push(`${name}.${f}: ${j(x)} is no longer allowed`);
    for (const [f, t] of Object.entries(p.scopeFields ?? {})) if (n.scopeFields?.[f] !== t) push(`${name}.scope.${f}: type ${t} → ${n.scopeFields?.[f] ?? "gone"}`);
    if (p.status !== undefined && n.writtenBy !== undefined && n.writtenBy !== p.writtenBy) push(`${name}: now written by ${n.writtenBy} only`);
    if (p.status !== undefined && n.keyPattern !== undefined && n.keyPattern !== p.keyPattern) push(`${name}: keys ${p.keyPattern ?? "any"} → ${n.keyPattern}`);
    if (p.status !== undefined && n.maxKeys !== undefined && (p.maxKeys === undefined || n.maxKeys < p.maxKeys)) push(`${name}: maxKeys ${p.maxKeys ?? "none"} → ${n.maxKeys}`);
    if (p.status !== undefined) for (const f of n.required ?? []) if (!(p.required ?? []).includes(f) && Object.hasOwn(p.fields ?? {}, f)) push(`${name}.${f}: now required`);
    for (const [f, m] of Object.entries(p.absentMeans ?? {})) if (n.absentMeans?.[f] !== m) push(`${name}.${f}: its meaning of absence ${j(m)} → ${j(n.absentMeans?.[f]) ?? "gone"}`);
    const judged = (f) => (!p.fields && !n.fields) || Object.hasOwn(n.fields ?? {}, f);
    for (const [f, m] of Object.entries(p.docs ?? {})) if (judged(f) && n.docs?.[f] !== m) push(`${name}.${f}: its meaning ${j(m)} → ${j(n.docs?.[f]) ?? "gone"}`);
    for (const [f, u] of Object.entries(p.units ?? {})) if (judged(f) && j(n.units?.[f]) !== j(u)) push(`${name}.${f}: its unit ${j(u)} → ${j(n.units?.[f]) ?? "gone"}`);
    for (const [f, g] of Object.entries(p.grammar ?? {})) if (n.grammar?.[f] !== g) push(`${name}.${f}: grammar ${g} → ${n.grammar?.[f] ?? "gone"}`);
    // a closed vocabulary (roles.vocab: ranks, built-in ids, permissions, the custom-id pattern, reserved ids): ANY difference
    // changes what a stored grant or role-def means (a freed id, a new reserved one), so additions break too: never silently
    for (const [f, v] of Object.entries(p.vocab ?? {})) if (j(n.vocab?.[f]) !== j(v)) push(`${name}.${f}: vocabulary ${j(v)} → ${j(n.vocab?.[f]) ?? "gone"}`);
    for (const [k, args] of Object.entries(p.handlers ?? {})) { if (!n.handlers?.[k]) { push(`${name}: handler kind ${k} is gone`); continue; }
      for (const a of args) if (!n.handlers[k].includes(a)) push(`${name}.${k}: handler arg ${a} is gone`); }
    // PROTOCOL §4: a field added after the name's first registration says what an older value WITHOUT it means (a value
    // stored before it existed never holds it, and materialize never rewrites the past), and that meaning is pinned
    for (const f of Object.keys(n.fields ?? {})) if (!Object.hasOwn(p.fields ?? {}, f) && !(typeof n.absentMeans?.[f] === "string" && n.absentMeans[f].trim()))
      push(`${name}.${f}: added after ${name} was first registered, with no meaning of absence (absentMeans.${f}: what an older value without it means)`);
  }
  return out;
}
/** What changed meaning between a pin and now, as lines. [] = nothing. */
export const pinBreaks = (pin, now = pinOf()) => pinBreakList(pin, now).map((b) => b.text);
/** May `now` be re-pinned over `pin`? {ok, why?, changelog?}: with no breaks, yes; with breaks only on trial or reserved
 *  names, only with an acknowledgement (`ack`, the why), and the changelog line to write says what and why; a stable
 *  name's break, never. `date` stamps the changelog line. */
export function pinVerdict(pin, now = pinOf(), ack = null, date = new Date().toISOString().slice(0, 10)) {
  const breaks = pinBreakList(pin, now);
  const stable = breaks.filter((b) => b.status === "stable");
  if (stable.length) return { ok: false, breaks, why: `these change a STABLE name's meaning (a changed meaning is a new versioned name; no acknowledgement re-pins it):\n  ${stable.map((b) => b.text).join("\n  ")}` };
  const why = typeof ack === "string" ? ack.trim() : "";
  if (breaks.length && !why) return { ok: false, breaks, why: `these change a trial or reserved name (allowed during the alpha, but never silently): re-pin with --ack "<why>", which writes spec/REGISTRY-CHANGELOG.md:\n  ${breaks.map((b) => b.text).join("\n  ")}` };
  return { ok: true, breaks, ...(why ? { changelog: `- ${date}: ${why}${breaks.length ? `\n${breaks.map((b) => `  - ${b.text}`).join("\n")}` : ""}\n` } : {}) };
}

/** A field's range ({min?, gt?, max?}) as the door judges a number against it, and the words it refuses with. `fmt`
 *  writes each bound (the editor's degrees); without it the bounds read as the door has always written them. */
export const outOfRange = (r, n) => (r.min !== undefined && n < r.min) || (r.gt !== undefined && n <= r.gt) || (r.max !== undefined && n > r.max);
export const rangeWords = (r, fmt) => [r.gt !== undefined ? `> ${fmt ? fmt(r.gt) : r.gt}` : r.min !== undefined ? `≥ ${fmt ? fmt(r.min) : r.min}` : "", r.max !== undefined ? `≤ ${fmt ? fmt(r.max) : +r.max.toFixed(4)}` : ""].filter(Boolean).join(" and ");

export const PENDULUM = { type: "pendulum", axis: [1, 0, 0], amp: 0, period: 2.4, damp: 0.08, maxAmp: 0.9, phase: 0 };
