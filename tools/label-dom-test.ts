// Real fold + real THREE transforms + actual DOM events; no GPU or live world.
// Regression: production folded entity values have no `id` property.
import { mock } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { strict as assert } from 'node:assert';
// three by explicit client path, not a bare specifier: tools/ sits outside
// client/, where the install lives, so this is the SAME module instance the
// client modules under test receive through the core.js mock below — a second
// copy would fail every instanceof against the first — and the test stops
// depending on a root install being present (tools/core-stub.mjs).
import * as THREE from '../client/node_modules/three/build/three.module.js';
GlobalRegistrator.register({ url: 'http://example.test/' });
const canvas = document.createElement('canvas');
canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 390, height: 844 } as DOMRect);
Object.assign(globalThis, { innerWidth: 390, innerHeight: 844 });
const camera = new THREE.PerspectiveCamera(60, 390 / 844, 0.1, 100);
camera.position.set(0, 2, 8); camera.lookAt(0, 1, 0); camera.updateMatrixWorld();
const entities = new Map();
let rayCount = 0;
// Occlusion is steered from the test: `blocked` names the ids whose sight line
// reports a hit, and `rayExcludes` records the excludeId every call was given.
const blocked = new Set<string>();
const rayExcludes: (string | null)[] = [];
const base = `${import.meta.dir}/../client/lib/`;
mock.module(`${base}core.js`, () => ({ THREE, camera, renderer: { domElement: canvas } }));
mock.module(`${base}world.js`, () => ({ entities }));
mock.module(`${base}colliders.js`, () => ({
  raySegment: (_origin: unknown, _dir: unknown, _far: number, excludeId: string | null = null) => {
    rayCount++;
    rayExcludes.push(excludeId);
    return blocked.has(excludeId!) ? { id: 'wall', t: 1 } : null;
  },
}));
mock.module(`${base}inspect.js`, () => ({ registerEditor: () => {} }));
const { CONFIG } = await import('../client/lib/base.js');
const { state, hydrate, foldLive } = await import('../client/lib/state.js');
const { emptyState, foldEntry } = await import('../shared/fold.js');
const { configureObjectLabels, initObjectLabels, tickObjectLabels } = await import('../client/lib/objectlabels.js');
const snapshot = emptyState();
let seq = 0;
const entry = (verb: string, args: object) => ({ verb, args, seq: ++seq, actor: 'fixture', ts: seq });
foldEntry(snapshot, entry('spawn', { id: 'landmark', lib: 'fixture.glb', pos: [0, 0, 0] }));
foldEntry(snapshot, entry('comp', { id: 'landmark', type: 'label', data: { name: 'Library', description: 'A quiet place to read.' } }));
assert.equal(snapshot.entities.landmark.id, undefined, 'fixture follows actual fold schema');
hydrate(snapshot);
const object = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
entities.set('landmark', object);
assert.equal(CONFIG.objectLabels, 'off');
localStorage.setItem('ew-object-labels', 'all');
initObjectLabels(); tickObjectLabels(1000);
assert.equal(document.querySelector('.ew-object-labels'), null, 'standalone defaults off even with legacy preference');
configureObjectLabels({ mode: 'nearby' }); tickObjectLabels(1100);
const visible = () => [...document.querySelectorAll<HTMLButtonElement>('.ew-object-labels button')].filter(button => !button.hidden);
assert.equal(visible().length, 1, 'real folded entity resolves its rendered object');
assert.equal(visible()[0].textContent, 'Library');
assert.equal(visible()[0].dataset.entityId, 'landmark');
visible()[0].click();
const panel = document.querySelector<HTMLElement>('.ew-object-detail')!;
assert.equal(panel.hidden, false);
assert.match(panel.textContent!, /A quiet place to read/);
assert(!panel.textContent!.includes('fixture.glb'), 'ordinary details omit implementation paths');
const before = JSON.stringify(state.st);
const x = visible()[0].style.left;
object.position.x = 1;
tickObjectLabels(1200);
assert.notEqual(visible()[0].style.left, x, 'anchor follows live motion without a world write');
assert.equal(JSON.stringify(state.st), before);
// A real component update refreshes semantic identity without replacing the model.
foldLive(entry('comp', { id: 'landmark', type: 'label', data: { name: '<img src=x onerror=alert(1)>', description: 'Renamed' } }));
tickObjectLabels(1300);
assert.equal(panel.querySelector('img'), null);
assert.match(panel.textContent!, /Renamed/);
configureObjectLabels({ mode: 'off' }); tickObjectLabels(1400);
assert.equal(visible().length, 0);
assert.equal(panel.hidden, false, 'hiding floating labels keeps selected details usable');
const rays = rayCount; tickObjectLabels(1500); assert.equal(rayCount, rays, 'off does no spatial work');
configureObjectLabels({ mode: 'all' });
foldLive(entry('comp', { id: 'landmark', type: 'label', data: { name: 'Library', visibility: 'inspect' } }));
tickObjectLabels(1600); assert.equal(visible().length, 1);
for (let i = 0; i < 3; i++) { hydrate(state.st); configureObjectLabels({ mode: 'all' }); }
assert.equal(document.querySelectorAll('.ew-object-labels').length, 1);
assert.equal(document.querySelectorAll('.ew-object-labels button').length, 32);
foldLive(entry('remove', { id: 'landmark' })); tickObjectLabels(1700);
assert.equal(visible().length, 0); assert.equal(panel.hidden, true);
assert.equal(document.querySelector('select'), null, 'no detached object list or pick mode');

// An authored offset is the ONLY anchor a geometry-less marker has: a bare
// Group measures empty, and measuring it first skipped the entity entirely,
// so the one case offset exists for was the one case that never rendered.
foldEntry(snapshot, entry('spawn', { id: 'marker', lib: 'marker.glb', pos: [0, 0, 0] }));
foldEntry(snapshot, entry('comp', { id: 'marker', type: 'label', data: {
  name: 'Meeting point', visibility: 'always', offset: [0, 3, 0] } }));
hydrate(snapshot);
entities.set('marker', new THREE.Group());        // no geometry: bounds are empty
configureObjectLabels({ mode: 'nearby' });
tickObjectLabels(1800);
// (re-hydrating the snapshot restores landmark too, so address the marker by id)
const marker = () => visible().find(button => button.dataset.entityId === 'marker');
assert.ok(marker(), 'an authored offset needs no bounds of its own');
assert.equal(marker()!.textContent, 'Meeting point');

// ...and it is used exactly as authored: no clearance bump on top of it.
const marked = new THREE.Vector3(0, 3, 0).project(camera);
const expected = (1 - marked.y) * 844 / 2;
assert.ok(Math.abs(parseFloat(marker()!.style.top) - expected) < 0.5,
  `offset is the anchor, unbumped: ${marker()!.style.top} vs ${expected}`);

// A focused plaque must not eat the world's keys. These are <button>s, the
// mouse used to focus them, and the overlay stopped EVERY keydown -- so one
// click on a label killed W/A/S/D until the user clicked the canvas again.
const heard: string[] = [];
const onKey = (event: KeyboardEvent) => heard.push(event.key);
globalThis.addEventListener('keydown', onKey);
const focused = marker()!;
focused.focus();
assert.equal(document.activeElement, focused, 'plaques stay keyboard-focusable');
const press = (key: string, code: string) => focused.dispatchEvent(
  new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }));
press('w', 'KeyW'); press('a', 'KeyA'); press('Shift', 'ShiftLeft');
assert.deepEqual(heard, ['w', 'a', 'Shift'], 'movement keys reach window through a focused plaque');
heard.length = 0;
press('Enter', 'Enter'); press(' ', 'Space'); press('Escape', 'Escape');
assert.deepEqual(heard, [], 'the keys the overlay consumes stop at the overlay');
globalThis.removeEventListener('keydown', onKey);
// ...and the mouse never parks focus on a plaque in the first place.
focused.blur();
const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
focused.dispatchEvent(down);
assert.equal(down.defaultPrevented, true, 'a mouse press on a plaque is not allowed to focus it');
focused.focus();
focused.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
assert.notEqual(document.activeElement, focused, 'a mouse-driven activation leaves no focus behind');

// ---- overlap suppression and the viewport clamp -----------------------------
const mesh = (x: number, y: number, z: number) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  m.position.set(x, y, z);
  m.updateMatrixWorld();
  return m;                      // anchor lands 0.7m above position: top + 0.2
};
const twins = emptyState();
for (const id of ['twinA', 'twinB']) {
  foldEntry(twins, entry('spawn', { id, lib: 'fixture.glb', pos: [0, 1, 0] }));
  foldEntry(twins, entry('comp', { id, type: 'label', data: { name: `Twin ${id.slice(-1)}` } }));
}
hydrate(twins);
entities.clear();
entities.set('twinA', mesh(0, 1, 0));
entities.set('twinB', mesh(0.05, 1, 0));   // same screen box as twinA
configureObjectLabels({ mode: 'nearby' });
tickObjectLabels(2000);
assert.equal(visible().length, 1, 'two labels in one screen box render as one plaque, not stacked text');
const twinB = entities.get('twinB');
twinB.position.x = 1.2; twinB.updateMatrixWorld();   // clear of twinA's box
tickObjectLabels(2100);
assert.equal(visible().length, 2, 'separated labels both render, so the suppression is about the boxes');

// ---- plaque identity survives a distance reorder ----------------------------
const trio = emptyState();
const seats: Record<string, [number, number, number]> = { A: [0, 0.5, 4], B: [0, 1.5, 0], C: [0, 2.5, -4] };
for (const [id, pos] of Object.entries(seats)) {
  foldEntry(trio, entry('spawn', { id, lib: 'fixture.glb', pos }));
  foldEntry(trio, entry('comp', { id, type: 'label', data: { name: id } }));
}
hydrate(trio);
entities.clear();
for (const [id, [x, y, z]] of Object.entries(seats)) entities.set(id, mesh(x, y, z));
configureObjectLabels({ mode: 'all' });   // C sits a hair past the 12m nearby ring
tickObjectLabels(2400);
const buttonById = () => new Map(visible().map(button => [button.dataset.entityId!, button]));
const distOf = (id: string) => entities.get(id).getWorldPosition(new THREE.Vector3()).distanceTo(camera.position);
const seated = buttonById();
assert.equal(seated.size, 3, 'three separated labels each get a plaque');
assert.ok(distOf('A') < distOf('C'), 'A starts nearest');
camera.position.set(0, 2, -8); camera.lookAt(0, 1, 0); camera.updateMatrixWorld();
tickObjectLabels(2500);
const reseated = buttonById();
assert.ok(distOf('C') < distOf('A'), 'the camera move really did reverse the distance order');
assert.equal(reseated.size, 3, 'all three still render after the reorder');
for (const [id, button] of seated) {
  assert.equal(reseated.get(id), button, `the plaque for ${id} is reused without changing its entity identity`);
}

// ---- occlusion hides exactly the blocked label ------------------------------
blocked.add('B');
rayExcludes.length = 0;
tickObjectLabels(2600);   // 100ms on from the last sample: sight lines re-cast
assert.ok(rayExcludes.includes('B'), 'the sight-line query passes the labelled object as its own excludeId');
assert.deepEqual(visible().map(button => button.dataset.entityId).sort(), ['A', 'C'],
  'a blocked sight line hides that plaque and only that plaque');
blocked.clear();
tickObjectLabels(2700);
assert.equal(visible().length, 3, 'clearing the obstruction brings it back');

console.log('label DOM: real fold identity, default off, click details, motion, rename, removal, replay, authored offsets, keyboard passthrough, overlap suppression, plaque identity, occlusion and no world writes passed');
GlobalRegistrator.unregister();
