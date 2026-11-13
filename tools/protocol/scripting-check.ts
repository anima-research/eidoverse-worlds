// tools/protocol/scripting-check.ts — the script developer kit (scripting/): its types name exactly the sandbox's API, and
// each example runs through the local runner as the docs say it does.
//   bun tools/protocol/scripting-check.ts
// Cases:
//   K1  scripting/world.d.ts's World members = the keys of the sandbox's `world` (read live, from inside a run)
//   K2  greeter: two arrivals, two greetings, the count kept in its component between events
//   K3  bellkeeper: a ring swings the bell (a pendulum motion), says who rang it, and world.use()s its lamp
//   K4  lighthouse: a sweep says the nearest soul and how far (world.nearby); with nobody near it says nothing
//   K5  the runner's command line prints the writes and the console
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE } from "./common.ts";

const KIT = path.join(ENGINE, "scripting");
const exists = (f: string) => fs.existsSync(path.join(KIT, f));
const RUN = exists("run.ts") ? await import(path.join(KIT, "run.ts")) : null;
const SB = await import(path.join(ENGINE, "shared/protocol/sandbox.js"));
const example = (n: string) => fs.readFileSync(path.join(KIT, "examples", n), "utf8");

type Case = { id: string; what: string; run: () => any; good: (o: any) => boolean };
const cases: Case[] = [
  { id: "K1", what: "scripting/world.d.ts's World members are exactly the sandbox's world object's keys", run() {
      const r = SB.runScript({ text: `world.set("self", "t/keys", Object.keys(world).sort());`, self: "k", key: "script:k", event: { on: "load" }, now: 0, seed: "0".repeat(64), st: { entities: { k: { born: 0, c: {} } }, diagnostics: [] } });
      const live = r.ok ? r.ops[0].value : null;
      const dts = exists("world.d.ts") ? fs.readFileSync(path.join(KIT, "world.d.ts"), "utf8") : "";
      const body = /interface World \{([\s\S]*?)\n\}/.exec(dts)?.[1] ?? "";
      const typed = [...new Set([...body.matchAll(/^\s*(?:readonly\s+)?([a-zA-Z_$][\w$]*)\s*[(:]/gm)].map((m) => m[1]))].sort();
      return { live, typed }; },
    good: (o) => Array.isArray(o.live) && o.live.includes("use") && o.live.includes("nearby") && JSON.stringify(o.live) === JSON.stringify(o.typed) },
  { id: "K2", what: "greeter: two arrivals get two greetings; its count lives in a component and carries between events", run() {
      if (!RUN) return { absent: true };
      return RUN.runEvents(example("greeter.js"), { self: "sign", knobs: { greeting: "welcome to the meadow" }, events: [{ on: "enter", by: "you" }, { on: "enter", by: "kit" }] }); },
    good: (o) => JSON.stringify(o.says) === JSON.stringify(["welcome to the meadow, you — you are visitor #1", "welcome to the meadow, kit — you are visitor #2"]) && o.state?.sign?.["example.org/greeter"]?.met === 2 && o.failed.length === 0 },
  { id: "K3", what: "bellkeeper: a ring swings the bell (pendulum), says who rang it, and world.use()s the lamp it names; another action does nothing", run() {
      if (!RUN) return { absent: true };
      return RUN.runEvents(example("bellkeeper.js"), { self: "bell1", knobs: { period: 2, note: "the bell tolls", lamp: "lamp1" }, events: [{ on: "use", action: "ring", by: "you" }, { on: "use", action: "kick", by: "you" }] }); },
    good: (o) => o.state?.bell1?.motion?.type === "pendulum" && o.state.bell1.motion.period === 2 && o.state.bell1["example.org/bellkeeper"]?.rings === 1
      && JSON.stringify(o.says) === JSON.stringify(["the bell tolls (1) — rung by you"]) && JSON.stringify(o.uses) === '[{"id":"lamp1","action":"toggle"}]' && o.failed.length === 0 },
  { id: "K4", what: "lighthouse: each sweep counts; with people near it names the nearest and how far (world.nearby); with nobody near it says nothing", run() {
      if (!RUN) return { absent: true };
      const near = RUN.runEvents(example("lighthouse.js"), { self: "lamp1", knobs: { text: "all clear", r: 20 }, people: [{ id: "far", d: 12.5 }, { id: "you", d: 3.25 }], events: [{ on: "tick" }, { on: "tick" }] });
      const none = RUN.runEvents(example("lighthouse.js"), { self: "lamp1", knobs: { r: 20 }, people: [], events: [{ on: "tick" }] });
      return { near: near.says, sweeps: near.state?.lamp1?.["example.org/lighthouse"]?.sweeps, none: none.says, noneSweeps: none.state?.lamp1?.["example.org/lighthouse"]?.sweeps, failed: [...near.failed, ...none.failed] }; },
    good: (o) => JSON.stringify(o.near) === JSON.stringify(["all clear — sweep 1; 2 in view, the nearest you at 3.25 m", "all clear — sweep 2; 2 in view, the nearest you at 3.25 m"]) && o.sweeps === 2 && o.none.length === 0 && o.noneSweeps === 1 && o.failed.length === 0 },
  { id: "K5", what: "the runner's command line: --self, --knobs, --use print the writes, the says, the uses and the console", run() {
      const r = Bun.spawnSync(["bun", path.join(KIT, "run.ts"), path.join(KIT, "examples/bellkeeper.js"), "--self", "bell1", "--knobs", '{"lamp":"lamp1"}', "--use", '{"action":"ring","by":"you"}'], { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
      return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; },
    good: (o) => o.code === 0 && /set bell1 motion .*pendulum/.test(o.out) && /say "the bell tolls \(1\) — rung by you"/.test(o.out) && /use lamp1 toggle/.test(o.out) && /console rung by you #1/.test(o.out) },
];

let pass = 0, fail = 0;
for (const c of cases) {
  let o: any, good = false;
  try { o = c.run(); good = !o?.absent && !!c.good(o); } catch (e: any) { o = { threw: `${e?.constructor?.name}: ${e?.message}`.slice(0, 300) }; }
  if (good) pass++; else fail++;
  console.log(`${good ? "ok  " : "FAIL"} ${c.id.padEnd(3)} ${c.what}${good ? "" : `\n       ${JSON.stringify(o).slice(0, 700)}`}`);
}
console.log(`[scripting-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
