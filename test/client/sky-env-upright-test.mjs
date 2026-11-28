// sky-env-upright-test — scene.environment is the right way up. sky_baked.js copies ("blits") each bake into the
// persistent equirect target that is scene.environment; three reads that target with equirectUV (v = 1 at the zenith)
// in PMREM and every lit material. The render lab's chrome sphere (11-23) showed the sky and a second sun in its lower
// half: the blit wrote the bake upside down, on both backends.
// Three r186 samples a render-target texture top-down on both backends: uv v reads what was drawn at clip-space
// y = 1 − 2v (TextureNode.setupUV flips v on GLSL, whose framebuffers are bottom-up; WGSL needs no flip). A copy is a
// copy only if each target texel, drawn at clip y, samples its source at that same v = (1 − y) / 2. The pixels
// themselves are the live check's (render-lab probe: readback of both targets + the chrome sphere).
// The REAL sky_baked.js; the renderer is a fake that records each draw's scene and camera.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/sky-env-upright-test.mjs
// Mutation (must go red): drop the uv flip on blitGeo in sky_baked.js ensureEnvRig (U1, U2).
import { fileURLToPath } from "node:url";
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { mock } from 'bun:test';
import { suite } from "../gate/suite.ts";
GlobalRegistrator.register({ url: 'http://localhost/?world=t&name=p' });
const S = suite("sky-env-upright");
const check = (n, ok, d) => S.check(n, ok, d);
const THREE = await import('three/webgpu');
const TSL = await import('three/tsl');
const lib = (f) => fileURLToPath(new URL(`../../client/lib/${f}`, import.meta.url));

const scene = new THREE.Scene();
let bound = null;
const draws = [];
const renderer = {
  backend: { isWebGLBackend: true }, xr: { isPresenting: false }, autoClear: true,
  getRenderTarget: () => bound, setRenderTarget(t) { bound = t; },
  render(sc, cam) { draws.push({ target: bound, sc, cam }); }, renderAsync: async () => {}, compileAsync: async () => {},
};
const bus = { on() { return () => {}; }, emit() {} };
mock.module(lib('core.js'), () => ({ THREE, TSL, scene, renderer, camera: new THREE.PerspectiveCamera() }));
mock.module(lib('base.js'), () => ({ bus, tee() {}, teeNow() {}, report() {}, CONFIG: { params: new URLSearchParams('') } }));
mock.module(lib('render/warmqueue.js'), () => ({ warm: async (_n, fn) => fn(), P_AMBIENT: 0 }));
mock.module(lib('render/framebudget.js'), () => ({ ask: () => true, spent() {}, turn() {}, busy: () => false }));

const SB = await import(lib('sky/sky_baked.js'));

// a mesh's vertices as (clip y, uv v) pairs, through the camera it was drawn with
const clipUV = (mesh, cam) => {
  cam.updateMatrixWorld(true); mesh.updateMatrixWorld(true);
  const pos = mesh.geometry.attributes.position, uv = mesh.geometry.attributes.uv, p = new THREE.Vector3(), out = [];
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).project(cam);
    out.push({ x: p.x, y: p.y, u: uv.getX(i), v: uv.getY(i) });
  }
  return out;
};
const close = (a, b, t = 1e-5) => Math.abs(a - b) < t;
// three's equirectUV (src/nodes/utils/EquirectUV.js): v = asin(y) / π + 0.5
const equirectV = (elevDeg) => Math.asin(Math.sin(elevDeg * Math.PI / 180)) / Math.PI + 0.5;
// a render-target texture, sampled at v, returns what was drawn at clip y = 1 − 2v (both backends; see the header)
const clipYRead = (v) => 1 - 2 * v;

// U0: the bake side. The engine's bake (sky_system.js bakeEnv) draws a PlaneGeometry(2, 2) quad whose fragment turns
// its uv into a direction with lat = (0.5 − uv.y)·π; sky_baked's band strips must carry the same uv at the same clip y
const bakeTarget = new THREE.RenderTarget(64, 32);
const bakeMat = new THREE.MeshBasicNodeMaterial();
const bakeScene = new THREE.Scene(); bakeScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bakeMat));
const bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
await SB.bandedBakeRender(renderer, bakeScene, bakeCam, bakeTarget, { nextFrame: async () => {} });
const bandDraw = draws.find((d) => d.target === bakeTarget);
const bandVerts = bandDraw ? bandDraw.sc.children.flatMap((m) => clipUV(m, bandDraw.cam)) : [];
check('U0 the bake\'s band strips carry uv v at clip y = 2v − 1, as the engine\'s own full quad does',
  bandVerts.length > 0 && bandVerts.every((q) => close(q.y, 2 * q.v - 1)), bandVerts.slice(0, 4));
// the bake's direction at clip y (engine formula on the quad uv, v = (y + 1) / 2)
const bakeLatAt = (clipY) => (0.5 - (clipY + 1) / 2) * 180;

// U1: the env blit is a copy: each env texel samples its source at the v that three will read the env texel at
const env = SB.envTexture();
scene.environment = bakeTarget.texture;   // as sky.js's post-bake path: the engine points scene.environment at its target
SB.adoptEnvironment();
const blit = draws.filter((d) => d.target === env.renderTarget).pop();
check('U1a adoptEnvironment draws into the persistent env target and puts it back', !!blit && scene.environment === env);
const blitMesh = blit?.sc.children[0];
const colorNode = blitMesh?.material?.colorNode;
// the test reads the geometry's uv: the material must sample through it (no uv node of its own)
check('U1b the blit samples its source through the blit geometry\'s own uv', colorNode?.isTextureNode && colorNode.uvNode == null,
  colorNode?.uvNode?.constructor?.name);
const verts = blitMesh ? clipUV(blitMesh, blit.cam) : [];
check('U1 every env texel, drawn at clip y, samples its source at v = (1 − y)/2: the copy is upright',
  verts.length > 0 && verts.every((q) => close(q.v, (1 - q.y) / 2)), verts.map((q) => `y ${q.y.toFixed(2)} → v ${q.v.toFixed(2)}`));
check('U1c and is not mirrored left-right: u = (x + 1)/2', verts.length > 0 && verts.every((q) => close(q.u, (q.x + 1) / 2)));

// U2: end to end, the elevation three's equirect lookup reads from the env when it asks for elevation e is e
// (env read at v → env clip y → the source v the blit sampled there → the bake's clip y → the bake's direction)
const srcVAtClipY = (y) => {   // the blit quad's uv is linear in y: interpolate between its bottom and top vertices
  const lo = verts.reduce((a, q) => (q.y < a.y ? q : a)), hi = verts.reduce((a, q) => (q.y > a.y ? q : a));
  return lo.v + (hi.v - lo.v) * (y - lo.y) / (hi.y - lo.y);
};
const seen = (e) => bakeLatAt(clipYRead(srcVAtClipY(clipYRead(equirectV(e)))));
const elevs = [90, 43.8, 10, 0, -30, -90];
check('U2 looking up the environment at elevation e finds the bake\'s sky at e (zenith, sun at 43.8°, horizon, ground)',
  verts.length > 0 && elevs.every((e) => close(seen(e), e, 1e-3)), elevs.map((e) => `${e}° → ${seen(e).toFixed(1)}°`));

S.done();
