// Crossing the world's water level costs no new render pipelines after the first time (#306), in a real browser.
//   bun tools/water/crossing-pipelines-check.ts   (its own scratch server and world; WebGL, the backend headless CI has)
// A lake is built (this repo's height law, as level-dive-check); the camera is pinned above it, in the level..level+1
// band (the sheet's underside), and under it (the level's fog and far-water background), three times round. Every
// program the backend links is counted, and each render pipeline is put down to what asked for it: the sheet, the
// background, or anything else (the fog, which every lit material carries).
import { PNG } from "pngjs";
import { scratchBench, mkCheck } from "../harness.ts";
import { until } from "../protocol/wait.ts";

const WORLD = "water-cross";
const bench = await scratchBench("water-cross", { worlds: [WORLD] });
const { cdp, evalJson, BASE } = bench;
const { check, tally } = mkCheck();
const errors: string[] = [];
bench.cws.addEventListener("message", (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.method === "Runtime.exceptionThrown") errors.push(String(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text).slice(0, 300));
  if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") errors.push(String(m.params.args?.map((a: any) => a.value ?? a.description).join(" ")).slice(0, 300));
  if (m.method === "Fetch.requestPaused") cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,   // the ground: this repo's height law (below)
    responseHeaders: [{ name: "content-type", value: "text/javascript" }], body: Buffer.from("// stand-in").toString("base64") });
});
await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/library/eidoverse/terrain.js" }] });
// what the backend creates, counted from the first line of the page: WebGL links programs, WebGPU makes pipelines
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
  const g = globalThis, n = g.__made = { gl: 0, gpu: 0 };
  const wrap = (proto, name, key) => { const f = proto && proto[name]; if (f) proto[name] = function (...a) { n[key]++; return f.apply(this, a); }; };
  wrap(g.WebGL2RenderingContext && WebGL2RenderingContext.prototype, 'linkProgram', 'gl');
  if (g.GPUDevice) { wrap(GPUDevice.prototype, 'createRenderPipeline', 'gpu'); wrap(GPUDevice.prototype, 'createRenderPipelineAsync', 'gpu'); }
})();` });
const js = (body: string) => evalJson(`(async () => { ${body} })()`);
const LAKE = { x: 0, z: 30 };
try {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 480, height: 270, deviceScaleFactor: 1, mobile: false });   // SwiftShader draws every pixel on the CPU
  await cdp.send("Page.navigate", { url: `${BASE}/?world=${WORLD}&spectate=1&name=cross&webgl=1` });
  try { await until("the water debug hook", () => evalJson("!!globalThis.__waterDebug").catch(() => false), { ms: 60000 }); }
  catch (e) {   // say why the page never got to main.js's last line (#314 Windows CI)
    const at = await evalJson(`({ ready: document.readyState, made: globalThis.__made, gl: !!document.createElement('canvas').getContext('webgl2'),
      text: document.body?.innerText?.slice(0, 200), main: performance.getEntriesByType('resource').filter((r) => /\\/(main|lib\\/core)\\.js/.test(r.name)).map((r) => [r.name.split('/').pop(), Math.round(r.duration)]) })`).catch((x) => String(x));
    // in the error itself: the gate keeps a throw's message, not the suite's stdout
    throw new Error(`${(e as Error).message}; page at the timeout: ${JSON.stringify(at)} | page errors: ${JSON.stringify(errors.slice(0, 8))}`);
  }
  await js(`const { THREE } = await import('/lib/core.js'), tm = await import('/shared/terrainmath.js');
    globalThis.makeTerrain = (args) => {
      const p = tm.terrainParams(args), h = tm.makeHeightField(p), geo = new THREE.PlaneGeometry(p.size, p.size, 96, 96).rotateX(-Math.PI / 2);
      const pos = geo.attributes.position; for (let i = 0; i < pos.count; i++) pos.setY(i, h(pos.getX(i), pos.getZ(i)));
      geo.computeVertexNormals(); return { mesh: new THREE.Mesh(geo, new THREE.MeshStandardNodeMaterial({ color: 0x7a8a5a })), heightAt: h };
    }; return true;`);
  await until("the world hydrated", () => js("return (await import('/lib/state.js')).state.hydrated;"), { ms: 15000 });
  await js(`(await import('/lib/world.js')).applyTerrainState({ seed: 7, size: 120, amplitude: 0, features: [{ type: 'hill', x: ${LAKE.x}, z: ${LAKE.z}, radius: 18, height: -8 }], water: { level: 0 } }); return true;`);
  await until("the lake's level is 0", () => js("return (await import('/lib/water.js')).waterLevel() === 0;"), { ms: 15000 });
  // the camera pinned wherever a phase puts it (the client's own frame keeps running); each pipeline put down to its asker
  const setup = await js(`const core = await import('/lib/core.js'), { camera, renderer, THREE } = core, g = globalThis;
    g.__pin = null; const pin = () => { if (g.__pin) { camera.position.copy(g.__pin.P); camera.quaternion.copy(g.__pin.Q); } };
    const mw = camera.updateMatrixWorld.bind(camera), wm = camera.updateWorldMatrix.bind(camera);
    camera.updateMatrixWorld = (f) => { pin(); mw(f); }; camera.updateWorldMatrix = (p, c) => { pin(); wm(p, c); };
    g.__at = (y, down) => { const P = new THREE.Vector3(${LAKE.x} + 3, y, ${LAKE.z} + 6), L = down ? new THREE.Vector3(${LAKE.x} + 3, y - 3, ${LAKE.z} + 9) : new THREE.Vector3(${LAKE.x}, y - 0.6, ${LAKE.z});
      g.__pin = { P, Q: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(P, L, new THREE.Vector3(0, 1, 0))) }; };
    g.__at(3);
    const by = g.__by = { sheet: 0, background: 0, other: 0 }, be = renderer.backend, f = be.createRenderPipeline.bind(be);
    be.createRenderPipeline = (ro, p) => { const o = ro.object; by[/^water/.test(o?.name ?? '') ? 'sheet' : o?.name === 'Background.mesh' ? 'background' : 'other']++; return f(ro, p); };
    const { warmStats } = await import('/lib/warmqueue.js'); g.__warm = warmStats;
    g.__frames = 0; const tick = () => { g.__frames++; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
    return { backend: be.isWebGLBackend ? 'webgl' : 'webgpu', sheet: !!core.scene.getObjectByName('water') };`);
  // N real frames, then until nothing new has been made for 30 more (a program links when a draw first needs it)
  // stepped 10 frames per CDP call so one call spans 10 frames, not the whole settle (the budget is frames, not seconds);
  // quiet also needs the warm queue empty: the underside's warm is queued ambient work, not instant
  const settle = async (min: number) => {
    await js(`const g = globalThis; g.__s = { f0: g.__frames, last: g.__made.gl + g.__made.gpu, quiet: g.__frames }; return true;`);
    for (;;) {
      const r = await js(`const g = globalThis, s = g.__s, made = () => g.__made.gl + g.__made.gpu;
        for (let i = 0; i < 10; i++) { await new Promise((r) => requestAnimationFrame(r)); const w = g.__warm(); if (made() !== s.last || w.pending || w.running) { s.last = made(); s.quiet = g.__frames; } }
        const n = g.__frames - s.f0; return n > 3000 ? false : n >= ${min} && g.__frames - s.quiet >= 30 ? n : null;`);
      if (r !== null) return r;
    }
  };
  const initial = await settle(60);
  const phase = async (name: string, y: number) => {
    const before = await js("const g = globalThis; return { made: { ...g.__made }, by: { ...g.__by }, f: g.__frames };");
    await js(`globalThis.__at(${y}); return true;`);
    const settled = await settle(40);
    const after = await js("const g = globalThis, core = await import('/lib/core.js'), w = (await import('/lib/watervolumes.js')).waterDebug(); return { made: { ...g.__made }, by: { ...g.__by }, f: g.__frames, under: w.under, background: w.background, underside: !!core.scene.getObjectByName('water-underside')?.visible };");
    const r = { name, y, settled, frames: after.f - before.f, under: after.under, background: after.background, underside: after.underside,
      made: after.made.gl - before.made.gl + after.made.gpu - before.made.gpu,
      by: Object.fromEntries(Object.keys(after.by).map((k) => [k, after.by[k] - before.by[k]])) as Record<string, number> };
    console.log(`  · ${JSON.stringify(r)}`);
    return r;
  };
  const rounds: any[][] = [];
  for (let i = 0; i < 3; i++) rounds.push([await phase(`band-${i + 1}`, 0.5), await phase(`under-${i + 1}`, -1.5), await phase(`above-${i + 1}`, 3)]);
  const later = rounds.slice(1).flat(), sum = (rs: any[], k?: string) => rs.reduce((t, r) => t + (k ? r.by[k] : r.made), 0);
  const band = later.filter((r) => r.name.startsWith("band")), under = later.filter((r) => r.name.startsWith("under"));
  // the sky's fog still reaches above the water: a dense red fog (held there: the sky rewrites it every frame), looking 45° down from 3 m, paints the view red
  const HELD = "['set', 'setRGB', 'setHex', 'copy', 'lerpColors', 'multiplyScalar']";   // what the sky writes the fog's colour with
  await js(`const HELD = ${HELD}, { scene } = await import('/lib/core.js'), f = scene.fog;
    f.color.setRGB(1, 0, 0); for (const k of HELD) f.color[k] = function () { return this; }; Object.defineProperty(f, 'density', { configurable: true, get: () => 2, set() {} }); globalThis.__at(3, true);
    const cv = (await import('/lib/core.js')).renderer.domElement; for (const el of document.querySelectorAll('body *')) if (!el.contains(cv)) el.style.visibility = 'hidden';   // the panels cover the view
    return true;`);
  const shotSettled = await settle(20);
  const png = Buffer.from((await cdp.send<any>("Page.captureScreenshot", { format: "png" })).data, "base64"), shot = PNG.sync.read(png);
  if (process.env.SHOT_DIR) (await import("node:fs")).writeFileSync(`${process.env.SHOT_DIR}/fog-red.png`, png);
  const px = (x: number, y: number) => { const i = (shot.width * y + x) << 2; return [shot.data[i], shot.data[i + 1], shot.data[i + 2]]; };
  const centre = px(shot.width >> 1, (shot.height >> 1) + (shot.height >> 3));
  await js(`const HELD = ${HELD}, { scene } = await import('/lib/core.js'); delete scene.fog.density; scene.fog.density = 0.018; for (const k of HELD) delete scene.fog.color[k]; return true;`);

  check("WP0 the lake is drawn on the backend asked for, and every phase renders frames where it should be", setup.backend === "webgl" && setup.sheet
    && initial && rounds.flat().every((r) => r.settled && r.frames >= 40 && r.under === r.name.startsWith("under")
      && r.underside === !r.name.startsWith("above") && r.background === r.name.startsWith("under")),
    JSON.stringify({ setup, initial, phases: rounds.flat().map((r) => [r.name, r.frames, r.under, r.underside, r.background]) }));
  check("WP1a the band alone, the first time in: the underside's pipeline is ready before the camera gets there", rounds[0][0].made === 0, JSON.stringify([rounds[0][0].made, rounds[0][0].by]));
  check("WP1 the band alone (level..level+1, the sheet's underside): no new pipeline after the first crossing", sum(band) === 0 && sum(band, "sheet") === 0, JSON.stringify(band.map((r) => [r.name, r.made, r.by])));
  check("WP2 the fog: under the level after the first crossing, nothing but the sheet and the background asks for a pipeline (and they don't either, WP1/WP3)", sum(under, "other") === 0, JSON.stringify(under.map((r) => [r.name, r.by])));
  check("WP3 the background: under the level after the first crossing, the far-water background makes no new pipeline", sum(under, "background") === 0, JSON.stringify(under.map((r) => [r.name, r.by])));
  check("WP4 after the first crossing, the backend links or makes nothing at all: rounds 2 and 3 cost 0", sum(later) === 0, JSON.stringify(later.map((r) => [r.name, r.made])));
  check("WP5 the sky's fog still reaches above the water (a dense red fog paints the view down red)", !!shotSettled && centre[0] > 180 && centre[1] < 60 && centre[2] < 60, JSON.stringify(centre));
  const real = errors.filter((e) => !/popErrorScope|sky finish/.test(e));
  check("WP6 no page errors", real.length === 0, JSON.stringify(real.slice(0, 4)));
} catch (e) { check("the run threw", false, String((e as any)?.stack ?? e)); }
console.log(`[crossing-pipelines-check] ${tally.passed} passed, ${tally.failed} failed${tally.note()}`);
await bench.cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);
