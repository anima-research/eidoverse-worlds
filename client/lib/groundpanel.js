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
import { sendVerb } from './net.js';
import { flashHint } from './ui.js';
import { selectRow, btn, btnRow } from './rows.js';

// panel state, OUTSIDE the paint: a defs push repaints the rows and must not
// forget what the author had dialed in
const st = { tint: null, shape: null, seed: 7, density: null, grass: false, plant: null, height: null };

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

    const growTerrain = () => sendVerb('terrain', {
      seed: st.seed, size: 160, segments: 200, amplitude: pal.shapes[st.shape], flatRadius: 16,
      layers: [{ color: pal.tints[st.tint].layer, repeat: 16 }],
    });
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
      btn(k, () => { st.shape = k; growTerrain(); flashHint(`terrain: ${k}`); }))));
    body.appendChild(btnRow(btn('↻ reshuffle', () => { st.seed = Math.floor(Math.random() * 9999); growTerrain(); })));

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
      growTerrain();
      if (st.grass) growGrass();
    });
    body.appendChild(tint.row);
  };

  const fill = () => defsRegistry().then(paint).catch((e) => report('ground palette', e));
  fill();
  bus.on('defs-updated', fill);
}
