// clickuse-test.ts — the mouse on things while holding one (R 10-17 20:26, live in the gym): right-clicking the crate she held
// still offered "pick up" beside "put down", and right-clicking the desk while holding a crate offered nothing to put it on.
// Headless, through the real client/lib/clickuse.js: every module it reaches that owns a renderer, the DOM or the network is
// a stand-in served from this file (a bun plugin's virtual namespace); three and shared/ are real, so thingAt and aimPoint
// raycast real meshes.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/clickuse-test.ts
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
const THREE_PATH = fileURLToPath(new URL('../client/node_modules/three/build/three.module.js', import.meta.url));
const STUBS: Record<string, string> = {
  core: `import * as THREE from ${JSON.stringify(THREE_PATH)}; export { THREE };
    export const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 100); camera.position.set(0, 1.6, 0); camera.lookAt(0, 0.4, -3); camera.updateMatrixWorld(true);
    const L = {}; export const canvas = { style: {}, addEventListener: (k, f) => { (L[k] ??= []).push(f); }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }), _fire: (k, e) => { for (const f of L[k] ?? []) f(e); } };
    globalThis.__cu.core = { THREE, camera, canvas };`,
  myview: `export const outOfMyView = () => false;`,
  world: `export const entities = new Map(); export const bags = {}; export const bagOf = (id) => bags[id]; export const socketsOn = () => []; globalThis.__cu.world = { entities, bags };`,
  panels: `export const menus = []; export function contextMenu(x, y, items) { menus.push(items); } export function closeContextMenu() {} globalThis.__cu.panels = { menus };`,
  ui: `export const flashHint = () => {};`,
  xrask: `export const xrActive = () => false;`,
  plainwords: `export const nameOf = (id) => id;`,
  thingphysics: `export const held = []; export const calls = [];
    export const physicsApi = { mine: () => held.slice(), grabbable: (id) => (id === 'crate' || id === 'ball' ? { enabled: true } : null), inReach: () => true, whereFromMe: () => null,
      grab: (id) => calls.push(['grab', id]), put: (id, at) => calls.push(['put', id, at]), throw: () => calls.push(['throw']), punt: () => {}, canPunt: () => true, canPutAt: () => true };
    globalThis.__cu.tp = { held, calls };`,
  useprompt: `export const actionsOf = () => []; export const useThing = () => {};`,
  localbody: `export const trySitOn = () => {};`,
  controller: `export const walkTo = async () => 'arrived'; export const clampToBounds = (x, z) => [x, z];`,
};
plugin({
  name: 'clickuse-stubs',
  setup(b) {
    b.onResolve({ filter: new RegExp(`^\\./(${Object.keys(STUBS).join('|')})\\.js$`) }, (a) => (a.importer.endsWith('clickuse.js') ? { path: a.path.slice(2, -3), namespace: 'cu-stub' } : undefined));
    b.onLoad({ filter: /.*/, namespace: 'cu-stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
  },
});
(globalThis as any).__cu = {};
(globalThis as any).document ??= { pointerLockElement: null };
const winL: Record<string, Function[]> = {}; (globalThis as any).addEventListener = (k: string, f: Function) => { (winL[k] ??= []).push(f); };

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); } else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); } };

const cu: any = await import('../client/lib/clickuse.js');
const { core, world, panels, tp } = (globalThis as any).__cu;
const { THREE } = core;
cu.initClickUse({ editing: () => false, busy: () => false, myPos: () => new THREE.Vector3(0, 0, 0) });
const scene = new THREE.Scene();
const thing = (id: string, size: number[], at: number[], bag: any) => { const m = new THREE.Mesh(new THREE.BoxGeometry(...size)); m.position.set(...at); m.userData.entityId = id; scene.add(m); m.updateMatrixWorld(true); world.entities.set(id, m); world.bags[id] = bag; return m; };
// a desk 3 m ahead (nothing to pick up or use: a surface), a crate on the floor to its left, the held crate out of the way
thing('desk', [1.6, 0.8, 0.8], [0, 0.4, -3], { label: 'desk' });
thing('crate', [0.5, 0.5, 0.5], [3, 0.25, 0], { label: 'crate', physics: { kind: 'dynamic' } });
const keys = (offers: any[]) => offers.map((o) => o.k);
const click = (b: number, x = 50, y = 50) => { core.canvas._fire('mousedown', { button: b, clientX: x, clientY: y }); for (const f of winL.mouseup ?? []) f({ button: b, clientX: x, clientY: y }); };

// ---- holding the crate, its own menu: put down and throw, never "pick up"
tp.held.splice(0, Infinity, 'crate');
const own = keys(cu.offersOf('crate'));
check('holding the crate, its menu offers put down and throw', own.includes('put') && own.includes('throw'), JSON.stringify(own));
check('holding the crate, its menu does not offer to pick it up', !own.includes('grab'), JSON.stringify(own));

// ---- holding the crate, a right-click on the desk: put the crate on the desk, where the click landed
panels.menus.length = 0; click(2);
const menu = panels.menus.at(-1)?.map((i: any) => i.k) ?? null;
check('holding the crate, right-clicking the desk offers to put it on the desk', !!menu && menu.includes('puton'), JSON.stringify(menu));
// ---- …and a left-click on the desk sets it down on the desk's top
tp.calls.length = 0; click(0); await new Promise((r) => setTimeout(r, 0));
const put = tp.calls.find((c: any[]) => c[0] === 'put');
check('holding the crate, left-clicking the desk puts it down there, on its top', !!put && put[1] === 'crate' && Math.abs(put[2][0]) < 0.8 && Math.abs(put[2][1] + 3) < 0.4, JSON.stringify(tp.calls));

// ---- holding the crate, a left-click on another thing to pick up still picks it up (its own first use); the menu offers both
thing('ball', [0.3, 0.3, 0.3], [0, 0.8, -2], { label: 'ball' });   // in the line of the click, in front of the desk
tp.calls.length = 0; click(0); await new Promise((r) => setTimeout(r, 0));
check('holding the crate, left-clicking a ball picks the ball up (its own first use)', JSON.stringify(tp.calls) === '[["grab","ball"]]', JSON.stringify(tp.calls));
panels.menus.length = 0; click(2); const bm = panels.menus.at(-1)?.map((i: any) => i.k) ?? null;
check('holding the crate, right-clicking the ball offers to put the crate on it', !!bm && bm[0] === 'puton', JSON.stringify(bm));
scene.remove(world.entities.get('ball')); world.entities.delete('ball'); delete world.bags.ball;

// ---- holding nothing, the desk offers nothing (a click on it is not a thing's use) and the crate offers pick up
tp.held.splice(0, Infinity); panels.menus.length = 0; click(2);
check('holding nothing, a right-click on the desk opens no menu', panels.menus.length === 0, JSON.stringify(panels.menus));
check('holding nothing, the crate offers pick up', keys(cu.offersOf('crate')).includes('grab'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
