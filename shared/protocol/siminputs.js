// What the sim reads that isn't in the log. Everything else it reads is the entries' own (Covenant III: geometry enters as
// physics.shape); these are named by the log and fetched apart, so a client can hold the log before it holds them.
// One list: the replica waits on it (replica.js), and siminputs-check refuses a sim module that reads outside it.
import { shapeReady, shapeParams, requestGrid } from "../terrainshape.js";

export const SIM_INPUTS = {
  // a heightmap's grid: the authority reads its disk, a client fetches store/heightmaps/<hash>.json
  heightmap: {
    module: "shared/terrainshape.js",
    missing: (st) => { const t = st?.entities?.["@world"]?.c?.terrain; return t && typeof t === "object" && !shapeReady(shapeParams(t)) ? [t.heightmap.grid] : []; },
    request: (ref) => requestGrid(ref),
  },
};

/** The outside inputs the sim would read from `st` that this machine doesn't hold yet, as [{kind, ref}] ([] when it can fold as written). */
export const simInputsMissing = (st) => Object.entries(SIM_INPUTS).flatMap(([kind, i]) => i.missing(st).map((ref) => ({ kind, ref })));
/** Ask for them (each kind fetches its own way, once at a time); what lands is seen by the next simInputsMissing. */
export const requestSimInputs = (miss) => { for (const { kind, ref } of miss) void SIM_INPUTS[kind].request(ref); };
