### browserlab receipt — chrome-151

`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36`

| | |
|---|---|
| backend | `WebGPUBackend` (isWebGPURenderer true, navigator.gpu true) |
| adapter | vendor `nvidia` · arch `turing` · device `` · fallback _not exposed_ |
| pixel ratio | device 1 · renderer 1 · render scale auto |
| buffer | 1280×800 (viewport 1280×800) |
| cadence | 60Hz-ish (fastest arm p50 16.67ms) |
| cores / memory | 16 / 32GB |
| quality tier | casters 6 · light slots 8 · emitters auto · grass 1 · detail shed false |
| scene | 0 people · 5 skinned · 6186 draws · 2,725,031 tris · 38 textures · 85,910 blades |
| camera | pos [-0.62, 2.771, -3.987] yaw 3.1416 pitch 0.32 fov 55 |

**25s per arm, fixed camera, UI hidden.** Frame time in ms — lower is better.

| foliage | p50 | p95 | p99 | max | mean | fps (p50) | >40ms | >100ms | blades drawn |
|---|---|---|---|---|---|---|---|---|---|
| full | 16.67 | 16.69 | 16.75 | 33.31 | 16.68 | 60.01 | 0 | 0 | 85,910 |
| static | 16.67 | 16.68 | 16.69 | 16.78 | 16.66 | 60.01 | 0 | 0 | 85,910 |
| off | 16.67 | 16.68 | 16.7 | 16.8 | 16.66 | 60.01 | 0 | 0 | 0 |

Foliage costs **0ms** at the median and **0.01ms** at p95 from this camera.

**Console during the run:** _clean_
**Context loss:** _none_

> Comparability: this receipt is only a browser delta against another
> receipt with the same camera pose, the same people count, and the same
> world. Check those three lines before reading the frame times.
