// particles-probe — the `particles` component end-to-end through a REAL
// sequencer and a REAL embodied body: author an emitter over websockets,
// watch the flight recorder explain an unrenderable one, and confirm that a
// resident who joins afterwards SEES the fire in look() without being told it
// was just lit. Scratch use only (not part of the pure suite).
//
//   WORLDS_DIR=$(mktemp -d) JOIN_TOKEN=test-door PORT=8996 bun run server/server.ts &
//   WORLD_URL=ws://localhost:8996/ws JOIN_TOKEN=test-door bun tools/particles-probe.ts

// Shorten the world-change coalescing window so the probe doesn't wait four
// seconds per leg. agent.ts reads it at module load, so the import must come
// after (a static import would hoist above this line).
process.env.EW_EMITTER_COALESCE_SEC = "1";
const WINDOW = 1000;
const { WorldAgent } = await import("../mcpl/agent.ts");

const URL = process.env.WORLD_URL ?? "ws://localhost:8996/ws";
const TOKEN = process.env.JOIN_TOKEN ?? "test-door";
const world = `partprobe-${Math.random().toString(36).slice(2, 8)}`;

function connect(id: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const state: any = { ws, entries: [], snapshot: null, live: [], debug: [] };
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", token: TOKEN, world, id }));
    ws.onmessage = (m: MessageEvent) => {
      const msg = JSON.parse(String(m.data));
      if (msg.type === "snapshot") { state.snapshot = msg.state; state.entries = msg.entries ?? []; resolve(state); }
      if (msg.type === "log") state.live.push(msg.entry);
      if (msg.type === "debug") state.debug = msg.events ?? [];
    };
    ws.onerror = (e: unknown) => reject(e);
  });
}
const send = (c: any, verb: string, args: unknown) => c.ws.send(JSON.stringify({ type: "verb", verb, args }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) fails++;
};

const FIRE = {
  preset: "fire", seed: 1234, origin: [0, 0.25, 0], count: 150, quality: "auto",
  texture: "eidoverse/assets/particle_textures/flame_05.png",
};

// ---- author -----------------------------------------------------------------
const author = await connect("probe-author");
send(author, "spawn", { id: "hearth", lib: "deco/bench.glb", pos: [0, 0, 0], yaw: 0 });
send(author, "comp", { id: "hearth", type: "particles", data: FIRE });
await sleep(400);

const compEntry = author.live.find((e: any) => e.verb === "comp" && e.args?.type === "particles");
check("the emitter is an ordinary logged component", Boolean(compEntry));
check("...authored by whoever authored it", compEntry?.actor === "probe-author");
check("...and the log carries the bag verbatim, no per-particle entries",
  JSON.stringify(compEntry?.args?.data) === JSON.stringify(FIRE)
  && author.live.filter((e: any) => e.verb === "comp").length === 1);

// ---- a body that arrives afterwards -----------------------------------------
// Everything below rides the REAL join: snapshot → entries → fold, exactly the
// path a resident's body takes.
const body = new WorldAgent({ url: URL, name: "probe-body", world });
(process.env as Record<string, string>).WORLD_TOKEN ??= TOKEN;
const heard: any[] = [];
body.onEvent = (ev: any) => { if (ev.kind === "world-change") heard.push(ev); };
await body.connect();
await sleep(600);

const seen = body.look();
check("a late joiner's look() names the emitter semantically", /\[hearth\][^\n]*emitting fire/.test(seen),
  seen.split("\n").find((l: string) => l.includes("hearth")));
check("...with the authored local origin", seen.includes("local origin [0, 0.25, 0]"));
check("...and the replay did NOT re-perform the lighting as a live event", heard.length === 0);

// ---- a live change, with a body standing there -------------------------------
send(author, "comp", { id: "hearth", type: "particles", data: { ...FIRE, preset: "smoke" } });
await sleep(600);
check("a live change IS heard, once", heard.length === 1, `got ${heard.length}`);
check("...carrying actor, entity and both states",
  heard[0]?.text?.includes("probe-author") && heard[0]?.text?.includes("[hearth]")
  && heard[0]?.text?.includes("smoke"), heard[0]?.text);
check("the body's look() now reports smoke", /\[hearth\][^\n]*emitting smoke/.test(body.look()));

// ---- the flight recorder explains an emitter that will not emit --------------
send(author, "comp", { id: "hearth", type: "particles", data: { preset: "plasma", glow: true } });
await sleep(500);
author.ws.send(JSON.stringify({ type: "debug", limit: 30 }));
await sleep(400);
const lint = author.debug.filter((d: any) => d.kind === "particles-lint");
check("an unrenderable preset lands in the flight recorder", lint.length >= 1, JSON.stringify(author.debug.slice(-3)));
check("...naming the preset and what would have worked",
  lint.some((d: any) => String(d.why).includes("plasma") && String(d.why).includes("fire")));
check("...and it is advisory: the component still folded",
  Boolean(author.live.find((e: any) => e.args?.data?.preset === "plasma")));
check("...and still reads as an emitter to a resident",
  /\[hearth\][^\n]*emitting "plasma"/.test(body.look()));

// ---- a second, named emitter on the same entity ------------------------------
send(author, "comp", { id: "hearth", type: "particles:wisp", data: { preset: "smoke", scale: 0.05, wobble: 99 } });
await sleep(500);
author.ws.send(JSON.stringify({ type: "debug", limit: 30 }));
await sleep(400);
const named = author.debug.filter((d: any) => d.kind === "particles-lint" && d.component === "particles:wisp");
check("a named emitter's clamp lands in the recorder, saying WHICH emitter",
  named.some((d: any) => String(d.why).includes("wobble clamped")), JSON.stringify(author.debug.slice(-3)));
check("both emitters read on the entity, each under its own key",
  /\[hearth\][^\n]*emitting "plasma"[^\n]*emitting smoke \(particles:wisp;[^)]*scale 0\.05/.test(body.look()),
  body.look().split("\n").find((l: string) => l.includes("hearth")));
send(author, "comp", { id: "hearth", type: "particles:wisp", data: null });
await sleep(300);

// ---- put it out --------------------------------------------------------------
// Past the open coalescing window first: the plasma change above is still
// folding, and an ending inside that window is (correctly) reported when the
// window closes rather than the instant it lands.
await sleep(WINDOW * 2);
heard.length = 0;
send(author, "comp", { id: "hearth", type: "particles", data: null });
await sleep(WINDOW * 2);
check("removing the component ends the emitter in perception", !body.look().includes("emitting"));
check("...and is heard as an ending", heard.length === 1 && heard[0].text.includes("puts out"), heard[0]?.text);

body.close();
author.ws.close();
console.log(fails ? `\n${fails} FAILED` : "\nall probe checks passed");
process.exit(fails ? 1 : 0);
