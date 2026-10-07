// agent-v4 — feed a WorldAgent (mcpl/agent.ts) the world of a scratch v4 door, the way its v4 path does, without a
// server: the agent's v4 client adopts the door's cut, and after every write the agent takes the next view of its own
// fold (applyView), diffing it from the last: percepts when live, supports always. This replaces the v1 bench idiom
// (A.applyEntry({verb, args}) of hand-written log entries), which went with the v1 reader.
//
//   const { act, seed } = agentOnDoor(agent, "tag");
//   await seed({ console: { lib, pos: [1, 0, 1], comp: {...} } });      // the world as it stood at join (not live)
//   await act("set", { id: "console", component: "picture", value }, { who: "antra" });   // a live write, by antra
//   await act("sky", { hours: 12 }, { at: T0 + 20 * 60e3 });            // …at a chosen door time
//
// The door is the real one (shared/v4/door.js request over server/v4/disk.ts openWorld, the tools/v4/door-check.ts
// pattern), its clock pinned through V4_NOW: each request is stamped at `at`, or one second after the last. `who` is
// the display name the agent's percepts attribute the change to (the door's actor in a scratch world is its founder).
// @ts-nocheck
import { scratch } from "./v4/common.ts";
import { request, LAB_CATALOGUE } from "../shared/v4/door.js";
import { openWorld } from "../server/v4/disk.ts";
import { viewState } from "../shared/v4/record.js";
import { enc, encName } from "../shared/v4/names.js";
import { qNorm, qFromYaw } from "../shared/rot.js";
import { makeV4Client, stateView } from "../shared/v4/client.js";

// any model path the tests name: the lab's measured models where they exist, else one the door can name, unmeasured
const ANY_MODEL = Object.freeze({ get: (n) => LAB_CATALOGUE.get(n) ?? (typeof n === "string" && n ? { label: n, surfaces: [] } : undefined), list: (q) => LAB_CATALOGUE.list(q) });
let worldN = 0;

export function agentOnDoor(agent: any, tag = "agent", { owner = "olive", start = 1_800_000_000_000 } = {}) {
  const root = scratch(tag); const name = `w${++worldN}`;
  let T = start, w = null;
  const call = (tool, args = {}, at = null) => {
    T = at ?? T + 1000; process.env.V4_NOW = String(T);
    w ??= Object.assign(openWorld(root, name), { catalogue: ANY_MODEL });
    return request(w, owner, tool, args);
  };
  const founded = call("create-world", { title: tag });
  if (!founded.ok) throw new Error(`agentOnDoor: new refused: ${JSON.stringify(founded.refused)}`);
  const A = agent;
  A.v4c = makeV4Client();
  let joined = false;
  /** the agent takes the door's current state as its next view */
  const sync = async (live: boolean, who: string | null = null, ts: number | null = null) => {
    A.v4c.adopt({ state: stateView(w.state()), head: -1 });
    await A.applyView(joined ? live : false, who, ts ?? T);
    joined = true;
  };
  return {
    call, sync,
    now: () => T,
    state: () => w.state(),
    view: () => viewState(w.state()),
    /** create things from view-form records ({lib?, pos, yaw|q, scale, comp}) as the world the agent joins into */
    seed: async (recs: Record<string, any>) => {
      for (const [id, r] of Object.entries(recs)) {
        const components: any = { transform: { pos: r.pos ?? [0, 0, 0], q: qNorm(r.q) ?? qFromYaw(r.yaw ?? 0), scale: Number.isFinite(r.scale) ? [r.scale, r.scale, r.scale] : [1, 1, 1] } };
        for (const [k, v] of Object.entries(r.comp ?? {})) components[encName(k)] = v;
        const res = call("create", { id: enc(id), ...(r.lib ? { model: r.lib } : {}), components });
        if (!res.ok) throw new Error(`seed ${id}: ${JSON.stringify(res.refused)}`);
      }
      await sync(false);
    },
    /** one door request (at `at`, door time), then the agent's next view of it (live unless {live: false}) */
    act: async (tool: string, args: any, { who = "someone", at = null as number | null, live = true } = {}) => {
      const r = call(tool, args, at);
      await sync(live, who, T);
      return r;
    },
  };
}
