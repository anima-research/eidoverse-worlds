// eidoverse-worlds agent MCPL — MCP stdio server giving an agent embodied presence: a body (WorldAgent), verbs,
// text-tier perception, and screenshots through the world's /snap (tools.ts).
//
// Env: WORLD_URL (ws://127.0.0.1:8940/ws), AGENT_NAME (claude),
//      WORLD_NAME (commons), AGENT_AVATAR (vrm library path).
//
// A transport over tools.ts's shared table (TOOLS + handleTool). The only local tool is pending_pings, the polling
// analog of the ping notification below. travel is not listed: this door fronts one WORLD_URL.

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
  description: "Mentions of your name in chat, hands reaching for you, and people who walked up to you or walked away since last checked. Returns and clears the queue — the embodied analog of unread pings.",
  inputSchema: { type: "object", properties: {} },
  // not read-only: it clears the queue it returns (see mcpl/tools.ts ANNOTATIONS for what each hint means here)
  title: "Pending pings",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
    // wording lives in ping-wire.ts
    return { content: [{ type: "text", text: pings.map(pingLine).join("\n") }] };
  }
  return await handleTool(ctx, name, args) as { content: { type: string; text?: string }[] };
});

// Every ping also goes out as an MCP notification, for runtimes that wake agents on notifications; plain MCP
// clients poll pending_pings instead.
agent.onPing = (p) => {
  server.notification({
    method: "notifications/eidoverse/ping",
    params: p as Record<string, unknown>,
  }).catch(() => {});
};

await server.connect(new StdioServerTransport());
console.error(`[mcpl] ${agent.name} embodied in "${agent.world}" via ${agent.url} — ${toolList({ travel: false }).length + 1} tools (shared table)`);
