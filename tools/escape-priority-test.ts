// Escape is a chain, not a broadcast — and the pad legend is taught once.
//
// The two defects this exists for (PR #171 review, items 4 and 6):
//
//  4. Escape became a KEYBOARD binding for `cancel` (stand up, leave photo
//     mode, drop pointer lock) while build.js already owned Escape as its
//     deselect chain. The controller dispatched `cancel` BEFORE the key bus,
//     so one press while sitting-and-editing did both: it deselected AND
//     stood you up. The editor gets first refusal now and declines the
//     default on the press it consumes; the pad's B/○ never enters this path
//     at all (it emits `input-action` straight out of pollInput), so
//     cancel-while-editing still works on a controller.
//
//  6. `input-device` fires on every SWITCH, so a mouse-for-UI, pad-for-play
//     session re-read the same six-second banner on every swap.
//
// Real controller.js and real build.js, on the real bus and the real
// input.js: the whole point is the seam between the two key handlers, and a
// stub of either end would test the stub.
import { strict as assert } from 'node:assert';
import { mock } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
// three by explicit path: tools/ sits outside client/, where the install is
// (see tools/core-stub.mjs) — a bare specifier only resolves with a root copy.
import * as THREE from '../client/node_modules/three/build/three.module.js';
GlobalRegistrator.register({ url: 'https://renderer.example/' });

const base = `${import.meta.dir}/../client/lib/`;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
const canvas = document.createElement('canvas');
document.body.append(canvas);
Object.defineProperty(document, 'hasFocus', { value: () => true });

const hints: string[] = [];
const entities = new Map<string, any>([['lamp', new THREE.Group()]]);

mock.module(base + 'core.js', () => ({ THREE, scene, camera, canvas }));
mock.module(base + 'terrain.js', () => ({ heightAt: () => 0 }));
mock.module(base + 'colliders.js', () => ({
  resolveColliders: (p: any) => p, lastBlockedTop: () => null, findSeat: () => null,
  raySegment: () => null, reindexCollider() {},
}));
mock.module(base + 'chat.js', () => ({ chat: { open() {} } }));
mock.module(base + 'ui.js', () => ({
  isOverlayOpen: () => false,
  flashHint: (html: string) => { hints.push(html); },
  collapseAll() {}, panelFrame: () => ({ show() {} }),
}));
mock.module(base + 'fp_view.js', () => ({
  resolveFirstPersonAnchor: () => null,
  FP_FORWARD: 0, FP_EYE_LIFT: 0, FP_GAZE_AHEAD: 0, FP_GAZE_DROP: 0,
}));
mock.module(base + 'assets.js', () => ({ loadGLB: async () => new THREE.Group(), libLabels: new Map() }));
mock.module(base + 'lights.js', () => ({ makeLightGizmo: () => new THREE.Group() }));
mock.module(base + 'world.js', () => ({
  entities, entityMeta: new Map(), comps: new Map(), editHolds: new Set(),
}));
mock.module(base + 'net.js', () => ({ sendVerb() {}, sendDrag() {} }));
mock.module(base + 'scenegraph.js', () => ({ sceneSelect() {} }));
mock.module(base + 'seatedit.js', () => ({
  refreshSeatGizmos() {}, resetSeats() {}, armSeatPlacement() {},
  seatArmed: () => false, seatSelected: () => false,
  cancelSeatArm: () => false, deselectSeat() {},
  seatMouseDown() {}, seatKeyDown() {}, updateSeatDrag() {},
}));

const { bus } = await import('../client/lib/base.js');
const { noteInput } = await import('../client/lib/input.js');
const { myState, setPosture, getPosture } = await import('../client/lib/controller.js');
const { setEditMode, isEditing, select, hasSelection } = await import('../client/lib/build.js');

const actions: string[] = [];
bus.on('input-action', (a: string) => actions.push(a));
const escape = () => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: 'Escape', key: 'Escape' });
  window.dispatchEvent(e);
  return e;
};
const sitOnABench = () => { setPosture('sit'); myState.seat = 'bench'; };

// ---- item 4: one press, one action -----------------------------------------

sitOnABench();
setEditMode(true, { quiet: true });
select('lamp');
assert.equal(hasSelection(), true, 'fixture: something is selected');

let e = escape();
assert.equal(hasSelection(), false, 'the editor still gets the press');
assert.equal(e.defaultPrevented, true, 'a consumed press is a declined default');
assert.deepEqual(actions, [], 'deselecting must not ALSO stand you up');
assert.equal(myState.seat, 'bench');
assert.equal(getPosture(), 'sit');

// The bottom rung of the editor's chain is still the editor's: leaving edit
// mode is one press, and not one press plus a dismount.
e = escape();
assert.equal(isEditing(), false, 'the next press leaves edit mode');
assert.equal(e.defaultPrevented, true);
assert.deepEqual(actions, []);
assert.equal(myState.seat, 'bench', 'leaving edit mode is not leaving the seat');

// Nothing left to dismiss: the press falls all the way through, which is the
// binding the PR added and it has to keep working.
e = escape();
assert.equal(e.defaultPrevented, false, 'an unclaimed press is not declined');
assert.deepEqual(actions, ['cancel'], 'Escape with nothing selected still cancels');
assert.equal(myState.seat, null);
assert.equal(getPosture(), null);

// ---- item 4: the pad is not the keyboard -----------------------------------
// B/○ reaches `cancel` through pollInput, never through the keydown handler,
// so the editor's first refusal must not reach it: standing up with a
// selection live is exactly what the button is for.
actions.length = 0;
sitOnABench();
setEditMode(true, { quiet: true });
select('lamp');
bus.emit('input-action', 'cancel');
assert.deepEqual(actions, ['cancel']);
assert.equal(myState.seat, null, 'B / ○ stands you up even mid-edit');
assert.equal(getPosture(), null);
assert.equal(hasSelection(), true, 'and it leaves the editor alone');
setEditMode(false, { quiet: true });

// ---- item 6: the legend is taught once -------------------------------------

const legends = () => hints.filter(h => h.startsWith('controller —')).length;
assert.equal(legends(), 0, 'fixture: no pad has spoken yet');
noteInput('gamepad');
assert.equal(legends(), 1, 'the first pad frame teaches the legend');
noteInput('keyboard'); noteInput('gamepad');
noteInput('keyboard'); noteInput('gamepad');
assert.equal(legends(), 1, 'reaching for the mouse and back does not re-teach it');

console.log('Escape priority and pad-hint checks passed');
