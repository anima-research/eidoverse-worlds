// domquad — VR quads ARE the desktop frames: each XR-registered frame's live DOM is rasterised onto a quad by the
// vendored HTMLMesh (vendor/htmlmesh.js), and a trigger fires the SAME click/input handlers the mouse does.
// While presenting, the frame moves into an offscreen-but-laid-out stage (HTMLMesh measures with getBoundingClientRect,
// so negative coordinates are fine) and returns, with its display state, on exit. Fallback: ?canvasquads=1.
import { THREE, renderer } from '../core.js';
import { tee, bus, CONFIG } from '../base.js';
import { allFrames, getFrame, frameResizeInfo } from '../windows.js';
import { HTMLMesh } from '../../vendor/three-addons/htmlmesh.js';
import { quadMaterial } from './quadcolour.js';

const PX_PER_M = 900;      // xrpanels' density
const W = 0.58;            // metres across, like the canvas quads
const XR_FRAMES = ['world', 'actions', 'settings', 'chat', 'debug', 'profile', 'moderation', 'world-settings'];   // the frames that had canvas quads, + the two roles panels
const LIVE_MIN_MS = { debug: 250, chat: 250 };   // live panels re-rasterise at most 4 Hz; others at 16 ms

let stage = null; let quads = null; let shown = false;
let all = [];          // every quad ever staged, kept across sessions (soft swap); `quads` is this session's list
let rigRef = null; let builds = 0;
// where you put each panel (rig-local pos + yaw/pitch), per browser — a grabbed panel stays put next session
const PLACE_LS = 'ew-xr-quads';
const loadPlaces = () => { try { return JSON.parse(localStorage.getItem(PLACE_LS) || '{}'); } catch { return {}; } };
// MERGED into what is saved: a move (pos/yaw/pitch) must not wipe a VR resize (w, bh, mpp)
const savePlace = (id, p) => { try { const all = loadPlaces(); all[id] = { ...(all[id] ?? {}), ...p }; localStorage.setItem(PLACE_LS, JSON.stringify(all)); } catch {} };
const _rc = new THREE.Raycaster(); const _m = new THREE.Matrix4();

function ensureStage() {
  if (stage) return stage;
  // XR-only chrome: HTMLMesh's mini-renderer has no blur/shadow, so none is asked for; desktop furniture (✕, resize, collapse) hides
  const css = document.createElement('style'); css.id = 'xr-stage-css';
  // The panel is the --panel-rgb token, opaque by default (desktop glass has no viewport to composite over);
  // --xr-panel-a is "VR panel opacity". rgb(var()), never color-mix(): HTMLMesh's parser mangles color(srgb …).
  css.textContent = `#xr-stage .frame.panel { box-shadow: none; backdrop-filter: none; background: rgb(var(--panel-rgb) / var(--xr-panel-a, 1)); }
#xr-stage .fr-head { backdrop-filter: none; }
#xr-stage .fr-btns { display: none; }`;
  document.head.appendChild(css);
  stage = document.createElement('div'); stage.id = 'xr-stage';
  stage.style.cssText = 'position:fixed;left:-100000px;top:0;width:1px;height:1px;overflow:visible;visibility:visible;pointer-events:none;';
  document.body.appendChild(stage);
  return stage;
}

// Soft swap: a quad is STAGED every session but its mesh is BUILT on first show (HTMLTexture rasterises
// synchronously) and kept across sessions, paused on the desktop. A frame resized since rebuilds at next show.
function stageEl(q) {
  const el = q.el, api = q.api;
  q.restore = { parent: el.parentNode, next: el.nextSibling, display: el.style.display, left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height, position: el.style.position, collapsed: el.classList.contains('collapsed') };
  ensureStage().appendChild(el);
  el.style.display = 'flex'; el.style.left = '0px'; el.style.top = '0px'; el.style.position = 'absolute';   // laid out, visible, INSIDE the offscreen stage (frames are position:fixed: left so, they pile up in the desktop's corner)
  if (el.offsetWidth < 40 || el.offsetHeight < 40) {   // a frame that has never been shown may carry no size yet
    const st = api._state ?? api.state ?? {}; el.style.width = `${st.w ?? 300}px`; el.style.height = `${st.h ?? 220}px`;
  }
  // VR has ITS OWN layout for a frame: a headset resize (saved with the panel's place) goes on while staged; the desktop's is never touched
  const vr = loadPlaces()[q.id];
  if (Number.isFinite(vr?.w) && Number.isFinite(vr?.bh)) api._setVrSize?.({ w: vr.w, h: vr.bh });
}

function build(q) {
  const el = q.el;
  const cssW = Math.max(40, el.offsetWidth);
  const placed = loadPlaces()[q.id];
  const wM = Number.isFinite(placed?.mpp) && placed.mpp > 0.0003 && placed.mpp < 0.01 ? placed.mpp * cssW : W;   // the quad's width, metres (see below)
  const scale = (PX_PER_M * wM) / cssW;   // device px per CSS px so the quad reads at 900 px/m
  const mesh = new HTMLMesh(el, { scale, minInterval: LIVE_MIN_MS[q.id] ?? 16 });
  builds++;
  mesh.material.transparent = false;   // stays in the opaque pass (no sorting, no blending)…
  mesh.material.alphaTest = 0.5;       // …while the raster's clear corners (a frame's border-radius) cut out instead of drawing black
  prepareQuadMaterial(mesh);           // the authored colour after the output pass (quadcolour.js says why)
  applyPanelAlpha(mesh);               // Settings › Style › VR panel opacity: below 1 the quad leaves the opaque pass
  const saved = loadPlaces()[q.id];
  // a panel RESIZED in VR keeps the pixel density it had (metres per CSS px, saved with its place): wider is bigger,
  // not finer. Never resized: every quad is W wide, as always.
  const mpp = Number.isFinite(saved?.mpp) && saved.mpp > 0.0003 && saved.mpp < 0.01 ? saved.mpp : W / cssW;
  const k = mpp / 0.001;   // HTMLMesh geometry = CSS px × 1 mm; rescale to mpp metres per px
  mesh.scale.setScalar(k);
  const a = (q.i - (q.n - 1) / 2) * 0.55;
  mesh.position.set(Math.sin(a) * 0.85, 1.15, -Math.cos(a) * 0.85);
  mesh.rotation.y = -a;
  if (saved && Array.isArray(saved.pos) && saved.pos.length === 3 && saved.pos.every(Number.isFinite) && Number.isFinite(saved.yaw)) {
    mesh.position.fromArray(saved.pos); mesh.rotation.set(Number.isFinite(saved.pitch) ? saved.pitch : 0, saved.yaw, 0, 'YXZ');
  }
  mesh.userData.noCamCollide = true;
  q.mesh = mesh; q.builtAt = [el.offsetWidth, el.offsetHeight];
  makeHandle(q);
}

/** The quad's material: undoes the renderer's ACES output pass and applies the VR panel grade (exported for the probe). */
export const prepareQuadMaterial = (mesh) => quadMaterial(mesh, renderer);

// VR panel opacity (--xr-panel-a, stylepanel.js): the background's alpha only. Below 1 the quad joins the
// transparent pass with depthWrite ON (nothing later paints through the text) and alphaTest 0.01. The ACES undo
// (quadcolour.js) is exact only at alpha 1.
const xrPanelAlpha = () => {
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

function drop(q) { if (!q.mesh) return; q.handle?.geometry.dispose(); q.handle?.material.dispose(); q.mesh.removeFromParent(); q.mesh.dispose(); q.mesh = null; q.aids = null; q.handle = null; }

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
  // the desktop DOM may have re-ordered meanwhile: the saved sibling is usable only if still that parent's child (else insertBefore throws)
  const parent = r.parent ?? document.body;
  if (r.next && r.next.parentNode === parent) parent.insertBefore(q.el, r.next); else parent.appendChild(q.el);
  q.el.style.display = r.display; q.el.style.left = r.left; q.el.style.top = r.top; q.el.style.width = r.width; q.el.style.height = r.height; q.el.style.position = r.position; if (r.collapsed) q.el.classList.add('collapsed');
  q.restore = null;
  q.api?._setVrSize?.(null);   // the desktop size back (the VR one stays saved with the panel's place)
}

export const domQuadsEnabled = () => !CONFIG.params.has('canvasquads');

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
  // OFF by default (staged, hidden, unbuilt); the ring's 'panels' slot or a text-focus shows them. ?quads=1 restores the old default.
  shown = CONFIG.params.get('quads') === '1';
  for (const q of quads) setVisible(q, shown);
  bus.emit('xr:domquads', quads.map((q) => q.id));
}

export function domQuadsExit(rig) {
  if (!quads) return;
  for (const q of quads) {   // one bad restore must not strand the others (or the session teardown)
    try { if (q.mesh) { q.mesh.removeFromParent(); q.mesh.visible = false; const t = q.mesh.material.map; t.pause?.(); t.suspend?.(); } unstageEl(q); } catch (e) { console.warn('[domquad] unmount', q.id, e); }
  }
  quads = null; shown = false; rigRef = null; stash = null;
}

/** probe window: how many meshes exist, how many were ever built (a re-entry that rebuilds shows here) */
const domQuadsDebug = () => ({ ids: all.map((q) => q.id), kept: all.length, built: all.filter((q) => q.mesh).length, builds, staged: (quads ?? []).length, shown: domQuadsShown(),
  meshIds: all.map((q) => q.mesh?.uuid ?? null), onDesktop: all.map((q) => !!q.el && !q.el.closest('#xr-stage')), observing: all.map((q) => (q.mesh ? !q.mesh.material.map.suspended : null)) });
globalThis.__domQuads = domQuadsDebug;

export const domQuadsShown = () => !!quads && quads.some((q) => q.mesh?.visible);
export function domQuadsSetShown(v) {
  stash = null;   // an explicit show/hide of all supersedes a quick hide
  shown = !!v;
  for (const q of quads ?? []) setVisible(q, shown);
}

// THE QUICK HIDE: one button puts every open panel away and brings exactly those back, where they were.
// Not closing: open state, places and sizes are kept (meshes hidden, paused); opening one from the ring brings the hidden back first.
let stash = null;   // ids of the panels the quick hide put away, or null when nothing is hidden
export const domQuadsHidden = () => !!stash;
export function domQuadsHideToggle() {
  if (!quads) return false;
  if (stash) {
    for (const q of quads) if (stash.includes(q.id)) setVisible(q, true);
    stash = null; shown = quads.some((x) => x.mesh?.visible);
    return false;
  }
  const open = quads.filter((q) => q.mesh?.visible);
  if (!open.length) return false;   // nothing to put away
  stash = open.map((q) => q.id);
  for (const q of open) setVisible(q, false);
  shown = false;
  return true;
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
    // witness: which element the click lands on, teed
    try { const el = hit.object.material.map.elementAt?.(data.x, data.y); tee(`[xr] quad click ${quads.find((q) => q.mesh === hit.object)?.id ?? '?'} → ${el ? `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} "${(el.textContent || '').trim().slice(0, 24)}"` : 'nothing'}`); } catch {}
    for (const type of ['mousedown', 'mouseup', 'click']) hit.object.dispatchEvent({ type, data });
  }
  return hit.distance;
}

// Trigger works like touch: drag past DRAG_PX scrolls, release without dragging clicks, so a scroll starting on a
// checkbox doesn't flip it. Only sliders and text fields act on the press itself.
// the text fields (a press focuses them for typing) — also the VR pointer's "type" icon (xr.js targetKind)
export const TEXT_SEL = 'input:not([type]),input[type=text],input[type=search],input[type=number],input[type=password],input[type=email],input[type=url],'
  + 'textarea,[contenteditable=""],[contenteditable="true"]';
const NEEDS_PRESS = 'input[type=range],[role=slider],' + TEXT_SEL;
const DRAG_PX = 20;   // from the press point, not summed per frame: hand tremor wanders a few px each way
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

// A control = anything a click acts on (incl. labels, and a pointer cursor its parent lacks). The laser sticks
// to one (xr.js, xrpointer.js); a grip over one doesn't grab the panel.
const CONTROL_SEL = 'a[href],button,input,select,textarea,label,summary,.dd,[role=button],[role=checkbox],[role=radio],[role=switch],'
  + '[role=slider],[role=tab],[role=option],[role=link],[role=menuitem],[contenteditable=""],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
/** The interactive element at uv (x, y down) on a quad's texture, or null (background, title, text). */
export function controlAt(map, x, y) {
  const root = map?.dom; const el = map?.elementAt?.(x, y);
  if (!root || !el) return null;
  for (let n = el; n && n !== root; n = n.parentElement) if (n.matches?.(CONTROL_SEL) || typeof n.onclick === 'function') return n;
  // a pointer cursor that STARTS at some ancestor (cursor inherits: the topmost element still showing it is the control)
  let top = null;
  for (let n = el; n && n !== root; n = n.parentElement) { if (getComputedStyle(n).cursor === 'pointer') top = n; else if (top) break; }
  return top;
}
const _wn = new THREE.Vector3();
/** What the ray is on, among the shown quads: {dist, point, normal (world, facing the ray's side), mesh, id, control}
 *  or null. `control` is the element under the hit when it is interactive (controlAt), else null. */
export function domQuadsAt(handRay) {
  if (!quads || !shown) return null;
  aim(handRay);
  const vis = quads.filter((q) => q.mesh?.visible);
  const hit = _rc.intersectObjects([...vis.map((q) => q.mesh), ...vis.map((q) => q.handle).filter(Boolean)], false)[0];
  if (!hit) return null;
  const normal = hit.face ? _wn.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).clone() : new THREE.Vector3(0, 0, 1);
  if (normal.dot(_rc.ray.direction) > 0) normal.negate();
  const hq = hit.object.userData.handleOf;   // the handle bar under the panel: the move grip, nothing to click
  if (hq) return { dist: hit.distance, point: hit.point, normal, mesh: hq.mesh, id: hq.id, control: null, zone: 'move', handle: true, scroll: false };
  const map = hit.object.material.map;
  const control = hit.uv ? controlAt(map, hit.uv.x, 1 - hit.uv.y) : null;
  let zone = null;
  if (!control && hit.uv && map?.dom) { const fr = map.dom.getBoundingClientRect(); zone = zoneAt(map.dom, hit.uv.x * fr.width, (1 - hit.uv.y) * fr.height); }
  return { dist: hit.distance, point: hit.point, normal, mesh: hit.object, id: quads.find((q) => q.mesh === hit.object)?.id ?? null, control, zone,
    scroll: !control && hit.uv ? scrollableAt(map, hit.uv.x, 1 - hit.uv.y) : false };
}

// ---- ZONES: resize corners and left/right/bottom edges, in frame CSS px (windows.js frameResizeInfo) --------------
// The rest is 'body' (a fallback move grab); a control under the laser outranks every zone.
const ZONE_EDGE_PX = 12, ZONE_CORNER_PX = 24;
function zoneAt(root, x, y) {
  const fr = root.getBoundingClientRect(), W = fr.width, H = fr.height;
  if (!(x >= 0 && y >= 0 && x <= W && y <= H)) return null;
  if (frameResizeInfo(root)) {
    const L = x < ZONE_EDGE_PX, R = x > W - ZONE_EDGE_PX, T = y < ZONE_EDGE_PX, B = y > H - ZONE_EDGE_PX;
    const cl = x < ZONE_CORNER_PX, cr = x > W - ZONE_CORNER_PX, ct = y < ZONE_CORNER_PX, cb = y > H - ZONE_CORNER_PX;
    if ((L || B) && cl && cb) return 'resize-sw';
    if ((R || B) && cr && cb) return 'resize-se';
    if ((L || T) && cl && ct) return 'resize-nw';
    if ((R || T) && cr && ct) return 'resize-ne';
    if (L) return 'resize-w';
    if (R) return 'resize-e';
    if (B) return 'resize-s';
  }
  return 'body';
}

// The handle bar: a faint bar below each panel, the primary move grab (full on laser dwell or hold). A child of the
// quad in its units, so it scales and rides along.
const HANDLE_W_PX = 120, HANDLE_H_PX = 14, HANDLE_GAP_PX = 10;
const HANDLE_IDLE = 0.35, HANDLE_ON = 0.95;
let handleTex = null;
function handleTexture() {
  if (handleTex) return handleTex;
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 32;
  const g = cv.getContext('2d'); g.fillStyle = '#f2f7f5'; g.beginPath(); g.roundRect(4, 6, 248, 20, 10); g.fill();
  handleTex = new THREE.CanvasTexture(cv); handleTex.colorSpace = THREE.SRGBColorSpace;
  return handleTex;
}
function makeHandle(q) {
  const H = q.mesh.geometry.parameters.height;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(HANDLE_W_PX * 0.001, HANDLE_H_PX * 0.001),
    new THREE.MeshBasicNodeMaterial({ map: handleTexture(), transparent: true, opacity: HANDLE_IDLE, depthWrite: false, alphaTest: 0.02 }));
  m.position.set(0, -H / 2 - (HANDLE_GAP_PX + HANDLE_H_PX / 2) * 0.001, 0);
  m.name = 'xr-handle'; m.userData.handleOf = q; m.userData.noCamCollide = true; m.renderOrder = 1300;
  q.mesh.add(m); q.handle = m;
}
/** Is the point inside an area that scrolls (a trigger-drag there scrolls it)? */
function scrollableAt(map, x, y) {
  for (let n = map?.elementAt?.(x, y); n && n !== map.dom.parentElement; n = n.parentElement) {
    if (n.scrollHeight > n.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowY)) return true;
    if (n === map.dom) break;
  }
  return false;
}

// THE RESIZE HANDLES, revealed on dwell (xr.js asks with the hand's dwell): an L at a corner, a line along an edge, brand ink,
// as the quad's children a hair in front. 'move' brightens the handle bar instead.
const AID_INK = 0x8fe8c8, AID_Z = 0.002;
function aidsFor(q) {
  if (q.aids && q.aids.parent === q.mesh) return q.aids;
  const g = new THREE.Group(); g.name = 'xr-aids'; q.mesh.add(g); q.aids = g; return g;
}
function aidMesh(q, zone) {
  const fr = q.el.getBoundingClientRect(), W = fr.width * 0.001, H = fr.height * 0.001, g = aidsFor(q);
  const key = `${zone}:${fr.width}x${fr.height}`;
  let m = g.children.find((c) => c.userData.zone === zone);
  if (m && m.userData.key === key) return m;
  if (m) { g.remove(m); m.geometry.dispose(); m.material.dispose(); }
  const mat = (o) => new THREE.LineBasicNodeMaterial({ color: AID_INK, transparent: true, opacity: o, depthWrite: false });
  const x0 = -W / 2, x1 = W / 2, y0 = -H / 2, y1 = H / 2, c = ZONE_CORNER_PX * 0.001, i = 0.004;   // corner arm; inset 4 px
  let pts;
  if (zone.startsWith('resize-')) {
    const z = zone.slice(7), X = z.includes('w') ? x0 + i : x1 - i, Y = z.includes('n') ? y1 - i : y0 + i, sx = z.includes('w') ? 1 : -1, sy = z.includes('n') ? -1 : 1;
    if (z.length === 2) pts = [[X, Y], [X + sx * c, Y], [X, Y], [X, Y + sy * c]];
    else if (z === 's') pts = [[x0 + c, y0 + i], [x1 - c, y0 + i]];
    else pts = [[X, y0 + c], [X, y1 - c]];
  } else return null;
  const geo = new THREE.BufferGeometry().setFromPoints(pts.map(([x, y]) => new THREE.Vector3(x, y, AID_Z)));
  m = new THREE.LineSegments(geo, mat(0.95)); m.userData.zone = zone; m.userData.key = key; m.renderOrder = 1400; m.frustumCulled = false;
  g.add(m); return m;
}
/** Show quad `mesh`'s handle for `zone` ('move' | 'resize-*'), hiding its others; zone null hides them all. */
function domQuadReveal(mesh, zone) {
  const q = all.find((x) => x.mesh === mesh); if (!q) return;
  const want = zone?.startsWith('resize-') ? aidMesh(q, zone) : null;
  for (const c of q.aids?.children ?? []) c.visible = c === want;
  if (q.handle) q.handle.material.opacity = zone === 'move' ? HANDLE_ON : HANDLE_IDLE;
}
/** every quad's handles hidden but `keep` (a {mesh, zone} list) */
export function domQuadsRevealOnly(keep) {
  for (const q of all) {
    if (!q.mesh) continue;
    const k = keep.find((x) => x.mesh === q.mesh);
    domQuadReveal(q.mesh, k?.zone ?? null);   // resize handles are built the first time one is revealed; the bar always exists
  }
}

// ---- RESIZE in VR: the gripped corner/edge follows the laser. The size is VR's OWN (windows.js _setVrSize, saved in
// ew-xr-quads); the desktop layout is untouched. Rebuilt at the same pixel density; floor minW/minH, ceiling RESIZE_MAX_M.
const RESIZE_MAX_M = 1.6;
const _rp = new THREE.Plane(), _rv = new THREE.Vector3(), _rn = new THREE.Vector3(), _rq = new THREE.Quaternion();
export function domQuadResizeBegin(at) {
  const q = all.find((x) => x.mesh === at?.mesh); const info = q && frameResizeInfo(q.el);
  if (!q || !info || !at.zone?.startsWith('resize-')) return null;
  const z = at.zone.slice(7), fr = q.el.getBoundingClientRect(), { width: W0, height: H0 } = q.mesh.geometry.parameters;
  q.mesh.updateMatrixWorld(true);
  _rn.set(0, 0, 1).applyQuaternion(q.mesh.getWorldQuaternion(_rq));
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(_rn, q.mesh.getWorldPosition(_rv));
  // the ANCHOR: the corner (or edge midpoint) opposite the one gripped, in quad-local units
  const ax = z.includes('e') ? -W0 / 2 : z.includes('w') ? W0 / 2 : -W0 / 2, ay = z.includes('s') ? H0 / 2 : z.includes('n') ? -H0 / 2 : H0 / 2;
  const api = getFrame(q.id), chrome = Math.max(0, q.el.offsetHeight - (api?._vrSize?.h ?? api?._state?.h ?? q.el.offsetHeight));   // the frame's chrome over its body
  const kScale = q.mesh.scale.x;   // metres per local unit
  const maxW = RESIZE_MAX_M / (kScale * 0.001), maxH = RESIZE_MAX_M / (kScale * 0.001);   // VR's own layout: no desktop window to fit
  // a closed Line (five points; the WebGPU renderer draws no LineLoop)
  const outline = new THREE.Line(new THREE.BufferGeometry().setFromPoints([0, 1, 2, 3, 4].map(() => new THREE.Vector3())),
    new THREE.LineBasicNodeMaterial({ color: AID_INK, transparent: true, opacity: 0.95, depthWrite: false }));
  outline.renderOrder = 1401; outline.frustumCulled = false; outline.name = 'xr-resize-outline'; q.mesh.add(outline);
  // where the grip took the edge, relative to the edge itself: the edge then moves BY the laser's travel, it does not
  // jump to the laser (a grip 5 px inside the corner would otherwise shrink the panel 5 px on the first frame)
  const p0 = q.mesh.worldToLocal(at.point.clone());
  const offX = fr.width - Math.abs(p0.x - ax) / 0.001, offY = fr.height - Math.abs(p0.y - ay) / 0.001;
  return { q, z, plane, ax, ay, offX, offY, w0: fr.width, h0: fr.height, w: fr.width, h: fr.height, chrome, info, maxW, maxH, outline };
}
/** One frame of a resize: the laser's point on the panel's plane sets the new size (CSS px); the outline shows it. */
export function domQuadResizeMove(drag, handRay) {
  aim(handRay);
  if (!_rc.ray.intersectPlane(drag.plane, _rv)) return drag;
  const p = drag.q.mesh.worldToLocal(_rv), z = drag.z;
  const minH = drag.info.minH + drag.chrome;
  if (z.includes('e') || z.includes('w')) drag.w = THREE.MathUtils.clamp(Math.abs(p.x - drag.ax) / 0.001 + drag.offX, Math.max(drag.info.minW, 40), drag.maxW);
  if (z.includes('s') || z.includes('n')) drag.h = THREE.MathUtils.clamp(Math.abs(p.y - drag.ay) / 0.001 + drag.offY, minH, drag.maxH);
  // the outline from the anchor, in the direction the gripped side lies
  const sx = z.includes('w') ? -1 : 1, sy = z.includes('n') ? 1 : -1, X = drag.ax, Y = drag.ay, w = drag.w * 0.001, h = drag.h * 0.001;
  const ox = z.includes('e') || z.includes('w') ? X : -drag.q.mesh.geometry.parameters.width / 2;   // an edge-only resize keeps the other axis
  const oy = z.includes('s') || z.includes('n') ? Y : drag.q.mesh.geometry.parameters.height / 2;
  const pos = drag.outline.geometry.attributes.position;
  const xs = [ox, ox + sx * w], ys = [oy, oy + sy * h];
  [[xs[0], ys[0]], [xs[1], ys[0]], [xs[1], ys[1]], [xs[0], ys[1]], [xs[0], ys[0]]].forEach(([x, y], i) => pos.setXYZ(i, x, y, AID_Z * 1.5));
  pos.needsUpdate = true; drag.outline.geometry.computeBoundingSphere();
  return drag;
}
/** Release: commit the size to the frame (windows.js, as a desktop resize does) and rebuild the quad at the same density
 *  with the anchor where it was. Returns { w, h } (CSS px, the frame's whole box) or null. */
export function domQuadResizeEnd(drag, rig) {
  if (!drag) return null;
  drag.outline.removeFromParent(); drag.outline.geometry.dispose(); drag.outline.material.dispose();
  const { q, z } = drag, api = getFrame(q.id);
  if (!api?._setVrSize || (Math.abs(drag.w - drag.w0) < 1 && Math.abs(drag.h - drag.h0) < 1)) return null;
  const mesh = q.mesh, mpp = mesh.scale.x * 0.001;   // metres per CSS px, kept
  // the anchor corner in world, before the rebuild
  const anchorW = mesh.localToWorld(new THREE.Vector3(drag.ax, drag.ay, 0));
  // VR's OWN size: on the staged frame and saved with the panel's place below; the desktop frame's state and layout are untouched
  const cur = api._vrSize ?? { w: q.el.offsetWidth, h: Math.max(drag.info.minH, Math.round(drag.h0 - drag.chrome)) };
  const w = z.includes('e') || z.includes('w') ? Math.round(drag.w) : cur.w;
  const bh = z.includes('s') || z.includes('n') ? Math.max(drag.info.minH, Math.round(drag.h - drag.chrome)) : cur.h;
  api._setVrSize({ w, h: bh });
  // the new centre: from the anchor, half the NEW size toward the gripped side, in the quad's frame (an edge-only resize keeps the other axis)
  const fr = q.el.getBoundingClientRect(), sx = z.includes('w') ? -1 : 1, sy = z.includes('n') ? 1 : -1;
  const { width: W0, height: H0 } = mesh.geometry.parameters;
  const cx = z.includes('e') || z.includes('w') ? drag.ax + sx * fr.width * 0.0005 : 0;
  const cy = z.includes('s') || z.includes('n') ? drag.ay + sy * fr.height * 0.0005 : (H0 / 2 - fr.height * 0.0005);   // top edge stays put
  const centreW = mesh.localToWorld(new THREE.Vector3(cx, cy, 0));
  const parent = mesh.parent ?? rig; parent.updateMatrixWorld(true);
  const posLocal = parent.worldToLocal(centreW.clone());
  const _e = new THREE.Euler().setFromQuaternion(mesh.quaternion, 'YXZ');
  const place = { pos: posLocal.toArray().map((v) => +v.toFixed(3)), yaw: +_e.y.toFixed(3), pitch: +_e.x.toFixed(3), mpp: +mpp.toFixed(6), w, bh };
  savePlace(q.id, place);
  drop(q); q.aids = null; setVisible(q, true);   // rebuilt at the new size, from the saved place
  return { w: fr.width, h: fr.height, anchorWorld: anchorW.toArray(), centreWorld: centreW.toArray(), W0, H0 };
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
  if (stash) domQuadsHideToggle();   // opening one while they are hidden brings the hidden ones back first
  setVisible(q, on == null ? !q.mesh?.visible : !!on);
  shown = quads.some((x) => x.mesh?.visible);
  return !!q.mesh?.visible;
}
export const domQuadIds = () => (quads ?? []).map((q) => q.id);
export const domQuadOpen = (id) => !!quads?.find((q) => q.id === id)?.mesh?.visible;

// ---- grabbable panels: a grip on background or title (never a control) takes the quad; on release it rejoins the
// rig where it is, roll stripped and pitch clamped. Placement is kept per browser (ew-xr-quads).
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
export function domQuadsGrab(handRay) {
  const at = domQuadsAt(handRay);
  if (!at || at.control || at.zone?.startsWith('resize-')) return null;   // a control: the grip is not a grab; a resizer: it is a resize
  return quads.find((q) => q.mesh === at.mesh) ?? null;
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
