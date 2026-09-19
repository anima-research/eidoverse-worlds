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
if (typeof renderer.render === 'function') { const orig = renderer.render.bind(renderer);   // node-side suites mock core.js with a renderer that has no render (wing-owner-wire-test)
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
let curtain = null, curtainOn = false; const _yAxis = new THREE.Vector3(0, 1, 0);
export function setXRCurtain(on) {
  curtainOn = !!on; if (on && curtain) curtain.userData.warmFrames = 0;
  if (curtainOn && !curtain) {
    curtain = new THREE.Scene();
    const shell = new THREE.Mesh(new THREE.SphereGeometry(4, 24, 16), new THREE.MeshBasicNodeMaterial({ color: 0x0b0f12, side: THREE.BackSide, depthTest: false, depthWrite: false }));
    shell.frustumCulled = false; shell.renderOrder = 0; curtain.add(shell); curtain.userData.shell = shell;
    // THE SPLASH, head-locked 1.6 m out (R 09-19: 'still just plain white Entering VR with no logo or name'):
    // the ∃ (its three paths read from #splash so there is one drawing of the mark), eidoverse / worlds, and
    // 'entering VR' with the dots breathing — repainted on the texture 3×/s while the curtain is up.
    const c = document.createElement('canvas'); c.width = 1024; c.height = 1024; const g = c.getContext('2d');
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const paths = [...document.querySelectorAll('#splash .sp-logo path')].map((el) => new Path2D(el.getAttribute('d')));
    const font = getComputedStyle(document.documentElement).getPropertyValue('--font').trim() || 'system-ui, sans-serif';
    const paint = (dots) => {
      g.clearRect(0, 0, 1024, 1024); g.fillStyle = '#8fe8c8';
      g.save(); g.translate(512 - 0.2 * 1372 / 2 + 0.2 * 70, 150); g.scale(0.2, 0.2); for (const pth of paths) g.fill(pth); g.restore();   // viewBox -70 -40 1372 1372, at 0.2×
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `500 64px ${font}`; g.letterSpacing = '0.34em'; g.fillText('eidoverse', 512 + 11, 520);
      g.globalAlpha = 0.45; g.font = `400 30px ${font}`; g.letterSpacing = '0.58em'; g.fillText('worlds', 512 + 9, 575); g.globalAlpha = 1;
      g.letterSpacing = '0.08em'; g.font = `400 40px ${font}`; g.textAlign = 'left';
      const w = g.measureText('entering VR').width; g.fillText('entering VR' + '.'.repeat(dots), 512 - w / 2, 690);
      tex.needsUpdate = true;
    };
    paint(0); curtain.userData.paint = paint; curtain.userData.lastDots = -1;
    const text = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), new THREE.MeshBasicNodeMaterial({ map: tex, transparent: true, depthTest: false }));
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
    { const t = curtain.userData.text; if (t) { const yaw = Math.atan2(e[8], e[10]); t.quaternion.setFromAxisAngle(_yAxis, yaw); t.position.set(e[12] - Math.sin(yaw) * 1.6, e[13], e[14] - Math.cos(yaw) * 1.6); } }   // LEVEL with the horizon (R 09-19): yaw follows the head, pitch/roll do not
    { const d = Math.floor(performance.now() / 400) % 4; if (d !== curtain.userData.lastDots) { curtain.userData.lastDots = d; curtain.userData.paint?.(d); } }
    // THE WORLD RENDERS UNDER THE CURTAIN, hidden by it (R 09-19: 'chugging until the construct stops fading'): the
    // sync pipeline builds compileAsync misses (shadow/depth variants, the first draw of each batch) fire on the
    // world's first frames — better they fire while the curtain covers the world than after it drops. The curtain
    // draws last with depth off, so nothing of the world shows.
    if (curtain.userData.warmFrames == null) curtain.userData.warmFrames = 0;
    if (curtain.userData.warmFrames++ < 6) { renderer.autoClear = true; batches.render(renderer, scene, camera); renderer.autoClear = false; renderer.render(curtain, camera); renderer.autoClear = true; }
    else renderer.render(curtain, camera);
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
