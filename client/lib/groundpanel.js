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

import { bus, report } from './base.js';
import { defsRegistry } from './defs.js';
import { sendVerb, isV4 } from './net.js';
import { send as sendV4 } from './v4edit.js';
import { flashHint } from './ui.js';
import { selectRow, btn, btnRow } from './rows.js';
import { paletteDefaults, terrainArgs, grassArgs } from '../../shared/grounddefs.js';
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
    // carry the author's dials across a defs push; fall back when an edit
    // removed the very option they had selected
    const def = paletteDefaults(pal);
    if (!pal.tints[st.tint]) st.tint = def.tint;
    if (pal.shapes[st.shape] == null) st.shape = def.shape;
    if (pal.grassHeight[st.height] == null) st.height = def.height;
    if (pal.grassDensity[st.density] == null) st.density = def.density;
    if (!pal.plantings[st.plant]) st.plant = def.plant;

    // the args are shared/grounddefs.js's — the Build tab's World section
    // writes the same ones for the same pick
    // a v4 world takes door requests, written here (slice 3b): the ground is @world's terrain and grass components, so
    // a pick is a `set` and mow is a `delete` — one act each, undoable like any edit. v1 worlds keep their verbs.
    const ground = (component, value) => isV4()
      ? sendV4(value == null ? { tool: 'delete', args: { id: '@world', component } } : { tool: 'set', args: { id: '@world', component, value } }, { what: component })
      : sendVerb(component, value ?? { clear: true });
    const growTerrain = () => ground('terrain', terrainArgs(pal, { seed: st.seed, shape: st.shape, tint: st.tint }));
    // what "grow" plants — every option is one bag on the singleton grass
    // verb, straight from the def; blade plantings take the height dial and
    // the tint row's colour column
    const growGrass = () => {
      st.grass = true;
      ground('grass', grassArgs(pal, st));
    };
    const isBlade = () => !!pal.plantings[st.plant]?.blade;

    // terrain shape
    body.appendChild(btnRow(...Object.keys(pal.shapes).map((k) =>
      btn(k, () => { st.shape = k; growTerrain(); flashHint(`terrain: ${k}`); }))));
    body.appendChild(btnRow(btn('↻ reshuffle', () => { st.seed = Math.floor(Math.random() * 9999); growTerrain(); })));

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
      btn('mow', () => { st.grass = false; ground('grass', null); flashHint('field cleared'); }),
    ));

    // tint drives both terrain layer and grass colour
    const tint = selectRow('tint', Object.keys(pal.tints), st.tint, (v) => {
      st.tint = v;
      growTerrain();
      if (st.grass) growGrass();
    });
    body.appendChild(tint.row);
  };

  const fill = () => defsRegistry().then(paint).catch((e) => report('ground palette', e));
  fill();
  bus.on('defs-updated', fill);
}
