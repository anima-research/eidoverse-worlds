// material — what a `material` component MEANS: an image on a NAMED node of the thing's model (glTF's material
// baseColorTexture, Godot's surface_material_override). A standalone image is a picture (shared/picture.js); R 10-27: two
// shapes, no overlap. Shared by the browser host (client/lib/materialcomp.js), the door and every reader.
//
//   material {node, texture, description?, lit?}
//   comp {id, type: "material", data: null}          # the node wears its own material again
//
// `texture` is a picture's source, by the same rule (shared/mediasrc.js); `node` is a node's name as its file spells it
// (measure lists them). The host clones that node's material, textures the clone and restores the original on removal.

import { mediaTier } from './mediasrc.js';
import { graphemes, graphemeList, quoted } from './text.js';
import { PICTURE_LIT, PICTURE_DESCRIPTION_MAX } from './picture.js';

export const MATERIAL_NODE_MAX = 64;
const KNOWN_KEYS = new Set(['node', 'texture', 'description', 'lit']);

/** Validate an authored bag: {ok: false, why} or {ok: true, material, tier, notes}. */
export function normalizeMaterial(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, why: 'material data must be an object {node, texture, description?, lit?}' };
  if (typeof data.node !== 'string' || !data.node.trim() || data.node.length > MATERIAL_NODE_MAX) {
    return { ok: false, why: `node must name a node of its model (a non-empty string, ≤${MATERIAL_NODE_MAX} characters): measure lists them` };
  }
  const tier = mediaTier(data.texture, 'image');
  if (tier.tier === 'bad') return { ok: false, why: `texture: ${tier.why} — ${tier.fix}` };
  const notes = [];
  const unknown = Object.keys(data).filter((k) => !KNOWN_KEYS.has(k) && !k.startsWith('_'));
  if (unknown.length) notes.push(`ignored by the evaluator: ${unknown.join(', ')} (accepted: ${[...KNOWN_KEYS].join(', ')})`);
  const material = { node: data.node.trim(), texture: data.texture, lit: 'scene' };
  if (data.description != null) {
    const d = String(data.description).replace(/\s+/g, ' ').trim();
    if (graphemes(d) > PICTURE_DESCRIPTION_MAX) { notes.push(`description clipped to ${PICTURE_DESCRIPTION_MAX} characters`); material.description = graphemeList(d).slice(0, PICTURE_DESCRIPTION_MAX).join(''); }
    else if (d) material.description = d;
  }
  if (data.lit != null) {
    if (Object.hasOwn(PICTURE_LIT, data.lit)) material.lit = data.lit;
    else notes.push(`lit ${JSON.stringify(data.lit)} is unknown (${Object.keys(PICTURE_LIT).join('/')}) — using scene`);
  }
  return { ok: true, material, tier, notes };
}

/** The one line look() carries for a material: what the author said is on which node; never anything about pixels. */
export function describeMaterial(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'an image on a part of it (malformed declaration)';
  const node = typeof data.node === 'string' && data.node.trim() ? data.node.trim() : null;
  const file = typeof data.texture === 'string' ? (/^https:/i.test(data.texture) ? (() => { try { return new URL(data.texture).hostname; } catch { return 'a link'; } })() : data.texture.split('/').pop()) : null;
  const said = typeof data.description === 'string' && data.description.trim() ? data.description : null;
  const bits = [];
  if (!node || mediaTier(data.texture, 'image').tier === 'bad') bits.push('not shown: invalid declaration');
  if (data.lit === 'self') bits.push('self-lit');
  const tail = bits.length ? ` (${bits.join('; ')})` : '';
  const where = node ? ` on its ${node}` : '';
  return said ? `an image${where}: ${quoted(said, PICTURE_DESCRIPTION_MAX)}${tail}` : `an image${where} (${file ?? 'no file'})${tail}`;
}
