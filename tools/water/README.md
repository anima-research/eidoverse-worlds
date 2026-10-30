# Water environments

The Three.js client consumes ordinary component data. There are no world-name
checks, scene coordinates, model paths, or submarine classes in the renderer.
The reference scene is authored separately: `world-data/water/manifest.json` holds
upstream's records for it (main's `asset`/`spawn`/`comp`), and `requests.js` turns
them into this protocol's `create`/`set` requests through the old-world translator's
own mapping (`tools/protocol/import-v1/translate-v1.js`, `VOLUMES`).

## Components

All dimensions are metres, Y-up. spec/PROTOCOL.md §4 is the contract; shared/zone.js
is the one reader (`mediumOf` → `{medium, level, flow, body, priority}`).

| Component | Parameters and behavior |
| --- | --- |
| `zone` | `{shape, size, priority?, blend?, weight?, global?}` on a thing, centred on its origin. Water reads a `box` zone for now (a sphere, capsule or cylinder under water or water-exclusion is refused). Where zones overlap the higher `priority` decides; a tie goes to the later id. |
| `water` | On a thing with a sibling zone: a body filling it (`level` absent = the zone's top; `waves`, `attenuationColor` + `attenuationDistance`, `scatterColor`, `flow` [x, y, z], `density`, `drag`). On `@world`: the world's level (lowest priority of all). A body stays horizontal and axis-aligned; its thing's rotation turns only its centre. |
| `water-exclusion` | `{bodies?}` on a thing with a sibling zone: a dry pocket. It keeps out every body at or below its zone's priority (only `bodies` when named), `@world`'s level included. It follows its thing (and any carrier) through the parent chain, so a moving vessel carries its dry interior. |

Upstream's components map as follows (translate-v1 `VOLUMES`): `water {center, size,
absorption, scatter, speed?, waves}` → a body (on its own thing when that has no model
or light and the box is centred on it, else a child at the centre; σ → `attenuationColor`
e^−σ over 1 m; `speed` rides in `imported:water`); `air {boxes}` → one child per box,
`zone {box, size, priority: 1}` + `water-exclusion {}`, its centre and `q` its transform.
Each `traversal` route is a child with `climb {points, reach, speed}` and its name as
`label`; `collision {enabled: false}` is `collider {enabled: false}`; `environment` goes
to `@world.spawn`, `@world.bounds`, `@world.sky.gradient`, `@world.terrain {kind: 'flat', height}` (the floor), a
directional sun thing and a dust `particles` child, and what has no home (the sky's
`ambient`, the particles' clamped count and range) rides `imported:environment`, listed
under `unmapped`. The `vehicle` is `drive` on the submarine and a helm child
(`station {action: 'drive', input: {move: 'drive'}, exit}`); its `minY` (-230) and `maxY` (-4)
are two hidden walls in the submarine's own collision layer, which only its collider's
`mask` scans, so it still can't surface while another vehicle passes them; `probes` ride
`imported:vehicle`, listed under `unmapped`. Nothing is deferred.

The renderer supports four water bodies, sixteen pockets, and eight waves per body.
Excess bodies and pockets produce a diagnostic and are inactive (the highest-priority
bodies are kept). The fog reads each pocket's mask of the bodies it clears
(zone.js `fogSlots`), so the GPU keeps the same law as `mediumOf`; one corner differs:
a pocket naming only a higher body also stops the fog of a lower one there.

The optical pass measures the camera-to-fragment distance through water, subtracts
dry intervals, and applies RGB Beer–Lambert extinction plus scattering. Looking
through a habitat window therefore retains fog outside while leaving its interior
dry. Particles are suppressed where a pocket clears their body. Water removal/world
reset restores the prior fog, lighting, and demo floor. `EW.water()` exposes active
volume counts. Inside a pocket below `@world`'s level the controller does not wade or
dive (watervolumes `levelAt`).

## Movement

- In water: WASD follows the camera, Space rises, C or Ctrl dives. The controller
  applies drag, gentle buoyancy, surface floating, and collision sweeps. Shallow
  water and dry floors return to walking. Touch controls include a dive button.
- At a moonpool, hatch, or platform ladder, E climbs up or down; a proximity hint
  identifies the route. Paths are authored data and follow moving carriers.
- A nearby authored helm is entered with E. W/S gives thrust, A/D turns, Space/C
  changes depth, and E exits. Existing leases arbitrate exclusive control.
- Presence carries optional full orientation and locomotion metadata. Remote
  divers interpolate orientation; VRM avatars receive a procedural swimming pose.
- Mixed land/water worlds use the same controller. Author finite water regions,
  terrain collision, and dry boxes only where needed.

## Reference scene and exports

Source: Unreal `/Game/Underwater/SpectralPrototype/L_SpectralOcean_Prototype` in
`Test1`. Five content-addressed GLBs contain terrain, habitat, submarine, platform,
and scenery. `world-data/water/manifest.json` (upstream's) has twenty records and
fifteen dry volumes; they become twenty-one `create`s (five models, one water body,
fifteen pockets) and five `@world` asset entries. `prepare.ts` writes a bundle whose
manifest already carries those requests. Repeated ecology meshes use GPU instancing.
Binaries are provided in the companion bundle, not embedded in client source or
committed here.

With the scene open, run this in Unreal's Python console (set `EIDO_EXPORT_DIR`
for a custom output; default is the project's `Saved/EidoverseExport`):

```python
exec(open('/absolute/path/eidoverse-worlds/tools/water/export-unreal.py').read())
```

The reference submarine's hidden pawn hierarchy did not export its geometry.
Export its five replacement meshes from the original Blender source. The exporter
also restores the four Blueprint floor slabs from `world-data/water/vessels.json`
and substitutes transparent glass for Blender's opaque placeholder material:

```sh
blender --background --python tools/water/export-submarine-blender.py -- /path/PressureVessels.blend /path/export/submarine-source.glb
bun tools/water/prepare.ts /path/export /path/bundle --right-handed
bun tools/water/preview.ts /path/bundle 19347
```

The preparation script contains this world's authoring choices, such as group
origins, optics, helm locations, and spawn. Adjust these here or author a different
manifest; general rendering belongs in the client. The preview script creates
isolated temporary world, optimized-asset, and relay directories and binds loopback.

`import.ts --dry` prints the requests (one `batch` of `create`/`set`, every new thing a
`$<id>` placeholder the authority mints), what it maps and what it holds back; it needs
no server. Preflight is read-only. `--apply` uploads the bundle's GLBs, swaps each model
path for the library path it got, and sends the batch; credentials are read from
`EIDO_TOKEN` and are never printed:

```sh
bun tools/water/import.ts /path/bundle/manifest.json --dry
bun tools/water/import.ts /path/bundle/manifest.json https://eidoverse.animalabs.ai water
# Once the bundle, coordinate choice, and deployment are approved:
bun tools/water/import.ts /path/bundle/manifest.json https://eidoverse.animalabs.ai water --apply
```

The importer verifies SHA-256 hashes of the files present. The batch is one request:
taken whole or refused whole, so a rerun into a world that already holds the scene
makes a second copy (inspect the world first). Deploy the updated static client as
part of rollout. No production import, deployment, restart, or native-source
modification was performed during this work.

## Coordinate decision

The existing native bridge maps UE positions to `(UE.Y, UE.Z, UE.X) / 100`.
A bundle in this frame matches existing presence positions but mirrors the scene's
handedness, including lettering. The default manifest preserves that compatibility.

`prepare.ts ... --right-handed` instead maps to `(-UE.Y, UE.Z, UE.X) / 100`.
`native-coordinate-fix.patch` is a matching, **unapplied** native bridge patch,
including inverse rotation and yaw fallback conversion. It passes `git apply
--check`, but has not been compiled. Apply the corrected bundle and bridge together;
existing saved positions/orientations need conversion. The corrected bundle is
for preview until this coordinated change is chosen. Do not mix the two frames.

## Fidelity and current limits

This is the exported scene with a reusable web water implementation, not an exact
port of Unreal's renderer. Baked/glTF materials differ from Unreal's procedural
materials. The web surface uses directional swells rather than the native spectral
FFT; fog and particles clip against the mean surface. It does not include native
spectral LUTs, volumetric caustics, dynamic fauna/boids, or the native vehicle's
full hydrodynamics. Multi-water scattering is a distance-weighted approximation.
Wave time wraps hourly to retain GPU precision.

A glTF node with `extras: {collision:false}` remains visible but is excluded
from exact collision (including its descendants). This keeps moonpool water
planes permeable while preserving their appearance.

The scenery group is decorative and noncolliding; terrain, habitat, platform, and
submarine retain mesh collision, including instanced floors. Vehicle movement uses
yaw steering and translational hull probes, not rotational swept-volume collision.
Passenger sockets work through the existing mount system; freely walking occupants
are not carried as a vessel accelerates. The Unreal client currently exchanges
presence; importing these entities does not add native fold/vehicle replication.

## Validation

Run from the repo root with Bun. In the gate: `zone-water-check`, `water-vectors`,
`water-import` (this manifest through `import.ts --dry`, a real authority, and `mediumOf`
against main's `mediumAt`). `fog-mask-check.ts` runs the fog in headless Chromium on
WebGL. The rest require Chrome with WebGPU and a preview (`WATER_PREVIEW_URL`); the
regression check also needs the scene imported (`--apply`):

```sh
bun tools/protocol/zone-water-check.ts
bun tools/water/import-golden-check.ts
bun tools/water/fog-mask-check.ts
bun tools/water/math-test.ts
bun tools/foldfix-test.ts
bun tools/models-field-test.ts
bun tools/underwater-presence-test.ts
UNDERWATER_TEST_PORT=19348 bun tools/underwater-wire-test.ts
bun tools/water/gpu-test.ts
bun tools/water/browser-check.ts
bun tools/water/controller-check.ts
bun tools/water/regression-check.ts
```

Set `WATER_PREVIEW_URL` to an isolated preview when changing the port or world;
set `WATER_SCREENSHOT` to select the browser-check PNG output. Controller checks
use the legacy reference frame. GPU checks read back rendered pixels for wet,
dry, overlapping, and duplicate boxes and verify reset cleanup. Controller checks
exercise imported floor collision, moving dry volumes, ascent/descent, and vehicle
lease claim/state/final release. Wire checks cover 3D orientation, late join, and
movement staying off the persistent log. The regression check uses the corrected reference frame and the actual VRM:
walks along the submarine aisle, verifies all four floor slabs and glass alpha,
checks a ray through the moonpool, climbs each ladder both ways, moves a carrier
mid-climb, and samples hand positions over full swim/sculling cycles. It writes
`/tmp/water-fix-{inside,windshield,swim}.png` for visual review.

## Coordinates

Always prepare with `--right-handed`. Wire space is right-handed (`-UE.Y, UE.Z, UE.X`);
the earlier legacy mapping (`UE.Y, UE.Z, UE.X`) mirrored the whole scene, visible as
reversed lettering on the habitat, in every client. `world-data/water/manifest.json` is
the right-handed export. Renderers must honour mirrored glTF node transforms (the
wire-coordinate frame is one when composed with the exporter's own basis).
