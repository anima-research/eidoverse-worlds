// GET /heightmap through a real scratch sequencer: the public export door's budget is a gate in front of
// the work, not a report after it. Six new exports a minute are served; the seventh is refused WITHOUT
// sampling (asking for it again is still refused — nothing was cached); a cached answer still serves.
//   bun tools/heightmap-route-test.ts
import { join } from "node:path";
const { scratchSequencer, mkCheck } = await import("./harness.ts");
const { foundWorld } = await import("../server/worldlog.ts");
const { openLive } = await import("../server/livehost.ts");
const { request } = await import("../shared/protocol/authority.js");
const { check, tally } = mkCheck();

const terrain = { seed: 11, size: 160, segments: 256, amplitude: 1.2, flatRadius: 12,
  features: [{ type: "hill", x: 42, z: -28, radius: 30, height: 16 }, { type: "ridge", x1: -60, z1: -55, x2: 20, z2: -62, radius: 9, height: 7 }] };
const h = await scratchSequencer("heightmap-route", {
  serverEnv: { SKIP_OPT_SWEEP: "1" }, portFrom: 9420,
  // a world founded the way an operator founds one (tools/protocol/world.ts found), whose owner then sets @world's
  // terrain component through the authority — the protocol's spelling of upstream's hand-written v1 `terrain` entry
  prepare: (scratch) => {
    const dir = join(scratch, "worlds", "hm");
    const { owner } = foundWorld(dir, "hm", "builder");
    const r = request(openLive(dir, "hm"), owner, "set", { id: "@world", component: "terrain", value: terrain });
    if (!r.ok) throw new Error(`seeding the terrain was refused: ${JSON.stringify(r.refused)}`);
  },
});
const get = async (q: string, ip = "9.9.9.9") => {
  const t0 = performance.now();
  const r = await fetch(`${h.BASE}/heightmap?world=hm&${q}`, { headers: { "x-real-ip": ip } });
  const body = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, ms: performance.now() - t0, bytes: body.length, retry: r.headers.get("retry-after") };
};
try {
  const json = await get("format=json");
  check("the json range answers without an export", json.status === 200);
  const six = [];
  for (let res = 507; res <= 512; res++) six.push(await get(`res=${res}`));
  check("six new near-maximum exports are served", six.every((r) => r.status === 200 && r.bytes > 100_000), six.map((r) => r.status).join(","));
  const slowest = Math.max(...six.map((r) => r.ms));
  const seventh = await get("res=513");
  check("the seventh is refused with 429 and a Retry-After", seventh.status === 429 && Number(seventh.retry) > 0);
  check(`...in a fraction of an export's time (${seventh.ms.toFixed(1)} ms vs ${slowest.toFixed(0)} ms)`, seventh.ms < slowest / 3);
  const again = await get("res=513");
  check("asking again is refused again: the refused export was never made or cached", again.status === 429, `${again.status} ${again.bytes}B`);
  const cached = await get("res=509");
  check("an export already made still serves to the same address", cached.status === 200 && cached.bytes > 100_000);
  check("another address has its own budget", (await get("res=513", "8.8.8.8")).status === 200);
} finally {
  await h.cleanup(tally.failed ? 1 : 0);
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
