// Desktop view while presenting (R, 09-05 18:22: "mirror VR view to desktop,
// and 3rd person as an option"). By default the desktop canvas goes black in
// VR — WebXR owns the framebuffer. This system draws one extra frame per tick
// onto the canvas from a desktop camera: 'first' = the headset's own eyes,
// 'third' = behind-and-above the body, looking at it. porch-old's pattern
// (index.html:11160–11184): renderer.xr.enabled OFF around the pass, then
// restored, so three renders to the canvas instead of the eye buffers.
import { THREE, renderer, scene, camera } from './core.js';
import { isPresenting, xrPrefs, withHeadShown } from './xr.js';
import { myState } from './controller.js';
import { tee, bus } from './base.js';
import { toast } from './ui.js';

const deskCam = new THREE.PerspectiveCamera(65, 16 / 9, 0.1, 20000);
const tmpPos = new THREE.Vector3(), tmpQuat = new THREE.Quaternion(), behind = new THREE.Vector3();
let lastAspect = 0;

// History, kept short because a stranger will pick this up: 'first' once re-rendered the scene (a full pass on
// top of stereo — a missed frame every tick), then read the session's XRWebGLLayer with gl.blitFramebuffer (two
// freezes — see below). Neither survives. What runs now is described at ensureQuad(). 'third' renders one pass
// into a SMALL target (fill is the lever) and blits it up.
let thirdRT = null, blitFailed = false, blitTeed = false;
// A blit straight onto the canvas also left ONE still frame: Chrome re-composites a WebGL canvas only when a
// draw or clear touches it. So the eye is drawn onto the canvas with one fullscreen quad through three's own
// canvas path — the path the scene pass used, which presents live.
let quadScene = null, quadCam = null, quadMesh = null, quadMap = null;
const MIRROR_FLIP = new URLSearchParams(location.search).has('mirrorflip') ? -1 : 1;
// R 09-08 01:43: TWO freezes (fps → 17 → nothing; SteamVR alpha-ing), and by elimination the one thing both frozen
// builds did that no other version did was READ THE XR LAYER'S OPAQUE FRAMEBUFFER with blitFramebuffer. On
// Windows that framebuffer is a shared D3D surface owned by the compositor; a read from it every frame is a GPU
// sync against SteamVR. So the layer is never touched again. Three keeps its OWN intermediate target for the
// eyes (renderer._getFrameBufferTarget() while the XR target is the output — 'fbts=Map:1' in the enter tee): the
// MSAA target it resolves into the layer each frame. That is an ordinary texture; the quad samples its LEFT
// half — the same read three's own output pass already does — and draws it onto the canvas through three's
// canvas path (linear in, three tone-maps + encodes on the way out, as it does for the eye).
function ensureQuad() {
  if (quadScene) return;
  quadScene = new THREE.Scene(); quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const g = new THREE.PlaneGeometry(2, 2); const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 0.5);   // left eye only
  quadMesh = new THREE.Mesh(g, new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false }));
  quadScene.add(quadMesh);
}
function blitEye() {
  const layer = renderer.xr.getSession?.()?.renderState?.baseLayer ?? null;
  const fbt = (typeof renderer._getFrameBufferTarget === 'function') ? renderer._getFrameBufferTarget() : null;   // keyed on the CURRENT output target = the XR target while presenting
  if (!fbt?.texture) return 'no-fbt';
  ensureQuad();
  if (quadMap !== fbt.texture) { quadMap = fbt.texture; quadMesh.material.map = quadMap; quadMesh.material.needsUpdate = true; }
  const ew = (layer?.framebufferWidth ?? fbt.width) >> 1, eh = layer?.framebufferHeight ?? fbt.height;
  const cw = renderer.domElement.width || 1, ch = renderer.domElement.height || 1;
  const sc = Math.min(cw / ew, ch / eh); quadMesh.scale.set((ew * sc) / cw, MIRROR_FLIP * (eh * sc) / ch, 1);   // letterboxed; ?mirrorflip=1 if inverted
  const was = renderer.xr.enabled; const oldRT = renderer.getRenderTarget(); const oldOut = renderer.getOutputRenderTarget?.() ?? null;
  renderer.xr.enabled = false;
  try { renderer.setOutputRenderTarget?.(null); renderer.setRenderTarget(null); renderer.render(quadScene, quadCam); }
  catch (e) { return `quad threw ${e?.message ?? e}`.slice(0, 100); }
  finally { renderer.setOutputRenderTarget?.(oldOut); renderer.setRenderTarget(oldRT); renderer.xr.enabled = was; if (renderer.xr.isPresenting) renderer.xr.updateCamera(camera); }
  return null;
}
function blitRT(rt) {
  const gl = renderer.backend?.gl; const fbs = renderer.backend?.get?.(rt)?.framebuffers; const fb = fbs ? Object.values(fbs)[0] ?? null : null;
  if (!gl || !fb) return false;
  const cw = gl.drawingBufferWidth, ch = gl.drawingBufferHeight;
  const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), prevDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
  try { gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null); gl.blitFramebuffer(0, 0, rt.width, rt.height, 0, 0, cw, ch, gl.COLOR_BUFFER_BIT, gl.LINEAR); return gl.getError() === gl.NO_ERROR; }
  finally { gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDraw); }
}

let slowFrames = 0, lastTick = 0, passFrame = 0, mirrorKilled = false;
bus.on('xr:state', (on) => { if (on) { mirrorKilled = false; slowFrames = 0; lastTick = 0; } });   // 'off for this session' means THIS session
export function tickXRMirror() {
  if (!isPresenting() || xrPrefs.mirror === 'off' || mirrorKilled) return;
  // THE MIRROR MUST NEVER COST THE HEADSET (R 09-08 01:19: fps 17 → frozen with the mirror on). 30 consecutive
  // frames over 30 ms while it runs → off for the session, said out loud. The pref is untouched.
  { const now = performance.now(); if (lastTick && now - lastTick > 30) { if (++slowFrames >= 30) { mirrorKilled = true; tee(`[xr] mirror: OFF for this session — 30 frames over 30 ms (mode ${xrPrefs.mirror})`); toast('desktop mirror switched off — it was costing the headset frames', 'warn', 8000); return; } } else slowFrames = 0; lastTick = now; }
  if (xrPrefs.mirror === 'first') {
    if (!blitFailed) { let why; try { why = blitEye(); } catch (e) { why = `threw ${e?.name ?? ''} ${e?.message ?? e}`.slice(0, 120); } if (!why) { if (!blitTeed) { blitTeed = true; const l = renderer.xr.getSession?.()?.renderState?.baseLayer; tee(`[xr] mirror: eye quad live from three's frame-buffer target (${l?.framebufferWidth ?? '?'}×${l?.framebufferHeight ?? '?'} → canvas ${renderer.domElement.width}×${renderer.domElement.height}; the layer is never read)`); } return; } blitFailed = true; tee(`[xr] mirror: eye blit unavailable (${why}) — falling back to a scene pass`); }
  }
  if ((++passFrame % 3) !== 0) return;   // a scene pass is the expensive path: a third of the frames is plenty for a desktop onlooker
  const w = renderer.domElement.clientWidth || 1, h = renderer.domElement.clientHeight || 1;
  if (w / h !== lastAspect) { lastAspect = w / h; deskCam.aspect = lastAspect; deskCam.updateProjectionMatrix(); }
  const xrCam = renderer.xr.getCamera();
  if (xrPrefs.mirror === 'first') {
    xrCam.matrixWorld.decompose(tmpPos, tmpQuat, behind);
    deskCam.position.copy(tmpPos); deskCam.quaternion.copy(tmpQuat);
  } else {
    // third person: 2.2 m behind the head's yaw, 0.8 m above the body, looking at chest height
    xrCam.matrixWorld.decompose(tmpPos, tmpQuat, behind);
    const yaw = Math.atan2(2 * (tmpQuat.w * tmpQuat.y + tmpQuat.x * tmpQuat.z), 1 - 2 * (tmpQuat.y * tmpQuat.y + tmpQuat.x * tmpQuat.x));
    behind.set(Math.sin(yaw) * 2.2, 0.8, Math.cos(yaw) * 2.2);
    deskCam.position.set(myState.pos.x + behind.x, myState.pos.y + 1.4 + behind.y, myState.pos.z + behind.z);
    deskCam.lookAt(myState.pos.x, myState.pos.y + 1.2, myState.pos.z);
  }
  deskCam.updateMatrixWorld(true);
  // the pass renders into a SMALL target (a quarter of the canvas on each side — fill, not draws, is what the
  // frame budget can't afford), with the output target held on the canvas so a null target never resolves to
  // the eyes (three r185: XR sets outputRenderTarget = xrRenderTarget for the frame — R 09-08 00:38's double vision)
  const tw = Math.max(320, (renderer.domElement.width >> 1) || 640), th = Math.max(180, (renderer.domElement.height >> 1) || 360);
  if (!thirdRT || thirdRT.width !== tw || thirdRT.height !== th) { thirdRT?.dispose(); thirdRT = new THREE.RenderTarget(tw, th, { depthBuffer: true, samples: 0 }); }
  const was = renderer.xr.enabled; const oldRT = renderer.getRenderTarget(); const oldOut = renderer.getOutputRenderTarget?.() ?? null;
  renderer.xr.enabled = false;
  try {
    // the small target is the renderer's OUTPUT target for this pass, so three's own output pass (tone map + sRGB)
    // lands in it — a plain render target skips that and came out dark (R 09-08 01:10)
    renderer.setOutputRenderTarget?.(thirdRT);
    renderer.setRenderTarget(null);
    withHeadShown(() => renderer.render(scene, deskCam));   // the onlooker sees the whole head (the chop is for the eyes)
    if (!blitRT(thirdRT) && !blitTeed) { blitTeed = true; tee('[xr] mirror: target blit unavailable — the small pass has nowhere to go'); }
  } catch { /* a bad frame must never kill the XR loop */ }
  finally {
    renderer.setOutputRenderTarget?.(oldOut); renderer.setRenderTarget(oldRT); renderer.xr.enabled = was;
    if (renderer.xr.isPresenting) renderer.xr.updateCamera(camera);   // the eyes rebuilt from the rig before the stereo pass (renderAside's rule)
  }
}
