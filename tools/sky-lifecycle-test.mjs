// sky-lifecycle-test — the REAL client/lib/sky.js state machine (the VR cap, the headset holds, the tier queued while
// the sky arrives, the failed bake's one retry, the held changes applied at exit), driven headless.
//
// Why not a browser probe: headless Chromium can't compile the cloud programs (they exhaust a 7 GB machine), so every
// real-sky probe either skips the cloudy tiers or never reaches them. The state machine doesn't need them. Here sky.js
// runs as shipped; only its NEIGHBOURS are fakes: the renderer, sky_baked.js (dome hold/park/attach), the Skye module
// loader (a fake makeSky/makeSkySystem with two domes), the interim gradient, the boot/loading gates. The pure pieces
// it composes run for real: sky_swapchain (one swap at a time, latest wins), sky_bakelock (one bake at a time, the
// post-bake step inside the lock), shared/forecast.
//
// "The live march is visible in the headset" is measured the way a person would see it: a FRAME sampler (every few ms
// of scaled time, i.e. between tasks, never mid-function) records any frame where the session is presenting, a live dome
// is in the scene, and no baked dome is attached. Synchronous hold/release flips inside one task are never a frame.
//
// Timers are scaled 1/TS so the cap's 4 s wait, the 1 s settle and the failed bake's 10 s retry run in milliseconds,
// in the same order.
//
// Not covered here (disclosed): the prebuild under the splash (navigator.xr is absent, so headsetPresent() is false);
// banded bakes (bandCuts is faked to one band); how the real sky_baked parks domes (its own probe:
// sky-xr-livehold-probe); anything visual. Those are the fakes' contracts, stated beside each fake.
//
//   bun tools/sky-lifecycle-test.mjs
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { mock } from 'bun:test';
GlobalRegistrator.register({ url: 'http://localhost/?world=t&name=p' });

const TS = 50;
const realST = globalThis.setTimeout.bind(globalThis), realCT = globalThis.clearTimeout.bind(globalThis);
globalThis.setTimeout = (fn, ms = 0, ...a) => realST(fn, Math.max(0, ms / TS), ...a);
globalThis.clearTimeout = (h) => realCT(h);
const sleep = (ms) => new Promise((r) => realST(r, ms / TS));   // in SCALED ms, like the product's own timers

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m ${n}${ok ? '' : `  ${typeof d === 'string' ? d : JSON.stringify(d)}`}`); };

const THREE = await import('three');
const lib = (f) => new URL(`../client/lib/${f}`, import.meta.url).pathname;

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
mock.module(lib('loadwork.js'), () => ({ beginWork: () => ({ end() {} }) }));
mock.module(lib('framebudget.js'), () => ({ busy: () => false }));
mock.module(lib('lightrig.js'), () => ({ setDayness() {}, releaseForeignLights() {} }));
mock.module(lib('warmqueue.js'), () => ({ warm: async (_n, fn) => fn(), P_AMBIENT: 0 }));
mock.module(lib('autohooks.js'), () => ({ claimUnowned: () => [], releaseHook() {} }));

// ---- the interim gradient: a flag, announced as sky_interim does ---------------------------------------------------
let interim = false;
mock.module(lib('sky_interim.js'), () => ({
  showInterimSky() { if (!interim) { interim = true; bus.emit('sky-interim', true); } },
  hideInterimSky() { if (interim) { interim = false; bus.emit('sky-interim', false); } },
  updateInterimSky() {}, interimSkyShown: () => interim,
}));

// ---- sky_baked: the dome contract sky.js relies on ------------------------------------------------------------------
// hold: take the live domes out of the scene (true if it took them); release: put held ones back, under their parent;
// attach: the baked dome goes up and PARKS the live domes (out of the scene) — refused when `attachRefuses`;
// detach: the baked dome comes down and the parked/held domes go back (sky_baked.detachBakedDome's documented order).
const SB = { held: null, parked: null, baked: null, attachRefuses: false, attaches: [], gen: 1 };
const putBack = (list) => { for (const [d, p] of list ?? []) if (!d.parent) p.add(d); };
const takeOut = (api) => { const ds = api?._internals?.sky?.domes ?? []; const l = ds.filter((d) => d.parent).map((d) => [d, d.parent]); for (const [d, p] of l) p.remove(d); return l; };
mock.module(lib('sky_baked.js'), () => ({
  BAKE_INTERCEPT: Symbol('bake-intercept'),
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
mock.module(lib('assets.js'), () => ({
  primeFiles: async () => {}, listLibrary: async () => [], fetchBytes: async () => new Uint8Array(),
  async loadEidoModule() {
    globalThis.makeSkySystem = (args) => fakeSystem(args);   // through sky.js's setter, as sky_system's eval assigns it
    globalThis.makeSky = async () => {
      BAKE.builds++;
      const sys = await globalThis.makeSkySystem({ opts: {} });
      return { _internals: { sky: sys }, bakeEnv: (o) => sys.bakeEnv(o), enableReflections() {}, update() {},
        transitionTo() {}, setWeather() {}, setTime() {}, setColors() {}, setClouds() {}, dispose() {} };
    };
  },
}));

localStorage.setItem('ew-cloud-quality', 'medium');
const sky = await import('../client/lib/sky.js');
SB.tierAtAttach = () => sky.getCloudQuality();

// ---- the frame sampler: what a person in the headset would SEE ----------------------------------------------------
let frames = [], sampling = null;
const domes = () => sky.skyForProbe().sys?.domes ?? [];
function startFrames() {
  frames = [];
  sampling = setInterval(() => {
    const live = domes().some((d) => d.parent);
    frames.push({ xr: renderer.xr.isPresenting, live, baked: !!SB.baked, tier: sky.getCloudQuality(), interim });
  }, 1);
}
const stopFrames = () => { clearInterval(sampling); sampling = null; };
const liveInHeadset = () => frames.filter((f) => f.xr && f.live && !f.baked);
const enter = () => { renderer.xr.isPresenting = true; bus.emit('xr:state', true); };
const leave = () => { renderer.xr.isPresenting = false; bus.emit('xr:state', false); };
const curtain = () => bus.emit('xr:curtain-shown');
const until = async (p, ms = 60000) => { const t0 = Date.now(); while (!p()) { if (Date.now() - t0 > ms / TS) return false; await sleep(10); } return true; };
const settle = () => sleep(3000);   // a few scaled seconds: finishSky's 1 s settle, swaps, bakes
const bakesSince = (i) => BAKE.runs.slice(i);
let T = 0;
const ARGS = { system: 'eidoverse', world: 'earth', clouds: 'cumulus', weather: 'clear' };
async function freshSky(quality) {
  // a new sky build at `quality` (a rebuild through setCloudQuality would carry today's state; a clean module per case
  // isn't possible, so each case starts by flipping off → quality, which rebuilds, and waits for the sky to arrive)
  if (renderer.xr.isPresenting) leave();
  localStorage.setItem('ew-cloud-quality', quality);
  BAKE.fail = 0; BAKE.gate = null; SB.attachRefuses = false;
  await sky.applySky({ ...ARGS, ts: ++T });
  await sky.setCloudQuality('off');
  await settle();
  await sky.setCloudQuality(quality);
  await settle();
}

try {
  await sky.applySky({ ...ARGS, ts: ++T });
  await settle();
  check('(setup) the real sky arrives on the fake system: medium, baked dome attached, no gradient',
    sky.getCloudQuality() === 'medium' && !!SB.baked && !interim && !sky.skyBusy(), { q: sky.getCloudQuality(), baked: !!SB.baked, interim, log: log.slice(-4) });

  // ---- 1. ENTRY WHILE `high` IS PENDING -----------------------------------------------------------------------------
  // high chosen on the desktop while the sky is still arriving is only PENDING at entry. The cap takes it: the session
  // runs medium (baked), the live march never shows in the headset, and the choice still reads high.
  {
    await freshSky('low');
    await sky.setCloudQuality('off'); await settle();          // arrive fresh: an off → low rebuild, caught mid-arrival
    const p = sky.setCloudQuality('low');                       // rebuild starts; the sky is ARRIVING (gradient up)
    await sleep(20);
    const arriving = interim;
    await sky.setCloudQuality('high');                          // queued: pendingTier = high
    startFrames();
    enter();
    const cap = sky.cloudCap(), choice = sky.getCloudChoice();
    curtain();
    await p; await settle();
    stopFrames();
    check('pending high at entry: (setup) the sky was still arriving when high was chosen', arriving, log.slice(-6));
    check('…the cap takes the PENDING choice: capped high → medium, the choice still reads high',
      cap?.from === 'high' && cap?.to === 'medium' && choice === 'high', { cap, choice });
    check('…the session runs medium, baked', sky.getCloudQuality() === 'medium' && !!SB.baked, { q: sky.getCloudQuality(), baked: !!SB.baked });
    check('…and the live march is never on screen in the headset (no frame: presenting + live dome + no baked dome)',
      liveInHeadset().length === 0 && frames.some((f) => f.xr), { bad: liveInHeadset().slice(0, 3), n: frames.length });
    leave(); await settle();
    check('…exit restores the choice: high (the live tier)', sky.getCloudQuality() === 'high' && !sky.cloudCap(), sky.getCloudQuality());
  }

  // ---- 2. QUICK EXIT / RE-ENTRY DURING THE CAP -----------------------------------------------------------------------
  {
    await freshSky('high');
    // (a) exit before the cap's deferred flip fires: the first session's timer must not apply later
    enter(); leave();
    await sleep(6000);                                          // past the 4 s fallback timer
    check('quick exit: the first session\'s cap timer never applies (desktop stays high)',
      sky.getCloudQuality() === 'high' && !sky.cloudCap(), { q: sky.getCloudQuality(), cap: sky.cloudCap() });
    // (a2) exit and re-enter INSIDE the first timer's window, no curtain yet: at the moment the FIRST session's 4 s timer
    //      would fire, the second session must still be waiting on its own curtain (review 10b L1: the old timer applied
    //      the cap early, its bake taking the GPU before the headset's first frames)
    enter(); await sleep(2500); leave(); enter();
    await sleep(2000);                                          // 4.5 s after the FIRST entry, 2 s after the second
    const early = sky.getCloudQuality();
    await sleep(3000); await settle();                          // the second session's own fallback timer
    const own = sky.getCloudQuality();
    check('re-entry inside the first timer\'s window: the stale timer doesn\'t flip the cap early', early === 'high', early);
    check('…the second session\'s own timer does (medium)', own === 'medium' && !!sky.cloudCap(), own);
    leave(); await settle();
    // (b) exit and re-enter DURING the cap's bake: the stale bake doesn't attach on the desktop, and the second session
    //     ends capped, baked, with the live march never shown
    const r0 = BAKE.runs.length;
    let open; BAKE.gate = new Promise((r) => { open = r; });
    startFrames();
    enter(); curtain(); await sleep(300);                       // the cap's swap is baking (gated)
    const bakingInFirst = bakesSince(r0).length > 0;
    leave(); await sleep(300);
    enter(); curtain(); await sleep(300);
    open(); BAKE.gate = null;
    await settle();
    stopFrames();
    check('re-entry during the cap bake: (setup) the first session\'s cap bake was running at exit', bakingInFirst, bakesSince(r0));
    check('…the second session ends capped: medium, baked, choice high',
      sky.getCloudQuality() === 'medium' && !!SB.baked && sky.cloudCap()?.from === 'high' && sky.getCloudChoice() === 'high',
      { q: sky.getCloudQuality(), baked: !!SB.baked, cap: sky.cloudCap() });
    check('…and the live march is never on screen in either session', liveInHeadset().length === 0, liveInHeadset().slice(0, 3));
    const capLines = log.filter((l) => /clouds capped high → medium/.test(l)).length;
    leave(); await settle();
    check('…exit restores high once', sky.getCloudQuality() === 'high' && !sky.cloudCap(), sky.getCloudQuality());
    check('(info) cap announcements so far', capLines > 0, capLines);
  }

  // ---- 3. A FAILED BAKE -----------------------------------------------------------------------------------------------
  {
    await freshSky('medium');
    // (a) one failure: the live clouds stay, exactly one retry, which succeeds and attaches
    const r0 = BAKE.runs.length, a0 = SB.attaches.length;
    BAKE.fail = 1;
    const flip = sky.setCloudQuality('low');                    // medium → low: a baked → baked swap, a new bake
    await sleep(200);
    const afterFail = { live: domes().some((d) => d.parent), baked: !!SB.baked, runs: bakesSince(r0).map((r) => r.ok) };
    await flip; await sleep(15000); await settle();              // past the 10 s retry
    const runs = bakesSince(r0).map((r) => r.ok);
    check('failed bake: no dome attaches over the undrawn target; the live clouds are on screen instead',
      afterFail.runs[0] === false && !afterFail.baked && afterFail.live, afterFail);
    check('…exactly one retry, 10 s later, and it attaches', JSON.stringify(runs) === '[false,true]' && SB.attaches.length === a0 + 1 && !!SB.baked,
      { runs, attaches: SB.attaches.length - a0 });
    // (b) two failures: the retry fails too, and nothing further runs
    await sky.setCloudQuality('medium'); await settle();
    const r1 = BAKE.runs.length, a1 = SB.attaches.length;
    BAKE.fail = 2;
    await sky.setCloudQuality('low');
    await sleep(30000); await settle();
    const runs2 = bakesSince(r1).map((r) => r.ok);
    check('two failures: exactly one retry (two bakes, not three), no dome attached, the live clouds stay',
      JSON.stringify(runs2) === '[false,false]' && SB.attaches.length === a1 && !SB.baked && domes().some((d) => d.parent),
      { runs2, attached: SB.attaches.length - a1 });
    // (c) in the headset: a failed bake releases the held march (a costly sky beats no clouds) and the hold stands down
    await sky.setCloudQuality('medium'); await settle();
    enter(); await settle();
    BAKE.fail = 1;
    leave(); await sky.setCloudQuality('low'); enter();        // (a swap only runs outside a session: set it up, re-enter)
    await sleep(200);
    const inXR = { live: domes().some((d) => d.parent), baked: !!SB.baked, interim };
    await sky.applySky({ ...ARGS, ts: T });                     // the product's periodic re-apply (holdLiveInHeadset runs)
    await sleep(50);
    check('in a headset, a failed bake puts the live clouds back rather than leave the sky black',
      inXR.live && !inXR.baked, inXR);
    check('…and a re-apply does not hold them out again (attachFailedFor)', domes().some((d) => d.parent) || !!SB.baked,
      { live: domes().some((d) => d.parent), baked: !!SB.baked });
    await sleep(15000); await settle();
    leave(); await settle();
  }

  // ---- 4. HELD CHANGES AT EXIT ------------------------------------------------------------------------------------------
  {
    // (a) no cap: several choices in the headset; the LATEST applies once at exit
    await freshSky('medium');
    enter(); await settle();
    const b0 = BAKE.builds;
    await sky.setCloudQuality('low'); await sky.setCloudQuality('off');
    const held = sky.skyHeld();
    const inSession = sky.getCloudQuality();
    leave(); await settle();
    check('held quality: nothing changes in the session, the latest choice is held', inSession === 'medium' && held?.quality === 'off', { inSession, held });
    check('…and applies ONCE at exit (one rebuild, to off)', sky.getCloudQuality() === 'off' && BAKE.builds === b0 + 1 && !sky.skyHeld(),
      { q: sky.getCloudQuality(), builds: BAKE.builds - b0 });

    // (b) capped session, a deliberate choice made in the headset replaces the cap's memory; exit applies it once
    await freshSky('high');
    enter(); curtain(); await settle();
    await sky.setCloudQuality('low');
    const heldC = sky.skyHeld(), capC = sky.cloudCap();
    leave(); await settle();
    check('capped + a choice in the headset: the choice is held and the cap forgotten', heldC?.quality === 'low' && !capC, { heldC, capC });
    check('…exit applies it once: low, baked', sky.getCloudQuality() === 'low' && !!SB.baked && !sky.skyHeld(), sky.getCloudQuality());

    // (c) a sky-world switch held while CAPPED survives the cap's restore and applies once, after it
    await freshSky('high');
    sky.SKY_WORLDS.push('mars');                                // latent today (earth only): a second world makes it real
    enter(); curtain(); await settle();
    const b1 = BAKE.builds;
    await sky.applySky({ ...ARGS, world: 'mars', ts: ++T });
    const heldW = sky.skyHeld(), buildsInSession = BAKE.builds - b1;
    leave(); await settle(); await settle();
    const worldLine = log.filter((l) => /applying the sky world held/.test(l)).length;
    check('capped + a sky-world switch in the headset: held, no rebuild in the session', heldW?.rebuild === true && buildsInSession === 0, { heldW, buildsInSession });
    check('…at exit: the cap restores high, then the world applies ONCE (one rebuild)',
      sky.getCloudQuality() === 'high' && BAKE.builds === b1 + 1 && worldLine >= 1 && !sky.skyHeld(),
      { q: sky.getCloudQuality(), builds: BAKE.builds - b1, worldLine });
    sky.SKY_WORLDS.pop();
  }

  check('no reported errors', reports.length === 0, reports.slice(0, 3));
} catch (e) { check('ran', false, e?.stack ?? String(e)); }

if (fail) { console.log('\n  last sky lines:'); for (const l of log.slice(-25)) console.log(`    ${l.slice(0, 170)}`); }
console.log(`${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
