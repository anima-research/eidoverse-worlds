// flora_args — pure translation logic for the `grass` verb: legacy makeGrass
// bags → createFlora options, and preset/variety stroke composition. No DOM,
// no THREE — unit-tested in spec/flora_args.test.ts.

// makeGrass's blade atlas replacement has a known opaque mean (documented in
// vegetation.js: 91/138/35). A legacy hex color maps to the multiplier that
// carries the atlas mean to that hex — the same field intent, spoken in the
// new system's terms.
export const ATLAS_MEAN = [91, 138, 35];
const LEGACY_KEYS = ['bladeHeight', 'spacing', 'perCell', 'colorTip',
  'windSpeed', 'lean', 'fade', 'fadeStart', 'fadeEnd', 'fadeColor', 'backlight'];

export function isLegacyArgs(a) {
  return LEGACY_KEYS.some((k) => a[k] !== undefined) || typeof a.color === 'number';
}

const splitHex = (h) => {
  const n = typeof h === 'string' ? parseInt(h.replace('#', ''), 16) : h;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export function hexToMultiplier(hex, tipHex) {
  const c = splitHex(hex);
  const t = tipHex !== undefined ? splitHex(tipHex) : c;
  // blade color reads mostly at the lit tip half — bias the blend that way
  return c.map((v, i) => {
    const blended = v * 0.4 + t[i] * 0.6;
    return Math.min(2.5, Math.max(0.2, blended / ATLAS_MEAN[i]));
  });
}

/** A persisted `grass` bag → createFlora options. New-style bags pass
 *  through; legacy makeGrass bags are translated. The log is never
 *  rewritten — old worlds replay forever through this mapping. */
export function mapGrassArgs(a) {
  if (!isLegacyArgs(a)) return { species: 'grass', ...a };
  const out = {
    species: 'grass',
    width: a.width, depth: a.depth, size: a.size, center: a.center, seed: a.seed,
    height: a.bladeHeight ?? 0.42,
    // legacy density knobs vs their own old defaults (spacing 0.26, perCell 4)
    density: Math.min(2.2, Math.max(0.25,
      ((0.26 / (a.spacing ?? 0.26)) ** 2) * ((a.perCell ?? 4) / 4))),
    wind: Math.min(2, Math.max(0, (a.wind ?? 0.24) / 0.24)),
  };
  if (a.color !== undefined) out.color = hexToMultiplier(a.color, a.colorTip);
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

// The `grass` verb is a world singleton, but a real biome is several strokes
// (the engine's field-approved Mojave recipe is galleta + three shrubs at
// de-centred organic stands + yucca). `preset` bags compose those strokes
// client-side under ONE field object, so the verb model stays untouched.
export function presetStrokes(args) {
  const W = args.width ?? args.size ?? 80, D = args.depth ?? args.size ?? 70;
  const [cx, cz] = args.center ?? [0, 0];
  const seed = args.seed ?? 7;
  const sc = (f) => Math.round(f * Math.min(W, D));
  // the caller's density is a FACTOR over each stroke's authored fullness —
  // a preset that ignored it left the sparse/lush dial doing nothing at all
  // on the composed biomes, since every stroke carried a hardcoded density
  const k = args.density ?? 1;
  if (args.preset === 'mojave') {
    return [
      { species: 'galleta_dry', width: W, depth: D, center: [cx, cz], seed, density: 1.3 * k },
      { species: 'blackbrush', width: W - 2, depth: D - 2, center: [cx + sc(0.08), cz - sc(0.05)], seed: seed + 2, density: 0.85 * k, footprint: 'organic' },
      { species: 'blackbrush', width: W - 2, depth: D - 2, center: [cx - sc(0.09), cz + sc(0.08)], seed: seed + 52, variant: 1, density: 0.85 * k, footprint: 'organic' },
      { species: 'creosote', width: W, depth: D, center: [cx - sc(0.06), cz - sc(0.08)], seed: seed + 5, density: 0.85 * k, footprint: 'organic' },
      { species: 'creosote', width: W, depth: D, center: [cx + sc(0.1), cz + sc(0.06)], seed: seed + 85, variant: 1, density: 0.85 * k, footprint: 'organic' },
      { species: 'sagebrush', width: W - 2, depth: D - 2, center: [cx + sc(0.05), cz + sc(0.1)], seed: seed + 9, density: 0.85 * k, footprint: 'organic' },
      { species: 'yucca', width: W, depth: D, center: [cx, cz], seed: seed + 18, density: 0.7 * k },
    ];
  }
  if (args.species === 'corn' && !args.rows?.stride) {
    // Honest agriculture, and VARIETY: one stroke = one plant variant cloned
    // field-wide (a single rng roll decides every stalk's ears). The engine's
    // field-approved recipe interleaves seeds by row stride — four husked
    // variants plus every 5th row rolled heavily open.
    const rows = { spacing: 0.9, plant: 0.26, ...(args.rows ?? {}) };
    const corn = args.corn ?? {};
    return [
      ...[0, 1, 3, 4].map((phase, i) => ({
        ...args, seed: seed + 31 + i * 17,
        rows: { ...rows, stride: 5, phase },
        corn: { peelChance: 0.12, ...corn },
      })),
      { ...args, seed: seed + 91, rows: { ...rows, stride: 5, phase: 2 },
        corn: { ...corn, peel: true, peelChance: 0.6 } },
    ];
  }
  if (args.species === 'sunflower' && !args.rows?.stride) {
    // Same interleave trick, three plant variants through one grid. The
    // shared `heading` is the signature look — a sunflower field faces one
    // way together — and it must be identical across the strokes or the
    // variants argue about where the sun is.
    const rows = { spacing: 0.85, plant: 0.5, ...(args.rows ?? {}) };
    const heading = args.heading ?? -0.6;
    return [0, 1, 2].map((phase, i) => ({
      ...args, heading, seed: seed + 23 + i * 19,
      rows: { ...rows, stride: 3, phase },
    }));
  }
  return [args];
}
