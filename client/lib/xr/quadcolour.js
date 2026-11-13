// quadcolour — the VR panels' colour, delivered as authored.
//
// WebGPURenderer ignores material.toneMapped: tone mapping and the sRGB encode happen in one output pass over the whole
// frame, so panel pixels went through ACES Filmic at the world's exposure and read washed out
// (test/client/xr-quad-colour-probe.mjs). The cure: the quad's output node applies the exact inverse of three's
// acesFilmicToneMapping at the live exposure, so the output pass lands on the authored value.
// On top, a VR-only saturation/contrast grade in sRGB space, quads only (never the design tokens or the desktop);
// quadgrade.js holds its JS twin and test/client/quadcolour-test.mjs holds both to the same numbers.
import * as THREE from 'three';
import { GRADE_DEFAULT, GRADE_RANGE, LUMA, loadGrade, clampTo, storeGrade, ACES_IN_INV, ACES_OUT_INV, ACES_FIT } from './quadgrade.js';
import { Fn, vec3, vec4, mat3, texture, uniform, toneMappingExposure, sRGBTransferOETF, sRGBTransferEOTF, dot, mix, clamp, sqrt, max } from 'three/tsl';

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
  // not clamped at 0: saturated hues need a negative linear input for ACES's input matrix to land them; the output
  // pass reads a HalfFloat target, which carries it
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
  // outputNode, not colorNode: NodeMaterial clamps its lit result at 0 and the inverse needs negatives. The map stays
  // the diffuse colour, so alphaTest still cuts the rounded corners from the texture's alpha.
  m.outputNode = vec4(aces ? acesFilmicInverse(lin) : lin, t.a);
  m.toneMapped = false;   // honoured by the classic WebGLRenderer only; kept so the intent reads the same
  mesh.material = m; old.dispose();
  // HTMLMesh.dispose() disposes `material` from its closure (the old one) — keep ours from leaking
  const dispose = mesh.dispose; if (dispose) mesh.dispose = function () { m.dispose(); return dispose.call(this); };
  return m;
}
