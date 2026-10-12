// kind-test — "is this a light / an Empty / a model" is decided ONCE (shared/protocol/kind.js kindOf), and every surface that
// says a thing's kind agrees with it: the realizer's planner (models_field), the hierarchy row hint, GET /geom?world's `kind`,
// and the mcpl inspect head. Five fixtures: a native v4 light (comp.light, no model), a bare Empty, a model, a model with a
// child light, and a thing carrying a `mesh` component (a sibling branch's kind; not built here, only named).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/kind-test.ts
//
// Part 1 is headless (a scratch world behind the real authority); part 2 fetches the route from an owned sequencer and asks the
// agent's inspect tool over the same world. The probe at the end is the premise of the refactor: a native world's view carries no
// `kind` field (view.js never emits one; translate-v1 rewrites a v1 light to c.light and skips `kind`), so a reader branching
// on `ent.kind === 'light'` is dead.
process.env.WORLD_TOKEN = "";
import { kindOf as plannerKindOf } from "../client/lib/realize/models_field.js";
import { kindHint } from "../shared/hierarchy.js";
import { viewOf, viewState } from "../shared/protocol/view.js";
import { project as projectV1 } from "./protocol/import-v1/translate-v1.js";
import { scratchWorld } from "./protocol/scratchworld.ts";
import { mkCheck } from "./harness.ts";
const { WorldAgent } = await import("../mcpl/agent.ts");
const { handleTool } = await import("../mcpl/tools.ts");
const { check, tally } = mkCheck();

const shared: any = await import("../shared/protocol/kind.js").catch(() => null);
const kindOf: (x: any) => string = shared?.kindOf ?? plannerKindOf;
check("shared/protocol/kind.js exports kindOf (until it does, the planner's rule stands in)", !!shared?.kindOf);

const TABLE = "eidoverse/assets/models/table_oak_round.glb";
const LIGHT = { color: 0xffd9a0, intensity: 8, range: 4 };
const SEED = {
  bulb: { pos: [0, 2, 0], comp: { light: LIGHT } },
  marker: { pos: [3, 0, 0] },
  table: { lib: TABLE, pos: [6, 0, 0] },
  "table-light": { pos: [0, 1, 0], parent: { to: "table", offset: [0, 1, 0] }, comp: { light: LIGHT } },
};
const WANT: Record<string, string> = { bulb: "light", marker: "empty", table: "model", "table-light": "light" };
const MESH_VIEW = { pos: [9, 0, 0], yaw: 0, q: [0, 0, 0, 1], scale: 1, comp: { mesh: { shape: "box", size: [1, 1, 1] } } };
const MESH_REC = { c: { transform: { pos: [9, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, mesh: { shape: "box", size: [1, 1, 1] } } };
const stem = (lib: string) => String(lib).split("/").pop()!;
// the mcpl inspect head's own word for a thing: `[id] light|empty|<file>`
const headKind = (text: string, id: string) => { const m = new RegExp(`^\\[${id}\\] (\\S+)`).exec(text); return m ? (m[1] === stem(TABLE) ? "model" : m[1]) : `?(${text.split("\n")[0]})`; };
const routeKind = (k: string) => k;

console.log("1. one answer per fixture, headless");
{
  const D = scratchWorld("kind").seed(SEED);
  const W = D.view().entities;
  const S = D.state().entities;
  for (const [id, want] of Object.entries(WANT)) {
    const rec = S[id], v = W[id];
    check(`kindOf({c}) ${id} = ${want}`, kindOf(rec) === want, kindOf(rec));
    check(`kindOf(view) ${id} = ${want}`, kindOf(v) === want, kindOf(v));
    check(`planner kindOf ${id} = ${want}`, plannerKindOf(v) === want, plannerKindOf(v));
    const hint = kindHint(v);
    check(`kindHint ${id} says ${want}`, want === "model" ? hint === "table oak round" : hint === want, hint);
  }
  check("a model with a light component (an imported lamp) is a model; the view-side rule agrees", kindOf({ c: { model: TABLE, light: LIGHT } }) === "model" && kindOf({ lib: TABLE, comp: { light: LIGHT } }) === "model");
  check("kindOf({c}) mesh = mesh", kindOf(MESH_REC) === "mesh", kindOf(MESH_REC));
  check("kindOf(view) mesh = mesh", kindOf(MESH_VIEW) === "mesh", kindOf(MESH_VIEW));
  check("kindHint mesh = mesh", kindHint(MESH_VIEW) === "mesh", kindHint(MESH_VIEW));
  check("a light that is not an object is not a light", kindOf({ c: { light: true } }) === "empty" && kindOf({ comp: { light: 3 } }) === "empty");
  check("nothing is an Empty", kindOf(null) === "empty" && kindOf({}) === "empty" && kindOf({ c: {} }) === "empty");
  check("viewOf of each fixture's record is the same kind as the record", Object.keys(WANT).every((id) => kindOf(viewOf(id, S[id].c)) === kindOf(S[id])));
}

console.log("2. the route and the inspect head, over an owned sequencer");
{
  const { scratchSequencer } = await import("./harness.ts");
  const h = await scratchSequencer("kind-route", { worlds: ["kind"], owner: "kind-writer", serverEnv: { TRUST_NAMES: "1", SKIP_OPT_SWEEP: "1" }, portFrom: 9400 });
  try {
    const ag: any = new WorldAgent({ name: "kind-writer", world: "kind", url: h.BASE.replace("http", "ws") + "/ws" });
    await ag.connect();
    const must = (r: any, what: string) => { if (!r?.ok) throw new Error(`${what} refused: ${JSON.stringify(r?.refused ?? r)}`); };
    const tf = (pos: number[]) => ({ pos, q: [0, 0, 0, 1], scale: [1, 1, 1] });
    must(await ag.request("create", { id: "bulb", components: { transform: tf([0, 2, 0]), light: LIGHT } }), "bulb");
    must(await ag.request("create", { id: "marker", components: { transform: tf([3, 0, 0]) } }), "marker");
    must(await ag.request("create", { id: "table", model: TABLE, components: { transform: tf([6, 0, 0]) } }), "table");
    must(await ag.request("create", { id: "table-light", components: { transform: tf([0, 1, 0]), light: LIGHT, parent: { to: "table", order: "a0" } } }), "table-light");
    const body = await (await fetch(`${h.BASE}/geom?world=kind&boxes=0`)).json() as any;
    const byId = Object.fromEntries((body.entities ?? []).map((e: any) => [e.id, e]));
    for (const [id, want] of Object.entries(WANT)) check(`GET /geom?world kind ${id} = ${want}`, routeKind(byId[id]?.kind) === want, String(byId[id]?.kind));
    check("the route's kind is kindOf of the route's own record", Object.keys(WANT).every((id) => byId[id] && kindOf(byId[id]) === byId[id].kind));
    const ctx = { agent: ag, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } };
    for (const [id, want] of Object.entries(WANT)) {
      const r = await handleTool(ctx, "inspect", { id });
      const text = r.content?.[0]?.text ?? "";
      check(`mcpl inspect head ${id} says ${want}`, headKind(text, id) === want, headKind(text, id));
    }
    ag.close?.();
  } finally { await h.cleanup(tally.failed ? 1 : 0); }
}

console.log("3. the premise: no native or translated record carries `kind`");
{
  const D = scratchWorld("kind-probe").seed(SEED);
  const st = viewState(D.state());
  check("a native world's view has no entity with a `kind` field", Object.values(st.entities).every((e: any) => !("kind" in e)), JSON.stringify(Object.entries(st.entities).filter(([, e]: any) => "kind" in e).map(([id]) => id)));
  const v1 = { entities: { lamp: { kind: "light", pos: [0, 1, 0], color: 1, intensity: 2, range: 3, keep: true, actor: "a", ts: 1 } } };
  const c = projectV1(v1 as any).lamp;
  check("translate-v1 rewrites a v1 kind:'light' entity to c.light (keep → important) and carries no imported:kind", !!c.light && c.light.color === 1 && c.light.important === true && !("imported:kind" in c) && !("kind" in c), JSON.stringify(c));
  check("…so its view is a light to kindOf and carries no `kind`", kindOf(viewOf("lamp", c)) === "light" && !("kind" in viewOf("lamp", c)));
}

console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
