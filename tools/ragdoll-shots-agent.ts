// The agent half of tools/ragdoll-shots-probe.mjs (#282): headless WorldAgents on the probe's world, driven
// over stdin (Playwright needs Node; WorldAgent needs Bun). Commands, one per line:
//   spawn <name> <x> <z> <posture>   → joins, walks there, takes the posture, prints "ok <name> <json>"
//   state <name>                     → prints "ok <name> <json>" (published root + posture)
//   bye                              → exits
if (process.env.__EIDO_TEST_CACHE_OFF !== '1') {
  const child = Bun.spawn({
    cmd: [process.execPath, import.meta.path, ...process.argv.slice(2)],
    env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', __EIDO_TEST_CACHE_OFF: '1' },
    stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
  });
  process.exit(await child.exited);
}

const { WorldAgent } = await import("../mcpl/agent.ts");
const URL = process.env.WORLD_URL!, W = process.env.WORLD_NAME!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const agents = new Map<string, any>();
const say = (name: string, ag: any) => console.log(`ok ${name} ${JSON.stringify({ p: [ag.pos.x, ag.pos.y, ag.pos.z], clip: ag.clip })}`);

for await (const line of console) {
  const [cmd, name, ...rest] = line.trim().split(/\s+/);
  if (cmd === "bye") break;
  if (cmd === "spawn") {
    const [x, z, posture] = [Number(rest[0]), Number(rest[1]), rest[2]];
    const ag = new WorldAgent({ url: URL, name, world: W } as any);
    await ag.connect();
    await sleep(800);
    await ag.walkTo(x, z, false, 20000).catch(() => {});
    ag.setPosture(posture);
    await sleep(500);
    agents.set(name, ag);
    say(name, ag);
  } else if (cmd === "state") {
    const ag = agents.get(name);
    if (ag) say(name, ag); else console.log(`ok ${name} null`);
  }
}
for (const ag of agents.values()) ag.close?.();
process.exit(0);
