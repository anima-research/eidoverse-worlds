// particles-host-test — the ACTUAL browser host (client/lib/emitters.js) with a
// stand-in GPU builder and real THREE transforms. What it pins:
//
//   1. every authored motion/look knob reaches makeParticles as a preset
//      override, and nothing the host owns leaks into it;
//   2. `scale` is the emitter's own frame — set on the emitter mesh, composing
//      with the entity's scale, leaving the origin an entity-frame offset;
//   3. several emitters per entity (`particles`, `particles:<name>`) live and
//      die independently, and an entity's removal / demotion / late arrival
//      handles all of them, with no hook growth and nothing leaked.
//
//   bun tools/particles-host-test.ts
import { mock } from 'bun:test';
// three by explicit client path (tools/core-stub.mjs's convention): the SAME
// module instance the client modules under test resolve.
import * as THREE from '../client/node_modules/three/build/three.module.js';

let passed = 0, failed = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const handlers = new Map<string, Function[]>();
const bus = { on(k: string, f: Function) { handlers.set(k, [...(handlers.get(k) ?? []), f]); } };
const emit = (k: string, v: unknown) => handlers.get(k)?.forEach((f) => f(v));
const entities = new Map<string, THREE.Object3D | null>();
const scene = new THREE.Scene();
const base = `${import.meta.dir}/../client/lib/`;
mock.module(`${base}core.js`, () => ({ THREE, scene }));
mock.module(`${base}base.js`, () => ({ bus }));
mock.module(`${base}world.js`, () => ({ entities, findPart: () => null }));
mock.module(`${base}assets.js`, () => ({ loadEidoModule: async () => {}, primeFiles: async () => {} }));

// The upstream builder as it behaves today: adds its mesh to the scene, pushes
// its billboard update into the global array, hands back no dispose.
const hooks: Function[] = [];
(globalThis as any)._autoParticleSystems = hooks;
const calls: any[] = [];
let disposed = 0;
(globalThis as any).makeParticles = (opts: any) => {
  calls.push(opts);
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  mesh.name = opts.name;
  mesh.geometry.addEventListener('dispose', () => disposed++);
  const update = () => {};
  hooks.push(update); (opts.scene ?? scene).add(mesh);
  return { mesh, update };
};

const { _registry: registry, clearEmitters, emitterCount } = await import('../client/lib/emitters.js');
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const comp = async (id: string, type: string, data: unknown) => { emit('comp', { id, type, data }); await settle(); };
const meshes = (root: THREE.Object3D) => root.children.filter((c) => c.userData.emitterOf);
const byKey = (root: THREE.Object3D, key: string) => root.children.find((c) => c.userData.emitterKey === key);

// ---- 1. overrides reach the builder -----------------------------------------
console.log('\noverrides — the preset is a starting point\n');
const hearth = new THREE.Group(); hearth.position.set(5, 0, -2); scene.add(hearth);
entities.set('hearth', hearth);
await comp('hearth', 'particles', {
  preset: 'fire', origin: [0, 0.25, 0], size: 0.4, wobble: 0.05, up: 0.3, spread: 0.1, grow: -0.2,
  swirl: 0.5, twinkle: 0.3, converge: 0.9, rotate: 0.2, gravity: 0.8, color: '#ffcc88', blending: 'additive',
});
const fireOpts = calls.at(-1);
check('the builder saw the preset and every authored override',
  fireOpts?.preset === 'fire' && fireOpts.size === 0.4 && fireOpts.wobble === 0.05 && fireOpts.up === 0.3
  && fireOpts.spread === 0.1 && fireOpts.grow === -0.2 && fireOpts.swirl === 0.5 && fireOpts.twinkle === 0.3
  && fireOpts.converge === 0.9 && fireOpts.rotate === 0.2 && fireOpts.color === 0xffcc88 && fireOpts.blending === 'additive',
  JSON.stringify(fireOpts));
check('a vertical gravity arrives as the [x, y, z] the builder indexes',
  JSON.stringify(fireOpts?.gravity) === '[0,0.8,0]');
check('the builder never sees scale, quality or the authored origin (the host owns those)',
  fireOpts && !('scale' in fireOpts) && !('quality' in fireOpts) && JSON.stringify(fireOpts.origin) === '[0,0,0]');
await comp('hearth', 'particles', { preset: 'smoke' });
check('an untouched preset passes no overrides (it IS the preset)',
  ['size', 'wobble', 'gravity', 'color', 'blending', 'up'].every((k) => !(k in calls.at(-1))));

// ---- 2. scale is the emitter's own frame ------------------------------------
console.log('\nscale — the emitter\'s frame, composing with the entity\'s\n');
const candle = new THREE.Group(); candle.position.set(1, 0.98, 2); candle.scale.setScalar(1.1); scene.add(candle);
entities.set('candle', candle);
await comp('candle', 'particles', { preset: 'fire', origin: [0, 0.11, 0], scale: 0.025, size: 0.32, area: 0.03 });
const flame = byKey(candle, 'particles')!;
check('the emitter mesh carries the authored scale', flame?.scale.x === 0.025 && flame.scale.y === 0.025 && flame.scale.z === 0.025);
check('...the origin stays an entity-frame offset, unscaled by it', JSON.stringify(flame?.position.toArray()) === '[0,0.11,0]');
scene.updateMatrixWorld(true);
const ws = new THREE.Vector3(); flame?.getWorldScale(ws);
check('...and the entity\'s own scale composes on top (1.1 × 0.025)', Math.abs(ws.x - 0.0275) < 1e-9, String(ws.x));
const wp = new THREE.Vector3(); flame?.getWorldPosition(wp);
check('...placing it at the wick in world space', wp.distanceTo(new THREE.Vector3(1, 0.98 + 0.11 * 1.1, 2)) < 1e-9);
await comp('candle', 'particles', { preset: 'fire', origin: [0, 0.11, 0] });
check('no scale means scale 1 (an existing bag renders exactly as before)', byKey(candle, 'particles')?.scale.x === 1);

// ---- 3. several emitters per entity -----------------------------------------
console.log('\nseveral emitters — one entity, independent lifecycles\n');
const hooksBefore = hooks.length;
await comp('hearth', 'particles', { preset: 'fire', origin: [0, 0.25, 0] });
await comp('hearth', 'particles:smoke', { preset: 'smoke', origin: [0, 0.8, 0], gravity: 0.6 });
await comp('hearth', 'particles:sparks', { preset: 'sparks', origin: [0, 0.3, 0], count: 40 });
check('three emitters hang off one entity', meshes(hearth).length === 3, String(meshes(hearth).length));
check('each knows its own key', ['particles', 'particles:smoke', 'particles:sparks'].every((k) => byKey(hearth, k)));
check('named builds are told apart in the scene graph', byKey(hearth, 'particles:smoke')?.name === 'particles_hearth_smoke_smoke');
check('one per-frame hook per emitter, no more', hooks.length === hooksBefore + 2, `${hooks.length} vs ${hooksBefore}`);
const fireMesh = byKey(hearth, 'particles');
await comp('hearth', 'particles:smoke', { preset: 'dust', origin: [0, 0.8, 0] });
check('replacing one emitter rebuilds only that one', byKey(hearth, 'particles') === fireMesh
  && calls.at(-1).preset === 'dust' && meshes(hearth).length === 3);
await comp('hearth', 'particles:sparks', null);
check('putting out one leaves the others burning', !byKey(hearth, 'particles:sparks') && meshes(hearth).length === 2
  && byKey(hearth, 'particles') === fireMesh);
const before = calls.length;
await comp('hearth', 'particles:two words', { preset: 'fire' });
check('a malformed emitter key builds nothing', calls.length === before && meshes(hearth).length === 2);
await comp('hearth', 'particles:smoke', { preset: 'dust', origin: [0, 0.8, 0] });
check('an identical re-author is idempotent (no rebuild, no extra hook)', calls.length === before);

// lifecycle of the entity takes ALL its emitters
emit('entity', { id: 'hearth', kind: 'demote' });
check('demotion retires every emitter on the entity', meshes(hearth).length === 0 && registry.slotsOf('hearth').length === 0);
const stand = new THREE.Group(); entities.set('hearth', stand);
emit('entity', { id: 'hearth', kind: 'spawn' });
await comp('hearth', 'particles', { preset: 'fire' });
await comp('hearth', 'particles:smoke', { preset: 'smoke' });
check('promotion re-announces and rebuilds them all on the new subtree', meshes(stand).length === 2);
emit('entity', { id: 'hearth', kind: 'remove' });
check('removal retires them all', meshes(stand).length === 0 && registry.slotsOf('hearth').length === 0);

// a late joiner: comps fold before the GLB lands
entities.set('lantern', null);
await comp('lantern', 'particles', { preset: 'magic' });
await comp('lantern', 'particles:glow', { preset: 'stars', area: 0.01 });
check('emitters wait for their entity instead of burning at the world origin', registry.slotsOf('lantern').length === 0
  && !scene.children.some((c) => c.userData?.emitterOf === 'lantern'));
const lantern = new THREE.Group(); entities.set('lantern', lantern);
emit('entity', { id: 'lantern', kind: 'spawn' }); await settle();
check('...and all of them attach when it arrives', meshes(lantern).length === 2);

clearEmitters();
check('world teardown takes every emitter and every hook back', emitterCount() === 0
  && hooks.length === 0 && meshes(hearth).length + meshes(candle).length + meshes(lantern).length === 0);
check('...disposing what each built', disposed === calls.length, `${disposed} disposed of ${calls.length} built`);

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
