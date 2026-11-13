// overdraw — how many times is each pixel shaded in one frame, and by whom? (debug; EW.overdraw())
//
// Renders the live scene through the live camera with every material swapped for a clone whose fragment output is a
// constant 1, blended additively into a half-float target: red = fragments shaded at that pixel. Clones keep the
// vertex stage (NodeMaterial.copy shares the node graph; a scene.overrideMaterial would lose the meadow's positionNode).
//   mode 'actual' — real depth state and draw order: fragments that pass depth (alpha-tested ones count: shaded, then discarded)
//   mode 'raw'    — depth test off: every fragment rasterised; raw − actual is what early-Z already saves
// perTag adds one pass per category (grass, terrain, sky, avatars, …): that category counts, the rest write depth only.
//
// Limits: unbatched, one mono view, the live frame held during capture (a brief black blink in a headset). Per-category
// passes sum to the total within ~0.1 %, not exactly; `stable` checks the frame itself.
import { THREE, TSL, renderer, scene, camera } from '../core.js';
import { renderAside, setWorldHold } from '../render.js';
import { reassertShadowPref } from '../lightrig.js';

const { vec4 } = TSL;

function tagOf(o) {
  for (let n = o; n; n = n.parent) if (n.userData?.odTag) return n.userData.odTag;
  if (o.isSkinnedMesh) return 'avatars';
  const transparent = Array.isArray(o.material) ? o.material.some((m) => m?.transparent) : !!o.material?.transparent;
  for (let n = o; n; n = n.parent) if (n.userData?.entityId) return transparent ? 'entities (transparent)' : 'entities';
  return transparent ? 'other (transparent)' : 'other';
}

const halfToFloat = (h) => {
  const e = (h >> 10) & 0x1f, f = h & 0x3ff, s = h >> 15 ? -1 : 1;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
};

function stats(px, w, h) {
  const n = w * h, counts = new Float32Array(n);
  const half = px instanceof Uint16Array;
  let total = 0, covered = 0, max = 0;
  const hist = { 1: 0, 2: 0, '3-4': 0, '5-8': 0, '9-16': 0, '17+': 0 };
  for (let i = 0; i < n; i++) {
    const c = Math.round(half ? halfToFloat(px[i * 4]) : px[i * 4]);
    counts[i] = c; total += c;
    if (c > 0) {
      covered++; if (c > max) max = c;
      hist[c === 1 ? 1 : c === 2 ? 2 : c <= 4 ? '3-4' : c <= 8 ? '5-8' : c <= 16 ? '9-16' : '17+']++;
    }
  }
  return { total, covered, max, hist, meanPerPixel: +(total / n).toFixed(3), meanPerCovered: +(total / Math.max(1, covered)).toFixed(3), counts };
}

function heatURL(counts, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), img = g.createImageData(w, h);
  const ramp = [[0, 0, 0], [20, 40, 140], [30, 150, 90], [230, 210, 40], [240, 120, 20], [220, 30, 30], [255, 255, 255]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = counts[(h - 1 - y) * w + x];           // GL readback is bottom-up
    const k = v <= 0 ? 0 : v === 1 ? 1 : v === 2 ? 2 : v <= 4 ? 3 : v <= 8 ? 4 : v <= 16 ? 5 : 6;
    const o = (y * w + x) * 4; img.data[o] = ramp[k][0]; img.data[o + 1] = ramp[k][1]; img.data[o + 2] = ramp[k][2]; img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

/** One overdraw capture of the live view. Returns totals, a histogram, per-category fragment shares and (heat) a
 *  PNG data URL: black 0 · blue 1 · green 2 · yellow 3-4 · orange 5-8 · red 9-16 · white 17+. */
// one capture at a time: overlapping captures would swap each other's counting materials and lift the world hold early
let capturing = false;
export async function overdrawCapture(opts) {
  if (capturing) return { error: 'busy: an overdraw capture is already running' };
  capturing = true;
  try { return await captureOnce(opts); } finally { capturing = false; }
}
async function captureOnce({ mode = 'actual', w = 480, perTag = true, heat = false, camera: srcCam = camera, debugCounts = false } = {}) {
  // one frozen viewpoint for compile and every pass: the world keeps ticking while the clones compile
  srcCam.updateMatrixWorld(true);
  const cam = srcCam.isPerspectiveCamera ? new THREE.PerspectiveCamera(srcCam.fov, srcCam.aspect, srcCam.near, srcCam.far) : srcCam.clone();
  srcCam.matrixWorld.decompose(cam.position, cam.quaternion, cam.scale);
  cam.projectionMatrix.copy(srcCam.projectionMatrix); cam.projectionMatrixInverse.copy(srcCam.projectionMatrixInverse);
  cam.updateMatrixWorld(true);
  const h = Math.max(1, Math.round(w / (srcCam.aspect || 16 / 9)));
  const draw = [];
  scene.traverseVisible((o) => { if ((o.isMesh || o.isLine || o.isPoints || o.isSprite) && o.material) draw.push(o); });
  const orig = new Map(draw.map((o) => [o, o.material]));
  const tag = new Map(draw.map((o) => [o, tagOf(o)]));
  const clones = new Map();
  let nonNode = 0;
  const mk = (m, role) => {
    const k = m.uuid + role;
    let c = clones.get(k);
    if (!c) {
      if (!m.isNodeMaterial) nonNode++;
      c = m.clone();
      c.fragmentNode = vec4(1, 0, 0, 1);
      c.blending = THREE.AdditiveBlending;
      if (role === 'depth') c.colorWrite = false;
      if (mode === 'raw') { c.depthTest = false; c.depthWrite = false; }
      clones.set(k, c);
    }
    return c;
  };
  const swap = (roleOf) => {
    for (const o of draw) {
      const m = orig.get(o), r = roleOf(o);
      o.material = Array.isArray(m) ? m.map((x) => mk(x, r)) : mk(m, r);
    }
  };
  const shadowLights = [];
  scene.traverse((o) => { if (o.isLight && o.shadow) shadowLights.push([o, o.shadow.autoUpdate]); });
  const saved = { bg: scene.background, cc: renderer.getClearColor(new THREE.Color()), ca: renderer.getClearAlpha() };
  const tags = [...new Set(tag.values())];
  // '*' is rendered FIRST and LAST: equal totals prove nothing moved between passes (the self-check behind 'stable')
  const passes = [['*', () => 'count'], ...(perTag ? tags.map((t) => [t, (o) => (tag.get(o) === t ? 'count' : 'depth')]) : []), ['*2', () => 'count']];
  const out = { mode, size: `${w}x${h}`, objects: draw.length, materials: new Set([...orig.values()].flat()).size };
  const rts = [];
  setWorldHold(true);
  try {
    scene.background = null;
    for (const [l] of shadowLights) l.shadow.autoUpdate = false;
    renderer.setClearColor(0x000000, 0);
    // every clone compiles async before the first draw
    swap(() => 'count'); await renderer.compileAsync(scene, cam);
    if (perTag && tags.length > 1) { swap(() => 'depth'); await renderer.compileAsync(scene, cam); }
    // every pass in one synchronous block (nothing ticks between them), each into its own target; readbacks after
    for (const [name, roleOf] of passes) {
      swap(roleOf);
      const rt = new THREE.RenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true });
      rts.push([name, rt]);
      renderer.setRenderTarget(rt); renderer.clear(); renderer.setRenderTarget(null);
      renderAside(scene, cam, rt);
    }
    const res = {};
    for (const [name, rt] of rts) res[name] = stats(await renderer.readRenderTargetPixelsAsync(rt, 0, 0, w, h), w, h);
    const all = res['*'];
    out.stable = res['*2'].total === all.total;   // false → something animated between passes; treat byTag as approximate
    if (!out.stable) out.drift = res['*2'].total - all.total;
    Object.assign(out, { pixels: w * h, covered: all.covered, total: all.total, meanPerPixel: all.meanPerPixel, meanPerCovered: all.meanPerCovered, max: all.max, hist: all.hist, nonNodeMaterials: nonNode });
    if (perTag && tags.length) {
      out.byTag = Object.fromEntries(tags.map((t) => [t, { fragments: res[t].total, covered: res[t].covered, share: +(res[t].total / Math.max(1, all.total)).toFixed(3), perCovered: res[t].meanPerCovered }])
        .sort((a, b) => b[1].fragments - a[1].fragments));
    }
    if (heat) out.heat = heatURL(all.counts, w, h);
    if (debugCounts) out.counts = Object.fromEntries(Object.entries(res).map(([k, v]) => [k, Array.from(v.counts)]));
  } finally {
    for (const [o, m] of orig) o.material = m;
    scene.background = saved.bg;
    for (const [l, a] of shadowLights) l.shadow.autoUpdate = a;
    reassertShadowPref();   // a shadows toggle mid-measure wins over the saved value
    renderer.setClearColor(saved.cc, saved.ca);
    setWorldHold(false);
    for (const [, rt] of rts) rt.dispose();
    for (const c of clones.values()) c.dispose();
  }
  return out;
}
