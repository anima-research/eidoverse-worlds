// Rows for the editor's History: pure, testable without a browser. A refused write is logged as an act whose body
// carries refused {code} (shared/protocol/authority.js logRefusal): shown as an attempt, never counted as a deed.
// Not every refusal has a row: logRefusal only counts a rate refusal or a contact punt, and drops presence verbs.
import { phraseOf } from '../../../shared/credits.js';
export function worldHistoryRows(entries, nameOf) {
  return entries.filter((e) => e.kind === 'request').reverse().map((e) => {
    const refused = e.body?.refused?.code ?? null, who = nameOf(e.actor);
    const verb = e.verb === 'imported' && typeof e.body?.verb === 'string' ? e.body.verb : e.verb;   // an imported act, as what it was
    const changed = [e.body?.args?.component].filter(Boolean), target = e.body?.args?.id ?? null;
    const what = `${verb}${target ? ` ${target}` : ''}${changed.length ? ` · ${changed.join(', ')}` : ''}`;
    return { seq: e.seq, by: e.actor, who, verb, changed, target, ts: e.ts ?? null, refused,
      text: refused ? `${who} tried ${what} — refused (${refused}); nothing changed` : `${who} · ${what}` };
  });
}

// Credits are History view modes. The same rows, seen four ways:
//   time    every row, newest first (the default)
//   person  one person's rows (opts.who: their identity)
//   top     the biggest contributors: people ranked by deeds (acts that changed something), with their rows
//   kind    rows grouped by what was changed (a component, or the verb when it names none)
export const HISTORY_MODES = [['time', 'by time'], ['person', 'by person'], ['top', 'biggest contributors'], ['kind', 'by what changed']];
const asRows = (list, nameOf) => (list.length && list[0]?.kind !== undefined ? worldHistoryRows(list, nameOf) : list);
export function historyView(list, nameOf, { mode = 'time', who = null } = {}) {
  const rows = asRows(list ?? [], nameOf);
  if (mode === 'person') return { mode, rows: rows.filter((r) => r.by === who) };
  if (mode === 'top' || mode === 'person-list') {
    const people = new Map();
    for (const r of rows) { const p = people.get(r.by) ?? { by: r.by, who: r.who ?? nameOf(r.by), deeds: 0, tried: 0, last: r.ts ?? null, did: [] };
      if (r.refused) p.tried++; else { p.deeds++;   // what they did, in the Credits words (shared/credits.js)
        for (const c of r.changed?.length ? r.changed : [null]) { const what = c === '(created)' ? 'made it' : c === '(deleted)' ? 'took it away' : c ? phraseOf({ op: 'set', comp: c }) : r.verb;
          if (!p.did.includes(what)) p.did.push(what); } }
      people.set(r.by, p); }
    return { mode, rows, people: [...people.values()].sort((a, b) => b.deeds - a.deeds || String(a.who).localeCompare(String(b.who))) };
  }
  if (mode === 'kind') {
    const groups = new Map();
    for (const r of rows) { const k = r.changed?.length ? r.changed.join(', ') : r.verb; const g = groups.get(k) ?? { kind: k, rows: [] }; g.rows.push(r); groups.set(k, g); }
    return { mode, rows, groups: [...groups.values()].sort((a, b) => b.rows.length - a.rows.length) };
  }
  return { mode: 'time', rows };
}

/** Merge a `history {id, limit, before?}` reply ({entries: [{seq, diff, …}], next: the last seq or null}) into the
 *  panel's state {entries, next, paged} (panels.js History):
 *  - an Older… read (`more`) appends and takes the reply's cursor, marking the panel `paged`;
 *  - a refresh shows the newest page — unless the person has paged and the new page meets what they read: then the
 *    deeper pages stay, with the deeper cursor. A page that doesn't meet starts over. */
export function mergeHistory({ entries, next, paged = false }, rows, rNext, more) {
  const sorted = (xs) => { const m = new Map(); for (const e of xs) m.set(e.seq, e); return [...m.values()].sort((a, b) => b.seq - a.seq); };
  if (more) return { entries: sorted([...entries, ...rows]), next: rNext, paged: true };
  if (!paged) return { entries: sorted(rows), next: rNext, paged: false };
  const oldestNew = rows.length ? Math.min(...rows.map((e) => e.seq)) : Infinity;
  const meets = rNext == null || entries.some((e) => e.seq >= oldestNew);
  if (!meets) return { entries: sorted(rows), next: rNext, paged: false };
  const deeper = entries.some((e) => e.seq < oldestNew);
  return { entries: sorted([...entries, ...rows]), next: deeper ? next : rNext, paged: true };
}
