// test/harness/labworld.ts: the in-process authority fixture the lab suites repeat: a scratch root, a lab clock, and
// call(world, actor, verb, args), which advances the clock a step and then requests. ENG names the carried eidosim.
import { request } from "../../shared/protocol/authority.js";
import { openWorld } from "./filehost.ts";
import { ENGINES } from "../../shared/protocol/simlayer.js";
import { scratch } from "../gate/common.ts";
import { labClock } from "../gate/clock.ts";

export const ENG = { engine: Object.keys(ENGINES).find((k) => k.startsWith("eidosim@")) };
export function labWorld(name: string, step = 1500) {
  const root = scratch(name), clock = labClock();
  const call = (w: string, actor: string, verb: string, args: any = {}) => { clock.advance(step); return request(openWorld(root, w), actor, verb, args); };
  return { root, clock, call };
}
