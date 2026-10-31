// drafts — the component ladder's first two rungs as the editor sees them (docs/COMPONENT-LADDER.md; R 10-12 10:09).
//
// A DRAFT is a namespaced component (`hesperus/material`) the authority stores but doesn't read: it is only as real as
// the readers that choose to read it. A reader registers the draft it reads here, and Add Component and the Inspector
// consult the registry: a draft is offered only where this client can do something with it (under a "drafts" heading,
// an amber chip, "unproven"). On a server, or a client without the reader, the registry is empty and the draft is never
// offered — the hollow grey dot on a card is for a component nothing here reads.
//
// TRUSTED HERE is a fact about the WORLD, written by its owner: `@world.trusted-components = {components: [names]}` (a registered
// world component, owner-gated like the rest of @world). A trusted draft sits in the main list with a blue chip and no
// hint. Trust is not engine understanding: the authority still doesn't read it, and it still can't feed a rule.

import { isComponent } from './protocol/fold.js';
import { isNamespaced, registered } from './protocol/componentspec.js';

const READ = new Map();
/** A reader says what it reads: `name` is the draft's base name (no key); `applies(ent)` says where it is offered. */
export function registerDraft(name, { title = name, summary = '', category = 'Look', blank = {}, applies = () => true } = {}) {
  READ.set(name, { name, title, summary, category, blank, applies });
}
export const readsDraft = (name) => READ.has(name);
export const draftsRead = () => [...READ.values()];

export const TRUSTED = 'trusted-components';
/** Its spelling before 10-17 (R: the bare word read as trusted PEOPLE). The maintenance command renames a stored one
 *  (shaperepair.js, rename-components); a world it hasn't run on reads the same. */
export const OLD_TRUSTED = 'trusted';
export const TRUSTED_MAX = 64;
export const UNPROVEN_HINT = "unproven: this client reads it; the engine doesn't";
/** The names a world trusts, from its @world components bag; a malformed value reads as none. */
export function trustedOf(worldC) {
  const v = (worldC?.[TRUSTED] ?? worldC?.[OLD_TRUSTED])?.components;
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}
export const isTrusted = (name, trusted) => Array.isArray(trusted) && trusted.includes(name);
/** Why a `trusted-components` value would be refused, or null: {components: [≤ 64 distinct namespaced draft names]}; a bare or
 *  registered name has no business there (it is official, or it is nothing). The authority and the inspector ask this. */
export function trustRefusal(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'trusted-components is {components: [<namespaced draft names>]}';
  const extra = Object.keys(v).filter((k) => k !== 'components');
  if (extra.length) return `trusted-components: unknown key '${extra[0]}' (it is {components: [...]})`;
  const list = v.components;
  if (!Array.isArray(list)) return 'trusted-components.components is a list of component names';
  if (list.length > TRUSTED_MAX) return `trusted-components.components holds at most ${TRUSTED_MAX} names (got ${list.length})`;
  for (const x of list) {
    if (typeof x !== 'string' || !isComponent(x) || x.includes(':')) return `trusted-components.components: ${JSON.stringify(x)} isn't a component name (a base name, no key)`;
    if (!isNamespaced(x)) return `trusted-components.components: '${x}' is a bare name; only a namespaced draft (<handle>/<name>) is trusted — a bare name is the engine's or nothing`;
    if (registered(x)) return `trusted-components.components: '${x}' is already official (${registered(x)}); trust is for drafts`;
  }
  if (new Set(list).size !== list.length) return 'trusted-components.components lists a name twice';
  return null;
}
/** The list with `name` toggled: added when absent, removed when present. */
export const toggleTrusted = (trusted, name) => (isTrusted(name, trusted) ? trusted.filter((x) => x !== name) : [...(trusted ?? []), name]);
