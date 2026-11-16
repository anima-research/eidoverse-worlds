// catalog — the world panel's palette sections: the model library, the avatar roster, and drag-in upload. How a
// thing gets INTO your hand; build.js (holdGhost) is what your hand does with it.

import { enc } from '../../../shared/protocol/names.js';
import * as OP from '../../../shared/requests.js';
import { sendOps } from './writes.js';
import { TIER_COLORS } from '../../../shared/perfrank.js';
import { CONFIG, report, bus } from '../base.js';
import { libLabels } from '../assets.js';
import { makeSection, toast } from '../ui/ui.js';
import { escapeHtml } from '../ui/markup.js';
import { holdGhost } from './build.js';
import { paintGround } from './groundpanel.js';
import { paintSky } from './skypanel.js';

// the curated starters; everything else arrives through the library search or an upload
const STARTER = [
  ['crate (red)', 'eidoverse/assets/models/crate_large_red.glb'],
  ['crate (blue)', 'eidoverse/assets/models/crate_large_blue.glb'],
  ['palm tree', 'eidoverse/assets/models/palm_date_tree_tropical_deseert_oasis_plant.glb'],
  ['joshua tree', 'eidoverse/assets/models/stylized_yucca_joshua_tree_desert_cactus_plant.glb'],
  ['streetlight', 'eidoverse/assets/models/streetlight_lamp_light_street_blade_runner_cyberpunk.glb'],
  ['deco desk', 'eidoverse/assets/models/scifi_art_deco_office_desk.glb'],
  ['retro computer', 'eidoverse/assets/models/scif_cyberpunk_crt_retro_computer_monitor_screen_keyboard_tower.glb'],
  ['barrels', 'eidoverse/assets/models/scifi_barrels_group_of_four.glb'],
];

/** The curated starters, as rows — the same list the palette opens on. */
export const starterModels = () => STARTER.map(([name, path]) => ({ name, path }));

export function initPalette() {
  makeSection('🧱 build', async (body) => { if (!body.dataset.init) await paintBuild(body); },
    { id: 'build' });
  makeSection('🧍 avatar', paintAvatars, { id: 'avatar' });
  makeSection('🌿 ground', paintGround, { id: 'ground' });
  makeSection('☀ sky', paintSky, { id: 'sky' });
}

// ---- models ----------------------------------------------------------------

async function paintBuild(body) {
  body.dataset.init = '1';
  body.innerHTML = '';

  // primitives that aren't library models — a light is the first
  const prim = document.createElement('button');
  prim.textContent = '💡 add light';
  prim.title = 'place a light source';
  prim.onclick = () => holdGhost('@light', 'light');
  body.appendChild(prim);
  for (const shape of ['box', 'sphere', 'cylinder', 'plane', 'capsule']) {
    const b = document.createElement('button');
    b.textContent = `▢ add ${shape}`;
    b.title = `place a ${shape}: a parametric body with no model`;
    b.onclick = () => holdGhost(`@mesh:${shape}`, shape);
    body.appendChild(b);
  }

  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'search the library…';
  search.addEventListener('keydown', (e) => e.stopPropagation()); // typing ≠ walking
  body.appendChild(search);

  const grid = document.createElement('div');
  grid.className = 'grid';
  body.appendChild(grid);

  // every optimization's status, from the server's verdicts (/library-models `opt`, server/store-variants.ts
  // variantStatus): refused / deferred / stale shows an amber chip, a built LOD a quiet one. Text goes through
  // textContent/title only: reasons derive from uploaded content.
  const PASS = { min: 'compressed copy', ktx2: 'GPU textures', lod: 'LOD' };
  const WORD = { built: 'built', 'not-needed': 'not needed', unsupported: 'not supported', refused: 'refused',
    stale: 'will be re-checked', deferred: 'deferred', pending: 'not processed yet' };
  // the corner row: the perf rank as a coloured pill (shared/perfrank.js, as Debug › Perf › Loupe), then LOD / ⚠ chips
  const CAT = { tris: 'triangles', draws: 'draw calls', texMB: 'texture memory', bones: 'bones', mats: 'materials', alpha: 'transparent materials' };
  const chipRow = (card) => {
    let row = card.querySelector('.opt-row');
    if (!row) {
      row = document.createElement('div');
      row.className = 'opt-row';
      // the chips sit INSIDE the card's <button>: a click on one is the chip's, never the card's (placement)
      row.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); });
      row.style.cssText = 'position:absolute;bottom:6px;right:6px;display:flex;gap:4px;align-items:center;pointer-events:none';
      (card.querySelector('.pv') ?? card).appendChild(row);
    }
    return row;
  };
  const perfLine = (label, p) => `${label}: ${p.rankName} — set by ${CAT[p.worst] ?? p.worst}\n`
    + `  ${p.tris.toLocaleString()} tris · ${p.draws} draws · ${p.mats} materials · ${p.texMB} MB textures (desktop worst case)`
    + `${p.alpha ? ` · ${p.alpha} transparent` : ''}${p.bones ? ` · ${p.bones} bones` : ''}`
    + `${p.unsizedImages ? ` · ${p.unsizedImages} image(s) not sized` : ''}`;
  // ↻: re-run this model's GPU-texture + LOD passes (POST /rebuild, signed-in or token-keyed). Inside the card's
  // <button>, so a click must never reach the card (placement).
  const rebuildChip = (card, path, bad) => {
    const chip = document.createElement('b');
    chip.className = 'opt-rebuild';
    chip.textContent = '↻';
    chip.setAttribute('role', 'button');
    chip.tabIndex = 0;
    chip.title = 'rebuild GPU textures + LOD (re-asks a refused pass)';
    chip.setAttribute('aria-label', chip.title);
    chip.style.cssText = 'position:relative;display:inline-block;width:auto;font-size:10px;line-height:1;padding:1px 5px;border-radius:4px;'
      + `pointer-events:auto;cursor:pointer;background:rgba(0,0,0,.55);color:#e8e8e8;opacity:${bad ? 1 : 0.55}`;
    // a >= 22 px hit area for a finger or laser without growing the drawn chip; 3 px on the left so it never covers
    // the chip beside it
    const hit = document.createElement('i');   // not a <span>: a card's name is its first span
    hit.style.cssText = 'position:absolute;inset:-6px -8px -6px -3px';
    chip.appendChild(hit);
    chip.onmousedown = (e) => e.preventDefault();   // Tab focuses it; a mouse press leaves focus where it was
    chip.onpointerenter = () => { chip.style.opacity = '1'; };
    chip.onpointerleave = () => { chip.style.opacity = bad ? '1' : '0.55'; };
    chip.onclick = async (e) => {
      e.stopPropagation(); e.preventDefault();
      if (chip.dataset.busy) return;
      chip.dataset.busy = '1'; chip.firstChild.data = '…';
      try {
        const q = new URLSearchParams({ path });
        // the authority key rides a header, never the URL; a signed-in session rides its cookie (same-origin fetch sends it)
        const r = await fetch(`/rebuild?${q}`, { method: 'POST', headers: CONFIG.token ? { authorization: `Bearer ${CONFIG.token}` } : {} });
        const j = r.ok ? await r.json() : null;
        toast(j ? (j.busy ? 'the encoder is busy with other rebuilds — try again in a minute' : j.cooldownS ? `rebuilt recently — this model can be rebuilt again in ${Math.ceil(j.cooldownS / 60)} min` : j.queued.length ? `rebuilding ${j.queued.map((k) => PASS[k] ?? k).join(' + ')} — the card updates on the next search`
          : 'nothing to rebuild on this server (no texture encoder)') : `rebuild refused (${r.status})`);
      } catch { toast('rebuild failed — server unreachable'); }
      chip.firstChild.data = '↻'; delete chip.dataset.busy;
    };
    // keyboard: the card's <button> would take Enter/Space as a placement, so the chip keeps them
    chip.onkeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.stopPropagation(); e.preventDefault(); chip.onclick(e);
    };
    chip.onkeyup = (e) => { if (e.key === ' ') { e.stopPropagation(); e.preventDefault(); } };   // Space activates a button on keyup
    chipRow(card).appendChild(chip);
  };
  // tooltips live on the thing they explain: the pill carries the perf numbers (what it costs if you load it, and
  // the original upload's), the LOD/⚠ chips each pass's status; the card names the model in full
  const optBadge = (card, opt, perf, perfOriginal, path, rebuildable, fullName) => {
    if (fullName) card.title = fullName;
    if (perf) {
      const perfRows = [perfLine(`perf if loaded (${perf.servedAs ?? 'served'})`, perf)];
      if (perfOriginal) perfRows.push(perfLine('original upload', perfOriginal));
      const pill = document.createElement('b');   // not a span: the card's label rule (.card span) is full-width
      pill.className = 'opt-rank';
      pill.dataset.rank = String(perf.rank);
      pill.style.cssText = `display:inline-block;width:14px;height:8px;border-radius:4px;background:${TIER_COLORS[perf.rank]};`
        + 'box-shadow:0 0 0 1px rgba(0,0,0,.45);pointer-events:auto;cursor:help';
      // + every pass's status: a card with no LOD/⚠ chip would otherwise show its status nowhere
      pill.title = [...perfRows, ...(opt ? [Object.entries(opt).map(([k, v]) => `${PASS[k] ?? k}: ${WORD[v.state] ?? v.state}${v.reason ? ` — ${v.reason}` : ''}`).join('\n')] : [])].join('\n');
      chipRow(card).appendChild(pill);
    }
    if (!opt) { if (path && rebuildable !== false) rebuildChip(card, path, false); return; }
    const statusRows = Object.entries(opt).map(([k, v]) => `${PASS[k] ?? k}: ${WORD[v.state] ?? v.state}${v.reason ? ` — ${v.reason}` : ''}`).join('\n');
    const bad = Object.values(opt).some((v) => v.state === 'refused' || v.state === 'deferred' || v.state === 'stale');
    const lod = opt.lod?.state === 'built';
    for (const [on, text, css] of [[lod, 'LOD', 'background:rgba(143,232,200,.18);color:#8fe8c8'], [bad, '⚠', 'background:#6b4a12;color:#ffd68a']]) {
      if (!on) continue;
      const chip = document.createElement('b');
      chip.className = 'opt-chip';
      chip.textContent = text;
      chip.style.cssText = `display:inline-block;width:auto;font-size:9px;line-height:1;padding:2px 4px;border-radius:4px;font-weight:600;pointer-events:auto;cursor:help;${css}`;
      chip.title = statusRows;
      chipRow(card).appendChild(chip);
    }
    if (path && rebuildable !== false) rebuildChip(card, path, bad);   // no source to rebuild from → no button (it would 400)
  };

  const paint = (items) => {
    grid.innerHTML = '';
    for (const it of items) {
      libLabels.set(it.path, it.name);
      const card = document.createElement('button');
      card.className = 'card panel';
      const img = it.preview
        ? `<img alt="" loading="lazy" src="/library/${escapeHtml(it.preview)}">`   // no inline onerror: the page's CSP refuses inline handlers (hidden below)
        : '<div style="width:100%;aspect-ratio:1"></div>';
      // the picture gets its own positioned box so the status row sits ON the image (bottom-right), clear of the
      // label strip the previews carry along their top edge and of the name below
      card.innerHTML = `<div class="pv" style="position:relative;width:100%;line-height:0">${img}</div><span>${escapeHtml(it.name)}</span>`;   // server-supplied name: escaped
      card.querySelector('img')?.addEventListener('error', (e) => { e.currentTarget.style.visibility = 'hidden'; });
      card.onclick = () => holdGhost(it.path, it.name);
      optBadge(card, it.opt, it.perf, it.perfOriginal, it.path, it.rebuildable, (it.path?.split('/').pop() ?? it.name).replace(/\.glb$/i, '').replace(/_/g, ' '));
      grid.appendChild(card);
    }
    if (!items.length) grid.innerHTML = '<div style="color:var(--dim);font-size:11px">nothing matched</div>';
  };

  // the catalog agents have (mcpl list_library), with each model's _preview.jpg
  const starter = () => STARTER.map(([name, path]) =>
    ({ name, path, preview: path.replace(/\.glb$/, '_preview.jpg') }));
  // the starters paint at once, then again with the catalog's record for each (opt / perf / rebuildable), in one
  // request; a starter the catalog doesn't know stays plain
  const enrichStarters = async () => {
    const rows = starter();
    const stems = STARTER.map(([, p]) => p.split('/').pop().replace(/\.glb$/, '').toLowerCase());
    try {
      const hits = await (await fetch(`/library-models?q=${encodeURIComponent(stems.join(' '))}`)).json();
      const by = new Map(hits.map((h) => [h.path, h]));
      return rows.map((r) => { const h = by.get(r.path); return h ? { ...h, name: r.name, preview: r.preview } : r; });
    } catch (e) { report('catalog', e); return rows; }
  };
  const showStarters = () => {
    paint(starter());
    enrichStarters().then((rows) => { if (!search.value.trim()) paint(rows); });   // not over a search typed meanwhile
  };

  let timer = null;
  const run = async (q) => {
    // an empty box shows the curated starters, not an alphabetical dump of the whole library
    if (!q) { showStarters(); return; }
    try {
      const r = await fetch(`/library-models?q=${encodeURIComponent(q)}`);
      paint(await r.json());
    } catch (e) { report('catalog', e); }
  };
  search.oninput = () => { clearTimeout(timer); timer = setTimeout(() => run(search.value.trim()), 160); };

  showStarters();
}

// Assets uploaded into the world join the palette live, for everyone.
bus.on('asset', ({ name, path }) => {
  libLabels.set(path, name);
  toast(`${name} joined the world's palette`, 'info');
});

// ---- avatars ---------------------------------------------------------------

let onSwitchAvatar = null;
const AV_CAT = { tris: 'triangles', draws: 'draw calls', texMB: 'texture memory', bones: 'bones', mats: 'materials', alpha: 'transparent materials' };
export function wireAvatarSwitch(fn) { onSwitchAvatar = fn; }
/** The one body-switch, for every surface (the desktop cards, the bodies panel, its quad). */
export function switchAvatar(path, name) { return onSwitchAvatar?.(path, name); }
let myAvatarPath = '';
export function setMyAvatarPath(p) { myAvatarPath = p; }

// a confirmed perf stamp (avatar.js) repaints an open avatar section, so the pill appears without a reload
let avatarBody = null;
bus.on('avatar-perf', () => { if (avatarBody?.isConnected) paintAvatars(avatarBody); });
async function paintAvatars(body) {
  avatarBody = body;
  const list = await fetch('/avatars').then((r) => r.json()).catch(() => []);
  body.innerHTML = '';
  // dense grid, every card a 3:4 portrait box whether the image loaded or not
  const grid = document.createElement('div');
  grid.className = 'grid dense av-grid';
  for (const { name, path, perf } of list) {
    const card = document.createElement('button');
    card.className = `card panel ${path === myAvatarPath ? 'on' : ''}`;
    // the portrait BOX sizes the card, never the image: a lazy <img> that hasn't loaded (or 404s) has no size.
    // The placeholder shows through until a portrait covers it.
    card.innerHTML =
      `<div class="av-shot"><div class="ph">🧍</div><img alt="" loading="lazy" src="/thumb/${encodeURIComponent(name)}.png"></div>
       <span>${escapeHtml(name)}</span>`;
    const img = card.querySelector('img');
    img.addEventListener('error', () => { img.remove(); });
    card.title = name;   // the portrait names itself; the perf numbers live on the pill
    // the perf rank of this body as loaded (stamped by a wearer's client, server/routes.ts avatarRoster; absent
    // until someone has worn it): the same pill as the library cards
    if (perf) {
      const pill = document.createElement('b');
      pill.className = 'opt-rank';
      pill.dataset.rank = String(perf.rank);
      pill.style.cssText = `position:absolute;right:6px;bottom:6px;z-index:1;display:inline-block;width:14px;height:8px;border-radius:4px;`
        + `background:${TIER_COLORS[perf.rank]};box-shadow:0 0 0 1px rgba(0,0,0,.45)`;
      pill.style.cursor = 'help';
      card.querySelector('.av-shot').appendChild(pill);
      // the tooltip lives ON the pill, not the whole portrait
      pill.title = `perf: ${perf.rankName} — set by ${AV_CAT[perf.worst] ?? perf.worst}\n  ${perf.tris.toLocaleString()} tris · ${perf.draws} draws · `
        + `${perf.mats} materials · ${perf.texMB} MB textures${perf.bones ? ` · ${perf.bones} bones` : ''}${perf.alpha ? ` · ${perf.alpha} transparent` : ''}`;
    }
    card.onclick = () => onSwitchAvatar?.(path, name);
    grid.appendChild(card);
  }
  body.appendChild(grid);
}

// ---- upload ----------------------------------------------------------------

addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  const isVrm = /\.vrm$/i.test(file.name);
  if (!/\.(glb|vrm)$/i.test(file.name)) {
    toast(`can't ingest ${file.name} — .glb and .vrm only`, 'warn');
    return;
  }
  toast(`uploading ${file.name} (${(file.size / 1e6).toFixed(1)}MB)…`, 'info');
  try {
    const q = new URLSearchParams();
    if (isVrm) { q.set('as', 'avatar'); q.set('name', file.name); }
    const r = await fetch(`/upload${q.size ? `?${q}` : ''}`, { method: 'POST', body: file, headers: CONFIG.token ? { authorization: `Bearer ${CONFIG.token}` } : {} });   // the key rides a header, never the URL
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const { path, name } = await r.json();
    if (isVrm) {
      toast(`avatar "${name}" is on the roster — pick it in the avatar panel`, 'info', 9000);
    } else {
      const label = file.name.replace(/\.glb$/i, '');
      sendOps([OP.set('@world', `assets:${enc(path)}`, { name: label, path })], { what: `add ${label} to this world's assets`, expect: false });  // world vocabulary grows for everyone
      await holdGhost(path, label);
    }
  } catch (err) { report(`upload ${file.name}`, err); }
});
