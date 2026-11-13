// particles-host-test — the ACTUAL browser host (client/lib/emitters.js) with a stand-in GPU half (particlefx.js
// buildEmitter) and real THREE transforms. Ported from upstream #256's host test to this protocol's shapes (an instance
// names an effect document; a thing carries one `particles`). What it pins:
//
//   1. `scale` is the emitter's own frame: set on the emitter group, composing with the thing's own scale, leaving `at`
//      a thing-frame offset (upstream's section 2, as it was);
//   2. several emitters: a stored document's emitters each build their own, with their own random stream, hung on one
//      group; an emitter lit and put out on its own is a CHILD thing's `particles` (the translator writes upstream's
//      particles:<name> that way), and it lives and dies apart from its host's;
//   3. a thing's removal / demotion / late arrival handles its emitter, with no hook growth and nothing leaked.
//
// Not ported (cannot exist here): upstream's section 1 (each preset override reaching makeParticles: a document's modules
// replace the override bag, and particlefx builds from the resolved document) and its particles:<name> keys (one
// particles per thing; see 2).
//
//   bun tools/particles-host-test.ts
import { mock } from 'bun:test';
// three by explicit client path (tools/core-stub.mjs's convention): the SAME module instance the client modules resolve.
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
// a stored document with two emitters (the world's `effect` request answers it)
const HEX = 'ab'.repeat(32);
const DOC = { kind: 'particle-effect', v: 1, name: 'hearth', reads: 'a hearth fire and its smoke', emitters: [
  { spawn: { amount: 40, lifetime: 1 }, size: { base: 0.3 }, render: { blend: 'add' } },
  { spawn: { amount: 20, lifetime: 3 }, size: { base: 0.6 }, forces: { gravity: [0, 0.5, 0] }, render: { blend: 'alpha' } }] };
const asked: string[] = [];
mock.module(`${base}core.js`, () => ({ THREE, scene }));
mock.module(`${base}base.js`, () => ({ bus }));
mock.module(`${base}world.js`, () => ({ entities, findPart: () => null }));
mock.module(`${base}assets.js`, () => ({ primeFiles: async () => {} }));
mock.module(`${base}net.js`, () => ({ sendRequest: async (verb: string, args: any) => { asked.push(`${verb}:${args?.name}`); return verb === 'effect' && args?.name === `sha256:${HEX}` ? { ok: true, effect: DOC } : { ok: false }; } }));
// the GPU half: one mesh per emitter, counted, with a dispose the host must call
const built: { name: string; seed: number; em: any; fx?: any }[] = [];
let disposed = 0;
mock.module(`${base}particlefx.js`, () => ({
  buildEmitter: (em: any, { seed, name }: { seed: number; name: string }) => {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()); mesh.name = name;
    let on = true;
    const fx = { mesh, update() {}, setEmitting(v: boolean) { on = v; }, get emitting() { return on; }, dispose() { disposed++; } };
    built.push({ name, seed, em, fx });
    return fx;
  },
}));

const hooks: Function[] = ((globalThis as any)._autoParticleSystems ||= []);
const { _registry: registry, clearEmitters, emitterCount } = await import('../client/lib/emitters.js');
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const comp = async (id: string, data: unknown) => { emit('comp', { id, type: 'particles', data }); await settle(); };
const groups = (root: THREE.Object3D) => root.children.filter((c) => c.userData.emitterOf);

// ---- 1. scale is the emitter's own frame ------------------------------------
console.log('\nscale — the emitter\'s frame, composing with the thing\'s\n');
const candle = new THREE.Group(); candle.position.set(1, 0.98, 2); candle.scale.setScalar(1.1); scene.add(candle);
entities.set('candle', candle);
await comp('candle', { effect: 'fire', at: [0, 0.11, 0], scale: 0.025, params: { size: 0.32, area: 0.03 } });
const flame = groups(candle)[0];
check('the emitter group carries the authored scale', flame?.scale.x === 0.025 && flame.scale.y === 0.025 && flame.scale.z === 0.025);
check('...`at` stays a thing-frame offset, unscaled by it', JSON.stringify(flame?.position.toArray()) === '[0,0.11,0]');
scene.updateMatrixWorld(true);
const ws = new THREE.Vector3(); flame?.getWorldScale(ws);
check('...and the thing\'s own scale composes on top (1.1 × 0.025)', Math.abs(ws.x - 0.0275) < 1e-9, String(ws.x));
const wp = new THREE.Vector3(); flame?.getWorldPosition(wp);
check('...placing it at the wick in world space', wp.distanceTo(new THREE.Vector3(1, 0.98 + 0.11 * 1.1, 2)) < 1e-9);
await comp('candle', { effect: 'fire', at: [0, 0.11, 0] });
check('no scale means scale 1 (an existing value renders exactly as before)', groups(candle)[0]?.scale.x === 1 && groups(candle).length === 1);

// ---- 2. several emitters ----------------------------------------------------
console.log('\nseveral emitters — one document\'s, and a child thing\'s\n');
const hearth = new THREE.Group(); hearth.position.set(5, 0, -2); scene.add(hearth);
entities.set('hearth', hearth);
const hooksBefore = hooks.length, builtBefore = built.length;
await comp('hearth', { effect: `sha256:${HEX}`, at: [0, 0.25, 0], seed: 42 });
check('a stored document is asked for once', asked.filter((a) => a === `effect:sha256:${HEX}`).length === 1, asked.join(', '));
check('...and when it lands, each of its emitters builds, on one group', built.length === builtBefore + 2 && groups(hearth).length === 1
  && groups(hearth)[0].children.length === 2, `${built.length - builtBefore} built`);
const [e0, e1] = built.slice(-2);
check('...each with its own random stream (two emitters, not one drawn twice)', e0.seed !== e1.seed && e0.seed === 42, `${e0.seed} ${e1.seed}`);
check('...each its own modules', e0.em.size.base === 0.3 && e1.em.size.base === 0.6);
check('one per-frame hook for the thing, however many emitters it has', hooks.length === hooksBefore + 1, `${hooks.length} vs ${hooksBefore}`);
// sparks lit and put out on their own: a child thing (parent: the hearth) with its own particles
const sparks = new THREE.Group(); hearth.add(sparks); entities.set('hearth-sparks', sparks);
const hostGroup = groups(hearth)[0];
await comp('hearth-sparks', { effect: 'sparks', at: [0, 0.3, 0], params: { count: 40 } });
check('a child thing\'s emitter hangs off the child', groups(sparks).length === 1 && groups(hearth)[0] === hostGroup);
await comp('hearth-sparks', { effect: 'embers' });
check('replacing it rebuilds only that one', groups(hearth)[0] === hostGroup && groups(sparks).length === 1);
await comp('hearth-sparks', null);
check('putting it out leaves the hearth burning', groups(sparks).length === 0 && groups(hearth)[0] === hostGroup);
const before = built.length;
await comp('hearth', { effect: `sha256:${HEX}`, at: [0, 0.25, 0], seed: 42 });
check('an identical re-author is idempotent (no rebuild, no extra hook)', built.length === before && hooks.length === hooksBefore + 1);
await comp('hearth', { effect: `sha256:${HEX}`, at: [0, 0.25, 0], seed: 42, playing: false });
check('playing off stops spawning without a rebuild', built.length === before && groups(hearth)[0] === hostGroup
  && e0.fx.emitting === false && e1.fx.emitting === false);

// ---- 3. the thing's lifecycle takes its emitter -----------------------------
console.log('\nlifecycle — removal, demotion, promotion, a late joiner\n');
emit('entity', { id: 'hearth', kind: 'demote' });
check('demotion retires the emitter', groups(hearth).length === 0 && !registry.has('hearth'));
const stand = new THREE.Group(); entities.set('hearth', stand);
emit('entity', { id: 'hearth', kind: 'spawn' });
await comp('hearth', { effect: 'fire' });
check('promotion re-announces and rebuilds on the new subtree', groups(stand).length === 1);
emit('entity', { id: 'hearth', kind: 'remove' });
check('removal retires it', groups(stand).length === 0 && !registry.has('hearth'));

// a late joiner: the component folds before the GLB lands
entities.set('lantern', null);
await comp('lantern', { effect: 'magic' });
check('an emitter waits for its thing instead of burning at the world origin', !registry.has('lantern')
  && !scene.children.some((c) => c.userData?.emitterOf === 'lantern'));
const lantern = new THREE.Group(); entities.set('lantern', lantern);
emit('entity', { id: 'lantern', kind: 'spawn' }); await settle();
check('...and attaches when it arrives', groups(lantern).length === 1);

clearEmitters();
check('world teardown takes every emitter and every hook back', emitterCount() === 0
  && hooks.length === 0 && groups(hearth).length + groups(candle).length + groups(lantern).length === 0, `${emitterCount()} ${hooks.length}`);
check('...disposing what each built', disposed === built.length, `${disposed} disposed of ${built.length} built`);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
