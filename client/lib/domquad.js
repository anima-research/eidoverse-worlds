// VR quads = the REAL desktop frames (live, 2026-09-05 20:37: "use the ACTUAL menus so
// there is only one set of panels to maintain"). Each XR-registered frame's live DOM is
// rasterised onto a quad by the vendored HTMLMesh (vendor/htmlmesh.js: DPR, inline SVG,
// throttle, no window dispatch) and a trigger on the quad fires the SAME click/input
// handlers the mouse does — one panel set, one code path. While presenting, the frame
// element is moved into an offscreen-but-laid-out stage (HTMLMesh measures with
// getBoundingClientRect, never elementFromPoint, so negative coordinates are fine) and
// returned, with its display state, on exit. Fallback for comparison: ?canvasquads=1.
import { THREE, renderer } from './core.js';
import { tee, bus } from './base.js';
import { allFrames, getFrame } from './frames.js';
import { HTMLMesh } from './vendor/htmlmesh.js';
import { quadMaterial } from './quadcolour.js';

const PX_PER_M = 900;      // xrpanels' density — the number the tester's eyes accepted
const W = 0.58;            // metres across, like the canvas quads
const XR_FRAMES = ['world', 'emotes', 'settings', 'chat', 'debug', 'profile'];   // the frames that had canvas quads
const LIVE_MIN_MS = { debug: 250, chat: 250 };   // live panels re-rasterise at most 4 Hz; others at 16 ms

let stage = null; let quads = null; let shown = false;
let all = [];          // every quad ever staged, kept across sessions (soft swap); `quads` is this session's list
let rigRef = null; let builds = 0;
// where you put each panel (rig-local pos + yaw/pitch), per browser — a grabbed panel (C17) stays put next session
const PLACE_LS = 'ew-xr-quads';
const loadPlaces = () => { try { return JSON.parse(localStorage.getItem(PLACE_LS) || '{}'); } catch { return {}; } };
const savePlace = (id, p) => { try { const all = loadPlaces(); all[id] = p; localStorage.setItem(PLACE_LS, JSON.stringify(all)); } catch {} };
export const resetQuadPlaces = () => { try { localStorage.removeItem(PLACE_LS); } catch {} };
const _rc = new THREE.Raycaster(); const _m = new THREE.Matrix4();

function ensureStage() {
  if (stage) return stage;
  // XR-only chrome for the staged frames: HTMLMesh's mini-renderer has no blur/shadow, so none is asked
  // for; desktop-only furniture (✕, resize, collapse) is hidden on the quad
  const css = document.createElement('style'); css.id = 'xr-stage-css';
  // The panel is the TOKEN (--panel-rgb), opaque by default: its desktop glass (--panel-a) composites over a viewport a
  // quad does not have. No lift: the panel was mixed 18% toward the text tone (09-05, when it read near-black) — that
  // was the ACES output pass darkening it, which quadcolour.js now undoes, so the lift only made it lighter than
  // authored (owner, 09-30). --xr-panel-a is Settings › Style's "VR panel opacity" (setXrPanelAlpha below).
  // rgb(var()) computes to a plain rgb()/rgba(): HTMLMesh parses computed colours itself, and Chrome serialises a
  // color-mix() result as color(srgb …), which that parser mangled to PURPLE (pairs probe, 09-05 23:40).
  // The head strip keeps its desktop rgb(0 0 0 / .3), composited on the quad's own canvas over the panel.
  css.textContent = `#xr-stage .frame.panel { box-shadow: none; backdrop-filter: none; background: rgb(var(--panel-rgb) / var(--xr-panel-a, 1)); }
#xr-stage .fr-head { backdrop-filter: none; }
#xr-stage .fr-btns { display: none; }`;
  document.head.appendChild(css);
  stage = document.createElement('div'); stage.id = 'xr-stage';
  stage.style.cssText = 'position:fixed;left:-100000px;top:0;width:1px;height:1px;overflow:visible;visibility:visible;pointer-events:none;';
  document.body.appendChild(stage);
  return stage;
}

// SOFT SWAP (Basis: build once, hide/show). A quad is STAGED every session — its element must leave the
// desktop while presenting and come back after — but its mesh is BUILT only when first shown (quads start
// hidden, and HTMLTexture's constructor rasterises the whole frame synchronously on the main thread: six of
// those ran at every entry for panels nobody had opened) and then KEPT across sessions, paused and with its
// observer suspended while the element lives on the desktop. A frame resized on the desktop since the mesh
// was built rebuilds at its next show (HTMLMesh fixes its geometry at construction).
function stageEl(q) {
  const el = q.el, api = q.api;
  q.restore = { parent: el.parentNode, next: el.nextSibling, display: el.style.display, left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height, position: el.style.position, collapsed: el.classList.contains('collapsed') };
  ensureStage().appendChild(el);
  el.style.display = 'flex'; el.style.left = '0px'; el.style.top = '0px'; el.style.position = 'absolute';   // laid out, visible, INSIDE the offscreen stage (frames are position:fixed — left at that they piled up in the desktop's corner while presenting; owner, 22:25)
  if (el.offsetWidth < 40 || el.offsetHeight < 40) {   // a frame that has never been shown may carry no size yet
    const st = api._state ?? api.state ?? {}; el.style.width = `${st.w ?? 300}px`; el.style.height = `${st.h ?? 220}px`;
  }
}

function build(q) {
  const el = q.el;
  const cssW = Math.max(40, el.offsetWidth);
  const scale = (PX_PER_M * W) / cssW;   // device px per CSS px so the quad reads at 900 px/m
  const mesh = new HTMLMesh(el, { scale, minInterval: LIVE_MIN_MS[q.id] ?? 16 });
  builds++;
  mesh.material.transparent = false;   // stays in the opaque pass (no sorting, no blending)…
  mesh.material.alphaTest = 0.5;       // …while the raster's clear corners (a frame's border-radius) cut out instead of drawing black
  prepareQuadMaterial(mesh);           // the authored colour after the output pass (quadcolour.js says why)
  applyPanelAlpha(mesh);               // Settings › Style › VR panel opacity: below 1 the quad leaves the opaque pass
  const k = W / (cssW * 0.001);   // HTMLMesh geometry = CSS px × 1 mm; rescale to W metres
  mesh.scale.setScalar(k);
  const a = (q.i - (q.n - 1) / 2) * 0.55;
  mesh.position.set(Math.sin(a) * 0.85, 1.15, -Math.cos(a) * 0.85);
  mesh.rotation.y = -a;
  const saved = loadPlaces()[q.id];
  if (saved && Array.isArray(saved.pos) && saved.pos.length === 3 && saved.pos.every(Number.isFinite) && Number.isFinite(saved.yaw)) {
    mesh.position.fromArray(saved.pos); mesh.rotation.set(Number.isFinite(saved.pitch) ? saved.pitch : 0, saved.yaw, 0, 'YXZ');
  }
  mesh.userData.noCamCollide = true;
  q.mesh = mesh; q.builtAt = [el.offsetWidth, el.offsetHeight];
}

/** The quad's material: undoes the renderer's ACES output pass and applies the VR panel grade (exported for the probe). */
export const prepareQuadMaterial = (mesh) => quadMaterial(mesh, renderer);

// VR panel opacity (Settings › Style; stylepanel.js stores it as the --xr-panel-a token, default 1). It is the PANEL
// BACKGROUND's alpha, as --panel-a is on the desktop — text and controls stay opaque — carried by the raster's own alpha
// (the #xr-stage rule above). At 1 the quad is exactly what it always was: opaque pass, alphaTest cutting the corners.
// Below 1 it must blend, so it joins the transparent pass: three sorts those back-to-front by distance after every
// opaque thing, so the world shows through; depthWrite stays ON so a nearer panel still hides what is behind it and a
// laser/particle drawn later can't paint through the text. alphaTest drops to 0.01: it still cuts the clear corners.
// The ACES undo (quadcolour.js) is exact only where alpha is 1: the blend with the world happens BEFORE the output
// pass tone-maps the mix, so a see-through panel's background lands near, not on, its authored colour.
export const xrPanelAlpha = () => {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--xr-panel-a'));
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
};
function applyPanelAlpha(mesh) {
  const m = mesh.material, see = xrPanelAlpha() < 1;
  if (m.transparent === see && m.userData.panelAlphaSet) return;
  m.transparent = see; m.alphaTest = see ? 0.01 : 0.5; m.depthWrite = true; m.userData.panelAlphaSet = true; m.needsUpdate = true;
}
// a style token changed (a colour, the VR opacity): every built quad re-rasters from the live DOM and re-checks its pass
bus.on('style', () => {
  for (const q of all) {
    if (!q.mesh) continue;
    applyPanelAlpha(q.mesh);
    const t = q.mesh.material.map; if (q.mesh.visible && !t.paused) t.update?.();
  }
});

function drop(q) { if (!q.mesh) return; q.mesh.removeFromParent(); q.mesh.dispose(); q.mesh = null; }

// visible = true builds (or rebuilds a stale) mesh; false only hides what exists
function setVisible(q, on) {
  if (on) {
    const el = q.el;
    if (q.mesh && (q.builtAt[0] !== el.offsetWidth || q.builtAt[1] !== el.offsetHeight)) drop(q);
    if (!q.mesh) { build(q); rigRef?.add(q.mesh); }
  }
  if (!q.mesh) return;
  q.mesh.visible = on; const t = q.mesh.material.map; if (on) t.resume?.(); else t.pause?.();
}

function unstageEl(q) {
  const r = q.restore; if (!r) return;
  // the desktop DOM may have re-ordered while we were presenting: the saved sibling is only usable if it is
  // still that parent's child (live, 09-05 22:20: 'error when I try to leave VR' — insertBefore NotFoundError)
  const parent = r.parent ?? document.body;
  if (r.next && r.next.parentNode === parent) parent.insertBefore(q.el, r.next); else parent.appendChild(q.el);
  q.el.style.display = r.display; q.el.style.left = r.left; q.el.style.top = r.top; q.el.style.width = r.width; q.el.style.height = r.height; q.el.style.position = r.position; if (r.collapsed) q.el.classList.add('collapsed');
  q.restore = null;
}

export const domQuadsEnabled = () => !new URLSearchParams(location.search).has('canvasquads');

export function domQuadsEnter(rig) {
  const apis = XR_FRAMES.map((id) => getFrame(id)).filter(Boolean);
  const extra = allFrames().filter((f) => f.xr && !apis.includes(f));
  const list = [...apis, ...extra];
  for (const q of all) if (!list.includes(q.api)) drop(q);   // a frame that went away since last session
  rigRef = rig;
  quads = list.map((api, i) => {
    const q = all.find((x) => x.api === api) ?? { id: api.id, api, el: api.el, mesh: null, restore: null, builtAt: null };
    q.el = api.el; q.i = i; q.n = list.length;
    return q;
  });
  all = quads.slice();
  for (const q of quads) {
    try { stageEl(q); } catch (e) { console.warn('[domquad] stage', q.id, e); }
    if (q.mesh) { rig.add(q.mesh); q.mesh.material.map.unsuspend?.(); }
  }
  // OFF by default while the quads are still being worked on (live 09-06 12:49): staged, hidden, unbuilt;
  // the ring's 'panels' slot (or a text-focus for the keyboard) shows them. ?quads=1 restores the old default.
  shown = new URLSearchParams(location.search).get('quads') === '1';
  for (const q of quads) setVisible(q, shown);
  bus.emit('xr:domquads', quads.map((q) => q.id));
}

export function domQuadsExit(rig) {
  if (!quads) return;
  for (const q of quads) {   // one bad restore must not strand the others (or the session teardown)
    try { if (q.mesh) { q.mesh.removeFromParent(); q.mesh.visible = false; const t = q.mesh.material.map; t.pause?.(); t.suspend?.(); } unstageEl(q); } catch (e) { console.warn('[domquad] unmount', q.id, e); }
  }
  quads = null; shown = false; rigRef = null;
}

/** probe window: how many meshes exist, how many were ever built (a re-entry that rebuilds shows here) */
const domQuadsDebug = () => ({ ids: all.map((q) => q.id), kept: all.length, built: all.filter((q) => q.mesh).length, builds, staged: (quads ?? []).length, shown: domQuadsShown(),
  meshIds: all.map((q) => q.mesh?.uuid ?? null), onDesktop: all.map((q) => !!q.el && !q.el.closest('#xr-stage')), observing: all.map((q) => (q.mesh ? !q.mesh.material.map.suspended : null)) });
globalThis.__domQuads = domQuadsDebug;

export const domQuadsShown = () => !!quads && quads.some((q) => q.mesh?.visible);
export function domQuadsSetShown(v) {
  shown = !!v;
  for (const q of quads ?? []) setVisible(q, shown);
}

// mirrors xrPanelsPick: distance to the quad under the ray, or null; on click, the
// trigger becomes mousedown → mouseup → click at the hit uv on the real DOM
export function domQuadsPick(handRay, click = false) {
  if (!quads || !shown) return null;
  _m.identity().extractRotation(handRay.matrixWorld);
  _rc.ray.origin.setFromMatrixPosition(handRay.matrixWorld);
  _rc.ray.direction.set(0, 0, -1).applyMatrix4(_m);
  _rc.far = 3;
  const hit = _rc.intersectObjects(quads.filter((q) => q.mesh?.visible).map((q) => q.mesh), false)[0];
  if (!hit) return null;
  if (click && hit.uv) {
    const data = { x: hit.uv.x, y: 1 - hit.uv.y };
    // witness (live 09-07 22:57: 'trigger-to-click … working'): which element the click lands on, teed
    try { const el = hit.object.material.map.elementAt?.(data.x, data.y); tee(`[xr] quad click ${quads.find((q) => q.mesh === hit.object)?.id ?? '?'} → ${el ? `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} "${(el.textContent || '').trim().slice(0, 24)}"` : 'nothing'}`); } catch {}
    for (const type of ['mousedown', 'mouseup', 'click']) hit.object.dispatchEvent({ type, data });
  }
  return hit.distance;
}

// Trigger on a panel, the way touch works (and Resonite / VRChat panels): every press is a PRESS: drag past DRAG_PX and
// the panel scrolls with the laser, release without dragging and it clicks where it was pressed. Buttons, checkboxes,
// dropdowns and links click on release, so a drag that starts on one scrolls instead of toggling it: the debug panel
// is mostly checkbox rows and section-head buttons, and pressing to scroll it flipped them (owner 09-27, review P2).
// Only controls that need the press ITSELF click at once: a slider (it drags its own thumb) and text fields (focus).
const NEEDS_PRESS = 'input[type=range],[role=slider],input:not([type]),input[type=text],input[type=search],'
  + 'input[type=number],input[type=password],input[type=email],input[type=url],textarea,[contenteditable=""],[contenteditable="true"]';
const DRAG_PX = 20;   // from the press point, not summed per frame: hand tremor wanders a few px each way (review 09-27, P1)
function aim(handRay) {
  _m.identity().extractRotation(handRay.matrixWorld);
  _rc.ray.origin.setFromMatrixPosition(handRay.matrixWorld);
  _rc.ray.direction.set(0, 0, -1).applyMatrix4(_m);
  _rc.far = 3;
}
const fire = (mesh, data) => { for (const type of ['mousedown', 'mouseup', 'click']) mesh.dispatchEvent({ type, data }); };

/** Trigger down on the quads: {dist, press} (press is null when it already clicked), or null when no quad is hit. */
export function domQuadsPress(handRay) {
  if (!quads || !shown) return null;
  aim(handRay);
  const hit = _rc.intersectObjects(quads.filter((q) => q.mesh?.visible).map((q) => q.mesh), false)[0];
  if (!hit) return null;
  if (!hit.uv) return { dist: hit.distance, press: null };
  const data = { x: hit.uv.x, y: 1 - hit.uv.y };
  const el = hit.object.material.map.elementAt?.(data.x, data.y);
  if (!el || el.closest?.(NEEDS_PRESS)) { domQuadsPick(handRay, true); return { dist: hit.distance, press: null }; }
  return { dist: hit.distance, press: { mesh: hit.object, el, data, lastY: data.y, travel: 0, dragging: false } };
}

/** Trigger held after a press: the panel follows the laser once it has moved DRAG_PX. */
export function domQuadsDrag(handRay, press) {
  aim(handRay);
  const hit = _rc.intersectObject(press.mesh, false)[0];
  if (!hit?.uv) return;
  const map = press.mesh.material.map;
  const y = 1 - hit.uv.y, h = map.dom?.getBoundingClientRect().height ?? 0;
  const dPx = (y - press.lastY) * h;
  press.lastY = y;
  press.travel = Math.max(press.travel, Math.abs(y - press.data.y) * h);   // farthest from where it was pressed
  if (!press.dragging && press.travel >= DRAG_PX) press.dragging = true;
  if (press.dragging && dPx) map.scrollAt?.(press.data.x, press.data.y, -dPx);   // content follows the laser
}

/** Trigger up: a press that never dragged is a click where it began. `cancel` (a grab took over) drops it. */
export function domQuadsRelease(press, cancel = false) {
  if (!press || cancel || press.dragging || !press.mesh.parent) return;
  // the click goes to what was PRESSED: if the content moved under the point meanwhile (a chat line arrived), the
  // element there now is something else, and a release over it is no click (as a mouse up off its button isn't)
  const now = press.mesh.material.map?.elementAt?.(press.data.x, press.data.y);
  if (press.el && now !== press.el && !press.el.contains?.(now)) return;
  fire(press.mesh, press.data);
}

/** Scroll the panel under the ray by dy CSS px (right stick Y while the laser is on a quad). */
export function domQuadsScroll(handRay, dy) {
  if (!quads || !shown) return false;
  _m.identity().extractRotation(handRay.matrixWorld);
  _rc.ray.origin.setFromMatrixPosition(handRay.matrixWorld);
  _rc.ray.direction.set(0, 0, -1).applyMatrix4(_m);
  _rc.far = 3;
  const hit = _rc.intersectObjects(quads.filter((q) => q.mesh?.visible).map((q) => q.mesh), false)[0];
  if (!hit?.uv) return false;
  return !!hit.object.material.map.scrollAt?.(hit.uv.x, 1 - hit.uv.y, dy);
}

// one quad by id — a ring slot opens that frame's quad; `on` null toggles
export function domQuadShow(id, on = null) {
  const q = quads?.find((x) => x.id === id); if (!q) return false;
  setVisible(q, on == null ? !q.mesh?.visible : !!on);
  shown = quads.some((x) => x.mesh?.visible);
  return !!q.mesh?.visible;
}
export const domQuadIds = () => (quads ?? []).map((q) => q.id);
export const domQuadOpen = (id) => !!quads?.find((q) => q.id === id)?.mesh?.visible;

// ---- grabbable, following panels (gap list C17; Basis's design over rig-locked quads). The
// grip+trigger chord on a quad takes the QUAD (xr.js asks here before it asks the world, the same
// order a click uses): the mesh rides the hand; on release it goes back to the rig where it
// visually is, roll stripped so text stays upright, pitch clamped so it never lies flat. Where you
// put a panel is remembered per browser (ew-xr-quads in localStorage, above).
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
export function domQuadsGrab(handRay) {
  if (!quads || !shown) return null;
  _m.identity().extractRotation(handRay.matrixWorld);
  _rc.ray.origin.setFromMatrixPosition(handRay.matrixWorld);
  _rc.ray.direction.set(0, 0, -1).applyMatrix4(_m);
  _rc.far = 3;
  const hit = _rc.intersectObjects(quads.filter((q) => q.mesh?.visible).map((q) => q.mesh), false)[0];
  return hit ? quads.find((q) => q.mesh === hit.object) ?? null : null;
}
/** Hand the quad back to `rig` where it visually is; upright it. Returns the quad's rig-local pose. */
export function domQuadRelease(q, rig) {
  rig.attach(q.mesh);
  _e.setFromQuaternion(q.mesh.quaternion, 'YXZ');
  _e.z = 0; _e.x = THREE.MathUtils.clamp(_e.x, -0.6, 0.6);
  q.mesh.quaternion.setFromEuler(_e);
  q.mesh.updateMatrixWorld(true);
  const p = { pos: q.mesh.position.toArray().map((v) => +v.toFixed(3)), yaw: +_e.y.toFixed(3), pitch: +_e.x.toFixed(3) };
  savePlace(q.id, p);
  return p;
}
export const domQuadTexture = (id) => quads?.find((q) => q.id === id)?.mesh?.material.map ?? null;
export const domQuadMesh = (id) => quads?.find((q) => q.id === id)?.mesh ?? null;   // probe window (the material's pass)
