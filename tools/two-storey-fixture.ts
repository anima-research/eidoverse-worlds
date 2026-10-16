// two-storey-fixture — a small two-storey building as a GLB, for tests of
// bodies that stand, climb and route (agent-mesh-collision-test, navgrid-test).
//
// Model frame, Y up, door on +Z. Ground floor top 0.30 (a raised floor). A
// straight stair of 15 solid treads (rise 0.1875, going 0.25) climbs the east
// side toward -Z from its foot at z = STAIR_FOOT onto an upper floor at 3.30
// that begins where the last tread ends — a landing that overhangs the top
// treads puts its edge in a climbing body's hip band, and a person in a
// browser is held on the stair by it — with a metre of landing before the
// back wall to turn on. The well is open above the stair and railed on its
// west edge. Footprint x, z in [-3, 3].
import { Document, NodeIO } from "@gltf-transform/core";
import { KHRDracoMeshCompression, ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";

export const FLOOR = 0.3, UPPER = 3.3, RISE = 0.1875, GOING = 0.25, STAIR_FOOT = 2.0;
/** The fixture's own description of itself, as a modelling tool would write it. */
export const building = {
  kind: "building", name: "the tower",
  rooms: [
    { id: "hall", name: "the hall", min: [-2.8, FLOOR, -2.8], max: [2.8, 3.1, 2.8] },
    { id: "upstairs", name: "the upper room", min: [-2.8, UPPER, -2.8], max: [1.55, 6.3, 2.8] },
  ],
  portals: [{ id: "front_door", center: [0, FLOOR, 2.9] }],
  arrivals: [{ id: "outside", pos: [0, 0, 5] }],
};
const STAIR_TOP = STAIR_FOOT - 15 * GOING;                   // -1.75
export type Box = [number, number, number, number, number, number];   // minX minY minZ maxX maxY maxZ
export const boxes: Box[] = [
  [-3, 0, -3, 3, FLOOR, 3],                                   // raised ground floor
  [-3, FLOOR, -3, -2.8, 6.3, 3], [2.8, FLOOR, -3, 3, 6.3, 3],  // west, east walls
  [-3, FLOOR, -3, 3, 6.3, -2.8],                              // back wall
  [-3, FLOOR, 2.8, -0.6, 6.3, 3], [0.6, FLOOR, 2.8, 3, 6.3, 3], [-0.6, 2.4, 2.8, 0.6, 6.3, 3], // front, door gap
  [-2.8, 3.1, -2.8, 1.6, UPPER, 2.8],                         // upper floor west of the well
  [1.6, 3.1, -2.8, 2.8, UPPER, STAIR_TOP],                    // ...and the landing the stair arrives on
  [1.55, UPPER, STAIR_TOP, 1.6, UPPER + 1.0, STAIR_FOOT],     // railing along the well
];
for (let i = 1; i <= 15; i++) boxes.push([1.6, FLOOR, STAIR_FOOT - i * GOING, 2.8, FLOOR + i * RISE, STAIR_FOOT - (i - 1) * GOING]);
export function boxMesh(list: Box[]) {
  const pos: number[] = [], idx: number[] = [];
  for (const [x0, y0, z0, x1, y1, z1] of list) {
    const b = pos.length / 3;
    for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) pos.push(x, y, z);
    // corners: index = xi*4 + yi*2 + zi
    for (const f of [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]])
      idx.push(b + f[0], b + f[1], b + f[2], b + f[0], b + f[2], b + f[3]);
  }
  return { pos: new Float32Array(pos), idx: new Uint32Array(idx) };
}

/** A GLB whose one mesh sits under a parent node lifted `lift` (and the mesh
 *  itself shifted `shift` along x — both default 0), with an orphan mesh node
 *  outside the scene. `building`: a description the model carries of itself
 *  (rooms, portals, seats, arrivals), stored in the root node's extras as a
 *  JSON string — the way Blender exports a custom property — where
 *  mcpl/places.ts reads named places from. */
export async function buildGlb(list: Box[], { draco = false, lift = 0, shift = 0, building = null as unknown } = {}) {
  const doc = new Document();
  const buf = doc.createBuffer();
  const make = (l: Box[]) => {
    const { pos, idx } = boxMesh(l);
    return doc.createMesh().addPrimitive(doc.createPrimitive()
      .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(pos).setBuffer(buf))
      .setIndices(doc.createAccessor().setType("SCALAR").setArray(idx).setBuffer(buf)));
  };
  const parent = doc.createNode("lift").setTranslation([0, lift, 0]);
  if (building) parent.setExtras({ building: JSON.stringify(building) });
  parent.addChild(doc.createNode("building").setMesh(make(list)).setTranslation([shift, 0, 0]));
  doc.createScene("s").addChild(parent);
  doc.createNode("orphan").setMesh(make([[50, 0, 50, 51, 1, 51]]));
  if (draco) doc.createExtension(KHRDracoMeshCompression).setRequired(true)
    .setEncoderOptions({ method: KHRDracoMeshCompression.EncoderMethod.SEQUENTIAL });
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    "draco3d.decoder": await draco3d.createDecoderModule(), "draco3d.encoder": await draco3d.createEncoderModule() });
  return io.writeBinary(doc);
}
