// rolespanels.js — the two dock panels of roles and moderation (research roles 10-06, S7 and S8; PLAN decisions 10-06).
// Each thing lives in exactly one place (research §7):
//   MODERATION (dock: a shield; shown only while you hold mute, kick, ban or pauseScripts — it follows your-rights)
//     Bans     bans in force, then mutes, kicks cooling down and ghosts, each with its lift where you may; ended bans
//              collapsed. Lifting follows the authority's rule (an owner, the author, or someone who outranks the author).
//     Log      the moderator log, newest first, with role changes merged in; a person filter and verb chips; older.
//     Scripts  every script here: thing, name, sponsor, status, who paused it, Pause / Resume where you may.
//   WORLD SETTINGS (dock: a flag; everyone reads, owners edit; editWorld holders edit Card and Places)
//     Roles    the grid: permissions down, roles across (owner first, locked); dependencies grey a cell with the reason;
//              place a role above another; holders under it; + Role; delete a held role by moving its people (one batch).
//              Narrow (a phone, or the panel squeezed): one role at a time.
//     Access   who can come in, what arrivals and guests are, how many at once; a warning when the default role holds
//              moderation powers or generate.
//     Card     the world's name and blurb (@world.about).   Places  spawn and bounds.   Old world  what translation carried.
// Rows here are DOM like every panel; in a headset they are the same frame as a quad (domquad.js XR_FRAMES), rows stay
// rows, and every control is a button or a select (no hover, no long-press).
import { bus, report } from './base.js';
import { net, sendRequest, replica, identities } from './net.js';
import { makeSection, moderationFrame, worldSettingsFrame, setDockEntry, toast } from './ui.js';
import * as R from '../../shared/protocol/roles.js';

const wc = () => replica.st?.entities?.['@world']?.c ?? {};
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const me = () => { const r = net.myRights ?? {}; return { id: net.you, role: r.role ?? 'visitor', rank: r.rank ?? 0, permissions: r.permissions ?? [] }; };
const has = (k) => me().role === 'owner' || me().permissions.includes(k);
const isOwner = () => me().role === 'owner';
const nameOf = (id) => { for (const [n, v] of identities) if (v === id) return n; return net.names?.[id] ?? replica.nameOf?.(id) ?? id; };
const rankOfId = (id) => R.effectiveOf(wc(), id).rank;
const ago = (ts) => { const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
const ends = (until) => { if (until == null) return 'never'; const s = Math.round((until - Date.now()) / 1000); return s <= 0 ? 'ended' : s < 3600 ? `in ${Math.ceil(s / 60)} min` : s < 86400 ? `in ${Math.round(s / 3600)} h` : `in ${Math.round(s / 86400)} d`; };
const badge = (id) => { const e = R.effectiveOf(wc(), id); const b = R.badgeOf(e); return b ? ` <span class="who-badge" data-tone="${b.tone}">${esc(b.text)}</span>` : ''; };
async function act(verb, args, what, refresh) {
  const r = await sendRequest(verb, args);
  if (r?.ok) toast(`${what}: done`, 'info'); else toast(`${what}: ${r?.refused?.reason ?? 'refused'}`, 'warn', 8000);
  await refresh?.(); return r;
}
/** May I lift this record? (the authority's rule, mirrored for drawing the button; the authority decides) */
const mayLift = (rec, power, strict = true) => { if (!has(power)) return false; if (isOwner() || rec.actor === me().id) return true; const a = rankOfId(rec.actor); return strict ? me().rank > a : me().rank >= a; };

// ---------------------------------------------------------------- Moderation
const sections = {};
let modWho = null, modVerbs = new Set(), modBefore = null;
export function openModeration({ tab = 'log', who = null } = {}) { modWho = who; const s = sections[tab]; if (s) s.toggle(true).catch((e) => report('moderation', e)); }

async function paintBans(body) {
  const r = await sendRequest('bans', {});
  if (!r?.ok) { body.innerHTML = `<p class="rp-note">${esc(r?.refused?.reason ?? "couldn't read the ban list")}</p>`; return; }
  const now = r.now ?? [];
  // names from the authority's reply (its directory knows absent people; this page knows only who is here)
  const named = new Map([...now.map((x) => [x.who, x.name]), ...(r.ended ?? []).map((m) => [m.who, m.name])]);
  const nm = (id) => named.get(id) ?? nameOf(id);
  const row = (who, rec, kind, lift) => `<div class="rp-row" data-who="${esc(who)}"><div class="rp-main"><b>${esc(nm(who))}</b>${badge(who)} <span class="rp-dim">${esc(kind)}</span></div>`
    + `<div class="rp-sub">${rec.reason ? `${esc(rec.reason)} · ` : ''}by ${esc(rec.by ?? nameOf(rec.actor))}${rec.ts ? ` · ${ago(rec.ts)}` : ''} · ends ${ends(rec.until)}${rec.chosen ? ' · chose it' : ''}</div>`
    + `${lift ? `<button type="button" class="rp-btn" data-lift="${lift}" data-who="${esc(who)}">${lift === 'unban' ? 'Unban' : lift === 'unmute' ? 'Unmute' : 'Bring back'}</button>` : ''}</div>`;
  const bans0 = now.filter((x) => x.ban || x.kick), mutes = now.filter((x) => x.mute), ghosts = now.filter((x) => x.ghost && !x.ghost.chosen);
  const bans = bans0;
  body.innerHTML = `<h4 class="rp-h">Banned or removed now</h4>${bans.length ? bans.map((x) => x.ban ? row(x.who, x.ban, 'banned', mayLift(x.ban, 'ban') && 'unban') : row(x.who, x.kick, 'removed (cooling down)', mayLift(x.kick, 'ban') && 'unban')).join('') : '<p class="rp-note">nobody</p>'}`
    + `<h4 class="rp-h">Muted now</h4>${mutes.length ? mutes.map((x) => row(x.who, x.mute, (x.mute.channels ?? ['voice', 'chat']).join(' + '), mayLift(x.mute, 'mute') && 'unmute')).join('') : '<p class="rp-note">nobody</p>'}`
    + `<h4 class="rp-h">Ghosts</h4>${ghosts.length ? ghosts.map((x) => row(x.who, x.ghost, 'ghost', mayLift(x.ghost, 'kick', false) && 'unghost')).join('') : '<p class="rp-note">nobody</p>'}`
    + `<details class="rp-ended"><summary>Ended bans (${(r.ended ?? []).length})</summary>${(r.ended ?? []).map((m) => row(m.who, m, 'ended', null)).join('') || '<p class="rp-note">none</p>'}</details>`;
  body.querySelectorAll('button[data-lift]').forEach((b) => { b.onclick = () => act(b.dataset.lift, { who: b.dataset.who }, `${b.dataset.lift} ${nm(b.dataset.who)}`, () => paintBans(body)); });
}
const VERB_CHIPS = [['ban', 'bans'], ['mute', 'mutes'], ['kick', 'kicks'], ['warn', 'warns'], ['ghost', 'ghosts'], ['role', 'roles'], ['auto-cooldown', 'automatic']];
async function paintLog(body, { more = false } = {}) {
  if (!more) modBefore = null;
  const r = await sendRequest('modlog', { ...(modWho ? { who: modWho } : {}), ...(modBefore ? { before: modBefore } : {}), limit: 50 });
  if (!r?.ok) { body.innerHTML = `<p class="rp-note">${esc(r?.refused?.reason ?? "couldn't read the log")}</p>`; return; }
  const recs = (r.records ?? []).filter((x) => !modVerbs.size || modVerbs.has(x.verb) || (modVerbs.has('ban') && x.verb === 'unban') || (modVerbs.has('mute') && x.verb === 'unmute') || (modVerbs.has('ghost') && x.verb === 'unghost'));
  const line = (x) => `<div class="rp-row"><div class="rp-main"><span class="rp-dim">${new Date(x.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span> `
    + `<b>${esc(x.by ?? nameOf(x.actor))}</b>${x.actor && x.actor !== 'system' ? badge(x.actor) : ''} <span class="rp-verb" data-verb="${esc(x.verb)}">${esc(x.verb === 'role' ? (x.role ? `made ${x.role}` : 'took a role from') : x.verb)}</span> <b>${esc(x.name ?? nameOf(x.who))}</b></div>`
    + `<div class="rp-sub">${[x.reason, x.channels ? x.channels.join(' + ') : null, x.until !== undefined ? `ends ${ends(x.until)}` : null, x.verb === 'auto-cooldown' ? x.why : null].filter(Boolean).map(esc).join(' · ')}</div></div>`;
  const head = `<div class="rp-filters"><input type="search" class="rp-search" placeholder="person (name or u-…)" value="${esc(modWho ? nameOf(modWho) : '')}">`
    + `<div class="pm-chips">${VERB_CHIPS.map(([v, l]) => `<button type="button" class="pm-chip" data-v="${v}" aria-pressed="${modVerbs.has(v)}">${l}</button>`).join('')}</div></div>`;
  if (!more) body.innerHTML = `${head}<div class="rp-list"></div>`;
  const list = body.querySelector('.rp-list');
  list.querySelector('.rp-more')?.remove();
  list.insertAdjacentHTML('beforeend', recs.map(line).join('') || (more ? '' : '<p class="rp-note">nothing yet</p>'));
  if (r.next) { modBefore = r.next; list.insertAdjacentHTML('beforeend', '<button type="button" class="rp-btn rp-more">older</button>'); list.querySelector('.rp-more').onclick = () => paintLog(body, { more: true }); }
  if (!more) {
    body.querySelectorAll('.pm-chip').forEach((b) => { b.onclick = () => { const v = b.dataset.v; if (modVerbs.has(v)) modVerbs.delete(v); else modVerbs.add(v); paintLog(body); }; });
    const s = body.querySelector('.rp-search'); s.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key !== 'Enter') return;
      const q = s.value.trim(); modWho = !q ? null : /^u-/.test(q) ? q : (identities.get(q) ?? null);
      if (q && !modWho) sendRequest('whois', { name: q }).then((w) => { modWho = w?.people?.[0]?.id ?? '∅'; paintLog(body); }); else paintLog(body); });
  }
}
async function paintScripts(body) {
  const r = await sendRequest('scripts', {});
  if (!r?.ok) { body.innerHTML = `<p class="rp-note">${esc(r?.refused?.reason ?? "couldn't read the scripts")}</p>`; return; }
  const rows = (r.scripts ?? []).map((x) => {
    const paused = x.status === 'paused' && x.pausedBy; const mine = x.sponsor === me().id;
    const may = isOwner() || mine || (has('pauseScripts') && x.sponsor && rankOfId(x.sponsor) < me().rank);
    const blocked = paused && x.pausedBy !== me().id && rankOfId(x.pausedBy) > me().rank;
    const btn = may && !blocked ? `<button type="button" class="rp-btn" data-id="${esc(x.id)}" data-s="${esc(x.script)}" data-p="${paused ? 0 : 1}">${paused ? 'Resume' : 'Pause'}</button>` : '';
    return `<div class="rp-row"><div class="rp-main"><b>${esc(x.id)}</b> <code>${esc(String(x.script).replace(/^script:/, ''))}</code> <span class="rp-status" data-s="${esc(x.status)}">${esc(x.status)}</span></div>`
      + `<div class="rp-sub">sponsor ${esc(x.sponsor ? nameOf(x.sponsor) : 'nobody')}${x.sponsor ? badge(x.sponsor) : ''}${paused ? ` · paused by ${esc(nameOf(x.pausedBy))}${x.pausedTs ? `, ${ago(x.pausedTs)}` : ''}` : ''}</div>${btn}</div>`;
  }).join('');
  body.innerHTML = rows || '<p class="rp-note">no scripts here</p>';
  body.querySelectorAll('button[data-s]').forEach((b) => { b.onclick = () => act('set', { id: b.dataset.id, component: b.dataset.s, value: { paused: b.dataset.p === '1' }, merge: true }, `${b.dataset.p === '1' ? 'pause' : 'resume'} ${b.dataset.id}`, () => paintScripts(body)); });
}
// which Moderation tabs you see: Bans (ban), Log (any moderation power), Scripts (pauseScripts) — a tab whose power you
// lack isn't shown, and the whole panel and its dock entry go when the last power does (research roles S7)
function syncModeration() {
  const want = { bans: has('ban'), log: R.MOD_POWERS.some(has), scripts: has('pauseScripts') };
  const any = Object.values(want).some(Boolean);
  setDockEntry({ id: 'moderation', icon: 'shield', always: true }, any);   // there whenever you hold a power that uses it
  if (!any) { for (const k of Object.keys(sections)) { sections[k].remove(); delete sections[k]; } return; }
  moderationFrame();
  const make = { bans: () => makeSection('Bans', (b) => paintBans(b), { id: 'mod-bans', host: 'moderation' }),
    log: () => makeSection('Log', (b) => paintLog(b), { id: 'mod-log', host: 'moderation' }),
    scripts: () => makeSection('Scripts', (b) => paintScripts(b), { id: 'mod-scripts', host: 'moderation' }) };
  for (const k of ['bans', 'log', 'scripts']) { if (want[k] && !sections[k]) sections[k] = make[k](); else if (!want[k] && sections[k]) { sections[k].remove(); delete sections[k]; } }
}

// ---------------------------------------------------------------- World Settings
const ro = (what = 'the owner') => `<p class="rp-ro">only ${what} changes this</p>`;
const narrow = (body) => (body.closest('.frame')?.clientWidth ?? innerWidth) < 440;   // the grid needs ~440 px for four columns; under that, one role at a time
let gridRole = null;
function defsValue() { const d = wc()['role-defs']; return d && typeof d === 'object' ? JSON.parse(JSON.stringify(d)) : {}; }
async function writeDefs(next, what) { return act('set', { id: '@world', component: 'role-defs', value: next }, what); }
function holdersOf(rid) { const c = wc(); return Object.keys(c).filter((k) => k.startsWith('roles:') && c[k]?.role === rid).map((k) => k.slice(6)); }
function paintRoles(body) {
  const roles = R.rolesOf(wc()); const edit = isOwner(); const grant = has('grantRoles');
  const cell = (r, k) => {
    const on = !!r.can[k]; const lockedOwner = r.id === 'owner';
    const need = R.PERMISSIONS[k].needs.find((n) => !r.can[n]);
    const dis = !edit || lockedOwner || (!!need && !on);
    const why = lockedOwner ? 'the owner holds every permission, always' : need && !on ? `needs ${need}: turn ${need} on first` : !edit ? 'only the owner changes this' : R.PERMISSIONS[k].text;
    return `<td class="${need && !on ? 'rp-grey' : ''}"><input type="checkbox" data-r="${esc(r.id)}" data-k="${k}" ${on ? 'checked' : ''} ${dis ? 'disabled' : ''} title="${esc(why)}" aria-label="${esc(`${r.name}: ${k}`)}"></td>`;
  };
  const head = (r) => `<th scope="col"><div class="rp-rname">${esc(r.name)}</div><div class="rp-dim">${holdersOf(r.id).length} ${holdersOf(r.id).length === 1 ? 'holder' : 'holders'}</div>`
    + (edit && r.custom ? `<select class="rp-above" data-r="${esc(r.id)}" title="place it above…">${roles.filter((x) => x.id !== r.id && x.id !== 'owner').map((x) => `<option value="${esc(x.id)}" ${R.rolesOf(wc()).find((y) => y.rank < r.rank)?.id === x.id ? 'selected' : ''}>above ${esc(x.name)}</option>`).join('')}</select><button type="button" class="rp-x" data-del="${esc(r.id)}" title="delete ${esc(r.name)}">×</button>` : '') + '</th>';
  const holders = (r) => { const ids = holdersOf(r.id); if (!ids.length) return '';
    return `<div class="rp-holders"><b>${esc(r.name)}</b>: ${ids.map((id) => `<span class="rp-holder">${esc(nameOf(id))}${grant && (isOwner() || (rankOfId(id) < me().rank && r.rank < me().rank)) && r.id !== 'owner' ? ` <select class="rp-change" data-who="${esc(id)}"><option value="">change ▸</option>${R.grantableRoles(wc(), { ...me(), permissions: me().permissions }).filter((x) => x.id !== r.id && x.id !== 'owner').map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}<option value="::remove">remove (default role)</option></select>` : ''}</span>`).join(' · ')}</div>`; };
  let html;
  if (narrow(body)) {   // one role at a time (phone, VR, a squeezed panel)
    if (!roles.some((r) => r.id === gridRole)) gridRole = roles[0]?.id;
    const r = roles.find((x) => x.id === gridRole);
    html = `<label class="rp-field">role <select class="rp-pick">${roles.map((x) => `<option value="${esc(x.id)}" ${x.id === gridRole ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>`
      + `<table class="rp-grid rp-one"><tbody>${R.PERMISSION_NAMES.map((k) => `<tr><th scope="row"><b>${k}</b><div class="rp-dim">${esc(R.PERMISSIONS[k].text)}</div></th>${cell(r, k)}</tr>`).join('')}</tbody></table>${holders(r)}`;
  } else {
    html = `<div class="rp-gridwrap"><table class="rp-grid"><thead><tr><th></th>${roles.map(head).join('')}</tr></thead><tbody>`
      + R.PERMISSION_NAMES.map((k) => `<tr><th scope="row"><b>${k}</b><div class="rp-dim">${esc(R.PERMISSIONS[k].text)}</div></th>${roles.map((r) => cell(r, k)).join('')}</tr>`).join('')
      + `</tbody></table></div>${roles.map(holders).join('')}`;
  }
  body.innerHTML = html + (edit ? '<div class="rp-actions"><button type="button" class="rp-btn" data-add>+ Role</button></div>' : ro());
  body.querySelector('.rp-pick')?.addEventListener('change', (e) => { gridRole = e.target.value; paintRoles(body); });
  body.querySelectorAll('input[type=checkbox][data-k]').forEach((cb) => { cb.onchange = () => {
    const rid = cb.dataset.r, k = cb.dataset.k; const r = R.roleDef(wc(), rid); const d = defsValue();
    const can = { ...r.can, [k]: cb.checked };
    if (!cb.checked) for (const x of R.PERMISSION_NAMES) if (R.PERMISSIONS[x].needs.includes(k)) can[x] = false;   // turning a need off turns off what needs it
    d[rid] = { ...(d[rid] ?? {}), ...(r.custom ? { name: r.name, rank: r.rank } : {}), can };
    writeDefs(d, `${r.name}: ${k} ${cb.checked ? 'on' : 'off'}`).then(() => paintRoles(body)); }; });
  body.querySelectorAll('select.rp-above').forEach((s) => { s.onchange = () => {
    const rid = s.dataset.r, below = R.roleDef(wc(), s.value); const above = R.rolesOf(wc()).filter((x) => x.rank > below.rank && x.id !== rid).sort((a, b) => a.rank - b.rank)[0];
    const lo = below.rank, hi = above?.rank ?? 255; const rank = Math.floor((lo + hi) / 2);
    if (rank <= lo || rank >= hi) return toast('no room there: move another role first', 'warn');
    const d = defsValue(); d[rid] = { ...d[rid], rank }; writeDefs(d, `place ${rid} above ${below.name}`).then(() => paintRoles(body)); }; });
  body.querySelectorAll('select.rp-change').forEach((s) => { s.onchange = () => { const v = s.value; if (!v) return; const who = s.dataset.who;
    (v === '::remove' ? act('delete', { id: '@world', component: `roles:${who}` }, `${nameOf(who)}: back to the default role`) : act('set', { id: '@world', component: `roles:${who}`, value: { role: v } }, `make ${nameOf(who)} ${v}`)).then(() => paintRoles(body)); }; });
  body.querySelectorAll('button[data-del]').forEach((b) => { b.onclick = () => deleteRole(b.dataset.del, body); });
  body.querySelector('button[data-add]')?.addEventListener('click', () => addRole(body));
}
function addRole(body) {
  const box = document.createElement('div'); box.className = 'pm-form rp-add';
  const roles = R.rolesOf(wc()).filter((r) => r.id !== 'owner');
  box.innerHTML = `<label class="rp-field">name <input class="pm-text" maxlength="32" placeholder="Crew"></label><label class="rp-field">place it above <select>${roles.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}</select></label><div class="pm-btns"><button type="button" class="pm-cancel">Cancel</button><button type="button" class="pm-go">Add</button></div>`;
  body.querySelector('.rp-actions').before(box);
  const inp = box.querySelector('input'); inp.addEventListener('keydown', (e) => e.stopPropagation()); inp.focus();
  box.querySelector('.pm-cancel').onclick = () => box.remove();
  box.querySelector('.pm-go').onclick = () => {
    const name = inp.value.trim(); if (!name) return inp.focus();
    // an id of its own: a name that slugs like an existing role's (or two names with no Latin letters) must never land on
    // that role's key and overwrite its permissions (review 10-07)
    const base = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 20) || 'role';
    const taken = new Set([...R.BUILTIN_IDS, 'none', 'guest', 'everyone', 'ghost', 'banned', ...Object.keys(defsValue())]);
    let id = base; for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    const below = R.roleDef(wc(), box.querySelector('select').value); const above = R.rolesOf(wc()).filter((x) => x.rank > below.rank).sort((a, b) => a.rank - b.rank)[0];
    const rank = Math.floor((below.rank + (above?.rank ?? 255)) / 2);
    if (rank <= below.rank) return toast('no room there: move another role first', 'warn');
    const d = defsValue(); d[id] = { name, rank, can: {} }; writeDefs(d, `add ${name}`).then(() => paintRoles(body));
  };
}
function deleteRole(rid, body) {
  const ids = holdersOf(rid); const d = defsValue(); delete d[rid];
  if (!ids.length && wc()['default-role']?.role !== rid) return writeDefs(d, `delete ${rid}`).then(() => paintRoles(body));
  // a held role: move its people to another role, and delete it, as ONE act (research S8)
  const box = document.createElement('div'); box.className = 'pm-form';
  const others = R.rolesOf(wc()).filter((r) => r.id !== rid && r.id !== 'owner');
  box.innerHTML = `<p>${ids.length} ${ids.length === 1 ? 'person holds' : 'people hold'} ${esc(rid)}. Move them to <select>${others.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}</select> and delete it?</p><div class="pm-btns"><button type="button" class="pm-cancel">Cancel</button><button type="button" class="pm-go danger">Move and delete</button></div>`;
  body.querySelector('.rp-actions').before(box);
  box.querySelector('.pm-cancel').onclick = () => box.remove();
  box.querySelector('.pm-go').onclick = () => { const to = box.querySelector('select').value;
    const ops = [...ids.map((id) => ({ verb: 'set', args: { id: '@world', component: `roles:${id}`, value: { role: to } } })),
      ...(wc()['default-role']?.role === rid ? [{ verb: 'set', args: { id: '@world', component: 'default-role', value: { ...wc()['default-role'], role: to } } }] : []),
      { verb: 'set', args: { id: '@world', component: 'role-defs', value: d } }];
    act('batch', { ops, label: `delete role ${rid}` }, `move ${ids.length} to ${to} and delete ${rid}`).then(() => paintRoles(body)); };
}
function paintAccess(body) {
  const a = wc().access ?? {}, dr = wc()['default-role'] ?? {}; const edit = isOwner();
  const roles = R.rolesOf(wc()).filter((r) => r.id !== 'owner');
  const def = R.roleDef(wc(), dr.role ?? 'visitor');
  const warn = def && (R.MOD_POWERS.some((k) => def.can[k]) || def.can.generate || dr.can?.generate) ? `<p class="rp-warn">Everyone who arrives is ${esc(def.name)}: they ${R.MOD_POWERS.some((k) => def.can[k]) ? 'may moderate people ranked below them (guests and visitors)' : ''}${R.MOD_POWERS.some((k) => def.can[k]) && (def.can.generate || dr.can?.generate) ? ' and ' : ''}${def.can.generate || dr.gen ? "spend the world's generation credit" : ''}.</p>` : '';
  const sel = (k, opts, v) => `<select data-k="${k}" ${edit ? '' : 'disabled'}>${opts.map(([x, l]) => `<option value="${esc(x)}" ${x === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  body.innerHTML = `<label class="rp-field">Who can come in ${sel('join', [['anyone', 'Anyone'], ['signed-in', 'Signed-in people'], ['listed', 'Only people with a role here']], a.join ?? 'anyone')}</label>`
    + `<label class="rp-field">People who arrive are ${sel('role', roles.map((r) => [r.id, r.name]), dr.role ?? 'visitor')}</label>`
    + `<label class="rp-field">People without an account are ${sel('guests', roles.filter((r) => !R.GUESTS_AT_MOST_DEFAULT || r.rank <= (def?.rank ?? 0)).map((r) => [r.id, r.name]), dr.guests ?? 'visitor')}</label>`
    + `<label class="rp-field">Most people at once <input type="number" min="1" max="200" data-k="max" value="${a.max ?? ''}" placeholder="no limit" ${edit ? '' : 'disabled'}></label>`
    + `<label class="rp-field">Accounts at least <input type="number" min="0" max="365" step="1" data-k="minAccountDays" value="${a.minAccountDays || ''}" placeholder="any age" ${edit ? '' : 'disabled'}> days old</label>`
    + `<p class="rp-dim">when set, guests can't come in; agents are exempt</p>`
    + `<p class="rp-dim">moderators and owners always get in${a.soft ? ` · recommended: ${a.soft}` : ''}</p>${warn}${edit ? '' : ro()}`;
  body.querySelectorAll('[data-k]').forEach((x) => { x.addEventListener('keydown', (e) => e.stopPropagation()); x.onchange = () => {
    const k = x.dataset.k;
    if (k === 'role' || k === 'guests') act('set', { id: '@world', component: 'default-role', value: { [k]: x.value }, merge: true }, `${k === 'role' ? 'arrivals' : 'guests'}: ${x.value}`).then(() => paintAccess(body));
    else { const v = { ...(wc().access ?? { join: 'anyone' }) }; if (k === 'max') { if (x.value) v.max = Math.max(1, Math.min(200, Number(x.value))); else delete v.max; }
      else if (k === 'minAccountDays') { const d = Math.round(Number(x.value)); if (x.value && d > 0) v.minAccountDays = Math.min(365, d); else delete v.minAccountDays; } else v[k] = x.value;
      act('set', { id: '@world', component: 'access', value: v }, 'access').then(() => paintAccess(body)); } }; });
}
function paintCard(body) {
  const ab = wc().about ?? {}; const edit = has('editWorld');
  body.innerHTML = `<label class="rp-field">Name <input data-k="name" maxlength="80" value="${esc(ab.name ?? '')}" ${edit ? '' : 'disabled'}></label>`
    + `<label class="rp-field rp-wide">Description <textarea data-k="text" rows="4" maxlength="2000" ${edit ? '' : 'disabled'}>${esc(ab.text ?? '')}</textarea></label>`
    + `<p class="rp-dim">address: <code>${esc(new URLSearchParams(location.search).get('world') ?? '')}</code></p>${edit ? '<button type="button" class="rp-btn" data-save>Save</button>' : ro('the owner (or someone with editWorld)')}`;
  body.querySelectorAll('input,textarea').forEach((x) => x.addEventListener('keydown', (e) => e.stopPropagation()));
  body.querySelector('[data-save]')?.addEventListener('click', () => act('set', { id: '@world', component: 'about', value: { name: body.querySelector('[data-k=name]').value, text: body.querySelector('[data-k=text]').value } }, 'the card', () => paintCard(body)));
}
function paintPlaces(body) {
  const sp = wc().spawn ?? null, bd = wc().bounds ?? null; const edit = has('editWorld');
  const v3 = (k, v) => `<span class="rp-v3">${[0, 1, 2].map((i) => `<input type="number" step="0.5" data-k="${k}" data-i="${i}" value="${v?.[i] ?? ''}" ${edit ? '' : 'disabled'} aria-label="${k} ${'xyz'[i]}">`).join('')}</span>`;
  body.innerHTML = `<h4 class="rp-h">Spawn</h4><label class="rp-field">where people arrive ${v3('spawn', sp?.pos)}</label><label class="rp-field">within (m) <input type="number" step="0.5" min="0" data-k="radius" value="${sp?.radius ?? ''}" ${edit ? '' : 'disabled'}></label>`
    + `<h4 class="rp-h">Bounds</h4><label class="rp-field">min ${v3('min', bd?.min)}</label><label class="rp-field">max ${v3('max', bd?.max)}</label>`
    + (edit ? '<button type="button" class="rp-btn" data-save>Save</button>' : ro('the owner (or someone with editWorld)'));
  body.querySelectorAll('input').forEach((x) => x.addEventListener('keydown', (e) => e.stopPropagation()));
  const read = (k) => [0, 1, 2].map((i) => Number(body.querySelector(`[data-k=${k}][data-i="${i}"]`).value || 0));
  body.querySelector('[data-save]')?.addEventListener('click', () => act('batch', { ops: [
    { verb: 'set', args: { id: '@world', component: 'spawn', value: { pos: read('spawn'), ...(body.querySelector('[data-k=radius]').value ? { radius: Number(body.querySelector('[data-k=radius]').value) } : {}) } } },
    { verb: 'set', args: { id: '@world', component: 'bounds', value: { min: read('min'), max: read('max') } } }], label: 'places' }, 'places', () => paintPlaces(body)));
}
// what translation carried from an older world: imported:<k>, imported-behavior:<k>, imported-bans:<id>, imported-epoch
const IMPORTED = /^imported(?:-[a-z]+)?(?::|$)/;
function paintOld(body) {
  const st = replica.st?.entities ?? {}; const c = wc(); const edit = isOwner();
  const legacy = Object.keys(c).filter((k) => IMPORTED.test(k));
  const things = Object.entries(st).filter(([id, e]) => id !== '@world' && Object.keys(e.c ?? {}).some((k) => IMPORTED.test(k)));
  body.innerHTML = (!legacy.length && !things.length) ? '<p class="rp-note">nothing carried over from an older world</p>'
    : `<p class="rp-dim">what translation from the old world carried, kept as it was; the old behaviours don't run here (re-install them as scripts)</p>`
    + legacy.map((k) => `<div class="rp-row"><div class="rp-main"><code>${esc(k)}</code> ${k.startsWith('imported-behavior:') ? '<span class="rp-status" data-s="needs-reinstall">not running yet</span>' : ''}</div>${edit ? `<button type="button" class="rp-btn" data-rm="${esc(k)}">Remove</button>` : ''}</div>`).join('')
    + (things.length ? `<h4 class="rp-h">Things (${things.length})</h4>` + things.slice(0, 50).map(([id, e]) => `<div class="rp-row"><div class="rp-main"><b>${esc(id)}</b> ${Object.keys(e.c).filter((k) => IMPORTED.test(k)).map((k) => `<code>${esc(k)}</code>`).join(' ')}</div></div>`).join('') : '')
    + (edit ? '' : ro());
  body.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => act('delete', { id: '@world', component: b.dataset.rm }, `remove ${b.dataset.rm}`, () => paintOld(body)); });
}

let built = false;
export function initRolesPanels() {
  if (built) return; built = true;
  // World Settings: everyone's (read), the owner's (edit)
  worldSettingsFrame();
  setDockEntry({ id: 'world-settings', icon: 'flag', pinOnce: true }, true);
  const ws = [makeSection('Roles', (b) => paintRoles(b), { id: 'ws-roles', host: 'world-settings' }), makeSection('Access', (b) => paintAccess(b), { id: 'ws-access', host: 'world-settings' }),
    makeSection('Card', (b) => paintCard(b), { id: 'ws-card', host: 'world-settings' }), makeSection('Places', (b) => paintPlaces(b), { id: 'ws-places', host: 'world-settings' }),
    makeSection('Old world', (b) => paintOld(b), { id: 'ws-old', host: 'world-settings' })];
  const PAINT = { 'ws-roles': paintRoles, 'ws-access': paintAccess, 'ws-card': paintCard, 'ws-places': paintPlaces, 'ws-old': paintOld };
  // a role or a setting changed (anyone's write lands in the fold): repaint what's open, unless someone is typing in it
  let t = 0; const repaint = () => { clearTimeout(t); t = setTimeout(() => {
    for (const s of ws) if (s.isOpen && !s.body.contains(document.activeElement)) PAINT[s.key]?.(s.body);
    if (sections.bans?.isOpen) paintBans(sections.bans.body); }, 150); };
  bus.on('log-applied', repaint);
  bus.on('your-rights', () => { syncModeration(); repaint(); });
  bus.on('roster', () => { if (sections.bans?.isOpen) paintBans(sections.bans.body); });
  syncModeration();
}
export const _test = { paintRoles, paintAccess, syncModeration, sections };
