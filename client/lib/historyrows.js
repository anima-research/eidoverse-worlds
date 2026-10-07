// Rows for the editor's History (and, later, its Credits facet): pure, so they can be tested without a browser.
// A refused write is on the record as an act whose body carries refused {code} (door.js logRefusal, R7): it reads as
// an attempt, never as a deed (Commons parity audit, 10-06: "refused acts print as done").
export function worldHistoryRows(entries, nameOf) {
  return entries.filter((e) => e.kind === 'act').reverse().map((e) => {
    const refused = e.body?.refused?.code ?? null, who = nameOf(e.actor);
    const changed = [e.body?.request?.component].filter(Boolean), target = e.body?.request?.id ?? null;
    const what = `${e.verb}${target ? ` ${target}` : ''}${changed.length ? ` · ${changed.join(', ')}` : ''}`;
    return { seq: e.seq, by: e.actor, who, verb: e.verb, changed, target, ts: e.ts ?? null, refused,
      text: refused ? `${who} tried ${what} — refused (${refused}); nothing changed` : `${who} · ${what}` };
  });
}
