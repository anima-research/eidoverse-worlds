// The interim sky: a plain gradient dome shown while the real sky's programs compile (on a cold GPU cache the cloud
// march takes minutes to link on WebGL). Its colours are the sky system's OWN time-of-day horizon/zenith, which it
// recomputes in JavaScript every frame independently of its shaders, so the stand-in matches the hour from the start.
// Tiny program, no textures: it links in milliseconds. (Owner, 09-27: one gradient that resembles the time of day,
// never the half-made states.)
import { THREE, scene, camera } from './core.js';
import { bus } from './base.js';

const R = 14000;          // inside sky_system's DOME_R, outside everything else
let mesh = null, uni = null, lastKey = '';

function paint() {
  const zen = uni?.zenith?.value, hor = uni?.horizon?.value;
  if (!mesh || !zen || !hor) return;
  const key = `${zen.x.toFixed(3)},${zen.y.toFixed(3)},${zen.z.toFixed(3)}|${hor.x.toFixed(3)},${hor.y.toFixed(3)},${hor.z.toFixed(3)}`;
  if (key === lastKey) return;
  lastKey = key;
  const pos = mesh.geometry.attributes.position, col = mesh.geometry.attributes.color;
  for (let i = 0; i < pos.count; i++) {
    const up = pos.getY(i) / R;
    // the shader's own blend is mix(horizon, zenith, upK); a sqrt ramp keeps the horizon band narrow like the real one
    const k = up > 0 ? Math.sqrt(up) : 0;
    const dim = up < 0 ? 0.55 : 1;   // below the horizon: the haze, darker (the ground covers most of it)
    col.setXYZ(i, (hor.x + (zen.x - hor.x) * k) * dim, (hor.y + (zen.y - hor.y) * k) * dim, (hor.z + (zen.z - hor.z) * k) * dim);
  }
  col.needsUpdate = true;
}

/** Show the stand-in, fed by the sky system's uniforms ({zenith, horizon} vec3 uniforms). */
export function showInterimSky(uniforms) {
  uni = uniforms ?? null;
  if (!mesh) {
    const g = new THREE.SphereGeometry(R, 32, 16);
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 3), 3));
    mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false }));
    mesh.name = 'interim sky'; mesh.renderOrder = -101; mesh.frustumCulled = false; mesh.userData.noCamCollide = true;
    mesh.userData.noSupportCheck = true;
    lastKey = '';
  }
  if (!mesh.parent) { scene.add(mesh); bus.emit('sky-interim', true); }
  paint();
}

/** Per frame while shown: follow the eye, repaint when the palette moved. */
export function updateInterimSky() {
  if (!mesh?.parent) return;
  camera.getWorldPosition(mesh.position); mesh.position.y = 0;
  paint();
}

export function hideInterimSky() {
  if (!mesh) return;
  const was = !!mesh.parent;
  mesh.removeFromParent(); mesh.geometry.dispose(); mesh.material.dispose(); mesh = null; uni = null;
  if (was) bus.emit('sky-interim', false);
}
export const interimSkyShown = () => !!mesh?.parent;
