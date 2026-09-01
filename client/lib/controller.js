// controller — input to embodiment. Owns my body's state, my camera, and the
// keyboard/mouse/touch surface that drives both.
//
// The camera is the thing most people judge a 3D client by in the first ten
// seconds, so it gets: collision (no more seeing through hillsides), a
// shoulder offset (your own body stops occluding what you're aiming at), and
// a continuous zoom that passes through into first person.

import { THREE, camera, canvas, CONFIG, angleDelta, bus } from './core.js';
import { heightAt } from './terrain.js';
import { resolveColliders, lastBlockedTop, findSeat, raySegment } from './colliders.js';
import { chat } from './chat.js';
import { isOverlayOpen, flashHint } from './ui.js';
import {
  resolveFirstPersonAnchor, FP_FORWARD, FP_EYE_LIFT, FP_GAZE_AHEAD, FP_GAZE_DROP,
} from './fp_view.js';

// ---------------------------------------------------------------- flight
// Janus: "would it be possible to add the ability for me to also fly through
// the client ... controls like the flightbench". Yes, and it is the SAME
// integrator an agent flies -- shared/flight.js, one function, every runtime.
// A human and an agent in the same sky must be flying the same physics or the
// bench proves nothing about the world.
//
// Default OFF and gated: F toggles it, and only when the capability provider
// grants this body a rig. A commons avatar with no wings gets nothing.
import {
  makeConfig as flightConfig, initialState as flightState, step as flightStep,
  takeOff as flightTakeOff, bestGlide,
} from '../../shared/flight.js';
import { pilotInput } from '../../shared/flightpilot.js';
import { devFlightProvider, resolveFlight } from '../../shared/flightcap.js';

let flight = null, flightCfg = null, flightProv = null;
let lastFlightEnd = null;   // why the last flight ended -- 'F did nothing' has causes
let flightBones = null;

/** Called once the body is known; without a compatible rig F does nothing. */
export function armFlight(boneNames, identity = 'me') {
  flightBones = boneNames ?? [];
  flightProv = devFlightProvider({ allow: [identity], label: 'client-dev' });
  return resolveFlight(flightProv, { identity, avatar: { boneNames: flightBones } }).enabled;
}

// THE SAME FLOOR WALKING STANDS ON. Flight was handed raw `heightAt` while
// take-off measured `resolveColliders` -- two different answers for "where is
// the ground", differing by the whole height of every deck, slab and structure
// floor in the world. A flier launched from the resolved floor and then tested
// against bare terrain is airborne by one measure and buried by the other.
//
// The scratch vector is load-bearing twice over: resolveColliders MUTATES the
// x/z it is given (wall push-out) and resets the module's `blockedTop`, so
// probing with the live body would shove the flier sideways and steal the
// mantle probe the walk path reads on the same frame.
const _gp = new THREE.Vector3();
function groundUnder(pos) {
  _gp.set(pos.x, pos.y, pos.z);
  const g = resolveColliders(_gp, heightAt);
  return g;
}
/** groundY(x, z) for the integrator: it has no y to offer, so probe from the
 *  flier's own altitude -- which is what decides whether a box is floor or
 *  wall, and the reason this is not a two-argument terrain lookup. */
function flightGround(x, z) {
  _gp.set(x, flight?.pos?.y ?? myState.pos.y, z);
  return resolveColliders(_gp, heightAt);
}

export const flying = () => !!flight;

/** WHY FLIGHT IS DOING THAT, in words, for a person with no devtools open.
 *
 *  The __flightDebug probe below is the same information, and it was useless
 *  twice running: a browser console is not where the person who hits the bug
 *  is standing, and every report that reached me was a DESCRIPTION ("it jumps
 *  and lands", "I'm stuck standing") that I then spent a session translating
 *  back into state. /audio exists for the same reason and says so: "a
 *  diagnostic nobody can find is one nobody uses". */
export function flightReport() {
  const v = flightProv
    ? resolveFlight(flightProv, { identity: 'me', avatar: { boneNames: flightBones } })
    : { enabled: false, reason: 'flight not armed for this body' };
  const L = [];
  L.push(`rig: ${flightBones?.length ?? 0} bones, ` +
         (v.enabled ? `granted (${v.profile.wingCount} wing bones)` : `DENIED — ${v.reason}`));
  if (flight) {
    L.push(`state: ${flight.phase} · t=${flight.t.toFixed(1)}s · ` +
           `y=${flight.pos.y.toFixed(2)} (ground ${flightGround(flight.pos.x, flight.pos.z).toFixed(2)})`);
    L.push(`speed: ${flight.airspeed.toFixed(1)} m/s air · vy=${flight.vel.y.toFixed(2)} · ` +
           `wings ${flight.wings} · stamina ${Math.round(flight.stamina)}`);
    // The freeze that started this: a phase that integrates nothing while
    // still holding the body. If it is ever seen again, it names itself.
    if (flight.phase === 'GROUND') L.push('!! GROUND while held — this is the freeze bug; press F');
  } else {
    L.push('state: not flying' + (lastFlightEnd
      ? ` · last flight ended ${lastFlightEnd.phase} at t=${lastFlightEnd.t}s, ` +
        `y=${lastFlightEnd.y} over ground ${lastFlightEnd.ground}`
      : ' · no flight this session'));
  }
  return L.join('\n');
}
// A probe, because "F did nothing" has three possible causes and they need
// telling apart: no provider, a rig the provider refuses, or a toggle that
// ran and then the movement loop overwrote it.
if (typeof globalThis !== 'undefined') {
  globalThis.__flightDebug = () => ({
    armed: !!flightProv, bones: flightBones?.length ?? 0,
    flying: !!flight, phase: flight?.phase ?? null,
    y: flight?.pos?.y ?? myState.pos.y,
    vy: flight?.vel?.y ?? null,
    launchNow: flight?.launchNow ?? null,
    groundHere: (() => { try { return heightAt(myState.pos.x, myState.pos.z); } catch { return null; } })(),
    lastEnd: lastFlightEnd,
    verdict: flightProv
      ? resolveFlight(flightProv, { identity: 'me', avatar: { boneNames: flightBones } })
      : 'no provider',
  });
}

function toggleFlight() {
  if (flight) { flight = null; return 'landed'; }
  if (!flightProv) return 'flight not armed for this body';
  const r = resolveFlight(flightProv, { identity: 'me', avatar: { boneNames: flightBones } });
  if (!r.enabled) return `no: ${r.reason}`;
  flightCfg ??= flightConfig();
  // ARM IT IN A LOCAL, PUBLISH IT ONCE. The first cut assigned the GROUND state
  // to `flight` and then reassigned the result of takeOff on the next line --
  // so anything that threw in between (or any refusal takeOff returned) left
  // `flight` holding a body that had never left the ground. That state is
  // TRUTHY, so the movement loop handed it the body, `stepGround` integrated
  // nothing, and the person was frozen in whatever clip they were wearing until
  // they pressed F again. "Stuck standing or walking depending on which one I
  // was doing at the time."
  //
  // A toggle either flies or it does not. Nothing observes a partial one.
  let next;
  try {
    next = flightState({
      phase: 'GROUND',
      pos: { x: myState.pos.x, y: myState.pos.y, z: myState.pos.z },
      // the world's yaw convention is atan2(dx,dz); the integrator's is
      // atan2(dz,dx). Convert, both ways, at this boundary only.
      yaw: Math.PI / 2 - myState.yaw,
    }, flightCfg);
    // THE GROUND UNDER HER FEET, resolved the way walking resolves it. Passing
    // `myState.pos.y` -- where she IS -- is the same number only while she is
    // standing still on flat ground; mid-jump or a frame after a step-up it is
    // metres off, and takeOff builds its launch height from it.
    next = flightTakeOff(flightCfg, next, { groundY: groundUnder(myState.pos) });
  } catch (e) {
    return `flight failed to start: ${e?.message ?? e}`;
  }
  // A REFUSAL IS NOT A TAKE-OFF. takeOff returns a state with a `takeoff.refused`
  // event rather than throwing, and the phase it returns is the phase it was
  // given -- which is the other way the body ended up frozen on the ground
  // holding the controls.
  if (next.phase !== 'PILOT') {
    const why = next.events?.find(ev => ev.kind === 'takeoff.refused')?.reason ?? next.phase;
    return `cannot take off: ${why}`;
  }
  flight = next;
  return 'flying — W/S pitch, A/D bank, Shift spoil, Space flap, F to land';
}

export const myState = {
  pos: new THREE.Vector3(0, 0, 0),
  yaw: 0,
  pitch: 0,          // head pitch, mirrored from the camera
  speed: 0,
  clip: 'idle',
  emote: null,       // one-shot, cleared after it's been sent once
  pose: undefined,   // held custom bone override (null clears); presence only
  seat: null,        // { id, chair } while seated on something
};

export const keys = new Set();
let posture = null;              // 'sit' | 'lie' | null
let vy = 0, grounded = true, mantle = null, airborneFor = 0;

// camera
export let camYaw = 0, camPitch = 0.32, camDist = 4.2;
let dragging = false, dragBtn = 0;
export const mouse = new THREE.Vector2();
export let firstPerson = false;
export let photoMode = false;

const MOVE_KEYS = {
  fwd: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
};
const held = (list) => list.some((k) => keys.has(k));

// A hook the build module sets while a ghost or a drag owns the pointer, so
// the controller doesn't also spin the camera.
let pointerClaimed = () => false;
export function setPointerClaim(fn) { pointerClaimed = fn; }

// ---------------------------------------------------------------- keyboard

const typing = () => document.activeElement?.tagName === 'INPUT'
  || document.activeElement?.tagName === 'TEXTAREA';

addEventListener('keydown', (e) => {
  if (typing() || isOverlayOpen()) return;
  if (e.key === 'Enter') { chat.open(); e.preventDefault(); return; }
  if (e.code === 'Space') e.preventDefault();      // space scrolls the page otherwise
  keys.add(e.code);
  bus.emit('key', e);
});
addEventListener('keyup', (e) => keys.delete(e.code));
// A held key with the window unfocused stays "down" forever — clear on blur.
addEventListener('blur', () => keys.clear());

bus.on('key', (e) => {
  // AUTOREPEAT IS NOT A SECOND PRESS. A held key re-fires keydown at the OS
  // repeat rate (~30Hz after a ~500ms delay) and every binding here is a
  // TOGGLE, so holding F for two thirds of a second took off and landed and
  // took off and landed -- which is exactly what "switching into flying mode
  // just makes my character jump and land immediately" looks like from the
  // outside, and why it reproduced for a person and never for a scripted
  // probe that synthesises one clean keydown.
  //
  // Guarded HERE and not on the emit, because the repeat is wanted elsewhere:
  // build.js binds R/F and the arrows to nudge/raise/turn, where holding the
  // key to keep moving a thing is the whole interaction.
  if (e.repeat) return;
  if (e.code === 'KeyX') toggleSit();
  if (e.code === 'KeyF') { const m = toggleFlight(); if (m) flashHint?.(m); }
  if (e.code === 'KeyZ') { posture = posture === 'lie' ? null : 'lie'; myState.seat = null; }
});

// Declared seats (the `sockets` component — mount verb, rides motion) live in
// main.js with the rest of the world vocabulary; the controller only knows
// postures. main.js registers a hook so X reaches BOTH systems: sockets get
// first claim (a swing that carries you beats sitting frozen mid-air where
// its collider used to be), and a mounted body's X means "get up". Returns
// true when the hook consumed the press. Same probe pattern as build.js.
let seatHook = () => false;
export function setSeatHook(fn) { seatHook = fn; }

function toggleSit() {
  if (seatHook()) return;
  if (posture === 'sit') { posture = null; myState.seat = null; return; }
  // Layer-0: if there's a real seat pan within reach, sit ON it. The geometry
  // is the affordance — a scanned stool is sittable the moment it arrives.
  const seat = findSeat(myState.pos);
  if (seat) {
    myState.pos.set(seat.x, seat.y, seat.z);
    myState.yaw = seat.yaw;
    myState.seat = { id: seat.id, chair: true };
    grounded = true; vy = 0;
    flashHint('seated — <kbd>X</kbd> to stand');
  } else {
    myState.seat = null;
  }
  posture = 'sit';
}

// ---------------------------------------------------------------- mouse
// Everything here is gated on the event actually being on the canvas. It used
// to be bound to the window with no target check, so dragging a sky slider
// spun the camera and scrolling the palette dollied it.

canvas.addEventListener('mousedown', (e) => {
  if (pointerClaimed()) return;
  // In edit mode a left-drag belongs to the object under it; look with the
  // right button (or leave edit mode). Outside it, either button looks.
  if (e.button === 2 || (e.button === 0 && !editingNow())) { dragging = true; dragBtn = e.button; }
});
// set by build.js so the controller doesn't have to import it (build imports us)
let editingNow = () => false;
export function setEditingProbe(fn) { editingNow = fn; }
addEventListener('mouseup', () => { dragging = false; });
// ---- mouselook --------------------------------------------------------------
// The desktop-game standard (VRChat, WoW): the canvas captures the pointer,
// looking is free, Esc hands the cursor back. Drag-orbit stays untouched as
// the fallback and the edit-mode behavior — a mode this module already has,
// because looking-vs-editing was settled the same way in build.js.
// While locked the cursor is parked, so `mouse` pins to (0,0): hover and
// picking read the screen centre — crosshair semantics — instead of wherever
// the pointer happened to die.
let locked = false, lockHinted = false;
export const isMouselook = () => locked;

// MOUSELOOK: M toggles, Esc frees. Two keys, one behaviour each.
//
//   M     toggle: locked <-> free, both directions. Bare M only — modified
//         presses belong to the browser and the OS (Ctrl+M etc).
//   Esc   always frees the cursor. One-way by browser law: every engine
//         hardcodes Esc to RELEASE a pointer lock and refuses to let a page
//         grant one from it, because that is exactly how a hostile page would
//         trap a cursor. So Esc can never be the way back IN — hence M.
//
// M rather than C: M is the name of the mode and matches Second Life's
// binding, while Ctrl+C is the most-pressed shortcut on any machine and a
// guard regression there would bite someone mid-copy.
//
// Clicking the world does NOT enter mouselook. It used to, and that made
// cursor mode nearly unusable — every click on anything dropped you back into
// capture, so you could never interact freely.
//
// While locked the cursor is parked, so `mouse` pins to (0,0): hover and
// picking read the screen centre — crosshair semantics — instead of wherever
// the pointer happened to die.

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  if (locked) {
    mouse.set(0, 0);
    if (!lockHinted) { flashHint('mouselook — <kbd>M</kbd> toggles · <kbd>Esc</kbd> frees the cursor'); lockHinted = true; }
  }
});
bus.on('edit-mode', (on) => { if (on && locked) document.exitPointerLock(); });

addEventListener('keydown', (e) => {
  if (e.code !== 'KeyM' || e.repeat) return;
  // bare M only: modified presses belong to the browser and the OS
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (editingNow() || isOverlayOpen() || chat.isOpen) return;
  if (locked) document.exitPointerLock();
  else relock();
});

// An Esc-initiated unlock leaves the canvas unfocused, and Chrome wants
// requestPointerLock from a focused target — a bare window keydown listener
// was not enough to get back IN (R, 00:33). Focus first, then ask; and if the
// browser refuses anyway, say so instead of failing silently, which is how
// this hid in the first place.
function relock() {
  if (document.pointerLockElement === canvas) return;
  try { canvas.focus?.({ preventScroll: true }); } catch { /* not focusable, fine */ }
  const p = canvas.requestPointerLock();
  p?.catch?.(() => flashHint('press <kbd>M</kbd> again to look'));
}

addEventListener('mousemove', (e) => {
  if (locked || dragging) {
    camYaw -= e.movementX * 0.005;
    camPitch = THREE.MathUtils.clamp(camPitch + e.movementY * 0.004, -0.9, 1.2);
  }
  if (!locked) mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // right-drag orbit
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  camDist = THREE.MathUtils.clamp(camDist + e.deltaY * 0.004, 0.0, 16);
  const wasFP = firstPerson;
  // Hysteresis: enter FP under 0.4m, don't leave until past 0.7m. A single
  // threshold flickers 1P/3P at the boundary — nauseating, and loudest for
  // exactly the motion-sensitive people a hangout world shelters.
  firstPerson = wasFP ? camDist < 0.7 : camDist < 0.4;
  if (firstPerson !== wasFP) flashHint(firstPerson ? 'first person' : 'third person');
}, { passive: false });

// ---------------------------------------------------------------- touch
// No touch support at all meant a spectator on a phone got nothing. A left
// thumbstick plus look-drag on the rest of the screen is the minimum that
// makes a body usable.

const touchState = { moveX: 0, moveZ: 0, lookId: null, lastX: 0, lastY: 0 };
export function enableTouch() {
  document.body.classList.add('touch');
  const stick = document.getElementById('stick');
  const nub = stick.querySelector('.nub');
  let stickId = null, cx = 0, cy = 0;
  const R = 46;
  stick.addEventListener('pointerdown', (e) => {
    stickId = e.pointerId;
    const r = stick.getBoundingClientRect();
    cx = r.left + r.width / 2; cy = r.top + r.height / 2;
    stick.setPointerCapture(e.pointerId);
  });
  stick.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stickId) return;
    let dx = e.clientX - cx, dy = e.clientY - cy;
    const d = Math.hypot(dx, dy);
    if (d > R) { dx *= R / d; dy *= R / d; }
    nub.style.transform = `translate(${dx}px, ${dy}px)`;
    touchState.moveX = dx / R; touchState.moveZ = dy / R;
  });
  const end = (e) => {
    if (e.pointerId !== stickId) return;
    stickId = null; touchState.moveX = touchState.moveZ = 0;
    nub.style.transform = '';
  };
  stick.addEventListener('pointerup', end);
  stick.addEventListener('pointercancel', end);

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || touchState.lookId !== null) return;
    touchState.lookId = e.pointerId;
    touchState.lastX = e.clientX; touchState.lastY = e.clientY;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== touchState.lookId) return;
    camYaw -= (e.clientX - touchState.lastX) * 0.006;
    camPitch = THREE.MathUtils.clamp(camPitch + (e.clientY - touchState.lastY) * 0.005, -0.9, 1.2);
    touchState.lastX = e.clientX; touchState.lastY = e.clientY;
  });
  const lookEnd = (e) => { if (e.pointerId === touchState.lookId) touchState.lookId = null; };
  canvas.addEventListener('pointerup', lookEnd);
  canvas.addEventListener('pointercancel', lookEnd);

  const btns = document.getElementById('touchbtns');
  for (const [label, code] of [['⤒', 'Space'], ['💬', 'chat']]) {
    const b = document.createElement('button');
    b.className = 'panel';
    b.textContent = label;
    if (code === 'chat') b.onclick = () => chat.open();
    else {
      b.addEventListener('pointerdown', () => keys.add(code));
      b.addEventListener('pointerup', () => keys.delete(code));
    }
    btns.appendChild(b);
  }
}
if (matchMedia('(pointer: coarse)').matches) enableTouch();

// ---------------------------------------------------------------- movement

const _dir = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _facing = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export function updateMe(dt, me) {
  if (!me) return;
  if (photoMode) { updatePhotoCamera(dt); return; }

  let fwd = Number(held(MOVE_KEYS.fwd)) - Number(held(MOVE_KEYS.back));
  let strafe = Number(held(MOVE_KEYS.right)) - Number(held(MOVE_KEYS.left));
  if (touchState.moveX || touchState.moveZ) { strafe = touchState.moveX; fwd = -touchState.moveZ; }

  const moving = Math.abs(fwd) > 0.08 || Math.abs(strafe) > 0.08;
  const running = keys.has('ShiftLeft') || keys.has('ShiftRight');
  // A slow walk for precise positioning — placing a chair exactly where you
  // want it at 1.55 m/s is a fight.
  const creeping = keys.has('AltLeft') || keys.has('AltRight');
  const mag = Math.min(1, Math.hypot(fwd, strafe));
  const target = moving ? (creeping ? 0.55 : running ? 4.0 : 1.55) * mag : 0;
  myState.speed = THREE.MathUtils.lerp(myState.speed, target, 1 - Math.exp(-10 * dt));
  if (myState.speed < 0.02) myState.speed = 0;

  if (moving) {
    _dir.set(strafe, 0, -fwd).normalize().applyAxisAngle(UP, camYaw);
    const targetYaw = Math.atan2(_dir.x, _dir.z);
    myState.yaw += angleDelta(myState.yaw, targetYaw) * Math.min(1, 12 * dt);
    myState.pos.addScaledVector(_dir, myState.speed * dt);
    const R = 78; // stay on the island
    const r = Math.hypot(myState.pos.x, myState.pos.z);
    if (r > R) { myState.pos.x *= R / r; myState.pos.z *= R / r; }
  }

  // ---- vertical
  const ground = resolveColliders(myState.pos, heightAt);
  const blockedTop = lastBlockedTop();
  // FLIGHT OWNS THE BODY while it lasts -- position, heading and clip -- the
  // same way a mantle or a ragdoll does. Walking resumes the moment she lands.
  if (flight) {
    // A GROUNDED FLIGHT DOES NOT OWN A BODY. `stepGround` integrates nothing,
    // so a state that reaches here still in GROUND freezes the person in place
    // and swallows their controls -- flight's grip on the body has to be
    // conditional on flight actually happening. The toggle already refuses to
    // publish a non-PILOT state; this is the second lock, because "the body is
    // held by something that is not moving it" is the failure worth making
    // structurally impossible rather than merely unlikely.
    if (flight.phase === 'GROUND') {
      flashHint?.('flight did not start — released');
      flight = null; grounded = true; vy = 0;
    }
  }
  if (flight) {
    const input = pilotInput(keys, flight, dt);
    flight = flightStep(flightCfg, flight, dt, { groundY: flightGround, input });
    myState.pos.set(flight.pos.x, flight.pos.y, flight.pos.z);
    myState.yaw = Math.PI / 2 - flight.yaw;          // back to world convention
    myState.speed = Math.hypot(flight.vel.x, flight.vel.z);
    myState.clip = flight.wings === 'LIMP' ? 'ragdoll'
      : (input.flap ? 'fly' : 'soar');
    if (flight.phase === 'LANDED' || flight.phase === 'GROUND' || flight.phase === 'RAGDOLL') {
      const endedAt = +flight.t.toFixed(2);
      lastFlightEnd = { phase: flight.phase, y: +flight.pos.y.toFixed(2),
                        ground: +flightGround(flight.pos.x, flight.pos.z).toFixed(2),
                        t: endedAt };
      // A FLIGHT THAT ENDS IN ITS FIRST SECOND IS A BUG REPORTING ITSELF.
      // "It jumps and lands immediately" arrived as a description because the
      // client had no way to say WHY -- the receipt existed only in a devtools
      // probe. A landing is normal; a landing before the launch has finished
      // spooling is not, and it should arrive with its numbers attached.
      if (endedAt < 1.5) {
        flashHint?.(`flight ended after ${endedAt}s — landed at y=${lastFlightEnd.y}, ` +
                    `ground ${lastFlightEnd.ground}`, 6000);
      }
      flight = null; grounded = true; vy = 0;
      myState.clip = 'idle'; myState.speed = 0;
    }
    return;                                           // nothing else drives her
  }
  if (mantle) {
    mantle.t += dt / 0.55;
    const k = Math.min(1, mantle.t), e = k * k * (3 - 2 * k);
    myState.pos.lerpVectors(mantle.from, mantle.to, e);
    if (k >= 1) { mantle = null; grounded = true; vy = 0; }
  } else {
    if (grounded && keys.has('Space')) {
      posture = null; myState.seat = null;
      const reach = blockedTop !== null ? blockedTop - myState.pos.y : 0;
      if (blockedTop !== null && reach > 0.3 && reach <= 1.7) {
        _facing.set(Math.sin(myState.yaw), 0, Math.cos(myState.yaw));
        const to = myState.pos.clone().addScaledVector(_facing, 0.6);
        to.y = blockedTop;
        mantle = { from: myState.pos.clone(), to, t: 0 };
        grounded = false;
      } else { vy = 5.6; grounded = false; }
    }
    if (!mantle) {
      if (!grounded || myState.pos.y > ground + 0.02) {
        grounded = false;
        vy -= 16 * dt;
        myState.pos.y += vy * dt;
        if (myState.pos.y <= ground) { myState.pos.y = ground; vy = 0; grounded = true; }
      } else { myState.pos.y = ground; vy = 0; grounded = true; }
    }
  }
  airborneFor = grounded || mantle ? 0 : airborneFor + dt;
  if (myState.speed >= 0.05) {
    posture = null; myState.seat = null; // standing up is just walking away
    // ...and so is escaping a held pose (puppet, restored, or ragdoll-settled).
    // Without this, a pose applied from OUTSIDE this session had no exit —
    // the get-up path only exists in the session that fell.
    if (myState.pose) myState.pose = null;
  }

  const seatedClip = myState.seat?.chair ? 'sitchair' : 'sit';
  myState.clip = mantle ? 'climb'
    : airborneFor > 0.09 ? 'jump'
      : myState.speed >= 0.05 ? (myState.speed < 2.6 ? 'walk' : 'run')
        : posture === 'sit' ? seatedClip
          : posture === 'lie' ? 'lie'
            : 'idle';

  me.setClip(myState.clip, myState.speed);
  me.root.position.copy(myState.pos);
  me.root.rotation.y = myState.yaw;
  // your head follows your camera — you could always look up, your body never
  // showed it
  myState.pitch = THREE.MathUtils.clamp(camPitch - 0.32, -0.45, 0.55);
  me.pitch = firstPerson ? 0 : myState.pitch;

  updateFollowCamera(dt, me);
}

// ---------------------------------------------------------------- camera

// Clips whose head sits where the fixed standing-height guess puts it. Any
// other clip — sit/sitchair/lie, whatever pose a socket declares — moves the
// head somewhere a constant offset from the root can't know.
const STANDING_CLIPS = new Set(['idle', 'walk', 'run', 'jump', 'climb']);
const _headWp = new THREE.Vector3();

export function updateFollowCamera(dt, me) {
  const headY = 1.45;
  const focus = _eye.set(myState.pos.x, myState.pos.y + headY, myState.pos.z);

  if (firstPerson) {
    // Seated/lying (and any held ragdoll pose) put the head somewhere the
    // standing offset can't predict — a chair leans you back, lying puts the
    // head a body-length from the root near the floor. Anchor on the LIVE
    // head bone instead (#75's contract, same as the snap/spectator views):
    // me.update() keeps the mixer animating while the mesh is hidden in
    // first person, so the bone tracks the sit-down/lie-down transition
    // frame by frame and rides a moving socket. Standing locomotion keeps
    // the fixed height — bolting the eye to the bone there would add the
    // walk cycle's head bob to every step.
    if (me && (myState.pose || !STANDING_CLIPS.has(myState.clip))) {
      const hp = me.headWorldPosition(_headWp);
      if (hp) focus.set(hp.x, hp.y + FP_EYE_LIFT, hp.z);
    }
    // Eye slightly forward of the head joint so the face doesn't clip the near
    // plane, aimed along the orbit angles (which are now the LOOK angles).
    _facing.set(Math.sin(camYaw), 0, Math.cos(camYaw));
    camera.position.copy(focus).addScaledVector(_facing, 0.16);
    _dir.set(
      -Math.sin(camYaw) * Math.cos(camPitch - 0.32),
      -Math.sin(camPitch - 0.32),
      -Math.cos(camYaw) * Math.cos(camPitch - 0.32),
    ).normalize();
    camera.lookAt(
      camera.position.x + _dir.x, camera.position.y + _dir.y, camera.position.z + _dir.z);
    if (me) me.vrm.scene.visible = false;         // don't render the inside of your own head
    return;
  }
  if (me) me.vrm.scene.visible = true;

  // desired eye, with a shoulder offset so the body doesn't sit dead-centre
  // over whatever you're aiming at
  const dirX = Math.sin(camYaw) * Math.cos(camPitch);
  const dirY = Math.sin(camPitch);
  const dirZ = Math.cos(camYaw) * Math.cos(camPitch);
  const shoulder = _shoulder.set(Math.cos(camYaw), 0, -Math.sin(camYaw))
    .multiplyScalar(THREE.MathUtils.clamp(camDist * 0.16, 0, 0.62));
  const want = _camWant.set(dirX, dirY, dirZ).multiplyScalar(camDist).add(focus).add(shoulder);

  // ---- collision: pull the eye in so orbiting into a wall or hillside never
  // puts the camera inside the world. One grid segment query (§14.2 6a) —
  // this used to be a recursive raycast into every mesh of every entity,
  // with three fresh Vector3s per frame, to learn this one number.
  const farD = focus.distanceTo(want);
  _cdir.copy(want).sub(focus).normalize();
  const hitT = raySegment(focus, _cdir, farD);
  const allowed = hitT !== null ? Math.min(farD, hitT - 0.22) : farD;
  if (allowed < farD) {
    want.copy(focus).addScaledVector(_cdir, Math.max(0.35, allowed));
  }
  // never let the eye go under the floor
  want.y = Math.max(want.y, heightAt(want.x, want.z) + 0.35);

  camera.position.lerp(want, 1 - Math.exp(-(allowed < farD ? 26 : 14) * dt));
  camera.lookAt(focus.x + shoulder.x * 0.5, focus.y - 0.1, focus.z + shoulder.z * 0.5);
}
const _shoulder = new THREE.Vector3();
const _camWant = new THREE.Vector3();   // _want is photo mode's, below
const _cdir = new THREE.Vector3();

// (The camera's collision-target DI hook died with the mesh raycast — the
// grid's raySegment answers from collider entries, no entity list needed.)

// ---- photo mode -------------------------------------------------------------
// The pitch is "the video toolkit becomes the camera crew" and there was no
// screenshot key, no UI hide, no free camera. This is the human-facing version
// of the retina path that already exists for agents.

// Damping. A camera that starts and stops on the exact frame a key goes down
// reads as a debug flythrough, not a shot: the eye is a physical object and an
// operator's hands have mass. Everything here eases with an exponential
// half-life — frame-rate independent (no `dt` term in a lerp factor, which
// silently changes feel between 60 and 144Hz), and it cannot overshoot after a
// long frame the way a spring would.
const MOVE_TAU = 0.22;   // dolly weight: pushes off, glides to a stop
const LOOK_TAU = 0.09;   // pans settle instead of snapping; short enough to not feel laggy
const FOV_TAU = 0.16;    // the lens breathes
// Alt is the fine-adjust modifier: the last few metres and the last few degrees
// of a frame. It slows the dolly to a walking pace AND puts the head on a
// geared tripod — the same hand movement that whips the camera around at full
// speed becomes a slow, smooth swing, so a shot can be settled precisely
// instead of hunted. Damping only changes HOW it gets there: the mouse still
// commands the same angle, it just arrives without the jitter of the wrist.
const LOOK_TAU_FINE = 0.5;
const FINE_MPS = 2.5;    // absolute, not a fraction — "creep at 2.5 m/s"
const damp = (cur, target, tau, dt) => target + (cur - target) * Math.exp(-dt / tau);
/** Same, over the shortest arc — so a pan across ±π doesn't unwind the long way. */
function dampAngle(cur, target, tau, dt) {
  let d = (target - cur) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return cur + d * (1 - Math.exp(-dt / tau));
}

const photo = {
  pos: new THREE.Vector3(), vel: new THREE.Vector3(),
  yaw: 0, pitch: 0, fov: 55, speed: 6,
};
const _f = new THREE.Vector3(), _right = new THREE.Vector3(), _want = new THREE.Vector3();
export function togglePhotoMode() {
  photoMode = !photoMode;
  if (photoMode) {
    photo.pos.copy(camera.position);
    photo.yaw = camYaw; photo.pitch = camPitch;
    photo.vel.set(0, 0, 0);          // enter at rest — no inherited drift
    photo.fov = camera.fov;
    flashHint('photo mode — <kbd>WASD</kbd>+<kbd>QE</kbd> fly · <kbd>[</kbd><kbd>]</kbd> lens · <kbd>F1</kbd> hide UI · <kbd>F2</kbd> save · <kbd>P</kbd> exit', 6000);
  } else {
    camera.fov = 55; camera.updateProjectionMatrix();
    document.body.classList.remove('photo');
  }
  return photoMode;
}
function updatePhotoCamera(dt) {
  if (dragging) { /* handled by the shared mousemove */ }
  // The mouse sets a TARGET orientation; the camera chases it. Framing against
  // the damped angles (not the raw ones) is what makes a pan feel operated
  // rather than teleported — and the fly keys steer by where the camera is
  // actually looking, so movement never fights the settle.
  const fine = keys.has('AltLeft');
  const lookTau = fine ? LOOK_TAU_FINE : LOOK_TAU;
  photo.yaw = dampAngle(photo.yaw, camYaw, lookTau, dt);
  photo.pitch = damp(photo.pitch, camPitch, lookTau, dt);
  _f.set(-Math.sin(photo.yaw) * Math.cos(photo.pitch), -Math.sin(photo.pitch),
    -Math.cos(photo.yaw) * Math.cos(photo.pitch));
  _right.crossVectors(_f, UP).normalize();

  const boost = (keys.has('ShiftLeft') ? 3.5 : 1) * (fine ? FINE_MPS / photo.speed : 1);
  _want.set(0, 0, 0);
  if (held(MOVE_KEYS.fwd)) _want.add(_f);
  if (held(MOVE_KEYS.back)) _want.sub(_f);
  if (held(MOVE_KEYS.right)) _want.add(_right);
  if (held(MOVE_KEYS.left)) _want.sub(_right);
  if (keys.has('KeyE')) _want.y += 1;
  if (keys.has('KeyQ')) _want.y -= 1;
  // diagonals used to travel ~1.4× faster than the cardinals
  if (_want.lengthSq() > 1) _want.normalize();
  _want.multiplyScalar(photo.speed * boost);

  // Velocity chases the intent, so a keypress accelerates and a release coasts.
  const k = 1 - Math.exp(-dt / MOVE_TAU);
  photo.vel.addScaledVector(_want.sub(photo.vel), k);
  photo.pos.addScaledVector(photo.vel, dt);

  if (keys.has('BracketLeft')) photo.fov = Math.max(12, photo.fov - 30 * dt);
  if (keys.has('BracketRight')) photo.fov = Math.min(95, photo.fov + 30 * dt);
  const fov = damp(camera.fov, photo.fov, FOV_TAU, dt);
  if (Math.abs(fov - camera.fov) > 1e-4) { camera.fov = fov; camera.updateProjectionMatrix(); }

  camera.position.copy(photo.pos);
  camera.lookAt(_f.add(photo.pos));   // _f is spent here — recomputed next frame
}

/** Spectator/retina camera: first person from a followed body's head.
 *  Same eye/exclusion semantics as the snap `first` view (#75): the eye
 *  anchors on the live head bone (bounds when the rig has none) so it follows
 *  a mounted socket, and the followed body is hidden — a first-person view
 *  of someone is not improved by the inside of their skull. */
const _specHead = new THREE.Vector3();
const _specBox = new THREE.Box3();
export function updateSpectator(dt, remote) {
  if (!remote?.avatar) return;
  const root = remote.avatar.root;
  const head = remote.avatar.headWorldPosition(_specHead);
  const box = head ? null : remote.avatar.visualBounds(_specBox);
  let anchor;
  try {
    anchor = resolveFirstPersonAnchor({
      head: head ? [head.x, head.y, head.z] : null,
      bounds: box ? { min: box.min.toArray(), max: box.max.toArray() } : null,
      name: remote.id,
    });
  } catch {
    return;   // rig offers no anchor (still materializing) — hold the frame
  }
  root.visible = false;
  _facing.set(Math.sin(root.rotation.y), 0, Math.cos(root.rotation.y));
  const eye = new THREE.Vector3(...anchor.eye).addScaledVector(_facing, FP_FORWARD);
  camera.position.lerp(eye, 1 - Math.exp(-20 * dt));
  camera.lookAt(eye.clone().addScaledVector(_facing, FP_GAZE_AHEAD).add(new THREE.Vector3(0, -FP_GAZE_DROP, 0)));
}

export function setCamYaw(v) { camYaw = v; }
export function setPosture(p) { posture = p; }
export const getPosture = () => posture;
