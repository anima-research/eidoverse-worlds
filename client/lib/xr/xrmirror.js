// Desktop view while presenting. The desktop canvas goes black in VR (WebXR owns the framebuffer), so after the eye
// render this draws the scene once more onto the canvas from a desktop camera: 'first' = where the headset looks,
// 'third' = behind and above the body. Settings › VR › desktop view (vrpanel.js).
//
// three's XRManager sizes the CanvasTarget to the XR layer for the whole session, so a canvas pass would draw through
// a target the size of both eyes; for this pass only the CanvasTarget gets the canvas's real size back.
// Never read the XR layer's framebuffer (blitFramebuffer): on Windows it belongs to the SteamVR compositor and froze the GPU.
import { THREE, renderer, scene, camera } from '../core.js';
import { isPresenting, xrPrefs, withHeadShown } from './xr.js';
import { myState } from '../controller.js';
import { tee, bus } from '../base.js';
import { xrCurtainOn, renderWorldFrom } from '../render.js';

const deskCam = new THREE.PerspectiveCamera(65, 16 / 9, 0.1, 20000);
const tmpPos = new THREE.Vector3(), tmpQuat = new THREE.Quaternion(), tmpScl = new THREE.Vector3(), behind = new THREE.Vector3();
const savedVp = new THREE.Vector4(), savedSc = new THREE.Vector4();
let lastAspect = 0;

/** Render `fn` onto the canvas with the CanvasTarget at the canvas's real size (see the header). Returns the size the
 *  target held during the session, for the first-frame tee. */
function onCanvas(fn) {
  const ct = renderer._canvasTarget;
  if (!ct || typeof ct._width !== 'number') throw new Error('three internals moved (_canvasTarget)');
  const pr = ct._pixelRatio || 1;
  const cw = renderer.domElement.width || 1, ch = renderer.domElement.height || 1;
  const was = { w: ct._width, h: ct._height, st: ct._scissorTest };
  savedVp.copy(ct._viewport); savedSc.copy(ct._scissor);
  const xrWas = renderer.xr.enabled, oldRT = renderer.getRenderTarget(), oldOut = renderer.getOutputRenderTarget?.() ?? null;
  const depth = renderer._callDepth;   // three's _renderScene has no try/finally: a throw leaves this one too deep
  // this frame's shadow maps are already drawn for the eyes: the desk pass samples them instead of drawing them again
  const shadowLights = casters().map((l) => [l, l.shadow.autoUpdate]); for (const [l] of shadowLights) l.shadow.autoUpdate = false;
  renderer.xr.enabled = false;
  // the backend still holds the eye render's context, whose XR framebuffer no longer resolves (drawBuffers throws on
  // the second pass): null the pointers, never restore them — the next XR frame's beginRender sets its own
  if (renderer.backend) renderer.backend._currentContext = null;
  renderer._currentRenderContext = null;
  try {
    renderer.setOutputRenderTarget?.(null);
    renderer.setRenderTarget(null);
    ct._width = cw / pr; ct._height = ch / pr;
    ct._viewport.set(0, 0, cw / pr, ch / pr); ct._scissor.set(0, 0, cw / pr, ch / pr); ct._scissorTest = false;
    fn();
  } catch (e) {
    // a throw mid-render leaves three's call depth raised and its context pointers on the dead pass: put them back
    if (typeof depth === 'number') renderer._callDepth = depth;
    if (renderer.backend) renderer.backend._currentContext = null;
    renderer._currentRenderContext = null;
    throw e;
  } finally {
    for (const [l, a] of shadowLights) l.shadow.autoUpdate = a;
    ct._width = was.w; ct._height = was.h; ct._viewport.copy(savedVp); ct._scissor.copy(savedSc); ct._scissorTest = was.st;
    renderer.setOutputRenderTarget?.(oldOut); renderer.setRenderTarget(oldRT); renderer.xr.enabled = xrWas;
    if (renderer.xr.isPresenting) renderer.xr.updateCamera(camera);   // the eyes rebuilt from the rig before the next stereo pass (renderAside's rule)
  }
  return { sessionTarget: `${Math.round(was.w * pr)}x${Math.round(was.h * pr)}`, canvas: `${cw}x${ch}` };
}

// Shadow-casting lights, refreshed now and then (a light added mid-session joins within a second).
let casterList = [], castersAt = 0;
function casters() {
  const now = performance.now();
  if (now - castersAt > 1000) { castersAt = now; casterList = []; scene.traverse((o) => { if (o.isLight && o.castShadow && o.shadow?.autoUpdate) casterList.push(o); }); }
  return casterList;
}

let slowFrames = 0, lastTick = 0, mirrorKilled = false, teed = false, failed = false;
const stats = (globalThis.__xrMirror = { passes: 0, last: null });   // test/client/xr-mirror-probe.mjs; its holdKill disarms the killswitch (wouldKill still recorded)

// A banner on the desktop, from the moment the mirror switches itself off until the session ends (a toast is too easily
// missed at the monitor). Mirror off by choice gets a neutral 'in VR' label instead, so black doesn't read as a crash.
let banner = null, bannerKind = null;
function showInVRLabel() {
  if (typeof document === 'undefined' || bannerKind === 'killed') return;
  showMirrorBanner(null, 'inVR');
}
function showMirrorBanner(why, kind = 'killed') {
  if (typeof document === 'undefined') return;
  if (!banner) {
    banner = document.createElement('div'); banner.className = 'xr-mirror-off'; banner.setAttribute('role', 'status');
    banner.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:90;max-width:min(460px,86vw);'
      + 'padding:14px 18px;border-radius:10px;text-align:center;font-size:15px;line-height:1.45;pointer-events:none;'
      + 'color:var(--fg, #ebebe9);';
    document.body.appendChild(banner);
  }
  bannerKind = kind;
  const tone = kind === 'killed' ? 'var(--attn, #e0a040)' : 'var(--accent, #6fb3d2)';
  banner.style.background = `color-mix(in srgb, ${tone} 14%, var(--bg, #101818))`;
  banner.style.border = `1px solid color-mix(in srgb, ${tone} 70%, transparent)`;
  banner.innerHTML = kind === 'killed'
    ? '<b>Desktop view paused while you\'re in VR</b><br>' + why + '<br><span style="opacity:.75;font-size:13px">It comes back on your next entry (Settings › VR › desktop view).</span>'
    : '<b>In VR</b><br><span style="opacity:.75;font-size:13px">The desktop view is off (Settings › VR › desktop view).</span>';
}
const hideMirrorBanner = () => { banner?.remove(); banner = null; bannerKind = null; };
const syncInVRLabel = () => {
  if (isPresenting() && xrPrefs.mirror === 'off') showInVRLabel();
  else if (bannerKind === 'inVR') hideMirrorBanner();
};
bus.on('xr:prefs', syncInVRLabel);
export const mirrorBannerText = () => banner?.textContent ?? null;   // probe

bus.on('xr:state', (on) => { if (on) { mirrorKilled = false; failed = false; slowFrames = 0; lastTick = 0; teed = false; hideMirrorBanner(); syncInVRLabel(); } else hideMirrorBanner(); });   // 'off for this session' means THIS session
export function tickXRMirror() {
  if (!isPresenting() || xrPrefs.mirror === 'off' || mirrorKilled || failed) return;
  if (xrCurtainOn()) return;   // entry: the curtain is up and pipelines are building; no desktop pass on top of that
  // the mirror must never cost the headset: 30 consecutive frames over 30 ms → off for the session (the pref is untouched)
  { const now = performance.now(); if (lastTick && now - lastTick > 30) { if (++slowFrames >= 30 && !(stats.wouldKill = stats.holdKill)) { mirrorKilled = true; stats.killed = true; tee(`[xr] mirror: OFF for this session — 30 frames over 30 ms (mode ${xrPrefs.mirror})`); showMirrorBanner('Mirroring your eyes to this screen was costing the headset frames, so it switched itself off to keep VR smooth.'); return; } } else slowFrames = 0; lastTick = now; }
  // every frame: a skipped one presents a cleared buffer (a flicker)
  const cw = renderer.domElement.width || 1, ch = renderer.domElement.height || 1;
  if (cw / ch !== lastAspect) { lastAspect = cw / ch; deskCam.aspect = lastAspect; deskCam.updateProjectionMatrix(); }
  const xrCam = renderer.xr.getCamera();
  xrCam.matrixWorld.decompose(tmpPos, tmpQuat, tmpScl);
  if (xrPrefs.mirror === 'first') {
    deskCam.position.copy(tmpPos); deskCam.quaternion.copy(tmpQuat);
  } else {
    // third person: 2.2 m behind the head's yaw, 0.8 m above the body, looking at chest height
    const yaw = Math.atan2(2 * (tmpQuat.w * tmpQuat.y + tmpQuat.x * tmpQuat.z), 1 - 2 * (tmpQuat.y * tmpQuat.y + tmpQuat.x * tmpQuat.x));
    behind.set(Math.sin(yaw) * 2.2, 0.8, Math.cos(yaw) * 2.2);
    deskCam.position.set(myState.pos.x + behind.x, myState.pos.y + 1.4 + behind.y, myState.pos.z + behind.z);
    deskCam.lookAt(myState.pos.x, myState.pos.y + 1.2, myState.pos.z);
  }
  deskCam.updateMatrixWorld(true);
  try {
    // first person sees what the eyes see (head chopped, as for the eyes); the onlooker's third person sees the whole head
    const info = onCanvas(() => (xrPrefs.mirror === 'third' ? withHeadShown(() => renderWorldFrom(deskCam)) : renderWorldFrom(deskCam)));
    stats.passes++; stats.last = info;
    if (!teed) { teed = true; tee(`[xr] mirror: ${xrPrefs.mirror} drawn to the canvas at ${info.canvas} (the canvas target held ${info.sessionTarget} for the session; restored after each pass)`); }
  } catch (e) {
    // a bad frame must never kill the XR loop: say so once and stop for this session
    failed = true; stats.error = `${e?.name ?? ''} ${e?.message ?? e}`.slice(0, 300); stats.stack = String(e?.stack ?? '').slice(0, 900);
    tee(`[xr] mirror: failed, off for this session — ${`${e?.name ?? ''} ${e?.message ?? e}`.slice(0, 160)}`);
    showMirrorBanner('The desktop mirror hit an error and switched itself off so it can\'t disturb the headset.');
  }
}
