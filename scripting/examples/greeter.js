// greeter: says hello to each arrival and remembers how many it has met (in a component: nothing survives an activation).
// Install on any thing (a sign); every script that lists `enter` hears every arrival:
//   set {id: "sign", component: "script:greeter", value: {src, on: ["enter"], knobs: {greeting: "welcome to the meadow"},
//        scope: {ids: "self", comps: ["example.org/greeter"], say: true}}}
// Try it: bun scripting/run.ts scripting/examples/greeter.js --self sign --enter you --enter kit
world.on("enter", (e) => {
  const met = (world.get("self", "example.org/greeter")?.met ?? 0) + 1;
  world.set("self", "example.org/greeter", { met });
  world.say(`${world.knobs.greeting ?? "welcome"}, ${world.name(e.by) ?? e.by} — you are visitor #${met}`);
  console.log("greeted", e.by, "total", met);
});
