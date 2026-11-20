// shader-draft — the reader for the DRAFT component `antra/shader` (docs/contributing/COMPONENT-LADDER.md, rung 1;
// what the code may say: docs/guide/SHADERS.md).
//
// `antra/shader = {code, params?}` gives every material of a thing a shader; `antra/shader:<slot>` gives one (the slot
// names are material_draft.js's). The code is checked and turned into a graph by shared/shaderlang.js (it is never run
// as code), and ../render/shader-emit.js builds the graph as the renderer's nodes on a per-thing COPY of the material:
// material_draft.js owns the copies, so a shader and a hesperus/material override share one. A value that isn't
// {code: <text that compiles>} is absent: the thing shows its own material, and nothing throws.
//
// `params` are the shader's uniforms by name (a number, or a list for a vec); a uniform the component doesn't set reads
// the thing's own `params` component, so a script's world.param(id, name, n) moves a shader. Changing one is a uniform
// write: nothing recompiles.

import { THREE, TSL } from '../core.js';
import { report } from '../base.js';
import { serverNow } from '../serverclock.js';
import { compileShader, uniformValue } from '../../../shared/shaderlang.js';
import { emitShader } from '../render/shader-emit.js';
import { registerDraft } from '../../../shared/drafts.js';

export const SHADER = 'antra/shader';
export const isShaderKey = (k) => k === SHADER || String(k).startsWith(`${SHADER}:`);
registerDraft(SHADER, { title: 'Shader', summary: 'draw it with code: colour, glow, roughness, opacity and the surface\'s shape, per pixel (a draft this client reads)', category: 'Look',
  blank: { code: 'color = baseColor;' }, applies: (ent) => ent?.model != null || (ent?.mesh && typeof ent.mesh === 'object') });

// the world's clock in seconds, wrapped hourly so it stays exact in a 32-bit float: one uniform for every shader
const time = TSL.uniform(0).onRenderUpdate(() => (serverNow() / 1000) % 3600);

const graphs = new Map();   // code → its graph, or null when it doesn't compile (bounded: the oldest is dropped)
function graphOf(code) {
  if (graphs.has(code)) return graphs.get(code);
  const r = compileShader(code); const g = r.ok ? r : null;
  if (graphs.size >= 128) graphs.delete(graphs.keys().next().value);
  graphs.set(code, g);
  return g;
}
const read = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.code !== 'string') return null;
  const graph = graphOf(v.code); if (!graph) return null;
  return { code: v.code, graph, params: v.params && typeof v.params === 'object' && !Array.isArray(v.params) ? v.params : null };
};
/** The shader a material slot wears: the slot's own over the thing's; null when it has none that compiles. */
export function shaderFor(bag, slot) { return (slot ? read(bag?.[`${SHADER}:${slot}`]) : null) ?? read(bag?.[SHADER]); }

// a model's materials are three's classic ones (the renderer makes their node twins itself); a shader needs the node
// class, so the copy is built the way the renderer builds its twin: the same class of material, every property carried over
const nodeClass = (m) => (m.isMeshPhysicalMaterial ? THREE.MeshPhysicalNodeMaterial : m.isMeshStandardMaterial ? THREE.MeshStandardNodeMaterial
  : m.isMeshBasicMaterial ? THREE.MeshBasicNodeMaterial : m.isMeshLambertMaterial ? THREE.MeshLambertNodeMaterial : m.isMeshPhongMaterial ? THREE.MeshPhongNodeMaterial : null);
function nodeCopy(mat) {
  if (mat.isNodeMaterial) return mat.clone();
  const Cls = nodeClass(mat); if (!Cls) return null;
  const from = mat.clone(), c = new Cls();   // `from` owns its colours and vectors; textures stay shared
  for (const k in from) if (k !== 'uuid' && k !== 'type' && k !== 'version') c[k] = from[k];
  return c;
}

/** A copy of `mat` for `mesh`, drawn by the shader, or null if it can't be built (the caller keeps the plain copy). */
export function dressShader(mat, sh, mesh) {
  try {
    const c = nodeCopy(mat); if (!c) return null;
    const { outputs: o, discard, uniforms } = emitShader({ TSL, THREE }, sh.graph, time, (name) => !!mesh?.geometry?.attributes?.[name]);
    const wrapped = !!mat.userData?.envWrapped;
    if (o.color || o.roughness || o.metalness) {
      // the factory composed its wetness and cloud shade over the material's own nodes (render/materials.js): take that
      // off the copy, so prepareMaterial composes it over the shader's instead
      if (wrapped) { c.colorNode = null; c.roughnessNode = null; c.metalnessNode = null; delete c.userData.envWrapped; }
      if (o.color) c.colorNode = TSL.vec4(o.color, TSL.materialColor.a);
      if (o.roughness) c.roughnessNode = o.roughness;
      if (o.metalness) c.metalnessNode = o.metalness;
    }
    if (o.emissive) c.emissiveNode = o.emissive;
    if (o.opacity) c.opacityNode = o.opacity;
    if (o.position) c.positionNode = o.position;
    if (o.normal) c.normalNode = TSL.transformNormalToView(TSL.normalize(o.normal));
    if (discard) {
      c.maskNode = c.maskNode ? TSL.bool(c.maskNode).and(discard.not()) : discard.not();
      if (wrapped) { c.maskShadowNode = null; delete c.userData.shadowFade; }   // the shadow pass is cut out the same way
    }
    c.__uniforms = uniforms; c.__seeThrough = !!o.opacity;
    return c;
  } catch (e) { report?.('shader draft', e); return null; }
}
/** Write a dressed copy's uniforms from the component's params and the thing's own. */
export function writeShaderUniforms(c, sh, thingParams) {
  if (!c?.__uniforms) return;
  for (const [name, u] of c.__uniforms) {
    const v = uniformValue({ name, type: u.type }, sh.params, thingParams);
    if (u.type === 'float') u.node.value = v[0]; else u.node.value.fromArray(v);
  }
  if (c.__seeThrough) c.transparent = true;
}
