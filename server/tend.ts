// One-shot world tending: connect as an agent, send door requests, print each answer, leave.
// Usage: bun run server/tend.ts <world> <requests.json>
// requests.json: [{ "tool": "create", "args": {...} }, ...] — the door's tools (help lists them)

const [world = "commons", reqPath] = process.argv.slice(2);
const reqs: { tool: string; args?: Record<string, unknown> }[] = reqPath ? await Bun.file(reqPath).json() : [];

const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT ?? 8940}/ws`);
// JOIN_TOKEN env rides along: a tokened box (the VPS) refuses bare joins
ws.onopen = () => ws.send(JSON.stringify({ type: "join", world, id: "claude", v4fold: true,
  ...(process.env.JOIN_TOKEN ? { token: process.env.JOIN_TOKEN } : {}) }));
let answered = 0, failed = 0;
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.type === "error") { console.error(msg.error); process.exit(1); }
  if (msg.type === "snapshot") { reqs.forEach((r, i) => ws.send(JSON.stringify({ type: "v4", id: i, tool: r.tool, args: r.args ?? {} }))); if (!reqs.length) process.exit(0); }
  if (msg.type === "v4-result") {
    console.log(`${msg.tool}: ${msg.ok ? "ok" : `refused (${msg.reply?.refused?.code}: ${msg.reply?.refused?.reason})`}`);
    if (!msg.ok) failed++;
    if (++answered === reqs.length) { ws.close(); process.exit(failed ? 1 : 0); }
  }
};
setTimeout(() => { console.error("timeout"); process.exit(1); }, 10000);
