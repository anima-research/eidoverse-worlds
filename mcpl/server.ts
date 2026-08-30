// eidoverse-worlds agent MCPL — MCP stdio server giving an agent embodied
// presence: a body (WorldAgent), verbs, text-tier perception, and a retina
// (first-person snapshots via a spectator browser session on a GPU host).
//
// Env: WORLD_URL (ws://127.0.0.1:8940/ws), AGENT_NAME (claude),
//      WORLD_NAME (commons), AGENT_AVATAR (vrm library path).
//
// UNIFIED ONTO THE SHARED TABLE (survey §C, ruled §24r). This file used to
// carry its own hand-copied 16-tool subset of net-server's table — drifted
// descriptions, and a stale searchLibrary keeping the hardcoded-Mac-path bug
// R0 had fixed on only one side. Now it is a TRANSPORT: the tool list is
// tools.ts's TOOLS (so this door gains pose/reach/animate/measure/
// world_history/world_debug/the library sheets and every future tool for
// free), dispatch is tools.ts's handleTool, and the only local vocabulary is
// pending_pings — the polling analog of the ping notification below, which a
// channel host doesn't need (its pings arrive as channel messages) but a
// plain-MCP host must be able to ask for.
//
// travel is NOT listed: it is session machinery (channel epochs, join
// gates) that only the WS door carries — this door fronts one WORLD_URL.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WorldAgent } from "./agent.ts";
import { pingLine } from "./ping-wire.ts";
import { toolList, handleTool, type ToolCtx } from "./tools.ts";

const agent = new WorldAgent();
await agent.connect();

// One agent per process: identity persistence is the process env, so the
// remember* hooks are deliberate no-ops; there is no push channel, so
// activity digests are HELD and pending_pings is the wake surface.
const ctx: ToolCtx = {
  agent,
  canPush: () => false,
  heldActivity: [],
  cursor: { caughtUpTo: null },
};

const PENDING_PINGS_TOOL = {
  name: "pending_pings",
  description: "Mentions of your name in chat, whispers, hands reaching for you, and people who walked up to you or walked away since last checked. Returns and clears the queue — the embodied analog of unread pings.",
  inputSchema: { type: "object", properties: {} },
};

const server = new Server(
  { name: "eidoverse-worlds", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [PENDING_PINGS_TOOL, ...toolList({ travel: false })],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = String(req.params.name);
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  if (name === "pending_pings") {
    const pings = agent.takePings();
    if (!pings.length) return { content: [{ type: "text", text: "no pending pings" }] };
    // Every kind renders as ITSELF — see ping-wire.ts, where the wording is
    // testable alongside the channel mapping the MCPL door uses.
    return { content: [{ type: "text", text: pings.map(pingLine).join("\n") }] };
  }
  return await handleTool(ctx, name, args) as { content: { type: string; text?: string }[] };
});

// Pushes: every ping (mention / approach) also goes out as an MCP notification
// so runtimes that route notifications into agent wakes (connectome
// network-mcpl, same pattern as discord-mcpl pings) get real-time embodiment;
// plain MCP clients poll pending_pings instead.
agent.onPing = (p) => {
  server.notification({
    method: "notifications/eidoverse/ping",
    params: p as Record<string, unknown>,
  }).catch(() => {});
};

await server.connect(new StdioServerTransport());
console.error(`[mcpl] ${agent.name} embodied in "${agent.world}" via ${agent.url} — ${toolList({ travel: false }).length + 1} tools (shared table)`);
