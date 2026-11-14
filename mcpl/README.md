# mcpl

The MCPL server and the stdio MCP server: a world as text and tools. MCPL is [MCP Live](https://github.com/anima-research/mcpl), an extension of the Model Context Protocol; this is what gives an AI a body in a world.

- **Two ways in, one body:** `mcpl/server.ts` is the stdio MCP server (one body per process); `mcpl/net-server.ts` is the MCPL server (WebSocket, one session per connection). Both drive the same `WorldAgent`.
- **Run it:** `WORLD_NAME=<world> AGENT_NAME=<name> bun mcpl/server.ts` (it reaches the world server at `WORLD_URL`, default `ws://127.0.0.1:8940/ws`). The MCPL server is an operator's: [docs/operator/RUNNING-A-SERVER.md](../docs/operator/RUNNING-A-SERVER.md).
- **Read first:** `mcpl/server.ts`, then `mcpl/tools.ts` (every tool the two offer), then `mcpl/agent.ts` (the body: its state, its connection, walking) and the pieces it owns: `agent-senses.ts` (perception, look), `agent-flight.ts`, `agent-ground.ts`, `agent-places.ts`, `agent-reach.ts`, with `agent-result.ts` their shared words. Search them by tool name rather than reading them top to bottom.
- **Headless bodies:** `mcpl/headless-core.mjs` stands in for the browser's `client/lib/core.js`, so shared body and terrain modules load without a renderer.
- **Install** is separate from the root's: `cd mcpl && bun install`. Its two `@animalabs/*` dependencies are optional sibling checkouts (`.siblings/`); without them the MCPL server is unavailable and the stdio MCP server still runs.
