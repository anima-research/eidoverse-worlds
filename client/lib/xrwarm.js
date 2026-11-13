// DUAL WARM: when content loads on a headset-capable machine, warm the variant the OTHER mode will need, while the
// thing is still being warmed out of sight — so neither entering nor leaving VR finds a material it has to compile.
//
// Pattern from BasisVR (MIT, © 2024 Luke B Doolan, https://github.com/BasisVR/Basis):
//   ContentPoliceControl.cs warms a loaded avatar/prop "before we set the clone active, so the first frame it's
//   visible doesn't stall" (Basis/Packages/com.basis.sdk/Scripts/Content Police/ContentPoliceControl.cs:411-417).
// Basis warms at content load, not at the mode switch; it never deliberately warms the stereo variant (Unity's
// STEREO_INSTANCING_ON can't be put in a ShaderVariantCollection). Here both variants are warmed, because the stereo
// pass split (xrpass.js) lets them coexist.
//
// Hooked at renderer.compileAsync, where every content warm already passes (assets, avatars, flora, sky, terrain —
// through the warm conductor). Only calls with the MAIN camera and no bound render target are doubled: portraits,
// shadow depth and bakes keep their own cameras/targets and are left alone.
//   desktop  the call built the desktop variant → also compile through three's own XR camera + its persistent eyes
//            (xrpass.js withXREyes — a look-alike camera would rebind the stereo uniforms to ITS matrices)
//   in VR    three swapped in the XR camera, so the call built the XR variant → also compile with the main camera
//            into a 1×1 twin of the desktop framebuffer target (same attachment key, so the same render context
//            the desktop frames use; binding it is also what keeps three from swapping the XR camera back in)
// tools/xr-dual-warm-probe.mjs measures it: enter and exit build nothing for content that arrived in the other mode.
import { withXREyes } from './xrpass.js';

export function installDualWarm({ THREE, renderer, camera, presenting }) {
  if (!renderer || renderer.__dualWarm) return false;
  const compile = renderer.compileAsync.bind(renderer);
  let twin = null;
  // the desktop tone-mapping target's attachment key: count:format:type:samples:depth:stencil (three RenderContexts.get)
  const desktopTwin = () => (twin ??= new THREE.RenderTarget(1, 1, {
    type: renderer._outputBufferType, samples: renderer.samples, depthBuffer: renderer.depth, stencilBuffer: renderer.stencil }));
  // Frustum culling is off only for the compile's SYNCHRONOUS walk: once three is initialised compileAsync reads
  // frustumCulled in _projectObject before its first await and never again — the awaited rest is the pipeline link.
  // Restoring at the promise's end instead left warmed objects already in the scene drawing unculled every frame for
  // the whole link (seconds; in a session too). An uninitialised renderer awaits init() BEFORE the walk: keep the flag
  // down until the promise settles then.
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
    // no target bound: the eyes draw through the same tone-mapping target shape as the desktop (measured: the
    // probe's births land in the desktop's render context), so only the eye COUNT differs
    return unculled(obj, () => withXREyes(renderer, (eyes) => compile(obj, eyes, target)));
  };
  // THE LEAK (three r186): after an XR frame Renderer._renderScene "restores" the bound target to
  // `_renderTarget || _outputRenderTarget`, i.e. it leaves the eye buffer bound. render() still draws through the
  // tone-mapping target, but compileAsync takes `_renderTarget === null` as its test and compiles STRAIGHT INTO the eye
  // buffer — a different render context. So every compile during a session (content warms, the entry curtain) prepared
  // render objects (node builds, bindings) the headset's frames never used, and the frames built them again at draw time.
  // The GPU pipelines were NOT wasted (the pipeline cache is keyed on formats, so both contexts share them) — measured in a
  // pure-three A/B on r186 and dev: 12 render objects rebuilt by the next render(), 0 pipelines. A bound target that is
  // just the leaked output target is treated as unbound for the compile's synchronous pass (tools/xr-dual-warm-probe.mjs).
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
