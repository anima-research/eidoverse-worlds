// sky-degrade-test — the sky's fallback ladder (client/lib/sky/sky.js `degrade`): a build that fails on the light cache's
// storage texture is retried with the engine's light cache OFF (level 1), even at sky quality 'high', before giving up
// to three's SkyMesh (level 2) (333-cm bug b2). The REAL sky.js; its neighbours are sky-lifecycle-test.mjs's fakes.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/sky-degrade-test.mjs
// Mutation (must go red): in buildSky set envKnobs.LCACHE from skyQuality() alone again.
import { fileURLToPath } from "node:url";
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { mock } from 'bun:test';
import { tryUntil } from '../gate/wait.ts';
import { suite } from "../gate/suite.ts";
GlobalRegistrator.register({ url: 'http://localhost/?world=t&name=p' });
const S = suite("sky-degrade");
const check = (n, ok, d) => S.check(n, ok, d);
const KNOBS = [], THROWS = [];
const THREE = await import('three');
const lib = (f) => fileURLToPath(new URL(`../../client/lib/${f}`, import.meta.url));

// ---- the bus, tee, the scene -------------------------------------------------------------------------------------
const handlers = new Map();
const bus = {
  on(ev, fn) { if (!handlers.has(ev)) handlers.set(ev, new Set()); handlers.get(ev).add(fn); return () => handlers.get(ev)?.delete(fn); },
  emit(ev, v) { for (const fn of [...(handlers.get(ev) ?? [])]) fn(v); },
};
const log = [];
const tee = (l) => log.push(String(l));
const reports = [];
const scene = new THREE.Scene();
const renderer = {
  backend: { isWebGLBackend: true },
  xr: { isPresenting: false, enabled: false },
  domElement: { width: 800, height: 600 },
  getRenderTarget: () => null, setRenderTarget() {}, renderAsync: async () => {}, compileAsync: async () => {}, render() {},
};
mock.module(lib('core.js'), () => ({ THREE, scene, renderer, camera: new THREE.PerspectiveCamera(),
  sun: new THREE.DirectionalLight(), hemi: new THREE.HemisphereLight() }));
mock.module(lib('base.js'), () => ({ bus, tee, teeNow: tee, report: (w, e) => reports.push(`${w}: ${e?.message ?? e}`),
  CONFIG: { params: new URLSearchParams('') } }));
mock.module(lib('boot.js'), () => ({ markPhase() {}, bootDone: () => true }));
mock.module(lib('render/loadwork.js'), () => ({ beginWork: () => ({ end() {} }) }));
mock.module(lib('render/framebudget.js'), () => ({ busy: () => false }));
mock.module(lib('render/lightrig.js'), () => ({ setDayness() {}, releaseForeignLights() {} }));
mock.module(lib('render/warmqueue.js'), () => ({ warm: async (_n, fn) => fn(), P_AMBIENT: 0 }));
mock.module(lib('terrain.js'), () => ({ rainSurfaceAt: () => null }));   // sky.js reads only the rain surface from terrain (main #254)
mock.module(lib('render/autohooks.js'), () => ({ claimUnowned: () => [], releaseHook() {}, autoHooks: [], ownHook: (fn) => fn }));

// ---- the interim gradient: a flag, announced as sky_interim does ---------------------------------------------------
let interim = false;
mock.module(lib('sky/sky_interim.js'), () => ({
  showInterimSky() { if (!interim) { interim = true; bus.emit('sky-interim', true); } },
  hideInterimSky() { if (interim) { interim = false; bus.emit('sky-interim', false); } },
  updateInterimSky() {}, interimSkyShown: () => interim, interimSkyObject: () => null,   // read only to hide the sky under water (main #254)
}));

// ---- sky_baked: the dome contract sky.js relies on ------------------------------------------------------------------
// hold: take the live domes out of the scene (true if it took them); release: put held ones back, under their parent;
// attach: the baked dome goes up and PARKS the live domes (out of the scene) — refused when `attachRefuses`;
// detach: the baked dome comes down and the parked/held domes go back (sky_baked.detachBakedDome's documented order).
const SB = { held: null, parked: null, baked: null, attachRefuses: false, attaches: [], gen: 1 };
const putBack = (list) => { for (const [d, p] of list ?? []) if (!d.parent) p.add(d); };
const takeOut = (api) => { const ds = api?._internals?.sky?.domes ?? []; const l = ds.filter((d) => d.parent).map((d) => [d, d.parent]); for (const [d, p] of l) p.remove(d); return l; };
mock.module(lib('sky/sky_baked.js'), () => ({
  BAKE_INTERCEPT: Symbol('bake-intercept'),
  bakedDomeObject: () => null,   // read only to hide the sky under water (main #254)
  bandCuts: () => [0, 1], bandedBakeRender: async () => 1, bakeGeneration: () => SB.gen,
  holdLiveDomes(api) { if (SB.held || SB.parked) return false; const l = takeOut(api); if (!l.length) return false; SB.held = l; return true; },
  releaseLiveDomes() { putBack(SB.held); SB.held = null; },
  liveDomesHeld: () => !!SB.held,
  takeHeldDomes() { const l = (SB.held ?? []).map(([d]) => d); SB.held = null; return l; },
  attachBakedDome(api, opts) {
    if (SB.attachRefuses) return false;
    SB.parked = [...(SB.held ?? []), ...takeOut(api)]; SB.held = null;
    SB.baked = { api, opts }; SB.attaches.push({ tier: SB.tierAtAttach?.(), presenting: renderer.xr.isPresenting });
    return true;
  },
  detachBakedDome() { SB.baked = null; putBack(SB.parked); SB.parked = null; putBack(SB.held); SB.held = null; },
  updateBakedDome() {}, bakedActive: () => !!SB.baked, requestBake() {}, envTexture: () => null, adoptEnvironment() {},
  whenBakeReady: async () => {}, bakedRefreshing: () => false,
}));

// ---- the Skye module: makeSky + makeSkySystem, two domes, a controllable bake -----------------------------------
// BAKE.fail: the next N bakes throw. BAKE.gate: a promise every bake waits on (a slow bake, to act during it).
const BAKE = { fail: 0, gate: null, runs: [], builds: 0 };
function fakeSystem() {
  const domes = [new THREE.Mesh(), new THREE.Mesh()];
  for (const d of domes) scene.add(d);          // AT BIRTH, like the real system (sky.js's wrapper holds them)
  const sys = {
    domes, uniforms: {}, setClouds() {}, dispose() { for (const d of domes) d.removeFromParent(); },
    _envTarget: {}, _envFbNode: {}, _envBake: null,
    async bakeEnv(o = {}) {
      const run = { w: o.width ?? null, ok: null }; BAKE.runs.push(run);
      if (BAKE.gate) await BAKE.gate;
      if (BAKE.fail > 0) { BAKE.fail--; run.ok = false; throw new Error('fake bake failure'); }
      run.ok = true;
    },
  };
  return sys;
}
// LIB: what the asset library lists under eidoverse/assets/sky and what fails to prime (the weather sounds live there, not in the engine)
const LIB = { sky: [], missing: [] };
mock.module(lib('assets.js'), () => ({
  primeFiles: async (paths) => paths.filter((p) => LIB.missing.includes(p)), listLibrary: async (dir) => (dir.endsWith('/sky') ? LIB.sky.map((path) => ({ path })) : []), fetchBytes: async () => new Uint8Array(),
  async loadEidoModule() {
    globalThis.makeSkySystem = (args) => fakeSystem(args);   // through sky.js's setter, as sky_system's eval assigns it
    globalThis.makeSky = async (o = {}) => {
      BAKE.builds++; BAKE.audio = o.audio; KNOBS.push(globalThis.__ewEnv?.LCACHE ?? 'on');
      if (THROWS.length) throw new Error(THROWS.shift());
      const sys = await globalThis.makeSkySystem({ opts: {} });
      return { _internals: { sky: sys }, bakeEnv: (o) => sys.bakeEnv(o), enableReflections() {}, update() {},
        transitionTo() {}, setWeather() {}, setTime() {}, setColors() {}, setClouds() {}, dispose() {} };
    };
  },
}));

localStorage.setItem('ew-cloud-quality', 'medium');
localStorage.setItem('ew-sky-quality', 'high');
const sky = await import('../../client/lib/sky/sky.js');
const degraded = [];
bus.on('sky-degraded', (v) => degraded.push(v?.msg));
try {
  check('setup: sky quality is high (the light cache is on by choice)', sky.skyQuality() === 'high', sky.skyQuality());
  THROWS.push('Uniform "storageTexture" not implemented');
  await sky.applySky({ system: 'eidoverse', world: 'earth', clouds: 'cumulus', weather: 'clear', ts: 1 });
  await tryUntil('the second build', () => KNOBS.length >= 2 || undefined, { ms: 5000, step: 20 });
  check('setup: the first build ran with the light cache on, and failed on its storage texture', KNOBS[0] === 'on' && degraded.length >= 1, { KNOBS, degraded });
  check('b2 the retry builds without the light cache (level 1), as its message says', KNOBS[1] === '0', { KNOBS });
  check('…and that sky stands: not given up to SkyMesh', !sky.skyDegraded(), { KNOBS, reports });
} finally { S.done(); }
