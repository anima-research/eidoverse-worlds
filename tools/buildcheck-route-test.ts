// bun tools/buildcheck-route-test.ts — the build check as a server and an
// agent meet it: an upload answers at once with where its check will be (and
// is never refused for what the check finds), GET /check serves the report
// (cached after the first run), and the check_model tool reads it out.
process.env.AGENT_BODY_ENGINE = "verlet";
process.env.WORLD_TOKEN = "";
const { boxes, buildGlb } = await import("./two-storey-fixture.ts");
const { scratchSequencer, mkCheck, sleep, legacyVerb } = await import("./harness.ts");
const { check, tally } = mkCheck();

const ROOF = [-3.2, 6.3, -3.2, 3.2, 6.5, 3.2];
// a fresh store and check cache: every report here is computed by this run
const { mkdtempSync } = await import("node:fs");
const OPT = mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "checkroute-"));
const h = await scratchSequencer("buildcheck-route", { serverEnv: { SKIP_OPT_SWEEP: "1", OPT_DIR: OPT, TRUST_NAMES: "1" }, worlds: ["checks"], owner: "inspector", portFrom: 9540 });
const { WorldAgent } = await import("../mcpl/agent.ts");
const { handleTool } = await import("../mcpl/tools.ts");
const a: any = new WorldAgent({ name: "inspector", world: "checks", url: h.BASE.replace("http", "ws") + "/ws" });
const ctx = { agent: a, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } };
const tool = async (name: string, args: Record<string, any>) => ((await handleTool(ctx as any, name, args)) as any).content.map((c: any) => c.text).join("\n");
try {
  await a.connect();
  const t0 = performance.now();
  const up = await (await fetch(`${h.BASE}/upload?name=checked-tower`, { method: "POST", body: await buildGlb([...boxes, ROOF] as any) })).json() as any;
  const upMs = performance.now() - t0;
  check("an upload answers at once, with where its check will be", typeof up.path === "string" && up.check === `/check?lib=${encodeURIComponent(up.path)}` && upMs < 3000, `${JSON.stringify(up)} in ${upMs.toFixed(0)}ms`);
  // a model with a problem is stored all the same — the check is advice
  // a 0.3 m door (protocol merge: the mover's body needs more than 0.4 m; it was 0.5 m, under main's 0.64)
  const narrowBoxes = [...boxes.filter((b: number[]) => !(b[2] === 2.8 && b[5] === 3)), [-3, 0.3, 2.8, -0.15, 6.3, 3], [0.15, 0.3, 2.8, 3, 6.3, 3], [-0.15, 2.4, 2.8, 0.15, 6.3, 3], ROOF];
  const bad = await (await fetch(`${h.BASE}/upload?name=narrow-tower`, { method: "POST", body: await buildGlb(narrowBoxes as any) })).json() as any;
  check("an upload the check will find fault with is still accepted", typeof bad.path === "string" && bad.path !== up.path, JSON.stringify(bad));

  const r = await (await fetch(`${h.BASE}${up.check}`)).json() as any;
  check("GET /check serves the report: no problems, two floors, a room on each, a door and a stair",
    r.ok === true && r.levels.length === 2 && r.suggested.rooms.length === 2 && r.suggested.doors.length >= 1 && r.suggested.stairs.length === 1,
    JSON.stringify({ ok: r.ok, warnings: r.warnings, levels: r.levels, rooms: r.suggested?.rooms?.length }));
  const t1 = performance.now();
  const again = await (await fetch(`${h.BASE}${up.check}`)).json() as any;
  check("a second ask is answered from the cache", JSON.stringify(again) === JSON.stringify(r) && performance.now() - t1 < 500, `${(performance.now() - t1).toFixed(0)}ms`);
  const rb = await (await fetch(`${h.BASE}${bad.check}`)).json() as any;
  check("the faulty one's report names the narrow doorway", rb.warnings?.some((w: any) => w.kind === "narrow"), JSON.stringify(rb.warnings));
  check("an unknown asset is a 404 with a reason", (await fetch(`${h.BASE}/check?lib=store/nope.glb`)).status === 404);

  await legacyVerb(a, "spawn", { id: "tower", lib: up.path, pos: [0, a.heightAt(0, 0), 0], yaw: 0 });
  for (let i = 0; i < 40 && !a.entities.get("tower"); i++) await sleep(50);
  const said = await tool("check_model", { id: "tower" });
  check("check_model reads it out for a placed thing: walk-in, floors, no problems, suggestions and the comp to name them",
    /\[tower\].*walk-in; 2 floors/.test(said) && /No problems found/.test(said) && /Suggested places/.test(said) && /act \{verb: "set", args: \{id: "tower", component: "places"/.test(said), said);
  // checked as placed: the model scaled, the body not. A one-room hall 8m
  // square and 4m tall, its door `door` wide.
  const hall = (door: number) => [[-4, 0, -4, 4, 0.1, 4], [-4, 0.1, -4, -3.8, 4, 4], [3.8, 0.1, -4, 4, 4, 4], [-4, 0.1, -4, 4, 4, -3.8],
    [-4, 0.1, 3.8, -door / 2, 4, 4], [door / 2, 0.1, 3.8, 4, 4, 4], [-door / 2, 3, 3.8, door / 2, 4, 4], [-4, 4, -4, 4, 4.2, 4]];
  // protocol merge: the mover's body (radius 0.2, a push under 5 cm a nudge) gets through more than 0.3 m (main's 0.54), so the
  // doors are 0.45 m and 0.25 m (were 0.9 and 0.5)
  const wide = await (await fetch(`${h.BASE}/upload?name=wide-hall`, { method: "POST", body: await buildGlb(hall(0.45) as any) })).json() as any;
  const slim = await (await fetch(`${h.BASE}/upload?name=slim-hall`, { method: "POST", body: await buildGlb(hall(0.25) as any) })).json() as any;
  // 0.45m door at 0.6×: 0.27m, narrower than a body; 0.25m door at 1.6×: 0.4m, a body fits
  await legacyVerb(a, "spawn", { id: "small", lib: wide.path, pos: [40, a.heightAt(40, 0), 0], yaw: 0, scale: 0.6, collide: "exact" });
  await legacyVerb(a, "spawn", { id: "big", lib: slim.path, pos: [80, a.heightAt(80, 0), 0], yaw: 0, scale: 1.6 });
  await legacyVerb(a, "spawn", { id: "forced", lib: up.path, pos: [60, a.heightAt(60, 0), 0], yaw: 0, collide: "box" });
  for (let i = 0; i < 40 && !(a.entities.get("small") && a.entities.get("big") && a.entities.get("forced")); i++) await sleep(50);
  const plain = await tool("check_model", { lib: wide.path });
  check("(the 0.45m-doored hall at its own size: no problems)", /No problems found/.test(plain), plain.slice(0, 300));
  const saidSmall = await tool("check_model", { id: "small" });
  check("check_model on that hall placed at 0.6× checks it at 0.6×: its doorway is now narrower than a body",
    /\[small\] .* at scale 0.6: walk-in/.test(saidSmall) && /narrower than a body/.test(saidSmall) && !/No problems found/.test(saidSmall), saidSmall.slice(0, 500));
  const slimPlain = await tool("check_model", { lib: slim.path });
  check("(the 0.25m-doored hall at its own size: too narrow)", /narrower than a body/.test(slimPlain), slimPlain.slice(0, 300));
  const saidBig = await tool("check_model", { id: "big" });
  check("...and the 0.25m-doored hall placed at 1.6× gets in: no narrow passage, every floor reachable",
    /at scale 1.6: walk-in/.test(saidBig) && !/narrower than a body/.test(saidBig) && /No problems found/.test(saidBig), saidBig.slice(0, 500));
  const viaLib = await tool("check_model", { lib: wide.path, scale: 0.6 });
  check("check_model {lib, scale} is the same check before placing", /at scale 0.6/.test(viaLib) && /narrower than a body/.test(viaLib), viaLib.slice(0, 300));
  const r6 = await (await fetch(`${h.BASE}${up.check}&scale=1.5`)).json() as any;
  const r1 = await (await fetch(`${h.BASE}${up.check}`)).json() as any;
  const room = (r: any) => Object.values(r.suggested.places).find((p: any) => p.min) as any;
  check("GET /check?scale= reports in world metres, its suggested places back in the model's own frame",
    r6.scale === 1.5 && r6.levels.some((l: any) => Math.abs(l.y - 0.45) < 0.05) && r6.levels.some((l: any) => Math.abs(l.y - 4.95) < 0.05) && !!room(r6) && Math.abs(room(r6).min[0] - room(r1).min[0]) < 0.2,
    JSON.stringify({ levels: r6.levels, room15: room(r6), room1: room(r1) }).slice(0, 300));
  const saidForced = await tool("check_model", { id: "forced" });
  check("...and on one spawned collide: \"box\": solid, for that reason", /SOLID — spawned as a box/.test(saidForced) && /collide: "box"/.test(saidForced), saidForced.slice(0, 300));
  const saidBad = await tool("check_model", { lib: bad.path });
  check("...and the problems, for a library path", /Problems:\n  - .*narrower than a body/.test(saidBad), saidBad.slice(0, 400));
  // review r3 F1: the door is public, so new work is rate-limited per address (a cached answer never is)
  {
    const asks = Array.from({ length: 11 }, (_, i) => fetch(`${h.BASE}${up.check}&scale=${(0.3 + i * 0.01).toFixed(2)}`, { headers: { "x-real-ip": "10.7.7.7" } }));
    const quick: Response[] = [];
    asks.forEach((p) => p.then((res) => quick.push(res)));
    await sleep(1500);
    const limited = quick.filter((res) => res.status === 429);
    const body = limited[0] ? await limited[0].json() as any : null;
    check("GET /check: a burst of new checks from one address is refused 429 past the limit, in words, with retry-after",
      limited.length === 1 && /rate limit/.test(body?.error ?? "") && Number(limited[0].headers.get("retry-after")) > 0, JSON.stringify({ statuses: quick.map((x) => x.status), body }));
    const cachedAsk = await fetch(`${h.BASE}${up.check}`, { headers: { "x-real-ip": "10.7.7.7" } });
    check("...and that address is still answered at once from the cache", cachedAsk.status === 200, String(cachedAsk.status));
  }
} finally {
  try { a.close(); } catch { /* gone */ }
  (await import("node:fs")).rmSync(OPT, { recursive: true, force: true });
  await h.cleanup(tally.failed || process.exitCode ? 1 : 0);
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
