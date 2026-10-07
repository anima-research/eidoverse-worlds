// Set a world's time of day: a door `sky` request (persists in the world's v4 log as @world's sky).
//   bun tools/sky.ts [world] [hours] [clouds]     e.g.  bun tools/sky.ts commons 16.8 clear
// The client maps hours→sun elevation/warmth: 12 = noon, ~17 = golden hour,
// <6 / >18 = night. clouds: clear | cumulus (eidoverse sky_system only).
// optional key=val tuners appended after clouds: sun, ambient, fill, exposure (multipliers, default 1)
//   bun tools/sky.ts commons 16.8 clear ambient=1.2 exposure=0.9
//
// Changing @world.sky needs the world's OWNER, so this joins embodied as one (a spectator may read, not write):
//   EW_URL    the sequencer's socket            (default ws://localhost:8940/ws)
//   EW_ID     who to join as                     (default claude)
//   EW_AGENT_TOKEN  that identity's agent bearer, if it is a reserved agent name (mcpl/tokens.json)
//   EW_TOKEN  the door key, if the sequencer has one (JOIN_TOKEN)
// The door's answer is printed: a refusal says why (e.g. "changing @world.sky needs owner; you are visitor").
const [world, hours, clouds] = [Bun.argv[2] ?? "commons", Number(Bun.argv[3] ?? 16.8), Bun.argv[4] ?? "clear"];
const tuners: Record<string, number> = {};
for (const kv of Bun.argv.slice(5)) { const [k, v] = kv.split("="); tuners[k] = Number(v); }
const id = process.env.EW_ID ?? "claude";
const ws = new WebSocket(process.env.EW_URL ?? "ws://localhost:8940/ws");
const fail = (why: string) => { console.error(`sky → ${world}: ${why}`); try { ws.close(); } catch {} process.exit(1); };
const timer = setTimeout(() => fail("no answer from the world in 10 s"), 10_000);
ws.onerror = () => fail("socket error");
ws.onopen = () => ws.send(JSON.stringify({ type: "join", world, id, v4fold: true, token: process.env.EW_TOKEN ?? "",
  ...(process.env.EW_AGENT_TOKEN ? { agentToken: process.env.EW_AGENT_TOKEN, agent: true } : {}) }));
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.type === "error") fail(m.error);
  else if (m.type === "snapshot") ws.send(JSON.stringify({ type: "v4", id: "sky-1", tool: "sky", args: { hours, clouds, ...tuners } }));
  else if (m.type === "v4-result" && m.id === "sky-1") {
    clearTimeout(timer);
    if (!m.ok) fail(`refused: ${m.reply?.refused?.reason ?? JSON.stringify(m.reply)}`);
    console.log(`sky {hours: ${hours}, clouds: ${clouds}${Object.keys(tuners).length ? `, ${JSON.stringify(tuners).slice(1, -1)}` : ""}} → ${world} (as ${m.reply?.seq !== undefined ? `seq ${m.reply.seq}` : "accepted"})`);
    ws.close(); process.exit(0);
  }
};
