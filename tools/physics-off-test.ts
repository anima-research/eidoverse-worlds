// physics-off-test.ts — the per-client "object physics off" switch (R 10-28, item 33; main's ew-phys): off, this browser
// folds and draws no flights (things stand at their committed poses, colliders kept) and remembers the choice; on again,
// flights are drawn. Headless, through the real client/lib/thingphysics.js over put-settle-test's stubs, with a stand-in
// presentation copy (one body in the air) for the replica's sim.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/physics-off-test.ts
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const STUB = here('./put-settle-stub.mjs');
plugin({
  name: 'physics-off-stubs',
  setup(b) {
    b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
    for (const m of ['world', 'remotes', 'colliders', 'autohooks', 'bodyscale', 'net', 'ui', 'chat', 'actions', 'emitters', 'serverclock', 'plainwords', 'markup', 'xrask'])
      b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: STUB }));
  },
});
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); } };

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`); };

const S: any = await import('./put-settle-stub.mjs');
const { THREE } = await import('./core-stub.mjs');
const { bus }: any = await import('../client/lib/base.js');
const tp: any = await import('../client/lib/thingphysics.js');
const me = { root: new THREE.Object3D(), vrm: null };
tp.initThingPhysics({ myPos: () => me.root.position, me: () => me, camera: null, editing: () => false, myState: () => ({ yaw: 0 }) });
const frame = () => { for (const fn of S.hostHooks) fn(5000); };
const crate = new THREE.Group(); new THREE.Scene().add(crate); S.entities.set('crate', crate);
S.replica.st.entities.crate = { c: { physics: { kind: 'dynamic' } } };
// a flight: the canonical sim has the crate in the air; its copy (simClone) is drawn. tick far ahead: nothing to advance
let clones = 0;
S.replica.sim = { sim: { bodies: { crate: {} } }, launched: { crate: 1 }, foreign: false };
S.replica.simVersion = 1;
S.replica.simClone = () => { clones++; return { bodies: { crate: { p: [5, 1, 5], resting: false } }, epoch: { ts: 0, tickMs: 66 }, tick: 1e9, terrain: {} }; };
const reverted: string[] = []; bus.on('pose-revert', ({ id }: any) => { reverted.push(id); crate.position.set(0, 0, 0); });

check('on by default (nothing stored)', tp.physicsEnabled() === true);
frame();
check('on: the flight is drawn where the engine has it, its collider sat out', crate.position.x === 5 && crate.position.y === 1 && S.suspended.has('crate'), JSON.stringify([crate.position.toArray(), [...S.suspended]]));
tp.setPhysicsEnabled(false);
check('switched off mid-flight: drawn back at its committed pose, collider back', reverted.includes('crate') && crate.position.x === 0 && !S.suspended.has('crate'), JSON.stringify([reverted, crate.position.toArray(), [...S.suspended]]));
check('…and the choice is kept on this device (ew-phys)', store.get('ew-phys') === '0');
const c0 = clones; S.replica.simVersion = 2; frame(); frame();
check('off: no copy of the sim is folded or drawn; the thing stays at its committed pose', clones === c0 && crate.position.x === 0 && !S.suspended.has('crate'), JSON.stringify({ clones: clones - c0, at: crate.position.toArray() }));
// my own body's track (thingphysics tickTrack, a real-clock 200 ms tick) isn't about things' physics: counting it made this row load-dependent
const thingSends = S.sent.filter(([v]: any) => v !== 'move');
check('…and nothing was sent (harmless to everyone else)', thingSends.length === 0, JSON.stringify(thingSends));
tp.setPhysicsEnabled(true); frame();
check('on again: the flight is drawn again', crate.position.x === 5 && clones > c0 && store.get('ew-phys') === '1', JSON.stringify([crate.position.toArray(), clones - c0]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
