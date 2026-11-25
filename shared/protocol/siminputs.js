// What the sim reads that isn't in the log. Everything else it reads is the entries' own (Covenant III: geometry enters as
// physics.shape); these are named by the log and fetched apart, so a client can hold the log before it holds them.
// One list: the replica waits on it (replica.js), and siminputs-check refuses a sim module that reads outside it.
import { shapeReady, shapeParams, requestGrid, groundArgs } from "../terrainshape.js";

export const SIM_INPUTS = {
  // a heightmap's grid: the authority reads its disk, a client fetches store/heightmaps/<hash>.json
  heightmap: {
    module: "shared/terrainshape.js",
    // read through the ground's args whatever the terrain is: shapeParams names the sculpted layer on this machine as it
    // goes (the tiles are in the log, so the state holds them), and what can still be missing is the grid
    missing: (st) => { const t = groundArgs(st?.entities?.["@world"]?.c); const shape = t && typeof t === "object" ? shapeParams(t) : null;
      return shape?.heightmap && !shapeReady(shape) ? [shape.heightmap.grid] : []; },
    request: (ref) => requestGrid(ref),
  },
};

/** The outside inputs the sim would read from `st` that this machine doesn't hold yet, as [{kind, ref}] ([] when it can fold as written). */
export const simInputsMissing = (st) => Object.entries(SIM_INPUTS).flatMap(([kind, i]) => i.missing(st).map((ref) => ({ kind, ref })));
/** Ask for them (each kind fetches its own way, once at a time); what lands is seen by the next simInputsMissing. */
export const requestSimInputs = (miss) => { for (const { kind, ref } of miss) void SIM_INPUTS[kind].request(ref); };
