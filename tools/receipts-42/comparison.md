
## browserlab comparison — chrome-151  vs  firefox-154

| gate | values | why it matters |
|---|---|---|
| ✓ camera pose | `[[-0.62,2.771,-3.987],3.1416,0.32,55]` · `[[-0.62,2.771,-3.987],3.1416,0.32,55]` |  |
| ✓ drawing buffer | `[1280,800]` · `[1280,800]` |  |
| ✓ people present | `0` · `0` |  |
| ✓ triangles | `2725031` · `2725031` |  |
| ✓ blades planted | `85910` · `85910` |  |
| ✓ seconds per arm | `25` · `25` |  |

### environment

| | chrome-151 | firefox-154 |
|---|---|---|
| backend | WebGPUBackend | WebGPUBackend |
| adapter vendor | nvidia | _not exposed_ |
| adapter arch | turing | _not exposed_ |
| navigator.gpu | true | true |
| devicePixelRatio | 1 | 1 |
| render scale | auto | auto |
| shadow casters | 6 | 6 |
| cadence | 60Hz-ish (fastest arm p50 16.67ms) | 60Hz-ish (fastest arm p50 16.66ms) |
| cores / memory | 16 / 32GB | 16 / ? |

### frame time by arm (ms)

| arm | metric | chrome-151 | firefox-154 | delta |
|---|---|---|---|---|
| full | p50 | 16.67 | 16.66 | -0.01 |
| full | p95 | 16.69 | 16.68 | -0.01 |
| full | p99 | 16.75 | 16.68 | -0.07 |
| full | max | 33.31 | 33.34 | +0.03 |
| full | over40ms | 0 | 0 | 0 |
| static | p50 | 16.67 | 16.66 | -0.01 |
| static | p95 | 16.68 | 16.68 | 0 |
| static | p99 | 16.69 | 16.68 | -0.01 |
| static | max | 16.78 | 16.68 | -0.1 |
| static | over40ms | 0 | 0 | 0 |
| off | p50 | 16.67 | 16.66 | -0.01 |
| off | p95 | 16.68 | 16.68 | 0 |
| off | p99 | 16.7 | 16.68 | -0.02 |
| off | max | 16.8 | 42.9 | +26.1 |
| off | over40ms | 0 | 2 | +2 |

### verdict

Gates pass: the runs are comparable.

**Both are vsync-locked at ~16.66ms (60Hz) in every arm.** That is a FLOOR result, not a tie: this scene leaves both browsers enough headroom to hit the refresh interval, so the comparison can only report that neither one failed. To discriminate, run it where the reports came from — more skinned bodies, more triangles, a denser meadow — or against a display with a higher refresh rate.

**Capability reporting gap:** firefox-154 exposed no adapter vendor/architecture. #42 asks that "browser/adapter capability and selected quality tier are inspectable in the HUD/debug receipt" — on those browsers the adapter half of that is currently unavailable to any receipt, ours included.

