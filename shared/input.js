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

export function movement(keys, touch, pad) {
  const held = (...codes) => codes.some(code => keys.has(code));
  let moveX = Number(held('KeyD', 'ArrowRight')) - Number(held('KeyA', 'ArrowLeft'));
  let moveZ = Number(held('KeyS', 'ArrowDown')) - Number(held('KeyW', 'ArrowUp'));
  if (touch.moveX || touch.moveZ) { moveX = touch.moveX; moveZ = touch.moveZ; }
  if (pad.moveX || pad.moveZ) { moveX = pad.moveX; moveZ = pad.moveZ; }
  const length = Math.max(1, Math.hypot(moveX, moveZ));
  return { moveX: moveX / length, moveZ: moveZ / length,
    jump: keys.has('Space') || pad.jump,
    run: held('ShiftLeft', 'ShiftRight') || pad.run,
    creep: held('AltLeft', 'AltRight') };
}
