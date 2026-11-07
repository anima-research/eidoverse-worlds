// xrmicicon — the mic, in view, while you are in VR (owner, 10-02). VRChat keeps a mic icon in the lower left of the
// view in VR: crossed out while muted, faint while open and quiet, bright while you speak (wiki.vrchat.com/wiki/HUD).
// The desktop has our HUD glyph for this; in a headset nothing showed it — you found out you were muted when nobody
// answered. Head-locked (a child of the camera, as vrmic.js's note), small, low in the left of the view, drawing the
// HUD's own glyph in its own inks (mictoggle.js micIndicatorSvg): off = the slashed glyph, on = brand ink but faint and
// a little smaller, hot = transmitting (under push-to-talk only while held), full. Repainted only when the state changes.
import { THREE, camera, renderer } from './core.js';
import { bus } from './base.js';
import { quadMaterial } from './quadcolour.js';
import { micIndicatorState, micIndicatorSvg } from './mictoggle.js';

export const MIC_ICON = { x: -0.17, y: -0.15, z: -0.6, size: 0.032 };   // metres in front of the eyes: ≈3° across, ≈16° left, 14° down
const LOOK = { off: { opacity: 0.9, scale: 1 }, on: { opacity: 0.45, scale: 0.8 }, hot: { opacity: 1, scale: 1 } };
let mesh = null, cv = null, tex = null, state = null, timer = null, painted = 0;

function paint(st) {
  const g = cv.getContext('2d'), css = getComputedStyle(document.documentElement);
  const panel = (css.getPropertyValue('--panel-rgb').trim() || '5 20 20').split(/\s+/).join(',');
  g.clearRect(0, 0, 128, 128);
  g.beginPath(); g.arc(64, 64, 60, 0, Math.PI * 2); g.fillStyle = `rgba(${panel},0.85)`; g.fill();
  const img = new Image(), mine = ++painted;
  img.onload = () => { if (mine !== painted) return; g.drawImage(img, 22, 22, 84, 84); tex.needsUpdate = true; };
  img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(micIndicatorSvg(84));
  tex.needsUpdate = true;
  const look = LOOK[st] ?? LOOK.off;
  mesh.material.opacity = look.opacity; mesh.scale.setScalar(look.scale);
}
function tick() { const st = micIndicatorState(); if (st !== state) { state = st; paint(st); } }
function show() {
  if (!mesh) {
    cv = document.createElement('canvas'); cv.width = cv.height = 128;
    tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    mesh = new THREE.Mesh(new THREE.PlaneGeometry(MIC_ICON.size, MIC_ICON.size),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
    quadMaterial(mesh, renderer);   // the glyph's inks as authored, not ACES-washed (the panels' path)
    mesh.renderOrder = 2999; mesh.frustumCulled = false; mesh.name = 'xr-mic-icon';
  }
  mesh.position.set(MIC_ICON.x, MIC_ICON.y, MIC_ICON.z);
  camera.add(mesh); state = null; tick();
  clearInterval(timer); timer = setInterval(tick, 125);   // the HUD glyph's own cadence
}
function hide() { clearInterval(timer); timer = null; mesh?.removeFromParent(); state = null; }
bus.on('xr:state', (on) => (on ? show() : hide()));
/** probe window */
export const xrMicIconState = () => ({ shown: !!mesh?.parent, onCamera: mesh?.parent === camera, state, opacity: mesh?.material.opacity ?? null,
  scale: mesh?.scale.x ?? null, pos: mesh ? mesh.position.toArray() : null, size: MIC_ICON.size });
