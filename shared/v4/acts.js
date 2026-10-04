// shared/v4/acts.js — the v4 log read as ACTS: who asked for what, and what it changed (protocol v4, Phase 1).
//
// A row is one request and its results: the timeline record (what was asked, by whom, as sent), the state entry it
// caused (which components of which things changed), and — for physics — the launch it started and the rest that
// followed, however much later. This is the reading a person verifying an agent's work needs: not the raw log, not
// a diff dump, but "kit · place lamp-1 → lamp-1: transform, parent".
//
// Pure: no I/O. The server shadow builds rows from its translation; the editor's History panel and the agent text
// tier render the same rows.

/** Which components of which things a state entry changed. */
export function touchedBy(entry) {
  const out = new Map();
  const add = (id, what) => { if (typeof id !== 'string') return; if (!out.has(id)) out.set(id, new Set()); out.get(id).add(what); };
  const walk = (verb, a = {}) => {
    if (verb === 'batch') { for (const o of a.ops ?? []) walk(o.verb, o.args); return; }
    if (verb === 'create') add(a.id, '+created');
    else if (verb === 'delete') add(a.id, a.component ? `-${a.component}` : '-deleted');
    else if (verb === 'set') add(a.id, a.component);
  };
  walk(entry.verb, entry.args);
  return [...out].map(([id, s]) => ({ id, changed: [...s] }));
}

/** v4 entries (in seq order) → act rows, oldest first. Rests attach to the act whose launch caused them. */
export function actsOf(v4entries) {
  const rows = [], bySeq = new Map(), launchRow = new Map();
  for (const e of v4entries) {
    if (e.kind === 'timeline') {
      const row = { seq: e.from ?? e.seq, at: e.seq, ts: e.ts, actor: e.actor,
        verb: e.verb === 'legacy' ? e.args?.verb : e.verb, args: e.verb === 'legacy' ? e.args?.args : e.args,
        changed: [], launches: [], rests: [] };
      rows.push(row); bySeq.set(e.seq, row);
    } else if (e.kind === 'sim' && e.verb === 'launch') {
      const row = bySeq.get(e.cause); if (row) { row.launches.push({ id: e.args?.id, at: e.seq }); launchRow.set(e.seq, row); }
    } else if (e.kind === 'state') {
      if (e.args?.sim?.rest) {
        const row = launchRow.get(e.cause);
        const r = { id: e.args.sim.id, pos: e.args.sim.at, at: e.seq, ts: e.ts, ...(e.args.sim.lost ? { lost: true } : {}) };
        if (row) row.rests.push(r); else rows.push({ seq: null, at: e.seq, ts: e.ts, actor: 'sim', verb: 'rest', args: {}, changed: touchedBy(e), launches: [], rests: [r] });
      } else { const row = bySeq.get(e.cause); if (row) row.changed.push(...touchedBy(e)); }
    }
  }
  return rows;
}

const SHOW = { say: true };
/** One line for a row — the text tier, and the panel's label. */
export function lineOf(row) {
  const who = row.actor ?? '?';
  if (row.verb === 'say' && SHOW.say) return `${who} said “${String(row.args?.text ?? '').slice(0, 80)}”`;
  const target = row.args?.id ? ` ${row.args.id}` : '';
  const ch = row.changed.length
    ? ' → ' + row.changed.slice(0, 4).map((c) => `${c.id}: ${c.changed.join(', ')}`).join('; ') + (row.changed.length > 4 ? ` (+${row.changed.length - 4} more)` : '')
    : (row.launches.length ? '' : ' (changed nothing)');
  const fl = row.launches.length ? ` → threw ${row.launches.map((l) => l.id).join(', ')}` : '';
  const rs = row.rests.length ? `; came to rest: ${row.rests.map((r) => `${r.id} at [${r.pos.map((n) => Math.round(n * 100) / 100).join(', ')}]${r.lost ? ' (lost)' : ''}`).join('; ')}` : '';
  return `${who} · ${row.verb}${target}${ch}${fl}${rs}`;
}
