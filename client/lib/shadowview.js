// ?shadowview=1 — 09-07: no ground shadow from any scene caster on a real desktop GPU (ANGLE/D3D11), while
// SwiftShader shows one; every state tee matches. So: put the SUN'S VIEW on screen. Each frame the scene is
// rendered from sun.shadow.camera with a depth-as-grey override into a small colour target (renderAside — XR-safe),
// and that target is drawn on a camera-locked quad, top-left. If the yucca's silhouette is there, the sun camera
// sees it (frustum + geometry are right) and the fault is in the shadow pass or the compare sampling; if not,
// the map's view is wrong. Diagnostic only; a no-op without the param.
import { THREE, TSL, scene, camera, sun } from './core.js';
import { CONFIG } from './base.js';
import { renderAside } from './render.js';

const ON = CONFIG.params.has('shadowview');
const MAIN = CONFIG.params.get('shadowview') === 'main';   // control: the same override through the MAIN camera — proves the diagnostic path before trusting the sun's view
let rt = null, depthMat = null, quad = null;

function ensure() {
  if (rt) return;
  rt = new THREE.RenderTarget(512, 512, { depthBuffer: true });
  depthMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  // view-space NORMALS from the light: the floor is one flat tone, every caster a different one — silhouettes
  // read at any depth (depth-as-grey over 150 m made a 4 m tree a 3 % step: invisible)
  depthMat.colorNode = TSL.normalView.mul(0.5).add(0.5);
  quad = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.28), new THREE.MeshBasicNodeMaterial({ map: rt.texture, depthTest: false, depthWrite: false }));
  quad.renderOrder = 10000; quad.frustumCulled = false; scene.add(quad);   // a scene child that follows the camera — the desktop camera is not in the graph, so a camera child never draws
}

export function tickShadowView() {
  if (!ON) return;
  ensure();
  const prev = scene.overrideMaterial; scene.overrideMaterial = depthMat;
  quad.visible = false;
  quad.quaternion.copy(camera.quaternion); quad.position.set(-0.36, 0.22, -0.6).applyQuaternion(camera.quaternion).add(camera.position);
  // three's own shadow pass copies the main camera's layer mask onto the shadow camera (ShadowNode.updateShadow);
  // without it the sun's view sees layer 0 only — the floor and nothing else (headless, 09-07 19:38)
  // a DirectionalLight's shadow camera is placed by shadow.updateMatrices(light) inside three's shadow pass — not by
  // the scene's matrix update; without this call the sun camera sits at its stale transform (floor-only square, 19:40)
  sun.shadow.updateMatrices(sun);
  const sc = sun.shadow.camera; const mask = sc.layers.mask; sc.layers.mask = camera.layers.mask;
  try { renderAside(scene, MAIN ? camera : sc, rt); }
  catch (e) { console.warn('[shadowview]', e?.message ?? e); }
  finally { sc.layers.mask = mask; scene.overrideMaterial = prev; quad.visible = true; }
}
