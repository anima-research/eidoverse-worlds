// shared/v4/labmodels.js — the lab's hand-written models (the protocol lab's own table, kept for the tests and any
// world opened without the engine catalogue: server/v4/modelcatalogue.ts measures library GLBs instead). Models are
// local-space boxes with the origin at the base centre, front = +Z, with their support surfaces.
export const MODELS = {
  table:       { size: [1.2, 0.75, 0.8],  surfaces: [{ y: 0.75 }], label: "a wooden table" },
  chair:       { size: [0.5, 0.9, 0.5],   surfaces: [{ y: 0.45, inset: 0.05 }], sockets: { seat: { pos: [0, 0.45, 0], body: { pose: "sitchair" } } }, label: "a chair" },
  "table-lamp":{ size: [0.3, 0.5, 0.3],   surfaces: [], label: "a small table lamp" },
  "floor-lamp":{ size: [0.4, 1.7, 0.4], solids: [[[-0.2,0,-0.2],[0.2,0.05,0.2]], [[-0.03,0,-0.03],[0.03,1.45,0.03]], [[-0.2,1.45,-0.2],[0.2,1.7,0.2]]],   surfaces: [], label: "a standing lamp" },
  crate:       { size: [0.6, 0.6, 0.6],   surfaces: [{ y: 0.6 }], label: "a wooden crate" },
  wall:        { size: [4, 2.6, 0.15],    surfaces: [], label: "a plaster wall section" },
  door:        { size: [0.9, 2.1, 0.06],  surfaces: [], label: "a plank door (hinge on its left edge)" },
  shelf:       { size: [1.0, 1.8, 0.35], solids: [[[-0.5,0,-0.175],[-0.47,1.8,0.175]], [[0.47,0,-0.175],[0.5,1.8,0.175]], [[-0.5,0,-0.175],[0.5,1.8,-0.155]], [[-0.47,0,-0.155],[0.47,0.03,0.175]], [[-0.47,0.37,-0.155],[0.47,0.4,0.175]], [[-0.47,0.77,-0.155],[0.47,0.8,0.175]], [[-0.47,1.17,-0.155],[0.47,1.2,0.175]], [[-0.47,1.57,-0.155],[0.47,1.6,0.175]], [[-0.47,1.77,-0.155],[0.47,1.8,0.175]]],  surfaces: [{ y: 0.4, inset: 0.03 }, { y: 0.8, inset: 0.03 }, { y: 1.2, inset: 0.03 }, { y: 1.6, inset: 0.03 }], label: "a bookshelf with four shelves" },
  book:        { size: [0.04, 0.22, 0.15], surfaces: [], label: "a book (spine faces +Z)" },
  "swing-frame": { size: [2.0, 2.2, 1.2], solids: [[[-1,0,-0.6],[-0.9,2.2,0.6]], [[0.9,0,-0.6],[1,2.2,0.6]], [[-1,2.1,-0.06],[1,2.2,0.06]]], surfaces: [], label: "an A-frame for a swing" },
  "swing-seat":  { size: [0.6, 0.05, 0.3], surfaces: [{ y: 0.05 }], sockets: { seat: { pos: [0, 0.05, 0], body: { action: "sit", pose: "sit" } } }, label: "a plank swing seat on ropes" },
  bed:         { size: [1.0, 0.5, 2.0],   surfaces: [{ y: 0.5 }], label: "a single bed" },
  rug:         { size: [2.0, 0.01, 1.4],  surfaces: [{ y: 0.01 }], label: "a woven rug" },
  ball:        { size: [0.22, 0.22, 0.22], surfaces: [], label: "a rubber ball" },
  bell:        { size: [0.25, 0.3, 0.25], surfaces: [], label: "a brass hand bell" },
};
