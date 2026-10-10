// clickuse — the mouse on things (R, 2026-10-10, first minute of the desktop test: "there's a label over the balls that
// says 'grab one', but left-clicking on them doesn't do anything"). Her rule: LEFT-CLICK is the thing's primary use
// (grab a ball, open a door, sit on a seat); RIGHT-CLICK opens a menu of everything it offers. The keys stay (T, C, E, X):
// the mouse sends the same requests they do, so the authority's refusals read the same.
//   A click is a press and release that didn't travel (a drag is the camera's orbit, either button). Not in edit mode
// (a click selects there), not in a headset, not over a person (bodydrag's capture listener takes that press first).
// The cursor is an open hand over what a click would pick up, a pointing finger over any other use.
import { THREE, camera, canvas } from './core.js';
import { comps, entities } from './world.js';
import { contextMenu, closeContextMenu } from './panels.js';
import { flashHint } from './ui.js';
import { xrActive } from './xrask.js';
import { nameOf } from './plainwords.js';
import { bodyOf } from '../../shared/components.js';
import { physicsApi } from './thingphysics.js';
import { actionsOf, useThing } from './useprompt.js';
import { trySitOn } from './localbody.js';

const CLICK_TRAVEL = 5, CLICK_MS = 500, HOVER_MS = 100, NEAR = 0.15;   // px, ms: more than this and the press was a drag
let hooks = null;   // { editing(): bool, busy(): bool }
export function initClickUse(h) { hooks = h; }
const off = () => !hooks || hooks.editing?.() || hooks.busy?.() || xrActive();

const isBag = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const seatOf = (id) => { const s = comps.get(id)?.sockets; if (!isBag(s)) return null; const k = Object.keys(s).find((k) => bodyOf(s[k])); return k ? bodyOf(s[k]) : null; };   // a socket a body may take (localbody's rule)
const canGrab = (id) => !!physicsApi.grabbable(id)?.enabled;

/** What a thing offers, most likely first: [{k, label, run}]. The first is what a left-click does. */
export function offersOf(id) {
  const out = [], name = nameOf(id) ?? id, held = physicsApi.mine().includes(id);
  if (held) { out.push({ k: 'put', label: `put ${name} down`, run: () => physicsApi.put(id) }, { k: 'throw', label: `throw ${name}`, run: () => physicsApi.throw() }); }
  else if (canGrab(id)) out.push({ k: 'grab', label: `pick up ${name}`, run: () => physicsApi.grab(id) });
  for (const a of actionsOf(id)) out.push({ k: `use:${a.action}`, label: `${a.verb} ${name}${a.barred ? ` (${a.barred})` : ''}`, run: () => useThing(id, a.action, a.verb) });
  const seat = seatOf(id);
  if (seat) out.push({ k: 'sit', label: `${seat.action ?? 'sit'} on ${name}`, run: () => trySitOn(id) });
  if (!held && comps.get(id)?.physics?.kind === 'dynamic') out.push({ k: 'punt', label: `kick ${name}`, run: () => physicsApi.punt(id) });
  return out;
}

const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
/** The nearest thing under the pointer that offers something: its id, or null. */
export function thingAt(clientX, clientY) {
  const lock = document.pointerLockElement === canvas, r = canvas.getBoundingClientRect();
  if (lock) ndc.set(0, 0); else ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const targets = [];
  for (const [id, o] of entities) if (o && (canGrab(id) || actionsOf(id).length || seatOf(id) || physicsApi.mine().includes(id))) targets.push(o);
  if (!targets.length) return null;
  // not a surface the camera is standing in (an orbit camera pulled up against a gate saw only the gate, 7 cm away)
  let root = ray.intersectObjects(targets, true).find((h) => h.distance > NEAR)?.object;
  while (root && !root.userData.entityId) root = root.parent;
  return root?.userData.entityId ?? null;
}

let press = null;
canvas.addEventListener('mousedown', (e) => { press = (e.button === 0 || e.button === 2) && !off() ? { x: e.clientX, y: e.clientY, t: performance.now(), b: e.button } : null; });
addEventListener('mouseup', (e) => {
  const p = press; press = null;
  if (!p || e.button !== p.b || off() || Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_TRAVEL || performance.now() - p.t > CLICK_MS) return;
  const id = thingAt(e.clientX, e.clientY); if (!id) return;
  const offers = offersOf(id); if (!offers.length) return;
  if (p.b === 0) { void offers[0].run(); return; }
  contextMenu(e.clientX, e.clientY, offers.map((o) => ({ k: o.k, label: o.label })), (k) => { void offers.find((o) => o.k === k)?.run(); });
});
let hoverAt = 0, hand = '';
canvas.addEventListener('mousemove', (e) => {
  const now = performance.now(); if (now - hoverAt < HOVER_MS) return; hoverAt = now;
  // R: an open hand where a click picks up, a pointing finger for any other use
  const id = !off() && !e.buttons ? thingAt(e.clientX, e.clientY) : null, k = id ? offersOf(id)[0]?.k : null;
  const cur = !k ? '' : k === 'grab' ? 'grab' : k === 'put' ? 'grabbing' : 'pointer';
  if (cur !== hand) { hand = cur; canvas.style.cursor = cur; }
});
export const clickUseApi = { offersOf, thingAt, close: closeContextMenu, hint: flashHint };
