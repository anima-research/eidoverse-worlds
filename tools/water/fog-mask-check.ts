// tools/water/fog-mask-check.ts — the GPU fog keeps the combine law (shared/zone.js fogSlots' masks): in headless Chromium on
// WebGL, a pocket at or above the body's priority clears its fog, one below it or naming another body doesn't, one naming it does.
//   bun tools/water/fog-mask-check.ts        (BACKENDS=webgl,webgpu to try both; this host's headless shell has no WebGPU device)
// @ts-nocheck
import fs from "node:fs"; import path from "node:path";
import { ENGINE } from "../protocol/common.ts";
const { scratchBench } = await import(ENGINE + "tools/harness.ts");
const WORLD = "fogprobe", ME = "fogger";
const { cdp, evalJson, cleanup, BASE } = await scratchBench("fogprobe", { prepare: (scratch) => {
  const wd = path.join(scratch, "worlds"); fs.mkdirSync(wd, { recursive: true });
  const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", WORLD, "--owner", ME, "--title", "fog"], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: wd, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString()); } });
const errs = [];
cdp.on?.("Runtime.exceptionThrown", (m) => errs.push(JSON.stringify(m).slice(0, 400)));
try {
  for (const backend of (process.env.BACKENDS ?? "webgl").split(",")) {
  await cdp.send("Page.navigate", { url: `${BASE}/?name=${ME}&world=${WORLD}&spectate=1&${backend}=1` });
  for (let i = 0; i < 300; i++) { if (await evalJson("!!globalThis.__waterDebug").catch(() => false)) break; await Bun.sleep(100); }
  const out = await evalJson(`(async () => {
    const errors = []; const oe = console.error; console.error = (...a) => { errors.push(a.map(String).join(' ').slice(0, 300)); oe(...a); };
    const st = await import('/lib/state.js'); for (let i = 0; i < 200 && !st.state.hydrated; i++) await new Promise(r => setTimeout(r, 50));
    const { THREE, scene, camera, renderer } = await import('/lib/core.js'); await renderer.init?.();
    const { CONFIG } = await import('/lib/base.js'); CONFIG.renderer = true;
    const w = await import('/lib/watervolumes.js'); w.setWaterObjects(() => new Map());
    for (const o of scene.children) o.visible = false;
    const rec = (pos, comps) => ({ pos, q: [0,0,0,1], scale: 1, ...comps });
    const view = (pockets) => ({ ...st.state.st, entities: { sea: rec([0,-5,0], { zone: { shape: 'box', size: [100,10,100] }, water: { attenuationColor: [Math.exp(-.1),Math.exp(-.1),Math.exp(-.1)], attenuationDistance: 1, scatterColor: [0,0,0] } }), ...pockets } });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(10,10), new THREE.MeshBasicNodeMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
    mesh.position.set(0,-5,10); scene.add(mesh); camera.position.set(0,-5,-10); camera.lookAt(0,-5,10); camera.updateMatrixWorld();
    const rt = new THREE.RenderTarget(32,32); rt.texture.colorSpace = THREE.LinearSRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
    const px = [];
    const room = (prio, bodies) => rec([0,-5,0], { zone: { shape: 'box', size: [4,4,4], priority: prio }, 'water-exclusion': bodies ? { bodies } : {} });
    for (const pockets of [{}, {}, { room: room(0) }, { room: room(-1) }, { room: room(5, ['elsewhere']) }, { room: room(5, ['sea']) }]) {
      st.applyView(view(pockets)); w.updateWater(); renderer.setRenderTarget(rt); await renderer.compileAsync(scene, camera);
      renderer.render(scene, camera); const p = await renderer.readRenderTargetPixelsAsync(rt, 16, 16, 1, 1); px.push([...p]); renderer.setRenderTarget(null);
    }
    return { px, errors, debug: w.waterDebug(), backend: renderer.backend?.isWebGLBackend ? 'webgl' : 'webgpu' };
  })()`);
  console.log(backend, JSON.stringify(out));
  // [warm-up, no pocket, priority 0 (= the body's), priority -1, naming another body, naming the body]: cleared is brighter
  const [, fog, at, below, other, named] = out.px.map((p) => p[0]);
  const good = out.errors.length === 0 && out.backend === backend && at > fog && below === fog && other === fog && named === at;
  console.log(`${good ? "PASS" : "FAIL"} (${backend}): fog ${fog}, cleared ${at}; below ${below}, another body ${other}, named ${named}`);
  if (!good) process.exitCode = 1;
  }
  if (errs.length) { console.log("exceptions", errs); process.exitCode = 1; }
} finally { await cleanup(); }
