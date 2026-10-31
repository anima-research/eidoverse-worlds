//   bun tools/killz-slumped-test.ts
if (process.env.__EIDO_TEST_CACHE_OFF !== "1") {
  const child = Bun.spawnSync({
    cmd: [process.execPath, import.meta.path, ...process.argv.slice(2)],
    env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", __EIDO_TEST_CACHE_OFF: "1" },
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(child.exitCode ?? 1);
}
process.env.WORLD_TOKEN = "";
const { WorldAgent } = await import("../mcpl/agent.ts");
const { until, tryUntil } = await import("./protocol/wait.ts");
const { scratchSequencer } = await import("./harness.ts");
const { fixture } = await import("./body-fixture.ts");
const { KILL_MARGIN } = await import("../shared/protocol/physconst.js");
const minYFor = (killY: number) => killY + KILL_MARGIN;
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

const W = "killz-slumped";
const lib = fs.mkdtempSync(path.join(os.tmpdir(), "killz-slumped-library-"));
fs.mkdirSync(path.join(lib, "fixtures")); fs.writeFileSync(path.join(lib, "fixtures/body.vrm"), fixture());
const H = await scratchSequencer(W, { worlds: [W], owner: "keeper", serverEnv: { EIDOVERSE_DIR: lib, SKIP_OPT_SWEEP: "1", TRUST_NAMES: "1" } });
const URL = `ws://127.0.0.1:${H.PORT}/ws`;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = "") => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); } };
const agents: any[] = [];
const agent = async (name: string, avatar = "fixtures/body.vrm") => { const a: any = new WorldAgent({ url: URL, name, world: W, avatar }); agents.push(a); await a.connect(); return a; };
try {
  const keeper = await agent("keeper");
  const set = async (component: string, value: unknown) => { const r = await keeper.request("set", { id: "@world", component, value }); if (!r?.ok) throw new Error(`setting @world.${component}: ${JSON.stringify(r)}`); };
  const tiles = Array.from({ length: 64 }, (_, i) => [i % 8, Math.floor(i / 8)]);
  const deck = await keeper.request("create", { components: { transform: { pos: [20, 0, 20] }, structure: { levels: [{ y: 1.5, tiles }] } } });
  if (!deck?.ok) throw new Error(`creating the raised deck: ${JSON.stringify(deck)}`);
  await set("spawn", { pos: [24, 1.5, 24], radius: 1 });
  await set("bounds", { min: [-100, minYFor(-0.5), -100], max: [100, minYFor(100), 100] });
  const fellOf = new Map<any, number>();
  const answers = new Map<any, boolean[]>();
  const watch = (a: any) => {
    fellOf.set(a, 0); answers.set(a, []);
    const request = a.request.bind(a);
    a.request = (verb: string, args: any, ...rest: any[]) => {
      if (!(verb === "move" && args?.reason === "below-bounds")) return request(verb, args, ...rest);
      fellOf.set(a, fellOf.get(a)! + 1);
      return request(verb, args, ...rest).then((r: any) => { answers.get(a)!.push(r?.ok === true); return r; });
    };
  };
  const fellFalling = new Map<any, boolean>();
  const watchFall = (a: any) => { const respawnFell = a.respawnFell.bind(a); a.respawnFell = () => { if (!fellFalling.has(a)) fellFalling.set(a, !!a.simTicker); return respawnFell(); }; };
  const ticks = async (a: any, n: number) => { for (let i = 0; i < n; i++) { const t = a.selfObservedAt; await until("the agent ticks", () => a.selfObservedAt !== t, { ms: 5000, step: 10 }); } };
  const bound = (a: any) => a.replica?.st?.entities?.["@world"]?.c?.bounds?.min?.[1];
  const raise = async (y: number, who: any[]) => {
    await set("bounds", { min: [-100, minYFor(y), -100], max: [100, minYFor(100), 100] });
    await until(`the bodies know the kill line ${y}`, () => who.every((a) => bound(a) === minYFor(y)), { ms: 5000, step: 20 });
  };
  const standingUp = (a: any) => a.clip !== "ragdoll" && !(a.heldPose != null && !a.heldPoseAuthored);
  const onDeck = (a: any) => a.pos.y > 0.5 && a.pos.x >= 20 && a.pos.x <= 28 && a.pos.z >= 20 && a.pos.z <= 28;
  const once = (a: any) => fellOf.get(a) === 1 && answers.get(a)!.join() === "true" && onDeck(a) && standingUp(a);
  const at = (...as: any[]) => as.map((a) => `${a.name}: ${fellOf.get(a)} moves (taken: ${answers.get(a)?.join() ?? ""}), at ${a.pos.x.toFixed(2)},${a.pos.y.toFixed(2)},${a.pos.z.toFixed(2)} clip ${a.clip}${a.heldPose ? a.heldPoseAuthored ? " posed" : " physics pose" : ""}`).join("; ");
  const lying = await agent("lying"), floor = await agent("floor"), posed = await agent("posed"), tumbling = await agent("tumbling"), standing = await agent("standing");
  const canned = await agent("canned", "fixtures/no-such-body.vrm");
  const all = [lying, floor, posed, canned, tumbling, standing];
  await until("the bodies know the world's bounds", () => all.every((a) => bound(a) === minYFor(-0.5)), { ms: 5000, step: 50 });
  await Promise.all([[lying, 6, 6], [floor, -6, 6], [posed, 0, 12], [canned, 12, 0], [tumbling, -6, -6], [standing, 6, -6]].map(([a, x, z]: any[]) => a.walkTo(x, z, false, 15_000)));
  for (const a of all) watch(a);
  watchFall(tumbling);
  const spot = { x: lying.pos.x, z: lying.pos.z };
  const laid = [lying, floor, posed];
  for (const a of [...laid, canned]) a.knockDown(keeper.name, null, "(knocked over)");
  await until("their sims run", () => laid.every((a) => a.clip === "ragdoll" && a.simTicker), { ms: 5000, step: 20 });
  await ticks(lying, 3);
  const running = laid.every((a) => !!a.simTicker);
  check("a body knocked down onto its floor isn't sent back while its sim runs", running && laid.every((a) => fellOf.get(a) === 0), `sims running ${running}; ${at(...laid)}`);
  const settled = await tryUntil("their sims stop", () => laid.every((a) => !a.simTicker), { ms: 30_000, step: 50 });
  posed.flightEnd();
  await ticks(lying, 3); await ticks(posed, 3);
  check("once settled, a body the sim laid on its floor, its root below the kill line, isn't sent back and lies where it fell",
    !!settled && [lying, floor].every((a) => fellOf.get(a) === 0 && a.clip === "ragdoll" && a.pos.y < -0.5) && Math.hypot(lying.pos.x - spot.x, lying.pos.z - spot.z) < 3, `settled ${!!settled}; ${at(lying, floor)}`);
  for (const y of [-0.1, 0]) {
    await raise(y, [lying, floor, posed, canned]);
    for (const a of [lying, floor, posed, canned]) await ticks(a, 3);
    check(`with the kill line at ${y}, a body the sim laid on its floor isn't sent back`, [lying, floor].every((a) => fellOf.get(a) === 0), at(lying, floor));
    check(`…nor a canned slump, nor a physics pose kept under another clip, their roots at the floor`, [canned, posed].every((a) => fellOf.get(a) === 0) && canned.clip === "ragdoll" && posed.clip === "idle" && posed.heldPose != null && !posed.heldPoseAuthored, at(canned, posed));
  }
  const up = await floor.walkTo(floor.pos.x + 1, floor.pos.z, false, 10_000);
  await ticks(floor, 3);
  check("…and a body that gets up on that floor isn't sent back either", up && fellOf.get(floor) === 0 && standingUp(floor) && floor.pos.y >= 0, at(floor));
  tumbling.knockDown(keeper.name, null, "(knocked over)");
  await until("the tumbling body's sim runs", () => tumbling.clip === "ragdoll" && tumbling.simTicker, { ms: 5000, step: 20 });
  await raise(0.5, [tumbling]);
  await tryUntil("the falling body is sent back and answered", () => answers.get(tumbling)!.length > 0, { ms: 15_000, step: 20 });
  await ticks(tumbling, 3);
  check("a body falling as the kill line rises above it is sent back exactly once, while still falling, and arrives standing",
    fellFalling.get(tumbling) === true && once(tumbling), `sim running when sent back ${fellFalling.get(tumbling)}; ${at(tumbling)}`);
  const below = [lying, floor, posed, canned, standing];
  await tryUntil("the bodies below the kill line are sent back and answered", () => below.every((a) => answers.get(a)!.length > 0), { ms: 5000, step: 20 });
  for (const a of below) await ticks(a, 3);
  check("with the kill line raised above it, a body the sim laid down is sent back once, to an arrival place above the line, and arrives standing", once(lying), at(lying));
  check("a standing body the kill line reads as fallen is sent back once, and arrives standing", once(standing) && once(floor), at(standing, floor));
  check("…and so are a canned slump and a physics pose kept under another clip", once(canned) && once(posed), at(canned, posed));
} finally {
  for (const a of agents) { try { a.close(); } catch {} }
  await H.cleanup(failed ? 1 : 0);
  fs.rmSync(lib, { recursive: true, force: true });
}
console.log(`[killz-slumped-test] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
