// tools/protocol/labhost.ts — openLive for the suites: the lab's hand-written models (./labmodels.js) as the catalogue, the
// sim's models left as the host's ({} unless a suite names them). The runtime's openLive knows no model it isn't handed.
import { openLive as hostOpen, type LiveOpts } from "../../server/livehost.ts";
import { LAB_CATALOGUE } from "./labmodels.js";
export * from "../../server/livehost.ts";
export const openLive = (dir: string, name: string, opts: LiveOpts = {}) => hostOpen(dir, name, { catalogue: LAB_CATALOGUE, ...opts });
