
## browserlab comparison — chrome-151  vs  firefox-154

| gate | values | why it matters |
|---|---|---|
| ✓ camera pose | `[[-0.62,2.771,-3.987],3.1416,0.32,55]` · `[[-0.62,2.771,-3.987],3.1416,0.32,55]` |  |
| ✓ drawing buffer | `[1280,800]` · `[1280,800]` |  |
| ✓ scene digest | `"2e324e3b"` · `"2e324e3b"` |  |
| ✓ world log seq | `26` · `26` |  |
| ✓ people present | `0` · `0` |  |
| ✓ triangles | `2725031` · `2725031` |  |
| ✓ blades planted | `85910` · `85910` |  |
| ✓ seconds per arm | `25` · `25` |  |
| ✓ code under test | `"2947d074a629935f"` · `"2947d074a629935f"` |  |

### environment

| | chrome-151 | firefox-154 |
|---|---|---|
| backend | WebGPUBackend | WebGPUBackend |
| adapter vendor | nvidia | _not exposed_ |
| adapter arch | turing | _not exposed_ |
| navigator.gpu | true | true |
| devicePixelRatio | 1 | 1 |
| render scale | 1 | 1 |
| shadow casters | 6 | 12 |
| cadence | 60Hz-ish (fastest arm p50 16.67ms) | 60Hz-ish (fastest arm p50 16.66ms) |
| cores / memory | 16 / 32GB | 16 / ? |
| draws / frame | 110 (per-frame) | 110 (per-frame) |
| code under test | 08276ca · 2947d074a629935f | 08276ca · 2947d074a629935f |

### frame time by arm (ms)

| arm | metric | chrome-151 | firefox-154 | delta |
|---|---|---|---|---|
| full | p50 | 16.67 | 16.66 | -0.01 |
| full | p95 | 16.69 | 16.68 | -0.01 |
| full | p99 | 16.74 | 16.68 | -0.06 |
| full | max | 33.31 | 33.32 | +0.01 |
| full | over40ms | 0 | 0 | 0 |
| static | p50 | 16.67 | 16.66 | -0.01 |
| static | p95 | 16.68 | 16.68 | 0 |
| static | p99 | 16.69 | 16.68 | -0.01 |
| static | max | 16.76 | 16.68 | -0.08 |
| static | over40ms | 0 | 0 | 0 |
| off | p50 | 16.67 | 16.66 | -0.01 |
| off | p95 | 16.68 | 16.68 | 0 |
| off | p99 | 16.71 | 16.68 | -0.03 |
| off | max | 16.81 | 16.68 | -0.13 |
| off | over40ms | 0 | 0 | 0 |

chrome-151 — foliage cost: **0ms** p50, **0.01ms** p95
  static arm scope: 3 meadow-owned hooks released, 1 wind amplitudes zeroed, 0 non-meadow hooks (sky, weather, emitters) left running.

firefox-154 — foliage cost: **0ms** p50, **0ms** p95
  static arm scope: 3 meadow-owned hooks released, 1 wind amplitudes zeroed, 0 non-meadow hooks (sky, weather, emitters) left running.

### verdict

Gates pass: the runs are comparable.

**Both are vsync-locked at ~16.66ms (60Hz) in every arm.** That is a FLOOR result, not a tie: this scene leaves both browsers enough headroom to hit the refresh interval, so the comparison can only report that neither one failed. To discriminate, run it where the reports came from — more skinned bodies, more triangles, a denser meadow — or against a display with a higher refresh rate.

**Capability reporting gap:** firefox-154 exposed no adapter vendor/architecture. #42 asks that "browser/adapter capability and selected quality tier are inspectable in the HUD/debug receipt" — on those browsers the adapter half of that is currently unavailable to any receipt, ours included.

_Scope: this comparison is valid for FROZEN SEEDED SCENES — a world whose entities and population do not change between the two runs, which the scene-digest and world-seq gates enforce. It is NOT yet validated for a live populated commons, where bodies move between sequential browser runs by definition; there the two runs would have to be simultaneous, or the scene frozen first._
