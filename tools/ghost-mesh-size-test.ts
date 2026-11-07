// ghost-mesh-size-test — every Create ▸ mesh the editor can hold, at every size the ghost keys reach (the ×1.1 ladder whole, the ×1.01 ladder sampled and at its ends, to both clamps), asks the door for a
// size the door takes. A plane shrunk once (,) sent y = 0.05/1.1 and was refused at mesh.size's min (debt survey 2, §2.3).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/ghost-mesh-size-test.ts
process.env.WORLD_TOKEN = "";
import { ghostMeshSize } from "../client/lib/meshghost.js";
import { COMPONENTS } from "../shared/protocol/componentspec.js";
import * as OP from "../shared/requests.js";
import { scratchWorld } from "./protocol/scratchworld.ts";
import { mkCheck } from "./harness.ts";
const { check, tally } = mkCheck();

// every size the keys reach: , / . step ×1.1 (Shift ×1.01) from 1, clamped to [0.1, 12] (build.js ghostKey) — both ladders, both ways, to the clamps (bot #164)
const ladder = (k: number) => { const out = new Set<number>([1]); for (const dir of [k, 1 / k]) { let s = 1; for (let i = 0; i < 400; i++) { const n = Math.min(12, Math.max(0.1, s * dir)); if (n === s) break; s = n; out.add(s); } } return [...out]; };
// the fine ladder is ~480 steps: every 10th, plus the last 5 at each clamp (where the refusal lived)
const fine = ladder(1.01); const ends = (a: number[]) => { const o = [...a].sort((x, y) => x - y); return [...o.slice(0, 5), ...o.slice(-5)]; };
const SCALES = [...new Set([...ladder(1.1), ...fine.filter((_, i) => i % 10 === 0), ...ends(fine)])];
const W = scratchWorld("ghostmesh");
let n = 0;
for (const shape of COMPONENTS.mesh.enums.shape) for (const scale of SCALES) {
  const size = ghostMeshSize(shape, scale);
  const r: any = W.send(OP.create(`m${++n}`, { transform: { pos: [n * 3, 0, 0] }, components: { mesh: { shape, size } } }));
  check(`${shape} at ×${+scale.toFixed(4)}: the door takes size ${JSON.stringify(size)}`, !!r?.ok, r?.ok ? "" : r?.refused?.reason);
}

console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
