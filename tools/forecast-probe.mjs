// forecast-probe — end-to-end through a REAL sequencer: author a forecast
// policy, land a manual override, rejoin as a late client, and assert the
// folded sky that comes back carries stamped provenance and derives the same
// weather the live path derived. Scratch use only (not part of the suite).
//
//   WORLDS_DIR=$(mktemp -d) PORT=8996 bun run server/server.ts &
//   WORLD_URL=ws://localhost:8996/ws bun tools/forecast-probe.mjs

import { effectiveSky, describeSky } from "../shared/forecast.js";

const URL = process.env.WORLD_URL ?? "ws://localhost:8996/ws";
const world = `probe-${Math.random().toString(36).slice(2, 8)}`;

function connect(id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const state = { ws, entries: [], snapshot: null, live: [] };
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", world, id }));
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.type === "snapshot") { state.snapshot = msg.state; state.entries = msg.entries ?? []; resolve(state); }
      if (msg.type === "entry") state.live.push(msg.entry);
    };
    ws.onerror = (e) => reject(e);
  });
}

const send = (c, verb, args) => c.ws.send(JSON.stringify({ type: "verb", verb, args }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) fails++;
};

// author: rated day + forecast policy
const author = await connect("probe-author");
send(author, "sky", {
  hours: 8, rate: 24, weather: "clear",
  forecast: { seed: 7, states: ["clear", "overcast", "rain"], dwellSec: [300, 900], transitionSec: 20,
    epoch: 1, seq: 9999, by: "mallory" },   // spoof attempt — the fold must overwrite
});
await sleep(300);
send(author, "weather", { weather: "storm", weatherK: 1.1 });
await sleep(500);

// late joiner: the folded/replayed sky is all it gets
const late = await connect("probe-late");
const skyEntries = [...late.entries.filter((e) => e.verb === "sky" || e.verb === "weather")];
check("late joiner sees the sky+weather history (or fold)", skyEntries.length > 0 || late.snapshot?.sky);

// fold the way the client does (world.js applyEntry): sky replaces, weather merges
// — or take the snapshot's sky if the log was already folded server-side
import("../shared/forecast.js").then(() => {});
const { foldSkyEntry } = await import("../shared/forecast.js");
let sky = late.snapshot?.sky ?? null;
for (const e of skyEntries) sky = foldSkyEntry(e.verb === "sky" ? null : sky, e);

check("forecast provenance is server-stamped", sky?.forecast?.by === "probe-author" && sky?.forecast?.epoch > 1e12,
  JSON.stringify(sky?.forecast));
check("spoofed stamps did not survive", sky?.forecast?.seq !== 9999 && sky?.forecast?.by !== "mallory");
check("manual override recorded with actor + seq", sky?.override?.state === "storm" && sky?.override?.by === "probe-author",
  JSON.stringify(sky?.override));

const now = Date.now();
const eff = effectiveSky(sky, now);
check("derived source right now is the manual override", eff.source === "manual" && eff.weather === "storm",
  `${eff.source}/${eff.weather}`);
const hour = describeSky(sky, now);
check("narration is legible", /manual override/.test(hour) && /probe-author/.test(hour), hour);
console.log(`  narration: ${hour}`);

// day continuity: hour must reflect ~8 + 24*(elapsed) — i.e. NOT snapped back to 8.0
// (elapsed is under a second of wall time here, so just assert the formula's inputs
// survived the weather merge: hours was rebased onto the override's ts)
check("weather merge rebased hours (no day-snap)", Math.abs(sky.hours - 8) < 0.1 && sky.ts === sky.override.ts,
  `hours ${sky.hours} ts ${sky.ts} override.ts ${sky.override?.ts}`);

author.ws.close(); late.ws.close();
console.log(fails ? `\n${fails} FAILED` : "\nall probe checks passed");
process.exit(fails ? 1 : 0);
