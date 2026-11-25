// groundpanel — the ground section of the world panel. Unlike the sky panel's live sliders, every control here is a
// deliberate pick (terrain and grass are authored: they persist and fold). The grass pickers recommit at once only
// after 🌱 grow on this page (st.grass, not read from the world); before that they wait for grow.
//
// The vocabulary (tints, shapes, grass dials, plantings) is a def (defs/ground/_palette.json): a pick writes concrete
// verb args, so the log never stores a palette name. No fallback vocabulary: a world serving no palette says so.

import { bus, report, CONFIG } from '../base.js';
import { currentTerrainArgs, terrainEditBase, noteTerrainSent } from '../world.js';
import { defsRegistry } from '../defs.js';
import { send as sendRequest } from './writes.js';
import { flashHint } from '../ui/ui.js';
import { selectRow, btn, btnRow } from './rows.js';
import { paletteDefaults, terrainArgs, grassArgs } from '../../../shared/grounddefs.js';
import { state, onWorldChange } from '../state.js';
import { stateLines } from '../ui/statelines.js';
import { getGrassQuality, getGrassShed, getGrassDensity } from '../terrain.js';

// panel state, outside the paint: a defs push repaints the rows and must keep what the author dialed in
const st = { tint: null, shape: null, seed: 7, density: null, grass: false, plant: null, height: null };
let offNow = null, offBudget = null;   // the readout's subscriptions — one per paint
// the ground is @world's terrain and grass components: a pick is a `set`, mow is a `delete`; one request, undoable
const ground = (component, value) => sendRequest(value == null ? { verb: 'delete', args: { id: '@world', component } } : { verb: 'set', args: { id: '@world', component, value } }, { what: component });

export function paintGround(body) {
  if (body.dataset.init) return;
  body.dataset.init = '1';
  const paint = (reg) => {
    body.innerHTML = '';
    const pal = reg.groundPalette;
    if (!pal?.tints || !pal.shapes || !pal.plantings || !pal.grassHeight || !pal.grassDensity) {
      body.innerHTML = '<div style="color:var(--dim);font-size:11px">this world serves no ground palette (defs/ground/_palette.json)</div>';
      return;
    }
    // keep the author's dials across a defs push; fall back when the def dropped the option selected
    const def = paletteDefaults(pal);
    if (!pal.tints[st.tint]) st.tint = def.tint;
    if (pal.shapes[st.shape] == null) st.shape = def.shape;
    if (pal.grassHeight[st.height] == null) st.height = def.height;
    if (pal.grassDensity[st.density] == null) st.density = def.density;
    if (!pal.plantings[st.plant]) st.plant = def.plant;

    // the args are shared/grounddefs.js's (the Build tab's World section writes the same). Each control patches ITS
    // key over the current terrain bag (terrainEditBase: a sent-but-unechoed edit counts, so quick clicks compose), so
    // what the panel doesn't own (features, a heightmap) survives. A world with no terrain gets the default bag.
    const fresh = () => terrainArgs(pal, { seed: st.seed, shape: st.shape, tint: st.tint });
    const growTerrain = (patch = {}) => {
      const cur = terrainEditBase();
      ground('terrain', noteTerrainSent(cur ? { ...cur, ...patch } : { ...fresh(), ...patch }));
    };
    // what "grow" plants: one grass bag from the def; blade plantings take the height dial and the tint's colour
    const growGrass = () => {
      const args = grassArgs(pal, st);
      if (!args) { flashHint('nothing to grow: this ground palette has no plantings'); return; }   // null to ground() would be a mow
      st.grass = true;
      ground('grass', args); return true;
    };
    const isBlade = () => !!pal.plantings[st.plant]?.blade;

    // terrain shape
    body.appendChild(btnRow(...Object.keys(pal.shapes).map((k) =>
      btn(k, () => { st.shape = k; growTerrain({ amplitude: pal.shapes[k] }); flashHint(`terrain: ${k}`); }))));
    body.appendChild(btnRow(btn('↻ reshuffle', () => { st.seed = Math.floor(Math.random() * 9999); growTerrain({ seed: st.seed }); })));
    body.appendChild(heightmapRow());

    // water: one level for the world (@world's `water` component). The field starts at the current level, else a
    // quarter of the way up the ground's range (a pond in the low places).
    {
      const lvl = document.createElement('input');
      lvl.type = 'number'; lvl.step = '0.25'; lvl.title = 'water level (m)';
      lvl.style.cssText = 'width:4.5em;font-size:11px';
      const cur = (state.st?.water ?? currentTerrainArgs()?.water)?.level;   // water is its own component
      if (Number.isFinite(cur)) lvl.value = String(cur);
      else fetch(`/heightmap?world=${encodeURIComponent(CONFIG.world)}&format=json`).then((r) => (r.ok ? r.json() : null))
        .then((m) => { if (m && !lvl.value) lvl.value = (m.min + (m.max - m.min) * 0.25).toFixed(1); }).catch(() => {});
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:4px;align-items:center;font-size:11px;color:var(--dim)';
      row.append('💧 level', lvl, 'm');
      body.appendChild(row);
      body.appendChild(btnRow(
        btn('fill', () => {
          const level = Number(lvl.value);
          if (!Number.isFinite(level)) { flashHint('set a water level first'); return; }
          ground('water', { ...(state.st?.water ?? {}), level });
          flashHint(`water at ${level} m`);
        }),
        btn('drain', () => { ground('water', null); flashHint('water drained'); }),
      ));
    }

    // what the world has now, and what you're seeing instead (only while those differ): the dials below are a
    // COMPOSER (what grow will plant) and would otherwise read as a report of the field
    const lines = stateLines();
    lines.el.classList.add('ground-now');
    const readNow = () => {
      const g = state.st?.grass;
      let world;
      if (!g || g.clear) world = 'no grass';
      else {
        const named = Object.entries(pal.plantings).find(([, v]) => v?.args?.species && v.args.species === g.species)?.[0];
        world = `${named ?? g.species ?? 'grass'}${named && named !== g.species ? ` (${g.species})` : ''}`
          + `${g.density != null ? ` · density ${g.density}` : ''}${g.height != null ? ` · height ${g.height}` : ''}`;
      }
      let you = null;
      if (g && !g.clear) {
        const cap = getGrassQuality(), shed = getGrassShed(), eff = getGrassDensity();
        if (cap === 'off') you = 'no grass drawn (your grass⚙ is off)';
        else if (eff < 1) you = `drawing ×${+eff.toFixed(2)} of it (${shed < 1 ? `auto governor ×${+shed.toFixed(2)}` : ''}${shed < 1 && cap !== 'full' ? ', ' : ''}${cap !== 'full' ? `your grass⚙ ${cap}` : ''})`;
      }
      lines.set(world, you);
    };
    readNow();
    offNow?.(); offNow = onWorldChange(readNow);
    offBudget?.(); offBudget = bus.on('grass-budget', readNow) ?? null;
    body.appendChild(lines.el);
    const cap = document.createElement('div');
    cap.style.cssText = 'font-size:10px;color:var(--dim);padding:0 2px 2px';
    cap.textContent = 'below: what 🌱 grow plants';
    body.appendChild(cap);

    // what to plant
    const plant = selectRow('plant', Object.keys(pal.plantings), st.plant, (v) => {
      st.plant = v;
      syncPlantControls();
      if (st.grass) growGrass();
    });
    body.appendChild(plant.row);

    // blade length — BLADE grass only: structural species carry their own size and ignore `height`, so the row hides
    const h = selectRow('height', Object.keys(pal.grassHeight), st.height, (v) => {
      st.height = v;
      if (st.grass && isBlade()) growGrass();
    });
    body.appendChild(h.row);
    syncPlantControls();

    function syncPlantControls() {
      h.row.style.display = isBlade() ? '' : 'none';
    }

    // grass
    const dens = selectRow('grass', Object.keys(pal.grassDensity), st.density, (v) => {
      st.density = v;
      if (st.grass) growGrass();
    });
    body.appendChild(dens.row);
    body.appendChild(btnRow(
      btn('🌱 grow', () => { if (growGrass()) flashHint(`${st.plant} growing`); }),
      btn('mow', () => { st.grass = false; ground('grass', null); flashHint('field cleared'); }),
    ));

    // tint drives both terrain layer and grass colour
    const tint = selectRow('tint', Object.keys(pal.tints), st.tint, (v) => {
      st.tint = v;
      growTerrain({ layers: terrainArgs(pal, { tint: v }, terrainEditBase() ?? fresh()).layers });   // the recipe's layers: the first recoloured, the rest kept
      if (st.grass) growGrass();
    });
    body.appendChild(tint.row);
  };

  // heightmap: the ground as an image, out and back (server/heightmap.ts). Export samples the current ground into a
  // 16-bit PNG carrying its height range: all of it, the bag's features, the named ones and the sculpting. Import makes
  // one the ground and takes away everything that shaped the old one (the features list, each terrain-feature, each
  // sculpted tile) in the same request, so no hill is counted twice. The low/high fields cover an image without a
  // range chunk; they start at the current range.
  function heightmapRow() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:3px;padding:2px 0';
    const num = (title) => {
      const i = document.createElement('input');
      i.type = 'number'; i.step = '0.5'; i.title = title;
      i.style.cssText = 'width:4.5em;font-size:11px';
      return i;
    };
    const lo = num('height (m) that black maps to'), hi = num('height (m) that white maps to');
    const range = document.createElement('div');
    range.style.cssText = 'display:flex;gap:4px;align-items:center;font-size:11px;color:var(--dim)';
    range.append('black', lo, 'm  white', hi, 'm');
    const fillRange = () => fetch(`/heightmap?world=${encodeURIComponent(CONFIG.world)}&format=json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { if (m && !lo.value && !hi.value) { lo.value = (+m.min).toFixed(1); hi.value = (+m.max).toFixed(1); } })
      .catch(() => {});
    const file = document.createElement('input');
    file.type = 'file'; file.accept = 'image/png'; file.style.display = 'none';
    file.onchange = async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      flashHint('uploading heightmap…');
      try {
        const q = new URLSearchParams({ as: 'heightmap', name: f.name });
        const r = await fetch(`/upload?${q}`, { method: 'POST', body: f, headers: CONFIG.token ? { authorization: `Bearer ${CONFIG.token}` } : {} });   // the key rides a header, never the URL
        if (!r.ok) throw new Error(await r.text());
        const up = await r.json();
        const min = up.meta?.min ?? Number(lo.value), max = up.meta?.max ?? Number(hi.value);
        if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
          flashHint('set the black/white heights first — this image does not say its range');
          return;
        }
        lo.value = (+min).toFixed(1); hi.value = (+max).toFixed(1);
        const cur = terrainEditBase() ?? { seed: st.seed, segments: 200, layers: terrainArgs(pal(), { tint: st.tint }).layers };
        const next = noteTerrainSent({
          ...cur, size: up.meta?.size ?? cur.size ?? 160,
          // enough mesh to show the image's detail along its longer side
          segments: Math.max(cur.segments ?? 200, Math.min(512, Math.max(up.w, up.h) - 1)),
          heightmap: { grid: up.grid, min, max }, features: [],
        });
        // what shapes the ground from beside the bag goes with the features list: the image already holds it
        const beside = [...Object.keys(state.st?.terrainFeatures ?? {}).map((k) => `terrain-feature:${k}`), ...Object.keys(state.st?.terrainTiles ?? {}).map((k) => `terrain-tile:${k}`)];
        if (!beside.length) ground('terrain', next);
        else sendRequest({ verb: 'batch', args: { requests: [{ verb: 'set', args: { id: '@world', component: 'terrain', value: next } },
          ...beside.map((component) => ({ verb: 'delete', args: { id: '@world', component } }))] } }, { what: 'terrain' });
        flashHint(`heightmap ${up.w}×${up.h} (${up.bits}-bit): ${(+min).toFixed(1)} to ${(+max).toFixed(1)} m`);
      } catch (e) { report('heightmap import', e); flashHint(`heightmap import failed: ${e.message ?? e}`); }
    };
    wrap.append(btnRow(
      btn('⬇ export heightmap', () => {
        const a = document.createElement('a');
        a.href = `/heightmap?world=${encodeURIComponent(CONFIG.world)}&res=257`;
        a.download = `${CONFIG.world}-heightmap.png`;
        a.click();
      }),
      btn('⬆ import heightmap', () => file.click()),
    ), range, file);
    fillRange();
    return wrap;
  }
  const pal = () => lastPal;
  let lastPal = null;
  const fill = () => defsRegistry().then((reg) => { lastPal = reg.groundPalette; paint(reg); }).catch((e) => report('ground palette', e));
  fill();
  bus.on('defs-updated', fill);
}
