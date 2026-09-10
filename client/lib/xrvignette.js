// Comfort vignette (R, 09-05 18:22). A soft dark ring fixed to the headset's
// view that closes in while you move or turn on the stick and opens when you
// stop — the standard VR comfort tool. Off by default (R "raw dogs" it); on
// via Settings › VR. Lives on the XR camera so it rides every eye.
import { THREE, camera } from './core.js';
import { xrPrefs, isPresenting, turnMagnitude } from './xr.js';
import { xrIntent } from './controller.js';

let mesh = null, level = 0;
function ensure() {
  if (mesh) return mesh;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 60, 128, 128, 128);
  grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(0.55, 'rgba(0,0,0,0)'); grad.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
  mesh.renderOrder = 9999; mesh.frustumCulled = false; mesh.position.set(0, 0, -0.5);
  mesh.scale.set(1.1, 1.1, 1);   // a hair past the view so the edge never shows
  camera.add(mesh);
  return mesh;
}

export function tickXRVignette(dt) {
  if (!isPresenting() || !xrPrefs.vignette) { if (mesh) mesh.material.opacity = 0; return; }
  const m = ensure();
  const move = Math.min(1, Math.hypot(xrIntent.fwd || 0, xrIntent.strafe || 0));
  const want = Math.min(1, Math.max(move, turnMagnitude()) * 1.2) * 0.85;
  level += (want - level) * Math.min(1, dt * 8);   // closes fast, opens a little slower is fine either way
  m.material.opacity = level;
}
