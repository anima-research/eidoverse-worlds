// palette — the world panel's catalog sections (split from build.js, §R4):
// the model library, the avatar roster, and the drag-in upload door. The
// EDITING gestures (ghost, select, drag, undo) stay in build.js; this module
// is how a thing gets INTO your hand, build.js is what your hand does with it.

import { CONFIG, report, bus } from './base.js';
import { libLabels } from './assets.js';
import { sendVerb } from './net.js';
import { makeSection, toast, escapeHtml } from './ui.js';
import { holdGhost } from './build.js';
import { paintGround } from './groundpanel.js';
import { paintSky } from './skypanel.js';

// The starter vocabulary. Everything else arrives through the catalog or an
// `asset` verb, so this list is a doorway, not a limit.
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

  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'search the library…';
  search.addEventListener('keydown', (e) => e.stopPropagation()); // typing ≠ walking
  body.appendChild(search);

  const grid = document.createElement('div');
  grid.className = 'grid';
  body.appendChild(grid);

  const paint = (items) => {
    grid.innerHTML = '';
    for (const it of items) {
      libLabels.set(it.path, it.name);
      const card = document.createElement('button');
      card.className = 'card panel';
      const img = it.preview
        ? `<img alt="" loading="lazy" src="/library/${it.preview}" onerror="this.style.visibility='hidden'">`
        : '<div style="width:100%;aspect-ratio:1"></div>';
      card.innerHTML = `${img}<span>${escapeHtml(it.name)}</span>`;   // server-supplied name (§24k hygiene)
      card.onclick = () => holdGhost(it.path, it.name);
      grid.appendChild(card);
    }
    if (!items.length) grid.innerHTML = '<div style="color:var(--dim);font-size:11px">nothing matched</div>';
  };

  // The catalog agents already had (mcpl list_library), now served to people —
  // with the _preview.jpg Skye ships beside every model, so it's a real
  // catalog instead of a list of filenames.
  const starter = () => STARTER.map(([name, path]) =>
    ({ name, path, preview: path.replace(/\.glb$/, '_preview.jpg') }));

  let timer = null;
  const run = async (q) => {
    // An empty box shows the curated starters, not an alphabetical dump of the
    // whole library — otherwise opening the panel greets you with four
    // varieties of apocalyptic rubble.
    if (!q) { paint(starter()); return; }
    try {
      const r = await fetch(`/library-models?q=${encodeURIComponent(q)}`);
      paint(await r.json());
    } catch (e) { report('catalog', e); }
  };
  search.oninput = () => { clearTimeout(timer); timer = setTimeout(() => run(search.value.trim()), 160); };

  paint(starter());
}

// Assets uploaded into the world join the palette live, for everyone.
bus.on('asset', ({ name, path }) => {
  libLabels.set(path, name);
  toast(`${name} joined the world's palette`, 'info');
});

// ---- avatars ---------------------------------------------------------------

let onSwitchAvatar = null;
export function wireAvatarSwitch(fn) { onSwitchAvatar = fn; }
let myAvatarPath = '';
export function setMyAvatarPath(p) { myAvatarPath = p; }

async function paintAvatars(body) {
  const list = await fetch('/avatars').then((r) => r.json()).catch(() => []);
  body.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const { name, path } of list) {
    const card = document.createElement('button');
    card.className = `card panel ${path === myAvatarPath ? 'on' : ''}`;
    card.innerHTML =
      `<img alt="" loading="lazy" src="/thumb/${encodeURIComponent(name)}.png"
         onerror="this.parentNode.querySelector('.ph').style.display='flex';this.style.display='none'">
       <div class="ph" style="display:none;width:100%;aspect-ratio:1;align-items:center;
         justify-content:center;background:rgba(0,0,0,.3);border-radius:4px;font-size:18px">🧍</div>
       <span>${escapeHtml(name)}</span>`;
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
    if (CONFIG.token) q.set('token', CONFIG.token);
    const r = await fetch(`/upload${q.size ? `?${q}` : ''}`, { method: 'POST', body: file });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const { path, name } = await r.json();
    if (isVrm) {
      toast(`avatar "${name}" is on the roster — pick it in the avatar panel`, 'info', 9000);
    } else {
      const label = file.name.replace(/\.glb$/i, '');
      sendVerb('asset', { name: label, path });  // world vocabulary grows for everyone
      await holdGhost(path, label);
    }
  } catch (err) { report(`upload ${file.name}`, err); }
});
