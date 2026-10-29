// dismount-height-test.ts — standing up keeps the height I'm let go at (review of PR #260, client/lib/localbody.js:151).
// dismountMe read the full `vacated.at` (or the socket's exit, in the thing's frame) and then set my height to 0; so did
// stepLeaving when a leave clip finished. A seat on an upper floor that was moved or switched off dropped its occupant
// downstairs: the walker can't climb back to a floor more than a step above where it was put.
// Headless, through the REAL client/lib/localbody.js: every module it imports that owns a renderer, the DOM, the network or
// the world's scene is a stand-in served from this file (a bun plugin's virtual namespace, as clickuse-test does); three
// and shared/ (sockbody's bodyOf, mayLeave) are real.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/dismount-height-test.ts
// Mutation (must go red): in dismountMe, `myState.pos.set(off.x, off.y, off.z)` back to `(off.x, 0, off.z)` (rows D1, D2);
// in stepLeaving, put back `myState.pos.y = 0;` (row D3).
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
const THREE_PATH = fileURLToPath(new URL('../client/node_modules/three/build/three.module.js', import.meta.url));
const STUBS: Record<string, string> = {
  core: `import * as THREE from ${JSON.stringify(THREE_PATH)}; export { THREE }; export const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 100); globalThis.__dm.THREE = THREE;`,
  base: `export const CONFIG = { name: 'me' }; export const bus = { on() {}, emit() {} };`,
  controller: `import * as THREE from ${JSON.stringify(THREE_PATH)};
    export const myState = { pos: new THREE.Vector3(), yaw: 0, speed: 0, clip: 'idle' }; export const keys = new Set(); export const xrIntent = {};
    export const camYaw = 0, camPitch = 0; export const setCamYaw = () => {}; export const updateFollowCamera = () => {};
    export const postures = []; export const setPosture = (p) => postures.push(p); export const setOccupyHook = () => {}; export const setMountedHook = () => {};
    globalThis.__dm.ctl = { myState, postures };`,
  world: `export const avatarMounts = new Map(); export const entities = new Map(); export const bags = {}; export const bagOf = () => null;
    export const socket = { host: 'balcony-chair', station: { action: 'sit' } };
    export const seatAt = { p: [4, 3.45, -2], yaw: 0 };
    export const mountTransform = (name, out) => { out.set(seatAt.p[0], seatAt.p[1], seatAt.p[2]); return { yaw: seatAt.yaw }; };
    export const socketWorldPos = () => null; export const setBodySeat = () => {}; export const seatSocket = () => socket; export const socketsOn = () => []; export const parentIdOf = () => null;
    globalThis.__dm.world = { avatarMounts, socket, entities };`,
  occupybody: `export const driveOccupied = () => {}; export const releaseOccupied = () => {};`,
  remotes: `export const serverNow = () => Date.now();`,
  net: `export const sendRequest = async () => ({ ok: true }); export const sendAnim = () => {}; export const identities = new Map();`,
  plainwords: `export const plain = (x) => x; export const called = (x) => x; export const typeable = (x) => x;`,
  useprompt: `export const usePromptHint = () => {};`,
  thingphysics: `export const handsHint = () => {}; export const physicsApi = { mine: () => [] };`,
  myview: `export const outOfMyView = () => false;`,
  bodysim: `export const makeRagdoll = () => null;`,
  ragdoll: `export const jointPositions = () => null;`,
  bodydrag: `export const initBodyDrag = () => {}; export const beingDragged = () => false; export const revokeDragged = () => {};`,
  ui: `export const toast = () => {}; export const flashHint = () => {}; export const setAmbientHint = () => {}; export const html = (s, ...v) => s.reduce((a, x, i) => a + x + (v[i] ?? ''), '');`,
  consent: `export const posable = () => false; export const pushable = () => false; export const bodyTable = () => ({}); export const onConsentChange = () => {}; export const noteHeld = () => {};`,
  consentsync: `export const makeConsentSync = () => ({});`,
  reachnet: `export const clearMyReach = () => {};`,
  mybody: `export let me = null; export const getMe = () => globalThis.__dm.me ?? null;`,
};
plugin({
  name: 'dismount-stubs',
  setup(b) {
    b.onResolve({ filter: new RegExp(`^\\./(${Object.keys(STUBS).join('|')})\\.js$`) }, (a) => (a.importer.endsWith('localbody.js') ? { path: a.path.slice(2, -3), namespace: 'dm-stub' } : undefined));
    b.onLoad({ filter: /.*/, namespace: 'dm-stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
  },
});
const G = globalThis as any; G.__dm = {};

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); } else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); } };

const lb: any = await import('../client/lib/localbody.js');
const { ctl, world, THREE } = G.__dm;
const seatOn = (station: any) => { world.socket.station = station; world.avatarMounts.set('me', { to: 'balcony-chair:a' }); ctl.myState.pos.set(4, 3.45, -2); };

// D1: the authority's vacated.at on an upper floor (y 3.0): I stand there, at its height
seatOn({ action: 'sit' });
const ok1 = lb.dismountMe('script', [4.6, 3.0, -2.1]);
const p1 = ctl.myState.pos;
check('D1 stood up at vacated.at on the upper floor: x, y and z as the authority gave them (y 3.0, not 0)', ok1 && Math.abs(p1.x - 4.6) < 1e-9 && Math.abs(p1.y - 3.0) < 1e-9 && Math.abs(p1.z + 2.1) < 1e-9, `${ok1} [${p1.x}, ${p1.y}, ${p1.z}]`);

// D2: no `at`, a socket exit in the thing's frame: the exit's height, carried through the host's world matrix (the host
// stands on a floor 3 m up)
{ const host = new THREE.Object3D(); host.position.set(10, 3, 0); world.entities.set('balcony-chair', host);
  seatOn({ action: 'sit', exit: [0, 0, 0.8] });
  const ok2 = lb.dismountMe('menu'); const p2 = ctl.myState.pos;
  check('D2 a socket exit on the upper floor keeps its world height (3.0), not 0', ok2 && Math.abs(p2.y - 3.0) < 1e-9 && Math.abs(p2.x - 10) < 1e-9 && Math.abs(p2.z - 0.8) < 1e-9, `${ok2} [${p2.x}, ${p2.y}, ${p2.z}]`);
  world.entities.delete('balcony-chair'); }

// D3: a leave clip: carried off while it plays, then stepLeaving finishes at vacated.at's height
{ const me = { root: new THREE.Object3D(), locomotion: null, ensureClip: () => ({ getClip: () => ({ duration: 0.001 }) }), setSeatBlend() {} };
  G.__dm.me = me;
  seatOn({ action: 'sit', leave: 'stand-up' });
  const ok3 = lb.dismountMe('script', [4.6, 3.0, -2.1]);
  await new Promise((r) => setTimeout(r, 15));
  lb.updateMountedMe(1 / 60);
  const p3 = ctl.myState.pos;
  check('D3 a leave clip finishes where the authority let me go, at its height (3.0), not 0', ok3 && !lb.seatLeaving() && Math.abs(p3.y - 3.0) < 1e-9 && Math.abs(p3.x - 4.6) < 1e-9, `${ok3} leaving=${lb.seatLeaving()} [${p3.x}, ${p3.y}, ${p3.z}]`);
  G.__dm.me = null; }

// D4 (control): a ground-floor seat let go at ground height stands at 0
seatOn({ action: 'sit' });
lb.dismountMe('script', [1, 0, 1]);
check('D4 (control) let go on the ground floor, I stand at 0', Math.abs(ctl.myState.pos.y) < 1e-9, String(ctl.myState.pos.y));

console.log(`\n${fail ? `\x1b[31m${fail} failed\x1b[0m` : '\x1b[32mall passed\x1b[0m'} — ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
