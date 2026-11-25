// xrmicicon — the mic state in view while in VR (the desktop has the HUD glyph; a headset had nothing). Head-locked
// (a child of the camera, like vrmic.js's plate), small, low-left, drawing the HUD's own glyph (mictoggle.js
// micIndicatorSvg): off = slashed, on = faint and smaller, hot = transmitting, full. Repainted only on a state change.
import { THREE, camera, renderer } from '../core.js';
import { bus } from '../base.js';
import { quadMaterial } from './quadcolour.js';
import { micIndicatorState, micIndicatorSvg } from '../audio/mictoggle.js';

const MIC_ICON = { x: -0.17, y: -0.15, z: -0.6, size: 0.032 };   // metres in front of the eyes: ≈3° across, ≈16° left, 14° down
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
