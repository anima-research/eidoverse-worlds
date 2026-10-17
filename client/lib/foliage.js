// foliage — alpha-blended, TEXTURED see-through surfaces drawn as two passes in 'fast' mode (Video › textured
// transparency). Named for the case that motivated it; it applies to every qualifying surface, not only leaves.
//
// A blended leaf writes no depth, so every layer of a canopy is shaded in full: EW.overdraw measured the Commons'
// two date palms at 41% of the frame facing them, 2.95 layers per covered pixel, 17+ at the crown (2026-09-24).
// fast = the classic foliage split: a CUTOUT twin of the mesh (alphaTest 0.999, writes depth, no blending) draws the
// solid interior of each leaf in the opaque pass, then the original blend draws after it with depthFunc Less, so it
// only fills what the cutout left — the soft edges — and everything hidden behind a solid leaf is rejected by depth.
// Measured on the palms: 1.65 layers/px (−45%, frame −25%) for 0.36% of pixels changed; owner, 09-24: "very close …
// some jagged pixels in the center mass". 0.999 (not 0.98) halved those speckles; pure cutout buys no more fill.
// soft = the original single blended pass. auto = fast while presenting in a headset, soft on the desktop.
//
// Who qualifies: world models (prepareObject kind 'model'), not skinned, one material, transparent, textured, opacity
// ≥ 0.99 — foliage keeps its see-through in the TEXTURE; glass and tinted panels (uniform opacity) are left alone.
import { THREE, renderer, scene, camera } from './core.js';
import { warm, P_AMBIENT } from './warmqueue.js';

export const FOLIAGE_MODES = ['auto', 'soft', 'fast'];
const KEY = 'ew-foliage';
const CORE_ALPHA = 0.999;
const lsGet = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const lsSet = (v) => { try { localStorage.setItem(KEY, v); } catch { /* private mode */ } };

let mode = FOLIAGE_MODES.includes(lsGet()) ? lsGet() : 'auto';
// Per SOURCE MATERIAL, not per mesh: every placed model is a skeletonClone of its loaded prototype and shares the
// prototype's materials, so the mode lives on shared state. Each placed instance gets its own core mesh (a child of its
// leaf mesh, answering no raycasts); all cores of a material share one cutout material, and that material's `visible`
// switches the whole family on or off. (Registering on the prototype, as this first did, gave clones made before the
// core existed no core at all, and clones made after a frozen copy the mode switch never reached.)
const byMat = new Map();            // source material → { m, depthFunc, cut, warmed, warming, cores }
const noRaycast = () => {};

export const getFoliageMode = () => mode;
/** What auto resolves to right now. */
export const foliageEffective = () => (mode === 'auto' ? (renderer.xr?.isPresenting ? 'fast' : 'soft') : mode);

export function qualifiesAsFoliage(o) {
  if (!o?.isMesh || o.isSkinnedMesh || Array.isArray(o.material)) return false;
  const m = o.material;
  return !!(m?.isNodeMaterial && m.transparent && m.map && (m.opacity ?? 1) >= 0.99);
}

function stateFor(m) {
  let st = byMat.get(m);
  if (st) return st;
  const cut = m.clone();
  cut.transparent = false; cut.alphaTest = CORE_ALPHA; cut.depthWrite = true;
  cut.visible = false;                           // shown only once its pipeline is warm (never a render-path compile)
  st = { m, depthFunc: m.depthFunc, cut, warmed: false, warming: false, cores: 0 };
  byMat.set(m, st);
  m.addEventListener('dispose', () => {          // the model's materials went away: restore, free the twin
    byMat.delete(m); liveCores.delete(m); m.depthFunc = st.depthFunc; st.cut.dispose();
  });
  return st;
}

function warmCut(st, core) {
  if (st.warmed || st.warming) return;
  st.warming = true;
  warm('foliage core', async () => {
    if (byMat.get(st.m) !== st) return;
    // compileAsync projects synchronously and skips invisible materials: visible for that instant only, so no frame
    // can draw a core before its pipeline exists
    // …and frustum-culls: a core behind the viewer would compile nothing and still be marked warm
    st.cut.visible = true;
    const culled = core.frustumCulled; core.frustumCulled = false;
    let p;
    try { p = renderer.compileAsync(core, camera, scene); } finally { st.cut.visible = false; core.frustumCulled = culled; }
    try { await p; st.warmed = true; } catch { /* warm pattern: swallowed */ } finally { st.warming = false; }
    apply(st, foliageEffective());
  }, { p: P_AMBIENT }).catch(() => {});
}

function apply(st, eff) {
  const fast = eff === 'fast' && st.warmed;      // not warm yet: blend-only until it can show without a stall
  st.cut.visible = fast;
  st.m.depthFunc = fast ? THREE.LessDepth : st.depthFunc;
}

function applyAll() {
  const eff = foliageEffective();
  for (const st of byMat.values()) {
    apply(st, eff);
    if (eff === 'fast' && !st.warmed) for (const core of coresOf(st)) { warmCut(st, core); break; }
  }
}

const liveCores = new Map();        // material → a recent core (a warm needs one mesh to compile against)
const coresOf = (st) => (liveCores.get(st.m) ? [liveCores.get(st.m)] : []);

/** Give a PLACED model's qualifying leaf meshes their core twins (call on each instance, after the clone). */
export function registerFoliage(root) {
  root?.traverse?.((o) => {
    if (!qualifiesAsFoliage(o)) return;
    const had = o.children.find((c) => c.userData?.foliageCore);
    if (had) { had.raycast = noRaycast; return; }  // a clone of a placed instance copies the core but not its own raycast
    const st = stateFor(o.material);
    const c = new THREE.Mesh(o.geometry, st.cut);
    c.name = 'foliage-core'; c.castShadow = false; c.receiveShadow = o.receiveShadow;
    c.raycast = noRaycast;                       // the parent answers for the leaf (walk/select/grab)
    c.userData.noWalkable = true; c.userData.foliageCore = true;
    o.add(c);                                    // a child at identity: same world transform as the leaf mesh
    st.cores++;
    liveCores.set(st.m, c);
    if (foliageEffective() === 'fast') warmCut(st, c);
    apply(st, foliageEffective());
  });
}

export function setFoliageMode(v) {
  if (!FOLIAGE_MODES.includes(v)) return mode;
  mode = v; lsSet(v);
  applyAll();
  return mode;
}

export const foliageDebug = () => {
  const sts = [...byMat.values()];
  return { mode, effective: foliageEffective(), materials: sts.length, meshes: sts.reduce((n, st) => n + st.cores, 0),
    warmed: sts.filter((st) => st.warmed).length, showing: sts.reduce((n, st) => n + (st.cut.visible ? st.cores : 0), 0) };
};

// auto follows the headset
renderer.xr?.addEventListener?.('sessionstart', () => { if (mode === 'auto') applyAll(); });
renderer.xr?.addEventListener?.('sessionend', () => { if (mode === 'auto') applyAll(); });
