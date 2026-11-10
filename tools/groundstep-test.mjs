// groundstep-test — walking downhill keeps the feet on the ground (client/lib/groundstep.js, floor snap).
//
// Drives the REAL groundStep and the REAL selectClip down a slope at 30/60/144 fps, the way controller.js does
// (airborneFor += dt while not grounded), plus a check that controller.js calls groundStep.
//
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/groundstep-test.mjs
//
// Each of these mutations of the PRODUCT must turn a named check red:
//   groundStep: SNAP_SLOPE 1 → 0          → GS1 (downhill flickers into the jump clip, the bug)
//   groundStep: drop the `snap &&` guard   → GS4 (a swimmer would stick to the bed)
//   groundStep: SNAP_SLOPE 1 → 99          → GS2, GS3 (a ledge, and ground steeper than walkable, no longer fall)
//   groundStep: SNAP_MAX 0.3 → 99          → GS6 (a hitch frame snaps a ledge)
//   controller.js: snap: true, a dropped floor, or the eased speed in place of the stride → GS5
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { groundStep, SNAP_SLACK } from '../client/lib/groundstep.js';
import { selectClip } from '../client/lib/locomotion_clip.js';

let fail = 0;
const check = (id, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${detail}`); if (!ok) fail++; };

/** walk along x at `speed` for `secs` over ground(x); returns the clips seen and whether it ever left the ground */
function walk(ground, speed, fps, secs, opts) {
  const dt = 1 / fps; let x = 0, airborneFor = 0; const s = { y: ground(0), vy: 0, grounded: true }; const clips = new Set(); let left = false;
  for (let i = 0; i < secs * fps; i++) {
    x += speed * dt;
    groundStep(s, ground(x), dt, speed * dt, opts);
    if (!s.grounded) left = true;
    airborneFor = s.grounded ? 0 : airborneFor + dt;
    clips.add(selectClip({ mantle: null, jumped: false, airborneFor, wantMove: true, speed, scale: 1, posture: null, seat: null }).clip);
  }
  return { clips: [...clips], left, y: s.y, ground: ground(x) };
}

// GS1: downhill at walkable slopes (≤ 45°), walking and running, at every frame rate: never the jump clip
for (const slope of [0.2, 0.5, 0.9]) for (const speed of [1.4, 4, 7]) for (const fps of [30, 60, 144]) {
  const r = walk((x) => -slope * x, speed, fps, 2);
  check('GS1', !r.clips.includes('jump') && !r.left, `slope ${slope} speed ${speed} @${fps}fps: clips ${r.clips.join(',')}${r.left ? ' (left the ground)' : ''}`);
}
// GS2: a ledge is still a fall: walking off a 1.5 m drop leaves the ground and plays the jump clip, then lands
{ const r = walk((x) => (x < 1 ? 0 : -1.5), 1.4, 60, 3);
  check('GS2', r.left && r.clips.includes('jump') && Math.abs(r.y - r.ground) < 1e-9, `ledge: left ${r.left}, clips ${r.clips.join(',')}, landed at ${r.y.toFixed(3)}`); }
// GS3: ground falling away steeper than walkable (slope 2 and 3) is a fall too, at every frame rate where a frame's
// drop passes the 2 cm slack (below it a body stayed grounded before the snap as well: slope 2 at 144 fps walking)
for (const slope of [2, 3]) for (const fps of [30, 60, 144]) { if (slope * 1.4 / fps <= SNAP_SLACK) continue; const r = walk((x) => -slope * x, 1.4, fps, 1);
  check('GS3', r.left, `slope ${slope} @${fps}fps: left the ground ${r.left}`); }
// GS4: no snap where there's no floor to keep (a swimmer falling toward the bed)
{ const s = { y: 0, vy: 0, grounded: true }; groundStep(s, -0.03, 1 / 60, 0.1, { snap: false, floor: -5 });
  check('GS4', !s.grounded && s.y < 0 && s.y > -0.03, `snap:false falls: grounded ${s.grounded}, y ${s.y.toFixed(4)}`); }
// GS5: the controller calls it with the stride's real distance, the swimmer's floor and no snap in water
{ const here = dirname(fileURLToPath(import.meta.url)); const src = readFileSync(join(here, '../client/lib/controller.js'), 'utf8');
  const call = "groundStep({ y: myState.pos.y, vy, grounded }, support, dt, walked, { floor: swimming ? ground : support, snap: !swimming })";
  check('GS5', src.includes(call) && src.includes('walked = stride.moved') && /import \{ groundStep \} from '\.\/groundstep\.js'/.test(src), 'controller.js passes the stride, the floor and snap: !swimming'); }
// GS6: a hitch frame (dt 0.1, running 7 m/s: 0.7 m walked) off a 0.6 m ledge still falls; standing still never snaps
{ const s = { y: 0, vy: 0, grounded: true }; groundStep(s, -0.6, 0.1, 0.7);
  check('GS6', !s.grounded && s.y > -0.6, `hitch off a 0.6 m ledge: grounded ${s.grounded}, y ${s.y.toFixed(3)}`);
  const t = { y: 0, vy: 0, grounded: true }; groundStep(t, -0.05, 1 / 60, 0);
  check('GS6', !t.grounded, `not walking, floor 5 cm lower: falls (grounded ${t.grounded})`); }

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exit(fail ? 1 : 0);
