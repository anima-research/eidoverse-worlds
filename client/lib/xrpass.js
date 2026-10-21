// STEREO RENDERS GET THEIR OWN PASS (vr-exit-hang-commons: "why is entering and leaving VR such a heavy cost?").
//
// three r186 keeps one render object per (object, material, render context, lights) in a chain map chosen by
// passId. The XR stereo ArrayCamera changes a render object's dynamic cache key (`cameras.length`), so while desktop
// and XR shared the default map every switch disposed each object and rebuilt it in the same slot — entry threw
// the desktop variant away and the first exit recompiled every material in the world (61 programs for 60
// materials, measured: tools/xr-switch-compile-probe.mjs). Worse, a desktop-side pre-warm of the XR variant was
// undone by the very next desktop frame.
//
// Routing stereo cameras to their own chain map ('xr', 'xr:backSide') lets both variants live side by side:
// after each variant's first build, a switch is a presentation change, not a rebuild (Basis's soft swap).
// passId is only ever a map key in three (never compared), and compileAsync resolves through the same get(),
// so a warm with a stereo camera lands in the map the headset will read.
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

/** Run a stereo warm through THREE'S OWN XR camera and its persistent eye cameras (renderer.xr._cameras, updated in
 *  place every XR frame). Not a look-alike: r186 binds the stereo camera uniforms to ONE module-global array
 *  (`_cameraProjectionMatrixArray.array = matrices`, inside a .once() Fn, no per-frame refresh), pointed at whichever
 *  ArrayCamera's matrix objects built a shader last. A warm through a stand-in left the headset's eyes reading the
 *  stand-in's matrices — head tracking frozen to the desktop view (tools/xr-eye-binding-probe.mjs: red where green).
 *  Before a session xr.getCamera() has ZERO eyes (three fills them on the first XR frame), which compiles the MONO
 *  variant, so the two eyes are put in for the warm's whole duration (node builds happen after compileAsync yields)
 *  and taken out again if no session started meanwhile. */
// Overlapping warms SHARE the pushed eyes: a count of warms in flight, and only the LAST one out takes them back.
// With a plain push/clear, a second warm that started while the first held the eyes saw them present, pushed nothing,
// and then lost them the moment the first finished — its deferred node builds ran with zero eyes and compiled the
// MONO variant (a flora warm runs outside the conductor, so overlap is real). A session that starts meanwhile owns
// the eyes from then on: nobody clears them while presenting.
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
