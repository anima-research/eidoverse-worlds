// Terrain material layers are an array only; a persisted numeric `layers` (old or hand-authored) reads as none,
// so a malformed decoration never stops the ground realizing. Noise complexity is `octaves`, not this field.
export function materialLayerSpecs(value) {
  return Array.isArray(value) ? value : [];
}
