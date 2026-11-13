// quadcolour — the VR panels' colour, delivered as authored.
//
// WHY (owner's headset pass, 09-30: "all colours on the VR panes look washed out"; only our panels, not other pages):
// the quads are MeshBasicMaterial with toneMapped:false, and WebGPURenderer (both its backends — the WebGL 2 one is
// what Chromium runs, desktop and headset) IGNORES material.toneMapped: tone mapping and the sRGB encode happen in ONE
// output pass over the whole frame (Renderer._renderOutput; `toneMapped` is read only by the classic WebGLRenderer).
// So every panel pixel went through ACES Filmic at the world's exposure: measured on the real renderer, --brand
// #8fe8c8 left as #b4dbce, --attn #ffc46b as #e6cc8a, the panel #051414 as #000404 (tools/xr-quad-colour-probe.mjs).
//
// The cure without a second pass (the XR frame has one output pass, per eye, and panels are in the scene): the quad's
// colour node applies the EXACT INVERSE of three's acesFilmicToneMapping at the live toneMappingExposure, so the
// output pass lands on the authored value (measured exact to the 8-bit level for every house token).
//
// Then the VR-only look (owner, 09-30: "colours are generally less vibrant in VR"): saturation and contrast in
// display (sRGB-encoded) space, applied to the quads only — never the design tokens, never the desktop.
// `gradeSRGB` (quadgrade.js) is the JS twin of the shader's grade; tools/quadcolour-test.mjs holds both to the same numbers.
import * as THREE from 'three';
import { GRADE_DEFAULT, GRADE_RANGE, LUMA, loadGrade, clampTo, storeGrade, ACES_IN_INV, ACES_OUT_INV, ACES_FIT } from './quadgrade.js';
import { Fn, vec3, vec4, mat3, texture, uniform, toneMappingExposure, sRGBTransferOETF, sRGBTransferEOTF, dot, mix, clamp, sqrt, max } from 'three/tsl';

// the inverse's constants live in quadgrade.js beside their JS twin (acesFilmicInverseJS), which the unit test round-trips
const { A, B, C, D, E } = ACES_FIT;

const uSat = uniform(1), uCon = uniform(1);
export function setGrade(g, persist = true) {
  const cur = loadGrade();
  const next = { saturation: clampTo(Number(g.saturation ?? cur.saturation), GRADE_RANGE.saturation, cur.saturation),
    contrast: clampTo(Number(g.contrast ?? cur.contrast), GRADE_RANGE.contrast, cur.contrast) };
  uSat.value = next.saturation; uCon.value = next.contrast;
  if (persist) storeGrade(next);
  return next;
}
export { GRADE_DEFAULT, GRADE_RANGE };
export const currentGrade = () => ({ saturation: uSat.value, contrast: uCon.value });
setGrade(loadGrade(), false);

// one channel of RRTAndODTFit⁻¹: y = (v² + Av − B)/(Cv² + Dv + E) solved for v ≥ 0
const rrtInv = (y) => {
  const yc = clamp(y, 0, 1);
  const a = yc.mul(C).oneMinus(), b = yc.mul(D).negate().add(A), c = yc.mul(E).add(B);
  return b.negate().add(sqrt(max(b.mul(b).add(a.mul(c).mul(4)), 0))).div(a.mul(2));
};
/** Linear working colour whose ACES Filmic (at the live exposure) is `lin` — the output pass's exact undo. */
export const acesFilmicInverse = Fn(([lin]) => {
  const y = mat3(...ACES_OUT_INV).mul(clamp(lin, 0, 1));
  const v = vec3(rrtInv(y.x), rrtInv(y.y), rrtInv(y.z));
  // NOT clamped at 0: a saturated hue (--brand's red channel, a strong yellow) needs a NEGATIVE linear input for
  // ACES's channel-mixing input matrix to land it; the output pass reads a HalfFloat target (three's default
  // outputBufferType), which carries it. Clamped, #8fe8c8 came out #a0e8c8 (the probe, 09-30).
  return mat3(...ACES_IN_INV).mul(v).mul(0.6).div(toneMappingExposure);
});

/** Swap a textured quad's material (an HTMLMesh's, or a head-locked canvas plate's) for one whose output is the
 *  authored (graded) colour after the renderer's output pass. Blending and depth settings carry over. */
export function quadMaterial(mesh, renderer) {
  const old = mesh.material, map = old.map;
  const m = new THREE.MeshBasicNodeMaterial({ map, transparent: old.transparent, alphaTest: old.alphaTest, side: old.side,
    depthTest: old.depthTest, depthWrite: old.depthWrite, fog: false });
  const t = texture(map);   // decoded to linear by the texture's own colorSpace (sRGB)
  const s = sRGBTransferOETF(t.rgb);
  const y = dot(s, vec3(...LUMA));
  const graded = clamp(mix(vec3(y), s, uSat).sub(0.5).mul(uCon).add(0.5), 0, 1);
  const lin = sRGBTransferEOTF(graded);
  const aces = renderer?.toneMapping === THREE.ACESFilmicToneMapping;
  // outputNode, not colorNode: NodeMaterial clamps its lit result at 0 ('force unsigned floats', NodeMaterial.js
  // setup) and the inverse needs negatives; outputNode replaces that result whole. The map stays the diffuse colour,
  // so alphaTest still cuts the frame's rounded corners from the texture's alpha.
  m.outputNode = vec4(aces ? acesFilmicInverse(lin) : lin, t.a);
  m.toneMapped = false;   // honoured by the classic WebGLRenderer only; kept so the intent reads the same everywhere
  mesh.material = m; old.dispose();
  // HTMLMesh.dispose() disposes `material` from its closure (the old one) — keep ours from leaking
  const dispose = mesh.dispose; if (dispose) mesh.dispose = function () { m.dispose(); return dispose.call(this); };
  return m;
}
