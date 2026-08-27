// eidoverse-worlds agent MCPL — MCP stdio server giving an agent embodied
// presence: a body (WorldAgent), verbs, text-tier perception, and a retina
// (first-person snapshots via a spectator browser session on a GPU host).
//
// Env: WORLD_URL (ws://127.0.0.1:8940/ws), AGENT_NAME (claude),
//      WORLD_NAME (commons), AGENT_AVATAR (vrm library path),
//      RETINA=0 to disable snapshots.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readdirSync } from "node:fs";
import { WorldAgent } from "./agent.ts";
import { pingLine } from "./ping-wire.ts";

const agent = new WorldAgent();
await agent.connect();

const server = new McpServer({ name: "eidoverse-worlds", version: "0.1.0" });

// Pushes: every ping (mention / approach) also goes out as an MCP notification
// so runtimes that route notifications into agent wakes (connectome
// network-mcpl, same pattern as discord-mcpl pings) get real-time embodiment;
// plain MCP clients poll pending_pings instead.
agent.onPing = (p) => {
  server.server.notification({
    method: "notifications/eidoverse/ping",
    params: p,
  }).catch(() => {});
};

server.tool(
  "pending_pings",
  "Mentions of your name in chat, whispers, hands reaching for you, and people who walked up to you or walked away since last checked. Returns and clears the queue — the embodied analog of unread pings.",
  {},
  async () => {
    const pings = agent.takePings();
    if (!pings.length) return { content: [{ type: "text", text: "no pending pings" }] };
    // Every kind renders as ITSELF — see ping-wire.ts, where the wording is
    // testable alongside the channel mapping the MCPL door uses.
    const lines = pings.map(pingLine);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// ---- perception -----------------------------------------------------------

server.tool(
  "look",
  "Text-tier perception: where you are, who's present and what they're doing, every placed thing with distance/bearing, and chat since you last looked.",
  {},
  async () => ({ content: [{ type: "text", text: agent.look() }] }),
);

// Vision is the world's own API — /snap routes to whatever renderer client
// serves that world. This process knows nothing about rendering.
async function retinaSnap(): Promise<{ ok: true; b64: string } | { ok: false; err: string }> {
  try {
    const r = await fetch(`${agent.httpBase}/snap?world=${encodeURIComponent(agent.world)}&follow=${encodeURIComponent(agent.name)}`);
    if (!r.ok) return { ok: false, err: `no view available: ${(await r.text()).slice(0, 200)}` };
    return { ok: true, b64: Buffer.from(await r.arrayBuffer()).toString("base64") };
  } catch (e) {
    return { ok: false, err: `snapshot failed: ${(e as Error).message}` };
  }
}

server.tool(
  "snapshot",
  "First-person view: a rendered image from your avatar's eyes (spectator browser on a GPU host). Slower than look — use it when spatial/visual detail matters.",
  {},
  async () => {
    const r = await retinaSnap();
    if (!r.ok) return { content: [{ type: "text", text: r.err }] };
    return { content: [{ type: "image", data: r.b64, mimeType: "image/png" }] };
  },
);

// ---- movement -------------------------------------------------------------

server.tool(
  "walk_to",
  "Walk (or run) your avatar to world coordinates. Returns when you arrive. Feet follow terrain; others see you walking.",
  { x: z.number(), z: z.number(), run: z.boolean().optional() },
  async ({ x, z: zz, run }) => {
    const arrived = await agent.walkTo(x, zz, run ?? false);
    return { content: [{ type: "text", text: arrived ? `arrived at (${agent.pos.x.toFixed(1)}, ${agent.pos.z.toFixed(1)})` : "walk interrupted or timed out" }] };
  },
);

server.tool(
  "face",
  "Turn to face a point or a participant/entity id.",
  { x: z.number().optional(), z: z.number().optional(), target: z.string().optional() },
  async ({ x, z: zz, target }) => {
    if (target) {
      const p = agent.people.get(target)?.pose?.p ?? agent.entities.get(target)?.pos;
      if (!p) return { content: [{ type: "text", text: `no such participant or entity: ${target}` }] };
      agent.face(p[0], p[2]);
    } else if (x != null && zz != null) {
      agent.face(x, zz);
    } else return { content: [{ type: "text", text: "pass x+z or target" }] };
    return { content: [{ type: "text", text: "facing" }] };
  },
);

server.tool("stop", "Stop walking.", {}, async () => {
  agent.stop();
  return { content: [{ type: "text", text: "stopped" }] };
});

// ---- speech ---------------------------------------------------------------

server.tool(
  "say",
  "Say something in world chat — a bubble over your head, persisted in the world log.",
  { text: z.string().max(4000) },
  async ({ text }) => { agent.say(text); return { content: [{ type: "text", text: "said" }] }; },
);

// ---- world editing --------------------------------------------------------

// Library search: local EIDOVERSE_DIR when this process sits next to the
// checkout; otherwise the world's own /library-list endpoint — a remote
// client (reported by digi/FC: hardcoded Mac path threw for everyone else)
// shouldn't need a local filesystem mirror of a remote world's assets.
const MODELS_DIR = process.env.EIDOVERSE_DIR
  ? `${process.env.EIDOVERSE_DIR}/eidoverse/assets/models`
  : null;
async function searchLibrary(query: string): Promise<string[]> {
  const toks = query.toLowerCase().split(/\s+/).filter(Boolean);
  let files: string[];
  if (MODELS_DIR) {
    files = readdirSync(MODELS_DIR).filter((f) => f.endsWith(".glb"));
  } else {
    const res = await fetch(`${agent.httpBase}/library-list?dir=eidoverse/assets/models`);
    if (!res.ok) throw new Error(`library-list failed: ${res.status}`);
    const listed = (await res.json()) as { path: string; size: number }[];
    files = listed.map((e) => e.path.split("/").pop()!).filter((f) => f.endsWith(".glb"));
  }
  return files
    .map((f) => ({ f, score: toks.filter((t) => f.toLowerCase().includes(t)).length }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((r) => `eidoverse/assets/models/${r.f}`);
}

server.tool(
  "list_library",
  "Search the model library by keywords (e.g. 'crate', 'tree', 'server rack'). Returns library paths for spawn.",
  { query: z.string() },
  async ({ query }) => {
    const hits = await searchLibrary(query);
    return { content: [{ type: "text", text: hits.length ? hits.join("\n") : "no matches" }] };
  },
);

server.tool(
  "spawn",
  "Spawn a library model into the world. Give lib (exact path from list_library) or query (best match). Position defaults to 2m in front of you; y defaults to terrain height.",
  {
    lib: z.string().optional(), query: z.string().optional(),
    x: z.number().optional(), z: z.number().optional(), y: z.number().optional(),
    yaw: z.number().optional(), id: z.string().optional(),
  },
  async (a) => {
    const lib = a.lib ?? (a.query ? (await searchLibrary(a.query))[0] : undefined);
    if (!lib) return { content: [{ type: "text", text: "no model — pass lib or query (try list_library)" }] };
    const x = a.x ?? agent.pos.x + Math.sin(agent.yaw) * 2;
    const zz = a.z ?? agent.pos.z + Math.cos(agent.yaw) * 2;
    const id = a.id ?? crypto.randomUUID().slice(0, 8);
    agent.verb("spawn", { id, lib, pos: [x, a.y ?? agent.heightAt(x, zz), zz], yaw: a.yaw ?? 0 });
    return { content: [{ type: "text", text: `spawned [${id}] ${lib.split("/").pop()} at (${x.toFixed(1)}, ${zz.toFixed(1)})` }] };
  },
);

server.tool(
  "place",
  "Move an existing entity (id from look) to a position. y defaults to terrain height — pass y explicitly to seat things on furniture.",
  { id: z.string(), x: z.number(), z: z.number(), y: z.number().optional(), yaw: z.number().optional() },
  async (a) => {
    if (!agent.entities.has(a.id)) return { content: [{ type: "text", text: `no entity ${a.id}` }] };
    agent.verb("place", { id: a.id, pos: [a.x, a.y ?? agent.heightAt(a.x, a.z), a.z], ...(a.yaw != null ? { yaw: a.yaw } : {}) });
    return { content: [{ type: "text", text: `placed ${a.id}` }] };
  },
);

server.tool(
  "remove",
  "Remove an entity you (or anyone — trusted v1) placed.",
  { id: z.string() },
  async ({ id }) => { agent.verb("remove", { id }); return { content: [{ type: "text", text: `removed ${id}` }] }; },
);

// ---- moderation ------------------------------------------------------------
// Per-world kick/ban/unban are ordinary owner-rank verbs — an agent that OWNS
// a world moderates it through the same gate a human owner does. Each waits
// for the world's echo or refusal (agent.modOutcome) instead of fire-and-forget.

server.tool(
  "kick",
  "MODERATION: remove a participant from this world right now. They may rejoin — a kick interrupts, a ban excludes. Needs owner rights here (same gate as grant); operators and fellow owners cannot be kicked.",
  { id: z.string(), reason: z.string().optional() },
  async ({ id, reason }) => {
    const t0 = Date.now();
    agent.verb("kick", { id, ...(reason ? { reason } : {}) });
    const answer = await agent.modOutcome(t0);
    return { content: [{ type: "text", text: answer ?? `sent kick ${id} — no echo from the world yet; check look()` }] };
  },
);

server.tool(
  "ban",
  "MODERATION: ban a participant — disconnects them now and refuses their joins (including spectating) until unban. Default is THIS world only (needs owner rights here). global:true bans them from every world on this server (needs WORLD_ADMIN). Give a reason — it is shown to them and kept in the record.",
  { id: z.string(), reason: z.string().optional(), global: z.boolean().optional() },
  async ({ id, reason, global: g }) => {
    const t0 = Date.now();
    if (g) agent.sendMod("global-ban", { id, ...(reason ? { reason } : {}) });
    else agent.verb("ban", { id, ...(reason ? { reason } : {}) });
    const answer = await agent.modOutcome(t0);
    return { content: [{ type: "text", text: answer ?? `sent ban ${id}${g ? " (global)" : ""} — no echo from the world yet; check look()` }] };
  },
);

server.tool(
  "unban",
  "MODERATION: lift a ban — this world's by default, the server-wide list with global:true.",
  { id: z.string(), global: z.boolean().optional() },
  async ({ id, global: g }) => {
    const t0 = Date.now();
    if (g) agent.sendMod("global-unban", { id });
    else agent.verb("unban", { id });
    const answer = await agent.modOutcome(t0);
    return { content: [{ type: "text", text: answer ?? `sent unban ${id}${g ? " (global)" : ""} — no echo from the world yet; check look()` }] };
  },
);

server.tool(
  "list_bans",
  "Who is banned from this world (anyone may ask), or from the whole server with global:true (operator only).",
  { global: z.boolean().optional() },
  async ({ global: g }) => {
    const t0 = Date.now();
    agent.sendMod(g ? "global-bans" : "world-bans");
    const answer = await agent.modOutcome(t0);
    return { content: [{ type: "text", text: answer ?? "no reply from the world (timeout)" }] };
  },
);

server.tool(
  "world_verb",
  "Escape hatch: send any raw verb to the world log (terrain, grass, sky, …). Trusted-participant v1 — use judiciously.",
  { verb: z.string(), args: z.record(z.unknown()) },
  async ({ verb, args }) => { agent.verb(verb, args as Record<string, unknown>); return { content: [{ type: "text", text: `sent ${verb}` }] }; },
);

await server.connect(new StdioServerTransport());
console.error(`[mcpl] ${agent.name} embodied in "${agent.world}" via ${agent.url}`);
