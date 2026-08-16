// client/lib/realize/models_field.js — the models realizer's pure planner
// (TEL0S_NOTES §11.4), tested headless.
//
//   bun tools/models-field-test.ts
//
// The load-bearing claims: the plan is a pure diff of folded entities vs
// the realized view; identity changes (kind flips on the flat id namespace,
// a model's lib changing under a same-id spawn) are rebuilds, not
// refreshes; state is the pending list for mounts (mountsTouching finds
// every linkage a completed spawn could unblock); distance bands promote
// what is in front of you.

import { planReconcile, bandForDistance, mountsTouching } from "../client/lib/realize/models_field.js";
import { P } from "../client/lib/scheduler.js";

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log(`\nmodels_field — the pure planner\n`);

const model = (lib: string, extra: object = {}) => ({ lib, pos: [0, 0, 0], actor: "t", ts: 1, ...extra });
const light = () => ({ kind: "light", pos: [0, 1, 0], color: 0xffd9a0, intensity: 16, range: 10, actor: "t", ts: 1 });

// 1. fresh world: everything creates, nothing retires
{
  const st = { a: model("x.glb"), b: light() };
  const plan = planReconcile(st, new Map());
  check("fresh state creates all", plan.create.length === 2 && plan.retire.length === 0);
}

// 2. steady state: no work
{
  const st = { a: model("x.glb"), b: light() };
  const view = new Map([["a", { kind: "model", lib: "x.glb" }], ["b", { kind: "light" }]] as any);
  const plan = planReconcile(st, view);
  check("matching view plans nothing", plan.create.length === 0 && plan.retire.length === 0);
}

// 3. gone from state → retire
{
  const plan = planReconcile({}, new Map([["a", { kind: "model", lib: "x.glb" }]] as any));
  check("vanished id retires", plan.retire.join() === "a" && plan.create.length === 0);
}

// 4. kind flip (light verb landed on a model id) → rebuild
{
  const st = { a: light() };
  const plan = planReconcile(st, new Map([["a", { kind: "model", lib: "x.glb" }]] as any));
  check("kind flip rebuilds", plan.retire.join() === "a" && plan.create.length === 1 && plan.create[0].id === "a");
}

// 5. lib change under a same-id spawn → rebuild (follows the fold's
//    overwrite semantics; PROTOCOL.md's "no-op" text is the flagged
//    contradiction, and the planner projects whatever the fold folded)
{
  const st = { a: model("y.glb") };
  const plan = planReconcile(st, new Map([["a", { kind: "model", lib: "x.glb" }]] as any));
  check("lib change rebuilds", plan.retire.join() === "a" && plan.create[0]?.ent.lib === "y.glb");
}

// 6. mountsTouching finds both directions of a linkage
{
  const st = {
    truck: model("t.glb"),
    crate: model("c.glb", { parent: { to: "truck" } }),
    lantern: model("l.glb", { parent: { to: "crate" } }),
    bystander: model("b.glb"),
  };
  check("carrier realizing unblocks its cargo", mountsTouching(st, "truck").join() === "crate");
  check("cargo realizing re-checks its own mount", mountsTouching(st, "crate").sort().join() === "crate,lantern");
  check("unrelated spawn touches nothing", mountsTouching(st, "bystander").length === 0);
}

// 7. distance bands
{
  check("close is NEAR", bandForDistance(3) === P.NEAR);
  check("mid is VISIBLE", bandForDistance(25) === P.VISIBLE);
  check("far is FAR", bandForDistance(300) === P.FAR);
  check("unknown distance is VISIBLE", bandForDistance(NaN) === P.VISIBLE);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
