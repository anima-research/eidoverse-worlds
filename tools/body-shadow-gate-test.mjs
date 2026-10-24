// Only a body with a LAMP in it casts and receives (client/lib/materials.js,
// client/lib/avatar.js).
//
// Bodies briefly got real shadows for every avatar in the world. That is a
// global rendering default flipped on shared client code, and the costs were
// unmeasured: a body's depth pipelines never reach warmqueue's warmDepth (only
// registered MODELS do), so they compile in-frame on the first shadow render,
// and bodies bypass the distance-ranked caster budget that exists to prevent
// exactly that. In a crowded room that is N bodies compiling.
//
// Janus scoped it down: "set the change for now to only shadowed body by
// default if you have the lamp like mythos... we can test the performance of
// having more on the shared server later." So the gate is the lamp, and this
// pins all three paths -- including that an unlamped body is EXACTLY as it was
// before any of this work.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
HTMLCanvasElement.prototype.getContext = function () { const a = new Proxy(function () {}, { get: (_t, k) => (k === 'width' ? 100 : a), apply: () => a, set: () => true }); return new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 100 }) : a), set: () => true }); };
import { plugin } from 'bun';
const HERE = import.meta.dir; const here = (p) => `${HERE}/${p.replace(/^\.\//, '')}`;
plugin({ name: 'core-stub', setup(build) {
  build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
  build.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
  build.onResolve({ filter: /^\.\/state\.js$/ }, () => ({ path: here('./state-stub.mjs') }));
} });
const { THREE } = await import('./core-stub.mjs');
const mats = await import('../client/lib/materials.js');

let pass = 0, fail = 0;
const check = (name, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${note ? `  -- ${note}` : ''}`); } };

// the real node names off Mythos's VRM (nodes, not meshes -- o.name is the node)
const NAMES = ['body_main', 'wings', 'eyelids', 'eyeballs', 'GOLD', 'lamp'];
const makeBody = () => {
  const g = new THREE.Group();
  for (const n of NAMES) {
    const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    m.name = n; g.add(m);
  }
  return g;
};
const meshes = (g) => { const out = []; g.traverse((o) => { if (o.isMesh) out.push(o); }); return out; };
const byName = (g, n) => meshes(g).find((m) => m.name === n);

console.log('AN UNLAMPED BODY — the fleet default, unchanged from main');
const plain = makeBody();
mats.prepareObject(plain, { kind: 'body' });
check('casts nothing', meshes(plain).every((m) => m.castShadow === false),
  meshes(plain).filter((m) => m.castShadow).map((m) => m.name).join(',') || '');
check('receives nothing (it is on its blob)', meshes(plain).every((m) => m.receiveShadow === false),
  meshes(plain).filter((m) => m.receiveShadow).map((m) => m.name).join(',') || '');

console.log('A LAMPED BODY — setBodyShadows, as avatar.js calls it');
const lamped = makeBody();
mats.prepareObject(lamped, { kind: 'body' });
const n = mats.setBodyShadows(lamped, true);
check('every mesh was visited', n === NAMES.length, `visited ${n} of ${NAMES.length}`);
check('the body receives', meshes(lamped).every((m) => m.receiveShadow === true));
const NO_CAST = ['GOLD', 'wings'];
check('the body casts', meshes(lamped).filter((m) => !NO_CAST.includes(m.name)).every((m) => m.castShadow === true),
  meshes(lamped).filter((m) => !NO_CAST.includes(m.name) && !m.castShadow).map((m) => m.name).join(','));
// the kintsugi seams self-shadow into scratches at any map size
check('GOLD does NOT cast', byName(lamped, 'GOLD').castShadow === false);
check('...but GOLD still receives', byName(lamped, 'GOLD').receiveShadow === true);
// THE WINGS, at Janus's ask. castShadow is per OBJECT and both wings are one
// mesh, so dropping `wings` from the caster set is what "no wing-on-wing
// shadowing" actually means -- there is no per-pair exclusion in three. They
// keep receiving, so the chest lamp still lights them and the body still
// shadows them.
check('the wings do NOT cast', byName(lamped, 'wings').castShadow === false);
check('...but the wings still receive', byName(lamped, 'wings').receiveShadow === true);
// the silhouette that reads as a person is still thrown
check('body_main still casts', byName(lamped, 'body_main').castShadow === true);

console.log('setBodyShadows(root, false) — reversible');
mats.setBodyShadows(lamped, false);
check('everything goes back off', meshes(lamped).every((m) => !m.castShadow && !m.receiveShadow));

console.log('OTHER KINDS — untouched by any of this');
const model = makeBody();
mats.prepareObject(model, { kind: 'model' });
check('models receive but do not cast',
  meshes(model).every((m) => m.receiveShadow === true && m.castShadow === false));
const grass = makeBody();
mats.prepareObject(grass, { kind: 'grass' });
check('grass neither casts nor receives',
  meshes(grass).every((m) => m.receiveShadow === false && m.castShadow === false));

console.log("'MY BODY CASTS A REAL SHADOW' — the Video pref, own body only (materials.applyOwnBodyShadow, from mybody.setMe)");
{ const fakeAv = (lamps = 0) => { const g = makeBody(); mats.prepareObject(g, { kind: 'body' }); return { vrm: { scene: g }, _lamps: new Array(lamps).fill({}) }; };
  const body = (av) => meshes(av.vrm.scene);
  localStorage.removeItem('ew-my-shadow');
  check('the pref defaults off', mats.myShadowPref() === false);
  const off = fakeAv();
  await mats.applyOwnBodyShadow(off);
  check('pref off: an unlamped body is EXACTLY as before (nothing casts, nothing receives)', body(off).every((m) => !m.castShadow && !m.receiveShadow));
  mats.setMyShadowPref(true);
  check('setMyShadowPref persists', localStorage.getItem('ew-my-shadow') === '1' && mats.myShadowPref() === true);
  const warmed = [];
  const on = fakeAv();
  const flippedBeforeWarm = [];
  const r = await mats.applyOwnBodyShadow(on, { warm: async (label, get) => { warmed.push(label, get().map((m) => m.name)); flippedBeforeWarm.push(body(on).some((m) => m.castShadow)); } });
  check('pref on: the own body casts and receives', r === true && body(on).filter((m) => !NO_CAST.includes(m.name)).every((m) => m.castShadow) && body(on).every((m) => m.receiveShadow));
  check('…GOLD and the wings still do not cast', !byName(on.vrm.scene, 'GOLD').castShadow && !byName(on.vrm.scene, 'wings').castShadow);
  check('…the depth pipelines were warmed BEFORE the flip, for the casting meshes only', warmed[0] === 'depth me' && flippedBeforeWarm[0] === false
    && JSON.stringify(warmed[1]) === JSON.stringify(NAMES.filter((n) => !NO_CAST.includes(n))), JSON.stringify(warmed));
  const remote = fakeAv();                        // a remote body: prepareObject only — setMe never runs for it
  check('…a remote body with the same pref value in this browser does NOT cast', body(remote).every((m) => !m.castShadow && !m.receiveShadow));
  mats.setMyShadowPref(false);
  await mats.applyOwnBodyShadow(on);
  check('pref back off: the own body goes back to its blob', body(on).every((m) => !m.castShadow && !m.receiveShadow));
  const lamped2 = fakeAv(1);
  await mats.applyOwnBodyShadow(lamped2);
  check('pref off but lamped: the lamp gate still wins', byName(lamped2.vrm.scene, 'body_main').castShadow === true);
  const swapped = fakeAv();
  mats.setMyShadowPref(true);
  const r2 = await mats.applyOwnBodyShadow(swapped, { warm: async () => {}, still: () => false });
  check('a body taken off while its warm ran is left alone', r2 === false && body(swapped).every((m) => !m.castShadow));
  mats.setMyShadowPref(false); }

console.log("ROUND 2 — the LIT warm (receiveShadow IS in the cache key) and the toggle race");
{ const fakeAv = (lamps = 0) => { const g = makeBody(); mats.prepareObject(g, { kind: 'body' }); return { vrm: { scene: g }, _lamps: new Array(lamps).fill({}) }; };
  const body = (av) => meshes(av.vrm.scene);
  const order = [];
  const av = fakeAv();
  const r = await mats.applyOwnBodyShadow(av, { pref: true,
    lit: async (label, get) => { order.push(label); const ms = get(); order.push(`receive:${body(av).map((m) => +m.receiveShadow).join('')}`, `lit:${ms.map((m) => m.name).join(',')}`); },
    warm: async (label, get) => { order.push(label); get(); } });
  check('the lit warm runs first, with receiveShadow still false on every mesh, for the casting meshes only; the depth warm follows; the flip is last',
    r === true && order.join(' ') === `lit me receive:000000 lit:${NAMES.filter((n) => !NO_CAST.includes(n)).join(',')} depth me` && body(av).every((m) => m.receiveShadow), order.join(' '));

  // S2-1: ON → (warm pending) → OFF → the warm lands: the body must END with the pref off
  const race = fakeAv();
  let release; const gate = new Promise((res) => { release = res; });
  const on = mats.applyOwnBodyShadow(race, { pref: () => mats.myShadowPref(), lit: async (_l, get) => { get(); await gate; } });
  mats.setMyShadowPref(true);
  await Promise.resolve();
  mats.setMyShadowPref(false);
  const off = await mats.applyOwnBodyShadow(race, { pref: () => mats.myShadowPref() });
  release(); const first = await on;
  check('pref ON then OFF while the warm was pending: the body does NOT cast afterwards', off === false && first === false && body(race).every((m) => !m.castShadow && !m.receiveShadow),
    `first=${first} off=${off} casting=${body(race).filter((m) => m.castShadow).map((m) => m.name).join(',')}`);

  // the pref re-read AFTER the warm: ON at call time, OFF when the warm lands — no newer call in between
  const late = fakeAv();
  mats.setMyShadowPref(true);
  const r3 = await mats.applyOwnBodyShadow(late, { pref: () => mats.myShadowPref(), lit: async (_l, get) => { get(); mats.setMyShadowPref(false); } });
  check('the decision is re-read after the warm (pref off by then → off)', r3 === false && body(late).every((m) => !m.castShadow), `r3=${r3}`);

  // ON → OFF → ON runs the warm once, not once per toggle
  const twice = fakeAv(); let warms = 0;
  mats.setMyShadowPref(true);
  await mats.applyOwnBodyShadow(twice, { pref: () => mats.myShadowPref(), lit: async (_l, get) => { if (get().length) warms++; } });
  mats.setMyShadowPref(false); await mats.applyOwnBodyShadow(twice, { pref: () => mats.myShadowPref(), lit: async (_l, get) => { if (get().length) warms++; } });
  mats.setMyShadowPref(true); await mats.applyOwnBodyShadow(twice, { pref: () => mats.myShadowPref(), lit: async (_l, get) => { if (get().length) warms++; } });
  check('ON → OFF → ON warms once and ends casting', warms === 1 && body(twice).some((m) => m.castShadow), `warms=${warms}`);
  mats.setMyShadowPref(false); }

console.log('A NULL ROOT — no throw (module init passes a null ground)');
check('setBodyShadows(null) returns 0', mats.setBodyShadows(null) === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
