// water — a world's one water level, drawn (shared/terrainshape.js waterParams).
//
// A flat sheet at `level` over the terrain square. Every vertex carries how deep the water is THERE
// (level minus the ground under it), baked once at build, and the material reads that depth: clear and
// pale in the shallows, the world's colour further out, foam where the depth runs to nothing at the shore.
// Triangles wholly over dry ground are dropped from the index, so the sheet costs what the lakes cost,
// not what the whole square would. The ripple is a moving normal, not moving vertices, so the shoreline
// foam stays exactly where the ground meets the water.
//
// KINDS (shared/waterkind.js): the same level fills a bowl, a channel and the open edge of the world,
// and those are different water. The shape of each wet body says which — still, river, ocean — and each
// vertex is told its kind, a river's flow, and the sea's way in to shore. The material reads them: still
// water lies nearly mirror-calm; a river's ripples and foam streaks are carried down its channel; the
// sea rolls a swell in toward the shore whose swash runs the waterline up and down the beach.
// Foam is made by water moving at the edge: the waterline's speed up the beach, weighted by wave size.
//
// Nothing here moves bodies — wading is the controller's (and the agents') rule, from the same level.
import { THREE, scene } from './core.js';
import { attribute, mix, smoothstep, vec3, float, positionGeometry, uniform, sin, cos, max, normalize, color, transformNormalToView } from 'three/tsl';
import { OCEAN, RIVER, STILL, waveClock, cyc } from '../../shared/waves.js';
import { setWaterField } from './terrain.js';
import { waterParams } from '../../shared/terrainshape.js';
import { analyzeWater, waterGridSeg } from '../../shared/waterkind.js';

let current = null;   // { mesh, level }

// THE WAVE CLOCK (shared/waves.js): the surface runs on the world's synced time, wrapped to WAVE_PERIOD, so a
// swell a swimmer rises on is the swell everyone sees. main.js hands in the synced clock; until it does,
// the page's own (unsynced) time stands in.
const waveT = uniform(0);
let clock = () => Date.now();
/** Give the water the world's synced milliseconds (remotes.js serverNow). */
export function setWaveClock(fn) { clock = fn; }
/** Wave time now, in seconds into the period — what the shader and the floating bodies both read. */
export const waveTime = () => waveClock(clock());

/** The world's water level, or null when it has none. */
export const waterLevel = () => current?.level ?? null;

/** Build (or replace, or remove) the water for terrain-verb args over the ground `heightAt`. */
export function applyWater(args, heightAt) {
  if (current) {
    if (current.mesh) {
      scene.remove(current.mesh);
      current.mesh.geometry.dispose();
      current.mesh.material.dispose();
    }
    current = null;
  }
  setWaterField(null);
  const W = waterParams(args);
  if (!W) return;
  const size = typeof args?.size === 'number' ? args.size : 80;
  // about a metre a vertex (2 m on the biggest worlds), so a small pond is not stepped over
  const seg = waterGridSeg(size);
  // the analysis grid IS the mesh's vertex grid: PlaneGeometry rotated flat lists vertex (i, j) at
  // x = -size/2 + i·cell, z = -size/2 + j·cell, row by row — the same order waterkind indexes
  const A = analyzeWater(heightAt, size, { level: W.level, kind: args.water?.kind, flow: args.water?.flow }, seg);
  // The level is the world's whether or not the sheet shows: wading, depth and floating read it, not the mesh.
  current = { mesh: null, level: W.level, analysis: A };
  // what floats reads the same water (ammodoll.js, through terrain.js's seam)
  setWaterField({ level: W.level, sample: (x, z) => A.sample(x, z), time: waveTime });
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const n = A.n, N = n * n, depth = A.depth;
  // Dry vertices near the water take their NEAREST water's kind, flow and way-to-shore (a multi-source
  // walk out from the wet cells, a few metres), so a wave has a beach to run up and the surf, streaks and
  // ripples reach the waterline instead of fading across the last triangle.
  const src = new Int32Array(N).fill(-1), q = [];
  for (let k = 0; k < N; k++) if (depth[k] > 0) { src[k] = k; q.push(k); }
  const REACH = Math.ceil(8 / A.cell);
  const hops = new Uint16Array(N);
  for (let h = 0; h < q.length; h++) {
    const k = q[h]; if (hops[k] >= REACH) continue;
    const i = k % n, j = (k - i) / n;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
      const m = jj * n + ii;
      if (src[m] >= 0) continue;
      src[m] = src[k]; hops[m] = hops[k] + 1; q.push(m);
    }
  }
  // how far UP the shore each kind's water can reach: the sea's swash climbs; still water and rivers barely
  const RUNUP = [0.08, 0.1, 1.1];
  const runupAt = (k) => (src[k] >= 0 ? RUNUP[A.kind[src[k]]] : 0);
  const idx = geo.index.array, keep = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (depth[a] > -runupAt(a) || depth[b] > -runupAt(b) || depth[c] > -runupAt(c)) keep.push(a, b, c);
  }
  if (!keep.length) return;   // no vertex is under water: nothing to draw (the level still stands)
  geo.setIndex(keep);
  const kindw = new Float32Array(N * 3), flow = new Float32Array(N * 3), shore = new Float32Array(N * 3);
  for (let k = 0; k < N; k++) {
    const m = src[k] >= 0 ? src[k] : k;
    kindw[3 * k + A.kind[m]] = 1;
    // the ripples' speed: one per river (its waveSpeed, rounded to wrap with the clock — waterkind.js)
    flow[3 * k] = A.flow[2 * m]; flow[3 * k + 1] = A.flow[2 * m + 1]; flow[3 * k + 2] = A.comp[m] >= 0 ? A.bodies[A.comp[m]].waveSpeed ?? 0 : 0;
    shore[3 * k] = A.toShore[2 * m]; shore[3 * k + 1] = A.toShore[2 * m + 1];
    // the ground's slope here (rise per metre): a wave lifting the water by h moves the waterline h/slope
    // across the beach — which is what foam follows
    const i = k % n, j = (k - i) / n;
    const dx = (depth[j * n + Math.min(n - 1, i + 1)] - depth[j * n + Math.max(0, i - 1)]) / (2 * A.cell);
    const dz = (depth[Math.min(n - 1, j + 1) * n + i] - depth[Math.max(0, j - 1) * n + i]) / (2 * A.cell);
    shore[3 * k + 2] = Math.hypot(dx, dz);
  }
  geo.setAttribute('depth', new THREE.BufferAttribute(depth, 1));
  geo.setAttribute('wkind', new THREE.BufferAttribute(kindw, 3));
  geo.setAttribute('wflow', new THREE.BufferAttribute(flow, 3));
  geo.setAttribute('wshore', new THREE.BufferAttribute(shore, 3));

  const mat = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, roughness: 0.08, metalness: 0 });
  const d = attribute('depth'), K = attribute('wkind'), F = attribute('wflow'), S = attribute('wshore');
  const still = K.x, river = K.y, ocean = K.z;
  // the RAW vertex position (before the waves lift it), so the vertex and fragment stages compute the same
  // wave; the mesh sits at (0, level, 0) unrotated, so its x/z ARE world x/z — the same on every client
  const px = positionGeometry.x, pz = positionGeometry.z, t = waveT;

  // ---- the surface's height above the level, and how fast it is rising, for each kind --------------
  // STILL — a breath of wind, millimetres
  const sPh = px.mul(STILL.kx).add(pz.mul(STILL.kz)).sub(t.mul(STILL.w));
  const sAmp = float(STILL.amp);
  // RIVER — standing chop carried down the channel: `a` runs along the flow, `c` across it
  const a = px.mul(F.x).add(pz.mul(F.y)), c = pz.mul(F.x).sub(px.mul(F.y));
  // the cross train is the main one at 0.6 of its wavenumber (same speed downstream), angled by `c`: both
  // run whole cycles a wave period for a riverSpeed-rounded F.z (waves.js RIVER_SPEED_STEP)
  const ph1 = a.sub(t.mul(F.z)).mul(RIVER.k), ph2 = ph1.mul(0.6).add(c.mul(1.7));
  const rAmp = float(RIVER.amp);
  // OCEAN — two swells rolling in along `o`, the way to shore. Deep-water dispersion, ω = √(g·k): the
  // long swell (31 m) runs at 7 m/s, the shorter (19 m) at 5.5. Height grows offshore and keeps a third of
  // itself right up the beach — that remainder is the swash that moves the waterline.
  const o = px.mul(S.x).add(pz.mul(S.y)), oc = pz.mul(S.x).sub(px.mul(S.y));
  const { k1, w1, k2, w2 } = OCEAN;
  const ow1 = o.mul(k1).sub(t.mul(w1)).add(sin(oc.mul(OCEAN.crestK)).mul(OCEAN.crestBend));
  const ow2 = o.mul(k2).add(oc.mul(OCEAN.across2)).sub(t.mul(w2));
  // 0.2 m of swash at the shore → 0.6 m offshore (the same law shared/waves.js surfaceOffset floats bodies on)
  const oAmp = smoothstep(OCEAN.ampFrom, OCEAN.ampTo, d).mul(OCEAN.ampDeep - OCEAN.ampShore).add(OCEAN.ampShore).mul(ocean);
  // a peaked crest (a touch of second harmonic) — swell, not a sine
  const crest = (ph) => sin(ph).add(sin(ph.mul(2)).mul(OCEAN.harmonic));
  const dCrest = (ph) => cos(ph).add(cos(ph.mul(2)).mul(2 * OCEAN.harmonic));
  const disp = oAmp.mul(crest(ow1)).add(oAmp.mul(OCEAN.share2).mul(crest(ow2)))
    .add(river.mul(rAmp).mul(sin(ph1)))
    .add(still.mul(sAmp).mul(sin(sPh)));
  // vertical speed of the surface (∂h/∂t) — how fast the waterline is driven up or down the beach
  const rise = oAmp.mul(dCrest(ow1)).mul(-w1).add(oAmp.mul(OCEAN.share2).mul(dCrest(ow2)).mul(-w2))
    .add(river.mul(rAmp).mul(cos(ph1)).mul(F.z.mul(-RIVER.k)))
    .add(still.mul(sAmp).mul(cos(sPh)).mul(-STILL.w));
  mat.positionNode = positionGeometry.add(vec3(0, disp, 0));

  // ---- normals: the swell's slope, plus each kind's small ripples ---------------------------------
  const oSlope = oAmp.mul(dCrest(ow1)).mul(k1).add(oAmp.mul(OCEAN.share2).mul(dCrest(ow2)).mul(k2));
  // (every time-driven term runs a whole number of cycles per wave period — cyc — so nothing jumps at the wrap)
  const sX = sin(px.mul(1.3).add(t.mul(cyc(0.5)))).mul(0.018).add(sin(pz.mul(2.1).sub(t.mul(cyc(0.4)))).mul(0.01));
  const sZ = cos(pz.mul(1.1).add(t.mul(cyc(0.45)))).mul(0.018).add(cos(px.mul(1.9).add(t.mul(cyc(0.35)))).mul(0.01));
  const along = cos(ph1).mul(0.085).add(cos(ph2).mul(0.04)), across = cos(ph2).mul(0.05);
  const rX = F.x.mul(along).sub(F.y.mul(across)), rZ = F.y.mul(along).add(F.x.mul(across));
  const nx = still.mul(sX).add(river.mul(rX.add(sX.mul(0.5)))).add(ocean.mul(S.x.mul(oSlope).negate().add(sX)));
  const nz = still.mul(sZ).add(river.mul(rZ.add(sZ.mul(0.5)))).add(ocean.mul(S.y.mul(oSlope).negate().add(sZ)));
  mat.normalNode = transformNormalToView(normalize(vec3(nx, float(1), nz)));

  // ---- foam: made by water MOVING at the edge ---------------------------------------------------------
  // `wet` is the depth of water actually standing here this instant (the bed depth plus the wave), so the
  // edge — and the foam riding it — moves up and down the beach with every wave. Foam is the UPRUSH: the
  // speed the waterline is being driven up the beach (the surface's rise ∂h/∂t over the ground's slope,
  // m/s), weighted by how big the wave is, in a band at the moving edge. A pond's millimetre ripple moves
  // its waterline at nothing, so its edge stays clean; the sea's swash runs metres a second up a gentle
  // beach and throws surf on every crest's arrival.
  const wet = d.add(disp);
  const band = float(1).sub(smoothstep(0.0, 0.3, wet));
  const lineSpeed = max(rise, float(0)).div(max(S.z, float(0.04)));
  const waveSize = smoothstep(0.02, 0.25, oAmp.add(river.mul(rAmp)).add(still.mul(sAmp)));
  const uprush = smoothstep(0.15, 2.0, lineSpeed).mul(waveSize);
  const streak = smoothstep(0.86, 1.0, sin(c.mul(2.2).add(sin(a.mul(0.35)).mul(1.6))).mul(0.5).add(0.5))
    .mul(smoothstep(0.55, 1.0, sin(ph1.mul(0.4)).mul(0.5).add(0.5)));   // 0.4: whole cycles a period (waves.js)
  const foam = band.mul(float(0.08).add(uprush.mul(0.9)))
    .add(streak.mul(river).mul(0.22).mul(float(1).sub(smoothstep(0.5, 2.5, d).mul(0.6))))
    .clamp(0, 1);

  // colour: the world's water colour, murkier and greener in a river, a deeper blue out at sea with
  // turquoise in its shallows
  const deep = smoothstep(0.0, 2.5, d);                    // 0 at the shore → 1 past 2.5 m
  const base = color(W.color);
  const deepCol = base.mul(still).add(mix(base, vec3(0.2, 0.3, 0.22), 0.25).mul(river)).add(mix(base, vec3(0.04, 0.2, 0.36), 0.55).mul(ocean));
  const shallowCol = base.mul(0.55).add(vec3(0.18, 0.24, 0.2)).mul(still.add(river)).add(vec3(0.22, 0.56, 0.56).mul(ocean));
  mat.colorNode = mix(mix(shallowCol, deepCol, deep), vec3(0.9, 0.95, 0.94), foam);
  // where the wave has drawn back, the beach is dry: no water to see (the ground hides most of it anyway;
  // this keeps the last centimetres from shimmering against the sand)
  mat.opacityNode = mix(float(0.38), float(W.opacity), deep).add(foam.mul(0.3)).mul(smoothstep(-0.02, 0.04, wet)).clamp(0, 1);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'water';
  mesh.position.y = W.level;
  mesh.renderOrder = 2;   // after the ground and the opaque world: it is seen THROUGH
  mesh.onBeforeRender = () => { waveT.value = waveTime(); };   // one synced wave time per frame
  mesh.userData.bodies = A.bodies.map((b) => ({ kind: b.kind, area: Math.round(b.area), width: +b.width.toFixed(1), length: +b.length.toFixed(1) }));
  scene.add(mesh);
  current.mesh = mesh;
}

/** What kind of water is at a point, for the HUD and probes (shared/waterkind.js sample). */
export const waterAt = (x, z) => current?.analysis?.sample(x, z) ?? null;
