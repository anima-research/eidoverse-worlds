// shared/protocol/componentspec.js — the component types a builder can discover: their fields, defaults, ranges and help.
// The lab's hand-written models are shared/protocol/labmodels.js.
//
// Every parameter is written down (PROTOCOL §4; review 10-07 H2, R: "the parameter is the parameter"). The authority writes a
// component's defaults into the stored value when it's created or set (materialize, below): `defaults` always, and each
// `when` rule ({if: {field: value}, absent: [fields], set: {…}}) when it holds. So a renderer never supplies a number the
// log doesn't hold, and changing a default here never changes an old world. A default that lives only in help text or a
// renderer is a bug (pretrans-check D7); a changed default, type or enum is a changed meaning (spec/registry-pin.json, D8).

// how two touching surfaces' coefficients combine: the modes PhysX, Unity and Rapier name (Jolt and Box2D take any rule as a
// callback), so every engine can carry them; when two differ, the later in this list wins (PhysX's and Unity's priority)
export const COMBINE = ["average", "min", "multiply", "max"];
export const COMPONENTS = {
  transform: { on: "thing", fields: { pos: "vec3", q: "array", scale: "vec3" }, defaults: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, help: "where it is: pos (m), q (unit quaternion), scale" },
  model:     { on: "thing", type: "string", help: "which model it shows: a name from find {kind: 'model'}, or its content address eido:sha256/<64 hex> (spec/EIDO-URIS.md; a glTF binary by its role)" },
  label:     { type: "string", help: "its display name, a short string" },
  // every client honours it (the editor's Hide; shared/editschema.js flags); registered 10-07 when bare names became the
  // registry's (PROTOCOL §4), with the meaning it already had
  // the collision shape every client and the authority's solids honour (shared/editschema.js Collider): its triangles or
  // its box; and the caption bot's speaker mark (shared/components.js Stage). Registered 10-07 with the meanings they had
  collider:  { on: "thing", fields: { shape: "string" }, enums: { shape: ["exact", "box"] }, help: "how it collides: {shape: exact (its triangles) | box (its bounding box)}; absent, its size decides" },
  stage:     { on: "thing", fields: { speaker: "any" }, help: "the caption bot's stage mark: {speaker?: who is speaking here}" },
  hidden:    { on: "thing", type: "bool", help: "true: not drawn by any client (it's still there: it collides, look and inspect list it). Delete it to show the thing again" },
  pivot:     { on: "thing", help: "{pos: [x,y,z]}: where it turns and scales from, in its own frame before scale ([0,0,0] = its origin). Never moves it or changes how it draws" },
  // attaching to a NAMED point on the parent is general (Unreal AttachToComponent's SocketName, Roblox Attachment,
  // Godot BoneAttachment3D): socket names one of the parent's sockets
  parent:    { on: "thing", fields: { to: "ref", order: "string", socket: "string" }, defaults: { order: "a0" }, help: "{to: id, socket?: one of its sockets}; its transform becomes local to the parent (to the socket, with socket)" },
  // the punctual light every engine shares (glTF KHR_lights_punctual, Godot OmniLight3D/SpotLight3D, Unity Light,
  // three.js): kind, color, intensity, range; a spot adds its cone as HALF-angles in radians (glTF outer/innerConeAngle,
  // Godot spot_angle, three.js angle/penumbra) and shines along the thing's local -Z (glTF, Godot)
  light:     { fields: { kind: "string", color: "int", intensity: "number", range: "number", angle: "number", inner: "number", shadows: "bool", important: "bool", day: "bool" }, defaults: { kind: "point", color: 0xffd9a0, intensity: 16, range: 10, shadows: false, important: false, day: true }, enums: { kind: ["point", "spot"] },
    when: [{ if: { kind: "spot" }, set: { angle: Math.PI / 4, inner: 0 } }],
    ranges: { color: { min: 0, max: 0xffffff }, intensity: { min: 0 }, range: { gt: 0 }, angle: { gt: 0, max: Math.PI / 2 }, inner: { min: 0, max: Math.PI / 2 } },
    help: "a light on this thing: {kind: point|spot, color (0xRRGGBB), intensity, range (m), shadows}; a spot shines along the thing's -Z with angle (its cone's half-angle, rad, default π/4) and inner (where the edge starts to soften, rad, default 0)" },
  // the closed forms every client and the agent evaluate (client/lib/motioneval.js). Rates are degrees a second (Unreal's
  // RotatingMovementComponent RotationRate, Unity's Rotate) or a period in seconds; a path is control points with a speed
  // or a duration and a loop mode (Unreal's InterpToMovementComponent: ControlPoints, Duration, OneShot/Loop/PingPong)
  // the per-type defaults are motioneval.js's readings, written down (a spin with no rate turned at 36°/s in every renderer)
  motion:    { on: "thing", keyed: "optional", when: [
                 { if: { type: "pendulum" }, set: { axis: [1, 0, 0], period: 2.4, damp: 0.08, maxAmp: 0.9, phase: 0 } }, { if: { type: "pendulum" }, absent: ["amp", "amplitude"], set: { amp: 0 } },
                 { if: { type: "spin" }, set: { axis: [0, 1, 0], phase: 0 } }, { if: { type: "spin" }, absent: ["degPerSec", "period", "rpm"], set: { degPerSec: 36 } },
                 { if: { type: "orbit" }, set: { radius: 3, phase: 0, face: true } }, { if: { type: "orbit" }, absent: ["degPerSec", "period", "rpm"], set: { degPerSec: 12 } },
                 { if: { type: "bob" }, set: { axis: [0, 1, 0], period: 4, phase: 0 } }, { if: { type: "bob" }, absent: ["amp", "amplitude"], set: { amp: 0.3 } },
                 { if: { type: "path" }, set: { loop: "loop", face: true } }, { if: { type: "path" }, absent: ["speed", "duration"], set: { speed: 1 } }],
               fields: { type: "string", axis: "axis", amp: "number", period: "number", damp: "number", maxAmp: "number", phase: "number", t0: "number", part: "string", radius: "number", degPerSec: "number", amplitude: "number", pivot: "vec3",
                 center: "vec3", face: "bool", points: "array", speed: "number", duration: "number", loop: "string" }, enums: { type: ["pendulum", "spin", "orbit", "bob", "path"], loop: ["loop", "pingpong", "once"] },
               ranges: { period: { gt: 0, max: 3600 }, degPerSec: { min: -36000, max: 36000 }, radius: { min: 0, max: 10000 }, speed: { min: 0, max: 1000 }, duration: { gt: 0, max: 36000 } },
               help: "{type, …} (the authority stamps t0): pendulum {axis [x,y,z] (local), amp (rad), period (s), damp, maxAmp, phase} swings about the point it hangs from; spin {axis, degPerSec (degrees a second) or period (s a turn), pivot?, phase} turns steadily; orbit {radius (m), center? [x,y,z] (in its parent's frame; default where it stands), period (s a lap) or degPerSec, face? (false: keeps its own heading), phase} circles; bob {axis, amp (m), period (s), phase} floats; path {points [[x,y,z], …] (2–64, in its parent's frame), speed (m/s) or duration (s), loop?: loop|pingpong|once, face?} follows its points. part: a node of its model that moves instead (motion:<part>)" },
  // lock levels (R, 10-07): true is a builder-level lock (the first protocol's); {rank} names the level. A plain true is
  // never rewritten (materialize fills objects only), so every existing lock keeps its value and its meaning
  lock:      { fields: { rank: "string" }, defaults: { rank: "builder" }, enums: { rank: ["builder", "moderator", "owner"] },
               help: "an edit lock (PROTOCOL §7, Locks): true (builder level, the first protocol's lock) or {rank: 'builder' | 'moderator' | 'owner'}. Nobody, its locker and owners included, may move, replace or delete it, or anything attached to it; edits that don't relocate it (label, light, motion, reactions…) stay open. Whoever set it, or anyone at its level or above, may unlock it (delete {id, component: 'lock'}), change it, or act through it by sending a request with throughLock: true; nobody sets a lock above their own rank. An owner-level lock is 'not this piece': builders and moderators can't lift it or act through it. Not on @world. A door's gameplay lock is `openable.locked`, not this" },
  // a named attachment point on the thing (Unreal sockets, Roblox Attachment). With `body`, a PERSON can attach there by
  // using it (VRChat Station, Roblox Seat): chairs, swings, saddles, a car's seats. Things attach with parent {to, socket}.
  sockets:   { on: "thing", map: "object", help: "{<name>: {pos: [x,y,z] (its own frame), q? [x,y,z,w] (its rotation: a rocket seat lies on its back), part? (a model node it rides), accepts? [keywords] + radius? (m, default 0.15): a thing released within radius whose grabbable.fits shares a keyword snaps in (a key on its hook, a sword in its rack), body?: what a person's body does there: {action ('sit'; what 'use' calls it), anchor (root, the default | hips | feet | head: the body point on the socket), pose (a clip; {clip, time: 'phase'}; or a blend {by: 'speed'|'steer'|…|'param.<name>', clips: [[0,'idle'],[2,'walk']]}), poses {<name>: pose} + sync, approach [x,y,z,yaw], enter/leave (clips), exit [x,y,z], reach {leftHand: {at, q?, part?, hint?, vr: snap|track|near}}, hold {<bone>: q}, look {yaw: [min,max]°, pitch, up: world|socket}, input {move: none|drive|walk, look: free|aim|locked} (one drive per thing), leaveBy (jump|menu|script), fromSeat, who (builder|owner)}}}" },
  // the numbers a thing exposes to the bodies on it (a pose blends by `param.<name>`); scripts write them
  params:    { on: "thing", map: "number", help: "{<name>: number}: values a socket's pose can blend by (param.<name>); scripts write them" },
  reactions: { help: "{<action>: handler}: what happens when someone uses it. Each handler may add who: 'builder'|'owner' (who may use it) and fix: text (shown on refusal).",
    handlers: {
      toggle: { args: { component: "the component to flip (default 'openable')", field: "the true/false field inside it to flip (default 'open' for openable; leave both out for an openable). A named component with no field flips its whole value. The component must be on the thing when the handler is written", unless: "a field of the same component that, when true, bars it (e.g. 'locked')" }, example: { open: { kind: "toggle", component: "openable", field: "open", unless: "locked" } } },
      set: { args: { component: "which component", field: "optional: the field inside it to set (the component must then be on the thing)", value: "the value it gets (checked when the handler is written, as the authority would check that write)" }, example: { bolt: { kind: "set", component: "openable", field: "locked", value: true, who: "builder" } } },
      // the general primitive pair (Godot apply_impulse / apply_torque_impulse; Unity AddForce / AddTorque with
      // ForceMode.Impulse; Rapier and PhysX applyImpulse / applyTorqueImpulse): a push changes the thing's velocity at its
      // centre (strength, m/s) or its turn rate about its axis (angular, rad/s). A hinged thing (a pendulum motion) takes
      // strength as strength / its distance from the hinge, and angular as it is.
      // research 41 §3.1: the join between the two tiers. The action list, its `who` gate and its `fix` stay data; only
      // the effect is computed, by the script:<name> on the same thing, with its sponsor's rights narrowed to its scope
      script: { args: { script: "the name of a script on this same thing (its component is script:<name>)" }, example: { ring: { kind: "script", script: "bell" } } },
      // batch 2: a doorbell plays its sound again from the top, whether or not it's playing (set can't restart it, toggle
      // would stop it): the authority writes sound {…, playing: true, t0: now}
      play: { args: {}, example: { ring: { kind: "play" } } },
      impulse: { args: { strength: "a push: the speed it gives the thing at its centre, m/s (default 0.5). A use may give its own push as args.impulse [x,y,z] (m/s)", angular: "or a turn: the turn rate it adds about the thing's axis, rad/s (instead of strength)" }, example: { push: { kind: "impulse", strength: 0.5 } } } },
    common: { kind: "the handler kind", who: "who may use it: builder|owner", fix: "text shown on refusal" } },
  // R 10-07: the behaviour is `openable` (a door, a gate, a lid, a hatch, a cabinet), not the asset. The conventional shape
  // (Unity/Godot/Roblox door recipes, Unreal's door timeline): a turn about a hinge (angle about axis, through the thing's
  // pivot) or a slide, tweened over a time (Roblox TweenInfo's default 1 s). `open` is the state; every client animates to it
  openable:  { on: "thing", fields: { open: "bool", locked: "bool", angle: "number", axis: "axis", slide: "vec3", time: "number", part: "string" },
               defaults: { open: false, locked: false, time: 1 }, when: [{ absent: ["slide"], set: { angle: Math.PI / 2, axis: [0, 1, 0] } }],
               ranges: { angle: { min: -Math.PI, max: Math.PI }, time: { min: 0, max: 10 } },
               help: "it opens and closes when someone uses it: a door, a gate, a lid, a hatch. {open: true/false (its state), locked? (true bars an open handler with unless: 'locked'; the edit lock is the separate `lock`), angle? (rad it turns when open, default π/2; negative turns the other way), axis? (its own frame, default [0,1,0]: an upright hinge), slide? [x,y,z] (m it moves in its own frame when open, instead of turning), time? (s to open or close, 0–10, default 1), part? (a node of its model that moves instead of the whole thing)}. It turns about its pivot (pivot {pos}: put it on the hinge edge). Usable with reactions {open: {kind: 'toggle', unless: 'locked'}} (toggle's default flips openable.open)" },
  // spec/PHYSICS.md §3.1–§3.2 (research physics-seeds 10-07, seeds 3–4): shape has a grammar (shared/protocol/shapes.js),
  // and the physical properties are named now, with units and what absence means, so the first engine that reads them
  // can't invent either. None is a materialized default: no engine this server carries reads them yet, and a number
  // written into every value that nothing honours is a number builders tune for nothing. Absence keeps today's meaning.
  // Angular velocity everywhere (acts, launches, state samples) is w: [x, y, z] rad/s in the world frame.
  physics:   { on: "thing", fields: { kind: "string", who: "string", shape: "any", mass: "number", density: "number", material: "string", friction: "number", restitution: "number",
                 linearDamping: "number", angularDamping: "number", centerOfMass: "vec3", ccd: "bool", layers: "int", mask: "int",
                 frictionCombine: "string", restitutionCombine: "string" },
    grammar: { shape: "shape" },   // `any` is the pinned type of every value ever stored; the grammar narrows what may be written
    defaults: { kind: "dynamic" }, enums: { kind: ["dynamic", "static", "none", "kinematic"], frictionCombine: COMBINE, restitutionCombine: COMBINE },
    when: [{ if: { kind: "dynamic" }, set: { who: "visitor" } }],   // shared/grab.js DEFAULT_WHO, written down
    ranges: { mass: { gt: 0, max: 1e6 }, density: { gt: 0, max: 1e5 }, friction: { min: 0, max: 10 }, restitution: { min: 0, max: 1 }, linearDamping: { min: 0, max: 1000 }, angularDamping: { min: 0, max: 1000 },
              layers: { min: 0, max: 0xffffffff }, mask: { min: 0, max: 0xffffffff }, material: { maxLen: 64 } },
    absentMeans: {
      shape: "no measured shape: the thing is no body to the engine (it neither flies nor collides)",
      mass: "kg; absent, density × the volume of its stamped shape (shapes.js shapeVolume; a convex, mesh or compound shape's baked geometry). Never a constant",
      density: "kg/m³; absent, its material's surface density, else 1000 kg/m³ (water)",
      material: "a surface:<name> on @world; absent (or naming no surface there now), friction and restitution are its own fields', else the engine's own law",
      friction: "≥ 0, one coefficient (static = dynamic); absent, its material's, else the engine's own law (eidosim: its fixed constants)",
      restitution: "0..1; absent, its material's, else the engine's own law (eidosim: its fixed bounce)",
      frictionCombine: "average|min|multiply|max, how its friction meets another's (the higher in that order wins); absent, its material's, else average",
      restitutionCombine: "average|min|multiply|max, as frictionCombine; absent, its material's, else max",
      linearDamping: "1/s; absent, the engine's own law (eidosim: none)",
      angularDamping: "1/s; absent, the engine's own law (eidosim: none; it doesn't spin)",
      centerOfMass: "[x, y, z] m in its own frame; absent, the centroid of its stamped shape",
      ccd: "true: swept (continuous) collision for this body; absent, the engine's own law (eidosim sweeps every body)",
      layers: "32-bit collision layers it is in; absent, 1 (the first)",
      mask: "32-bit layers it collides with (both sides must accept); absent, all (0xffffffff)" },
    help: "how it takes part in physics: {kind: dynamic (it flies when thrown, dropped or punted; with no grabbable it can also be picked up) | static (a collider; what anything with a model becomes when the world runs physics) | kinematic (a collider moved only by edits and motion, never by the engine; it is never launched) | none (nothing collides with it), who: who may punt it (and pick it up, when it has no grabbable; default visitor), shape: stamped by the authority (its measured box; you never send it), and, for engines that read them (eidosim reads none of these yet): mass (kg; absent: density × volume), density (kg/m³), material (a surface:<name> on @world), friction, restitution (0..1), linearDamping, angularDamping (1/s), centerOfMass [x,y,z], ccd, layers, mask (32-bit collision layers), frictionCombine, restitutionCombine (average|min|multiply|max)}. Grabbable makes a thing carryable; physics makes it fall. With eidosim@0.5: a thrown thing flies, bounces off what's in the world and comes to rest; it does NOT push or topple things at rest (stacks don't fall over), and things don't spin" },
  // what a hand may do with it (research RESEARCH-grab-2026-10-06; shared/grab.js holds the shape, the defaults and the
  // check). Its own component, apart from dynamics: a lantern, a key, a book can be carried in a world with no physics.
  // shared/grab.js DEFAULTS, written down: the ones absent by meaning (no grips, no home, no use, a size-chosen pose)
  // stay absent. grab-check pins that these equal grab.js's own.
  grabbable: { on: "thing", refPaths: { "home.parent.to": "ref" }, defaults: { enabled: true, who: "visitor", steal: true, range: 1.5, priority: 0, hold: "auto", twoHanded: false, throw: 1, release: "drop", returnAfter: 0 }, help: "it can be picked up and carried (grab, put, drop, throw; a VR hand's grip; desktop T): {who?: visitor|builder|owner (default visitor), enabled? (false: not now), steal? (false: nobody takes it from a hand; owners may), range? (m from the hand, 0.1..10, default 1.5; past 1.5 it flies to you), priority? (-10..10: wins when several are in reach), hold?: auto|press|toggle, pose?: hand|carry|torch|pistol|two-hand|shoulder (a body without tracked hands; default by size), grips? {<name>: {pos, q?, hand?: left|right|either, role?: primary|secondary, fingers?: fist|pinch|point|flat|open|trigger, hold?, part?}} (where the palm goes, in its own frame; none: held where grabbed), twoHanded?, throw? (0..3, ×the release velocity; 0: drop only), release?: drop|stay|return, returnAfter? (s unheld, then it goes home), home? (stamped by the authority), fits? [keywords] (snaps into a socket whose accepts shares one), use? (a reactions action, or {down, up}: what the use button fires while held), prompt? (hover text), fx? {particles, at?} (drawn while its holder presses use: presence, never logged)}. Grabbable makes it carryable; physics {kind: 'dynamic'} makes it fall. A dynamic thing with no grabbable is carryable by physics.who" },
  "physics-engine": { on: "world", fields: { engine: "string", build: "any", tickMs: "int" }, help: "on @world only (owner): the physics engine this world runs: {engine: 'eidosim@0.5.0', tickMs?}. The authority stamps the exact build. Delete it to turn physics off (refused while things are in flight)" },
  // spec/PHYSICS.md §3.2: a world's named surface materials (Marrow's Surface Data Cards: one name bundles a surface's
  // physical numbers; SLZ's format names materials, not raw per-object numbers). physics.material names one
  surface:   { on: "world", keyed: true, key: "instance", fields: { friction: "number", restitution: "number", density: "number", frictionCombine: "string", restitutionCombine: "string", label: "string" },
               enums: { frictionCombine: COMBINE, restitutionCombine: COMBINE }, ranges: { friction: { min: 0, max: 10 }, restitution: { min: 0, max: 1 }, density: { gt: 0, max: 1e5 }, label: { maxLen: 80 } },
               help: "on @world, keyed by name: a surface material things name with physics.material: {friction? (≥ 0), restitution? (0..1), density? (kg/m³), frictionCombine?, restitutionCombine? (average|min|multiply|max; absent: average and max), label?}. When two touching surfaces' combine modes differ, the higher of average < min < multiply < max wins (PHYSICS §3.2)" },
  // spec/PHYSICS.md §3.3: reserved so a door, a lever or a chain has ONE meaning when an engine can solve it. parent is a
  // rigid attachment, never a solver joint; openable is kinematic animation; a physical door is a joint. The authority
  // refuses it until the world's engine carries joints (none does yet)
  joint:     { on: "thing", keyed: true, key: "instance", fields: { to: "ref", type: "string", anchor: "vec3", axis: "axis", limits: "array", drive: "object", breakForce: "number" },
               enums: { type: ["fixed", "hinge", "slider", "ball", "distance", "spring"] }, ranges: { breakForce: { gt: 0 } },
               help: "reserved (refused until this world's engine carries joints): keyed by name, a physical joint to another thing: {to: id, type: fixed|hinge|slider|ball|distance|spring, anchor [x,y,z] (own frame, m), axis, limits [min, max] (rad or m), drive {stiffness, damping, maxForce}, breakForce (N)}" },
  "copy-of": { on: "thing", fields: { from: "string", key: "string" }, help: "set by the server on copies: {from: record hash, key}" },
  // a sound a thing plays (shared/sound.js; batch 2, 10-07): silent AT radius (a true taper to zero, not Web Audio's clamp,
  // which leaked about −21 dB across the whole world), cap 100 m, near ≤ radius (valueCheck), the authority stamps t0 when it
  // starts. src: this server's store, an allowlisted host's https link (everyone hears it), or another https link (only
  // viewers who allow untrusted links hear it; shared/mediasrc.js). Registered so it isn't refused as a near-miss of bounds
  sound:      { on: "thing", fields: { src: "string", playing: "bool", loop: "bool", volume: "number", pitch: "number", near: "number", radius: "number", spatial: "bool", t0: "number", alt: "string" },
                defaults: { playing: true, loop: true, volume: 0.8, pitch: 1, near: 1.5, radius: 12, spatial: true }, required: ["src"],
                ranges: { volume: { min: 0, max: 1 }, pitch: { min: 0.5, max: 2 }, near: { gt: 0, max: 100 }, radius: { min: 1, max: 100 }, src: { maxLen: 2048 }, alt: { maxLen: 200 } }, clean: { alt: "line" },
                help: "a sound this thing plays: {src (store/audio/…, eidoverse/assets/…, or an https link: an allowlisted host's plays for everyone, any other only for viewers who allow untrusted links), playing? (default true), loop?, volume? 0..1, pitch? 0.5..2 (playback rate), near? m (full volume inside it), radius? m (≤ 100: silent at and beyond it), spatial? (false: heard evenly inside radius, no panning), t0? (stamped by the authority when it starts), alt? (what is playing, in words: what agents and people who can't hear it read)}. A reaction {kind: 'play'} plays it again from the top" },
  // an image on a thing (shared/picture.js; batch 2): with no part it's a framed quad of its own (width m, height from the
  // image's aspect, facing +Z), with part it textures that model node's material. src as sound's, for images
  picture:    { on: "thing", fields: { src: "string", part: "string", width: "number", alt: "string", lit: "string", flip: "bool" },
                defaults: { lit: "scene", flip: false, width: 1 }, required: ["src"], enums: { lit: ["scene", "self"] },
                ranges: { width: { gt: 0, max: 20 }, part: { maxLen: 64 }, src: { maxLen: 2048 }, alt: { maxLen: 200 } }, clean: { alt: "line" },
                help: "an image on this thing: {src (store/images/…, eidoverse/assets/…, or an https link: see sound), part? (a model node to texture; absent = a picture of its own, a quad facing +Z), width? m (the quad's; its height follows the image), alt? (alternative text: what it shows, for people who can't see it and for agents), lit?: scene|self (self = a screen, unlit), flip?}" },
  // why a thing is here (batch 2; R: {title, text, marks?}): a museum label's title and text. Who wrote it is a view over
  // the log (History), never stored. The world's own blurb is @world.about
  story:      { on: "thing", fields: { title: "string", text: "string", marks: "refs" }, required: ["title", "text"],
                ranges: { title: { maxLen: 80 }, text: { maxLen: 1000 }, marks: { maxItems: 8 } }, clean: { title: "line", text: "lines" },
                help: "why this thing is here, a museum label: {title (≤ 80), text (≤ 1000; plain text, a blank line between paragraphs), marks? [ids] (≤ 8: what it marks or commemorates)}. Shown on Inspect and in look" },
  // words in the world (batch 2): signage, on the canvas text path (a browser font stack: CJK, RTL and emoji). Long-form
  // text (a book, a library) will be its own component; this one stays a sign
  text:       { on: "thing", fields: { text: "string", size: "number", width: "number", align: "string", color: "int", outline: "bool", background: "int", billboard: "string", lit: "string" },
                defaults: { size: 0.15, width: 2, align: "center", color: 0xffffff, outline: true, billboard: "off", lit: "self" }, required: ["text"],
                enums: { align: ["left", "center", "right"], billboard: ["off", "yaw", "full"], lit: ["self", "scene"] },
                ranges: { text: { maxLen: 400 }, size: { min: 0.02, max: 2 }, width: { min: 0.1, max: 10 }, color: { min: 0, max: 0xffffff }, background: { min: 0, max: 0xffffff } }, clean: { text: "lines" },
                help: "a sign: {text (≤ 400 characters, ≤ 16 lines), size? (line height, m; 0.02..2), width? (wrap width, m; 0.1..10), align?: left|center|right, color? 0xRRGGBB, outline? (a contrasting edge), background? 0xRRGGBB (a plate behind it; absent = none), billboard?: off (flat, facing +Z, readable from both sides) | yaw (turns about up toward each viewer) | full (faces each viewer, kept upright), lit?: self|scene}" },
  // a thing (or one part, look-at:<part>) turns to face something (batch 2; Unity AimConstraint, Blender Locked/Damped
  // Track, Resonite LookAt). State is logged; the turn is a view each client computes, like motion
  "look-at":  { on: "thing", keyed: "optional", fields: { target: "target", mode: "string", forward: "axis", up: "axis", yaw: "array", pitch: "array", speed: "number", range: "number", offset: "vec3" },
                defaults: { mode: "yaw", forward: "z", up: "y", speed: 240, range: 12 }, required: ["target"], enums: { mode: ["yaw", "aim"] },
                ranges: { speed: { min: 0, max: 3600 }, range: { gt: 0, max: 100 } },
                help: "it turns to face something: {target (a thing's id, @viewer: each viewer's own eyes, @nearest: whoever is nearest within range, or a person's identity u-…), mode?: yaw (turns about up only, stays upright) | aim (tilts too), forward? (its local axis that points: x|y|z|-x|-y|-z, default z, its front), up?, yaw? [min, max]° and pitch? [min, max]° (limits from rest), speed? °/s (0 = at once), range? m (a person beyond it: back to rest), offset? [x,y,z] (a point in the target thing's frame)}. look-at:<part> turns one model part" },
  // captions (a screen's live subtitles): written only by the caption request, a line at a time (shared/captions.js);
  // who may caption a screen is the screen's own captioners list (R leaned that way, 10-06, as the roles branch's CAPTION_ON_SCREENS does)
  captions:   { on: "thing", fields: { session: "string", n: "int", gen: "number", title: "string", mediaTime: "number", window: "array" }, help: "a screen's captions, written by the caption request only: {session, n, gen, title?, mediaTime, window: [{t0, t1, text, speaker?}]}" },
  captioners: { on: "thing", fields: { ids: "people" }, help: "who may caption this screen with the caption request: {ids: [<identity u-…>]}; anyone who may edit the screen may caption it too" },
  // round-2 review R8 (2026-10-05): names the engine reads, carried by imported worlds, registered with their old
  // meaning so it's fixed (L5). Fields from every old world log on Burrow, translated. A name not here is a world's own
  // invention (heart, inscription…): admitted, unless it's a near-miss of one of these (ligth).
  sky:       { on: "world", fields: { hours: "number", rate: "number", ts: "number", azimuth: "number", clouds: "string", weather: "string", forecast: "object", override: "object", weatherK: "number", clock: "string", tz: "string", dormantRated: "object", weatherSeconds: "number", fog: "number", exposure: "number", ambient: "number", sun: "number", fill: "number", world: "string" }, help: "on @world: the sky and its clock {hours, rate, weather, clouds, forecast, fog…}" },
  grass:     { on: "world", fields: { width: "number", depth: "number", center: "array", bladeHeight: "number", wind: "number", spacing: "number", perCell: "number", color: "any", colorTip: "number", species: "string", height: "number", density: "number", preset: "string", rows: "object", corn: "object" },
               ranges: { width: { gt: 0, max: 1000 }, depth: { gt: 0, max: 1000 }, bladeHeight: { gt: 0, max: 5 }, height: { gt: 0, max: 10 }, density: { min: 0, max: 4 },
                         spacing: { min: 0.05, max: 10 }, perCell: { min: 1, max: 32 }, wind: { min: 0, max: 10 } }, help: "a grass or crop field {width, depth, center, species, density…}" },
  structure: { on: "thing", fields: { tile: "number", wallH: "number", wallT: "number", slabT: "number", labels: "object", levels: "array" }, help: "a built structure's plan {tile, wallH, wallT, levels, labels}" },
  particles: { fields: { preset: "string", seed: "number", origin: "array", count: "number", quality: "string", size: "number", area: "any", texture: "string", speed: "number", opacity: "number", lifetime: "number" },
               // the renderer's own bounds (shared/particles.js NUMERIC_BOUNDS): the authority now says what the client would clamp
               ranges: { count: { min: 1, max: 600 }, size: { min: 0.005, max: 4 }, opacity: { min: 0, max: 1 }, speed: { min: 0.05, max: 8 }, lifetime: { min: 0.05, max: 30 }, area: { min: 0, max: 8 } }, help: "a particle emitter {preset, count, size, speed, lifetime…}" },
  "imported-epoch": { on: "world", fields: { sim: "string", tickMs: "number", ts: "number", seq: "number" }, help: "on @world: the physics epoch a translated world began (dialect 3), carried from translation" },
  "imported-behavior": { on: "world", keyed: true, key: "instance", fields: { src: "string", attach: "string", caps: "object", knobs: "object", author: "string", ts: "number", state: "object" }, help: "keyed by name: an imported world's old runtime-script binding, carried from translation (scripts are script:<name>)" },
  assets:    { on: "world", keyed: true, key: "instance", fields: { name: "string", path: "string" }, help: "on @world, keyed: one of the world's assets (a model added here)" },
  imported:  { keyed: true, key: "instance", help: "keyed: a field an imported world's translation had no mapping for, carried as it was" },
  "imported-bans": { on: "world", keyed: true, key: "instance", help: "on @world, keyed by identity: a ban an imported world carried, as it was (live bans are the moderator log's)" },
  // research roles 10-06 (shared/protocol/roles.js): ranked membership (visitor 0, builder 100, moderator 200, owner 255,
  // custom roles between) and a closed list of permissions. Banned and ghost are states in the moderator log, never roles.
  roles:     { on: "world", keyed: true, key: "instance", fields: { role: "string", can: "object", note: "string", sub: "any" }, help: "on @world, keyed by identity: {role: visitor|builder|moderator|owner|<a custom role>, can?: {<permission>: true|false} (exceptions on top of the role), note? (≤ 80)}. A grantRoles holder may give roles ranked below their own, with only permissions they hold" },
  // guests isn't written down: absent means visitor whatever the role (roles.js guestRoleOf), and a written visitor is
  // refused above a default role of none (guests never above role). Pinned as a known gap (pretrans D7)
  "default-role": { on: "world", fields: { role: "string", can: "object", guests: "string" }, help: "on @world (owner): the role of anyone without roles:<id> (absent = visitor): any role but owner; can? {<permission>: true|false} on top of that role for everyone who holds it this way (not guests); guests (people without an account) get guests (default visitor), never above role" },
  "role-defs": { on: "world", help: "on @world (owner): {<role id>: {name, rank (custom: 1–254, unique), can: {<permission>: true|false}, note?}}. Built-ins visitor, builder, moderator may be renamed and their permissions edited (rank fixed); owner holds every permission and isn't listed. Permissions: build, editOthers, editWorld, generate, fly, scripts, pauseScripts, mute, kick, ban, grantRoles" },
  access:    { on: "world", fields: { join: "string", max: "int", soft: "int", minAccountDays: "int" }, enums: { join: ["anyone", "signed-in", "listed"] }, ranges: { max: { min: 1, max: 200 }, soft: { min: 1, max: 200 }, minAccountDays: { min: 0, max: 365 } }, help: "on @world (owner): who may come in {join: anyone|signed-in|listed (only people with a roles:<id>), max? (1–200 at once), soft? (≤ max: the recommended capacity), minAccountDays? (0–365: a person's account must be at least this many days old; a guest is then refused, an enrolled agent is exempt; 0 or absent = off)}; moderators and owners always get in" },
  about:     { on: "world", fields: { name: "string", text: "string" }, help: "on @world: the world's name and blurb" },
  bounds:    { on: "world", fields: { min: "vec3", max: "vec3" }, help: "on @world: the box the world lives in (m)" },
  spawn:     { on: "world", fields: { pos: "vec3", radius: "number" }, help: "on @world: where visitors arrive {pos, radius}" },
  // research 40 §6.1: today's noise bag with `kind` explicit, or an imported raster as a value blob. Keys by kind.
  terrain:   { on: "world", fields: { kind: "string", seed: "int", size: "number", amplitude: "number", octaves: "int", frequency: "number", flatRadius: "number", flatHeight: "number",
                         blob: "string", w: "int", h: "int", spacing: "number", origin: "array", format: "string", segments: "int", layers: "any" },
               defaultKind: "noise", byKind: { noise: ["kind", "seed", "size", "amplitude", "octaves", "frequency", "flatRadius", "flatHeight", "segments", "layers"], raster: ["kind", "blob", "w", "h", "spacing", "origin", "format"] },
               // what every visitor's client can build: past these a single write freezes or breaks everyone (review T0)
               ranges: { size: { gt: 0, max: 4096 }, segments: { min: 2, max: 512 }, octaves: { min: 1, max: 8 }, frequency: { gt: 0, max: 64 },
                         amplitude: { min: -500, max: 500 }, flatRadius: { min: 0, max: 4096 }, w: { min: 2, max: 4096 }, h: { min: 2, max: 4096 }, spacing: { gt: 0, max: 64 } },
               help: "the ground's base: {kind: 'noise', seed, size, amplitude, octaves, frequency, flatRadius, flatHeight} or {kind: 'raster', blob, w, h, spacing, origin: [x, z], format: 'i32-mm-le'}" },
  "terrain-grid": { on: "world", fields: { spacing: "number", tile: "int", origin: "array", extent: "array", limits: "object" }, help: "the sculpt grid: {spacing (m), tile (samples per side), origin [x, z], extent [nx, nz] tiles, limits {raise, lower} (mm)}; fixed while any terrain-tile exists" },
  "terrain-tile": { on: "world", keyed: true, key: "partition", fields: { mm: "array" }, help: "keyed <i>-<j>: {mm: [tile² integer millimetres, row-major]}, a delta over the base; written whole by sculpt" },
  // research 41 §3.2: a behaviour. Keyed, so §5's creator rule decides who may change it and who its SPONSOR is.
  script:    { keyed: true, key: "instance", fields: { src: "string", scope: "object", on: "array", every: "number", always: "bool", knobs: "object", paused: "bool" },
               scopeFields: { ids: "scope", comps: "array", create: "bool", say: "bool", launch: "bool", bodies: "array" },
               help: "keyed <name>: a script (JavaScript; docs/SCRIPTS.md). {src: the source blob's name (upload {text} gives it), scope: {ids: 'self'|'subtree'|[ids], comps: [names, 'name:*'], create?, say?, bodies?: ['shove'|'pose']}, on: ['use', 'say', 'enter', 'leave', 'grab', 'release', 'changed:<comp>'], every?: s (>= 5; it gets tick, and wake after sleeping), always?: bool (run with nobody present; owner), knobs?: {…} (<= 4 KiB), paused?}. It acts with its sponsor's rights now, never beyond its scope; a `use` reaches it through a reactions handler {kind: 'script', script: <name>}" },
  // §5 (23:40): keyed names say which kind of key they are. instance: the creator rule; partition: one shared surface
  schemas:   { on: "world", keyed: true, key: "instance", help: "on @world (owner), keyed by component name: the content hash of that name's written definition; set once, never changed (PROTOCOL §4)" },
  blueprints: { on: "world", keyed: true, key: "instance", help: "on @world, keyed by a blueprint's hash: {name, …} (publish writes it)" },
  "terrain-paint": { on: "world", keyed: true, key: "partition", help: "keyed <i>-<j>: paint channels for one tile (research 40 §3; not built in the lab)" },
  capacity:  { on: "world", fields: { things: "int", guestThings: "int" }, defaults: { things: 2000, guestThings: 200 }, ranges: { things: { min: 1, max: 5000 }, guestThings: { min: 0, max: 5000 } },
               help: "on @world (owner): how much this world holds: {things (default 2000, at most 5000), guestThings (default 200: how many things people without an account may have standing here, all of them together)}. A create past either is refused (full)" },
  "script-settings": { on: "world", fields: { run: "bool", install: "string", max: "int", budget: "int", rate: "int", depth: "int", fails: "int", cpu: "int", runs: "int" }, enums: { install: ["builder", "owner"] },
               defaults: { run: true, install: "builder", max: 12, budget: 600, rate: 6, depth: 8, fails: 5, cpu: 2000, runs: 60 },   // the authority's SCRIPTS (pretrans D6 pins they agree)
               ranges: { max: { min: 0, max: 64 }, budget: { min: 0, max: 100000 }, rate: { min: 0, max: 600 }, depth: { min: 1, max: 32 }, fails: { min: 1, max: 100 }, cpu: { min: 0, max: 60000 }, runs: { min: 0, max: 600 } },
               help: "on @world (owner): {run: false stops every script, install: 'builder'|'owner', max (scripts, default 12), budget (script entries per hour, default 600; each sponsor gets a fair share), rate (logged activations per script per minute, default 6), depth (cascade depth, default 8), fails (failed activations in a row before a script pauses, default 5), cpu (ms of the authority's time per sponsor per minute, default 2000; the world 3×), runs (activations per script per minute, whatever they write, default 60)}" },
};

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
/** Every THING an entity's component value refers to: [{path: "story.marks[1]", id}]. People and @words aren't things. */
export function refsOf(comp, v) {
  const out = []; const name = baseOf(comp);
  for (const { path, type } of refFields(comp)) { const x = getAt(v, path); const at = `${name}.${path.join(".")}`;
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
  for (const { path, type } of refFields(comp)) {
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
/** A value with its definition's defaults written in: `defaults`, then each `when` rule that holds, never over a field
 *  that's there. {value, filled: [fields written]}. A non-object value, or a name with no definition, comes back as it is. */
export function materialize(comp, v) {
  const def = defOf(comp);
  if (!def || !v || typeof v !== "object" || Array.isArray(v)) return { value: v, filled: [] };
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

// ---- what a name means, pinned (PROTOCOL §4: a name never changes meaning) ----
// The checkable part of a definition: each field's type, each default (and when it applies), each enum's members. A
// change to any of these is a changed meaning, so spec/registry-pin.json holds them and test:protocol fails when one
// moves (pretrans-check D8); a NEW field, default, enum member or name is an addition and is fine. A field added to a name
// after its first registration must say what an older value without it means (`absentMeans`, PROTOCOL §4; D11), and that
// sentence is pinned too, as is a field's `grammar` (physics.shape). Regenerate the pin only for an addition:
// bun tools/protocol/pretrans-check.ts --pin
export function pinOf() {
  const out = {};
  for (const [name, d] of Object.entries(COMPONENTS)) {
    const p = {};
    if (d.type) p.type = d.type;
    if (d.fields) p.fields = { ...d.fields };
    if (d.defaults) p.defaults = copy(d.defaults);
    if (d.when) p.when = copy(d.when);
    if (d.enums) p.enums = copy(d.enums);
    if (d.absentMeans) p.absentMeans = { ...d.absentMeans };
    if (d.grammar) p.grammar = { ...d.grammar };
    if (d.keyed !== undefined) p.keyed = d.keyed;
    if (d.on) p.on = d.on;
    out[name] = p;
  }
  return out;
}
/** What changed meaning between a pin and now (removals and changes; additions are not breaks). [] = nothing. */
export function pinBreaks(pin, now = pinOf()) {
  const out = [], j = (x) => JSON.stringify(x);
  for (const [name, p] of Object.entries(pin)) {
    const n = now[name]; if (!n) { out.push(`${name}: the name is gone (a registered name is read forever)`); continue; }
    for (const k of ["type", "keyed", "on"]) if (p[k] !== undefined && j(p[k]) !== j(n[k])) out.push(`${name}: ${k} ${j(p[k])} → ${j(n[k])}`);
    for (const [f, t] of Object.entries(p.fields ?? {})) if (n.fields?.[f] !== t) out.push(`${name}.${f}: type ${t} → ${n.fields?.[f] ?? "gone"}`);
    for (const [f, v] of Object.entries(p.defaults ?? {})) if (j(n.defaults?.[f]) !== j(v)) out.push(`${name}.${f}: default ${j(v)} → ${j(n.defaults?.[f]) ?? "gone"}`);
    for (const r of p.when ?? []) if (!(n.when ?? []).some((q) => j(q.if) === j(r.if) && j(q.absent) === j(r.absent) && Object.entries(r.set).every(([f, v]) => j(q.set?.[f]) === j(v)))) out.push(`${name}: a conditional default changed: ${j(r)}`);
    for (const [f, vals] of Object.entries(p.enums ?? {})) for (const x of vals) if (!(n.enums?.[f] ?? []).includes(x)) out.push(`${name}.${f}: ${j(x)} is no longer allowed`);
    for (const [f, m] of Object.entries(p.absentMeans ?? {})) if (n.absentMeans?.[f] !== m) out.push(`${name}.${f}: its meaning of absence ${j(m)} → ${j(n.absentMeans?.[f]) ?? "gone"}`);
    for (const [f, g] of Object.entries(p.grammar ?? {})) if (n.grammar?.[f] !== g) out.push(`${name}.${f}: grammar ${g} → ${n.grammar?.[f] ?? "gone"}`);
    // PROTOCOL §4: a field added after the name's first registration says what an older value WITHOUT it means (a value
    // stored before it existed never holds it, and materialize never rewrites the past), and that meaning is pinned
    for (const f of Object.keys(n.fields ?? {})) if (!Object.hasOwn(p.fields ?? {}, f) && !(typeof n.absentMeans?.[f] === "string" && n.absentMeans[f].trim()))
      out.push(`${name}.${f}: added after ${name} was first registered, with no meaning of absence (absentMeans.${f}: what an older value without it means)`);
  }
  return out;
}

export const PENDULUM = { type: "pendulum", axis: [1, 0, 0], amp: 0, period: 2.4, damp: 0.08, maxAmp: 0.9, phase: 0 };
