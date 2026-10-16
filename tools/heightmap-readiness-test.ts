// heightmap readiness — a real WorldAgent never commits noise in a heightmap's place. A failed grid fetch
// keeps the last ground (and says so in `look`); the grid's later arrival builds that bag exactly once; a
// newer terrain supersedes a waiting one, and a slow old grid cannot commit over it.
//   bun tools/heightmap-readiness-test.ts
// The browser half: tools/heightmap-readiness-browser-test.ts.
process.env.AGENT_BODY_ENGINE = "verlet";
const { WorldAgent } = await import("../mcpl/agent.ts");
const { encodeGrid, shapeReady, shapeParams } = await import("../shared/terrainshape.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// three grids, each one flat value (white = max), each with its own behaviour
const ref = (n: number) => `store/heightmaps/${n.toString(16).padStart(16, "0")}.json`;
const white = JSON.stringify(encodeGrid({ w: 2, h: 2, data: new Uint16Array([65535, 65535, 65535, 65535]) }));
const grids: Record<string, { fail: number; delay: number; hits: number; retryDelay?: number }> = {
  [ref(0xa1)]: { fail: 2, delay: 0, hits: 0 },                    // fails twice, then serves
  [ref(0xa2)]: { fail: 1, delay: 0, hits: 0, retryDelay: 500 },   // fails once; its retry is slow, and overtaken
  [ref(0xa3)]: { fail: 0, delay: 400, hits: 0 },                  // slow
  [ref(0xa4)]: { fail: 99, delay: 400, hits: 0 },                 // slow, and fails
};
const srv = Bun.serve({ port: 0, async fetch(req) {
  const g = grids[new URL(req.url).pathname.replace(/^\/library\//, "")];
  if (!g) return new Response("no", { status: 404 });
  g.hits++;
  await sleep(g.hits > 1 && g.retryDelay ? g.retryDelay : g.delay);
  return g.hits <= g.fail ? new Response("unavailable", { status: 503 }) : new Response(white);
} });

const a: any = new WorldAgent({ name: "walker", world: "hm-ready", url: `ws://127.0.0.1:${srv.port}/ws` });
// the toolkit's noise stands in as one height per seed, so a false commit is visible as that seed
let builds = 0;
a.terrainSrc = "stub";
(globalThis as any).makeTerrain = (args: any) => { builds++; return { heightAt: () => args.seed }; };
a.joined = true;
const hm = (seed: number, grid: string) => ({ seed, size: 40, heightmap: { grid, min: -10, max: 10 } });
const ground = () => a.heightAt(3, 4);
const tickUntil = async (ok: () => boolean, ms = 6000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) { a.tick(); await sleep(50); } return ok(); };

const routeGrid = () => {
  // A real walk constructs/reuses the shipping navgrid. Stop at once: this
  // test owns cache identity, not locomotion.
  const p = a.walkTo(a.pos.x + 1, a.pos.z, false, 1_000, 0.01);
  const grid = a.navGrid?.grid;
  a.stop(); void p;
  return grid;
};

console.log("\na grid that fails, then arrives");
{
  await a.buildTerrain({ seed: 1, size: 40 });
  check("a plain terrain builds", ground() === 1 && builds === 1);
  await sleep(0); // let setHeightField's support generation settle before caching the baseline route
  const beforePending = routeGrid();
  await a.buildTerrain(hm(2, ref(0xa1)));
  check("a heightmap whose grid failed is NOT committed: the last ground stands", ground() === 1 && builds === 1, `ground ${ground()}`);
  const whilePending = routeGrid();
  check("pending grid does not invalidate a route grid on the still-standing ground", whilePending === beforePending);
  check("...it is pending, and the shared readiness law agrees", !!a.pendingTerrain && !shapeReady(shapeParams(hm(2, ref(0xa1)))));
  check("...and look says so", a.look().includes("has not loaded yet"));
  const arrived = await tickUntil(() => ground() === 10);
  check("once the grid comes, that terrain is built — on its grid, not noise", arrived && ground() === 10, `ground ${ground()}`);
  const afterCommit = routeGrid();
  check("the committed grid invalidates the old-ground route grid", afterCommit !== whilePending);
  await tickUntil(() => false, 300);
  check("...exactly once", builds === 2 && !a.pendingTerrain && !a.look().includes("has not loaded yet"), `builds ${builds}`);
}

console.log("\na waiting heightmap superseded by a newer terrain");
{
  await a.buildTerrain(hm(3, ref(0xa2)));
  check("waiting on its grid", !!a.pendingTerrain && ground() === 10);
  await tickUntil(() => grids[ref(0xa2)].hits >= 2);   // its retry is in flight…
  await a.buildTerrain({ seed: 4, size: 40 });       // …when a newer terrain comes
  check("a newer plain terrain builds at once", ground() === 4 && !a.pendingTerrain && builds === 3);
  await tickUntil(() => false, 1000);   // the old grid's retry answers, with the grid
  check("the superseded heightmap never builds, though its grid came", ground() === 4 && builds === 3, `ground ${ground()} builds ${builds}`);
}

console.log("\na slow grid overtaken");
{
  const slow = a.buildTerrain(hm(5, ref(0xa3)));
  await sleep(50);
  await a.buildTerrain({ seed: 6, size: 40 });
  await slow;
  check("the slow old grid lands after a newer terrain, and does not commit over it", ground() === 6 && builds === 4, `ground ${ground()} builds ${builds}`);
  const failing = a.buildTerrain(hm(7, ref(0xa4)));
  await sleep(50);
  await a.buildTerrain({ seed: 8, size: 40 });
  await failing;
  check("a slow FAILED old grid leaves no false 'not loaded' behind the newer terrain", ground() === 8 && !a.pendingTerrain && !a.look().includes("has not loaded yet"));
}

srv.stop(true);
console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : "\n\x1b[32mall passed\x1b[0m");
process.exit(failures ? 1 : 0);
