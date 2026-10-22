// mcpl/tools.ts — the agent tool surface, ONE table and ONE dispatcher
// (survey §B3/§C, ruled §24r: "unify stdio door", the stdio MCP server).
//
// Two MCP servers front the same embodied agent: the MCPL server (net-server.ts,
// sessions + channels + capabilities) and the plain-MCP stdio server
// (server.ts). The stdio server used to carry a hand-copied 16-tool subset of
// this table — drifted descriptions, a stale searchLibrary with the
// hardcoded-Mac-path bug R0 fixed on only one side, and a "shared schema"
// comment that had stopped being true. Now both servers register from TOOLS
// and dispatch through handleTool; what differs between hosts rides ToolCtx:
//
//   - rememberAvatar / rememberActivity — per-identity persistence (the WS
//     server writes state.json; the stdio server, one agent per process, may
//     no-op);
//   - canPush + heldActivity — whether ambient activity digests can be
//     DELIVERED (a channel host) or must be HELD for the next poll;
//   - cursor.caughtUpTo — the catch_up position, per attachment;
//   - travel — session machinery (channel epochs, join gates); a door
//     without the hook does not list the tool.
//
// Everything else in here talks only to the WorldAgent and the sequencer's
// HTTP surface, which is exactly what makes it transport-agnostic.

import { bodyOf } from "../shared/components.js";
import { kindOf } from "../shared/protocol/kind.js";
import { describeBody, socketRole } from "../shared/sockbody.js";
import { dec as decName, enc as encId } from "../shared/protocol/names.js";
import { actorName } from "../shared/protocol/names.js";
import { refusalText, warningText, touchWords } from "../shared/protocol/refusal.js";
import { readdirSync } from "node:fs";
import sharp from "sharp";
import { validatePose, validateTracks, tracksSpan, poseReport, HUMANOID_BONES, mergePose, puppetPose } from "../shared/humanoid.js";
import { rigBonesFor } from "./rigbones.ts";
import { CONTACT_POINTS, canonicalPoint } from "../shared/contact.js";
import { inspectSchema, editOps, describeSchema } from "../shared/editschema.js";
import * as OP from "../shared/protocol/requests.js";
import { PURGED } from "../shared/protocol/fold.js";
import { childrenOf } from "../shared/hierarchy.js";
import { WORLD_ID, worldSchema, worldEditOps, describeWorld } from "../shared/worldentity.js";
/** Every folded record by id — what the hierarchy maths reads (a child's
 *  parent and its socket, children, in-place parenting). */
const foldWorld = (ag: any): Record<string, any> => {
  const out: Record<string, any> = {};
  for (const id of ag.foldedIds()) { const r = ag.foldRecord(id); if (r) out[id] = r; }
  return out;
};
import { type ActResult, type WorldAgent, WALK_ARGS_REASON } from "./agent.ts";
import type { Destination } from "./places.ts";
import { normalizeSnapFrame } from "../shared/snapframe.js";
import { shown } from "../shared/shown.js";

/** The slice of WorldAgent the tools touch — typed loosely on purpose: the
 *  agent's surface is the contract, not this file's re-declaration of it. */
type ToolAgent = WorldAgent;

export type ToolCtx = {
  agent: WorldAgent;
  /** can ambient activity digests reach this host on their own (a channel
   *  host), or must they be held for the next poll? */
  canPush: () => boolean;
  /** digests held for a push-less host — handed over on the next activity call */
  heldActivity: string[];
  /** the catch_up position — per attachment, reset on travel */
  cursor: { caughtUpTo: number | null };
  /** persist the avatar choice for this identity (outlives the session) */
  rememberAvatar?: (path: string) => void;
  /** persist the applied activity dial for this identity */
  rememberActivity?: (cfg: { pulseSec?: number; radiusM?: number }) => void;
  /** session-machinery travel; absent = the authority does not offer it */
  travel?: (world: string) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
  /** the authority's RFC-005 join policy for THIS credential, so `worlds` can say
   *  which of the listed worlds the agent may actually travel to — the same
   *  gate travel itself applies, asked before the move instead of after.
   *  Absent = the authority has no policy vocabulary (stdio fronts one world). */
  worldPolicy?: { canJoin: (world: string) => boolean; canFound: boolean };
};

// ---- tools (shared schema with the stdio server, minus retina by default) --

// THE SURFACE (REPOINT-PLAN 2026-10-14 §4; R's standard, 09:47): an engine tool must pass BOTH tests — its name is
// intuitive to everyone who might use the action, AND the action is useful in general situations — or it is an alias,
// not an engine tool. So the table holds GENERAL SHAPES (act, create, edit, inspect, move, anim, reach, library…) whose
// modes carry what used to be bespoke verbs: the flight nine are move {mode: "fly"} + act land (and body_state says
// where the sky left you); fold/unfold wings and clear_pose are anim's (R 10-17 15:31: pose, animate, posture and the action bar's old tool are anim too);
// clear_reach is reach {release}; ragdoll is anim {ragdoll} (and the push on someone else is act shove); kick/ban/unban/list_bans are act's; three library tools are one; light is create
// {components: {light}}, remove is act delete, blueprint_place is create {from}. The old names still answer, teaching
// where they went (TOOL_FOLDS). High-volume social/perception sugar (look, say, face, stop…) stays on the
// MUD argument. The flight REHEARSAL hooks (trusted DOWN/RECOVER seams) are no longer tools at all: a bench calls
// the agent's flightBodyDown / flightBodyRecovered directly (tools/flight-test.ts).

const TOOL_ROWS = [
  { name: "body_state", description: "Perceive your body or another present participant (who; omitted or 'self' means you). Default summary reports body-mode, the clip playing, the named poses held (wings-folded), position, held poses/reaches and freshness; for yourself it also carries flight: where the sky has left you (altitude, heading, airspeed, stamina, how far your best glide reaches, which layer is flying) — or that you are on the ground. detail:'bones' adds published quaternions and derived world joint positions; 'contacts' adds named world-space contact points, outward normals, self-relative positions and ready-to-use reach targets; 'all' includes both. Optional window_ms (0–5000) measures reconstructed joint motion and endpoint residuals over a short window; a snapshot alone does not measure stability. Optional points filters contacts, e.g. ['chest_front','hand_l','hand_r']. Geometry evaluates the shared VRMA posture clips, published bone rotations and dependent limb reaches. Missing clips or unresolved/cyclic reach dependencies return incomplete geometry. Contacts are bone-bound anatomical estimates; full renderer blending, gestures and springbones are not reproduced. Reading never moves or touches anyone. Use returned reachTarget with reach to track a named point; use selfPosition to plan offsets around your own body.", inputSchema: { type: "object", properties: { who: { type: "string" }, detail: { type: "string", enum: ["summary", "bones", "contacts", "all"] }, points: { type: "array", items: { type: "string" }, maxItems: Object.keys(CONTACT_POINTS).length }, window_ms: { type: "integer", minimum: 0, maximum: 5000 } } } },
  { name: "look", description: "Text-tier perception: where you are, who's present and what they're doing, every placed thing with distance/bearing, and chat since you last looked.", inputSchema: { type: "object", properties: {} } },
  { name: "screenshot", description: "A rendered image from the world (spectator browser on a GPU host). Slower than look — use when spatial/visual detail matters. view: 'first' (default) is your avatar's eyes — you are not in frame; 'third' is an over-the-shoulder chase view — your body and what's ahead of it; 'selfie' faces you from in front — your avatar, framed. at: a placed thing's id frames THAT thing instead — seen from where you stand, fitted to its bounds (to check what you built without walking to it). Optional framing (#226): pitch (first only) tilts your gaze in degrees, + up / − down (default ≈ −4; try −60 to see what's at your feet); dist and height (third/selfie) set the camera's flat distance from you and its height above your feet in metres (defaults third 3.4/2.1, selfie 2.6/1.6). renderer: 'auto' (default) prefers a native Unreal renderer serving this world, else a browser one; 'browser' or 'unreal' asks for that one only. A world that admits only people listed answers its own people only.", inputSchema: { type: "object", properties: { view: { type: "string", enum: ["first", "third", "selfie"] }, at: { type: "string", description: "id of a placed thing to frame (overrides view)" }, renderer: { type: "string", enum: ["auto", "browser", "unreal"] }, pitch: { type: "number", minimum: -85, maximum: 85 }, dist: { type: "number", minimum: 0.5, maximum: 30 }, height: { type: "number", minimum: 0, maximum: 30 } } } },
  { name: "move", description: "Move your body somewhere. to is a point ([x, y, z]: y picks the floor there — the place to stand nearest that height, no more than a step (the mover's, 0.8 m) above it, so 0 is a ground floor and an upper storey's floor height is that storey; a y no floor matches arrives on the nearest floor and the reply says which; [x, z]: your own storey if the destination has one, else its lowest floor) or a NAME, tried in this order: \"thing/place\" (e.g. \"lookout/balcony\"; \"@world/<place>\" for a place on no thing), a placed thing's id alone (its entrance or door, when it names one; else you walk up to it and stop beside it), a place's name or label alone (\"reading room\": the nearest one), a thing's label (the same as its id), then a person here (you stop just short of them, on your side) — so a person named like a thing or a place never captures the walk. Places are a model's own (its file's rooms, doors, seats, arrivals) and its places component (name_place writes it); look lists the nearest, and to: \"?\" lists them all, nearest 200 (no move; \"?<text>\" lists only those whose name or label holds the text). mode: \"walk\" (default; run: true runs): the authority's move {to} — your body is the authority's body: it walks there in steps the authority accepts (about 6 m/s, not through what it calls solid), so a wall stops you where it stands and the reply is an error saying why; placed models are solid, as they are to people: you stand on their floors, climb their stairs and are stopped by their walls and furniture — and the walk routes through them (round furniture, through doorways, up and down stairs, onto other storeys); griddled structures route through their doors and arches; a destination with nowhere to stand, or no way there (sealed, oversized, conflicting), is refused before a step, with the reason, and a walk something unexpected stops ends early and says where; after a flight, a seat or a drag it re-arrives you where you are (a teleport, on the record). Things you hold come with you. Default arrival tolerance is 0.01m, so short positioning moves are honored; tolerance (0–0.4 metres) changes how close to the requested point counts as arrived (destination accuracy, not distance from another body). mode: \"fly\" (behind the world's fly grant and a winged rig): with nothing else, you take off (refused with folded wings — anim {stop: \"wings-folded\"} opens them — or a limp body; the launch costs stamina); altitude climbs to that many metres (THE expensive verb: 1 stamina per metre, refilled only on the ground at 0.5/s; an empty pool stops you where it ran out and the world hears 'winded'); to glides there, free, trading altitude for distance on the published polar — short of range you land SHORT, honestly, where the polar runs out, and the reply says by how much. Landing is act {verb: \"land\", args: {to}}; body_state reports altitude, heading, airspeed and stamina. READ THE REPLY: it is your only feedback on where you are.", inputSchema: { type: "object", properties: { to: { anyOf: [{ type: "array", items: { type: "number" }, minItems: 2, maxItems: 3 }, { type: "string", description: "a named place (\"thing/place\", a place's name or label), a thing's id or label, a person's name, or \"?\" for the list of named places (\"?<text>\" narrows it)" }] }, mode: { type: "string", enum: ["walk", "fly"] }, altitude: { type: "number", description: "fly: climb to this many metres" }, run: { type: "boolean" }, tolerance: { type: "number", minimum: 0, maximum: 0.4 } } } },
  { name: "name_place", description: "Give a spot a name, so you and everyone else can move {to} it by name. Names where you stand (or x/z, with y optional: the floor there nearest your height), on the thing you are in or the nearest placed thing (or `on`), in that thing's own frame — it moves with it. Written to the thing's `places` component as an ordinary set through the authority (builder rights, undo; answers once the world accepts or refuses it): a name can be added, re-pointed or retired any time, and covers places the model itself declares. remove: true retires a name.", inputSchema: { type: "object", properties: { name: { type: "string" }, label: { type: "string", description: "how it reads, e.g. \"the window seat\"" }, on: { type: "string", description: "the thing's id; default: the thing you are in, else the nearest within 15m" }, x: { type: "number" }, y: { type: "number" }, z: { type: "number" }, remove: { type: "boolean" } }, required: ["name"] } },
  { name: "face", description: "Turn to face a point (x,z) or a participant/entity id (target).", inputSchema: { type: "object", properties: { x: { type: "number" }, z: { type: "number" }, target: { type: "string" } } } },
  { name: "stop", description: "Stop walking.", inputSchema: { type: "object", properties: {} } },
  { name: "say", description: "Say something in world chat (bubble over your head, persisted). Equivalent to publishing on the world channel. Optional spoken-say trio (spoken+utt, t0 optional): display/continuation metadata marking this say as voice-performed by your live voice leg — it does NOT prove performance (the authenticated attest/performed receipt path is the only performance truth). The trio travels together or the server refuses loudly.", inputSchema: { type: "object", properties: { text: { type: "string" }, to: { type: "string", description: "a participant id or name: the say is addressed to them (the client sends this too; it is logged)" }, spoken: { type: "boolean", description: "true = a live voice leg is performing this say (display metadata only)" }, utt: { type: "integer", minimum: 0, description: "utterance counter: author-controlled display/continuation metadata (does NOT prove performance)" }, t0: { type: "number", description: "performance start, epoch ms (optional, finite)" } }, required: ["text"] } },
  { name: "catch_up", description: "What happened in the world while you were not thinking. Returns chat since a point in the world's history; omit `since` to continue from where you last caught up. Use when a conversation refers to something you have no memory of.", inputSchema: { type: "object", properties: { since: { type: "number" }, limit: { type: "number" } } } },
  { name: "activity", description: "Your ambient-activity sense — and the dial for it. While something is happening within radius_m of you (speech, movement, gestures, arrivals, building), you receive one digest per pulse_sec window on the world channel, tagged \"activity\" with metadata {activity: true} — never as a mention. If your host lets you configure wake rules, match that tag/metadata to be woken regularly exactly as long as there is life nearby; the stream stops by itself when the area goes quiet, so it costs nothing in an empty room. Call with no arguments to see your current settings. pulse_sec (10–3600 seconds, 0 = off) and radius_m (1–200) are your own to set and persist across sessions. If your host has no push channel (plain MCP), digests are held instead and handed over each time you call this tool — poll it when you want to know what has been happening around you.", inputSchema: { type: "object", properties: { pulse_sec: { type: "number" }, radius_m: { type: "number" } } } },
  { name: "anim", description: "Play an anim on your body — a pose (one frame, only the bones it names) or a clip (more than one key): you never need to know which. By NAME: anim {name, mode?} — the built-in names are the action bar's (wave, cheer, clap, point, salute, flail, talk play once; dance, sit, sitchair, lie, stand loop) and the pose wings-folded (the folded-wing silhouette, which grounds you; it holds); a name your body doesn't know plays its default, never an error. LIVE, for ad-lib: anim {joints} sets bones now (a sparse map of bone name to [x,y,z,w] or {q, t, s}: humanoid bones by VRM name, any other bone your rig has by its own; replace:true makes it the whole pose; hold:true keeps it through walking; call anim with joints: {} to list your rig's bones), or anim {tracks, dur} plays keys (bone → [{t, q}], dur seconds; replace:true ends your held pose first). mode (default: the anim's own): once (plays, then you're back to normal) | loop (until something else happens) | hold (freezes on a frame — at seconds in, default its last — and holds until something else happens). The reply says {playing: name or \"live\", mode}. Anims are layers: a clip (a named loop or hold), a pose you strike (joints, or wings-folded) and a tracks loop play at once, and a new one replaces only the one in its own layer (a pose struck over a sit leaves the sit playing). A loop or a hold ends when another in its layer starts, you move, anim {stop} or you're knocked over — and you're told: stopped {name, why} (a once anim ends silently). anim {stop: true} stops every one of them, each layer, and rests in your body-mode's own anim (stand: idle, sit: the sit loop, lie: lie, swim: tread, fly: soar) — never the bind pose; the body-mode is unchanged (to stand up, declare bodyMode stand, or walk; on a seat, detach: a declaration never takes you off it). stop: \"<name>\" stops only that layer, the rest going on (stop: \"wings-folded\" opens your wings; a name that isn't playing is a note, not an error); stop: \"live\" stops only the ad-libbed ones (joints, tracks), which replies call \"live\" — a reserved name no anim may have. ragdoll: true goes limp (walking, or anim {stop: true}, stands you back up). target plays it on SOMEONE ELSE (joints, tracks, stop or ragdoll; their consent decides). Presence only — never written to the world log. bodyMode declares your body-mode (stand | sit | lie | swim | fly | fall), for looks — e.g. fly plays the hover set while you walk; the mover sets it itself on real transitions (water, a take-off, a fall, a landing), and a declaration holds until the next one; it grants nothing (a take-off still needs the fly permission). (pose, animate and posture are its old names: they still answer, for one release.)", inputSchema: { type: "object", properties: { name: { type: "string", description: "an anim by name (a pose or a clip)" }, bodyMode: { type: "string", enum: ["stand", "sit", "lie", "swim", "fly", "fall"], description: "declare your body-mode, for looks (it grants nothing)" }, mode: { type: "string", enum: ["once", "loop", "hold"], description: "default: the anim's own" }, at: { type: "number", description: "mode hold: seconds into the anim to freeze at (default its last frame)" }, joints: { type: "object", description: "live: bone → [x,y,z,w] or {q, t, s}" }, tracks: { type: "object", description: "live: bone → [{t, q}]" }, dur: { type: "number", description: "with tracks: seconds" }, replace: { type: "boolean" }, hold: { type: "boolean", description: "with joints: keep them through walking" }, target: { type: "string" }, stop: { description: "true: stop every anim, each layer, and rest in your body-mode's own anim (never the bind pose; the body-mode is unchanged); a name: stop only that layer; \"live\": only the ad-libbed ones" }, ragdoll: { type: "boolean" } } } },
  { name: "reach", description: `Reach out with a hand (or foot) — real IK: everyone sees your arm extend toward the target and TRACK it (your walking, their moving) until you release it, and the palm turns to rest on the surface it meets. Two ways to aim it: (1) a contact point on a body — \`who\` (participant id; omit to touch your own body) + \`point\`, one of: ${Object.keys(CONTACT_POINTS).join(", ")}; the person you touch hears about it (they get a 'reaches toward you' event, then a 'touches' event when your hand arrives — you hear the same when someone touches you). A hand on SOMEONE ELSE is shown only if their consent allows it (class touch; intimate for chest_front, waist and hips — on the default table everyone's are 'ask' and 'deny'): otherwise the world strips it from your pose, nobody sees it, and the reply says it was refused (never why: that is theirs); to ask, act {verb: 'reach', args: {who: <their identity>, point}} and wait for their yes. (2) a bare point — x, y, z with \`space\`: 'world' (default, fixed), 'self' (your own root frame — moves with you), or a participant id (their root frame — tracks them). READ THE REPLY, it is your only feedback: it says whether the hand actually arrives, what limited it (joints, body, distance), and how far to walk if it fell short. A reach composes over walking, sitting and held poses. If YOU (the reacher) are knocked over, your outgoing reaches are cleared. The target walking, changing posture or falling does not revoke your tracking relation. The target ends someone's reach toward them by closing their consent to it (act {verb: "consent", args: {deny: <who>}} for that person, or {switch: "refuse"} for everyone not allowed by name): the reach ends then, and its reacher hears body-revoked. Presence-only, never logged. release: true lets go — one limb, or all of YOUR reaching limbs when no limb is named — easing back to normal animation; anyone you were touching sees the hand withdraw (it clears your outgoing reaches, never someone's reach toward you).`, inputSchema: { type: "object", properties: { release: { type: "boolean", description: "let go (of `limb`, or every limb)" }, limb: { type: "string", enum: ["rightHand", "leftHand", "rightFoot", "leftFoot"], description: "default rightHand" }, who: { type: "string" }, point: { type: "string" }, x: { type: "number" }, y: { type: "number" }, z: { type: "number" }, space: { type: "string" }, standoff: { type: "number", description: "metres to hover off the surface (default 0.02 — resting on it)" }, palm: { type: "boolean", description: "false = don't orient the palm to the surface" } } } },
  { name: "attach", description: "Get on a thing at one of its sockets (look says what each does: sit, ride, drive, stand at…): your body occupies it — swings with the swing, holds the station's anim — until you detach (or walk; a socket may only let you go a certain way, which look and the reply say). to is the thing; pick the socket by `socket` or by `action`. The seat must be within reach (3.5 m across the ground, 1.6 m up, 1 m down: walk up first; farther is refused out-of-reach), free (one occupant each) and yours to take (its station.who); detach first to change seats. Presence only: nothing is logged, exactly like a person's /sit.", inputSchema: { type: "object", properties: { to: { type: "string" }, socket: { type: "string" }, action: { type: "string" } }, required: ["to"] } },
  { name: "detach", description: "Get off the thing you're attached to (the reverse of attach). A socket may hold you until the world lets you go (its leaveBy); the reply says so. escape: true gets you off any seat whatever it says (the one exit no seat can take away, like a person holding X).", inputSchema: { type: "object", properties: { escape: { type: "boolean" } } } },
  { name: "set_avatar", description: "Change your body. Pass `avatar` as a roster name (see it with no arguments) or a full vrm path. Takes effect immediately — everyone sees you change; your position and held pose carry over. library {kind: \"avatars\"} shows the roster as a contact sheet.", inputSchema: { type: "object", properties: { avatar: { type: "string" } } } },
  { name: "library", description: "The catalog: models to place and bodies to wear. query searches the model library by keywords and returns library paths for create {model}. kind ('models' | 'avatars') with page is a contact sheet — one grid image with names under each tile, 12 per page: the placeable object library, or the wearable roster (portraits exist once a body has been worn; set_avatar puts one on). preview is one item at full size: an avatar's portrait (roster name) or a model's preview render (library filename or path). Pass one of the three.", inputSchema: { type: "object", properties: { query: { type: "string", description: "search the model library" }, kind: { type: "string", enum: ["avatars", "models"], description: "a contact sheet of this catalog" }, page: { type: "number" }, preview: { type: "string", description: "one item at full size: a roster name or a model path" } } } },
  { name: "create", description: "Make a new thing: the authority's create, with its exact args. model is a library path (library {query} finds one); components sets any component values in the same act; place {on|beside|hang|against|near|at, …} puts it somewhere in the same step (the authority solves where; see place); at is a point, [x, z] on the ground or [x, y, z] exactly (or the authority's {pos, yaw|q}). With no place, at or transform, it goes on the ground 2 m in front of you. A light is a thing with a light component and no model: create {components: {light: {color: 0xffd9a0, intensity: 16, range: 10, important?: true}}} — with nowhere said it hangs just in front of you at about eye height; color is a hex integer (0xffd9a0 warm, 0x88bbff cool, 0xff5533 red), important: true means it ALWAYS casts (outside the per-client point-light budget; every casting light has real GPU cost — save it for lights that matter); a small glowing sphere marks it; edit {id, set: {\"light.intensity\": 24, \"pos.y\": \"+=1\"}} dims or moves it later and act {verb: \"delete\", args: {id}} removes it. from copies: a blueprint hash (sha256:… — a unique prefix will do; blueprints lists them) places a copy of one of this world's blueprints (2 m in front of you, facing the way you face, or at; the whole tree in one act), and a thing's id duplicates it with everything attached to it, beside it or at a point: create {from: \"crate-1\", at: [4, 2]} ([x, z] keeps its height; or [x, y, z], or {pos: [x, y, z], yaw}). A duplicate stays a sibling of its source, so when the source has a parent the point is in that parent's frame. Leave id out: the authority mints every id (opaque, never renamed; the reply gives its short handle, which every tool takes, as it takes a thing's label or any unique id prefix of 4+ characters). An id you choose is refused; a placeholder '$name' is accepted (refs to it in the same request resolve; act {verb: 'batch'} makes several things that refer to each other). dry: true asks without writing.", inputSchema: { type: "object", properties: { id: { type: "string" }, model: { type: "string" }, components: { type: "object" }, from: { type: "string", description: "a blueprint hash (sha256:…, a unique prefix will do) or a thing's id to duplicate" }, at: { anyOf: [{ type: "array", items: { type: "number" }, minItems: 2, maxItems: 3 }, { type: "object" }], description: "where it goes: [x, z], [x, y, z] or {pos, yaw|q}" }, place: { type: "object" }, dry: { type: "boolean" } } } },
  { name: "place", description: "Put a thing somewhere by saying where it goes: the authority's place, with its exact args. One of on (a thing's surface), beside (next to a thing on the same support), hang (below a frame or beam; height), against (back to a wall; height, along, side), near (on the floor near a thing), at ([x, z]); then facing (a thing or [x, z]; away: true turns its back), level (which surface of an `on` target), offset ([dx, dz] on the surface), side, gap, height, along, lying (rest it on its largest face), attach (ride what it's placed on). The authority solves the numbers and says where it went. dry: true asks without writing.", inputSchema: { type: "object", properties: { id: { type: "string" }, on: { type: "string" }, beside: { type: "string" }, hang: { type: "string" }, against: { type: "string" }, near: { type: "string" }, at: { type: "array", items: { type: "number" } }, facing: {}, away: { type: "boolean" }, level: { type: "integer" }, offset: { type: "array", items: { type: "number" } }, side: {}, gap: { type: "number" }, height: { type: "number" }, along: { type: "number" }, lying: { type: "boolean" }, attach: { type: "boolean" }, dry: { type: "boolean" } }, required: ["id"] } },
  { name: "act", description: "One request, by verb — the escape hatch for verbs that have no tool of their own; answered by the world's authority itself: {ok: true, …what changed, notes, warnings} or {ok: false, refused: {code, reason, fix}}. A few verbs are answered by YOUR BODY (same reply shape, {ok, text}) before anything reaches the authority: land {to: [x, z]} descends, flares and lands there — landing is an EVENT the world sees, and afterwards your body is walking again (a fly-mode move gets you up); shove {target, strength?} knocks another body over — a physics ragdoll, directed from where YOU stand through them (walk to the right side of someone before pushing; strength 0.5–4 m/s, default 2.2), simulated by THEM on their own body and settled into a held pose everyone sees; whether a body can be knocked over is ITS owner's call (their consent switch, or their answer for you), the same for every body, and the server also wants you within 3 m — a refusal comes back as an error saying why. MODERATION rides here too, by NAME: kick {who, minutes?, reason?} removes someone now (who is their name or identity u-…; they may come back after minutes, default 10, at most 60 — a kick interrupts, a ban excludes; needs the kick permission and a rank above theirs; an owner can't be kicked); ban {who, days?, reason?, global?} disconnects them and refuses their joins (including spectating) until unban or for days — someone absent is found among the people this world has seen (whois); global: true bans them from every world on this server (WORLD_ADMIN); give a reason, it is shown to them and kept in the moderator's record; unban {who, global?} lifts a ban (or a kick's cooldown); bans {global?} lists what is in force now — bans, removals cooling down and mutes (people who hold a moderation power may ask; the whole server's with global: true, operator only). The authority's own verbs: create {id?, model?, components?, place?} | create {from: <blueprint hash, or a thing's id to duplicate it>, at?} | set {id, component, value, merge?, base?} | delete {id, component?} | place {id, on|beside|hang|against|near|at, facing?, …} (the authority solves where it goes) | turn {id, axis, deg, space?, about?} | batch {ops: [{verb, args}…]} | use {id, action?} | say {text} | caption {id, session, n, t0, t1, text, speaker?, title?} (one line of a screen's captions, if its captioners {ids} name you) | undo {act?|label?} (your own acts; refuses what others changed since) | publish {from, name} | update {copy, to} | move {to} | grab {id, hand?, grip?} (a thing with a grabbable component, or physics {kind: 'dynamic'}; look says who may and how it's held) | put {id, pos?} | throw {id, v, pos?} | drop {id, hand?} (its grabbable may send it home, into a socket that accepts it, or leave it where you let go) | use {id} while holding it fires its grabbable.use (args {phase: 'up'}: the release) | punt {id, power?|v?} (send a loose thing beside your body into flight) | wait (your tracked body; physics: things with physics {kind: 'dynamic'} fly when @world.physics-engine runs; grabbable makes a thing carryable, physics makes it fall) | look | inspect {id} (who made it, versions) | measure {id} | find {kind: 'model'|'blueprint', query?} | lint {id?} | history {id?, limit?, before?, after?, verbs?} | schema {component?} | help {verb?} | consent (your body's consent: bare reads it; switch: accept|ask|refuse, allow|deny {who, class?} for one person, answer an ask) | body {to, kind: pose|anim|shove|drag|occupy|carry, spec?} (act on another body: their consent decides) | reach {who, point} (ask to touch) | inbox. A write whose verb takes dry (help {verb} lists each verb's arguments) may add dry: true to preview it; every write may add expect: [{id, component, value?}] (refused 'changed' if any isn't what you started from) and throughLock: true. undo {act: <your undo>} is redo. create/place/edit are tools of their own, and wait for the authority's answer too; delete {id} removes a thing (with its children). whois {name} finds a person's identity (u-…) here, present or not.", inputSchema: { type: "object", properties: { verb: { type: "string" }, args: { type: "object" } }, required: ["verb"] } },
  // Description narrowed to what the implementation actually does (antra
  // review, #3). It previously promised "held pose and posture survive", which
  // joinWorld does NOT transfer — and which contradicts the existing pose
  // contract ("vanishes when you leave"). Carrying a world-local pose across
  // worlds is a product decision nobody has made, so the honest move is to
  // stop promising it rather than to implement it by inference. Identity,
  // avatar and the activity dial ARE carried, and are named because they are.
  { name: "worlds", description: "Which worlds this server fronts that you may see, and who is embodied in each — the map for `travel`. Marks the world you are in now, each world's door (open, visitors, signed-in, watch: anyone may watch, only people listed come in; members: only people listed, and invisible to everyone else), and whether you may enter or only watch: each world's owners decide who comes in (@world.access, and roles:<you>). Joining never founds a world here. Everyone embodied is in one list, by the ids you see in `look`, each with the word they declared for themselves at join, if any (nothing is inferred); spectators appear as nothing, as in-world.", inputSchema: { type: "object", properties: {} } },
  { name: "travel", description: "Walk to another world this server fronts, keeping your identity, avatar and attention settings — no reconnect. The world you name decides whether you may come in (its owners' access and roles), and a credential limited to certain worlds keeps you to them; you are asked about before anything moves, so a refusal leaves you where you are. Joining never founds a world: a name that doesn't exist is refused. The anims you hold do NOT survive the move (they are world-local, like a disconnect), and your chat cursor resets to the new world.", inputSchema: { type: "object", properties: { world: { type: "string", description: "world name, e.g. \"commons\"" } }, required: ["world"] } },
  { name: "measure", description: "Geometry as data: bounding box, up-facing flat zones (candidates for a station, a table, a deck), and named parts of a placed thing (id) or a library model (lib). Flat-zone coords are the MODEL's local frame — the same frame sockets use, so a zone's center IS a socket's pos (the body's root goes there; anchor: 'hips' puts the hips joint there instead): a socket is a child entity, made with create {components: {parent: {to: id}, transform: {pos: [cx, y, cz]}, socket: {name: 'seat'}, station: {anim: 'sitchair'}}} (station makes it a place a body occupies: sit, ride, stand…; without one it is an attach point for things). Use this to find where a body can go before declaring the station; verify by attaching to it yourself (attach {to: <the socket's id>}) and taking a selfie screenshot. Raw GLB bytes are at GET <sequencer>/library/<lib> if you want to process the mesh locally. check: true asks the build check instead (#241): what the model is like to walk into, measured with the walking body's own rules before or after it is placed — whether it is walk-in at all, its floors and how much of each can be reached from outside, why any part can't (a passage narrower than a body, a rise too high to step, a climb an overhanging floor blocks, no way in), the render budget — and suggested rooms, doors and stairs, ready to name as places. Advisory: nothing is refused. With id it is checked as placed (its scale, its collider); with lib at its own size, or at scale (0.05–20). The first check of a model at a scale takes a few seconds.", inputSchema: { type: "object", properties: { check: { type: "boolean", description: "the build check: walk-in, reachable floors, why not, suggested places" }, scale: { type: "number", description: "with lib and check: as if placed at this scale (0.05–20)" },  id: { type: "string" }, lib: { type: "string" } } } },
  { name: "inspect", description: "The inspector, for you: every editable field on a placed thing with its current value, units, limits, and the verb that changes it — the same declaration the browser's Inspector panel renders (shared/editschema.js). Fields are addressed group.field: pos.x pos.yaw pos.scale · rot.x rot.y rot.z (Rotate in degrees, read from q in the thing's rotation order) rot.qx…rot.qw rot.order · flags.lock flags.hidden flags.label flags.description (its alt text; flags.reads is how it reads: name, description, what it can do, its state) · light.color light.intensity light.range light.important light.daytime (on: daytime full, burns at noon) · motion.type motion.axis motion.amp motion.period … (a part's motion as motion.<part>|amp) · sockets.<slot>|pos|0..2 sockets.<slot>|rot|0..2 sockets.<slot>|body sockets.<slot>|anim sockets.del (a host's socket children, read and written as one map: the door writes each slot as its socket child) · particles.effect particles.playing particles.at|0..2 particles.param|<name> (the effect's own knobs) · comp.<type> (raw JSON for any component no group speaks for; comp.+ adds one) · parent.to (its parent; set an id to parent it where it stands, \"\" or null to make it a root) · parent.unparent. Says its parent and children; a child's Transform is LOCAL to its parent. Read-only fields say why (locked, guarded, riding a moving part). id \"@world\" is the world entity: its Sky (sky.tz sky.hours sky.rate sky.clouds …; sky.tz empty is the authored clock), Weather (weather.state), Terrain (terrain.amplitude terrain.color …) and Grass (grass.density … grass.mow) — the world's sky/terrain/grass, edited with edit {id: \"@world\", …} (owner rank). Pass json:true for the raw schema.", inputSchema: { type: "object", properties: { id: { type: "string" }, json: { type: "boolean" } }, required: ["id"] } },
  { name: "edit", description: "Change fields on a placed thing by address (see inspect) — ONE request for the whole edit (one act; undo {act} takes it back), exactly what a person's edit sends: the transform channels become one whole `set transform` (local to its parent for a child); socket fields one `set sockets`. Numbers take Maya's relative math: \"+=1\", \"-=0.5\", \"*=-1\", \"+=10%\". Angles are typed in DEGREES. Edits that can't be planned (unknown field, a cycle, bad JSON) are reported by name and the rest still go; a locked thing is refused by the authority with the way through (throughLock: true, if you may lift locks). \"parent.to\": \"lamp\" parents it under lamp where it stands (null = make it a root); a child's pos/rot are local to its parent. set: {\"pos.x\": \"+=1\", \"light.intensity\": 24, \"flags.label\": \"the good chair\", \"sockets.seat|pos|1\": 0.55, \"comp.recipe\": \"{...}\"}. id \"@world\" edits the world entity: {\"sky.hours\": 17.5, \"weather.state\": \"rain\", \"terrain.amplitude\": \"+=1\"}. Pass dry:true to have the authority check it without writing.", inputSchema: { type: "object", properties: { id: { type: "string" }, set: { type: "object" }, dry: { type: "boolean" }, throughLock: { type: "boolean" } }, required: ["id", "set"] } },
  { name: "hierarchy", description: "The scene tree, as the browser's Hierarchy panel shows it: every placed thing, mounted things indented under their carrier, seated people as occupants, with each thing's label, lib, components and lock state. filter narrows to ids/labels/libs/component types containing the text (matches keep their ancestors). Cheaper than look() when you want structure, not surroundings.", inputSchema: { type: "object", properties: { filter: { type: "string" } } } },
  { name: "blueprints", description: "This world's blueprints: every published blueprint (a thing and everything under it, saved as one content-hashed record) with its short hash, name, part count and the copies placed from it. Pass hash for one. Publish with act {verb: \"publish\", args: {from, name}}; place a copy with create {from: \"sha256:<hash>\", at?}.", inputSchema: { type: "object", properties: { hash: { type: "string" } } } },
  { name: "world_history", description: "Read the world log — the append-only record every world IS: who did what, newest page by default. Filter by verbs: the authority's (create, set, delete, place, use, undo, say, batch…); a world imported from an old log also holds its imported entries (verb 'imported'; each names the verb it was written with: filter by that verb). Page backwards with before, forwards with after (the reply says where to continue). A refused request is on the record as an attempt and reads REFUSED — it changed nothing. act {verb: 'history', args: {id}} reads one thing's own acts. This is the debugging primitive: the log is the world, so reading it is reading the world's source.", inputSchema: { type: "object", properties: { verbs: { type: "array", items: { type: "string" } }, before: { type: "number" }, after: { type: "number" }, limit: { type: "number" } } } },
  { name: "world_debug", description: "The world's flight recorder: why things BOUNCED. The log answers 'what happened'; this answers 'why didn't it' — every request the authority refused here (kind 'refused': who, the verb, the code, the authority's reason and how to fix it — rights, locks, shapes, rate limits, bans). Pass script: <thing>/<name> to read ONE script's last activations (what console.log wrote, how each ended); scripts: true lists what scripts run here and why each is active, asleep, dormant or paused. Components (motion, sockets, reactions) are data, not scripts: they never appear in the scripts roster — world_history {verbs: ['set']} shows how one was written. In-memory, recent events only. Check here first when something doesn't do what you expected.", inputSchema: { type: "object", properties: { limit: { type: "number" }, kinds: { type: "array", items: { type: "string" } }, script: { type: "string" }, scripts: { type: "boolean" } } } },
  { name: "whois", description: "Who goes by a name here: their identity (u-…, what roles and bans name), the word they declare for themselves if they declared one while here (nothing is inferred), whether they are a guest (no account), their role in this world, whether they're here now and whether they're banned. Only people this world has seen (present, in its log, its roles or its moderator record), never the whole server. An identity (u-…) works as the name too.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
];

// ---- MCP annotations (spec 2025-06-18 ToolAnnotations; tools audit 10-07 §3: none were set, so every tool read as
// "destructive, open-world" to a host). [title, readOnly, destructive, idempotent, openWorld], said honestly:
//   readOnly: it changes nothing in the world or in anyone's body (a read may still advance this session's own cursor:
//     look and catch_up mark chat as seen);
//   destructive: it can remove or overwrite something someone made, or remove a person (edit overwrites values in place
//     and can remove components; act can do anything a verb can);
//   idempotent: the same call again changes nothing more (move to the same point, set the same pose; not say, not create);
//   openWorld: it reaches other people (their chat, their body, their place in the world). The world itself is the
//     tools' own domain, so reading or building in it is not open-world.
type Ann = [string, boolean, boolean, boolean, boolean];
const ANNOTATIONS: Record<string, Ann> = {
  body_state: ["Read a body's state", true, false, true, false],
  look: ["Look around", true, false, true, false],
  screenshot: ["Take a screenshot", true, false, true, false],
  move: ["Move somewhere (walk, run, fly)", false, false, true, false],
  face: ["Turn to face", false, false, true, false],
  stop: ["Stop walking", false, false, true, false],
  say: ["Say something aloud", false, false, false, true],
  catch_up: ["Catch up on chat", true, false, true, false],
  activity: ["Activity sense (read or set)", false, false, true, false],
  anim: ["Play a pose or a clip, by name or live (or offer one)", false, false, false, true],
  reach: ["Reach for a point or a body (or let go)", false, false, true, true],
  attach: ["Get on a seat or socket", false, false, true, false],
  detach: ["Get off", false, false, true, false],
  set_avatar: ["Change your body", false, false, true, false],
  library: ["The catalog: search, contact sheet, preview", true, false, true, false],
  create: ["Make a thing", false, false, false, false],
  place: ["Place a thing", false, false, true, false],
  act: ["Any verb (escape hatch; land, shove, moderation)", false, true, false, true],
  worlds: ["List worlds", true, false, true, false],
  travel: ["Travel to another world", false, false, true, false],
  measure: ["Measure geometry (check: the build check)", true, false, true, false],
  name_place: ["Name a place", false, false, true, false],
  inspect: ["Inspect a thing", true, false, true, false],
  edit: ["Edit a thing's fields", false, true, false, false],
  hierarchy: ["Scene tree", true, false, true, false],
  blueprints: ["List blueprints", true, false, true, false],
  world_history: ["Read the world log", true, false, true, false],
  world_debug: ["Why things bounced", true, false, true, false],
  whois: ["Who goes by a name", true, false, true, false],
};
export const TOOLS = TOOL_ROWS.map((t) => {
  const a = ANNOTATIONS[t.name];
  if (!a) throw new Error(`[tools] "${t.name}" has no annotations row`);
  return { ...t, title: a[0], annotations: { readOnlyHint: a[1], destructiveHint: a[2], idempotentHint: a[3], openWorldHint: a[4] } };
});
for (const n of Object.keys(ANNOTATIONS)) if (!TOOL_ROWS.some((t) => t.name === n)) throw new Error(`[tools] annotations for "${n}", which isn't a tool`);

import { readdirSync } from "node:fs";
import { recordComponents } from "../shared/protocol/view.js";
import { modelWord } from "../shared/eido.js";
import { WINGS_FOLDED } from "../shared/wingpresence.js";
import { PoseClips } from "./pose-clips.ts";
import { BODY_MODES, isBodyMode } from "../shared/bodymode.js";
import { isReservedAnimName } from "../shared/animdefs.js";
// §24k R0 (survey A5): this fallback used to be a hardcoded developer home
// directory — the SAME bug mcpl/server.ts:120 fixed with an incident note
// ("hardcoded Mac path threw for everyone else"); this copy never got the
// fix, and its readdirSync sat OUTSIDE the try, so any box without
// EIDOVERSE_DIR where the route failed threw ENOENT with someone else's
// $HOME in the message. Local scan only when a checkout is actually named;
// otherwise the sequencer's catalog is the one source of truth and its
// unreachability is a soft, honest miss.
const MODELS_DIR = process.env.EIDOVERSE_DIR
  ? `${process.env.EIDOVERSE_DIR}/eidoverse/assets/models`
  : null;
/** Search the catalog through the sequencer (one source of truth — includes
 *  the content-addressed store, so conjured/orrery-delivered objects are
 *  findable), falling back to a local dir scan only when a checkout exists. */
async function searchLibrary(httpBase: string, query: string): Promise<{ path: string; name?: string }[]> {
  try {
    const r = await fetch(`${httpBase}/library-models?q=${encodeURIComponent(query)}`);
    if (r.ok) return ((await r.json()) as { path: string; name?: string }[]).slice(0, 24);
  } catch { /* sequencer route unreachable — scan what we can see, if anything */ }
  if (!MODELS_DIR) return [];
  try {
    const toks = query.toLowerCase().split(/\s+/).filter(Boolean);
    return readdirSync(MODELS_DIR)
      .filter((f) => f.endsWith(".glb"))
      .map((f) => ({ f, score: toks.filter((t) => f.toLowerCase().includes(t)).length }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((r) => ({ path: `eidoverse/assets/models/${r.f}` }));
  } catch { return []; }
}

// ---- contact sheets ---------------------------------------------------------
// The library's previews and the roster's portraits, composed into ONE grid
// image per page — an agent flipping through a catalog, not drowning in a
// dozen separate image blocks. Layout is SVG (labels for free), sharp
// rasterizes it.

const SHEET = { tile: 200, label: 26, cols: 4, perPage: 12 };

async function contactSheet(tiles: { name: string; data: ArrayBuffer | null; mime: string; h?: number | null }[]): Promise<Buffer> {
  const { tile, label, cols } = SHEET;
  const rows = Math.ceil(tiles.length / cols);
  const W = cols * tile, H = rows * (tile + label);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  // When statures are known, draw to a common scale on a shared ground line —
  // a lineup, not a stamp collection. The tallest body on the page fills its
  // tile; everyone else is proportionally shorter (floored so nobody vanishes).
  const maxH = Math.max(...tiles.map((t) => t.h ?? 0), 0);
  const cells = tiles.map((t, i) => {
    const x = (i % cols) * tile, y = Math.floor(i / cols) * (tile + label);
    const frac = maxH > 0 && t.h ? Math.max(0.22, t.h / maxH) : 1;
    const side = (tile - 8) * frac;
    const img = t.data
      ? `<image x="${x + (tile - side) / 2}" y="${y + 4 + (tile - 8 - side)}" width="${side}" height="${side}" preserveAspectRatio="xMidYMax meet" xlink:href="data:${t.mime};base64,${Buffer.from(t.data).toString("base64")}"/>`
      : `<text x="${x + tile / 2}" y="${y + tile / 2}" text-anchor="middle" fill="#667" font-size="15" font-family="DejaVu Sans, sans-serif">no preview yet</text>`;
    const tag = t.h ? ` ${t.h.toFixed(1)}m` : "";
    const room = 26 - tag.length;
    const name = t.name.length > room ? `${t.name.slice(0, room - 1)}…` : t.name;
    return `${img}<text x="${x + tile / 2}" y="${y + tile + 17}" text-anchor="middle" fill="#cfd3dc" font-size="12" font-family="DejaVu Sans Mono, monospace">${esc(name)}${tag ? `<tspan fill="#8a90a0">${tag}</tspan>` : ""}</text>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#1c1e24"/>${cells}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}


/** The tool list an MCP server should advertise: travel only exists where the host wired the session machinery for it.
 *  (No whisper: removed with world chat's private channel, R 10-18.) */
export function toolList({ travel = false }: { travel?: boolean } = {}) {
  return TOOLS.filter((t) => travel || t.name !== "travel");
}

export async function screenshotTool(ag: ToolAgent, view = "first", at?: string, renderer = "auto", frame: { dist?: unknown; height?: unknown; pitch?: unknown } = {}) {
  try {
    const norm = normalizeSnapFrame(frame);
    const extra = Object.entries(norm).map(([k, v]) => `&${k}=${v}`).join("");
    // Name any framing field the chosen view does not use, rather than ignoring it silently (#226): pitch is first-only,
    // dist/height third/selfie-only; `at` frames the thing itself, so none of them apply
    const posed = view === "third" || view === "selfie";
    const ignored = at ? (Object.keys(norm) as string[]) : posed ? (norm.pitch !== undefined ? ["pitch"] : []) : (["dist", "height"] as const).filter((k) => norm[k] !== undefined);
    const note = !ignored.length ? null
      : at ? `${ignored.join(" and ")} ${ignored.length > 1 ? "don't" : "doesn't"} apply when at frames a thing; ignored`
      : posed ? "pitch applies only to view first; ignored"
      : `${ignored.join(" and ")} ${ignored.length > 1 ? "apply" : "applies"} only to views third and selfie; ignored`;
    // as this identity (readHeaders): a world that admits only people listed answers its own people only
    const r = await fetch(`${ag.httpBase}/snap?world=${encodeURIComponent(ag.world)}&follow=${encodeURIComponent(ag.name)}&view=${encodeURIComponent(view)}&renderer=${encodeURIComponent(renderer)}${extra}${at ? `&at=${encodeURIComponent(at)}` : ""}`, { headers: ag.readHeaders });
    // a 401 or 403 is who this body is, which calling again doesn't change: say who can
    if (r.status === 401 || r.status === 403) return fail(`screenshot: no picture was taken; this world shows its state only to the people it lets in, and it didn't take this body's read key (${r.status}). Calling again won't change that: the world's owners decide who comes in, and the host's operator issues this body's key`);
    if (!r.ok) {
      // The server's text in parentheses, where its own quoted names can't
      // nest in ours; the remedy is the status's (server/snapshots.ts).
      const said = (await r.text()).slice(0, 200).replace(/\s+/g, " ").trim();
      const remedy = r.status === 429 ? "try again in a few seconds"
        // an Unreal-only request summons no roaming renderer, and "auto" can pick the same Unreal
        // renderer again; "browser" takes a browser renderer, or summons one (server/snapshots.ts)
        : r.status === 503 && renderer === "unreal" ? `try again in a while, or ask for renderer "browser"`
        : r.status === 404 ? "calling again works only once what it says has changed"
        : r.status < 500 ? "calling again with the same arguments won't change that"
        : "try again in a while";
      return fail(`screenshot: no picture was taken; the world server answered ${r.status}${said ? ` (${said})` : ""}, so ${remedy}`);
    }
    const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
    const label = r.headers.get("x-eidoverse-scene") === "world-projection"
      ? "Unreal server-world projection: models, structures, terrain and avatars; unsupported components and effects may be absent. This is a donor-rendered image, not authoritative state."
      : "Unreal underwater prototype view: local terrain/habitats and networked avatars; persistent world buildings are not mirrored.";
    const image = { type: "image", data: b64, mimeType: "image/png" };
    return { content: [...(r.headers.get("x-eidoverse-renderer") === "unreal" ? [{ type: "text", text: label }] : []), image, ...(note ? [{ type: "text", text: note }] : [])] };
  } catch (e) {
    return fail(`screenshot failed: no picture arrived from the world server (${(e as Error).message}); try again in a moment`);
  }
}

// ---- the dispatcher --------------------------------------------------------
// One handler per tool, keyed to TOOLS by NAME — the verbs.ts/messages.ts
// treatment (survey §B3, deferred until the table had one home): bodies moved
// VERBATIM from the 26-case switch. The load-time assertion below makes
// advertise/handle drift a boot failure on BOTH servers instead of an
// "Unknown tool" a caller meets at runtime.

const text = (t: string) => ({ content: [{ type: "text", text: t }] });
/** A call that didn't do what it was asked: a host shows the result as failed. */
const fail = (t: string) => ({ content: [{ type: "text", text: t }], isError: true });
// expect's limit, the authority's (authority.js expectCheck): a request pins at most this many components
const EXPECT_MAX = 256;
/** expect entries pinning these components of one thing to `read`, the plan's read of it (agent componentsOf): its value,
 *  or absent when the read hadn't it. A purged component is left out: the authority counts a purged value equal to
 *  nothing, so a pin on one would be refused as changed every time, and replacing it could never go through. */
function pinsOf(id: string, comps: string[], read: Record<string, unknown> | null): { id: string; component: string; value?: unknown }[] {
  return comps.filter((k) => !(read && read[k] === PURGED))
    .map((k) => read && k in read ? { id, component: k, value: read[k] } : { id, component: k });
}
/** An act's answer, failed when the call didn't do what it asked. */
const act = (r: ActResult) => (r.ok ? text(r.text) : fail(r.text));
/** The most speech say sends in one call, as it always has: 4000 UTF-16 units. A cut never ends in half of a
 *  surrogate pair. */
const SPEECH_MAX = 4000;
const cutSpeech = (t: string) => {
  if (t.length <= SPEECH_MAX) return t;
  const end = /[\uD800-\uDBFF]/.test(t[SPEECH_MAX - 1]!) ? SPEECH_MAX - 1 : SPEECH_MAX;
  return t.slice(0, end);
};
/** An altitude the call can't fly to: not a number. A number flies, and so does a string that reads as one, as
 *  `Number()` always took "5"; a boolean, a blank, a list or an object doesn't. */
const notANumber = (v: unknown) => typeof v === "number" ? !Number.isFinite(v)
  : typeof v !== "string" || v.trim() === "" || !Number.isFinite(Number(v));
/** The authority's refusal as a tool error: the code, why, and what to do instead. */
// the same words a person in edit mode sees for the same refusal (shared/protocol/refusal.js)
/** One line of a world's history, as an agent reads it: who did what, with what arguments. An entry imported from an
 *  old log (an act `imported`) shows the verb and args it was written with, not `imported {}`; a refused request says it
 *  was refused, and never reads as a thing that happened (Commons audit, agents #3). */
export function historyLine(e: any): string {
  const who = actorName(String(e.actor)); const when = e.ts ? `${new Date(e.ts).toISOString()} ` : "";
  const args = (v: any) => { const j = JSON.stringify(v ?? {}); return j.length > 300 ? `${j.slice(0, 300)}…` : j; };
  if (e.kind === "say") { const b = e.body ?? {}; if (b.text === undefined && b.commit !== undefined) return `#${e.seq} ${when}${who}: say (purged)`;
    return `#${e.seq} ${when}${who}: say ${JSON.stringify(b.text ?? "")}${b.to ? ` (to ${actorName(String(b.to))})` : ""}`; }
  const b = e.body ?? {};
  if (e.verb === "imported") return `#${e.seq} ${when}${who}: ${b.verb ?? "?"} ${args(b.args)} (imported from the old log${Number.isInteger(b.from) ? `, #${b.from}` : ""})`;
  if (b.refused) return `#${e.seq} ${when}${who}: tried ${e.verb} ${args(b.request)} — REFUSED (${b.refused.code}); nothing changed`;
  return `#${e.seq} ${when}${who}: ${e.verb} ${args(b.request ?? Object.fromEntries(Object.entries(b).filter(([k]) => k !== "salt")))}`;
}
/** A presence message (puppet) has no reply when it's forwarded; a refusal comes back as the server's `error` at once.
 *  Wait briefly for one sent after t0 and return its words, or null. */
async function presenceRefusal(ag: ToolAgent, t0: number, ms = 700): Promise<string | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const r = ag.lastRefusal; if (r && r.ts >= t0) return r.text; await new Promise((res) => setTimeout(res, 25)); }
  return null;
}
const refusedBy = (r: any, what: string) => ({ content: [{ type: "text", text: refusalText(what, r) }], isError: true });
// R 10-17 (ID HARDENING (5)): every tool argument that names a thing takes its id, its label or a unique id prefix (4+,
// git-style; look prints each thing's short handle). A label two things share is refused with the candidates — never
// resolved by picking one. One resolver (WorldAgent.thingRef; destination() asks it too); a name that matches nothing is
// passed on as typed, for the authority's own not-found words.
const THING_KEYS = ["id", "on", "beside", "hang", "against", "near", "facing", "from", "copy", "to", "target"];
function namedThings(ag: any, a: Record<string, any>, keys: string[] = THING_KEYS): { args: Record<string, any> } | { err: any } {
  const out: Record<string, any> = { ...a };
  for (const k of keys) { const v = out[k]; if (typeof v !== "string" || !v.trim()) continue;
    const r = ag.thingRef(v); if ("refusal" in r) return { err: { content: [{ type: "text", text: `${k}: ${r.refusal}` }], isError: true } };
    if ("id" in r) out[k] = r.id; }
  return { args: out };
}
/** Is this body in the air? (the flight integrator's phases; GROUND/LANDED are feet on the ground, and so are RAGDOLL and
 *  RECOVER, a body down on the ground after a cut, which a fly-mode move launches afresh, as the agent's down refusals say) */
const airborne = (ag: ToolAgent) => !!ag.flight && !["GROUND", "LANDED", "RAGDOLL", "RECOVER"].includes(ag.flight.phase);
/** A name move {to} takes that destination() doesn't: a place in the older upstream shape (`places:<name>` on @world or
 *  a thing's `places` entry given as a bare [x, y, z] / {pos}, world coordinates). Things, labels, people and places in the
 *  current shape are destination()'s alone (review r5 F3: one resolver, so a person never captures a walk here and of
 *  several things the nearest is taken). */
function legacyPlace(ag: ToolAgent, name: string): { x: number; z: number; what: string } | null {
  const st: any = ag.replica?.st ?? {};
  const places: Record<string, any> = { ...(st.places ?? {}), ...(st.entities?.[WORLD_ID]?.c?.places ?? {}) };
  for (const e of ag.entities.values() as any) for (const [k, v] of Object.entries<any>((e as any)?.places ?? {})) places[k] ??= v;
  const pl = places[name] ?? places[`places:${name}`];
  const pp = Array.isArray(pl) ? pl : Array.isArray(pl?.pos) ? pl.pos : null;
  return pp && pp.every(Number.isFinite) && pp.length >= 2 ? { x: pp[0], z: pp.length === 3 ? pp[2] : pp[1], what: `the place "${name}"` } : null;
}

/** measure {check: true}: #241's check_model, a mode of measure (it reads a model's geometry as data; check_model is an alias). */
const CHECK_MODEL = async (ag: WorldAgent, a: Record<string, any>) => {
  const e = a.id ? ag.entities.get(String(a.id)) : null;
  if (a.id && !e) return fail(`no thing called "${a.id}" here`);
  const lib = String(e?.model ?? a.lib ?? "");
  if (!lib) return fail("measure {check: true} needs the id of a placed model, or a library path");
  let r: any;
  // a placed thing is checked as placed: at its scale (the body is not scaled)
  const scale = e ? (e.scale && e.scale > 0 ? e.scale : 1) : (typeof a.scale === "number" && a.scale > 0 ? a.scale : 1);
  try { r = await (await fetch(`${ag.httpBase}/check?lib=${encodeURIComponent(lib)}${scale !== 1 ? `&scale=${scale}` : ""}`)).json(); }
  catch (err) { return fail(`the check could not be reached: ${String((err as Error)?.message ?? err)}`); }
  if (r.error) return fail(`couldn't check ${lib}: ${r.error}`);
  return text(describeCheck(`${e ? `[${ag.refName(e.id)}] ` : ""}${lib}${r.scale && r.scale !== 1 ? ` at scale ${r.scale}` : ""}`, r, e ? ag.placesOn(e).length : 0, e?.id, e?.collide));
};

type ToolHandler = (ag: WorldAgent, a: Record<string, any>, ctx: ToolCtx, name: string)
  => Promise<Record<string, unknown>> | Record<string, unknown>;

// ---- act's body verbs ------------------------------------------------------
// Verbs `act` answers before the authority: the body's own (land, shove — presence, like a person's /push) and
// moderation by NAME (kick/ban/unban resolve a name to an identity through whois, then ask the authority; bans
// reads what's in force). Each answers in act's shape: {ok, text} as text, isError on a refusal.
// One answer to "who": a person's identity (u-…) as given, a present person's by the name they arrived with, anyone the
// world has seen by name through the directory (whois) — so an absent person can be banned, unbanned or warned. Every
// verb that takes a `who` resolves through here (the kick family and `act`), so there is one way to say who, not two.
// Returns {who} or {err: <tool result>}; `verb` only shapes the words (a kick needs them here).
async function resolveWho(ag: any, raw: unknown, verb: string): Promise<{ who: string } | { err: any }> {
  const id = String(raw ?? "").trim();
  if (!id) return { err: fail(`${verb} needs who — their name or identity (u-…)`) };
  let who = /^u-[a-z2-7]{20}$/.test(id) ? id : ag.actorIds.get(id) ?? null;
  if (!who) {
    const w: any = await ag.request("whois", { name: id });
    const ppl: any[] = w?.ok ? w.people ?? [] : [];
    if (ppl.length > 1) return { err: { content: [{ type: "text", text: `${verb}: ${ppl.length} people here have gone by "${id}" — say which identity: ${ppl.map((p) => `${p.id} (${p.guest ? "a guest, " : ""}${p.role}${p.here ? ", here" : ""})`).join("; ")}` }], isError: true } };
    if (verb === "kick" && ppl[0] && !ppl[0].here) return { err: { content: [{ type: "text", text: `kick: ${id} isn't here to remove (a kick takes someone out now; ban keeps someone away)` }], isError: true } };
    who = ppl[0]?.id ?? null;
    if (!who) return { err: { content: [{ type: "text", text: `${verb}: nobody called "${id}" has been in this world${w?.ok ? "" : ` (${w?.refused?.reason ?? "no answer"})`} — whois finds the people it has seen` }], isError: true } };
  }
  return { who };
}

const BODY_VERBS: Record<string, ToolHandler> = {
  land: async (ag, a) => {
    const to = Array.isArray(a.to) ? a.to.map(Number) : [Number(a.x), Number(a.z)];
    const x = to[0], z = to.length === 3 ? to[2] : to[1];
    if (![x, z].every(Number.isFinite)) return { content: [{ type: "text", text: "land needs to: [x, z] (or [x, y, z]) — where to come down" }], isError: true };
    if (!airborne(ag)) return { content: [{ type: "text", text: `land: ${ag.flight ? "already on the ground" : "you are on the ground"} — move {mode: "fly"} gets you up` }], isError: true };
    return act(await ag.landAt(x, z));
  },
  shove: async (ag, a, ctx, name) => {
      if (!a.target) return { content: [{ type: "text", text: "shove needs a `target` — the body that falls simulates it" }], isError: true };
      // the shove is directed: from where THIS body stands, through the
      // target — the same line a browser /push uses. No known position for
      // them = an undirected knock-over, the old wire.
      const to = String(a.target);
      const tp = ag.people.get(to)?.pose?.p;
      const pow = Math.min(4, Math.max(0.5, Number(a.strength) || 2.2));
      let lean: number[] | null = null;
      if (Array.isArray(tp)) {
        const dx = tp[0] - ag.pos.x, dz = tp[2] - ag.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.05) lean = [(dx / d) * pow, 0, (dz / d) * pow];
      }
      const t0 = Date.now();
      ag.puppet(to, { ragdoll: lean ? { lean } : true });
      // the server checks the target's consent (class shove) and range before it forwards a shove, and answers a refusal
      // with an error (server/messages.ts bodyRefusal); silence is the only yes it gives (parity audit 10-07 F2)
      const no = await presenceRefusal(ag, t0);
      if (no) return { content: [{ type: "text", text: `shove refused (consent class: shove): ${no}` }], isError: true };
      return text(`you shove ${to}${lean ? " — they go down the way you pushed" : " — asked them to go limp"} (the server passed it on; their body has the last word)`);

  },
  kick: async (ag, a, ctx, name) => {
      // Moderation deserves a real answer, not fire-and-forget: wait for
      // the world's echo (success) or refusal and hand THAT back.
      const id = String(a.who ?? "").trim();
      if (!id) return fail(`${name} needs who — their name or identity (u-…)`);
      const reason = a.reason != null ? String(a.reason) : undefined;
      const t0 = Date.now();
      if (a.global && name !== "kick") {
        ag.sendMod(name === "ban" ? "global-ban" : "global-unban", { id, ...(reason ? { reason } : {}) });
        const answer = await ag.modOutcome(t0);
        // A refusal is the world's no; no echo yet is sent, not refused.
        if (answer?.startsWith("refused: ")) return fail(answer);
        return text(answer ?? `sent ${name} ${id} (global) — no echo yet; check look()`);
      }
      const rw = await resolveWho(ag, a.who, name); if ("err" in rw) return rw.err; const who = rw.who;
      const r: any = await ag.request(name, { who, ...(reason ? { reason } : {}), ...(name === "kick" && a.minutes != null ? { minutes: Number(a.minutes) } : {}), ...(name === "ban" && a.days != null ? { days: Number(a.days) } : {}) });
      return r?.ok ? text(`${name} ${id}${who !== id ? ` (${who})` : ""}: done (${r.logged ?? "the moderator log"})`) : refusedBy(r, name);

  },
  bans: async (ag, a, ctx, name) => {
      if (a.global) {
        const t0 = Date.now();
        ag.sendMod("global-bans");
        const answer = await ag.modOutcome(t0);
        if (answer == null || answer.startsWith("refused: ")) return fail(answer ?? "no reply from the world (timeout)");
        return text(answer);
      }
      // this world: the authority's `bans` (what the Moderation panel reads): bans, removals and mutes in force.
      // The legacy world-bans message listed bans only, so a mute in force read "nobody is banned" (audit 10-07)
      const r: any = await ag.request("bans", {});
      if (!r?.ok) return { content: [{ type: "text", text: r?.refused?.reason ?? "couldn't read what's in force here" }], isError: true };
      const until = (t: any) => (Number.isFinite(t) ? `until ${new Date(t).toISOString()}` : "until lifted");
      const why = (x: any) => (x?.reason ? ` — ${x.reason}` : "");
      const lines: string[] = [];
      for (const x of r.now ?? []) {
        const who = x.name ? `${x.name} (${x.who})` : x.who;
        if (x.ban) lines.push(`banned: ${who} ${until(x.ban.until)}${why(x.ban)}`);
        else if (x.kick) lines.push(`removed, cooling down: ${who} ${until(x.kick.until)}${why(x.kick)}`);
        if (x.mute) lines.push(`muted (${(x.mute.channels ?? ["voice", "chat"]).join(" + ")}): ${who} ${until(x.mute.until)}${why(x.mute)}`);
      }
      return text(lines.length ? lines.join("\n") : "nobody is banned or muted here");

  },
};
BODY_VERBS.ban = BODY_VERBS.kick; BODY_VERBS.unban = BODY_VERBS.kick;

export const HANDLERS: Record<string, ToolHandler> = {
  look: async (ag, a, ctx, name) => { return text(ag.look()); },
  body_state: async (ag, a) => {
    const self = a.who == null || a.who === "self" || a.who === ag.name;
    const result = await ag.bodyState(self ? ag.name : String(a.who), a.detail ?? "summary", a.points, a.window_ms ?? 0);
    // flight_status folded here: where the sky has left you — or that you are on the ground
    const out = self ? { ...result, flight: ag.flightStatus() } : result;
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], ...(result.ok ? {} : { isError: true }) };
  },
  screenshot: async (ag, a, ctx, name) => {
    // at takes what look prints, a handle or a label, as the other tools do: the renderer wants the full id
    let at = typeof a.at === "string" && a.at ? a.at : undefined;
    if (at) { const t = ag.thingRef(at); if ("refusal" in t) return fail(`screenshot: ${t.refusal}`); if ("id" in t) at = t.id; }
    return await screenshotTool(ag, typeof a.view === "string" ? a.view : "first", at,
    typeof a.renderer === "string" ? a.renderer : "auto", { dist: a.dist, height: a.height, pitch: a.pitch }); },
  set_avatar: async (ag, a, ctx, name) => {
      const roster = (await (await fetch(`${ag.httpBase}/avatars`)).json()) as { name: string; path: string }[];
      const want = String(a.avatar ?? "").trim();
      if (!want) return text(`bodies on the roster: ${roster.map((r) => r.name).join(", ")}`);
      const path = want.includes("/") ? want : roster.find((r) => r.name === want)?.path;
      if (!path) return fail(`no body named "${want}" is on the roster, so you're still wearing your current body. ${roster.length ? `The roster has: ${roster.map((r) => r.name).join(", ")}.` : "The roster is empty."} A path with a slash names a library model instead.`);
      ag.setAvatar(path);
      ctx.rememberAvatar?.(path);   // the choice outlives this session
      return text(`you are now wearing ${want.includes("/") ? path.split("/").pop() : want}`);

  },
  attach: async (ag, a) => {
      // a body on a seat is PRESENCE (bodies aren't entities; nothing is logged): my frames carry {to: <socket id>} while
      // I sit. A seat is a socket child with a body block (PLAN-sockets-entities; shared/sockbody.js). `to` is the thing
      // (pick by `socket` name or by `action`), or a socket's own id. The authority is asked first (use {id: <socket>,
      // action}): it checks who may, and that nobody sits there. The seat's leaveBy decides how I get off, and fromSeat
      // whether I may move to it without standing.
      let want = String(a.to ?? "").trim();
      if (want && !ag.socketRec(want)) { const t = ag.thingRef(want); if ("refusal" in t) return { content: [{ type: "text", text: `attach: ${t.refusal}` }], isError: true }; if ("id" in t) want = t.id; }
      const mine = ag.myOccupancy;
      if (!want) return { content: [{ type: "text", text: "attach needs to: the thing to get on (detach gets you off)" }], isError: true };
      const direct = ag.socketRec(want);   // a socket's own id
      const on = direct ? String(direct.host ?? "") : want;
      if (!ag.foldRecord(on)) return { content: [{ type: "text", text: `attach: nothing here called "${want}"` }], isError: true };
      const all = (direct ? [direct] : ag.socketsOf(on)).map((x: any) => ({ id: x.id, slot: x.name, body: bodyOf(x.station) })).filter((x: any) => x.body);   // only sockets a person can attach to
      const taken = new Set([...ag.mounts.entries()].filter(([id]) => id !== ag.name).map(([, m]) => m.to));
      const fits = all.filter((x: any) => (a.socket == null || x.slot === String(a.socket)) && (a.action == null || x.body.action === String(a.action)));
      const pick: any = fits.find((x: any) => !taken.has(x.id)) ?? null;
      if (!pick) {
        const why = !all.length ? "declares no seat" : !fits.length ? `has no ${a.action != null ? `'${a.action}' ` : ""}seat${a.socket != null ? ` called "${a.socket}"` : ""}` : "has every such seat taken";
        // the remedy is a whole call, id and set
        return { content: [{ type: "text", text: `attach: ${on} ${why} (its seats: ${all.map((x: any) => `${x.slot} (${x.body.action})`).join(", ") || "none"})${all.length ? "" : ` — a builder can add one: edit {id: "${ag.handle(on)}", set: {"sockets.seat|pos|1": 0.5}} (a new socket is a seat)`}` }], isError: true };
      }
      const { id: sid, slot, body } = pick;
      if (mine && mine.to !== sid) {
        if (!body.fromSeat) return { content: [{ type: "text", text: `attach: you're on ${ag.socketName(mine.to)}; ${on} (${slot}) doesn't take you straight from another seat — detach first` }], isError: true };
      }
      { const r = await ag.request("use", { id: sid, action: body.action });
        if (!r?.ok) return { content: [{ type: "text", text: `attach: the authority refused (${r?.refused?.code}): ${r?.refused?.reason ?? ""}${r?.refused?.fix ? ` — ${r.refused.fix}` : ""}` }], isError: true }; }
      ag.setOccupant({ to: sid });   // (no pose menu: a station's poses are reserved in the alpha, review r11 claims R4)
      return text(`you ${body.action} on ${on} — ${describeBody(slot, body, { door: true })}`);
  },
  detach: async (ag, a) => {
      const mine = ag.myOccupancy;
      if (!mine) return text("you're not attached to anything");
      // the escape (review r9 scars M1): a seat may make leaving deliberate, never impossible
      if (!ag.mayVacate(a?.escape === true ? "escape" : "menu")) return { content: [{ type: "text", text: `${ag.socketName(mine.to)} lets you go when the world does (a script, or the seat being taken away); detach {escape: true} gets you up anyway` }], isError: true };
      ag.setOccupant(null); return text(a?.escape === true ? "you get up (the escape: no seat can hold you)" : "you get off");
  },
  library: async (ag, a, ctx, name) => {
      // one catalog tool: query (search), kind + page (a contact sheet), preview (one item)
      if (typeof a.query === "string" && a.query.trim()) {
        const hits = await searchLibrary(ag.httpBase, String(a.query));
        return text(hits.length
          ? hits.map((h) => h.name && !h.path.includes(h.name) ? `${h.path}  — ${h.name}` : h.path).join("\n")
          : "no matches");
      }
      if (typeof a.preview === "string" && a.preview.trim()) {
        const want = String(a.preview).trim();
        const tries: string[] = [];
        if (!want.includes("/") && !/\.(glb|jpg)$/i.test(want)) tries.push(`${ag.httpBase}/thumb/${encodeURIComponent(want)}.png`);
        const stem = (want.includes("/") ? want : `eidoverse/assets/models/${want}`).replace(/(_preview\.jpg|\.jpg|\.glb)$/i, "");
        tries.push(`${ag.httpBase}/library/${stem}_preview.jpg`);
        // Only a 404 is the sequencer's answer that a candidate has no preview.
        // A fetch that throws, any other status that isn't ok, or a body that
        // can't be read never got that answer, so "no preview" is said only
        // when every candidate answered 404. Calling again may work after a
        // failed fetch, a 408, a 429, a 5xx or a preview that couldn't be read,
        // at any candidate. Each reason is named once, so two candidates that
        // failed alike read as one.
        const whys: string[] = [];
        let retry = false;
        const miss = (reason: string, mayRetry: boolean) => { if (!whys.includes(reason)) whys.push(reason); retry ||= mayRetry; };
        for (const url of tries) {
          let r: Response;
          try { r = await fetch(url); } catch (e) { miss((e as Error).message || "the request failed", true); continue; }
          if (r.status === 404) continue;
          if (!r.ok) { miss(`it answered ${r.status}`, r.status >= 500 || r.status === 408 || r.status === 429); continue; }
          let data: string;
          try { data = Buffer.from(await r.arrayBuffer()).toString("base64"); }
          catch (e) { miss(`a preview it sent couldn't be read: ${(e as Error).message || "no reason given"}`, true); continue; }
          return { content: [{ type: "image", data, mimeType: r.headers.get("content-type")?.split(";")[0] ?? "image/jpeg" }] };
        }
        if (whys.length) return fail(`couldn't get a preview of "${want}" from the world's server (${whys.join("; ")})${retry ? "; calling again may work" : "; calling again won't change that"}`);
        return fail(`no preview for "${want}" — avatar portraits appear once a body has been worn; library models ship _preview.jpg files`);
      }
      if (a.kind !== "models" && a.kind !== "avatars") return { content: [{ type: "text", text: "library takes one of: query (search the model library), kind: \"models\" | \"avatars\" (+ page: a contact sheet), preview: <a roster name or model path>" }], isError: true };
      const kind = a.kind === "models" ? "models" : "avatars";
      const page = Math.max(1, Math.floor(Number(a.page) || 1));
      let items: { name: string; url: string | null; h?: number | null }[];
      if (kind === "avatars") {
        const roster = (await (await fetch(`${ag.httpBase}/avatars`)).json()) as { name: string; height?: number | null }[];
        items = roster.map((r) => ({ name: r.name, url: `${ag.httpBase}/thumb/${encodeURIComponent(r.name)}.png`, h: r.height ?? null }));
      } else {
        const hits = (await (await fetch(`${ag.httpBase}/library-models`)).json()) as { path: string; name: string; preview: string | null }[];
        items = hits.map((h) => ({
          // library files: the filename IS the spawnable identity; store
          // items: the hash filename means nothing — show the given name
          name: h.path.startsWith("store/") ? h.name : h.path.split("/").pop()!.replace(/\.glb$/i, ""),
          url: h.preview ? `${ag.httpBase}/library/${h.preview}` : null,
        }));
      }
      const pages = Math.max(1, Math.ceil(items.length / SHEET.perPage));
      const slice = items.slice((page - 1) * SHEET.perPage, page * SHEET.perPage);
      // A page past the end asked for something that isn't there. An empty
      // roster or library is an answer: the lookup ran and found none.
      if (!slice.length) return items.length
        ? fail(`no page ${page}: there are ${items.length} ${kind} on ${pages} page${pages === 1 ? "" : "s"}, so pass a page from 1 to ${pages}`)
        : text(`there are no ${kind} to show yet`);
      const tiles = await Promise.all(slice.map(async (it) => {
        if (!it.url) return { name: it.name, data: null, mime: "", h: it.h };
        try {
          const r = await fetch(it.url);
          if (!r.ok) return { name: it.name, data: null, mime: "", h: it.h };
          return { name: it.name, data: await r.arrayBuffer(), mime: r.headers.get("content-type")?.split(";")[0] ?? "image/png", h: it.h };
        } catch { return { name: it.name, data: null, mime: "", h: it.h }; }
      }));
      const png = await contactSheet(tiles);
      return { content: [
        { type: "text", text: `${kind} — page ${page}/${pages}: ${slice.map((t) => t.name).join(", ")}${page < pages ? `. More: library {kind:"${kind}", page:${page + 1}}` : ""}` },
        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
      ] };

  },
  move: async (ag, a, ctx, name) => {
      if (ag.myOccupancy && !ag.mayVacate("menu")) return { content: [{ type: "text", text: `you're held on ${ag.socketName(ag.myOccupancy.to)}: it lets you go when the world does (detach {escape: true} gets you up anyway)` }], isError: true };
      const mode = a.mode == null ? "walk" : String(a.mode);
      if (mode !== "walk" && mode !== "fly") return { content: [{ type: "text", text: `move: mode is "walk" (default) or "fly"` }], isError: true };
      // to: [x, y, z] (y picks the floor there, #236) or [x, z] (no y: the walk's own storey, else the lowest floor), or a
      // NAME: a named place (#239: "thing/place", a place's name or label, a thing's entrance), a thing, a person
      let x: number, z: number, y: number | undefined, what = "", label: string | null = null;
      let near: { reach?: number; above?: number; below?: number; inside?: (x: number, z: number) => boolean; bodyAt?: { x: number; z: number } } = {};
      let orBeside: Destination | undefined;   // a thing on another's top: the spot beside what holds it up (review r6 L1)
      const tolerance = a.tolerance ?? 0.01;
      if (typeof a.to === "string") {
        const q = a.to.trim();
        if (q.startsWith("?")) return text(ag.placeList(q.slice(1)));   // the named places here, seen or not (owner 22:40), nearest 200; "?<text>" narrows: no move
        // a named place (it carries its own floor and reach), a thing (its entrance, else up to it and beside it), a
        // person (stopping short): destination() alone; only a place in the older upstream shape is read here besides
        const d = ag.destination(q);
        if (!("refusal" in d)) { ({ x, z } = d); y = d.y; near = { reach: d.reach, above: d.above, below: d.below, inside: d.inside, bodyAt: d.bodyAt }; label = d.label; orBeside = d.orBeside; }
        else {
          const r = legacyPlace(ag, q);
          if (!r) return { content: [{ type: "text", text: `move: ${d.refusal}` }], isError: true };
          ({ x, z } = r); what = ` (${r.what})`;
        }
      } else if (a.to != null || mode === "walk") {
        // a null coordinate is no value, not 0: Number(null) would pick the floor at height 0
        const to = Array.isArray(a.to) ? a.to.map((v: unknown) => v == null ? NaN : Number(v)) : [];
        x = to[0]; z = to.length === 3 ? to[2] : to[1];
        if (to.length === 3) y = a.to[1] == null ? undefined : to[1];
        if (to.length !== 2 && to.length !== 3)
          return { content: [{ type: "text", text: "move needs to: [x, y, z] (or [x, z]) of finite numbers, or a name (a named place, a thing's id or label, a person; \"?\" lists the places)" }], isError: true };
      } else { x = NaN; z = NaN; }
      if (y != null && !Number.isFinite(y)) return { content: [{ type: "text", text: WALK_ARGS_REASON }], isError: true };
      // a non-finite point or a tolerance out of range: walkTo's own refusal, in its own words (WALK_ARGS_REASON)
      if (((a.to != null || mode === "walk") && ![x, z].every(Number.isFinite)) || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 0.4)
        return { content: [{ type: "text", text: WALK_ARGS_REASON }], isError: true };
      if (mode === "fly") {
        // FLIGHT (upstream's flight arc, merged 2026-09-02; behind the world's `fly` grant). The integrator is the agent's
        // (shared/flight.js); this is only its door: take off if on the ground, climb if asked, glide if sent somewhere.
        const L: string[] = [];
        // the arguments are checked before the launch, so a refusal moves nothing
        if (a.altitude != null && notANumber(a.altitude)) return fail("move {mode: \"fly\"}: altitude is a number of metres");
        if (!airborne(ag)) { const r = await ag.takeOff(); L.push(r.text); if (!r.ok || !airborne(ag)) return fail(L.join("\n")); }
        if (a.altitude != null) {
          const r = await ag.climbTo(Number(a.altitude)); L.push(r.text);
          if (!r.ok) return fail([...L, ag.flightStatus()].join("\n"));
        }
        if (Number.isFinite(x) && Number.isFinite(z)) {
          const r = await ag.glideTo(x, z); L.push(r.text + what);
          if (!r.ok) return fail([...L, ag.flightStatus()].join("\n"));
        }
        L.push(ag.flightStatus());
        return text(L.join("\n"));
      }
      // this request's own refusal (receipt): its plan may wait for placed geometry still loading (#235), so walkRefusal,
      // read straight after the call, could belong to a later walk
      let receipt = { refusal: null as string | null };
      const attempt = async () => {
        receipt = { refusal: null };
        let ok = await ag.walkTo(x, z, Boolean(a.run), 90_000, tolerance, y, near, receipt);
        // a y no floor matches (mid-air, or under every floor there): the nearest place to stand at any height, said so
        if (!ok && y != null && near.above == null && /^nowhere to stand/.test(receipt.refusal ?? "")) {
          const first = receipt.refusal;
          receipt = { refusal: null };
          ok = await ag.walkTo(x, z, Boolean(a.run), 90_000, tolerance, y, { ...near, above: Infinity }, receipt);
          if (!ok && !receipt.refusal) receipt.refusal = first;
        }
        return ok;
      };
      let arrived = await attempt();
      // refused before a step, and the thing stands on another's top (a cup on a table, a walk that can't climb onto it):
      // beside what holds it up instead, on its floor; the first refusal is the one said if none of them is walked
      // A walk stopped or replaced while it waited for geometry (agent.ts walkTo's receipt) isn't a route refused: the
      // fallback would start the walk that was just cancelled, so it ends the tries and is the one said
      const superseded = () => /^superseded by a newer walk or a stop/.test(receipt.refusal ?? "");
      const firstRefusal = receipt.refusal;
      for (let alt = orBeside; !arrived && receipt.refusal && !superseded() && alt; alt = alt.orBeside) {
        ({ x, z } = alt); y = alt.y; near = { reach: alt.reach, above: alt.above, below: alt.below, inside: alt.inside };
        arrived = await attempt();
      }
      if (!arrived && receipt.refusal && !superseded()) receipt.refusal = firstRefusal;
      const planned = receipt.refusal;
      // no route (a sealed room, a structure over the search limit, two that conflict): refused before a step, and why
      if (!arrived && planned) return { content: [{ type: "text", text: `move refused before a step: ${planned}\nyou stand at (${ag.pos.x.toFixed(3)}, ${ag.pos.z.toFixed(3)})${what}` }], isError: true };
      const note = ag.lastWalkNote ? ` (${ag.lastWalkNote})` : "";
      // E1: the authority walks this body too; a stretch it refused (a wall, out of bounds) stopped it, and says why
      const no = ag.lastWalkRefusal;
      if (!arrived && no) return { content: [{ type: "text", text: `${refusalText("move", { refused: no })}\nyou stopped at (${ag.pos.x.toFixed(3)}, ${ag.pos.z.toFixed(3)}), ${Math.hypot(ag.pos.x - x, ag.pos.z - z).toFixed(3)}m short${note}${what}` }], isError: true };
      if (!arrived) return fail(ag.walkStopReason ?? ag.walkStall ?? "walk interrupted or timed out");   // main #241: the stride's own stop reason first
      // which floor it chose, when the y asked for wasn't one (#236 y, owner 22:40)
      const floorNote = y != null && Math.abs(ag.pos.y - y) > 0.1 ? `; no floor at ${y.toFixed(2)} m there — you're on the floor at ${ag.pos.y.toFixed(2)} m` : "";
      // which named room you're in now (#239)
      const here = ag.placesAt([ag.pos.x, ag.pos.y, ag.pos.z])[0];
      const inRoom = here ? `, in ${here.place.label ?? here.place.name} (${ag.refName(here.entity.id)}/${here.place.name})` : "";
      return text(label
        ? `arrived at ${label}: (${ag.pos.x.toFixed(2)}, ${ag.pos.y.toFixed(2)}, ${ag.pos.z.toFixed(2)})${here ? `, in ${here.place.label ?? here.place.name}` : ""}${note}`
        : `arrived at (${ag.pos.x.toFixed(3)}, ${ag.pos.z.toFixed(3)}); ${Math.hypot(ag.pos.x - x, ag.pos.z - z).toFixed(3)}m from requested destination${floorNote}${inRoom}${note}${what}`);

  },
  name_place: async (ag, a) => {
      // coordinates: x and z together (y optional: the floor there nearest
      // your own height), or none — never some of them silently dropped
      const given = [a.x, a.y, a.z].some((v: unknown) => v != null);
      if (given && ![a.x, a.z].every((v: unknown) => typeof v === "number" && Number.isFinite(v)))
        return { content: [{ type: "text", text: "name_place's coordinates need x and z (y is optional: the floor there nearest your own height) — or leave them all out to name where you stand" }], isError: true };
      if (a.y != null && !(typeof a.y === "number" && Number.isFinite(a.y)))
        return { content: [{ type: "text", text: "name_place's y, when given, must be a finite height in metres" }], isError: true };
      const at = given ? { x: a.x as number, z: a.z as number, y: a.y as number | undefined } : undefined;
      let on = a.on; if (typeof on === "string" && on.trim()) { const t = ag.thingRef(on); if ("refusal" in t) return { content: [{ type: "text", text: `name_place: ${t.refusal}` }], isError: true }; if ("id" in t) on = t.id; }
      return act(await ag.namePlace(String(a.name ?? ""), { on, label: a.label, remove: a.remove === true, at }));
  },
  face: async (ag, a, ctx, name) => {
      if (a.target) {
        let tid = String(a.target); if (!ag.people.has(tid)) { const t = ag.thingRef(tid); if ("refusal" in t) return { content: [{ type: "text", text: `face: ${t.refusal}` }], isError: true }; if ("id" in t) tid = t.id; }
        // a thing's world point, as move reads it: a child's pos is local to its parent
        const person = ag.people.get(tid)?.pose?.p;
        let p: number[] | undefined = person;
        if (!p && ag.entities.has(tid)) { const w = ag.worldPointOf(tid); if ("why" in w) return fail(`face: you didn't turn, since where ${a.target} is can't be worked out here: ${w.why}`); p = w.pos; }
        if (!p) return fail(`nothing here is called "${a.target}", so you didn't turn; look lists who and what is around you`);
        ag.face(p[0], p[2]);
      } else if (a.x != null && a.z != null) ag.face(Number(a.x), Number(a.z));
      else return fail('face needs x and z, or a target, so you didn\'t turn: face {x: 4, z: -2} or face {target: "<an id from look>"}');
      return text("facing");

  },
  stop: async (ag, a, ctx, name) => { ag.stop(); return text("stopped"); },
  // say args ride through whole (spoken-say protocol: a voice aux leg
  // performs says marked spoken:true; utt/t0 are author-controlled
  // display/continuation metadata — NOT proof of performance, which only
  // the attest/performed receipt path establishes). ag.say rebuilt {text}
  // bare and silently stripped them —
  // which forced voice agents onto a raw world-ws side door (2026-08-10).
  say: async (ag, a, ctx, name) => {
      // Spoken-say protocol keys ride through; anything else stays at the
      // door. The server validates these (bounded utt window, clamped t0)
      // and strips them from ordinary says — the authority's job is to forward
      // the protocol, not arbitrary metadata.
      // THE TRIO IS A UNIT (r3 review). The world server deletes all three
      // keys unless spoken===true AND utt is a safe non-negative integer —
      // so forwarding keys independently let a spoken:true say with a bad
      // utt ride to the server and silently degrade to ordinary chat, the
      // voice agent none the wiser. Validate the same unit here and refuse
      // LOUDLY: a door that must drop the protocol should say so, not shrug
      // the say into text. (r5 tightened this to TYPE-EXACT rather than the
      // server's Number() coercion — see the next block: the authority refuses
      // null/bool/"5" outright so a coerced value can never be laundered into
      // a fabricated utterance.)
      // text is REQUIRED and must be a real string (Opus-5 review): the schema
      // says required:["text"], but a schema is not a boundary here (same
      // reason "5" is refused for utt) — so validate it, or a call with the
      // trio but no text lands a FABRICATED spoken say whose body is the
      // literal "undefined"/"[object Object]".
      if (typeof a.text !== "string" || a.text.length === 0) {
        return { content: [{ type: "text", text: `say refused: \`text\` is required and must be a non-empty string, so nothing was said; you sent ${shown(a.text)}` }], isError: true };
      }
      // "Wants spoken" means the caller is ASSERTING a performance: spoken:true,
      // or a trio partner (utt/t0) present. An explicit spoken:false (or spoken
      // absent) is an ordinary say — degrade to plain chat exactly as the world
      // server does, never an error (Opus-5 review: refusing spoken:false muted
      // a voice leg doing the natural `spoken: leg.isActive`).
      const wantsSpoken = a.spoken === true || a.utt !== undefined || a.t0 !== undefined;
      // TYPE-EXACT, not coerced (adversarial review): Number(null)===0 and
      // Number(true)===1 let a null/boolean utt or a null t0 pass the old
      // guard and forward a FABRICATED value — violating this server's own
      // "malformed refuses, never silently drops" invariant. The schema
      // declares utt:integer>=0 and t0:number; require exactly those raw
      // JSON types. (The world server tolerates numeric strings elsewhere;
      // the authority does not launder them into the protocol.)
      const uttOk = typeof a.utt === "number" && Number.isSafeInteger(a.utt) && a.utt >= 0;
      const t0Ok = a.t0 === undefined || (typeof a.t0 === "number" && Number.isFinite(a.t0));
      const trioOk = a.spoken === true && uttOk && t0Ok;
      if (wantsSpoken && !trioOk) {
        // Machine-legible failure (r6 review): the same {content, isError:true}
        // contract every malformed tool call returns. A prose-only refusal let a
        // schema client that inspects result.isError read this as a successful
        // say — the authority must mark the refusal as an error, not just describe
        // one in text.
        return { content: [{ type: "text", text: `spoken-say refused, so nothing was said: a spoken line needs spoken: true and utt a non-negative integer, and t0, if given, a finite number (you sent spoken ${shown(a.spoken)}, utt ${shown(a.utt)}, t0 ${shown(a.t0)}). Sent as plain text it would lose its performance link. For an ordinary say, send only text.` }], isError: true };
      }
      const extra = trioOk
        ? { spoken: true as const, utt: a.utt, ...(typeof a.t0 === "number" ? { t0: a.t0 } : {}), ...(typeof a.to === "string" && a.to ? { to: a.to } : {}) }
        : (typeof a.to === "string" && a.to ? { to: a.to } : undefined);
      // the authority answers a say: a refused one (the rate limit, a ban) comes back as an error in its own words, not "said"
      const sent = cutSpeech(a.text);
      const r: any = await ag.say(sent, extra);
      // no answer isn't a refusal: it may have landed. Say so, so a retry doesn't say it twice
      if (r && r.ok === false && r.refused?.code === "timeout") return { content: [{ type: "text", text: "say: the world didn't confirm it in time — it may still have landed; look (or catch_up) before saying it again" }], isError: true };
      if (r && r.ok === false) return refusedBy(r, "say");
      return text(sent.length < a.text.length ? `said — only its first ${[...sent].length} characters were sent; say the rest in another call` : "said");

  },
  pose: async (ag, a, ctx, name) => {
      // the presets: clear (the old clear_pose), posture (the old posture tool), wings (fold_wings / unfold_wings)
      if (a.clear === true) {
        if (a.target) { const t0 = Date.now(); ag.puppet(String(a.target), puppetPose(null));
          const no = await presenceRefusal(ag, t0);
          if (no) return { content: [{ type: "text", text: `anim {stop} refused (consent class: pose): ${no}` }], isError: true };
          return text(`asked ${a.target} to release their pose. They decide whether to.`); }
        ag.setPose(null);
        return text("released pose");
      }
      if (a.ragdoll === true) {
        if (a.target) {
          const to = String(a.target); const t0 = Date.now();
          ag.puppet(to, { ragdoll: true });   // undirected: their body goes limp where it stands (a push is act shove)
          const no = await presenceRefusal(ag, t0);
          if (no) return { content: [{ type: "text", text: `anim {ragdoll} refused (consent class: shove): ${no}` }], isError: true };
          return text(`asked ${to} to go limp (the server passed it on; their body has the last word)`);
        }
        ag.knockDown(ag.name, null, "(you go limp)");
        return text("you go limp and fall — walking, or anim {stop: true}, stands you back up");
      }
      if (a.posture != null) {
        const kind = String(a.posture);
        const clip = { sit: "sit", sitchair: "sitchair", lie: "lie", stand: "idle" }[kind];
        if (!clip) return { content: [{ type: "text", text: "pose: posture is sit (on the ground), sitchair (chair height), lie or stand" }], isError: true };
        ag.setPosture(clip);
        return text(kind === "stand" ? "you stand up" : `you ${kind === "lie" ? "lie down" : "sit down"} — walking stands you back up`);
      }
      // a pose by name (R 10-17 15:09): one frame the body holds by name. The one every winged rig knows is wings-folded;
      // a name the body doesn't know leaves it as it is (its default), said, never an error
      if (a.name != null) {
        if (a.bones != null) return { content: [{ type: "text", text: "pose: a name OR bones, not both" }], isError: true };
        const n = String(a.name);
        if (n === WINGS_FOLDED) return act(await ag.foldWings(true));
        return text(`no pose named "${n}" on this body — it holds what it held (its default). Known by name: ${WINGS_FOLDED}. Or pose inline with bones.`);
      }
      if (a.wings != null) {
        const w = String(a.wings);
        if (w !== "fold" && w !== "open") return { content: [{ type: "text", text: `pose: wings is "fold" or "open"` }], isError: true };
        return act(await ag.foldWings(w === "fold"));
      }
      // Validate and SAY what happened. A pose is authored blind — the only
      // other feedback is a snapshot through a GPU host — so a bone name that
      // does not exist, a three-component quaternion, or two names folding
      // onto one bone must come back as words, not as a body that silently
      // did not move. (See shared/humanoid.js.) Checked against the rig of
      // the body being posed: arbitrary bones exist only on the rigs that
      // have them.
      const target = a.target ? String(a.target) : null;
      const avatar = target ? ag.people.get(target)?.avatar : ag.avatar;
      const rig = avatar ? await rigBonesFor(ag.httpBase, avatar) : null;
      if (a.bones == null) {
        if (!rig) return fail(`can't read ${target ? `${target}'s` : "your"} rig to list its bones. Humanoid names always work: ${HUMANOID_BONES.join(", ")}.`);
        const humanoid = Object.entries(rig.humanoidOf).map(([raw, vrm]) => vrm === raw ? vrm : `${vrm} (${raw})`);
        const other = rig.bones.filter((b) => !rig.humanoidOf[b] && !rig.aboveHips.includes(b));
        return text(`${target ? `${target}'s` : "your"} rig — humanoid bones (by VRM name): ${humanoid.join(", ")}.`
          + ` Other bones (by their own name): ${other.length ? other.join(", ") : "none"}.`
          + `${rig.aboveHips.length ? ` Not poseable (above the hips; move hips instead): ${rig.aboveHips.join(", ")}.` : ""}`);
      }
      const v = validatePose(a.bones, { rig });
      const note = poseReport(v);
      const replace = !!a.replace;
      if (!v.accepted.length && !(v.released.length && !replace)) {
        return fail(`no pose set — nothing usable in \`bones\`.${note ? ` ${note}.` : ""}`
          + " Want a sparse map of bone name to [x,y,z,w] or {q, t, s}, e.g."
          + ' {"leftUpperArm": [0, 0, -0.9, 0.44], "hips": {"t": [0, -0.4, 0]}}. anim {joints: {}} lists your rig\'s.');
      }
      const what = `${v.accepted.length} bone(s)${v.custom.length ? ` (${v.custom.length} beyond the humanoid set: ${v.custom.join(", ")})` : ""}`
        + `${v.released.length && !replace ? `, releasing ${v.released.join(", ")}` : ""}`;
      // replace: the named bones ARE the pose (a null means nothing there).
      // Otherwise merge over what is already held — mergePose, the same rule
      // a browser applies when it is posed.
      if (target) {
        const t0 = Date.now();
        ag.puppet(target, puppetPose(v.pose, replace));
        const no = await presenceRefusal(ag, t0);   // consent class pose and range, at the server (F2)
        if (no) return { content: [{ type: "text", text: `anim refused (consent class: pose): ${no}` }], isError: true };
        return text(`asked ${target} to ${replace ? "hold a pose (replacing theirs)" : "pose"} ${what}`
          + `${note ? ` — ${note}` : ""}. They decide whether to take it.`);
      }
      const hold = !!a.hold;
      const next = mergePose(replace ? null : (ag.heldPoseAuthored ? ag.heldPose : null), v.pose);
      ag.setPose(next, hold);
      const held = Object.keys(next ?? {});
      return text(`${replace ? "holding a pose over" : "posed"} ${what}`
        + `${!replace && held.length ? `; now holding ${held.length} bone(s) in all` : ""}${!held.length ? " — nothing is held now" : ""}`
        + `${note ? ` — ${note}` : ""}`
        + `${hold && held.length ? ". It stays through walking — anim {stop: \"live\"} drops it." : ""}`);

  },
  reach: async (ag, a, ctx, name) => {
      if (a.release === true) {   // the old clear_reach
        if (a.limb != null && typeof a.limb !== "string") return fail("reach {release}'s `limb`, when given, is one limb's name, such as rightHand; leave it out to release every reach");
        return act(ag.releaseReach(a.limb ?? null));
      }
      // Two target grammars, checked here so the refusal can TEACH: the
      // named-point form (who/point) and the bare-point form (x,y,z/space).
      const hasName = a.who != null || a.point != null;
      const hasXYZ = typeof a.x === "number" && typeof a.y === "number" && typeof a.z === "number";
      if (!hasName && !hasXYZ) {
        // a point given as strings, or short a coordinate, isn't a target either: say what came
        const sent = [a.x, a.y, a.z].some((v) => v !== undefined) ? `; you sent x ${shown(a.x)}, y ${shown(a.y)}, z ${shown(a.z)}` : "";
        return fail(`reach needs a target, so nothing was reached: point for a contact point on your own body, who and point for one on someone else's, or x, y and z as numbers for a point (space 'world' by default, 'self' for your own frame, or a participant id for theirs)${sent}`);
      }
      let target: Record<string, unknown>;
      if (hasName) {
        if (a.point == null) return fail(`reaching for someone needs point too, the contact point on them, so nothing was reached: reach {who: ${JSON.stringify(String(a.who))}, point: "shoulder_l"}; the points are ${Object.keys(CONTACT_POINTS).join(", ")}`);
        const pt = canonicalPoint(String(a.point));
        if (!pt) return fail(`there's no contact point called ${shown(a.point)}, so nothing was reached; the points are ${Object.keys(CONTACT_POINTS).join(", ")}`);
        target = { who: String(a.who ?? ag.name), point: pt, ...(typeof a.standoff === "number" ? { standoff: a.standoff } : {}) };
      } else {
        target = { p: [a.x, a.y, a.z], ...(typeof a.space === "string" ? { space: a.space } : {}) };
      }
      const r = await ag.reach(typeof a.limb === "string" ? a.limb : undefined, target,
        a.palm === false ? { palm: false } : {});
      return r.ok ? text(r.text) : { content: [{ type: "text", text: r.text }], isError: true };

  },
  animate: async (ag, a, ctx, name) => {
      // a clip by name (R 10-17 15:09): once rides the presence one-shot every receiver already plays; looped holds the clip
      // (it loops until another action replaces it: a walk, a posture, another animation). A name the body doesn't know
      // plays the body's default on every receiver, never an error here.
      const looped = a.looped === true || a.loop === true;
      if (a.name != null) {
        if (a.tracks != null) return { content: [{ type: "text", text: "animate: a name OR tracks, not both" }], isError: true };
        const n = String(a.name);
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(n)) return { content: [{ type: "text", text: `animate: "${n}" isn't a clip name (letters, digits, - and _)` }], isError: true };
        if (a.target) return { content: [{ type: "text", text: "animate {name} plays on your own body; to animate someone else, send tracks (they decide)" }], isError: true };
        if (looped) { ag.setPosture(n); return text(`playing "${n}", looped — until another action (a walk, a posture, another animation)`); }
        ag.playOnce(n); return text(`playing "${n}" once — everyone sees it`);
      }
      // Same contract as `pose`: authored blind, so every correction and
      // every drop comes back as words. Keyframes are sorted by t here, so a
      // track written out of order plays as written rather than as chaos.
      const v = validateTracks(a.tracks);
      const note = poseReport(v);
      if (!v.accepted.length) {
        return fail(`nothing played — no usable tracks.${note ? ` ${note}.` : ""}`
          + ' Want bone -> keyframes, e.g. {"leftUpperArm": [{"t": 0, "q": [0,0,0,1]},'
          + ' {"t": 0.5, "q": [0,0,-0.7,0.7]}]}.');
      }
      const dur = Number(a.dur);
      if (!Number.isFinite(dur) || dur <= 0) return fail(`animate needs dur, the length in seconds and more than 0, so nothing played; you sent ${shown(a.dur)}`);
      const span = tracksSpan(v.tracks);
      const cut = span > dur ? ` — note dur ${dur}s cuts keyframes that run to ${span}s` : "";
      const spec = { dur, loop: looped, tracks: v.tracks, replace: !!a.replace };
      if (a.target) {
        const t0 = Date.now();
        ag.puppet(String(a.target), { anim: spec });
        const no = await presenceRefusal(ag, t0);
        if (no) return { content: [{ type: "text", text: `anim refused (consent class: pose): ${no}` }], isError: true };
        return text(`sent a ${dur}s animation over ${v.accepted.length} bone(s) to ${a.target}`
          + `${note ? ` — ${note}` : ""}${cut}. They decide whether to play it.`);
      }
      ag.animate(spec);
      return text(`playing a ${dur}s animation over ${v.accepted.length} bone(s): ${v.accepted.join(", ")}`
        + `${note ? ` — ${note}` : ""}${cut}`);

  },
  activity: async (ag, a, ctx, name) => {
      const opts: { pulseSec?: number; radiusM?: number } = {};
      if (typeof a.pulse_sec === "number") opts.pulseSec = a.pulse_sec;
      if (typeof a.radius_m === "number") opts.radiusM = a.radius_m;
      const cur = ag.setActivity(opts);
      if (opts.pulseSec != null || opts.radiusM != null) {
        ctx.rememberActivity?.(cur); // what was APPLIED, not what was asked
      }
      // A push-less host cannot receive the stream — saying "delivered on
      // the world channel" to a session with no channels would set an agent
      // waiting forever for pushes that structurally cannot arrive
      // (external integrator find #5b, digi/FC). Tell the truth, and hand
      // over whatever digests accumulated since the last call: the same
      // sense, in the polling model this host lives in anyway.
      if (!ctx.canPush()) {
        const held = ctx.heldActivity.splice(0);
        const status = cur.pulseSec === 0
          ? "your activity sense is OFF (pulse_sec 10–3600 turns it on)"
          : `your activity sense: one digest per ${cur.pulseSec}s while something happens within ${cur.radiusM}m of you`;
        return text(`${status}. Your host has no push channel, so digests cannot arrive on their own — they are HELD (last 8) and handed over each time you call this tool.` +
          (held.length ? `\nheld since your last call:\n${held.join("\n")}` : `\nnothing held since your last call.`));
      }
      return text(cur.pulseSec === 0
        ? `your activity sense is OFF — no ambient digests. Turn it back on with pulse_sec (10–3600s); radius stays ${cur.radiusM}m.`
        : `your activity sense: one digest per ${cur.pulseSec}s while something happens within ${cur.radiusM}m of you — delivered on the world channel tagged "activity" (metadata {activity: true}), never a mention. Wake rules matching that tag give you regular wakes exactly as long as there is life nearby. Settings persist across your sessions.`);

  },
  catch_up: async (ag, a, ctx, name) => {
      const from = typeof a.since === "number" ? a.since : (ctx.cursor.caughtUpTo ?? -1);
      const said = await ag.missedSince(from, Math.min(200, Number(a.limit ?? 60)));
      ctx.cursor.caughtUpTo = ag.lastSeq;
      if (!said.length) return text(`nothing said since seq ${from}. You are up to seq ${ag.lastSeq}.`);
      const lines = said.map((m) => `[${m.seq}] ${m.who}: ${m.text}`);
      return text(`${said.length} message(s) since seq ${from} (now at ${ag.lastSeq}):\n${lines.join("\n")}`);

  },
  create: async (ag, a, ctx, name) => {
      // the authority's create, its args as they are; one default: with nowhere said, 2 m in front of you, on the ground
      // (a light — no model — at eye height, since it has no size for place to solve)
      // #216: an id, when given, is a non-empty string; null/omitted means a minted one. The wire doesn't refuse a bad id —
      // it ESCAPES it (x--…), so "" and {} used to mint junk with no word said.
      if (a.id !== undefined && a.id !== null && (typeof a.id !== "string" || !a.id.trim()))
        return { content: [{ type: "text", text: "create's id, when given, is a placeholder ('$lamp'); omit it (or pass null) and the authority mints one" }], isError: true };
      const args: Record<string, unknown> = { ...a }; if (a.id == null) delete args.id;
      // from (a thing to duplicate) and place's targets name things: by id, label or a unique id prefix
      if (typeof a.from === "string" && !/^sha256:/.test(a.from)) { const t = namedThings(ag, { from: a.from }, ["from"]); if ("err" in t) return t.err; args.from = t.args.from; a = { ...a, from: t.args.from }; }
      if (a.place && typeof a.place === "object" && !Array.isArray(a.place)) { const t = namedThings(ag, a.place as any); if ("err" in t) return t.err; args.place = t.args; }
      const comps = a.components && typeof a.components === "object" ? a.components as any : null;
      const somewhere = a.place != null || a.at != null || comps?.transform != null;
      const ahead = [ag.pos.x + Math.sin(ag.yaw) * 2, ag.pos.z + Math.cos(ag.yaw) * 2];
      const bodiless = a.model == null && comps?.model == null && comps?.mesh == null;   // a light, an empty: nothing for place to size
      if (a.from == null && bodiless && comps?.light && !a.place && !comps?.transform) {
        // the old light tool's default: just in front of you, at about eye height (or exactly at)
        const pt = Array.isArray(a.at) ? a.at.map(Number) : null;
        if (pt && ((pt.length !== 2 && pt.length !== 3) || !pt.every(Number.isFinite))) return { content: [{ type: "text", text: "create: at is a point [x, z] or [x, y, z], or {pos: [x, y, z], yaw}" }], isError: true };
        const x = pt ? pt[0] : ahead[0], z = pt ? (pt.length === 3 ? pt[2] : pt[1]) : ahead[1];
        const y = pt && pt.length === 3 ? pt[1] : ag.heightAt(x, z) + 1.6;
        args.components = { ...comps, light: { color: 0xffd9a0, intensity: 16, range: 10, ...comps.light }, transform: { pos: [x, y, z] } };
        // at's object form ({pos, yaw}) goes on to the authority, which lays it over this transform and checks its shape
        // (it was read only as an array, then deleted, and the light went ahead of you at eye height)
        if (pt) delete args.at;
      } else if (a.from == null && Array.isArray(a.at)) {
        // at without from: a point. On the ground ([x, z]) it is place {at} — the authority seats a model's bottom; a
        // bodiless thing, or an exact [x, y, z], goes straight into its transform
        const pt = a.at.map(Number);
        if ((pt.length !== 2 && pt.length !== 3) || !pt.every(Number.isFinite)) return { content: [{ type: "text", text: "create: at is a point [x, z] or [x, y, z] (or, with from, the authority's {pos, yaw})" }], isError: true };
        delete args.at;
        // at sets the position only: a rotation or scale given in components.transform stays
        if (pt.length === 3 || bodiless) args.components = { ...(comps ?? {}), transform: { ...(comps?.transform ?? {}), pos: pt.length === 3 ? pt : [pt[0], ag.heightAt(pt[0], pt[1]), pt[1]] } };
        else args.place = { ...(a.place && typeof a.place === "object" ? a.place : {}), at: pt };
      } else if (!somewhere && a.from == null) {
        if (bodiless) args.components = { ...(comps ?? {}), transform: { pos: [ahead[0], ag.heightAt(ahead[0], ahead[1]), ahead[1]] } };
        else args.place = { at: ahead };
      } else if (a.from != null) {
        // a blueprint by a unique PREFIX of its hash (the old blueprint_place's courtesy)
        if (/^sha256:/.test(String(a.from))) { const want = String(a.from).slice(7).toLowerCase(); const lib = ag.worldBlueprints();
          const hits = Object.keys(lib).filter((h) => h.startsWith(want));
          if (!hits.length) return { content: [{ type: "text", text: `create: no blueprint here whose hash starts "${want}" (the blueprints tool lists them)` }], isError: true };
          if (hits.length > 1) return { content: [{ type: "text", text: `create: "${want}" matches ${hits.length} blueprints — give more of the hash` }], isError: true };
          args.from = `sha256:${hits[0]}`; }
        // create {from}'s `at` is the authority's {pos, yaw|q} (verbspec create.at). The tool also takes a point, [x, z] or
        // [x, y, z] (audit 10-07: it sent [x, z] and every duplicate was refused `shape`). A duplicate stays a sibling of its
        // source, so its point is in the source's parent's frame when it has one; [x, z] keeps the source's height. With no
        // at, a duplicate goes where the authority puts it (beside its source), a blueprint copy 2 m in front of you.
        const blueprint = String(a.from).startsWith("sha256:");
        const src: any = blueprint ? null : ag.foldRecord(String(a.from));
        const pt = Array.isArray(a.at) ? a.at.map(Number) : null;
        if (pt) {
          if ((pt.length !== 2 && pt.length !== 3) || !pt.every(Number.isFinite)) return { content: [{ type: "text", text: "create: with from, at is a point [x, z] or [x, y, z] (or the authority's {pos: [x, y, z], yaw})" }], isError: true };
          const y = pt.length === 3 ? pt[1] : Number.isFinite(src?.pos?.[1]) ? Number(src.pos[1]) : ag.heightAt(pt[0], pt[1]);   // a fold record's pos is its LOCAL transform (shared/protocol/view.js)
          args.at = { pos: pt.length === 3 ? pt : [pt[0], y, pt[1]] };
        } else if (a.at == null && blueprint) args.at = { pos: [ahead[0], ag.heightAt(ahead[0], ahead[1]), ahead[1]], q: [0, Math.sin(ag.yaw / 2), 0, Math.cos(ag.yaw / 2)] };   // facing the way you face
      }
      const r: any = await ag.request("create", args);
      if (!r?.ok) return refusedBy(r, "create");
      const made = (r.notes ?? []).find((n: any) => n?.copied)?.as ?? r.refs?.[0]?.id ?? (r.would ?? []).find((o: any) => o?.verb === "create")?.id ?? Object.keys(r.after ?? {})[0];
      const id = (typeof a.id === "string" ? r.ids?.[a.id] : null) ?? made ?? "?";
      const pos = r.after?.[id]?.transform?.pos;
      // its handle (the short id look prints: tools take it, or its label), and its full id once (R 10-17)
      return text(`${a.dry ? "would create" : "created"} [${a.dry ? id : ag.handle(id)}]${a.model ? ` ${modelWord(a.model)}` : ""}${Array.isArray(pos) ? ` at (${pos.map((v: number) => (+v).toFixed(2)).join(", ")})` : ""} — id ${id}${r.notes?.length ? `\nnotes: ${JSON.stringify(r.notes).slice(0, 600)}` : ""}`);

  },
  place: async (ag, a, ctx, name) => {
      // the authority's place, its args as they are: it solves where the thing goes and says so (things named by id, label or prefix)
      const t = namedThings(ag, a); if ("err" in t) return t.err; a = t.args;
      const r: any = await ag.request("place", { ...a });
      if (!r?.ok) return refusedBy(r, "place");
      const where = r.notes?.find((n: any) => n.placed)?.placed;
      return text(`${a.dry ? "would place" : "placed"} ${a.id}${where ? `: ${JSON.stringify(where).slice(0, 400)}` : ""}${r.notes?.length ? `\nnotes: ${JSON.stringify(r.notes.filter((n: any) => !n.placed)).slice(0, 600)}` : ""}`);

  },
  act: async (ag, a, ctx) => {
      const verb = String(a.verb ?? ""), args = (a.args && typeof a.args === "object" ? a.args : {}) as Record<string, any>;
      if (Object.hasOwn(BODY_VERBS, verb)) return BODY_VERBS[verb](ag, args, ctx, verb);   // answered by this body, or moderation by name
      if (typeof args.who === "string") { const rw = await resolveWho(ag, args.who, verb); if ("err" in rw) return rw.err; args.who = rw.who; }   // warn/mute/…: a name works here too
      // a thing by id, label or prefix. No authority verb takes a thing in to or target: move's to is a point, say's and
      // body's name a person, update's is a blueprint's hash (verbspec.js), so a person who shares a thing's label is
      // still the one addressed
      const named = namedThings(ag, args, THING_KEYS.filter((k) => k !== "to" && k !== "target")); if ("err" in named) return named.err;
      const r = await ag.request(verb, named.args);
      const reply = r ?? { ok: false };
      return { content: [{ type: "text", text: JSON.stringify(reply, null, 1) }], ...(reply.ok ? {} : { isError: true }) };
  },
  travel: async (ag, a, ctx, name) => {
      // Travel is SESSION machinery — channel epochs, join gates, the
      // fatal-join teardown — so the shared table hands it to the host
      // through the ctx hook. A server with no hook (stdio fronts exactly one
      // WORLD_URL) does not list the tool; answering anyway teaches.
      if (!ctx.travel) return { content: [{ type: "text", text: "travel isn't available on this server: it fronts a single world, so you stayed where you are; its operator chooses that world (WORLD_NAME)" }], isError: true };
      return await ctx.travel(String(a.world ?? "").trim());

  },
  worlds: async (ag, a, ctx, name) => {
      // Discovery only — this reads the sequencer's /worlds and never moves
      // the body. The policy column is the authority's own joinAllowed, asked
      // here so an agent learns "may I?" from the map rather than from a
      // refused travel.
      let r: Response;
      // AS THIS IDENTITY (readHeaders): the map is per caller — a world that admits only people listed is invisible to
      // everyone it doesn't list, so an anonymous ask would hide the private worlds this agent belongs to
      try { r = await fetch(`${ag.httpBase}/worlds`, { signal: AbortSignal.timeout(4_000), headers: ag.readHeaders }); }
      catch (e) { return { content: [{ type: "text", text: `worlds: the world server didn't answer (${(e as Error).message}), so the list isn't known; try again in a moment` }], isError: true }; }
      if (!r.ok) return { content: [{ type: "text", text: `worlds: the world server answered ${r.status}, so the list isn't known; try again in a moment` }], isError: true };
      const body = (await r.json()) as { worlds?: { name: string; loaded?: boolean; access?: string; you?: string; people?: ({ id: string; declares?: string } | string)[] }[] };
      const list = Array.isArray(body.worlds) ? body.worlds : [];
      if (!list.some((w) => w.name === ag.world)) list.push({ name: ag.world, loaded: true, people: [] });
      list.sort((x, y) => (x.name === ag.world ? -1 : y.name === ag.world ? 1 : x.name.localeCompare(y.name)));
      const pol = ctx.worldPolicy;
      const lines = list.map((w) => {
        const here = w.name === ag.world;
        const who = (w.people ?? []).map((p) => (typeof p === "string" ? p : p.declares ? `${p.id} (${p.declares})` : p.id));   // one list; a declared word, if any, as a tag
        const occupancy = who.length ? who.join(", ") : (w.loaded ? "empty" : "empty, not loaded");
        const door = w.access === "invite-only" ? "invite-only" : w.access === "watch" ? "watch only" : "";
        const may = here ? "you are here"
          : pol && !pol.canJoin(w.name) ? "outside the worlds your credential is limited to"
            : w.you === "watch" ? "you may watch, not travel in"
              : pol ? "may travel" : "";
        return `- ${w.name}${here ? " ←" : ""}${door ? ` (${door})` : ""}: ${occupancy}${may ? ` — ${may}` : ""}`;
      });
      const foot = pol
        ? "`travel` goes to worlds that exist: joining never founds one here (a signed-in person founds a world with world-found; an operator founds one for an agent)."
        : ctx.travel ? "" : "This server fronts a single world; there is no travel from here.";
      return text(`Worlds on this server (${list.length}):\n${lines.join("\n")}${foot ? `\n${foot}` : ""}`);
  },
  measure: async (ag, a, ctx, name) => {
      { const t = namedThings(ag, a, ["id"]); if ("err" in t) return t.err; a = t.args; }
      if (a.check === true) return CHECK_MODEL(ag, a);
      // 🔴 USE THE AGENT'S OWN httpBase (2026-08-16). This re-derived the HTTP
      // base by string surgery on WORLD_URL — the exact form agent.ts:297
      // replaced with real URL parsing, for a reason its comment records: a
      // WORLD_URL carrying a query string (…/ws?token=…) defeats the `/\/ws$/`
      // replace and produces a malformed URL (reported by digi/FC). The bug was
      // fixed in one place and left standing in the other, which is what a
      // duplicated derivation always eventually does.
      //
      // It also ignored the authority's actual connection: WORLD_URL is the boot
      // env, but `connect()` re-reads its target on every dial, so after a
      // travel this could point at the world we LEFT and measure a different
      // world's geometry than the one the agent is standing in.
      const base = ag.httpBase;
      const q = a.id
        ? `world=${encodeURIComponent(ag.world)}&id=${encodeURIComponent(String(a.id))}`
        : a.lib ? `lib=${encodeURIComponent(String(a.lib))}` : null;
      if (!q) return fail("measure wants {id} (a placed thing) or {lib} (a library model)");
      // What the world server did, as far as the door can see it: no answer,
      // an answer that isn't geometry, or its own error.
      // as this identity (readHeaders): a members-only world's geometry answers only its members. One request
      let d: any;
      let status = 0;
      try { const r = await fetch(`${base}/geom?${q}`, { headers: ag.readHeaders }); status = r.status;
        // who this body is, which calling again doesn't change: say who can
        if (r.status === 401 || r.status === 403) return fail(`measure: nothing was measured; this world shows its state only to the people it lets in, and it didn't take this body's read key (${r.status}). Calling again won't change that: the world's owners decide who comes in, and the host's operator issues this body's key`);
        try { d = await r.json(); } catch { return fail(`measure: the world server answered ${r.status} with something that isn't geometry, so nothing was measured`); } }
      catch (e) { return fail(`measure: the world server didn't answer (${String((e as Error)?.message ?? e)}), so nothing was measured; try again in a moment`); }
      if (d.error) return fail(`measure: the world server answered ${status} (${d.error}), so nothing was measured`);
      const g = d.geometry ?? d;
      if (!g?.bbox) return fail("no geometry available for that (parsing offline, or a light)");
      const L: string[] = [];
      const s = g.bbox.size;
      // /geom?lib= answers with no model, so a library model is named by the path asked for
      L.push(`${a.id ? `[${ag.refName(String(d.id))}] ${d.model ?? ""}` : d.model ?? a.lib} — ${s[0]}×${s[1]}×${s[2]}m, ${g.tris} tris${g.sampled ? " (sampled)" : ""}`);
      if (a.id) L.push(`placed at (${d.pos.map((n: number) => n.toFixed(2)).join(", ")}) yaw ${d.yaw.toFixed(2)}${d.scale !== 1 ? ` scale ${d.scale}` : ""}${d.parent ? ` — mounted on ${d.parent.to}` : ""}`);
      if (g.topSurfaces?.length) {
        L.push(`flat zones (local frame, biggest first) — a center is a socket pos verbatim:`);
        for (const f of g.topSurfaces.slice(0, 5)) {
          const cx = +((f.x[0] + f.x[1]) / 2).toFixed(2), cz = +((f.z[0] + f.z[1]) / 2).toFixed(2);
          L.push(`  y=${f.y}  ${(f.x[1] - f.x[0]).toFixed(2)}×${(f.z[1] - f.z[0]).toFixed(2)}m  area ${f.area}m²  → pos [${cx}, ${f.y}, ${cz}]`);
        }
      } else L.push("no up-facing flat zones found (nothing seat-like)");
      if (g.nodes?.length) L.push(`named parts: ${g.nodes.slice(0, 12).map((n: any) => `${n.name} @[${n.center.join(",")}]`).join(" · ")}`);
      if (g.orphans?.length) L.push(`⚠ orphan nodes in the FILE, rendered by NOBODY (broken export — do not target): ${g.orphans.join(", ")}`);
      if (a.id && Object.keys(recordComponents(d)).length) L.push(`components already on it: ${Object.keys(recordComponents(d)).join(", ")}`);
      return text(L.join("\n"));

  },
  inspect: async (ag, a) => {
      { const t = namedThings(ag, a, ["id"]); if ("err" in t) return t.err; a = t.args; }
      const id = String(a.id ?? "");
      if (id === WORLD_ID) {
        // the world entity (design §3): the fold's sky / terrain / grass read as one
        // entity's components — the same declaration the browser's World cards render
        const schema = worldSchema(ag.worldFold(), { now: Date.now() });
        if (a.json) return text(JSON.stringify(schema));
        return text(`[${WORLD_ID}] the world entity — ${describeWorld(ag.worldFold(), Date.now())}`
          + `\ncomponents: ${schema.sections.list.map((c: any) => `${c.title}${c.present ? "" : " (default)"}`).join(", ")} — an alias of the world's sky, terrain and grass: edits go out as one request setting @world's sky / terrain / grass (owner rank)`
          + `\n${describeSchema(schema, { verbsHint: false })}`
          + `\nedit {id: "${WORLD_ID}", set: {"sky.hours": 17.5, "sky.clouds": "cirrus", "weather.state": "rain", "terrain.amplitude": "+=1", "grass.density": 1.4, "grass.mow": true}} — relative math works on every number.`);
      }
      // the FOLDED record, not the perception view (which thins a light to
      // its position): the schema wants every field the fold keeps
      const rec = ag.foldRecord(id) as any;
      // a call that did nothing answers failed (as #269 has it)
      if (!rec) return fail(`inspect: no placed thing "${id}" here (ids are in look() and hierarchy)`);
      const world = foldWorld(ag);
      const schema = inspectSchema(rec, id, { world, box: rec.model ? await ag.modelBox(String(rec.model)) : null });
      if (a.json) return text(JSON.stringify(schema));
      const kids = childrenOf(world, id);
      const head = `[${ag.handle(id)}] ${kindOf(rec) === "model" ? modelWord(rec.model) : kindOf(rec)}${rec?.label ? ` "${rec.label}"` : ""} — id ${id} (minted, never renamed: its label is its name)`
        + `\nparent: ${rec.parent ? `${ag.socketName(rec.parent.to)} — its Transform below is LOCAL to ${rec.parent.to}` : "none (a root: its Transform is the world's)"}`
        + `\nchildren: ${kids.length ? kids.join(", ") : "none"}`
        // a copy's parts carry copy-of {from: sha256:<hash>, key} (blueprints.js), not a hash field
        + (() => { const h = String((rec as any)?.["copy-of"]?.from ?? "").replace(/^sha256:/, ""); if (!h) return ""; const b = ag.worldBlueprints()[h]; return `\nblueprint: a copy of \"${b?.name ?? "?"}\" (${h.slice(0, 12)})`; })();
      // where each component's value came from (the authority's touched; the Inspector's card tooltips say the same words)
      let prov = "";
      { const r = await ag.request("inspect", { id }).catch(() => null);
        const t = r?.ok ? Object.entries(r.touched ?? {}) as [string, any][] : [];
        if (t.length) prov = `\nlast changed: ${t.map(([c, v]) => `${c} ${touchWords(v)}`).join("; ")}\n(older: act {verb: "history", args: {id: "${id}"}})`; }
      return text(`${head}\n${describeSchema(schema)}${prov}`);
  },
  edit: async (ag, a) => {
      { const t = namedThings(ag, a, ["id"]); if ("err" in t) return t.err; a = t.args; }
      const id = String(a.id ?? "");
      const rec = id === WORLD_ID ? null : ag.foldRecord(id) as any;
      if (!rec && id !== WORLD_ID) return fail(`edit: no placed thing "${id}" here, so nothing was sent (ids are in look() and hierarchy)`);
      // what the plan reads, taken before it awaits the model's box: the write is pinned to it (expect, §3a), so a change
      // that lands meanwhile is refused as changed, not overwritten (a person's edit pins the same way)
      const wireId = id === WORLD_ID ? id : encId(id);   // the authority's own id, as the ops carry it (requests.js)
      const base = ag.componentsOf(wireId);
      // a host's sockets are its socket children: a write of the sockets map changes the children it names and retires the
      // rest (authority/sockets.js liftOps), so the plan's read of them is pinned too
      const sockets = id === WORLD_ID ? {} : ag.socketChildrenOf(wireId);
      const { ops, errors, asks } = id === WORLD_ID
        ? { ...worldEditOps(ag.worldFold(), (a.set ?? {}) as Record<string, unknown>, { now: Date.now() }), asks: undefined }
        : editOps(rec, id, (a.set ?? {}) as Record<string, unknown>, { world: foldWorld(ag), box: rec.model ? await ag.modelBox(String(rec.model)) : null });   // pivot.centre / pivot.base snap to it, as a person's do
      const L: string[] = [];
      for (const e of errors) L.push(`refused: ${e}`);
      // needs (design §3): a choice to make or a remove-both to confirm sends nothing and says how to answer
      for (const q of (asks ?? []) as any[]) if (q.kind === 'confirm' || q.options.length) L.push(q.kind === 'choice'
        ? `asks: ${q.prompt} — answer with ${q.options.map((o: any) => `"${q.key}": "${o.v}" (${o.label})`).join(' or ')}`
        : `asks: ${q.prompt} — answer with "${q.key}": "both"`);
      if (!ops.length) return { content: [{ type: "text", text: L.length ? L.join("\n") : "edit: nothing to change" }], isError: errors.length > 0 };
      // ONE request for the whole edit (a batch when it took several ops): one act, one undo — what a person's edit sends
      const req: any = OP.batch(ops);
      // every component an op sets or unsets is pinned to the value the plan read: an unset planned from a read (an openable's
      // reactions taken away) erases whatever landed since as surely as a set does
      const touched = [...new Set(ops.filter((o: any) => (o.verb === "set" || o.verb === "delete") && o.args?.id === wireId && o.args?.component != null)
        .map((o: any) => String(o.args.component)))];
      const writesSockets = touched.includes("sockets");
      if (writesSockets) {
        // a socket child added or taken away while the plan awaited the model's box: the map would retire one it never read,
        // and no pin can name a child the plan didn't see, so nothing is sent
        const now = Object.keys(ag.socketChildrenOf(wireId)).sort().join("\n");
        if (now !== Object.keys(sockets).sort().join("\n"))
          return fail(`edit: ${id}'s sockets changed while the edit was being prepared (a socket was added or taken away), so nothing was sent: look again and redo it`);
      }
      const pins = [
        ...pinsOf(wireId, touched, base),
        // each socket child the map was planned from, as liftOps reads and writes it: its parent (which host's child it is),
        // its socket, its transform and its station
        ...(writesSockets ? Object.entries(sockets).flatMap(([kid, c]) => pinsOf(kid, ["parent", "socket", "transform", "station"], c)) : []),
      ];
      if (pins.length > EXPECT_MAX)
        return fail(`edit: ${id} has more sockets than one edit can pin (${pins.length} pins; a request carries at most ${EXPECT_MAX}), so nothing was sent: edit its socket children one at a time (each is a thing of its own)`);
      const r: any = await ag.sendOps(ops, { ...(a.dry ? { dry: true } : {}), ...(a.throughLock ? { throughLock: true } : {}), ...(pins.length ? { expect: pins } : {}) });
      L.push(`${a.dry ? "would send" : "sent"} ${req.verb} ${JSON.stringify(req.args)}`);
      if (r && !r.ok) L.push(refusalText("edit", r));   // the words a person sees (shared/protocol/refusal.js)
      else if (r) {
        // the authority's own words on what it did (agent lab round 2, Hazel): its notes, warnings, and an undo's account
        for (const w of (r.warnings ?? []) as any[]) L.push(`  warning: ${warningText(w)}`);
        for (const nt of (r.notes ?? []) as any[]) if (!nt.placed) L.push(`  note: ${nt.why ?? JSON.stringify(nt)}`);
        if (!a.dry) L.push(`the authority accepted it${r.act != null ? ` (act ${r.act}; undo {act: ${r.act}} takes it back)` : ""}`);
      }
      return { content: [{ type: "text", text: L.join("\n") }], ...(r && !r.ok ? { isError: true } : {}) };
  },
  hierarchy: async (ag, a) => {
      const q = String(a.filter ?? "").trim().toLowerCase();
      const ents = [...ag.entities.values()] as any[];
      const kids = new Map<string, string[]>(); const roots: string[] = [];
      for (const e of ents) { const p = ag.mounts.get(e.id)?.to; if (p && ag.entities.has(p)) { (kids.get(p) ?? kids.set(p, []).get(p)!).push(e.id); } else roots.push(e.id); }
      const occupants = new Map<string, string[]>();
      for (const [who, m] of ag.mounts) if (!ag.entities.has(who)) (occupants.get(m.to) ?? occupants.set(m.to, []).get(m.to)!).push(who);   // under the socket they sit in
      const line = (e: any) => {
        const c = recordComponents(e);
        const comps = Object.keys(c).filter((k) => k !== "lock" && k !== "label").map((k) => (k === "motion" || k.startsWith("motion:")) ? `${k}(${c[k]?.type ?? "…"})` : k === "socket" ? `socket(${c.socket?.name ?? ""}: ${socketRole(c)})` : k);
        return `[${ag.handle(e.id)}]${c.label ? ` "${c.label}"` : ""} ${e.kind === "model" ? modelWord(e.model) : e.kind}${comps.length ? ` · ${comps.join(" · ")}` : ""}${c.lock ? " · 🔒" : ""}${c.hidden ? " · hidden" : ""}`;
      };
      const hit = (e: any) => !q || [e.id, e.model, e.model ? modelWord(e.model) : "", e?.label ?? "", ...Object.keys(recordComponents(e))].join(" ").toLowerCase().includes(q);
      const L: string[] = [];
      const walk = (id: string, depth: number): boolean => {
        const e = ag.entities.get(id) as any; if (!e) return false;
        const subs: string[] = [];
        let any = hit(e);
        for (const r of occupants.get(id) ?? []) if (!q || r.toLowerCase().includes(q)) { subs.push(`${"  ".repeat(depth + 1)}└ 🧍 ${r}`); any = true; }
        const before = L.length;
        for (const k of kids.get(id) ?? []) if (walk(k, depth + 1)) any = true;
        const childLines = L.splice(before);
        if (any) L.push(`${"  ".repeat(depth)}${depth ? "└ " : ""}${line(e)}`, ...subs, ...childLines);
        return any;
      };
      for (const r of roots.sort()) walk(r, 0);
      // pinned, as in the browser's Hierarchy: the world entity, never filtered out
      L.unshift(`[${WORLD_ID}] World — ${describeWorld(ag.worldFold(), Date.now())} (inspect @world for its sky, weather, ground, grass)`);
      if (L.length === 1) L.push(q ? `(no placed thing matches "${q}")` : "(nothing placed yet)");
      L.push(`(${ents.length} things${q ? `, filtered` : ""} · inspect {id} for fields · edit {id, set} to change them)`);
      return text(L.join("\n"));
  },
  blueprints: async (ag, a) => {
      // the world's blueprints: @world blueprints:<hash> → {name, parts}, written by the authority's publish; a placed copy
      // carries a `copy-of` component naming the hash it came from
      const lib = ag.worldBlueprints();
      const copies: Record<string, string[]> = {};
      // the authority stamps every part of a copy copy-of {from: sha256:<hash>, key}; the copy itself is the part whose parent
      // isn't a part of the same copy
      const W = foldWorld(ag) as Record<string, any>;
      for (const [id, e] of Object.entries(W)) { const f = e?.["copy-of"]?.from; if (typeof f !== "string") continue;
        const up = e.parent?.to ? W[e.parent.to] : null; if (up?.["copy-of"]?.from === f) continue;
        (copies[f.replace(/^sha256:/, "")] ??= []).push(id); }
      const hashes = Object.keys(lib);
      const want = String(a.hash ?? "").trim().toLowerCase();
      const pick = want ? hashes.filter((h) => h.startsWith(want)) : hashes;
      if (want && pick.length !== 1) return fail(pick.length ? `blueprints: "${want}" matches ${pick.length} (${pick.map((h) => h.slice(0, 12)).join(", ")}) — give more of the hash` : `blueprints: none here starts "${want}"`);
      if (!hashes.length) return text("This world has no blueprints yet. Publish one: act {verb: \"publish\", args: {from: <thing id>, name}} — the thing and everything under it, as one record.");
      return text(pick.map((h) => { const c = copies[h] ?? [];
        return `[${h.slice(0, 12)}] "${lib[h]?.name ?? "?"}" · ${(lib[h] as any)?.parts ?? "?"} part(s)${c.length ? ` · ${c.length} cop${c.length === 1 ? "y" : "ies"}: ${c.slice(0, 8).join(", ")}${c.length > 8 ? ", …" : ""}` : " · no copies placed"}`; }).join("\n")
        + `\n(create {from: "sha256:<hash>", at?} places a copy; act {verb: "publish", args: {from, name}} saves a new one)`);
  },

  world_history: async (ag, a, ctx, name) => {
      // the world's log is read through the authority (its history request: verbs, before and after reach it)
      if (typeof a.before === "number" && typeof a.after === "number") return fail("world_history pages one way: before or after, not both, so nothing was read");
      const h = await ag.request("history", { limit: Math.min(200, Math.max(1, Number(a.limit ?? 30))),
        ...(Array.isArray(a.verbs) && a.verbs.length ? { verbs: a.verbs.map(String) } : {}),
        ...(typeof a.before === "number" ? { before: Math.floor(a.before) } : {}), ...(typeof a.after === "number" ? { after: Math.floor(a.after) } : {}) });
      if (!h?.ok) return refusedBy(h, "world_history");
      const rows = (h.entries ?? []).filter((e: any) => e.kind === "act" || e.kind === "say");
      const more = h.next != null ? `\n… more ${typeof a.after === "number" ? `after #${h.next} (page with after)` : `before #${h.next} (page with before)`}` : "";
      // a page can hold only change entries (an act's results), which this view leaves out: say so, and where to go on
      if (!rows.length) return text(`${Array.isArray(a.verbs) && a.verbs.length ? `no acts or says with ${a.verbs.join(" / ")}` : "no acts or says"} in this page of the log${more || " — and nothing further that way"}`);
      return text(rows.map(historyLine).join("\n") + more
        + "\n(the world log: acts and says; act {verb: 'history', args: {id}} reads one thing's own acts)");
  },
  world_debug: async (ag, a, ctx, name) => {
      const r = await ag.worldDebug({
        limit: Math.min(300, Math.max(1, Number(a.limit ?? 30))),
        kinds: Array.isArray(a.kinds) && a.kinds.length ? a.kinds.map(String) : undefined,
        ...(a.script != null ? { script: String(a.script) } : {}),
        ...(a.scripts ? { scripts: true } : {}),
      } as any);
      const status = (r as any).status ? `status: ${(r as any).status}\n` : "";
      if (!r.events.length) return text(status || "flight recorder is empty — nothing has bounced recently");
      const lines = r.events.map((e: any) => {
        const { ts, kind, line, ...rest } = e;
        const when = ts ? new Date(ts).toISOString() + " " : "";
        return `${when}[${kind}] ${line ?? JSON.stringify(rest)}`;
      });
      return text(status + lines.join("\n"));

  },
  whois: async (ag, a, ctx, name) => {
      const q = String(a.name ?? "").trim();
      if (!q) return fail('whois needs a name, so nothing was looked up: whois {name: "<a name>"}');
      const w: any = await ag.request("whois", { name: q });
      if (!w?.ok) return refusedBy(w, "whois");
      if (!w.people?.length) return text(w.note ?? `nobody called "${q}" here`);
      return text(w.people.map((p: any) => `${p.name} — ${p.id}: ${typeof p.declares === "string" ? `declares ${p.declares}, ` : ""}${p.guest ? "a guest, " : p.imported ? "an imported name, " : ""}${p.role} here${p.here ? ", here now" : ", not here"}${p.banned ? ", BANNED" : ""}`).join("\n"));
  },
};


// ---------------- anim (R 10-17 15:31/15:32): ONE tool for a pose or a clip, by name or live ----------------
// The old pose / animate handlers are its live and by-name halves now (LEGACY below): they keep their words, and the old
// tool names answer as hidden aliases of anim for one release (TOOL_ALIASES).
const LEGACY: Record<string, ToolHandler> = { pose: HANDLERS.pose, animate: HANDLERS.animate };
delete HANDLERS.pose; delete HANDLERS.animate;
/** Each built-in anim's own mode (R 15:32): what plays when the call says none. A one-frame pose holds. A name not
 *  here plays once (the body plays its default for a name it doesn't know). When anim-clip has a shape, its mode is a
 *  field of it. */
export const ANIM_MODES: Record<string, "once" | "loop" | "hold"> = {
  wave: "once", cheer: "once", clap: "once", point: "once", salute: "once", flail: "once", talk: "once",
  dance: "loop", sit: "loop", sitchair: "loop", lie: "loop", stand: "loop", [WINGS_FOLDED]: "hold",
};
const ANIM_POSES = new Set([WINGS_FOLDED]);
const CLIP_READERS = new Map<string, PoseClips>();
/** A clip's length in seconds, when this host can read it (the posture clips' VRMA); else null. */
async function clipLength(base: string, clip: string): Promise<number | null> {
  try { let r = CLIP_READERS.get(base); if (!r) CLIP_READERS.set(base, (r = new PoseClips(base))); const a: any = await r.load(clip);
    const d = Number(a?.duration ?? a?.clip?.duration); return Number.isFinite(d) && d > 0 ? d : null; } catch { return null; }
}
const ANIM_CLIP: Record<string, string> = { stand: "idle" };   // the presence clip a built-in name holds as
/** The body-mode a built-in anim asks for while it plays (R 15:34; an anim-clip's data may carry bodyMode once it has a shape). */
const ANIM_BODY: Record<string, "stand" | "sit" | "lie"> = { sit: "sit", sitchair: "sit", lie: "lie", stand: "stand" };
/** Where a name resolves (R 15:34): the avatar's own anim, then the world's, then the built-in ones. Neither of the first two
 *  exists yet (anim-pose / anim-clip are reserved; avatars carry no anim list): every name is built in today. */
function animFrom(_ag: any, _name: string): "avatar" | "world" | "builtin" { return "builtin"; }
const MODES = ["once", "loop", "hold"];
const playing = (name: string, mode: string, extra = "", from?: string) => text(`${JSON.stringify({ playing: name, mode, ...(from ? { from } : {}) })}${extra ? ` — ${extra}` : ""}`);
/** The frame of live tracks at `at` seconds (default the last key): each bone's last key at or before it. */
function frameOf(tracks: Record<string, { t: number; q: number[] }[]>, at: number | null) {
  const out: Record<string, number[]> = {};
  for (const [bone, keys] of Object.entries(tracks)) { const ks = [...keys].sort((x, y) => x.t - y.t); const pick = at == null ? ks.at(-1) : ks.filter((k) => k.t <= at).at(-1) ?? ks[0]; if (pick) out[bone] = pick.q; }
  return out;
}
HANDLERS.anim = async (ag, a, ctx, name) => {
  const mode0 = a.mode == null ? null : String(a.mode);
  if (mode0 != null && !MODES.includes(mode0)) return { content: [{ type: "text", text: `anim: mode is once, loop or hold (got ${JSON.stringify(a.mode)})` }], isError: true };
  const at = a.at == null ? null : Number(a.at);
  if (at != null && !(Number.isFinite(at) && at >= 0)) return { content: [{ type: "text", text: "anim: at is seconds into the anim (0 or more)" }], isError: true };
  // a body-mode declaration (R 15:45): any of the six, for looks; it holds until the mover's next real transition or the
  // next declaration, and grants nothing. Alone, or beside a name (the anim then plays in that mode)
  if (a.bodyMode != null) { if (!isBodyMode(a.bodyMode)) return { content: [{ type: "text", text: `anim: bodyMode is ${BODY_MODES.join(" | ")} (got ${JSON.stringify(a.bodyMode)})` }], isError: true };
    if (a.target) return { content: [{ type: "text", text: "anim {bodyMode} declares your own body's mode" }], isError: true };
    ag.bodyMode = String(a.bodyMode);
    // alone, it rests the body in the new mode's own anim (declaring stand stands you up, R 16:26), unless a clip anim plays
    // or a walk is under way (the walk's clip is the mover's)
    if (a.name == null && a.joints == null && a.tracks == null && (a.stop == null || a.stop === false) && a.ragdoll !== true && !ag.target && ag.clip !== "ragdoll" && !ag.anims.some((x: any) => x.kind === "clip")) { const rest = ag.restClip(ag.bodyModeNow()); if (rest) ag.clip = rest; }
    // on a seat (review r11 L1): body-mode grants nothing, so a declaration never moves you off it; the reply says how
    const seated = ag.myOccupancy ? `; you're still attached to ${ag.socketName?.(ag.myOccupancy.to) ?? "your seat"}, and rest in its anim — detach to get off` : "";
    // with stop or ragdoll beside it, that runs too, in the mode just declared (the declaration returned first)
    if (a.name == null && a.joints == null && a.tracks == null && (a.stop == null || a.stop === false) && a.ragdoll !== true) return text(`${JSON.stringify({ bodyMode: String(a.bodyMode) })} — declared, for looks: it holds until a real transition (water, a take-off, a fall, a landing) or your next declaration, and grants nothing${seated}`); }
  const forms = ["name", "joints", "tracks", "stop", "ragdoll"].filter((k) => a[k] != null && a[k] !== false);
  if (a.name != null && (a.joints != null || a.tracks != null)) return { content: [{ type: "text", text: "anim: a name OR live keys (joints, or tracks), not both — a named anim plays as it is; nothing was guessed and nothing played" }], isError: true };
  if (forms.length > 1) return { content: [{ type: "text", text: `anim: one of name, joints, tracks, stop or ragdoll at a time (got ${forms.join(", ")})` }], isError: true };
  // stop (R 10-17 16:26/16:27): true stops every anim this body plays or holds, each layer, and rests in the CURRENT
  // body-mode's own anim (never the bind pose; the body-mode is unchanged); a name stops only that layer ("live": every
  // ad-libbed one). With target: their held pose
  if (a.stop != null && a.stop !== false) {
    if (a.target) return LEGACY.pose(ag, { clear: true, target: a.target }, ctx, "pose");
    const which = a.stop === true ? null : String(a.stop);
    if (which === WINGS_FOLDED && ag.wingsFolded && !ag.anims.some((x: any) => x.name === WINGS_FOLDED)) return act(await ag.foldWings(false));
    const stopped: string[] = await ag.stopAnims(which);
    const left = ag.anims.map((x: any) => x.name);
    if (which != null && !stopped.length) return text(`not playing "${which}" — nothing stopped (playing: ${left.join(", ") || "nothing"})`);
    const mode = ag.bodyModeNow();
    return text(`${stopped.length ? `stopped ${stopped.join(", ")}` : "nothing was playing; released any held pose"}${which == null ? ` — resting as ${mode} (${ag.clip}); body-mode ${mode} is unchanged` : left.length ? ` — still playing ${left.join(", ")}` : ""}`);
  }
  // only your own fall ends your anims: a ragdoll asked of someone else leaves yours playing, whatever they answer
  if (a.ragdoll === true) { if (!a.target) ag.animEnded("knocked over"); return LEGACY.pose(ag, { ragdoll: true, ...(a.target ? { target: a.target } : {}) }, ctx, "pose"); }
  // live joints: today's pose shape; a held frame
  if (a.joints != null && typeof a.joints === "object" && !Object.keys(a.joints).length) return LEGACY.pose(ag, { ...(a.target ? { target: a.target } : {}) }, ctx, "pose");   // joints: {} lists the rig
  if (a.joints != null || a.bones != null) {
    const r: any = await LEGACY.pose(ag, { bones: a.joints ?? a.bones, ...(a.replace != null ? { replace: a.replace } : {}), ...(a.hold != null ? { hold: a.hold } : {}), ...(a.target ? { target: a.target } : {}) }, ctx, "pose");
    if (!a.target && !r.isError && ag.heldPose) { ag.animBegan({ name: "live", mode: "hold", kind: "live" }); r.content[0] = { ...r.content[0], text: `${JSON.stringify({ playing: "live", mode: "hold" })} — ${r.content[0].text}` }; }
    return r;
  }
  // live tracks: today's animate shape (once or loop); hold freezes the frame at `at` (default the last key) as joints
  if (a.tracks != null) {
    const mode = mode0 ?? "once";
    if (mode === "hold") {
      if (a.target) return { content: [{ type: "text", text: "anim {tracks, mode: hold} holds on your own body; send joints to hold a frame on someone else" }], isError: true };
      const v = validateTracks(a.tracks); if (!v.accepted.length) return LEGACY.animate(ag, { tracks: a.tracks, dur: a.dur }, ctx, "animate");
      ag.setPose(frameOf(v.tracks, at), !!a.hold); ag.animBegan({ name: "live", mode: "hold", kind: "live" });
      // what validation left out or corrected is said, as animate says it
      const note = poseReport(v);
      // between two keys a bone holds the earlier one, not the frame a loop would show there, so the reply says so
      return playing("live", "hold", `holding ${at == null ? "the last key" : `each bone's key at or before ${at} s (else its first), not a blend between keys,`} of ${v.accepted.length} bone(s)${note ? `. ${note}` : ""}`);
    }
    // a new tracks loop on your body replaces the one in its layer: the earlier loop stops on every renderer before the new
    // one is sent, so "replaced" is what they show (the merge left both running). Only a loop animate
    // will play ends it: one it refuses (no usable track, no dur) leaves the earlier loop playing
    if (!a.target && mode === "loop" && ag.anims.some((x: any) => x.kind === "track") && validateTracks(a.tracks).accepted.length && Number(a.dur) > 0 && Number.isFinite(Number(a.dur))) ag.endTrackLoop("replaced");
    const r: any = await LEGACY.animate(ag, { tracks: a.tracks, dur: a.dur, loop: mode === "loop", ...(a.replace != null ? { replace: a.replace } : {}), ...(a.target ? { target: a.target } : {}) }, ctx, "animate");
    if (!r.isError && !a.target && mode === "loop") ag.animBegan({ name: "live", mode: "loop", kind: "track" });
    if (!r.isError) r.content[0] = { ...r.content[0], text: `${JSON.stringify({ playing: "live", mode })} — ${r.content[0].text}` };
    return r;
  }
  // by name: a pose or a clip, the anim's own mode unless the call says one
  if (a.name != null) {
    const n = String(a.name);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(n)) return { content: [{ type: "text", text: `anim: "${n}" isn't an anim name (letters, digits, - and _)` }], isError: true };
    if (isReservedAnimName(n)) return { content: [{ type: "text", text: `anim: "${n}" is reserved — it names every ad-libbed anim (joints, tracks), so no anim can be called it; stop: "${n}" stops those` }], isError: true };
    if (a.target) return { content: [{ type: "text", text: "anim {name} plays on your own body; to animate someone else, send joints or tracks (they decide)" }], isError: true };
    const from = animFrom(ag, n);
    if (ANIM_POSES.has(n)) { const t = await ag.foldWings(true); if (!t.ok) return fail(t.text); if (ag.wingsFolded) ag.animBegan({ name: n, mode: "hold", kind: "pose" }); return playing(n, "hold", t.text, from); }
    const mode = (mode0 ?? ANIM_MODES[n] ?? "once") as "once" | "loop" | "hold";
    // once overlays what is held and returns to it (R 15:34: sit + wave is still sitting): the held anim goes on, unstopped
    if (mode === "once") { ag.playOnce(n); return playing(n, "once", `everyone sees it${ag.anim ? `, over ${ag.anim.name}, which goes on` : ""}`, from); }
    const clip = ANIM_CLIP[n] ?? n;
    // hold: at, else its last frame (a hair before its end: receivers take clipTime modulo the clip's length), when this
    // host can read the clip's length; else its first frame, said
    let holdAt: number | null = null, holdWords = "";
    if (mode === "hold") { if (at != null) { holdAt = at; holdWords = `${at} s`; } else { const d = await clipLength(ag.httpBase, clip); holdAt = d ? Math.max(0, d - 1 / 60) : 0; holdWords = d ? "its last frame" : "its first frame (its length isn't known here)"; } }
    ag.setPosture(clip);   // the one it replaces is told stopped {why: replaced} by animBegan
    ag.animBegan({ name: n, mode, kind: "clip", clip, ...(ANIM_BODY[n] ? { bodyMode: ANIM_BODY[n] } : {}) }, holdAt);
    return playing(n, mode, `${mode === "loop" ? "until something else happens (another anim, a move, anim {stop}, being knocked over)" : `frozen at ${holdWords}, until something else happens`}${ANIM_BODY[n] ? `; body-mode ${ANIM_BODY[n]}` : ""}`, from);
  }
  if (a.joints == null && a.tracks == null) return LEGACY.pose(ag, {}, ctx, "pose");   // bare: list the rig's bones (as pose did)
  return text("anim: name, joints, tracks, stop or ragdoll");
};

// advertised ⇔ handled, asserted the moment either server imports this table
{
  const declared = new Set(TOOLS.map((t) => t.name));
  for (const n of declared) if (!HANDLERS[n]) throw new Error(`[tools] "${n}" is advertised but has no handler`);
  for (const n of Object.keys(HANDLERS)) if (!declared.has(n)) throw new Error(`[tools] "${n}" has a handler but no schema row`);
}

/** A build check (server/buildcheck.ts) as text a reader can act on. */
function describeCheck(what: string, r: any, named: number, id?: string, collide?: string): string {
  const L: string[] = [];
  // spawned with collide: the world fits it that way whatever its size
  if (collide === "exact" || collide === "box") {
    r = { ...r, walkIn: { ...r.walkIn, roomScale: collide === "exact" }, warnings: (r.warnings ?? []).filter((w: any) => w.kind !== "solid") };
    if (collide === "box") r.warnings.unshift({ kind: "solid", message: `it was spawned with collide: "box", so it is one solid box: nobody can go inside — what follows is what it would be with collide: "exact"` });
  }
  const floors = (r.levels ?? []).map((l: any) => `${l.y}m (${l.reachable}m² of ${l.area}m² reachable)`).join(", ");
  L.push(`${what}: ${r.walkIn?.roomScale ? "walk-in" : collide === "box" ? "SOLID — spawned as a box" : "SOLID — under the walk-in size"}; ${(r.levels ?? []).length} floor${(r.levels ?? []).length === 1 ? "" : "s"}${floors ? `: ${floors}` : ""}`
    + `${r.perf ? `; rendering ${r.perf.rank} (${r.perf.tris} triangles, ${r.perf.draws} draw calls)` : ""}.`);
  if (r.warnings?.length) { L.push("Problems:"); for (const w of r.warnings) L.push(`  - ${w.message}`); }
  else L.push("No problems found: every floor under its roof can be reached from outside.");
  const s = r.suggested ?? {};
  const parts = [
    ...(s.rooms ?? []).map((x: any) => `${x.id} (a room, floor ${x.min[1]}m, ${x.area}m²)`),
    ...(s.doors ?? []).map((x: any) => `${x.id} (${x.between.join(" ↔ ")}, ~${x.width}m wide, at ${x.at.join(", ")})`),
    ...(s.stairs ?? []).map((x: any) => `${x.id} (a stair, ${x.between.join(" ↔ ")})`),
  ];
  if (parts.length) {
    L.push(`Suggested places, read from the geometry${named ? ` (it already has ${named} named)` : ""}: ${parts.join("; ")}.`);
    L.push(`To name them, rename the keys and send: act {verb: "set", args: {id: "${id ?? "<thing>"}", component: "places", value: ${JSON.stringify(s.places)}, merge: true}}`
      + ` — merge: true keeps the places it already has — or stand in each and use name_place.`);
  }
  return L.join("\n");
}

// Old names still work (STRIKES A-S1-2: walk_to, snapshot, spawn and world_verb were renamed with no alias, and a pilot
// whose code learned the old name got "Unknown tool"). An alias runs the new tool and says so in one line; an unknown
// name offers the closest declared one.
export const TOOL_ALIASES: Record<string, string> = { walk_to: "move", snapshot: "screenshot", spawn: "create", world_verb: "act", check_model: "measure",
  // R 10-17 15:31: the old body tools are anim now (hidden aliases for one release; TOOL_ALIAS_ARGS maps the shapes that changed)
  pose: "anim", animate: "anim", emote: "anim", posture: "anim" };
/** Tools that FOLDED into a general tool's mode (10-14): the old name is refused with the call that does it now. Not an
 *  alias — the arguments changed shape, so running the new tool on the old args would do the wrong thing quietly. */
export const TOOL_FOLDS: Record<string, string> = {
  take_off: 'move {mode: "fly"}', climb_to: 'move {mode: "fly", altitude}', glide_to: 'move {mode: "fly", to: [x, z]}', land_at: 'act {verb: "land", args: {to: [x, z]}}',
  rehearse_down: "no tool: a bench calls the agent's flightBodyDown directly", rehearse_recover: "no tool: a bench calls the agent's flightBodyRecovered directly",
  fold_wings: 'anim {name: "wings-folded"}', unfold_wings: 'anim {stop: "wings-folded"}', flight_status: "body_state (its flight field)",
  clear_pose: "anim {stop: true, target?}", clear_reach: "reach {release: true, limb?}",
  ragdoll: 'anim {ragdoll: true, target?} (a body going limp); to push someone: act {verb: "shove", args: {target, strength?}}', library_sheet: "library {kind, page?}", library_preview: "library {preview}", list_library: "library {query}",
  light: 'create {components: {light: {…}}, at?} (edit {id, set: {"light.intensity": …}} updates one)', remove: 'act {verb: "delete", args: {id}}',
  blueprint_place: 'create {from: "sha256:<hash>", at?}', kick: 'act {verb: "kick", args: {who, minutes?, reason?}}', ban: 'act {verb: "ban", args: {who, days?, reason?, global?}}',
  unban: 'act {verb: "unban", args: {who, global?}}', list_bans: 'act {verb: "bans", args: {global?}}',
  // main's world_access left without a pointer
  world_access: 'the world\'s own components on @world: worlds shows each door; owners change it with act {verb: "set", args: {id: "@world", component: "access" | "roles:<id>", value}}',
};
/** Main's tools that left with what they did, and why: refused with a pointer, never "no such tool" (#260 r3 I3; whisper
 *  fell through to a did-you-mean of whois). */
export const TOOL_REMOVED: Record<string, string> = {
  whisper: "world chat has no private channel (the maintainers' speech ruling: speech is logged, whisper stays disabled); say speaks aloud to everyone here",
};
/** An alias carries the OLD argument shape too (review 10-15 #5: walk_to {x, z} reached move, which takes {to}, and got a shape
 *  error — the alias ran the right tool with the wrong words). Each translates the old schema to the new one, or says what to
 *  call instead when the old call has no one-to-one new form. */
export const TOOL_ALIAS_ARGS: Record<string, (a: Record<string, any>) => Record<string, any> | { refuse: string }> = {
  // walk_to {to} (a named place, a thing, a person, "?": #239) passes through as move's to; {x, z} is to: [x, z], and with
  // y (#236: which floor) to: [x, y, z]. run and tolerance carry over; walk_to took nothing else
  walk_to: (a) => ({ to: a.to !== undefined ? a.to : a.y != null ? [a.x, a.y, a.z] : [a.x, a.z],
    ...(a.run !== undefined ? { run: a.run } : {}), ...(a.tolerance !== undefined ? { tolerance: a.tolerance } : {}) }),
  snapshot: (a) => a,
  check_model: (a) => ({ ...a, check: true }),   // #241's tool, a mode of measure: the same {id | lib, scale?}
  // the old body tools became anim (R 10-17 15:31), each with its old shape and meaning (the action bar's old tool played its {name} once)
  pose: (a) => {
    const t = a.target != null ? { target: a.target } : {};
    if (a.clear === true) return { stop: true, ...t };
    if (a.ragdoll === true) return { ragdoll: true, ...t };
    if (a.posture != null) { const k = String(a.posture); return ["sit", "sitchair", "lie", "stand"].includes(k) ? { name: k, mode: "loop" } : { refuse: "pose: posture is sit (on the ground), sitchair (chair height), lie or stand — anim {name} plays it now" }; }
    if (a.wings != null) return a.wings === "fold" ? { name: "wings-folded" } : a.wings === "open" ? { stop: "wings-folded" } : { refuse: 'pose: wings is "fold" or "open" — anim {name: "wings-folded"} / anim {stop: "wings-folded"} now' };
    if (a.name != null) return { name: a.name, ...t };
    return { ...(a.bones != null ? { joints: a.bones } : {}), ...(a.replace != null ? { replace: a.replace } : {}), ...(a.hold != null ? { hold: a.hold } : {}), ...t };
  },
  animate: (a) => a.name != null ? { name: a.name, ...(a.looped === true || a.loop === true ? { mode: "loop" } : {}) }
    : { tracks: a.tracks, dur: a.dur, mode: a.looped === true || a.loop === true ? "loop" : "once", ...(a.replace != null ? { replace: a.replace } : {}), ...(a.target != null ? { target: a.target } : {}) },
  emote: (a) => ({ name: a.name, mode: "once" }),   // the old gesture tool played once: a dance loops under anim, never under the old name (house review I59)
  posture: (a) => { const k = String(a.kind ?? a.posture ?? ""); return ["sit", "sitchair", "lie", "stand"].includes(k) ? { name: k, mode: "loop" } : { refuse: "posture is sit, sitchair, lie or stand — anim {name} plays it now" }; },
  world_verb: (a) => a,   // TOOL_ALIAS_ARGS: act takes the same {verb, args}
  spawn: (a) => {
    if (!a.lib) return { refuse: a.query ? `spawn {query} has no one-step form now: library {query: ${JSON.stringify(a.query)}} finds the model, then create {model}` : "spawn needs lib (a library path); it is create {model} now" };
    const hasXZ = Number.isFinite(a.x) && Number.isFinite(a.z);
    // the old spawn's id was how its author named the thing: the authority mints ids now (R 10-17), so the name becomes its
    // label, which every tool takes as it takes an id
    const id = a.id !== undefined ? { components: { label: String(a.id) } } : {};
    // with a yaw and no y: place {at: [x, z], facing}, the authority's seat on what's under x, z (the same as without a yaw),
    // facing a point 1 m along yaw (place takes facing, not yaw; atan2 gives yaw back); it used to be {pos: [x, 0, z], yaw},
    // the origin at y 0, sitting on nothing (review r2 F8)
    if (hasXZ && Number.isFinite(a.yaw) && !Number.isFinite(a.y)) return { model: a.lib, ...id, place: { at: [a.x, a.z], facing: [a.x + Math.sin(a.yaw), a.z + Math.cos(a.yaw)] } };
    const at = !hasXZ ? undefined : a.yaw !== undefined ? { pos: [a.x, a.y, a.z], yaw: a.yaw } : Number.isFinite(a.y) ? [a.x, a.y, a.z] : [a.x, a.z];
    return { model: a.lib, ...id, ...(at !== undefined ? { at } : {}) };
  },
};
export function resolveTool(name: string): { name: string; note?: string } | null {
  if (HANDLERS[name]) return { name };
  const to = TOOL_ALIASES[name]; if (to && HANDLERS[to]) return { name: to, note: `(${name} is now called ${to}; this ran ${to})` };
  return null;
}
const edits = (x: string, y: string) => { const d: number[][] = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]); for (let j = 1; j <= y.length; j++) d[0][j] = j;
  for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1)); return d[x.length][y.length]; };
export const nearestTool = (name: string) => Object.keys(HANDLERS).map((n) => [n, edits(name, n)] as const).sort((p, q) => p[1] - q[1])[0];
export async function handleTool(ctx: ToolCtx, name: string, a: Record<string, any>) {
  const r = resolveTool(name);
  if (!r && TOOL_FOLDS[name]) return { content: [{ type: "text", text: `${name} folded into a general tool: ${TOOL_FOLDS[name]} — nothing ran` }], isError: true };
  // the same words for a tool this server doesn't serve, hidden or never there (#247), with the nearest name when one is close
  if (!r && TOOL_REMOVED[name]) return { content: [{ type: "text", text: `${name} was removed: ${TOOL_REMOVED[name]} — nothing ran` }], isError: true };
  if (!r) { const near = nearestTool(name); return { content: [{ type: "text", text: `there's no tool named "${name}" on this server, so nothing ran${near && near[1] <= 4 ? ` (did you mean ${near[0]}?)` : ""}; your tool list has the ones it serves` }], isError: true }; }
  // a refused translation ran nothing, so its note says what the old name is now, not that it ran
  if (r.note && TOOL_ALIAS_ARGS[name]) { const t = TOOL_ALIAS_ARGS[name](a ?? {}); if ("refuse" in t) return { content: [{ type: "text", text: `(${name} is now called ${r.name}; nothing ran)\n${t.refuse}` }], isError: true }; a = t; }
  // A tool's failure belongs in its result, where the model reads it: a
  // handler that throws, such as verb()'s refusal while the link is down,
  // answers as a failed call rather than as a protocol error.
  let out: Record<string, unknown>;
  try { out = await HANDLERS[r.name](ctx.agent, a, ctx, r.name); }
  catch (e) {
    // The host no longer sees the throw, so the operator's log does.
    console.error(`[door] ${r.name} threw:`, e);
    // A throw with nothing to say, such as an Error with no message, still tells the model the call failed.
    const why = e instanceof Error ? e.message : String(e);
    out = fail(why || `${r.name} failed, and its error gave no reason${e instanceof Error ? ` (${e.name})` : ""}`);
  }
  if (r.note && Array.isArray((out as any)?.content) && (out as any).content[0]?.type === "text") (out as any).content[0] = { ...(out as any).content[0], text: `${r.note}\n${(out as any).content[0].text}` };
  return out;
}
