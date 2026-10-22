// agent-scratch — feed a WorldAgent (mcpl/agent.ts) the world of a scratch authority, the way its protocol path does, without a
// server: the agent's replica adopts the authority's cut, and after every write the agent takes the next view of its own
// fold (applyView), diffing it from the last: percepts when live, supports always. This replaces the v1 bench idiom
// (A.applyEntry({verb, args}) of hand-written log entries), which went with the v1 reader.
//
//   const { act, seed } = agentOnDoor(agent, "tag");
//   await seed({ console: { lib, pos: [1, 0, 1], ... } });      // the world as it stood at join (not live)
//   await act("set", { id: "console", component: "picture", value }, { who: "antra" });   // a live write, by antra
//   await act("sky", { hours: 12 }, { at: T0 + 20 * 60e3 });            // …at a chosen door time
//
// The door is the real one (shared/protocol/authority.js request over server/filehost.ts openWorld, the tools/protocol/authority-check.ts
// pattern), its clock pinned through the lab clock (tools/protocol/clock.ts): each request is stamped at `at`, or one second after the last. `who` is
// the display name the agent's percepts attribute the change to (the door's actor in a scratch world is its founder).
// @ts-nocheck
import "./protocol/fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import { scratch } from "./protocol/common.ts";
import { request, LAB_CATALOGUE } from "../shared/protocol/authority.js";
import { openWorld } from "../server/filehost.ts";
import { viewState } from "../shared/protocol/view.js";
import { enc, encName } from "../shared/protocol/names.js";
import { qNorm, qFromYaw } from "../shared/rot.js";
import { makeReplica, wireState } from "../shared/protocol/replica.js";

import { recordComponents } from "../shared/protocol/view.js";
import { labClock } from "./protocol/clock.ts";
// any model path the tests name: the lab's measured models where they exist, else one the door can name, unmeasured
const ANY_MODEL = Object.freeze({ get: (n) => LAB_CATALOGUE.get(n) ?? (typeof n === "string" && n ? { label: n, surfaces: [] } : undefined), list: (q) => LAB_CATALOGUE.list(q) });
let worldN = 0;

export function agentOnDoor(agent: any, tag = "agent", { owner = "olive", start = 1_800_000_000_000 } = {}) {
  const root = scratch(tag); const name = `w${++worldN}`;
  const clock = labClock(start); let w = null;
  const call = (verb, args = {}, at = null) => {
    clock.set(at ?? clock.t + 1000);
    w ??= Object.assign(openWorld(root, name), { catalogue: ANY_MODEL });
    return request(w, owner, verb, args);
  };
  const founded = call("create-world", { title: tag });
  if (!founded.ok) throw new Error(`agentOnDoor: new refused: ${JSON.stringify(founded.refused)}`);
  const A = agent;
  A.replica = makeReplica();
  let joined = false;
  /** the agent takes the door's current state as its next view */
  // the first view is a cut (as a join is); after that the agent INGESTS the door's new log entries, as it does live, so
  // what only the log carries (who wrote the sky, at which seq: #260 I286) reaches it the real way
  let head = -1;
  const sync = async (live: boolean, who: string | null = null, ts: number | null = null) => {
    const E = w.entries;
    if (!joined) { A.replica.adopt({ state: wireState(w.state()), head: E.length - 1 }); head = E.length - 1; }
    else { const r = A.replica.ingest(JSON.parse(JSON.stringify(E.slice(head + 1))), head + 1); head = E.length - 1; if (r.sky) A.skyStamp = r.sky; if (r.resync) A.replica.adopt({ state: wireState(w.state()), head }); }
    await A.applyView(joined ? live : false, who, ts ?? clock.t);
    joined = true;
  };
  return {
    call, sync,
    now: () => clock.t,
    state: () => w.state(),
    view: () => viewState(w.state()),
    /** create things from view-form records ({lib?, pos, yaw|q, scale, comp}) as the world the agent joins into */
    seed: async (recs: Record<string, any>) => {
      for (const [id, r] of Object.entries(recs)) {
        const components: any = { transform: { pos: r.pos ?? [0, 0, 0], q: qNorm(r.q) ?? qFromYaw(r.yaw ?? 0), scale: Number.isFinite(r.scale) ? [r.scale, r.scale, r.scale] : [1, 1, 1] } };
        for (const [k, v] of Object.entries(recordComponents(r))) components[encName(k)] = v;
        const res = call("create", { id: enc(id), ...(r.model ? { model: r.model } : {}), components });
        if (!res.ok) throw new Error(`seed ${id}: ${JSON.stringify(res.refused)}`);
      }
      await sync(false);
    },
    /** one door request (at `at`, door time), then the agent's next view of it (live unless {live: false}) */
    act: async (verb: string, args: any, { who = "someone", at = null as number | null, live = true } = {}) => {
      const r = call(verb, args, at);
      await sync(live, who, clock.t);
      return r;
    },
  };
}
