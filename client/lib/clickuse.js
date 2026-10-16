// clickuse — the mouse on things (R, 2026-10-10, first minute of the desktop test: "there's a label over the balls that
// says 'grab one', but left-clicking on them doesn't do anything"). Her rule: LEFT-CLICK is the thing's primary use
// (grab a ball, open a door, sit on a seat); RIGHT-CLICK opens a menu of everything it offers. The keys stay (T, C, E, X):
// the mouse sends the same requests they do, so the authority's refusals read the same.
//   A click is a press and release that didn't travel (a drag is the camera's orbit, either button). Not in edit mode
// (a click selects there), not in a headset, not over a person (bodydrag's capture listener takes that press first).
// The cursor is an open hand over what a click would pick up, a pointing finger over any other use.
import { THREE, camera, canvas } from './core.js';
import { outOfMyView } from './myview.js';
import { bagOf, entities, socketsOn } from './world.js';
import { contextMenu, closeContextMenu } from './panels.js';
import { flashHint } from './ui.js';
import { xrActive } from './xrask.js';
import { nameOf } from './plainwords.js';
import { bodyOf } from '../../shared/components.js';
import { physicsApi } from './thingphysics.js';
import { actionsOf, useThing } from './useprompt.js';
import { trySitOn } from './localbody.js';
import { walkTo, clampToBounds } from './controller.js';

const CLICK_TRAVEL = 5, CLICK_MS = 500, HOVER_MS = 100, NEAR = 0.15;   // px, ms: more than this and the press was a drag
let hooks = null;   // { editing(): bool, busy(): bool, myPos(): Vector3 }
export function initClickUse(h) { hooks = h; }
const off = () => !hooks || hooks.editing?.() || hooks.busy?.() || xrActive();

const isBag = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const seatOf = (id) => { for (const x of socketsOn(id)) { const b = bodyOf(x.station); if (b) return b; } return null; };   // a socket child a body may take (localbody's rule)
const canGrab = (id) => !!physicsApi.grabbable(id)?.enabled;

/** What a thing offers, most likely first: [{k, label, run}]. The first is what a left-click does. */
/** spot: where the click landed (the context menu passes it), for "put X on Y" there. */
export function offersOf(id, { spot = null } = {}) {
  // its name as its builder wrote it, no quotes: the menu draws it in the accent colour (R, 10-10)
  const L = bagOf(id)?.label, name = typeof L === 'string' && L.trim() ? L.trim().slice(0, 40) : (nameOf(id) ?? id), held = physicsApi.mine().includes(id);
  // every offer that needs me near it carries `reach`: the click walks me there first (R 10-11 23:32: "the walk-to rule
  // should probably apply to any use action"); without one the offer runs where I stand
  const near = () => physicsApi.inReach(id), out = [], add = (k, pre, post, run, reach = null) => out.push({ k, label: `${pre}${name}${post}`, parts: [pre, name, post], run, ...(reach ? { reach } : {}) });
  // from the menu a put or a throw is the plain one: at my feet, the way I face (the cursor's spot is the click and the C key)
  if (held) { add('put', 'put ', ' down', () => physicsApi.put(id)); add('throw', 'throw ', '', () => physicsApi.throw()); }
  // holding something else, on another thing: set it down on that thing where the click landed (R, 10-10: "you can't click
  // to place it down on another grabbable object ... 'Put down [held item] on [clicked-on item]' at the place that was clicked")
  const inHand = physicsApi.mine().find((h) => h !== id);
  if (!held && inHand && spot) { const H = bagOf(inHand)?.label, hn = typeof H === 'string' && H.trim() ? H.trim().slice(0, 40) : (nameOf(inHand) ?? inHand);
    out.push({ k: 'puton', label: `put ${hn} on ${name}`, parts: [`put ${hn} on `, name, ''], run: () => putAtSpot(inHand, onTop(id, spot)) }); }
  else if (canGrab(id)) add('grab', 'pick up ', '', () => physicsApi.grab(id), near);
  for (const a of actionsOf(id)) add(`use:${a.action}`, `${a.verb} `, a.barred ? ` (${a.barred})` : '', () => useThing(id, a.action, a.verb), near);
  const seat = seatOf(id);
  if (seat) add('sit', `${seat.action ?? 'sit'} on `, '', () => trySitOn(id), near);
  if (!held && bagOf(id)?.physics?.kind === 'dynamic') add('punt', 'kick ', '', () => physicsApi.punt(id), () => physicsApi.canPunt(id));
  return out;
}

const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
/** The nearest thing under the pointer that offers something: its id, or null. */
export function thingAt(clientX, clientY) {
  const lock = document.pointerLockElement === canvas, r = canvas.getBoundingClientRect();
  if (lock) ndc.set(0, 0); else ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const targets = [];
  // clickthrough (componentspec): a click passes through it to whatever is behind (R 10-11: a per-thing switch)
  const through = (id) => bagOf(id)?.clickthrough === true;
  for (const [id, o] of entities) if (o && !through(id) && (canGrab(id) || actionsOf(id).length || seatOf(id) || physicsApi.mine().includes(id))) targets.push(o);
  if (!targets.length) return null;
  // not a surface the camera is standing in (an orbit camera pulled up against a gate saw only the gate, 7 cm away)
  let root = ray.intersectObjects(targets, true).find((h) => h.distance > NEAR && !outOfMyView(h.object))?.object;
  while (root && !root.userData.entityId) root = root.parent;
  return root?.userData.entityId ?? null;
}

// A click on something to pick up that is out of reach: walk over and take it (what a click-to-use game does; R, 10-10).
// Too far to be what you meant: say so, in the status bar. A move key on the way cancels, quietly.
const WALK_MAX = 14;   // m along the floor
async function fetchIt(id, offer) {
  const reach = offer.reach ?? (() => physicsApi.inReach(id));
  if (reach()) return offer.run();
  const w = physicsApi.whereFromMe(id); if (!w) return offer.run();
  if (w.flat > WALK_MAX) { flashHint(`${nameOf(id) ?? id} is ${w.flat.toFixed(0)} m away — too far to walk over for it; go closer`, 3800, 'attn'); return null; }
  const why = await walkTo(w.at[0], w.at[2], { until: reach });
  if (why === 'arrived' && reach()) return offer.run();
  if (why === 'blocked' || why === 'timeout' || why === 'arrived') flashHint(`couldn't get to ${nameOf(id) ?? id}: something is in the way`, 3800, 'attn');
  return null;
}
/** The world point under the pointer: the nearest surface of anything placed (not what I hold), else the ground. [x, y, z] or null. */
const aimRay = new THREE.Raycaster(), aimNdc = new THREE.Vector2(), aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), aimHit = new THREE.Vector3();
let lastXY = null;
canvas.addEventListener('mousemove', (e) => { lastXY = [e.clientX, e.clientY]; });
export function aimPoint(clientX = lastXY?.[0], clientY = lastXY?.[1]) {
  const lock = document.pointerLockElement === canvas, r = canvas.getBoundingClientRect();
  if (lock) aimNdc.set(0, 0); else if (clientX == null) return null; else aimNdc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  aimRay.setFromCamera(aimNdc, camera);
  const mine = new Set(physicsApi.mine()), targets = []; for (const [id, o] of entities) if (o && !mine.has(id)) targets.push(o);
  const h = aimRay.intersectObjects(targets, true).find((x) => x.distance > NEAR);   // a thing hidden in my view still catches a put: it is solid for everyone
  const feetY = hooks?.myPos?.()?.y ?? 0; aimPlane.constant = -feetY;
  const g = aimRay.ray.intersectPlane(aimPlane, aimHit) ? aimHit.clone() : null;
  const p = h && (!g || h.distance < aimRay.ray.origin.distanceTo(g)) ? h.point : g;
  return p ? [p.x, p.y, p.z] : null;
}
/** A click on a thing's side still means on top of it: the spot pulled inside its footprint (5 cm in), at its top. */
function onTop(id, spot) {
  const o = entities.get(id); if (!o) return spot; const b = new THREE.Box3().setFromObject(o); if (b.isEmpty()) return spot;
  const c = (v, lo, hi) => (hi - lo < 0.1 ? (lo + hi) / 2 : Math.min(hi - 0.05, Math.max(lo + 0.05, v)));
  return [c(spot[0], b.min.x, b.max.x), Math.max(spot[1], b.max.y), c(spot[2], b.min.z, b.max.z)];
}
/** Holding something, a click on a spot: set it down THERE (R, 10-10: "my assumption is that my character would try to
 *  drop it where the cursor is, not right at their feet"), walking over first when it is out of reach. */
async function putAtSpot(id, spot) {
  { const [x, z] = clampToBounds(spot[0], spot[2], 0); if (x !== spot[0] || z !== spot[2]) { flashHint("that's past the edge of this world", 3200, 'attn'); return null; } }
  if (!physicsApi.canPutAt(spot[0], spot[1], spot[2])) {
    const me = hooks?.myPos?.(); const flat = me ? Math.hypot(spot[0] - me.x, spot[2] - me.z) : Infinity;
    if (flat > WALK_MAX) { flashHint(`that spot is ${flat.toFixed(0)} m away — too far to carry it over; go closer`, 3800, 'attn'); return null; }
    const why = await walkTo(spot[0], spot[2], { until: () => physicsApi.canPutAt(spot[0], spot[1], spot[2]) });
    if (why === 'cancelled') return null;
    if (!physicsApi.canPutAt(spot[0], spot[1], spot[2])) { flashHint(`couldn't get close enough to set it down there`, 3800, 'attn'); return null; }
  }
  return physicsApi.put(id, [spot[0], spot[2]]);
}
let press = null;
canvas.addEventListener('mousedown', (e) => { press = (e.button === 0 || e.button === 2) && !off() ? { x: e.clientX, y: e.clientY, t: performance.now(), b: e.button } : null; });
addEventListener('mouseup', (e) => {
  const p = press; press = null;
  if (!p || e.button !== p.b || off() || Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_TRAVEL || performance.now() - p.t > CLICK_MS) return;
  // with something in my hand, a click that lands on nothing is about IT (R, 10-10, holding the wrecking ball: "left-click
  // doesn't drop it ... How do I drop this thing??": in third person my own body hides what I hold, so there is nothing to aim at)
  const over = thingAt(e.clientX, e.clientY), heldNow = physicsApi.mine()[0];
  // holding something, a left-click that isn't on a thing to use: set it down at that spot
  if (!over && heldNow && p.b === 0) { const spot = aimPoint(e.clientX, e.clientY); void (spot ? putAtSpot(heldNow, spot) : physicsApi.put(heldNow)); return; }
  const id = over ?? heldNow; if (!id) return;
  const offers = offersOf(id); if (!offers.length) return;
  if (p.b === 0) { void (offers[0].reach ? fetchIt(id, offers[0]) : offers[0].run()); return; }
  const menu = over && heldNow ? offersOf(id, { spot: aimPoint(e.clientX, e.clientY) }) : offers;
  contextMenu(e.clientX, e.clientY, menu.map((o) => ({ k: o.k, label: o.label, parts: o.parts })), (k) => { const o = menu.find((x) => x.k === k); if (o) void (o.reach ? fetchIt(id, o) : o.run()); });
});
let hoverAt = 0, hand = '';
canvas.addEventListener('mousemove', (e) => {
  const now = performance.now(); if (now - hoverAt < HOVER_MS) return; hoverAt = now;
  // R: an open hand where a click picks up, a pointing finger for any other use
  const id = !off() && !e.buttons ? thingAt(e.clientX, e.clientY) : null, k = id ? offersOf(id)[0]?.k : null;
  const cur = !k ? '' : k === 'grab' ? 'grab' : k === 'put' ? 'grabbing' : 'pointer';
  if (cur !== hand) { hand = cur; canvas.style.cursor = cur; }
});
export const clickUseApi = { offersOf, thingAt, aimPoint, close: closeContextMenu, hint: flashHint };
