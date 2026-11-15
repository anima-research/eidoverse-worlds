# Test fixtures

Inputs the gate's suites read. `v1-worlds/` are old-protocol worlds (its README says which). The rest:

- `ammodoll-rig.json` contains node transforms, parentage and humanoid bone
  mapping extracted from the source VRM named and SHA-256-bound inside it.
  Meshes and textures are omitted. Reproduce the extraction with
  `bun test/fixtures/extract-doll-fixture.ts path/to/mythos-wings.vrm`.
  `bun test/client/ammodoll-test.ts` uses this committed skeleton and a copy with
  digit bones removed, including every wing/hair matrix assertion. Add
  `--fleet` to also test installed local avatars; that optional extension
  reports a missing library before running it.
- `sim-ground-assets.json` binds the ground-smoke offsets and bounds to
  measured source and KTX2 response hashes. The smoke hashes the response
  consumed by the browser, including negotiated/overlay variants. Before
  adding another hash, run `bun tools/assets/ground-asset-measure.ts path/to/file.glb`
  and verify its measured geometry fits this fixture. Its source and KTX2
  variants both have 6,040 triangles and the same millimetre-rounded bounds
  and visual-center offset.
- `claude_suit-rig.json`: the same extraction for that avatar (`bun test/fixtures/rig-fixture.mjs claude_suit.vrm`).
- `mythos-wings-rig.json`: a different shape (hash, size, bone names), read by `test/client/flight-test.ts`; only
  `bun test/fixtures/flight-fixture.ts` writes it.
