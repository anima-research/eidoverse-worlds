// grassdiag — which part of the meadow is eating the GPU? (§22)
//
// tel0s's MacBook holds ~50fps with the meadow, 60 without — and suspects
// the "physics" (the shader-side pusher displacement) rather than the fill.
// On a vsync-bound machine the grass cost hides inside 'render' as GPU
// time, invisible to the per-system CPU bill. So this measures by
// DIFFERENCE: freeze one component at a time for a few seconds and watch
// fps / frame-ms recover. Run from the console:
//
//   await EW.grassDiag()               // ~30s, prints a table, restores all
//   await EW.grassDiag({ secsPer: 5 }) // longer phases on a noisy machine
//
// The phases:
//   pushers off   the 4-slot per-vertex displacement loop goes to zero work
//                 (an empty pusher list — the shader's early-out)
//   autos off     wind + gust + billboards + tile ticks freeze (coarse
//                 bucket: everything riding _autoParticleSystems, pushers
//                 included — reads as "all grass animation")
//   blades far    every tile drops to the 40% far-LOD index (vertex AND
//                 fill shrink together — the §17b lever, forced)
//   density low   instance count to 35% (the governor's deepest shed)
//   grass hidden  the whole field skipped — total grass cost, the ceiling
//
// Interpretation on a 60Hz vsync-bound machine: deltas clamp at the vsync
// floor (16.7ms), so read RECOVERY — the first phase that reaches the
// no-grass fps names the dominant cost.

import { perf } from './perf.js';
import { renderer, THREE } from './core.js';
import { freezePushers, forceBladeLod, setDiagDensityScope, DENSE_BASE } from './flora.js';
import { getGrassField, getGrassDensity, getTerrainMesh, grassTiles } from './terrain.js';
import { skyOwnedObjects } from './sky.js';
import { governorDebug } from './governor.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sample fps/ms/worst over ~secs (1Hz pulses drive perf). */
async function sample(secs) {
  await sleep(1200);                       // settle: one full pulse past the toggle
  const fps = [], ms = [], worst = [];
  let doubled = 0, spikes = 0;
  for (let i = 0; i < Math.max(2, secs - 1); i++) {
    await sleep(1000);
    fps.push(perf.fps); ms.push(perf.ms); worst.push(perf.worst);
    doubled += perf.doubled ?? 0; spikes += perf.spikes ?? 0;
  }
  fps.sort((a, b) => a - b); ms.sort((a, b) => a - b);
  const n = Math.max(2, secs - 1);
  return {
    fps: fps[Math.floor(fps.length / 2)],
    ms: +ms[Math.floor(ms.length / 2)].toFixed(1),
    worst: Math.round(Math.max(...worst)),
    // §22p: pacing vs stutter, separated. doubled/s is EXPECTED to be
    // nonzero whenever fps < refresh (vsync arithmetic); spikes/s > 0 is
    // the only line that means a real hitch.
    doubledPerSec: +(doubled / n).toFixed(1),
    spikesPerSec: +(spikes / n).toFixed(1),
  };
}

export async function grassDiag({ secsPer = 4 } = {}) {
  const field = getGrassField();
  if (!field?.mesh) { console.warn('[grassdiag] no grass field'); return null; }
  const autos = globalThis._autoParticleSystems;
  const savedAutos = autos ? [...autos] : null;
  const savedDensity = getGrassDensity();
  const savedPr = renderer.getPixelRatio();
  const out = [];
  const run = async (name, on, off) => {
    on();
    out.push({ phase: name, ...(await sample(secsPer)) });
    off();
  };
  // §22m: the diag stopped assuming grass owns the frame. Header prints the
  // regime (pixel ratio, buffer size, render-scale dial, per-stroke material
  // generation), and scene-level phases attribute the NON-grass draw too —
  // "grass hidden barely helps" is an answer, not a dead end.
  const g = governorDebug();
  const size = renderer.getDrawingBufferSize?.(new THREE.Vector2()) ?? null;
  const strokes = grassTiles().strokes;
  console.log(`grassdiag regime: pr ${g.pixelRatio} scale⚙ ${g.renderScale}` +
    (size ? ` buffer ${size.x}×${size.y}` : '') + ` dense ${DENSE_BASE}`);
  for (const s of strokes) console.log(`  stroke ${s.stroke}: mode ${s.mode}, drawn ${s.drawn}/${s.planted}`);
  const skyObjs = skyOwnedObjects();
  const skyVis = skyObjs.map((o) => o.visible);
  const terrain = getTerrainMesh();
  try {
    out.push({ phase: 'baseline', ...(await sample(secsPer)) });
    if (skyObjs.length) {
      await run('sky hidden', () => skyObjs.forEach((o) => { o.visible = false; }),
        () => skyObjs.forEach((o, i) => { o.visible = skyVis[i]; }));
    }
    if (terrain) {
      await run('terrain hidden', () => { terrain.visible = false; },
        () => { terrain.visible = true; });
    }
    // per-stroke isolation: with several strokes, name WHICH one bills
    const live = getGrassField()?._strokes ?? [];
    if (live.length > 1) {
      for (const f of live) {
        if (!f.mesh) continue;
        await run(`stroke ${f.strokeLabel ?? '?'} hidden (${f.grassMode ?? '?'})`,
          () => { f.mesh.visible = false; }, () => { f.mesh.visible = true; });
      }
    }
    await run('pushers off', () => freezePushers(true), () => freezePushers(false));
    if (savedAutos) {
      await run('autos off (wind+billboards)', () => { autos.length = 0; },
        () => { autos.push(...savedAutos); });
    }
    await run('blades far-LOD everywhere', () => forceBladeLod('far'), () => forceBladeLod(null));
    await run('density 35%', () => field.setDensity?.(0.35),
      () => field.setDensity?.(savedDensity));
    // §22c second round — the full-window Air run acquitted blade volume and
    // convicted something density-shaped: these three split WHERE and WHAT.
    await run('near ring only @35%', () => setDiagDensityScope({ near: 0.35, far: 1 }),
      () => setDiagDensityScope(null));
    await run('far sea only @35%', () => setDiagDensityScope({ near: 1, far: 0.35 }),
      () => setDiagDensityScope(null));
    await run(`render scale 80% (pr ${(savedPr * 0.8).toFixed(2)})`,
      () => renderer.setPixelRatio(savedPr * 0.8),
      () => renderer.setPixelRatio(savedPr));
    await run('grass hidden', () => { field.mesh.visible = false; },
      () => { field.mesh.visible = true; });
  } finally {
    // belt & braces — a throw mid-phase must not leave the world frozen
    skyObjs.forEach((o, i) => { o.visible = skyVis[i]; });
    if (terrain) terrain.visible = true;
    for (const f of getGrassField()?._strokes ?? []) if (f.mesh) f.mesh.visible = true;
    freezePushers(false);
    forceBladeLod(null);
    setDiagDensityScope(null);
    renderer.setPixelRatio(savedPr);
    if (savedAutos && autos && autos.length !== savedAutos.length) {
      autos.length = 0; autos.push(...savedAutos);
    }
    field.setDensity?.(savedDensity);
    if (field.mesh) field.mesh.visible = true;
  }
  const base = out[0];
  console.log('grass diag — recovery vs baseline names the dominant cost');
  console.log('  (2×/s = vsync-doubled frames, EXPECTED sub-60; spk/s = real >40ms hitches)');
  for (const r of out) {
    const d = r === base ? '' : `  Δ ${r.fps - base.fps >= 0 ? '+' : ''}${r.fps - base.fps}fps ${(r.ms - base.ms).toFixed(1)}ms`;
    console.log(`  ${r.phase.padEnd(28)} ${String(r.fps).padStart(4)}fps ${String(r.ms).padStart(6)}ms  2× ${String(r.doubledPerSec).padStart(4)}/s spk ${String(r.spikesPerSec).padStart(3)}/s${d}`);
  }
  return out;
}
