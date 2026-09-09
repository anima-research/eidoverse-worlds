// Contextual controls: range, occlusion, focus, prompts, and ordinary use.
import { strict as assert } from 'node:assert';
import { mock } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
// three by explicit path: tools/ sits outside client/, where the install is
// (see tools/core-stub.mjs) — a bare specifier only resolves with a root copy.
import * as THREE from '../client/node_modules/three/build/three.module.js';
GlobalRegistrator.register({ url: 'https://renderer.example/' });
const base = `${import.meta.dir}/../client/lib/`;
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
camera.position.set(0, 2, 5); camera.lookAt(0, 1, 0); camera.updateMatrixWorld();
let action: Function, occluded = false, overlay = false;
const uses: any[] = [];
const myState = { pos: new THREE.Vector3(0, 0, 1) };
const state = { st: { entities: { lamp: { comp: { interaction: { action: 'toggle', label: 'Toggle lamp' } } } } } };
const entities = new Map([['lamp', new THREE.Group()]]);
let building = null;
mock.module(base+'realize/structure.js', () => ({ structureObject: () => building }));
mock.module(base+'core.js', () => ({ THREE, camera }));
mock.module(base+'base.js', () => ({ CONFIG: {}, bus: { on: (_: string, fn: Function) => { action = fn; } } }));
mock.module(base+'input.js', () => ({ requestAction: (value: string) => action(value),
  usePrompt: () => 'X / □', setInputAvailable() {}, noteInput() {},
  // stands in for input.js's typing() — its real selector is covered by
  // tools/input-dom-test.ts, which is the point of sharing one definition
  typing: () => Boolean(document.activeElement?.closest('input, textarea, [contenteditable]')) }));
mock.module(base+'controller.js', () => ({ myState, photoMode: false }));
mock.module(base+'build.js', () => ({ isEditing: () => false }));
mock.module(base+'ui.js', () => ({ isOverlayOpen: () => overlay }));
mock.module(base+'state.js', () => ({ state }));
mock.module(base+'world.js', () => ({ entities }));
mock.module(base+'colliders.js', () => ({ raySegment: () => occluded ? 0.5 : null }));
mock.module(base+'net.js', () => ({ net: { joined: true }, sendVerb: (...args: any[]) => uses.push(args) }));
const { tickInteraction } = await import('../client/lib/interaction.js');
const press = () => action('use');
tickInteraction(100);
const button = document.querySelector<HTMLButtonElement>('.ew-interaction')!;
assert.equal(button.hidden, false);
assert.match(button.textContent!, /Toggle lamp/);
assert.match(button.textContent!, /X \/ □/);
press(); action('cancel');
assert.deepEqual(uses, [['use', { id: 'lamp', action: 'toggle' }]]);
occluded = true; press(); tickInteraction(200); assert(button.hidden);
occluded = false;
myState.pos.z = 9; press(); tickInteraction(300); assert(button.hidden);
myState.pos.z = 1;
const input = document.createElement('input'); document.body.append(input); input.focus();
press(); tickInteraction(400); assert(button.hidden);
input.blur(); overlay = true; press(); overlay = false;
assert.equal(uses.length, 1);
entities.get('lamp')!.visible = false;
building = new THREE.Group();
tickInteraction(500); assert.match(button.textContent!, /Toggle lamp/);
assert.equal(button.hidden, false, 'a visible native chamber remains usable with its model anchor hidden');
button.click();
assert.equal(uses.length, 2);
assert.deepEqual(uses[1], ['use', { id: 'lamp', action: 'toggle' }]);
state.st.entities.lamp = { comp: { reactions: { push: { impulse: 0.3 } } } } as any;
press(); assert.deepEqual(uses[2], ['use', { id: 'lamp', action: 'push' }]);
state.st.entities.lamp = { comp: { reactions: { push: {}, pull: {} } } } as any;
tickInteraction(600); assert(button.hidden, 'multiple actions need an authored primary interaction');

// The prompt is a button you can click, and it must still never own the
// keyboard: a focused one swallowed every keydown before the window listener
// in controller.js saw it (all keyboard play dead until you clicked the
// canvas) and turned Enter into a `use` verb instead of chat.
assert.equal(button.tabIndex, -1, 'the prompt stays out of the tab order');
const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
button.dispatchEvent(down);
assert.equal(down.defaultPrevented, true, "mousedown's default IS the focus — declining it keeps the keyboard");
let keysSeen = 0;
const onKey = () => { keysSeen++; };
addEventListener('keydown', onKey);
button.focus();
button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, code: 'KeyW' }));
assert.equal(keysSeen, 1, 'a keydown over the prompt still reaches the window');
removeEventListener('keydown', onKey);
const before = uses.length;
button.click();
assert.notEqual(document.activeElement, button, 'clicking the prompt never leaves it focused');
assert.equal(uses.length, before, 'a blocked prompt still sends nothing');

console.log('Interaction control checks passed');
