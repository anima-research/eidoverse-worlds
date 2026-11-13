// lighthouse: keeps its own clock. Each sweep counts, and when someone is in view it names the nearest and how far.
//   set {id: "lamp1", component: "script:keeper", value: {src, every: 60, knobs: {text: "all clear", r: 30},
//        scope: {ids: "self", comps: ["example.org/lighthouse"], say: true}}}
// With nobody in the world a timer sleeps (unless `always`, an owner's); it wakes once when someone arrives.
// Try it: bun scripting/run.ts scripting/examples/lighthouse.js --self lamp1 --people '[{"id":"you","d":4}]' --tick 2
world.on("tick", () => {
  const sweeps = (world.get("self", "example.org/lighthouse")?.sweeps ?? 0) + 1;
  world.set("self", "example.org/lighthouse", { sweeps });
  const seen = world.nearby(world.knobs.r ?? 30);
  if (seen.length) world.say(`${world.knobs.text ?? "all clear"} — sweep ${sweeps}; ${seen.length} in view, the nearest ${world.name(seen[0].id) ?? seen[0].id} at ${seen[0].d} m`);
  console.log("sweep", sweeps, "in view", seen.length);
});
