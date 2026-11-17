// capture — the one framebuffer-readback primitive (docs/design/RENDERER-SEAM.md): the only module outside the presentation
// layer allowed to say `renderer.render`, so swapping the renderer leaves frame capture as one function.
// Deliberately NOT unified here: avatar-thumbnail.js's portrait pipeline, an offscreen-SUBJECT renderer (own RenderTarget,
// isolated Scene, async reads, transparent background) rather than a capture of the live frame.

import { THREE, renderer, scene, camera } from '../core.js';
import { renderWorld } from './render.js';

/** Render the live scene through the live camera and read the frame back
 *  as a PNG data URL. Throws on a readback under 2000 characters (a context that
 *  has not produced a frame yet answers with a blank canvas, silently); a blank
 *  canvas large enough to encode past that is not caught. */
export function captureFrame() {
  // a handled GPU loss: the canvas still holds the LAST frame, and a readback would pass it off as now
  if (globalThis.__gpuLost?.fired) throw new Error('GPU lost: no frame to capture');
  renderWorld();   // completed frame, then read it
  const url = renderer.domElement.toDataURL('image/png');
  if (url.length < 2000) throw new Error('empty frame readback');
  return url;
}

const _at = new THREE.Vector3();

/** Pose the live camera (eye position + look-at) and capture. The camera is
 *  deliberately NOT restored — the callers are spectator sessions whose
 *  camera exists to be driven by requests (the snap: net_capture.js). */
export function captureFrom(eye, lookAt) {
  camera.position.copy(eye);
  camera.lookAt(_at.copy(lookAt));
  return captureFrame();
}
