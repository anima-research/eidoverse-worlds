// flora — the browser host for eidoverse-video's vegetation brush
// (`createFlora`), which replaced `makeGrass` upstream. Real species with PBR
// map sets — grass carpets with seasonal color, desert bunch grass, three
// Mojave shrubs, yucca, corn with baked cobs and planted rows — GPU-instanced
// whole plants, self-animating wind, pushers that part foliage around walkers.
//
// This file owns the DOM/THREE-bound hosting. The pure logic lives beside it
// so it can be unit-tested without a browser:
//   flora_args.js  — legacy makeGrass-bag mapping + preset/variety strokes
//   flora_field.js — field composition + retirement lifecycle
// Both are covered by tools/flora.test.ts.
import { THREE, TSL, bus } from './core.js';
import { primeFiles } from './assets.js';
import { colliders } from './colliders.js';
import { myState } from './controller.js';
import { remotes } from './remotes.js';
import { mapGrassArgs, presetStrokes } from './flora_args.js';
import { composeField } from './flora_field.js';
import { densityCount } from './grass_quality.js';
import { pushHostHook } from './autohooks.js';

export { mapGrassArgs, presetStrokes } from './flora_args.js';
export { retireField } from './flora_field.js';

// ---- module ----------------------------------------------------------------

const FLORA_URL = '/library/eidoverse/vegetation.js';
let floraMod = null;
/** Import the vegetation module off the library route. Native ESM — relative
 *  imports inside it (shrub/corn generators) resolve against the same route.
 *  The specifier goes through an indirect import so a BUNDLER treats it as
 *  runtime data: `/library/` exists only on the sequencer at run time, and a
 *  literal dynamic import made the bundle fail trying to resolve it. */
const runtimeImport = new Function('s', 'return import(s)');
export async function loadFloraModule() {
  if (!floraMod) {
    floraMod = runtimeImport(FLORA_URL).then((m) => {
      // engine parity: the loader shim registers these globally
      globalThis.createFlora = m.createFlora;
      globalThis.FLORA_SPECIES = m.FLORA_SPECIES;
      globalThis.GRASS_COLORS = m.GRASS_COLORS;
      globalThis.resetFloraOccupancy = m.resetFloraOccupancy;
      return m;
    });
  }
  return floraMod;
}

// ---- assets ----------------------------------------------------------------

const GRASS_DIR = 'eidoverse/assets/grass';
/** Prime the map sets a species needs (albedo/normal/roughness/translucency,
 *  blade-fit + anchor JSONs, shrub bark). The module reads them synchronously
 *  Deno-style; missing optional maps degrade gracefully inside it. */
async function ensureFloraAssets(mod, species) {
  const spec = mod.FLORA_SPECIES[species];
  if (!spec) return;
  const paths = [];
  if (spec.maps) {
    for (const kind of ['albedo', 'normal', 'roughness', 'translucency']) {
      paths.push(`${GRASS_DIR}/${spec.maps}_${kind}.png`);
    }
  }
  if (spec.stem) {
    for (const kind of ['albedo', 'normal', 'roughness']) {
      paths.push(`${GRASS_DIR}/${spec.stem}_${kind}.png`);
    }
  }
  if (spec.archetype === 'blades') paths.push(`${GRASS_DIR}/${spec.maps}_fit.json`);
  if (spec.archetype === 'shrub') paths.push(`${GRASS_DIR}/shrub_anchors.json`);
  await primeFiles(paths); // missing files warn + degrade, never throw
}

// ---- interior clearings ----------------------------------------------------
// Exact-collider interiors paint their footprints black into a mask; the
// vertex stage sinks masked plants underground. ONE mask per FIELD, wired into
// EVERY stroke's material and disposed with the field: a module-global mask
// left earlier strokes pointing at an orphaned canvas (only the last stroke
// stayed repaintable) and leaked a bus listener per stroke per re-grow.
// The mask samples the PLANT's world XZ — the field's positionNode output —
// because positionLocal is per-plant space under instancing.
const MASK = 256;

function makeClearingMask(W, D) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = MASK;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false;
  const paint = () => {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, MASK, MASK);
    ctx.fillStyle = '#000';
    for (const [, e] of colliders) {
      if (!e.interior) continue;                    // things with a real floor only
      const { obj, box } = e;
      const s = obj.scale?.x || 1;
      const hw = ((box.max.x - box.min.x) / 2) * s + 0.15;  // small apron past the wall
      const hd = ((box.max.z - box.min.z) / 2) * s + 0.15;
      const bx = ((box.max.x + box.min.x) / 2) * s, bz = ((box.max.z + box.min.z) / 2) * s;
      const c = Math.cos(obj.rotation.y), n = Math.sin(obj.rotation.y);
      const wx = obj.position.x + bx * c + bz * n;
      const wz = obj.position.z - bx * n + bz * c;
      ctx.save();
      ctx.translate(((wx + W / 2) / W) * MASK, ((wz + D / 2) / D) * MASK);
      ctx.rotate(-obj.rotation.y);
      ctx.fillRect((-hw / W) * MASK, (-hd / D) * MASK, (2 * hw / W) * MASK, (2 * hd / D) * MASK);
      ctx.restore();
    }
    tex.needsUpdate = true;
  };
  const unsubscribe = bus.on('entity', paint);      // spawns/moves/rescales repaint
  paint();
  /** Sink this stroke's masked plants. Composes with the stroke's own
   *  positionNode (instancing + wind + pushers all live in there). */
  const wire = (mat) => {
    if (!mat) return;
    const { Fn, texture, vec2, vec3, float } = TSL;
    const orig = mat.positionNode;
    mat.positionNode = Fn(() => {
      const p = vec3(orig).toVar();
      const uv = p.xz.add(vec2(W / 2, D / 2)).div(vec2(W, D));
      const mask = texture(tex, uv).r;              // 1 = meadow, 0 = interior
      const sink = float(1).sub(mask).mul(4);       // deep enough for corn, not just blades
      return p.sub(vec3(0, sink, 0));
    })();
  };
  return { tex, paint, wire, dispose: () => { unsubscribe(); tex.dispose(); } };
}

// ---- density dial ----------------------------------------------------------
// The perf governor thins the meadow before dropping resolution (Safari fill
// rate). Instanced fields make this near-free: shuffle the per-instance
// attribute arrays once (deterministic — a field must stay the same field),
// and InstancedMesh.count becomes a uniform-density dial.
function wireDensityDial(field) {
  const geo = field.mesh.geometry;
  const attrs = ['aPosRot', 'aScaleVar', 'aPhase'].map((n) => geo.getAttribute(n)).filter(Boolean);
  const n = field.count;
  if (!n || !attrs.length) return;
  const order = Array.from({ length: n }, (_, i) => i);
  let seed = 0x6d2b79f5;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
  for (let i = n - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  for (const a of attrs) {
    const sz = a.itemSize, src = a.array.slice();
    for (let i = 0; i < n; i++) {
      const s = order[i] * sz, d = i * sz;
      for (let k = 0; k < sz; k++) a.array[d + k] = src[s + k];
    }
    a.needsUpdate = true;
  }
  // the stem mesh (shrub wood) rides the same attribute OBJECTS, so the
  // shuffle above already covers it — only the count needs mirroring
  field.setDensity = (f) => {
    // densityCount owns the clamp — including genuine zero for `off` (#60)
    const keep = densityCount(n, f);
    field.mesh.count = keep;
    if (field.stemMesh) field.stemMesh.count = keep;
  };
}

// ---- pushers ---------------------------------------------------------------
// The brush's own interaction model: up to 4 pusher slots part the plants
// around moving bodies. Slot 0 is the local avatar; the rest are the nearest
// remote presences. Per-frame and cheap (a uniform write).
function wirePushers(field) {
  const R = 1.1;
  const hook = () => {
    const list = [];
    if (myState?.pos) list.push({ x: myState.pos.x, y: myState.pos.y, z: myState.pos.z, r: R });
    if (remotes?.size) {
      const near = [];
      for (const [, rb] of remotes) {
        const p = rb?.avatar?.root?.position;
        if (p) near.push(p);
      }
      if (myState?.pos) {
        near.sort((a, b) => a.distanceToSquared(myState.pos) - b.distanceToSquared(myState.pos));
      }
      for (const p of near.slice(0, 3)) list.push({ x: p.x, y: p.y, z: p.z, r: R });
    }
    field.setPushers(list);
  };
  pushHostHook(hook);
  return hook;
}

// ---- the field -------------------------------------------------------------

/** Build a flora field from a `grass` verb bag. Returns a field shaped to
 *  terrain.js's setGrass contract: { mesh, material, update, autoHooks,
 *  setDensity, dispose }. The mesh is added to the scene here; setGrass owns
 *  removing and disposing it. */
export async function buildFloraField(rawArgs, { scene, heightFn }) {
  const mod = await loadFloraModule();
  const args = mapGrassArgs(rawArgs);
  const strokes = presetStrokes(args);
  const species = [...new Set(strokes.map((st) => st.species ?? 'grass'))];
  for (const sp of species) await ensureFloraAssets(mod, sp);
  // the grass verb is a world singleton: each build starts a fresh occupancy
  // registry, or a replaced field's plants would still claim their ground
  mod.resetFloraOccupancy();
  const W = args.width ?? args.size ?? 30, D = args.depth ?? args.size ?? 30;
  const mask = makeClearingMask(W, D);
  const group = new THREE.Group();
  const fields = [];
  try {
    for (const st of strokes) {
      const f = await mod.createFlora({ ...st, heightFn });
      wireDensityDial(f);
      mask.wire(f.material);
      group.add(f.mesh);
      fields.push(f);
    }
  } catch (e) {
    // a half-built field must not leak its listener or its finished strokes
    for (const f of fields) f.dispose?.();
    mask.dispose();
    throw e;
  }
  const field = composeField({ group, fields, mask });
  field.autoHooks.push(wirePushers(field));   // setGrass unhooks everything the field owns
  scene.add(group);
  return field;
}
