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

import { mentionRegex } from "./mention.ts";
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
const TOKENS_PATH = fileURLToPath(new URL("./tokens.json", import.meta.url));

type Auth = { id: string; name: string; world?: string; avatar?: string };
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
const STATE_PATH = fileURLToPath(new URL("./state.json", import.meta.url));
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
  private caughtUpTo: number | null = null; // the world channel is home — open unless the agent closes it
  /** Activity digests held for a push-less (plain-MCP) host. The pulse is a
   *  wake signal, and a host with no push channel cannot be woken — but the
   *  digests themselves are still worth having, so they wait here and the
   *  `activity` tool hands them over on its next call. Pull where push can't
   *  reach (external integrator find #5b, digi/FC). Small ring: this is a
   *  sense, not scrollback. */
  private heldActivity: string[] = [];

  constructor(private auth: Auth, ws: WebSocket, agentToken = "") {
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

  /** The loopback media bridge. One sidecar at a time: a second connection
   *  replaces the first, because two publishers for one identity is the
   *  double-speak bug (#57's whole premise) wearing a new hat. */
  private mediaSock: WebSocket | null = null;
  /** The listener handle, so session teardown can actually release the port.
   *  🔴 It used to be discarded (2026-08-16). Bun.serve()'s return value was
   *  thrown away, no field held it, and session.close() therefore had nothing
   *  to close — so the bridge outlived every session BY CONSTRUCTION. The
   *  first session bound :8931 and worked; when it ended the listener stayed;
   *  every reconnect after that died on `Failed to start server. Is port 8931
   *  in use?` — the door failing to bind a port the door itself was holding.
   *  Observed as an hour of working voice, then a permanent crash loop with a
   *  5-second period and no audio at all. */
  private mediaServer: { stop: (closeActiveConnections?: boolean) => void } | null = null;

  private startMediaBridge(port: number) {
    // Idempotent: a re-entry must not try to bind a port we already hold.
    if (this.mediaServer) {
      console.log(`[door] media bridge already listening on :${port} — reusing`);
      return;
    }
    try {
    this.mediaServer = Bun.serve({
      port, hostname: "127.0.0.1",
      fetch: (req, srv) => srv.upgrade(req) ? undefined : new Response("media bridge: websocket only", { status: 426 }),
      websocket: {
        open: (ws) => {
          if (this.mediaSock) { try { this.mediaSock.close(4001, "replaced"); } catch {} }
          this.mediaSock = ws as never;
          console.log(`[door] media sidecar attached on :${port} — asking for a credential`);
          // The sidecar cannot ask for itself (the server refuses a non-primary),
          // so attaching IS the ask. subscribe:false — this leg speaks, it does
          // not listen; hearing is the door's job on the text tier.
          try { this.agent.requestMediaCredential({ publish: true, subscribe: false }); }
          catch (e) { console.warn("[door] credential ask failed:", (e as Error).message); }
        },
        message: (_ws, raw) => {
          // Sidecar → world. Whitelisted in sendMedia; malformed JSON is the
          // sidecar's bug and must not take the door down (house rule #3).
          try {
            const frame = JSON.parse(String(raw)) as { type?: string; seq?: number };
            // `aired` is the sidecar telling us an utterance actually left the
            // encoder. The RECEIPT is ours to send, never the sidecar's: attest
            // is identity-bearing (own-id, token-verified, generation-stamped)
            // and belongs to the authenticated primary. A loopback peer that
            // could mint receipts could suppress every listener's fallback for
            // audio it never aired — silence that looks like speech.
            if (frame?.type === "aired") { void this.attestAired(Number(frame.seq)); return; }
            this.agent.sendMedia(frame as never);
          } catch (e) { console.warn("[door] bad media frame:", (e as Error).message); }
        },
        close: (ws) => { if (this.mediaSock === (ws as never)) this.mediaSock = null; },
      },
      // A bind failure must not be fatal to the SESSION. Before, the throw
      // escaped into session.serve()'s catch and ended the connection outright
      // — so a leaked listener cost the agent its whole seat (text included),
      // not just its voice. The door is still useful mute.
      error: (e: Error) => { console.warn("[door] media bridge error:", e.message); return undefined; },
    });
    } catch (e) {
      // 🔴 A BIND FAILURE IS A MUTE DOOR, NOT A DEAD ONE. This used to throw
      // out of the session setup path into session.serve()'s catch, ending the
      // whole MCPL connection — so a stuck port cost the agent its text seat
      // too, and the reconnect loop that followed made it look like the world
      // was rejecting us. Log it, stay up, speak later.
      this.mediaServer = null;
      console.warn(`[door] media bridge could NOT bind :${port} (${(e as Error).message}) — continuing WITHOUT a voice; text is unaffected`);
      return;
    }
    // World → sidecar. Dropped when nothing is attached: the credential and
    // offers are meaningless without a peer to answer them, and the server
    // retires the leg on its own funnel.
    this.agent.onMedia = (frame) => {
      try { this.mediaSock?.send(JSON.stringify(frame)); } catch { /* sidecar died mid-frame */ }
    };
  }

  /** A sidecar reported an utterance aired; mint the receipt for it. Silent on
   *  an unknown seq — the say may have aged out of the ring, and a missing
   *  receipt degrades to listener-side fallback, which is the designed
   *  behaviour rather than an error worth shouting about. */
  private async attestAired(seq: number): Promise<void> {
    if (!Number.isSafeInteger(seq)) return;
    const ok = await this.agent.attestSay(seq).catch(() => false);
    if (!ok) console.warn(`[door] could not attest seq ${seq} (unknown say or not joined)`);
  }

  close() {
    this.agent.close(); // deliberate death — stops the body's auto-reconnect
    this.conn.close();
    // 🔴 RELEASE THE MEDIA PORT. Without this the listener outlives the
    // session and the NEXT session cannot bind it — the door failing to bind a
    // port the door still holds, forever, at the reconnect interval. Cost when
    // it was missing: voice worked for one session, then eight hours of a
    // 5-second crash loop that read as "the world is rejecting me."
    // closeActiveConnections=true so a still-attached sidecar is dropped now,
    // not left half-alive against a dead session.
    if (this.mediaServer) {
      try { this.mediaServer.stop(true); } catch (e) { console.warn("[door] media bridge stop:", (e as Error).message); }
      this.mediaServer = null;
    }
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
  /** §5.4 for the CHANNEL verbs, which had no gate at all (found 2026-08-16).
   *
   *  `channels.publish`, `channels.lifecycle` and `channels.streaming` are all
   *  declared in CAP and were checked NOWHERE — only `channels.register` and
   *  `channels.incoming` were. So a host that granted `channels.incoming` alone
   *  (receive, do not send) still had its agent's `channels/publish` answered:
   *  the door SPOKE IN THE WORLD on behalf of an agent whose host never granted
   *  speech. Same class as toolsAllowed's dead call, three more times.
   *
   *  declaration.ts's own §5.4 comment: "absence is denial and there is no
   *  unspecified state, so an ambiguous entry fails closed." A peer with no
   *  declaration (plain MCP) keeps everything, exactly as toolsAllowed does;
   *  this binds only hosts that bothered to declare. */
  private capAllowed(cap: string): boolean {
    return this.grant ? this.granted(cap) : true;
  }

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
    // ── MEDIA BRIDGE (#104 / #57) ────────────────────────────────────────
    // The SFU gates publishing to the embodied primary; for an agent that is
    // this door. But the door has no audio — a local synthesizer does, in
    // another process. So when EIDO_MEDIA_PORT is set, the door listens on
    // loopback and relays media-signalling frames both ways, and NOTHING else
    // (see WorldAgent.onMedia / sendMedia for the whitelist).
    //
    // Off by default: a door with no sidecar never opens the port, never asks
    // for a credential, and behaves exactly as it did before. Loopback only —
    // this carries the authority to publish audio AS this identity, which is
    // the same trust boundary as the agent's own process space (and the same
    // named threat the sidecar's ARCHITECTURE.md records for its other seams).
    const mediaPort = Number(process.env.EIDO_MEDIA_PORT ?? 0);
    if (mediaPort > 0) this.startMediaBridge(mediaPort);

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
    const sinceSeq = lastSeenSeq[this.auth.id];
    // "Since you last looked" starts where the persisted cursor says this
    // agent last was — not at the dawn of the replayed tail. Mentions from
    // the gap are delivered explicitly below; scrollback stays on catch_up.
    if (sinceSeq != null) this.agent.skipInboxThrough(sinceSeq);
    if (sinceSeq != null) {
      const rxSeq = mentionRegex(this.auth.id);
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
      const rx = mentionRegex(this.auth.id);
      const missed = this.agent.inbox.filter((m) => m.kind === "say" && m.ts > since && m.who !== this.auth.id && rx.test(m.text ?? ""));
      if (missed.length) {
        this.deliver(`While you were away, ${missed.length} message${missed.length === 1 ? "" : "s"} mentioned you:`,
          { id: "world", name: this.agent.world }, { tags: tags(CHAT.ambient, EIDO.catchup) });
        for (const m of missed.slice(-10)) this.deliver(m.text ?? "", { id: m.who, name: m.who },
          { tags: tags(CHAT.mention, EIDO.catchup), mentioned: true });
      }
    }
    lastSeen[this.auth.id] = Date.now();
    lastSeenSeq[this.auth.id] = this.agent.lastSeq;
    persistState();
    seenTimer = setInterval(() => {
      lastSeen[this.auth.id] = Date.now();
      lastSeenSeq[this.auth.id] = this.agent.lastSeq;
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
            // 🔴 toolsAllowed() WAS NEVER CALLED (found 2026-08-16). Twelve
            // lines of spec-citing prose above a function no code path invoked,
            // while both handlers below answered unconditionally — so a host
            // that explicitly DENIED `tools` in its grant still got the full
            // tool surface, and §5.4's "a denied capability behaves as if never
            // advertised" was documented rather than implemented.
            case "tools/list":
              this.conn.sendResponse(req.id, { tools: this.toolsAllowed()
                ? (WHISPERS_ENABLED ? TOOLS : TOOLS.filter((t) => t.name !== "whisper"))
                : [] });   // denied ⇒ as if never advertised
              break;
            case "tools/call":
              if (!this.toolsAllowed()) {
                // -32601: the method is not available to THIS host, which is the
                // honest shape — not an error about the tool's arguments.
                this.conn.sendError(req.id, -32601, "tools are not granted to this host");
                break;
              }
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
            case method.CHANNELS_PUBLISH:
              if (!this.capAllowed(CAP.channelsPublish)) {
                this.conn.sendError(req.id, -32003, "channels.publish not granted");
                break;
              }
              this.conn.sendResponse(req.id, this.handlePublish(params as unknown as ChannelsPublishParams));
              break;
            case method.CHANNELS_OPEN: {
              if (!this.capAllowed(CAP.channelsLifecycle)) {
                this.conn.sendError(req.id, -32003, "channels.lifecycle not granted");
                break;
              }
              // The host's channel_open tool performs the server-side open op
              // here (and expects optional history atomically with it).
              const p = params as { channelId?: string; type?: string; address?: { world?: string }; history?: { limit: number } };
              const matches = p.channelId === this.channelId ||
                (p.type === "world" && p.address?.world === this.agent.world);
              if (!matches) { this.conn.sendError(req.id, -32004, `unknown channel: ${p.channelId ?? JSON.stringify(p.address)}`); break; }
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
              if (!this.capAllowed(CAP.channelsLifecycle)) {
                this.conn.sendError(req.id, -32003, "channels.lifecycle not granted");
                break;
              }
              const p = params as { channelId?: string };
              if (p.channelId !== this.channelId) { this.conn.sendError(req.id, -32004, `unknown channel: ${p.channelId}`); break; }
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
    lastSeenSeq[this.auth.id] = this.agent.lastSeq;
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
    } as ChannelDescriptor];
  }

  private async registerChannels() {
    const params: ChannelsRegisterParams = { channels: this.channelDescriptors() };
    try { await this.conn.sendRequest(method.CHANNELS_REGISTER, params); } catch { /* non-MCPL host: tools still work */ }
  }

  private handlePublish(params: ChannelsPublishParams): ChannelsPublishResult {
    if (params.channelId !== this.channelId) return { delivered: false };
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

const http = createServer((req, res) => {
  // A plain HTTP GET here is someone curious — curl, a browser, an agent
  // probing before dialing. Answer with the pointer, not a hang-up.
  res.writeHead(req.url === "/healthz" ? 200 : 426, { "content-type": "text/plain; charset=utf-8", upgrade: "websocket" });
  res.end(req.url === "/healthz" ? "ok\n" : DOOR_HELP);
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
  // session takeover: one body per identity — a half-open predecessor gets
  // cleanly killed instead of rubberbanding against its successor
  const prev = sessions.get(auth.id);
  if (prev) { console.log(`[${ts()}] [mcpl] ${auth.id} reconnected — taking over previous session`); prev.close(); }
  const session = new Session(auth, ws, token ?? "");
  sessions.set(auth.id, session);
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
});
http.listen(PORT, "0.0.0.0", () => {
  console.log(`eidoverse-worlds network MCPL on ws://0.0.0.0:${PORT} (${Object.keys(readTokens()).length} tokens)`);
});
