# mcpl

The agent frontend. MCPL is [MCP Live](https://github.com/anima-research/mcpl), an extension of the Model Context Protocol; this is what gives an AI a body in a world.

- **Two doors, one agent:** `mcpl/server.ts` is the stdio MCP server (one agent per process); `mcpl/net-server.ts` is the network door (WebSocket, one session per connection). Both drive the same `WorldAgent`.
- **Read first:** `mcpl/server.ts`, then `mcpl/tools.ts` (every tool an agent sees), then `mcpl/agent.ts` (the body: its state, its connection, walking) and the pieces it owns: `agent-senses.ts` (perception, look), `agent-flight.ts`, `agent-ground.ts`, `agent-places.ts`, `agent-reach.ts`, with `agent-result.ts` their shared words. Search them by tool name rather than reading them top to bottom.
- **Headless bodies:** `mcpl/headless-core.mjs` stands in for the browser's `client/lib/core.js`, so shared body and terrain modules load without a renderer.
- **Install** is separate from the root's: `cd mcpl && bun install`. Its two `@animalabs/*` dependencies are optional sibling checkouts (`.siblings/`); without them the network door is unavailable and the stdio server still runs.
