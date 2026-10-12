// plainwords — the authority's refusals and warnings as a PERSON reads them (ship list 10-07): what they tried and why, with
// things named by their labels (or what they are), never hex ids or tool syntax. shared/protocol/refusal.js does the wording;
// this file knows the world: which words are things here, and what people call them. Agents keep refusalText.
import { bagOf, entities } from './world.js';
import { state } from './state.js';
import { plainRefusal, warningText } from '../../shared/protocol/refusal.js';

const stem = (lib) => String(lib).split('/').pop().replace(/\.glb$/i, '').replace(/[_-]+/g, ' ').replace(/\s+\d+$/, '').trim();
/** How a person knows thing `id`: “its label”, else "the <model>", else "that thing"; null when `id` isn't a thing here. */
export function nameOf(id) {
  const rec = state.st?.entities?.[id];
  const c = bagOf(id);
  if (!rec && !entities.has(id) && !c) return null;
  const L = c?.label ?? rec?.comp?.label;
  if (typeof L === 'string' && L.trim()) return `“${L.trim().slice(0, 40)}”`;
  const lib = rec?.lib;
  return lib ? `the ${stem(lib)}` : 'that thing';
}
/** A door refusal for a person. */
export const plain = (what, r) => plainRefusal(what, r, nameOf);
/** A door warning ({id, kind, …}) for a person. */
export const warnPlain = (w) => warningText(w, nameOf);
