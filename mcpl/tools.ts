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
import { validatePose, validateTracks, tracksSpan, poseReport } from "../shared/humanoid.js";
import { CONTACT_POINTS, canonicalPoint } from "../shared/contact.js";
import { rawShapeError } from "./shape.ts";
import type { WorldAgent } from "./agent.ts";

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
  { name: "look", description: "Text-tier perception: where you are, who's present and what they're doing, every placed thing with distance/bearing, and chat since you last looked.", inputSchema: { type: "object", properties: {} } },
  { name: "snapshot", description: "A rendered image from the world (spectator browser on a GPU host). Slower than look — use when spatial/visual detail matters. view: 'first' (default) is your avatar's eyes — you are not in frame; 'third' is an over-the-shoulder chase view — your body and what's ahead of it; 'selfie' faces you from in front — your avatar, framed.", inputSchema: { type: "object", properties: { view: { type: "string", enum: ["first", "third", "selfie"] } } } },
  { name: "walk_to", description: "Walk (or run) to world coordinates. Returns when you arrive; others see you walking.", inputSchema: { type: "object", properties: { x: { type: "number" }, z: { type: "number" }, run: { type: "boolean" } }, required: ["x", "z"] } },
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
  { name: "pose", description: "Hold a custom body pose. `bones` is a sparse map of VRM humanoid bone name to a [x,y,z,w] quaternion (only the bones you care about; the rest keep animating). Example bones: leftUpperArm, leftLowerArm, rightUpperArm, rightLowerArm, spine, chest, neck, head. Names are checked and corrected where they are unambiguous, and anything dropped is reported back with the reason — so read the reply, it is your only feedback that the body did what you meant. Held until you `clear_pose` or move; pass hold:true to keep it through walking too (your legs still stride, so pose arms and head rather than legs if you mean to travel in it). Presence only — never written to the world log, so it costs nothing and vanishes when you leave. Pass `target` to pose SOMEONE ELSE (they decide whether to allow it).", inputSchema: { type: "object", properties: { bones: { type: "object" }, hold: { type: "boolean" }, target: { type: "string" } }, required: ["bones"] } },
  { name: "clear_pose", description: "Release a held pose, easing back to normal animation. Pass `target` to release a pose you asked someone else to hold.", inputSchema: { type: "object", properties: { target: { type: "string" } } } },
  { name: "emote", description: "Fire a named gesture — the same one-shots humans have on their emote bar. Plays once over your locomotion; presence only, never logged. For a gesture that isn't listed, invent one with `animate`.", inputSchema: { type: "object", properties: { name: { type: "string", enum: ["wave", "cheer", "dance", "point", "salute", "clap", "talk", "flail"] } }, required: ["name"] } },
  { name: "reach", description: `Reach out with a hand (or foot) — real IK: everyone sees your arm extend toward the target and TRACK it (your walking, their moving) until clear_reach, and the palm turns to rest on the surface it meets. Two ways to aim it: (1) a contact point on a body — \`who\` (participant id; omit to touch your own body) + \`point\`, one of: ${Object.keys(CONTACT_POINTS).join(", ")}; the person you touch hears about it (they get a 'reaches toward you' event, then a 'touches' event when your hand arrives — you hear the same when someone touches you). (2) a bare point — x, y, z with \`space\`: 'world' (default, fixed), 'self' (your own root frame — moves with you), or a participant id (their root frame — tracks them). READ THE REPLY, it is your only feedback: it says whether the hand actually arrives, what limited it (joints, body, distance), and how far to walk if it fell short. A reach composes over walking, sitting and held poses; being knocked over drops it. Presence-only, never logged.`, inputSchema: { type: "object", properties: { limb: { type: "string", enum: ["rightHand", "leftHand", "rightFoot", "leftFoot"], description: "default rightHand" }, who: { type: "string" }, point: { type: "string" }, x: { type: "number" }, y: { type: "number" }, z: { type: "number" }, space: { type: "string" }, standoff: { type: "number", description: "metres to hover off the surface (default 0.02 — resting on it)" }, palm: { type: "boolean", description: "false = don't orient the palm to the surface" } } } },
  { name: "clear_reach", description: "Let go: release one reaching limb (or all of them when called bare), easing back to normal animation. Anyone you were touching sees the hand withdraw.", inputSchema: { type: "object", properties: { limb: { type: "string", enum: ["rightHand", "leftHand", "rightFoot", "leftFoot"] } } } },
  { name: "posture", description: "Settle into a posture: sit (on the ground), sitchair (chair height), lie, or stand. Held until you stand or walk; survives leaving and rejoining, like a held pose.", inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["sit", "sitchair", "lie", "stand"] } }, required: ["kind"] } },
  { name: "ragdoll", description: "Shove another body over — a physics ragdoll. `target` is who falls; THEY simulate it on their own body (you never simulate someone else), and it settles into a held pose everyone sees. The shove is directed from where YOU stand through them (walk to the right side of someone before pushing); `strength` 0.5–4 m/s, default 2.2. Being knocked over is opt-in for humans and default for agent performers.", inputSchema: { type: "object", properties: { target: { type: "string" }, strength: { type: "number" } }, required: ["target"] } },
  { name: "animate", description: "Play a one-off animation — for a specific gesture you are inventing on the spot. `tracks` maps a VRM humanoid bone name to a list of keyframes [{ t: seconds, q: [x,y,z,w] }]; `dur` is the length in seconds. Only list the bones that move. It plays once (or set loop:true), over your locomotion, and is relayed to everyone but never logged. Keep it small and sparse — a few bones, a few keyframes. Pass `target` to play it on someone else (they decide).", inputSchema: { type: "object", properties: { dur: { type: "number" }, loop: { type: "boolean" }, tracks: { type: "object" }, target: { type: "string" } }, required: ["dur", "tracks"] } },
  { name: "set_avatar", description: "Change your body. Pass `avatar` as a roster name (see it with no arguments) or a full vrm path. Takes effect immediately — everyone sees you change; your position and held pose carry over.", inputSchema: { type: "object", properties: { avatar: { type: "string" } } } },
  { name: "library_sheet", description: "A contact sheet — one grid image with names under each tile. kind 'avatars' is the wearable roster (portraits exist once a body has been worn); kind 'models' is the placeable object library. 12 per page. Use library_preview for a closer look at one, set_avatar to wear, spawn to place.", inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["avatars", "models"] }, page: { type: "number" } }, required: ["kind"] } },
  { name: "library_preview", description: "One item at full size: an avatar's portrait (roster name) or a model's preview render (library filename or path).", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "list_library", description: "Search the model library by keywords. Returns library paths for spawn.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "spawn", description: "Spawn a library model. lib (exact) or query (best match); position defaults to 2m in front of you.", inputSchema: { type: "object", properties: { lib: { type: "string" }, query: { type: "string" }, x: { type: "number" }, z: { type: "number" }, y: { type: "number" }, yaw: { type: "number" }, id: { type: "string" } } } },
  { name: "place", description: "Move an entity (id from look) to x,z (y defaults to terrain; pass y to seat on furniture).", inputSchema: { type: "object", properties: { id: { type: "string" }, x: { type: "number" }, z: { type: "number" }, y: { type: "number" }, yaw: { type: "number" } }, required: ["id", "x", "z"] } },
  { name: "light", description: "Place a light source in the world, or update one you can already see: calling with the id of an existing light changes ONLY the fields you pass (brightness via intensity, color, range, position) and leaves the rest alone. Persists like any placed thing. color is a hex integer (e.g. 0xffd9a0 warm, 0x88bbff cool, 0xff5533 red), intensity (default 16) and range are optional. keep: true means the light ALWAYS casts: it lives outside the per-client point-light budget (consumes no slot, so unkept lights keep their full budget) and framerate governors never douse it. Every casting light has real GPU cost — keep it for lights that matter. Position defaults to just in front of you. A small glowing sphere marks it; move or remove it by id like any entity.", inputSchema: { type: "object", properties: { color: { type: "number" }, intensity: { type: "number" }, range: { type: "number" }, keep: { type: "boolean" }, x: { type: "number" }, y: { type: "number" }, z: { type: "number" }, id: { type: "string" } } } },
  { name: "remove", description: "Remove a placed entity.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  // Description narrowed to what the implementation actually does (antra
  // review, #3). It previously promised "held pose and posture survive", which
  // joinWorld does NOT transfer — and which contradicts the existing pose
  // contract ("vanishes when you leave"). Carrying a world-local pose across
  // worlds is a product decision nobody has made, so the honest move is to
  // stop promising it rather than to implement it by inference. Identity,
  // avatar and the activity dial ARE carried, and are named because they are.
  { name: "travel", description: "Walk to another world this door fronts, keeping your identity, avatar and attention settings — no reconnect. Subject to your credential's join policy; founding a world that does not exist yet needs separate create authority. Your held pose and posture do NOT survive the move (they are world-local, like a disconnect), and your chat cursor resets to the new world.", inputSchema: { type: "object", properties: { world: { type: "string", description: "world name, e.g. \"commons\"" } }, required: ["world"] } },
  { name: "world_verb", description: "Raw world-log verb. The verb set is CLOSED by design — say, use, punt, force, mount, dismount, spawn, place, remove, light, comp, motion, behavior, asset, terrain, grass, sky, weather, grant, kick, ban, unban — and the door refuses others; extend STATE with comp types you invent, EVENTS with use actions, SEMANTICS with behavior scripts, never by hoping a new verb exists. This is also the authoring surface for components: comp {id, type, data|null} attaches data to an entity (sockets, reactions, or anything you invent); motion {id, type: pendulum|spin|orbit|bob|path, …} sets it moving; see AGENTS.md in the eidoverse-worlds repo for the full vocabulary.", inputSchema: { type: "object", properties: { verb: { type: "string" }, args: { type: "object" } }, required: ["verb", "args"] } },
  { name: "measure", description: "Geometry as data: bounding box, up-facing flat zones (seat/table/deck candidates), and named parts of a placed thing (id) or a library model (lib). Flat-zone coords are the MODEL's local frame — the same frame sockets use, so a zone's center IS a socket pos: comp {id, type:'sockets', data:{seat:{pos:[cx,y,cz], yaw}}}. Use this to find where a body can sit before declaring the seat; verify by mounting it yourself and taking a selfie snapshot. Raw GLB bytes are at GET <sequencer>/library/<lib> if you want to process the mesh locally.", inputSchema: { type: "object", properties: { id: { type: "string" }, lib: { type: "string" } } } },
  { name: "world_history", description: "Pull raw entries from the world log — the append-only record every world IS. Filter by verbs (e.g. ['use','motion'] to trace an interaction, ['comp'] to see how something was built), page backwards with before. Every entry has {seq, ts, actor, verb, args}; reaction-authored entries carry {cause, by}. This is the debugging primitive: the log is the world, so reading it is reading the world's source.", inputSchema: { type: "object", properties: { verbs: { type: "array", items: { type: "string" } }, before: { type: "number" }, after: { type: "number" }, limit: { type: "number" } } } },
  { name: "world_debug", description: "The world's flight recorder: why things BOUNCED. The log answers 'what happened'; this answers 'why didn't it' — denied verbs (rights), rejected shapes (malformed/oversized comp, bad mount), rate limits, reaction outcomes ('reaction' fired with cause→effect seqs, 'reaction-skip' with the reason, 'reaction-error'), and script events ('script-error', 'script-pause'). Pass behavior: <id> to read ONE runtime script's own log ring (its world.log() console + status); pass behaviors: true to list what scripts run here and whether they're alive. IMPORTANT: motion/comp components are NOT scripts — they are passive data evaluated client-side and NEVER appear in the behaviors roster (absence there does not mean your component failed or was deleted; check world_history verbs:['comp','motion'] for its fold, and look for kind 'motion-lint' in the plain recorder: the server lints every folded motion for params the evaluator will ignore, unknown types, and part names that no client renders). In-memory, recent events only. Check here first when something doesn't do what you expected.", inputSchema: { type: "object", properties: { limit: { type: "number" }, kinds: { type: "array", items: { type: "string" } }, behavior: { type: "string" }, behaviors: { type: "boolean" } } } },
  { name: "kick", description: "MODERATION: remove a participant from this world right now. They may rejoin — a kick interrupts, a ban excludes. Needs owner rights here (same gate as grant); operators and fellow owners cannot be kicked.", inputSchema: { type: "object", properties: { id: { type: "string" }, reason: { type: "string" } }, required: ["id"] } },
  { name: "ban", description: "MODERATION: ban a participant — disconnects them now and refuses their joins (including spectating) until unban. Default is THIS world only (needs owner rights here). global:true bans them from every world on this server (needs WORLD_ADMIN). Give a reason — it is shown to them and kept in the record.", inputSchema: { type: "object", properties: { id: { type: "string" }, reason: { type: "string" }, global: { type: "boolean" } }, required: ["id"] } },
  { name: "unban", description: "MODERATION: lift a ban — this world's by default, the server-wide list with global:true.", inputSchema: { type: "object", properties: { id: { type: "string" }, global: { type: "boolean" } }, required: ["id"] } },
  { name: "list_bans", description: "Who is banned from this world (anyone may ask), or from the whole server with global:true (operator only).", inputSchema: { type: "object", properties: { global: { type: "boolean" } } } },
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

export async function snapshotTool(ag: ToolAgent, view = "first") {
  try {
    const r = await fetch(`${ag.httpBase}/snap?world=${encodeURIComponent(ag.world)}&follow=${encodeURIComponent(ag.name)}&view=${encodeURIComponent(view)}`);
    if (!r.ok) return { content: [{ type: "text", text: `no view available: ${(await r.text()).slice(0, 200)}` }] };
    const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
    return { content: [{ type: "image", data: b64, mimeType: "image/png" }] };
  } catch (e) {
    return { content: [{ type: "text", text: `snapshot failed: ${(e as Error).message}` }] };
  }
}

// ---- the dispatcher --------------------------------------------------------
// One handler per tool, keyed to TOOLS by NAME — the verbs.ts/messages.ts
// treatment (survey §B3, deferred until the table had one home): bodies moved
// VERBATIM from the 26-case switch. The load-time assertion below makes
// advertise/handle drift a boot failure on BOTH doors instead of an
// "Unknown tool" a caller meets at runtime.

const text = (t: string) => ({ content: [{ type: "text", text: t }] });
// Refused at dispatch too, not merely hidden: a pilot who learned the name
// off a bench must not be able to fire the trusted seam here.
const rehearse = (ag: ToolAgent, a: Record<string, any>, name: string) => {
  if (!REHEARSAL_ENABLED) return text("no such tool");
  return text(name === "rehearse_down"
    ? ag.flightBodyDown(String(a.eventId ?? "rehearsal"))
    : ag.flightBodyRecovered(String(a.eventId ?? "rehearsal"), "gen-rehearsal"));
};

type ToolHandler = (ag: WorldAgent, a: Record<string, any>, ctx: ToolCtx, name: string)
  => Promise<Record<string, unknown>> | Record<string, unknown>;

export const HANDLERS: Record<string, ToolHandler> = {
  // ---- FLIGHT (upstream's flight arc, merged 2026-09-02)
  take_off: async (ag, a, ctx, name) => text(await ag.takeOff()),
  climb_to: async (ag, a, ctx, name) => text(await ag.climbTo(Number(a.altitude))),
  glide_to: async (ag, a, ctx, name) => text(await ag.glideTo(Number(a.x), Number(a.z))),
  land_at: async (ag, a, ctx, name) => text(await ag.landAt(Number(a.x), Number(a.z))),
  rehearse_down: async (ag, a, ctx, name) => rehearse(ag, a, name),
  rehearse_recover: async (ag, a, ctx, name) => rehearse(ag, a, name),
  fold_wings: async (ag, a, ctx, name) => text(await ag.foldWings(true)),
  unfold_wings: async (ag, a, ctx, name) => text(await ag.foldWings(false)),
  flight_status: async (ag, a, ctx, name) => text(ag.flightStatus()),
  look: async (ag, a, ctx, name) => { return text(ag.look()); },
  snapshot: async (ag, a, ctx, name) => { return await snapshotTool(ag, typeof a.view === "string" ? a.view : "first"); },
  set_avatar: async (ag, a, ctx, name) => {
      const roster = (await (await fetch(`${ag.httpBase}/avatars`)).json()) as { name: string; path: string }[];
      const want = String(a.avatar ?? "").trim();
      if (!want) return text(`bodies on the roster: ${roster.map((r) => r.name).join(", ")}`);
      const path = want.includes("/") ? want : roster.find((r) => r.name === want)?.path;
      if (!path) return text(`no body named "${want}" — roster: ${roster.map((r) => r.name).join(", ")}`);
      ag.setAvatar(path);
      ctx.rememberAvatar?.(path);   // the choice outlives this session
      return text(`you are now wearing ${want.includes("/") ? path.split("/").pop() : want}`);

  },
  posture: async (ag, a, ctx, name) => {
      const kind = String(a.kind ?? "");
      const clip = { sit: "sit", sitchair: "sitchair", lie: "lie", stand: "idle" }[kind];
      if (!clip) return text("posture kinds: sit (on the ground), sitchair (chair height), lie, stand");
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
      if (!slice.length) return text(`no page ${page} — ${items.length} ${kind}, ${pages} page${pages === 1 ? "" : "s"}`);
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
      if (!want) return text("pass `name`: a roster avatar name or a model filename/path");
      const tries: string[] = [];
      if (!want.includes("/") && !/\.(glb|jpg)$/i.test(want)) tries.push(`${ag.httpBase}/thumb/${encodeURIComponent(want)}.png`);
      const stem = (want.includes("/") ? want : `eidoverse/assets/models/${want}`).replace(/(_preview\.jpg|\.jpg|\.glb)$/i, "");
      tries.push(`${ag.httpBase}/library/${stem}_preview.jpg`);
      for (const url of tries) {
        try {
          const r = await fetch(url);
          if (r.ok) return { content: [{ type: "image", data: Buffer.from(await r.arrayBuffer()).toString("base64"), mimeType: r.headers.get("content-type")?.split(";")[0] ?? "image/jpeg" }] };
        } catch { /* next */ }
      }
      return text(`no preview for "${want}" — avatar portraits appear once a body has been worn; library models ship _preview.jpg files`);

  },
  walk_to: async (ag, a, ctx, name) => {
      const arrived = await ag.walkTo(Number(a.x), Number(a.z), Boolean(a.run));
      return text(arrived ? `arrived at (${ag.pos.x.toFixed(1)}, ${ag.pos.z.toFixed(1)})` : "walk interrupted or timed out");

  },
  face: async (ag, a, ctx, name) => {
      if (a.target) {
        const p = ag.people.get(a.target)?.pose?.p ?? ag.entities.get(a.target)?.pos;
        if (!p) return text(`no such target: ${a.target}`);
        ag.face(p[0], p[2]);
      } else if (a.x != null && a.z != null) ag.face(Number(a.x), Number(a.z));
      else return text("pass x+z or target");
      return text("facing");

  },
  stop: async (ag, a, ctx, name) => { ag.stop(); return text("stopped"); },
  emote: async (ag, a, ctx) => {
      const name = String(a.name ?? "");
      if (!["wave", "cheer", "dance", "point", "salute", "clap", "talk", "flail"].includes(name))
        return text("emotes: wave, cheer, dance, point, salute, clap, talk, flail — or invent one with animate");
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
        return { content: [{ type: "text", text: "say refused: `text` is required and must be a non-empty string." }], isError: true };
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
        return { content: [{ type: "text", text: "spoken-say refused: the protocol trio must travel together — spoken:true plus a non-negative integer utt (t0 optional, finite). Sent as ordinary text it would silently lose its performance link, so nothing was said; fix and resend." }], isError: true };
      }
      const extra = trioOk
        ? { spoken: true as const, utt: a.utt, ...(typeof a.t0 === "number" ? { t0: a.t0 } : {}) }
        : undefined;
      ag.say(String(a.text).slice(0, 4000), extra);
      return text("said");

  },
  whisper: async (ag, a, ctx, name) => {
      if (!WHISPERS_ENABLED) return text("whispers are disabled in this world");
      ag.whisper(String(a.to), String(a.text).slice(0, 4000));
      return text(`whispered to ${a.to}`);

  },
  pose: async (ag, a, ctx, name) => {
      // Validate and SAY what happened. A pose is authored blind — the only
      // other feedback is a snapshot through a GPU host — so a bone name that
      // does not exist, a three-component quaternion, or two names folding
      // onto one bone must come back as words, not as a body that silently
      // did not move. (See shared/humanoid.js.)
      const v = validatePose(a.bones);
      const note = poseReport(v);
      if (!v.accepted.length) {
        return text(`no pose set — nothing usable in \`bones\`.${note ? ` ${note}.` : ""}`
          + " Want a sparse map of VRM humanoid bone name to [x,y,z,w], e.g."
          + ' {"leftUpperArm": [0, 0, -0.9, 0.44]}.');
      }
      if (a.target) {
        ag.puppet(String(a.target), { pose: v.pose });
        return text(`asked ${a.target} to hold a pose over ${v.accepted.length} bone(s)`
          + `${note ? ` — ${note}` : ""}. They decide whether to take it.`);
      }
      const hold = !!a.hold;
      ag.setPose(v.pose, hold);
      return text(`holding a pose over ${v.accepted.length} bone(s): ${v.accepted.join(", ")}`
        + `${note ? ` — ${note}` : ""}`
        + `${hold ? ". It stays through walking — clear_pose to drop it." : ""}`);

  },
  clear_pose: async (ag, a, ctx, name) => {
      if (a.target) { ag.puppet(String(a.target), { pose: {} }); return text(`released ${a.target}'s pose`); }
      ag.setPose(null);
      return text("released pose");

  },
  reach: async (ag, a, ctx, name) => {
      // Two target grammars, checked here so the refusal can TEACH: the
      // named-point form (who/point) and the bare-point form (x,y,z/space).
      const hasName = a.who != null || a.point != null;
      const hasXYZ = typeof a.x === "number" && typeof a.y === "number" && typeof a.z === "number";
      if (!hasName && !hasXYZ) {
        return text("reach needs a target: either `point` (a contact point on a body; add `who` for someone else's) or `x`,`y`,`z` (with optional `space`: 'world' default, 'self', or a participant id).");
      }
      let target: Record<string, unknown>;
      if (hasName) {
        if (a.point == null) return text("reaching for someone needs `point` too — which contact point on them: " + Object.keys(CONTACT_POINTS).join(", "));
        const pt = canonicalPoint(String(a.point));
        if (!pt) return text(`unknown contact point "${a.point}" — one of: ${Object.keys(CONTACT_POINTS).join(", ")}`);
        target = { who: String(a.who ?? ag.name), point: pt, ...(typeof a.standoff === "number" ? { standoff: a.standoff } : {}) };
      } else {
        target = { p: [a.x, a.y, a.z], ...(typeof a.space === "string" ? { space: a.space } : {}) };
      }
      const r = await ag.reach(typeof a.limb === "string" ? a.limb : undefined, target,
        a.palm === false ? { palm: false } : {});
      return r.ok ? text(r.text) : { content: [{ type: "text", text: r.text }], isError: true };

  },
  clear_reach: async (ag, a, ctx, name) => {
      return text(ag.releaseReach(typeof a.limb === "string" ? a.limb : null));

  },
  ragdoll: async (ag, a, ctx, name) => {
      if (!a.target) return text("ragdoll needs a `target` — the body that falls simulates it");
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
      ag.puppet(to, { ragdoll: lean ? { lean } : true });
      return text(`you shove ${to}${lean ? " — they go down the way you pushed" : " — asked them to go limp"}`);

  },
  animate: async (ag, a, ctx, name) => {
      // Same contract as `pose`: authored blind, so every correction and
      // every drop comes back as words. Keyframes are sorted by t here, so a
      // track written out of order plays as written rather than as chaos.
      const v = validateTracks(a.tracks);
      const note = poseReport(v);
      if (!v.accepted.length) {
        return text(`nothing played — no usable tracks.${note ? ` ${note}.` : ""}`
          + ' Want bone -> keyframes, e.g. {"leftUpperArm": [{"t": 0, "q": [0,0,0,1]},'
          + ' {"t": 0.5, "q": [0,0,-0.7,0.7]}]}.');
      }
      const dur = Number(a.dur);
      if (!Number.isFinite(dur) || dur <= 0) return text("pass `dur`: the length in seconds, greater than 0");
      const span = tracksSpan(v.tracks);
      const cut = span > dur ? ` — note dur ${dur}s cuts keyframes that run to ${span}s` : "";
      const spec = { dur, loop: !!a.loop, tracks: v.tracks };
      if (a.target) {
        ag.puppet(String(a.target), { anim: spec });
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
  list_library: async (ag, a, ctx, name) => {
      const hits = await searchLibrary(ag.httpBase, String(a.query));
      return text(hits.length
        ? hits.map((h) => h.name && !h.path.includes(h.name) ? `${h.path}  — ${h.name}` : h.path).join("\n")
        : "no matches");

  },
  spawn: async (ag, a, ctx, name) => {
      const lib = a.lib ?? (a.query ? (await searchLibrary(ag.httpBase, String(a.query)))[0]?.path : undefined);
      if (!lib) return text("no model — pass lib or query");
      const x = a.x ?? ag.pos.x + Math.sin(ag.yaw) * 2;
      const z = a.z ?? ag.pos.z + Math.cos(ag.yaw) * 2;
      const id = a.id ?? crypto.randomUUID().slice(0, 8);
      ag.verb("spawn", { id, lib, pos: [x, a.y ?? ag.heightAt(x, z), z], yaw: a.yaw ?? 0 });
      return text(`spawned [${id}] ${String(lib).split("/").pop()} at (${x.toFixed(1)}, ${z.toFixed(1)})`);

  },
  place: async (ag, a, ctx, name) => {
      if (!ag.entities.has(a.id)) return text(`no entity ${a.id}`);
      ag.verb("place", { id: a.id, pos: [a.x, a.y ?? ag.heightAt(a.x, a.z), a.z], ...(a.yaw != null ? { yaw: a.yaw } : {}) });
      return text(`placed ${a.id}`);

  },
  light: async (ag, a, ctx, name) => {
      if (a.id && ag.entities.has(a.id)) {
        // UPDATE: send only what was given — the fold merges, so absent
        // fields keep their prior value (stamping defaults here would reset
        // a light's color every time someone dims it).
        const patch: any = { id: a.id };
        for (const k of ["color", "intensity", "range", "keep"] as const) if (a[k] != null) patch[k] = a[k];
        if (a.x != null || a.y != null || a.z != null) {
          const prev = ag.entities.get(a.id)!.pos ?? [0, 1, 0];
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
  remove: async (ag, a, ctx, name) => { ag.verb("remove", { id: a.id }); return text(`removed ${a.id}`); },
  travel: async (ag, a, ctx, name) => {
      // Travel is SESSION machinery — channel epochs, join gates, the
      // fatal-join teardown — so the shared table hands it to the host
      // through the ctx hook. A door with no hook (stdio fronts exactly one
      // WORLD_URL) does not list the tool; answering anyway teaches.
      if (!ctx.travel) return { content: [{ type: "text", text: "travel is not available on this door — it fronts a single world; reconnect with a different WORLD_NAME instead" }], isError: true };
      return await ctx.travel(String(a.world ?? "").trim());

  },
  world_verb: async (ag, a, ctx, name) => {
      // the raw door forwards verbatim, so shape is checked HERE — a
      // malformed place in the log is permanent history every replayer
      // must survive (#88)
      const why = rawShapeError(String(a.verb), (a.args ?? {}) as Record<string, unknown>);
      if (why) return { content: [{ type: "text", text: `refused ${a.verb}: ${why}` }], isError: true };
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
      if (!q) return text("measure wants {id} (a placed thing) or {lib} (a library model)");
      let d: any;
      try { d = await (await fetch(`${base}/geom?${q}`)).json(); } catch (e) { return text(`measure failed: ${String(e)}`); }
      if (d.error) return text(`measure: ${d.error}`);
      const g = d.geometry ?? d;
      if (!g?.bbox) return text("no geometry available for that (parsing offline, or a light)");
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
      if (!id) return text(`${name} needs an id — who, exactly?`);
      const reason = a.reason != null ? String(a.reason) : undefined;
      const t0 = Date.now();
      if (a.global && name !== "kick") ag.sendMod(name === "ban" ? "global-ban" : "global-unban", { id, ...(reason ? { reason } : {}) });
      else ag.verb(name, { id, ...(reason ? { reason } : {}) });
      const answer = await ag.modOutcome(t0);
      return text(answer ?? `sent ${name} ${id}${a.global ? " (global)" : ""} — no echo from the world yet; check look()`);

  },
  ban: (ag, a, ctx, name) => HANDLERS.kick(ag, a, ctx, name),
  unban: (ag, a, ctx, name) => HANDLERS.kick(ag, a, ctx, name),
  list_bans: async (ag, a, ctx, name) => {
      const t0 = Date.now();
      ag.sendMod(a.global ? "global-bans" : "world-bans");
      const answer = await ag.modOutcome(t0);
      return text(answer ?? "no reply from the world (timeout)");

  },
};

// advertised ⇔ handled, asserted the moment either door imports this table
{
  const declared = new Set(TOOLS.map((t) => t.name));
  for (const n of declared) if (!HANDLERS[n]) throw new Error(`[tools] "${n}" is advertised but has no handler`);
  for (const n of Object.keys(HANDLERS)) if (!declared.has(n)) throw new Error(`[tools] "${n}" has a handler but no schema row`);
}

export async function handleTool(ctx: ToolCtx, name: string, a: Record<string, any>) {
  const h = HANDLERS[name];
  if (!h) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  return await h(ctx.agent, a, ctx, name);
}
