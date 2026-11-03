// groundpanel — the 🌿 ground section of the world panel (split from build.js).
//
// Ground was agent-only (terrain/grass verbs); an empty world had no way for a
// person to grow either. These are AUTHORED (they persist and fold), so —
// unlike the sky tuner's live sliders — each is a deliberate commit on a
// click, which is also why they don't spam the log.
//
// The vocabulary itself — tints, shapes, the grass dials, what "grow" can
// plant — is a DEF now (defs/ground/_palette.json, §R4 defs round two), on
// the sky-presets law: the panel applies a choice as concrete verb args, so
// the log never stores a palette name and logged meaning never depends on
// the def file. SINGLE-SOURCE posture: no hardcoded fallback vocabulary —
// a fallback would be the mirror this extraction exists to kill, so a world
// serving no palette gets a panel that says so.

import { bus, report, CONFIG } from './base.js';
import { currentTerrainArgs, terrainEditBase, noteTerrainSent } from './world.js';
import { defsRegistry } from './defs.js';
import { sendVerb } from './net.js';
import { flashHint } from './ui.js';
import { selectRow, btn, btnRow } from './rows.js';
import { state, onWorldChange } from './state.js';
import { stateLines } from './statelines.js';
import { getGrassQuality, getGrassShed, getGrassDensity } from './terrain.js';

// panel state, OUTSIDE the paint: a defs push repaints the rows and must not
// forget what the author had dialed in
const st = { tint: null, shape: null, seed: 7, density: null, grass: false, plant: null, height: null };
let offNow = null, offBudget = null;   // the readout's subscriptions — one per paint

export function paintGround(body) {
  if (body.dataset.init) return;
  body.dataset.init = '1';
  const paint = (reg) => {
    body.innerHTML = '';
    const pal = reg.groundPalette;
    if (!pal?.tints || !pal.shapes || !pal.plantings) {
      body.innerHTML = '<div style="color:var(--dim);font-size:11px">this world serves no ground palette (defs/ground/_palette.json)</div>';
      return;
    }
    const first = (o) => Object.keys(o)[0];
    // carry the author's dials across a defs push; fall back when an edit
    // removed the very option they had selected
    if (!pal.tints[st.tint]) st.tint = pal.tints.meadow ? 'meadow' : first(pal.tints);
    if (pal.shapes[st.shape] == null) st.shape = pal.shapes.hills != null ? 'hills' : first(pal.shapes);
    if (pal.grassHeight[st.height] == null) st.height = pal.grassHeight.meadow != null ? 'meadow' : first(pal.grassHeight);
    if (pal.grassDensity[st.density] == null) st.density = pal.grassDensity.normal != null ? 'normal' : first(pal.grassDensity);
    if (!pal.plantings[st.plant]) st.plant = pal.plantings.meadow ? 'meadow' : first(pal.plantings);

    // Each control changes ITS key over the world's current terrain bag, never the whole bag: rebuilding it
    // from the panel's dials dropped everything the panel doesn't own — placed features, a heightmap, a seed
    // or size set from the console. (Changing the tint flattened a shaped world back to plain noise.) A world
    // with no terrain yet gets the panel's full default bag, as before.
    const fresh = () => ({
      seed: st.seed, size: 160, segments: 200, amplitude: pal.shapes[st.shape], flatRadius: 16,
      layers: [{ color: pal.tints[st.tint].layer, repeat: 16 }],
    });
    const growTerrain = (patch) => {
      const cur = terrainEditBase();
      sendVerb('terrain', noteTerrainSent(cur ? { ...cur, ...patch } : { ...fresh(), ...patch }));
    };
    // what "grow" plants — every option is one bag on the singleton grass
    // verb, straight from the def; blade plantings take the height dial and
    // the tint row's colour column
    const growGrass = () => {
      st.grass = true;
      const p = pal.plantings[st.plant];
      const args = structuredClone(p.args);
      if (p.blade) {
        args.height = pal.grassHeight[st.height];
        const color = pal.tints[st.tint][p.tint];
        if (color) args.color = color;
      }
      sendVerb('grass', { ...args, density: pal.grassDensity[st.density] });
    };
    const isBlade = () => !!pal.plantings[st.plant]?.blade;

    // terrain shape
    body.appendChild(btnRow(...Object.keys(pal.shapes).map((k) =>
      btn(k, () => { st.shape = k; growTerrain({ amplitude: pal.shapes[k] }); flashHint(`terrain: ${k}`); }))));
    body.appendChild(btnRow(btn('↻ reshuffle', () => { st.seed = Math.floor(Math.random() * 9999); growTerrain({ seed: st.seed }); })));
    body.appendChild(heightmapRow());

    // 💧 water: one level for the world — every bit of ground below it is under water. The level starts
    // a quarter of the way up the ground's current range (a pond in the low places), or where it is now.
    {
      const lvl = document.createElement('input');
      lvl.type = 'number'; lvl.step = '0.25'; lvl.title = 'water level (m)';
      lvl.style.cssText = 'width:4.5em;font-size:11px';
      const cur = currentTerrainArgs()?.water?.level;
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
          growTerrain({ water: { ...(terrainEditBase()?.water ?? {}), level } });
          flashHint(`water at ${level} m`);
        }),
        btn('drain', () => { growTerrain({ water: null }); flashHint('water drained'); }),
      ));
    }

    // WHAT THE WORLD HAS NOW, and what you're seeing instead (only while those differ). The dials below are a
    // COMPOSER (what 🌱 grow will plant) and they default to meadow, so on their own they read like a report of the
    // field (the owner and I both took galleta_dry for meadow, 09-24).
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

    // blade length — a BLADE-grass control. Structural species (shrubs,
    // yucca, corn) carry their own size, and the engine ignores `height` for
    // them, so the row hides rather than sitting there as a dial that does
    // nothing.
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
      btn('🌱 grow', () => { growGrass(); flashHint(`${st.plant} growing`); }),
      btn('mow', () => { st.grass = false; sendVerb('grass', { clear: true }); flashHint('field cleared'); }),
    ));

    // tint drives both terrain layer and grass colour
    const tint = selectRow('tint', Object.keys(pal.tints), st.tint, (v) => {
      st.tint = v;
      growTerrain({ layers: [{ color: pal.tints[v].layer, repeat: 16 }] });
      if (st.grass) growGrass();
    });
    body.appendChild(tint.row);
  };

  // ⛰ heightmap: the ground as an image, out and back (server/heightmap.ts). Export samples the world's CURRENT
  // ground — noise, heightmap and placed features together — into a 16-bit grayscale PNG that carries its own
  // height range; import uploads one and makes it the ground. Because an export already contains the features,
  // importing replaces them too (no hill counted twice). If an editor drops the range chunk, the low/high
  // fields say which heights black and white mean; they start at the current ground's range.
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
        const q = new URLSearchParams({ as: 'heightmap', name: f.name, ...(CONFIG.token ? { token: CONFIG.token } : {}) });
        const r = await fetch(`/upload?${q}`, { method: 'POST', body: f });
        if (!r.ok) throw new Error(await r.text());
        const up = await r.json();
        const min = up.meta?.min ?? Number(lo.value), max = up.meta?.max ?? Number(hi.value);
        if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
          flashHint('set the black/white heights first — this image does not say its range');
          return;
        }
        lo.value = (+min).toFixed(1); hi.value = (+max).toFixed(1);
        const cur = terrainEditBase() ?? { seed: st.seed, segments: 200, layers: [{ color: pal().tints[st.tint].layer, repeat: 16 }] };
        sendVerb('terrain', noteTerrainSent({
          ...cur, size: up.meta?.size ?? cur.size ?? 160,
          // enough mesh to show the image's detail along its longer side
          segments: Math.max(cur.segments ?? 200, Math.min(512, Math.max(up.w, up.h) - 1)),
          heightmap: { grid: up.grid, min, max }, features: [],
        }));
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
