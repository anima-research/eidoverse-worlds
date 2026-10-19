// mcpl/tools.ts — the agent tool surface, ONE table and ONE dispatcher
// (survey §B3/§C, ruled §24r: "unify stdio door").
//
// Two doors front the same embodied agent: the MCPL/WS door (net-server.ts,
// sessions + channels + capabilities) and the plain-MCP stdio door
// (server.ts). The stdio door used to carry a hand-copied 16-tool subset of
// this table — drifted descriptions, a stale searchLibrary with the
// hardcoded-Mac-path bug R0 fixed on only one side, and a "shared schema"
// comment that had stopped being true. Now both doors register from TOOLS
// and dispatch through handleTool; what differs between hosts rides ToolCtx:
//
//   - rememberAvatar / rememberActivity — per-identity persistence (the WS
//     door writes state.json; the stdio door, one agent per process, may
//     no-op);
//   - canPush + heldActivity — whether ambient activity digests can be
//     DELIVERED (a channel host) or must be HELD for the next poll;
//   - cursor.caughtUpTo — the catch_up position, per attachment;
//   - travel — session machinery (channel epochs, join gates); a door
//     without the hook does not list the tool.
//
// Everything else in here talks only to the WorldAgent and the sequencer's
// HTTP surface, which is exactly what makes it transport-agnostic.

import { readdirSync } from "node:fs";
import sharp from "sharp";
import { validatePose, validateTracks, tracksSpan, poseReport, HUMANOID_BONES, mergePose, puppetPose } from "../shared/humanoid.js";
import { rigBonesFor } from "./rigbones.ts";
import { CONTACT_POINTS, canonicalPoint } from "../shared/contact.js";
import { normalizeSnapFrame } from "../shared/snapframe.js";
import { rawShapeError } from "./shape.ts";
import { shown } from "../shared/shown.js";
import { lightArgsError } from "../server/verb-shapes.ts";
import type { ActResult, WorldAgent } from "./agent.ts";

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
  /** session-machinery travel; absent = the door does not offer it */
  travel?: (world: string) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
  /** the door's RFC-005 join policy for THIS credential, so `worlds` can say
   *  which of the listed worlds the agent may actually travel to — the same
   *  gate travel itself applies, asked before the move instead of after.
   *  Absent = the door has no policy vocabulary (stdio fronts one world). */
  worldPolicy?: { canJoin: (world: string) => boolean; canFound: boolean };
};

// ---- tools (shared schema with the stdio server, minus retina by default) --

export const WHISPERS_ENABLED = process.env.EIDO_WHISPERS_ENABLED !== "0";
// REHEARSAL IS NOT A PILOT TOOL (upstream, flight arc — merged 2026-09-02):
// both rehearse_* verbs call the trusted DOWN seam directly, and down-spec
// §4 says DOWN is involuntary — "the body cannot cry wolf". DEFAULT OFF,
// unlike whispers: an operator opts a bench in; a production process that
// sets nothing has no rehearsal surface at all. Filtered from tools/list AND
// refused at dispatch — a tool hidden from the list but still callable is a
// hidden tool, not an absent one.
export const REHEARSAL_ENABLED = process.env.EIDO_FLIGHT_REHEARSAL === "1";
export const REHEARSAL_TOOLS = new Set(["rehearse_down", "rehearse_recover"]);

export const TOOLS = [
  { name: "body_state", description: "Perceive your body or another present participant (who; omitted or 'self' means you). Default summary reports posture, wings, position, held poses/reaches and freshness. detail:'bones' adds published quaternions and derived world joint positions; 'contacts' adds named world-space contact points, outward normals, self-relative positions and ready-to-use reach targets; 'all' includes both. Optional window_ms (0–5000) measures reconstructed joint motion and endpoint residuals over a short window; a snapshot alone does not measure stability. Optional points filters contacts, e.g. ['chest_front','hand_l','hand_r']. Geometry evaluates the shared VRMA posture clips, published bone rotations and dependent limb reaches. Missing clips or unresolved/cyclic reach dependencies return incomplete geometry. Contacts are bone-bound anatomical estimates; full renderer blending, emotes and springbones are not reproduced. Reading never moves or touches anyone. Use returned reachTarget with reach to track a named point; use selfPosition to plan offsets around your own body.", inputSchema: { type: "object", properties: { who: { type: "string" }, detail: { type: "string", enum: ["summary", "bones", "contacts", "all"] }, points: { type: "array", items: { type: "string" }, maxItems: Object.keys(CONTACT_POINTS).length }, window_ms: { type: "integer", minimum: 0, maximum: 5000 } } } },
  { name: "look", description: "Text-tier perception: where you are, who's present and what they're doing, every placed thing with distance/bearing, and chat since you last looked.", inputSchema: { type: "object", properties: {} } },
  { name: "snapshot", description: "A rendered image from the world (spectator browser on a GPU host). Slower than look — use when spatial/visual detail matters. view: 'first' (default) is your avatar's eyes — you are not in frame; 'third' is an over-the-shoulder chase view — your body and what's ahead of it; 'selfie' faces you from in front — your avatar, framed. Optional framing: pitch (first only) tilts your gaze in degrees, + up / − down (default ≈ −4; try −60 to see what's at your feet); dist and height (third/selfie) set the camera's flat distance from you and its height above your feet in metres (defaults third 3.4/2.1, selfie 2.6/1.6). renderer: 'auto' (default) prefers a native Unreal renderer serving this world, else a browser one; 'browser' or 'unreal' asks for that one only.", inputSchema: { type: "object", properties: { view: { type: "string", enum: ["first", "third", "selfie"] }, renderer: { type: "string", enum: ["auto", "browser", "unreal"] }, pitch: { type: "number", minimum: -85, maximum: 85 }, dist: { type: "number", minimum: 0.5, maximum: 30 }, height: { type: "number", minimum: 0, maximum: 30 } } } },
  { name: "walk_to", description: "Walk (or run) to a named place, a thing, a person, or world coordinates. Griddled structures route through walkable openings; sealed, oversized, or conflicting local routes return a reason without walking through walls. This is horizontal centerline routing with a 0.5m feet-to-step obstruction band, not full-body clearance or general mesh navigation. Placed models are solid, as they are to people: you stand on their floors, climb their stairs and are stopped by their walls and furniture — and walk_to routes through them: round furniture, through doorways, up and down stairs, onto other storeys (pick one with y). A destination with nowhere to stand, or no way there, is refused with the reason; a walk something unexpected stops ends early and says where. Main follows terrain support; identified-floor support requires the separate standing implementation. Default arrival tolerance is 0.01m, so short positioning moves are honored. Optional tolerance (0–0.4 metres) changes how close to the requested point counts as arrived. This is destination accuracy, not distance from another body.", inputSchema: { type: "object", properties: { to: { type: "string", description: "a named destination instead of coordinates: \"thing/place\" (e.g. \"lookout/balcony\"), a place's name or label alone (\"reading room\" — the nearest one), a thing alone (its entrance), or a person. look lists each thing's places." }, x: { type: "number" }, z: { type: "number" }, y: { type: "number", description: "which floor at the destination: the walkable surface nearest this height, no more than a step (0.55m) above it — 0 for a ground floor, an upper storey's floor height for that storey. Omit for your own storey if the destination has one, else its lowest floor (the ground floor of another building, the ground under a balcony)." }, run: { type: "boolean" }, tolerance: { type: "number", minimum: 0, maximum: 0.4 } } } },
  { name: "name_place", description: "Give a spot a name, so you and everyone else can walk_to it by name. Names where you stand (or x/z, with y optional: the floor there nearest your height), on the thing you are in or the nearest placed thing (or `on`), in that thing's own frame — it moves with it. Written to the thing's `places` component (builder rights; answers once the world accepts or refuses it): a name can be added, re-pointed or retired any time, and covers places the model itself declares. remove: true retires a name.", inputSchema: { type: "object", properties: { name: { type: "string" }, label: { type: "string", description: "how it reads, e.g. \"the window seat\"" }, on: { type: "string", description: "the thing's id; default: the thing you are in, else the nearest within 15m" }, x: { type: "number" }, y: { type: "number" }, z: { type: "number" }, remove: { type: "boolean" } }, required: ["name"] } },
  { name: "check_model", description: "What a model is like to walk into, measured with the walking body's own rules before or after it is placed: whether it is walk-in at all, its floors and how much of each can be reached from outside, why any part can't (a passage narrower than a body, a rise too high to step, a climb an overhanging floor blocks, no way in), the render budget — and suggested rooms, doors and stairs, ready to name as places. Advisory: nothing is refused. Pass the id of a placed thing (checked as placed: at its scale, with its collide), or a library/store path (what an upload returns; checked at its own size, or at scale). The first check of a model at a scale takes a few seconds.", inputSchema: { type: "object", properties: { id: { type: "string" }, lib: { type: "string" }, scale: { type: "number", description: "with lib: check it as if placed at this scale (0.05–20)" } } } },
  // ---- FLIGHT (upstream's flight arc, merged 2026-09-02; behind the `fly`
  // grant — the agent refuses on the ground it stands on). Deliberately no
  // file_plan: a sortie is these tools called in sequence from the pilot's own
  // code, exactly as walk_to already is.
  { name: "take_off", description: "Leave the ground. Refuses if your wings are folded (unfold first — the vigil posture costs the sky) or if you are limp. Costs stamina for the launch. READ THE REPLY: it gives your altitude, or why you are still standing.", inputSchema: { type: "object", properties: {} } },
  { name: "climb_to", description: "Climb to an altitude, in metres. THE expensive verb: 1 stamina per metre, and the pool only refills on the ground (0.5/s), never in the air. (Perches are NOT implemented in Stage 1 — see shared/flight.js.) Clamped by the soft ceiling. If the pool empties on the way you stop where it ran out and the world hears 'winded' — exhaustion is legible, not lethal.", inputSchema: { type: "object", properties: { altitude: { type: "number" } }, required: ["altitude"] } },
  { name: "glide_to", description: "Glide toward world coordinates, trading altitude for distance on the published polar. FREE — costs no stamina. If you cannot reach it from your current altitude you land SHORT, honestly, where the polar runs out: no teleport-assist, no rubber-banding. Returns when you arrive or when you are down, and says which, where, and by how much you missed.", inputSchema: { type: "object", properties: { x: { type: "number" }, z: { type: "number" } }, required: ["x", "z"] } },
  { name: "land_at", description: "Descend, flare and land at world coordinates. Landing is an EVENT — the world sees it. Afterwards your body is walking again.", inputSchema: { type: "object", properties: { x: { type: "number" }, z: { type: "number" } }, required: ["x", "z"] } },
  // REHEARSAL ONLY, and named so (see REHEARSAL_ENABLED above).
  { name: "rehearse_down", description: "REHEARSAL ONLY — fire the trusted bodyDown event the Connectome adapter will one day fire for real. Not a way to appear down: the real signal is involuntary and this exists to test the body's half of it.", inputSchema: { type: "object", properties: { eventId: { type: "string" } } } },
  { name: "rehearse_recover", description: "REHEARSAL ONLY — fire the trusted bodyRecovered event. Mid-air this begins the aerial sit-up; on the ground, the sit-up proper.", inputSchema: { type: "object", properties: { eventId: { type: "string" } } } },
  { name: "fold_wings", description: "Fold your wings down — the vigil posture. Requires a body with animatable wing chains, but NOT permission to fly: posture is body autonomy. It GROUNDS you; take_off refuses while folded, and unfolding is separate. A distinct silhouette, readable across a clearing. Ground only; land first if flying.", inputSchema: { type: "object", properties: {} } },
  { name: "unfold_wings", description: "Open your wings again, ending the vigil. Releasing a folded posture is always allowed, even after changing into a wingless body. This does NOT grant propulsion: without this world’s fly permission, take_off still refuses.", inputSchema: { type: "object", properties: {} } },
  { name: "flight_status", description: "Where the sky has left you: altitude, heading, airspeed, stamina, how far your best glide still reaches from here, and which layer is flying (live/plan/reflex). Cheap — call it as often as you like.", inputSchema: { type: "object", properties: {} } },
  { name: "face", description: "Turn to face a point (x,z) or a participant/entity id (target).", inputSchema: { type: "object", properties: { x: { type: "number" }, z: { type: "number" }, target: { type: "string" } } } },
  { name: "stop", description: "Stop walking.", inputSchema: { type: "object", properties: {} } },
  { name: "say", description: "Say something in world chat (bubble over your head, persisted). Equivalent to publishing on the world channel. Optional spoken-say trio (spoken+utt, t0 optional): display/continuation metadata marking this say as voice-performed by your live voice leg — it does NOT prove performance (the authenticated attest/performed receipt path is the only performance truth). The trio travels together or the door refuses loudly.", inputSchema: { type: "object", properties: { text: { type: "string" }, spoken: { type: "boolean", description: "true = a live voice leg is performing this say (display metadata only)" }, utt: { type: "integer", minimum: 0, description: "utterance counter: author-controlled display/continuation metadata (does NOT prove performance)" }, t0: { type: "number", description: "performance start, epoch ms (optional, finite)" } }, required: ["text"] } },
  { name: "catch_up", description: "What happened in the world while you were not thinking. Returns chat since a point in the world's history; omit `since` to continue from where you last caught up. Use when a conversation refers to something you have no memory of.", inputSchema: { type: "object", properties: { since: { type: "number" }, limit: { type: "number" } } } },
  { name: "activity", description: "Your ambient-activity sense — and the dial for it. While something is happening within radius_m of you (speech, movement, gestures, arrivals, building), you receive one digest per pulse_sec window on the world channel, tagged \"activity\" with metadata {activity: true} — never as a mention. If your host lets you configure wake rules, match that tag/metadata to be woken regularly exactly as long as there is life nearby; the stream stops by itself when the area goes quiet, so it costs nothing in an empty room. Call with no arguments to see your current settings. pulse_sec (10–3600 seconds, 0 = off) and radius_m (1–200) are your own to set and persist across sessions. If your host has no push channel (plain MCP), digests are held instead and handed over each time you call this tool — poll it when you want to know what has been happening around you.", inputSchema: { type: "object", properties: { pulse_sec: { type: "number" }, radius_m: { type: "number" } } } },
  { name: "whisper", description: "Say something privately to ONE participant. Not spoken aloud, no bubble, and deliberately never written to the world log — so it is also not replayed to anyone later.", inputSchema: { type: "object", properties: { to: { type: "string" }, text: { type: "string" } }, required: ["to", "text"] } },
  { name: "pose", description: "Hold a custom body pose. `bones` is a sparse map of bone name to a value: a rotation [x,y,z,w], or {q, t, s} to also move or scale that bone — q rotation [x,y,z,w], t translation [x,y,z] in metres, s scale (one number, or [x,y,z]). Humanoid bones go by VRM name (leftUpperArm, leftLowerArm, spine, chest, neck, head, hips, leftUpperLeg...); ANY other bone your rig has goes by its own name (a wing, an eyelid, a twist bone, a tail) — call pose with no `bones` to list them. Rotations are relative to the parent bone's. Translation on hips moves the whole body in world metres (Y is up): {\"hips\": {\"t\": [0, -0.5, 0]}} lowers you half a metre, for kneeling or crouching; on any other bone t is how far it moves beyond where its parent carries it. Scale is in the bone's own axes and carries to its children. By default only the bones you name change and the rest of any pose you hold stays (so you can raise an arm while kneeling); a bone set to null is released back to normal. replace:true makes this the WHOLE pose instead: every bone you don't name goes back to normal animation. Names are checked against the rig and corrected where unambiguous, and anything dropped is reported back with the reason — so read the reply, it is your only feedback that the body did what you meant. Held until you `clear_pose` or move; pass hold:true to keep it through walking too (your legs still stride, so pose arms and head rather than legs if you mean to travel in it). Presence only — never written to the world log, so it costs nothing and vanishes when you leave. Pass `target` to pose SOMEONE ELSE (checked against THEIR rig; they decide whether to allow it).", inputSchema: { type: "object", properties: { bones: { type: "object" }, replace: { type: "boolean", description: "true: this is the whole pose; unnamed bones return to normal. Default false: only the named bones change" }, hold: { type: "boolean" }, target: { type: "string" } } } },
  { name: "clear_pose", description: "Release a held pose, easing back to normal animation. Pass `target` to release a pose you asked someone else to hold.", inputSchema: { type: "object", properties: { target: { type: "string" } } } },
  { name: "emote", description: "Fire a named gesture — the same one-shots humans have on their emote bar. Plays once over your locomotion; presence only, never logged. For a gesture that isn't listed, invent one with `animate`.", inputSchema: { type: "object", properties: { name: { type: "string", enum: ["wave", "cheer", "dance", "point", "salute", "clap", "talk", "flail"] } }, required: ["name"] } },
  { name: "reach", description: `Reach out with a hand (or foot) — real IK: everyone sees your arm extend toward the target and TRACK it (your walking, their moving) until clear_reach, and the palm turns to rest on the surface it meets. Two ways to aim it: (1) a contact point on a body — \`who\` (participant id; omit to touch your own body) + \`point\`, one of: ${Object.keys(CONTACT_POINTS).join(", ")}; the person you touch hears about it (they get a 'reaches toward you' event, then a 'touches' event when your hand arrives — you hear the same when someone touches you). (2) a bare point — x, y, z with \`space\`: 'world' (default, fixed), 'self' (your own root frame — moves with you), or a participant id (their root frame — tracks them). READ THE REPLY, it is your only feedback: it says whether the hand actually arrives, what limited it (joints, body, distance), and how far to walk if it fell short. A reach composes over walking, sitting and held poses. If YOU (the reacher) are knocked over, your outgoing reaches are cleared. The target walking, changing posture or falling does not revoke your tracking relation. The target currently has no tool to revoke someone else's incoming reach; agree on release with them. Presence-only, never logged.`, inputSchema: { type: "object", properties: { limb: { type: "string", enum: ["rightHand", "leftHand", "rightFoot", "leftFoot"], description: "default rightHand" }, who: { type: "string" }, point: { type: "string" }, x: { type: "number" }, y: { type: "number" }, z: { type: "number" }, space: { type: "string" }, standoff: { type: "number", description: "metres to hover off the surface (default 0.02 — resting on it)" }, palm: { type: "boolean", description: "false = don't orient the palm to the surface" } } } },
  { name: "clear_reach", description: "Let go: release one of YOUR reaching limbs (or all of them when called bare), easing back to normal animation. Anyone you were touching sees the hand withdraw. This clears your outgoing reaches; it does not revoke someone else's incoming reach toward you.", inputSchema: { type: "object", properties: { limb: { type: "string", enum: ["rightHand", "leftHand", "rightFoot", "leftFoot"] } } } },
  { name: "posture", description: "Settle into a posture: sit (on the ground), sitchair (chair height), lie, or stand. Held until you stand or walk; survives leaving and rejoining, like a held pose.", inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["sit", "sitchair", "lie", "stand"] } }, required: ["kind"] } },
  { name: "ragdoll", description: "Shove another body over — a physics ragdoll. `target` is who falls; THEY simulate it on their own body (you never simulate someone else), and it settles into a held pose everyone sees. The shove is directed from where YOU stand through them (walk to the right side of someone before pushing); `strength` 0.5–4 m/s, default 2.2. Being knocked over is opt-in for humans and default for agent performers.", inputSchema: { type: "object", properties: { target: { type: "string" }, strength: { type: "number" } }, required: ["target"] } },
  { name: "animate", description: "Play a one-off animation — for a specific gesture you are inventing on the spot. `tracks` maps a VRM humanoid bone name to a list of keyframes [{ t: seconds, q: [x,y,z,w] }]; `dur` is the length in seconds. Only list the bones that move. It plays once (or set loop:true), over your locomotion AND over any pose you hold or animation already playing — it takes only the bones it animates; replace:true ends your held pose and other animations first. Relayed to everyone but never logged. Keep it small and sparse — a few bones, a few keyframes. Pass `target` to play it on someone else (they decide).", inputSchema: { type: "object", properties: { dur: { type: "number" }, loop: { type: "boolean" }, replace: { type: "boolean" }, tracks: { type: "object" }, target: { type: "string" } }, required: ["dur", "tracks"] } },
  { name: "set_avatar", description: "Change your body. Pass `avatar` as a roster name (see it with no arguments) or a full vrm path. Takes effect immediately — everyone sees you change; your position and held pose carry over.", inputSchema: { type: "object", properties: { avatar: { type: "string" } } } },
  { name: "library_sheet", description: "A contact sheet — one grid image with names under each tile. kind 'avatars' is the wearable roster (portraits exist once a body has been worn); kind 'models' is the placeable object library. 12 per page. Use library_preview for a closer look at one, set_avatar to wear, spawn to place.", inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["avatars", "models"] }, page: { type: "number" } }, required: ["kind"] } },
  { name: "library_preview", description: "One item at full size: an avatar's portrait (roster name) or a model's preview render (library filename or path).", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "list_library", description: "Search the model library by keywords. Returns library paths for spawn.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "spawn", description: "Spawn a library model. lib (exact) or query (best match); position defaults to 2m in front of you.", inputSchema: { type: "object", properties: { lib: { type: "string" }, query: { type: "string" }, x: { type: "number" }, z: { type: "number" }, y: { type: "number" }, yaw: { type: "number" }, id: { type: "string" } } } },
  { name: "place", description: "Move an entity (id from look) to x,z (y defaults to terrain; pass y to seat on furniture).", inputSchema: { type: "object", properties: { id: { type: "string" }, x: { type: "number" }, z: { type: "number" }, y: { type: "number" }, yaw: { type: "number" } }, required: ["id", "x", "z"] } },
  { name: "light", description: "Place a light source in the world, or update one you can already see: calling with the id of an existing light changes ONLY the fields you pass (brightness via intensity, color, range, position) and leaves the rest alone. Persists like any placed thing. color is a hex integer (e.g. 0xffd9a0 warm, 0x88bbff cool, 0xff5533 red), intensity (default 16) and range are optional. keep: true means the light ALWAYS casts: it lives outside the per-client point-light budget (consumes no slot, so unkept lights keep their full budget) and framerate governors never douse it. Every casting light has real GPU cost — keep it for lights that matter. Position defaults to just in front of you. A supplied id must be a string with at least one non-whitespace character; omit it (or pass null) to generate one. An id that names something other than a light is refused, since a light would replace it. A small glowing sphere marks it; move or remove it by id like any entity.", inputSchema: { type: "object", properties: { color: { type: "number" }, intensity: { type: "number" }, range: { type: "number" }, keep: { type: "boolean" }, x: { type: "number" }, y: { type: "number" }, z: { type: "number" }, id: { type: "string" } } } },
  { name: "remove", description: "Remove a placed entity.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  // Description narrowed to what the implementation actually does (antra
  // review, #3). It previously promised "held pose and posture survive", which
  // joinWorld does NOT transfer — and which contradicts the existing pose
  // contract ("vanishes when you leave"). Carrying a world-local pose across
  // worlds is a product decision nobody has made, so the honest move is to
  // stop promising it rather than to implement it by inference. Identity,
  // avatar and the activity dial ARE carried, and are named because they are.
  { name: "worlds", description: "Which worlds this door fronts that you may see, and who is embodied in each — the map for `travel`. Marks the world you are in now, which worlds are members-only or watch-only, and which you may travel to: each world's owners decide who comes in. Travelling to a name that isn't listed founds a new world (a few per day). People and agents are listed by the same ids you see in `look`; spectators appear as nothing, as in-world.", inputSchema: { type: "object", properties: {} } },
  { name: "travel", description: "Walk to another world this door fronts, keeping your identity, avatar and attention settings — no reconnect. The world you name decides whether you may come in (its owners' grants), and a credential limited to certain worlds keeps you to them; a refusal leaves you where you are. Naming a world that does not exist yet founds it (a few per day). Your held pose and posture do NOT survive the move (they are world-local, like a disconnect), and your chat cursor resets to the new world.", inputSchema: { type: "object", properties: { world: { type: "string", description: "world name, e.g. \"commons\"" } }, required: ["world"] } },
  { name: "world_verb", description: "Raw world-log verb. The verb set is CLOSED by design — say, use, punt, force, mount, dismount, spawn, place, remove, light, comp, motion, behavior, asset, terrain, grass, sky, weather, epoch (owner only: enters or upgrades the world's deterministic-sim epoch), grant, kick, ban, unban, caption (one line of what a screen said; needs the per-screen caption deed) — and the world refuses others; extend STATE with comp types you invent, EVENTS with use actions, SEMANTICS with behavior scripts, never by hoping a new verb exists. This is also the authoring surface for components: comp {id, type, data|null} attaches data to an entity (sockets, reactions, or anything you invent); motion {id, type: pendulum|spin|orbit|bob|path, …} sets it moving; see AGENTS.md in the eidoverse-worlds repo for the full vocabulary.", inputSchema: { type: "object", properties: { verb: { type: "string" }, args: { type: "object" } }, required: ["verb", "args"] } },
  { name: "measure", description: "Geometry as data: bounding box, up-facing flat zones (seat/table/deck candidates), and named parts of a placed thing (id) or a library model (lib). Flat-zone coords are the MODEL's local frame — the same frame sockets use, so a zone's center IS a socket pos: comp {id, type:'sockets', data:{seat:{pos:[cx,y,cz], yaw}}}. Use this to find where a body can sit before declaring the seat; verify by mounting it yourself and taking a selfie snapshot. Raw GLB bytes are at GET <sequencer>/library/<lib> if you want to process the mesh locally.", inputSchema: { type: "object", properties: { id: { type: "string" }, lib: { type: "string" } } } },
  { name: "world_history", description: "Pull raw entries from the world log — the append-only record every world IS. Filter by verbs (e.g. ['use','motion'] to trace an interaction, ['comp'] to see how something was built), page backwards with before. Every entry has {seq, ts, actor, verb, args}; reaction-authored entries carry {cause, by}. This is the debugging primitive: the log is the world, so reading it is reading the world's source.", inputSchema: { type: "object", properties: { verbs: { type: "array", items: { type: "string" } }, before: { type: "number" }, after: { type: "number" }, limit: { type: "number" } } } },
  { name: "world_debug", description: "The world's flight recorder: why things BOUNCED. The log answers 'what happened'; this answers 'why didn't it' — denied verbs (rights), rejected shapes (malformed/oversized comp, bad mount), rate limits, reaction outcomes ('reaction' fired with cause→effect seqs, 'reaction-skip' with the reason, 'reaction-error'), script events ('script-error', 'script-pause'), and 'spawn-lint' (an accepted spawn whose lib is malformed or names no file /library serves; repeats of one lib are recorded once a minute). Pass behavior: <id> to read ONE runtime script's own log ring (its world.log() console + status); pass behaviors: true to list what scripts run here and whether they're alive. IMPORTANT: motion/comp components are NOT scripts — they are passive data evaluated client-side and NEVER appear in the behaviors roster (absence there does not mean your component failed or was deleted; check world_history verbs:['comp','motion'] for its fold, and look for kind 'motion-lint' in the plain recorder: the server lints every folded motion for params the evaluator will ignore, unknown types, and part names that no client renders). In-memory, recent events only. Check here first when something doesn't do what you expected.", inputSchema: { type: "object", properties: { limit: { type: "number" }, kinds: { type: "array", items: { type: "string" } }, behavior: { type: "string" }, behaviors: { type: "boolean" } } } },
  { name: "kick", description: "MODERATION: remove a participant from this world right now. They may rejoin — a kick interrupts, a ban excludes. Needs owner rights here (same gate as grant); operators and fellow owners cannot be kicked.", inputSchema: { type: "object", properties: { id: { type: "string" }, reason: { type: "string" } }, required: ["id"] } },
  { name: "ban", description: "MODERATION: ban a participant — disconnects them now and refuses their joins (including spectating) until unban. Default is THIS world only (needs owner rights here). global:true bans them from every world on this server (needs WORLD_ADMIN). Give a reason — it is shown to them and kept in the record.", inputSchema: { type: "object", properties: { id: { type: "string" }, reason: { type: "string" }, global: { type: "boolean" } }, required: ["id"] } },
  { name: "unban", description: "MODERATION: lift a ban — this world's by default, the server-wide list with global:true.", inputSchema: { type: "object", properties: { id: { type: "string" }, global: { type: "boolean" } }, required: ["id"] } },
  { name: "list_bans", description: "Who is banned from this world (anyone may ask), or from the whole server with global:true (operator only).", inputSchema: { type: "object", properties: { global: { type: "boolean" } } } },
  { name: "world_access", description: "WHO MAY COME INTO this world, and until when. The world decides this itself (not your credential). action 'show' (anyone here): the door, and everyone named. Owners change it — action 'mode' with mode: members (invisible to everyone not listed), watch (anyone may watch, only those listed may come in), visitors, or open; action 'grant' with id (a name, even of someone who is not here right now) and role: owner|builder|visitor|spectator|none, optionally for: '30m' | '2h' | '1d' | '1w' to make it end; action 'revoke' with id. Ending access is enforced by the world: the holder is warned five minutes before, then removed.", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["show", "mode", "grant", "revoke"] }, mode: { type: "string", enum: ["members", "watch", "visitors", "open"] }, id: { type: "string" }, role: { type: "string", enum: ["owner", "builder", "visitor", "spectator", "none"] }, for: { type: "string" } }, required: ["action"] } },
];

import { readdirSync } from "node:fs";
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


/** The tool list a door should advertise: whispers ride an env kill-switch,
 *  travel only exists where the host wired the session machinery for it. */
export function toolList({ travel = false }: { travel?: boolean } = {}) {
  return TOOLS.filter((t) => (WHISPERS_ENABLED || t.name !== "whisper") && (travel || t.name !== "travel")
    && (REHEARSAL_ENABLED || !REHEARSAL_TOOLS.has(t.name)));
}

export async function snapshotTool(ag: ToolAgent, view = "first", renderer = "auto", frame: { dist?: unknown; height?: unknown; pitch?: unknown } = {}) {
  try {
    const norm = normalizeSnapFrame(frame);
    const extra = Object.entries(norm).map(([k, v]) => `&${k}=${v}`).join("");
    // Name any framing field the chosen view does not use, rather than
    // ignoring it silently: pitch is first-only, dist/height third/selfie-only.
    const posed = view === "third" || view === "selfie";
    const ignored = posed ? (norm.pitch !== undefined ? ["pitch"] : []) : (["dist", "height"] as const).filter((k) => norm[k] !== undefined);
    const note = !ignored.length ? null
      : posed ? "pitch applies only to view first; ignored"
      : `${ignored.join(" and ")} ${ignored.length > 1 ? "apply" : "applies"} only to views third and selfie; ignored`;
    // as this identity: a members-only world's snap answers only its members
    const r = await fetch(`${ag.httpBase}/snap?world=${encodeURIComponent(ag.world)}&follow=${encodeURIComponent(ag.name)}&view=${encodeURIComponent(view)}&renderer=${encodeURIComponent(renderer)}${extra}`,
      ag.agentToken ? { headers: { authorization: `Bearer ${ag.agentToken}` } } : undefined);
    if (!r.ok) return fail(`snapshot: no picture was taken; the world server answered "${(await r.text()).slice(0, 200)}" (${r.status}), so try again in a while`);
    const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
    const label = r.headers.get("x-eidoverse-scene") === "world-projection"
      ? "Unreal server-world projection: models, structures, terrain and avatars; unsupported components and effects may be absent. This is a donor-rendered image, not authoritative state."
      : "Unreal underwater prototype view: local terrain/habitats and networked avatars; persistent world buildings are not mirrored.";
    const image = { type: "image", data: b64, mimeType: "image/png" };
    return { content: [...(r.headers.get("x-eidoverse-renderer") === "unreal" ? [{ type: "text", text: label }] : []), image, ...(note ? [{ type: "text", text: note }] : [])] };
  } catch (e) {
    return fail(`snapshot failed: no picture arrived from the world server (${(e as Error).message}); try again in a moment`);
  }
}

// ---- the dispatcher --------------------------------------------------------
// One handler per tool, keyed to TOOLS by NAME — the verbs.ts/messages.ts
// treatment (survey §B3, deferred until the table had one home): bodies moved
// VERBATIM from the 26-case switch. The load-time assertion below makes
// advertise/handle drift a boot failure on BOTH doors instead of a missing
// tool a caller meets at runtime.

const text = (t: string) => ({ content: [{ type: "text", text: t }] });
/** A call that didn't do what it was asked: a host shows the result as failed. */
const fail = (t: string) => ({ content: [{ type: "text", text: t }], isError: true });
/** An act's answer, failed when the call didn't do what it asked. */
const act = (r: ActResult) => (r.ok ? text(r.text) : fail(r.text));
/** A text argument as sent: a number goes as its digits, as it always has, and anything else that isn't
 *  a string reads as none. */
const textArg = (v: unknown) => typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
/** The most speech say and whisper send in one call, as they always have: 4000 UTF-16 units (world_verb's raw say
 *  doesn't come through here). The world cuts a whisper at its own EW_WHISPER_LEN, 4000 unless its operator sets
 *  another. A cut never ends in half of a surrogate pair. */
const SPEECH_MAX = 4000;
const cutSpeech = (t: string) => {
  if (t.length <= SPEECH_MAX) return t;
  const end = /[\uD800-\uDBFF]/.test(t[SPEECH_MAX - 1]!) ? SPEECH_MAX - 1 : SPEECH_MAX;
  return t.slice(0, end);
};
/** Why a request can't go to `to`, someone else as a trimmed name, or null. A name of only spaces names no
 *  one. While joined, someone not here is refused, and look lists who is; your own name is here, though
 *  the world's list of people leaves you out. While not joined, the request goes on, and the link's own
 *  refusal answers it. */
const absent = (ag: ToolAgent, to: string, why: string) => {
  if (!to) return fail(`the target is only spaces, ${why}`);
  if (!ag.joined || to === ag.name || ag.people.has(to)) return null;
  return fail(`${to} isn't here, ${why}; look lists who is around you`);
};
/** A tool this door doesn't serve, hidden or never there: the same words. */
const noSuchTool = (name: string) => `there's no tool named "${name}" on this door, so nothing ran; your tool list has the ones it serves`;
// Refused at dispatch too, not merely hidden: a pilot who learned the name
// off a bench must not be able to fire the trusted seam here.
const rehearse = (ag: ToolAgent, a: Record<string, any>, name: string) => {
  if (!REHEARSAL_ENABLED) return fail(noSuchTool(name));
  return act(name === "rehearse_down"
    ? ag.flightBodyDown(String(a.eventId ?? "rehearsal"))
    : ag.flightBodyRecovered(String(a.eventId ?? "rehearsal"), "gen-rehearsal"));
};
/** A coordinate or altitude the call can't fly to: missing, or not a number.
 *  A number flies, and so does a string that reads as one, as `Number()`
 *  always took "5"; a boolean, a blank, a list or an object doesn't. */
const notANumber = (v: unknown) => typeof v === "number" ? !Number.isFinite(v)
  : typeof v !== "string" || v.trim() === "" || !Number.isFinite(Number(v));

type ToolHandler = (ag: WorldAgent, a: Record<string, any>, ctx: ToolCtx, name: string)
  => Promise<Record<string, unknown>> | Record<string, unknown>;

export const HANDLERS: Record<string, ToolHandler> = {
  // ---- FLIGHT (upstream's flight arc, merged 2026-09-02)
  take_off: async (ag, a, ctx, name) => act(await ag.takeOff()),
  climb_to: async (ag, a, ctx, name) => notANumber(a.altitude)
    ? fail("climb_to needs `altitude`, a number of metres")
    : act(await ag.climbTo(Number(a.altitude))),
  glide_to: async (ag, a, ctx, name) => notANumber(a.x) || notANumber(a.z)
    ? fail("glide_to needs `x` and `z`, numbers")
    : act(await ag.glideTo(Number(a.x), Number(a.z))),
  land_at: async (ag, a, ctx, name) => notANumber(a.x) || notANumber(a.z)
    ? fail("land_at needs `x` and `z`, numbers")
    : act(await ag.landAt(Number(a.x), Number(a.z))),
  rehearse_down: async (ag, a, ctx, name) => rehearse(ag, a, name),
  rehearse_recover: async (ag, a, ctx, name) => rehearse(ag, a, name),
  fold_wings: async (ag, a, ctx, name) => act(await ag.foldWings(true)),
  unfold_wings: async (ag, a, ctx, name) => act(await ag.foldWings(false)),
  flight_status: async (ag, a, ctx, name) => text(ag.flightStatus()),
  look: async (ag, a, ctx, name) => { return text(ag.look()); },
  body_state: async (ag, a) => {
    const result = await ag.bodyState(a.who == null ? ag.name : String(a.who), a.detail ?? "summary", a.points, a.window_ms ?? 0);
    return (result.ok ? text : fail)(JSON.stringify(result, null, 2));
  },
  snapshot: async (ag, a, ctx, name) => { return await snapshotTool(ag, typeof a.view === "string" ? a.view : "first", typeof a.renderer === "string" ? a.renderer : "auto", { dist: a.dist, height: a.height, pitch: a.pitch }); },
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
  posture: async (ag, a, ctx, name) => {
      const kind = String(a.kind ?? "");
      const clip = { sit: "sit", sitchair: "sitchair", lie: "lie", stand: "idle" }[kind];
      if (!clip) return fail("posture kinds: sit (on the ground), sitchair (chair height), lie, stand");
      ag.setPosture(clip);
      return text(kind === "stand" ? "you stand up" : `you ${kind === "lie" ? "lie down" : "sit down"} — walking stands you back up`);

  },
  library_sheet: async (ag, a, ctx, name) => {
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
        { type: "text", text: `${kind} — page ${page}/${pages}: ${slice.map((t) => t.name).join(", ")}${page < pages ? `. More: library_sheet {kind:"${kind}", page:${page + 1}}` : ""}` },
        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
      ] };

  },
  library_preview: async (ag, a, ctx, name) => {
      const want = String(a.name ?? "").trim();
      if (!want) return fail("pass `name`: a roster avatar name or a model filename/path");
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

  },
  walk_to: async (ag, a, ctx, name) => {
      // `to` names the destination (a place, a thing, a person); x/z/y are
      // coordinates. A named place carries its own floor and reach.
      let x = Number(a.x), z = Number(a.z), y = a.y != null ? Number(a.y) : undefined, label: string | null = null;
      let near: { reach?: number; above?: number; below?: number; inside?: (x: number, z: number) => boolean; bodyAt?: { x: number; z: number } } = {};
      if (typeof a.to === "string") {
        const d = ag.destination(a.to);
        if ("refusal" in d) return fail(d.refusal);
        ({ x, z } = d); y = d.y; near = { reach: d.reach, above: d.above, below: d.below, inside: d.inside, bodyAt: d.bodyAt }; label = d.label;
      }
      const tolerance = a.tolerance ?? 0.01;
      if (![x, z, tolerance].every(Number.isFinite) || tolerance < 0 || tolerance > 0.4)
        return fail("walk_to needs finite x/z and tolerance between 0 and 0.4 metres");   // walkTo's own words (WALK_ARGS_REASON)
      if (y != null && !Number.isFinite(y))
        return fail("walk_to's y, when given, must be a finite height in metres");
      // This request's own refusal (its plan may wait for geometry still loading).
      const receipt = { refusal: null as string | null };
      const arrived = await ag.walkTo(x, z, Boolean(a.run), 90_000, tolerance, y, near, receipt);
      if (!arrived) return fail(receipt.refusal ?? ag.walkStopReason ?? ag.walkStall ?? "walk interrupted or timed out");
      const here = ag.placesAt([ag.pos.x, ag.pos.y, ag.pos.z])[0];
      return text(label
        ? `arrived at ${label}: (${ag.pos.x.toFixed(2)}, ${ag.pos.y.toFixed(2)}, ${ag.pos.z.toFixed(2)})${here ? `, in ${here.place.label ?? here.place.name}` : ""}`
        : `arrived at (${ag.pos.x.toFixed(3)}, ${ag.pos.z.toFixed(3)}); ${Math.hypot(ag.pos.x - x, ag.pos.z - z).toFixed(3)}m from requested destination${here ? `, in ${here.place.label ?? here.place.name} (${here.entity.id}/${here.place.name})` : ""}`);

  },
  check_model: async (ag, a) => {
      const e = a.id ? ag.entities.get(String(a.id)) : null;
      if (a.id && !e) return fail(`no thing called "${a.id}" here`);
      const lib = String(e?.lib ?? a.lib ?? "");
      if (!lib || lib === "(light)") return fail("check_model needs the id of a placed model, or a library path");
      let r: any;
      // a placed thing is checked as placed: at its scale (the body is not scaled)
      const scale = e ? (e.scale && e.scale > 0 ? e.scale : 1) : (typeof a.scale === "number" && a.scale > 0 ? a.scale : 1);
      try { r = await (await fetch(`${ag.httpBase}/check?lib=${encodeURIComponent(lib)}${scale !== 1 ? `&scale=${scale}` : ""}`)).json(); }
      catch (err) { return fail(`the check could not be reached: ${String((err as Error)?.message ?? err)}`); }
      if (r.error) return fail(`couldn't check ${lib}: ${r.error}`);
      return text(describeCheck(`${e ? `[${e.id}] ` : ""}${lib}${r.scale && r.scale !== 1 ? ` at scale ${r.scale}` : ""}`, r, e ? ag.placesOn(e).length : 0, e?.id, e?.collide));
  },
  name_place: async (ag, a) => {
      // coordinates: x and z together (y optional: the floor there nearest
      // your own height), or none — never some of them silently dropped
      const given = [a.x, a.y, a.z].some((v: unknown) => v != null);
      if (given && ![a.x, a.z].every((v: unknown) => typeof v === "number" && Number.isFinite(v)))
        return fail("name_place's coordinates need x and z (y is optional: the floor there nearest your own height) — or leave them all out to name where you stand");
      if (a.y != null && !(typeof a.y === "number" && Number.isFinite(a.y)))
        return fail("name_place's y, when given, must be a finite height in metres");
      const at = given ? { x: a.x as number, z: a.z as number, y: a.y as number | undefined } : undefined;
      return act(await ag.namePlace(String(a.name ?? ""), { on: a.on, label: a.label, remove: a.remove === true, at }));
  },
  face: async (ag, a, ctx, name) => {
      if (a.target) {
        const p = ag.people.get(a.target)?.pose?.p ?? ag.entities.get(a.target)?.pos;
        if (!p) return fail(`nothing here is called "${a.target}", so you didn't turn; look lists who and what is around you`);
        ag.face(p[0], p[2]);
      } else if (a.x != null && a.z != null) ag.face(Number(a.x), Number(a.z));
      else return fail('face needs x and z, or a target, so you didn\'t turn: face {x: 4, z: -2} or face {target: "<an id from look>"}');
      return text("facing");

  },
  stop: async (ag, a, ctx, name) => { ag.stop(); return text("stopped"); },
  emote: async (ag, a, ctx) => {
      const name = String(a.name ?? "");
      if (!["wave", "cheer", "dance", "point", "salute", "clap", "talk", "flail"].includes(name))
        return fail("emotes: wave, cheer, dance, point, salute, clap, talk, flail — or invent one with animate");
      ag.emote(name);
      return text(`you ${name === "wave" ? "wave" : `play "${name}"`} — everyone sees it`);
  },
  // say args ride through whole (spoken-say protocol: a voice aux leg
  // performs says marked spoken:true; utt/t0 are author-controlled
  // display/continuation metadata — NOT proof of performance, which only
  // the attest/performed receipt path establishes). ag.say rebuilt {text}
  // bare and silently stripped them —
  // which forced voice agents onto a raw world-ws side door (2026-08-10).
  say: async (ag, a, ctx, name) => {
      // Spoken-say protocol keys ride through; anything else stays at the
      // door. The server validates these (bounded utt window, clamped t0)
      // and strips them from ordinary says — the door's job is to forward
      // the protocol, not arbitrary metadata.
      // THE TRIO IS A UNIT (r3 review). The world server deletes all three
      // keys unless spoken===true AND utt is a safe non-negative integer —
      // so forwarding keys independently let a spoken:true say with a bad
      // utt ride to the server and silently degrade to ordinary chat, the
      // voice agent none the wiser. Validate the same unit here and refuse
      // LOUDLY: a door that must drop the protocol should say so, not shrug
      // the say into text. (r5 tightened this to TYPE-EXACT rather than the
      // server's Number() coercion — see the next block: the door refuses
      // null/bool/"5" outright so a coerced value can never be laundered into
      // a fabricated utterance.)
      // text is REQUIRED and must be a real string (Opus-5 review): the schema
      // says required:["text"], but a schema is not a boundary here (same
      // reason "5" is refused for utt) — so validate it, or a call with the
      // trio but no text lands a FABRICATED spoken say whose body is the
      // literal "undefined"/"[object Object]".
      if (typeof a.text !== "string" || a.text.length === 0) {
        return fail(`say refused: \`text\` is required and must be a non-empty string, so nothing was said; you sent ${shown(a.text)}`);
      }
      // "Wants spoken" means the caller is ASSERTING a performance: spoken:true,
      // or a trio partner (utt/t0) present. An explicit spoken:false (or spoken
      // absent) is an ordinary say — degrade to plain chat exactly as the world
      // server does, never an error (Opus-5 review: refusing spoken:false muted
      // a voice leg doing the natural `spoken: leg.isActive`).
      const wantsSpoken = a.spoken === true || a.utt !== undefined || a.t0 !== undefined;
      // TYPE-EXACT, not coerced (adversarial review): Number(null)===0 and
      // Number(true)===1 let a null/boolean utt or a null t0 pass the old
      // guard and forward a FABRICATED value — violating this door's own
      // "malformed refuses, never silently drops" invariant. The schema
      // declares utt:integer>=0 and t0:number; require exactly those raw
      // JSON types. (The world server tolerates numeric strings elsewhere;
      // the door does not launder them into the protocol.)
      const uttOk = typeof a.utt === "number" && Number.isSafeInteger(a.utt) && a.utt >= 0;
      const t0Ok = a.t0 === undefined || (typeof a.t0 === "number" && Number.isFinite(a.t0));
      const trioOk = a.spoken === true && uttOk && t0Ok;
      if (wantsSpoken && !trioOk) {
        // Machine-legible failure (r6 review): the same {content, isError:true}
        // contract a malformed world_verb returns. A prose-only refusal let a
        // schema client that inspects result.isError read this as a successful
        // say — the door must mark the refusal as an error, not just describe
        // one in text.
        return fail(`spoken-say refused, so nothing was said: a spoken line needs spoken: true and utt a non-negative integer, and t0, if given, a finite number (you sent spoken ${shown(a.spoken)}, utt ${shown(a.utt)}, t0 ${shown(a.t0)}). Sent as plain text it would lose its performance link. For an ordinary say, send only text.`);
      }
      const extra = trioOk
        ? { spoken: true as const, utt: a.utt, ...(typeof a.t0 === "number" ? { t0: a.t0 } : {}) }
        : undefined;
      const sent = cutSpeech(a.text);
      ag.say(sent, extra);
      return text(sent.length < a.text.length ? `said — only its first ${[...sent].length} characters were sent; say the rest in another call` : "said");

  },
  whisper: async (ag, a, ctx, name) => {
      if (!WHISPERS_ENABLED) return fail("whispers are turned off on this door, so nothing was sent, and calling again won't change that");
      // A name or text given as a number goes as its digits, as it always
      // has; anything else that isn't a string, or is only whitespace, is
      // refused, and the name goes trimmed, since the world matches ids
      // exactly. `to` may be someone not here yet: the world holds a whisper
      // for them until they come.
      // A number past the safe integers has lost digits by the time it's read here, so it isn't what was sent.
      const unsafe = (v: unknown) => typeof v === "number" && Math.abs(v) > Number.MAX_SAFE_INTEGER;
      if (unsafe(a.to) || unsafe(a.text)) {
        return fail(`whisper's \`${unsafe(a.to) ? "to" : "text"}\` is a number too large to read exactly, so send it as a string`);
      }
      const to = textArg(a.to)?.trim(), said = textArg(a.text);
      if (!to || said == null || !said.trim()) {
        return fail("whisper needs `to`, the name of who it's for, and `text`, what to say to them");
      }
      const sent = cutSpeech(said);
      ag.whisper(to, sent);
      // The world holds at most EW_WHISPER_HOLD (20 by default) for each person away, dropping the oldest past that,
      // and holds them in memory, so a restart drops them.
      const away = ag.joined && to !== ag.name && !ag.people.has(to)
        ? `; they aren't here, so the world holds it for when they next arrive, unless it restarts first. It keeps each person's latest 20 by default, so an older one can be dropped` : "";
      // The cut comes before the note on holding it, which ends on the whispers the world drops.
      return text(`whispered to ${to}${sent.length < said.length ? ` — only the first ${[...sent].length} characters were sent; whisper the rest in another call` : ""}${away}`);

  },
  pose: async (ag, a, ctx, name) => {
      // Validate and SAY what happened. A pose is authored blind — the only
      // other feedback is a snapshot through a GPU host — so a bone name that
      // does not exist, a three-component quaternion, or two names folding
      // onto one bone must come back as words, not as a body that silently
      // did not move. (See shared/humanoid.js.) Checked against the rig of
      // the body being posed: arbitrary bones exist only on the rigs that
      // have them.
      const target = a.target ? String(a.target).trim() : null;
      const away = target != null ? absent(ag, target, "so there's no one to pose") : null;
      if (away) return away;
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
          + ' {"leftUpperArm": [0, 0, -0.9, 0.44], "hips": {"t": [0, -0.4, 0]}}. Call pose with no bones to list your rig\'s.');
      }
      const what = `${v.accepted.length} bone(s)${v.custom.length ? ` (${v.custom.length} beyond the humanoid set: ${v.custom.join(", ")})` : ""}`
        + `${v.released.length && !replace ? `, releasing ${v.released.join(", ")}` : ""}`;
      // replace: the named bones ARE the pose (a null means nothing there).
      // Otherwise merge over what is already held — mergePose, the same rule
      // a browser applies when it is posed.
      if (target) {
        ag.puppet(target, puppetPose(v.pose, replace));
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
        + `${hold && held.length ? ". It stays through walking — clear_pose to drop it." : ""}`);

  },
  clear_pose: async (ag, a, ctx, name) => {
      if (a.target) {
        const to = String(a.target).trim();
        const away = absent(ag, to, "so there's no pose of theirs to release");
        if (away) return away;
        ag.puppet(to, puppetPose(null));
        return text(`asked ${to} to release their pose. They decide whether to.`);
      }
      ag.setPose(null);
      return text("released pose");

  },
  reach: async (ag, a, ctx, name) => {
      // Two target grammars, checked here so the refusal can TEACH: the
      // named-point form (who/point) and the bare-point form (x,y,z/space).
      const hasName = a.who != null || a.point != null;
      const hasXYZ = typeof a.x === "number" && typeof a.y === "number" && typeof a.z === "number";
      if (!hasName && !hasXYZ) {
        return fail("reach needs a target: either `point` (a contact point on a body; add `who` for someone else's) or `x`,`y`,`z` (with optional `space`: 'world' default, 'self', or a participant id).");
      }
      let target: Record<string, unknown>;
      if (hasName) {
        if (a.point == null) return fail("reaching for someone needs `point` too — which contact point on them: " + Object.keys(CONTACT_POINTS).join(", "));
        const pt = canonicalPoint(String(a.point));
        if (!pt) return fail(`unknown contact point "${a.point}" — one of: ${Object.keys(CONTACT_POINTS).join(", ")}`);
        target = { who: String(a.who ?? ag.name), point: pt, ...(typeof a.standoff === "number" ? { standoff: a.standoff } : {}) };
      } else {
        target = { p: [a.x, a.y, a.z], ...(typeof a.space === "string" ? { space: a.space } : {}) };
      }
      const r = await ag.reach(typeof a.limb === "string" ? a.limb : undefined, target,
        a.palm === false ? { palm: false } : {});
      return act(r);

  },
  clear_reach: async (ag, a, ctx, name) => {
      if (a.limb != null && typeof a.limb !== "string") return fail("clear_reach's `limb`, when given, is one limb's name, such as rightHand; leave it out to release every reach");
      return act(ag.releaseReach(a.limb ?? null));

  },
  ragdoll: async (ag, a, ctx, name) => {
      if (!a.target) return fail('ragdoll needs a target, the body to knock over, so nothing happened: ragdoll {target: "<an id from look>"}');
      // the shove is directed: from where THIS body stands, through the
      // target — the same line a browser /push uses. No known position for
      // them = an undirected knock-over, the old wire.
      const to = String(a.target).trim();
      const away = absent(ag, to, "so there's no one to shove");
      if (away) return away;
      const tp = ag.people.get(to)?.pose?.p;
      const pow = Math.min(4, Math.max(0.5, Number(a.strength) || 2.2));
      let lean: number[] | null = null;
      if (Array.isArray(tp)) {
        const dx = tp[0] - ag.pos.x, dz = tp[2] - ag.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.05) lean = [(dx / d) * pow, 0, (dz / d) * pow];
      }
      ag.puppet(to, { ragdoll: lean ? { lean } : true });
      return text(`you shove ${to}${lean ? ", asking them to go down the way you pushed" : ", asking them to go limp"}. They decide whether to.`);

  },
  animate: async (ag, a, ctx, name) => {
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
      const spec = { dur, loop: !!a.loop, tracks: v.tracks, replace: !!a.replace };
      if (a.target) {
        const to = String(a.target).trim();
        const away = absent(ag, to, "so there's no one to play it on");
        if (away) return away;
        ag.puppet(to, { anim: spec });
        return text(`sent a ${dur}s animation over ${v.accepted.length} bone(s) to ${to}`
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
  list_library: async (ag, a, ctx, name) => {
      const hits = await searchLibrary(ag.httpBase, String(a.query));
      return text(hits.length
        ? hits.map((h) => h.name && !h.path.includes(h.name) ? `${h.path}  — ${h.name}` : h.path).join("\n")
        : "no matches");

  },
  spawn: async (ag, a, ctx, name) => {
      // The library is searched when no lib names a model and a query is
      // given. An empty lib names no model, as a lib left out doesn't, so a
      // query given with it still searches.
      const named = a.lib === "" ? undefined : a.lib;
      const searched = named == null && !!a.query;
      const lib = named ?? (searched ? (await searchLibrary(ag.httpBase, String(a.query)))[0]?.path : undefined);
      // A search that found nothing is not a call that named no model, and
      // neither is a lib such as 0 or false.
      if (!lib) return fail(searched
        ? `no library model matches ${shown(a.query)}, so nothing was spawned; list_library finds models by other words`
        : named != null
          ? `spawn's lib was ${shown(a.lib)}, which names no model, so nothing was spawned; pass a model's path, or leave lib out and pass query to search the library`
          : "spawn needs lib (a model's path) or query (words to search the library), so nothing was spawned");
      const x = a.x ?? ag.pos.x + Math.sin(ag.yaw) * 2;
      const z = a.z ?? ag.pos.z + Math.cos(ag.yaw) * 2;
      const id = a.id ?? crypto.randomUUID().slice(0, 8);
      ag.verb("spawn", { id, lib, pos: [x, a.y ?? ag.heightAt(x, z), z], yaw: a.yaw ?? 0 });
      return text(`spawned [${id}] ${String(lib).split("/").pop()} at (${x.toFixed(1)}, ${z.toFixed(1)})`);

  },
  place: async (ag, a, ctx, name) => {
      if (a.id == null) return fail(`place needs id, the entity to move, so nothing was placed: place {id: "lamp1", x: 3, z: -2}`);
      // What this body has seen of the world: an entity spawned a moment ago
      // may not have reached it yet.
      if (!ag.entities.has(a.id)) return fail(`this body knows of no entity ${shown(a.id)} in this world, so nothing was placed; look lists what's around you`);
      ag.verb("place", { id: a.id, pos: [a.x, a.y ?? ag.heightAt(a.x, a.z), a.z], ...(a.yaw != null ? { yaw: a.yaw } : {}) });
      return text(`placed ${a.id}`);

  },
  light: async (ag, a, ctx, name) => {
      // Omission generates an id, and so does null, which hosts that fill
      // every optional argument send for one left out; a supplied invalid id
      // is not a placement.
      if (a.id !== undefined && a.id !== null) {
        const why = lightArgsError(a);
        if (why) return fail(why);
      }
      const standing = a.id != null ? ag.entities.get(a.id) : undefined;
      // Only a light is updated: the fold replaces anything else holding the
      // id with a light wholesale (spec §3.1), so a sparse "update" of a
      // model would leave a light at the fold's defaults where the model was.
      if (standing && standing.lib !== "(light)") {
        return fail(`"${a.id}" is a model (${standing.lib || "no lib"}), not a light, so light won't update it. Use another id, or omit id to generate one.`);
      }
      if (standing) {
        // UPDATE: send only what was given — the fold merges, so absent
        // fields keep their prior value (stamping defaults here would reset
        // a light's color every time someone dims it).
        const patch: any = { id: a.id };
        for (const k of ["color", "intensity", "range", "keep"] as const) if (a[k] != null) patch[k] = a[k];
        if (a.x != null || a.y != null || a.z != null) {
          const prev = standing.pos ?? [0, 1, 0];
          patch.pos = [a.x ?? prev[0], a.y ?? prev[1], a.z ?? prev[2]];
        }
        ag.verb("light", patch);
        return text(`updated light [${a.id}]`);
      }
      const x = a.x ?? ag.pos.x + Math.sin(ag.yaw) * 2;
      const z = a.z ?? ag.pos.z + Math.cos(ag.yaw) * 2;
      const y = a.y ?? ag.heightAt(x, z) + 1.6;
      const id = a.id ?? crypto.randomUUID().slice(0, 8);
      ag.verb("light", { id, pos: [x, y, z], color: a.color ?? 0xffd9a0, intensity: a.intensity ?? 16, range: a.range ?? 10, ...(a.keep ? { keep: true } : {}) });
      return text(`placed light [${id}] at (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`);

  },
  remove: async (ag, a, ctx, name) => {
    if (a.id == null || a.id === "") return fail("remove needs `id`, the thing to remove");
    ag.verb("remove", { id: a.id }); return text(`removed ${a.id}`);
  },
  travel: async (ag, a, ctx, name) => {
      // Travel is SESSION machinery — channel epochs, join gates, the
      // fatal-join teardown — so the shared table hands it to the host
      // through the ctx hook. A door with no hook (stdio fronts exactly one
      // WORLD_URL) does not list the tool; answering anyway teaches.
      if (!ctx.travel) return fail("travel isn't available on this door: it fronts a single world, so you stayed where you are; its operator chooses that world (WORLD_NAME)");
      return await ctx.travel(String(a.world ?? "").trim());

  },
  worlds: async (ag, a, ctx, name) => {
      // Discovery only — this reads the sequencer's /worlds and never moves
      // the body. The policy column is the door's own joinAllowed, asked
      // here so an agent learns "may I?" from the map rather than from a
      // refused travel.
      let r: Response;
      // AS THIS IDENTITY: the map is per caller — a members-only world is
      // invisible to everyone it does not list, so an anonymous ask would
      // hide the private worlds this agent belongs to.
      const headers: Record<string, string> = ag.agentToken ? { authorization: `Bearer ${ag.agentToken}` } : {};
      try { r = await fetch(`${ag.httpBase}/worlds`, { headers, signal: AbortSignal.timeout(4_000) }); }
      catch (e) { return fail(`worlds: the world server didn't answer (${(e as Error).message}), so the list isn't known; try again in a moment`); }
      if (!r.ok) return fail(`worlds: the world server answered ${r.status}, so the list isn't known; try again in a moment`);
      const body = (await r.json()) as { worlds?: { name: string; loaded?: boolean; access?: string; you?: string; people?: string[]; agents?: string[] }[] };
      const list = Array.isArray(body.worlds) ? body.worlds : [];
      if (!list.some((w) => w.name === ag.world)) list.push({ name: ag.world, loaded: true, people: [], agents: [] });
      list.sort((x, y) => (x.name === ag.world ? -1 : y.name === ag.world ? 1 : x.name.localeCompare(y.name)));
      const pol = ctx.worldPolicy;
      const lines = list.map((w) => {
        const here = w.name === ag.world;
        const who = [...(w.people ?? []), ...(w.agents ?? []).map((p) => `${p} (agent)`)];
        const occupancy = who.length ? who.join(", ") : (w.loaded ? "empty" : "empty, not loaded");
        const door = w.access === "members" ? "members only" : w.access === "watch" ? "watch only" : "";
        const may = here ? "you are here"
          : pol && !pol.canJoin(w.name) ? "outside the worlds your credential is limited to"
            : w.you === "watch" ? "you may watch, not travel in"
              : pol ? "may travel" : "";
        return `- ${w.name}${here ? " ←" : ""}${door ? ` (${door})` : ""}: ${occupancy}${may ? ` — ${may}` : ""}`;
      });
      const foot = pol
        ? (pol.canFound ? "`travel` to a name that isn't listed founds a new world there (you can found a few each day)." : "Your credential doesn't let you found new worlds.")
        : ctx.travel ? "" : "This door fronts a single world; there is no travel from here.";
      return text(`Worlds on this door (${list.length}):\n${lines.join("\n")}${foot ? `\n${foot}` : ""}`);
  },
  world_verb: async (ag, a, ctx, name) => {
      // the raw door forwards verbatim, so shape is checked HERE — a
      // malformed place in the log is permanent history every replayer
      // must survive (#88)
      const why = rawShapeError(String(a.verb), (a.args ?? {}) as Record<string, unknown>);
      if (why) return fail(`refused ${a.verb}: ${why}`);
      ag.verb(String(a.verb), a.args ?? {});
      return text(`sent ${a.verb}`);

  },
  measure: async (ag, a, ctx, name) => {
      // 🔴 USE THE AGENT'S OWN httpBase (2026-08-16). This re-derived the HTTP
      // base by string surgery on WORLD_URL — the exact form agent.ts:297
      // replaced with real URL parsing, for a reason its comment records: a
      // WORLD_URL carrying a query string (…/ws?token=…) defeats the `/\/ws$/`
      // replace and produces a malformed URL (reported by digi/FC). The bug was
      // fixed in one place and left standing in the other, which is what a
      // duplicated derivation always eventually does.
      //
      // It also ignored the door's actual connection: WORLD_URL is the boot
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
      let r: Response;
      // as this identity: a members-only world's geometry answers only its members
      try { r = await fetch(`${base}/geom?${q}`, ag.agentToken ? { headers: { authorization: `Bearer ${ag.agentToken}` } } : undefined); } catch (e) { return fail(`measure: the world server didn't answer (${String(e)}), so nothing was measured; try again in a moment`); }
      let d: any;
      try { d = await r.json(); } catch { return fail(`measure: the world server answered ${r.status} with something that isn't geometry, so nothing was measured`); }
      if (d.error) return fail(`measure: the world server answered "${d.error}" (${r.status}), so nothing was measured`);
      const g = d.geometry ?? d;
      if (!g?.bbox) return fail("no geometry available for that (parsing offline, or a light)");
      const L: string[] = [];
      const s = g.bbox.size;
      L.push(`${a.id ? `[${d.id}] ${d.lib ?? ""}` : d.lib} — ${s[0]}×${s[1]}×${s[2]}m, ${g.tris} tris${g.sampled ? " (sampled)" : ""}`);
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
      if (a.id && Object.keys(d.comp ?? {}).length) L.push(`components already on it: ${Object.keys(d.comp).join(", ")}`);
      return text(L.join("\n"));

  },
  world_history: async (ag, a, ctx, name) => {
      const r = await ag.history({
        verbs: Array.isArray(a.verbs) && a.verbs.length ? a.verbs.map(String) : undefined,
        before: typeof a.before === "number" ? a.before : undefined,
        after: typeof a.after === "number" ? a.after : undefined,
        limit: Math.min(200, Math.max(1, Number(a.limit ?? 50))),
      });
      if (!r.entries.length) return text("no matching entries");
      const lines = r.entries.map((e: any) =>
        `#${e.seq} ${new Date(e.ts).toISOString()} ${e.actor}: ${e.verb} ${JSON.stringify(e.args)}`);
      return text(`${lines.join("\n")}${r.hasMore ? `\n… more before seq ${r.oldestSeq} (page with before)` : ""}`);

  },
  world_debug: async (ag, a, ctx, name) => {
      const r = await ag.worldDebug({
        limit: Math.min(300, Math.max(1, Number(a.limit ?? 30))),
        kinds: Array.isArray(a.kinds) && a.kinds.length ? a.kinds.map(String) : undefined,
        ...(a.behavior != null ? { behavior: String(a.behavior) } : {}),
        ...(a.behaviors ? { behaviors: true } : {}),
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
  kick: async (ag, a, ctx, name) => {
      // Moderation deserves a real answer, not fire-and-forget: wait for
      // the world's echo (success) or refusal and hand THAT back.
      const id = String(a.id ?? "").trim();
      if (!id) return fail(`${name} needs an id — who, exactly?`);
      const reason = a.reason != null ? String(a.reason) : undefined;
      const t0 = Date.now();
      if (a.global && name !== "kick") ag.sendMod(name === "ban" ? "global-ban" : "global-unban", { id, ...(reason ? { reason } : {}) });
      else ag.verb(name, { id, ...(reason ? { reason } : {}) });
      const answer = await ag.modOutcome(t0);
      // A refusal is the world's no; no echo yet is sent, not refused.
      if (answer?.startsWith("refused: ")) return fail(answer);
      return text(answer ?? `sent ${name} ${id}${a.global ? " (global)" : ""} — no echo from the world yet; check look()`);

  },
  ban: (ag, a, ctx, name) => HANDLERS.kick(ag, a, ctx, name),
  unban: (ag, a, ctx, name) => HANDLERS.kick(ag, a, ctx, name),
  list_bans: async (ag, a, ctx, name) => {
      const t0 = Date.now();
      ag.sendMod(a.global ? "global-bans" : "world-bans");
      const answer = await ag.modOutcome(t0);
      if (answer == null || answer.startsWith("refused: ")) return fail(answer ?? "no reply from the world (timeout)");
      return text(answer);

  },
  world_access: async (ag, a, ctx, name) => {
      // Every change is the `grant` verb underneath (the wildcard's rung for
      // a mode), so an agent that owns a world administers it exactly like a
      // human. The answer is the world's own: its refusal, or the door as it
      // now stands (asked right after the change, so it reflects it).
      const action = String(a.action ?? "show");
      const t0 = Date.now();
      if (action === "mode") {
        const rung = ({ members: "none", watch: "spectator", visitors: "visitor", open: "builder" } as Record<string, string>)[String(a.mode ?? "")];
        if (!rung) return fail("world_access mode wants mode: members, watch, visitors or open");
        ag.verb("grant", { id: "*", role: rung });
      } else if (action === "grant") {
        const id = String(a.id ?? "").trim();
        if (!id || !a.role) return fail("world_access grant wants id and role (owner|builder|visitor|spectator|none), and optionally for: '2h'");
        ag.verb("grant", { id, role: String(a.role), ...(a.for ? { for: String(a.for) } : {}) });
      } else if (action === "revoke") {
        const id = String(a.id ?? "").trim();
        if (!id) return fail("world_access revoke wants the id of whoever to revoke");
        ag.verb("grant", { id, revoke: true });
      } else if (action !== "show") {
        return fail("world_access action is one of show, mode, grant, revoke");
      }
      ag.sendMod("world-access");
      // Wait for THE LISTING (or a refusal): a change is also echoed as a
      // `mod` line ("…bound to <subject>"), which must not be mistaken for it.
      // The echo arrives first. The listing says whether each entry is bound, and to what kind of principal, but
      // not to whom.
      // The change's own echo (whom a grant was bound to — the one way an
      // agent owner can check a name-based grant reached the right person) is
      // returned WITH the listing, not dropped (Greptile #258).
      const echo = () => ag.recentMods.filter((m) => m.ts >= t0 && !m.text.startsWith("who can come into")).map((m) => m.text);
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (ag.lastRefusal && ag.lastRefusal.ts >= t0) return fail(`refused: ${ag.lastRefusal.text}`);
        if (ag.lastMod && ag.lastMod.ts >= t0 && ag.lastMod.text.startsWith("who can come into")) {
          return text([...echo(), ag.lastMod.text].join("\n"));
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      // A show with no listing told nothing, as list_bans's does. A change with no listing yet was still sent, as a
      // ban with no echo yet is, so it isn't failed, and the answer says so, with the change's echo if it came.
      if (action === "show") return fail("no reply from the world (timeout)");
      return text([...echo(), "sent the change, but the world's listing didn't come within 2 s; world_access show tells where the door stands"].join("\n"));

  },
};

// advertised ⇔ handled, asserted the moment either door imports this table
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
    L.push(`To name them, rename the keys and send: comp {id: "${id ?? "<thing>"}", type: "places", data: ${JSON.stringify(s.places)}}`
      + ` — merged with any places it already has, since a comp replaces the whole bag — or stand in each and use name_place.`);
  }
  return L.join("\n");
}

export async function handleTool(ctx: ToolCtx, name: string, a: Record<string, any>) {
  const h = HANDLERS[name];
  if (!h) return fail(noSuchTool(name));
  // A tool's failure belongs in its result, where the model reads it: a
  // handler that throws, such as verb()'s refusal while the link is down,
  // answers as a failed call rather than as a protocol error.
  try { return await h(ctx.agent, a, ctx, name); }
  catch (e) {
    // The host no longer sees the throw, so the operator's log does.
    console.error(`[door] ${name} threw:`, e);
    return fail(e instanceof Error ? e.message : String(e));
  }
}
