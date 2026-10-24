// plainwords — the authority's refusals and warnings as a PERSON reads them (ship list 10-07): what they tried and why, with
// things named by their labels (or what they are), never hex ids or tool syntax. shared/protocol/refusal.js does the wording;
// this file knows the world: which words are things here, and what people call them. Agents keep refusalText.
import { bagOf, entities } from './world.js';
import { state } from './state.js';
import { plainRefusal, warningText } from '../../shared/protocol/refusal.js';
import { modelWord } from '../../shared/eido.js';
import { resolveThing, handleOf } from '../../shared/thingref.js';

const stem = (lib) => modelWord(lib).replace(/[_-]+/g, ' ').replace(/\s+\d+$/, '').trim();
/** How a person knows thing `id`: “its label”, else "the <model>", else "that thing"; null when `id` isn't a thing here. */
export function nameOf(id) {
  const rec = state.st?.entities?.[id];
  const c = bagOf(id);
  if (!rec && !entities.has(id) && !c) return null;
  const L = c?.label ?? rec?.label;
  if (typeof L === 'string' && L.trim()) return `“${L.trim().slice(0, 40)}”`;
  const lib = rec?.model;
  return lib ? `the ${stem(lib)}` : 'that thing';
}
/** A thing in a person's sentence: what nameOf calls it, else its id (never an opaque id where a name exists; R 10-17). */
export const called = (id) => nameOf(id) ?? String(id);
/** What a person can TYPE to name a thing in a chat command: its label when that names it alone, else its short handle. */
export function typeable(id) {
  const all = [...entities.keys()].map((k) => ({ id: k, label: bagOf(k)?.label }));
  const l = bagOf(id)?.label; if (typeof l === 'string' && l.trim() && !/\s/.test(l.trim()) && resolveThing(l, all).id === id) return l.trim();
  return handleOf(id, entities.keys());
}
/** A door refusal for a person. */
export const plain = (what, r) => plainRefusal(what, r, nameOf);
/** A door warning ({id, kind, …}) for a person. */
export const warnPlain = (w) => warningText(w, nameOf);
