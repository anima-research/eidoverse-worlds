// accesspanel.js — World Settings › Who may come in › Listed here: everyone this world lists (@world roles:*), who is here
// unlisted, and adding someone (R 10-27; docs/DESIGN-world-access.md § UX).
// Facts come from the page's own fold; edits are ordinary set/delete requests on @world, and the authority judges every one
// (its refusal is shown here in its words). Controls follow your rights as roles.js reads them, never wider.
// Adding someone: a name is looked up only among the people this world has seen (whois); anyone else is added by their exact
// identity (u-…, shown to each person on this panel). There is no search of everyone on the server.
import { bus } from './base.js';
import { net, sendRequest, replica, identities } from './net.js';
import { toast } from './ui.js';
import * as R from '../../shared/protocol/roles.js';
import { listedIn, leftWords } from '../../shared/protocol/access.js';
import { serverNow, serverUntil } from './serverclock.js';

const ID = /^u-[a-z2-7]{20}$/;
const SPANS = [['', 'no end'], ['3600000', '1 hour'], ['86400000', '1 day'], ['604800000', '1 week']];
const wc = () => replica.st?.entities?.['@world']?.c ?? {};
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const me = () => { const r = net.myRights ?? {}; return { id: net.you, role: r.role ?? 'member', rank: r.rank ?? 0, permissions: r.permissions ?? [] }; };
const isOwner = () => R.isOwner(me());
const mayGrant = () => isOwner() || me().permissions.includes('grantRoles');
const rankOfId = (id) => R.effectiveOf(wc(), id).rank;
// names of people not here, learned from the world's own lookup (whois answers by id for anyone the world knows)
const named = new Map(), asked = new Set();
const presentName = (id) => { for (const [n, v] of identities) if (v === id) return n; return null; };
const nameOf = (id) => presentName(id) ?? named.get(id) ?? net.names?.[id] ?? replica.nameOf?.(id) ?? id;
function learnName(id) {
  if (asked.has(id) || presentName(id) || named.has(id)) return; asked.add(id);
  sendRequest('whois', { id }).then((r) => { const p = r?.people?.find((x) => x.id === id); if (p?.name && p.name !== id) { named.set(id, p.name); repaint(); } });
}
/** May I change this person's grant (the authority's grant rule, mirrored to draw the controls; the authority decides)? */
const mayChange = (id, roleId) => roleId !== 'owner' && (isOwner() || (mayGrant() && rankOfId(id) < me().rank && R.rankOfRole(wc(), roleId) < me().rank));
const roleOptions = () => R.grantableRoles(wc(), me()).filter((r) => isOwner() || r.id !== 'owner');

const ui = { q: '', hits: null, note: '', refused: '', role: null, span: '' };
let box = null;
const repaint = () => { if (box?.isConnected && !box.contains(document.activeElement)) paintListed(box); };
bus.on('log-applied', repaint);
bus.on('roster', repaint);

async function send(verb, args, what) {
  const r = await sendRequest(verb, args);
  if (r?.ok) { ui.refused = ''; toast(`${what}: done`, 'info'); }
  else { ui.refused = `${what}: ${r?.refused?.reason ?? 'refused'}`; toast(ui.refused, 'warn', 8000); }
  if (box?.isConnected) paintListed(box);
  return r;
}
function add(id) {
  const role = ui.role, span = Number(ui.span), merge = !!wc()[`roles:${id}`];
  const value = { role, ...(span > 0 ? { until: serverUntil(span) } : merge ? { until: null } : {}) };
  return send('set', { id: '@world', component: `roles:${id}`, value, ...(merge ? { merge: true } : {}) }, `add ${nameOf(id)} as ${role}`);
}
async function find() {
  const q = ui.q.trim(); ui.hits = null; ui.note = '';
  if (!q) return paintListed(box);
  if (ID.test(q)) { ui.hits = [{ id: q, name: nameOf(q), by: 'by identity' }]; return paintListed(box); }
  const r = await sendRequest('whois', { name: q });
  if (!r?.ok) ui.note = r?.refused?.reason ?? "couldn't look that up just now";
  else {
    for (const p of r.people ?? []) if (p.name) named.set(p.id, p.name);
    ui.hits = (r.people ?? []).map((p) => ({ id: p.id, name: p.name, by: [p.role, p.here ? 'here now' : 'not here now', p.guest ? 'a guest' : null].filter(Boolean).join(' · ') }));
    if (!ui.hits.length) ui.note = `nobody called "${q}" has been in this world; to add someone who hasn't, paste their identity (u-…: each person sees theirs on this panel)`;
  }
  if (box?.isConnected) paintListed(box);
}

/** Paint the Listed-here part into `b` (World Settings › Who may come in calls it). */
export function paintListed(b) {
  box = b;
  const c = wc(), now = serverNow(), grant = mayGrant();
  const rows = Object.entries(c).filter(([k, v]) => k.startsWith('roles:') && v && typeof v === 'object' && listedIn(c, k.slice(6), now)).map(([k, v]) => ({ id: k.slice(6), ...v }));
  const here = new Set(identities.values());
  for (const r of rows) if (!here.has(r.id)) learnName(r.id);
  const opts = roleOptions();
  if (!opts.some((r) => r.id === ui.role)) ui.role = (opts.find((r) => r.id === 'member') ?? opts[0])?.id ?? null;
  const sel = (cls, options, v) => `<select class="${cls}">${options.map(([x, l]) => `<option value="${esc(x)}" ${x === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const row = (r) => {
    const bits = [r.role, here.has(r.id) ? 'here now' : null, Number.isSafeInteger(r.until) ? leftWords(r.until, now) : null, r.id === net.you ? 'you' : null].filter(Boolean);
    const ctl = grant && mayChange(r.id, r.role)
      ? sel('ap-role', opts.map((x) => [x.id, x.name]), r.role)
        + sel('ap-until', [['', 'ends ▸'], ...SPANS.map(([v, l]) => [v || 'never', l])], '')
        + `<button type="button" class="rp-btn ap-rm" title="take ${esc(nameOf(r.id))} off the list">✕</button>` : '';
    return `<div class="rp-row ap-row" data-who="${esc(r.id)}"><div class="rp-main"><b>${esc(nameOf(r.id))}</b> <span class="rp-dim">${esc(bits.join(' · '))}</span></div>${ctl}</div>`;
  };
  const unlisted = [...new Set(identities.values())].filter((id) => id !== net.you && !listedIn(c, id, now));
  let html = `<p class="rp-dim ap-you">your identity here: <code>${esc(net.you ?? '…')}</code> (an owner can add you by it)</p>`
    + `<h4 class="rp-h">Listed here (${rows.length})</h4>${rows.map(row).join('') || '<p class="rp-note">nobody is listed by name</p>'}`;
  if (grant && ui.role) {
    html += `<h4 class="rp-h">Add someone</h4><div class="ap-add"><input type="search" class="pm-text ap-q" placeholder="a name seen here, or an identity (u-…)" value="${esc(ui.q)}"> <button type="button" class="rp-btn ap-find">find</button></div>`
      + `<label class="rp-field">as ${sel('ap-add-role', opts.map((r) => [r.id, r.name]), ui.role)}</label><label class="rp-field">for ${sel('ap-add-span', SPANS, ui.span)}</label>`
      + (ui.hits ?? []).map((h) => `<div class="rp-row ap-hit" data-who="${esc(h.id)}"><div class="rp-main"><b>${esc(h.name)}</b> <span class="rp-dim">${esc(h.by)}</span></div><button type="button" class="rp-btn">add</button></div>`).join('')
      + (ui.note ? `<p class="rp-note ap-note">${esc(ui.note)}</p>` : '')
      + (unlisted.length ? `<h4 class="rp-h">Here now, not listed (${unlisted.length})</h4><div class="rp-actions ap-here">${unlisted.map((id) => `<button type="button" class="rp-btn" data-who="${esc(id)}">+ ${esc(nameOf(id))}</button>`).join('')}</div>` : '');
  }
  if (ui.refused) html += `<p class="rp-warn ap-refused">${esc(ui.refused)}</p>`;
  b.innerHTML = html;
  if (!grant) return;
  const q = b.querySelector('.ap-q');
  q?.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { ui.q = q.value; find(); } });
  b.querySelector('.ap-find')?.addEventListener('click', () => { ui.q = q.value; find(); });
  b.querySelector('.ap-add-role')?.addEventListener('change', (e) => { ui.role = e.target.value; });
  b.querySelector('.ap-add-span')?.addEventListener('change', (e) => { ui.span = e.target.value; });
  b.querySelectorAll('.ap-hit button').forEach((x) => { x.onclick = () => { const id = x.closest('.ap-hit').dataset.who; ui.q = ''; ui.hits = null; ui.note = ''; add(id); }; });
  b.querySelectorAll('.ap-here button[data-who]').forEach((x) => { x.onclick = () => add(x.dataset.who); });
  b.querySelectorAll('.ap-row').forEach((r) => { const id = r.dataset.who;
    r.querySelector('.ap-role')?.addEventListener('change', (e) => send('set', { id: '@world', component: `roles:${id}`, value: { role: e.target.value }, merge: true }, `make ${nameOf(id)} ${e.target.value}`));
    r.querySelector('.ap-until')?.addEventListener('change', (e) => { const v = e.target.value; if (!v) return;   // only the end (merge; null removes it): never a role painted before someone changed it
      send('set', { id: '@world', component: `roles:${id}`, value: { until: v === 'never' ? null : serverUntil(Number(v)) }, merge: true }, `${nameOf(id)}: ${v === 'never' ? 'no end' : SPANS.find(([s]) => s === v)?.[1]}`); });
    r.querySelector('.ap-rm')?.addEventListener('click', () => send('delete', { id: '@world', component: `roles:${id}` }, `take ${nameOf(id)} off the list`)); });
}
export const _test = { paintListed, ui };
