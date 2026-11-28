// Dual warm: when content is warmed on a headset-capable machine, also warm the variant the OTHER mode will need,
// so neither entering nor leaving VR finds a material to compile (the stereo pass split in xrpass.js lets both
// variants coexist). Pattern from BasisVR's ContentPoliceControl (MIT, https://github.com/BasisVR/Basis).
//
// Hooked at renderer.compileAsync. Only calls with the main camera and no bound render target are doubled
// (portraits, shadow depth and bakes keep their own):
//   desktop → also compile through three's own XR camera + eyes (xrpass.js withXREyes)
//   in VR   → also compile with the main camera into a 1×1 twin of the desktop target (same attachment key, so the
//             same render context the desktop frames use)
// bench/xr-dual-warm-measure.mjs measures it.
import { withXREyes } from './xrpass.js';

export function installDualWarm({ THREE, renderer, camera, presenting }) {
  if (!renderer || renderer.__dualWarm) return false;
  const compile = renderer.compileAsync.bind(renderer);
  let twin = null;
  // the desktop tone-mapping target's attachment key: count:format:type:samples:depth:stencil (three RenderContexts.get)
  const desktopTwin = () => (twin ??= new THREE.RenderTarget(1, 1, {
    type: renderer._outputBufferType, samples: renderer.samples, depthBuffer: renderer.depth, stencilBuffer: renderer.stencil }));
  // frustum culling off only for the compile's synchronous walk (three reads frustumCulled before its first await);
  // an uninitialised renderer awaits init() before the walk, so then it stays off until the promise settles
  const unculled = (obj, fn) => {
    const off = []; obj.traverse?.((o) => { if (o.isMesh && o.frustumCulled) { off.push(o); o.frustumCulled = false; } });
    const restore = () => { for (const o of off) o.frustumCulled = true; };
    let p;
    try { p = fn(); } catch (e) { restore(); throw e; }
    if (renderer._initialized !== false) { restore(); return p; }
    return p.finally(restore);
  };
  const other = (obj, target) => {
    if (presenting()) {
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(desktopTwin());
      // compileAsync captures its context synchronously: restore before the first await (warmqueue.js's rule)
      try { return unculled(obj, () => { const p = compile(obj, camera, target); renderer.setRenderTarget(prev); return p; }); }
      finally { renderer.setRenderTarget(prev); }
    }
    // no target bound: the eyes draw through the same target shape as the desktop, so only the eye count differs
    return unculled(obj, () => withXREyes(renderer, (eyes) => compile(obj, eyes, target)));
  };
  // three r186 leaves the eye buffer bound after an XR frame, and compileAsync would compile straight into it (a
  // render context the headset's frames never use): a bound target that is just the output target counts as unbound
  const compileAsRendered = (obj, cam, target, onProgress) => {
    const rt = renderer.getRenderTarget(), out = renderer.getOutputRenderTarget();
    if (rt === null || rt !== out) return compile(obj, cam, target, onProgress);
    renderer.setRenderTarget(null);
    try { return compile(obj, cam, target, onProgress); } finally { renderer.setRenderTarget(rt); }
  };
  renderer.compileAsync = function compileAsync(obj, cam, target = null, onProgress = null) {
    const first = compileAsRendered(obj, cam, target, onProgress);
    // a caller's OWN target (portrait, bake) opts out; three itself leaves the XR output target bound while presenting
    const rt = renderer.getRenderTarget();
    if (cam !== camera || (rt !== null && rt !== renderer.getOutputRenderTarget())) return first;
    return first.then(async (v) => { try { await other(obj, target); } catch { /* a warm is best-effort (house pattern) */ } return v; });
  };
  renderer.__dualWarm = true;
  return true;
}
