// Pure input normalization. Standard Gamepad mapping only; no synthetic keys.
export function stick(x = 0, y = 0, deadZone = 0.18) {
  x = Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;
  y = Number.isFinite(y) ? Math.max(-1, Math.min(1, y)) : 0;
  const length = Math.hypot(x, y);
  if (length <= deadZone) return [0, 0];
  const scale = (Math.min(1, length) - deadZone) / (1 - deadZone) / length;
  return [x * scale, y * scale];
}

const empty = () => ({ moveX: 0, moveZ: 0, lookX: 0, lookY: 0,
  jump: false, use: false, cancel: false, run: false });

// What counts as "I meant to move". A stick resting just outside the dead
// zone rescales to ~0.01, and raw truthiness reads that as walking — with it
// you can neither stay seated on a socket nor stay knocked down while a worn
// pad sits on the table. updateMe has always used this number; everything
// that asks "is this body being driven?" has to ask with the same one.
export const MOVE_MIN = 0.08;
export const moving = (input) =>
  Math.abs(input?.moveX ?? 0) > MOVE_MIN || Math.abs(input?.moveZ ?? 0) > MOVE_MIN;

/** Level input read as an edge, the way the pad sampler arms itself above:
 *  after a disarm nothing counts until the input passes through neutral once.
 *  A key that was already held when you were knocked over is not a decision
 *  to stand up — without this the ragdoll lasted a single frame for anyone
 *  walking, and a grabbed body broke free before the hand had closed. */
export function neutralLatch() {
  let armed = false;
  return {
    disarm() { armed = false; },
    edge(active) { if (!armed) { armed = !active; return false; } return !!active; },
  };
}

export function standardPad(pad) {
  const result = empty();
  if (!pad?.connected || pad.mapping !== 'standard') return result;
  [result.moveX, result.moveZ] = stick(pad.axes?.[0], pad.axes?.[1]);
  [result.lookX, result.lookY] = stick(pad.axes?.[2], pad.axes?.[3]);
  const pressed = i => !!pad.buttons?.[i]?.pressed;
  result.jump = pressed(0); result.cancel = pressed(1); result.use = pressed(2);
  result.run = pressed(10);
  return result;
}

export function createPadInput() {
  let identity = null, armed = false, previous = empty();
  return {
    clear() { identity = null; armed = false; previous = empty(); },
    sample(pads, enabled = true) {
      const available = Array.from(pads ?? []).filter(p => p?.connected && p.mapping === 'standard');
      const id = p => `${p.index}:${p.id}`;
      const pad = available.find(p => id(p) === identity) ?? available[0];
      const nextIdentity = pad ? id(pad) : null;
      if (identity !== nextIdentity || !enabled) armed = false;
      identity = nextIdentity;
      const value = standardPad(pad);
      const active = Object.values(value).some(Boolean);
      // A held button on discovery, reconnect, or return from a dialog is
      // not a new press. Require a neutral frame before accepting anything.
      if (enabled && pad && !active) armed = true;
      const result = enabled && armed ? value : empty();
      const edges = {};
      for (const action of ['jump', 'use', 'cancel']) edges[action] = result[action] && !previous[action];
      previous = result;
      return { ...result, edges, active: enabled && armed && active, connected: !!pad };
    },
  };
}

/** `out` is the frame loop's scratch, in the house style of the Vector3
 *  scratches all over the client: this runs once per frame forever, and the
 *  answer is read and discarded inside the calling statement. Pure by default
 *  — omit it and you get a fresh object, which is what every caller that
 *  KEEPS the answer (and every test) does. Never hand the same `out` to two
 *  live readers: it is one buffer, not a value. */
export function movement(keys, touch, pad, out = {}) {
  const held = (...codes) => codes.some(code => keys.has(code));
  let moveX = Number(held('KeyD', 'ArrowRight')) - Number(held('KeyA', 'ArrowLeft'));
  let moveZ = Number(held('KeyS', 'ArrowDown')) - Number(held('KeyW', 'ArrowUp'));
  if (touch.moveX || touch.moveZ) { moveX = touch.moveX; moveZ = touch.moveZ; }
  if (pad.moveX || pad.moveZ) { moveX = pad.moveX; moveZ = pad.moveZ; }
  const length = Math.max(1, Math.hypot(moveX, moveZ));
  out.moveX = moveX / length;
  out.moveZ = moveZ / length;
  out.jump = keys.has('Space') || pad.jump;
  out.run = held('ShiftLeft', 'ShiftRight') || pad.run;
  out.creep = held('AltLeft', 'AltRight');
  return out;
}
