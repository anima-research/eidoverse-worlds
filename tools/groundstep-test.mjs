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
//   groundStep: SNAP_SLOPE 1 → 99          → GS2 (a ledge no longer falls)
//   controller.js: stop calling groundStep → GS5
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { groundStep } from '../client/lib/groundstep.js';
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
// GS3: ground falling away steeper than walkable (slope 3) is a fall too
{ const r = walk((x) => -3 * x, 1.4, 60, 1);
  check('GS3', r.left, `slope 3: left the ground ${r.left}`); }
// GS4: no snap where there's no floor to keep (a swimmer falling toward the bed)
{ const s = { y: 0, vy: 0, grounded: true }; groundStep(s, -0.03, 1 / 60, 0.1, { snap: false, floor: -5 });
  check('GS4', !s.grounded && s.y < 0 && s.y > -0.03, `snap:false falls: grounded ${s.grounded}, y ${s.y.toFixed(4)}`); }
// GS5: the controller calls it
{ const here = dirname(fileURLToPath(import.meta.url)); const src = readFileSync(join(here, '../client/lib/controller.js'), 'utf8');
  check('GS5', /groundStep\(\{ y: myState\.pos\.y/.test(src) && /import \{ groundStep \} from '\.\/groundstep\.js'/.test(src), 'controller.js imports and calls groundStep'); }

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exit(fail ? 1 : 0);
