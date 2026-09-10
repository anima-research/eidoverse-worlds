// xrpanels — frames as PHYSICAL SURFACES. A frame that declares its body as
// FIELDS (panels.js schema) rides a canvas-textured quad in the headset; the
// right-hand laser is the cursor; a UV-hit resolves to a hit REGION and fires
// the SAME dispatcher the desktop frame calls. No DOM crosses the threshold.
//
// Any module opts a frame in with registerXRPanel — the dock has no body in
// VR, so this registry IS the dock's edit-mode: what you can reach, floating
// at desk height. Frames that never register (chat's free text, the debug
// log) simply have no VR body yet, and say nothing rather than pretend.

import { THREE } from './core.js';
import { bus } from './base.js';
import { renderCanvas, hitRegion } from './panels.js';
import { domQuadsEnabled, domQuadsEnter, domQuadsExit, domQuadsPick, domQuadsSetShown, domQuadsShown, domQuadShow, domQuadsGrab, domQuadRelease } from './domquad.js';   // the REAL frames on quads (default); ?canvasquads=1 keeps these canvases

const PX_PER_M = 900;              // canvas pixels per world metre of quad
const W = 0.58;                    // quad width, metres — an arm's-length read

const registry = [];               // [{id, title, fields, dispatch}]
let panels = null;                 // live: [{mesh, canvas, tex, regions, def}]
let shown = false;   // off by default in VR (R 09-06 12:49) — the ring's 'panels' slot shows them
const _rc = new THREE.Raycaster();
const _m = new THREE.Matrix4();

/** Opt a frame into VR. fields() → panels.js field specs (no closures);
 *  dispatch(action, payload) is the frame's own edit function. */
export function registerXRPanel(def) {
  if (!def?.id || typeof def.fields !== 'function' || typeof def.dispatch !== 'function') return false;
  const i = registry.findIndex((d) => d.id === def.id);
  if (i >= 0) registry[i] = def; else registry.push(def);
  return true;
}
export const xrPanelIds = () => registry.map((d) => d.id);

function makePanel(def, i, n) {
  const canvas = document.createElement('canvas');
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: tex, transparent: false }));
  // fan the quads across an arc in front of the body, desk height
  const a = (i - (n - 1) / 2) * 0.55;
  mesh.position.set(Math.sin(a) * 0.85, 1.15, -Math.cos(a) * 0.85);
  mesh.rotation.y = -a;
  mesh.userData.noCamCollide = true;
  const p = { mesh, canvas, tex, regions: [], def };
  repaint(p);
  return p;
}

function repaint(p) {
  p.regions = renderCanvas(p.canvas, p.def.fields(), { width: Math.round(W * PX_PER_M), title: p.def.title ?? p.def.id });
  // quad keeps the canvas's aspect so buttons are where they look like they are
  p.mesh.scale.set(W, W * (p.canvas.height / p.canvas.width), 1);
  p.tex.needsUpdate = true;
}

let repaintQueued = false;
function repaintAll() {
  if (!panels || repaintQueued) return;
  repaintQueued = true;            // events arrive in bursts; one paint per frame
  requestAnimationFrame(() => {
    repaintQueued = false;
    if (panels) panels.forEach(repaint);
  });
}

export function xrPanelsEnter(rig) {
  if (domQuadsEnabled()) return domQuadsEnter(rig);
  panels = registry.map((def, i) => makePanel(def, i, registry.length));
  for (const p of panels) { rig.add(p.mesh); p.mesh.visible = shown; }   // shown starts false
  bus.on('entity', repaintAll);
  bus.on('comp', repaintAll);
  bus.on('presence', repaintAll);
  bus.on('xr:panels', togglePanels);
  bus.on('xr:repaint', repaintAll);
}

export function xrPanelsExit(rig) {
  if (domQuadsEnabled()) return domQuadsExit(rig);
  bus.off?.('xr:panels', togglePanels);
  if (!panels) return;
  for (const p of panels) { rig.remove(p.mesh); p.tex.dispose(); p.mesh.geometry.dispose(); }
  panels = null;
}

function togglePanels() {
  // derive from what is actually on screen: a flag of our own drifted from the quads' real state
  // (a phantom press flipped it while the quads didn't exist yet — R 09-06 11:35, 'can't close the menus')
  if (domQuadsEnabled()) { shown = !domQuadsShown(); return domQuadsSetShown(shown); }
  shown = !(panels ?? []).some((p) => p.mesh.visible);
  for (const p of panels ?? []) p.mesh.visible = shown;
}

/** One quad by id — what a ring slot does (R: each slot opens that frame's
 *  quad). `on` null toggles. */
export function showXRPanel(id, on = null) {
  if (domQuadsEnabled()) return domQuadShow(id, on);
  const p = panels?.find((q) => q.def.id === id);
  if (!p) return false;
  p.mesh.visible = on == null ? !p.mesh.visible : !!on;
  shown = (panels ?? []).some((q) => q.mesh.visible);
  return p.mesh.visible;
}
export const xrPanelHas = (id) => registry.some((d) => d.id === id);
export const xrPanelsShown = () => (domQuadsEnabled() ? domQuadsShown() : (panels ?? []).some((p) => p.mesh.visible));
export const xrPanelOpen = (id) => !!panels?.find((q) => q.def.id === id)?.mesh.visible;

/** Laser test against the panels. Returns hit distance (for laser length) or
 *  null. When `click`, resolves the region and fires the panel's dispatcher —
 *  the same function the desktop frame calls. */
export function xrPanelsPick(handRay, click = false) {
  if (domQuadsEnabled()) return domQuadsPick(handRay, click);
  if (!panels || !shown) return null;
  _m.identity().extractRotation(handRay.matrixWorld);
  _rc.ray.origin.setFromMatrixPosition(handRay.matrixWorld);
  _rc.ray.direction.set(0, 0, -1).applyMatrix4(_m);
  _rc.far = 3;
  const hit = _rc.intersectObjects(panels.map((p) => p.mesh), false)[0];
  if (!hit) return null;
  if (click && hit.uv) {
    const p = panels.find((q) => q.mesh === hit.object);
    const r = hitRegion(p.regions, p.canvas, hit.uv.x, 1 - hit.uv.y);
    if (r) { p.def.dispatch(r.action, r.payload); repaintAll(); }
  }
  return hit.distance;
}

/** C17: the panel under the laser, as a grabbable — {id, mesh} or null. Canvas quads grab too. */
export function xrPanelsGrab(handRay) {
  if (domQuadsEnabled()) return domQuadsGrab(handRay);
  if (!panels || !shown) return null;
  _m.identity().extractRotation(handRay.matrixWorld);
  _rc.ray.origin.setFromMatrixPosition(handRay.matrixWorld);
  _rc.ray.direction.set(0, 0, -1).applyMatrix4(_m);
  _rc.far = 3;
  const hit = _rc.intersectObjects(panels.filter((p) => p.mesh.visible).map((p) => p.mesh), false)[0];
  if (!hit) return null;
  const p = panels.find((q) => q.mesh === hit.object);
  return p ? { id: p.def.id, mesh: p.mesh } : null;
}
export const xrPanelRelease = (q, rig) => domQuadRelease(q, rig);   // uprighting is the same for either kind

/** harness window */
export const xrPanelsDebug = () => ({
  dispatch: (id, k, v) => registry.find((d) => d.id === id)?.dispatch(k, v),   // harness only
  fields: Object.fromEntries(registry.map((d) => [d.id, d.fields().map((f) => f.k ?? f.t)])),
  registered: xrPanelIds(), live: panels?.length ?? 0, shown,
  regions: panels?.map((p) => ({ id: p.def.id, n: p.regions.length, w: p.canvas.width, h: p.canvas.height })) ?? [],
});
