// shared/flora_presets.js — the named biome presets a grass write may name (shape audit 10-16): the authority expands one at
// write into its strokes (shared/protocol/assetref.js), so the stored value never holds the name. The SAME data as
// defs/flora/_presets.json (the client's hot-reloadable copy): tools/shape-render-test GR2 holds the two equal, so editing
// one without the other turns red. A changed preset changes only what a NEW write expands to; stored strokes stay.
export const FLORA_PRESETS = Object.freeze({
  "mojave": {
    "doc": "Big-galleta carpet + three shrub species in de-centred organic stands + yucca.",
    "strokes": [
      {
        "species": "galleta_dry",
        "density": 1.3
      },
      {
        "species": "blackbrush",
        "inset": 2,
        "offset": [
          0.08,
          -0.05
        ],
        "seedAdd": 2,
        "density": 0.85,
        "footprint": "organic"
      },
      {
        "species": "blackbrush",
        "inset": 2,
        "offset": [
          -0.09,
          0.08
        ],
        "seedAdd": 52,
        "variant": 1,
        "density": 0.85,
        "footprint": "organic"
      },
      {
        "species": "creosote",
        "offset": [
          -0.06,
          -0.08
        ],
        "seedAdd": 5,
        "density": 0.85,
        "footprint": "organic"
      },
      {
        "species": "creosote",
        "offset": [
          0.1,
          0.06
        ],
        "seedAdd": 85,
        "variant": 1,
        "density": 0.85,
        "footprint": "organic"
      },
      {
        "species": "sagebrush",
        "inset": 2,
        "offset": [
          0.05,
          0.1
        ],
        "seedAdd": 9,
        "density": 0.85,
        "footprint": "organic"
      },
      {
        "species": "yucca",
        "seedAdd": 18,
        "density": 0.7
      }
    ]
  }
});
