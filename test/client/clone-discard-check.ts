// clone-discard — a model object the client lets go of takes what three made for it per OBJECT with it, in a real headless
// browser on the client's own loader (assets.js loadGLB) and renderer (WebGL 2):
//   CD1 the control: N clones loadGLB made and that are simply dropped leave their RenderObjects behind: dispose listeners
//       on the proto's shared geometry and materials and uniform buffers grow (programs do not, here: headless WebGL 2
//       shares one pipeline across these clones; on the RTX 4080 / WebGPU they grew too, render lab 11-26) (if this row fails, the bench
//       cannot see the leak and CD2 proves nothing)
//   CD2 the same N, each dropped through render/discard.js discardObject: listeners, uniform buffers and programs do not grow
//   CD3 a DRAWN object discarded while another placement of the same model stands where it stood (a swap: the replacement
//       on its spot) and a third beside it: the frame afterwards is the frame before it was added, pixel for pixel; no
//       shared geometry or material was disposed; the standing placements keep their RenderObjects (listeners as before)
//   CD4 the build ghost: holding a library model and putting it down (cancelGhost) N times leaves no listeners behind
// The realizer's drop sites (a refused or same-tier re-tier, a stale load, a swap, a demote, a retire) are lod-client 4b/4c,
// over a stub loader that counts the dispose events; this bench is what those events buy, on the real thing.
//   bun test/client/clone-discard-check.ts   (its own scratch server, library, world and Chromium)
// WebGL 2 on Linux/macOS: headless Chromium there destroys its WebGPU device at once (the harness's GPU guard). NOT on
// Windows: with the runner's software flags (chrome.ts) a forced WebGL 2 context is null, core.js's renderer.init() throws
// and the page never boots (#378's windows-latest run 45863011154; as party-probe, swim-lists, water-cross), so there the
// client picks its own backend. Both backends count programs and uniform buffers in three's common layer (Pipelines.js,
// Bindings.js), and RenderObject.onObjectDispose is backend-independent; the RTX 4080 / WebGPU counts are also the live
// probe's (render lab, 11-26).
// Mutations (must go red, by hand): discardObject a no-op (CD2, CD4); dispose the geometry/materials too (CD3);
// discardObject entering every child, the other placement included (CD3 when the standing one rides it: not set up here).
import { scratchBench, mkCheck } from "../harness/harness.ts";
import { until } from "../gate/wait.ts";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORLD = "clone-discard";
const MODEL = "eidoverse/assets/models/clone_discard_pair.glb";
const LIB = mkdtempSync(join(tmpdir(), "ew-clone-discard-lib-"));
// two meshes, two materials: a shared proto with more than one RenderObject per clone
{
  const { Document, NodeIO } = await import("@gltf-transform/core");
  const doc = new Document(); const buf = doc.createBuffer();
  const quad = (x: number, name: string, rgb: [number, number, number]) => {
    const pos = new Float32Array([x, 0, 0, x + 0.8, 0, 0, x, 0.8, 0, x + 0.8, 0.8, 0]);
    const prim = doc.createPrimitive().setMaterial(doc.createMaterial(name).setBaseColorFactor([...rgb, 1]).setMetallicFactor(0).setRoughnessFactor(0.8).setDoubleSided(true))
      .setIndices(doc.createAccessor().setType("SCALAR").setBuffer(buf).setArray(new Uint16Array([0, 1, 2, 2, 1, 3])))
      .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setBuffer(buf).setArray(pos));
    return doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim));
  };
  doc.createScene("s").addChild(quad(-0.4, "a", [0.9, 0.3, 0.2])).addChild(quad(-0.4, "b", [0.2, 0.5, 0.9]).setTranslation([0, 0.9, 0]));
  mkdirSync(join(LIB, "eidoverse/assets/models"), { recursive: true });
  writeFileSync(join(LIB, MODEL), await new NodeIO().writeBinary(doc));
}

const bench = await scratchBench("clone-discard", { worlds: [WORLD], serverEnv: { EIDOVERSE_DIR: LIB } });
const { cdp, evalJson, BASE } = bench;
const { check, tally } = mkCheck();
const errors: string[] = [];
bench.cws.addEventListener("message", (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.method === "Runtime.exceptionThrown") errors.push(String(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text).slice(0, 300));
});
const js = (body: string) => evalJson(`(async () => { ${body} })()`);
const N = 6;
// WebGL 2 except on Windows, where the runner's forced WebGL 2 context is null (see the header)
const FORCE_WEBGL = process.platform !== "win32";
try {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 180, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `${BASE}/?world=${WORLD}&spectate=1&name=cd${FORCE_WEBGL ? "&webgl=1" : ""}` });
  try { await until("the client's render path", () => evalJson("import('/lib/render/render.js').then(() => true, () => false)").catch(() => false), { ms: 60000 }); }
  catch (e) {   // say why: the import's own rejection (a null forced WebGL 2 context reads as "getSupportedExtensions" of null)
    const why = await evalJson("import('/lib/render/render.js').then(() => 'loaded', (x) => String(x?.stack ?? x).slice(0, 400))").catch((x: any) => String(x));
    throw new Error(`${(e as Error).message}; the import says: ${why} | page errors: ${JSON.stringify(errors.slice(0, 4))}`);
  }
  await until("the world hydrated", () => js("return (await import('/lib/state.js')).state.hydrated;"), { ms: 30000 });
  await js("for (let i = 0; i < 10; i++) await new Promise((r) => requestAnimationFrame(r)); return true;");

  const setup = await js(`const g = globalThis, { THREE, renderer, camera } = await import('/lib/core.js'), R = await import('/lib/render/render.js');
    g.__A = await import('/lib/assets.js'); g.__D = await import('/lib/render/discard.js');
    R.setWorldHold(true);
    // the client's camera, pinned looking at the origin: loadGLB compiles each fresh clone (at the origin, detached)
    // against it, and three culls a compile by the frustum
    const P = new THREE.Vector3(0, 0.8, 3), L = new THREE.Vector3(0, 0.8, 0);
    const Q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(P, L, new THREE.Vector3(0, 1, 0)));
    const pin = () => { camera.position.copy(P); camera.quaternion.copy(Q); };   // (lookAt itself updates the world matrix)
    const a = camera.updateMatrixWorld.bind(camera), w = camera.updateWorldMatrix.bind(camera);
    camera.updateMatrixWorld = (f) => { pin(); a(f); }; camera.updateWorldMatrix = (p, c) => { pin(); w(p, c); };
    camera.updateMatrixWorld(true);
    // the first placement, worn for the whole run: the proto's geometry and materials are its
    const S = await g.__A.loadGLB(${JSON.stringify(MODEL)}); S.position.set(-1.2, 0, 0);
    const geos = new Set(), mats = new Set(); S.traverse((n) => { if (n.isMesh) { geos.add(n.geometry); for (const m of [].concat(n.material)) mats.add(m); } });
    g.__shared = [...geos, ...mats];
    g.__sharedDisposed = 0; for (const x of g.__shared) x.addEventListener('dispose', () => { g.__sharedDisposed++; });
    g.__count = () => { let l = 0; for (const x of g.__shared) l += x._listeners?.dispose?.length ?? 0; const i = renderer.info.memory; return { listeners: l, programs: i.programs, uniformBuffers: i.uniformBuffers }; };
    // a scene of our own, drawn into the canvas and read back in the same task (post-pixels-check's pattern)
    const MS = new THREE.Scene(); MS.background = new THREE.Color(0.05, 0.06, 0.08); MS.add(new THREE.AmbientLight(0xffffff, 1.5)); MS.add(S);
    const cv = renderer.domElement, W = cv.width, H = cv.height;
    const c2 = document.createElement('canvas'); c2.width = W; c2.height = H; const g2 = c2.getContext('2d', { willReadFrequently: true });
    g.__frame = () => { renderer.setRenderTarget(null); renderer.render(MS, camera); g2.clearRect(0, 0, W, H); g2.drawImage(cv, 0, 0); return g2.getImageData(0, 0, W, H).data; };
    g.__settle = async () => { let prev = null; for (let i = 0; i < 90; i++) { await new Promise((r) => requestAnimationFrame(r)); const px = g.__frame(); if (prev && px.every((v, j) => v === prev[j])) return px; prev = px; } return null; };
    g.__MS = MS; g.__S = S;
    return { backend: renderer.backend?.isWebGLBackend ? 'webgl' : 'webgpu', meshes: geos.size, mats: mats.size, ...g.__count() };`);
  check(`CD0 the bench: the client's ${FORCE_WEBGL ? "WebGL 2" : "own"} renderer, the model's proto (2 meshes, 2 materials) worn by one placement`,
    (!FORCE_WEBGL || setup?.backend === "webgl") && !!setup?.backend && setup.meshes === 2 && setup.mats === 2, JSON.stringify(setup));

  const arm = (discard: boolean) => js(`const g = globalThis; await g.__settle(); const a = g.__count();
    for (let i = 0; i < ${N}; i++) { const o = await g.__A.loadGLB(${JSON.stringify(MODEL)}); ${discard ? "g.__D.discardObject(o);" : ""} }
    for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r)); const b = g.__count();
    return { listeners: b.listeners - a.listeners, programs: b.programs - a.programs, uniformBuffers: b.uniformBuffers - a.uniformBuffers, before: a, after: b };`);
  const plain = await arm(false);
  check(`CD1 control: ${N} clones dropped plain leave RenderObjects behind (listeners, uniform buffers grow)`, plain.listeners > 0 && plain.uniformBuffers > 0, JSON.stringify(plain));
  const disc = await arm(true);
  check(`CD2 ${N} clones dropped through discardObject leave nothing: listeners, uniform buffers and programs do not grow`,
    disc.listeners <= 0 && disc.uniformBuffers <= 0 && disc.programs <= 0, JSON.stringify({ discarded: disc, plain }));

  const swap = await js(`const g = globalThis, A = g.__A, D = g.__D, MS = g.__MS;
    const R2 = await A.loadGLB(${JSON.stringify(MODEL)}); R2.position.set(1.2, 0, 0); MS.add(R2);   // the replacement, on the spot
    const ref = await g.__settle(); const c0 = g.__count(), d0 = g.__sharedDisposed;
    const old = await A.loadGLB(${JSON.stringify(MODEL)}); old.position.set(1.2, 0, 0); MS.add(old);  // the object it replaces, drawn
    await g.__settle(); const cDrawn = g.__count();
    MS.remove(old); D.discardObject(old);
    const after = await g.__settle(); const c1 = g.__count();
    let diff = 0; if (ref && after) for (let j = 0; j < ref.length; j++) if (ref[j] !== after[j]) diff++;
    let lit = 0; if (after) for (let j = 0; j < after.length; j += 4) if (after[j] > 60) lit++;
    return { settled: !!ref && !!after, diff, lit, sharedDisposed: g.__sharedDisposed - d0, listeners: [c0.listeners, cDrawn.listeners, c1.listeners], ubos: [c0.uniformBuffers, cDrawn.uniformBuffers, c1.uniformBuffers] };`);
  check("CD3 a drawn object discarded with its replacement on its spot and another placement beside it: the frame after is the frame before it came, no shared geometry or material disposed, the standing two keep their RenderObjects",
    swap.settled && swap.diff === 0 && swap.lit > 0 && swap.sharedDisposed === 0 && swap.listeners[1] > swap.listeners[0] && swap.listeners[2] === swap.listeners[0],
    JSON.stringify(swap));

  const ghost = await js(`const g = globalThis, B = await import('/lib/edit/build.js'); await g.__settle(); const a = g.__count();
    for (let i = 0; i < ${N}; i++) { await B.holdGhost(${JSON.stringify(MODEL)}, 'pair'); B.cancelGhost(); }
    for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r)); const b = g.__count();
    return { listeners: b.listeners - a.listeners, uniformBuffers: b.uniformBuffers - a.uniformBuffers, programs: b.programs - a.programs };`).catch((e: any) => ({ error: String(e).slice(0, 300) }));
  check(`CD4 the build ghost: held and put down ${N} times, its clones leave no listeners on the shared proto`, !ghost.error && ghost.listeners <= 0, JSON.stringify(ghost));
  check("no page exception", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) { check("the run threw", false, String((e as any)?.stack ?? e)); }
console.log(`[clone-discard-check] ${tally.passed} passed, ${tally.failed} failed${tally.note()}`);
await bench.cleanup(tally.failed ? 1 : 0);
try { rmSync(LIB, { recursive: true, force: true }); } catch { /* */ }
process.exit(tally.failed ? 1 : 0);
