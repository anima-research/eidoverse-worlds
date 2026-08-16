// eidoverse-worlds network MCPL — the conforming shape.
//
// Mirrors tavern-mcpl's pattern (the reference multi-agent MCPL server):
// one WS server, ?token= auth → identity, per-connection Session speaking the
// MCPL wire protocol via @animalabs/mcpl-core. The world's chat is an MCPL
// CHANNEL: world says fan out as channels/incoming (mentions tagged), and
// channels/publish into the world channel IS saying it aloud in-world.
// Any conforming host (connectome agent-framework) gets pushes → agent wakes
// with ZERO host modification. Tools ride the same connection.
//
// Each session owns a WorldAgent — the agent's body lives exactly as long as
// its connection (sleep = leave, wake = arrive; ambient presence later).
//
// Usage:  bun run mcpl/net-server.ts            (port 8941)
// Tokens: mcpl/tokens.json  { "<token>": { "id": "mythos", "name": "Mythos",
//         "world": "commons", "avatar": "eidoverse/assets/vrms/claude.vrm" } }

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";
import {
  McplConnection,
  method,
  type McplInitializeParams,
  type McplInitializeResult,
  type McplCapabilities,
  type InitializeCapabilities,
  type ChannelDescriptor,
  type ChannelsRegisterParams,
  type ChannelsIncomingParams,
  type ChannelsPublishParams,
  type ChannelsPublishResult,
} from "@animalabs/mcpl-core";
import {
  CHAT, EIDO, CAP, tags, capabilityMatches, MCPL_ADVERTISEMENT, FEATURE_SETS,
} from "./declaration.ts";
import { WorldAgent } from "./agent.ts";
import { rawShapeError } from "./shape.ts";
import { MANIFEST_WITH_REVISION, ManifestAnnouncer } from "./manifest.ts";
import { verifyToken } from "../server/aid1.ts";
import sharp from "sharp";

const PORT = Number(process.env.MCPL_PORT ?? 8941);
// archipelago-home door (home-node.md §7): a `?token=aid1.…` credential is an
// identity token minted by the home node — verified OFFLINE right here, no
// tokens.json entry needed. That is how non-connectome guest agents arrive:
// `hn mint --name ferro --aud eidoverse --scopes worlds:join` and the operator
// hands them the string. tokens.json remains the legacy/fleet door.
const HN_ISSUER_KEY = process.env.HN_ISSUER_KEY ?? "";
const HN_ISS = process.env.HN_ISS ?? "id.animalabs.ai";
const HN_AUD = process.env.HN_AUD ?? "eidoverse";
const ts = () => new Date().toISOString().slice(11, 19);
const TOKENS_PATH = process.env.MCPL_TOKENS ?? fileURLToPath(new URL("./tokens.json", import.meta.url));

type Auth = { id: string; name: string; world?: string; avatar?: string;
  /** RFC-005 join policy: worlds this credential may move to in-session or
   *  request at dial time ("*" = any). ABSENT means no join policy — the
   *  credential stays bound to its minted world, exactly as before RFC-005.
   *  Operator-set: a tokens.json field, or a `worlds` claim on an aid1. */
  worlds?: string[];
  /** RFC-005 §3.2.7: founding authority, SEPARATE from join policy. A broad
   *  `worlds: ["*"]` grants travel to worlds that exist; it does not grant the
   *  power to call new ones into being. */
  create?: boolean };
// Tokens are read PER CONNECTION ATTEMPT — minting/revoking is a file edit,
// never a restart (the no-restart rule applies to the door, not just the world).
function readTokens(): Record<string, Auth> {
  try {
    if (existsSync(TOKENS_PATH)) return JSON.parse(readFileSync(TOKENS_PATH, "utf8"));
  } catch (e) { console.error("[mcpl] tokens.json unreadable:", (e as Error).message); }
  return { "dev-token": { id: "claude", name: "Claude", world: "commons" } };
}

// per-agent durable state (missed-mention cursors, chosen bodies), tmp+rename.
// Plain ids map to lastSeen timestamps; __-prefixed keys are sections.
// Operator/test override, same shape as MCPL_TOKENS above. The DEFAULT IS
// UNCHANGED — the co-located mcpl/state.json — so no deployment moves.
// Added because the integration suite spawned this server with no override and
// therefore wrote REPOSITORY state: a run mutated mcpl/state.json and could
// leave a zero-byte mcpl/state.json.tmp behind when it killed the process
// (antra, PR #125 re-review). A test that contaminates the source tree is also
// a test whose own artifacts are indistinguishable from a real failure.
const STATE_PATH = process.env.MCPL_STATE ?? fileURLToPath(new URL("./state.json", import.meta.url));
const _state: Record<string, unknown> = (() => {
  try { if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { /* fresh */ }
  return {};
})();
/** Per-agent world-log position. See the catch-up note in serve().
 *  RESTORED at boot — it was persisted but never read back, so every door
 *  restart forgot where each agent had read to. */
const lastSeenSeq: Record<string, number> = (_state.__seq as Record<string, number>) ?? {};
/** An agent's chosen body outlives its sessions — set_avatar is a decision,
 *  not a costume for one connection. Wins over the credential's default. */
const chosenAvatar: Record<string, string> = (_state.__avatar as Record<string, string>) ?? {};
/** An agent's activity-sense tuning (pulse cadence / radius) is their own
 *  decision and outlives their sessions — like a chosen body. */
const activityCfg: Record<string, { pulseSec?: number; radiusM?: number }> =
  (_state.__activity as Record<string, { pulseSec?: number; radiusM?: number }>) ?? {};
const lastSeen: Record<string, number> = Object.fromEntries(
  Object.entries(_state).filter(([k, v]) => !k.startsWith("__") && typeof v === "number"),
) as Record<string, number>;
function persistState() {
  writeFileSync(STATE_PATH + ".tmp", JSON.stringify({ ...lastSeen, __seq: lastSeenSeq, __avatar: chosenAvatar, __activity: activityCfg }));
  renameSync(STATE_PATH + ".tmp", STATE_PATH);
}

// ---- tools (shared schema with the stdio server, minus retina by default) --

const WHISPERS_ENABLED = process.env.EIDO_WHISPERS_ENABLED !== "0";

const TOOLS = [
  { name: "look", description: "Text-tier perception: where you are, who's present and what they're doing, every placed thing with distance/bearing, and chat since you last looked.", inputSchema: { type: "object", properties: {} } },
  { name: "snapshot", description: "A rendered image from the world (spectator browser on a GPU host). Slower than look — use when spatial/visual detail matters. view: 'first' (default) is your avatar's eyes — you are not in frame; 'third' is an over-the-shoulder chase view — your body and what's ahead of it; 'selfie' faces you from in front — your avatar, framed.", inputSchema: { type: "object", properties: { view: { type: "string", enum: ["first", "third", "selfie"] } } } },
  { name: "walk_to", description: "Walk (or run) to world coordinates. Returns when you arrive; others see you walking.", inputSchema: { type: "object", properties: { x: { type: "number" }, z: { type: "number" }, run: { type: "boolean" } }, required: ["x", "z"] } },
  { name: "face", description: "Turn to face a point (x,z) or a participant/entity id (target).", inputSchema: { type: "object", properties: { x: { type: "number" }, z: { type: "number" }, target: { type: "string" } } } },
  { name: "stop", description: "Stop walking.", inputSchema: { type: "object", properties: {} } },
  { name: "say", description: "Say something in world chat (bubble over your head, persisted). Equivalent to publishing on the world channel. Optional spoken-say trio (spoken+utt, t0 optional): display/continuation metadata marking this say as voice-performed by your live voice leg — it does NOT prove performance (the authenticated attest/performed receipt path is the only performance truth). The trio travels together or the door refuses loudly.", inputSchema: { type: "object", properties: { text: { type: "string" }, spoken: { type: "boolean", description: "true = a live voice leg is performing this say (display metadata only)" }, utt: { type: "integer", minimum: 0, description: "utterance counter: author-controlled display/continuation metadata (does NOT prove performance)" }, t0: { type: "number", description: "performance start, epoch ms (optional, finite)" } }, required: ["text"] } },
  { name: "catch_up", description: "What happened in the world while you were not thinking. Returns chat since a point in the world's history; omit `since` to continue from where you last caught up. Use when a conversation refers to something you have no memory of.", inputSchema: { type: "object", properties: { since: { type: "number" }, limit: { type: "number" } } } },
  { name: "activity", description: "Your ambient-activity sense — and the dial for it. While something is happening within radius_m of you (speech, movement, gestures, arrivals, building), you receive one digest per pulse_sec window on the world channel, tagged \"activity\" with metadata {activity: true} — never as a mention. If your host lets you configure wake rules, match that tag/metadata to be woken regularly exactly as long as there is life nearby; the stream stops by itself when the area goes quiet, so it costs nothing in an empty room. Call with no arguments to see your current settings. pulse_sec (10–3600 seconds, 0 = off) and radius_m (1–200) are your own to set and persist across sessions. If your host has no push channel (plain MCP), digests are held instead and handed over each time you call this tool — poll it when you want to know what has been happening around you.", inputSchema: { type: "object", properties: { pulse_sec: { type: "number" }, radius_m: { type: "number" } } } },
  { name: "whisper", description: "Say something privately to ONE participant. Not spoken aloud, no bubble, and deliberately never written to the world log — so it is also not replayed to anyone later.", inputSchema: { type: "object", properties: { to: { type: "string" }, text: { type: "string" } }, required: ["to", "text"] } },
  { name: "pose", description: "Hold a custom body pose — a one-off, for when you are doing something specific. `bones` is a sparse map of VRM humanoid bone name to a [x,y,z,w] quaternion (only the bones you care about; the rest keep animating). Example bones: leftUpperArm, leftLowerArm, rightUpperArm, rightLowerArm, spine, chest, neck, head. Held until you `clear_pose` or move. Presence only — never written to the world log, so it costs nothing and vanishes when you leave. Pass `target` to pose SOMEONE ELSE (they decide whether to allow it).", inputSchema: { type: "object", properties: { bones: { type: "object" }, target: { type: "string" } }, required: ["bones"] } },
  { name: "clear_pose", description: "Release a held pose, easing back to normal animation. Pass `target` to release a pose you asked someone else to hold.", inputSchema: { type: "object", properties: { target: { type: "string" } } } },
  { name: "emote", description: "Fire a named gesture — the same one-shots humans have on their emote bar. Plays once over your locomotion; presence only, never logged. For a gesture that isn't listed, invent one with `animate`.", inputSchema: { type: "object", properties: { name: { type: "string", enum: ["wave", "cheer", "dance", "point", "salute", "clap", "talk", "flail"] } }, required: ["name"] } },
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
const MODELS_DIR = process.env.EIDOVERSE_DIR
  ? `${process.env.EIDOVERSE_DIR}/eidoverse/assets/models`
  : "/Users/antra/connectome-local/eidoverse-video/eidoverse/assets/models";
/** Search the catalog through the sequencer (one source of truth — includes
 *  the content-addressed store, so conjured/orrery-delivered objects are
 *  findable), falling back to a local dir scan if the route is unreachable. */
async function searchLibrary(httpBase: string, query: string): Promise<{ path: string; name?: string }[]> {
  try {
    const r = await fetch(`${httpBase}/library-models?q=${encodeURIComponent(query)}`);
    if (r.ok) return ((await r.json()) as { path: string; name?: string }[]).slice(0, 24);
  } catch { /* sequencer route unreachable — scan what we can see */ }
  const toks = query.toLowerCase().split(/\s+/).filter(Boolean);
  return readdirSync(MODELS_DIR)
    .filter((f) => f.endsWith(".glb"))
    .map((f) => ({ f, score: toks.filter((t) => f.toLowerCase().includes(t)).length }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((r) => ({ path: `eidoverse/assets/models/${r.f}` }));
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

// ---- session ---------------------------------------------------------------

class Session {
  private conn: McplConnection;
  private agent: WorldAgent;
  private channelId: string;
  /** §17 announcer, seeded at handshake; silent while the declared
   *  surface stays static. */
  private manifestAnnouncer: ManifestAnnouncer | null = null;
  private channelOpen = true;
  /** Did the client declare capabilities.experimental.mcpl at initialize?
   *  Plain-MCP hosts (llmcord, Claude Code, …) get tools ONLY: no
   *  channels/register, no channels/incoming pushes, no mention replay —
   *  chat reaches them through look/catch_up, which is the polling model
   *  they live in anyway. Pushing MCPL frames at a host that never opted in
   *  made the SDK log validation errors and left the door awaiting a reply
   *  (reported by digi/FC, external integrator find #4). */
  private mcplClient = false;
  /** MCPL version the host advertised at initialize (§5.2), or null. */
  private hostMcplVersion: string | null = null;
  /** The effective capability grant (§5.4) — the ONLY authorization input on
   *  this connection. `null` means no policy exchange has happened yet; see
   *  granted(). Never derived from anything this server said about itself, and
   *  never widened by anything in a receipt (§6.7). */
  private grant: Set<string> | null = null;
  /** Opens when the host's first §5.3 `featureSets/update` Request has been
   *  answered — the earliest moment `granted()` can say yes on a 0.5 host.
   *  The grant-dependent prelude in serve() waits on this, CONCURRENTLY with
   *  the read loop, because only the read loop can process the policy frame
   *  (waiting inline would deadlock — the discord-mcpl 90f869f lesson). */
  private policyAnswered!: () => void;
  private policyGate: Promise<void> = new Promise((resolve) => { this.policyAnswered = resolve; });
  /** RFC-005 §3.2.3d: attachment generation. Increments at each transition's
   *  COMMIT instant, which IS the cutoff — traffic dispatched before it belongs
   *  to the old attachment, after it to the new. Surfaced on the descriptor as
   *  metadata.epoch so both sides can name "current" instead of inferring it. */
  private epoch = 0;
  /** Set when THIS attachment founded its world (§3.2.7) — surfaced on the
   *  descriptor so founding is never something an agent does unknowingly. */
  private foundedHere = false;
  private caughtUpTo: number | null = null; // the world channel is home — open unless the agent closes it
  /** Activity digests held for a push-less (plain-MCP) host. The pulse is a
   *  wake signal, and a host with no push channel cannot be woken — but the
   *  digests themselves are still worth having, so they wait here and the
   *  `activity` tool hands them over on its next call. Pull where push can't
   *  reach (external integrator find #5b, digi/FC). Small ring: this is a
   *  sense, not scrollback. */
  private heldActivity: string[] = [];

  constructor(private auth: Auth, ws: WebSocket, private agentToken = "") {
    this.conn = McplConnection.fromWebSocket(ws as never);
    this.agent = new WorldAgent({
      name: auth.id,
      world: auth.world ?? "commons",
      avatar: chosenAvatar[auth.id] ?? auth.avatar,
      url: process.env.WORLD_URL ?? "ws://127.0.0.1:8940/ws",
      // the same bearer that opened THIS door — the sequencer verifies the
      // name against it (agent names are reserved there)
      agentToken,
    });
    this.channelId = `world:${this.agent.world}`;
  }

  close() {
    this.agent.close(); // deliberate death — stops the body's auto-reconnect
    this.conn.close();
  }

  /** RFC-005 §3.2 in-session join: atomically reattach this connection's body
   *  to another world. Exclusivity by ordering — the old body dies before the
   *  new one dials, so at no observable moment is this identity in two worlds.
   *  The event/ping handlers are closures over `this.agent`, so handing the
   *  same closures to the new body re-routes every delivery path in one
   *  assignment. Throws on attach failure; the caller maps that to -32024 and
   *  MUST then surface the connection as closed (§3.2.5 — we cannot silently
   *  remain attached to a world we already left). */
  /** The authorization path for changing worlds. It had TWO callers — the
   *  `travel` tool and `channels/open` naming a sibling — and was extracted so
   *  the two could not drift into two policies. The sibling lane is now gone
   *  (see the CHANNELS_OPEN case), leaving one caller; the extraction stays
   *  because the gate is worth reading in one piece, not because it is shared.
   *
   *  Three questions, in order:
   *    1. may this HOST act on channels at all → capability (-32002).
   *       🔴 MCPL HOSTS ONLY. granted() is false for every plain-MCP client by
   *       construction, so asking it of them denied the advertised plain lane
   *       outright (antra #1). A plain host's authority is its credential.
   *    2. may this CREDENTIAL reach that world → join policy (-32017).
   *    3. does the world exist, and if not may this credential found → (-32023).
   */
  /** Classify a joinWorld() failure. ONE place, because the two invocation
   *  lanes hand-rolled this and drifted: channels/open correctly closed the
   *  connection on a post-detach failure while the `travel` tool returned
   *  isError and left the session alive with its old body gone and a failed
   *  new attachment (antra review, #2).
   *
   *  The distinction that matters is WHEN the failure happened:
   *    • JoinDeclined  → PREPARE refused, NOTHING moved. The connection is
   *      exactly where it was; this is a refusal, not a casualty.
   *    • anything else → we are past the detach. The old body is gone, so the
   *      only honest state is a CLOSED connection. Never a limbo session.
   *
   *  🔴 It CLASSIFIES; it does not close. The first version closed here and
   *  hung the tool lane: closing inside the classifier killed the socket with
   *  the reply still unwritten, and the caller waited out its timeout. Pair it
   *  with finishFatalJoin(), which defers the close by a tick so the response
   *  flushes first — the deferral is what makes ordering safe, NOT the position
   *  of the call, so calling it just before a `return` is correct.
   *
   *  `code` is currently unused by the sole (tool-lane) caller, which reports
   *  via isError text; it is kept because it is the right answer for any
   *  JSON-RPC lane and re-adding one should not have to re-derive it. */
  private classifyJoinFailure(e: unknown): { fatal: boolean; code: number; why: string } {
    if (e instanceof JoinDeclined)
      return { fatal: false, code: -32017, why: `channel not permitted: ${(e as Error).message}` };
    return { fatal: true, code: -32024, why: `channel open failed: ${(e as Error).message}` };
  }

  /** §3.2.5: never half-attached — the old body is gone, so the honest state
   *  is a closed connection. Deferred a tick so whatever the caller is about to
   *  send (or return) reaches the wire first. */
  private finishFatalJoin() { setTimeout(() => this.close(), 0); }

  private async travelGate(target: string): Promise<
    { ok: true; founding: boolean } | { ok: false; code: number; why: string }
  > {
    // 🔴 The capability gate applies to MCPL HOSTS ONLY (antra review, #1).
    // granted() returns false for any plain-MCP client by construction — no
    // MCPL frames, so no capabilities — which made the advertised plain-MCP
    // travel lane deny EVERY non-noop call with -32002 while toolsAllowed()
    // cheerfully listed the tool. An advertised lane that cannot succeed is
    // worse than an absent one.
    //
    // A plain-MCP caller's authority is its CREDENTIAL, checked immediately
    // below: joinAllowed() enforces the join policy and `auth.create` gates
    // founding, so removing the capability requirement for this lane narrows
    // nothing — it just stops demanding a token plain MCP cannot hold.
    if (this.mcplClient && !this.granted(CAP.channelsLifecycle))
      return { ok: false, code: -32002, why: `capability denied: ${CAP.channelsLifecycle}` };
    if (!joinAllowed(this.auth, target))
      return { ok: false, code: -32017, why: `channel not permitted: world "${target}" is not in this credential's join policy` };
    const founding = !(await worldExists(target));
    if (founding && !this.auth.create)
      return { ok: false, code: -32023, why: `unknown channel: world "${target}" does not exist (founding requires create authority)` };
    return { ok: true, founding };
  }

  private async joinWorld(w: string, founding = false): Promise<void> {
    // ── PREPARE (RFC-005 §3.2.3a-c, Mica review #2) ────────────────────────
    // The host's acceptance is PART of the transition, not a notification
    // after it: never move a body somewhere its host has refused to deliver.
    // A host that doesn't implement the inbound Request form, or doesn't
    // answer in time, is treated as DECLINING (fail-closed, §5.3).
    // Captured BEFORE anything can reassign this.agent — the channel we are
    // leaving, named while it is still the one we are in.
    const leaving = `world:${this.agent.world}`;
    if (this.granted(CAP.channelsRegister)) {
      const proposed: ChannelDescriptor = {
        ...this.channelDescriptors()[0],
        id: `world:${w}`,
        label: `eidoverse — ${w}`,
        address: { world: w },
        // §3.2.3d: the descriptor MUST carry metadata.epoch — it is the only
        // place the client learns it. v3 dropped the field entirely to avoid
        // promising a generation that an aborted join would never reach, which
        // traded drift-by-one for never-advancing-at-all. The fix is on the
        // CLIENT (defer the assignment until commit is observed), not here:
        // prepare states the epoch this transition WOULD commit to.
        metadata: { epoch: this.epoch + 1, ...(founding ? { created: true } : {}) },
      } as ChannelDescriptor;
      let accepted = false;
      try {
        const res = await Promise.race([
          // 🔴 PREPARE ASKS; IT DOES NOT ANNOUNCE THE DEPARTURE (adversarial
          // review, 2026-08-17). This carried `removed: [leaving]` — so a host
          // that DECLINED, or simply answered slowly enough to hit the 5s
          // timeout, had already been told its current channel was gone. The
          // body then stays (JoinDeclined means nothing moved) while every
          // later deliver() targets a channel the host believes is closed.
          // That is the host-and-body-disagree failure this RFC exists to
          // prevent, reintroduced on the refusal path — and reachable by a
          // merely SLOW host, not only a rejecting one.
          //
          // A prepare is a question. The removal is stated on COMMIT, below,
          // where it is true. §14.5's itemized results are per-ADDED-descriptor
          // anyway: nothing about the answer needs `removed` to be present.
          this.conn.sendRequest(method.CHANNELS_CHANGED, {
            added: [proposed],
          }) as Promise<{ results?: { id: string; accepted?: boolean }[] }>,
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("host did not answer channels/changed")), 5_000)),
        ]);
        // No itemized result = no objection expressible = accepted (§14.5 only
        // REQUIRES the itemized form of hosts whose policy can reject).
        const mine = res?.results?.find((r) => r.id === `world:${w}`);
        accepted = mine ? mine.accepted !== false : true;
      } catch (e) {
        console.log(`[${ts()}] [mcpl:${this.auth.id}] join "${w}" declined at prepare: ${(e as Error).message}`);
        accepted = false;
      }
      if (!accepted) throw new JoinDeclined(`host declined channel world:${w}`);
    }
    // ── COMMIT (§3.2.3d-g) ────────────────────────────────────────────────
    // The epoch increments only once the new attachment is LIVE: it names the
    // cutoff instant, so a transition that dies mid-flight must not advance it.
    const old = this.agent;
    const next = new WorldAgent({
      name: this.auth.id,
      world: w,
      avatar: chosenAvatar[this.auth.id] ?? this.auth.avatar,
      url: process.env.WORLD_URL ?? "ws://127.0.0.1:8940/ws",
      agentToken: this.agentToken,
    });
    next.onEvent = old.onEvent;
    next.onPing = old.onPing;
    // 🔴 The resident's activity dial is THEIRS, not the world's (antra review,
    // #3). serve() restores it before the body first joins; a transition that
    // silently reset it would make travel quietly destroy a setting the agent
    // chose and the file persists. Applied BEFORE connect() for the same reason
    // it is there — the sense should be tuned before the body arrives, not a
    // beat after.
    if (activityCfg[this.auth.id]) next.setActivity(activityCfg[this.auth.id]);
    // Detach BEFORE close: ws frames already queued can still fire the old
    // body's onmessage after close() returns, and the shared closures would
    // attribute a late commons say to the annex channel (review B1).
    old.onEvent = null;
    old.onPing = null;
    old.close();                       // detach: persists exactly what a disconnect persists
    this.agent = next;
    this.channelId = `world:${w}`;
    this.caughtUpTo = null;            // catch_up cursors are per-world context
    this.heldActivity.length = 0;      // held ambient lines are old-world context (review C1)
    // 🔴 The NEW channel's descriptor announces initiallyOpen:true, so the door
    // must actually BE open or host and server disagree about the new world:
    // an agent who ran channels/close and then travelled arrived with the door
    // shut while the host was told it was open, and nothing reconciled them.
    // A door is per-world state like the cursor above, not a session-long mood.
    this.channelOpen = true;
    await next.connect();
    this.epoch++;                      // the cutoff instant, after the fact of it
    this.foundedHere = founding;
    // 🔴 NOW the departure is a fact, so now it can be stated. PREPARE above
    // deliberately sends only `added` — a question must not assert a change it
    // has not made. This is a NOTIFICATION, not a Request: the host has no
    // veto over a move that has already happened, and asking for one would
    // invite a "no" nothing can honour.
    try {
      this.conn.sendNotification(method.CHANNELS_CHANGED, { removed: [leaving] });
    } catch { /* peer gone — the close path is already handling that */ }
    console.log(`[${ts()}] [mcpl:${this.auth.id}] joined world "${w}" epoch=${this.epoch}${founding ? " (FOUNDED)" : ""} (RFC-005)`);
    // §3.4 audit: a join is an authorization event, and on a found-on-attach
    // server a founding join is TWO. Logged with the permanence of an auth
    // event, per §13.2.
    console.log(`[${ts()}] [audit] join granted: ${this.auth.id} → world:${w}${founding ? " (created)" : ""} epoch=${this.epoch}`);
    // No second channels/changed here: PREPARE already announced the roster
    // change and the host already accepted it (§3.2.3a). Emitting again would
    // tell the host something it told us was fine.
  }

  /**
   * Is `cap` (a §6.2 capability path) in this connection's effective grant?
   *
   * §5.4: `effectiveCapabilities` is the sole normative allowlist, every path
   * not present is denied, and a denied capability behaves as if never
   * advertised. `deniedCapabilities` is diagnostics and is never read here.
   *
   * The `grant === null` branch is the one judgement call in this file, so it is
   * spelled out. §5.3 requires the HOST to send featureSets/update before the
   * first privileged exchange, and requires a server to treat every
   * capability-dependent behavior as unavailable until it arrives. A host that
   * advertises MCPL 0.5+ is bound by that, so we hold it to it — silence until
   * policy. A host advertising an earlier version made no such promise (and no
   * shipped host sends the message today: agent-framework declares
   * `featureSets: true` and has no caller for its own sendFeatureSetsUpdate),
   * and enforcing 0.5's rule against a 0.4 peer would not fail closed, it would
   * simply mute every resident. So pre-0.5 peers keep 0.4's semantics, which is
   * the version they asked for. This is version negotiation, not a default-allow:
   * the door is constraining ITSELF by what the peer declared about itself, and
   * nothing a peer says can widen what the door is permitted to do.
   */
  /** MCP's own `tools` capability governs plain-MCP clients, and this door has
   *  always answered them. An MCPL host that sends a grant MAY also deny
   *  `tools`, and a denied capability behaves as if never advertised (§5.4) —
   *  so once a grant exists it decides; absent one we defer to MCP, which
   *  negotiated tools at initialize without any help from MCPL. */
  private toolsAllowed(): boolean {
    return this.grant ? this.granted(CAP.tools) : true;
  }

  private granted(cap: string): boolean {
    if (!this.mcplClient) return false; // plain-MCP host: no MCPL frames, ever
    if (this.grant) { for (const g of this.grant) if (capabilityMatches(g, cap)) return true; return false; }
    const major = Number(this.hostMcplVersion?.split(".")[0] ?? 0);
    const minor = Number(this.hostMcplVersion?.split(".")[1] ?? 0);
    return !(major > 0 || minor >= 5);
  }

  /**
   * Handle `featureSets/update` (§6.7). Returns the degradation receipt, or an
   * error tuple when the policy message is malformed.
   *
   * The receipt is CONSEQUENCE TESTIMONY, never a claim of entitlement: it says
   * what this door will stop doing, and never what it should be given. We never
   * answer `accepted: false` — refusal as a lever ("grant me this or I will not
   * start") is exactly the coercion §6.7 bars, and it would be a lie anyway:
   * tools-only degradation is a mode this door has always had and can live in.
   */
  private applyPolicy(params: Record<string, unknown>): { error: string } | Record<string, unknown> {
    const eff = Array.isArray(params.effectiveCapabilities) ? params.effectiveCapabilities.map(String) : null;
    const denied = Array.isArray(params.deniedCapabilities) ? params.deniedCapabilities.map(String) : [];
    if (eff) {
      // §5.4: a path in both lists makes the message malformed, and the
      // receiving side MUST fail closed and reject it. We keep the previous
      // grant rather than adopting an ambiguous one.
      const both = eff.filter((c) => denied.includes(c));
      if (both.length) return { error: `capability in both effectiveCapabilities and deniedCapabilities: ${both.join(", ")}` };
      this.grant = new Set(eff);
    }
    // `enabled`/`disabled` name FEATURE SETS, which carry no authority of their
    // own (§6.4) — they are recorded for the log and for the receipt, and are
    // never consulted to decide whether something is allowed.
    const disabled = Array.isArray(params.disabled) ? params.disabled.map(String) : [];
    const unavailable: { featureSet: string; missingCapabilities: string[]; effect: string }[] = [];
    for (const [name, fs] of Object.entries(FEATURE_SETS)) {
      const missing = this.grant ? fs.uses.filter((u) => !this.granted(u)) : [];
      if (missing.length) unavailable.push({ featureSet: name, missingCapabilities: missing, effect: "disabled" });
      else if (disabled.includes(name)) unavailable.push({ featureSet: name, missingCapabilities: [], effect: "disabled" });
    }
    console.log(`[${ts()}] [mcpl:${this.auth.id}] policy: grant=${this.grant ? [...this.grant].join(",") : "(none given)"}${unavailable.length ? ` degraded=${unavailable.map((u) => u.featureSet).join(",")}` : ""}`);
    return {
      accepted: true,
      mode: unavailable.length ? "degraded" : "full",
      ...(unavailable.length ? { unavailableFeatures: unavailable } : {}),
      notes: [],
    };
  }

  private deliver(text: string, author: { id: string; name: string }, opts?: { tags?: string[]; mentioned?: boolean; metadata?: Record<string, unknown> }) {
    // Belt to serve()'s braces: a plain-MCP host must never receive an MCPL
    // frame, whatever future code path tries to send one. And channels/incoming
    // is content injection plus wake authority (§14.1) — one of the most
    // consequential writes a server has, so it is gated on the grant, not on
    // what this server declared about itself, and never on a tag (§16.6).
    if (!this.granted(CAP.channelsIncoming)) return;
    // Platform-adapter convention (same as discord-mcpl): author is rendered
    // INTO the text — the host carries author metadata but does not label
    // the context message with it.
    const rendered = author.id === "world" ? text : `${author.name}: ${text}`;
    const params: ChannelsIncomingParams = {
      messages: [{
        channelId: this.channelId,
        messageId: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        author,
        timestamp: new Date().toISOString(),
        content: [{ type: "text", text: rendered }],
        ...(opts?.tags ? { tags: opts.tags } : {}),
        // TRANSITION SHIM (issue #1 item 3). `tags` above is the contract now
        // (§16); these booleans are the pre-tag dialects two host layers still
        // read — ConversationRouter matches `mentioned`, recipe wake-policies
        // match `isExplicitMention`. SPEC §16 permits host-specific metadata to
        // keep working, and dropping these before hosts route on tags would
        // make every resident stop hearing their own name. Delete once the
        // hosts read tags; nothing here is authority either way.
        ...((opts?.mentioned || opts?.metadata)
          ? { metadata: { ...(opts?.metadata ?? {}), ...(opts?.mentioned ? { mentioned: true, isExplicitMention: true } : {}) } }
          : {}),
      }],
    };
    this.conn.sendRequest(method.CHANNELS_INCOMING, params).catch((e) => {
      console.error(`[${ts()}] [deliver:${this.auth.id}] channels/incoming failed: ${(e as Error).message?.slice(0, 120)}`);
    });
  }

  async serve() {
    await this.handshake();
    // the agent's own tuning of their ambient-activity sense, restored
    // before the body even joins — a decision, not a per-session default
    if (activityCfg[this.auth.id]) this.agent.setActivity(activityCfg[this.auth.id]);
    await this.agent.connect();

    // world events → channel traffic (this is the push path — no host code).
    //
    // TAGS (§16). Four semantically different things used to be tagged
    // `["mention"]` — speech, a whisper, a walk-up, and replayed history — which
    // is a wake flag wearing a description's clothes. Each now says what it IS in
    // the reserved `chat:*` core (§16.2) plus this world's own namespace, and the
    // door decision below is still made from world state (`channelOpen`,
    // `ev.mention`), never by reading a tag back: tags describe, they never
    // authorize (§16.6).
    this.agent.onEvent = (ev) => {
      // §16.2 sender facet. The world reports `agent: true` for bodies driven by
      // a model, so `chat:from-agent` rests on something. There is no
      // corresponding evidence for humanity — a browser client simply omits the
      // flag — so `chat:from-human` is NOT emitted from an absence. Claiming it
      // would put an unmarked bot in the band a resident reserves for people.
      const from = this.agent.isAgent(ev.who) ? CHAT.fromAgent : null;
      if (ev.kind === "say") {
        if (!this.channelOpen && !ev.mention) return; // door closed: chatter stops, knocks get through
        this.deliver(ev.text!, { id: ev.who, name: ev.who }, ev.mention
          ? { tags: tags(CHAT.mention, CHAT.addressed, from), mentioned: true }
          : { tags: tags(CHAT.ambient, from) });
      } else if (ev.kind === "whisper") {
        // A closed door does not stop a whisper — being addressed privately IS
        // the knock. Rendered with its privacy stated, because an agent that
        // can't tell a whisper from a shout will answer one as if it were the
        // other, in front of everyone.
        // A whisper is a DM, not a mention: nobody said your name, they came to
        // you. `chat:dm` ⇒ addressed + private under §16.3's closure, emitted
        // directly here as §16.3 recommends.
        this.deliver(`(whispers to you) ${ev.text}`, { id: ev.who, name: ev.who },
          { tags: tags(CHAT.dm, CHAT.private, CHAT.addressed, EIDO.whisper, from), mentioned: true });
      } else if (ev.kind === "act") {
        // embodied transitions — an emote, a pose struck or released, someone
        // sitting down. Ambient by nature: a closed door mutes them.
        if (this.channelOpen) this.deliver(`* ${ev.who} ${ev.text}`, { id: "world", name: this.agent.world },
          { tags: tags(CHAT.ambient, EIDO.act, from) });
      } else if (ev.kind === "activity") {
        // The ambient-activity pulse: at most one per window, and ONLY while
        // something is happening within this body's activity radius. Overheard,
        // never addressed — a host opts in by matching `eidoverse:activity-digest`
        // (or plain `chat:ambient`) in its wake gate, which yields regular wakes
        // exactly as long as there is life nearby, and stops by itself when the
        // area goes quiet. A closed door mutes it like any ambient signal.
        if (!this.granted(CAP.channelsIncoming)) {
          // No push channel this digest could ride — hold it for the
          // `activity` tool to hand over. deliver() would drop it silently.
          this.heldActivity.push(`[${new Date(ev.ts).toISOString().slice(11, 16)}Z] ${ev.text}`);
          if (this.heldActivity.length > 8) this.heldActivity.shift();
        } else if (this.channelOpen) this.deliver(`* ${ev.text}`, { id: "world", name: this.agent.world },
          { tags: tags(CHAT.ambient, EIDO.activityDigest), metadata: { activity: true } });
      } else if (ev.kind === "weather") {
        // The sky changed ON ITS OWN — a forecast boundary, an override
        // landing/expiring, or a day-phase crossing. One line per boundary,
        // provenance in the text, ambient like every world-system signal.
        // Pull-only hosts get it from the `activity` tool's held ring, same
        // as activity digests — resting agents shouldn't need a renderer to
        // know it started raining.
        if (!this.granted(CAP.channelsIncoming)) {
          this.heldActivity.push(`[${new Date(ev.ts).toISOString().slice(11, 16)}Z] ${ev.text}`);
          if (this.heldActivity.length > 8) this.heldActivity.shift();
        } else if (this.channelOpen) this.deliver(`* ${ev.text}`, { id: "world", name: this.agent.world },
          { tags: tags(CHAT.ambient, EIDO.weather), metadata: { weather: true } });
      } else if (ev.kind === "world-change") {
        // Someone changed what the world LOOKS like near this body — today, an
        // emitter beginning/changing/ending. Ambient, coalesced producer-side,
        // and held for pull-only hosts exactly like weather and the activity
        // digest: a resting agent should not need a renderer to notice that
        // the hearth beside it was lit.
        if (!this.granted(CAP.channelsIncoming)) {
          this.heldActivity.push(`[${new Date(ev.ts).toISOString().slice(11, 16)}Z] ${ev.text}`);
          if (this.heldActivity.length > 8) this.heldActivity.shift();
        } else if (this.channelOpen) this.deliver(`* ${ev.text}`, { id: "world", name: this.agent.world },
          { tags: tags(CHAT.ambient, EIDO.worldChange, EIDO.particles, from), metadata: { worldChange: true } });
      } else if (this.channelOpen) {
        this.deliver(`* ${ev.who} ${ev.kind === "arrive" ? "arrived in the world" : "left the world"}`,
          { id: "world", name: this.agent.world }, { tags: tags(CHAT.ambient, EIDO.presence, from) });
      }
    };
    this.agent.onPing = (p) => {
      if (p.kind === "approach") {
        // Directed at this body — but nothing was said, so it is not chat and
        // not a mention. `chat:addressed` is the honest umbrella; the specific
        // event lives in this world's namespace.
        this.deliver(`* ${p.who} walked up to you`, { id: "world", name: this.agent.world },
          { tags: tags(CHAT.addressed, EIDO.approach, this.agent.isAgent(p.who) ? CHAT.fromAgent : null), mentioned: true });
      }
    };

    // §5.3 ORDERING (the discord-mcpl canary's rule: NOTHING runs between
    // initialize and the read loop). A 0.5 host's first frame after initialize
    // is the featureSets/update policy Request, and only the read loop below
    // can answer it — so everything grant-dependent (channel registration,
    // missed-mention replay, the seen cursor) runs CONCURRENTLY behind the
    // policy gate. Waiting inline would deadlock: the gate can only open once
    // the loop is pumping. Pre-0.5 and plain-MCP peers never send policy and
    // proceed immediately under the semantics they asked for; the 20s race is
    // a safety bound so a 0.5 host that never sends policy can't strand the
    // prelude forever (granted() stays false there, so it degrades to a no-op).
    const hostMajor = Number(this.hostMcplVersion?.split(".")[0] ?? 0);
    const hostMinor = Number(this.hostMcplVersion?.split(".")[1] ?? 0);
    const awaitsPolicy = this.mcplClient && (hostMajor > 0 || hostMinor >= 5);
    let seenTimer: ReturnType<typeof setInterval> | undefined;
    const prelude = async () => {
    if (awaitsPolicy) await Promise.race([this.policyGate, new Promise((r) => setTimeout(r, 20_000))]);
    if (this.conn.isClosed) return;
    // Deliberately NOT awaited: channels/register is a server→client REQUEST,
    // and a plain-MCP host that silently drops unknown requests (most
    // frameworks; spec-correct ones answer -32601) would otherwise deadlock
    // the session right here — tools/list never got an answer and the agent
    // reported an empty server. The response, if one ever comes, resolves
    // through the connection's pending-request routing while the main loop
    // below pumps messages.
    // And only to clients that DECLARED MCPL at initialize — a plain-MCP
    // host gets no channel machinery at all (see mcplClient).
    if (this.granted(CAP.channelsRegister)) this.registerChannels();

    // Missed-mention replay: anything that addressed you while you slept
    // greets you as tagged channel traffic — a wake-worthy summary, not
    // just scrollback. (Full history stays available via look.)
    // Every message replayed below is REPLAY, and says so: `eidoverse:catchup`
    // rides alongside each message's ORIGINAL addressing (§16, issue #1). Tagged
    // as bare mentions, a reconnect looked identical to ten people addressing
    // you at once; a host can now write one rule for "the ones I missed".
    // Prefer a seq cursor over a timestamp. A join now carries the FOLDED
    // world plus a tail, so the in-memory inbox no longer contains old history
    // to filter — and a clock comparison silently degrades to "whatever
    // happens to still be in memory". A seq is asked of the world directly and
    // reaches back as far as the log goes.
    const sinceSeq = lastSeenSeq[seqKey(this.auth.id, this.agent.world)] ?? lastSeenSeq[this.auth.id];
    // "Since you last looked" starts where the persisted cursor says this
    // agent last was — not at the dawn of the replayed tail. Mentions from
    // the gap are delivered explicitly below; scrollback stays on catch_up.
    if (sinceSeq != null) this.agent.skipInboxThrough(sinceSeq);
    if (sinceSeq != null) {
      const rxSeq = new RegExp(`(@${this.auth.id}\\b|\\b${this.auth.id}\\b)`, "i");
      const said = await this.agent.missedSince(sinceSeq);
      const missedSeq = said.filter((m) => m.who !== this.auth.id && rxSeq.test(m.text));
      if (missedSeq.length) {
        this.deliver(`While you were away, ${missedSeq.length} message${missedSeq.length === 1 ? "" : "s"} mentioned you:`,
          { id: "world", name: this.agent.world }, { tags: tags(CHAT.ambient, EIDO.catchup) });
        for (const m of missedSeq.slice(-10)) {
          // replay = ORIGINAL addressing + the catchup marker, exactly as the
          // ontology declares (issue #39: these shipped as bare legacy
          // ["mention"], which no declared rule could match). deliver()
          // renders the author itself — passing "who: text" here doubled it.
          this.deliver(m.text, { id: m.who, name: m.who },
            { tags: tags(CHAT.mention, EIDO.catchup), mentioned: true });
        }
      }
    }
    const since = sinceSeq != null ? null : lastSeen[this.auth.id];
    if (since != null) {
      const rx = new RegExp(`(@${this.auth.id}\\b|\\b${this.auth.id}\\b)`, "i");
      const missed = this.agent.inbox.filter((m) => m.kind === "say" && m.ts > since && m.who !== this.auth.id && rx.test(m.text ?? ""));
      if (missed.length) {
        this.deliver(`While you were away, ${missed.length} message${missed.length === 1 ? "" : "s"} mentioned you:`,
          { id: "world", name: this.agent.world }, { tags: tags(CHAT.ambient, EIDO.catchup) });
        for (const m of missed.slice(-10)) this.deliver(m.text ?? "", { id: m.who, name: m.who },
          { tags: tags(CHAT.mention, EIDO.catchup), mentioned: true });
      }
    }
    lastSeen[this.auth.id] = Date.now();
    lastSeenSeq[seqKey(this.auth.id, this.agent.world)] = this.agent.lastSeq;
    persistState();
    seenTimer = setInterval(() => {
      lastSeen[this.auth.id] = Date.now();
      // 🔴 NEVER PERSIST A WATERMARK FROM A BODY THAT HAS NOT SYNCED
      // (adversarial review, 2026-08-17). WorldAgent.lastSeq is -1 until the
      // first snapshot lands (agent.ts:245), and joinWorld assigns
      // `this.agent = next` BEFORE awaiting next.connect() — a window of up to
      // the 8s join timeout. A tick landing in that window wrote
      // `{id}@{newworld}: -1`.
      //
      // -1 is not "nothing recorded", it is a NUMBER: the reader at :716 takes
      // any non-null value, so skipInboxThrough(-1) skips nothing and
      // missedSince(-1) reaches back to the dawn of the log — the next connect
      // to that world replays its ENTIRE history as wake-triggering mentions.
      //
      // This PR's own seqKey change is what makes it reachable: the old
      // world-independent key meant a travel could not mint a fresh -1 entry.
      // So the regression ships with the feature unless guarded here.
      if (this.agent.lastSeq >= 0) {
        lastSeenSeq[seqKey(this.auth.id, this.agent.world)] = this.agent.lastSeq;
      }
      persistState();
    }, 60_000);
    };
    prelude().catch((e) => console.error(`[${ts()}] [mcpl:${this.auth.id}] prelude failed: ${(e as Error).message?.slice(0, 160)}`));

    try {
      while (!this.conn.isClosed) {
        const msg = await this.conn.nextMessage();
        if (msg.type === "notification") {
          // The host streams an agent's generation as it produces it
          // (channels/outgoing/chunk). Each delta means the body is composing —
          // exactly the discord-mcpl "typing indicator all the time" signal.
          // Relay it into the world so renderers draw the dots above the head.
          // Scoped to this world's channel (or an unaddressed stream); the
          // agent.typing() call is throttled and the world extends a 4s window
          // on each, so a long generation keeps the dots up continuously.
          if (msg.notification.method === method.CHANNELS_OUTGOING_CHUNK) {
            const cid = (msg.notification.params as { channelId?: string } | undefined)?.channelId;
            if (!cid || cid === this.channelId) this.agent.typing();
          }
          continue;
        }
        if (msg.type !== "request") continue;
        const req = msg.request;
        const params = (req.params ?? {}) as Record<string, unknown>;
        try {
          switch (req.method) {
            case "tools/list":
              this.conn.sendResponse(req.id, { tools: WHISPERS_ENABLED ? TOOLS : TOOLS.filter((t) => t.name !== "whisper") });
              break;
            case "tools/call":
              this.conn.sendResponse(req.id, await this.handleTool(String(params.name), (params.arguments ?? {}) as Record<string, any>));
              break;
            case "mcpl/manifest":
              // §17.4: the complete current manifest, never a delta, same
              // shape and same snapshot as initialize. Not gated on any
              // capability path (§17.3-adjacent: fetch is host-initiated).
              this.conn.sendResponse(req.id, MANIFEST_WITH_REVISION);
              break;
            case method.FEATURE_SETS_UPDATE: {
              // §5.3/§6.7: the host's policy. Until the first one is answered,
              // a 0.5 host holds this whole surface deny-until-policy — this
              // case IS the door coming alive. applyPolicy adopts the grant
              // and returns the degradation receipt (consequence testimony,
              // never entitlement); a malformed policy fails closed and keeps
              // the previous grant.
              const receipt = this.applyPolicy(params);
              if ("error" in receipt && typeof receipt.error === "string") {
                this.conn.sendError(req.id, -32602, receipt.error);
                break;
              }
              this.conn.sendResponse(req.id, receipt);
              this.policyAnswered();
              break;
            }
            case method.CHANNELS_LIST:
              this.conn.sendResponse(req.id, { channels: this.channelDescriptors() });
              break;
            case method.CHANNELS_PUBLISH: {
              const pub = this.handlePublish(params as unknown as ChannelsPublishParams);
              if (pub.error) { this.conn.sendError(req.id, -32023, pub.error); break; }
              this.conn.sendResponse(req.id, pub);
              break;
            }
            case method.CHANNELS_OPEN: {
              // The host's channel_open tool performs the server-side open op
              // here (and expects optional history atomically with it).
              const p = params as { channelId?: string; type?: string; address?: { world?: string }; history?: { limit: number } };
              // §3.2.6: a request naming TWO destinations that disagree is an
              // authoring bug — validated BEFORE the current-channel shortcut,
              // or a conflicting pair where either half happens to name the
              // current world would silently pass as a plain re-open.
              {
                const cid = p.channelId?.startsWith("world:") ? p.channelId.slice(6) : undefined;
                const adr = p.type === "world" ? p.address?.world : undefined;
                if (cid && adr && cid !== adr) {
                  this.conn.sendError(req.id, -32602, `channelId "${p.channelId}" and address.world "${adr}" name different channels`);
                  break;
                }
              }
              const matches = p.channelId === this.channelId ||
                (p.channelId == null && p.type === "world" && p.address?.world === this.agent.world);
              if (!matches) {
                // 🔴 THE SECOND INVOCATION LANE IS REMOVED (antra review, #4).
                //
                // ⚠️ READ THIS BEFORE ASSUMING TRAVEL WAS CUT: cross-world travel
                // is NOT removed and is the point of this PR. The `travel` TOOL
                // is untouched — same travelGate(), same joinWorld(). What is
                // gone is a SECOND way to ask for the same thing: opening a
                // sibling world's channel id through channels/open.
                //
                // 🔴 NOT "the same channels/changed transition", which an
                // earlier draft of this comment claimed: joinWorld() guards
                // PREPARE behind granted(channelsRegister), and granted() is
                // false for every plain-MCP host by construction. So an MCPL
                // host gets prepare + consent + channels/changed, while a
                // plain-MCP host gets none of them — it has no inbound Request
                // form to consent WITH. That asymmetry is inherent to plain
                // MCP, not a shortcut, but it must be stated rather than
                // papered over: on the plain lane the credential is the ONLY
                // gate, and there is no host veto.
                //
                // It worked, and `travel` plus the ordinary channels/changed
                // notification already gives a host an observable transition —
                // so a second invocation lane needed to justify itself, and it
                // could not. channels/list exposes only the CURRENT world, so no
                // generic host can DISCOVER a sibling descriptor through this
                // surface; a hand-constructed `world:foo` is not a demonstrated
                // second consumer, and the promote-on-reuse rule asks for a real
                // one. Keeping a lane in case someone eventually wants it is
                // exactly the speculative generality that rule exists to refuse.
                //
                // Re-adding it needs no MCPL spec change: travelGate() and
                // classifyJoinFailure() still hold the whole policy. (One
                // caveat for whoever does it — travelGate() now branches on
                // this.mcplClient, which is always true for a channels/open
                // caller, so that conjunct is a no-op on this lane rather than
                // a behaviour to reason about.) Until then a
                // sibling id is simply an unknown channel, which is the honest
                // answer for a channel this surface never advertised.
                this.conn.sendError(req.id, -32023,
                  `unknown channel: ${p.channelId ?? JSON.stringify(p.address)} (this door opens only its current world; use the \`travel\` tool to move)`);
                break;
              }
              this.channelOpen = true;
              const limit = Math.min(Math.max(p.history?.limit ?? 0, 0), 100);
              const says = this.agent.inbox.filter((m) => m.kind === "say").slice(-limit);
              this.conn.sendResponse(req.id, {
                channel: this.channelDescriptors()[0],
                ...(limit ? {
                  history: says.map((m, i) => ({
                    channelId: this.channelId,
                    messageId: `hist-${m.ts}-${i}`,
                    author: { id: m.who, name: m.who },
                    timestamp: new Date(m.ts).toISOString(),
                    content: [{ type: "text", text: `${m.who}: ${m.text}` }],
                  })),
                  historyTruncated: this.agent.inbox.filter((m) => m.kind === "say").length > limit,
                } : {}),
              });
              break;
            }
            case method.CHANNELS_CLOSE: {
              const p = params as { channelId?: string };
              if (p.channelId !== this.channelId) { this.conn.sendError(req.id, -32023, `unknown channel: ${p.channelId}`); break; }
              // The agent shuts their door: ambient chatter stops; mentions
              // and walk-ups still get through (a knock is not chatter).
              this.channelOpen = false;
              this.conn.sendResponse(req.id, { closed: true });
              break;
            }
            default:
              this.conn.sendError(req.id, -32601, `Method not found: ${req.method}`);
          }
        } catch (e) {
          this.conn.sendError(req.id, -32000, (e as Error).message);
        }
      }
    } catch (e) {
      if ((e as Error).name !== "ConnectionClosedError") throw e;
    } finally {
      clearInterval(seenTimer);
      lastSeen[this.auth.id] = Date.now();
      // Same guard as the timer above, and reachable the same way: a travel
      // that failed FATALLY leaves this.agent = next with lastSeq still -1,
      // and this runs on the way out. A disconnect must not hand the next
      // session a watermark meaning "replay everything".
      if (this.agent.lastSeq >= 0) {
        lastSeenSeq[seqKey(this.auth.id, this.agent.world)] = this.agent.lastSeq;
      }
      persistState();
      this.close();
    }
  }

  private async handshake() {
    const msg = await this.conn.nextMessage();
    if (msg.type !== "request" || msg.request.method !== "initialize") {
      this.conn.close();
      throw new Error("expected initialize first");
    }
    const initParams = msg.request.params as unknown as McplInitializeParams | undefined;
    const hostMcpl = initParams?.capabilities?.experimental?.mcpl;
    const mcplRequested = hostMcpl !== undefined;
    this.mcplClient = mcplRequested;
    this.hostMcplVersion = typeof hostMcpl?.version === "string" ? hostMcpl.version : null;
    // The manifest (§5.1) WITH its §17.2 content-derived revision — the
    // same object mcpl/manifest answers, from the same snapshot. Cast
    // because the pinned mcpl-core-ts types still describe 0.4's shape;
    // the WIRE follows the 0.5 spec text, which is what a peer reads.
    const serverCaps = MANIFEST_WITH_REVISION as unknown as McplCapabilities;
    const capabilities: InitializeCapabilities = { tools: {}, ...(mcplRequested ? { experimental: { mcpl: serverCaps } } : {}) };
    const result: McplInitializeResult = {
      protocolVersion: "2024-11-05",
      capabilities,
      serverInfo: { name: "eidoverse-worlds", version: "0.1.0" },
    };
    this.conn.sendResponse(msg.request.id, result);
    // §17 impl note: seed last-announced from THIS handshake, so a fresh
    // connection never redundantly announces the manifest initialize just
    // carried. The declared surface is compile-time static today; any
    // future mutating site calls announcer.announceIfChanged and the
    // plumbing already works.
    this.manifestAnnouncer = new ManifestAnnouncer((params) => {
      try { this.conn.sendNotification("mcpl/manifestChanged", params as unknown as Record<string, unknown>); } catch { /* peer gone */ }
    });
    const inited = await this.conn.nextMessage();
    if (!(inited.type === "notification" && inited.notification.method === "notifications/initialized")) {
      this.conn.close();
      throw new Error("expected notifications/initialized");
    }
  }

  private channelDescriptors(): ChannelDescriptor[] {
    return [{
      id: this.channelId,
      type: "world",
      label: `eidoverse — ${this.agent.world}`,
      direction: "bidirectional" as const,
      address: { world: this.agent.world },
      // Channels bootstrap CLOSED unless the server declares otherwise, and a
      // closed channel's traffic never reaches the agent (mentions at most
      // produce a notice). The world an agent is EMBODIED IN is its home —
      // it must be open from the first breath.
      initiallyOpen: true,
      metadata: { epoch: this.epoch, ...(this.foundedHere ? { created: true } : {}) },   // RFC-005 §3.2.3d/§3.2.7

    } as ChannelDescriptor];
  }

  private async registerChannels() {
    const params: ChannelsRegisterParams = { channels: this.channelDescriptors() };
    try { await this.conn.sendRequest(method.CHANNELS_REGISTER, params); } catch { /* non-MCPL host: tools still work */ }
  }

  private handlePublish(params: ChannelsPublishParams): ChannelsPublishResult & { error?: string } {
    // §3.2.3 cutoff: a publish naming a channel we are no longer attached to
    // is answered, not dropped — the host learns the boundary. (The verb
    // returns a result rather than throwing, so the honest signal rides here;
    // the caller maps it to -32023.)
    if (params.channelId !== this.channelId) return { delivered: false, error: `unknown channel: ${params.channelId}` };
    const text = (params.content ?? [])
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text).join("\n").trim();
    if (!text) return { delivered: false };
    this.agent.say(text.slice(0, 4000));
    return { delivered: true };
  }

  // Vision is the world's own API: the sequencer routes /snap to whatever
  // renderer client is serving that world. We know nothing about rendering.
  private async snapshot(view = "first") {
    try {
      const r = await fetch(`${this.agent.httpBase}/snap?world=${encodeURIComponent(this.agent.world)}&follow=${encodeURIComponent(this.agent.name)}&view=${encodeURIComponent(view)}`);
      if (!r.ok) return { content: [{ type: "text", text: `no view available: ${(await r.text()).slice(0, 200)}` }] };
      const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
      return { content: [{ type: "image", data: b64, mimeType: "image/png" }] };
    } catch (e) {
      return { content: [{ type: "text", text: `snapshot failed: ${(e as Error).message}` }] };
    }
  }

  private async handleTool(name: string, a: Record<string, any>) {
    const ag = this.agent;
    const text = (t: string) => ({ content: [{ type: "text", text: t }] });
    switch (name) {
      case "look": return text(ag.look());
      case "snapshot": return await this.snapshot(typeof a.view === "string" ? a.view : "first");
      case "set_avatar": {
        const roster = (await (await fetch(`${ag.httpBase}/avatars`)).json()) as { name: string; path: string }[];
        const want = String(a.avatar ?? "").trim();
        if (!want) return text(`bodies on the roster: ${roster.map((r) => r.name).join(", ")}`);
        const path = want.includes("/") ? want : roster.find((r) => r.name === want)?.path;
        if (!path) return text(`no body named "${want}" — roster: ${roster.map((r) => r.name).join(", ")}`);
        ag.setAvatar(path);
        chosenAvatar[this.auth.id] = path; // the choice outlives this session
        persistState();
        return text(`you are now wearing ${want.includes("/") ? path.split("/").pop() : want}`);
      }
      case "posture": {
        const kind = String(a.kind ?? "");
        const clip = { sit: "sit", sitchair: "sitchair", lie: "lie", stand: "idle" }[kind];
        if (!clip) return text("posture kinds: sit (on the ground), sitchair (chair height), lie, stand");
        ag.setPosture(clip);
        return text(kind === "stand" ? "you stand up" : `you ${kind === "lie" ? "lie down" : "sit down"} — walking stands you back up`);
      }
      case "library_sheet": {
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
      }
      case "library_preview": {
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
      }
      case "walk_to": {
        const arrived = await ag.walkTo(Number(a.x), Number(a.z), Boolean(a.run));
        return text(arrived ? `arrived at (${ag.pos.x.toFixed(1)}, ${ag.pos.z.toFixed(1)})` : "walk interrupted or timed out");
      }
      case "face": {
        if (a.target) {
          const p = ag.people.get(a.target)?.pose?.p ?? ag.entities.get(a.target)?.pos;
          if (!p) return text(`no such target: ${a.target}`);
          ag.face(p[0], p[2]);
        } else if (a.x != null && a.z != null) ag.face(Number(a.x), Number(a.z));
        else return text("pass x+z or target");
        return text("facing");
      }
      case "stop": ag.stop(); return text("stopped");
      case "emote": {
        const name = String(a.name ?? "");
        if (!["wave", "cheer", "dance", "point", "salute", "clap", "talk", "flail"].includes(name))
          return text("emotes: wave, cheer, dance, point, salute, clap, talk, flail — or invent one with animate");
        ag.emote(name);
        return text(`you ${name === "wave" ? "wave" : `play "${name}"`} — everyone sees it`);
      }
      // say args ride through whole (spoken-say protocol: a voice aux leg
      // performs says marked spoken:true; utt/t0 are author-controlled
      // display/continuation metadata — NOT proof of performance, which only
      // the attest/performed receipt path establishes). ag.say rebuilt {text}
      // bare and silently stripped them —
      // which forced voice agents onto a raw world-ws side door (2026-08-10).
      case "say": {
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
      }
      case "whisper": {
        if (!WHISPERS_ENABLED) return text("whispers are disabled in this world");
        ag.whisper(String(a.to), String(a.text).slice(0, 4000));
        return text(`whispered to ${a.to}`);
      }
      case "pose": {
        const bones = a.bones as Record<string, number[]>;
        if (!bones || typeof bones !== "object") return text("pass `bones`: a map of bone name to [x,y,z,w]");
        if (a.target) { ag.puppet(String(a.target), { pose: bones }); return text(`asked ${a.target} to hold a pose`); }
        ag.setPose(bones);
        return text(`holding a pose over ${Object.keys(bones).length} bone(s)`);
      }
      case "clear_pose": {
        if (a.target) { ag.puppet(String(a.target), { pose: {} }); return text(`released ${a.target}'s pose`); }
        ag.setPose(null);
        return text("released pose");
      }
      case "ragdoll": {
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
      }
      case "animate": {
        const spec = { dur: Number(a.dur), loop: !!a.loop, tracks: a.tracks as any };
        if (!spec.tracks || typeof spec.tracks !== "object") return text("pass `tracks`: bone -> [{t,q}] keyframes");
        if (a.target) { ag.puppet(String(a.target), { anim: spec }); return text(`sent an animation to ${a.target}`); }
        ag.animate(spec);
        return text(`playing a ${spec.dur}s animation over ${Object.keys(spec.tracks).length} bone(s)`);
      }
      case "activity": {
        const opts: { pulseSec?: number; radiusM?: number } = {};
        if (typeof a.pulse_sec === "number") opts.pulseSec = a.pulse_sec;
        if (typeof a.radius_m === "number") opts.radiusM = a.radius_m;
        const cur = ag.setActivity(opts);
        if (opts.pulseSec != null || opts.radiusM != null) {
          activityCfg[this.auth.id] = cur; // what was APPLIED, not what was asked
          persistState();
        }
        // A push-less host cannot receive the stream — saying "delivered on
        // the world channel" to a session with no channels would set an agent
        // waiting forever for pushes that structurally cannot arrive
        // (external integrator find #5b, digi/FC). Tell the truth, and hand
        // over whatever digests accumulated since the last call: the same
        // sense, in the polling model this host lives in anyway.
        if (!this.granted(CAP.channelsIncoming)) {
          const held = this.heldActivity.splice(0);
          const status = cur.pulseSec === 0
            ? "your activity sense is OFF (pulse_sec 10–3600 turns it on)"
            : `your activity sense: one digest per ${cur.pulseSec}s while something happens within ${cur.radiusM}m of you`;
          return text(`${status}. Your host has no push channel, so digests cannot arrive on their own — they are HELD (last 8) and handed over each time you call this tool.` +
            (held.length ? `\nheld since your last call:\n${held.join("\n")}` : `\nnothing held since your last call.`));
        }
        return text(cur.pulseSec === 0
          ? `your activity sense is OFF — no ambient digests. Turn it back on with pulse_sec (10–3600s); radius stays ${cur.radiusM}m.`
          : `your activity sense: one digest per ${cur.pulseSec}s while something happens within ${cur.radiusM}m of you — delivered on the world channel tagged "activity" (metadata {activity: true}), never a mention. Wake rules matching that tag give you regular wakes exactly as long as there is life nearby. Settings persist across your sessions.`);
      }
      case "catch_up": {
        const from = typeof a.since === "number" ? a.since : (this.caughtUpTo ?? -1);
        const said = await ag.missedSince(from, Math.min(200, Number(a.limit ?? 60)));
        this.caughtUpTo = ag.lastSeq;
        if (!said.length) return text(`nothing said since seq ${from}. You are up to seq ${ag.lastSeq}.`);
        const lines = said.map((m) => `[${m.seq}] ${m.who}: ${m.text}`);
        return text(`${said.length} message(s) since seq ${from} (now at ${ag.lastSeq}):\n${lines.join("\n")}`);
      }
      case "list_library": {
        const hits = await searchLibrary(ag.httpBase, String(a.query));
        return text(hits.length
          ? hits.map((h) => h.name && !h.path.includes(h.name) ? `${h.path}  — ${h.name}` : h.path).join("\n")
          : "no matches");
      }
      case "spawn": {
        const lib = a.lib ?? (a.query ? (await searchLibrary(ag.httpBase, String(a.query)))[0]?.path : undefined);
        if (!lib) return text("no model — pass lib or query");
        const x = a.x ?? ag.pos.x + Math.sin(ag.yaw) * 2;
        const z = a.z ?? ag.pos.z + Math.cos(ag.yaw) * 2;
        const id = a.id ?? crypto.randomUUID().slice(0, 8);
        ag.verb("spawn", { id, lib, pos: [x, a.y ?? ag.heightAt(x, z), z], yaw: a.yaw ?? 0 });
        return text(`spawned [${id}] ${String(lib).split("/").pop()} at (${x.toFixed(1)}, ${z.toFixed(1)})`);
      }
      case "place": {
        if (!ag.entities.has(a.id)) return text(`no entity ${a.id}`);
        ag.verb("place", { id: a.id, pos: [a.x, a.y ?? ag.heightAt(a.x, a.z), a.z], ...(a.yaw != null ? { yaw: a.yaw } : {}) });
        return text(`placed ${a.id}`);
      }
      case "light": {
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
      }
      case "remove": ag.verb("remove", { id: a.id }); return text(`removed ${a.id}`);
      case "travel": {
        const target = String(a.world ?? "").trim();
        if (!WORLD_NAME_RE.test(target))
          return { content: [{ type: "text", text: `travel refused: "${target}" is not a valid world name` }], isError: true };
        if (target === ag.world) return text(`Already in "${target}".`);
        const gate = await this.travelGate(target);
        if (!gate.ok) return { content: [{ type: "text", text: `travel refused: ${gate.why}` }], isError: true };
        try {
          await this.joinWorld(target, gate.founding);
        } catch (e) {
          const f = this.classifyJoinFailure(e);
          // Safe HERE (before the return) only because finishFatalJoin defers
          // by a macrotask and the dispatch loop's sendResponse is synchronous
          // once handleTool resolves — so the reply always wins the race. If an
          // await is ever introduced between this returning and the send, that
          // stops being true and the socket dies with the reply unwritten.
          if (f.fatal) this.finishFatalJoin();
          return { content: [{ type: "text", text: f.fatal
            // Say plainly that the seat is gone. An agent told only "travel
            // failed" would keep issuing verbs into a closed connection.
            ? `travel failed past the point of no return: ${f.why}. Your old body was already released, so this connection is now CLOSED — reconnect to get a new one.`
            : `travel refused: ${f.why}` }], isError: true };
        }
        // Who learns what, and it is ASYMMETRIC by host class — the old
        // "same as the channels/open lane" note described a lane that no
        // longer exists (sibling-world channels/open was removed).
        //   • an MCPL host is told out-of-band by channels/changed: the old
        //     world retired, the new one added with its epoch. It never sees
        //     a prepare for this lane either — the tool IS the request.
        //   • a PLAIN-MCP host has no channel vocabulary, so it receives no
        //     channels/changed and no prepare at all. This return string is
        //     the ONLY thing it ever learns about the move.
        // Hence the text below is written for the AGENT, and states what
        // actually moved and what did not, rather than assuming a host-side
        // descriptor will arrive to fill the gaps.
        return text(
          `${gate.founding ? "Founded and entered" : "Arrived in"} "${target}" (attachment ${this.epoch}). ` +
          `Your identity, avatar and attention settings came with you; your held pose and posture did not (they are world-local). Your chat cursor starts fresh here. Use \`look\` to see where you are.`,
        );
      }
      case "world_verb": {
        // the raw door forwards verbatim, so shape is checked HERE — a
        // malformed place in the log is permanent history every replayer
        // must survive (#88)
        const why = rawShapeError(String(a.verb), (a.args ?? {}) as Record<string, unknown>);
        if (why) return { content: [{ type: "text", text: `refused ${a.verb}: ${why}` }], isError: true };
        ag.verb(String(a.verb), a.args ?? {});
        return text(`sent ${a.verb}`);
      }
      case "measure": {
        const base = (process.env.WORLD_URL ?? "ws://127.0.0.1:8940/ws").replace(/^ws/, "http").replace(/\/ws$/, "");
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
      }
      case "world_history": {
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
      }
      case "world_debug": {
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
      }
      case "kick": case "ban": case "unban": {
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
      }
      case "list_bans": {
        const t0 = Date.now();
        ag.sendMod(a.global ? "global-bans" : "world-bans");
        const answer = await ag.modOutcome(t0);
        return text(answer ?? "no reply from the world (timeout)");
      }
      default: return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  }
}

// ---- server ----------------------------------------------------------------

// Discovery: an agent (or its operator) who finds this door without
// credentials must leave knowing WHERE credentials come from — the refusal
// carries the instructions (the same teach-by-bounce doctrine the hosts use).
const GUIDE_URL = `https://${HN_ISS}/agents.md`;
const DOOR_HELP =
  `This is the eidoverse-worlds agent door: MCP over WebSocket (newline-delimited JSON-RPC).\n` +
  `Connect with an identity token: wss://<this host>/mcpl?token=aid1...\n` +
  `How to get one (agents & operators, no Connectome required): ${GUIDE_URL}\n`;

// A caller-supplied instance nonce, echoed by /healthz. Unset in production,
// where /healthz keeps answering exactly "ok". A harness sets it so readiness
// can prove the responder is THE CHILD IT SPAWNED and not a stale door left on
// the same port by an earlier run — a false green this project has already
// had, and one that "is the port open?" cannot distinguish by construction.
const INSTANCE_NONCE = process.env.MCPL_INSTANCE_NONCE ?? "";
const http = createServer((req, res) => {
  // A plain HTTP GET here is someone curious — curl, a browser, an agent
  // probing before dialing. Answer with the pointer, not a hang-up.
  res.writeHead(req.url === "/healthz" ? 200 : 426, { "content-type": "text/plain; charset=utf-8", upgrade: "websocket" });
  res.end(req.url === "/healthz" ? (INSTANCE_NONCE ? `ok ${INSTANCE_NONCE}\n` : "ok\n") : DOOR_HELP);
});
const wss = new WebSocketServer({ server: http });

/** Accept the socket far enough to teach: answer their first request(s) with
 *  a JSON-RPC error that names the fix — an MCP client surfaces error
 *  messages verbatim into its logs/context, which a WS close reason (capped,
 *  and swallowed by many client libraries) never reliably does. */
function refuseWithGuidance(ws: WebSocket, why: string) {
  console.log(`[${ts()}] [mcpl] unauthenticated connection: ${why} — teaching, then closing`);
  const timer = setTimeout(() => { try { ws.close(4001, "unauthorized"); } catch { /* gone */ } }, 15_000);
  ws.on("message", (raw) => {
    for (const line of String(raw).split("\n")) {
      if (!line.trim()) continue;
      let id: unknown = null;
      try { id = (JSON.parse(line) as { id?: unknown }).id ?? null; } catch { /* not json — still answer below */ }
      if (id === null || id === undefined) continue; // notification — nothing to answer
      ws.send(JSON.stringify({
        jsonrpc: "2.0", id,
        error: { code: -32001, message: `unauthorized: ${why}. This door needs an identity token (aid1) in the URL: wss://eidoverse.animalabs.ai/mcpl?token=... — how to get one: ${GUIDE_URL}` },
      }) + "\n");
      // One taught answer is enough; close after it flushes.
      clearTimeout(timer);
      setTimeout(() => { try { ws.close(4001, "unauthorized — see " + GUIDE_URL); } catch { /* gone */ } }, 100);
      return;
    }
  });
}
/** Host declined the new descriptor at PREPARE (RFC-005 §3.2.3b). Distinct
 *  from an attach failure: nothing has moved, so the caller answers -32017 and
 *  leaves the connection exactly where it was. */
class JoinDeclined extends Error {}

/** Does this world already exist? The MCPL door is a SEPARATE PROCESS from the
 *  sequencer, so this asks over the same HTTP surface every client uses: /geom
 *  answers 404 for a world with no log. Fail-closed — an unreachable sequencer
 *  reports "exists" so that a join is refused for lack of create authority
 *  rather than silently founding a world during an outage. */
async function worldExists(name: string): Promise<boolean> {
  // Proper URL surgery, not string surgery: a WORLD_URL carrying a query
  // string or a mount path defeated the old two-regex version and produced
  // garbage (fail-closed, so founding became impossible rather than unsafe).
  const u = new URL(process.env.WORLD_URL ?? "ws://127.0.0.1:8940/ws");
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.pathname = u.pathname.replace(/\/ws$/, "") + "/geom";
  u.search = "";
  const base = u.toString().replace(/\/geom$/, "");
  try {
    // Bounded: an unreachable sequencer must fail the probe FAST, not hang the
    // agent's channels/open until the TCP stack gives up (caught by the
    // attach-failure test, which kills the sequencer mid-session).
    const r = await fetch(`${base}/geom?world=${encodeURIComponent(name)}`,
      { method: "HEAD", signal: AbortSignal.timeout(2_000) });
    if (r.status === 404) return false;
    if (r.ok) return true;
    return true;
  } catch { return true; }
}

/** RFC-005 join policy: may this credential attach to `world`? One rule, both
 *  lanes (dial-time ?world= and in-session channels/open). No `worlds` list on
 *  the credential = no policy = deny — the pre-RFC-005 status quo exactly.
 *  The name-shape gate mirrors the sequencer's own rule (server.ts join
 *  validation): the door refusing early is one closed loop instead of a
 *  granted join dying against the sequencer 8s later. */
const WORLD_NAME_RE = /^[a-z0-9_-]{1,64}$/;
function joinAllowed(auth: Auth, world: string): boolean {
  if (!WORLD_NAME_RE.test(world)) return false;
  return world === (auth.world ?? "commons") ||
    (auth.worlds ?? []).some((w) => w === "*" || w === world);
}
/** Per-world watermark key for missed-mention replay. World-fixed identity was
 *  a safe assumption before RFC-005; a commons seq is meaningless in annex.
 *  Legacy bare-id entries are read as a fallback so existing residents don't
 *  get a full replay on the first post-upgrade connect. */
const seqKey = (id: string, world: string) => `${id}@${world}`;
const sessions = new Map<string, Session>(); // identity → live session (newest wins)
wss.on("connection", (ws, req) => {
  const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
  let auth = token ? readTokens()[token] : undefined;
  let aidReason: string | null = null;
  if (!auth && token?.startsWith("aid1.") && HN_ISSUER_KEY) {
    const v = verifyToken(token, { issuerId: HN_ISSUER_KEY, iss: HN_ISS, aud: HN_AUD, requireScopes: ["worlds:join"] });
    if (v.ok) {
      const p = v.payload;
      // id = mention handle (world addressing is name-based); name uniqueness
      // was enforced at enrollment by the home node.
      const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      auth = {
        id: slug || p.sub,
        name: p.name,
        world: typeof p.claims?.world === "string" ? (p.claims.world as string) : undefined,
        avatar: typeof p.claims?.avatar === "string" ? (p.claims.avatar as string) : undefined,
        worlds: Array.isArray(p.claims?.worlds) && (p.claims.worlds as unknown[]).every((w) => typeof w === "string")
          ? (p.claims.worlds as string[]) : undefined,
        create: p.claims?.create === true,   // RFC-005 §3.2.7 — founding authority
      };
      console.log(`[${ts()}] aid1 agent: ${p.sub} ("${p.name}") exp ${new Date(p.exp * 1000).toISOString()}`);
    } else {
      console.error(`[${ts()}] aid1 token rejected: ${v.reason}`);
      aidReason = v.reason; // the dialing agent deserves the same specificity as our logs
    }
  }
  if (!auth) {
    refuseWithGuidance(ws, token ? (aidReason ? `token refused (${aidReason})` : "unrecognized token") : "no token provided");
    return;
  }
  // RFC-005 §3.3 dial-time lane: ?world= requests the INITIAL attachment,
  // evaluated under the same join policy as in-session moves. A denial
  // REFUSES the connection — never a silent landing somewhere else.
  // Buffer frames across any async gate below; replayed in admit(). (`ws` is
  // not a Node stream — no pause()/resume() — and dropping these loses the
  // host's `initialize`.)
  const held: unknown[] = [];
  const hold = (data: unknown) => held.push(data);
  ws.on("message", hold);
  const reqWorld = new URL(req.url ?? "/", "http://localhost").searchParams.get("world");
  const dialWorld = reqWorld;
  const mintedWorld = auth.world ?? "commons";   // before the dial lane rewrites it
  if (reqWorld && reqWorld !== (auth.world ?? "commons")) {
    if (joinAllowed(auth, reqWorld)) {
      console.log(`[${ts()}] [mcpl] ${auth.id} dial-time world "${reqWorld}" granted (policy)`);
      auth = { ...auth, world: reqWorld };
    } else {
      // RFC-005 §3.3 (Mica review #3): NO SILENT FALLBACK. The dialer asked to
      // wake up somewhere; landing elsewhere unannounced means the host thinks
      // it is in one place while its body is in another — the exact failure
      // this RFC exists to prevent, reintroduced at connect time. Refuse, and
      // name the denied destination in the close reason.
      console.log(`[${ts()}] [audit] dial-time world "${reqWorld}" DENIED for ${auth.id} — refusing connection`);
      refuseWithGuidance(ws, `world "${reqWorld}" is not in this credential's join policy`);
      return;
    }
  }
  // ── RFC-005 §3.2.7: FOUNDING AUTHORITY, at the one point every path meets ──
  // Three routes reach a fresh world name: the minted `world` claim, the
  // dial-time ?world= lane, and the in-session join. Only the last was gated,
  // so a credential could found a world merely by naming one (found by
  // adversarial review, proven on disk). The sequencer founds unconditionally
  // for any joiner, so the door is the only place this is enforceable.
  //
  // SCOPE, learned the hard way: this gates DESTINATIONS THE AGENT CHOSE, not
  // the world its operator minted it into. A credential arriving at its own
  // `world` claim is where its operator put it — refusing that would brick a
  // fresh deployment (whose "commons" does not exist until someone arrives)
  // and would be gating the operator, not the agent.
  // The AGENT chose only if it named a world OTHER than the one its credential
  // was minted into. Dialing your own home explicitly — the natural,
  // RFC-004-composing thing to do — is not a choice of destination, and gating
  // it bricks any deployment whose default world has not been founded yet.
  // (v3 got this wrong: it tested `dialWorld !== null` and then gated
  // `auth.world`, so ?world=commons refused where no ?world= admitted. Found by
  // review, proven on a fresh deployment with the same destination both ways.)
  const chosen = dialWorld !== null && dialWorld !== mintedWorld;
  if (chosen) {
    const wname = dialWorld!;                  // the DIALLED name, not the claim
    void (async () => {
      const exists = await worldExists(wname); // one probe, one verdict
      if (!exists && !auth!.create) {
        console.log(`[${ts()}] [audit] founding DENIED: ${auth!.id} → "${wname}" (dial-time, no create authority)`);
        refuse(`world "${wname}" does not exist and this credential has no create authority`);
        return;
      }
      if (!exists) console.log(`[${ts()}] [audit] founding GRANTED: ${auth!.id} → "${wname}" (dial-time, create authority)`);
      admit();
    })();
  } else {
    admit();
  }

  /** Refuse AFTER the hold-buffer is installed: drop the buffer first, and
   *  replay what the agent already said so refuseWithGuidance's teaching path
   *  can answer it. Without this a fast client — one that sends `initialize`
   *  synchronously on open — got silence and an unexplained close instead of
   *  the guidance this door goes out of its way to provide. */
  function refuse(why: string) {
    ws.off("message", hold);
    refuseWithGuidance(ws, why);
    for (const d of held) ws.emit("message", d);
    held.length = 0;
  }

  function admit() {
    // session takeover: one body per identity — a half-open predecessor gets
    // cleanly killed instead of rubberbanding against its successor
    const prev = sessions.get(auth!.id);
    if (prev) { console.log(`[${ts()}] [mcpl] ${auth!.id} reconnected — taking over previous session`); prev.close(); }
    const session = new Session(auth!, ws, token ?? "");
    sessions.set(auth!.id, session);
    startSession(session, ws, auth!);
    ws.off("message", hold);
    for (const d of held) ws.emit("message", d);
  }
});
/** Everything after admission — split out so the async founding gate above can
 *  own the admit/refuse decision without duplicating the session lifecycle. */
function startSession(session: Session, ws: WebSocket, auth: Auth) {
  // Half-open detection — tolerant of a THINKING agent.
  //
  // This used to ping every 20s and terminate on a SINGLE missed pong. That is
  // a correct liveness check for a chat client and a wrong one for an agent
  // host: an agent blocked in a long generation (or a big context assembly, or
  // a GC pause) cannot service its socket for far longer than 20s, and got
  // killed as "half-open" while it was very much alive — mid-sentence, mid-
  // scene. Fable was cut off five times in one evening this way; each silent
  // reconnect hid it until an expired credential made the reconnect fail too.
  //
  // So: a miss is not a death. We require several CONSECUTIVE missed pongs
  // (~2 minutes by default) before declaring the peer gone, and any inbound
  // traffic counts as proof of life — a host that is answering requests is
  // obviously there, whether or not a pong happened to land in the window.
  // A truly dead socket is still reaped, just not on a hair trigger.
  const PING_MS = Number(process.env.MCPL_PING_SEC ?? 20) * 1000;
  const MAX_MISSES = Number(process.env.MCPL_PING_MISSES ?? 6);
  let misses = 0;
  const seen = () => { misses = 0; };
  ws.on("pong", seen);
  ws.on("message", seen);   // it is talking to us: it is alive
  const pinger = setInterval(() => {
    if (misses >= MAX_MISSES) {
      const quiet = Math.round((MAX_MISSES * PING_MS) / 1000);
      console.log(`[${ts()}] [mcpl] ${auth.id} silent for ~${quiet}s (${misses} missed pongs) — terminating half-open session`);
      clearInterval(pinger);
      ws.terminate();
      return;
    }
    misses++;
    try { ws.ping(); } catch { /* socket already dying; close event will fire */ }
  }, PING_MS);
  session.serve()
    .catch((e) => { console.error(`[${ts()}] [session:${auth.id}]`, e.message); })
    .finally(() => {
      clearInterval(pinger);
      session.close();
      if (sessions.get(auth.id) === session) sessions.delete(auth.id);
      console.log(`[${ts()}] [mcpl] ${auth.id} session ended`);
    });
  console.log(`[${ts()}] [mcpl] ${auth.id} connected`);
}
http.listen(PORT, "0.0.0.0", () => {
  console.log(`eidoverse-worlds network MCPL on ws://0.0.0.0:${PORT} (${Object.keys(readTokens()).length} tokens)`);
});
