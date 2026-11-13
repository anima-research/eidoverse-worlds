// xrtip — a panel control's TOOLTIP, in the headset (owner, 10-02). The desktop shows a control's title= in the house
// chip (#tipchip, ui.js) after the mouse rests on it; a laser has no hover, so in VR the same text shows when the laser
// DWELLS on that control (dwell.js, per hand, through the pointer's stickiness) and goes when the laser leaves it.
// No strings of its own: the text is the control's own title (or its nearest titled ancestor's — a settings row
// carries the title for the select inside it), the very text the desktop chip borrows. First users: greyed controls
// that say why (unavailable in VR), and the settings rows' explanations.
//
// It is DOM, like the nameplate card: one #xr-tip element laid out offscreen in the house chip's look, rasterised by
// the vendored HTMLMesh, and hung IN the panel (a child of that panel's quad, a hair in front of it) under the control
// — or above it at the panel's foot — at the panel's own pixel size, so it reads exactly as legibly as the panel.
import { HTMLMesh } from './vendor/htmlmesh.js';
import { prepareQuadMaterial } from './domquad.js';

const RASTER = 2.5;     // device px per CSS px, as the nameplate card (crisp at arm's length)
const GAP_PX = 6;       // between the control and the tip, CSS px of the panel
const LIFT = 0.004;     // in the quad's local units (CSS px × 1 mm): ≈ 7 mm in front of a 0.58 m panel — never z-fights

let el = null, mesh = null, built = null, shownFor = null, shownText = '';

/** The text the desktop tooltip would show for `ctl` inside the frame element `root`: its own title, or the nearest
 *  titled ancestor's (ui.js borrows titles into `_tip` while the mouse is on them, so that counts too). '' for none. */
export function tipTextFor(ctl, root) {
  for (let n = ctl; n && n !== root?.parentElement; n = n.parentElement) {
    const t = n.getAttribute?.('title') || n._tip;
    if (t) return String(t);
    if (n === root) break;
  }
  return '';
}

function ensureEl() {
  if (el) return el;
  el = document.createElement('div');
  el.id = 'xr-tip';
  el.setAttribute('role', 'tooltip');
  el.style.cssText = 'position:fixed;left:-100000px;top:0;';   // laid out, never on the desktop (HTMLMesh measures, never hit-tests)
  document.body.appendChild(el);
  return el;
}
function drop() { if (!mesh) return; mesh.removeFromParent(); mesh.dispose(); mesh = null; built = null; }

/** Show `text` for control `ctl` on the quad `quadMesh` (an HTMLMesh of the frame `root`), or hide (text ''). */
export function showXRTip(quadMesh, root, ctl, text) {
  if (!text || !quadMesh || !ctl) { hideXRTip(); return; }
  const e = ensureEl();
  if (e.textContent !== text) e.textContent = text;
  const w = e.offsetWidth, h = e.offsetHeight;
  if (!w || !h) return;
  if (!mesh || built[0] !== w || built[1] !== h || built[2] !== text) {
    drop();
    mesh = new HTMLMesh(e, { scale: RASTER });
    mesh.name = 'xr-tip'; mesh.userData.noCamCollide = true;
    mesh.material.transparent = false; mesh.material.alphaTest = 0.5;   // the panels' recipe: opaque pass, rounded corners cut out
    prepareQuadMaterial(mesh);                                          // the authored colour after the output pass
    built = [w, h, text];
  }
  if (mesh.parent !== quadMesh) quadMesh.add(mesh);
  // under the control (above it if there is no room below), its centre over the control's, kept inside the panel
  const fr = root.getBoundingClientRect(), r = ctl.getBoundingClientRect();
  let x = (r.left + r.right) / 2 - fr.left, y = r.bottom - fr.top + GAP_PX + h / 2;
  if (y + h / 2 > fr.height) y = r.top - fr.top - GAP_PX - h / 2;
  x = Math.min(Math.max(x, w / 2), Math.max(w / 2, fr.width - w / 2));
  // the quad's geometry is the frame in CSS px × 1 mm, centred; the tip's is its own CSS px × 1 mm: same units
  mesh.position.set((x - fr.width / 2) * 0.001, (fr.height / 2 - y) * 0.001, LIFT);
  mesh.quaternion.identity(); mesh.scale.setScalar(1);
  if (!mesh.visible) { mesh.visible = true; mesh.material.map.resume?.(); }
  shownFor = ctl; shownText = text;
}
export function hideXRTip() {
  if (mesh?.visible) { mesh.visible = false; mesh.material.map.pause?.(); }
  shownFor = null; shownText = '';
}
/** Leaving VR: the quad goes away with its panels. */
export function dropXRTip() { hideXRTip(); drop(); }
/** probe window */
export const xrTipState = () => ({ shown: !!mesh?.visible, text: shownText, for: shownFor, mesh, el });
