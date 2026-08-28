// approach-env-clamp-test — the advertised live knobs may not silently
// reintroduce the headline defect.
//
// PR #145's review (antra, 2026-08-26): "At defaults the straight-pass
// invariant happens to hold, but it is only a comment." Her exact vectors:
// EW_APPROACH_MAX_WAIT_SEC=1 lets a body that never stopped be announced as
// an approach before it exits; lowering EW_APPROACH_STILL_MPS does the same
// under the default max wait. denoise.ts now CLAMPS the wait to the safe
// bound (2·APPROACH_RADIUS / APPROACH_STILL_MPS) derived from whatever
// stillness threshold is in force.
//
// The knobs are read once at module load, so each hostile combination runs in
// a spawned child of this same file — the non-default-env discriminator the
// review asked for. Run (no env): bun tools/approach-env-clamp-test.ts

import { spawnSync } from "node:child_process";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

const mode = process.argv[2];

if (!mode) {
  // ---- parent: defaults hold the invariant on their own ------------------
  const { APPROACH_MAX_WAIT_MS, APPROACH_SAFE_WAIT_MS } = await import("../mcpl/denoise.ts");
  check("at defaults the invariant holds without clamping",
    APPROACH_MAX_WAIT_MS === 20_000 && APPROACH_SAFE_WAIT_MS <= APPROACH_MAX_WAIT_MS,
    `wait=${APPROACH_MAX_WAIT_MS} safe=${APPROACH_SAFE_WAIT_MS}`);

  for (const [name, env] of [
    ["EW_APPROACH_MAX_WAIT_SEC=1 (review vector: the wait alone)", { EW_APPROACH_MAX_WAIT_SEC: "1" }],
    ["EW_APPROACH_STILL_MPS=0.1 (review vector: the threshold alone)", { EW_APPROACH_STILL_MPS: "0.1" }],
    ["EW_APPROACH_STILL_MPS=0 (rejected outright)", { EW_APPROACH_STILL_MPS: "0" }],
  ] as const) {
    const r = spawnSync(process.execPath, [process.argv[1], "child"],
      { env: { ...process.env, ...env }, encoding: "utf-8" });
    process.stdout.write(r.stdout.replace(/^/gm, "    "));
    check(`under ${name} the clamp held`, r.status === 0, (r.stderr || "").slice(-200));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ---- child: one hostile env, the same straight pass-through --------------
const { APPROACH_MAX_WAIT_MS, APPROACH_SAFE_WAIT_MS, APPROACH_STILL_MPS, APPROACH_RADIUS } =
  await import("../mcpl/denoise.ts");
const { WorldAgent } = await import("../mcpl/agent.ts");

check("the wait can never sit below the safe bound",
  APPROACH_MAX_WAIT_MS >= APPROACH_SAFE_WAIT_MS,
  `wait=${APPROACH_MAX_WAIT_MS} safe=${APPROACH_SAFE_WAIT_MS}`);
check("the stillness threshold is positive", APPROACH_STILL_MPS > 0, String(APPROACH_STILL_MPS));

// A body crossing the bubble on a straight line at just above the effective
// stillness threshold — the slowest crosser that never counts as still, i.e.
// the one that spends the LONGEST possible time inside. If the clamp holds,
// it exits before the max wait and is never announced.
const speed = APPROACH_STILL_MPS * 1.5;
const ag = new WorldAgent({ name: "clamptest" }) as any;
ag.pos = { x: 0, y: 0, z: 0 };
const T0 = Date.now();
const pings: any[] = [];
ag.onPing = (p: any) => pings.push(p);

const z = 0.5, stepMs = 200, stepM = speed * (stepMs / 1000);
let t = 0, inside = 0;
for (let x = -(APPROACH_RADIUS + 1); x <= APPROACH_RADIUS + 1.0001; x += stepM) {
  ag.notePose("digi", { p: [x, 0, z], yaw: 0, speed: 0, clip: "walk" }, T0 + t);
  if (Math.hypot(x, z) < APPROACH_RADIUS) inside++;
  t += stepMs;
}
check("(vacuity guard) the path really entered arm's reach", inside > 0);
check("a straight pass-through is not announced, whatever the knobs say",
  pings.filter((p) => p.kind === "approach").length === 0, JSON.stringify(pings));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
