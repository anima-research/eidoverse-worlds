// bun tools/particle-parts-test.ts — actual browser host, real Object3D
// transforms, mocked GPU builder; advisory lint uses a named geometry fixture.
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as THREE from 'three';
import { normalizeParticles, describeParticles } from '../shared/particles.js';

const handlers = new Map<string, Function[]>();
const bus = { on(k: string, f: Function) { handlers.set(k, [...(handlers.get(k) ?? []), f]); } };
const emit = (k: string, v: unknown) => handlers.get(k)?.forEach(f => f(v));
const entities = new Map<string, THREE.Object3D>();
const scene = new THREE.Scene();
const base = `${import.meta.dir}/../client/lib/`;
mock.module(`${base}core.js`, () => ({ THREE, scene }));
mock.module(`${base}base.js`, () => ({ bus }));
mock.module(`${base}world.js`, () => ({ entities, findPart(root: THREE.Object3D, name: string) {
  let found: THREE.Object3D | null = null;
  root.traverse(c => { if (!found && c !== root && c.name === name) found = c; });
  return found;
} }));
mock.module(`${base}assets.js`, () => ({ loadEidoModule: async () => {}, primeFiles: async () => {} }));
const hooks: Function[] = [];
(globalThis as any)._autoParticleSystems = hooks;
let disposed = 0;
(globalThis as any).makeParticles = () => {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  mesh.geometry.addEventListener('dispose', () => disposed++);
  const update = () => {};
  hooks.push(update); scene.add(mesh);
  return { mesh, update };
};
const { _registry: registry, clearEmitters } = await import('../client/lib/emitters.js');
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const apply = async (part?: unknown) => {
  emit('comp', { id: 'lantern', type: 'particles', data: { preset: 'fire', origin: [0, .05, 0], ...(part === undefined ? {} : {part}) } });
  await settle();
};
const root = new THREE.Group(); root.position.set(4, 1, -3); scene.add(root);
const arm = new THREE.Group(); arm.position.set(2, 0, 0); arm.rotation.z = Math.PI / 2; root.add(arm);
const wax = new THREE.Group(); wax.name = 'wax'; wax.position.set(0, 3, 0); arm.add(wax);
entities.set('lantern', root);
await apply('wax');
const mesh = wax.children[0];
assert(mesh, 'emitter attaches to named nested node');
assert.deepEqual(mesh.position.toArray(), [0, .05, 0]);
scene.updateMatrixWorld(true);
assert(mesh.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(2.95, 1, -3)) < 1e-6);
arm.rotation.z = 0; root.position.x = 10;
scene.updateMatrixWorld(true);
assert(mesh.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(12, 4.05, -3)) < 1e-6, 'motion and entity movement compose');
await apply('wax'); assert.equal(hooks.length, 1, 'identical replay is idempotent');
await apply('missing'); assert.equal(wax.children.length, 0); assert.equal(hooks.length, 1);
assert(root.children.some(c => c.userData.emitterOf === 'lantern'), 'unknown part uses entity frame');
await apply(); assert.equal(hooks.length, 1, 'legacy entity emitter remains supported');
emit('entity', {id: 'lantern', kind: 'demote'}); assert.equal(hooks.length, 0);
const replacement = new THREE.Group(); const newWax = new THREE.Group(); newWax.name = 'wax'; replacement.add(newWax);
entities.set('lantern', replacement); emit('entity', {id: 'lantern', kind: 'spawn'});
await apply('wax'); assert.equal(newWax.children.length, 1, 'promotion resolves the replacement subtree');
emit('comp', {id: 'lantern', type: 'particles', data: null}); await settle(); assert.equal(hooks.length, 0);
entities.delete('lantern'); await apply('wax'); assert.equal(hooks.length, 0, 'late join waits for model');
entities.set('lantern', replacement); emit('entity', {id: 'lantern', kind: 'spawn'}); await settle();
assert.equal(newWax.children.length, 1, 'deferred model resolves part');
clearEmitters(); assert.equal(hooks.length, 0); assert.equal(newWax.children.length, 0); assert.equal(disposed, 5);

for (const part of ['', ' ', 7, {}, 'x'.repeat(257)]) {
  const r = normalizeParticles({preset: 'fire', part});
  assert(r.ok && !r.emitter.part && r.notes.some(n => n.includes('part')));
}
const normalized = normalizeParticles({preset:'fire', part:'wax'});
assert(normalized.ok && normalized.emitter.part === 'wax' && normalized.notes.length === 0);
assert(describeParticles({preset:'fire',part:'wax'}).includes('declared part "wax"'));
assert(describeParticles({preset:'fire',part:'missing'}).includes('fallback if unavailable'));

// Lint remains advisory and uses the rendered-node summary (orphans excluded).
const dir = mkdtempSync(join(tmpdir(), 'particle-parts-'));
writeFileSync(join(dir, 'fixture.glb'), 'fixture');
mock.module(`${import.meta.dir}/../server/config.ts`, () => ({OPT_DIR:dir, LIBRARY_DIR:dir}));
mock.module(`${import.meta.dir}/../server/geometry.ts`, () => ({ summarizeGlb: async () => ({nodeNames:['wax'], nodes:[], orphans:['orphan']}) }));
const {lintParticles} = await import('../server/lint.ts');
const findings: any[] = [];
const world: any = {state:{entities:{lantern:{lib:'fixture.glb'}}}, debug:(kind:string,detail:any)=>findings.push({kind,...detail})};
const lint = async (part:string) => {lintParticles(world,{verb:'comp',args:{id:'lantern',type:'particles',data:{preset:'fire',part}},actor:'builder'} as any); await settle();};
await lint('wax'); assert.equal(findings.length,0);
await lint('orphan'); assert.equal(findings.length,1); assert(findings[0].why.includes('orphan') && findings[0].why.includes('entity frame'));
assert.equal(findings[0].kind,'particles-lint');
world.state.entities.lantern.lib = 'absent.glb'; await lint('wax'); assert(findings[1].why.includes('geometry is unavailable'));
console.log('particle part transforms, fallback, replay/lifecycle, normalization, perception and lint passed');
