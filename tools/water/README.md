# Water environments

The Three.js client consumes ordinary component data. There are no world-name
checks, scene coordinates, model paths, or submarine classes in the renderer.
The reference scene is authored separately in `world-data/water/manifest.json`.
The shared fold and verb vocabulary are unchanged.

## Components

All dimensions are metres. Positions use Y-up. Component centres and dry-box
rotations are relative to their owning entity; environment spawn/bounds are world
coordinates. Remove a component by setting its data to null.

| Component | Parameters and behavior |
| --- | --- |
| `water` | `center:[x,y,z]`, `size:[x,y,z]`: finite, horizontal, axis-aligned water volume. `absorption:[r,g,b]` controls extinction per metre, `scatter:[r,g,b]` the linear fog colour, `speed` swimming speed. `waves:[{amplitude,wavelength,direction:[x,z],phase}]` drives the displaced surface and swimming boundary. |
| `air` | `boxes:[{center:[x,y,z],size:[x,y,z],q:[x,y,z,w]}]`: oriented dry interiors. Quaternion is optional. Boxes inherit the complete live entity transform, including mounts, so a moving vessel carries its dry interior. Overlaps are unioned rather than subtracted twice. |
| `environment` | Optional `floor`, `spawn:[x,y,z]`, `bounds:{min:[x,y,z],max:[x,y,z]}`, `sky:{horizon,zenith,sunColor,sunDirection,sunIntensity,ambient}`, and `particles:{count,range,size,color}`. An authored environment replaces the demo ground plane; imported exact collision supplies terrain and floors. |
| `vehicle` | Local `helm` and `exit` points, `speed`, `turnRate`, optional world `minY/maxY`, and local hull `probes`. Uses the existing lease protocol, streams movement, and commits the final resting pose on release. |
| `collision` | `{enabled:false}` opts decorative imported geometry out of collision. |
| `traversal` | `routes:[{name,path:[[x,y,z],...],radius,speed}]`: bidirectional E-to-climb routes. Paths follow the owning entity, including moving vessels. E during a climb lets go. |
| `sockets` | Existing passenger/mount system; no new socket vocabulary. |

The renderer supports four water volumes, sixteen dry boxes, and eight wave
components per volume. Excess volumes produce a diagnostic and are inactive.
When water volumes overlap, the later entity in sorted ID order takes priority.
Air always wins. Water bounds stay horizontal and axis-aligned; set wave directions
explicitly in world X/Z. Dry boxes may rotate freely.

The optical pass measures the camera-to-fragment distance through water, subtracts
dry intervals, and applies RGB Beer–Lambert extinction plus scattering. Looking
through a habitat window therefore retains fog outside while leaving its interior
dry. Particles are suppressed inside dry boxes. Water removal/world reset restores
the prior fog, lighting, and demo floor. `EW.water()` exposes active volume counts.

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
and scenery. The manifest has twenty ordinary asset/spawn/component verbs and
fifteen dry volumes. Repeated ecology meshes use GPU instancing. Binaries are
provided in the companion bundle, not embedded in client source or committed here.

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

Preflight is read-only. Import requires the existing upload/authoring rights;
credentials are read from `EIDO_TOKEN` and are never printed:

```sh
bun tools/water/import.ts /path/bundle/manifest.json https://eidoverse.animalabs.ai water
# Once the bundle, coordinate choice, and deployment are approved:
bun tools/water/import.ts /path/bundle/manifest.json https://eidoverse.animalabs.ai water --apply
```

The importer verifies SHA-256 hashes and component sizes, detects conflicting
entity IDs, honors upload/verb rate windows, and can resume a partial import.
An unchanged rerun adds no log entries. `--replace` explicitly permits overwriting
conflicting entities; inspect them first. Imports are sequential, not transactional.
Deploy the updated static client as part of rollout. No production import,
deployment, restart, or native-source modification was performed during this work.

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

Run from the repo root with Bun; browser checks require Chrome with WebGPU:

```sh
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
