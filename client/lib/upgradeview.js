// client/lib/upgradeview.js — the splash of a world saved in an older format: the server's words, the doc, and (an operator or its owner)
// Upgrade world… → the dry-run report → Back up and upgrade → where the backup is. The server runs the CLI (server/upgrade.ts).
import { OLD_FORMAT_DOC, IF_YOU_RUN_IT } from '../../shared/oldformat.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };

/** One request on its own socket (the refused one is closed): resolves with the reply, or a refusal of our own. */
function ask(type, body, ms = 10 * 60_000) {
  return new Promise((resolve) => {
    let ws; try { ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`); } catch (e) { resolve({ ok: false, refused: { code: 'offline', reason: String(e?.message ?? e) } }); return; }
    const id = Math.floor(Math.random() * 1e9), done = (r) => { clearTimeout(t); try { ws.close(); } catch { /* gone */ } resolve(r); };
    const t = setTimeout(() => done({ ok: false, refused: { code: 'timeout', reason: 'the server gave no answer' } }), ms);
    ws.onopen = () => ws.send(JSON.stringify({ type, id, ...body }));
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (m?.type === type && m.id === id) done(m); };
    ws.onclose = () => done({ ok: false, refused: { code: 'offline', reason: 'the connection closed before an answer came' } });
  });
}
const refusedWords = (r) => `${r?.refused?.reason ?? 'refused'}${r?.refused?.fix ? ` — ${r.refused.fix}` : ''}`;

/** A section of the report: a title with its count, and one line per item ("nothing" when empty). */
function section(title, items) {
  const s = el('div', 'sp-up-sec'); s.append(el('div', 'sp-up-h', `${title} (${items.length})`));
  if (!items.length) s.append(el('div', 'sp-up-none', 'nothing'));
  else { const ul = el('ul'); for (const t of items) ul.append(el('li', null, t)); s.append(ul); }
  return s;
}
/** The report's claim in words: a string (world.ts CLAIM) is an ownerless world's, {by, how} an owner recognised as the upgrader. */
export function claimWords(claim) {
  if (typeof claim === 'string') return 'This world has no owner: you will become its owner when you upgrade it.';
  if (!claim || typeof claim !== 'object') return null;
  return `You're its owner ${claim.by}${claim.how === 'name' ? ', recognised by your name (provisional, until durable accounts)' : ', by the account main recorded'}: the upgrade keeps ${claim.by}'s role on your account.`;
}
/** The dry-run report as a person reads it: what carries, what is mapped, what has no home, what is refused. */
export function reportView(report, hash) {
  const R = report ?? {}, box = el('div', 'sp-up-report');
  const e = R.entries ?? {}, carried = [`${e.old ?? 0} old entries become ${e.new ?? 0} (${e.change ?? 0} changes)`];
  if (R.actorsRenamed) carried.push(`${R.actorsRenamed} name(s) escaped`);
  if (R.guards?.becameLocks) carried.push(`${R.guards.becameLocks} guarded thing(s) become locked`);
  if (R.models) carried.push(`${R.models.hashed ?? 0} model(s) addressed by their bytes${R.models.unhashed?.length ? `, ${R.models.unhashed.length} without bytes here` : ''}`);
  if (R.physics) carried.push(`${R.physics.launches} launch(es), ${R.physics.rests} rest(s) of the old physics`);
  if (R.source?.unparsedLines) carried.push(`${R.source.unparsedLines} line(s) of the old log don't parse and are dropped`);
  box.append(section('Carried', carried));
  box.append(section('Mapped', (R.mapped ?? []).map((m) => `${m.feature} on ${m.id} → ${(m.into ?? []).join(', ') || '(nothing new)'}`)));
  box.append(section('Unmapped, kept as imported', (R.unmapped ?? []).map((u) => `${u.component} on ${u.id}: ${(u.fields ?? []).join(', ')} (${u.as})`)));
  box.append(section('Dropped by design', Object.entries(R.dropped ?? {}).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)));
  box.append(section('People with a role', (R.people ?? []).map((p) => p.account ? `${p.role} ${p.name}: bound to their account (${p.account}, from ${p.from})` : `${p.role} ${p.name}: no account yet (${p.why}); bind with ${p.bind}`)));
  box.append(section('Banned', (R.bans ?? []).map((b) => b.account ? `${b.name}: holds against their account (${b.account}, from ${b.from})${b.check ? `; check it: ${b.check}` : ''}` : `${b.name}: no account yet (${b.why}), so it holds against no one who signs in; bind with ${b.bind}`)));
  const cw = claimWords(R.claim); if (cw) box.append(el('p', 'sp-up-claim', cw));
  if (R.ownerWarning) box.append(el('p', 'sp-up-err sp-up-owners', `Warning: ${R.ownerWarning}`));
  box.append(section('Refused', R.refused ? [R.refused] : []));
  if (R.trial) box.append(el('div', 'sp-up-note', R.trial));
  box.append(el('div', 'sp-up-hash', `report ${hash}`));
  return box;
}

/** Fill the refused splash for an old-format world. `refused`: the join's structured reason; `words`: the server's sentence. */
export function showOldFormat(root, refused, world) {
  if (!root) return;
  root.querySelector('.sp-upgrade')?.remove();
  const box = el('div', 'sp-upgrade');
  const doc = el('a', 'sp-up-doc', 'How upgrading works'); doc.href = `/${refused?.doc ?? OLD_FORMAT_DOC}`; doc.target = '_blank'; doc.rel = 'noopener';
  const area = el('div', 'sp-up-area'); box.append(area, doc);   // the action first; "how" is for when it's unclear (R 10-28)
  if (!refused?.may && !refused?.operator) area.append(el('p', 'sp-up-who', IF_YOU_RUN_IT));   // who can't upgrade it: the runner's way in, else ask (R 10-28)
  if (refused?.may) {   // an operator, or its owner (refused.owner: 'bound' by main's records, 'name' provisionally)
    const review = el('button', 'sp-up-btn sp-up-review', 'Upgrade world…'); area.append(review);
    review.onclick = async () => {
      review.disabled = true; review.textContent = 'reading the old world…';
      const r = await ask('world-upgrade-review', { world });
      area.textContent = '';
      if (!r.ok) { area.append(el('p', 'sp-up-err', `Couldn't review the upgrade: ${refusedWords(r)}`)); return; }
      area.append(reportView(r.report, r.hash));
      if (r.report?.refused) { area.append(el('p', 'sp-up-err', 'This world can\'t be upgraded yet (see Refused).')); return; }
      const go = el('button', 'sp-up-btn sp-up-go', 'Back up and upgrade'); area.append(go);
      go.onclick = async () => {
        go.disabled = true; go.textContent = 'backing up and upgrading…';
        const u = await ask('world-upgrade', { world, approved: r.hash });
        area.textContent = '';
        if (!u.ok) { area.append(el('p', 'sp-up-err', `The upgrade was refused, and nothing was changed: ${refusedWords(u)}`)); return; }
        // success replaces the problem: the headline, the doc link and the report go; Enter first; the backup and the undo fold away
        const phase = root.querySelector('.sp-phase'); if (phase) { phase.textContent = 'Upgraded. The world is ready.'; phase.removeAttribute('role'); }
        const sub = root.querySelector('.sp-sub'); if (sub) sub.textContent = 'upgrade complete';
        doc.remove();
        const done = el('div', 'sp-up-done');
        const enter = el('button', 'sp-up-btn sp-up-enter', 'Enter the world'); enter.onclick = () => location.reload();
        const more = el('details', 'sp-up-more'); more.append(el('summary', null, 'Backup and undo'),
          el('p', null, 'A verified copy of the old world was saved on the server, at:'), el('pre', 'sp-up-backup', u.backup),
          el('p', null, 'To undo: stop the server, then run this in a terminal on the server machine, from the folder the server runs in:'), el('pre', 'sp-up-rollback', u.rollback));
        done.append(enter, ...(u.claimed ? [el('p', 'sp-up-owned', u.owned ?? "You're now this world's owner.")] : []), ...(u.warning ? [el('p', 'sp-up-err sp-up-owners', `Warning: ${u.warning}`)] : []), more);
        area.append(done);
      };
    };
  }
  root.append(box);
}
