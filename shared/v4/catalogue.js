// What a builder can discover: models (with real bounds and support surfaces) and component types (with their
// defaults, which the door writes out in full, R7). Models are local-space boxes with the origin at the base centre,
// front = +Z.

export const MODELS = {
  table:       { size: [1.2, 0.75, 0.8],  surfaces: [{ y: 0.75 }], label: "a wooden table" },
  chair:       { size: [0.5, 0.9, 0.5],   surfaces: [{ y: 0.45, inset: 0.05 }], sockets: { seat: { pos: [0, 0.45, 0], body: { pose: "sitchair" } } }, label: "a chair" },
  "table-lamp":{ size: [0.3, 0.5, 0.3],   surfaces: [], label: "a small table lamp" },
  "floor-lamp":{ size: [0.4, 1.7, 0.4], solids: [[[-0.2,0,-0.2],[0.2,0.05,0.2]], [[-0.03,0,-0.03],[0.03,1.45,0.03]], [[-0.2,1.45,-0.2],[0.2,1.7,0.2]]],   surfaces: [], label: "a standing lamp" },
  crate:       { size: [0.6, 0.6, 0.6],   surfaces: [{ y: 0.6 }], label: "a wooden crate" },
  wall:        { size: [4, 2.6, 0.15],    surfaces: [], label: "a plaster wall section" },
  door:        { size: [0.9, 2.1, 0.06],  surfaces: [], label: "a plank door (hinge on its left edge)" },
  shelf:       { size: [1.0, 1.8, 0.35], solids: [[[-0.5,0,-0.175],[-0.47,1.8,0.175]], [[0.47,0,-0.175],[0.5,1.8,0.175]], [[-0.5,0,-0.175],[0.5,1.8,-0.155]], [[-0.47,0,-0.155],[0.47,0.03,0.175]], [[-0.47,0.37,-0.155],[0.47,0.4,0.175]], [[-0.47,0.77,-0.155],[0.47,0.8,0.175]], [[-0.47,1.17,-0.155],[0.47,1.2,0.175]], [[-0.47,1.57,-0.155],[0.47,1.6,0.175]], [[-0.47,1.77,-0.155],[0.47,1.8,0.175]]],  surfaces: [{ y: 0.4, inset: 0.03 }, { y: 0.8, inset: 0.03 }, { y: 1.2, inset: 0.03 }, { y: 1.6, inset: 0.03 }], label: "a bookshelf with four shelves" },
  book:        { size: [0.04, 0.22, 0.15], surfaces: [], label: "a book (spine faces +Z)" },
  "swing-frame": { size: [2.0, 2.2, 1.2], solids: [[[-1,0,-0.6],[-0.9,2.2,0.6]], [[0.9,0,-0.6],[1,2.2,0.6]], [[-1,2.1,-0.06],[1,2.2,0.06]]], surfaces: [], label: "an A-frame for a swing" },
  "swing-seat":  { size: [0.6, 0.05, 0.3], surfaces: [{ y: 0.05 }], sockets: { seat: { pos: [0, 0.05, 0], body: { action: "sit", pose: "sit" } } }, label: "a plank swing seat on ropes" },
  bed:         { size: [1.0, 0.5, 2.0],   surfaces: [{ y: 0.5 }], label: "a single bed" },
  rug:         { size: [2.0, 0.01, 1.4],  surfaces: [{ y: 0.01 }], label: "a woven rug" },
  ball:        { size: [0.22, 0.22, 0.22], surfaces: [], label: "a rubber ball" },
  bell:        { size: [0.25, 0.3, 0.25], surfaces: [], label: "a brass hand bell" },
};

export const COMPONENTS = {
  transform: { on: "thing", fields: { pos: "vec3", q: "array", scale: "vec3" }, defaults: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, help: "where it is: pos (m), q (unit quaternion), scale" },
  model:     { on: "thing", type: "string", help: "which model it shows: a name from find {kind: 'model'}" },
  label:     { type: "string", help: "its display name, a short string" },
  pivot:     { on: "thing", help: "{pos: [x,y,z]}: where it turns and scales from, in its own frame before scale ([0,0,0] = its origin). Never moves it or changes how it draws" },
  // attaching to a NAMED point on the parent is general (Unreal AttachToComponent's SocketName, Roblox Attachment,
  // Godot BoneAttachment3D): slot names one of the parent's sockets; seat presence uses the same word
  parent:    { on: "thing", fields: { to: "string", order: "string", slot: "string" }, defaults: { order: "a0" }, help: "{to: id, slot?: one of its sockets}; its transform becomes local to the parent (to the socket, with slot)" },
  // the punctual light every engine shares (glTF KHR_lights_punctual, Godot OmniLight3D/SpotLight3D, Unity Light,
  // three.js): kind, color, intensity, range; a spot adds its cone as HALF-angles in radians (glTF outer/innerConeAngle,
  // Godot spot_angle, three.js angle/penumbra) and shines along the thing's local -Z (glTF, Godot)
  light:     { fields: { kind: "string", color: "int", intensity: "number", range: "number", angle: "number", inner: "number", shadows: "bool", keep: "bool", day: "bool" }, defaults: { kind: "point", color: 0xffd9a0, intensity: 16, range: 10, shadows: false }, enums: { kind: ["point", "spot"] },
    ranges: { color: { min: 0, max: 0xffffff }, intensity: { min: 0 }, range: { gt: 0 }, angle: { gt: 0, max: Math.PI / 2 }, inner: { min: 0, max: Math.PI / 2 } },
    help: "a light on this thing: {kind: point|spot, color (0xRRGGBB), intensity, range (m), shadows}; a spot shines along the thing's -Z with angle (its cone's half-angle, rad, default π/4) and inner (where the edge starts to soften, rad, default 0)" },
  motion:    { on: "thing", keyed: "optional", fields: { type: "string", axis: "axis", amp: "number", period: "number", damp: "number", maxAmp: "number", phase: "number", t0: "number", part: "string", radius: "number", degPerSec: "number", amplitude: "number", pivot: "vec3" }, enums: { type: ["pendulum", "spin", "orbit", "bob"] }, help: "{type: pendulum|spin|bob, axis [x,y,z] (local), amp (rad or m), period (s), damp, maxAmp, phase}; a pendulum swings about the point it hangs from; the door stamps t0" },
  lock:      { help: "true: an edit lock (PROTOCOL-v4 §5; the first protocol's lock, same meaning). Nobody, its locker and owners included, may move, replace or delete it, or anything attached to it; edits that don't relocate it (label, light, motion, reactions…) stay open. Any builder or owner may unlock it (delete {id, component: 'lock'}), or act through it by sending a request with through_lock: true. Not on @world. A door's gameplay lock is `door.locked`, not this" },
  // a named attachment point on the thing (Unreal sockets, Roblox Attachment). With `body`, a PERSON can attach there by
  // using it (VRChat Station, Roblox Seat): chairs, swings, saddles, a car's seats. Things attach with parent {to, slot}.
  sockets:   { on: "thing", map: "object", help: "{<name>: {pos: [x,y,z] (its own frame), q? [x,y,z,w] (its rotation: a rocket seat lies on its back), part? (a model node it rides), accepts? [keywords] + radius? (m, default 0.15): a thing released within radius whose grabbable.fits shares a keyword snaps in (a key on its hook, a sword in its rack), body?: what a person's body does there: {action ('sit'; what 'use' calls it), anchor (root, the default | hips | feet | head: the body point on the socket), pose (a clip; {clip, time: 'phase'}; or a blend {by: 'speed'|'steer'|…|'param.<name>', clips: [[0,'idle'],[2,'walk']]}), poses {<name>: pose} + sync, approach [x,y,z,yaw], enter/leave (clips), exit [x,y,z], reach {leftHand: {at, q?, part?, hint?, vr: snap|track|near}}, hold {<bone>: q}, look {yaw: [min,max]°, pitch, up: world|socket}, input {move: none|drive|walk, look: free|aim|locked} (one drive per thing), leaveBy (jump|menu|script), fromSeat, who (builder|owner)}}}" },
  // the numbers a thing exposes to the bodies on it (a pose blends by `param.<name>`); scripts write them
  params:    { on: "thing", map: "number", help: "{<name>: number}: values a socket's pose can blend by (param.<name>); scripts write them" },
  reactions: { help: "{<action>: handler}: what happens when someone uses it. Each handler may add who: 'builder'|'owner' (who may use it) and teach: text (shown on refusal).",
    handlers: {
      toggle: { args: { component: "the component to flip (default 'door')", field: "the field inside it to flip (default 'open' for a door; leave both out for a door). A named component with no field flips its whole value", unless: "a field of the same component that, when true, bars it (e.g. 'locked')" }, example: { open: { kind: "toggle", component: "door", field: "open", unless: "locked" } } },
      set: { args: { component: "which component", field: "optional: the field inside it to set", value: "the value it gets" }, example: { bolt: { kind: "set", component: "door", field: "locked", value: true, who: "builder" } } },
      // the general primitive pair (Godot apply_impulse / apply_torque_impulse; Unity AddForce / AddTorque with
      // ForceMode.Impulse; Rapier and PhysX applyImpulse / applyTorqueImpulse): a push changes the thing's velocity at its
      // centre (strength, m/s) or its turn rate about its axis (angular, rad/s). A hinged thing (a pendulum motion) takes
      // strength as strength / its distance from the hinge, and angular as it is.
      // research 41 §3.1: the join between the two tiers. The action list, its `who` gate and its `teach` stay data; only
      // the effect is computed, by the script:<name> on the same thing, with its sponsor's rights narrowed to its scope
      script: { args: { script: "the name of a script on this same thing (its component is script:<name>)" }, example: { ring: { kind: "script", script: "bell" } } },
      // batch 2: a doorbell plays its sound again from the top, whether or not it's playing (set can't restart it, toggle
      // would stop it): the door writes sound {…, playing: true, t0: now}
      play: { args: {}, example: { ring: { kind: "play" } } },
      impulse: { args: { strength: "a push: the speed it gives the thing at its centre, m/s (default 0.5). A use may give its own push as args.impulse [x,y,z] (m/s)", angular: "or a turn: the turn rate it adds about the thing's axis, rad/s (instead of strength)" }, example: { push: { kind: "impulse", strength: 0.5 } } } },
    common: { kind: "the handler kind", who: "who may use it: builder|owner", teach: "text shown on refusal" } },
  door:      { on: "thing", fields: { open: "bool", locked: "bool" }, help: "{open: true/false, locked: true/false}: a door's own state. `locked` is gameplay (it bars the open handler); the edit lock is the separate `lock` component" },
  physics:   { on: "thing", fields: { kind: "string", who: "string", shape: "any" }, defaults: { kind: "dynamic" }, enums: { kind: ["dynamic", "static", "none"] },
    help: "how it takes part in physics: {kind: dynamic (it flies when thrown, dropped or punted; with no grabbable it can also be picked up) | static (a collider; what anything with a model becomes when the world runs physics) | none (nothing collides with it), who: who may punt it (and pick it up, when it has no grabbable; default builder), shape: stamped by the door (its measured box; you never send it)}. Grabbable makes a thing carryable; physics makes it fall. With eidosim@0.5: a thrown thing flies, bounces off what's in the world and comes to rest; it does NOT push or topple things at rest (stacks don't fall over), and things don't spin" },
  // what a hand may do with it (research RESEARCH-grab-2026-10-06; shared/grab.js holds the shape, the defaults and the
  // check). Its own component, apart from dynamics: a lantern, a key, a book can be carried in a world with no physics.
  grabbable: { on: "thing", help: "it can be picked up and carried (grab, put, drop, throw; a VR hand's grip; desktop T): {who?: visitor|builder|owner (default builder), enabled? (false: not now), steal? (false: nobody takes it from a hand; owners may), range? (m from the hand, 0.1..10, default 1.5; past 1.5 it flies to you), priority? (-10..10: wins when several are in reach), hold?: auto|press|toggle, pose?: hand|carry|torch|pistol|two-hand|shoulder (a body without tracked hands; default by size), grips? {<name>: {pos, q?, hand?: left|right|either, role?: primary|secondary, fingers?: fist|pinch|point|flat|open|trigger, hold?, part?}} (where the palm goes, in its own frame; none: held where grabbed), twoHanded?, throw? (0..3, ×the release velocity; 0: drop only), release?: drop|stay|return, returnAfter? (s unheld, then it goes home), home? (stamped by the door), fits? [keywords] (snaps into a socket whose accepts shares one), use? (a reactions action, or {down, up}: what the use button fires while held), prompt? (hover text), fx? {particles, at?} (drawn while its holder presses use: presence, never logged)}. Grabbable makes it carryable; physics {kind: 'dynamic'} makes it fall. A dynamic thing with no grabbable is carryable by physics.who" },
  sim:       { on: "world", fields: { engine: "string", build: "any", tickMs: "int" }, help: "on @world only (owner): the physics engine this world runs: {engine: 'eidosim@0.5.0', tickMs?}. The door stamps the exact build. Delete it to turn physics off (refused while things are in flight)" },
  blueprint: { on: "thing", fields: { from: "string", key: "string" }, help: "set by the server on copies: {from: record hash, key}" },
  // a sound a thing plays (shared/sound.js; batch 2, 10-07): silent AT radius (a true taper to zero, not Web Audio's clamp,
  // which leaked about −21 dB across the whole world), cap 100 m, near ≤ radius (valueCheck), the door stamps t0 when it
  // starts. src: this server's store, an allowlisted host's https link (everyone hears it), or another https link (only
  // viewers who allow untrusted links hear it; shared/mediasrc.js). Registered so it isn't refused as a near-miss of bounds
  sound:      { on: "thing", fields: { src: "string", playing: "bool", loop: "bool", volume: "number", pitch: "number", near: "number", radius: "number", spatial: "bool", t0: "number", alt: "string" },
                defaults: { playing: true, loop: true, volume: 0.8, pitch: 1, near: 1.5, radius: 12, spatial: true }, required: ["src"],
                ranges: { volume: { min: 0, max: 1 }, pitch: { min: 0.5, max: 2 }, near: { gt: 0, max: 100 }, radius: { min: 1, max: 100 }, src: { maxLen: 2048 }, alt: { maxLen: 200 } }, clean: { alt: "line" },
                help: "a sound this thing plays: {src (store/audio/…, eidoverse/assets/…, or an https link: an allowlisted host's plays for everyone, any other only for viewers who allow untrusted links), playing? (default true), loop?, volume? 0..1, pitch? 0.5..2 (playback rate), near? m (full volume inside it), radius? m (≤ 100: silent at and beyond it), spatial? (false: heard evenly inside radius, no panning), t0? (stamped by the door when it starts), alt? (what is playing, in words: what agents and people who can't hear it read)}. A reaction {kind: 'play'} plays it again from the top" },
  // an image on a thing (shared/picture.js; batch 2): with no part it's a framed quad of its own (width m, height from the
  // image's aspect, facing +Z), with part it textures that model node's material. src as sound's, for images
  picture:    { on: "thing", fields: { src: "string", part: "string", width: "number", alt: "string", lit: "string", flip: "bool" },
                defaults: { lit: "scene", flip: false, width: 1 }, required: ["src"], enums: { lit: ["scene", "self"] },
                ranges: { width: { gt: 0, max: 20 }, part: { maxLen: 64 }, src: { maxLen: 2048 }, alt: { maxLen: 200 } }, clean: { alt: "line" },
                help: "an image on this thing: {src (store/images/…, eidoverse/assets/…, or an https link: see sound), part? (a model node to texture; absent = a picture of its own, a quad facing +Z), width? m (the quad's; its height follows the image), alt? (alternative text: what it shows, for people who can't see it and for agents), lit?: scene|self (self = a screen, unlit), flip?}" },
  // why a thing is here (batch 2; R: {title, text, marks?}): a museum label's title and text. Who wrote it is a view over
  // the log (History), never stored. The world's own blurb is @world.about
  story:      { on: "thing", fields: { title: "string", text: "string", marks: "array" }, required: ["title", "text"],
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
  "look-at":  { on: "thing", keyed: "optional", fields: { target: "string", mode: "string", forward: "axis", up: "axis", yaw: "array", pitch: "array", speed: "number", range: "number", offset: "vec3" },
                defaults: { mode: "yaw", forward: "z", up: "y", speed: 240, range: 12 }, required: ["target"], enums: { mode: ["yaw", "aim"] },
                ranges: { speed: { min: 0, max: 3600 }, range: { gt: 0, max: 100 } },
                help: "it turns to face something: {target (a thing's id, @viewer: each viewer's own eyes, @nearest: whoever is nearest within range, or a person's identity u-…), mode?: yaw (turns about up only, stays upright) | aim (tilts too), forward? (its local axis that points: x|y|z|-x|-y|-z, default z, its front), up?, yaw? [min, max]° and pitch? [min, max]° (limits from rest), speed? °/s (0 = at once), range? m (a person beyond it: back to rest), offset? [x,y,z] (a point in the target thing's frame)}. look-at:<part> turns one model part" },
  // captions (a screen's live subtitles): written only by the caption tool, a line at a time (shared/captions.js);
  // who may caption a screen is the screen's own captioners list (R leaned that way, 10-06, as the roles branch's CAPTION_ON_SCREENS does)
  captions:   { on: "thing", fields: { session: "string", n: "int", gen: "number", title: "string", mediaTime: "number", window: "array" }, help: "a screen's captions, written by the caption tool only: {session, n, gen, title?, mediaTime, window: [{t0, t1, text, speaker?}]}" },
  captioners: { on: "thing", fields: { ids: "array" }, help: "who may caption this screen with the caption tool: {ids: [<identity u-…>]}; anyone who may edit the screen may caption it too" },
  // round-2 review R8 (2026-10-05): names the engine reads, carried by imported worlds, registered with their old
  // meaning so it's fixed (L5). Fields from every old world log on Burrow, translated. A name not here is a world's own
  // invention (heart, inscription…): admitted, unless it's a near-miss of one of these (ligth).
  sky:       { on: "world", fields: { hours: "number", rate: "number", ts: "number", azimuth: "number", clouds: "string", weather: "string", forecast: "object", override: "object", weatherK: "number", clock: "string", tz: "string", dormantRated: "object", weatherSeconds: "number", fog: "number", exposure: "number", ambient: "number", sun: "number", fill: "number", world: "string" }, help: "on @world: the sky and its clock {hours, rate, weather, clouds, forecast, fog…}" },
  grass:     { on: "world", fields: { width: "number", depth: "number", center: "array", bladeHeight: "number", wind: "number", spacing: "number", perCell: "number", color: "any", colorTip: "number", species: "string", height: "number", density: "number", preset: "string", rows: "object", corn: "object" },
               ranges: { width: { gt: 0, max: 1000 }, depth: { gt: 0, max: 1000 }, bladeHeight: { gt: 0, max: 5 }, height: { gt: 0, max: 10 }, density: { min: 0, max: 4 },
                         spacing: { min: 0.05, max: 10 }, perCell: { min: 1, max: 32 }, wind: { min: 0, max: 10 } }, help: "a grass or crop field {width, depth, center, species, density…}" },
  structure: { on: "thing", fields: { tile: "number", wallH: "number", wallT: "number", slabT: "number", labels: "object", levels: "array" }, help: "a built structure's plan {tile, wallH, wallT, levels, labels}" },
  particles: { fields: { preset: "string", seed: "number", origin: "array", count: "number", quality: "string", size: "number", area: "any", texture: "string", speed: "number", opacity: "number", lifetime: "number" },
               // the renderer's own bounds (shared/particles.js NUMERIC_BOUNDS): the door now says what the client would clamp
               ranges: { count: { min: 1, max: 600 }, size: { min: 0.005, max: 4 }, opacity: { min: 0, max: 1 }, speed: { min: 0.05, max: 8 }, lifetime: { min: 0.05, max: 30 }, area: { min: 0, max: 8 } }, help: "a particle emitter {preset, count, size, speed, lifetime…}" },
  epoch:     { on: "world", fields: { sim: "string", tickMs: "number", ts: "number", seq: "number" }, help: "on @world: the physics epoch a translated world began (dialect 3)" },
  behavior:  { on: "world", keyed: true, key: "instance", fields: { src: "string", attach: "string", caps: "object", knobs: "object", author: "string", ts: "number", state: "object" }, help: "keyed by name: an imported world's old runtime-script binding, carried from translation (scripts are script:<name>)" },
  palette:   { on: "world", keyed: true, key: "instance", fields: { name: "string", path: "string" }, help: "on @world, keyed: an asset on the world's palette" },
  legacy:    { keyed: true, key: "instance", help: "keyed: a field an imported world's translation had no mapping for, carried as it was (R10)" },
  // research roles 10-06 (shared/v4/roles.js): ranked membership (visitor 0, builder 100, moderator 200, owner 255,
  // custom roles between) and a closed list of switches. Banned and ghost are states in the moderator log, never roles.
  roles:     { on: "world", keyed: true, key: "instance", fields: { role: "string", can: "object", note: "string", gen: "bool", sub: "any" }, help: "on @world, keyed by identity: {role: visitor|builder|moderator|owner|<a custom role>, can?: {<switch>: true|false} (exceptions on top of the role), note? (≤ 80)}. A grantRoles holder may give roles ranked below their own, with only switches they hold" },
  "default-role": { on: "world", fields: { role: "string", gen: "bool", guests: "string" }, help: "on @world (owner): the role of anyone without roles:<id> (absent = visitor): any role but owner; guests (people without an account) get guests (default visitor), never above role" },
  "role-defs": { on: "world", help: "on @world (owner): {<role id>: {name, rank (custom: 1–254, unique), can: {<switch>: true|false}, note?}}. Built-ins visitor, builder, moderator may be renamed and their switches edited (rank fixed); owner holds every switch and isn't listed. Switches: build, editOthers, editWorld, generate, fly, scripts, pauseScripts, mute, kick, ban, grantRoles" },
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
               scopeFields: { ids: "any", comps: "array", create: "bool", say: "bool", launch: "bool", bodies: "array" },
               help: "keyed <name>: a script (JavaScript; docs/SCRIPTS-v4.md). {src: the source blob's name (upload {text} gives it), scope: {ids: 'self'|'subtree'|[ids], comps: [names, 'name:*'], create?, say?, bodies?: ['shove'|'pose']}, on: ['use', 'say', 'enter', 'leave', 'grab', 'release', 'changed:<comp>'], every?: s (>= 5; it gets tick, and wake after sleeping), always?: bool (run with nobody present; owner), knobs?: {…} (<= 4 KiB), paused?}. It acts with its sponsor's rights now, never beyond its scope; a `use` reaches it through a reactions handler {kind: 'script', script: <name>}" },
  // §5 (23:40): keyed names say which kind of key they are. instance: the creator rule; partition: one shared surface
  schemas:   { on: "world", keyed: true, key: "instance", help: "on @world (owner), keyed by component name: the content hash of that name's written definition; set once, never changed (L5, §3d M6)" },
  library:   { on: "world", keyed: true, key: "instance", help: "on @world, keyed by a blueprint's hash: {name, …} (publish writes it)" },
  "ground-paint": { on: "world", keyed: true, key: "partition", help: "keyed <i>-<j>: paint channels for one tile (research 40 §3; not built in the lab)" },
  capacity:  { on: "world", fields: { things: "int", guests: "int" }, ranges: { things: { min: 1, max: 5000 }, guests: { min: 0, max: 5000 } },
               help: "on @world (owner): how much this world holds: {things (default 2000, at most 5000), guests (default 200: what people without an account may have standing here, all of them together)}. A create past either is refused (full)" },
  scripts:   { on: "world", fields: { run: "bool", install: "string", max: "int", budget: "int", rate: "int", depth: "int", fails: "int", cpu: "int", runs: "int" }, enums: { install: ["builder", "owner"] },
               ranges: { max: { min: 0, max: 64 }, budget: { min: 0, max: 100000 }, rate: { min: 0, max: 600 }, depth: { min: 1, max: 32 }, fails: { min: 1, max: 100 }, cpu: { min: 0, max: 60000 }, runs: { min: 0, max: 600 } },
               help: "on @world (owner): {run: false stops every script, install: 'builder'|'owner', max (scripts, default 12), budget (script entries per hour, default 600; each sponsor gets a fair share), rate (logged activations per script per minute, default 6), depth (cascade depth, default 8), fails (failed activations in a row before a script pauses, default 5), cpu (ms of the door's time per sponsor per minute, default 2000; the world 3×), runs (activations per script per minute, whatever they write, default 60)}" },
};

export const PENDULUM = { type: "pendulum", axis: [1, 0, 0], amp: 0, period: 2.4, damp: 0.08, maxAmp: 0.9, phase: 0 };
