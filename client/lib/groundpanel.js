// groundpanel — the 🌿 ground section of the world panel (split from build.js).
//
// Ground was agent-only (terrain/grass verbs); an empty world had no way for a
// person to grow either. These are AUTHORED (they persist and fold), so —
// unlike the sky tuner's live sliders — each is a deliberate commit on a
// click, which is also why they don't spam the log.

import { sendVerb } from './net.js';
import { flashHint } from './ui.js';
import { selectRow, btn, btnRow } from './rows.js';

// A tint is a ground palette: the terrain layer colour, plus the createFlora
// seasonal colour each blade species takes (GRASS_COLORS name). The two grass
// keys differ because the sheets are authored in different hues — the meadow
// sheet is already green so it keeps its own art (null), while bunch grass
// ships a straw recolor and can only be brought back to green by the `green`
// recolor (a multiplier cannot survive a species' own recolor).
const GROUND_TINTS = {
  meadow: { layer: '#4a5d33', grass: null,          tufts: 'green' },
  arid:   { layer: '#7a6b48', grass: 'straw',       tufts: 'straw' },
  tundra: { layer: '#5a6b6b', grass: 'gray-green',  tufts: 'gray-green' },
};
const TERRAIN_SHAPES = { flat: 0.2, hills: 2.6, rugged: 6.0 };
// blade length drives the wind response too (lawns are stiff, tallgrass sways)
const GRASS_HEIGHT = { lawn: 0.15, meadow: 0.42, tall: 0.7 };
const GRASS_DENSITY = {
  sparse: 0.5,
  normal: 1,
  lush:   1.4,   // kept modest — blades are fill-rate
};

export function paintGround(body) {
  if (body.dataset.init) return;
  body.dataset.init = '1';
  body.innerHTML = '';
  const st = { tint: 'meadow', shape: 'hills', seed: 7, density: 'normal', grass: false, plant: 'meadow', height: 'meadow' };

  const growTerrain = () => sendVerb('terrain', {
    seed: st.seed, size: 160, segments: 200, amplitude: TERRAIN_SHAPES[st.shape], flatRadius: 16,
    layers: [{ color: GROUND_TINTS[st.tint].layer, repeat: 16 }],
  });
  // what "grow" plants — every option is one bag on the singleton grass verb
  const PLANTINGS = {
    meadow: () => {
      const args = { species: 'grass', width: 90, depth: 80, center: [0, 0],
        height: GRASS_HEIGHT[st.height] };
      if (GROUND_TINTS[st.tint].grass) args.color = GROUND_TINTS[st.tint].grass;
      return args;
    },
    tufts: () => {
      // bunch grass — a blade grass like the meadow, so it takes the same
      // length and seasonal-colour dials
      const args = { species: 'galleta_dry', width: 80, depth: 70, center: [0, 0],
        height: GRASS_HEIGHT[st.height] };
      if (GROUND_TINTS[st.tint].tufts) args.color = GROUND_TINTS[st.tint].tufts;
      return args;
    },
    'mojave desert': () => ({ preset: 'mojave', width: 90, depth: 80, center: [0, 0] }),
    'corn field': () => ({ species: 'corn', width: 40, depth: 30, center: [0, 0],
      rows: { spacing: 0.9, plant: 0.26 }, corn: { peelChance: 0.25 } }),
    'sunflower field': () => ({ species: 'sunflower', width: 34, depth: 26, center: [0, 0],
      rows: { spacing: 0.85, plant: 0.5 } }),
  };
  const growGrass = () => {
    st.grass = true;
    sendVerb('grass', { ...PLANTINGS[st.plant](), density: GRASS_DENSITY[st.density] });
  };

  // terrain shape
  body.appendChild(btnRow(...Object.keys(TERRAIN_SHAPES).map((k) =>
    btn(k, () => { st.shape = k; growTerrain(); flashHint(`terrain: ${k}`); }))));
  body.appendChild(btnRow(btn('↻ reshuffle', () => { st.seed = Math.floor(Math.random() * 9999); growTerrain(); })));

  // what to plant
  const plant = selectRow('plant', Object.keys(PLANTINGS), st.plant, (v) => {
    st.plant = v;
    syncPlantControls();
    if (st.grass) growGrass();
  });
  body.appendChild(plant.row);

  // blade length — a BLADE-grass control. Structural species (shrubs, yucca,
  // corn) carry their own size, and the engine ignores `height` for them, so
  // the row hides rather than sitting there as a dial that does nothing.
  const BLADE_PLANTINGS = new Set(['meadow', 'tufts']);
  const h = selectRow('height', Object.keys(GRASS_HEIGHT), st.height, (v) => {
    st.height = v;
    if (st.grass && BLADE_PLANTINGS.has(st.plant)) growGrass();
  });
  body.appendChild(h.row);
  syncPlantControls();

  function syncPlantControls() {
    h.row.style.display = BLADE_PLANTINGS.has(st.plant) ? '' : 'none';
  }

  // grass
  const dens = selectRow('grass', Object.keys(GRASS_DENSITY), st.density, (v) => {
    st.density = v;
    if (st.grass) growGrass();
  });
  body.appendChild(dens.row);
  body.appendChild(btnRow(
    btn('🌱 grow', () => { growGrass(); flashHint(`${st.plant} growing`); }),
    btn('mow', () => { st.grass = false; sendVerb('grass', { clear: true }); flashHint('field cleared'); }),
  ));

  // tint drives both terrain layer and grass colour
  const tint = selectRow('tint', Object.keys(GROUND_TINTS), st.tint, (v) => {
    st.tint = v;
    growTerrain();
    if (st.grass) growGrass();
  });
  body.appendChild(tint.row);
}
