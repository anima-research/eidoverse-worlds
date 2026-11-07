// Pure (no three, no DOM) so tools/ghost-mesh-size-test.ts can run every shape × scale through the real authority.
import { COMPONENTS } from '../../shared/protocol/componentspec.js';
export const MESH_DEFAULT = { box: [1, 1, 1], sphere: [1, 1, 1], cylinder: [1, 1, 1], plane: [2, 0.05, 2], capsule: [0.5, 1.5, 0.5] };
const { min, max } = COMPONENTS.mesh.ranges.size;
// each axis is held inside the door's range: a plane's 0.05 thickness shrunk below 1× was refused at mesh.size's min
export const ghostMeshSize = (shape, scale) => (MESH_DEFAULT[shape] ?? [1, 1, 1]).map((v) => Math.min(max, Math.max(min, +(v * scale).toFixed(3))));
