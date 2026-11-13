# Sky quality tiers and the VR rules

Design notes behind `client/lib/sky/sky.js`, `sky_baked.js` and `sky_swapchain.js`. The code comments say what; this says why.

## Tiers

- The volumetric cloud march is the most expensive thing the client draws (measured roughly 120 fps without it, 30 with,
  on the dev hardware). Its cost is dominated by `cloudPasses` (sky_system defaults to 8; Skye's `TIER=balanced` is 3).
- Every tier below `high` shows a **baked** sky: the march rendered once into the env-bake equirect, displayed on a
  static dome, re-baked on a cadence and crossfaded. Cost moves from per-frame to per-bake, which is why `medium` can
  afford the full 8-pass march at 4096x2048 (a 2048 bake was ~4x undersampled against the screen and read as mush).
  The trade is stillness between re-bakes.
- `high` is the live march: parallax, flying into clouds, continuous motion. Its program is a 1-2 MB shader whose first
  compile stalls the GPU process for seconds, and it marches every pixel every frame.
- `low`, `medium` and `high` construct the **same** sky system, so switching among them swaps what is shown instead of
  re-linking identical giant programs (three's WebGL backend never frees a GL program, so every rebuild also leaked).
- Cloud quality is a viewer preference, never world state: one person's GPU must not dictate everyone's sky.

## The VR cap

- In a headset on the WebGL backend, `high` falls back to `medium`. The live march per eye at headset resolution
  (5920x2960 on the reporting headset) ran at 12-13 fps, and each eye marched from its own origin with its own noise,
  so the eyes saw different skies. The baked panorama is stereo-correct and cheap.
- Revisit once VR rides WebGPU-XR: measure fps and eye agreement with live clouds and lift the cap if they hold.
- The cap's flip waits for the entry curtain, so its bake doesn't take the GPU before the headset's first frames.
- With a headset present, medium's bake program is prebuilt on the desktop (a 64x32 bake into a temporary target;
  a bake's shader doesn't depend on its size), so entry is a program-cache hit.

## No rebuild while presenting

A rebuild links the ~1.7 MB cloud graph and then runs a 4096x2048 boot bake. In one live session that blocked for
100 s and a single bake frame held the GPU 4.3 s, tripping the driver watchdog: context lost, session gone. A quality
flip or a sky-world switch made in the headset is held until exit; the world's own sky changes (time, weather, cloud
kind) are uniform writes plus the paced re-bake and still apply.

## World first, sky last

On a cold GPU cache the cloud dome's link took minutes on WebGL (125 s measured), and through the serial warm
conductor it starved every model pipeline behind it. So the real domes stay out of the scene under an interim
gradient in the hour's colours and compile only after the world near you has loaded.

## The clear-to-cloudy fence

The baked tier's graph cache keys on whether the preset is `clear`, and the cloud-carrying graph costs a ~1.5 MB WGSL
compile that stalls the whole GPU process 5-10 s cold, even async. On cloud-capable tiers `clear` is respelled as an
empty cumulus so the graph pins at the boot bake, inside the splash, and every later sky change is uniform writes.
