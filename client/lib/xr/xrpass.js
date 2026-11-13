// Stereo renders get their own pass, so entering and leaving VR doesn't rebuild the world.
//
// three r186 keeps render objects in a chain map chosen by passId, and the stereo ArrayCamera changes their cache
// key, so while desktop and XR shared the default map every switch rebuilt every object (the first exit recompiled
// every material: bench/xr-switch-compile-measure.mjs). Routing stereo cameras to their own map ('xr', 'xr:backSide')
// lets both variants live side by side; compileAsync resolves through the same get(), so a stereo warm lands where
// the headset reads. Test: test/client/xrpass-test.mjs.
const isStereo = (camera) => camera?.isArrayCamera === true && camera.cameras.length > 0;

export function separateXRPass(renderer) {
  const objects = renderer?._objects;
  if (!objects || objects.__xrPass || typeof objects.get !== 'function') return false;
  const get = objects.get.bind(objects);
  objects.get = function (object, material, scene, camera, lightsNode, renderContext, clippingContext, passId) {
    // three's own rebuild re-enters get() with the passId it was given: prefix once
    if (isStereo(camera) && !(typeof passId === 'string' && passId.startsWith('xr'))) passId = passId ? `xr:${passId}` : 'xr';
    return get(object, material, scene, camera, lightsNode, renderContext, clippingContext, passId);
  };
  objects.__xrPass = true;
  return true;
}

/** Run a stereo warm through three's OWN XR camera and its persistent eye cameras (renderer.xr._cameras): r186 binds
 *  the stereo uniforms to whichever ArrayCamera built a shader last, so a stand-in camera froze head tracking
 *  (test/client/xr-eye-binding-probe.mjs). Before a session the XR camera has no eyes, so the two are pushed for the
 *  warm's duration and taken out if no session started meanwhile. Overlapping warms share them: only the last one
 *  out takes them back, and never while presenting. */
const eyeHolds = new WeakMap();   // xr camera → number of warms currently relying on eyes WE pushed
export async function withXREyes(renderer, fn) {
  const xr = renderer.xr, cam = xr.getCamera();
  const held = eyeHolds.get(cam) ?? 0;
  if (cam.cameras.length > 0 && held === 0) return fn(cam);   // three's own eyes (a live session): not ours to touch
  const eyes = (xr._cameras ?? []).slice(0, 2);
  if (eyes.length !== 2) throw new Error('withXREyes: renderer.xr._cameras is not the two persistent eyes (three changed?)');
  if (held === 0) cam.cameras.push(...eyes);
  eyeHolds.set(cam, held + 1);
  try { return await fn(cam); }
  finally {
    const left = (eyeHolds.get(cam) ?? 1) - 1;
    eyeHolds.set(cam, left);
    if (left === 0 && !xr.isPresenting && cam.cameras[0] === eyes[0] && cam.cameras.length === 2) cam.cameras.length = 0;
  }
}
