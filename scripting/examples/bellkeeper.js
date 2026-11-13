// bellkeeper: a rung bell swings and answers, and lights the lamp its knobs name. The swing is one motion (a function of
// time the clients evaluate), never a per-frame write.
//   set {id: "bell1", component: "script:keeper", value: {src, on: ["use"], knobs: {period: 2.2, note: "the bell tolls", lamp: "lamp1"},
//        scope: {ids: ["self", "lamp1"], comps: ["example.org/bellkeeper", "motion"], say: true}}}
//   set {id: "bell1", component: "reactions", value: {ring: {kind: "script", script: "keeper"}}}
//   (lamp1 offers `toggle` in its own reactions); ring it: use {id: "bell1", action: "ring"}
// Try it: bun scripting/run.ts scripting/examples/bellkeeper.js --self bell1 --knobs '{"lamp":"lamp1"}' --use '{"action":"ring"}'
world.on("use", (e) => {
  if (e.action !== "ring") return;
  const rings = (world.get("self", "example.org/bellkeeper")?.rings ?? 0) + 1;
  world.set("self", "example.org/bellkeeper", { rings });
  world.set("self", "motion", { type: "pendulum", axis: [0, 0, 1], amp: 0.5, phase: 0, damp: 0.25, period: world.knobs.period ?? 2.2, t0: Date.now() });
  world.say(`${world.knobs.note ?? "the bell tolls"} (${rings}) — rung by ${e.by}`);
  if (world.knobs.lamp) world.use(world.knobs.lamp, "toggle");   // the lamp's own reaction decides, with this script's sponsor's rights
  console.log("rung by", e.by, "#" + rings);
});
