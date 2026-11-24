// geom-retry-test: an agent's support sync whose /geom ask meets the server's rate limit (429, server/routes.ts geomGate)
// asks again on a timer, backing off, instead of waiting for the thing to change. A join's replay syncs every model at
// once, which is just when the limit is met; a floor refused then would otherwise stay missing for good.
// A stub server: /geom answers 429 (Retry-After 1) the first times it is asked, then the model's box; /library 404s (no mesh).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/mcpl/geom-retry-test.ts
import { suite } from "../gate/suite.ts";
import { WorldAgent } from "../../mcpl/agent.ts";
import { supportHolders } from "../../mcpl/physics.ts";
import { tryUntil } from "../gate/wait.ts";

const S = suite("geom-retry");
const deck = { bbox: { min: [-1, 0, -1], max: [1, 1, 1], size: [2, 1, 2] }, topSurfaces: [] };
let refuseLeft = 2, asked = 0; const askedFor = new Map<string, number>();
// a model of its own: refused `refuse` times, each answer `delay` ms late (R3 orders two models' answers)
const scripted = new Map<string, { refuse: number; delay: number }>();
const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
  const u = new URL(req.url);
  if (u.pathname !== "/geom") return new Response("", { status: 404 });
  asked++; const lib = u.searchParams.get("lib") ?? ""; askedFor.set(lib, (askedFor.get(lib) ?? 0) + 1);
  const sc = scripted.get(lib);
  if (sc) { if (sc.delay) await Bun.sleep(sc.delay);
    if (sc.refuse > 0) { sc.refuse--; return new Response(JSON.stringify({ error: "geometry rate limit", retryAfter: 1 }), { status: 429, headers: { "retry-after": "1", "content-type": "application/json" } }); }
    return Response.json({ lib, ...deck }); }
  if (refuseLeft > 0) { refuseLeft--; return new Response(JSON.stringify({ error: "geometry rate limit", retryAfter: 1 }), { status: 429, headers: { "retry-after": "1", "content-type": "application/json" } }); }
  return Response.json({ lib: u.searchParams.get("lib"), ...deck });
} });

const ag: any = new WorldAgent({ url: `ws://127.0.0.1:${srv.port}/ws`, name: "retry-bot", world: "retry" });
try {
  // what the join replay does for each placed model (agent.ts: trackSupport(syncSupport(id)))
  ag.entities.set("t", { id: "t", model: "crate.glb", pos: [10, 0, 0], yaw: 0, actor: "x" });
  ag.ground.trackSupport(ag.ground.syncSupport("t"));
  await ag.ground.supportReady();
  S.check("R1 setup: the first ask met the rate limit and registered nothing yet", asked === 1 && !ag.ground.supportIds.has("t"), { asked });
  const got = await tryUntil("the crate's support registers after the limit lifts", () => ag.ground.supportIds.has("t") && supportHolders()["retry/t"], { ms: 15_000, step: 100 });
  S.check("R1b a 429 during the join replay still registers the support, asked again on a timer (nothing about the crate changed)", !!got && asked === 3, { asked, ids: [...ag.ground.supportIds.keys()] });

  // a thing re-modelled while its retry waits (the id now another model, its own sync not yet run): the retry, made for
  // the old model, asks about neither (retrySupport's model check; syncSupport alone would ask about the new one)
  refuseLeft = 1;
  ag.entities.set("m", { id: "m", model: "old.glb", pos: [20, 0, 0], yaw: 0, actor: "x" });
  ag.ground.trackSupport(ag.ground.syncSupport("m"));
  await ag.ground.supportReady();
  ag.entities.set("m", { id: "m", model: "new.glb", pos: [20, 0, 0], yaw: 0, actor: "x" });
  const remodelled = await tryUntil("a retry asking for a re-modelled thing", () => (askedFor.get("old.glb") ?? 0) > 1 || askedFor.has("new.glb"), { ms: 3000, step: 100 });
  S.check("R2 a thing re-modelled while its retry waits: the retry asks about neither model", remodelled === undefined, Object.fromEntries(askedFor));

  // a thing removed while its retry waits is not asked about again (syncSupport's own early return covers this one too)
  refuseLeft = 1; const before = asked;
  ag.entities.set("g", { id: "g", model: "gone.glb", pos: [30, 0, 0], yaw: 0, actor: "x" });
  ag.ground.trackSupport(ag.ground.syncSupport("g"));
  await ag.ground.supportReady();
  ag.entities.delete("g");
  const late = await tryUntil("a retry for a removed thing", () => asked > before + 1, { ms: 3000, step: 100 });
  S.check("R2b a thing removed while its retry waits is not asked about again", late === undefined && !ag.ground.supportIds.has("g"), { asked: asked - before });

  // R3: re-modelled while the OLD model's ask is still out: the old sync's 429 lands first and must not take the id's retry
  // slot (it would see the new model and give up), or the new model's 429, landing next, schedules nothing
  scripted.set("a.glb", { refuse: 1, delay: 0 }); scripted.set("b.glb", { refuse: 1, delay: 200 });
  ag.entities.set("r3", { id: "r3", model: "a.glb", pos: [40, 0, 0], yaw: 0, actor: "x" });
  const oldSync = ag.ground.syncSupport("r3");
  ag.entities.set("r3", { id: "r3", model: "b.glb", pos: [40, 0, 0], yaw: 0, actor: "x" });
  ag.ground.trackSupport(oldSync); ag.ground.trackSupport(ag.ground.syncSupport("r3"));
  await ag.ground.supportReady();
  const r3 = await tryUntil("the re-modelled thing's support registers", () => ag.ground.supportIds.has("r3") || null, { ms: 6000, step: 100 });
  S.check("R3 re-modelled while the old model's ask is out: the new model's 429 still asks again, and its support registers", r3 === true && (askedFor.get("b.glb") ?? 0) >= 2, Object.fromEntries(askedFor));

  // R4: measure meeting the geometry limit tells the agent when to ask again (the server's retryAfter), not only the 429
  { const { HANDLERS } = await import("../../mcpl/tools.ts");
    scripted.set("busy.glb", { refuse: 1, delay: 0 });
    const t = ((await HANDLERS.measure(ag, { lib: "busy.glb" }, {}, "measure")) as any).content?.[0]?.text ?? "";
    S.check("R4 measure refused by the geometry limit says when to try again", /429/.test(t) && /try again in 1 ?s/.test(t), t); }
} finally { ag.close(); srv.stop(true); }
S.done();
