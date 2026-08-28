### browserlab receipt — chrome-151

`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36`

| | |
|---|---|
| backend | `WebGPUBackend` (isWebGPURenderer true, navigator.gpu true) |
| adapter | vendor `nvidia` · arch `turing` · device `` · fallback _not exposed_ |
| pixel ratio | device 1 · renderer 1 · render scale 1 |
| buffer | 1280×800 (viewport 1280×800) |
| cadence | 60Hz-ish (fastest arm p50 16.67ms) |
| cores / memory | 16 / 32GB |
| quality tier | casters 6 · light slots 8 · emitters auto · grass 1 · detail shed false |
| scene | 0 people · 5 skinned · 24 entities · 38 textures · 85,910 blades |
| scene digest | `2e324e3b` · world seq 26 |
| camera | pos [-0.62, 2.771, -3.987] yaw 3.1416 pitch 0.32 fov 55 |
| build | server `737525ceb2870c6635b1d1c682632e87c56be740` (dirty tree) · tree `2dca5e7881a5f388` (clean checkout (excluding tools/receipts-42)) |

**25s per arm, fixed camera, UI hidden.** Frame time in ms — lower is better.

| foliage | p50 | p95 | p99 | max | mean | fps (p50) | >40ms | >100ms | blades | draws/frame |
|---|---|---|---|---|---|---|---|---|---|---|
| full | 16.67 | 16.69 | 16.72 | 17.13 | 16.67 | 60.01 | 0 | 0 | 85,910 | 110 |
| static | 16.67 | 16.68 | 16.69 | 16.77 | 16.66 | 60.01 | 0 | 0 | 85,910 | 110 |
| off | 16.67 | 16.68 | 16.71 | 16.9 | 16.66 | 60.01 | 0 | 0 | 0 | 67 |

Foliage costs **0ms** at the median and **0.01ms** at p95 from this camera.

_Static arm scope: 3 meadow-owned hooks released and 1 wind amplitudes zeroed; 0 non-meadow hooks (sky, weather, entity emitters) left running — 0 at start._

**Console during the run:** _clean_
**Context loss:** _none_

> Comparability: this receipt is a browser delta only against another
> receipt whose scene digest, world seq, camera pose and buffer match.
> tools/browserlab-compare.mjs checks that before it prints one.
