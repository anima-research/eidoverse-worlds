// agent-reads-test: every read the agent makes of the world server has a deadline (AbortSignal), and a geometry read
// that failed or timed out isn't cached, so the next walk near that model asks again; an answer is kept.
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
const bounded = (s: Seen | undefined) => s?.signal instanceof AbortSignal;

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
  ag.close();
} finally {
  globalThis.fetch = realFetch;
}
done();
