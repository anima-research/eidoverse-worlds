// ghost-mesh-size-test — every Create ▸ mesh the editor can hold, at every size the ghost keys reach, asks the door for a
// size the door takes. A plane shrunk once (,) sent y = 0.05/1.1 and was refused at mesh.size's min (debt survey 2, §2.3).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/ghost-mesh-size-test.ts
process.env.WORLD_TOKEN = "";
import { ghostMeshSize } from "../client/lib/meshghost.js";
import { COMPONENTS } from "../shared/protocol/componentspec.js";
import * as OP from "../shared/protocol/requests.js";
import { scratchWorld } from "./protocol/scratchworld.ts";
import { mkCheck } from "./harness.ts";
const { check, tally } = mkCheck();

const SCALES = [0.1, 1 / 1.1 / 1.1, 1 / 1.1, 1, 12];
const W = scratchWorld("ghostmesh");
let n = 0;
for (const shape of COMPONENTS.mesh.enums.shape) for (const scale of SCALES) {
  const size = ghostMeshSize(shape, scale);
  const r: any = W.send(OP.create(`m${++n}`, { transform: { pos: [n * 3, 0, 0] }, components: { mesh: { shape, size } } }));
  check(`${shape} at ×${+scale.toFixed(4)}: the door takes size ${JSON.stringify(size)}`, !!r?.ok, r?.ok ? "" : r?.refused?.reason);
}

console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
