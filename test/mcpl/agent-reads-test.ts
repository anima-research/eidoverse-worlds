// agent-reads-test: the agent's roster, terrain, heightmap, geometry and body-bone reads have a deadline (AbortSignal; not
// yet rigbones.ts or physics.ts skeletonFor), and a geometry read that threw or timed out isn't cached, so the next walk
// near that model asks again; an answer is kept, a 4xx one too (a 5xx is the server's trouble: asked again).
//   bun test/mcpl/agent-reads-test.ts
process.env.WORLD_TOKEN = "";
import { suite } from "../gate/suite.ts";
const { WorldAgent } = await import("../../mcpl/agent.ts");

const { check, done } = suite("agent-reads");

type Seen = { url: string; signal: unknown };
const seen: Seen[] = [];
let answer: (url: string) => Promise<Response> = async () => new Response("no", { status: 404 });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, init?: any) => { seen.push({ url: String(u), signal: init?.signal }); return answer(String(u)); }) as typeof fetch;
const readOf = (part: string) => seen.find((s) => s.url.includes(part));
// a deadline is a timeout signal (AbortSignal.timeout), not just any signal
// of at most a minute: an hour-long one is no deadline for an agent's turn
const timed = new WeakMap<AbortSignal, number>(); const realTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = ((ms: number) => { const s = realTimeout(ms); timed.set(s, ms); return s; }) as typeof AbortSignal.timeout;
const bounded = (s: Seen | undefined) => s?.signal instanceof AbortSignal && (timed.get(s.signal) ?? Infinity) <= 60_000;

try {
  const ag: any = new WorldAgent({ name: "reader", world: "reads-bench", url: "ws://127.0.0.1:1/ws" });
  const GRID = "store/heightmaps/0123456789abcdef.json";
  answer = async (url) => url.endsWith("/library/eidoverse/terrain.js") ? new Response("") : new Response("no", { status: 404 });
  await ag.seatCache.init();
  await ag.ground.buildTerrain({ heightmap: { grid: GRID, min: 0, max: 1 } }).catch(() => {});
  await ag.ground.geomFor("store/a.glb");
  await ag.loadBodyBones();
  for (const [what, part] of [["the seat roster", "/avatars"], ["terrain.js", "/library/eidoverse/terrain.js"],
    ["a heightmap's grid", `/library/${GRID}`], ["a model's geometry", "/geom?lib="], ["the body's bones", `/library/${ag.avatar}`]]) {
    const s = readOf(part);
    check(`a read of ${what} has a deadline`, bounded(s), s ? `${s.url}: no signal` : `no read of ${part} was made`);
  }

  // a geometry read that timed out is asked again; one the server answered is kept
  seen.length = 0;
  answer = async () => { throw new DOMException("The operation timed out.", "TimeoutError"); };
  const first = await ag.ground.geomFor("store/slow.glb");
  answer = async () => new Response("no", { status: 404 });
  const second = await ag.ground.geomFor("store/slow.glb");
  const asked = seen.filter((s) => s.url.includes("slow.glb")).length;
  check("a geometry read that timed out isn't kept: the next walk asks again", first === null && second === null && asked === 2, `${asked} read(s)`);
  await ag.ground.geomFor("store/slow.glb");
  const kept = seen.filter((s) => s.url.includes("slow.glb")).length;
  check("...and the server's answer is kept: it isn't asked a third time", kept === 2, `${kept} read(s)`);
  // a 503 is the server's own trouble, not an answer about the model: asked again once it recovers (bot #333 r2 173)
  seen.length = 0;
  answer = async () => new Response("busy", { status: 503 });
  await ag.ground.geomFor("store/busy.glb");
  answer = async () => new Response(JSON.stringify({ bbox: [[0, 0, 0], [1, 1, 1]] }), { headers: { "content-type": "application/json" } });
  const back = await ag.ground.geomFor("store/busy.glb");
  check("a geometry read the server answered 503 isn't kept: the next one gets the geometry", !!back?.bbox && seen.filter((x) => x.url.includes("busy.glb")).length === 2, JSON.stringify(back));
  ag.close();

  // a terrain.js that came back an error page isn't cached: the next build asks again (bot #333 107)
  const ag2: any = new WorldAgent({ name: "reader2", world: "reads-bench", url: "ws://127.0.0.1:1/ws" });
  seen.length = 0;
  answer = async () => new Response("<html>503</html>", { status: 503 });
  await ag2.ground.buildTerrain({ seed: 1, size: 40 }).catch(() => {});
  answer = async (url) => url.endsWith("/library/eidoverse/terrain.js") ? new Response("") : new Response("no", { status: 404 });
  await ag2.ground.buildTerrain({ seed: 1, size: 40 }).catch(() => {});
  const tries = seen.filter((s) => s.url.endsWith("/library/eidoverse/terrain.js")).length;
  check("a terrain.js that answered 503 isn't kept: the next build fetches it again", tries === 2 && ag2.ground.terrainSrc === "", `${tries} read(s), cached ${JSON.stringify(ag2.ground.terrainSrc)}`);
  ag2.close();
  // a terrain build still loading when its body closes commits nothing: the height and water fields are the process's
  // (a successor's by then), so the departed world's ground must not land on them (bot #333 r2 171)
  { const ag3 = new WorldAgent({ url: "ws://127.0.0.1:1/ws", name: "closing", world: "w" } as any);
    let release!: () => void; const held = new Promise<void>((r) => { release = r; });
    answer = async (u) => { if (u.endsWith("/terrain.js")) { await held; return new Response("globalThis.makeTerrain = () => ({ heightAt: () => 7 });"); } return new Response("no", { status: 404 }); };
    (ag3 as any).ground.terrainSrc = null;
    const build = (ag3 as any).ground.buildTerrain({ kind: "noise" });
    ag3.close(); release(); await build.catch(() => {});
    check("a terrain build that finishes after its body closed commits no ground", !(ag3 as any).ground.terrain, String(!!(ag3 as any).ground.terrain)); }
} finally {
  globalThis.fetch = realFetch;
}
done();
