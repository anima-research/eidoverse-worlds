// credits — who made a thing what it is, as a view over the log (batch 2; R 10-07: "Credits come from History"). Never
// stored: no hand credits, no author field (L2). The editor's History tab shows it as filter modes (client/lib/
// historyrows.js historyView); this is the per-thing grouping it and an agent share.
//
//   creditsOf(entries, id, {nameOf}) → [{by, who, did: [{what, n, at}], first, last}], ordered by first contribution
//
// What counts: a STATE entry that touches the thing, caused by a building act (create, set, place, turn, delete, batch,
// undo, …; an imported act by its original verb). A refused act changes nothing and never reaches a state entry, so it
// can't count. Play isn't authorship: a `use` (opening a door 40 times), a grab, a throw, the sim's rests and the
// door's own corrections are left out. Moves by one person less than five minutes apart are one session ("moved it",
// not "moved it ×591": the Commons has people with hundreds of imported nudges).
import { opsOf } from './v4/fold.js';

export const SESSION_MS = 5 * 60 * 1000;
const BUILDING = new Set(['create', 'set', 'delete', 'place', 'turn', 'batch', 'undo', 'redo', 'publish', 'update', 'sculpt', 'spawn', 'comp', 'light', 'motion', 'remove', 'mount', 'move', 'scale', 'unmount', 'label', 'edit']);
const SYSTEM = new Set(['sim', 'door', 'world']);
/** The phrase for one change, from one table (the client and the door read the same words). */
export function phraseOf(op) {
  if (op.verb === 'create') return 'made it';
  if (op.verb === 'delete' && op.comp === undefined) return 'took it away';
  const c = String(op.comp ?? '');
  if (c === 'transform' || c === 'parent') return 'moved it';
  if (c === 'model') return 'gave it its shape';
  if (c === 'light') return 'lit it';
  if (c === 'picture') return 'hung its picture';
  if (c === 'sound') return 'gave it sound';
  if (c === 'text') return 'wrote on it';
  if (c === 'story') return 'told its story';
  if (c === 'label') return 'named it';
  if (c === 'motion' || c.startsWith('motion:') || c === 'look-at' || c.startsWith('look-at:')) return 'set it moving';
  if (c === 'reactions' || c === 'sockets' || c === 'grabbable') return 'made it usable';
  if (c.startsWith('script:')) return 'scripted it';
  if (c === 'lock') return 'locked it';
  return `changed its ${c}`;
}
const opsQuiet = (e) => { try { return opsOf(e); } catch { return []; } };

export function creditsOf(entries, id, { nameOf = (x) => x } = {}) {
  const bySeq = new Map(); for (const e of entries) if (e && typeof e === 'object' && Number.isInteger(e.seq)) bySeq.set(e.seq, e);
  const at = (i) => bySeq.get(i) ?? entries[i];
  // the acts that changed this thing: their state entries' ops on it
  const caused = new Map();
  for (const e of entries) { if (!e || e.kind !== 'state') continue;
    const ops = opsQuiet(e).filter((o) => o.id === id); if (!ops.length) continue;
    const k = e.cause; caused.set(k, [...(caused.get(k) ?? []), ...ops]); }
  const people = new Map(); let last = null;
  for (const e of entries) {
    if (!e || e.kind !== 'act') continue;
    const ops = caused.get(e.seq); if (!ops) continue;
    const verb = e.verb === 'legacy' ? e.body?.verb : e.verb;
    if (!BUILDING.has(verb)) continue;
    if (SYSTEM.has(e.actor)) continue;
    const by = e.actor, ts = e.ts ?? at(e.seq)?.ts ?? 0;
    const made = ops.some((o) => o.verb === 'create');
    const whats = made ? ['made it'] : [...new Set(ops.map(phraseOf))];
    let p = people.get(by); if (!p) { p = { by, who: nameOf(by), did: [], first: ts, last: ts }; people.set(by, p); }
    p.last = ts;
    for (const what of whats) {
      if (last && last.by === by && last.what === what && ts - last.at < SESSION_MS) { last.at = ts; continue; }
      const d = p.did.find((x) => x.what === what); if (d) { d.n++; d.at = ts; } else p.did.push({ what, n: 1, at: ts });
      last = { by, what, at: ts };
    }
  }
  return [...people.values()].sort((a, b) => a.first - b.first);
}
