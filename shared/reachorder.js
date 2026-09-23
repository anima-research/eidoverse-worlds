import { CONTACT_POINTS } from './contact.js';

// Which effector moves a named point downstream of its root joint?
export function contactEffector(point) {
  const bone = CONTACT_POINTS[point]?.bone ?? '';
  const side = bone.startsWith('left') ? 'left' : bone.startsWith('right') ? 'right' : null;
  if (!side) return null;
  if (/LowerArm|Hand|Thumb|Index|Middle|Ring|Little/.test(bone)) return side + 'Hand';
  if (/LowerLeg|Foot|Toes/.test(bone)) return side + 'Foot';
  return null;
}
export const reachKey = (who, limb) => JSON.stringify([who, limb]);

/** Producers precede consumers, independent of insertion order. Cycles and
 * their dependants stay blocked rather than borrowing arbitrary old poses. */
export function planReaches(entries) {
  const nodes = new Map(entries.map(e => [reachKey(e.owner, e.limb), e]));
  const remaining = new Map();
  for (const [key, e] of nodes) {
    const limb = e.target?.who && contactEffector(e.target.point);
    const dep = limb && reachKey(e.target.who, limb);
    remaining.set(key, new Set(dep && dep !== key && nodes.has(dep) ? [dep] : []));
  }
  const order = [];
  while (remaining.size) {
    const ready = [...remaining.keys()].filter(k => remaining.get(k).size === 0).sort();
    if (!ready.length) break;
    for (const key of ready) {
      order.push(nodes.get(key)); remaining.delete(key);
      for (const deps of remaining.values()) deps.delete(key);
    }
  }
  return { order, blocked: [...remaining.keys()].map(k => nodes.get(k)) };
}
