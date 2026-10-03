// Headless bodies are pushable: the WorldAgent's knockdown semantics, against
// a real scratch sequencer. A body with no physics in-process cannot tumble,
// but it must (1) CONSENT, (2) land displaced the way the shove was taking
// it, (3) slump visibly (clip ragdoll + DOWNED_POSE), (4) perceive the event,
// and (5) stand up clean when it decides to move.
//
//   WORLDS_DIR=$(mktemp -d) JOIN_TOKEN=test-door PORT=8996 bun run server/server.ts &
//   WORLD_URL=ws://localhost:8996/ws WORLD_TOKEN=test-door JOIN_TOKEN=test-door \
//     bun run tools/knockdown-test.ts
// (WORLD_TOKEN is what WorldAgent presents at the door; JOIN_TOKEN is what the
//  test's bare "human" socket presents. Same value, two doors.)

// Bun 1.3.x caches transpiled module graphs globally by content, so a stale
// plugin-resolved path can bypass onResolve entirely and leave the headless
// sim "unavailable" — this suite then measures the canned-slump fallback and
// reports three false failures. #13 added this guard across the suite; this
// file was missed because it reaches the plugin INDIRECTLY, through
// WorldAgent -> physics.ts, rather than registering one itself.
if (process.env.__EIDO_TEST_CACHE_OFF !== '1') {
  const child = Bun.spawnSync({
    cmd: [process.execPath, import.meta.path, ...process.argv.slice(2)],
    env: {
      ...process.env,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
      __EIDO_TEST_CACHE_OFF: '1',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  process.exit(child.exitCode ?? 1);
}

const { WorldAgent } = await import("../mcpl/agent.ts");

const URL = process.env.WORLD_URL ?? "ws://localhost:8996/ws";
const TOKEN = process.env.JOIN_TOKEN ?? "test-door";
const W = `kd-${Math.random().toString(36).slice(2, 8)}`;

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// a "human" — a bare socket that joins, watches, and throws its weight around
function human(name: string): Promise<{ ws: WebSocket; verb: (v: string, a: any) => void; send: (m: any) => void; close: () => void }> {
  return new Promise((res) => {
    const ws = new WebSocket(`${URL}?name=${name}`);
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", world: W, id: name, token: TOKEN }));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "snapshot") res({
        ws,
        verb: (v, a) => ws.send(JSON.stringify({ type: "verb", verb: v, args: a })),
        send: (m2) => ws.send(JSON.stringify(m2)),
        close: () => ws.close(),
      });
    };
  });
}

console.log("knockdown (headless bodies are pushable):\n");

const events: string[] = [];
const ag = new WorldAgent({ url: URL, name: "kd-bot", world: W });
(ag as any).onEvent = (e: any) => { if (e?.text) events.push(String(e.text)); };
await ag.connect();
await sleep(400);
const h = await human("shover");
await sleep(400);

// 1. radial blast: the REAL tumble — sim pose, displaced away, perceived
const before = { x: ag.pos.x, z: ag.pos.z };
h.verb("force", { at: [ag.pos.x - 2, 0, ag.pos.z], power: 4, radius: 6 });
await sleep(2500);
check("a blast knocks the agent down", ag.clip === "ragdoll" && ag.heldPose != null, `clip=${ag.clip}`);
check("...with a SIMULATED pose, not the canned slump",
  ag.heldPose != null && Object.keys(ag.heldPose).length >= 10 && ag.heldPose !== (ag as any).DOWNED_POSE,
  `bones=${ag.heldPose ? Object.keys(ag.heldPose).length : 0}`);
check("...displaced AWAY from the blast", ag.pos.x > before.x + 0.2, `Δx=${(ag.pos.x - before.x).toFixed(2)}`);
check("...lying, not standing (root followed the hips down)", ag.pos.y < -0.2, `y=${ag.pos.y.toFixed(2)}`);
check("...and the agent PERCEIVED it", events.some((t) => t.includes("blast")), events.join(" | "));

// 2. walking stands it up clean — no zombie-walk slump
const downedOffset = ag.pos.y - ag.heightAt(ag.pos.x, ag.pos.z);
await ag.walkTo(ag.pos.x + 1, ag.pos.z, false, 10_000);
check("walking sheds the slump", ag.clip !== "ragdoll" && ag.heldPose == null, `clip=${ag.clip}`);
// #17's pending acceptance receipt, pinned as a regression: "record her
// offset immediately before her first self-authored walk, then confirm 0.00m
// after". A lying rig's root sits its hips offset BELOW the contact surface
// (−0.68 on a flat disc — Princess's reading, and not a second defect), and
// self-authored walking is what reasserts the terrain clamp. The downward
// half was already pinned above; this is the half the thread was waiting on.
check("...and the walk reasserts the terrain clamp — offset back to 0.00m",
  Math.abs(ag.pos.y - ag.heightAt(ag.pos.x, ag.pos.z)) < 0.01,
  `was ${downedOffset.toFixed(2)}m, now ${(ag.pos.y - ag.heightAt(ag.pos.x, ag.pos.z)).toFixed(2)}m`);

// 3. directed shove over the puppet wire: the tumble travels along the lean
const b2 = { x: ag.pos.x, z: ag.pos.z };
h.send({ type: "puppet", target: "kd-bot", ragdoll: { lean: [0, 0, 3] } });
await sleep(2500);
check("a directed shove floors it downwind", ag.clip === "ragdoll" && ag.pos.z > b2.z + 0.3,
  `clip=${ag.clip} Δz=${(ag.pos.z - b2.z).toFixed(2)}`);
check("...and named the shover", events.some((t) => t.includes("shover") && t.includes("knocks you over")), events.join(" | "));

// 4. consent: pushable=false refuses everything, silently and completely
ag.pushable = false;
ag.setPose(null);
const b3 = { x: ag.pos.x, z: ag.pos.z };
h.verb("force", { at: [ag.pos.x, 0, ag.pos.z], power: 6, radius: 6 });
h.send({ type: "puppet", target: "kd-bot", ragdoll: { lean: [3, 0, 0] } });
await sleep(600);
check("pushable=false: unmoved and standing",
  ag.clip !== "ragdoll" && Math.hypot(ag.pos.x - b3.x, ag.pos.z - b3.z) < 0.01,
  `clip=${ag.clip}`);

// 5. replay never re-detonates: a fresh agent folding the log stays standing
ag.close?.();
await sleep(200);
const ag2 = new WorldAgent({ url: URL, name: "kd-bot2", world: W });
await ag2.connect();
await sleep(600);
check("a late joiner folding the force history stays on its feet", ag2.clip !== "ragdoll", `clip=${ag2.clip}`);

// 6. drag release with a nail: the agent's OWN sim hangs the body for real —
// not a held pose pretending, a live Verlet with the pin enforced
const ag3 = new WorldAgent({ url: URL, name: "kd-bot3", world: W });
await ag3.connect();
await sleep(400);
h.verb("force", { at: [ag3.pos.x - 1, 0, ag3.pos.z], power: 4, radius: 6 });
await sleep(2000);
h.send({ type: "bodydrag", target: "kd-bot3", grab: { joint: "head" } });
await sleep(300);
h.send({ type: "bodydrag", target: "kd-bot3", pose: {}, p: [ag3.pos.x, 1.2, ag3.pos.z], yaw: 0 });
await sleep(300);
h.send({ type: "bodydrag", target: "kd-bot3", end: true, pinAt: { joint: "head", at: [ag3.pos.x, 1.9, ag3.pos.z] } });
await sleep(2500);
check("released with a nail: the agent's sim HANGS the body",
  ag3.pins.size === 1 && ag3.pos.y > -0.3, `pins=${ag3.pins.size} y=${ag3.pos.y.toFixed(2)}`);
h.send({ type: "bodydrag", target: "kd-bot3", unpin: { joint: "head" } });
await sleep(2500);
// A body released dead-still from a vertical head-hang drops feet-first and
// can LAND STANDING — the solver has no reason to invent a stumble. So the
// assertion is "came down off the nail", not "ended lying": no longer
// suspended anywhere near the pin height.
check("nail pulled: it comes down off the nail",
  ag3.pins.size === 0 && ag3.pos.y < 0.7, `y=${ag3.pos.y.toFixed(2)}`);
ag3.close?.();

// 7. explicit release carries a FINAL root sample. The dragger streams at
// ~15Hz, so the hand can move between the last ordinary sample and release.
// Browser targets apply end.p before rebuilding their sim; agents must not
// combine a stale root with the release's fresh pose/sim state.
const ag4 = new WorldAgent({ url: URL, name: "kd-bot4", world: W });
await ag4.connect();
await sleep(400);
h.verb("force", { at: [ag4.pos.x - 1, 0, ag4.pos.z], power: 4, radius: 6 });
await sleep(1800);
h.send({ type: "bodydrag", target: "kd-bot4", grab: { joint: "head" } });
await sleep(200);
const held = { head: [0, 0, 0, 1] };
const first = [ag4.pos.x, -0.31, ag4.pos.z];
h.send({ type: "bodydrag", target: "kd-bot4", pose: held, p: first, yaw: 0 });
await sleep(150);
let releaseStart: number[] | null = null;
(ag4 as any).settleFromDrag = async () => { releaseStart = [ag4.pos.x, ag4.pos.y, ag4.pos.z]; };
// A downed avatar root is legitimately below terrain by its hips offset; the
// release must preserve that world-space root rather than clamp or reinterpret it.
const final = [first[0] + 3.0, -0.48, first[2] - 2.0];
h.send({ type: "bodydrag", target: "kd-bot4", end: true, pose: {}, p: final, yaw: 0.7 });
await sleep(150);
check("explicit release applies the final authoritative root before settlement",
  !!releaseStart && releaseStart.every((v, i) => Math.abs(v - final[i]) < 1e-6),
  `started=${JSON.stringify(releaseStart)} final=${JSON.stringify(final)}`);
check("...and applies the release yaw", Math.abs(ag4.yaw - 0.7) < 1e-6, `yaw=${ag4.yaw}`);
check("...and an empty release pose does not wipe the last real pose",
  JSON.stringify(ag4.heldPose) === JSON.stringify(held), `pose=${JSON.stringify(ag4.heldPose)}`);
ag4.close?.();

h.close();
ag2.close?.();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
