// sky_bands — where the baked sky's strips are cut (sky_baked.js), kept free of imports so tools/sky-bands-test.mjs
// can load it under node.

/** Band edges in v (0..1) for re-marching a width x height equirect in strips of equal COST (see attachBakedDome's
 *  comment: rows are weighted by an inverse-elevation march-chord estimate). Shared by the cadence and the boot bake. */
export function bandCuts(width, height, cloudPasses, passTexelBudget) {
  const ROWS = Math.max(1, height | 0);   // weight the TEXEL rows: a band can't be thinner than one, and 256 coarse rows
                                          // under 168 bands left 79 empty and horizon bands ~6× the rest
  const bands = Math.min(ROWS, Math.max(1, Math.ceil((width * height * cloudPasses) / passTexelBudget)));
  const w = [];
  let wSum = 0;
  for (let r = 0; r < ROWS; r++) {
    const v = (r + 0.5) / ROWS;
    const lat = (0.5 - v) * Math.PI;      // the bake's uv→dir convention
    // chord ∝ 1/max(|sin lat|, eps), clamped like the march's fadeDist is;
    // below-horizon rows never march clouds — nearly free
    const chord = lat <= 0 ? 0.05 : Math.min(1 / Math.max(Math.sin(lat), 0.03), 30);
    w.push(0.05 + chord);                 // small floor: bg gradient is never free
    wSum += 0.05 + chord;
  }
  const cuts = [0];                        // band edges in v, equal weight per band
  let acc = 0;
  let nextCut = wSum / bands;
  for (let r = 0; r < ROWS; r++) {
    acc += w[r];
    if (acc >= nextCut - 1e-9 && r + 1 < ROWS) {
      cuts.push((r + 1) / ROWS);           // one cut per row at most: a row heavier than a band is its own band
      while (acc >= nextCut - 1e-9) nextCut += wSum / bands;
    }
  }
  cuts.push(1);
  return cuts;
}
