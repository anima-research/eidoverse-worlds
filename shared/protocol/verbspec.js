// Every request verb declares its arguments: type, which modes they apply to, and an example. The authority validates every
// request against this BEFORE doing anything, and `help {verb}` is generated from it (fresh-builder findings W1–W3).
// EVERY verb the authority answers has a row (engine-scars 3.3, R 10-17 02:45; scars-check's verb-row check): an argument a verb doesn't
// list is refused `unknown-arg`, so tightening after ship would break every client that sends extras. Where a handler checks
// a value itself (with its own words and code), the row's type is `any`: the row names the argument, the handler judges it.
import { COMPONENTS } from "./componentspec.js";
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
    args: { act: { type: "int", doc: "the act's number (history and inspect show them); someone else's needs the rank to revert it" }, label: { type: "string", doc: "the label you gave a batch" },
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
    args: { id: { type: "string", doc: "leave it out: the authority mints every id. A placeholder '$name' is accepted: refs to it in the same request (a batch) resolve, and the reply's ids map gives the id it became; any other id is refused" }, model: { type: "string", doc: "a model from find {kind: 'model'}" },
      components: { type: "object", doc: "component values; see schema" }, from: { type: "string", doc: "a blueprint hash (find {kind: 'blueprint'}), or a thing's id to duplicate it with what's attached to it" },
      at: { type: "any", doc: "where: [x, z] on the ground, [x, y, z] exactly, or {pos, yaw|q}; with from, {pos, yaw|q} only (a duplicate's is local to the source's parent; default 0.5 m along x). Not with place" }, place: { type: "object", doc: "a place request without id", example: { model: "chair", place: { near: "table-1", facing: "table-1" } } }, dry: { type: "bool" } },
  },
  set: { doc: "replace a component's value (merge: true patches only the fields you send)", args: { id: ref("the thing"), component: { type: "string" }, value: { type: "any" }, merge: { type: "bool" }, force: { type: "bool", doc: "@world.physics-engine only: cut even with things in flight (they freeze where they are)" }, base: { type: "any", doc: "the version you read, {seq, head} (inspect → versions; never a bare seq); refused if someone changed it since, or if it isn't this world's history" }, dry: { type: "bool" } }, required: ["id", "component"],
    example: { id: "lamp-1", component: "light", value: { range: 8 }, merge: true } },
  delete: { doc: "remove a thing (with its children) or one component", args: { id: ref("the thing"), component: { type: "string" }, force: { type: "bool", doc: "@world.physics-engine only: cut even with things in flight" }, dry: { type: "bool" } }, required: ["id"] },
  move: { doc: "walk your body somewhere (presence: not recorded). Things you hold come with you. The authority tracks your body: about 6 m/s, 4 m at most in one go, not through walls. Arriving is presence (nothing is logged); teleport: true is an act on the record, and can't carry things", args: { to: { type: "any", doc: "[x, y, z] in metres (y = the floor you stand on, usually 0)" }, teleport: { type: "bool", doc: "jump there (recorded; refused while holding; a world may limit arrivals to its spawn)" }, height: { type: "number", doc: "your body's standing height in metres (0.5-4), as your own walker measures it: where water reaches on you (a short body swims sooner). Kept until you send another" }, scale: { type: "number", doc: "your body's size (0.5-2, as the size slider): its step, its haul-out and its box grow with it. Kept until you send another" } }, required: ["to"],
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
  punt: { doc: "send a loose thing beside your body (low by it, or in the air beside you: a volley) into flight with a velocity. Only things with physics {kind: 'dynamic'}; who may is physics.who (default visitor). Needs the world to run physics", args: { id: ref("the thing"), power: { type: "number", doc: "m/s along the line from where you stand through it, lifted (default 4: a hop; 10: hard)" }, v: { type: "any", doc: "or exactly [x, y, z] in m/s (20 max)" }, contact: { type: "bool", doc: "true: a moving body's contact push (what a client sends when its body moves into the thing): needs v, along the ground at most what a 70 kg body's push passes to the thing's mass (3 m/s at most), from a body against the thing, never a thing beneath the body, already moving, or one that would move someone (occupied, or sliding into them)" }, shove: { type: "bool", doc: "old spelling of contact (recorded as contact)" } }, required: ["id"],
    example: { id: "ball-1", power: 6 } },
  // people (research roles 10-06): every act names an identity (whois {name} finds it) ranked below you
  warn: { doc: "warn someone: a record in the moderator log, and a notice they must dismiss. Needs mute, kick or ban; they must rank below you", args: { who: { type: "string", doc: "their identity (u-…)" }, reason: { type: "string", doc: "why (they see it)" } }, required: ["who", "reason"], example: { who: "u-…", reason: "please keep it friendly" } },
  mute: { doc: "mute someone's voice and/or chat for everyone, for a while (at most 7 days). Needs mute; they must rank below you", args: { who: { type: "string", doc: "their identity" }, minutes: { type: "number", doc: "how long: 5, 60, 1440…" }, channels: { type: "any", doc: "['voice'], ['chat'] or both (default both)" }, reason: { type: "string" } }, required: ["who", "minutes"], example: { who: "u-…", minutes: 60, channels: ["voice"], reason: "spam" } },
  unmute: { doc: "end a mute early (its author, an owner, or someone who outranks its author)", args: { who: { type: "string" } }, required: ["who"] },
  kick: { doc: "remove someone now; they can't come back for minutes (default 10, at most 60). Needs kick; they must rank below you; never an owner", args: { who: { type: "string" }, minutes: { type: "number", doc: "the cooldown before they may rejoin (1–60, default 10)" }, reason: { type: "string" } }, required: ["who"], example: { who: "u-…", minutes: 10, reason: "harassment" } },
  ban: { doc: "keep someone out: for days (at most 30 below owner), or, for owners, until lifted (leave days out). Needs ban; they must rank below you; never an owner", args: { who: { type: "string" }, days: { type: "number", doc: "1, 7, 30… (owners: leave out for until lifted)" }, reason: { type: "string" } }, required: ["who"], example: { who: "u-…", days: 7, reason: "spam" } },
  unban: { doc: "lift a ban (or a kick's cooldown): its author, an owner, or a ban holder who outranks its author", args: { who: { type: "string" } }, required: ["who"] },
  ghost: { doc: "ghost: in the world, outside society (unseen; can't interact, read or post chat). ghost {on} is yours to choose (spectate); ghost {who, minutes, reason} is a sanction (needs kick; they must rank below you; at most 7 days below owner)", args: { on: { type: "bool", doc: "you: become a ghost, or come back" }, who: { type: "string" }, minutes: { type: "number" }, reason: { type: "string" } }, example: { on: true } },
  unghost: { doc: "bring a ghosted person back (needs kick; its author, an owner, or someone at its author's rank or above)", args: { who: { type: "string" } }, required: ["who"] },
  modlog: { doc: "the moderation log, newest first, with role changes merged in (needs a moderation power)", args: { who: { type: "string", doc: "only this person" }, before: { type: "number", doc: "older than this ts (the reply's next)" }, limit: { type: "int" } } },
  bans: { doc: "who is banned, kicked (cooling down), muted or ghosted now, and bans that ended (needs a moderation power)", args: {} },
  // ---- the rest of the authority's verbs (rows added 10-17: names and types; each handler still judges its values) ----
  leave: { doc: "leave the world: whatever you hold is dropped (the server sends this when you disconnect)", args: {} },
  wait: { doc: "what physics did lately: things in flight, things that came to rest in the last minute, and any not yet on the record", args: {} },
  consent: { doc: "your body's consent table (presence: never logged). Bare: read it, with asks waiting for you and the last attempts on you. preset/set/allow/deny/pause/friend/unfriend/delegate/undelegate change it (only you open it, and only you add or remove a friend or a delegate; a delegate you named may close it, of: <you>); answer replies to an ask", args: {
      preset: { type: "any", doc: "normal | open | friends-only | performer" }, set: { type: "any", doc: "{class, tier: everyone|friends, mode: allow|ask|deny} (the words before 10-17, strangers and everyone|nobody, are still taken)" },
      allow: { type: "any", doc: "an identity allowed (every class, or `class`) for `for` ms (default 1 h, at most 30 days)" }, deny: { type: "any", doc: "an identity refused (every class, or `class`) until lifted" },
      class: { type: "any", doc: "near | follow | touch | intimate | pose | shove | displace | voice (displace: someone dragging, carrying or occupying-with your body; `move` is its old spelling)" }, for: { type: "any", doc: "ms an allow lasts" }, pause: { type: "any", doc: "true: every class is deny, friends included" },
      friend: { type: "any", doc: "name a friend: the friends tier is mutual (both of you named each other)" }, delegate: { type: "any", doc: "name a delegate: they may close your table (pause, deny), never open it" },
      switch: { type: "any", doc: "your body's one switch: accept | ask | refuse (every act on your body gets this answer; a never for one person still wins). Only you" }, unfriend: { type: "any", doc: "take someone off your friends list: the mutual tier ends at once (only you)" }, undelegate: { type: "any", doc: "take someone off your delegates list: they can no longer close your table (only you)" },
      of: { type: "any", doc: "act on someone else's table (closing only, if they named you a delegate)" },
      answer: { type: "any", doc: "an ask's id" }, yes: { type: "any", doc: "with answer: true allows it this once" } }, example: { set: { class: "touch", tier: "everyone", mode: "ask" } } },
  body: { doc: "act on another body (pose, anim, shove, drag, occupy, carry): their consent decides, at once or after they answer an ask (20 s; silence is no)", args: {
      to: { type: "any", doc: "their identity" }, kind: { type: "any", doc: "pose | anim | shove | drag | occupy | carry" }, spec: { type: "any", doc: "what the act carries (a pose, a clip)" }, why: { type: "any", doc: "a line they see with the ask" } },
    required: ["to", "kind"], example: { to: "u-…", kind: "pose", spec: { clip: "wave" } } },
  reach: { doc: "touch someone: a named contact point on them, or a world point at their body; judged by where the hand lands (touch or intimate) against their consent", args: {
      who: { type: "any", doc: "their identity" }, point: { type: "any", doc: "a contact point (shoulder_l, hand_r, …)" }, at: { type: "any", doc: "[x, y, z]: a world point instead" }, why: { type: "any", doc: "a line they see with the ask" } },
    example: { who: "u-…", point: "shoulder_l" } },
  inbox: { doc: "what reached your body since you last asked (asks, replies, touches, revocations), then empty", args: {} },
  "create-world": { doc: "found this world (you become its owner)", args: { title: { type: "any", doc: "its name" }, text: { type: "any", doc: "a line about it" },
      from: { type: "any", doc: "a fork or reset: {world: sha256:…, head, seq?, name?}" }, ownerKey: { type: "any", doc: "your own governance key, ed25519:<base64url> (PROTOCOL §13)" }, dry: { type: "bool" } }, example: { title: "the meadow" } },
  help: { doc: "what the authority answers: every verb, or one verb's arguments with examples", args: { verb: { type: "string", doc: "one verb" } }, example: { verb: "place" } },
  look: { doc: "what's here: the things (a tree, the first `limit`), and the bodies (your own consent table and who touches you; of others, where they are)", args: { limit: { type: "number", doc: "things shown (default 40)" } } },
  inspect: { doc: "one thing in full: its components, versions, who touched what lately, its children, what it offers you", args: { id: ref("the thing") }, required: ["id"] },
  measure: { doc: "a thing's box, size, front and surfaces", args: { id: ref("the thing") }, required: ["id"] },
  find: { doc: "models this server has (query narrows), or this world's blueprints (kind: 'blueprint')", args: { kind: { type: "string", doc: "model (default) | blueprint" }, query: { type: "string" } }, example: { kind: "model", query: "chair" } },
  lint: { doc: "warnings about one thing, or the whole world (overlaps, floating things, references that name nothing)", args: { id: ref("one thing (omit for all)") } },
  schema: { doc: "the component registry: every component, or one, with its fields, defaults, ranges and status", args: { component: { type: "string" } }, example: { component: "light" } },
  publish: { doc: "save a thing (with what hangs on it), or several, as a blueprint of this world (@world.blueprints:<hash>)", args: { from: { type: "any", doc: "a thing's id, or a list of them" }, name: { type: "any", doc: "what it's called" },
      unwire: { type: "bool", doc: "publish even though links point outside: each is dropped and listed" }, dry: { type: "bool" } }, required: ["from"], example: { from: "lamp-1", name: "reading lamp" } },
  update: { doc: "move a blueprint copy to a newer version of its blueprint, keeping its own overrides", args: { copy: ref("the copy's root"), to: { type: "any", doc: "the newer blueprint's hash" },
      resolve: { type: "any", doc: "{\"<id>.<component>.<field>\": 'yours'|'theirs'} for parts changed on both sides ({\"<id>.<component>\": …} for a whole value)" }, dry: { type: "bool" } }, required: ["copy", "to"] },
  say: { doc: "chat: a line everyone here sees (to: one person)", args: { text: { type: "any", doc: "the words (at most 8192 characters)" }, to: { type: "any", doc: "one person's identity" },
      spoken: { type: "any", doc: "true: the words were voice-performed, by anyone (a person reading through TTS or a voice leg alike: it says how the words were performed, never what a participant is; display only)" }, utt: { type: "any", doc: "with spoken: the utterance counter" }, t0: { type: "any", doc: "with spoken: when it started (ms)" } }, required: ["text"], example: { text: "hello" } },
  caption: { doc: "one line of a screen's captions (if its captioners name you), or end: true to clear it", args: { id: ref("the screen"), session: { type: "any", doc: "the UTC time the captioner attached, a hyphen, 2–16 letters or digits" },
      n: { type: "any", doc: "the line's number in the session" }, t0: { type: "any" }, t1: { type: "any" }, text: { type: "any" }, speaker: { type: "any" }, title: { type: "any" }, end: { type: "any" },
      gen: { type: "any", doc: "stamped by the server from the connection (a captioner's leg generation)" }, dry: { type: "bool" } }, required: ["id"] },
  upload: { doc: "store a script's source (text) or a particle effect (effect); the reply's src goes in script:<name>", args: { text: { type: "any", doc: "JavaScript (docs/SCRIPTS.md)" }, effect: { type: "any", doc: "a particle effect document" }, dry: { type: "bool" } } },
  effect: { doc: "a particle effect by name (an Essential) or address (sha256:…)", args: { name: { type: "any" } }, required: ["name"], example: { name: "sparks" } },
  adopt: { doc: "take on a script someone else sponsors (it then runs on your rights)", args: { id: ref("the thing"), script: { type: "any", doc: "its name (script:<name>)" }, base: { type: "any", doc: "the version you read" }, dry: { type: "bool" } }, required: ["id", "script"] },
  scripts: { doc: "the scripts here and their status; with id + script + test, run one dry on a test event", args: { id: ref("one thing"), script: { type: "any" }, test: { type: "any", doc: "an event {on: 'use'|'tick'|'wake'|'say'|'enter'|'leave'|'changed:<comp>', …}" } } },
  sky: { doc: "set the sky (the authority stamps its clock): every field of the sky component", args: skyArgs() },
  weather: { doc: "a weather change, merged onto the standing sky (keepSky: false starts fresh)", args: skyArgs() },
  sculpt: { doc: "one brush stroke on a terrain grid", args: { on: ref("the ground entity"), brush: { type: "any", doc: "a brush (raise, lower, smooth, flatten…)" }, path: { type: "any", doc: "[[x, z], …] (1–256 points)" },
      radius: { type: "any", doc: "metres (≤ 64)" }, strength: { type: "any", doc: "whole mm (> 0) for an additive brush" }, dry: { type: "bool" } }, required: ["on", "brush"] },
  batch: { doc: "several writes as ONE act (one undo): ops [{verb, args}…] of create, set, delete, place, turn", args: { ops: { type: "any", doc: "[{verb, args}, …]" }, label: { type: "any", doc: "a name undo {label} can find it by" }, dry: { type: "bool" } }, required: ["ops"] },
  "fork-copy": { doc: "a fork's copy of its parent's state (the server's own, while forking; never a person's request)", args: { ops: { type: "any" } } },
  use: { doc: "do something to a thing (inspect shows what it offers you). While you hold it, use {id} with no action fires its grabbable.use (its down; args {phase: 'up'} its up)", args: { id: ref("the thing"), action: { type: "string" }, args: { type: "object" }, dry: { type: "bool", doc: "preview only: what it would write (a script runs dry); nothing is logged" } }, required: ["id"],
    example: { id: "door-1", action: "open" } },
};
// Request words held for a shape that isn't built (PROTOCOL §7a: the avatar guard rails). The authority refuses each by name
// (`reserved`), never as an unknown verb, so nobody ships a client that sends one with a guessed shape.
export const RESERVED_VERBS = Object.freeze({
  arrive: { args: { wearing: { type: "any", doc: "{avatar, hash}: the body a person arrives wearing; the world records only this, never the body's parts (they live in the wearer's log)" } },
    why: "reserved (PROTOCOL §7a): avatar entity trees aren't built; arriving is a body's first move today" },
});
// Requests the protocol had and removed. The authority refuses each by name (`removed`), never as an unknown verb, so a
// client built before the removal is told what happened and what to do instead. whisper was a server ws message, never
// an authority verb; the server's door answers it with this row too (server/messages.ts).
export const REMOVED_VERBS = Object.freeze({
  whisper: { why: "speech in a world is public and arrival-only (R 10-18): everyone present hears a say, the world's log keeps it, and only the world's admins read it back. Direct messages will live at the identity level (client and profile), not in world chat",
    fix: "say it to everyone here (say {text, to} addresses one person in public), or reach them outside the world" },
});
// the sky and weather verbs take the sky component's own fields (componentspec), its old spellings (the fold translates
// them: forecast.js skySpelling) and weather's keepSky
function skyArgs() {
  const f = Object.fromEntries(Object.keys(COMPONENTS.sky.fields).map((k) => [k, { type: "any", doc: `the sky's ${k}` }]));
  return { ...f, clock: { type: "any", doc: "old spelling: a tz present means the wall clock governs" }, weatherSeconds: { type: "any", doc: "old spelling of transition" },
    dormantRated: { type: "any", doc: "old fold bookkeeping (read as hours/rate)" }, keepSky: { type: "any", doc: "weather: false discards the standing sky" }, dry: { type: "bool" } };
}
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
  const T = Object.hasOwn(VERBSPEC, verb) ? VERBSPEC[verb] : null; if (!T) return null;
  const ex = (k) => T.args[k]?.example ?? T.example;
  for (const k of Object.keys(a)) if (!(k in T.args)) return { code: "unknown-arg", reason: `${verb} has no argument '${k}'`, fix: `${verb} takes: ${Object.keys(T.args).join(", ")}`, example: ex(k) };
  for (const k of T.required ?? []) if (a[k] === undefined) return { code: "missing-arg", reason: `${verb} needs '${k}'`, fix: T.args[k]?.doc ? `${k}: ${T.args[k].doc}` : T.doc, example: T.example };
  if (T.oneOf) { const m = T.oneOf.filter((k) => a[k] !== undefined);
    if (m.length !== 1) return { code: "shape", reason: m.length ? `say one of ${m.join(" / ")}, not several` : `${verb} needs one of: ${T.oneOf.join(", ")}`, fix: T.oneOf.map((k) => `${k}: ${T.args[k].doc}`).join("; "), example: T.args[m[0] ?? "on"].example };
    for (const [k, s] of Object.entries(T.args)) if (a[k] !== undefined && s.modes && !s.modes.includes(m[0])) return { code: "doesnt-apply", reason: `'${k}' doesn't apply with '${m[0]}' (it applies with ${s.modes.join(", ")})`, fix: `remove '${k}'${k === "facing" && ["beside", "against"].includes(m[0]) ? `: ${m[0]} sets the facing itself` : ""}`, example: T.args[m[0]].example }; }
  for (const [k, s] of Object.entries(T.args)) if (a[k] !== undefined && !okType(s, a[k])) return { code: "shape", reason: `'${k}' should be ${s.type === "enum" ? `one of ${s.values.join(" | ")}` : s.doc ?? s.type}, got ${JSON.stringify(a[k])}`, fix: s.doc ?? "", example: ex(k) };
  return null;
}
export function verbHelp(verb) { const T = Object.hasOwn(VERBSPEC, verb) ? VERBSPEC[verb] : null; if (!T) return null;
  return { verb, doc: T.doc, ...(T.oneOf ? { oneOf: T.oneOf } : {}), args: Object.fromEntries(Object.entries(T.args).map(([k, s]) => [k, { type: s.type === "enum" ? s.values : s.type, doc: s.doc, ...(s.modes ? { onlyWith: s.modes } : {}), ...(s.example ? { example: s.example } : {}) }])), ...(T.example ? { example: T.example } : {}) }; }
