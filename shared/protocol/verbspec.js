// Every request verb declares its arguments: type, which modes they apply to, and an example. The authority validates every
// request against this BEFORE doing anything, and `help {verb}` is generated from it (fresh-builder findings W1–W3).
const xz = { type: "xz", doc: "[x, z] in metres (ground position; y comes from what's below)" };
const ref = (doc) => ({ type: "id", doc });
const target = (doc) => ({ type: "id|xz", doc });
export const PLACE_MODES = ["on", "beside", "hang", "against", "near", "at"];
export const VERBSPEC = {
  place: {
    doc: "put a thing somewhere by saying where it goes relative to other things; the authority solves the numbers",
    oneOf: PLACE_MODES,
    args: {
      id: ref("the thing to move"),
      on: { ...ref("put it on this thing's surface"), example: { id: "lamp-1", on: "table-1" } },
      beside: { ...ref("next to this thing, on the same support, backs flush"), example: { id: "book-2", beside: "book-1" } },
      hang: { ...ref("hang it below this thing (a frame, a beam)"), example: { id: "swing-1", hang: "frame-1", height: 0.45 } },
      against: { ...ref("back against this thing's face (a wall)"), example: { id: "shelf-1", against: "wall-n" } },
      near: { ...ref("on the floor near this thing"), example: { id: "chair-1", near: "table-1", facing: "table-1" } },
      at: { ...xz, example: { id: "crate-1", at: [2, -1] } },
      facing: { ...target("turn its front (+Z) toward this thing or [x, z] point"), modes: ["on", "near", "at", "hang"] },
      away: { type: "bool", doc: "with facing: turn its back to the target instead", modes: ["on", "near", "at", "hang"] },
      level: { type: "int", doc: "which surface of an `on` target (0 = lowest; default highest)", modes: ["on"] },
      offset: { ...xz, doc: "[dx, dz] from the surface's centre", modes: ["on"] },
      side: { type: "enum", values: ["left", "right", 1, -1], doc: "beside: left|right; against: 1|-1 = which face", modes: ["beside", "against"] },
      gap: { type: "number", doc: "metres of clearance", modes: ["beside", "against", "near"] },
      height: { type: "number", doc: "metres above the ground: hang (seat height), against (wall-mount height)", modes: ["hang", "against"] },
      along: { type: "number", doc: "metres along the target's width from its centre", modes: ["hang", "against"] },
      lying: { type: "bool", doc: "rest it on its largest face (a book laid flat); the authority handles the tilt", modes: ["on", "at", "near"] },
      attach: { type: "bool", doc: "ride with what it's placed on (default true for on/beside/hang/against-with-height)" },
      dry: { type: "bool", doc: "preview only" },
    },
  },
  // round-2 R10: a typo'd undo argument used to undo your latest act silently (undo {acts: 9}); now it's refused
  undo: { doc: "take back an act: your latest (bare), one by its act number, or one you tagged with label. You may undo your own acts, a builder's or visitor's if you're a builder, anyone's if you're an owner; never someone above you",
    args: { act: { type: "int", doc: "the act's number (history and inspect show them); someone else's needs the rank to revert it" }, label: { type: "string", doc: "the label you gave a batch or set" },
      actor: { type: "string", doc: "owners: roll back everything this person did since `since` (their identity; history shows it)" }, since: { type: "any", doc: "with actor: a version {seq, head} (history gives them)" },
      confirm: { type: "bool", doc: "with actor: needed to roll back more than 20 acts" }, dry: { type: "bool" } },
    example: { act: 42 } },
  history: { doc: "what happened, newest first. With id: that one thing's acts (who, when, which components), a page at a time; the reply's next goes in before to page back. Without id: the world's latest entries (oldest first in the page), filtered by verbs, paged with before or after. inspect's touched says who last changed each component within the recent window (beyond = unchanged since before that act: page history for older)",
    args: { id: ref("one thing (omit for the whole world)"), limit: { type: "int", doc: "acts per page (with id: default 5, at most 50; without: default 12)" }, before: { type: "int", doc: "continue from here: the previous reply's next (older than this seq)" },
      after: { type: "int", doc: "without id: newer than this seq, oldest first (the reply's next continues)" }, verbs: { type: "any", doc: "without id: only entries with one of these verbs or kinds (an imported entry matches its original verb: 'comp', 'mount')" } } },
  turn: {
    doc: "rotate a thing by an angle about an axis: in its own axes (space 'object', the default), its parent's, or the world's; about its pivot when it has one (the pivot stays put), else its origin",
    args: { id: ref("the thing to turn"), axis: { type: "any", doc: "'x', 'y', 'z' or [x, y, z]" }, deg: { type: "number", doc: "degrees; positive = counter-clockwise looking down the axis" },
      space: { type: "enum", values: ["object", "parent", "world"], doc: "whose axes: its own (default), its parent's, the world's" }, about: { type: "enum", values: ["pivot", "origin"], doc: "default: pivot if it has one" }, dry: { type: "bool", doc: "preview only" } },
    required: ["id", "axis", "deg"], example: { id: "plank-1", axis: "x", deg: 30, space: "object" } },
  create: {
    doc: "make a new thing; optionally place it in the same step",
    args: { id: { type: "string", doc: "optional; the server mints one if absent" }, model: { type: "string", doc: "a model from find {kind: 'model'}" },
      components: { type: "object", doc: "component values; see schema" }, from: { type: "string", doc: "a blueprint hash (find {kind: 'blueprint'}), or a thing's id to duplicate it with what's attached to it" },
      at: { type: "any", doc: "where: [x, z] on the ground, [x, y, z] exactly, or {pos, yaw|q}; with from, {pos, yaw|q} only (a duplicate's is local to the source's parent; default 0.5 m along x). Not with place" }, place: { type: "object", doc: "a place request without id", example: { model: "chair", place: { near: "table-1", facing: "table-1" } } }, dry: { type: "bool" } },
  },
  set: { doc: "replace a component's value (merge: true patches only the fields you send)", args: { id: ref("the thing"), component: { type: "string" }, value: { type: "any" }, merge: { type: "bool" }, force: { type: "bool", doc: "@world.physics-engine only: cut even with things in flight (they freeze where they are)" }, base: { type: "any", doc: "the version you read, {seq, head} (inspect → versions; never a bare seq); refused if someone changed it since, or if it isn't this world's history" }, dry: { type: "bool" } }, required: ["id", "component"],
    example: { id: "lamp-1", component: "light", value: { range: 8 }, merge: true } },
  delete: { doc: "remove a thing (with its children) or one component", args: { id: ref("the thing"), component: { type: "string" }, force: { type: "bool", doc: "@world.physics-engine only: cut even with things in flight" }, dry: { type: "bool" } }, required: ["id"] },
  move: { doc: "walk your body somewhere (presence: not recorded). Things you hold come with you. The authority tracks your body: about 6 m/s, 4 m at most in one go, not through walls. Your first move (arriving) and teleport: true are acts on the record, and can't carry things", args: { to: { type: "any", doc: "[x, y, z] in metres (y = the floor you stand on, usually 0)" }, teleport: { type: "bool", doc: "jump there (recorded; refused while holding; a world may limit arrivals to its spawn)" }, client: { type: "string", doc: "a presence claim (human|agent): shown, never read by consent (every body gets the same defaults)" } }, required: ["to"],
    example: { to: [0, 0, 1.5] } },
  grab: { doc: "pick something up (within its grabbable.range of your hand, default 1.5 m). Things with a grabbable component, or physics {kind: 'dynamic'} (then physics.who decides who may); inspect shows how it's held. You can catch a thing in the air. Grabbing what you already hold with your other hand takes it in both (twoHanded) or swaps hands", args: { id: ref("the thing"),
      hand: { type: "enum", values: ["left", "right"], doc: "which hand (default right, or the grip's own hand)" }, grip: { type: "string", doc: "one of its grabbable.grips by name (default: the first that suits the hand)" },
      offset: { type: "any", doc: "{pos: [x, y, z], q: [x, y, z, w]}: where it sits in your hand (the palm's frame), for a thing with no grips: a VR hand sends where it took hold" } }, required: ["id"],
    example: { id: "ball-1" } },
  put: { doc: "set down what you're holding. Leave pos out to set it straight down onto whatever's below your hand (or below at: [x, z]); or give pos (what a VR hand would): the authority checks it like any write (not inside things, not floating, within reach)", args: { id: ref("the thing you hold"), pos: { type: "any", doc: "[x, y, z]: where its origin goes" }, at: { type: "any", doc: "[x, z]: or just where on the floor: it is set there, on whatever is below, its bottom resting on it" }, q: { type: "any", doc: "[x, y, z, w] (optional)" } }, required: ["id"],
    example: { id: "ball-1" } },
  throw: { doc: "let go of what you're holding with a velocity; physics (if the world runs it) decides where it lands, and the log records where it came to rest", args: { id: ref("the thing you hold"), v: { type: "any", doc: "[x, y, z] in m/s (+y is up); 20 m/s max" }, pos: { type: "any", doc: "[x, y, z]: where your hand lets go (a VR hand, or the hand you see); within reach. Default: the authority's hand" }, w: { type: "any", doc: "[x, y, z]: its spin as the hand let go, rad/s about world axes (optional; recorded, and carried in the launch for engines that spin things: eidosim doesn't)" }, t: { type: "number", doc: "when the hand let go, on the authority's clock (the client's estimate, ms; optional; recorded for checks and smoothing, never a backdated sim input)" }, q: { type: "any", doc: "[x, y, z, w]: the thing's orientation as let go (a unit quaternion; optional). The launch carries it, so a client predicting its own throw folds the same inputs" } }, required: ["id", "v"],
    example: { id: "ball-1", v: [0, 3, 4] } },
  drop: { doc: "let go of what you're holding: it falls (with physics), or is set straight down (without); its grabbable may send it home, into a socket that accepts it, or leave it where you let go", args: { id: ref("the thing you hold"), pos: { type: "any", doc: "[x, y, z]: where your hand lets go; within reach" }, hand: { type: "enum", values: ["left", "right"], doc: "let go with this hand only (of a thing held in both: the other keeps it)" }, w: { type: "any", doc: "[x, y, z]: its spin as the hand let go, rad/s about world axes (optional; recorded, and carried in the launch for engines that spin things: eidosim doesn't)" }, t: { type: "number", doc: "when the hand let go, on the authority's clock (the client's estimate, ms; optional; recorded for checks and smoothing, never a backdated sim input)" }, q: { type: "any", doc: "[x, y, z, w]: the thing's orientation as let go (a unit quaternion; optional). The launch carries it, so a client predicting its own throw folds the same inputs" } }, required: ["id"], example: { id: "ball-1" } },
  punt: { doc: "kick a thing at your feet (or in the air beside you: a volley) into flight. Only things with physics {kind: 'dynamic'}; who may is physics.who (default visitor). Needs the world to run physics", args: { id: ref("the thing"), power: { type: "number", doc: "m/s along the line from your feet through it, lifted (default 4: a hop; 10: hard)" }, v: { type: "any", doc: "or exactly [x, y, z] in m/s (20 max)" }, shove: { type: "bool", doc: "true: a walking body's push (what a client sends when its body walks into the thing): needs v, along the ground at most what a 70 kg body's push passes to the thing's mass (3 m/s at most), from a body against the thing, never a thing under your feet, already moving, or one that would move someone (sat or stood on, or sliding into them)" } }, required: ["id"],
    example: { id: "ball-1", power: 6 } },
  // people (research roles 10-06): every act names an identity (whois {name} finds it) ranked below you
  warn: { doc: "warn someone: a record in the moderator log, and a notice they must dismiss. Needs mute, kick or ban; they must rank below you", args: { who: { type: "string", doc: "their identity (u-…)" }, reason: { type: "string", doc: "why (they see it)" } }, required: ["who", "reason"], example: { who: "u-…", reason: "please keep it friendly" } },
  mute: { doc: "mute someone's voice and/or chat for everyone, for a while (at most 7 days). Needs mute; they must rank below you. A chat-muted person may still whisper to a moderator", args: { who: { type: "string", doc: "their identity" }, minutes: { type: "number", doc: "how long: 5, 60, 1440…" }, channels: { type: "any", doc: "['voice'], ['chat'] or both (default both)" }, reason: { type: "string" } }, required: ["who", "minutes"], example: { who: "u-…", minutes: 60, channels: ["voice"], reason: "spam" } },
  unmute: { doc: "end a mute early (its author, an owner, or someone who outranks its author)", args: { who: { type: "string" } }, required: ["who"] },
  kick: { doc: "remove someone now; they can't come back for minutes (default 10, at most 60). Needs kick; they must rank below you; never an owner", args: { who: { type: "string" }, minutes: { type: "number", doc: "the cooldown before they may rejoin (1–60, default 10)" }, reason: { type: "string" } }, required: ["who"], example: { who: "u-…", minutes: 10, reason: "harassment" } },
  ban: { doc: "keep someone out: for days (at most 30 below owner), or, for owners, until lifted (leave days out). Needs ban; they must rank below you; never an owner", args: { who: { type: "string" }, days: { type: "number", doc: "1, 7, 30… (owners: leave out for until lifted)" }, reason: { type: "string" } }, required: ["who"], example: { who: "u-…", days: 7, reason: "spam" } },
  unban: { doc: "lift a ban (or a kick's cooldown): its author, an owner, or a ban holder who outranks its author", args: { who: { type: "string" } }, required: ["who"] },
  ghost: { doc: "ghost: in the world, outside society (unseen; can't interact, read or post chat). ghost {on} is yours to choose (spectate); ghost {who, minutes, reason} is a sanction (needs kick; they must rank below you; at most 7 days below owner)", args: { on: { type: "bool", doc: "you: become a ghost, or come back" }, who: { type: "string" }, minutes: { type: "number" }, reason: { type: "string" } }, example: { on: true } },
  unghost: { doc: "bring a ghosted person back (needs kick; its author, an owner, or someone at its author's rank or above)", args: { who: { type: "string" } }, required: ["who"] },
  modlog: { doc: "the moderation log, newest first, with role changes merged in (needs a moderation power)", args: { who: { type: "string", doc: "only this person" }, before: { type: "number", doc: "older than this ts (the reply's next)" }, limit: { type: "int" } } },
  bans: { doc: "who is banned, kicked (cooling down), muted or ghosted now, and bans that ended (needs a moderation power)", args: {} },
  use: { doc: "do something to a thing (inspect shows what it offers you). While you hold it, use {id} with no action fires its grabbable.use (its down; args {phase: 'up'} its up)", args: { id: ref("the thing"), action: { type: "string" }, args: { type: "object" }, dry: { type: "bool", doc: "preview only: what it would write (a script runs dry); nothing is logged" } }, required: ["id"],
    example: { id: "swing-1", action: "push", args: { impulse: [0, 0, 1.5] } } },
};
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const okType = (spec, v) => {
  switch (spec.type) {
    case "xz": return Array.isArray(v) && v.length === 2 && v.every(isNum);
    case "id": return typeof v === "string" && v.length > 0;
    case "id|xz": return (typeof v === "string" && v.length > 0) || (Array.isArray(v) && v.length === 2 && v.every(isNum));
    case "number": return isNum(v); case "int": return Number.isInteger(v); case "bool": return typeof v === "boolean";
    case "string": return typeof v === "string"; case "object": return v && typeof v === "object" && !Array.isArray(v);
    case "enum": return spec.values.includes(v); default: return true;
  }
};
export function validate(verb, a) {
  const T = VERBSPEC[verb]; if (!T) return null;
  const ex = (k) => T.args[k]?.example ?? T.example;
  for (const k of Object.keys(a)) if (!(k in T.args)) return { code: "unknown-arg", reason: `${verb} has no argument '${k}'`, fix: `${verb} takes: ${Object.keys(T.args).join(", ")}`, example: ex(k) };
  for (const k of T.required ?? []) if (a[k] === undefined) return { code: "missing-arg", reason: `${verb} needs '${k}'`, fix: T.doc, example: T.example };
  if (T.oneOf) { const m = T.oneOf.filter((k) => a[k] !== undefined);
    if (m.length !== 1) return { code: "shape", reason: m.length ? `say one of ${m.join(" / ")}, not several` : `${verb} needs one of: ${T.oneOf.join(", ")}`, fix: T.oneOf.map((k) => `${k}: ${T.args[k].doc}`).join("; "), example: T.args[m[0] ?? "on"].example };
    for (const [k, s] of Object.entries(T.args)) if (a[k] !== undefined && s.modes && !s.modes.includes(m[0])) return { code: "doesnt-apply", reason: `'${k}' doesn't apply with '${m[0]}' (it applies with ${s.modes.join(", ")})`, fix: `remove '${k}'${k === "facing" && ["beside", "against"].includes(m[0]) ? `: ${m[0]} sets the facing itself` : ""}`, example: T.args[m[0]].example }; }
  for (const [k, s] of Object.entries(T.args)) if (a[k] !== undefined && !okType(s, a[k])) return { code: "shape", reason: `'${k}' should be ${s.type === "enum" ? `one of ${s.values.join(" | ")}` : s.doc ?? s.type}, got ${JSON.stringify(a[k])}`, fix: s.doc ?? "", example: ex(k) };
  return null;
}
export function verbHelp(verb) { const T = VERBSPEC[verb]; if (!T) return null;
  return { verb, doc: T.doc, ...(T.oneOf ? { oneOf: T.oneOf } : {}), args: Object.fromEntries(Object.entries(T.args).map(([k, s]) => [k, { type: s.type === "enum" ? s.values : s.type, doc: s.doc, ...(s.modes ? { onlyWith: s.modes } : {}), ...(s.example ? { example: s.example } : {}) }])), ...(T.example ? { example: T.example } : {}) }; }
