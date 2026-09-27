import { strict as assert } from 'node:assert';
import {
  createPadInput, stick, standardPad, movement, moving, neutralLatch, MOVE_MIN,
} from '../shared/input.js';

const pad = { index: 0, id: 'Xbox', connected: true, mapping: 'standard',
  axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false })) };
assert.deepEqual(stick(0.1, -0.1), [0, 0]);
assert.deepEqual(stick(NaN, Infinity), [0, 0]);
assert(Math.abs(Math.hypot(...stick(1, 1)) - 1) < 1e-9);
assert(Math.abs(stick(0.59, 0)[0] - 0.5) < 1e-9);
assert.equal(standardPad({ ...pad, mapping: '' }).moveX, 0);
const input = createPadInput();
pad.buttons[2].pressed = true;
assert.equal(input.sample([null, pad]).edges.use, false, 'discovery must not activate held use');
pad.buttons[2].pressed = false; input.sample([pad]);
pad.buttons[2].pressed = true;
assert.equal(input.sample([pad]).edges.use, true);
for (let i = 0; i < 120; i++) assert.equal(input.sample([pad]).edges.use, false);
input.sample([pad], false);
assert.equal(input.sample([pad]).use, false, 'return from modal requires neutral');
pad.buttons[2].pressed = false; input.sample([pad]);
pad.axes = [1, -1, 0.5, -0.5];
let value = input.sample([pad]);
assert(value.moveX > 0 && value.moveZ < 0 && value.lookX > 0 && value.lookY < 0);
assert.equal(input.sample([]).moveX, 0);
assert.equal(input.sample([pad]).moveX, 0, 'reconnect requires neutral sticks');
pad.axes.fill(0); input.sample([pad]);
pad.buttons[0].pressed = true; pad.buttons[1].pressed = true;
value = input.sample([pad]); assert(value.edges.jump && value.edges.cancel);
input.clear(); assert.equal(input.sample([pad]).jump, false);
pad.buttons.forEach(b => b.pressed = false);
const neutral = standardPad(pad);
const keyboard = movement(new Set(['KeyW', 'KeyD', 'Space']), { moveX: 0, moveZ: 0 }, neutral);
assert(Math.abs(Math.hypot(keyboard.moveX, keyboard.moveZ) - 1) < 1e-9);
assert(keyboard.jump && keyboard.moveZ < 0);
assert.equal(movement(new Set(), { moveX: 0.5, moveZ: 0 }, neutral).moveX, 0.5);

// The frame loop hands in a scratch instead of allocating a fresh answer it
// throws away sixty times a second (PR #171 review, item 5). Every OTHER
// caller — and every test — still gets its own object, so nothing can end up
// holding a buffer somebody else is about to rewrite.
const scratch: any = { moveX: 9, moveZ: 9, jump: true, run: true, creep: true };
assert.equal(movement(new Set(['KeyW']), { moveX: 0, moveZ: 0 }, neutral, scratch), scratch,
  'the out-parameter IS the answer');
assert.equal(scratch.moveZ, -1);
assert.equal(scratch.jump, false, 'every field is written, so nothing survives from last frame');
assert.equal(scratch.run, false); assert.equal(scratch.creep, false);
movement(new Set(['KeyS']), { moveX: 0, moveZ: 0 }, neutral, scratch);
assert.equal(scratch.moveZ, 1, 'the scratch is overwritten, not merged');
const a = movement(new Set(), { moveX: 0, moveZ: 0 }, neutral);
const b = movement(new Set(), { moveX: 0, moveZ: 0 }, neutral);
assert.notEqual(a, b, 'omit the scratch and movement() is still pure');
input.clear(); input.sample([pad]);
const second = { ...pad, index: 1, id: 'PlayStation', axes: [1, 0, 0, 0] };
assert.equal(input.sample([second, pad]).moveX, 0, 'retain selected pad despite list order');
assert.equal(input.sample([second]).moveX, 0, 'replacement must return to neutral');
second.axes[0] = 0; input.sample([second]);
second.axes[0] = 1; assert.equal(input.sample([second]).moveX, 1);

// The movement threshold is one number, and it is the one updateMe walks on.
// A worn stick resting just outside the dead zone rescales to ~0.01: real
// enough for `if (moveX)`, which is why dismount and getUp used to fire on it.
assert.equal(MOVE_MIN, 0.08);
const drift = stick(0.19, 0)[0];
assert(drift > 0 && drift < MOVE_MIN);
assert.equal(moving({ moveX: drift, moveZ: 0 }), false, 'stick drift is not walking');
assert.equal(moving({ moveX: 0, moveZ: -0.5 }), true);
assert.equal(moving(undefined as any), false);

// The neutral latch: whatever was already held when it disarmed never counts.
const latch = neutralLatch();
for (let i = 0; i < 5; i++) assert.equal(latch.edge(true), false, 'input held through a disarm is not a press');
assert.equal(latch.edge(false), false, 'the neutral frame only re-arms');
assert.equal(latch.edge(true), true);
assert.equal(latch.edge(true), true, 'once armed it stays level-true — the caller acts once');
latch.disarm();
assert.equal(latch.edge(true), false, 'a second disarm needs another neutral frame');

console.log('Input normalization and edge checks passed');
