// The live world's render path, shared by animation and frame capture.
import { THREE, renderer, scene, camera } from './core.js';
import { CONFIG, bus, tee } from './base.js';
import { DrawBatches } from './draw_batches.js';
import { warm, warmDepth, P_AMBIENT } from './warmqueue.js';

const batches = new DrawBatches({ warm: async (mesh, live) => {
  let error;
  await warm('instance pipelines', async () => {
    if (!live()) return;
    const culled = mesh.frustumCulled;
    mesh.frustumCulled = false;
    try { await renderer.compileAsync(mesh, camera, scene); }
    catch (e) { error = e; }
    finally { mesh.frustumCulled = culled; }
  }, { p: P_AMBIENT });
  if (error) throw error;
  if (mesh.castShadow && live()) await warmDepth('instance shadows', () => live() ? [mesh] : []);
} });
batches.enabled = CONFIG.params.get('batching') !== '0';
let lastRender = {};

/** Render something that is NOT the world's eye pass — a sky bake, a thumbnail, a snapshot, the
 *  desktop mirror — without disturbing WebXR. three's XRManager.updateCamera(cam) runs inside EVERY
 *  renderer.render() while presenting and rewrites the SHARED stereo camera from `cam.parent`; a
 *  parentless bake/thumbnail camera leaves the eyes at the playspace origin for the frame (R's Steam
 *  Frame, 2026-09-05 21:45–23:30: 'I pop to the origin' — per-eye cameras at (0, 1.6, 0) while the
 *  base camera sat on the rig; sky_baked.js:351 had met the same class once). Pattern from porch-old
 *  :11176–11179: XR off around the pass, render target saved and restored. */
export function renderAside(sc, cam, target = null) {
  const xr = renderer.xr;
  if (!xr?.isPresenting) { const rt = renderer.getRenderTarget(); renderer.setRenderTarget(target); try { return renderer.render(sc, cam); } finally { renderer.setRenderTarget(rt); } }
  const was = xr.enabled, rt = renderer.getRenderTarget();
  xr.enabled = false;
  try { renderer.setRenderTarget(target); return renderer.render(sc, cam); }
  finally { renderer.setRenderTarget(rt); xr.enabled = was; if (xr.isPresenting) xr.updateCamera(camera); }   // the eyes are rebuilt from the RIG before anything else renders
}

// RENDER CENSUS (R 09-06 12:22: per-eye fisheye + right eye bleeding into the left, spontaneous, mirror OFF):
// count every renderer.render() per animation frame while presenting and remember the last one that was
// NOT the main pass — camera type/fov/parent and whether it targeted a render target. A second render
// into the eye framebuffer with a non-XR camera is exactly a wide frame stamped across both eyes.
export const renderCensus = { perFrame: 0, maxPerFrame: 0, foreign: null, frames: 0 };
let mainPassCam = null;
{ const orig = renderer.render.bind(renderer);
  renderer.render = (sc, cam) => {
    renderCensus.perFrame++;
    if (renderer.xr?.isPresenting && cam !== mainPassCam) {
      const rt = renderer.getRenderTarget();
      renderCensus.foreign = { cam: cam?.type, name: cam?.name || null, fov: cam?.fov ?? null, parent: !!cam?.parent, target: rt ? (rt.isXRRenderTarget ? 'xr' : 'rt') : 'canvas', xrEnabled: renderer.xr.enabled, t: +performance.now().toFixed(0) };
    }
    return orig(sc, cam);
  }; }
export function renderCensusTick() { renderCensus.frames++; if (renderCensus.perFrame > renderCensus.maxPerFrame) renderCensus.maxPerFrame = renderCensus.perFrame; renderCensus.perFrame = 0; }
export const renderCensusPeek = () => renderCensus.foreign;
export function renderCensusTake() { const o = { max: renderCensus.maxPerFrame, foreign: renderCensus.foreign }; renderCensus.maxPerFrame = 0; renderCensus.foreign = null; return o; }

// ENTRY CURTAIN: while up, the eye pass draws a closed dark sphere around the head (the page's own
// --bg) instead of the world — cheap, one material — so the headset gets frames (no runtime construct)
// while the scene compiles behind it (xr.js). Not a splash: no text yet; the world simply arrives.
let curtain = null, curtainOn = false;
export function setXRCurtain(on) {
  curtainOn = !!on;
  if (curtainOn && !curtain) {
    curtain = new THREE.Scene();
    const shell = new THREE.Mesh(new THREE.SphereGeometry(4, 24, 16), new THREE.MeshBasicNodeMaterial({ color: 0x0b0f12, side: THREE.BackSide }));
    shell.frustumCulled = false; curtain.add(shell); curtain.userData.shell = shell;
    // one line of text, head-locked 1.6 m out — the feedback R asked for while the scene links (09-07 18:20)
    const c = document.createElement('canvas'); c.width = 1024; c.height = 256; const g = c.getContext('2d');
    g.fillStyle = '#dfe7ea'; g.font = '600 96px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('Entering VR…', 512, 128);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const text = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.3), new THREE.MeshBasicNodeMaterial({ map: tex, transparent: true, depthTest: false }));
    text.frustumCulled = false; text.renderOrder = 1; curtain.add(text); curtain.userData.text = text;
  }
}
export const xrCurtainOn = () => curtainOn;
let healed = 0;
export function renderWorld() {
  mainPassCam = camera;
  // SELF-HEAL (09-07 00:30, the black desktop's second half): three captures `outputRenderTarget = _renderTarget || …`
  // at the top of every render. A frame that aborts between binding its frame-buffer target and restoring leaves
  // that target bound; every later frame then renders INTO it and blits it onto ITSELF — the canvas never sees a
  // pixel again, with no further errors. Off-XR, a bound target at the top of the main pass can only be that.
  if (!renderer.xr?.isPresenting && renderer.getRenderTarget() !== null) {
    const rt = renderer.getRenderTarget(); renderer.setRenderTarget(null);
    if (healed++ < 3) tee(`[render] unbound a stale target at frame start (${rt.constructor.name} ${rt.width}x${rt.height}) — an earlier frame aborted mid-render`);
  }
  if (curtainOn && renderer.xr?.isPresenting) {
    renderer.xr.updateCamera(camera);
    const xc = renderer.xr.getCamera(); const e = xc.matrixWorld.elements; curtain.userData.shell.position.set(e[12], e[13], e[14]);
    { const t = curtain.userData.text; if (t) { t.quaternion.setFromRotationMatrix(xc.matrixWorld); t.position.set(e[12] - e[8] * 1.6, e[13] - e[9] * 1.6, e[14] - e[10] * 1.6); } }
    renderer.render(curtain, camera);
    return;
  }
  const before = { ...renderer.info.render };
  if (renderer.xr?.isPresenting) renderer.xr.updateCamera(camera);   // WE build the eyes (cameraAutoUpdate is false while presenting — xr.js); whatever rendered aside this frame, the eye pass starts from the rig
  batches.render(renderer, scene, camera);
  const after = renderer.info.render;
  // Count this render and its nested shadow/output passes, independently of
  // sky bakes or earlier captures in the same animation frame. Never reset the
  // renderer's shared counters: other diagnostics own their own intervals.
  lastRender = {
    drawCalls: after.drawCalls - before.drawCalls,
    triangles: after.triangles - before.triangles,
    points: after.points - before.points,
    lines: after.lines - before.lines,
    passes: after.calls - before.calls,
  };
}

/** On-demand inventory before batching, by source type and library. Material
 *  groups are not total GPU draws (shadows, transparency and output add passes);
 *  `render.drawCalls` above is the measured total. No per-frame survey cost. */
function sourceSurvey() {
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    camera.coordinateSystem, camera.reversedDepth);
  const types = new Map(), libraries = new Map();
  const visit = (o, lib = null) => {
    if (!o.visible) return;
    lib = o.userData.lib ?? lib;
    if ((o.isMesh || o.isSprite || o.isLine || o.isPoints) && o.layers.test(camera.layers)
      && (!o.isInstancedMesh || o.count > 0)
      && (!o.frustumCulled || (o.isSprite ? frustum.intersectsSprite(o,camera) : frustum.intersectsObject(o)))) {
      const groups = Array.isArray(o.material)
        ? o.geometry.groups.filter((g) => o.material[g.materialIndex]?.visible).length
        : o.material?.visible ? 1 : 0;
      if (groups) {
        const type = o.userData.drawBatchSource ? 'library' : o.isSkinnedMesh ? 'skinned'
          : o.isInstancedMesh ? 'instanced' : o.isSprite ? 'sprites' : o.isLine ? 'lines' : 'other';
        let row = types.get(type);
        if (!row) types.set(type, row = { type, visibleObjects: 0, materialGroups: 0 });
        row.visibleObjects++; row.materialGroups += groups;
        if (lib) libraries.set(lib, (libraries.get(lib) ?? 0) + groups);
      }
    }
    for (const child of o.children) visit(child,lib);
  };
  visit(scene);
  return { types: [...types.values()], libraries: [...libraries].map(([lib,materialGroups]) => ({lib,materialGroups}))
    .sort((a,b) => b.materialGroups-a.materialGroups).slice(0,20) };
}

export const drawStats = ({ sources = false } = {}) => ({ render: lastRender, batching: batches.debug(),
  ...(sources ? { sources: sourceSurvey() } : {}) });
export function setDrawBatching(on) {
  batches.enabled = !!on;
  if (!on) batches.dispose();
  return drawStats();
}
bus.on('world-reset', () => batches.dispose());
