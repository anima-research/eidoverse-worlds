// approach-seed-test — reconnect/state replay must SEED, not narrate (issue #39).
//
// The expensive class: after a restart, every body already in the room
// streamed its first pose to a fresh session, and the agent narrated the
// baseline as transitions — "walked up to you" (warm, addressed, answered as
// live) and "sits down" bursts. The contract now: the FIRST spatial
// observation of a person is a baseline. Approach arms only for someone
// first seen properly far away; acts edge-trigger only against a known
// previous pose.
//
// Run: bun tools/approach-seed-test.ts

import { WorldAgent } from "../mcpl/agent.ts";
import { APPROACH_DWELL_MS } from "../mcpl/denoise.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

const pose = (x: number, z: number, clip = "idle", extra: Record<string, unknown> = {}) =>
  ({ p: [x, 0, z], yaw: 0, speed: 0, clip, ...extra });

function rig() {
  const ag = new WorldAgent({ name: "seedtest" }) as any;
  ag.pos = { x: 0, y: 0, z: 0 };
  const acts: any[] = [];
  ag.onEvent = (ev: any) => { if (ev.kind === "act") acts.push(ev); };
  // Offset from a REAL epoch: `cooled` measures against a last-approach time
  // that defaults to 0, so a clock starting near zero reads as "approached a
  // moment ago" and refuses the first knock.
  const T0 = Date.now();
  return { ag, acts, T0, pings: () => ag.takePings().filter((p: any) => p.kind === "approach") };
}

// ---------------------------------------------------------------- the incident: body already beside you at (re)join

{
  const { ag, acts, T0, pings } = rig();
  ag.notePose("digi", pose(1.0, 0.5, "sitstool", { pose: { head: [0, 0, 0, 1] } }));
  check("first observation within arm's reach pings NO approach", pings().length === 0);
  check("first observation narrates NO acts (sitting body stays silent)", acts.length === 0, JSON.stringify(acts));

  // and they cannot "walk up" without actually leaving first
  ag.notePose("digi", pose(1.2, 0.4, "sitstool", { pose: { head: [0, 0, 0, 1] } }));
  ag.notePose("digi", pose(0.8, 0.3, "sitstool", { pose: { head: [0, 0, 0, 1] } }));
  check("shuffling in place near you still pings nothing", pings().length === 0);

  // leave properly (> re-arm radius), come back: NOW it is a real walk-up —
  // but only once they STOP. The crossing alone no longer speaks.
  ag.notePose("digi", pose(9, 0), T0);
  ag.notePose("digi", pose(1.5, 0), T0 + 100);
  check("the crossing alone is not yet an approach", pings().length === 0);
  ag.notePose("digi", pose(1.5, 0), T0 + 100 + APPROACH_DWELL_MS + 50);
  check("leave-and-return and STAY is a REAL approach and pings once", pings().length === 1);
}

// ---------------------------------------------------------------- the normal path is untouched

{
  const { ag, acts, T0, pings } = rig();
  ag.notePose("visitor", pose(15, 0), T0);       // first seen far — baseline, armed
  check("first observation far away pings nothing", pings().length === 0);
  ag.notePose("visitor", pose(6, 0, "walk"), T0 + 100);
  ag.notePose("visitor", pose(2.0, 0, "walk"), T0 + 200);
  // Note the clip is still "walk" and the pose's own `speed` is 0 — neither is
  // consulted. Stillness is the distance WE watched them not cover.
  ag.notePose("visitor", pose(2.0, 0, "walk"), T0 + 200 + APPROACH_DWELL_MS + 50);
  check("a live walk-up still pings approach", pings().length === 1);
  const before = acts.length;
  ag.notePose("visitor", pose(2.0, 0, "sitchair"), T0 + 400 + APPROACH_DWELL_MS);
  check("a live posture TRANSITION still narrates", acts.length === before + 1 && /sits down/.test(acts.at(-1)?.text),
    JSON.stringify(acts.at(-1)));
}

// ---------------------------------------------------------------- null-coordinate shells still seed silently

{
  const { ag, acts, pings } = rig();
  ag.notePose("ghost", { p: [null as any, 0, null as any], yaw: 0, speed: 0, clip: "idle" });
  ag.notePose("ghost", pose(1.1, 0.2, "lie"));   // first REAL coords, right beside us
  check("shell → first real coords is still a baseline (no approach, no acts)",
    pings().length === 0 && acts.length === 0, JSON.stringify(acts));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
