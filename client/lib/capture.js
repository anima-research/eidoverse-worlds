// capture — the one framebuffer-readback primitive (RENDERER-SEAM move 1).
//
// "Render the world and hand me the pixels" existed as private copies in
// the wire protocol (net.js snap requests) and the command dispatcher
// (screenshots) — a protocol file and a chat file each owning a renderer
// call. This is the only module outside the designated presentation layer
// allowed to say `renderer.render`; when the renderer is ever swapped,
// frame capture is one function, not a grep.
//
// Deliberately NOT unified here: avatar.js's portrait pipeline. It is an
// offscreen-SUBJECT renderer (its own RenderTarget + isolated Scene +
// async pixel reads, transparent background), not a capture of the live
// frame — one primitive with five booleans would be worse than two honest
// ones (the R2 ladder lesson).

import { THREE, renderer, scene, camera } from './core.js';

/** Render the live scene through the live camera and read the frame back
 *  as a PNG data URL. Throws on an empty readback (a context that has not
 *  produced a frame yet answers with a blank canvas, silently). */
export function captureFrame() {
  renderer.render(scene, camera);   // completed frame, then read it
  const url = renderer.domElement.toDataURL('image/png');
  if (url.length < 2000) throw new Error('empty frame readback');
  return url;
}

const _at = new THREE.Vector3();

/** Pose the live camera (eye position + look-at) and capture. The camera is
 *  deliberately NOT restored — the callers are spectator sessions whose
 *  camera exists to be driven by requests (net.js snap semantics, kept). */
export function captureFrom(eye, lookAt) {
  camera.position.copy(eye);
  camera.lookAt(_at.copy(lookAt));
  return captureFrame();
}
