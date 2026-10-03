// platecard — two quiet things beside a person's nameplate (owner, 09-30, about a mockup that put mic/ear marks ON the
// plate: "it looks messy. Maybe anyone muted near you can pop up a grayed out ear *next* to their name plate? Oh, or
// maybe hovering your cursor on their nameplate can pop that info beside their nameplate? … a little like an in-world
// tooltip").
//
// VOICE STATE IS HOVER-ONLY (owner, 10-02: "I'd go for hover only"). An earlier pass put grey crossed headphones
// beside the plate of anyone nearby with hearing off. The headphone toggle gates VOICE only (mic and TTS; world sound
// is a separate slider), so that mark only mattered to someone speaking aloud and was noise to everyone typing; it
// is gone. Mic and hearing live in the card below, in words. A client too old to say leaves them undefined and the
// card reads "not shared" — unknown is not "headphones off".
//
// THE CARD: rest the pointer on a nameplate (or the head under it) for HOVER_MS and a small card opens beside the
// plate — name, presence, mic and hearing in words, distance / VR / agent, and the one per-person action the people
// column already offers (message → the DM tab, chat.js openConvo). It is DOM, projected to the plate each frame:
// crisp text at any distance, the house tokens and buttons for free, focusable, and it follows the plate while open.
// (A sprite would need its own text rendering, its own hit-testing for the button and a repaint per state change.)
// On a touch screen a TAP on a plate opens the same card; a tap elsewhere closes it. Esc closes it and goes no
// further (frames.js's Esc toggle yields to the claim). Leaving plate and card closes a hover-opened card.
// VR (owner, 10-02: "VR has no hover — … you can still laser-point at someone's label"): a hand's laser RESTING on a
// plate (or the head under it) is the hover. xr.js asks platePick once no panel has claimed the laser and reports what it
// found with aimPlate; the same timer opens the same card. The card is the SAME DOM, moved offscreen and rasterised onto
// a quad by the vendored HTMLMesh, the way domquad.js puts the real frames in the headset (one set of panels to
// maintain), with the panels' colour handling (prepareQuadMaterial). It floats beside the plate at the plate's own
// depth, upright, facing you, sized to a constant angle — at any distance it reads as a panel does at arm's length.
// The "message" button is left out in VR: it opens the DM tab, a desktop surface (index.html #platecard[data-xr]).
// The trigger on a plate does nothing new.
import * as THREE from 'three';
import { claimEscape } from './frames.js';
import { svg, fsvg } from './icons.js';
import { HTMLMesh } from './vendor/htmlmesh.js';
import { prepareQuadMaterial } from './domquad.js';

export const HOVER_MS = 300;       // rest this long on a plate before the card opens
const LEAVE_MS = 250;              // grace to travel from plate to card
const HEAD_R = 0.14;               // metres: the head under the plate counts as the plate
// VR: a CSS px of the card subtends this many radians, whatever the plate's distance — the narrowest VR panel's (342 px
// across 0.58 m at arm's length, 0.85 m: domquad.js); wider panels draw their px up to ~1.6× smaller, and the card's text
// is 12 px. Rasterised at XR_RASTER device px per CSS px.
const XR_RAD_PER_PX = 0.002, XR_RASTER = 2.5, XR_GAP_PX = 10;
const PICK_SLACK_M = 0.03;         // VR: the laser's slack around the pill (the desktop gives the cursor 3–4 px): a hand trembles

let d = null;                      // injected: { camera, canvas, scene, remotes, myPos, presenting, openConvo, colorFor }
let card = null, cardFor = null, openedBy = null, sig = '';
let ptr = null;                    // { x, y } in client px while a mouse is over the canvas, else null
let hoverId = null, hoverSince = 0, leftAt = 0;
let dismissed = null, dismissOff = 0;              // a card closed by hand (Esc, tap-out, its action) stays closed until the pointer leaves that plate
const _v = new THREE.Vector3(), _h = new THREE.Vector3();
let vr = false;                                    // presenting: the laser is the pointer, the card is a quad
let xrMesh = null, xrBuilt = null;                 // the card's quad and the CSS size it was built at (HTMLMesh fixes its geometry)
const xrAim = { left: null, right: null };         // the plate id under each hand's laser, as xr.js last reported it
let openedAt = 0;                                  // for probes: when the open card opened

export function initPlates(deps) {
  d = deps;
  card = document.createElement('div');
  card.id = 'platecard'; card.className = 'panel'; card.hidden = true;
  card.setAttribute('role', 'dialog');
  document.body.append(card);
  card.addEventListener('click', (e) => {
    const b = e.target.closest?.('button[data-act]');
    if (!b || !cardFor) return;
    if (b.dataset.act === 'dm') { const who = cardFor; close(); d.openConvo?.(who); }
  });
  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    ptr = e.target === d.canvas && !document.pointerLockElement ? { x: e.clientX, y: e.clientY } : null;
    if (card.contains(e.target)) leftAt = 0;
  }, { passive: true });
  document.addEventListener('pointerleave', () => { ptr = null; });
  // a TAP (touch/pen: short, still) on a plate opens its card; anywhere else but the card closes it
  let down = null;
  addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    down = { x: e.clientX, y: e.clientY, t: e.timeStamp, onCanvas: e.target === d.canvas };   // event time: a slow frame between down and up is not a long press
    // outside the card: close — unless it lands on a plate, whose tap (pointerup) re-aims the card instead
    if (!card.hidden && !card.contains(e.target) && !(down.onCanvas && hitAt(e.clientX, e.clientY))) close();
  }, { passive: true, capture: true });
  addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse' || !down) return;
    const tap = down.onCanvas && e.timeStamp - down.t < 350 && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 12;
    down = null;
    if (!tap) return;
    const id = hitAt(e.clientX, e.clientY);
    if (id) open(id, 'tap');
  }, { passive: true });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !card.hidden) { e.preventDefault(); close(); }
  });
  claimEscape(() => (card.hidden ? null : 'platecard'));
}

/** Per frame (main.js registers it after gaze): the hover timer, the open card's place. */
export function updatePlates(now = performance.now()) {
  if (!d) return;
  if (d.presenting()) { updatePlatesXR(now); return; }
  if (vr) leaveXR();
  const over = ptr ? hitAt(ptr.x, ptr.y) : null;
  hoverStep(over, onDomCard, now);
  if (!card.hidden) follow();
}
const onDomCard = () => card.matches(':hover'), onNoCard = () => false;

// hover: the same plate for HOVER_MS opens it; leaving plate AND card closes a hover-opened card. `over` is the plate
// under the pointer (desktop) or under a laser (VR); onCard() says whether the pointer is on the card itself.
function hoverStep(over, onCard, now) {
  if (over !== hoverId) { hoverId = over; hoverSince = now; }
  // a dismissal ends only once the pointer has been OFF that plate for a moment: a plate is a thin target, and a
  // one-frame miss (the camera breathing a few px) must not re-arm the card under a resting pointer
  if (dismissed && over === dismissed) dismissOff = 0;
  else if (dismissed && !dismissOff) dismissOff = now;
  else if (dismissed && now - dismissOff >= LEAVE_MS) { dismissed = null; dismissOff = 0; }
  if (over && over !== cardFor && over !== dismissed && now - hoverSince >= HOVER_MS && openedBy !== 'tap') open(over, 'hover');
  if (!card.hidden && openedBy === 'hover') {
    if (over === cardFor || onCard()) leftAt = 0;
    else if (!leftAt) leftAt = now;
    else if (now - leftAt >= LEAVE_MS) close();
  }
}

// ---- VR: the laser is the pointer ------------------------------------------------------------------------------
function updatePlatesXR(now) {
  if (!vr) enterXR();
  // either hand: one already on the open card's person keeps it; otherwise the right hand leads
  const L = xrAim.left, R = xrAim.right;
  xrAim.left = xrAim.right = null;   // xr.js re-reports every frame its pointer loop runs; a frame it doesn't, nothing is aimed at
  const over = cardFor && (L === cardFor || R === cardFor) ? cardFor : (R ?? L);
  hoverStep(over, onNoCard, now);    // the card's own quad is part of platePick's answer (it returns cardFor)
  if (!card.hidden) followXR();
}
function enterXR() {
  close(); vr = true; hoverId = null; dismissed = null; dismissOff = 0;
  card.dataset.xr = '';                                         // VR styling: opaque, no blur or fade-in, no message button
  card.style.left = '-100000px'; card.style.top = '0px';        // laid out but off the desktop mirror (HTMLMesh measures, never hit-tests)
}
function leaveXR() {
  close(); vr = false; hoverId = null; dismissed = null; dismissOff = 0; xrAim.left = xrAim.right = null;
  dropXRMesh();
  delete card.dataset.xr;
}
function dropXRMesh() { if (!xrMesh) return; xrMesh.removeFromParent(); xrMesh.dispose(); xrMesh = null; xrBuilt = null; }
function buildXRMesh(w, h) {
  dropXRMesh();
  const m = new HTMLMesh(card, { scale: XR_RASTER });
  m.material.transparent = false; m.material.alphaTest = 0.5;   // the panels' recipe: opaque pass, rounded corners cut out
  prepareQuadMaterial(m);                                       // the authored colour after the ACES output pass (quadcolour.js)
  m.name = 'platecard'; m.userData.noCamCollide = true;
  d.scene.add(m);
  xrMesh = m; xrBuilt = [w, h];
}
const _e = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _s = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
// beside the plate, at its depth (so the two sit together in stereo), right of the pill, upright, facing the eye
function followXR() {
  const r = d.remotes.get(cardFor), lab = r?.avatar?.label;
  if (!lab?.visible || lab.material.opacity < 0.1) { close(); return; }
  paint();
  const w = card.offsetWidth, h = card.offsetHeight;
  if (!w || !h) return;
  if (!xrMesh || xrBuilt[0] !== w || xrBuilt[1] !== h) buildXRMesh(w, h);
  if (!xrMesh.visible) { xrMesh.visible = true; xrMesh.material.map.resume?.(); }
  d.camera.getWorldPosition(_e); lab.getWorldPosition(_v);
  _f.subVectors(_v, _e);
  const dist = _f.length();
  _r.crossVectors(_f, UP);
  if (_r.lengthSq() < 1e-8 || dist < 1e-3) return;   // straight above or below the eye: keep last frame's place
  _r.normalize();
  const s = XR_RAD_PER_PX * dist;                    // metres per CSS px
  lab.getWorldScale(_s);
  const hw = _s.x * (lab.userData.pill ?? 0.5) / 2;
  xrMesh.position.copy(_v).addScaledVector(_r, hw + (XR_GAP_PX + w / 2) * s);
  xrMesh.scale.setScalar(s * 1000);                  // HTMLMesh geometry is CSS px × 1 mm
  xrMesh.lookAt(_e);
}

/** VR (xr.js, per hand, once no panel claimed the laser): what the laser rests on — a plate's pill, the head under it,
 *  or the open card — as { id, dist }, or null. `cam` is the XR camera: plates are sprites, and a sprite faces a camera. */
const _rc = new THREE.Raycaster(), _rm = new THREE.Matrix4(), _hits = [];
export function platePick(handRay, cam, far = 40) {
  if (!d || !vr) return null;
  _rm.extractRotation(handRay.matrixWorld);
  _rc.ray.origin.setFromMatrixPosition(handRay.matrixWorld);
  _rc.ray.direction.set(0, 0, -1).applyMatrix4(_rm);
  _rc.near = 0; _rc.far = far; _rc.camera = cam;
  let best = null, bestD = Infinity;
  if (xrMesh?.visible && cardFor) {
    _hits.length = 0; xrMesh.raycast(_rc, _hits);
    for (const h of _hits) if (h.distance < bestD) { best = cardFor; bestD = h.distance; }
  }
  for (const r of d.remotes.values()) {
    const av = r.avatar, lab = av?.label;
    // what the desktop hit test skips, this skips: a plate not drawn, faded out, or behind a wall (its occlusion query)
    if (!lab?.visible || lab.material.opacity < 0.1 || lab.userData.occluded) continue;
    _hits.length = 0; lab.raycast(_rc, _hits);
    const h = _hits[0];
    if (h?.uv && h.distance < bestD) {
      // the sprite is the whole canvas; the plate is the pill centred in it
      lab.getWorldScale(_s);
      const hu = (lab.userData.pill ?? 0.5) / 2 + PICK_SLACK_M / _s.x;
      const hv = (lab.userData.pillH ?? 52 / 512) / (lab.userData.aspect ?? 64 / 512) / 2 + PICK_SLACK_M / _s.y;
      if (Math.abs(h.uv.x - 0.5) <= hu && Math.abs(h.uv.y - 0.5) <= hv) { best = r.id; bestD = h.distance; }
    }
    if (av.head) {   // the head under the plate counts as the plate
      av.head.getWorldPosition(_v);
      const t = _h.subVectors(_v, _rc.ray.origin).dot(_rc.ray.direction);
      if (t > 0 && t < far && t < bestD && _rc.ray.distanceSqToPoint(_v) <= HEAD_R * HEAD_R) { best = r.id; bestD = t; }
    }
  }
  return best ? { id: best, dist: bestD } : null;
}
/** VR: xr.js reports, per hand per frame, the plate its laser rests on (null: none). */
export function aimPlate(side, id) { if (side === 'left' || side === 'right') xrAim[side] = id ?? null; }

// ---- where a plate is on screen ------------------------------------------------------------------------------
// The plate is a camera-facing sprite: its screen rect is its world anchor projected, sized by pixels-per-metre at
// its view depth. Returns null when it is not drawn (faded out, hidden, behind the camera).
function plateRect(av, box) {
  const lab = av?.label;
  if (!lab?.visible || lab.material.opacity < 0.1) return null;
  const cam = d.camera, W = d.canvas.clientWidth, H = d.canvas.clientHeight;
  lab.getWorldPosition(_v);
  _h.copy(_v).applyMatrix4(cam.matrixWorldInverse);
  const depth = -_h.z;
  if (depth <= cam.near) return null;
  const ppm = (H / 2) / (Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * depth);
  _v.project(cam);
  const cx = box.left + (_v.x + 1) / 2 * W, cy = box.top + (1 - _v.y) / 2 * H;
  const lw = lab.scale.x;
  const hw = lw * (lab.userData.pill ?? 0.5) / 2 * ppm, hh = lw * (lab.userData.pillH ?? 52 / 512) / 2 * ppm;
  let head = null;
  if (av.head) {
    av.head.getWorldPosition(_v);
    _h.copy(_v).applyMatrix4(cam.matrixWorldInverse);
    if (-_h.z > cam.near) { _v.project(cam); head = _rectHead; head.x = box.left + (_v.x + 1) / 2 * W; head.y = box.top + (1 - _v.y) / 2 * H; head.r = HEAD_R * ppm; }
  }
  const o = _rect;
  o.l = cx - hw; o.r = cx + hw; o.t = cy - hh; o.b = cy + hh; o.cx = cx; o.cy = cy; o.depth = depth; o.head = head;
  return o;
}
// plateRect's answer, reused: it runs per remote on every pointer move and every frame the card follows, and every
// caller reads it before the next call
const _rect = { l: 0, r: 0, t: 0, b: 0, cx: 0, cy: 0, depth: 0, head: null }, _rectHead = { x: 0, y: 0, r: 0 };

function hitAt(x, y) {
  let best = null, bestDepth = Infinity;
  const box = d.canvas.getBoundingClientRect();
  for (const r of d.remotes.values()) {
    // a plate a wall hides (its last draw failed the depth test, avatar.js noteOccluded) opens nothing, nor does the head under it
    const p = r.avatar?.label?.userData.occluded ? null : plateRect(r.avatar, box);
    if (!p) continue;
    const onPlate = x >= p.l - 3 && x <= p.r + 3 && y >= p.t - 4 && y <= p.b + 4;   // a little slack: the plate is thin
    const onHead = p.head && Math.hypot(x - p.head.x, y - p.head.y) <= p.head.r;
    if ((onPlate || onHead) && p.depth < bestDepth) { best = r.id; bestDepth = p.depth; }
  }
  return best;
}

// ---- the card --------------------------------------------------------------------------------------------------
function open(id, how) {
  if (!d.remotes.get(id)) return;
  cardFor = id; openedBy = how; leftAt = 0; sig = ''; openedAt = performance.now();
  card.hidden = false;
  card.dataset.for = id;
  paint();
  if (vr) followXR(); else follow();
}
export function close() {
  if (!card || card.hidden) return;
  dismissed = cardFor; dismissOff = 0;
  card.hidden = true; cardFor = null; openedBy = null; sig = '';
  delete card.dataset.for;
  if (xrMesh?.visible) { xrMesh.visible = false; xrMesh.material.map.pause?.(); }
}

const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function paint() {
  const r = d.remotes.get(cardFor);
  if (!r) return;
  const me = d.myPos();
  const dist = me && r.avatar?.root ? r.avatar.root.position.distanceTo(me) : null;
  const pres = r.presence ?? 'present';
  const known = typeof r.mic === 'boolean' || typeof r.hear === 'boolean';
  const s = [pres, r.mic, r.hear, dist == null ? '' : Math.round(dist), !!r.xrOn, !!r.agent].join('|');
  if (s === sig) return;
  sig = s;
  const rows = [];
  if (known) {
    rows.push(`<div class="pc-row" data-k="mic" data-on="${r.mic === true}">${svg(r.mic === true ? 'mic' : 'micOff', 14)}<span>${
      r.mic === true ? 'mic on' : r.mic === false ? 'mic off' : 'mic: not shared'}</span></div>`);
    rows.push(`<div class="pc-row" data-k="hear" data-on="${r.hear === true}">${svg(r.hear === false ? 'headphonesOff' : 'headphones', 14)}<span>${
      r.hear === true ? 'headphones on' : r.hear === false ? 'headphones off' : 'headphones: not shared'}</span></div>`);
  } else {
    rows.push(`<div class="pc-row" data-k="voice"><span>voice state not shared</span></div>`);
  }
  // the visor (owner, 10-02: "we should probably include the VR visor icon") — the HUD's own VR glyph
  rows.push(`<div class="pc-row" data-k="xr" data-on="${!!r.xrOn}">${fsvg('virtual-reality', 14)}<span>${r.xrOn ? 'in VR' : 'not in VR'}</span></div>`);
  // the header's right end: what kind of body and how far — 'present' is the default and says nothing, so only away /
  // busy are named, in their presence colour, after the name
  const where = [r.agent ? 'agent' : null,
    dist == null ? null : `${dist < 10 ? dist.toFixed(1) : Math.round(dist)} m`].filter(Boolean).join(' · ');
  card.innerHTML = `<div class="pc-head"><span class="pc-dot" style="background:${esc(d.colorFor?.(r.id) ?? 'var(--brand)')}"></span>`
    + `<b class="pc-name">${esc(r.id)}</b>`
    + (pres !== 'present' ? `<span class="pc-pres" data-presence="${esc(pres)}">${esc(pres)}</span>` : '')
    + (where ? `<span class="pc-where">${esc(where)}</span>` : '') + `</div>`
    + rows.join('')
    + `<div class="pc-btns"><button type="button" data-act="dm">message</button></div>`;
  card.setAttribute('aria-label', `${r.id} — voice and actions`);
}

function follow() {
  const r = d.remotes.get(cardFor);
  const p = r && plateRect(r.avatar, d.canvas.getBoundingClientRect());
  if (!p) { close(); return; }
  paint();
  const W = innerWidth, H = innerHeight, M = 8, GAP = 10;
  const cw = card.offsetWidth, ch = card.offsetHeight;
  let x, y = p.cy - ch / 2, side;
  if (p.r + GAP + cw <= W - M) { x = p.r + GAP; side = 'right'; }
  else if (p.l - GAP - cw >= M) { x = p.l - GAP - cw; side = 'left'; }
  else {   // a phone: neither side has room — under the plate, centred on it
    x = Math.min(Math.max(M, p.cx - cw / 2), W - M - cw);
    y = p.b + GAP; side = 'below';
  }
  y = Math.min(Math.max(M, y), H - M - ch);
  card.style.left = `${Math.round(x)}px`;
  card.style.top = `${Math.round(y)}px`;
  card.dataset.side = side;
}

/** For probes: where the card is and for whom, without reaching into module state. */
export const plateCardState = () => ({ open: !!card && !card.hidden, for: cardFor, by: openedBy, vr, hoverId, hoverSince, openedAt,
  aim: { ...xrAim }, mesh: xrMesh && { visible: xrMesh.visible, inScene: !!xrMesh.parent, built: xrBuilt } });
/** For probes: the card's quad (VR), or null. */
export const plateCardMesh = () => xrMesh;
