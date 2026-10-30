// helm-leave-test.ts — getting up from a helm lets its hull go (client/lib/vehicles.js). updateHelm, the only place the
// drive state was cleared, runs only while I'm seated or being carried off a seat (main.js me-drive), so after an ordinary dismount the 'drive' handler
// still took the hull for mine: it dropped every relayed step of it (someone else driving it looked frozen here), and a
// later seat at its helm drove on from the stale pose.
// Headless, through the REAL client/lib/vehicles.js: the modules it imports that own the DOM, the network or the scene are
// stand-ins served from this file (a bun plugin's virtual namespace, as dismount-height-test does); three and
// shared/drive.js are real.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/helm-leave-test.ts
// Mutation (must go red): drop vehicles.js's bus.on('mount', …) line (rows HL1, HL2).
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
const THREE_PATH = fileURLToPath(new URL('../client/node_modules/three/build/three.module.js', import.meta.url));
const STUBS: Record<string, string> = {
  base: `const on = new Map(); export const CONFIG = { name: 'me' };
    export const bus = { on(e, f) { (on.get(e) ?? on.set(e, []).get(e)).push(f); }, emit(e, a) { for (const f of on.get(e) ?? []) f(a); } };
    globalThis.__hl.bus = bus;`,
  world: `import * as THREE from ${JSON.stringify(THREE_PATH)}; export const entities = new Map(); const bags = {};
    export const bagOf = (id) => bags[id] ?? null; globalThis.__hl.world = { entities, bags, THREE };`,
  mounts: `export const avatarMounts = new Map(); globalThis.__hl.avatarMounts = avatarMounts;`,
  net: `export const sendDrive = (...a) => globalThis.__hl.sent.push(a);`,
  controller: `export const keys = new Set(); globalThis.__hl.keys = keys;`,
  colliders: `export const reindexCollider = () => {};`,
};
plugin({
  name: 'helm-leave-stubs',
  setup(b) {
    b.onResolve({ filter: new RegExp(`^\\./(${Object.keys(STUBS).join('|')})\\.js$`) }, (a) => (a.importer.endsWith('vehicles.js') ? { path: a.path.slice(2, -3), namespace: 'hl-stub' } : undefined));
    b.onLoad({ filter: /.*/, namespace: 'hl-stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
  },
});
const G = globalThis as any; G.__hl = { sent: [] };

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); } else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); } };

const v: any = await import('../client/lib/vehicles.js');
const { bus, world, avatarMounts, keys } = G.__hl;
const { THREE } = world;
// a hull with drive at x 0, its helm a socket child that drives it
const hull = new THREE.Object3D(); hull.position.set(0, 0, 0); world.entities.set('hull', hull);
world.bags.hull = { drive: { maxSpeed: 4, turnRate: 0.4, climbRate: 4 } };
world.bags.helm = { parent: { to: 'hull' }, socket: { name: 'helm' }, station: { action: 'drive', input: { move: 'drive' } } };
const sit = () => { avatarMounts.set('me', { to: 'helm' }); bus.emit('mount', { id: 'me', to: 'helm' }); };
const getUp = () => { avatarMounts.delete('me'); bus.emit('mount', { id: 'me', to: null }); };   // as world.js setBodySeat does
const relayed = (x: number) => bus.emit('drive', { id: 'hull', pos: [x, 0, 0], q: [0, 0, 0, 1], by: 'someone' });

// control: at the helm, driving it, a relayed step of my own hull is dropped (my steps are the hull's here)
sit();
const atHelm = v.helmHull() === 'hull' && v.updateHelm(0.016) === true;
relayed(5);
check('HL0 (control) at the helm and driving, a relayed step of the hull is dropped: my driving owns it here', atHelm && Math.abs(hull.position.x - 5) > 1e-9, `atHelm ${atHelm}, x ${hull.position.x}`);

// HL1: I get up; updateHelm no longer runs (main.js calls it only while I'm seated or being carried off a seat); someone else drives the hull
getUp();
relayed(7);
check('HL1 got up from the helm, someone else\'s relayed drive of the hull moves it here', Math.abs(hull.position.x - 7) < 1e-9, `x ${hull.position.x}`);

// HL2: someone moved it while I was off; I sit at its helm again and drive one frame with no key: the hull stays where
// it is, not where I left it (a stale pose would snap it back to x ~0)
relayed(9);
sit(); keys.clear();
const n0 = G.__hl.sent.length; v.updateHelm(0.016);
const sentTo = G.__hl.sent.slice(n0).at(-1)?.[1];
check('HL2 …sitting at its helm again drives on from where the hull is, not from where I left it', Math.abs(hull.position.x - 9) < 0.05 && (!sentTo || Math.abs(sentTo[0] - 9) < 0.05), `x ${hull.position.x}, sent ${JSON.stringify(sentTo)}`);

console.log(`[helm-leave-test] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
