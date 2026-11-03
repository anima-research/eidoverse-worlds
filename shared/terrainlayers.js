// Terrain material-layer compatibility. Persisted worlds may carry an old or
// hand-authored numeric `layers` field; material layers are an ARRAY only.
// One malformed optional decoration must never prevent the ground itself from
// realizing. Noise complexity remains `octaves`, not this field.
export function materialLayerSpecs(value) {
  return Array.isArray(value) ? value : [];
}
